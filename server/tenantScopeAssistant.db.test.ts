/**
 * SEC-1 item 1 — an assistant proposal cannot name another organization's records.
 *
 * `assistant.draft` takes `jobId`, `tripId`, `unitId` and `targetRecordId` from the caller and
 * stores them on the proposal. Every later procedure, `commit` included, admits the proposal through
 * `proposalInScope`, and `commit` writes to whatever those ids name (a trip stop on the proposal's
 * trip, an expense or fuel transaction on the financial entity in `targetRecordId`, a defect on the
 * unit). So the ids are authority the moment they are stored, and two things must hold:
 *
 *   - the draft refuses an id outside the caller's organization BEFORE the model is called, so a
 *     foreign id never costs a model call or reaches a prompt;
 *   - `proposalInScope` admits a proposal only when EVERY id it carries is in scope. It used to stop
 *     at the first one present (job, else trip, else unit), so an in-scope job beside a foreign trip
 *     was admitted, and commit then wrote to the foreign trip's stop. Rows written before the draft
 *     was fixed still exist; this is the check that holds for them.
 *
 * Across the boundary the answer is the same NOT_FOUND a missing id gets (`docs/security/
 * LEASEOS_SECURITY_BASELINE.md` §4.4, V2). Every case goes through `appRouter.createCaller`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const llm = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(async () => {
    llm.calls++;
    return { choices: [{ message: { content: "{}" } }] };
  }),
}));

import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 940_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });
beforeEach(() => { llm.calls = 0; });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
/** `office` holds assistant.use, assistant.review and assistant.commit. */
async function member(orgRef: string, roles = ["office"]) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function job(orgRef: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]);
  return r.insertId;
}
async function trip(orgRef: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, orgRef) VALUES (?,?)", [`TRP-${rnd()}`, orgRef]);
  return r.insertId;
}
async function unloadStop(tripId: number) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO tripStops (tripId, stopType) VALUES (?, 'unload')", [tripId]);
  return r.insertId;
}
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
async function entity(orgRef: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?,?, 'corporation', 'AB', ?)",
    [`FE-${rnd()}`, `Fixture Co ${rnd()}`, orgRef],
  );
  return r.insertId;
}
const draft = (userId: number, extra: Record<string, unknown>) =>
  callerFor(userId).fieldRoute.assistant.draft({ formKey: "unload_stop", targetRef: "fixture stop", transcript: "Arrived at the facility and unloaded.", ...extra } as never);

d("an assistant proposal cannot name another organization's records", () => {
  it("draft refuses another organization's job, trip, unit or financial entity, before the model is called", async () => {
    const A = await org(), B = await org();
    const officeA = await member(A);
    const jobA = await job(A), jobB = await job(B), tripB = await trip(B), unitB = await unit(B), entityB = await entity(B);

    await expect(draft(officeA, { jobId: jobB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(draft(officeA, { jobId: jobA, tripId: tripB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(draft(officeA, { unitId: unitB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(draft(officeA, { formKey: "expense_receipt", targetRecordId: entityB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A foreign trip stop is reached through its trip: naming B's stop under A's trip is refused too.
    const tripA = await trip(A), stopB = await unloadStop(tripB);
    await expect(draft(officeA, { tripId: tripA, targetRecordId: stopB })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(llm.calls).toBe(0);
  }, 60_000);

  it("the owner still drafts against its own records (the guard did not narrow the happy path)", async () => {
    const A = await org();
    const officeA = await member(A);
    const jobA = await job(A), tripA = await trip(A), stopA = await unloadStop(tripA);
    const r = await draft(officeA, { jobId: jobA, tripId: tripA, targetRecordId: stopA });
    expect(r.proposal.proposalId).toBeTruthy();
    expect(llm.calls).toBe(1);
  }, 60_000);

  it("a stored proposal is admitted only when every id it carries is in scope", async () => {
    const A = await org(), B = await org();
    const officeA = await member(A), officeB = await member(B);
    const jobA = await job(A), tripA = await trip(A), stopA = await unloadStop(tripA);
    const tripB = await trip(B), entityB = await entity(B);
    const { proposal } = await draft(officeA, { jobId: jobA, tripId: tripA, targetRecordId: stopA });
    const id = proposal.proposalId;

    // Another organization never sees it.
    await expect(callerFor(officeB).fieldRoute.assistant.get({ proposalId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(officeB).fieldRoute.assistant.commit({ proposalId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A row written before the draft was guarded: in-scope job, foreign trip. The job alone used to admit it.
    await pool.execute("UPDATE assistantProposals SET tripId = ? WHERE proposalId = ?", [tripB, id]);
    await expect(callerFor(officeA).fieldRoute.assistant.get({ proposalId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(officeA).fieldRoute.assistant.commit({ proposalId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Same for a financial-entity target on an expense or fuel proposal: commit would write into B's books.
    await pool.execute("UPDATE assistantProposals SET tripId = ?, formKey = 'expense_receipt', targetRecordId = ? WHERE proposalId = ?", [tripA, entityB, id]);
    await expect(callerFor(officeA).fieldRoute.assistant.commit({ proposalId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM expenseRecords WHERE financialEntityId = ?", [entityB]);
    expect(Number(rows[0]!.n)).toBe(0);
  }, 60_000);
});
