/**
 * The marketplace (0233) through the real router, against a real database.
 *
 * Three organizations: a client that posts work and two contractors that bid.
 * The tender is sealed, so the client is shown no price until it closes the
 * bidding; a bid is withdrawn and resubmitted and both revisions survive; the
 * client awards one bid with a reason and the other is rejected in the same
 * transaction; a third organization sees none of it. Every refusal along the
 * way is asserted by its reason, and the trail is read back at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { qualifyOrganization } from "./fixtures/marketplaceQualify";

const DB_URL = process.env.DATABASE_URL;

describe("marketplace — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped marketplace suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 316_000_000 + Math.floor(Math.random() * 50_000);
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

async function org(name: string, status: "active" | "suspended" = "active") {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,?)", [orgRef, name, status]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function contractorProfile(orgRef: string, status: "active" | "suspended" = "active") {
  await pool.execute("INSERT INTO contractorBusinessProfiles (orgRef, operatingMode, legalName, status, createdByUserId) VALUES (?,?,?,?,1)", [orgRef, "CONTRACTOR_COMPANY", `Profile ${orgRef}`, status]);
}

const POSTING = {
  title: "Produced water haul — Fox Creek to disposal",
  workType: "FLUID_HAULING",
  pickupLocation: "Fox Creek, AB",
  pickupLsd: "04-12-063-19W5",
  destination: "Disposal Facility XYZ",
  estimatedQuantityMillis: 600_000,
  quantityUnit: "M3",
  equipmentType: "Tandem / tri-drive vacuum units",
  unitsRequired: 4,
  estimatedDistanceKm: 86,
  requestedStart: new Date("2026-09-24T07:00:00Z"),
  requirements: { certifications: ["TDG", "H2S"], dangerousGoods: ["CLASS_3"], insuranceLiabilityMinimumCents: 500_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] },
};

const QUALIFIED = { certifications: ["TDG", "H2S"], permits: [], dangerousGoods: ["CLASS_3"], insuranceLiabilityCents: 500_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] };
/** What the POSTING above requires of a bidder, as the registries hold it (0236). */
const qualify = (orgRef: string, over: Parameters<typeof qualifyOrganization>[2] = {}) => qualifyOrganization(pool, orgRef, { workerCodes: ["TDG", "H2S", "TDG_ROAD"], unitClass: "TRI_DRIVE_VAC", liabilityLimit: 5_000_000, ...over });

const fixedBid = (totalCents: number, units = 4) => ({
  pricingType: "fixed_price" as const, currency: "CAD", fixedTotalCents: totalCents, components: [],
  exclusions: ["Disposal fees"], qualifications: QUALIFIED, unitsOffered: units, availableFrom: new Date("2026-09-24T07:00:00Z"), notes: null, attachments: [],
});

