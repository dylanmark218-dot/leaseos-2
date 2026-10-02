/**
 * Verified marketplace readiness (0192, P10.3) through the real router, against a real database.
 *
 * The registries are written as their own surfaces write them (see fixtures/marketplaceQualify.ts),
 * and the marketplace reads them through the engines that already decide validity. Proved here:
 * submission is enforced on the server by what is on record, not by what a bid declares; a draft
 * survives a refusal; the picture at submission is immutable while the picture now moves; a lapse
 * after submission refuses the award and the bid stands; the bridge and the dispatch gate are
 * untouched; no door evaluates another organization; and nothing private crosses to the client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { qualifyOrganization } from "./fixtures/marketplaceQualify";

const DB_URL = process.env.DATABASE_URL;

describe("verified readiness — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped readiness suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 370_000_000 + Math.floor(Math.random() * 50_000);
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

const TENDER = {
  title: "Produced water haul — Fox Creek", workType: "FLUID_HAULING", unitsRequired: 2, visibility: "open" as const,
  requirements: {
    workerQualificationCodes: ["H2S_ALIVE"], tdgRequired: true, organizationDocTypes: ["wcb_clearance"],
    insurance: { coverageType: "general_liability", minimumLimitCents: 500_000_000, additionalInsuredRequired: false },
    equipmentClasses: ["TRI_DRIVE_VAC"], jurisdiction: "CA-AB", clientSpecific: ["Crews attend the client's site orientation"],
  },
};
const COMPLIANT = { workerCodes: ["H2S_ALIVE", "TDG_ROAD"], workers: 2, units: 2, unitClass: "TRI_DRIVE_VAC", liabilityLimit: 5_000_000, carrierDocTypes: ["wcb_clearance"] };
const bid = (totalCents: number, unitsOffered = 2) => ({ pricingType: "fixed_price" as const, currency: "CAD", fixedTotalCents: totalCents, components: [], exclusions: [], qualifications: { certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityCents: null, equipmentTypes: [] }, unitsOffered, availableFrom: null, notes: null, attachments: [] });

async function tender(clientUser: number) {
  const p = await callerFor(clientUser).marketplace.postingCreate(TENDER);
  await callerFor(clientUser).marketplace.postingPublish({ postingRef: p.postingRef });
  await callerFor(clientUser).marketplace.postingOpenBidding({ postingRef: p.postingRef });
  return p;
}
const checkOf = (r: { checks: { check: string; result: string; blocking?: boolean; detail?: string }[] }, name: string) => r.checks.find(c => c.check === name)!;

d("submission is decided by the registries", () => {
  it("lets a compliant bidder submit, blocks one whose records fall short, keeps the blocked draft, and records both decisions", async () => {
    const client = await org("Registry Energy");
    const good = await org("Compliant Vac");
    const short = await org("Short Vac");
    const clientOffice = await member(client, ["office"]);
    const goodOffice = await member(good, ["office"]);
    const shortOffice = await member(short, ["office"]);
    await qualifyOrganization(pool, good, COMPLIANT);
    // Short Vac: WCB on file, insurance fine, trucks fine — but nobody holds TDG_ROAD.
    await qualifyOrganization(pool, short, { ...COMPLIANT, workerCodes: ["H2S_ALIVE"] });
    const p = await tender(clientOffice);

    // The acting organization's own picture; the bid content is optional and never names an organization.
    const preview = await callerFor(goodOffice).marketplace.bidReadiness({ postingRef: p.postingRef });
    expect(preview.verdict).toBe("submittable");
    expect(preview.basis).toBe("canonical_registries");
    for (const name of ["organization", "contractor_profile", "organization_document:wcb_clearance", "insurance", "equipment", "worker_qualifications", "dangerous_goods"]) expect(checkOf(preview, name).result, name).toBe("PASS");
    expect(checkOf(preview, "client_requirement:Crews attend the client's site orientation")).toMatchObject({ result: "UNKNOWN", blocking: false });
    expect(preview.notEvaluated.map(n => n.capability)).toContain("hos");

    const shortPreview = await callerFor(shortOffice).marketplace.bidReadiness({ postingRef: p.postingRef, content: bid(100_000) });
    expect(shortPreview.verdict).toBe("blocked");
    expect(checkOf(shortPreview, "worker_qualifications")).toMatchObject({ result: "BLOCK", blocking: true });
    expect(checkOf(shortPreview, "worker_qualifications").detail).toMatch(/TDG_ROAD: 0\/2/);
    expect(checkOf(shortPreview, "dangerous_goods").result).toBe("BLOCK");

    // Drafting while blocked is allowed; submitting is not, and the refusal is a record.
    const shortDraft = await callerFor(shortOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(100_000) });
    expect(shortDraft.state).toBe("draft");
    await expect(callerFor(shortOffice).marketplace.bidSubmit({ bidRef: shortDraft.bidRef })).rejects.toThrow(/Not eligible to submit — .*worker_qualifications \[BLOCK\].*dangerous_goods \[BLOCK\]/);
    const mine = await callerFor(shortOffice).marketplace.bidsMine({ postingRef: p.postingRef });
    expect(mine[0]).toMatchObject({ state: "draft", revisions: [] });
    expect(mine[0]!.draft?.fixedTotalCents).toBe(100_000);
    const [refusals] = await pool.query<mysql.RowDataPacket[]>("SELECT purpose, verdict, dependencyFingerprint FROM marketplaceReadinessEvaluations WHERE bidderOrgRef = ? ORDER BY id", [short]);
    expect(refusals.map(r => [r.purpose, r.verdict])).toEqual([["submission_refused", "blocked"]]);
    expect(refusals[0]!.dependencyFingerprint).toMatch(/^MR-[0-9a-f]{64}$/);
    const trail = await callerFor(shortOffice).marketplace.postingEvents({ postingRef: p.postingRef });
    expect(trail.some(e => e.eventType === "bid_submission_refused")).toBe(true);

    // Declaring what you do not have changes nothing: the registries decide.
    await callerFor(shortOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: { ...bid(100_000), qualifications: { certifications: ["TDG_ROAD", "H2S_ALIVE"], permits: [], dangerousGoods: ["CLASS_3"], insuranceLiabilityCents: 900_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] } } });
    await expect(callerFor(shortOffice).marketplace.bidSubmit({ bidRef: shortDraft.bidRef })).rejects.toThrow(/Not eligible to submit/);

    // The compliant bidder submits; the picture and its fingerprint freeze on the revision.
    const goodDraft = await callerFor(goodOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(120_000) });
    const sub = await callerFor(goodOffice).marketplace.bidSubmit({ bidRef: goodDraft.bidRef });
    expect(sub.readiness.verdict).toBe("submittable");
    const [[rev]] = await pool.query<mysql.RowDataPacket[]>("SELECT readinessVerdict, readinessFingerprint FROM marketplaceBidRevisions WHERE revisionRef = ?", [sub.revisionRef]);
    expect(rev).toMatchObject({ readinessVerdict: "submittable", readinessFingerprint: sub.readiness.dependencyFingerprint });
    const [evals] = await pool.query<mysql.RowDataPacket[]>("SELECT purpose, verdict FROM marketplaceReadinessEvaluations WHERE bidderOrgRef = ? ORDER BY id", [good]);
    expect(evals.map(r => [r.purpose, r.verdict])).toEqual([["submission", "submittable"]]);
  });

  it("allows a warning-only bidder to submit and shows the client 'eligible with warnings'", async () => {
    const client = await org("Warning Energy");
    const partial = await org("Partial Vac");
    const clientOffice = await member(client, ["office"]);
    const partialOffice = await member(partial, ["office"]);
    // One compliant truck and one qualified worker against two required: warnings, not blocks.
    await qualifyOrganization(pool, partial, { ...COMPLIANT, workers: 1, units: 1 });
    const p = await tender(clientOffice);
    const draft = await callerFor(partialOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(90_000, 1) });
    const sub = await callerFor(partialOffice).marketplace.bidSubmit({ bidRef: draft.bidRef });
    expect(sub.readiness.verdict).toBe("submittable");
    expect(sub.readiness.warnings.map(w => w.check).sort()).toEqual(["equipment", "units_offered", "worker_qualifications"]);
    const seen = await callerFor(clientOffice).marketplace.bidsForPosting({ postingRef: p.postingRef });
    expect(seen[0]!.currentReadiness).toMatchObject({ eligibility: "eligible_with_warnings", warningCount: 3, blockerCount: 0 });
  });
});

d("the picture at submission is immutable; the picture now moves", () => {
  it("refuses the award when the bidder's insurance lapsed after submission, leaves the bid standing, and awards once cover is back", async () => {
    const client = await org("Lapse Energy");
    const vac = await org("Lapsing Vac");
    const clientMgmt = await member(client, ["management"]);
    const vacOffice = await member(vac, ["office"]);
    const vacDispatch = await member(vac, ["dispatcher"]);
    const q = await qualifyOrganization(pool, vac, COMPLIANT);
    const p = await tender(clientMgmt);
    const draft = await callerFor(vacOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(150_000) });
    const sub = await callerFor(vacOffice).marketplace.bidSubmit({ bidRef: draft.bidRef });
    const before = await callerFor(vacOffice).marketplace.bidsMine({ postingRef: p.postingRef });
    expect(before[0]).toMatchObject({ readinessChangedSinceSubmission: false });
    expect(before[0]!.currentReadiness?.verdict).toBe("submittable");

    // The policy expires. Nothing in the marketplace was touched.
    await pool.execute("UPDATE insurancePolicies SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE policyRef = ?", [q.policyRef]);

    const after = await callerFor(vacOffice).marketplace.bidsMine({ postingRef: p.postingRef });
    expect(after[0]!.currentReadiness?.verdict).toBe("blocked");
    expect(checkOf(after[0]!.currentReadiness!, "insurance")).toMatchObject({ result: "BLOCK" });
    expect(checkOf(after[0]!.currentReadiness!, "insurance").detail).toMatch(/expired/);
    expect(after[0]!.readinessChangedSinceSubmission).toBe(true);
    // The submission's own picture is exactly what it was.
    const submission = after[0]!.revisions[0]!.submissionReadiness as { verdict: string; dependencyFingerprint: string };
    expect(submission.verdict).toBe("submittable");
    expect(submission.dependencyFingerprint).toBe(sub.readiness.dependencyFingerprint);
    expect(after[0]!.state).toBe("submitted");

    // The client sees the change as a projection, with no policy detail.
    await callerFor(clientMgmt).marketplace.postingCloseBidding({ postingRef: p.postingRef });
    const clientView = await callerFor(clientMgmt).marketplace.bidsForPosting({ postingRef: p.postingRef });
    expect(clientView[0]!.currentReadiness).toMatchObject({ eligibility: "not_currently_eligible", blockerCount: 1 });
    expect(clientView[0]!.readinessChangedSinceSubmission).toBe(true);
    expect(JSON.stringify(clientView[0]!.currentReadiness)).not.toMatch(/POL-|expired|detail/);

    // The award fails closed, is recorded, and the bid stands.
    await expect(callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: draft.bidRef, rationale: "Only bid; we would like to proceed regardless." })).rejects.toThrow(/not currently eligible: insurance \[BLOCK\].*facts changed.*the bid stands as submitted/);
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT state FROM marketplaceBids WHERE bidRef = ?", [draft.bidRef]);
    expect(row!.state).toBe("submitted");
    const [evals] = await pool.query<mysql.RowDataPacket[]>("SELECT purpose, verdict FROM marketplaceReadinessEvaluations WHERE bidderOrgRef = ? ORDER BY id", [vac]);
    expect(evals.map(r => [r.purpose, r.verdict])).toEqual([["submission", "submittable"], ["award_refused", "blocked"]]);
    const trail = await callerFor(clientMgmt).marketplace.postingEvents({ postingRef: p.postingRef });
    expect(trail[trail.length - 1]!.eventType).toBe("award_refused_readiness");

    // Cover restored: the award goes through, the bridge works exactly as checkpoint 2 left it.
    await pool.execute("UPDATE insurancePolicies SET expiresAt = DATE_ADD(NOW(), INTERVAL 300 DAY) WHERE policyRef = ?", [q.policyRef]);
    const award = await callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: draft.bidRef, rationale: "Only bid, and every stated requirement is on record." });
    expect(award.state).toBe("awarded");
    const [evals2] = await pool.query<mysql.RowDataPacket[]>("SELECT purpose FROM marketplaceReadinessEvaluations WHERE bidderOrgRef = ? ORDER BY id", [vac]);
    expect(evals2.map(r => r.purpose)).toEqual(["submission", "award_refused", "award"]);
    const contract = await callerFor(clientMgmt).marketplace.contractIssue({ postingRef: p.postingRef });
    const dispatched = await callerFor(vacDispatch).marketplace.contractDispatch({ contractRef: contract.contractRef });
    expect(dispatched.roleIds).toHaveLength(2);

    // The dispatch gate is untouched: the marketplace wrote no eligibility check, booking or assignment for the job.
    const [[gate]] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM dispatchEligibilityChecks WHERE jobId = ?) AS checks, (SELECT COUNT(*) FROM resourceBookings WHERE jobId = ?) AS bookings, (SELECT COUNT(*) FROM dispatchRoles WHERE postingId = ? AND assignedOperatorId IS NOT NULL) AS bound",
      [contract.jobId, contract.jobId, dispatched.dispatchPostingId],
    );
    expect([Number(gate!.checks), Number(gate!.bookings), Number(gate!.bound)]).toEqual([0, 0, 0]);
    const roles = await callerFor(vacDispatch).dispatch.listRoles({ jobId: contract.jobId });
    expect(roles.staffing.state).toBe("unstaffed");
  });
});

d("tenant isolation and authorization", () => {
  it("evaluates only the acting organization, shows the client a projection, hides a bidder's picture from other bidders, and ignores any organization named in input", async () => {
    const client = await org("Isolation Energy");
    const a = await org("Bidder A");
    const b = await org("Bidder B");
    const clientOffice = await member(client, ["office"]);
    const clientDriver = await member(client, ["driver"]);
    const aOffice = await member(a, ["office"]);
    const bOffice = await member(b, ["office"]);
    const qa = await qualifyOrganization(pool, a, COMPLIANT);
    await qualifyOrganization(pool, b, { ...COMPLIANT, liabilityLimit: 1_000_000 });   // B's cover falls short
    const p = await tender(clientOffice);

    const da = await callerFor(aOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(100_000) });
    await callerFor(aOffice).marketplace.bidSubmit({ bidRef: da.bidRef });
    const db2 = await callerFor(bOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(95_000) });
    await expect(callerFor(bOffice).marketplace.bidSubmit({ bidRef: db2.bidRef })).rejects.toThrow(/insurance \[BLOCK\]/);

    // B's own reasons are B's; A's door answers about A whatever B passes; a forged organization is not an input anywhere.
    const bPicture = await callerFor(bOffice).marketplace.bidReadiness({ postingRef: p.postingRef });
    expect(checkOf(bPicture, "insurance").detail).toMatch(/policy limit is 1000000/);
    const aPicture = await callerFor(aOffice).marketplace.bidReadiness({ postingRef: p.postingRef, content: { ...bid(1), qualifications: { certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityCents: null, equipmentTypes: [] } } });
    expect(aPicture.verdict).toBe("submittable");
    expect(JSON.stringify(aPicture)).not.toContain(b);
    await expect(callerFor(bOffice).marketplace.bidsMine({ postingRef: p.postingRef }).then(r => r.map(x => x.bidRef))).resolves.toEqual([db2.bidRef]);
    await expect(callerFor(bOffice).marketplace.bidsForPosting({ postingRef: p.postingRef })).rejects.toThrow(/Only the client organization/);
    await expect(callerFor(bOffice).marketplace.bidSubmit({ bidRef: da.bidRef })).rejects.toThrow(/Bid not found/);
    const forged = await callerFor(bOffice).marketplace.postingCreate({ ...TENDER, title: "Forged", ...( { clientOrgRef: client } as object) });
    expect((await callerFor(bOffice).marketplace.postingGet({ postingRef: forged.postingRef })).clientOrgRef).toBe(b);

    // The client reads A's eligibility and check results — not A's holdings, units, users or policy references.
    const seen = await callerFor(clientOffice).marketplace.bidsForPosting({ postingRef: p.postingRef });
    const aRow = seen.find(x => x.bidRef === da.bidRef)!;
    expect(aRow.currentReadiness).toMatchObject({ eligibility: "eligible", blockerCount: 0 });
    expect(aRow.currentReadiness!.checks.find(c => c.check === "worker_qualifications")).toEqual({ check: "worker_qualifications", result: "PASS" });
    const text = JSON.stringify(seen);
    for (const secret of [...qa.holdingRefs, ...qa.userIds.map(String), qa.policyRef!, String(qa.financialEntityId)]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"detail"/);
    expect(seen.some(x => x.bidRef === db2.bidRef)).toBe(false);   // a draft is nobody's business but the bidder's

    // A role with no marketplace permission reads nothing; the client's own door never evaluates another company by name.
    await expect(callerFor(clientDriver).marketplace.bidReadiness({ postingRef: p.postingRef })).rejects.toThrow(/marketplace\.bid\.manage/);
    const clientSelf = await callerFor(clientOffice).marketplace.bidReadiness({ postingRef: p.postingRef });
    expect(checkOf(clientSelf, "counterparty").result).toBe("BLOCK");
  });

  it("fails closed on an inactive organization and on records it cannot verify", async () => {
    const client = await org("Inactive Energy");
    const clientOffice = await member(client, ["office"]);
    const suspended = `ORG-${rnd()}`;
    await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'suspended')", [suspended, "Suspended Vac"]);
    const suspendedOffice = await member(suspended, ["office"]);
    await qualifyOrganization(pool, suspended, COMPLIANT);
    const unverified = await org("Unverified Vac");
    const unverifiedOffice = await member(unverified, ["office"]);
    await qualifyOrganization(pool, unverified, { ...COMPLIANT, coverageVerified: false });
    const p = await tender(clientOffice);

    const s1 = await callerFor(suspendedOffice).marketplace.bidReadiness({ postingRef: p.postingRef });
    expect(s1.blockers.map(b => b.check)).toEqual(["organization"]);
    const s2 = await callerFor(unverifiedOffice).marketplace.bidReadiness({ postingRef: p.postingRef });
    expect(checkOf(s2, "insurance")).toMatchObject({ result: "UNKNOWN", blocking: true });
    expect(s2.verdict).toBe("blocked");
    const draft = await callerFor(unverifiedOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(80_000) });
    await expect(callerFor(unverifiedOffice).marketplace.bidSubmit({ bidRef: draft.bidRef })).rejects.toThrow(/insurance \[UNKNOWN\]/);
  });
});
