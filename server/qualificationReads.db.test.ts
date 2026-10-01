/**
 * C1b-3 — the D-05 qualification read adapter, and the four readers that now use it.
 *
 * Every qualification, certificate and document below is a test fixture. Numbered cases are the owner's
 * required list (qualification adapter 11–25).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import type { DomainRole } from "./_core/recordsAuthorization";
import { getDb, grantUserRole } from "./db";
import { academyVerdict, effectiveQualifications, legacyVerdict } from "./qualificationReads";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 887_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const AT = new Date("2026-11-10T06:00:00Z");
const DAY = 86_400_000;
const days = (n: number) => new Date(AT.getTime() + n * DAY);
beforeAll(async () => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
async function member(role: DomainRole, orgRef: string) {
  const id = await withRole(role);
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, id]);
  return id;
}
async function org() { const o = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [o, o]); return o; }
async function operatorRow(id: number) {
  // Open Work (#59) reaches a person's operator record through `operators.userId`, and #52 reads the
  // legacy licence date alone as unverified, so a ready driver also carries a verified licence document.
  await pool.execute("INSERT INTO operators (id, userId, name, licenseClass, licenseExpiresAt, createdAt) VALUES (?,?,?,?,?,NOW())", [id, id, `Op ${rnd()}`, "1", new Date("2028-01-01T00:00:00Z")]);
  await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'driver_licence', 'Driver licence', NOW(), ?, 'verified')", [id, new Date("2028-01-01T00:00:00Z")]);
}
async function academy(userId: number, code: string, o: { status?: string; expiresAt?: Date | null; sourceKind?: string; complianceDocumentId?: number | null; createdAt?: Date } = {}) {
  const ref = `AQ-${rnd()}${rnd()}`;
  await pool.execute(
    `INSERT INTO academyQualifications (qualificationRef, userId, qualificationCode, sourceKind, status, complianceDocumentId, validFrom, expiresAt, verifiedByUserId, verifiedAt, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [ref, userId, code, o.sourceKind ?? "academy_certificate", o.status ?? "current", o.complianceDocumentId ?? null,
      new Date("2026-01-01T00:00:00Z"), o.expiresAt === undefined ? days(300) : o.expiresAt, 1, new Date("2026-01-01T00:00:00Z"), o.createdAt ?? new Date("2026-01-01T00:00:00Z")]);
  return ref;
}
async function legacy(userId: number, code: string, o: { state?: string; expiresAt?: Date | null; verifiedBy?: number | null; tenantId?: string | null } = {}) {
  const ref = `WQ-${rnd()}${rnd()}`;
  const state = o.state ?? "verified";
  const verifiedBy = o.verifiedBy === undefined ? (state === "verified" ? 1 : null) : o.verifiedBy;
  await pool.execute(
    `INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt, verifiedByUserId, verifiedAt, certificateNumber)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [ref, o.tenantId === undefined ? "default" : o.tenantId, userId, code, state, o.expiresAt === undefined ? days(200) : o.expiresAt, 1,
      new Date("2026-01-01T00:00:00Z"), verifiedBy, verifiedBy ? new Date("2026-01-02T00:00:00Z") : null, `CERT-${rnd()}`]);
  return ref;
}
async function document(ownerId: number, o: { verification?: string; expiresAt?: Date | null } = {}) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus)
     VALUES ('operator', ?, 'tdg_certificate', 'Fixture external TDG', NOW(), ?, ?)`,
    [ownerId, o.expiresAt === undefined ? days(200) : o.expiresAt, o.verification ?? "verified"]);
  return r.insertId;
}
const read = async (userId: number, codes?: string[], tenantId = "default") =>
  effectiveQualifications((await getDb())!, { tenantId, userId, at: AT, codes });

/* ------------------------------------------------------------------ */
/* Precedence                                                          */
/* ------------------------------------------------------------------ */

