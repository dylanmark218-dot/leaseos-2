/**
 * Payroll P3 — payroll time, operational candidates, approval routing, exceptions and the time → earning
 * boundary, pure (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §26).
 *
 * D11 is the spine of this module. Operational records are evidence; a candidate is a read-only projection of one
 * operational fact, and its type says so (`status: "candidate"`, always). Nothing here writes, and nothing here turns
 * a candidate into submitted or approved time: a person does that, through a mutation, later.
 *
 *   operational source ─► candidate (this module, read-only) ─► worker submission ─► payroll time entry
 *     ─► approval (D10 approver) ─► approved earning (P1 version × rule) ─► runCollect (P0/P2, the only way into a run)
 *
 * Identity and provenance are separate on purpose. `candidateKey` names the source segment (what was worked) and
 * does not change when the source is edited, so the same segment can never become two payable entries.
 * `sourceFingerprint` hashes the material facts and the source's version, so an edit after preparation is visible.
 */
import { canonicalJson, sha256 } from "./commercialLifecycle";
import { DATE_TEXT, type DateText } from "./payrollSchedule";

/* ------------------------------------------------------------------ */
/* Sources and their authority                                         */
/* ------------------------------------------------------------------ */

/**
 * The sources P3 reads. Work orders are deliberately absent: they record a free-text technician and one labour total
 * (`workOrders.technician`, `laborMinutes`), which cannot be attributed to a person, so no person-level candidate is
 * made from them. Training records carry no duration and tailgate attendance is free text; neither is a source yet.
 */
export const CANDIDATE_SOURCES = ["hos_duty", "dispatch_booking", "trip", "load", "field_ticket"] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export type SourceAuthority = "regulatory_duty" | "planned_assignment" | "actual_operational" | "measured_quantity";

export type SourceAuthorityEntry = {
  authority: SourceAuthority;
  /** What the record can show about time: a regulatory window, a plan, or an actual. Never "approved". */
  timeMeaning: "regulatory_duty_window" | "planned_window" | "actual_window" | "none";
  /** Whether it carries a measured quantity (km, load, tonne, m³). */
  provesQuantity: boolean;
  /** Whether P3 lets a worker submit it as payroll TIME. Quantity earnings are a later flow on the same architecture. */
  timeEligible: boolean;
  /** Said on every candidate from this source. */
  warning: string;
};

/**
 * The source-authority matrix. Every source is evidence of something specific and of nothing more; none of them is
 * payroll approval, and only a person turns one into submitted time.
 */
export const SOURCE_AUTHORITY: Readonly<Record<CandidateSource, SourceAuthorityEntry>> = {
  hos_duty: {
    authority: "regulatory_duty", timeMeaning: "regulatory_duty_window", provesQuantity: false, timeEligible: true,
    warning: "Hours-of-service duty is a regulatory record, not paid time; the worker confirms what was worked",
  },
  dispatch_booking: {
    authority: "planned_assignment", timeMeaning: "planned_window", provesQuantity: false, timeEligible: true,
    warning: "A dispatch booking is the planned assignment, not proof the shift was worked for that long",
  },
  trip: {
    authority: "actual_operational", timeMeaning: "none", provesQuantity: true, timeEligible: false,
    warning: "A trip proves distance and completion, not hourly time",
  },
  load: {
    authority: "measured_quantity", timeMeaning: "none", provesQuantity: true, timeEligible: false,
    warning: "A load proves a measured quantity, not hourly time",
  },
  field_ticket: {
    authority: "actual_operational", timeMeaning: "actual_window", provesQuantity: false, timeEligible: true,
    warning: "A closed or signed field ticket is the strongest operational evidence of a window worked, and it is still only a candidate",
  },
};

export const PAYROLL_ACTIVITIES = ["driving", "on_location", "loading", "unloading", "waiting", "standby", "shop", "training", "safety_meeting", "travel", "break", "off_duty"] as const;
export type PayrollActivity = (typeof PAYROLL_ACTIVITIES)[number];

