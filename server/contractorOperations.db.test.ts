/**
 * P4.3 — the contractor / owner-operator payables chain (0115–0117) through
 * the real router. The boundary tests read the source; this one runs it.
 *
 * Two organizations: a carrier (payer) and a leased owner-operator (payee).
 * The carrier chains a job to the operator, sets a private HOURLY rate,
 * prepares a payable from evidence, submits it for review, and a second
 * person approves it. Every refusal along the way is asserted by its reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 200_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org(name: string) {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, name]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function job(orgRef: string) {
  const jobCode = `JOB-${rnd()}`;
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [jobCode, "Hydrovac", "Fixture Energy", "LSD 04-12-045-08W4", orgRef]);
  return { jobId: r.insertId, jobCode };
}

d("a carrier pays a leased owner-operator for hours worked", () => {
  it("chains the job, sets a private rate, prepares from evidence, and needs a second person to approve", async () => {
    const carrier = await org("Fixture Carrier Ltd."), operator = await org("Fixture Owner-Op");
    const officeA = await member(carrier, ["office", "management"]);   // prepares (contractor.write)
    const controllerA = await member(carrier, ["controller"]);          // approves (contractor.approve)
    const opMgr = await member(operator, ["management"]);
    const { jobId, jobCode } = await job(carrier);

    await callerFor(officeA).contractorOperations.profileUpsert({ operatingMode: "CONTRACTOR_COMPANY", legalName: "Fixture Carrier Ltd." });
    await callerFor(opMgr).contractorOperations.profileUpsert({ operatingMode: "LEASED_OWNER_OPERATOR", legalName: "Fixture Owner-Op" });

    // The relationship is proposed by the carrier and accepted by the operator — never self-accepted.
    const rel = await callerFor(officeA).contractorOperations.relationshipCreate({ childOrgRef: operator, relationshipType: "LEASED_OWNER_OPERATOR", effectiveFrom: new Date("2026-01-01") });
    expect(rel.status).toBe("pending");
    await expect(callerFor(officeA).contractorOperations.relationshipCreate({ childOrgRef: carrier, relationshipType: "CONTRACTOR", effectiveFrom: new Date() })).rejects.toThrow(/cannot contract with itself/);
    await callerFor(opMgr).contractorOperations.relationshipAccept({ relationshipRef: rel.relationshipRef });
    const seen = await callerFor(opMgr).contractorOperations.relationships();
    expect(seen.find(r => r.relationshipRef === rel.relationshipRef)?.status).toBe("active");

    // The chain carries an inherited commercial number derived from the job code.
    const chain = await callerFor(officeA).contractorOperations.jobChainCreate({ rootJobId: jobId, performingOrgRef: operator, relationshipType: "LEASED_OWNER_OPERATOR" });
    expect(chain.chainNumber).toMatch(new RegExp(`^${jobCode}-C\\d{2}$`));

    // A private HOURLY rate between exactly these two parties.
    const rate = await callerFor(controllerA).contractorOperations.rateSet({ counterpartyOrgRef: operator, compensationType: "HOURLY", rateCents: 9_500, currency: "CAD", effectiveFrom: new Date("2026-01-01") });
    const mine = await callerFor(opMgr).contractorOperations.ratesMine();
    expect(mine.find(r => r.rateRef === rate.rateRef)?.rateCents).toBe(9_500);

    // 10.5 hours (quantityMillis is thousandths) → 99,750 cents. The unit must match the rate's compensation type.
    await expect(callerFor(officeA).contractorOperations.payablePrepare({ chainRef: chain.chainRef, rateRef: rate.rateRef, quantityMillis: 10_500, quantityUnit: "DAY", evidenceRefs: ["FT-1"] }))
      .rejects.toThrow(/HOURLY requires HOUR/);
    const payable = await callerFor(officeA).contractorOperations.payablePrepare({ chainRef: chain.chainRef, rateRef: rate.rateRef, quantityMillis: 10_500, quantityUnit: "HOUR", evidenceRefs: ["FT-1", "TRIP-1"] });
    expect(payable.grossAmountCents).toBe(99_750);

    // The payee cannot prepare against itself; only the assigning organization may.
    await expect(callerFor(opMgr).contractorOperations.payablePrepare({ chainRef: chain.chainRef, rateRef: rate.rateRef, quantityMillis: 1_000, quantityUnit: "HOUR", evidenceRefs: ["X"] }))
      .rejects.toThrow(/Only the assigning organization/);

    // Approval needs review first, and a second person.
    await expect(callerFor(controllerA).contractorOperations.payableApprove({ payableRef: payable.payableRef })).rejects.toThrow(/in review before approval/);
    await callerFor(officeA).contractorOperations.payableSubmitReview({ payableRef: payable.payableRef });
    await expect(callerFor(officeA).contractorOperations.payableApprove({ payableRef: payable.payableRef })).rejects.toThrow(/preparer cannot approve|FORBIDDEN/);
    const approved = await callerFor(controllerA).contractorOperations.payableApprove({ payableRef: payable.payableRef });
    expect(approved.state ?? "approved").toMatch(/approved/);

    // Both sides see the payable; nobody else does.
    expect((await callerFor(opMgr).contractorOperations.payablesMine()).some(p => p.payableRef === payable.payableRef)).toBe(true);
    const stranger = await member(await org("Unrelated Ltd."), ["management"]);
    expect((await callerFor(stranger).contractorOperations.payablesMine()).some(p => p.payableRef === payable.payableRef)).toBe(false);
  }, 30_000);

  it("refuses a rate that is not a private contract rate between the parties, and a salary rate that cannot be auto-settled", async () => {
    const carrier = await org("Fixture Carrier 2"), operator = await org("Fixture Owner-Op 2"), other = await org("Third Party");
    const officeA = await member(carrier, ["office", "management"]);
    const controllerA = await member(carrier, ["controller"]);
    const opMgr = await member(operator, ["management"]);
    const { jobId } = await job(carrier);
    // No chain without an active relationship — asserted, then satisfied.
    await expect(callerFor(officeA).contractorOperations.jobChainCreate({ rootJobId: jobId, performingOrgRef: operator, relationshipType: "LEASED_OWNER_OPERATOR" }))
      .rejects.toThrow(/No active commercial relationship/);
    const rel = await callerFor(officeA).contractorOperations.relationshipCreate({ childOrgRef: operator, relationshipType: "LEASED_OWNER_OPERATOR", effectiveFrom: new Date("2026-01-01") });
    await callerFor(opMgr).contractorOperations.relationshipAccept({ relationshipRef: rel.relationshipRef });
    const chain = await callerFor(officeA).contractorOperations.jobChainCreate({ rootJobId: jobId, performingOrgRef: operator, relationshipType: "LEASED_OWNER_OPERATOR" });
    const wrongParty = await callerFor(controllerA).contractorOperations.rateSet({ counterpartyOrgRef: other, compensationType: "HOURLY", rateCents: 1, currency: "CAD", effectiveFrom: new Date("2026-01-01") });
    await expect(callerFor(officeA).contractorOperations.payablePrepare({ chainRef: chain.chainRef, rateRef: wrongParty.rateRef, quantityMillis: 1_000, quantityUnit: "HOUR", evidenceRefs: ["X"] }))
      .rejects.toThrow(/not a private contract rate between these parties/);
    const salary = await callerFor(controllerA).contractorOperations.rateSet({ counterpartyOrgRef: operator, compensationType: "SALARY", rateCents: 1, currency: "CAD", effectiveFrom: new Date("2026-01-01") });
    await expect(callerFor(officeA).contractorOperations.payablePrepare({ chainRef: chain.chainRef, rateRef: salary.rateRef, quantityMillis: 1_000, quantityUnit: "HOUR", evidenceRefs: ["X"] }))
      .rejects.toThrow(/cannot be auto-settled/);
  }, 30_000);
});
