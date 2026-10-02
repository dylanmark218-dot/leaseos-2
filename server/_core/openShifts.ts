/**
 * v22.20 — posting a shift, and the gap between wanting it and having it.
 *
 * Pure. No network, no database.
 *
 * Composes approved leave from `timeOff`, rotation from `calendarProjection`,
 * licence expiry from `documentValidity` and qualification standing from the
 * qualification read adapter. It re-decides none
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

import { isOnShift, type RotationPattern } from "./calendarProjection";
import { readExpiry } from "./documentValidity";
import { windowsOverlap } from "./bookingConflict";
import { isAbsent, type LeaveRequest } from "./timeOff";

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
  /**
   * Only an open post takes interest. Absent in pure planning, where every post is open. Open Work's
   * `draft` and `closed` (0206) are not open either, and refuse the same way.
   */
  status?: PostStatus;
};

/**
 * SPINE item 2 (owner's ruling): this is the one answer to "may this person take this shift?".
 * It is the union of what the engine and the router used to refuse separately — the router now
 * reads the records below and enforces this verdict; it decides nothing itself.
 */
export type IneligibilityCode =
  | "not_in_organization"
  | "wrong_role" | "not_rostered" | "on_approved_leave" | "overlaps_existing"
  | "no_licence_recorded" | "licence_expired"
  | "qualification_unknown" | "qualification_unverified" | "qualification_expired";

export type Ineligibility = { code: IneligibilityCode; detail: string };

/** A qualification's standing as the qualification read adapter reports it (`effectiveQualifications`). */
export type QualificationStanding = { code: string; held: boolean; notHeld: string | null; reason: string };

/** An existing commitment over some window — a confirmed or tentative booking. */
export type Commitment = { assignmentRef: string; startsAt: Date; endsAt: Date };

/**
 * Everything the rule reads about one person, all of it from records — never from the person
 * asking. A fact that could not be established is given as its absence, and absence refuses.
 */
export type PersonFacts = {
  userId: number;
  name: string;
  /** An active member of the organization that owns the post. */
  inOrganization: boolean;
  roles: readonly string[];
  /** Active crew memberships in the organization. None means not on its roster. */
  rosters: readonly { rotation: RotationPattern | null }[];
  leave: readonly LeaveRequest[];
  commitments: readonly Commitment[];
  /** The person's own operator record: none, more than one (ambiguous), or its licence expiry. */
  licence: { kind: "none" } | { kind: "ambiguous" } | { kind: "recorded"; expiresAt: Date | null };
  /** One standing per code the post requires. A required code with no standing is unknown. */
  qualifications: readonly QualificationStanding[];
};

export type Candidate = {
  userId: number;
  name: string;
  eligible: boolean;
  /** Empty when eligible. Never empty when not — see the module note. */
  reasons: Ineligibility[];
};


/**
 * Whether one person could take one post, and every reason they could not.
 *
 * Every reason is collected rather than stopping at the first, because a person missing two
 * qualifications is a different planning problem from one missing one. The one exception is a
 * person outside the organization: nothing else about them is read, so nothing else is said.
 */
export function shiftEligibility(post: ShiftPost, p: PersonFacts): Candidate {
  if (!p.inOrganization) {
    return { userId: p.userId, name: p.name, eligible: false, reasons: [{ code: "not_in_organization", detail: "Not an active member of the organization that posted this shift" }] };
  }
  const reasons: Ineligibility[] = [];

  if (!p.roles.includes(post.requiredRole)) {
    reasons.push({ code: "wrong_role", detail: `Holds ${p.roles.join(", ") || "no role"}; this post needs ${post.requiredRole}` });
  }

  // Rostered means an active crew membership whose rotation has them working that day. No pattern
  // is not the same as not working; no membership at all is not being on the roster.
  if (!p.rosters.some(r => !r.rotation || isOnShift(r.rotation, post.startsAt))) {
    reasons.push({ code: "not_rostered", detail: p.rosters.length ? "Off-hitch on this date" : "Not on this organization's roster" });
  }

  if (p.leave.some(l => l.userId === p.userId && isAbsent(l) && !l.partialDay
    && l.from <= post.startsAt && post.startsAt <= l.to)) {
    reasons.push({ code: "on_approved_leave", detail: "Away that day on leave already recorded" });
  }

  const clash = p.commitments.find(c => windowsOverlap(post, c));   // the one rule: _core/bookingConflict.ts
  if (clash) reasons.push({ code: "overlaps_existing", detail: `Already on ${clash.assignmentRef} over this window` });

  if (p.licence.kind === "none") {
    reasons.push({ code: "no_licence_recorded", detail: "No licence on record — this cannot be established as current" });
  } else if (p.licence.kind === "ambiguous") {
    reasons.push({ code: "no_licence_recorded", detail: "More than one operator record for this person — no licence is chosen between them" });
  } else if (!p.licence.expiresAt) {
    reasons.push({ code: "no_licence_recorded", detail: "No licence expiry on record — this cannot be established as current" });
  } else if (readExpiry(p.licence.expiresAt, post.startsAt, 0).expiry === "expired") {
    reasons.push({ code: "licence_expired", detail: `Licence expires ${p.licence.expiresAt.toISOString().slice(0, 10)}, before this shift` });
  }

  // From the adapter's structured verdict, never from its prose. A required code with no standing
  // at all is unknown, and unknown blocks exactly as expired does.
  for (const code of post.requiredQualifications) {
    const q = p.qualifications.find(x => x.code === code);
    if (q?.held) continue;
    reasons.push({
      code: q?.notHeld === "expired" ? "qualification_expired" : q?.notHeld === "unverified" ? "qualification_unverified" : "qualification_unknown",
      detail: q?.reason ?? `No ${code} on record — unknown is not satisfied`,
    });
  }

  return { userId: p.userId, name: p.name, eligible: reasons.length === 0, reasons };
}

/** Who could take this shift, and why the rest could not — the same rule, over many people. */
export function candidatesFor(args: { post: ShiftPost; people: readonly PersonFacts[] }): Candidate[] {
  return args.people.map(p => shiftEligibility(args.post, p));
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
  if (args.post.kind !== "open") {
    throw new NotEligible(`${args.post.postRef} is an assigned post; interest is not how it is filled`);
  }
  if (args.post.status && args.post.status !== "open") {
    throw new NotEligible(`${args.post.postRef} is ${args.post.status}; only an open post takes interest`);
  }
  if (!args.candidate.eligible) {
    throw new NotEligible(`${args.candidate.name} cannot take ${args.post.postRef}: ${args.candidate.reasons.map(r => r.detail).join("; ")}`);
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
/* 0206 — the post's life, and the offer's                              */
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
/* 0206 — availability is a declaration                                 */
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
