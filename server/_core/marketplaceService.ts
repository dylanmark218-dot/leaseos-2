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
  commercialJobChains,
  contractorBusinessProfiles,
  dispatchPostings,
  domainEventOutbox,
  jobs,
  marketplaceAwards,
  marketplaceBidRevisions,
  marketplaceBids,
  marketplaceClarifications,
  marketplaceCompanyProfiles,
  marketplaceContracts,
  marketplaceEvents,
  marketplaceFollows,
  marketplacePreferredContractors,
  marketplaceInvitations,
  marketplacePostings,
  marketplaceReadinessEvaluations,
  organizations,
  workflowNotifications,
  type MarketplaceAwardRow,
  type MarketplaceClarificationRow,
  type MarketplaceContractRow,
  type MarketplaceBidRevisionRow,
  type MarketplaceBidRow,
  type MarketplacePostingRow,
} from "../../drizzle/schema";
import type { Db, DbOrTx, Tx } from "./dbTypes";
import { buildOutboxRow } from "./eventEmitter";
import { nextSequence, pad2 } from "./commercialChainNumbers";
import { createPosting as createDispatchPosting } from "../dispatchRoleService";
import { gatherReadinessFacts } from "./marketplaceReadinessFacts";
import {
  EMPTY_TENDER_REQUIREMENTS,
  clientReadinessProjection,
  evaluateMarketplaceReadiness,
  normalizeTenderRequirements,
  type MarketplaceReadiness,
  type ReadinessStage,
  type TenderRequirements,
} from "./marketplaceReadiness";
import {
  bidContentHash,
  bidIsLive,
  biddingWindow,
  clarificationVisibility,
  followMatchKey,
  followMatches,
  comparableTotalCents,
  makeRef,
  mayViewBidPricing,
  openBidRange,
  postingAcceptsInvitations,
  postingAcceptsQuestions,
  postingIsEditable,
  transitionBid,
  transitionPosting,
  validateBidContent,
  type BidContent,
  type BidState,
  type PostingDistribution,
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

/* ===================== notifications: the existing inbox, not a new engine ===================== */

/** The roles that hold `marketplace.read`; a notification to an organization is a row for each. */
const MARKETPLACE_INBOX_ROLES = ["dispatcher", "office", "management"] as const;

/**
 * Tells an organization something through `workflowNotifications`, which the
 * universal inbox already reads by tenant and role. Idempotent on `key`, so a
 * retried transaction cannot tell a company twice. Same transaction as the
 * domain write: a notification about a state that rolled back never exists.
 */
async function notifyOrganization(tx: Tx, n: { orgRef: string; key: string; title: string; body: string; deepLink: string }, now: Date): Promise<void> {
  for (const role of MARKETPLACE_INBOX_ROLES) {
    const notificationKey = `${n.key}:${role}`.slice(0, 200);
    await tx.insert(workflowNotifications).values({
      notificationKey,
      tenantId: n.orgRef,
      recipientRole: role,
      title: n.title.slice(0, 220),
      body: n.body,
      deepLink: n.deepLink.slice(0, 300),
      channel: "in_app",
      status: "queued",
      queuedAt: now,
    }).onDuplicateKeyUpdate({ set: { notificationKey } });
  }
}

const postingLink = (postingRef: string) => `/marketplace/postings/${postingRef}`;

/** Every organization with a stake in a posting's clarifications: anyone who has started a bid, and every invitee. */
async function interestedOrganizations(tx: Tx, postingId: number, except: string): Promise<string[]> {
  const bidders = await tx.select({ orgRef: marketplaceBids.bidderOrgRef }).from(marketplaceBids).where(eq(marketplaceBids.postingId, postingId));
  const invitees = await tx.select({ orgRef: marketplaceInvitations.invitedOrgRef }).from(marketplaceInvitations).where(and(eq(marketplaceInvitations.postingId, postingId), eq(marketplaceInvitations.status, "sent")));
  return Array.from(new Set([...bidders, ...invitees].map(x => x.orgRef))).filter(o => o !== except);
}

/* ===================== helpers ===================== */

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found.` });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const refused = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });

/** A refused submission carries the picture, so the bidder gets the reasons in one answer rather than a sentence. */
export class SubmissionBlocked extends TRPCError {
  constructor(message: string, public readonly readiness: MarketplaceReadiness) {
    super({ code: "PRECONDITION_FAILED", message });
  }
}

function parseRequirements(json: string): TenderRequirements {
  try {
    return normalizeTenderRequirements(JSON.parse(json));
  } catch {
    return EMPTY_TENDER_REQUIREMENTS;
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
  /** Typed tender requirements (`TenderRequirements`); checkpoint-1 keys are still read and mapped. */
  requirements?: Record<string, unknown>;
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
    requirementsJson: JSON.stringify(normalizeTenderRequirements(d.requirements ?? {})),
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

/**
 * Opening bidding is the moment the opportunity feed fires: every organization
 * whose follow matches a PUBLIC posting is told, once, in the same transaction.
 */
export const openBidding = (db: Db, actor: MarketplaceActor, args: PostingTransitionArgs, now = new Date()) =>
  db.transaction(async tx => {
    const r = await transitionLocked(tx, actor, args, "open_bidding", { biddingOpenedAt: now }, () => null, now);
    const p = r.posting;
    const follows = p.distribution === "public" ? await tx.select().from(marketplaceFollows) : [];
    const matched = Array.from(new Set(follows.filter(f => followMatches(f, p)).map(f => f.orgRef)));
    for (const orgRef of matched) {
      await notifyOrganization(tx, {
        orgRef, key: `MKT:${p.postingRef}:open:${orgRef}`,
        title: `Work matching what you follow: ${p.title}`,
        body: `${p.workType}${p.operatingArea ? ` · ${p.operatingArea}` : ""}${p.biddingClosesAt ? ` · bids close ${p.biddingClosesAt.toISOString()}` : ""}`,
        deepLink: postingLink(p.postingRef),
      }, now);
    }
    if (matched.length) await record(tx, actor, { postingId: p.id, eventType: "followers_notified", detail: { organizations: matched.length } }, now);
    return { ...transitionResult(r), notifiedOrganizations: matched.length };
  });

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
    await notifyOrganization(tx, { orgRef: args.invitedOrgRef, key: `MKT:${posting.postingRef}:invite:${args.invitedOrgRef}`, title: `Invited to tender: ${posting.title}`, body: `${posting.clientOrgRef} invited your organization to bid.${posting.biddingClosesAt ? ` Bids close ${posting.biddingClosesAt.toISOString()}.` : ""}`, deepLink: postingLink(posting.postingRef) }, now);
    return { invitationRef, status: "sent" as const, alreadyInvited: false as const };
  });
}

/* ===================== bids ===================== */

/**
 * The verified picture: facts from the canonical registries, the evaluator's verdict. Private
 * credential fields never reach this function — the loader reduces holdings to code, state and
 * expiry, and the evaluator reduces those to counts.
 */
async function readinessFor(db: DbOrTx, posting: MarketplacePostingRow, bidderOrgRef: string, unitsOffered: number | null, now: Date, stage: ReadinessStage): Promise<MarketplaceReadiness> {
  return evaluateMarketplaceReadiness(await gatherReadinessFacts(db, { posting, bidderOrgRef, unitsOffered, stage }, now), now);
}

/**
 * A refusal must outlive the transaction that refused. Throwing inside `db.transaction` rolls the
 * evaluation row and the trail event back with everything else, so a refusing transaction COMMITS
 * its record and returns this marker; the caller throws after the commit.
 */
type Refusal = { refused: true; readiness: MarketplaceReadiness; message: string };
const isRefusal = (v: unknown): v is Refusal => typeof v === "object" && v !== null && (v as Refusal).refused === true;

/** Records an evaluation that decided something, beside the bid it decided. */
async function recordEvaluation(tx: Tx, args: { postingId: number; bidId: number | null; bidRevisionId: number | null; bidderOrgRef: string; purpose: "submission" | "submission_refused" | "award" | "award_refused"; readiness: MarketplaceReadiness; actorUserId: number }) {
  const evaluationRef = makeRef("MRE");
  await tx.insert(marketplaceReadinessEvaluations).values({
    evaluationRef, postingId: args.postingId, bidId: args.bidId, bidRevisionId: args.bidRevisionId, bidderOrgRef: args.bidderOrgRef,
    purpose: args.purpose, verdict: args.readiness.verdict, dependencyFingerprint: args.readiness.dependencyFingerprint,
    readinessJson: JSON.stringify(args.readiness), evaluatedByUserId: args.actorUserId, evaluatedAt: args.readiness.evaluatedAt,
  });
  return evaluationRef;
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

/**
 * The bidder's own verified picture, for a posting it can see, before it commits to anything.
 * Reads only; evaluates the ACTING organization and nobody else — there is no input that names
 * an organization, so one company cannot read another's picture through this door.
 */
export async function previewReadiness(db: Db, actor: MarketplaceActor, args: { postingRef: string; content?: BidContent | null }, now = new Date()): Promise<MarketplaceReadiness> {
  const posting = await visiblePosting(db, args.postingRef, actor.orgRef);
  if (args.content) {
    const v = validateBidContent(args.content);
    if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join(" ") });
  }
  return readinessFor(db, posting, actor.orgRef, args.content?.unitsOffered ?? null, now, "submission");
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
  const outcome = await db.transaction(async tx => {
    const { head, posting } = await lockBidUnderPosting(tx, args.bidRef, actor);
    assertVersion(args.expectedVersion, head.version);
    const to = advanceBid(head, "submit");
    if (!head.draftContentJson) throw refused("There is no draft to submit.");
    const content = parseContent(head.draftContentJson);
    const v = validateBidContent(content);
    if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join(" ") });
    const readiness = await readinessFor(tx, posting, actor.orgRef, content.unitsOffered, now, "submission");
    if (readiness.verdict !== "submittable") {
      // The refusal is recorded — the evaluation row and the trail event — and COMMITTED, so "we
      // tried to submit and were blocked" is a fact the bidder and an auditor can both read.
      const refusedRef = await recordEvaluation(tx, { postingId: posting.id, bidId: head.id, bidRevisionId: null, bidderOrgRef: actor.orgRef, purpose: "submission_refused", readiness, actorUserId: actor.userId });
      await record(tx, actor, { postingId: posting.id, bidId: head.id, eventType: "bid_submission_refused", previousState: head.state, newState: head.state, detail: { evaluationRef: refusedRef, blockers: readiness.blockers.map(b => b.check), dependencyFingerprint: readiness.dependencyFingerprint } }, now);
      const why = readiness.blockers.map(b => `${b.check} [${b.result}]: ${b.detail}`);
      return { refused: true, readiness, message: `Not eligible to submit — ${why.join(" | ")}` } as Refusal;
    }
    const revisionNumber = head.revisionCount + 1;
    const revisionRef = makeRef("REV");
    const hash = bidContentHash(content);
    const cmp = comparableTotalCents(content);
    await tx.insert(marketplaceBidRevisions).values({
      revisionRef, bidId: head.id, postingId: posting.id, bidderOrgRef: actor.orgRef, revisionNumber,
      contentJson: head.draftContentJson, contentHash: hash, pricingType: content.pricingType, currency: content.currency,
      comparableTotalCents: cmp.totalCents, comparableBasis: cmp.basis,
      readinessJson: JSON.stringify(readiness), readinessVerdict: readiness.verdict, readinessFingerprint: readiness.dependencyFingerprint,
      submittedByUserId: actor.userId, submittedAt: now,
    });
    const [rev] = await tx.select({ id: marketplaceBidRevisions.id }).from(marketplaceBidRevisions).where(eq(marketplaceBidRevisions.revisionRef, revisionRef)).limit(1);
    await recordEvaluation(tx, { postingId: posting.id, bidId: head.id, bidRevisionId: rev!.id, bidderOrgRef: actor.orgRef, purpose: "submission", readiness, actorUserId: actor.userId });
    await tx.update(marketplaceBids).set({ state: to, currentRevisionId: rev!.id, revisionCount: revisionNumber, draftContentJson: null, submittedAt: now, withdrawnAt: null, version: head.version + 1 }).where(eq(marketplaceBids.id, head.id));
    await record(tx, actor, { postingId: posting.id, bidId: head.id, bidRevisionId: rev!.id, eventType: "bid_submitted", previousState: head.state, newState: to, detail: { revisionNumber, contentHash: hash, readinessVerdict: readiness.verdict, readinessFingerprint: readiness.dependencyFingerprint } }, now);
    return { bidRef: head.bidRef, revisionRef, revisionNumber, contentHash: hash, state: to, version: head.version + 1, readiness };
  });
  if (isRefusal(outcome)) throw new SubmissionBlocked(outcome.message, outcome.readiness);
  return outcome;
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
  const outcome = await db.transaction(async tx => {
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
    // Readiness NOW, not readiness at submission: a certificate that lapsed since is a refusal here,
    // recorded as one. The submission's own picture on the revision is untouched. The client's
    // refusal names checks and results — never the bidder's private detail.
    const current = await readinessFor(tx, posting, head.bidderOrgRef, parseContent(rev.contentJson).unitsOffered, now, "standing");
    if (current.verdict !== "submittable") {
      const evaluationRef = await recordEvaluation(tx, { postingId: posting.id, bidId: head.id, bidRevisionId: rev.id, bidderOrgRef: head.bidderOrgRef, purpose: "award_refused", readiness: current, actorUserId: actor.userId });
      await record(tx, actor, { postingId: posting.id, bidId: head.id, bidRevisionId: rev.id, eventType: "award_refused_readiness", previousState: posting.state, newState: posting.state, detail: { evaluationRef, blockers: current.blockers.map(b => b.check), submissionFingerprint: rev.readinessFingerprint, currentFingerprint: current.dependencyFingerprint } }, now);
      return { refused: true, readiness: current, message: `This bidder is not currently eligible: ${current.blockers.map(b => `${b.check} [${b.result}]`).join(", ")}. Its readiness changed since submission (${rev.readinessFingerprint === current.dependencyFingerprint ? "same facts, lapsed by time" : "facts changed"}); the award is refused, the bid stands as submitted.` } as Refusal;
    }

    const bidTo = advanceBid(head, "accept");
    const awardRef = makeRef("AWD");
    await recordEvaluation(tx, { postingId: posting.id, bidId: head.id, bidRevisionId: rev.id, bidderOrgRef: head.bidderOrgRef, purpose: "award", readiness: current, actorUserId: actor.userId });
    await tx.insert(marketplaceAwards).values({
      awardRef, postingId: posting.id, bidId: head.id, bidRevisionId: rev.id, clientOrgRef: posting.clientOrgRef, contractorOrgRef: head.bidderOrgRef,
      contentHash: rev.contentHash, comparableTotalCents: rev.comparableTotalCents, currency: rev.currency, rationale: args.rationale.trim(),
      readinessJson: JSON.stringify(current), awardedByUserId: actor.userId, awardedAt: now,
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

    await notifyOrganization(tx, { orgRef: head.bidderOrgRef, key: `MKT:${posting.postingRef}:award:${head.bidderOrgRef}`, title: `Awarded: ${posting.title}`, body: `Your bid (revision ${rev.revisionNumber}) was awarded by ${posting.clientOrgRef}. A contract follows.`, deepLink: postingLink(posting.postingRef) }, now);
    for (const other of others) {
      if (other.id === head.id) continue;
      await notifyOrganization(tx, { orgRef: other.bidderOrgRef, key: `MKT:${posting.postingRef}:award:${other.bidderOrgRef}`, title: `Not awarded: ${posting.title}`, body: "The client awarded this work to another bidder.", deepLink: postingLink(posting.postingRef) }, now);
    }
    await tx.update(marketplacePostings).set({ state: to, awardedAt: now, version: posting.version + 1 }).where(eq(marketplacePostings.id, posting.id));
    await record(tx, actor, { postingId: posting.id, awardId: award!.id, bidId: head.id, bidRevisionId: rev.id, eventType: "posting_awarded", previousState: posting.state, newState: to, detail: { contractorOrgRef: head.bidderOrgRef, contentHash: rev.contentHash, rejectedBids: others.length - 1 } }, now);
    return { awardRef, postingRef: posting.postingRef, bidRef: head.bidRef, contractorOrgRef: head.bidderOrgRef, contentHash: rev.contentHash, state: to, version: posting.version + 1 };
  });
  if (isRefusal(outcome)) throw refused(outcome.message);
  return outcome;
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

/** The picture as stored (0236 shape), or the checkpoint-1 declared picture on an older revision. */
function storedReadiness(json: string): MarketplaceReadiness | { legacy: true; declaredOnly: unknown } {
  const v = JSON.parse(json) as Partial<MarketplaceReadiness> & { rows?: unknown };
  if (v && v.basis === "canonical_registries" && Array.isArray(v.checks)) return { ...(v as MarketplaceReadiness), evaluatedAt: new Date(v.evaluatedAt as unknown as string) };
  return { legacy: true, declaredOnly: v };
}

/** `own`: the bidder reads its own full picture; the client reads the projection. */
function presentRevision(rev: MarketplaceBidRevisionRow, pricingVisible: boolean, own: boolean) {
  const content = parseContent(rev.contentJson);
  const stored = storedReadiness(rev.readinessJson);
  const submissionReadiness = "legacy" in stored ? { legacy: true as const } : own ? stored : clientReadinessProjection(stored);
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
    submissionReadiness,
    readinessFingerprint: rev.readinessFingerprint,
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
  const out = [];
  for (const h of heads.filter(x => x.state !== "draft")) {
    const rev = h.currentRevisionId ? byId.get(h.currentRevisionId) ?? null : null;
    const vis = mayViewBidPricing({ viewerOrgRef: actor.orgRef, clientOrgRef: posting.clientOrgRef, bidderOrgRef: h.bidderOrgRef, visibility: posting.visibility, postingState: posting.state });
    // Readiness NOW for a standing bid, as the client's projection: eligibility, check names and
    // results, counts. The submission's own picture stays on the revision. Nothing private.
    const live = rev && bidIsLive(h.state) ? await readinessFor(db, posting, h.bidderOrgRef, parseContent(rev.contentJson).unitsOffered, now, "standing") : null;
    out.push({
      bidRef: h.bidRef,
      bidderOrgRef: h.bidderOrgRef,
      state: h.state,
      revisionCount: h.revisionCount,
      submittedAt: h.submittedAt,
      withdrawnAt: h.withdrawnAt,
      current: rev ? presentRevision(rev, vis.visible, false) : null,
      currentReadiness: live ? clientReadinessProjection(live) : null,
      readinessChangedSinceSubmission: live && rev ? live.dependencyFingerprint !== rev.readinessFingerprint : null,
      pricingWithheld: vis.visible ? null : vis.reason,
    });
  }
  return out.sort((a, b) => Number(bidIsLive(b.state)) - Number(bidIsLive(a.state)));
}

/** The bidder's own bids, every revision included; its own pricing is always visible to it. */
export async function myBids(db: Db, actor: MarketplaceActor, args: { postingRef?: string }, now = new Date()) {
  const heads = args.postingRef
    ? await db.select({ bid: marketplaceBids }).from(marketplaceBids).innerJoin(marketplacePostings, eq(marketplacePostings.id, marketplaceBids.postingId)).where(and(eq(marketplaceBids.bidderOrgRef, actor.orgRef), eq(marketplacePostings.postingRef, args.postingRef))).then(r => r.map(x => x.bid))
    : await db.select().from(marketplaceBids).where(eq(marketplaceBids.bidderOrgRef, actor.orgRef)).orderBy(desc(marketplaceBids.createdAt));
  const out = [];
  for (const h of heads) {
    const revisions = await db.select().from(marketplaceBidRevisions).where(eq(marketplaceBidRevisions.bidId, h.id)).orderBy(asc(marketplaceBidRevisions.revisionNumber));
    const [postingRow] = await db.select().from(marketplacePostings).where(eq(marketplacePostings.id, h.postingId)).limit(1);
    const current = revisions.find(r => r.id === h.currentRevisionId) ?? null;
    // The bidder's own picture now, full detail, beside the immutable one on each revision.
    const live = postingRow && bidIsLive(h.state) && current ? await readinessFor(db, postingRow, actor.orgRef, parseContent(current.contentJson).unitsOffered, now, "standing") : null;
    out.push({
      bidRef: h.bidRef,
      posting: postingRow ? { postingRef: postingRow.postingRef, title: postingRow.title, state: postingRow.state } : null,
      state: h.state,
      version: h.version,
      draft: h.draftContentJson ? parseContent(h.draftContentJson) : null,
      revisions: revisions.map(r => presentRevision(r, true, true)),
      currentReadiness: live,
      readinessChangedSinceSubmission: live && current ? live.dependencyFingerprint !== current.readinessFingerprint : null,
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

/* ===================== the award → dispatch bridge (0234) ===================== */

/** The legacy job's `mode`, read from the work type the client chose. Nothing downstream is decided by this alone. */
export function jobModeForWorkType(workType: string): "general" | "hydrovac" | "recovery" | "transport" {
  const w = workType.toUpperCase();
  if (w.includes("HYDROVAC")) return "hydrovac";
  if (w.includes("RECOVERY") || w.includes("TOW")) return "recovery";
  if (/HAUL|TRANSPORT|FLUID|WATER|GRAVEL|HOTSHOT|VAC|HEAVY/.test(w)) return "transport";
  return "general";
}

/**
 * The client issues the contract. In ONE transaction: the posting advances
 * awarded → contracted, the award to `contracted`, the job is created — owned
 * by the CONTRACTOR organization with the client as its customer, so the
 * contractor's own dispatch, tickets and billing run on it — and the commercial
 * chain is numbered by the same allocator contractor-office chains use. The
 * contract row ties them together and carries the award's content hash.
 */
export async function issueContract(db: Db, actor: MarketplaceActor, args: PostingTransitionArgs, now = new Date()) {
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    assertClient(posting, actor);
    assertVersion(args.expectedVersion, posting.version);
    const to = advancePosting(posting, "contract");
    const [award] = await tx.select().from(marketplaceAwards).where(eq(marketplaceAwards.postingId, posting.id)).for("update").limit(1);
    if (!award || award.state !== "awarded") throw refused(award ? `The award is ${award.state}; only a standing award can be contracted.` : "This posting carries no award to contract.");
    const [existing] = await tx.select({ contractRef: marketplaceContracts.contractRef }).from(marketplaceContracts).where(eq(marketplaceContracts.postingId, posting.id)).limit(1);
    if (existing) throw conflict(`This posting already carries contract ${existing.contractRef}.`);
    const [client] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.orgRef, posting.clientOrgRef)).limit(1);

    const jobCode = makeRef("JOB");
    await tx.insert(jobs).values({
      orgRef: award.contractorOrgRef,
      customerOrgRef: posting.clientOrgRef,
      jobCode,
      type: posting.workType,
      mode: jobModeForWorkType(posting.workType),
      customer: (client?.name ?? posting.clientOrgRef).slice(0, 160),
      location: (posting.pickupLocation ?? posting.pickupLsd ?? posting.operatingArea ?? posting.title).slice(0, 220),
      latitude: posting.pickupLat,
      longitude: posting.pickupLng,
      status: "dispatched",
      progress: 0,
    });
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.jobCode, jobCode)).limit(1);
    if (!job) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Job creation failed." });

    const chainRef = makeRef("CHN");
    const chainNumber = `${jobCode}-C${pad2(await nextSequence(tx, `CONTRACT:${job.id}`))}`;
    await tx.insert(commercialJobChains).values({
      chainRef, chainNumber, rootJobId: job.id, parentChainRef: null,
      assigningOrgRef: posting.clientOrgRef, performingOrgRef: award.contractorOrgRef, customerOrgRef: posting.clientOrgRef,
      operatingCarrierOrgRef: award.contractorOrgRef, equipmentOwnerOrgRef: null,
      // The bid and the award are the two consents; the chain records the relationship they made.
      relationshipType: "INDEPENDENT_CONTRACTOR", status: "accepted", createdByUserId: actor.userId,
    });

    const contractRef = makeRef("CON");
    await tx.insert(marketplaceContracts).values({
      contractRef, awardId: award.id, postingId: posting.id, clientOrgRef: posting.clientOrgRef, contractorOrgRef: award.contractorOrgRef,
      contentHash: award.contentHash, jobId: job.id, jobCode, chainRef, chainNumber, issuedByUserId: actor.userId, issuedAt: now,
    });
    await tx.update(marketplaceAwards).set({ state: "contracted" }).where(eq(marketplaceAwards.id, award.id));
    await tx.update(marketplacePostings).set({ state: to, version: posting.version + 1 }).where(eq(marketplacePostings.id, posting.id));
    await record(tx, actor, { postingId: posting.id, awardId: award.id, bidId: award.bidId, eventType: "contract_issued", previousState: "awarded", newState: "contracted", detail: { contractRef, jobId: job.id, jobCode, chainRef, chainNumber, contractorOrgRef: award.contractorOrgRef, contentHash: award.contentHash } }, now);
    await record(tx, actor, { postingId: posting.id, eventType: "posting_contract", previousState: posting.state, newState: to, detail: { contractRef } }, now);
    return { contractRef, postingRef: posting.postingRef, state: to, version: posting.version + 1, jobId: job.id, jobCode, chainRef, chainNumber, contractorOrgRef: award.contractorOrgRef };
  });
}

/**
 * The contractor dispatches its contract: the canonical dispatch posting is
 * created through `dispatchRoleService.createPosting` — the same door a
 * dispatcher's screen uses — in the CONTRACTOR's scope, one `PRIMARY_UNIT`
 * slot per unit the posting required. That door runs its own transaction, so
 * this is two steps made safe by idempotence: a dispatch posting that already
 * exists for the contract's job is bound rather than duplicated, and a second
 * call on a dispatched contract returns what it has.
 */
export async function dispatchContract(db: Db, actor: MarketplaceActor, args: { contractRef: string }, now = new Date()) {
  const [contract] = await db.select().from(marketplaceContracts).where(eq(marketplaceContracts.contractRef, args.contractRef)).limit(1);
  // The client sees its contract; only the contractor dispatches it. A stranger sees nothing.
  if (!contract || (contract.contractorOrgRef !== actor.orgRef && contract.clientOrgRef !== actor.orgRef)) throw notFound("Contract");
  if (contract.contractorOrgRef !== actor.orgRef) throw forbidden("Only the contractor organization dispatches its contract; the client's part ended at issue.");
  if (contract.state === "dispatched" && contract.dispatchPostingId) {
    return { contractRef: contract.contractRef, dispatchPostingId: contract.dispatchPostingId, dispatchPostingNumber: contract.dispatchPostingNumber, roleIds: [] as number[], alreadyDispatched: true as const };
  }
  if (contract.state !== "issued") throw refused(`A ${contract.state} contract cannot be dispatched.`);
  const [posting] = await db.select().from(marketplacePostings).where(eq(marketplacePostings.id, contract.postingId)).limit(1);
  if (!posting) throw notFound("Posting");

  const [prior] = await db.select({ id: dispatchPostings.id, postingNumber: dispatchPostings.postingNumber }).from(dispatchPostings).where(eq(dispatchPostings.jobId, contract.jobId)).orderBy(asc(dispatchPostings.id)).limit(1);
  let created: { postingId: number; postingNumber: string; roleIds: number[] };
  if (prior) created = { postingId: prior.id, postingNumber: prior.postingNumber, roleIds: [] };
  else {
    const requirements = parseRequirements(posting.requirementsJson);
    const units = Math.max(1, posting.unitsRequired ?? 1);
    created = await createDispatchPosting({
      jobId: contract.jobId,
      distribution: "direct_assignment",
      roles: Array.from({ length: units }, (_, i) => ({
        roleCode: "PRIMARY_UNIT",
        roleLabel: `${posting.equipmentType ?? "Unit"} ${i + 1} of ${units}`,
        required: true,
        requiredEquipmentClass: requirements.equipmentClasses[0] ?? null,
      })),
      actorUserId: actor.userId,
      scope: { tenantId: actor.orgRef },
    });
  }

  return db.transaction(async tx => {
    const mp = await lockPosting(tx, posting.postingRef);
    const [locked] = await tx.select().from(marketplaceContracts).where(eq(marketplaceContracts.id, contract.id)).for("update").limit(1);
    if (!locked) throw notFound("Contract");
    if (locked.state === "dispatched" && locked.dispatchPostingId) {
      return { contractRef: locked.contractRef, dispatchPostingId: locked.dispatchPostingId, dispatchPostingNumber: locked.dispatchPostingNumber, roleIds: [] as number[], alreadyDispatched: true as const };
    }
    const to = advancePosting(mp, "dispatch");
    await tx.update(marketplaceContracts).set({ state: "dispatched", dispatchPostingId: created.postingId, dispatchPostingNumber: created.postingNumber, dispatchedByUserId: actor.userId, dispatchedAt: now }).where(eq(marketplaceContracts.id, locked.id));
    await tx.update(marketplacePostings).set({ state: to, version: mp.version + 1 }).where(eq(marketplacePostings.id, mp.id));
    await record(tx, actor, { postingId: mp.id, awardId: locked.awardId, eventType: "contract_dispatched", previousState: "issued", newState: "dispatched", detail: { contractRef: locked.contractRef, dispatchPostingId: created.postingId, dispatchPostingNumber: created.postingNumber, roleIds: created.roleIds, reusedExistingPosting: !!prior } }, now);
    await record(tx, actor, { postingId: mp.id, eventType: "posting_dispatch", previousState: mp.state, newState: to, detail: { contractRef: locked.contractRef } }, now);
    return { contractRef: locked.contractRef, dispatchPostingId: created.postingId, dispatchPostingNumber: created.postingNumber, roleIds: created.roleIds, alreadyDispatched: false as const };
  });
}

function presentContract(c: MarketplaceContractRow, viewerOrgRef: string) {
  return { ...c, isClient: c.clientOrgRef === viewerOrgRef, isContractor: c.contractorOrgRef === viewerOrgRef };
}

/** A contract, to either of its parties. */
export async function getContract(db: Db, actor: MarketplaceActor, args: { contractRef: string }) {
  const [c] = await db.select().from(marketplaceContracts).where(eq(marketplaceContracts.contractRef, args.contractRef)).limit(1);
  if (!c || (c.clientOrgRef !== actor.orgRef && c.contractorOrgRef !== actor.orgRef)) throw notFound("Contract");
  const [posting] = await db.select({ postingRef: marketplacePostings.postingRef, title: marketplacePostings.title, state: marketplacePostings.state }).from(marketplacePostings).where(eq(marketplacePostings.id, c.postingId)).limit(1);
  const [chain] = await db.select({ status: commercialJobChains.status, relationshipType: commercialJobChains.relationshipType }).from(commercialJobChains).where(eq(commercialJobChains.chainRef, c.chainRef)).limit(1);
  return { ...presentContract(c, actor.orgRef), posting: posting ?? null, chain: chain ?? null };
}

/** Every contract this organization is a party to, newest first. */
export async function contractsMine(db: Db, actor: MarketplaceActor) {
  const rows = await db.select().from(marketplaceContracts).where(or(eq(marketplaceContracts.clientOrgRef, actor.orgRef), eq(marketplaceContracts.contractorOrgRef, actor.orgRef))).orderBy(desc(marketplaceContracts.createdAt));
  return rows.map(c => presentContract(c, actor.orgRef));
}

/* ===================== the social layer (0235) ===================== */

/* ---- tender discussion ---- */

/** A bidder's question. Private to the asker and the client until published. */
export async function askQuestion(db: Db, actor: MarketplaceActor, args: { postingRef: string; question: string }, now = new Date()) {
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    if (!(await postingVisibleTo(tx, posting, actor.orgRef))) throw notFound("Posting");
    if (posting.clientOrgRef === actor.orgRef) throw refused("The client issues notices; it does not ask itself questions. Use noticeIssue.");
    if (!postingAcceptsQuestions(posting.state)) throw refused(`Questions are taken while the tender is live (posting is "${posting.state}").`);
    const clarificationRef = makeRef("CLQ");
    await tx.insert(marketplaceClarifications).values({ clarificationRef, postingId: posting.id, kind: "question", askerOrgRef: actor.orgRef, askedByUserId: actor.userId, question: args.question.trim(), askedAt: now });
    await record(tx, actor, { postingId: posting.id, eventType: "question_asked", detail: { clarificationRef, askerOrgRef: actor.orgRef } }, now);
    await notifyOrganization(tx, { orgRef: posting.clientOrgRef, key: `MKT:${posting.postingRef}:q:${clarificationRef}`, title: `Bidder question on ${posting.title}`, body: args.question.trim().slice(0, 500), deepLink: postingLink(posting.postingRef) }, now);
    return { clarificationRef, status: "open" as const };
  });
}

async function lockClarification(tx: Tx, clarificationRef: string): Promise<{ c: MarketplaceClarificationRow; posting: MarketplacePostingRow }> {
  const [peek] = await tx.select({ postingId: marketplaceClarifications.postingId }).from(marketplaceClarifications).where(eq(marketplaceClarifications.clarificationRef, clarificationRef)).limit(1);
  if (!peek) throw notFound("Clarification");
  const [posting] = await tx.select().from(marketplacePostings).where(eq(marketplacePostings.id, peek.postingId)).for("update").limit(1);
  if (!posting) throw notFound("Posting");
  const [c] = await tx.select().from(marketplaceClarifications).where(eq(marketplaceClarifications.clarificationRef, clarificationRef)).for("update").limit(1);
  if (!c) throw notFound("Clarification");
  return { c, posting };
}

/** The client's answer — write-once, private until published. */
export async function answerQuestion(db: Db, actor: MarketplaceActor, args: { clarificationRef: string; answer: string }, now = new Date()) {
  return db.transaction(async tx => {
    const { c, posting } = await lockClarification(tx, args.clarificationRef);
    assertClient(posting, actor);
    if (c.status !== "open") throw refused(`This question is ${c.status}; an answer is written once. Issue a notice to add to it.`);
    await tx.update(marketplaceClarifications).set({ answer: args.answer.trim(), answeredByUserId: actor.userId, answeredAt: now, status: "answered" }).where(eq(marketplaceClarifications.id, c.id));
    await record(tx, actor, { postingId: posting.id, eventType: "question_answered", detail: { clarificationRef: c.clarificationRef, askerOrgRef: c.askerOrgRef } }, now);
    await notifyOrganization(tx, { orgRef: c.askerOrgRef, key: `MKT:${posting.postingRef}:a:${c.clarificationRef}`, title: `Your question on ${posting.title} was answered`, body: args.answer.trim().slice(0, 500), deepLink: postingLink(posting.postingRef) }, now);
    return { clarificationRef: c.clarificationRef, status: "answered" as const };
  });
}

/**
 * Publishing makes the question and its answer one clarification for every
 * bidder, asker withheld, and tells every interested organization. This is
 * the tender's fairness mechanism: nobody is quietly told more than the rest.
 */
export async function publishClarification(db: Db, actor: MarketplaceActor, args: { clarificationRef: string }, now = new Date()) {
  return db.transaction(async tx => {
    const { c, posting } = await lockClarification(tx, args.clarificationRef);
    assertClient(posting, actor);
    if (c.status !== "answered") throw refused(c.status === "published" ? "Already published." : "Answer the question before publishing it.");
    await tx.update(marketplaceClarifications).set({ visibility: "public", status: "published", publishedAt: now, publishedByUserId: actor.userId }).where(eq(marketplaceClarifications.id, c.id));
    const orgs = await interestedOrganizations(tx, posting.id, posting.clientOrgRef);
    for (const orgRef of orgs) {
      await notifyOrganization(tx, { orgRef, key: `MKT:${posting.postingRef}:pub:${c.clarificationRef}:${orgRef}`, title: `Clarification on ${posting.title}`, body: `Q: ${c.question.slice(0, 240)}\nA: ${(c.answer ?? "").slice(0, 240)}`, deepLink: postingLink(posting.postingRef) }, now);
    }
    await record(tx, actor, { postingId: posting.id, eventType: "clarification_published", detail: { clarificationRef: c.clarificationRef, notifiedOrganizations: orgs.length } }, now);
    return { clarificationRef: c.clarificationRef, status: "published" as const, notifiedOrganizations: orgs.length };
  });
}

/** A client's clarification with no question behind it: a correction, a road-ban update, a changed detail. Public from birth. */
export async function issueNotice(db: Db, actor: MarketplaceActor, args: { postingRef: string; notice: string }, now = new Date()) {
  return db.transaction(async tx => {
    const posting = await lockPosting(tx, args.postingRef);
    assertClient(posting, actor);
    if (!postingAcceptsQuestions(posting.state)) throw refused(`Notices are issued while the tender is live (posting is "${posting.state}").`);
    const clarificationRef = makeRef("CLN");
    await tx.insert(marketplaceClarifications).values({ clarificationRef, postingId: posting.id, kind: "notice", askerOrgRef: posting.clientOrgRef, askedByUserId: actor.userId, question: args.notice.trim(), askedAt: now, visibility: "public", status: "published", publishedAt: now, publishedByUserId: actor.userId });
    const orgs = await interestedOrganizations(tx, posting.id, posting.clientOrgRef);
    for (const orgRef of orgs) {
      await notifyOrganization(tx, { orgRef, key: `MKT:${posting.postingRef}:pub:${clarificationRef}:${orgRef}`, title: `Notice on ${posting.title}`, body: args.notice.trim().slice(0, 500), deepLink: postingLink(posting.postingRef) }, now);
    }
    await record(tx, actor, { postingId: posting.id, eventType: "notice_issued", detail: { clarificationRef, notifiedOrganizations: orgs.length } }, now);
    return { clarificationRef, status: "published" as const, notifiedOrganizations: orgs.length };
  });
}

/** The discussion as the viewer may read it: the client all of it, a bidder its own and the published, asker withheld on the published. */
export async function listClarifications(db: Db, actor: MarketplaceActor, args: { postingRef: string }) {
  const posting = await visiblePosting(db, args.postingRef, actor.orgRef);
  const rows = await db.select().from(marketplaceClarifications).where(eq(marketplaceClarifications.postingId, posting.id)).orderBy(asc(marketplaceClarifications.askedAt), asc(marketplaceClarifications.id));
  const out = [];
  for (const c of rows) {
    const v = clarificationVisibility(c, { viewerOrgRef: actor.orgRef, clientOrgRef: posting.clientOrgRef });
    if (!v.visible) continue;
    out.push({
      clarificationRef: c.clarificationRef, kind: c.kind, status: c.status, visibility: c.visibility,
      askerOrgRef: v.revealAsker ? c.askerOrgRef : null,
      question: c.question, askedAt: c.askedAt, answer: c.answer, answeredAt: c.answeredAt, publishedAt: c.publishedAt,
      mine: c.askerOrgRef === actor.orgRef,
    });
  }
  return out;
}

/* ---- following: the opportunity feed ---- */

export async function followSet(db: Db, actor: MarketplaceActor, args: { workType?: string | null; operatingArea?: string | null }) {
  const workType = args.workType?.trim() || null;
  const operatingArea = args.operatingArea?.trim() || null;
  const matchKey = followMatchKey({ workType, operatingArea });
  const [existing] = await db.select().from(marketplaceFollows).where(and(eq(marketplaceFollows.orgRef, actor.orgRef), eq(marketplaceFollows.matchKey, matchKey))).limit(1);
  if (existing) return { followRef: existing.followRef, workType: existing.workType, operatingArea: existing.operatingArea, created: false as const };
  const followRef = makeRef("FLW");
  await db.insert(marketplaceFollows).values({ followRef, orgRef: actor.orgRef, workType, operatingArea, matchKey, createdByUserId: actor.userId });
  return { followRef, workType, operatingArea, created: true as const };
}

export async function followRemove(db: Db, actor: MarketplaceActor, args: { followRef: string }) {
  const [f] = await db.select().from(marketplaceFollows).where(eq(marketplaceFollows.followRef, args.followRef)).limit(1);
  if (!f || f.orgRef !== actor.orgRef) throw notFound("Follow");
  await db.delete(marketplaceFollows).where(eq(marketplaceFollows.id, f.id));
  return { removed: true as const };
}

export async function followsMine(db: Db, actor: MarketplaceActor) {
  return db.select({ followRef: marketplaceFollows.followRef, workType: marketplaceFollows.workType, operatingArea: marketplaceFollows.operatingArea, createdAt: marketplaceFollows.createdAt }).from(marketplaceFollows).where(eq(marketplaceFollows.orgRef, actor.orgRef)).orderBy(asc(marketplaceFollows.createdAt));
}

/* ---- company profiles ---- */

export type ProfileDraft = { displayName: string; description?: string | null; workTypes: string[]; operatingAreas: string[]; equipmentTypes: string[] };

export async function profileUpsert(db: Db, actor: MarketplaceActor, draft: ProfileDraft) {
  const values = { displayName: draft.displayName.trim(), description: draft.description?.trim() || null, workTypesJson: JSON.stringify(draft.workTypes), operatingAreasJson: JSON.stringify(draft.operatingAreas), equipmentTypesJson: JSON.stringify(draft.equipmentTypes), updatedByUserId: actor.userId };
  await db.insert(marketplaceCompanyProfiles).values({ orgRef: actor.orgRef, ...values }).onDuplicateKeyUpdate({ set: values });
  return { orgRef: actor.orgRef };
}

/** A company's public face, with what the system itself can say beside what the company declares. */
export async function profileGet(db: Db, _actor: MarketplaceActor, args: { orgRef: string }) {
  const [org] = await db.select({ name: organizations.name, status: organizations.status }).from(organizations).where(eq(organizations.orgRef, args.orgRef)).limit(1);
  if (!org) throw notFound("Organization");
  const [p] = await db.select().from(marketplaceCompanyProfiles).where(eq(marketplaceCompanyProfiles.orgRef, args.orgRef)).limit(1);
  const [profile] = await db.select({ status: contractorBusinessProfiles.status, operatingMode: contractorBusinessProfiles.operatingMode }).from(contractorBusinessProfiles).where(eq(contractorBusinessProfiles.orgRef, args.orgRef)).limit(1);
  const awards = await db.select({ state: marketplaceAwards.state }).from(marketplaceAwards).where(eq(marketplaceAwards.contractorOrgRef, args.orgRef));
  return {
    orgRef: args.orgRef,
    organization: org,
    declared: p ? { displayName: p.displayName, description: p.description, workTypes: JSON.parse(p.workTypesJson) as string[], operatingAreas: JSON.parse(p.operatingAreasJson) as string[], equipmentTypes: JSON.parse(p.equipmentTypesJson) as string[], updatedAt: p.updatedAt } : null,
    // What LeaseOS can state itself: these are records, not the company's description of itself.
    recorded: {
      contractorProfile: profile ?? null,
      marketplaceAwards: awards.length,
      marketplaceAwardsContracted: awards.filter(a => a.state === "contracted").length,
      // Ratings need completed work and a client's signed-off closeout; neither exists here yet, and
      // an empty number would read as a bad one.
      rating: "not_available" as const,
    },
  };
}

/* ---- preferred contractors ---- */

export async function preferredAdd(db: Db, actor: MarketplaceActor, args: { contractorOrgRef: string; note?: string | null }) {
  if (args.contractorOrgRef === actor.orgRef) throw refused("An organization cannot prefer itself.");
  const [org] = await db.select({ orgRef: organizations.orgRef }).from(organizations).where(eq(organizations.orgRef, args.contractorOrgRef)).limit(1);
  if (!org) throw notFound("Contractor organization");
  await db.insert(marketplacePreferredContractors).values({ clientOrgRef: actor.orgRef, contractorOrgRef: args.contractorOrgRef, note: args.note?.trim() || null, addedByUserId: actor.userId }).onDuplicateKeyUpdate({ set: { note: args.note?.trim() || null } });
  return { contractorOrgRef: args.contractorOrgRef };
}

export async function preferredRemove(db: Db, actor: MarketplaceActor, args: { contractorOrgRef: string }) {
  await db.delete(marketplacePreferredContractors).where(and(eq(marketplacePreferredContractors.clientOrgRef, actor.orgRef), eq(marketplacePreferredContractors.contractorOrgRef, args.contractorOrgRef)));
  return { removed: true as const };
}

export async function preferredList(db: Db, actor: MarketplaceActor) {
  return db.select({ contractorOrgRef: marketplacePreferredContractors.contractorOrgRef, note: marketplacePreferredContractors.note, createdAt: marketplacePreferredContractors.createdAt }).from(marketplacePreferredContractors).where(eq(marketplacePreferredContractors.clientOrgRef, actor.orgRef)).orderBy(asc(marketplacePreferredContractors.createdAt));
}

/** Invites the whole preferred list to a tender in one act; each invitation is its own row, event and notification. */
export async function invitePreferred(db: Db, actor: MarketplaceActor, args: { postingRef: string }, now = new Date()) {
  const preferred = await preferredList(db, actor);
  const results = [];
  for (const p of preferred) results.push({ contractorOrgRef: p.contractorOrgRef, ...(await invite(db, actor, { postingRef: args.postingRef, invitedOrgRef: p.contractorOrgRef }, now)) });
  return { invited: results.filter(r => !r.alreadyInvited).length, alreadyInvited: results.filter(r => r.alreadyInvited).length, results };
}