/** One operational fact, read by the service from a record the caller's organization owns. */
export type SourceFact = {
  sourceType: CandidateSource;
  /** The authoritative identity of the source record (its unique ref, or its table and primary key when it has no ref). */
  sourceRef: string;
  /** The segment inside the record, when one record carries several (a labour line, a duty interval). */
  segment?: string | null;
  /** The record's version: a revision id, a sealed hash, an updatedAt. Null when the source keeps none. */
  sourceVersion?: string | null;
  /** The facts whose change matters to pay. Hashed into the fingerprint, never into the identity. */
  material: Record<string, unknown>;
  startedAt?: Date | null;
  endedAt?: Date | null;
  quantity?: { value: number; unit: string } | null;
  measurementAuthority: string;
  activity?: PayrollActivity | null;
  jobId?: number | null;
  unitId?: number | null;
  tripId?: number | null;
  warnings?: readonly string[];
  /** A reason the source itself cannot be submitted (open interval, unsigned ticket, cancelled booking). */
  blockedReason?: string | null;
};

export type Candidate = {
  /** Always "candidate". Nothing in this module produces any other status. */
  status: "candidate";
  candidateKey: string;
  sourceType: CandidateSource;
  sourceRef: string;
  segment: string | null;
  sourceVersion: string | null;
  sourceFingerprint: string;
  authority: SourceAuthority;
  measurementAuthority: string;
  employeePayrollProfileId: number;
  workDate: DateText | null;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number | null;
  quantity: { value: number; unit: string } | null;
  activity: PayrollActivity | null;
  jobId: number | null;
  unitId: number | null;
  tripId: number | null;
  warnings: string[];
  eligible: boolean;
  ineligibleReason: string | null;
  /** Set when an effective time entry already carries this source segment. */
  submittedAsEntryRef: string | null;
};

/** The source segment's identity: same source record and segment → same key, whatever the record now says. */
export function candidateKey(f: { sourceType: CandidateSource; sourceRef: string; segment?: string | null }): string {
  return sha256(canonicalJson({ v: 1, sourceType: f.sourceType, sourceRef: f.sourceRef, segment: f.segment ?? null }));
}

/** The source's material facts and version: any change to what would be paid, or to the record's version, changes it. */
export function sourceFingerprint(f: Pick<SourceFact, "sourceType" | "sourceRef" | "segment" | "sourceVersion" | "material" | "startedAt" | "endedAt" | "quantity">): string {
  return sha256(canonicalJson({
    v: 1, sourceType: f.sourceType, sourceRef: f.sourceRef, segment: f.segment ?? null, sourceVersion: f.sourceVersion ?? null,
    startedAt: f.startedAt ?? null, endedAt: f.endedAt ?? null, quantity: f.quantity ?? null, material: f.material,
  }));
}

/* ------------------------------------------------------------------ */
/* Calendar dates in a zone                                            */
/* ------------------------------------------------------------------ */

