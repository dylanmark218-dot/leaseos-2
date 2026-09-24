/**
 * v22.20 — posting a shift, and the gap between wanting it and having it.
 *
 * Pure. No network, no database.
 *
 * Composes `Person` and `Assignment` from `shiftReadiness`, approved leave from
 * `timeOff`, and rotation availability from `crewCoverage`. It re-decides none
 * of them: whether somebody holds a qualification, whether they are on leave,
 * whether they are rostered — all already answered elsewhere, and a second
 * opinion in a job-posting screen is how a person is shown as eligible for work
 * the readiness gate will refuse an hour later.
 *
 * **The rule this exists to hold.** Tapping *Interested* is a person saying
 * they would take the work. It is not an assignment, it does not reserve the
 * shift, and it does not make the eventual assignment valid. Dispatch assigns,
 * and the authoritative readiness checks run then — because eligibility
 * computed at 14:00 on Thursday says nothing about a certificate that expires
 * on Friday night.
 *
 * **Ineligible always says why.** "8 eligible" with no account of the other
 * twelve is a number nobody can act on. A named reason is the difference
 * between a filter and a planning tool: *missing H2S* is something safety can
 * fix before the shift.
 */

import { isAvailable, type CrewMember } from "./crewCoverage";
import { isAbsent, type LeaveRequest } from "./timeOff";
import type { Assignment } from "./shiftReadiness";

export type ShiftPost = {
  postRef: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  requiredRole: string;
  requiredQualifications: readonly string[];
  /** How many people the post needs. Interest beyond this is still recorded. */
  seats: number;
  /** Assigned posts are dispatch's decision; open posts invite interest first. */
  kind: "assigned" | "open";
};

export type IneligibilityCode =
  | "wrong_role" | "missing_qualification" | "on_approved_leave"
  | "not_rostered" | "overlaps_existing";

export type Ineligibility = { code: IneligibilityCode; detail: string };

export type Candidate = {
  userId: number;
  name: string;
  eligible: boolean;
  /** Empty when eligible. Never empty when not — see the module note. */
  reasons: Ineligibility[];
};

const overlaps = (a: { startsAt: Date; endsAt: Date }, b: Assignment) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * Who could take this shift, and why the rest could not.
 *
 * Every reason is collected rather than stopping at the first, because a person
 * missing two qualifications is a different planning problem from one missing
 * one.
 */
export function candidatesFor(args: {
  post: ShiftPost;
  crew: readonly CrewMember[];
  leave: readonly LeaveRequest[];
}): Candidate[] {
  return args.crew.map(member => {
    const reasons: Ineligibility[] = [];

    if (!member.roles.includes(args.post.requiredRole)) {
      reasons.push({ code: "wrong_role", detail: `Holds ${member.roles.join(", ") || "no role"}; this post needs ${args.post.requiredRole}` });
    }

    // An absent qualification is an absent qualification, whether it expired or
    // nobody ever recorded one. Unknown is not eligible.
    const missing = args.post.requiredQualifications.filter(q => !member.currentQualifications.includes(q));
    if (missing.length) {
      reasons.push({ code: "missing_qualification", detail: `No current ${missing.join(", ")}` });
    }

    if (args.leave.some(l => l.userId === member.userId && isAbsent(l) && !l.partialDay
      && l.from <= args.post.startsAt && args.post.startsAt <= l.to)) {
      reasons.push({ code: "on_approved_leave", detail: "Away on approved leave that day" });
    }

    if (!isAvailable(member, args.post.startsAt)) {
      reasons.push({ code: "not_rostered", detail: "Off-hitch on this date" });
    }

    const clash = member.existingAssignments.find(a => overlaps(args.post, a));
    if (clash) {
      reasons.push({ code: "overlaps_existing", detail: `Already on ${clash.assignmentRef} over this window` });
    }

    return { userId: member.userId, name: member.name, eligible: reasons.length === 0, reasons };
  });
}

export type PostSummary = {
  post: ShiftPost;
  eligible: Candidate[];
  ineligible: Candidate[];
  /** Why the ineligible are ineligible, counted — the actionable view. */
  barriers: { code: IneligibilityCode; count: number; detail: string }[];
  line: string;
};

