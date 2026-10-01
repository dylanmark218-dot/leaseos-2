/**
 * Marketplace — the transactional half.
 *
 * Every write here runs inside one transaction that (a) locks the row whose
 * state is changing, (b) asks the pure module whether the change is allowed,
 * (c) refuses a stale version rather than merging, (d) appends a
 * `marketplaceEvents` row, and (e) hands the outbox a domain event — all of
 * which commit together or not at all.
 *
 * Tenant isolation is the acting organization, resolved from the caller's
 * membership (`resolveActingScope`), never from input. A posting is the
 * client's; a bid is the bidder's; nobody else reads either's private parts.
 * The pure module decides who may see a price; this file applies it to every
 * row it returns.
 */

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  contractorBusinessProfiles,
  domainEventOutbox,
  marketplaceAwards,
  marketplaceBidRevisions,
  marketplaceBids,
  marketplaceEvents,
  marketplaceInvitations,
  marketplacePostings,
  organizations,
  type MarketplaceAwardRow,
  type MarketplaceBidRevisionRow,
  type MarketplaceBidRow,
  type MarketplacePostingRow,
} from "../../drizzle/schema";
import type { Db, DbOrTx, Tx } from "./dbTypes";
import { buildOutboxRow } from "./eventEmitter";
import {
  EMPTY_REQUIREMENTS,
  assessBidReadiness,
  bidContentHash,
  bidIsLive,
  biddingWindow,
  comparableTotalCents,
  makeRef,
  mayViewBidPricing,
  openBidRange,
  postingAcceptsInvitations,
  postingIsEditable,
  transitionBid,
  transitionPosting,
  validateBidContent,
  type BidContent,
  type BidReadiness,
  type BidState,
  type PostingDistribution,
  type PostingRequirements,
  type PostingState,
  type PostingVisibility,
} from "./marketplace";

/* ===================== actor ===================== */

export type MarketplaceActor = {
  userId: number;
  /** The organization the caller acts for — from membership, never from input. */
  orgRef: string;
};

/* ===================== audit + outbox ===================== */

