/**
 * v22.20 (0091) — open shifts through the API, and the check that cannot run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("posting work is sensitive; wanting it is not", () => {
  it("fails closed on the post only", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("shifts.post");
    expect(SENSITIVE_PERMISSIONS).not.toContain("shifts.read");
    expect(SENSITIVE_PERMISSIONS).not.toContain("shifts.interest");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 14_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const STARTS = new Date("2026-11-10T06:00:00Z");
const ENDS = new Date("2026-11-10T18:00:00Z");

/**
 * An operator row with a licence, since that is the one credential stored.
 *
 * 0206 — `operators.userId` is the mapping the board reads (design C-10). The row used to be
 * seeded with `id = userId` and no `userId`, which only worked because the eligibility read
 * conflated the two; it now names the person it belongs to.
 */
async function operatorWithLicence(userId: number, expires: Date | null) {
  await pool.execute(
    "INSERT INTO operators (id, userId, name, licenseClass, licenseExpiresAt, createdAt) VALUES (?,?,?,?,?,NOW())",
    [userId, userId, `Op ${rnd()}`, "1", expires]);
  // #52 (on main): the legacy operators.licenseExpiresAt date alone is an unverified licence, so a ready
  // driver also needs a verified driver_licence document. Same expiry, so an expired fixture stays expired.
  if (expires) await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'driver_licence', 'Driver licence', NOW(), ?, 'verified')", [userId, expires]);
}
const postShift = (dispatcher: number, over: Record<string, unknown> = {}) =>
  caller(dispatcher).shifts.post({ title: "Vac truck operator", startsAt: STARTS, endsAt: ENDS, requiredRole: "driver", ...over });

d("eligibility from what is on record", () => {
  it("is eligible with a current licence and no leave", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver, new Date("2027-01-01T00:00:00Z"));
    const p = await postShift(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.eligible).toBe(true);
    expect(e.note).toContain("readiness check still runs at assignment");
  });

  it("reports a qualification nobody has recorded as blocking, not as satisfied", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver, new Date("2027-01-01T00:00:00Z"));
    const p = await postShift(dispatcher, { requiredQualifications: ["TDG", "H2S"] });
    expect(p.note).toContain("check TDG, H2S against verified holdings");

    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.eligible).toBe(false);
    expect(e.reasons.filter(r => r.code === "qualification_unknown")).toHaveLength(2);
    expect(e.reasons[0].detail).toContain("unknown is not satisfied");   // still the rule, now read from the store
  });

  it("blocks on no licence recorded rather than assuming one", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver, null);
    const p = await postShift(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.reasons.some(r => r.code === "no_licence_recorded")).toBe(true);
  });

  it("blocks on a licence that expires before the shift", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver, new Date("2026-11-01T00:00:00Z"));
    const p = await postShift(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.reasons.some(r => r.code === "licence_expired")).toBe(true);
  });

  it("reads approved leave from the record rather than from a caller", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const manager = await withRole("management");
    await operatorWithLicence(driver, new Date("2027-01-01T00:00:00Z"));
    const leave = await caller(driver).timeOff.request({ category: "vacation", from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-11T00:00:00Z") });

    const p = await postShift(dispatcher);
    // Requested leave does not exclude.
    expect((await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver })).eligible).toBe(true);

    await caller(manager).timeOff.decide({ requestRef: leave.requestRef, decision: "approve" });
    const after = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(after.eligible).toBe(false);
    expect(after.reasons.some(r => r.code === "on_approved_leave")).toBe(true);
  });
});

d("interest assigns nothing", () => {
  it("records it once, and says plainly what it is not", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const p = await postShift(dispatcher);
    const first = await caller(driver).shifts.expressInterest({ postRef: p.postRef });
    expect(first).toMatchObject({ recorded: true, assigns: false });
    expect(first.note).toContain("Dispatch assigns the shift");

    const again = await caller(driver).shifts.expressInterest({ postRef: p.postRef });
    expect(again.recorded).toBe(false);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM shiftInterests WHERE postRef = ?", [p.postRef]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses interest on an assigned post", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const p = await postShift(dispatcher, { kind: "assigned" });
    await expect(caller(driver).shifts.expressInterest({ postRef: p.postRef })).rejects.toThrow(/interest is not how it is filled/);
  });

  it("lists the interested and says they have no claim", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const p = await postShift(dispatcher);
    await caller(driver).shifts.expressInterest({ postRef: p.postRef });
    const i = await caller(dispatcher).shifts.interests({ postRef: p.postRef });
    expect(i.interested.map(x => x.userId)).toEqual([driver]);
    expect(i.note).toContain("has no claim");
  });
});

d("the boundaries", () => {
  it("refuses a driver the post and allows them the interest", async () => {
    const driver = await withRole("driver");
    await expect(postShift(driver)).rejects.toThrow();
    await expect(caller(driver).shifts.list({})).resolves.toBeTruthy();
  });

  it("refuses a shift that ends before it begins", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(postShift(dispatcher, { startsAt: ENDS, endsAt: STARTS })).rejects.toThrow(/ends before it begins/);
  });

  it("does not show another organization's post", async () => {
    const dispatcher = await withRole("dispatcher");
    const p = await postShift(dispatcher);
    await pool.execute("UPDATE shiftPosts SET tenantId = 'ORG-ELSEWHERE' WHERE postRef = ?", [p.postRef]);
    await expect(caller(dispatcher).shifts.eligibility({ postRef: p.postRef })).rejects.toThrow(/No such shift post/);
  });
});