export function summarize(post: ShiftPost, candidates: readonly Candidate[]): PostSummary {
  const eligible = candidates.filter(c => c.eligible);
  const ineligible = candidates.filter(c => !c.eligible);

  const counts = new Map<IneligibilityCode, { count: number; detail: string }>();
  for (const c of ineligible) {
    for (const r of c.reasons) {
      const existing = counts.get(r.code);
      counts.set(r.code, { count: (existing?.count ?? 0) + 1, detail: existing?.detail ?? r.detail });
    }
  }
  const barriers: PostSummary["barriers"] = [];
  counts.forEach((v, code) => barriers.push({ code, count: v.count, detail: v.detail }));
  barriers.sort((a, b) => b.count - a.count);

  const short = Math.max(0, post.seats - eligible.length);
  return {
    post, eligible, ineligible, barriers,
    line: short > 0
      ? `${post.postRef}: ${eligible.length} eligible for ${post.seats} seat(s) — short ${short}. Largest barrier: ${barriers[0]?.code ?? "none"} (${barriers[0]?.count ?? 0})`
      : `${post.postRef}: ${eligible.length} eligible for ${post.seats} seat(s)`,
  };
}

/* ------------------------------------------------------------------ */
/* Interest is not assignment                                           */
/* ------------------------------------------------------------------ */

export type Interest = {
  postRef: string;
  userId: number;
  expressedAt: Date;
  /** Structurally. There is no value of this field that means assigned. */
  assigns: false;
  note: string;
};

export class NotEligible extends Error {}

/**
 * Record that somebody would take the shift.
 *
 * Refuses from an ineligible person — not to be strict, but because an
 * interest list that includes people who cannot do the work is a list dispatch
 * has to re-filter by hand, which is the job this was supposed to do.
 */
export function expressInterest(args: { post: ShiftPost; candidate: Candidate; at: Date }): Interest {
  if (!args.candidate.eligible) {
    throw new NotEligible(`${args.candidate.name} cannot take ${args.post.postRef}: ${args.candidate.reasons.map(r => r.detail).join("; ")}`);
  }
  if (args.post.kind !== "open") {
    throw new NotEligible(`${args.post.postRef} is an assigned post; interest is not how it is filled`);
  }
  return {
    postRef: args.post.postRef, userId: args.candidate.userId, expressedAt: args.at,
    assigns: false,
    note: "Interest recorded. Dispatch assigns the shift, and the readiness checks run then — eligibility today says nothing about a certificate expiring tomorrow night.",
  };
}

export type AssignmentIntent = {
  postRef: string;
  userId: number;
  /** What still has to happen. This is a request to assign, not an assignment. */
  requiresReadinessCheck: true;
  basis: "dispatch_decision";
  interestExpressed: boolean;
  note: string;
};

/**
 * Dispatch chooses somebody.
 *
 * Still not an assignment: it is the input to the readiness gate that already
 * exists. Interest, where it was expressed, is recorded as context and confers
 * nothing — a person who never tapped the button can be assigned, and one who
 * did has no claim.
 */
export function intendToAssign(args: { post: ShiftPost; candidate: Candidate; interests: readonly Interest[] }): AssignmentIntent {
  if (!args.candidate.eligible) {
    throw new NotEligible(`${args.candidate.name} cannot be assigned to ${args.post.postRef}: ${args.candidate.reasons.map(r => r.detail).join("; ")}`);
  }
  return {
    postRef: args.post.postRef, userId: args.candidate.userId,
    requiresReadinessCheck: true, basis: "dispatch_decision",
    interestExpressed: args.interests.some(i => i.postRef === args.post.postRef && i.userId === args.candidate.userId),
    note: "Dispatch's decision, pending the readiness check. Interest is context and confers no claim.",
  };
}

/* ------------------------------------------------------------------ */
/* 0183 — the post's life, and the offer's                              */
/* ------------------------------------------------------------------ */

export type PostStatus = "draft" | "open" | "closed" | "filled" | "cancelled" | "expired";

/**
 * Where a post may go from where it is. Beside `POSTING_TRANSITIONS` in dispatchLifecycle and
 * tested the same way. `filled` is reached only by the award; nothing else writes it.
 */
export const POST_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ["open", "cancelled"],
  open: ["closed", "filled", "cancelled", "expired"],
  // Reopening is allowed; filling still needs an award.
  closed: ["open", "filled", "cancelled"],
  filled: [],
  cancelled: [],
  expired: [],
};

