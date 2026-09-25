/**
 * 0206 — "Offer Me Work": a declaration is appended and superseded, never edited; it is one
 * organization's; it feeds the candidate pool and changes no readiness verdict.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, count, DAY_AFTER, DAY_BEFORE, DAY_OF, member, operatorFor, org, postWork, rnd, TWO_DAYS_AFTER } from "./boardFixtures";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

d("declaring", () => {
  it("supersedes a standing declaration, keeps windowed ones beside it, and answers a retry with the same ref", async () => {
    const a = await org(pool);
    const drv = await member(pool, a, ["driver"]);
    const first = await callerFor(drv).shifts.availabilitySet({ state: "available" });
    const second = await callerFor(drv).shifts.availabilitySet({ state: "on_call", preferences: { regions: ["HINTON"], maxDistanceKm: 150, overnight: false, overtime: true } as never });
    const windowed = await callerFor(drv).shifts.availabilitySet({ state: "unavailable", windowStartsAt: DAY_BEFORE, windowEndsAt: TWO_DAYS_AFTER });
    const mine = await callerFor(drv).shifts.availabilityMine();
    expect(mine.declarations.map(x => x.availabilityRef).sort()).toEqual([second.availabilityRef, windowed.availabilityRef].sort());
    expect(await count(pool, "SELECT COUNT(*) AS n FROM workerAvailability WHERE availabilityRef = ? AND supersededByRef = ?", [first.availabilityRef, second.availabilityRef])).toBe(1);
    const key = { state: "available" as const, deviceId: `TAB-${rnd()}`, clientMutationId: `m-${rnd()}` };
    const one = await callerFor(drv).shifts.availabilitySet(key);
    const two = await callerFor(drv).shifts.availabilitySet(key);
    expect(two.replayed).toBe(true);
    expect(two.availabilityRef).toBe(one.availabilityRef);
    await expect(callerFor(drv).shifts.availabilitySet({ state: "available", windowStartsAt: TWO_DAYS_AFTER, windowEndsAt: DAY_AFTER })).rejects.toThrow(/ends before it begins/);
  });

  it("is read by a dispatcher of the same organization and not found from another", async () => {
    const a = await org(pool), b = await org(pool);
    const drv = await member(pool, a, ["driver"]);
    const dispA = await member(pool, a, ["dispatcher"]);
    const dispB = await member(pool, b, ["dispatcher"]);
    await callerFor(drv).shifts.availabilitySet({ state: "available" });
    expect((await callerFor(dispA).shifts.availabilityFor({ userId: drv })).declarations).toHaveLength(1);
    await expect(callerFor(dispB).shifts.availabilityFor({ userId: drv })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

d("what a declaration changes", () => {
  it("excludes a declared unavailability from the pool with its code, and changes no readiness verdict", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    await operatorFor(pool, a, drv);
    const p = await postWork(disp);
    const before = await callerFor(disp).shifts.eligibility({ postRef: p.postRef, userId: drv });
    expect(before.verdict).toBe("eligible");
    expect(before.availability).toBe("undeclared");
    await callerFor(drv).shifts.availabilitySet({ state: "unavailable", windowStartsAt: DAY_BEFORE, windowEndsAt: TWO_DAYS_AFTER });
    const after = await callerFor(disp).shifts.eligibility({ postRef: p.postRef, userId: drv });
    expect(after.verdict).toBe("ineligible");
    expect(after.reasons.map(r => r.code)).toEqual(["declared_unavailable"]);
    expect(after.availability).toBe("unavailable");
    // The readiness axis is untouched by what a person said about their willingness.
    expect(after.readiness).toEqual(before.readiness);
    await expect(callerFor(drv).shifts.respond({ postRef: p.postRef })).rejects.toThrow(/cannot take/);
  });

  it("puts a declarer whose window covers the start into the pool without them having responded, and tells them when work is posted", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    await operatorFor(pool, a, drv);
    await callerFor(drv).shifts.availabilitySet({ state: "available", windowStartsAt: DAY_OF, windowEndsAt: DAY_AFTER });
    const p = await postWork(disp, { regionCode: "HINTON" });
    const c = await callerFor(disp).shifts.candidates({ postRef: p.postRef });
    expect(c.candidates.map(x => x.userId)).toEqual([drv]);
    expect(c.candidates[0]!.response).toBeNull();
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT payloadJson FROM domainEventOutbox WHERE aggregateType = 'shiftPost' AND aggregateId = ? AND eventType = 'work.posted'", [p.postRef]);
    expect(JSON.parse(String(row[0]!.payloadJson)).recipientUserIds).toEqual([drv]);
  });
});
