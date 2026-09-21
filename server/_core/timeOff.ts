/**
 * v22.20 — asking for a day off, without telling the whole company why.
 *
 * Pure. No network, no database.
 *
 * The reason a person is away is three different facts at three different
 * audiences, and collapsing them is how a scheduling system ends up publishing
 * somebody's medical appointments to dispatch.
 *
 *   AVAILABILITY   the window they cannot work. Everyone who schedules sees it.
 *   CATEGORY       "Medical appointment", "Vacation". Scheduling-safe by design.
 *   PRIVATE NOTE   the employee's own words. Employee, and HR where policy says.
 *
 * The separation is structural rather than a filter somebody has to remember to
 * apply: `schedulingView` returns a type with no field for the note, so there
 * is nowhere for it to leak to even by accident. That is the same shape the
 * roadside panel uses, for the same reason.
 *
 * Two other rules worth stating.
 *
 * **A request is not an absence.** Only an approved request removes somebody
 * from the available pool. A pending one that already did would let anybody
 * take themselves off a crew by asking.
 *
 * **Coverage is reported to the approver, not consulted instead of them.** This
 * says what the crew would look like if the request were granted. It does not
 * grant or refuse anything: a shortage is often the right answer anyway, and a
 * system that auto-refuses leave because a day looks tight will simply be
 * worked around.
 */

import type { EventSource } from "./calendarProjection";

export type LeaveCategory =
  | "vacation" | "sick" | "medical_appointment" | "personal" | "family_responsibility"
  | "bereavement" | "unpaid" | "statutory_holiday" | "training" | "certification_renewal"
  | "court_obligation" | "company_authorized" | "other";

/** How urgently it has to be dealt with, which is not the same as why. */
export type LeaveUrgency = "planned" | "same_day";

export type LeaveRequest = {
  requestRef: string;
  userId: number;
  category: LeaveCategory;
  urgency: LeaveUrgency;
  from: Date;
  to: Date;
  /** Part of a day, where the absence is not the whole shift. */
  partialDay: { fromTime: string; toTime: string } | null;
  /** The employee's own words. Never reaches scheduling — see the module note. */
  privateNote: string | null;
  requestedAt: Date;
  status: "requested" | "approved" | "declined" | "cancelled" | "recorded";
  decidedByUserId: number | null;
  decidedAt: Date | null;
  decisionNote: string | null;
};

/** Categories a company may reasonably treat as sensitive. */
export const SENSITIVE_CATEGORIES: readonly LeaveCategory[] = [
  "sick", "medical_appointment", "family_responsibility", "bereavement", "court_obligation",
];

const LABEL: Record<LeaveCategory, string> = {
  vacation: "Vacation", sick: "Sick", medical_appointment: "Medical appointment",
  personal: "Personal day", family_responsibility: "Family responsibility",
  bereavement: "Bereavement", unpaid: "Unpaid leave", statutory_holiday: "Statutory holiday",
  training: "Training", certification_renewal: "Certification renewal",
  court_obligation: "Court obligation", company_authorized: "Company-authorized leave",
  other: "Leave",
};

/**
 * What a scheduler is given.
 *
 * There is no `privateNote` on this type and no way to add one at the call
 * site. A sensitive category is reduced to "Unavailable — approved leave",
 * because dispatch needs to know the time is gone and does not need to know a
 * person is unwell.
 */
export type SchedulingView = {
  requestRef: string;
  userId: number;
  from: Date;
  to: Date;
  partialDay: { fromTime: string; toTime: string } | null;
  status: LeaveRequest["status"];
  /** Category where it is scheduling-safe; a neutral phrase where it is not. */
  label: string;
  /** True when the real category has been withheld, so the redaction is visible. */
  categoryWithheld: boolean;
};

export function schedulingView(request: LeaveRequest, sensitive: readonly LeaveCategory[] = SENSITIVE_CATEGORIES): SchedulingView {
  const withheld = sensitive.includes(request.category);
  return {
    requestRef: request.requestRef, userId: request.userId,
    from: request.from, to: request.to, partialDay: request.partialDay, status: request.status,
    label: withheld
      ? request.status === "approved" ? "Unavailable — approved leave" : "Unavailable — leave requested"
      : LABEL[request.category],
    categoryWithheld: withheld,
  };
}

export type Audience = "self" | "scheduling" | "hr";

export type LeaveDisclosure =
  | { audience: "self" | "hr"; request: LeaveRequest }
  | { audience: "scheduling"; request: SchedulingView };

/** The one place an audience is turned into what it may hold. */
export function disclose(request: LeaveRequest, audience: Audience, viewerUserId?: number): LeaveDisclosure | null {
  if (audience === "self") return viewerUserId === request.userId ? { audience: "self", request } : null;
  if (audience === "hr") return { audience: "hr", request };
  return { audience: "scheduling", request: schedulingView(request) };
}

