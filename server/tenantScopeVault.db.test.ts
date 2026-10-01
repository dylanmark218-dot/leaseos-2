/**
 * SEC-1 — the restricted vault opens nothing across the organization boundary.
 *
 * `matterOpen` and `investigationPropose` loaded the incident by id with no organization predicate
 * (`incidentReports` carries none; it is owned through its job, unit or operator), so a manager in
 * one company could open a vault matter — or raise an investigation proposal — over another
 * company's incident. `breakGlass` minted a grant for any `recordType` string and any id, with no
 * check that the record exists or is the caller's; only `incidentMatter` grants are ever consulted,
 * so a grant on anything else was a record about nothing, and one on another company's matter wrote
 * a GRANT_CREATED event naming it. Baseline V8/V10 (target validation half).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 943_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function manager(orgRef: string) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,'management','global',1,NOW())", [userId]);
  return userId;
}
/** An incident owned through its job — the chain `incidentInScope` already follows. */
async function incidentOf(orgRef: string, injury = 1) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture", "Somewhere", orgRef]);
  const [i] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO incidentReports (incidentNumber, incidentType, severity, jobId, occurredAt, reportedAt, originalStatement, originalStatementSource, status, injuryReported) VALUES (?, 'incident', 'serious', ?, NOW(), NOW(), 'Hand caught in the boom pinch point during stowage.', 'typed', 'open', ?)",
    [`INC-${rnd()}`, j.insertId, injury],
  );
  return i.insertId;
}
const purpose = "Reviewing whether this matter names the same unit as the September near-miss.";

d("the restricted vault opens nothing across the organization boundary", () => {
  it("a matter or an investigation proposal is opened only over the caller's own incident", async () => {
    const A = await org(), B = await org();
    const mgrA = await manager(A), mgrB = await manager(B);
    const incidentB = await incidentOf(B);

    await expect(callerFor(mgrA).restrictedVault.matterOpen({ incidentReportId: incidentB, matterType: "INTERNAL_INVESTIGATION" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrA).restrictedVault.investigationPropose({ incidentReportId: incidentB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [[{ n }]] = (await pool.query("SELECT COUNT(*) AS n FROM incidentMatters WHERE incidentReportId = ?", [incidentB])) as unknown as [[{ n: number }]];
    expect(Number(n)).toBe(0);

    // The owner still can.
    await expect(callerFor(mgrB).restrictedVault.matterOpen({ incidentReportId: incidentB, matterType: "INTERNAL_INVESTIGATION" })).resolves.toMatchObject({ restricted: true });
  }, 60_000);

  it("break glass names a matter that exists in the caller's organization, and nothing else", async () => {
    const A = await org(), B = await org();
    const mgrA = await manager(A), mgrB = await manager(B);
    const matterB = (await callerFor(mgrB).restrictedVault.matterOpen({ incidentReportId: await incidentOf(B), matterType: "INTERNAL_INVESTIGATION" })).matterId;

    await expect(callerFor(mgrA).restrictedVault.breakGlass({ recordType: "incidentMatter", recordId: matterB, purpose })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrA).restrictedVault.breakGlass({ recordType: "payrollProfile" as never, recordId: 1, purpose })).rejects.toThrow();
    await expect(callerFor(mgrA).restrictedVault.breakGlass({ recordType: "incidentMatter", recordId: 2_000_000_000, purpose })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [[{ n }]] = (await pool.query("SELECT COUNT(*) AS n FROM restrictedAccessGrants WHERE userId = ?", [mgrA])) as unknown as [[{ n: number }]];
    expect(Number(n)).toBe(0);

    await expect(callerFor(mgrB).restrictedVault.breakGlass({ recordType: "incidentMatter", recordId: matterB, purpose })).resolves.toMatchObject({ grantId: expect.any(Number) });
  }, 60_000);
});
