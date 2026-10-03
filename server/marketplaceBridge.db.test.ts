/**
 * The award → dispatch bridge (0234) through the real router, against a real database.
 *
 * A client awards a sealed tender, issues the contract, and the contractor dispatches it. What
 * must be true afterwards: the job exists ONCE and is the contractor's (with the client as its
 * customer); the commercial chain is numbered by the same allocator as a contractor-office chain;
 * the dispatch posting and its unit slots were made by the canonical door and read back through
 * the dispatch router as the contractor's own; nobody re-entered anything; the wrong party is
 * refused at both doors; and a second dispatch call binds rather than duplicates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { jobModeForWorkType } from "./_core/marketplaceService";
import { qualifyOrganization } from "./fixtures/marketplaceQualify";

const DB_URL = process.env.DATABASE_URL;

describe("marketplace bridge — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped bridge suite proves nothing").toBeTruthy();
  });
  it("reads a legacy job mode from the client's work type without deciding anything else", () => {
    expect(jobModeForWorkType("FLUID_HAULING")).toBe("transport");
    expect(jobModeForWorkType("hydrovac")).toBe("hydrovac");
    expect(jobModeForWorkType("RECOVERY")).toBe("recovery");
    expect(jobModeForWorkType("MECHANICS")).toBe("general");
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 330_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => {
  // Every marketplace write queues an outbox row. Left unprocessed, hundreds of them sit ahead of the
  // outbox worker suites' own events in a FIFO claim of fifty; mark what this suite queued as
  // processed so those suites find theirs. (Checked in-test above, where the rows are the point.)
  if (pool) await pool.execute("UPDATE domainEventOutbox SET processedAt = NOW() WHERE eventType LIKE 'marketplace.%' AND processedAt IS NULL");
  await pool?.end();
});

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

const QUALIFIED = { certifications: ["TDG", "H2S"], permits: [], dangerousGoods: [], insuranceLiabilityCents: 500_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] };
const bid = (totalCents: number) => ({ pricingType: "fixed_price" as const, currency: "CAD", fixedTotalCents: totalCents, components: [], exclusions: [], qualifications: QUALIFIED, unitsOffered: 4, availableFrom: null, notes: null, attachments: [] });

/** A posting carried all the way to `awarded`, with the award in hand. */
async function awarded(clientMgmt: number, contractorOffice: number) {
  const p = await callerFor(clientMgmt).marketplace.postingCreate({
    title: "Produced water haul — Fox Creek", workType: "FLUID_HAULING", pickupLocation: "Fox Creek, AB", pickupLsd: "04-12-063-19W5", pickupLat: 54.4, pickupLng: -116.8,
    equipmentType: "Tri-drive vacuum truck", unitsRequired: 4, visibility: "sealed",
    requirements: { certifications: ["TDG", "H2S"], insuranceLiabilityMinimumCents: 500_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] },
  });
  await callerFor(clientMgmt).marketplace.postingPublish({ postingRef: p.postingRef });
  await callerFor(clientMgmt).marketplace.postingOpenBidding({ postingRef: p.postingRef });
  const b = await callerFor(contractorOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(1_940_000) });
  await callerFor(contractorOffice).marketplace.bidSubmit({ bidRef: b.bidRef });
  await callerFor(clientMgmt).marketplace.postingCloseBidding({ postingRef: p.postingRef });
  const award = await callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: b.bidRef, rationale: "Four compliant tri-drive units on the start date." });
  return { p, b, award };
}