d("precedence", () => {
  it("11. an Academy qualification is the answer, with its provenance", async () => {
    const u = await withRole("driver");
    const ref = await academy(u, "TDG");
    const [q] = await read(u, ["TDG"]);
    expect(q).toMatchObject({
      source: "ACADEMY_QUALIFICATION", sourceRef: ref, academyQualificationRef: ref, legacyFallback: false,
      held: true, state: "in_force", verification: "current", issuer: "academy:academy_certificate", orgRef: "default", userId: u,
    });
  });

  it("12. an external credential links its compliance document as evidence, and cannot outlive it", async () => {
    const u = await withRole("driver");
    const good = await document(u);
    await academy(u, "TDG", { sourceKind: "external_credential", complianceDocumentId: good });
    const [q] = await read(u, ["TDG"]);
    expect(q.evidence).toEqual({ complianceDocumentId: good, docType: "tdg_certificate", state: "in_force" });
    expect(q.held).toBe(true);

    const v = await withRole("driver");
    const lapsed = await document(v, { expiresAt: days(-3) });
    await academy(v, "TDG", { sourceKind: "external_credential", complianceDocumentId: lapsed });
    const [r] = await read(v, ["TDG"]);
    expect(r).toMatchObject({ held: false, notHeld: "expired", evidence: { state: "expired" } });
    expect(r.discrepancies.map((x) => x.kind)).toContain("EVIDENCE_NOT_IN_FORCE");
  });

  it("13/16. with no Academy record, a legacy holding is used — and says it is legacy", async () => {
    const u = await withRole("driver");
    const ref = await legacy(u, "TDG");
    const [q] = await read(u, ["TDG"]);
    expect(q).toMatchObject({ source: "LEGACY_WORKER_QUALIFICATION", sourceRef: ref, legacyFallback: true, held: true, academyQualificationRef: null });
    expect(q.issuer).toMatch(/^legacy:/);
    expect(q.certificateNumber).toMatch(/^CERT-/);
  });

  it("14. the Academy record beats a conflicting legacy one, and the conflict is reported, not resolved by rewriting", async () => {
    const u = await withRole("driver");
    await academy(u, "TDG", { status: "rejected" });
    const legacyRef = await legacy(u, "TDG");
    const [q] = await read(u, ["TDG"]);
    expect(q).toMatchObject({ source: "ACADEMY_QUALIFICATION", held: false, notHeld: "rejected" });
    expect(q.discrepancies).toEqual([expect.objectContaining({ kind: "LEGACY_DISAGREES", ref: legacyRef })]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT verificationState FROM workerQualifications WHERE holdingRef = ?", [legacyRef]);
    expect(rows[0].verificationState).toBe("verified"); // untouched
  });

  it("15. an expired Academy qualification is not rescued by a valid-looking legacy row", async () => {
    const u = await withRole("driver");
    await academy(u, "TDG", { expiresAt: days(-10) });
    await legacy(u, "TDG", { expiresAt: days(400) });
    const [q] = await read(u, ["TDG"]);
    expect(q).toMatchObject({ source: "ACADEMY_QUALIFICATION", held: false, notHeld: "expired", state: "expired" });
    // Nor by an Academy status the dates would contradict.
    const v = await withRole("driver");
    await academy(v, "TDG", { status: "expired", expiresAt: days(100) });
    await legacy(v, "TDG");
    const [r] = await read(v, ["TDG"]);
    expect(r).toMatchObject({ held: false, notHeld: "expired" });
  });

  it("17. a legacy row that says verified with no recorded verifier is UNKNOWN, not held", async () => {
    const u = await withRole("driver");
    await legacy(u, "TDG", { verifiedBy: null });
    const [q] = await read(u, ["TDG"]);
    expect(q).toMatchObject({ source: "LEGACY_WORKER_QUALIFICATION", held: false, notHeld: "unknown", state: "unverified" });
    expect(q.reason).toContain("provenance is insufficient");
  });

  it("nothing on record is UNKNOWN; every code on record is listed when none are asked for", async () => {
    const u = await withRole("driver");
    expect((await read(u, ["TDG"]))[0]).toMatchObject({ source: null, held: false, notHeld: "unknown", state: "none" });
    await academy(u, "H2S");
    await legacy(u, "TDG");
    expect((await read(u)).map((q) => [q.code, q.source])).toEqual([["H2S", "ACADEMY_QUALIFICATION"], ["TDG", "LEGACY_WORKER_QUALIFICATION"]]);
  });
});

/* ------------------------------------------------------------------ */
/* Tenancy                                                              */
/* ------------------------------------------------------------------ */

d("tenancy", () => {
  it("22/23. another organization's person, and another organization's legacy rows, are not read", async () => {
    const a = await org(); const b = await org();
    const personA = await member("driver", a);
    await academy(personA, "TDG");
    await legacy(personA, "H2S", { tenantId: a });
    // In organization A: both read.
    expect((await read(personA, ["TDG", "H2S"], a)).map((q) => q.held)).toEqual([true, true]);
    // From organization B: nothing about A's person is read — every code is UNKNOWN.
    expect((await read(personA, ["TDG", "H2S"], b)).map((q) => [q.source, q.notHeld])).toEqual([[null, "unknown"], [null, "unknown"]]);
    // A legacy row stamped for another organization is not visible even for the right person.
    const personB = await member("driver", b);
    await legacy(personB, "TDG", { tenantId: a });
    expect((await read(personB, ["TDG"], b))[0].source).toBeNull();
  });

  it("23. the readers take the organization from the caller's scope — a dispatcher in B cannot read A's person", async () => {
    const a = await org(); const b = await org();
    const personA = await member("driver", a);
    await operatorRow(personA);
    await academy(personA, "TDG");
    const dispatcherB = await member("dispatcher", b);
    const r = await caller(dispatcherB).readiness.forTime({ startsAt: AT, requiredQualifications: ["TDG"], userId: personA });
    expect(mark(r.lines, "TDG")).toBe("UNKNOWN");
    const dispatcherA = await member("dispatcher", a);
    const ok = await caller(dispatcherA).readiness.forTime({ startsAt: AT, requiredQualifications: ["TDG"], userId: personA });
    expect(mark(ok.lines, "TDG")).toBe("OK");
  });
});

// Readiness lines are rendered "MARK · label — reason"; the mark is the check's state.
const mark = (lines: string[], label: string) => lines.find((l) => l.split(" — ")[0].endsWith(` · ${label}`))?.split(" · ")[0];

/* ------------------------------------------------------------------ */
/* The four readers                                                    */
/* ------------------------------------------------------------------ */

d("the four readers read through the adapter", () => {
  it("18. shift readiness counts an Academy qualification with no legacy row", async () => {
    const u = await withRole("driver");
    await operatorRow(u);
    await academy(u, "TDG");
    const r = await caller(u).readiness.forTime({ startsAt: AT, requiredQualifications: ["TDG"] });
    expect(mark(r.lines, "TDG")).toBe("OK");
  });

  it("20. open shifts: eligible on an Academy qualification; the canonical record governs a conflicting legacy one", async () => {
    const dispatcher = await withRole("dispatcher");
    const p = await caller(dispatcher).shifts.post({ title: "DG haul", startsAt: AT, endsAt: new Date(AT.getTime() + 12 * 3600_000), requiredRole: "driver", requiredQualifications: ["TDG"] });
    const good = await withRole("driver"); await operatorRow(good); await academy(good, "TDG");
    const bad = await withRole("driver"); await operatorRow(bad); await academy(bad, "TDG", { expiresAt: days(-1) }); await legacy(bad, "TDG");
    expect((await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: good })).eligible).toBe(true);
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: bad });
    expect(e.eligible).toBe(false);
    expect(e.reasons.some((r: { code: string }) => r.code === "qualification_expired")).toBe(true);
  });

  /*
   * Open work through the same adapter (#59 reconciled with main). The board decides nothing about a
   * ticket itself: each of these is the adapter's verdict arriving through `shifts.eligibility`.
   */
  const tdgPost = async (dispatcher: number) =>
    caller(dispatcher).shifts.post({ title: "DG haul", startsAt: AT, endsAt: new Date(AT.getTime() + 12 * 3600_000), requiredRole: "driver", requiredQualifications: ["TDG"] });
  const tdgGap = (e: { reasons: { code: string }[] }) => e.reasons.filter((r) => r.code.startsWith("qualification_")).map((r) => r.code);

  it("20a. open shifts: a revoked Academy grant fails closed, and a legacy row does not rescue it", async () => {
    const dispatcher = await withRole("dispatcher");
    const p = await tdgPost(dispatcher);
    const u = await withRole("driver"); await operatorRow(u);
    await academy(u, "TDG", { status: "revoked" }); await legacy(u, "TDG");
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: u });
    expect(e.eligible).toBe(false);
    expect(tdgGap(e)).toHaveLength(1);
  });

  it("20b. open shifts: a holding stamped for another organization cannot satisfy this organization's post", async () => {
    const a = await org(); const b = await org();
    const dispatcherB = await member("dispatcher", b);
    const p = await tdgPost(dispatcherB);
    const u = await member("driver", b); await operatorRow(u);
    await legacy(u, "TDG", { tenantId: a });
    const e = await caller(dispatcherB).shifts.eligibility({ postRef: p.postRef, userId: u });
    expect(e.eligible).toBe(false);
    expect(tdgGap(e)).toEqual(["qualification_unknown"]);
  });

  it("20c. open shifts: precedence decides between grants, not insertion order", async () => {
    const dispatcher = await withRole("dispatcher");
    const p = await tdgPost(dispatcher);
    const u = await withRole("driver"); await operatorRow(u);
    // The newer, unasserted grant is written first; the older current one second.
    await academy(u, "TDG", { status: "pending", createdAt: new Date("2026-06-01T00:00:00Z") });
    await academy(u, "TDG", { createdAt: new Date("2026-01-01T00:00:00Z") });
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: u });
    expect(tdgGap(e)).toEqual([]);
    expect(e.eligible).toBe(true);
  });

  it("20d. open shifts: a grant with no expiry is not dispatch-valid (no qualification type is expiry-optional)", async () => {
    const dispatcher = await withRole("dispatcher");
    const p = await tdgPost(dispatcher);
    const u = await withRole("driver"); await operatorRow(u);
    await academy(u, "TDG", { expiresAt: null });
    const e = await caller(dispatcher).shifts.eligibility({ postRef: p.postRef, userId: u });
    expect(e.eligible).toBe(false);
    expect(tdgGap(e)).toHaveLength(1);
  });

  it("19. crews count an Academy ticket holder", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const holder = seq++;
    await operatorRow(holder);
    await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: holder, crewRole: "driver", rotation: { onDays: 7, offDays: 7, anchor: AT }, joinedAt: AT });
    await academy(holder, "TDG");
    const f = await caller(dispatcher).crews.forecast({ crewRef: c.crewRef, from: AT, days: 1, neededPerDay: 1, requirements: [{ qualification: "TDG", neededHolders: 1 }] });
    expect(f.days[0].state).not.toBe("short_qualification");
  });

  it("21. the calendar shows an Academy qualification's expiry, attributed to the Academy", async () => {
    const u = await withRole("driver");
    const ref = await academy(u, "TDG", { expiresAt: new Date(Date.now() + 5 * DAY) });
    const c = await caller(u).calendar.mine({ from: new Date(), days: 30 });
    const e = c.events.find((x: { title: string }) => x.title.includes("TDG expires"));
    expect(e?.source).toMatchObject({ sourceType: "academyQualification", sourceRef: ref });
  });
});

