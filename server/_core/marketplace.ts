/**
 * Marketplace — the commercial layer between a client organization that needs
 * work performed and the contractor organizations able to perform it.
 *
 * This module is PURE. It decides what a posting or a bid may do next, whether
 * a bid may be submitted at all, who may see a bid's price, and what a bid's
 * immutable content hashes to. It touches no database, so every rule can be
 * tested without one. The transactional service (`marketplaceService.ts`) does
 * the locking and the writes and asks this module every question of policy.
 *
 * Three things are deliberate and worth stating up front:
 *
 *  1. The client AWARDS; nothing here picks the lowest price. A readiness
 *     picture is computed beside every bid so the client can compare, and the
 *     decision stays a person's, recorded with their reason.
 *  2. A submitted bid is immutable. A change is a withdrawal followed by a new
 *     revision; v1 is never overwritten. The hash over a revision's content is
 *     what the award later binds to.
 *  3. A sealed tender's prices are invisible to the client until bidding has
 *     closed — decided here, enforced by the service's read models, never by a
 *     hidden button.
 *
 * Distinct from `dispatchPostings` / `dispatchBids` (0013), which record an
 * OPERATOR's willingness to take a shift inside one company. This is between
 * organizations; the award of a marketplace posting is what later creates the
 * canonical dispatch posting, and never the other way round.
 */

import { canonicalJson, sha256 } from "./auditPackage";

/* ===================== posting lifecycle ===================== */

export const POSTING_STATES = [
  "draft",
  "published",
  "bidding",
  "bidding_closed",
  "awarded",
  "contracted",
  "dispatched",
  "active",
  "completed",
  "closed",
  "cancelled",
] as const;
export type PostingState = (typeof POSTING_STATES)[number];

export const POSTING_EVENTS = [
  "publish",
  "open_bidding",
  "close_bidding",
  "award",
  "contract",
  "dispatch",
  "start",
  "complete",
  "close",
  "cancel",
] as const;
export type PostingEvent = (typeof POSTING_EVENTS)[number];

/**
 * The whole lifecycle, stated once. States past `awarded` are declared so the
 * machine is complete, but this checkpoint exposes no door into them: the
 * contract and dispatch transitions belong to the award → dispatch bridge.
 */
const POSTING_TRANSITIONS: Readonly<Record<PostingEvent, Readonly<Partial<Record<PostingState, PostingState>>>>> = {
  publish: { draft: "published" },
  open_bidding: { published: "bidding" },
  close_bidding: { bidding: "bidding_closed" },
  award: { bidding_closed: "awarded" },
  contract: { awarded: "contracted" },
  dispatch: { contracted: "dispatched" },
  start: { dispatched: "active" },
  complete: { active: "completed" },
  close: { completed: "closed" },
  // A posting may be cancelled up to and including the award. Once a contract
  // exists, cancelling is a commercial act with its own consequences and needs
  // its own door, not this one.
  cancel: {
    draft: "cancelled",
    published: "cancelled",
    bidding: "cancelled",
    bidding_closed: "cancelled",
    awarded: "cancelled",
  },
};

export type Transition<S extends string> =
  | { allowed: true; from: S; to: S }
  | { allowed: false; from: S; reason: string };

export function transitionPosting(from: PostingState, event: PostingEvent): Transition<PostingState> {
  const to = POSTING_TRANSITIONS[event][from];
  if (!to) return { allowed: false, from, reason: `A posting in state "${from}" cannot "${event}".` };
  return { allowed: true, from, to };
}

/** States in which the posting's structured fields may still be edited. */
export function postingIsEditable(state: PostingState): boolean {
  return state === "draft";
}

/** States from which the client may still invite organizations to tender. */
export function postingAcceptsInvitations(state: PostingState): boolean {
  return state === "draft" || state === "published" || state === "bidding";
}

/** States in which bidding has finished and the outcome may be decided. */
export function postingBiddingIsClosed(state: PostingState): boolean {
  return state === "bidding_closed";
}

/* ===================== bid lifecycle ===================== */

export const BID_STATES = ["draft", "submitted", "withdrawn", "shortlisted", "accepted", "rejected"] as const;
export type BidState = (typeof BID_STATES)[number];

export const BID_EVENTS = ["submit", "withdraw", "shortlist", "accept", "reject"] as const;
export type BidEvent = (typeof BID_EVENTS)[number];