/** The calendar date an instant falls on in an IANA zone. The server's own zone never enters. */
export function localDate(at: Date, zone: string): DateText {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const n = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${n("year")}-${n("month")}-${n("day")}`;
}

export const minutesBetween = (start: Date, end: Date) => Math.round((end.getTime() - start.getTime()) / 60_000);

/**
 * operational facts → read-only candidates for one payroll profile. Deterministic: the same facts give the same
 * candidates in the same order. `submitted` maps a candidate key to the effective entry that already carries it.
 */
export function candidatesFromSources(args: {
  employeePayrollProfileId: number;
  timezone: string;
  facts: readonly SourceFact[];
  submitted?: ReadonlyMap<string, string>;
}): Candidate[] {
  const out: Candidate[] = [];
  for (const f of args.facts) {
    const auth = SOURCE_AUTHORITY[f.sourceType];
    const key = candidateKey(f);
    const start = f.startedAt ?? null;
    const end = f.endedAt ?? null;
    const minutes = start && end ? minutesBetween(start, end) : null;
    const warnings = [auth.warning, ...(f.warnings ?? [])];
    let reason: string | null = null;
    if (!auth.timeEligible) reason = `${f.sourceType} candidates are quantity evidence; P3 submits time only`;
    else if (f.blockedReason) reason = f.blockedReason;
    else if (!start || !end) reason = "The source has no closed time window";
    else if (minutes! <= 0) reason = "The source's window has no duration";
    const submittedAs = args.submitted?.get(key) ?? null;
    if (!reason && submittedAs) reason = `Already submitted as ${submittedAs}`;
    out.push({
      status: "candidate",
      candidateKey: key,
      sourceType: f.sourceType,
      sourceRef: f.sourceRef,
      segment: f.segment ?? null,
      sourceVersion: f.sourceVersion ?? null,
      sourceFingerprint: sourceFingerprint(f),
      authority: auth.authority,
      measurementAuthority: f.measurementAuthority,
      employeePayrollProfileId: args.employeePayrollProfileId,
      workDate: start ? localDate(start, args.timezone) : null,
      startedAt: start ? start.toISOString() : null,
      endedAt: end ? end.toISOString() : null,
      minutes,
      quantity: f.quantity ?? null,
      activity: f.activity ?? null,
      jobId: f.jobId ?? null,
      unitId: f.unitId ?? null,
      tripId: f.tripId ?? null,
      warnings,
      eligible: reason === null,
      ineligibleReason: reason,
      submittedAsEntryRef: submittedAs,
    });
  }
  return out.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.candidateKey.localeCompare(b.candidateKey));
}

/* ------------------------------------------------------------------ */
/* Time entries: states, effectiveness, overlap                        */
/* ------------------------------------------------------------------ */

export type TimeEntryStatus = "open" | "submitted" | "verified" | "disputed" | "approved" | "void";

/**
 * The time-entry machine over the existing enum (0022). A rejection is `void` with rejection provenance recorded
 * beside it (0234), so a rejected row stays visible and no enum value was added for it.
 */
const TIME_TRANSITIONS: Readonly<Record<TimeEntryStatus, readonly TimeEntryStatus[]>> = {
  open: ["submitted", "void"],
  submitted: ["verified", "approved", "void", "disputed"],
  verified: ["approved", "void", "disputed"],
  disputed: ["approved", "void"],
  approved: ["disputed"],
  void: [],
};
export const canTransitionTime = (from: TimeEntryStatus, to: TimeEntryStatus) => TIME_TRANSITIONS[from].includes(to);

export type EntryLike = { entryRef?: string | null; status: TimeEntryStatus; supersededByEntryId: number | null; startedAt: Date; endedAt: Date | null };

/** Counts toward overlap and duplicate checks: not withdrawn, rejected or replaced. */
export const isEffective = (e: { status: TimeEntryStatus; supersededByEntryId: number | null }) => e.status !== "void" && e.supersededByEntryId == null;
/** May produce pay: approved and not replaced. A superseded row never counts as payable. */
export const isPayable = (e: { status: TimeEntryStatus; supersededByEntryId: number | null }) => e.status === "approved" && e.supersededByEntryId == null;

/** Half-open intervals: [start, end). Touching ends are adjacent, not overlapping. */
export function intervalsOverlap(a: { startedAt: Date; endedAt: Date }, b: { startedAt: Date; endedAt: Date }): boolean {
  return a.startedAt.getTime() < b.endedAt.getTime() && b.startedAt.getTime() < a.endedAt.getTime();
}

/** The effective, closed entries of one profile that overlap `candidate`. Drafts (`open`) are not yet claims. */
export function overlapsFor<T extends EntryLike>(candidate: { startedAt: Date; endedAt: Date }, entries: readonly T[]): T[] {
  return entries.filter(e => isEffective(e) && e.status !== "open" && e.endedAt != null && intervalsOverlap(candidate, { startedAt: e.startedAt, endedAt: e.endedAt }));
}

/** Every overlapping pair among a profile's effective, closed entries. */
export function overlappingPairs<T extends EntryLike>(entries: readonly T[]): Array<[T, T]> {
  const live = entries.filter(e => isEffective(e) && e.status !== "open" && e.endedAt != null).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (live[j]!.startedAt.getTime() >= live[i]!.endedAt!.getTime()) break;
      pairs.push([live[i]!, live[j]!]);
    }
  }
  return pairs;
}

/* ------------------------------------------------------------------ */
/* Profile → schedule → period                                         */
/* ------------------------------------------------------------------ */

export type PeriodLike = { id: number; periodRef: string; state: string; periodStartDate: DateText | null; periodEndDate: DateText | null };

export type PeriodResolution =
  | { kind: "period"; period: PeriodLike }
  | { kind: "none"; exception: "no_pay_schedule" | "no_matching_pay_period"; reason: string }
  | { kind: "integrity_error"; exception: "no_matching_pay_period"; reason: string };

/** The schedule a profile is paid on: its pay group's schedule, in the profile's own book. Never guessed. */
export function scheduleForProfile(args: {
  profile: { financialEntityId: number; payGroupId: number | null };
  payGroup: { id: number; financialEntityId: number | null; active: boolean; payScheduleId: number | null } | null;
  schedule: { id: number; financialEntityId: number; status: string; timezone: string } | null;
}): { ok: true; scheduleId: number; timezone: string } | { ok: false; reason: string } {
  const { profile, payGroup, schedule } = args;
  if (profile.payGroupId == null) return { ok: false, reason: "The payroll profile has no pay group, so no pay schedule" };
  if (!payGroup || payGroup.financialEntityId !== profile.financialEntityId) return { ok: false, reason: "The profile's pay group is not in the profile's book" };
  if (!payGroup.active) return { ok: false, reason: "The profile's pay group is inactive" };
  if (payGroup.payScheduleId == null) return { ok: false, reason: "The profile's pay group has no pay schedule" };
  if (!schedule || schedule.financialEntityId !== profile.financialEntityId) return { ok: false, reason: "The pay group's schedule is not in the profile's book" };
  if (schedule.status !== "active") return { ok: false, reason: "The pay group's schedule is retired" };
  return { ok: true, scheduleId: schedule.id, timezone: schedule.timezone };
}

/** calendar date → the one period of the schedule that contains it. Two is an integrity failure, never a choice. */
export function periodForDate(periods: readonly PeriodLike[], workDate: DateText): PeriodResolution {
  if (!DATE_TEXT.test(workDate)) return { kind: "none", exception: "no_matching_pay_period", reason: `work date "${workDate}" is not YYYY-MM-DD` };
  const matches = periods.filter(p => p.state !== "voided" && p.periodStartDate != null && p.periodEndDate != null && p.periodStartDate <= workDate && workDate < p.periodEndDate);
  if (matches.length === 1) return { kind: "period", period: matches[0]! };
  if (matches.length === 0) return { kind: "none", exception: "no_matching_pay_period", reason: `No pay period of the schedule contains ${workDate}; generate the schedule's periods first` };
  return { kind: "integrity_error", exception: "no_matching_pay_period", reason: `${matches.length} pay periods contain ${workDate}: ${matches.map(m => m.periodRef).join(", ")}` };
}

