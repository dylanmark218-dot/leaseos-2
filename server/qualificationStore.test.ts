/**
 * v22.20 (0092) — a ticket on record is not a ticket in force.
 *
 * Exercises the new store through the open-shifts eligibility read, since that
 * is the thing the store exists to make answerable.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 15_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const STARTS = new Date("2026-11-10T06:00:00Z");
const ENDS = new Date("2026-11-10T18:00:00Z");

/** On the single tenant's roster — an active crew membership — which the open-shift rule requires (SPINE item 2). */
async function onRoster(userId: number) {
  const crewRef = `CR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await pool.execute("INSERT INTO crews (crewRef, tenantId, name, createdByUserId) VALUES (?, 'default', ?, 1)", [crewRef, crewRef]);
  await pool.execute("INSERT INTO crewMembers (crewRef, userId, crewRole, joinedAt) VALUES (?, ?, 'driver', NOW())", [crewRef, userId]);
}
async function operatorWithLicence(userId: number) {
  await pool.execute("INSERT INTO operators (id, userId, name, licenseClass, licenseExpiresAt, createdAt) VALUES (?,?,?,?,?,NOW())",
    [userId, userId, `Op ${rnd()}`, "1", new Date("2028-01-01T00:00:00Z")]);
  await onRoster(userId);
}
async function holding(userId: number, code: string, o: { state?: string; expiresAt?: Date | null; recordedAt?: Date } = {}) {
  const holdingRef = `WQ-${rnd()}${rnd()}`;
  await pool.execute(
    `INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    // C1b-3: a legacy holding counts as verified only with a recorded verifier.
    [holdingRef, "default", userId, code, o.state ?? "verified", o.expiresAt === undefined ? new Date("2027-06-01T00:00:00Z") : o.expiresAt, 1, o.recordedAt ?? new Date("2026-01-01T00:00:00Z"),
     (o.state ?? "verified") === "verified" ? 1 : null, (o.state ?? "verified") === "verified" ? new Date("2026-01-02T00:00:00Z") : null]);
  return holdingRef;
}
const postDG = async (dispatcher: number) =>
  caller(dispatcher).shifts.post({ title: "DG haul", startsAt: STARTS, endsAt: ENDS, requiredRole: "driver", requiredQualifications: ["TDG"] });

d("a qualification is checked, not assumed", () => {
  it("is eligible with a verified, unexpired holding", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    await holding(driver, "TDG");
    const p = await postDG(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.eligible).toBe(true);
    expect(p.note).toContain("check TDG against verified holdings");
  });

  it("blocks when nothing is on record at all", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    const p = await postDG(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.reasons.some(r => r.code === "qualification_unknown" && r.detail.includes("No TDG on record"))).toBe(true);
  });

  it("blocks an uploaded certificate nobody has verified, exactly as an expired one", async () => {
    const dispatcher = await withRole("dispatcher");
    const unverified = await withRole("driver");
    const expired = await withRole("driver");
    await operatorWithLicence(unverified);
    await operatorWithLicence(expired);
    await holding(unverified, "TDG", { state: "unverified" });
    await holding(expired, "TDG", { expiresAt: new Date("2026-10-01T00:00:00Z") });
    const p = await postDG(dispatcher);

    const u = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: unverified });
    const x = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: expired });
    expect(u.eligible).toBe(false);
    expect(x.eligible).toBe(false);
    expect(u.reasons.some(r => r.code === "qualification_unverified")).toBe(true);
    expect(x.reasons.some(r => r.code === "qualification_expired")).toBe(true);
  });

  it("blocks an OCR extraction, because that is still nobody's assertion", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    await holding(driver, "TDG", { state: "extracted" });
    const p = await postDG(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.reasons.some(r => r.code === "qualification_unverified" && r.detail.includes("extracted"))).toBe(true);
  });

  it("blocks a verified holding with no expiry recorded rather than treating it as permanent", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    await holding(driver, "TDG", { expiresAt: null });
    const p = await postDG(dispatcher);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.reasons.some(r => r.detail.includes("no expiry recorded"))).toBe(true);
  });

  it("blocks a rejected holding", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    await holding(driver, "TDG", { state: "rejected" });
    const p = await postDG(dispatcher);
    expect((await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver })).eligible).toBe(false);
  });

  it("uses the most recent holding and ignores a superseded one", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    // An old expired ticket, superseded by a current renewal.
    await holding(driver, "TDG", { state: "superseded", expiresAt: new Date("2026-01-01T00:00:00Z"), recordedAt: new Date("2024-01-01T00:00:00Z") });
    await holding(driver, "TDG", { recordedAt: new Date("2026-02-01T00:00:00Z") });
    const p = await postDG(dispatcher);
    expect((await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver })).eligible).toBe(true);
  });

  it("blocks on the one missing ticket and names only that one", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorWithLicence(driver);
    await holding(driver, "TDG");
    const p = await caller(dispatcher).shifts.post({
      title: "Sour service", startsAt: STARTS, endsAt: ENDS, requiredRole: "driver",
      requiredQualifications: ["TDG", "H2S"],
    });
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: driver });
    expect(e.reasons).toHaveLength(1);
    expect(e.reasons[0].detail).toContain("No H2S on record");
  });
});