const BID_TRANSITIONS: Readonly<Record<BidEvent, Readonly<Partial<Record<BidState, BidState>>>>> = {
  // A withdrawn bid may be submitted again — as a NEW revision. The old
  // revision stays exactly as it was.
  submit: { draft: "submitted", withdrawn: "submitted" },
  withdraw: { submitted: "withdrawn", shortlisted: "withdrawn" },
  shortlist: { submitted: "shortlisted" },
  accept: { submitted: "accepted", shortlisted: "accepted" },
  reject: { submitted: "rejected", shortlisted: "rejected" },
};

export function transitionBid(from: BidState, event: BidEvent): Transition<BidState> {
  const to = BID_TRANSITIONS[event][from];
  if (!to) return { allowed: false, from, reason: `A bid in state "${from}" cannot "${event}".` };
  return { allowed: true, from, to };
}

/** A bid that currently stands before the client. */
export function bidIsLive(state: BidState): boolean {
  return state === "submitted" || state === "shortlisted";
}

/* ===================== the bidding window ===================== */

export type BiddingWindowInput = {
  state: PostingState;
  biddingClosesAt: Date | null;
};

export type BiddingWindow =
  | { open: true; closesAt: Date | null; remainingMs: number | null }
  | { open: false; reason: "not_yet_open" | "closed_by_deadline" | "closed_by_client" | "not_bidding" };

/**
 * May a bid be submitted right now? Two clocks must both say yes: the posting
 * must be in `bidding`, AND the deadline, where one is set, must not have
 * passed. The second is the one a hidden button cannot enforce — a bid that
 * arrives at 18:00:01 against an 18:00 close is refused here, whatever the
 * row's state says, because nobody has run the close yet.
 */
export function biddingWindow(input: BiddingWindowInput, now: Date): BiddingWindow {
  if (input.state === "draft" || input.state === "published") return { open: false, reason: "not_yet_open" };
  if (input.state === "bidding_closed") return { open: false, reason: "closed_by_client" };
  if (input.state !== "bidding") return { open: false, reason: "not_bidding" };
  if (input.biddingClosesAt && now.getTime() >= input.biddingClosesAt.getTime()) {
    return { open: false, reason: "closed_by_deadline" };
  }
  return {
    open: true,
    closesAt: input.biddingClosesAt,
    remainingMs: input.biddingClosesAt ? input.biddingClosesAt.getTime() - now.getTime() : null,
  };
}

/* ===================== who may see a price ===================== */

export type PostingVisibility = "open" | "sealed";
export type PostingDistribution = "public" | "invite_only";

export type PricingViewer = {
  viewerOrgRef: string;
  clientOrgRef: string;
  bidderOrgRef: string;
  visibility: PostingVisibility;
  postingState: PostingState;
};

export type PricingVisibility = { visible: true } | { visible: false; reason: string };

/**
 * The sealed-tender rule, in one place.
 *
 *  - A bidder always sees its own price.
 *  - The client sees prices on an OPEN posting at any time, and on a SEALED
 *    posting only once bidding has closed.
 *  - Any other organization never sees another organization's price. (An open
 *    posting may publish a range — see `openBidRange` — which is an aggregate,
 *    not a bid.)
 */
export function mayViewBidPricing(v: PricingViewer): PricingVisibility {
  if (v.viewerOrgRef === v.bidderOrgRef) return { visible: true };
  if (v.viewerOrgRef !== v.clientOrgRef) {
    return { visible: false, reason: "Only the bidder and the client may see a bid's pricing." };
  }
  if (v.visibility === "open") return { visible: true };
  const closed = SEALED_PRICING_OPENS_AT.has(v.postingState);
  if (closed) return { visible: true };
  return {
    visible: false,
    reason: `This is a sealed tender: pricing is withheld from the client until bidding closes (posting is "${v.postingState}").`,
  };
}

/** The states from which a sealed tender's pricing is readable by the client. */
const SEALED_PRICING_OPENS_AT: ReadonlySet<PostingState> = new Set<PostingState>([
  "bidding_closed",
  "awarded",
  "contracted",
  "dispatched",
  "active",
  "completed",
  "closed",
  "cancelled",
]);

/**
 * What an OPEN posting may show other bidders: the count and the range of the
 * live bids' comparable totals, never a bidder's name or a single price. Bids
 * with no comparable total (unit-rate bids without an estimated quantity) are
 * counted and excluded from the range, and the answer says how many.
 */