/** OPEN takes new time. Approval of time already submitted continues through REVIEWING. Nothing after. */
export const periodAcceptsNewTime = (state: string) => state === "collecting";
export const periodAcceptsTimeApproval = (state: string) => state === "collecting" || state === "review";

/* ------------------------------------------------------------------ */
/* D10 — who approves a time entry                                     */
/* ------------------------------------------------------------------ */

export type CrewMembership = { crewId: number; userId: number; crewRole: string; active: boolean };

export type ApproverResolution =
  | { route: "crew_supervisor"; approverUserIds: number[]; crewIds: number[] }
  | { route: "payroll_admin"; approverUserIds: number[]; reason: string }
  | { route: "none"; approverUserIds: number[]; reason: string };

/**
 * D10. The worker's field supervisor is a `crewMembers.crewRole = supervisor` of an active crew the worker is an
 * active member of, in the same organization (the service passes only that organization's crews). When there is
 * none, the book's payroll administrators. Nothing else: no role, dispatch, job or branch implies supervision.
 * The worker never appears among their own approvers.
 */
export function resolvePayrollTimeApprovers(args: {
  workerUserId: number;
  memberships: readonly CrewMembership[];
  payrollAdminUserIds: readonly number[];
}): ApproverResolution {
  const workerCrews = Array.from(new Set(args.memberships.filter(m => m.active && m.userId === args.workerUserId).map(m => m.crewId)));
  const supervisors = args.memberships.filter(m => m.active && m.crewRole === "supervisor" && workerCrews.includes(m.crewId) && m.userId !== args.workerUserId);
  if (supervisors.length) {
    return {
      route: "crew_supervisor",
      approverUserIds: Array.from(new Set(supervisors.map(s => s.userId))).sort((a, b) => a - b),
      crewIds: Array.from(new Set(supervisors.map(s => s.crewId))).sort((a, b) => a - b),
    };
  }
  const admins = Array.from(new Set(args.payrollAdminUserIds.filter(u => u !== args.workerUserId))).sort((a, b) => a - b);
  if (admins.length) return { route: "payroll_admin", approverUserIds: admins, reason: workerCrews.length ? "The worker's crews have no other supervisor" : "The worker is on no crew" };
  return { route: "none", approverUserIds: [], reason: "No crew supervisor and no payroll administrator can approve this time" };
}

