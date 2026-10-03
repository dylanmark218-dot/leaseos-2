/**
 * Marketplace readiness reads qualifications through the D-05 adapter — characterized against the read
 * it replaced, and proved to agree with the other canonical consumers.
 *
 * Before the port, the marketplace facts loader read `workerQualifications` (every tenant) and
 * `academyQualifications` directly, merged them into one holdings list, and let the newest record
 * decide. Now it asks `qualificationReads.effectiveQualifications` in the bidding organization's scope
 * and counts `held`. Each case below records, for one person and one code:
 *
 *   old        — the retired marketplace read, reproduced here verbatim so the difference is pinned;
 *   adapter    — `effectiveQualifications` itself;
 *   open shift — the open-shift board's person facts (another canonical consumer of the adapter);
 *   market     — the marketplace facts loader and evaluator after the port.
 *
 * `adapter`, `open shift` and `market` must agree on held and on the not-held code in every case; where
 * `old` differs, the case says why the canonical answer is the right one. Unknown, unverified, expired
 * and not-yet-effective never read as held. Every record here is a test fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { academyQualifications, workerQualifications, type MarketplacePostingRow } from "../drizzle/schema";
import { getDb } from "./db";
import { effectiveQualifications } from "./qualificationReads";
import { personFacts } from "./openShiftsService";
import { gatherReadinessFacts } from "./_core/marketplaceReadinessFacts";
import { evaluateMarketplaceReadiness } from "./_core/marketplaceReadiness";
import { heldFromValidity, qualificationValidity, type QualificationHolding } from "./_core/qualificationValidity";
import { addMembership, grantAcademyQualification } from "./fixtures/marketplaceQualify";
import { inArray } from "drizzle-orm";
import type { ShiftPost } from "./_core/openShifts";

const DB_URL = process.env.DATABASE_URL;

describe("marketplace qualification parity — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped parity suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 426_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const CODE = "H2S_ALIVE";

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, orgRef]);
  return orgRef;
}
/** A worker the organization lists; a member of it unless `member: false`. */
async function worker(orgRef: string, o: { member?: boolean } = {}) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'EMPLOYEE_DRIVER','active','2020-01-01',1)", [`WRK-${rnd()}`, orgRef, userId]);
  if (o.member ?? true) await addMembership(pool, orgRef, userId);
  return userId;
}
async function legacy(userId: number, tenantId: string, o: { verifiedBy?: number | null; expiresAt?: Date | null; recordedAt?: Date } = {}) {
  const verifiedBy = o.verifiedBy === undefined ? 1 : o.verifiedBy;
  await pool.execute(
    `INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, issuedAt, expiresAt, verificationState, verifiedByUserId, verifiedAt, recordedByUserId, recordedAt)
     VALUES (?,?,?,?,?,?,'verified',?,?,1,?)`,
    [`WQ-${rnd()}`, tenantId, userId, CODE, days(-100), o.expiresAt === undefined ? days(200) : o.expiresAt, verifiedBy, verifiedBy ? days(-90) : null, o.recordedAt ?? days(-90)]);
}

/** The retired marketplace read (marketplaceReadinessFacts before the port), reproduced to pin the difference. */
async function oldRead(userId: number): Promise<{ held: boolean; notHeld: string | null }> {
  const db = (await getDb())!;
  const recorded = await db.select().from(workerQualifications).where(inArray(workerQualifications.userId, [userId]));
  const issued = await db.select().from(academyQualifications).where(inArray(academyQualifications.userId, [userId]));
  const holdings: QualificationHolding[] = [
    ...recorded.map(r => ({ holdingRef: r.holdingRef, code: r.code, verificationState: r.verificationState, issuedAt: r.issuedAt, expiresAt: r.expiresAt, recordedAt: r.recordedAt })),
    ...issued.map(q => ({
      holdingRef: q.qualificationRef, code: q.qualificationCode,
      verificationState: (q.status === "current" || q.status === "expired" ? "verified" : q.status === "pending" ? "unverified" : "rejected") as QualificationHolding["verificationState"],
      issuedAt: q.validFrom, expiresAt: q.expiresAt, recordedAt: q.verifiedAt ?? q.validFrom ?? q.createdAt,
    })),
  ];
  const newest = holdings.filter(h => h.code === CODE).sort((x, y) => y.recordedAt.getTime() - x.recordedAt.getTime())[0];
  const v = heldFromValidity(qualificationValidity(holdings, CODE, NOW), CODE, newest?.verificationState === "extracted" ? "extracted" : "unverified");
  return { held: v.held, notHeld: v.code };
}