export function openBidRange(bids: Array<{ state: BidState; comparableTotalCents: number | null }>): {
  liveBids: number;
  withTotal: number;
  lowestCents: number | null;
  highestCents: number | null;
} {
  const live = bids.filter(b => bidIsLive(b.state));
  const totals = live.flatMap(b => (b.comparableTotalCents == null ? [] : [b.comparableTotalCents]));
  return {
    liveBids: live.length,
    withTotal: totals.length,
    lowestCents: totals.length ? Math.min(...totals) : null,
    highestCents: totals.length ? Math.max(...totals) : null,
  };
}

/* ===================== bid content: pricing, hash ===================== */

export const PRICING_TYPES = ["fixed_price", "unit_rate", "hourly", "combination"] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

export const PRICING_UNITS = ["HOUR", "KM", "LOAD", "M3", "TONNE", "DAY", "EACH", "LUMP_SUM"] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

/**
 * One priced line of a bid. Money is integer cents; quantities are thousandths
 * (`quantityMillis`), the same scale `contractorPayables.quantityMillis` uses.
 * `estimatedQuantityMillis` is the bidder's estimate and nothing more — it
 * exists so a unit-rate bid can be COMPARED, not so it can be billed.
 */
export type PricingComponent = {
  code: string;
  label: string;
  unit: PricingUnit;
  rateCents: number;
  estimatedQuantityMillis: number | null;
};

export type BidAttachment = { name: string; sha256: string; sizeBytes: number };

/** Everything the bidder commits to. This is what gets hashed and frozen. */
export type BidContent = {
  pricingType: PricingType;
  currency: string;
  /** Required for `fixed_price`; refused otherwise (a fixed total beside unit rates is two bids). */
  fixedTotalCents: number | null;
  components: PricingComponent[];
  exclusions: string[];
  /** What the bidder DECLARES. Declared is not verified, and the readiness rows say so. */
  qualifications: BidQualifications;
  unitsOffered: number;
  availableFrom: Date | null;
  notes: string | null;
  attachments: BidAttachment[];
};

export type BidQualifications = {
  certifications: string[];
  permits: string[];
  dangerousGoods: string[];
  insuranceLiabilityCents: number | null;
  equipmentTypes: string[];
};

export type ContentValidation = { ok: true } | { ok: false; reasons: string[] };

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

