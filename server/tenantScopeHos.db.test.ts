/**
 * P0-A1 — hours of service belong to the organization that owns the operator.
 *
 * The chain this suite defends, read from the schema rather than asserted:
 *
 *   caller → organizationMemberships (active, in its effective window) → orgRef
 *          → coreRecordOwnership(recordType = 'operator', recordId) → operators.id
 *          → dutyRecords.operatorId / hosAttestations.operatorId / complianceDocuments(ownerType = 'operator')
 *
 * A caller-supplied operator id is never authority. Across the boundary the answer is the same
 * "Operator N not found" a nonexistent id gets — never "forbidden", never a company name, never a
 * driver's name — so another organization's ids cannot be confirmed to exist. Every case goes
 * through `appRouter.createCaller`, the production boundary, not a helper.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 271_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

/** Roles that together hold hos.read, hos.write, hos.attest and hos.recordScannedLog, plus amendment authority. */
const HOS_ROLES = ["dispatcher", "management", "office"];

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
type Window = { status?: "active" | "suspended" | "ended"; from?: string; to?: string | null };
async function membership(userId: number, orgRef: string, w: Window = {}) {
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, effectiveTo, createdByUserId) VALUES (?,?,?,'employee',?,?,?,1)",
    [`MEM-${rnd()}`, orgRef, userId, w.status ?? "active", w.from ?? "2020-01-01", w.to ?? null],
  );
}
async function grant(userId: number, roles: string[]) {
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
}
async function member(orgRef: string | null, roles = HOS_ROLES, w: Window = {}) {
  const userId = seq++;
  if (orgRef) await membership(userId, orgRef, w);
  await grant(userId, roles);
  return userId;
}
async function operatorOwnedBy(orgRef: string | null, userId: number | null = null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId) VALUES (?, ?)", [`Driver ${rnd()}`, userId]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, r.insertId]);
  return r.insertId;
}
async function duty(operatorId: number, n: number, hoursAgoStart = 30) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = new Date(Date.now() - (hoursAgoStart - i) * 60 * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [r] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt, durationMinutes, source) VALUES (?, 'driving', ?, ?, 30, 'fixture')",
      [operatorId, start, end],
    );
    ids.push(r.insertId);
  }
  return ids;
}
const count = async (sql: string, args: (string | number)[]) => Number(((await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as { n: number }).n);
const notFoundFor = (id: number) => ({ code: "NOT_FOUND", message: `Operator ${id} not found` });
const CTX = { carrierAuthority: "federal" as const, jurisdiction: "AB", latitude: 51.0, at: new Date() };

d("HOS reads and feasibility are refused across the organization boundary", () => {
  it("HOS-T1/T2/T8/T9 — status and trip feasibility: foreign operator refused exactly like a nonexistent one; the owner is served", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A);
    const opA = await operatorOwnedBy(A), opB = await operatorOwnedBy(B);
    await duty(opA, 3); await duty(opB, 5);
    const ghost = 900_000_000 + Math.floor(Math.random() * 1_000_000);

    // T1 — status by a foreign operator id: refused, and refused as not-found.
    await expect(callerFor(dispA).hos.status({ ...CTX, operatorId: opB })).rejects.toMatchObject(notFoundFor(opB));
    // T2 — feasibility by a foreign operator id: refused the same way. A yes/no would still leak B's clocks.
    await expect(callerFor(dispA).hos.tripFeasibility({ ...CTX, operatorId: opB, estimatedDriveMinutes: 60 })).rejects.toMatchObject(notFoundFor(opB));
    // T8 — a nonexistent id gets the identical code and message shape, so existence is not disclosed.
    await expect(callerFor(dispA).hos.status({ ...CTX, operatorId: ghost })).rejects.toMatchObject(notFoundFor(ghost));
    await expect(callerFor(dispA).hos.tripFeasibility({ ...CTX, operatorId: ghost, estimatedDriveMinutes: 60 })).rejects.toMatchObject(notFoundFor(ghost));
    // T9 — the owner is served, and the count is the owner's rows only.
    await expect(callerFor(dispA).hos.status({ ...CTX, operatorId: opA })).resolves.toMatchObject({ operatorId: opA, dutyRecordsRead: 3 });
    await expect(callerFor(dispA).hos.tripFeasibility({ ...CTX, operatorId: opA, estimatedDriveMinutes: 60 })).resolves.toMatchObject({ operatorId: opA });
  }, 60_000);

  it("HOS-T3/T5/T6/T7 — the duty-record list is tenant-filtered in the query: no foreign rows, no foreign counts, no foreign ids by operator", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A), dispB = await member(B);
    const opA = await operatorOwnedBy(A), opB = await operatorOwnedBy(B);
    const idsA = await duty(opA, 4); const idsB = await duty(opB, 12);

    // T3 — a foreign operator id on the list is refused like a nonexistent one.
    await expect(callerFor(dispA).fieldRoute.dutyRecords.list({ operatorId: opB })).rejects.toMatchObject(notFoundFor(opB));
    // T5/T6/T7 — the unfiltered list returns the caller's organization only: every row is A's, none is B's,
    // and the count is A's count. B has more rows than A, so a global limit could not hide the leak.
    const listA = await callerFor(dispA).fieldRoute.dutyRecords.list();
    expect(listA.map(r => r.id).sort()).toEqual([...idsA].sort());
    expect(listA.some(r => idsB.includes(r.id))).toBe(false);
    expect(listA.some(r => r.operatorId === opB)).toBe(false);
    const listB = await callerFor(dispB).fieldRoute.dutyRecords.list();
    expect(listB).toHaveLength(12);
    expect(listB.every(r => r.operatorId === opB)).toBe(true);
  }, 60_000);

  it("HOS-T18 — HOS-backed dispatch readiness refuses a foreign operator through the router too", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A);
    const opB = await operatorOwnedBy(B);
    const r = callerFor(dispA).dispatch.readiness({ operatorId: opB, unitId: null });
    await expect(r).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(r).rejects.not.toMatchObject({ message: expect.stringContaining(B) });
  }, 60_000);
});