/* ------------------------------------------------------------------ */
/* Exceptions                                                          */
/* ------------------------------------------------------------------ */

export const PAYROLL_EXCEPTION_KINDS = [
  "missing_approval", "overlapping_entries", "duplicate_entry", "no_active_agreement", "missing_earning_code",
  "earning_rule_mismatch", "outside_employment", "long_shift", "job_reference_missing", "source_changed_after_preparation",
  "clock_variance", "cross_tenant_reference", "self_approval_blocked", "no_valid_approver", "no_pay_schedule",
  "no_matching_pay_period", "locked_pay_period",
] as const;
export type PayrollExceptionKind = (typeof PAYROLL_EXCEPTION_KINDS)[number];

/**
 * Blocking vs review, and what clears each.
 *
 * - `blocks` names the stage a blocking exception stops: `submission` (the act is refused outright and the exception is
 *   the record of the refusal), `approval` (the time entry cannot be approved while it is open), `earning` (approved
 *   time produces no earning while it is open). A review exception stops nothing.
 * - `clearedBy: "person"` stays open until someone resolves or dismisses it with a note. `clearedBy: "condition"` is
 *   re-checked by the act it blocks and closed by the system when the condition no longer holds (a period now exists,
 *   an approver now exists, the earning now prices), with the actor and the reason recorded.
 *
 * None of them changes pay by itself. HOS disagreeing with payroll is never a blocking condition: they are different clocks.
 */