export function validateBidContent(c: BidContent): ContentValidation {
  const reasons: string[] = [];
  if (!/^[A-Z]{3}$/.test(c.currency)) reasons.push(`Currency must be a three-letter code, got "${c.currency}".`);
  if (!Number.isInteger(c.unitsOffered) || c.unitsOffered < 1) reasons.push("A bid must offer at least one unit.");
  for (const comp of c.components) {
    if (!CODE.test(comp.code)) reasons.push(`Component code "${comp.code}" must be UPPER_SNAKE, 2–40 characters.`);
    if (!Number.isInteger(comp.rateCents) || comp.rateCents < 0) reasons.push(`Component "${comp.code}" needs a non-negative integer rate in cents.`);
    if (comp.estimatedQuantityMillis != null && (!Number.isInteger(comp.estimatedQuantityMillis) || comp.estimatedQuantityMillis < 0)) {
      reasons.push(`Component "${comp.code}" estimated quantity must be a non-negative integer in thousandths.`);
    }
  }
  const codes = c.components.map(x => x.code);
  if (new Set(codes).size !== codes.length) reasons.push("Component codes must be unique within a bid.");
  switch (c.pricingType) {
    case "fixed_price":
      if (c.fixedTotalCents == null || !Number.isInteger(c.fixedTotalCents) || c.fixedTotalCents < 0) reasons.push("A fixed-price bid needs a non-negative integer total in cents.");
      if (c.components.length) reasons.push("A fixed-price bid carries no rate components; use a combination bid to price lines beside a lump sum.");
      break;
    case "unit_rate":
      if (c.fixedTotalCents != null) reasons.push("A unit-rate bid carries no fixed total.");
      if (c.components.length !== 1) reasons.push("A unit-rate bid is exactly one rate component (e.g. $485/load).");
      if (c.components[0] && (c.components[0].unit === "HOUR" || c.components[0].unit === "LUMP_SUM")) reasons.push("A unit-rate bid is priced per load, m³, tonne, km, day or each — not per hour or lump sum.");
      break;
    case "hourly":
      if (c.fixedTotalCents != null) reasons.push("An hourly bid carries no fixed total.");
      if (c.components.length !== 1 || c.components[0]!.unit !== "HOUR") reasons.push("An hourly bid is exactly one HOUR-rate component (e.g. $245/hour/unit).");
      break;
    case "combination":
      if (c.components.length < 2 && c.fixedTotalCents == null) reasons.push("A combination bid prices at least two things (hourly + mileage + disposal + standby, or a lump sum beside rates).");
      break;
  }
  const ins = c.qualifications.insuranceLiabilityCents;
  if (ins != null && (!Number.isInteger(ins) || ins < 0)) reasons.push("Declared insurance liability must be a non-negative integer in cents.");
  for (const a of c.attachments) {
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) reasons.push(`Attachment "${a.name}" needs a SHA-256 hex digest.`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * A single number the client can put beside other bids — or null, with the
 * reason, when there is none to be had. A fixed price is its total. A rated
 * bid has a comparable total only where every component carries an estimated
 * quantity; one missing quantity makes the whole total UNKNOWN rather than a
 * smaller number that looks cheaper.
 */
export function comparableTotalCents(c: BidContent): { totalCents: number | null; basis: string } {
  if (c.pricingType === "fixed_price") return { totalCents: c.fixedTotalCents, basis: "fixed total as bid" };
  let total = c.fixedTotalCents ?? 0;
  for (const comp of c.components) {
    if (comp.estimatedQuantityMillis == null) {
      return { totalCents: null, basis: `UNKNOWN — component ${comp.code} carries no estimated quantity` };
    }
    total += Math.round((comp.rateCents * comp.estimatedQuantityMillis) / 1000);
  }
  return { totalCents: total, basis: "rates × bidder's estimated quantities" + (c.fixedTotalCents != null ? " + fixed amount" : "") };
}

/**
 * SHA-256 over the canonical (sorted-key) serialization of the content. Two
 * submissions with the same content hash the same; a changed exclusion, a
 * changed rate or a replaced attachment does not. The award binds to this.
 */
export function bidContentHash(c: BidContent): string {
  return sha256(canonicalJson(c));
}

/* ===================== bid readiness ===================== */
// 0240 — the declared-only evaluator that lived here is retired. Readiness is now verified against
// the canonical registries by `marketplaceReadiness.ts` (pure) over facts `marketplaceReadinessFacts.ts`
// reads; the bid's declared qualifications stay in its content as what the bidder claims, and decide
// nothing. Tender requirements are typed there as `TenderRequirements`.

/* ===================== identifiers ===================== */

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A short, unambiguous reference: no 0/O or 1/I, so it survives a phone call. */
export function makeRef(prefix: string, random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 10; i++) out += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  return `${prefix}-${out}`;
}

/* ===================== the social layer (0239) ===================== */

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

export type FollowRule = { orgRef: string; workType: string | null; operatingArea: string | null };

/** The uniqueness key for a follow: `<workType|*>|<operatingArea|*>`, normalized. */
export function followMatchKey(f: Pick<FollowRule, "workType" | "operatingArea">): string {
  return `${norm(f.workType) || "*"}|${norm(f.operatingArea) || "*"}`;
}

/**
 * Does this follow want to hear about this posting? Both stated facets must match (a null facet
 * matches anything); an organization never hears about its own posting; and only a PUBLIC posting
 * is matched — an invite-only tender reaches its invitees by invitation and nobody by following.
 */
export function followMatches(
  follow: FollowRule,
  posting: { clientOrgRef: string; workType: string; operatingArea: string | null; distribution: PostingDistribution },
): boolean {
  if (follow.orgRef === posting.clientOrgRef) return false;
  if (posting.distribution !== "public") return false;
  if (follow.workType && norm(follow.workType) !== norm(posting.workType)) return false;
  if (follow.operatingArea && norm(follow.operatingArea) !== norm(posting.operatingArea)) return false;
  return true;
}

export type ClarificationView = {
  askerOrgRef: string;
  visibility: "private" | "public";
};

/**
 * Who reads a clarification. The client reads every one. The asker reads its own. Everyone who
 * can see the posting reads a PUBLISHED one — with the asker withheld unless the viewer is the
 * client or the asker, because a published clarification is for all bidders equally and names
 * nobody.
 */
export function clarificationVisibility(
  c: ClarificationView,
  viewer: { viewerOrgRef: string; clientOrgRef: string },
): { visible: false } | { visible: true; revealAsker: boolean } {
  const isClient = viewer.viewerOrgRef === viewer.clientOrgRef;
  const isAsker = viewer.viewerOrgRef === c.askerOrgRef;
  if (isClient || isAsker) return { visible: true, revealAsker: true };
  if (c.visibility === "public") return { visible: true, revealAsker: false };
  return { visible: false };
}

/** States in which questions may be asked and clarifications issued: while the tender is live. */
export function postingAcceptsQuestions(state: PostingState): boolean {
  return state === "published" || state === "bidding";
}
