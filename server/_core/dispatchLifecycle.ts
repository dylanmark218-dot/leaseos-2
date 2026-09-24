/**
 * Dispatch lifecycle + pre-departure gate.
 *
 * The gap this module closes: an assignment made on Tuesday says the work is
 * SCHEDULED. It does not say the truck is safe to leave the yard on Thursday.
 * A critical defect can appear in between.
 *
 *     Match → Bid → Award Gate → Scheduled Assignment → PRE-DEPARTURE GATE → Dispatched
 *
 * So eligibility does not stop at award. Assignments are revalidated at
 * configured lead times and again immediately before departure, and a
 * post-award blocker moves the assignment to AT RISK and notifies dispatch
 * rather than silently cancelling work someone is relying on.
 */

import type { DispatchBlocker, EligibilityVerdict } from "./dispatchReadiness";
import type { BidState, PostingState } from "./dispatchAward";

/* ========================= posting lifecycle ========================= */

const POSTING_TRANSITIONS: Record<PostingState, PostingState[]> = {
  draft: ["planning", "cancelled"],
  planning: ["open_for_bid", "invite_only", "on_call", "direct", "cancelled"],
  open_for_bid: ["bid_closed", "awarding", "invite_only", "cancelled"],
  invite_only: ["bid_closed", "awarding", "open_for_bid", "cancelled"],
  on_call: ["awarding", "bid_closed", "cancelled"],
  // A direct-assignment posting reaches staffing by being crewed, not by being awarded. The bid
  // path arrives at `partially_staffed` through `awarding` because somebody had to be selected
  // first; a direct posting has nobody to select. Until the canonical assignment subsystem there
  // was no way to create a posting at all, so `direct` had no onward path but `awarding` and the
  // gap could not be reached. `awarding` is deliberately NOT reused for this: it means "we are
  // choosing who gets this", never "we are short a truck".
  direct: ["awarding", "partially_staffed", "staffed", "cancelled"],
  bid_closed: ["awarding", "open_for_bid", "cancelled"],
  awarding: ["partially_staffed", "staffed", "bid_closed", "cancelled"],
  partially_staffed: ["awarding", "staffed", "cancelled"],
  staffed: ["dispatched", "partially_staffed", "cancelled"],
  dispatched: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionPosting(
  from: PostingState,
  to: PostingState
): boolean {
  return POSTING_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Postings that may still accept new bids. */
const BID_OPEN_STATES: PostingState[] = [
  "open_for_bid",
  "invite_only",
  "on_call",
];

export function canAcceptBid(
  postingState: PostingState,
  bidDeadline: Date | null,
  now: Date
): { accepted: boolean; reason: string } {
  if (postingState === "cancelled") {
    return { accepted: false, reason: "Posting was cancelled" };
  }
  if (!BID_OPEN_STATES.includes(postingState)) {
    return {
      accepted: false,
      reason: `Posting is ${postingState} and is no longer taking bids`,
    };
  }
  if (bidDeadline && now.getTime() > bidDeadline.getTime()) {
    return { accepted: false, reason: "Bid deadline has passed" };
  }
  return { accepted: true, reason: "Posting is open for bids" };
}

const BID_TRANSITIONS: Record<BidState, BidState[]> = {
  draft: ["submitted", "withdrawn", "expired"],
  submitted: [
    "viewed",
    "shortlisted",
    "awarded",
    "withdrawn",
    "expired",
    "not_selected",
    "declined",
  ],
  viewed: [
    "shortlisted",
    "awarded",
    "withdrawn",
    "expired",
    "not_selected",
    "declined",
  ],
  shortlisted: ["awarded", "not_selected", "withdrawn", "expired"],
  awarded: ["declined"],
  declined: [],
  withdrawn: [],
  expired: [],
  not_selected: [],
};

export function canTransitionBid(from: BidState, to: BidState): boolean {
  return BID_TRANSITIONS[from]?.includes(to) ?? false;
}

export type InvitationState =
  | "queued"
  | "sent"
  | "delivered"
  | "viewed"
  | "accepted_interest"
  | "declined"
  | "no_response"
  | "bid_submitted"
  | "awarded"
  | "closed";

const INVITATION_TRANSITIONS: Record<InvitationState, InvitationState[]> = {
  queued: ["sent", "closed"],
  sent: ["delivered", "no_response", "closed"],
  delivered: ["viewed", "no_response", "closed"],
  viewed: [
    "accepted_interest",
    "declined",
    "bid_submitted",
    "no_response",
    "closed",
  ],
  accepted_interest: ["bid_submitted", "declined", "closed"],
  bid_submitted: ["awarded", "closed"],
  declined: ["closed"],
  no_response: ["closed"],
  awarded: ["closed"],
  closed: [],
};

export function canTransitionInvitation(
  from: InvitationState,
  to: InvitationState
): boolean {
  return INVITATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/* ===================== offline bid acknowledgement ===================== */

export type OfflineBidOutcome =
  | { accepted: true; message: string }
  | { accepted: false; reason: string };

/**
 * A bid prepared offline stays a draft until the server acknowledges it. When
 * it finally reaches the server the posting may have closed — the bid must
 * then fail, not appear retroactively successful.
 */
export function acknowledgeOfflineBid(
  postingState: PostingState,
  bidDeadline: Date | null,
  preparedAt: Date,
  receivedAt: Date
): OfflineBidOutcome {
  const gate = canAcceptBid(postingState, bidDeadline, receivedAt);
  if (!gate.accepted) {
    return {
      accepted: false,
      reason: `Bid prepared offline at ${preparedAt.toISOString().slice(11, 16)} could not be submitted: ${gate.reason}`,
    };
  }
  return { accepted: true, message: "Bid acknowledged by server" };
}

/* ========================= multi-role staffing ========================= */

export type RoleStaffing = {
  roleId: number;
  roleLabel: string;
  required: boolean;
  assignedOperatorId: number | null;
};

export type StaffingResult = {
  state: "unstaffed" | "partially_staffed" | "staffed";
  filled: number;
  requiredTotal: number;
  unfilledRoles: string[];
  message: string;
};

/**
 * A rig move is one posting with independently gated roles. It does not become
 * staffed until every REQUIRED role is filled — optional support roles do not
 * hold it back. No special-casing by job type.
 */
export function assessStaffing(roles: RoleStaffing[]): StaffingResult {
  const required = roles.filter(r => r.required);
  const filled = required.filter(r => r.assignedOperatorId !== null);
  const unfilled = required
    .filter(r => r.assignedOperatorId === null)
    .map(r => r.roleLabel);

  const state: StaffingResult["state"] =
    filled.length === 0
      ? "unstaffed"
      : filled.length < required.length
        ? "partially_staffed"
        : "staffed";

  return {
    state,
    filled: filled.length,
    requiredTotal: required.length,
    unfilledRoles: unfilled,
    message:
      state === "staffed"
        ? `All ${required.length} required roles filled.`
        : `${filled.length} of ${required.length} required roles filled. Outstanding: ${unfilled.join(", ")}.`,
  };
}

/* ===================== on-call rotation ===================== */

export type OnCallStatus =
  | "scheduled"
  | "called"
  | "delivered"
  | "viewed"
  | "accepted"
  | "declined"
  | "no_response"
  | "dispatched"
  | "unavailable";

export type RotationEntry = {
  operatorId: number;
  position: number;
  status: OnCallStatus;
};

export type RotationAdvance = {
  nextOperatorId: number | null;
  nextPosition: number | null;
  exhausted: boolean;
  message: string;
};

/**
 * After a decline or non-response, the next operator must be unambiguous.
 * Position ordering is preserved and prior responses are retained rather than
 * being overwritten, so the history of who was asked survives.
 */
export function advanceRotation(entries: RotationEntry[]): RotationAdvance {
  const spent: OnCallStatus[] = [
    "declined",
    "no_response",
    "unavailable",
    "dispatched",
  ];
  const candidates = entries
    .filter(e => !spent.includes(e.status))
    .sort((a, b) => a.position - b.position);

  if (candidates.length === 0) {
    return {
      nextOperatorId: null,
      nextPosition: null,
      exhausted: true,
      message:
        "Rotation exhausted — no remaining on-call operators. Escalate to dispatch.",
    };
  }
  const next = candidates[0];
  return {
    nextOperatorId: next.operatorId,
    nextPosition: next.position,
    exhausted: false,
    message: `Next on call is position ${next.position}.`,
  };
}

/* ===================== PRE-DEPARTURE GATE ===================== */

export type AssignmentRisk = "released" | "at_risk" | "blocked";

export type PreDepartureResult = {
  status: AssignmentRisk;
  blockers: DispatchBlocker[];
  /** True only for the final mandatory check immediately before departure. */
  releasedToDepart: boolean;
  message: string;
};

/**
 * Second gate. Assignment means SCHEDULED; this decides RELEASED TO DEPART.
 *
 * A post-award blocker does not silently cancel the assignment — it moves it
 * to AT RISK and notifies dispatch, because someone has planned their day
 * around it and the right response may be to fix the condition, not to
 * scrap the work.
 */
export function evaluatePreDeparture(
  verdict: EligibilityVerdict,
  blockers: DispatchBlocker[],
  isFinalCheck: boolean
): PreDepartureResult {
  const blocking = blockers.filter(b => b.severity === "blocking");
  const unknown = blockers.filter(b => b.severity === "unknown");

  if (blocking.length > 0) {
    return {
      status: "blocked",
      blockers,
      releasedToDepart: false,
      message: `ASSIGNMENT BLOCKED — ${blocking.map(b => b.label).join("; ")}. Resolve before departure.`,
    };
  }
  if (unknown.length > 0) {
    return {
      status: "at_risk",
      blockers,
      releasedToDepart: false,
      message: `ASSIGNMENT AT RISK — ${unknown.map(b => b.label).join("; ")}. Dispatch notified.`,
    };
  }
  if (verdict === "eligible_review") {
    return {
      status: "at_risk",
      blockers,
      releasedToDepart: false,
      message: `ASSIGNMENT AT RISK — ${blockers.map(b => b.label).join("; ")}. Dispatch notified.`,
    };
  }
  return {
    status: "released",
    blockers: [],
    // Only the final immediate-pre-departure check may release. An earlier
    // lead-time check that passes says "still on track", not "cleared to go".
    releasedToDepart: isFinalCheck,
    message: isFinalCheck
      ? "Released to depart — all conditions revalidated immediately before departure."
      : "On track. A final revalidation is still required immediately before departure.",
  };
}

export type LeadTimeCheckpoint = {
  hoursBefore: number;
  label: string;
  mandatory: boolean;
};

export const DEFAULT_LEAD_TIME_CHECKPOINTS: LeadTimeCheckpoint[] = [
  { hoursBefore: 24, label: "24 hours before", mandatory: false },
  { hoursBefore: 4, label: "4 hours before", mandatory: false },
  { hoursBefore: 1, label: "1 hour before", mandatory: false },
  { hoursBefore: 0, label: "Immediately before departure", mandatory: true },
];

export type DueCheckpoint = LeadTimeCheckpoint & {
  dueAt: Date;
  overdue: boolean;
};

/**
 * Which revalidations are due for an assignment. The zero-hour checkpoint is
 * mandatory and cannot be satisfied by an earlier passing check.
 */
export function checkpointsDue(
  scheduledDeparture: Date,
  now: Date,
  completedHoursBefore: number[] = [],
  checkpoints: LeadTimeCheckpoint[] = DEFAULT_LEAD_TIME_CHECKPOINTS
): DueCheckpoint[] {
  return checkpoints
    .filter(c => !completedHoursBefore.includes(c.hoursBefore))
    .map(c => {
      const dueAt = new Date(
        scheduledDeparture.getTime() - c.hoursBefore * 3_600_000
      );
      return { ...c, dueAt, overdue: now.getTime() >= dueAt.getTime() };
    })
    .filter(c => c.overdue);
}

/* ===================== rate visibility ===================== */

export type ViewerRole =
  | "operator_employee"
  | "operator_contractor"
  | "dispatcher"
  | "office"
  | "manager"
  | "administrator";

export type RateVisibility = {
  postedOffer: boolean;
  ownCompensation: boolean;
  customerRate: boolean;
  internalMargin: boolean;
  maySubmitPrice: boolean;
  mayAcceptPostedAmount: boolean;
};

/**
 * Financial visibility is a permission matrix, not one boolean — and it is
 * deliberately separate from dispatch eligibility. What someone may see about
 * money has no bearing on whether they may be assigned work.
 */
export function rateVisibilityFor(role: ViewerRole): RateVisibility {
  switch (role) {
    case "operator_employee":
      return {
        postedOffer: true,
        ownCompensation: true,
        customerRate: false,
        internalMargin: false,
        maySubmitPrice: false,
        mayAcceptPostedAmount: true,
      };
    case "operator_contractor":
      return {
        postedOffer: true,
        ownCompensation: true,
        customerRate: false,
        internalMargin: false,
        maySubmitPrice: true,
        mayAcceptPostedAmount: true,
      };
    case "dispatcher":
      return {
        postedOffer: true,
        ownCompensation: false,
        customerRate: true,
        internalMargin: false,
        maySubmitPrice: false,
        mayAcceptPostedAmount: false,
      };
    case "office":
    case "manager":
    case "administrator":
      return {
        postedOffer: true,
        ownCompensation: false,
        customerRate: true,
        internalMargin: true,
        maySubmitPrice: false,
        mayAcceptPostedAmount: false,
      };
  }
}
