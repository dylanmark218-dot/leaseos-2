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