type Answer = { held: boolean; notHeld: string | null };
async function answers(orgRef: string, userId: number): Promise<{ old: Answer; adapter: Answer & { source: string | null }; openShift: Answer; market: Answer; marketRow: string }> {
  const db = (await getDb())!;
  const [a] = await effectiveQualifications(db, { tenantId: orgRef, userId, at: NOW, codes: [CODE] });
  const facts = await personFacts(db, orgRef, { startsAt: NOW, endsAt: days(0.5), requiredQualifications: [CODE] } as unknown as ShiftPost, userId);
  const shift = facts.qualifications.find(q => q.code === CODE);
  const posting = {
    id: -1, clientOrgRef: `ORG-CLIENT-${rnd()}`, distribution: "public", state: "bidding_open", biddingClosesAt: null, unitsRequired: 1,
    requirementsJson: JSON.stringify({ workerQualificationCodes: [CODE] }),
  } as unknown as MarketplacePostingRow;
  const mf = await gatherReadinessFacts(db, { posting, bidderOrgRef: orgRef, unitsOffered: null, stage: "standing" }, NOW);
  const w = mf.workers.find(x => x.userId === userId)!;
  const q = w.qualifications.find(x => x.code === CODE);
  const row = evaluateMarketplaceReadiness(mf, NOW).checks.find(c => c.check === "worker_qualifications")!;
  return {
    old: await oldRead(userId),
    adapter: { held: a.held, notHeld: a.notHeld, source: a.source },
    // Open shifts reads nobody outside the organization (`inOrganization: false`, no qualifications):
    // the same fail-closed unknown the adapter gives.
    openShift: shift ? { held: shift.held, notHeld: shift.notHeld } : { held: false, notHeld: facts.inOrganization ? null : "unknown" },
    market: { held: q?.held ?? false, notHeld: q?.notHeld ?? null },
    marketRow: row.result,
  };
}

/** The three canonical consumers agree, and the marketplace row follows the adapter. */
function agree(r: Awaited<ReturnType<typeof answers>>, expected: Answer) {
  expect(r.adapter).toMatchObject(expected);
  expect(r.openShift).toEqual(expected);
  expect(r.market).toEqual(expected);
  expect(r.marketRow).toBe(expected.held ? "PASS" : "BLOCK");
}

