/**
 * Operator identity and scope hardening (docs/register/OPERATOR_IDENTITY_SCOPE_HARDENING.md).
 *
 * A caller's own operator record is found through `operators.userId`, in the acting organization,
 * and two in-scope records are a refusal, never the first row. These cases build the collision on
 * purpose: the caller's FIRST operator record (the lower id, the one `.limit(1)` returns) is owned
 * by another organization, and their own record in the acting organization comes second. Each
 * OPID case below failed on `main` @ b35bac4, where these sites read `operators` by `userId` with
 * `.limit(1)` and no ownership filter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { operatorForUserInScope } from "./db";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 930_000_000 + Math.floor(Math.random() * 50_000);
/** Explicit financial-entity ids, in their own declared band. */
let entitySeq = 2_300_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function operator(userId: number, orgRef: string | null, name = `Op ${rnd()}`) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name) VALUES (?,?)", [userId, name]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, "operator", r.insertId]);
  return r.insertId;
}
/** The collision: the caller's first record is owned by `elsewhere`, their own in `acting` comes second. */
async function splitPerson(roles: string[]) {
  const acting = await org(), elsewhere = await org();
  const userId = await member(acting, roles);
  const foreign = await operator(userId, elsewhere, "Foreign Record");
  const own = await operator(userId, acting, "Own Record");
  expect(foreign).toBeLessThan(own);
  return { acting, elsewhere, userId, foreign, own };
}
async function evidenceAbout(operatorId: number) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, status, createdAt) VALUES (?, 'inspection', DATE_ADD(NOW(), INTERVAL 1 DAY), 'verified', NOW())", [`about operator ${operatorId}`]);
  await pool.execute("INSERT INTO evidenceRelationships (evidenceRecordId, entityType, entityId) VALUES (?, 'operator', ?)", [e.insertId, operatorId]);
  return e.insertId;
}
async function entity(orgRef: string) {
  const id = entitySeq++;
  await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay, orgRef) VALUES (?,?,?,'corporation','AB',12,31,?)", [id, `FE-${rnd()}`, `entity ${rnd()}`, orgRef]);
  return id;
}
async function ownerOf(recordId: number) {
  const [r] = await pool.execute<mysql.RowDataPacket[]>("SELECT orgRef FROM coreRecordOwnership WHERE recordType = 'operator' AND recordId = ?", [recordId]);
  return (r[0]?.orgRef as string | undefined) ?? null;
}

d("OPID-1 records: the caller's own operator is the one in the acting organization", () => {
  it("evidence.listForOperator lists the acting organization's record, never the other organization's", async () => {
    const p = await splitPerson(["driver"]);
    const foreignEvidence = await evidenceAbout(p.foreign);
    const ownEvidence = await evidenceAbout(p.own);
    const ids = (await callerFor(p.userId).records.evidence.listForOperator()).map(r => r.id);
    expect(ids).toContain(ownEvidence);
    expect(ids).not.toContain(foreignEvidence);
  }, 30_000);

  it("a person whose only operator record is another organization's sees nothing, not that organization's evidence", async () => {
    const acting = await org(), elsewhere = await org();
    const userId = await member(acting, ["driver"]);
    const foreign = await operator(userId, elsewhere);
    await evidenceAbout(foreign);
    expect(await callerFor(userId).records.evidence.listForOperator()).toEqual([]);
    const road = await callerFor(userId).records.roadside.open();
    expect(road.records.length + road.withheldCount).toBe(0);
  }, 30_000);

  it("two operator records in the acting organization are ambiguous: nothing is listed rather than the first", async () => {
    const acting = await org();
    const userId = await member(acting, ["driver"]);
    const first = await operator(userId, acting);
    await operator(userId, acting);
    await evidenceAbout(first);
    expect(await callerFor(userId).records.evidence.listForOperator()).toEqual([]);
  }, 30_000);
});

d("OPID-2 dispatch.whatAmIMissing composes the caller's own operator in the acting organization", () => {
  it("resolves the acting organization's record when the first row is another organization's", async () => {
    const p = await splitPerson(["driver"]);
    const r = await callerFor(p.userId).dispatch.whatAmIMissing();
    expect(r.note).toBeUndefined();
  }, 30_000);

  it("two records in the acting organization are unknown, with a reason, not the first row", async () => {
    const acting = await org();
    const userId = await member(acting, ["driver"]);
    await operator(userId, acting); await operator(userId, acting);
    const r = await callerFor(userId).dispatch.whatAmIMissing();
    expect(r.verdict).toBe("unknown");
    expect(r.note).toMatch(/more than one operator record/);
  }, 30_000);
});

