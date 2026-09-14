/**
 * v22.20 (0094) — the calendar, and the private event a scheduler must see
 * without reading.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 17_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const FROM = new Date("2027-02-01T00:00:00Z");
const day = (n: number) => new Date(FROM.getTime() + n * 86_400_000);

async function ticket(userId: number, code: string, expiresAt: Date | null, state = "verified") {
  await pool.execute(
    `INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt)
     VALUES (?,?,?,?,?,?,?,NOW())`,
    [`WQ-${rnd()}${rnd()}`, "default", userId, code, state, expiresAt, 1]);
}

d("every event names the record it came from", () => {
  it("projects leave with its request reference and a link", async () => {
    const driver = await withRole("driver");
    const lr = await caller(driver).timeOff.request({ category: "vacation", from: day(3), to: day(5) });
    const c = await caller(driver).calendar.mine({ from: FROM, days: 14 });
    const event = c.events.find(e => e.source.sourceRef === lr.requestRef)!;
    expect(event.source.sourceType).toBe("leaveRequest");
    expect(event.deepLink).toBe(`/leaveRequest/${lr.requestRef}`);
    expect(c.note).toContain("the calendar holds none of these dates itself");
  });

  it("projects a qualification expiry as blocking once it has passed", async () => {
    const driver = await withRole("driver");
    await ticket(driver, "TDG", day(2));
    const c = await caller(driver).calendar.mine({ from: FROM, days: 30 });
    const e = c.events.find(x => x.title.includes("TDG expires"))!;
    expect(e.layer).toBe("compliance");
    expect(e.severity).toBe("due");
    expect(e.source.sourceType).toBe("workerQualification");
  });

  it("projects a verified holding with no expiry as unknown, not as fine", async () => {
    const driver = await withRole("driver");
    await ticket(driver, "H2S", null);
    const c = await caller(driver).calendar.mine({ from: FROM, days: 7 });
    const e = c.events.find(x => x.title.includes("H2S"))!;
    expect(e.title).toContain("no expiry recorded");
    expect(e.severity).toBe("unknown");
  });

  it("does not project an unverified certificate at all", async () => {
    const driver = await withRole("driver");
    await ticket(driver, "TDG", day(4), "unverified");
    const c = await caller(driver).calendar.mine({ from: FROM, days: 30 });
    expect(c.events.some(e => e.title.includes("TDG"))).toBe(false);
  });

  it("projects an expressed interest and says it is not an assignment", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const p = await caller(dispatcher).shifts.post({ title: "Night vac", startsAt: day(6), endsAt: day(7), requiredRole: "driver" });
    await caller(driver).shifts.expressInterest({ postRef: p.postRef });
    const c = await caller(driver).calendar.mine({ from: FROM, days: 14 });
    const e = c.events.find(x => x.source.sourceRef === p.postRef)!;
    expect(e.detail).toContain("Not an assignment");
  });

  it("projects one event per on-hitch day from the member's own rotation", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const crew = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    await caller(dispatcher).crews.addMember({
      crewRef: crew.crewRef, userId: driver, rotation: { onDays: 7, offDays: 7, anchor: FROM }, joinedAt: FROM,
    });
    const c = await caller(driver).calendar.mine({ from: FROM, days: 14 });
    // A fortnight of 7/7 is exactly one on-hitch. Fifteen days would be eight,
    // which is how the boundary bug showed itself.
    expect(c.events.filter(e => e.layer === "rotation")).toHaveLength(7);
    const longer = await caller(driver).calendar.mine({ from: FROM, days: 21 });
    expect(longer.events.filter(e => e.layer === "rotation")).toHaveLength(14);
  });
});

d("a scheduler sees the window and not the reason", () => {
  it("redacts a private leave event and keeps its dates", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    await caller(driver).timeOff.request({ category: "medical_appointment", from: day(8), to: day(8), privateNote: "MRI follow-up" });

    const own = await caller(driver).calendar.mine({ from: FROM, days: 14 });
    expect(own.events.some(e => e.title.includes("medical"))).toBe(true);

    const theirs = await caller(dispatcher).calendar.forScheduling({ userId: driver, from: FROM, days: 14 });
    const redacted = theirs.events.find(e => e.redacted)!;
    expect(redacted.title).toBe("Unavailable");
    expect(redacted.detail).toBeNull();
    expect(redacted.at).toBeTruthy();
    expect(JSON.stringify(theirs)).not.toContain("MRI");
    expect(JSON.stringify(theirs)).not.toContain("medical_appointment");
    expect(theirs.redactedCount).toBe(1);
    expect(theirs.note).toContain("Hiding it would show this person as free");
  });

  it("shows an ordinary leave category plainly", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    await caller(driver).timeOff.request({ category: "vacation", from: day(9), to: day(9) });
    const theirs = await caller(dispatcher).calendar.forScheduling({ userId: driver, from: FROM, days: 14 });
    expect(theirs.events.some(e => e.title.includes("vacation") && !e.redacted)).toBe(true);
  });

  it("refuses a driver another person's calendar", async () => {
    const driver = await withRole("driver");
    const other = await withRole("driver");
    await expect(caller(driver).calendar.forScheduling({ userId: other, from: FROM, days: 7 })).rejects.toThrow();
  });
});

d("exceptions list what needs somebody", () => {
  it("includes an unknown expiry, because a date nobody established is not fine", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    await ticket(driver, "CLIENT_ORIENTATION", null);
    const e = await caller(dispatcher).calendar.exceptions({ userId: driver, from: FROM, days: 30 });
    expect(e.events.some(x => x.severity === "unknown")).toBe(true);
    expect(e.note).toContain("not a date that is fine");
  });

  it("leaves rotation and interest out, since neither needs action", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const crew = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    await caller(dispatcher).crews.addMember({ crewRef: crew.crewRef, userId: driver, rotation: { onDays: 7, offDays: 7, anchor: FROM }, joinedAt: FROM });
    const e = await caller(dispatcher).calendar.exceptions({ userId: driver, from: FROM, days: 14 });
    expect(e.events.some(x => x.layer === "rotation")).toBe(false);
    expect(e.note).toBe("Nothing in this window needs action.");
  });
});