export function canTransitionPost(from: PostStatus, to: PostStatus): boolean {
  return POST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Terminal: nothing moves out of it. */
export function isTerminalPost(status: PostStatus): boolean {
  return POST_TRANSITIONS[status].length === 0;
}

/**
 * Expiry is derived on read: an open post whose `closesAt` has passed is expired whether or not a
 * mutation has persisted it yet. The persisted status catches up at the next mutation.
 */
export function effectivePostStatus(post: { status: PostStatus; closesAt: Date | null }, now: Date): PostStatus {
  if (post.status === "open" && post.closesAt && post.closesAt.getTime() <= now.getTime()) return "expired";
  return post.status;
}

/** A person's standing response to a post. One per person per post; a new one replaces it. */
export type ResponseKind = "interested" | "available" | "request_assignment" | "declined";
export const RESPONSE_KINDS: readonly ResponseKind[] = ["interested", "available", "request_assignment", "declined"];

/** Responses that put a person in the candidate pool. `declined` records the answer and removes them. */
export function responseVolunteers(kind: ResponseKind): boolean {
  return kind !== "declined";
}

export type OfferStatus = "offered" | "accepted" | "declined" | "withdrawn" | "expired" | "awarded" | "not_selected";

/**
 * The offer's life. `accepted` is a person's statement and binds nothing; `awarded` and
 * `not_selected` are written only by the award, under the posting lock.
 */
export const OFFER_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  offered: ["accepted", "declined", "withdrawn", "expired"],
  accepted: ["withdrawn", "expired", "awarded", "not_selected"],
  declined: [],
  withdrawn: [],
  expired: [],
  awarded: [],
  not_selected: [],
};

export function canTransitionOffer(from: OfferStatus, to: OfferStatus): boolean {
  return OFFER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Live: still awaiting a decision from somebody. */
export function isLiveOffer(status: OfferStatus): boolean {
  return status === "offered" || status === "accepted";
}

/** An offer past its `expiresAt` is expired on read, exactly as a post is. */
export function effectiveOfferStatus(offer: { status: OfferStatus; expiresAt: Date | null }, now: Date): OfferStatus {
  if (offer.status === "offered" && offer.expiresAt && offer.expiresAt.getTime() <= now.getTime()) return "expired";
  return offer.status;
}

/* ------------------------------------------------------------------ */
/* 0183 — availability is a declaration                                 */
/* ------------------------------------------------------------------ */

export type AvailabilityState = "available" | "unavailable" | "on_call" | "available_for_overtime";

export type AvailabilityDeclaration = {
  state: AvailabilityState;
  /** Both null = standing. A window is half-open: [starts, ends). */
  windowStartsAt: Date | null;
  windowEndsAt: Date | null;
  preferences: AvailabilityPreferences | null;
  declaredAt: Date;
};

export type AvailabilityPreferences = {
  regions: string[];
  equipmentClasses: string[];
  jobTypes: string[];
  maxDistanceKm: number | null;
  overnight: boolean | null;
  nights: boolean | null;
  weekends: boolean | null;
  overtime: boolean | null;
};

/** Whether a declaration covers an instant. A standing declaration covers every instant. */
export function declarationCovers(d: { windowStartsAt: Date | null; windowEndsAt: Date | null }, at: Date): boolean {
  if (d.windowStartsAt && d.windowStartsAt.getTime() > at.getTime()) return false;
  if (d.windowEndsAt && d.windowEndsAt.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * The declaration in force for one instant: the latest declared one that covers it. None is
 * "undeclared", which is neither available nor unavailable — a candidate pool shows it as such
 * rather than reading silence as consent.
 */
export function declaredStateAt(declarations: readonly AvailabilityDeclaration[], at: Date): AvailabilityState | "undeclared" {
  const covering = declarations.filter(d => declarationCovers(d, at));
  if (!covering.length) return "undeclared";
  covering.sort((a, b) => b.declaredAt.getTime() - a.declaredAt.getTime());
  return covering[0]!.state;
}

/**
 * Whether a declaration puts a person in the pool for a post. Overtime work needs an overtime
 * declaration or a plain `available`; `on_call` counts; `unavailable` excludes; `undeclared` is
 * reported, never treated as either.
 */
export type AvailabilityReason = { code: "declared_unavailable" | "undeclared" | "declines_overtime" | "outside_region"; detail: string };

export function availabilityReasons(args: {
  state: AvailabilityState | "undeclared";
  preferences: AvailabilityPreferences | null;
  post: { overtime: boolean; regionCode: string | null };
}): AvailabilityReason[] {
  const reasons: AvailabilityReason[] = [];
  if (args.state === "unavailable") reasons.push({ code: "declared_unavailable", detail: "Declared unavailable for this window" });
  if (args.state === "undeclared") reasons.push({ code: "undeclared", detail: "No availability declared for this window — not the same as available" });
  if (args.post.overtime && args.preferences?.overtime === false) reasons.push({ code: "declines_overtime", detail: "Declared no overtime" });
  if (args.post.regionCode && args.preferences?.regions.length && !args.preferences.regions.includes(args.post.regionCode)) {
    reasons.push({ code: "outside_region", detail: `Declared regions ${args.preferences.regions.join(", ")}; this post is ${args.post.regionCode}` });
  }
  return reasons;
}
