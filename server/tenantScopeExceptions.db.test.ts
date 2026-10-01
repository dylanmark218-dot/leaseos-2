/**
 * SEC-1 — the exception centre, My Day and the inbox show one organization's work.
 *
 * `loadExceptionSources` took no scope at all: critical defects, roadside events, vendor bills,
 * purchase requests, credentials awaiting review, assistant proposals, sync conflicts, revoked
 * devices, measurement devices, calibration sweeps, insurance policies, carrier reviews, inspector
 * requests, ungated assignments, fuel findings and open security incidents were read across every
 * organization, and `surfaces.exceptions` / `surfaces.myDay` filtered them by permission only. A
 * safety officer in one company saw another company's incident titles and defect descriptions; an
 * approver saw another company's purchase requests in the inbox. The loader now requires the
 * caller's scope, so a caller that forgets it does not compile rather than reading everything.
 *
 * Shapes are asserted on what a person sees: no title, reference or marker of B's appears in A's
 * results, and B's own results still carry them (the positive control proves the rows are real
 * exceptions, so their absence from A's is the scope and not a fixture that derives nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 942_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
/** management + safety + office: exceptions, review, purchasing approval and assistant review together. */
async function member(orgRef: string, roles = ["management", "safety", "office"]) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function owned(orgRef: string, recordType: "unit" | "operator", insert: string, params: (string | number)[]) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(insert, params);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, recordType, r.insertId]);
  return r.insertId;
}

/** One exception of each kind this suite checks, all marked, all in `orgRef`. */
async function seed(orgRef: string, requester: number, marker: string) {
  const unitId = await owned(orgRef, "unit", "INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${marker}`, "hydrovac"]);
  await pool.execute("INSERT INTO maintenanceDefects (unitId, title, reportedAt, severity, status) VALUES (?,?,NOW(),'critical','open')", [unitId, `Brake line ${marker}`]);
  await pool.execute(
    "INSERT INTO securityIncidents (orgRef, incidentRef, incidentType, severity, status, title, discoveredAt, discoveredByUserId, personalInformationSuspected) VALUES (?,?, 'data_exposure', 'high', 'open', ?, NOW(), ?, 1)",
    [orgRef, `SEC-${marker}`, `Exposure ${marker}`, requester],
  );
  const operatorId = await owned(orgRef, "operator", "INSERT INTO operators (name) VALUES (?)", [`Driver ${marker}`]);
  await pool.execute(
    "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, verificationStatus) VALUES ('operator', ?, 'drivers_licence', ?, NOW(), 'needs_review')",
    [operatorId, `Licence ${marker}`],
  );
  const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${marker}`, "Hydrovac", "Fixture", "Somewhere", orgRef]);
  await pool.execute(
    "INSERT INTO assistantProposals (proposalId, formKey, formVersion, title, targetRef, jobId, createdByUserId, commitState) VALUES (?, 'defect_report', 1, ?, ?, ?, ?, 'awaiting_readback')",
    [`P-${marker}`, `Proposal ${marker}`, `target ${marker}`, job.insertId, requester],
  );
  const [fe] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?,?, 'corporation', 'AB', ?)",
    [`FE-${marker}`, `Books ${marker}`, orgRef],
  );
  await pool.execute(
    "INSERT INTO purchaseAuthorizations (authorizationRef, financialEntityId, category, reason, estimatedAmount, requestedByUserId, requestedAt, status) VALUES (?,?, 'parts', ?, 1234, ?, NOW(), 'requested')",
    [`PA-${marker}`, fe.insertId, `Parts ${marker}`, requester],
  );
}

d("the exception centre, My Day and the inbox show one organization's work", () => {
  it("another organization's exceptions do not reach this organization, and still reach their own", async () => {
    const A = await org(), B = await org();
    const mgrA = await member(A), mgrB = await member(B);
    const requesterB = await member(B, ["driver"]);
    const marker = rnd();
    await seed(B, requesterB, marker);

    const own = JSON.stringify(await callerFor(mgrB).surfaces.exceptions());
    for (const m of [`Brake line ${marker}`, `SEC-${marker}`, `Licence ${marker}`, `P-${marker}`, `PA-${marker}`]) expect(own).toContain(m);

    const theirs = JSON.stringify(await callerFor(mgrA).surfaces.exceptions());
    expect(theirs).not.toContain(marker);
    const day = JSON.stringify(await callerFor(mgrA).surfaces.myDay());
    expect(day).not.toContain(marker);
    const inbox = JSON.stringify(await callerFor(mgrA).surfaces.inbox());
    expect(inbox).not.toContain(marker);
    // The approver in B does see B's purchase request waiting.
    expect(JSON.stringify(await callerFor(mgrB).surfaces.inbox())).toContain(`PA-${marker}`);
  }, 90_000);
});