d("award → contract → dispatch, nothing re-entered", () => {
  it("issues the contract as the client and dispatches it as the contractor through the canonical door", async () => {
    const client = await org("Fixture Energy Ltd.");
    const contractor = await org("Prairie Vac");
    const stranger = await org("Nosy Hauling");
    await pool.execute("INSERT INTO contractorBusinessProfiles (orgRef, operatingMode, legalName, status, createdByUserId) VALUES (?,?,?,?,1)", [contractor, "CONTRACTOR_COMPANY", "Prairie Vac Ltd.", "active"]);
    await qualifyOrganization(pool, contractor, { workerCodes: ["TDG", "H2S"], unitClass: "TRI_DRIVE_VAC", liabilityLimit: 5_000_000 });
    const clientMgmt = await member(client, ["management"]);
    const contractorOffice = await member(contractor, ["office"]);
    const contractorDispatch = await member(contractor, ["dispatcher"]);
    const strangerMgmt = await member(stranger, ["management"]);

    // --- before the award there is nothing to contract
    const early = await callerFor(clientMgmt).marketplace.postingCreate({ title: "Not yet awarded", workType: "HYDROVAC" });
    await expect(callerFor(clientMgmt).marketplace.contractIssue({ postingRef: early.postingRef })).rejects.toThrow(/cannot "contract"/);

    const { p, award } = await awarded(clientMgmt, contractorOffice);

    // --- only the client issues; the contractor and a stranger are refused by ownership
    await expect(callerFor(contractorOffice).marketplace.contractIssue({ postingRef: p.postingRef })).rejects.toThrow(/Only the client organization/);
    await expect(callerFor(strangerMgmt).marketplace.contractIssue({ postingRef: p.postingRef })).rejects.toThrow(/Only the client organization/);

    const contract = await callerFor(clientMgmt).marketplace.contractIssue({ postingRef: p.postingRef });
    expect(contract.state).toBe("contracted");
    expect(contract.contractorOrgRef).toBe(contractor);
    expect(contract.chainNumber).toBe(`${contract.jobCode}-C01`);
    await expect(callerFor(clientMgmt).marketplace.contractIssue({ postingRef: p.postingRef })).rejects.toThrow(/cannot "contract"/);

    // --- the job is the CONTRACTOR's, with the client as its customer, made from the posting's own fields
    const [[job]] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef, customerOrgRef, type, mode, customer, location, latitude, status FROM jobs WHERE id = ?", [contract.jobId]);
    expect(job).toMatchObject({ orgRef: contractor, customerOrgRef: client, type: "FLUID_HAULING", mode: "transport", customer: "Fixture Energy Ltd.", location: "Fox Creek, AB", status: "dispatched" });
    expect(Number(job!.latitude)).toBeCloseTo(54.4);
    const [[chain]] = await pool.query<mysql.RowDataPacket[]>("SELECT assigningOrgRef, performingOrgRef, customerOrgRef, relationshipType, status, rootJobId FROM commercialJobChains WHERE chainRef = ?", [contract.chainRef]);
    expect(chain).toMatchObject({ assigningOrgRef: client, performingOrgRef: contractor, customerOrgRef: client, relationshipType: "INDEPENDENT_CONTRACTOR", status: "accepted", rootJobId: contract.jobId });
    const [[awardRow]] = await pool.query<mysql.RowDataPacket[]>("SELECT state, contentHash FROM marketplaceAwards WHERE awardRef = ?", [award.awardRef]);
    expect(awardRow).toMatchObject({ state: "contracted", contentHash: award.contentHash });

    // --- the contract reads to both parties and to nobody else
    const asClient = await callerFor(clientMgmt).marketplace.contractGet({ contractRef: contract.contractRef });
    expect(asClient).toMatchObject({ isClient: true, isContractor: false, state: "issued", contentHash: award.contentHash, chain: { status: "accepted" } });
    const asContractor = await callerFor(contractorDispatch).marketplace.contractGet({ contractRef: contract.contractRef });
    expect(asContractor).toMatchObject({ isClient: false, isContractor: true });
    await expect(callerFor(strangerMgmt).marketplace.contractGet({ contractRef: contract.contractRef })).rejects.toThrow(/Contract not found/);
    expect((await callerFor(contractorOffice).marketplace.contractsMine()).map(c => c.contractRef)).toContain(contract.contractRef);
    expect((await callerFor(strangerMgmt).marketplace.contractsMine()).map(c => c.contractRef)).not.toContain(contract.contractRef);

    // --- the client's hands are off: it cannot dispatch; the contractor's office lacks dispatch.assign; a stranger sees no contract
    await expect(callerFor(clientMgmt).marketplace.contractDispatch({ contractRef: contract.contractRef })).rejects.toThrow(/Only the contractor organization dispatches/);
    await expect(callerFor(contractorOffice).marketplace.contractDispatch({ contractRef: contract.contractRef })).rejects.toThrow(/dispatch\.assign/);
    await expect(callerFor(strangerMgmt).marketplace.contractDispatch({ contractRef: contract.contractRef })).rejects.toThrow(/Contract not found/);

    // --- the contractor's dispatcher dispatches through the canonical door: one PRIMARY_UNIT slot per required unit
    const dispatched = await callerFor(contractorDispatch).marketplace.contractDispatch({ contractRef: contract.contractRef });
    expect(dispatched.alreadyDispatched).toBe(false);
    expect(dispatched.roleIds).toHaveLength(4);
    const [[dp]] = await pool.query<mysql.RowDataPacket[]>("SELECT jobId, distribution, planningState, postingNumber, createdByUserId FROM dispatchPostings WHERE id = ?", [dispatched.dispatchPostingId]);
    expect(dp).toMatchObject({ jobId: contract.jobId, distribution: "direct_assignment", planningState: "direct", postingNumber: dispatched.dispatchPostingNumber, createdByUserId: contractorDispatch });

    // The dispatch router lists the slots as the contractor's own, with the equipment class the posting required.
    const listed = await callerFor(contractorDispatch).dispatch.listRoles({ jobId: contract.jobId });
    expect(listed.postings.map(x => x.postingId)).toEqual([dispatched.dispatchPostingId]);
    expect(listed.roles).toHaveLength(4);
    for (const r of listed.roles) {
      expect(r).toMatchObject({ roleCode: "PRIMARY_UNIT", requiredEquipmentClass: "TRI_DRIVE_VAC", status: "open", jobId: contract.jobId });
      expect(r.roleLabel).toMatch(/^Tri-drive vacuum truck \d of 4$/);
    }
    expect(listed.staffing).toMatchObject({ state: "unstaffed", filled: 0, requiredTotal: 4 });
    // The client's dispatcher cannot see the contractor's job slots: the job is not the client's.
    const clientDispatch = await member(client, ["dispatcher"]);
    await expect(callerFor(clientDispatch).dispatch.listRoles({ jobId: contract.jobId })).rejects.toThrow();

    // --- the posting and the contract moved; a second dispatch binds what exists rather than making another
    const view = await callerFor(clientMgmt).marketplace.postingGet({ postingRef: p.postingRef });
    expect(view.state).toBe("dispatched");
    const again = await callerFor(contractorDispatch).marketplace.contractDispatch({ contractRef: contract.contractRef });
    expect(again).toMatchObject({ alreadyDispatched: true, dispatchPostingId: dispatched.dispatchPostingId });
    const [[count]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM dispatchPostings WHERE jobId = ?", [contract.jobId]);
    expect(Number(count!.n)).toBe(1);
    const [[jobs]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM jobs WHERE jobCode = ?", [contract.jobCode]);
    expect(Number(jobs!.n)).toBe(1);

    // --- cancellation is closed once a contract exists; the trail reads the whole chain
    await expect(callerFor(clientMgmt).marketplace.postingCancel({ postingRef: p.postingRef, reason: "Changed our minds after the contract." })).rejects.toThrow(/cannot "cancel"/);
    const trail = await callerFor(clientMgmt).marketplace.postingEvents({ postingRef: p.postingRef });
    const types = trail.map(e => e.eventType);
    expect(types.slice(-5)).toEqual(["posting_awarded", "contract_issued", "posting_contract", "contract_dispatched", "posting_dispatch"]);
    const issued = JSON.parse(trail.find(e => e.eventType === "contract_issued")!.detailJson!);
    expect(issued).toMatchObject({ contractRef: contract.contractRef, jobId: contract.jobId, chainNumber: contract.chainNumber, contentHash: award.contentHash });
    const [outbox] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, tenantId FROM domainEventOutbox WHERE eventType IN ('marketplace.contract_issued','marketplace.contract_dispatched') AND JSON_EXTRACT(payloadJson, '$.postingId') = ? ORDER BY id", [p.postingId]);
    expect(outbox.map(r => [r.eventType, r.tenantId])).toEqual([["marketplace.contract_issued", client], ["marketplace.contract_dispatched", contractor]]);
  });

  it("binds a dispatch posting that already exists for the contract's job instead of creating a second one", async () => {
    const client = await org("Retry Energy");
    const contractor = await org("Retry Vac");
    const clientMgmt = await member(client, ["management"]);
    const contractorDispatch = await member(contractor, ["dispatcher", "office"]);
    await qualifyOrganization(pool, contractor, { workerCodes: ["TDG", "H2S"], unitClass: "TRI_DRIVE_VAC", liabilityLimit: 5_000_000 });
    const { p } = await awarded(clientMgmt, contractorDispatch);
    const contract = await callerFor(clientMgmt).marketplace.contractIssue({ postingRef: p.postingRef });

    // The canonical door ran but the bridge's second step never did (a crash between the two).
    const prior = await callerFor(contractorDispatch).dispatch.createPosting({ jobId: contract.jobId, distribution: "direct_assignment", roles: [{ roleCode: "PRIMARY_UNIT" }] });
    const dispatched = await callerFor(contractorDispatch).marketplace.contractDispatch({ contractRef: contract.contractRef });
    expect(dispatched.dispatchPostingId).toBe(prior.postingId);
    expect(dispatched.alreadyDispatched).toBe(false);
    const [[count]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM dispatchPostings WHERE jobId = ?", [contract.jobId]);
    expect(Number(count!.n)).toBe(1);
    const trail = await callerFor(contractorDispatch).marketplace.postingEvents({ postingRef: p.postingRef });
    expect(JSON.parse(trail.find(e => e.eventType === "contract_dispatched")!.detailJson!)).toMatchObject({ reusedExistingPosting: true });
  });
});
