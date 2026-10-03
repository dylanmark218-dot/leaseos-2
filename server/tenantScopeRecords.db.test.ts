/**
 * P4.1 router 7 — records. Evidence is in scope through its job, else its capturer; an incident
 * through its job, unit or operator; a work order through its unit; a role grant only to a person
 * in the organization. Across the boundary the answer is "not found", never "forbidden".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 258_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  // B23.1A: grants are written in the shape 0170 leaves behind — scoped to the
  // organization that issued them. The fixture used to write `scopeType='global'`,
  // which after B23.1 means platform-wide authority; a tenant-isolation test that
  // hands both sides platform authority is testing the wrong thing, and 0170's
  // backfill produces no such row. A member of nowhere gets the quarantine shape:
  // preserved, authorizing nothing.
  for (const role of roles) {
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, grantedByUserId, grantedAt) VALUES (?,?,?,?,1,NOW())",
      [userId, role, orgRef ? "organization" : "unscoped_legacy", orgRef]
    );
  }
  return userId;
}
async function jobOwnedBy(orgRef: string | null) { const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]); return j.insertId; }
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  const [w] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO workOrders (workOrderNumber, unitId, status, priority, openedAt, technician, createdAt, updatedAt) VALUES (?, ?, 'in_progress', 'routine', '2026-09-01 00:00:00', 'J. Reyes', NOW(), NOW())", [`WO-${rnd()}`, u.insertId]);
  return { unitId: u.insertId, workOrderId: w.insertId };
}

d("records belong to the organization that owns the job, unit or person", () => {
  it("evidence, incidents, work-order releases and role grants answer not-found across the boundary and serve their owner", async () => {
    const A = await org(), B = await org();
    const safetyA = await member(A, ["safety", "management"]), safetyB = await member(B, ["safety", "management"]);
    const mechA = await member(A, ["shop_lead"]), mechB = await member(B, ["shop_lead"]);
    const personA = await member(A, ["driver"]), personB = await member(B, ["driver"]);
    const jobA = await jobOwnedBy(A);
    const [ev] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (jobId, title, category, capturedAt, status, createdAt) VALUES (?, 'Load photo', 'photo', NOW(), 'needs_review', NOW())", [jobA]);
    const incidentNumber = `INC-${rnd()}`;
    await pool.execute("INSERT INTO incidentReports (incidentNumber, incidentType, severity, jobId, occurredAt, reportedAt, originalStatement, originalStatementSource, status) VALUES (?, 'near_miss', 'minor', ?, NOW(), NOW(), 'Hose whipped loose during pressure-up', 'typed', 'open')", [incidentNumber, jobA]);
    const uA = await unitOwnedBy(A);
    // Evidence: B's safety officer does not find A's evidence; A's does (and fails only on the sealing rules, which is the next check).
    await expect(callerFor(safetyB).records.retention.disposition({ evidenceId: ev.insertId })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Evidence ${ev.insertId} not found` });
    await expect(callerFor(safetyA).records.retention.disposition({ evidenceId: ev.insertId })).resolves.toMatchObject({ eligible: false });   // in scope: the engine answers (not eligible yet), the guard did not
    await expect(callerFor(safetyB).records.legalHold.place({ holdNumber: `LH-${rnd()}`, reason: "litigation anticipated on the spill", evidenceIds: [ev.insertId] } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Incident: through the job.
    await expect(callerFor(safetyB).records.incident.readInvestigation({ incidentNumber })).rejects.toMatchObject({ code: "NOT_FOUND", message: "No such incident" });
    await expect(callerFor(safetyA).records.incident.readInvestigation({ incidentNumber })).resolves.toBeTruthy();
    // Work-order release: through the unit.
    await expect(callerFor(mechB).records.maintenance.recordRelease({ workOrderId: uA.workOrderId, releaseType: "full", repairSummary: "brake line replaced and bled", roadTestPerformed: true, technicianIdentifier: "TECH-1" } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Work order ${uA.workOrderId} not found` });
    // 0221 — that door is closed (one release door, design S-1). The owner's mechanic is in scope, so they hear why;
    // they release through shop.workOrderRelease, which scopes the work order the same way.
    await expect(callerFor(mechA).records.maintenance.recordRelease({ workOrderId: uA.workOrderId, releaseType: "full", repairSummary: "brake line replaced and bled", roadTestPerformed: true, technicianIdentifier: "TECH-1" } as never)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/shop\.workOrderRelease/) });
    await expect(callerFor(mechB).shop.workOrderRelease({ workOrderId: uA.workOrderId, releaseType: "full", repairSummary: "brake line replaced and bled", roadTestPerformed: true })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Work order ${uA.workOrderId} not found` });
    await expect(callerFor(mechA).shop.workOrderRelease({ workOrderId: uA.workOrderId, releaseType: "full", repairSummary: "brake line replaced and bled", roadTestPerformed: true })).resolves.toMatchObject({ releaseId: expect.any(Number), mechanicReleaseGiven: true });   // the owner's mechanic releases it
    // Role grant: only to a person in the organization.
    await expect(callerFor(safetyA).records.roles.grant({ targetUserId: personB, role: "mechanic" } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${personB} not found` });
    // B23.1A: this used to assert only that A's own person was NOT refused as
    // not-found, and it passed because the grant collided on the old unique key
    // and rejected for an unrelated reason. Now it states the property directly:
    // the grant is issued, and it lands in the ACTOR's organization — never
    // platform-wide, never in B. `mechanic` rather than `driver` because personA
    // already holds driver in A, and a duplicate would hide the same thing again.
    await expect(callerFor(safetyA).records.roles.grant({ targetUserId: personA, role: "mechanic" } as never)).resolves.toMatchObject({ granted: true, organization: A });
    const [grants] = await pool.execute<mysql.RowDataPacket[]>("SELECT scopeType, orgRef FROM userRoleAssignments WHERE userId = ? AND role = 'mechanic' AND revokedAt IS NULL", [personA]);
    expect(grants).toEqual([{ scopeType: "organization", orgRef: A }]);
  }, 60_000);
});