d("a sealed tender from posting to award", () => {
  it("posts, invites, takes two bids it cannot price until closed, and awards one with a reason", async () => {
    const client = await org("Fixture Energy Ltd.");
    const prairie = await org("Prairie Vac");
    const abc = await org("ABC Transport");
    const stranger = await org("Nosy Hauling");
    await contractorProfile(prairie);
    await contractorProfile(abc);
    await qualify(prairie);
    await qualify(abc);
    const clientOffice = await member(client, ["office"]);
    const clientMgmt = await member(client, ["management"]);
    const prairieDispatch = await member(prairie, ["dispatcher"]);
    const abcOffice = await member(abc, ["office"]);
    const strangerMgmt = await member(stranger, ["management"]);

    // --- the posting is a draft nobody else can see
    const created = await callerFor(clientOffice).marketplace.postingCreate({ ...POSTING, visibility: "sealed", distribution: "public" });
    expect(created.state).toBe("draft");
    expect(created.version).toBe(1);
    await expect(callerFor(prairieDispatch).marketplace.postingGet({ postingRef: created.postingRef })).rejects.toThrow(/Posting not found/);
    const boardBefore = await callerFor(prairieDispatch).marketplace.postingsList();
    expect(boardBefore.find(p => p.postingRef === created.postingRef)).toBeUndefined();

    // --- only the client edits, and a stale version is refused
    await expect(callerFor(strangerMgmt).marketplace.postingPublish({ postingRef: created.postingRef })).rejects.toThrow(/Only the client organization/);
    await expect(callerFor(clientOffice).marketplace.postingPublish({ postingRef: created.postingRef, expectedVersion: 99 })).rejects.toThrow(/changed since it was read/);
    const updated = await callerFor(clientOffice).marketplace.postingUpdate({ postingRef: created.postingRef, expectedVersion: 1, draft: { ...POSTING, title: "Produced water haul — Fox Creek → Disposal XYZ", visibility: "sealed" } });
    expect(updated.version).toBe(2);

    // --- published, then open for bidding; a bid before that is draft-only
    const published = await callerFor(clientOffice).marketplace.postingPublish({ postingRef: created.postingRef, expectedVersion: 2 });
    expect(published.state).toBe("published");
    await expect(callerFor(clientOffice).marketplace.postingUpdate({ postingRef: created.postingRef, draft: POSTING })).rejects.toThrow(/can no longer be edited/);
    const early = await callerFor(prairieDispatch).marketplace.bidReadiness({ postingRef: created.postingRef, content: fixedBid(1_940_000) });
    expect(early.verdict).toBe("blocked");
    expect(early.checks.find(r => r.check === "bidding_window")?.detail).toMatch(/not_yet_open/);
    const opened = await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: created.postingRef });
    expect(opened.state).toBe("bidding");

    // --- the client cannot bid on its own posting
    await expect(callerFor(clientOffice).marketplace.bidDraftSave({ postingRef: created.postingRef, content: fixedBid(1) })).rejects.toThrow(/cannot bid on its own posting/);

    // --- Prairie drafts, submits v1, withdraws, re-drafts and submits v2; v1 survives untouched
    const draft = await callerFor(prairieDispatch).marketplace.bidDraftSave({ postingRef: created.postingRef, content: fixedBid(2_100_000) });
    expect(draft.state).toBe("draft");
    const v1 = await callerFor(prairieDispatch).marketplace.bidSubmit({ bidRef: draft.bidRef, expectedVersion: draft.version });
    expect(v1.revisionNumber).toBe(1);
    expect(v1.state).toBe("submitted");
    expect(v1.readiness.verdict).toBe("submittable");
    await expect(callerFor(prairieDispatch).marketplace.bidDraftSave({ postingRef: created.postingRef, content: fixedBid(1_940_000) })).rejects.toThrow(/stands as submitted/);
    const withdrawn = await callerFor(prairieDispatch).marketplace.bidWithdraw({ bidRef: draft.bidRef, reason: "Re-pricing after the road ban lifted" });
    expect(withdrawn.state).toBe("withdrawn");
    await callerFor(prairieDispatch).marketplace.bidDraftSave({ postingRef: created.postingRef, content: fixedBid(1_940_000) });
    const v2 = await callerFor(prairieDispatch).marketplace.bidSubmit({ bidRef: draft.bidRef });
    expect(v2.revisionNumber).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    const mine = await callerFor(prairieDispatch).marketplace.bidsMine({ postingRef: created.postingRef });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.revisions.map(r => r.revisionNumber)).toEqual([1, 2]);
    expect(mine[0]!.revisions[0]!.contentHash).toBe(v1.contentHash);
    expect(mine[0]!.revisions[0]!.pricing).toMatchObject({ visible: true, fixedTotalCents: 2_100_000 });
    expect(mine[0]!.revisions[1]!.pricing).toMatchObject({ visible: true, fixedTotalCents: 1_940_000 });
    expect(mine[0]!.draft).toBeNull();

    // --- ABC submits a partial-capacity bid: a warning the client sees, not a refusal
    const abcDraft = await callerFor(abcOffice).marketplace.bidDraftSave({ postingRef: created.postingRef, content: fixedBid(1_790_000, 3) });
    const abcBid = await callerFor(abcOffice).marketplace.bidSubmit({ bidRef: abcDraft.bidRef });
    expect(abcBid.readiness.checks.find(r => r.check === "units_offered")).toMatchObject({ result: "WARN", blocking: false });

    // --- an organization with nothing on record may draft, and its submission is refused by the registries, not by what it declares
    const noTdg = await callerFor(strangerMgmt).marketplace.bidDraftSave({ postingRef: created.postingRef, content: { ...fixedBid(900_000), qualifications: QUALIFIED } });
    await expect(callerFor(strangerMgmt).marketplace.bidSubmit({ bidRef: noTdg.bidRef })).rejects.toThrow(/Not eligible to submit.*insurance \[UNKNOWN\].*worker_qualifications \[UNKNOWN\]/);

    // --- SEALED: the client sees the bids and their readiness, but no price, until it closes bidding
    const sealedView = await callerFor(clientOffice).marketplace.bidsForPosting({ postingRef: created.postingRef });
    const live = sealedView.filter(b => b.state === "submitted");
    expect(live).toHaveLength(2);
    for (const b of live) {
      expect(b.pricingWithheld).toMatch(/sealed tender/);
      expect(b.current?.pricing.visible).toBe(false);
      // The client reads a projection: eligibility and check results, never the bidder's detail.
      expect(["eligible", "eligible_with_warnings"]).toContain((b.current?.submissionReadiness as { eligibility: string }).eligibility);
      expect(b.currentReadiness?.eligibility).toBe((b.current?.submissionReadiness as { eligibility: string }).eligibility);
      expect(b.readinessChangedSinceSubmission).toBe(false);
    }
    const sealedPosting = await callerFor(clientOffice).marketplace.postingGet({ postingRef: created.postingRef });
    expect(sealedPosting.liveBidCount).toBe(2);
    expect(sealedPosting.openBidRange).toBeNull();
    // No bidder, and no stranger, reads the comparison table.
    await expect(callerFor(prairieDispatch).marketplace.bidsForPosting({ postingRef: created.postingRef })).rejects.toThrow(/Only the client organization/);
    await expect(callerFor(strangerMgmt).marketplace.bidsForPosting({ postingRef: created.postingRef })).rejects.toThrow(/Only the client organization/);

    // --- awarding before close is refused by the state machine
    await expect(callerFor(clientMgmt).marketplace.award({ postingRef: created.postingRef, bidRef: draft.bidRef, rationale: "Four compliant units available on the start date." })).rejects.toThrow(/cannot "award"/);

    // --- close, and the prices appear to the client (and to nobody else)
    const closed = await callerFor(clientOffice).marketplace.postingCloseBidding({ postingRef: created.postingRef });
    expect(closed.state).toBe("bidding_closed");
    await expect(callerFor(prairieDispatch).marketplace.bidWithdraw({ bidRef: draft.bidRef })).rejects.toThrow(/only while bidding is open/);
    const openView = await callerFor(clientOffice).marketplace.bidsForPosting({ postingRef: created.postingRef });
    const prairieRow = openView.find(b => b.bidRef === draft.bidRef)!;
    expect(prairieRow.pricingWithheld).toBeNull();
    expect(prairieRow.current?.pricing).toMatchObject({ visible: true, fixedTotalCents: 1_940_000, comparableTotalCents: 1_940_000 });
    expect(prairieRow.revisionCount).toBe(2);
    await callerFor(clientOffice).marketplace.bidShortlist({ bidRef: draft.bidRef });

    // --- the award needs the award permission (office lacks it), a rationale, and the client's own posting
    await expect(callerFor(clientOffice).marketplace.award({ postingRef: created.postingRef, bidRef: draft.bidRef, rationale: "Four compliant units available on the start date." })).rejects.toThrow(/marketplace\.award/);
    await expect(callerFor(strangerMgmt).marketplace.award({ postingRef: created.postingRef, bidRef: draft.bidRef, rationale: "I would like this contract please." })).rejects.toThrow(/Only the client organization/);
    await expect(callerFor(clientMgmt).marketplace.award({ postingRef: created.postingRef, bidRef: draft.bidRef, rationale: "ok" })).rejects.toThrow();
    const award = await callerFor(clientMgmt).marketplace.award({ postingRef: created.postingRef, bidRef: draft.bidRef, rationale: "Not the lowest price: four compliant tri-drive units available on the start date, where ABC offered three." });
    expect(award.state).toBe("awarded");
    expect(award.contractorOrgRef).toBe(prairie);
    expect(award.contentHash).toBe(v2.contentHash);

    // --- one award per posting; the other bid was rejected in the same transaction
    await expect(callerFor(clientMgmt).marketplace.award({ postingRef: created.postingRef, bidRef: abcDraft.bidRef, rationale: "Changed my mind, the cheaper one after all." })).rejects.toThrow(/cannot "award"/);
    const after = await callerFor(clientOffice).marketplace.bidsForPosting({ postingRef: created.postingRef });
    expect(after.find(b => b.bidRef === draft.bidRef)?.state).toBe("accepted");
    expect(after.find(b => b.bidRef === abcDraft.bidRef)?.state).toBe("rejected");
    const abcMine = await callerFor(abcOffice).marketplace.bidsMine({ postingRef: created.postingRef });
    expect(abcMine[0]?.state).toBe("rejected");

    // --- what each party sees of the award
    const clientSees = await callerFor(clientOffice).marketplace.postingGet({ postingRef: created.postingRef });
    expect(clientSees.award).toMatchObject({ contractorOrgRef: prairie, comparableTotalCents: 1_940_000, contentHash: v2.contentHash });
    expect(clientSees.award?.rationale).toMatch(/Not the lowest price/);
    const strangerSees = await callerFor(strangerMgmt).marketplace.postingGet({ postingRef: created.postingRef });
    expect(strangerSees.state).toBe("awarded");
    expect(strangerSees.award?.contractorOrgRef).toBe(prairie);
    expect(strangerSees.award?.comparableTotalCents).toBeNull();
    expect(strangerSees.award?.rationale).toBeNull();

    // --- the trail: the client reads all of it; a bidder reads the posting's and its own bid's events only
    const trail = await callerFor(clientOffice).marketplace.postingEvents({ postingRef: created.postingRef });
    // `followers_notified` appears when a database carries follow-everything rows from another suite; it is not part of this tender's story.
    const types = trail.map(e => e.eventType).filter(t => t !== "followers_notified");
    expect(types.slice(0, 5)).toEqual(["posting_created", "posting_updated", "posting_publish", "posting_open_bidding", "bid_draft_saved"]);
    expect(types).toContain("bid_withdrawn");
    expect(types.filter(t => t === "bid_submitted")).toHaveLength(3);
    expect(types).toContain("bid_shortlisted");
    expect(types).toContain("bid_accepted");
    expect(types).toContain("bid_rejected");
    expect(types[types.length - 1]).toBe("posting_awarded");
    expect(trail.every(e => e.actorUserId != null && e.actorOrgRef != null)).toBe(true);
    const prairieTrail = await callerFor(prairieDispatch).marketplace.postingEvents({ postingRef: created.postingRef });
    expect(prairieTrail.some(e => e.eventType === "bid_rejected")).toBe(false);
    expect(prairieTrail.some(e => e.eventType === "bid_accepted")).toBe(true);
    expect(prairieTrail.some(e => e.eventType === "posting_awarded")).toBe(true);

    // --- the outbox carries the same story, in the client's tenant, for the workflow engine
    const [outbox] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, tenantId, aggregateType FROM domainEventOutbox WHERE eventType LIKE 'marketplace.%' AND JSON_EXTRACT(payloadJson, '$.postingId') = ? ORDER BY id", [created.postingId]);
    expect(outbox.map(r => r.eventType)).toContain("marketplace.posting_awarded");
    expect(outbox.map(r => r.eventType)).toContain("marketplace.bid_submitted");
    expect(outbox.filter(r => r.eventType === "marketplace.posting_awarded")[0]).toMatchObject({ tenantId: client, aggregateType: "marketplace_award" });

    // --- the frozen revisions are exactly what was submitted
    const [revs] = await pool.query<mysql.RowDataPacket[]>("SELECT revisionNumber, contentHash, comparableTotalCents, readinessVerdict FROM marketplaceBidRevisions WHERE postingId = ? AND bidderOrgRef = ? ORDER BY revisionNumber", [created.postingId, prairie]);
    expect(revs.map(r => [r.revisionNumber, r.comparableTotalCents, r.readinessVerdict])).toEqual([[1, 2_100_000, "submittable"], [2, 1_940_000, "submittable"]]);
    expect(revs[0]!.contentHash).toBe(v1.contentHash);
  });
});