d("marketplace reads qualifications as every other canonical consumer does", () => {
  it("1. verified Academy grant: held everywhere", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE);
    const r = await answers(o, u);
    agree(r, { held: true, notHeld: null });
    expect(r.adapter.source).toBe("ACADEMY_QUALIFICATION");
    expect(r.old).toEqual({ held: true, notHeld: null });
  });

  it("2. unverified (pending) Academy grant: not held, unverified", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { status: "pending", verified: false });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unverified" });
    expect(r.old).toEqual({ held: false, notHeld: "unverified" });
  });

  it("3. expired Academy grant: not held, expired", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { status: "expired", validFrom: days(-400), expiresAt: days(-5) });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "expired" });
    expect(r.old.held).toBe(false);
  });

  it("4. future-effective Academy grant: not held yet", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { validFrom: days(10), expiresAt: days(400) });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unverified" });
  });

  it("5a. superseded: a later verified grant governs over the earlier one, even when it reads worse", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { validFrom: days(-200), expiresAt: days(300), createdAt: days(-200) });
    await grantAcademyQualification(pool, u, CODE, { status: "expired", validFrom: days(-100), expiresAt: days(-5), createdAt: days(-100) });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "expired" });
    expect(r.old.held).toBe(false);
  });

  it("5b. a current grant followed by a later revoked row: every canonical consumer gives the engine's one answer", async () => {
    // FINDING (raised with the owner, not changed here): the canonical engine takes the latest VERIFIED
    // version, and a revoked Academy row maps to `rejected`, so a later revocation row does not withdraw
    // an earlier current grant. That is the qualification engine's rule; the marketplace must not decide
    // otherwise on its own, so this pins only that it agrees with the adapter and open shifts.
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { createdAt: days(-100) });
    await grantAcademyQualification(pool, u, CODE, { status: "revoked", createdAt: days(-10) });
    const r = await answers(o, u);
    agree(r, { held: r.adapter.held, notHeld: r.adapter.notHeld });
    expect(r.adapter.held).toBe(true);
  });

  it("6a. legacy holding with a recorded verifier and no Academy grant: held as a marked fallback", async () => {
    const o = await org(); const u = await worker(o);
    await legacy(u, o);
    const r = await answers(o, u);
    agree(r, { held: true, notHeld: null });
    expect(r.adapter.source).toBe("LEGACY_WORKER_QUALIFICATION");
    expect(r.old).toEqual({ held: true, notHeld: null });
  });

  it("6b. legacy holding marked verified with no verifier: old read HELD it; canonical reads unknown", async () => {
    const o = await org(); const u = await worker(o);
    await legacy(u, o, { verifiedBy: null });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unknown" });
    expect(r.old.held).toBe(true);   // the difference: a verification claim with no provenance no longer counts
  });

  it("7. Academy rejection versus a newer verified legacy holding: old read HELD it; the Academy record governs", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { status: "rejected" });
    await legacy(u, o, { recordedAt: days(-1) });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "rejected" });
    expect(r.adapter.source).toBe("ACADEMY_QUALIFICATION");
    expect(r.old.held).toBe(true);   // the difference: newest-record-wins let the legacy row overrule the Academy
  });

  it("8. a renewal supersedes the expired grant before it: held", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { status: "expired", validFrom: days(-500), expiresAt: days(-130), createdAt: days(-500) });
    await grantAcademyQualification(pool, u, CODE, { validFrom: days(-120), expiresAt: days(245), createdAt: days(-120) });
    const r = await answers(o, u);
    agree(r, { held: true, notHeld: null });
    expect(r.old).toEqual({ held: true, notHeld: null });
  });

  it("9. a current grant with no expiry: unknown, never held", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { expiresAt: null });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unknown" });
    expect(r.old).toEqual({ held: false, notHeld: "unknown" });
  });

  it("10a. a listed worker who is not a member of the bidding organization: old read HELD it; canonical reads unknown", async () => {
    const o = await org(); const u = await worker(o, { member: false });
    await grantAcademyQualification(pool, u, CODE);
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unknown" });
    expect(r.old.held).toBe(true);   // the difference: the organization's scope is now enforced on the read
  });

  it("10b. a legacy holding recorded for another organization: old read HELD it; canonical reads unknown", async () => {
    const o = await org(); const other = await org(); const u = await worker(o);
    await legacy(u, other);
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unknown" });
    expect(r.old.held).toBe(true);   // the difference: legacy rows are read only for the acting organization
  });

  it("11a. nothing on record: unknown", async () => {
    const o = await org(); const u = await worker(o);
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unknown" });
    expect(r.old).toEqual({ held: false, notHeld: "unknown" });
  });

  it("11b. an external-credential grant whose evidence document is missing: old read HELD it; canonical reads unknown", async () => {
    const o = await org(); const u = await worker(o);
    await grantAcademyQualification(pool, u, CODE, { sourceKind: "external_credential", complianceDocumentId: 2_000_000_000 });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "unknown" });
    expect(r.old.held).toBe(true);   // the difference: a credential grant cannot outlive (or exist without) its document
  });

  it("11c. an external-credential grant whose evidence document has expired: not held, expired", async () => {
    const o = await org(); const u = await worker(o);
    const [doc] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'h2s_certificate', 'Fixture H2S card', NOW(), ?, 'verified')",
      [u, days(-3)]);
    await grantAcademyQualification(pool, u, CODE, { sourceKind: "external_credential", complianceDocumentId: doc.insertId });
    const r = await answers(o, u);
    agree(r, { held: false, notHeld: "expired" });
  });
});