/* ------------------------------------------------------------------ */
/* Availability                                                         */
/* ------------------------------------------------------------------ */

const overlapsDay = (request: LeaveRequest, day: Date) => {
  const d = day.toISOString().slice(0, 10);
  return request.from.toISOString().slice(0, 10) <= d && d <= request.to.toISOString().slice(0, 10);
};

/**
 * Whether approved leave makes this person unavailable that day.
 *
 * Approved only. A pending request that already removed somebody would let
 * anyone take themselves off a crew by asking, and a partial-day absence leaves
 * them available for the rest of the shift.
 */
export function onApprovedLeave(requests: readonly LeaveRequest[], userId: number, day: Date): boolean {
  return requests.some(r =>
    r.userId === userId && r.status === "approved" && !r.partialDay && overlapsDay(r, day));
}

/** Partial-day absences, for a planner who needs the hours rather than the day. */
export const partialAbsences = (requests: readonly LeaveRequest[], day: Date) =>
  requests
    .filter(r => r.status === "approved" && r.partialDay && overlapsDay(r, day))
    .map(r => ({ userId: r.userId, ...r.partialDay!, label: schedulingView(r).label }));

/* ------------------------------------------------------------------ */
/* Deciding                                                             */
/* ------------------------------------------------------------------ */

export type CoverageImpact = {
  day: Date;
  availableAfter: number;
  needed: number;
  shortfall: number;
  qualificationsLost: string[];
};

export type DecisionBrief = {
  request: LeaveRequest;
  impact: CoverageImpact[];
  /** Advisory. The approver decides; this only says what they should know. */
  advisory: "no_impact" | "leaves_tight" | "creates_shortage" | "loses_qualification";
  lines: string[];
  /** Never true for a decision. Nothing here approves anything. */
  decided: false;
};

export function briefForApprover(request: LeaveRequest, impact: readonly CoverageImpact[]): DecisionBrief {
  const losesQualification = impact.some(i => i.qualificationsLost.length > 0);
  const shortage = impact.some(i => i.shortfall > 0);
  const tight = impact.some(i => i.shortfall === 0 && i.availableAfter === i.needed);
  const advisory: DecisionBrief["advisory"] =
    losesQualification ? "loses_qualification" : shortage ? "creates_shortage" : tight ? "leaves_tight" : "no_impact";

  const lines = impact.map(i => {
    const date = i.day.toISOString().slice(0, 10);
    if (i.qualificationsLost.length) return `${date}: would leave nobody holding ${i.qualificationsLost.join(", ")}`;
    if (i.shortfall > 0) return `${date}: would leave ${i.availableAfter} of ${i.needed} — short ${i.shortfall}`;
    if (i.availableAfter === i.needed) return `${date}: would leave exactly ${i.needed}, with no margin`;
    return `${date}: ${i.availableAfter} of ${i.needed}, no impact`;
  });
  return { request, impact: [...impact], advisory, lines, decided: false };
}

/* ------------------------------------------------------------------ */
/* Calling in sick                                                      */
/* ------------------------------------------------------------------ */

export type CallOff = {
  request: LeaveRequest;
  /** Recorded as fact, not queued for approval. Somebody is not coming in. */
  routedTo: readonly ("dispatch" | "supervisor")[];
  source: EventSource;
  note: string;
};

/**
 * A same-day call-off.
 *
 * Recorded rather than requested. Someone phoning at 05:00 to say they cannot
 * drive is reporting a fact, and putting that through a vacation approval form
 * means either a sick person arguing with a workflow or a crew that does not
 * find out until the truck is missing. Whether it is paid is a payroll question
 * decided afterwards; whether the shift is covered is dispatch's problem now.
 */
export function recordCallOff(args: {
  requestRef: string; userId: number; category: Extract<LeaveCategory, "sick" | "family_responsibility" | "bereavement" | "other">;
  from: Date; to: Date; privateNote?: string | null; at: Date;
}): CallOff {
  const request: LeaveRequest = {
    requestRef: args.requestRef, userId: args.userId, category: args.category, urgency: "same_day",
    from: args.from, to: args.to, partialDay: null, privateNote: args.privateNote ?? null,
    requestedAt: args.at,
    // Not "requested": nobody is being asked to approve somebody being unwell.
    status: "recorded",
    decidedByUserId: null, decidedAt: null, decisionNote: null,
  };
  return {
    request,
    routedTo: ["dispatch", "supervisor"],
    source: { sourceType: "leaveRequest", sourceRef: args.requestRef, generatedBy: "call_off" },
    note: "Recorded as a call-off, not queued for approval. Coverage is dispatch's to solve now; whether it is paid is decided afterwards.",
  };
}

/** A call-off removes somebody from the pool as surely as approved leave does. */
export const isAbsent = (r: LeaveRequest): boolean => r.status === "approved" || r.status === "recorded";
