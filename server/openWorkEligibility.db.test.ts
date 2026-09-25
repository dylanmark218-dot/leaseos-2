/**
 * 0206 — the preview: eligible, ineligible or unknown, with codes, from the canonical stores and the
 * readiness composer. Unknown never reads as eligible, and readiness is its own axis.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, member, operatorFor, org, postWork, rnd, STARTS } from "./boardFixtures";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

d("what the preview says", () => {
  it("is unknown, not eligible, for a person with no operator record", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const p = await postWork(disp);
    const e = await callerFor(disp).shifts.eligibility({ postRef: p.postRef, userId: drv });
    expect(e.verdict).toBe("unknown");
    expect(e.eligible).toBe(false);
    expect(e.reasons.map(r => r.code)).toContain("no_operator_record");
    expect(e.readiness).toBeNull();
  });

  it("carries the readiness composer's own answer beside the verdict, names what was not evaluated, and does not fold a truck's findings into a person's", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    await operatorFor(pool, a, drv);
    const p = await postWork(disp);
    const e = await callerFor(disp).shifts.eligibility({ postRef: p.postRef, userId: drv });
    expect(e.verdict).toBe("eligible");
    expect(e.readiness).not.toBeNull();
    expect(e.readiness!.verdict).toBe("blocked");            // a post with no truck and no job: the composer says so
    expect(e.readiness!.blockerCodes).toContain("truck_inspection_missing");
    expect(e.reasons.map(r => r.code)).not.toContain("readiness_blocked:truck_inspection_missing");
    expect(e.readiness!.notEvaluated.length).toBeGreaterThan(0);   // never rendered as ✓
  });

  it("answers a required qualification from the canonical stores and calls the rest unknown", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const opId = await operatorFor(pool, a, drv);
    await pool.execute("INSERT INTO academyQualifications (qualificationRef, userId, qualificationCode, sourceKind, status, validFrom, expiresAt) VALUES (?,?,?,?,?,?,?)",
      [`AQ-${rnd()}`, drv, "H2S", "academy_certificate", "current", new Date(Date.now() - 200 * 86_400_000), new Date(STARTS.getTime() + 400 * 86_400_000)]);
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus, source) VALUES ('operator', ?, 'tdg_certificate', 'TDG', NOW(), ?, 'verified', 'upload')",
      [opId, new Date(STARTS.getTime() + 400 * 86_400_000)]);
    const p = await postWork(disp, { requiredQualifications: ["H2S", "TDG", "FIRST_AID"] });
    const e = await callerFor(disp).shifts.eligibility({ postRef: p.postRef, userId: drv });
    expect(e.verdict).toBe("unknown");
    const unknown = e.reasons.filter(r => r.code === "qualification_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.detail).toContain("FIRST_AID");
    expect(unknown[0]!.detail).toContain("unknown is not satisfied");
  });

  it("calls an expired qualification expired, which excludes", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    await operatorFor(pool, a, drv);
    await pool.execute("INSERT INTO academyQualifications (qualificationRef, userId, qualificationCode, sourceKind, status, validFrom, expiresAt) VALUES (?,?,?,?,?,?,?)",
      [`AQ-${rnd()}`, drv, "H2S", "academy_certificate", "current", new Date(Date.now() - 400 * 86_400_000), new Date(STARTS.getTime() - 86_400_000)]);   // expired the day before the work
    const p = await postWork(disp, { requiredQualifications: ["H2S"] });
    const e = await callerFor(disp).shifts.eligibility({ postRef: p.postRef, userId: drv });
    expect(e.verdict).toBe("ineligible");
    expect(e.reasons.map(r => r.code)).toEqual(["qualification_expired"]);
  });

  it("orders the candidate pool by verdict, then declared availability, then who answered first, and names every exclusion", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const ready = await member(pool, a, ["driver"]);
    const unknown = await member(pool, a, ["driver"]);
    const declarer = await member(pool, a, ["driver"]);
    await operatorFor(pool, a, ready);
    await operatorFor(pool, a, declarer);
    await callerFor(declarer).shifts.availabilitySet({ state: "available_for_overtime" });
    const p = await postWork(disp, { overtime: true });
    await callerFor(unknown).shifts.respond({ postRef: p.postRef });
    await callerFor(ready).shifts.respond({ postRef: p.postRef });
    const c = await callerFor(disp).shifts.candidates({ postRef: p.postRef });
    expect(c.candidates.map(x => x.userId)).toEqual([declarer, ready, unknown]);
    expect(c.candidates[0]!.availability).toBe("available_for_overtime");
    expect(c.candidates[2]!.reasons.map(r => r.code)).toContain("no_operator_record");
    expect(c.line).toContain(p.postRef);
    for (const x of c.candidates.filter(x => x.verdict !== "eligible")) expect(x.reasons.length).toBeGreaterThan(0);
  });
});