d("OPID-3 a verified credential is filed under the person's operator in the verifying organization", () => {
  async function verifiedTraining(acting: string, personId: number) {
    const hr = await member(acting, ["hr"]), safety = await member(acting, ["safety"]);
    const trn = await callerFor(hr).workforce.trainingRecord({ userId: personId, courseCode: "TDG_GROUND", title: "TDG Ground", completedAt: new Date("2026-09-15T00:00:00Z"), evidenceRecordId: 4 });
    const v = await callerFor(safety).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" });
    const [doc] = await pool.execute<mysql.RowDataPacket[]>("SELECT ownerType, ownerId FROM complianceDocuments WHERE id = ?", [v.complianceDocumentId]);
    return doc[0] as { ownerType: string; ownerId: number };
  }
  it("never under another organization's operator record", async () => {
    const p = await splitPerson(["driver"]);
    expect(await verifiedTraining(p.acting, p.userId)).toMatchObject({ ownerType: "operator", ownerId: p.own });
  }, 30_000);

  it("a person with no operator record in the verifying organization holds it as a user, not under the foreign record", async () => {
    const acting = await org(), elsewhere = await org();
    const userId = await member(acting, ["driver"]);
    await operator(userId, elsewhere);
    expect(await verifiedTraining(acting, userId)).toMatchObject({ ownerType: "user", ownerId: userId });
  }, 30_000);
});

d("OPID-4 a hired driver gets an operator record owned by the hiring organization", () => {
  async function hire(acting: string, personId: number) {
    const hr = await member(acting, ["hr"]);
    const app = await callerFor(hr).workforce.applicantCreate({ fullName: `Hire ${rnd()}`, contact: {}, roleApplied: "Vac truck operator", source: "referral" });
    for (const k of ["licence_verification", "driver_abstract", "references", "right_to_work", "road_test"] as const) await callerFor(hr).workforce.screeningRecord({ applicantRef: app.applicantRef, kind: k, result: "pass", evidenceRecordId: 1 });
    await callerFor(hr).workforce.applicantDecide({ applicantRef: app.applicantRef, decision: "hired", reason: "Clean abstract", userId: personId, startDate: new Date("2026-10-05T00:00:00Z") });
  }
  it("a first operator record is owned by the hiring organization, not left unowned", async () => {
    const acting = await org();
    const userId = await member(acting, []);
    await hire(acting, userId);
    const r = await operatorForUserInScope(userId, { tenantId: acting });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(await ownerOf(r.operatorId)).toBe(acting);
  }, 60_000);

  it("a record in another organization does not stand in for one in the hiring organization", async () => {
    const acting = await org(), elsewhere = await org();
    const userId = await member(acting, []);
    await operator(userId, elsewhere);
    await hire(acting, userId);
    expect((await operatorForUserInScope(userId, { tenantId: acting })).kind).toBe("resolved");
  }, 60_000);
});

d("OPID-5 payroll: the caller's own profile is found through their operator in the acting organization", () => {
  it("payroll.myPay reaches the acting organization's profile when the first operator row is another organization's", async () => {
    const p = await splitPerson(["driver"]);
    const entityA = await entity(p.acting), entityB = await entity(p.elsewhere);
    const insert = (operatorId: number, financialEntityId: number) => pool.execute("INSERT INTO employeePayrollProfiles (operatorId, employeeNumber, financialEntityId, employmentType, defaultPayMethod, effectiveFrom) VALUES (?,?,?,'full_time','hourly',NOW())", [operatorId, `EMP-${rnd()}`, financialEntityId]);
    await insert(p.foreign, entityB);
    await insert(p.own, entityA);
    await expect(callerFor(p.userId).payroll.myPay()).resolves.toBeTruthy();
  }, 30_000);
});

d("OPID-6 the field summary's assignment check uses the caller's operator in the acting organization", () => {
  it("a driver named on the job through their acting-organization record is assigned; the foreign first row does not decide", async () => {
    const p = await splitPerson(["driver"]);
    await entity(p.acting);
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, customer, location, driver) VALUES (?,?,?,?,?,?)", [p.acting, `JOB-${rnd()}`, "Hydrovac", "free text customer", "LSD 4-12", "Own Record"]);
    await expect(callerFor(p.userId).customerCommercial.jobs.fieldSummary({ jobId: j.insertId })).resolves.toMatchObject({ jobId: j.insertId });
  }, 30_000);

  it("another organization's record whose name matches the job's driver text does not make the caller assigned", async () => {
    const acting = await org(), elsewhere = await org();
    const userId = await member(acting, ["driver"]);
    await operator(userId, elsewhere, "Shared Name");
    await entity(acting);
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, customer, location, driver) VALUES (?,?,?,?,?,?)", [acting, `JOB-${rnd()}`, "Hydrovac", "free text customer", "LSD 4-12", "Shared Name"]);
    await expect(callerFor(userId).customerCommercial.jobs.fieldSummary({ jobId: j.insertId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);
});