type AuditInput = {
  postingId: number;
  bidId?: number | null;
  bidRevisionId?: number | null;
  awardId?: number | null;
  eventType: string;
  previousState?: string | null;
  newState?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * One call records both halves of the trail: the marketplace's own append-only
 * event (what an auditor reads beside the posting) and the outbox row (what the
 * workflow engine reacts to). Same transaction, so neither can exist alone.
 */
async function record(tx: Tx, actor: MarketplaceActor, input: AuditInput, now: Date): Promise<void> {
  await tx.insert(marketplaceEvents).values({
    eventRef: makeRef("MEV"),
    postingId: input.postingId,
    bidId: input.bidId ?? null,
    bidRevisionId: input.bidRevisionId ?? null,
    awardId: input.awardId ?? null,
    eventType: input.eventType,
    actorUserId: actor.userId,
    actorOrgRef: actor.orgRef,
    previousState: input.previousState ?? null,
    newState: input.newState ?? null,
    detailJson: input.detail ? JSON.stringify(input.detail) : null,
    occurredAt: now,
  });
  const subjectType = input.awardId ? "marketplace_award" : input.bidId ? "marketplace_bid" : "marketplace_posting";
  const subjectId = String(input.awardId ?? input.bidId ?? input.postingId);
  await tx.insert(domainEventOutbox).values(
    buildOutboxRow(
      {
        type: `marketplace.${input.eventType}`,
        actor: { userId: String(actor.userId), source: "human" },
        subject: { entityType: subjectType, entityId: subjectId },
        tenantId: actor.orgRef,
        payload: {
          postingId: input.postingId,
          bidId: input.bidId ?? null,
          bidRevisionId: input.bidRevisionId ?? null,
          awardId: input.awardId ?? null,
          previousState: input.previousState ?? null,
          newState: input.newState ?? null,
          ...(input.detail ?? {}),
        },
      },
      now,
    ),
  );
}

/* ===================== helpers ===================== */

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found.` });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const refused = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });

function parseRequirements(json: string): PostingRequirements {
  try {
    const v = JSON.parse(json) as Partial<PostingRequirements>;
    return { ...EMPTY_REQUIREMENTS, ...v };
  } catch {
    return EMPTY_REQUIREMENTS;
  }
}

function parseContent(json: string): BidContent {
  const v = JSON.parse(json) as BidContent & { availableFrom: string | Date | null };
  return { ...v, availableFrom: v.availableFrom ? new Date(v.availableFrom) : null };
}

/** The posting, locked for the rest of the transaction. */
async function lockPosting(tx: Tx, postingRef: string): Promise<MarketplacePostingRow> {
  const [row] = await tx.select().from(marketplacePostings).where(eq(marketplacePostings.postingRef, postingRef)).for("update").limit(1);
  if (!row) throw notFound("Posting");
  return row;
}

/**
 * Every transaction that touches a bid locks its POSTING first and the bid
 * second. The award and the cancellation lock the posting and then every live
 * bid; a submission or withdrawal that locked the bid first would be the other
 * half of a deadlock. The head is read unlocked only to learn which posting to
 * lock, then re-read under the lock, because the unlocked copy may be stale.
 */
async function lockBidUnderPosting(tx: Tx, bidRef: string, bidder: MarketplaceActor | null): Promise<{ head: MarketplaceBidRow; posting: MarketplacePostingRow }> {
  const [peek] = await tx.select({ postingId: marketplaceBids.postingId, bidderOrgRef: marketplaceBids.bidderOrgRef }).from(marketplaceBids).where(eq(marketplaceBids.bidRef, bidRef)).limit(1);
  // A bid that is not this bidder's reads as not found: its existence is the bidder's and the client's business.
  if (!peek || (bidder && peek.bidderOrgRef !== bidder.orgRef)) throw notFound("Bid");
  const [posting] = await tx.select().from(marketplacePostings).where(eq(marketplacePostings.id, peek.postingId)).for("update").limit(1);
  if (!posting) throw notFound("Posting");
  const [head] = await tx.select().from(marketplaceBids).where(eq(marketplaceBids.bidRef, bidRef)).for("update").limit(1);
  if (!head || (bidder && head.bidderOrgRef !== bidder.orgRef)) throw notFound("Bid");
  return { head, posting };
}

function assertClient(posting: MarketplacePostingRow, actor: MarketplaceActor): void {
  if (posting.clientOrgRef !== actor.orgRef) throw forbidden("Only the client organization that owns this posting may do that.");
}

/** Refuses a caller whose copy of the row is older than the row. Nothing is merged. */
function assertVersion(expected: number | undefined, actual: number): void {
  if (expected != null && expected !== actual) {
    throw conflict(`This record changed since it was read (version ${actual}, caller held ${expected}). Re-read and decide again.`);
  }
}

/** The posting's own state advanced through the machine, or a refusal naming why. */
function advancePosting(posting: MarketplacePostingRow, event: Parameters<typeof transitionPosting>[1]): PostingState {
  const t = transitionPosting(posting.state, event);
  if (!t.allowed) throw refused(t.reason);
  return t.to;
}

function advanceBid(bid: MarketplaceBidRow, event: Parameters<typeof transitionBid>[1]): BidState {
  const t = transitionBid(bid.state, event);
  if (!t.allowed) throw refused(t.reason);
  return t.to;
}

/* ===================== postings ===================== */

export type PostingDraft = {
  title: string;
  workType: string;
  description?: string | null;
  pickupLocation?: string | null;
  pickupLsd?: string | null;
  destination?: string | null;
  destinationLsd?: string | null;
  pickupLat?: number | null;
  pickupLng?: number | null;
  estimatedQuantityMillis?: number | null;
  quantityUnit?: string | null;
  equipmentType?: string | null;
  unitsRequired?: number | null;
  estimatedDurationMinutes?: number | null;
  estimatedDistanceKm?: number | null;
  requestedStart?: Date | null;
  deadline?: Date | null;
  biddingClosesAt?: Date | null;
  pricingBasis?: "fixed_price" | "unit_rate" | "hourly" | "combination" | "any";
  visibility?: PostingVisibility;
  distribution?: PostingDistribution;
  operatingArea?: string | null;
  currency?: string;
  requirements?: Partial<PostingRequirements>;
  documents?: Array<{ name: string; sha256: string; sizeBytes: number }>;
};

function draftColumns(d: PostingDraft) {
  return {
    title: d.title,
    workType: d.workType,
    description: d.description ?? null,
    pickupLocation: d.pickupLocation ?? null,
    pickupLsd: d.pickupLsd ?? null,
    destination: d.destination ?? null,
    destinationLsd: d.destinationLsd ?? null,
    pickupLat: d.pickupLat ?? null,
    pickupLng: d.pickupLng ?? null,
    estimatedQuantityMillis: d.estimatedQuantityMillis ?? null,
    quantityUnit: d.quantityUnit ?? null,
    equipmentType: d.equipmentType ?? null,
    unitsRequired: d.unitsRequired ?? null,
    estimatedDurationMinutes: d.estimatedDurationMinutes ?? null,
    estimatedDistanceKm: d.estimatedDistanceKm ?? null,
    requestedStart: d.requestedStart ?? null,
    deadline: d.deadline ?? null,
    biddingClosesAt: d.biddingClosesAt ?? null,
    pricingBasis: d.pricingBasis ?? "any",
    visibility: d.visibility ?? "sealed",
    distribution: d.distribution ?? "public",
    operatingArea: d.operatingArea ?? null,
    currency: d.currency ?? "CAD",
    requirementsJson: JSON.stringify({ ...EMPTY_REQUIREMENTS, ...(d.requirements ?? {}) }),
    documentsJson: JSON.stringify(d.documents ?? []),
  };
}

export async function createPosting(db: Db, actor: MarketplaceActor, draft: PostingDraft, now = new Date()) {
  const postingRef = makeRef("MKT");
  return db.transaction(async tx => {
    await tx.insert(marketplacePostings).values({ postingRef, clientOrgRef: actor.orgRef, ...draftColumns(draft), createdByUserId: actor.userId });
    const posting = await lockPosting(tx, postingRef);
    await record(tx, actor, { postingId: posting.id, eventType: "posting_created", previousState: null, newState: "draft" }, now);
    return { postingRef, postingId: posting.id, state: posting.state, version: posting.version };
  });
}

export async function updatePosting(db: Db, actor: MarketplaceActor, args: { postingRef: string; expectedVersion?: number; draft: PostingDraft }, now = new Date()) {
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    assertClient(posting, actor);
    assertVersion(args.expectedVersion, posting.version);
    if (!postingIsEditable(posting.state)) throw refused(`A posting in state "${posting.state}" can no longer be edited; cancel it and post again.`);
    await tx.update(marketplacePostings).set({ ...draftColumns(args.draft), version: posting.version + 1 }).where(eq(marketplacePostings.id, posting.id));
    await record(tx, actor, { postingId: posting.id, eventType: "posting_updated", previousState: posting.state, newState: posting.state }, now);
    return { postingRef: posting.postingRef, version: posting.version + 1 };
  });
}

type PostingTransitionArgs = { postingRef: string; expectedVersion?: number };
type PostingTransitionEvent = "publish" | "open_bidding" | "close_bidding" | "cancel";

/**
 * One posting transition, inside the caller's transaction and under the
 * posting lock. Everything a transition needs to know is read from the locked
 * row, so the "closed early" flag and the deadline check describe the row as
 * it is at the instant of the write, not as it was a query ago.
 */
async function transitionLocked(
  tx: Tx,
  actor: MarketplaceActor,
  args: PostingTransitionArgs,
  event: PostingTransitionEvent,
  stamp: Partial<typeof marketplacePostings.$inferInsert>,
  detailFor: (posting: MarketplacePostingRow) => Record<string, unknown> | null,
  now: Date,
): Promise<{ posting: MarketplacePostingRow; to: PostingState }> {
  const posting = await lockPosting(tx, args.postingRef);
  assertClient(posting, actor);
  assertVersion(args.expectedVersion, posting.version);
  const to = advancePosting(posting, event);
  if ((event === "publish" || event === "open_bidding") && posting.biddingClosesAt && posting.biddingClosesAt.getTime() <= now.getTime()) {
    throw refused(`The bidding deadline (${posting.biddingClosesAt.toISOString()}) is already in the past; a posting cannot ${event === "publish" ? "be published" : "open bidding"} against it.`);
  }
  await tx.update(marketplacePostings).set({ state: to, version: posting.version + 1, ...stamp }).where(eq(marketplacePostings.id, posting.id));
  await record(tx, actor, { postingId: posting.id, eventType: `posting_${event}`, previousState: posting.state, newState: to, detail: detailFor(posting) }, now);
  return { posting, to };
}

const transitionResult = (r: { posting: MarketplacePostingRow; to: PostingState }) => ({ postingRef: r.posting.postingRef, state: r.to, version: r.posting.version + 1 });

export const publishPosting = (db: Db, actor: MarketplaceActor, args: PostingTransitionArgs, now = new Date()) =>
  db.transaction(async tx => transitionResult(await transitionLocked(tx, actor, args, "publish", { publishedAt: now }, () => null, now)));

export const openBidding = (db: Db, actor: MarketplaceActor, args: PostingTransitionArgs, now = new Date()) =>
  db.transaction(async tx => transitionResult(await transitionLocked(tx, actor, args, "open_bidding", { biddingOpenedAt: now }, () => null, now)));

/**
 * Closing before the deadline is allowed — it is the client's tender — but it is
 * recorded as early, with the deadline it pre-empted, so a bidder shut out at
 * 17:40 against an 18:00 close can see that in the trail.
 */
export const closeBidding = (db: Db, actor: MarketplaceActor, args: PostingTransitionArgs, now = new Date()) =>
  db.transaction(async tx => transitionResult(await transitionLocked(tx, actor, args, "close_bidding", { biddingClosedAt: now },
    p => ({ closedEarly: !!(p.biddingClosesAt && now.getTime() < p.biddingClosesAt.getTime()), deadline: p.biddingClosesAt?.toISOString() ?? null }), now)));

/**
 * Cancels the posting and, in the SAME transaction, rejects every live bid and
 * cancels an award if one stands — each with its own event. A cancelled posting
 * with a bid still reading "submitted" would be a lie the trail could not explain.
 */
export async function cancelPosting(db: Db, actor: MarketplaceActor, args: PostingTransitionArgs & { reason: string }, now = new Date()) {
  return db.transaction(async tx => {
    const r = await transitionLocked(tx, actor, args, "cancel", { cancelledAt: now, cancelReason: args.reason }, () => ({ reason: args.reason }), now);
    const live = await tx.select().from(marketplaceBids).where(and(eq(marketplaceBids.postingId, r.posting.id), inArray(marketplaceBids.state, ["submitted", "shortlisted"]))).for("update");
    for (const bid of live) {
      const to = advanceBid(bid, "reject");
      await tx.update(marketplaceBids).set({ state: to, version: bid.version + 1, decidedAt: now, decidedByUserId: actor.userId }).where(eq(marketplaceBids.id, bid.id));
      await record(tx, actor, { postingId: r.posting.id, bidId: bid.id, bidRevisionId: bid.currentRevisionId, eventType: "bid_rejected", previousState: bid.state, newState: to, detail: { because: "posting_cancelled" } }, now);
    }
    const [award] = await tx.select().from(marketplaceAwards).where(eq(marketplaceAwards.postingId, r.posting.id)).for("update").limit(1);
    if (award && award.state === "awarded") {
      await tx.update(marketplaceAwards).set({ state: "cancelled" }).where(eq(marketplaceAwards.id, award.id));
      await record(tx, actor, { postingId: r.posting.id, awardId: award.id, bidId: award.bidId, eventType: "award_cancelled", previousState: "awarded", newState: "cancelled", detail: { reason: args.reason } }, now);
    }
    return { ...transitionResult(r), rejectedBids: live.length, awardCancelled: !!(award && award.state === "awarded") };
  });
}

export async function invite(db: Db, actor: MarketplaceActor, args: { postingRef: string; invitedOrgRef: string }, now = new Date()) {
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    assertClient(posting, actor);
    if (!postingAcceptsInvitations(posting.state)) throw refused(`A posting in state "${posting.state}" no longer accepts invitations.`);
    if (args.invitedOrgRef === actor.orgRef) throw refused("An organization cannot invite itself to its own tender.");
    const [org] = await tx.select({ orgRef: organizations.orgRef }).from(organizations).where(eq(organizations.orgRef, args.invitedOrgRef)).limit(1);
    if (!org) throw notFound("Invited organization");
    const [existing] = await tx.select().from(marketplaceInvitations).where(and(eq(marketplaceInvitations.postingId, posting.id), eq(marketplaceInvitations.invitedOrgRef, args.invitedOrgRef))).limit(1);
    if (existing) return { invitationRef: existing.invitationRef, status: existing.status, alreadyInvited: true as const };
    const invitationRef = makeRef("INV");
    await tx.insert(marketplaceInvitations).values({ invitationRef, postingId: posting.id, invitedOrgRef: args.invitedOrgRef, invitedByUserId: actor.userId });
    await record(tx, actor, { postingId: posting.id, eventType: "invitation_sent", detail: { invitedOrgRef: args.invitedOrgRef } }, now);
    return { invitationRef, status: "sent" as const, alreadyInvited: false as const };
  });
}

/* ===================== bids ===================== */

async function bidderPicture(db: DbOrTx, posting: MarketplacePostingRow, bidderOrgRef: string, content: BidContent, now: Date) {
  const [org] = await db.select({ status: organizations.status }).from(organizations).where(eq(organizations.orgRef, bidderOrgRef)).limit(1);
  const [profile] = await db.select({ status: contractorBusinessProfiles.status }).from(contractorBusinessProfiles).where(eq(contractorBusinessProfiles.orgRef, bidderOrgRef)).limit(1);
  const [inv] = await db.select({ status: marketplaceInvitations.status }).from(marketplaceInvitations).where(and(eq(marketplaceInvitations.postingId, posting.id), eq(marketplaceInvitations.invitedOrgRef, bidderOrgRef))).limit(1);
  return assessBidReadiness(
    {
      bidderOrgRef,
      clientOrgRef: posting.clientOrgRef,
      organizationStatus: org?.status ?? "missing",
      contractorProfileStatus: profile?.status ?? "none",
      distribution: posting.distribution,
      invited: inv?.status === "sent",
      window: biddingWindow({ state: posting.state, biddingClosesAt: posting.biddingClosesAt }, now),
      unitsRequired: posting.unitsRequired,
      requirements: parseRequirements(posting.requirementsJson),
      content,
    },
    now,
  );
}

/** May this organization see the posting at all? Client, invited, or anyone once a public posting is published. */
async function postingVisibleTo(db: DbOrTx, posting: MarketplacePostingRow, orgRef: string): Promise<boolean> {
  if (posting.clientOrgRef === orgRef) return true;
  if (posting.state === "draft") return false;
  if (posting.distribution === "public") return true;
  const [inv] = await db.select({ id: marketplaceInvitations.id }).from(marketplaceInvitations).where(and(eq(marketplaceInvitations.postingId, posting.id), eq(marketplaceInvitations.invitedOrgRef, orgRef))).limit(1);
  return !!inv;
}

async function visiblePosting(db: DbOrTx, postingRef: string, orgRef: string): Promise<MarketplacePostingRow> {
  const [posting] = await db.select().from(marketplacePostings).where(eq(marketplacePostings.postingRef, postingRef)).limit(1);
  // Not-found and not-visible read the same from outside, so a draft's existence leaks to nobody.
  if (!posting || !(await postingVisibleTo(db, posting, orgRef))) throw notFound("Posting");
  return posting;
}

/** The readiness picture for content the bidder has not committed to yet. Reads only. */
export async function previewReadiness(db: Db, actor: MarketplaceActor, args: { postingRef: string; content: BidContent }, now = new Date()): Promise<BidReadiness> {
  const posting = await visiblePosting(db, args.postingRef, actor.orgRef);
  const v = validateBidContent(args.content);
  if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join(" ") });
  return bidderPicture(db, posting, actor.orgRef, args.content, now);
}

/** Saves the working draft. Creates the bid head on first save. Never touches a revision. */
export async function saveBidDraft(db: Db, actor: MarketplaceActor, args: { postingRef: string; content: BidContent }, now = new Date()) {
  const v = validateBidContent(args.content);
  if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join(" ") });
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    if (!(await postingVisibleTo(tx, posting, actor.orgRef))) throw notFound("Posting");
    if (posting.clientOrgRef === actor.orgRef) throw refused("An organization cannot bid on its own posting.");
    if (posting.pricingBasis !== "any" && posting.pricingBasis !== args.content.pricingType) {
      throw refused(`This posting asks for ${posting.pricingBasis} bids; a ${args.content.pricingType} bid does not answer it.`);
    }
    const [existing] = await tx.select().from(marketplaceBids).where(and(eq(marketplaceBids.postingId, posting.id), eq(marketplaceBids.bidderOrgRef, actor.orgRef))).for("update").limit(1);
    const contentJson = JSON.stringify(args.content);
    if (existing) {
      if (existing.state === "accepted" || existing.state === "rejected") throw refused(`A ${existing.state} bid cannot be redrafted.`);
      if (bidIsLive(existing.state)) throw refused("This bid stands as submitted. Withdraw it to prepare a new revision; the submitted revision is never edited.");
      await tx.update(marketplaceBids).set({ draftContentJson: contentJson, version: existing.version + 1 }).where(eq(marketplaceBids.id, existing.id));
      await record(tx, actor, { postingId: posting.id, bidId: existing.id, eventType: "bid_draft_saved", previousState: existing.state, newState: existing.state }, now);
      return { bidRef: existing.bidRef, state: existing.state, version: existing.version + 1 };
    }
    const bidRef = makeRef("BID");
    await tx.insert(marketplaceBids).values({ bidRef, postingId: posting.id, bidderOrgRef: actor.orgRef, draftContentJson: contentJson, createdByUserId: actor.userId });
    const [bid] = await tx.select().from(marketplaceBids).where(eq(marketplaceBids.bidRef, bidRef)).limit(1);
    await record(tx, actor, { postingId: posting.id, bidId: bid!.id, eventType: "bid_draft_saved", previousState: null, newState: "draft" }, now);
    return { bidRef, state: "draft" as const, version: 1 };
  });
}

/**
 * Freezes the draft into the next revision and submits it. Refused unless the
 * readiness verdict is `eligible_to_submit` and the bidding window is open —
 * both decided at THIS instant, under the posting lock, so a deadline that
 * passed a second ago is a refusal and not a race.
 */
export async function submitBid(db: Db, actor: MarketplaceActor, args: { bidRef: string; expectedVersion?: number }, now = new Date()) {
  return db.transaction(async tx => {
    const { head, posting } = await lockBidUnderPosting(tx, args.bidRef, actor);
    assertVersion(args.expectedVersion, head.version);
    const to = advanceBid(head, "submit");
    if (!head.draftContentJson) throw refused("There is no draft to submit.");
    const content = parseContent(head.draftContentJson);
    const v = validateBidContent(content);
    if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join(" ") });
    const readiness = await bidderPicture(tx, posting, actor.orgRef, content, now);
    if (readiness.verdict !== "eligible_to_submit") {
      const fails = readiness.rows.filter(r => r.result === "FAIL").map(r => `${r.check}: ${r.detail}`);
      throw refused(`Not eligible to submit — ${fails.join(" | ")}`);
    }
    const revisionNumber = head.revisionCount + 1;
    const revisionRef = makeRef("REV");
    const hash = bidContentHash(content);
    const cmp = comparableTotalCents(content);
    await tx.insert(marketplaceBidRevisions).values({
      revisionRef, bidId: head.id, postingId: posting.id, bidderOrgRef: actor.orgRef, revisionNumber,
      contentJson: head.draftContentJson, contentHash: hash, pricingType: content.pricingType, currency: content.currency,
      comparableTotalCents: cmp.totalCents, comparableBasis: cmp.basis,
      readinessJson: JSON.stringify(readiness), readinessVerdict: readiness.verdict,
      submittedByUserId: actor.userId, submittedAt: now,
    });
    const [rev] = await tx.select({ id: marketplaceBidRevisions.id }).from(marketplaceBidRevisions).where(eq(marketplaceBidRevisions.revisionRef, revisionRef)).limit(1);
    await tx.update(marketplaceBids).set({ state: to, currentRevisionId: rev!.id, revisionCount: revisionNumber, draftContentJson: null, submittedAt: now, withdrawnAt: null, version: head.version + 1 }).where(eq(marketplaceBids.id, head.id));
    await record(tx, actor, { postingId: posting.id, bidId: head.id, bidRevisionId: rev!.id, eventType: "bid_submitted", previousState: head.state, newState: to, detail: { revisionNumber, contentHash: hash, readinessVerdict: readiness.verdict } }, now);
    return { bidRef: head.bidRef, revisionRef, revisionNumber, contentHash: hash, state: to, version: head.version + 1, readiness };
  });
}

/** The revision stays exactly as it was; only the head's state moves. */
export async function withdrawBid(db: Db, actor: MarketplaceActor, args: { bidRef: string; expectedVersion?: number; reason?: string | null }, now = new Date()) {
  return db.transaction(async tx => {
    const { head, posting } = await lockBidUnderPosting(tx, args.bidRef, actor);
    assertVersion(args.expectedVersion, head.version);
    if (posting.state !== "bidding") throw refused(`Bids can be withdrawn only while bidding is open (posting is "${posting.state}").`);
    const to = advanceBid(head, "withdraw");
    await tx.update(marketplaceBids).set({ state: to, withdrawnAt: now, version: head.version + 1 }).where(eq(marketplaceBids.id, head.id));
    await record(tx, actor, { postingId: posting.id, bidId: head.id, bidRevisionId: head.currentRevisionId, eventType: "bid_withdrawn", previousState: head.state, newState: to, detail: { reason: args.reason ?? null } }, now);
    return { bidRef: head.bidRef, state: to, version: head.version + 1 };
  });
}

export async function shortlistBid(db: Db, actor: MarketplaceActor, args: { bidRef: string }, now = new Date()) {
  return db.transaction(async tx => {
    const { head, posting } = await lockBidUnderPosting(tx, args.bidRef, null);
    assertClient(posting, actor);
    if (posting.state !== "bidding_closed") throw refused("Shortlisting happens after bidding closes.");
    const to = advanceBid(head, "shortlist");
    await tx.update(marketplaceBids).set({ state: to, version: head.version + 1 }).where(eq(marketplaceBids.id, head.id));
    await record(tx, actor, { postingId: posting.id, bidId: head.id, bidRevisionId: head.currentRevisionId, eventType: "bid_shortlisted", previousState: head.state, newState: to }, now);
    return { bidRef: head.bidRef, state: to };
  });
}

/* ===================== award ===================== */

/**
 * The client's decision. Not the lowest price: the one they chose, with the
 * reason they give. Under the posting lock so two awards cannot race; bound to
 * the revision's content hash so what was awarded is what was bid; every other
 * live bid rejected in the same transaction.
 */
export async function awardPosting(db: Db, actor: MarketplaceActor, args: { postingRef: string; bidRef: string; rationale: string; expectedVersion?: number }, now = new Date()) {
  if (args.rationale.trim().length < 10) throw new TRPCError({ code: "BAD_REQUEST", message: "An award records why this bid was chosen; give a rationale of at least ten characters." });
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    assertClient(posting, actor);
    assertVersion(args.expectedVersion, posting.version);
    const to = advancePosting(posting, "award");
    const [existingAward] = await tx.select({ id: marketplaceAwards.id }).from(marketplaceAwards).where(eq(marketplaceAwards.postingId, posting.id)).limit(1);
    if (existingAward) throw conflict("This posting already carries an award.");
    const [head] = await tx.select().from(marketplaceBids).where(eq(marketplaceBids.bidRef, args.bidRef)).for("update").limit(1);
    if (!head || head.postingId !== posting.id) throw notFound("Bid");
    if (!bidIsLive(head.state) || !head.currentRevisionId) throw refused(`Only a standing bid can be awarded (this one is "${head.state}").`);
    const [rev] = await tx.select().from(marketplaceBidRevisions).where(eq(marketplaceBidRevisions.id, head.currentRevisionId)).limit(1);
    if (!rev) throw notFound("Bid revision");
    // The hash is recomputed from the stored content and must equal what was recorded at submission.
    // A mismatch means the write-once row was touched, and that is a refusal, never a repair.
    const recomputed = bidContentHash(parseContent(rev.contentJson));
    if (recomputed !== rev.contentHash) throw refused(`Bid revision ${rev.revisionRef} no longer hashes to what was submitted; the award is refused and the trail must be examined.`);

    const bidTo = advanceBid(head, "accept");
    const awardRef = makeRef("AWD");
    await tx.insert(marketplaceAwards).values({
      awardRef, postingId: posting.id, bidId: head.id, bidRevisionId: rev.id, clientOrgRef: posting.clientOrgRef, contractorOrgRef: head.bidderOrgRef,
      contentHash: rev.contentHash, comparableTotalCents: rev.comparableTotalCents, currency: rev.currency, rationale: args.rationale.trim(),
      readinessJson: rev.readinessJson, awardedByUserId: actor.userId, awardedAt: now,
    });
    const [award] = await tx.select({ id: marketplaceAwards.id }).from(marketplaceAwards).where(eq(marketplaceAwards.awardRef, awardRef)).limit(1);
    await tx.update(marketplaceBids).set({ state: bidTo, decidedAt: now, decidedByUserId: actor.userId, version: head.version + 1 }).where(eq(marketplaceBids.id, head.id));
    await record(tx, actor, { postingId: posting.id, bidId: head.id, bidRevisionId: rev.id, eventType: "bid_accepted", previousState: head.state, newState: bidTo }, now);

    const others = await tx.select().from(marketplaceBids).where(and(eq(marketplaceBids.postingId, posting.id), inArray(marketplaceBids.state, ["submitted", "shortlisted"]))).for("update");
    for (const other of others) {
      if (other.id === head.id) continue;
      const otherTo = advanceBid(other, "reject");
      await tx.update(marketplaceBids).set({ state: otherTo, decidedAt: now, decidedByUserId: actor.userId, version: other.version + 1 }).where(eq(marketplaceBids.id, other.id));
      await record(tx, actor, { postingId: posting.id, bidId: other.id, bidRevisionId: other.currentRevisionId, eventType: "bid_rejected", previousState: other.state, newState: otherTo, detail: { because: "another_bid_awarded" } }, now);
    }

    await tx.update(marketplacePostings).set({ state: to, awardedAt: now, version: posting.version + 1 }).where(eq(marketplacePostings.id, posting.id));
    await record(tx, actor, { postingId: posting.id, awardId: award!.id, bidId: head.id, bidRevisionId: rev.id, eventType: "posting_awarded", previousState: posting.state, newState: to, detail: { contractorOrgRef: head.bidderOrgRef, contentHash: rev.contentHash, rejectedBids: others.length - 1 } }, now);
    return { awardRef, postingRef: posting.postingRef, bidRef: head.bidRef, contractorOrgRef: head.bidderOrgRef, contentHash: rev.contentHash, state: to, version: posting.version + 1 };
  });
}

/* ===================== read models ===================== */

/** A posting as the caller may see it: the client sees everything; others see the public face. */
function presentPosting(posting: MarketplacePostingRow, viewerOrgRef: string, now: Date) {
  const window = biddingWindow({ state: posting.state, biddingClosesAt: posting.biddingClosesAt }, now);
  const { requirementsJson, documentsJson, createdByUserId, ...rest } = posting;
  return {
    ...rest,
    createdByUserId: posting.clientOrgRef === viewerOrgRef ? createdByUserId : null,
    requirements: parseRequirements(requirementsJson),
    documents: JSON.parse(documentsJson) as Array<{ name: string; sha256: string; sizeBytes: number }>,
    biddingWindow: window,
    isClient: posting.clientOrgRef === viewerOrgRef,
  };
}

export async function getPosting(db: Db, actor: MarketplaceActor, args: { postingRef: string }, now = new Date()) {
  const posting = await visiblePosting(db, args.postingRef, actor.orgRef);
  const view = presentPosting(posting, actor.orgRef, now);
  const invitations = view.isClient
    ? await db.select().from(marketplaceInvitations).where(eq(marketplaceInvitations.postingId, posting.id))
    : [];
  const bids = await db.select().from(marketplaceBids).where(eq(marketplaceBids.postingId, posting.id));
  // The range is an aggregate over live bids, shown on OPEN postings to anyone who can see the
  // posting; a sealed posting shows nothing of the sort to anyone, client included, until closed.
  const revisionIds = bids.flatMap(b => (b.currentRevisionId ? [b.currentRevisionId] : []));
  const revisions = revisionIds.length ? await db.select().from(marketplaceBidRevisions).where(inArray(marketplaceBidRevisions.id, revisionIds)) : [];
  const byId = new Map(revisions.map(r => [r.id, r]));
  const range = posting.visibility === "open"
    ? openBidRange(bids.map(b => ({ state: b.state, comparableTotalCents: b.currentRevisionId ? byId.get(b.currentRevisionId)?.comparableTotalCents ?? null : null })))
    : null;
  const [award] = await db.select().from(marketplaceAwards).where(eq(marketplaceAwards.postingId, posting.id)).limit(1);
  return {
    ...view,
    invitations,
    liveBidCount: bids.filter(b => bidIsLive(b.state)).length,
    openBidRange: range,
    award: award ? presentAward(award, actor.orgRef) : null,
  };
}

function presentAward(award: MarketplaceAwardRow, viewerOrgRef: string) {
  const party = award.clientOrgRef === viewerOrgRef || award.contractorOrgRef === viewerOrgRef;
  // A third party sees that the posting was awarded and to whom; the price and the rationale are the parties'.
  return {
    awardRef: award.awardRef,
    contractorOrgRef: award.contractorOrgRef,
    state: award.state,
    awardedAt: award.awardedAt,
    contentHash: award.contentHash,
    comparableTotalCents: party ? award.comparableTotalCents : null,
    currency: award.currency,
    rationale: party ? award.rationale : null,
  };
}

/** The job board: every posting this organization may see, newest first. */
export async function listPostings(db: Db, actor: MarketplaceActor, args: { mineOnly?: boolean; states?: PostingState[] }, now = new Date()) {
  const invited = await db.select({ postingId: marketplaceInvitations.postingId }).from(marketplaceInvitations).where(eq(marketplaceInvitations.invitedOrgRef, actor.orgRef));
  const invitedIds = invited.map(i => i.postingId);
  const visible = args.mineOnly
    ? eq(marketplacePostings.clientOrgRef, actor.orgRef)
    : or(
        eq(marketplacePostings.clientOrgRef, actor.orgRef),
        and(eq(marketplacePostings.distribution, "public"), inArray(marketplacePostings.state, POSTED_STATES)),
        ...(invitedIds.length ? [and(inArray(marketplacePostings.id, invitedIds), inArray(marketplacePostings.state, POSTED_STATES))] : []),
      );
  const rows = await db.select().from(marketplacePostings).where(args.states?.length ? and(visible, inArray(marketplacePostings.state, args.states)) : visible).orderBy(desc(marketplacePostings.createdAt));
  return rows.map(r => presentPosting(r, actor.orgRef, now));
}

/** Everything but draft: a posting is visible to others only once published. */
const POSTED_STATES: PostingState[] = ["published", "bidding", "bidding_closed", "awarded", "contracted", "dispatched", "active", "completed", "closed", "cancelled"];

function presentRevision(rev: MarketplaceBidRevisionRow, pricingVisible: boolean) {
  const content = parseContent(rev.contentJson);
  const readiness = JSON.parse(rev.readinessJson) as BidReadiness;
  const priced = {
    pricingType: rev.pricingType,
    currency: rev.currency,
    fixedTotalCents: content.fixedTotalCents,
    components: content.components,
    comparableTotalCents: rev.comparableTotalCents,
    comparableBasis: rev.comparableBasis,
  };
  return {
    revisionRef: rev.revisionRef,
    revisionNumber: rev.revisionNumber,
    contentHash: rev.contentHash,
    submittedAt: rev.submittedAt,
    readiness,
    unitsOffered: content.unitsOffered,
    availableFrom: content.availableFrom,
    qualifications: content.qualifications,
    exclusions: content.exclusions,
    attachments: content.attachments,
    notes: content.notes,
    // Withheld, not blanked: the shape says WHY there is no price here.
    pricing: pricingVisible ? { visible: true as const, ...priced } : { visible: false as const, reason: "sealed until bidding closes" },
  };
}

/** The client's comparison table. Pricing withheld per the sealed rule; readiness always shown. */
export async function bidsForPosting(db: Db, actor: MarketplaceActor, args: { postingRef: string }, now = new Date()) {
  const posting = await visiblePosting(db, args.postingRef, actor.orgRef);
  if (posting.clientOrgRef !== actor.orgRef) throw forbidden("Only the client organization may list the bids on its posting.");
  const heads = await db.select().from(marketplaceBids).where(eq(marketplaceBids.postingId, posting.id)).orderBy(asc(marketplaceBids.createdAt));
  const ids = heads.flatMap(h => (h.currentRevisionId ? [h.currentRevisionId] : []));
  const revisions = ids.length ? await db.select().from(marketplaceBidRevisions).where(inArray(marketplaceBidRevisions.id, ids)) : [];
  const byId = new Map(revisions.map(r => [r.id, r]));
  return heads
    .filter(h => h.state !== "draft")
    .map(h => {
      const rev = h.currentRevisionId ? byId.get(h.currentRevisionId) ?? null : null;
      const vis = mayViewBidPricing({ viewerOrgRef: actor.orgRef, clientOrgRef: posting.clientOrgRef, bidderOrgRef: h.bidderOrgRef, visibility: posting.visibility, postingState: posting.state });
      return {
        bidRef: h.bidRef,
        bidderOrgRef: h.bidderOrgRef,
        state: h.state,
        revisionCount: h.revisionCount,
        submittedAt: h.submittedAt,
        withdrawnAt: h.withdrawnAt,
        current: rev ? presentRevision(rev, vis.visible) : null,
        pricingWithheld: vis.visible ? null : vis.reason,
      };
    })
    .sort((a, b) => Number(bidIsLive(b.state)) - Number(bidIsLive(a.state)));
}

/** The bidder's own bids, every revision included; its own pricing is always visible to it. */
export async function myBids(db: Db, actor: MarketplaceActor, args: { postingRef?: string }) {
  const heads = args.postingRef
    ? await db.select({ bid: marketplaceBids }).from(marketplaceBids).innerJoin(marketplacePostings, eq(marketplacePostings.id, marketplaceBids.postingId)).where(and(eq(marketplaceBids.bidderOrgRef, actor.orgRef), eq(marketplacePostings.postingRef, args.postingRef))).then(r => r.map(x => x.bid))
    : await db.select().from(marketplaceBids).where(eq(marketplaceBids.bidderOrgRef, actor.orgRef)).orderBy(desc(marketplaceBids.createdAt));
  const out = [];
  for (const h of heads) {
    const revisions = await db.select().from(marketplaceBidRevisions).where(eq(marketplaceBidRevisions.bidId, h.id)).orderBy(asc(marketplaceBidRevisions.revisionNumber));
    const [posting] = await db.select({ postingRef: marketplacePostings.postingRef, title: marketplacePostings.title, state: marketplacePostings.state }).from(marketplacePostings).where(eq(marketplacePostings.id, h.postingId)).limit(1);
    out.push({
      bidRef: h.bidRef,
      posting,
      state: h.state,
      version: h.version,
      draft: h.draftContentJson ? parseContent(h.draftContentJson) : null,
      revisions: revisions.map(r => presentRevision(r, true)),
    });
  }
  return out;
}

/** The tender's audit trail. The client reads all of it; a bidder reads the posting's events and its own bid's. */
export async function postingEvents(db: Db, actor: MarketplaceActor, args: { postingRef: string }) {
  const posting = await visiblePosting(db, args.postingRef, actor.orgRef);
  const events = await db.select().from(marketplaceEvents).where(eq(marketplaceEvents.postingId, posting.id)).orderBy(asc(marketplaceEvents.occurredAt), asc(marketplaceEvents.id));
  if (posting.clientOrgRef === actor.orgRef) return events;
  const mine = await db.select({ id: marketplaceBids.id }).from(marketplaceBids).where(and(eq(marketplaceBids.postingId, posting.id), eq(marketplaceBids.bidderOrgRef, actor.orgRef)));
  const myBidIds = new Set(mine.map(m => m.id));
  return events.filter(e => e.bidId == null || myBidIds.has(e.bidId)).map(e => (e.bidId == null && e.eventType === "invitation_sent" ? { ...e, detailJson: null } : e));
}