export const EXCEPTION_POLICY: Readonly<Record<PayrollExceptionKind, { severity: "blocking" | "review"; blocks: "submission" | "approval" | "earning" | null; clearedBy: "person" | "condition" }>> = {
  cross_tenant_reference: { severity: "blocking", blocks: "submission", clearedBy: "person" },
  duplicate_entry: { severity: "blocking", blocks: "submission", clearedBy: "person" },
  locked_pay_period: { severity: "blocking", blocks: "submission", clearedBy: "person" },
  overlapping_entries: { severity: "blocking", blocks: "approval", clearedBy: "person" },
  outside_employment: { severity: "blocking", blocks: "approval", clearedBy: "person" },
  source_changed_after_preparation: { severity: "blocking", blocks: "approval", clearedBy: "person" },
  no_pay_schedule: { severity: "blocking", blocks: "approval", clearedBy: "condition" },
  no_matching_pay_period: { severity: "blocking", blocks: "approval", clearedBy: "condition" },
  self_approval_blocked: { severity: "blocking", blocks: "approval", clearedBy: "condition" },
  no_valid_approver: { severity: "blocking", blocks: "approval", clearedBy: "condition" },
  no_active_agreement: { severity: "blocking", blocks: "earning", clearedBy: "condition" },
  missing_earning_code: { severity: "blocking", blocks: "earning", clearedBy: "condition" },
  earning_rule_mismatch: { severity: "blocking", blocks: "earning", clearedBy: "condition" },
  job_reference_missing: { severity: "blocking", blocks: "earning", clearedBy: "condition" },
  clock_variance: { severity: "review", blocks: null, clearedBy: "person" },
  long_shift: { severity: "review", blocks: null, clearedBy: "person" },
  missing_approval: { severity: "review", blocks: null, clearedBy: "person" },
};

/** The open exceptions on a time entry that stop its approval until a person resolves them. */
export const APPROVAL_GATE_KINDS: readonly PayrollExceptionKind[] = PAYROLL_EXCEPTION_KINDS.filter(k => EXCEPTION_POLICY[k].blocks === "approval" && EXCEPTION_POLICY[k].clearedBy === "person");
/** The exceptions a successful earning generation closes. */
export const EARNING_STAGE_KINDS: readonly PayrollExceptionKind[] = PAYROLL_EXCEPTION_KINDS.filter(k => EXCEPTION_POLICY[k].blocks === "earning");

export const isBlocking = (kind: PayrollExceptionKind) => EXCEPTION_POLICY[kind].severity === "blocking";

/** One open exception per deterministic condition: the same kind on the same subject (and discriminator) is the same exception. */
export function exceptionConditionKey(kind: PayrollExceptionKind, subjectType: string, subjectRef: string, discriminator?: string | null): string {
  return sha256(canonicalJson({ v: 1, kind, subjectType, subjectRef, discriminator: discriminator ?? null }));
}

/**
 * A conservative diagnostic, not a legal threshold: a single submitted entry this long is flagged for review. HOS
 * compliance is the HOS subsystem's decision and is not made here.
 */
export const LONG_SHIFT_REVIEW_MINUTES = 16 * 60;
/** A submission that differs from its candidate's window by more than this is flagged for review (never refused). */
export const CLOCK_VARIANCE_REVIEW_MINUTES = 15;

/* ------------------------------------------------------------------ */
/* Time → earning                                                      */
/* ------------------------------------------------------------------ */

/**
 * minutes × rateMillis (thousandths of the currency unit per hour) → integer cents, rounded half-up at the cent.
 * cents = minutes × rateMillis / 600, computed on integers: no floating-point money anywhere on the path.
 */
export function hourlyAmountCents(minutes: number, rateMillis: number): number {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new RangeError("minutes must be a non-negative integer");
  if (!Number.isSafeInteger(rateMillis) || rateMillis < 0) throw new RangeError("rateMillis must be a non-negative integer");
  const product = minutes * rateMillis;
  if (!Number.isSafeInteger(product)) throw new RangeError("minutes × rateMillis exceeds exact integer range");
  // Exact on safe integers: the remainder is exact, and (product − remainder) divides evenly.
  const remainder = product % 600;
  return (product - remainder) / 600 + (remainder >= 300 ? 1 : 0);
}

export type TimeEarningInput = {
  entry: { workDate: DateText; minutes: number | null; earningCode: string | null; jobId: number | null; unitId: number | null };
  code: { code: string; calculationType: string; requiresJob: boolean; requiresUnit: boolean } | null;
  inForce: { kind: "version"; versionRef: string; rulesHash: string } | { kind: "none" | "integrity_error"; reason: string } | null;
  rule: { id: number; earningCode: string; calculation: string; unit: string; rateMillis: number | null; requiresJob: boolean; requiresUnit: boolean } | null;
};