d("the deadline is enforced by the clock, not by the row's state", () => {
  it("refuses a submission at the deadline while the posting still reads 'bidding', and refuses publishing a past deadline", async () => {
    const client = await org("Deadline Energy");
    const bidder = await org("Punctual Vac");
    await contractorProfile(bidder);
    await qualify(bidder);
    const clientOffice = await member(client, ["office"]);
    const bidderOffice = await member(bidder, ["office"]);

    const past = await callerFor(clientOffice).marketplace.postingCreate({ ...POSTING, biddingClosesAt: new Date(Date.now() - 60_000) });
    await expect(callerFor(clientOffice).marketplace.postingPublish({ postingRef: past.postingRef })).rejects.toThrow(/already in the past/);

    const soon = await callerFor(clientOffice).marketplace.postingCreate({ ...POSTING, biddingClosesAt: new Date(Date.now() + 2_500) });
    await callerFor(clientOffice).marketplace.postingPublish({ postingRef: soon.postingRef });
    await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: soon.postingRef });
    const inTime = await callerFor(bidderOffice).marketplace.bidDraftSave({ postingRef: soon.postingRef, content: fixedBid(1_000_000) });
    const submitted = await callerFor(bidderOffice).marketplace.bidSubmit({ bidRef: inTime.bidRef });
    expect(submitted.state).toBe("submitted");
    await callerFor(bidderOffice).marketplace.bidWithdraw({ bidRef: inTime.bidRef });
    await callerFor(bidderOffice).marketplace.bidDraftSave({ postingRef: soon.postingRef, content: fixedBid(990_000) });

    await new Promise(r => setTimeout(r, 2_600));
    const view = await callerFor(bidderOffice).marketplace.postingGet({ postingRef: soon.postingRef });
    expect(view.state).toBe("bidding");
    expect(view.biddingWindow).toEqual({ open: false, reason: "closed_by_deadline" });
    await expect(callerFor(bidderOffice).marketplace.bidSubmit({ bidRef: inTime.bidRef })).rejects.toThrow(/closed_by_deadline/);

    // The client's close after the deadline is not "early"; the trail says so.
    await callerFor(clientOffice).marketplace.postingCloseBidding({ postingRef: soon.postingRef });
    const trail = await callerFor(clientOffice).marketplace.postingEvents({ postingRef: soon.postingRef });
    const close = trail.find(e => e.eventType === "posting_close_bidding")!;
    expect(JSON.parse(close.detailJson!)).toMatchObject({ closedEarly: false });
  }, 20_000);
});