/* ------------------------------------------------------------------ */
/* Pure                                                                 */
/* ------------------------------------------------------------------ */

describe("pure verdicts", () => {
  const T = new Date("2026-11-10T00:00:00Z");
  const aq = (id: number, status: string, expiresAt: Date | null, createdAt: string) => ({
    id, qualificationRef: `AQ${id}`, userId: 1, qualificationCode: "TDG", sourceKind: "academy_certificate", status, courseVersionId: null,
    certificateId: null, complianceDocumentId: null, validFrom: null, expiresAt, scopeJson: null, verifiedByUserId: 1, verifiedAt: null,
    createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
  }) as never;
  it("a newer pending Academy record does not displace a current one", () => {
    const { validity, chosen } = academyVerdict([aq(1, "current", new Date("2027-01-01"), "2026-01-01"), aq(2, "pending", new Date("2028-01-01"), "2026-06-01")], T);
    expect(validity.state).toBe("in_force");
    expect((chosen as unknown as { qualificationRef: string }).qualificationRef).toBe("AQ1");   // academyVerdict is generic over the row now; the fixtures are `as never`
  });
  it("a revoked Academy record is not held", () => {
    expect(academyVerdict([aq(1, "revoked", new Date("2027-01-01"), "2026-01-01")], T).validity.state).toBe("rejected");
  });
  it("a legacy row with no verifier reads UNKNOWN", () => {
    const row = { id: 1, holdingRef: "H1", tenantId: "default", userId: 1, code: "TDG", certificateNumber: null, issuedAt: null, expiresAt: new Date("2027-01-01"),
      verificationState: "verified", verifiedByUserId: null, verifiedAt: null, documentRef: null, supersededByHoldingRef: null, recordedByUserId: 1,
      recordedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01") } as never;
    expect(legacyVerdict([row], "TDG", T)).toMatchObject({ insufficient: true, held: { held: false, code: "unknown" } });
  });
});