d("HOS mutations prove ownership independently of the permission", () => {
  it("HOS-T4/T15/T16 — attest, scanned log and duty-record amendment: foreign operator refused with nothing written; own operator accepted", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A);
    const opA = await operatorOwnedBy(A), opB = await operatorOwnedBy(B);
    const today = new Date().toISOString().slice(0, 10);
    // B already has a live attestation for today; A's refused attempt must not supersede it.
    const dispB = await member(B);
    await callerFor(dispB).hos.attestHours({ operatorId: opB, dutyDate: today, method: "paper_log_reviewed", statement: "Reviewed the book for the day, totals not computed." });
    const before = {
      att: await count("SELECT COUNT(*) n FROM hosAttestations WHERE operatorId = ?", [opB]),
      live: await count("SELECT COUNT(*) n FROM hosAttestations WHERE operatorId = ? AND supersededAt IS NULL", [opB]),
      docs: await count("SELECT COUNT(*) n FROM complianceDocuments WHERE ownerType = 'operator' AND ownerId = ?", [opB]),
      duty: await count("SELECT COUNT(*) n FROM dutyRecords WHERE operatorId = ?", [opB]),
    };

    // T4 — the attestation is the HOS event here; a foreign operator's is refused as not-found.
    await expect(callerFor(dispA).hos.attestHours({ operatorId: opB, dutyDate: today, method: "driver_declaration", statement: "The driver told me they had a full rest last night." })).rejects.toMatchObject(notFoundFor(opB));
    // T15 — every HOS mutation, with the right permission and the wrong company.
    await expect(callerFor(dispA).hos.recordScannedLog({ operatorId: opB, dutyDate: today, storageKey: `hos/${rnd()}/page.jpg`, note: "Scanned from the binder in the dispatch office." })).rejects.toMatchObject(notFoundFor(opB));
    await expect(callerFor(dispA).fieldRoute.dutyRecords.create({ operatorId: opB, dutyStatus: "on_duty", startedAt: new Date(Date.now() - 60 * 60_000), endedAt: new Date() })).rejects.toMatchObject(notFoundFor(opB));
    // Nothing was written to B, and B's live attestation was not superseded.
    expect(await count("SELECT COUNT(*) n FROM hosAttestations WHERE operatorId = ?", [opB])).toBe(before.att);
    expect(await count("SELECT COUNT(*) n FROM hosAttestations WHERE operatorId = ? AND supersededAt IS NULL", [opB])).toBe(before.live);
    expect(await count("SELECT COUNT(*) n FROM complianceDocuments WHERE ownerType = 'operator' AND ownerId = ?", [opB])).toBe(before.docs);
    expect(await count("SELECT COUNT(*) n FROM dutyRecords WHERE operatorId = ?", [opB])).toBe(before.duty);

    // T16 — the same calls on the caller's own operator succeed.
    await expect(callerFor(dispA).hos.attestHours({ operatorId: opA, dutyDate: today, method: "paper_log_reviewed", statement: "Reviewed the book for the day, totals not computed." })).resolves.toMatchObject({ provenance: "attested" });
    await expect(callerFor(dispA).hos.recordScannedLog({ operatorId: opA, dutyDate: today, storageKey: `hos/${rnd()}/page.jpg`, note: "Scanned from the binder in the dispatch office." })).resolves.toMatchObject({ source: "scanned_paper" });
    const created = await callerFor(dispA).fieldRoute.dutyRecords.create({ operatorId: opA, dutyStatus: "on_duty", startedAt: new Date(Date.now() - 60 * 60_000), endedAt: new Date() });
    expect(typeof created).toBe("number");
    expect(await count("SELECT COUNT(*) n FROM dutyRecords WHERE id = ? AND operatorId = ?", [Number(created), opA])).toBe(1);
  }, 60_000);

  it("HOS-T15b — a driver whose own operator record belongs to another company cannot write duty records to it through the self path", async () => {
    const A = await org(), B = await org();
    // The person drove for B, left, and now works for A — but their operator record is still B's.
    const person = seq++;
    await membership(person, B, { status: "ended", to: "2025-01-01" });
    await membership(person, A);
    await grant(person, ["driver"]);
    const opB = await operatorOwnedBy(B, person);
    const dutyBefore = await count("SELECT COUNT(*) n FROM dutyRecords WHERE operatorId = ?", [opB]);
    await expect(callerFor(person).fieldRoute.dutyRecords.create({ dutyStatus: "driving", startedAt: new Date(Date.now() - 60 * 60_000), endedAt: new Date() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await count("SELECT COUNT(*) n FROM dutyRecords WHERE operatorId = ?", [opB])).toBe(dutyBefore);
  }, 60_000);

  it("HOS-T17 — a revoked HOS permission still fails inside the right company", async () => {
    const A = await org();
    const dispA = await member(A);
    const opA = await operatorOwnedBy(A);
    await pool.execute("UPDATE userRoleAssignments SET revokedAt = NOW(), revokedByUserId = 1, revokeReason = 'fixture' WHERE userId = ?", [dispA]);
    await expect(callerFor(dispA).hos.status({ ...CTX, operatorId: opA })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

d("multi-company users act for one organization at a time", () => {
  it("HOS-T10/T11 — acting as A reaches A's HOS only; acting as B reaches B's only; two live memberships are refused, never unioned", async () => {
    const A = await org(), B = await org();
    const opA = await operatorOwnedBy(A), opB = await operatorOwnedBy(B);
    await duty(opA, 2); await duty(opB, 2);
    const person = seq++;
    await grant(person, HOS_ROLES);
    // Acting as A: B's membership has ended.
    await membership(person, A, { from: "2020-01-01" });
    await membership(person, B, { status: "ended", from: "2019-01-01", to: "2019-12-31" });
    await expect(callerFor(person).hos.status({ ...CTX, operatorId: opA })).resolves.toMatchObject({ operatorId: opA, dutyRecordsRead: 2 });
    await expect(callerFor(person).hos.status({ ...CTX, operatorId: opB })).rejects.toMatchObject(notFoundFor(opB));
    expect((await callerFor(person).fieldRoute.dutyRecords.list()).every(r => r.operatorId === opA)).toBe(true);

    // Switch: A's membership ends, B's becomes the live one.
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = '2025-01-01' WHERE userId = ? AND orgRef = ?", [person, A]);
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, B]);
    await expect(callerFor(person).hos.status({ ...CTX, operatorId: opB })).resolves.toMatchObject({ operatorId: opB, dutyRecordsRead: 2 });
    await expect(callerFor(person).hos.status({ ...CTX, operatorId: opA })).rejects.toMatchObject(notFoundFor(opA));
    expect((await callerFor(person).fieldRoute.dutyRecords.list()).every(r => r.operatorId === opB)).toBe(true);

    // Two live memberships and no selection: refused outright. Not A, not B, not both.
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, A]);
    await expect(callerFor(person).hos.status({ ...CTX, operatorId: opA })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(person).hos.status({ ...CTX, operatorId: opB })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(person).fieldRoute.dutyRecords.list()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }, 60_000);
});

d("an ended membership is a hard boundary", () => {
  it("HOS-T12/T13 — an ex-member with every historical grant, and a fresh grant, reaches nothing of the company", async () => {
    const A = await org();
    const opA = await operatorOwnedBy(A);
    await duty(opA, 2);
    const ex = await member(A, HOS_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    // An ended membership is refused at the scope step, before any operator id is looked at: the
    // refusal names no organization, no record, and is the same whatever id was sent.
    const refused = { code: "FORBIDDEN", message: "No active organization membership" };
    await expect(callerFor(ex).hos.status({ ...CTX, operatorId: opA })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).hos.tripFeasibility({ ...CTX, operatorId: opA, estimatedDriveMinutes: 30 })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).fieldRoute.dutyRecords.list({ operatorId: opA })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).fieldRoute.dutyRecords.list()).rejects.toMatchObject(refused);
    // T13 — a new role grant after the membership ended changes nothing: roles are not tenancy.
    await grant(ex, ["safety", "hr"]);
    await expect(callerFor(ex).hos.status({ ...CTX, operatorId: opA })).rejects.toMatchObject(refused);
    // Nor does a membership that expired by its window rather than by status.
    const lapsed = await member(A, HOS_ROLES, { status: "active", from: "2020-01-01", to: "2021-01-01" });
    await expect(callerFor(lapsed).hos.status({ ...CTX, operatorId: opA })).rejects.toMatchObject(refused);
  }, 60_000);

  it("HOS-T14 — the legacy single-tenant fallback serves a person who never had a membership, and never revives one whose membership ended", async () => {
    const A = await org();
    // A legacy operator: no owner at all, from before organizations existed.
    const legacyOp = await operatorOwnedBy(null);
    await duty(legacyOp, 1);
    // Never a member anywhere: the deployment predates memberships for them, and the fallback is theirs.
    const legacyUser = await member(null);
    await expect(callerFor(legacyUser).hos.status({ ...CTX, operatorId: legacyOp })).resolves.toMatchObject({ operatorId: legacyOp, dutyRecordsRead: 1 });
    // Was a member of A, ended: no fallback. The legacy operator is not theirs either.
    const ex = await member(A, HOS_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    await expect(callerFor(ex).hos.status({ ...CTX, operatorId: legacyOp })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(ex).hos.tripFeasibility({ ...CTX, operatorId: legacyOp, estimatedDriveMinutes: 30 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(ex).fieldRoute.dutyRecords.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(ex).hos.attestHours({ operatorId: legacyOp, dutyDate: new Date().toISOString().slice(0, 10), method: "driver_declaration", statement: "The driver said they rested overnight." })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Suspended is not ended, but it is not active either: no fallback for them.
    const suspended = await member(A, HOS_ROLES, { status: "suspended" });
    await expect(callerFor(suspended).hos.status({ ...CTX, operatorId: legacyOp })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