d("invite-only tenders and tenant isolation", () => {
  it("shows an invite-only posting to invitees alone, refuses the uninvited, and lets the client close early with that fact recorded", async () => {
    const client = await org("Private Tender Co.");
    const invited = await org("Invited Vac");
    const uninvited = await org("Uninvited Vac");
    await contractorProfile(invited);
    await contractorProfile(uninvited);
    await qualify(invited);
    const clientOffice = await member(client, ["office"]);
    const invitedOffice = await member(invited, ["office"]);
    const uninvitedOffice = await member(uninvited, ["office"]);

    const p = await callerFor(clientOffice).marketplace.postingCreate({ ...POSTING, distribution: "invite_only", visibility: "open", biddingClosesAt: new Date(Date.now() + 3_600_000) });
    await expect(callerFor(clientOffice).marketplace.postingInvite({ postingRef: p.postingRef, invitedOrgRef: client })).rejects.toThrow(/cannot invite itself/);
    await expect(callerFor(clientOffice).marketplace.postingInvite({ postingRef: p.postingRef, invitedOrgRef: "ORG-DOES-NOT-EXIST" })).rejects.toThrow(/Invited organization not found/);
    const inv = await callerFor(clientOffice).marketplace.postingInvite({ postingRef: p.postingRef, invitedOrgRef: invited });
    expect(inv.status).toBe("sent");
    const again = await callerFor(clientOffice).marketplace.postingInvite({ postingRef: p.postingRef, invitedOrgRef: invited });
    expect(again).toMatchObject({ invitationRef: inv.invitationRef, alreadyInvited: true });
    await callerFor(clientOffice).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: p.postingRef });

    const invitedBoard = await callerFor(invitedOffice).marketplace.postingsList();
    expect(invitedBoard.some(x => x.postingRef === p.postingRef)).toBe(true);
    const uninvitedBoard = await callerFor(uninvitedOffice).marketplace.postingsList();
    expect(uninvitedBoard.some(x => x.postingRef === p.postingRef)).toBe(false);
    await expect(callerFor(uninvitedOffice).marketplace.postingGet({ postingRef: p.postingRef })).rejects.toThrow(/Posting not found/);
    await expect(callerFor(uninvitedOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(1) })).rejects.toThrow(/Posting not found/);

    // An OPEN posting shows the invitee the live range — an aggregate — and never a competitor's bid.
    const b = await callerFor(invitedOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(1_500_000) });
    await callerFor(invitedOffice).marketplace.bidSubmit({ bidRef: b.bidRef });
    const seen = await callerFor(invitedOffice).marketplace.postingGet({ postingRef: p.postingRef });
    expect(seen.openBidRange).toEqual({ liveBids: 1, withTotal: 1, lowestCents: 1_500_000, highestCents: 1_500_000 });
    expect(seen.invitations).toEqual([]);
    const clientSeen = await callerFor(clientOffice).marketplace.postingGet({ postingRef: p.postingRef });
    expect(clientSeen.invitations).toHaveLength(1);
    const openPricing = await callerFor(clientOffice).marketplace.bidsForPosting({ postingRef: p.postingRef });
    expect(openPricing[0]?.current?.pricing.visible).toBe(true);

    const closed = await callerFor(clientOffice).marketplace.postingCloseBidding({ postingRef: p.postingRef });
    expect(closed.state).toBe("bidding_closed");
    const trail = await callerFor(clientOffice).marketplace.postingEvents({ postingRef: p.postingRef });
    expect(JSON.parse(trail.find(e => e.eventType === "posting_close_bidding")!.detailJson!)).toMatchObject({ closedEarly: true });
    await expect(callerFor(clientOffice).marketplace.postingInvite({ postingRef: p.postingRef, invitedOrgRef: uninvited })).rejects.toThrow(/no longer accepts invitations/);
  });

  it("refuses a suspended organization's bid, a bid against a posting that asks for another pricing basis, and the wrong roles at every door", async () => {
    const client = await org("Role Gate Energy");
    const suspended = await org("Suspended Vac", "suspended");
    const clientOffice = await member(client, ["office"]);
    const clientDispatcher = await member(client, ["dispatcher"]);
    const clientDriver = await member(client, ["driver"]);
    const suspendedOffice = await member(suspended, ["office"]);
    const vac = await org("Unit Rate Vac");
    const vacOffice = await member(vac, ["office"]);

    const p = await callerFor(clientOffice).marketplace.postingCreate({ ...POSTING, pricingBasis: "unit_rate", visibility: "open" });
    await callerFor(clientOffice).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: p.postingRef });

    // A suspended organization's member is refused before the marketplace is reached: since v23.26 the
    // acting scope does not resolve into a company an administrator has stopped. (The evaluator's own
    // `organization` BLOCK row, for a bidder suspended after it bid, is pinned in marketplaceReadiness.test.)
    const unit = { ...fixedBid(1), pricingType: "unit_rate" as const, fixedTotalCents: null, components: [{ code: "LOAD", label: "Per load", unit: "LOAD" as const, rateCents: 48_500, estimatedQuantityMillis: 8_000 }] };
    await expect(callerFor(suspendedOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: unit })).rejects.toThrow(/No active organization membership/);
    await expect(callerFor(vacOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(1) })).rejects.toThrow(/asks for unit_rate bids/);
    const sb = await callerFor(vacOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: unit });

    // Roles: a driver holds no marketplace permission; a dispatcher may read and bid but not post; office may not award.
    await expect(callerFor(clientDriver).marketplace.postingsList()).rejects.toThrow(/marketplace\.read/);
    await expect(callerFor(clientDispatcher).marketplace.postingCreate(POSTING)).rejects.toThrow(/marketplace\.posting\.manage/);
    expect(await callerFor(clientDispatcher).marketplace.postingsList({ mineOnly: true })).toEqual(expect.any(Array));
    await expect(callerFor(clientOffice).marketplace.award({ postingRef: p.postingRef, bidRef: sb.bidRef, rationale: "office tries to award this one" })).rejects.toThrow(/marketplace\.award/);
  });

  it("cancels a posting, rejecting its live bids and cancelling its award in the same act", async () => {
    const client = await org("Cancel Energy");
    const vac = await org("Cancelled-On Vac");
    await contractorProfile(vac);
    await qualify(vac);
    const clientMgmt = await member(client, ["management"]);
    const vacOffice = await member(vac, ["office"]);

    const p = await callerFor(clientMgmt).marketplace.postingCreate({ ...POSTING, visibility: "open" });
    await callerFor(clientMgmt).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientMgmt).marketplace.postingOpenBidding({ postingRef: p.postingRef });
    const b = await callerFor(vacOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(700_000) });
    await callerFor(vacOffice).marketplace.bidSubmit({ bidRef: b.bidRef });
    await callerFor(clientMgmt).marketplace.postingCloseBidding({ postingRef: p.postingRef });
    const award = await callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: b.bidRef, rationale: "Only bid, and it meets every stated requirement." });
    expect(award.state).toBe("awarded");

    const cancelled = await callerFor(clientMgmt).marketplace.postingCancel({ postingRef: p.postingRef, reason: "Client's well shut in; haul no longer required." });
    expect(cancelled.state).toBe("cancelled");
    const view = await callerFor(vacOffice).marketplace.postingGet({ postingRef: p.postingRef });
    expect(view.state).toBe("cancelled");
    expect(view.award?.state).toBe("cancelled");
    await expect(callerFor(clientMgmt).marketplace.postingCancel({ postingRef: p.postingRef, reason: "again" })).rejects.toThrow(/cannot "cancel"/);
    const trail = await callerFor(clientMgmt).marketplace.postingEvents({ postingRef: p.postingRef });
    expect(trail.map(e => e.eventType).slice(-2)).toEqual(["posting_cancel", "award_cancelled"]);
  });

  it("lets exactly one of two simultaneous awards through, under the posting lock", async () => {
    const client = await org("Race Energy");
    const a = await org("Racer A");
    const b = await org("Racer B");
    await contractorProfile(a);
    await contractorProfile(b);
    await qualify(a);
    await qualify(b);
    const clientMgmt = await member(client, ["management"]);
    const aOffice = await member(a, ["office"]);
    const bOffice = await member(b, ["office"]);

    const p = await callerFor(clientMgmt).marketplace.postingCreate({ ...POSTING, visibility: "open" });
    await callerFor(clientMgmt).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientMgmt).marketplace.postingOpenBidding({ postingRef: p.postingRef });
    const ba = await callerFor(aOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(500_000) });
    await callerFor(aOffice).marketplace.bidSubmit({ bidRef: ba.bidRef });
    const bb = await callerFor(bOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(510_000) });
    await callerFor(bOffice).marketplace.bidSubmit({ bidRef: bb.bidRef });
    await callerFor(clientMgmt).marketplace.postingCloseBidding({ postingRef: p.postingRef });

    const results = await Promise.allSettled([
      callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: ba.bidRef, rationale: "Racer A: earlier availability on the start date." }),
      callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: bb.bidRef, rationale: "Racer B: more units offered for the same haul." }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch(/cannot "award"|already carries an award/);
    const [awards] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM marketplaceAwards WHERE postingId = ?", [p.postingId]);
    expect(Number(awards[0]!.n)).toBe(1);
    const [[states]] = await pool.query<mysql.RowDataPacket[]>("SELECT SUM(state='accepted') AS accepted, SUM(state='rejected') AS rejected FROM marketplaceBids WHERE postingId = ?", [p.postingId]);
    expect([Number(states!.accepted), Number(states!.rejected)]).toEqual([1, 1]);
  });

  it("refuses to award a revision whose stored content no longer hashes to what was submitted", async () => {
    const client = await org("Tamper Energy");
    const vac = await org("Tampered Vac");
    await contractorProfile(vac);
    await qualify(vac);
    const clientMgmt = await member(client, ["management"]);
    const vacOffice = await member(vac, ["office"]);

    const p = await callerFor(clientMgmt).marketplace.postingCreate({ ...POSTING, visibility: "open" });
    await callerFor(clientMgmt).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientMgmt).marketplace.postingOpenBidding({ postingRef: p.postingRef });
    const b = await callerFor(vacOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: fixedBid(800_000) });
    const sub = await callerFor(vacOffice).marketplace.bidSubmit({ bidRef: b.bidRef });
    await callerFor(clientMgmt).marketplace.postingCloseBidding({ postingRef: p.postingRef });

    // Somebody edits the write-once row underneath the system.
    await pool.execute("UPDATE marketplaceBidRevisions SET contentJson = REPLACE(contentJson, '800000', '700000') WHERE revisionRef = ?", [sub.revisionRef]);
    await expect(callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: b.bidRef, rationale: "Looks cheaper than I remembered, which is the problem." })).rejects.toThrow(/no longer hashes to what was submitted/);
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT state FROM marketplacePostings WHERE postingRef = ?", [p.postingRef]);
    expect(row!.state).toBe("bidding_closed");
  });
});