export type TimeEarning =
  | { ok: true; amountCents: number; rateMillis: number; minutes: number; earningCode: string; versionRef: string; rulesHash: string; ruleId: number }
  | { ok: false; exception: PayrollExceptionKind; reason: string };

/**
 * approved time + the earning code + the approved P1 version in force on the work date + that version's rule for the
 * code → an earning, or the named blocking exception. A legacy pay rate is never consulted here.
 */
export function resolveTimeEarning(i: TimeEarningInput): TimeEarning {
  if (!i.entry.earningCode) return { ok: false, exception: "missing_earning_code", reason: "The time entry has no earning code" };
  if (!i.code) return { ok: false, exception: "missing_earning_code", reason: `Earning code ${i.entry.earningCode} is not active in this book on ${i.entry.workDate}` };
  if (i.code.calculationType !== "hourly") return { ok: false, exception: "earning_rule_mismatch", reason: `Earning code ${i.code.code} is ${i.code.calculationType}, not hourly; time pays only hourly codes` };
  if (!i.inForce) return { ok: false, exception: "no_active_agreement", reason: "The profile has no compensation agreement covering the work date" };
  if (i.inForce.kind !== "version") return { ok: false, exception: "no_active_agreement", reason: i.inForce.reason };
  if (!i.rule) return { ok: false, exception: "earning_rule_mismatch", reason: `Version ${i.inForce.versionRef} has no rule for ${i.code.code}` };
  if (i.rule.earningCode !== i.code.code || i.rule.calculation !== "hourly" || i.rule.unit !== "hour") {
    return { ok: false, exception: "earning_rule_mismatch", reason: `Version ${i.inForce.versionRef}'s rule for ${i.rule.earningCode} is ${i.rule.calculation} per ${i.rule.unit}; time needs hourly per hour` };
  }
  if (i.rule.rateMillis == null) return { ok: false, exception: "earning_rule_mismatch", reason: `Version ${i.inForce.versionRef}'s rule for ${i.code.code} has no rate` };
  if ((i.code.requiresJob || i.rule.requiresJob) && i.entry.jobId == null) return { ok: false, exception: "job_reference_missing", reason: `Earning code ${i.code.code} requires a job and the time entry has none` };
  if ((i.code.requiresUnit || i.rule.requiresUnit) && i.entry.unitId == null) return { ok: false, exception: "job_reference_missing", reason: `Earning code ${i.code.code} requires a unit and the time entry has none` };
  if (i.entry.minutes == null || i.entry.minutes <= 0) return { ok: false, exception: "earning_rule_mismatch", reason: "The time entry has no closed duration" };
  return {
    ok: true, amountCents: hourlyAmountCents(i.entry.minutes, i.rule.rateMillis), rateMillis: i.rule.rateMillis, minutes: i.entry.minutes,
    earningCode: i.code.code, versionRef: i.inForce.versionRef, rulesHash: i.inForce.rulesHash, ruleId: i.rule.id,
  };
}

/* ------------------------------------------------------------------ */
/* Offline                                                             */
/* ------------------------------------------------------------------ */

/**
 * A capture prepared offline may ask to be kept as a draft or to be submitted. It may never ask for anything
 * further: approval, rejection and every money decision are server-side and online. The server chooses the state.
 */
export function serverStateForCapture(claimed: unknown): { ok: true; state: "open" | "submitted" } | { ok: false; reason: string } {
  if (claimed === undefined || claimed === null || claimed === "submitted") return { ok: true, state: "submitted" };
  if (claimed === "open" || claimed === "draft") return { ok: true, state: "open" };
  return { ok: false, reason: `A capture cannot claim "${String(claimed)}"; approval is decided on the server, online` };
}
