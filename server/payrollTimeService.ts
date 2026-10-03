/**
 * Payroll P3 — data access for payroll time, operational candidates, approval, the time → earning step and payroll
 * exceptions (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §26). The rules are in `_core/payrollTime.ts`;
 * this module reads and writes rows.
 *
 * Reads of operational records are scoped in the query to the caller's organization and keyed by the worker's own
 * operator record; nothing here writes an operational table, and nothing writes payroll because a source exists.
 *
 * Every write that depends on the pay period re-reads it `FOR UPDATE` inside its own transaction (the P2 rule), and
 * every submission locks the payroll profile row first, so two submissions for one person serialize: duplicate
 * capture refs, duplicate sources and overlaps are decided on a consistent view, and the unique indexes of 0228 stand
 * behind that if anything slips past.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { conflictingBookingsWhere } from "./_core/bookingConflict";
import { getDb, jobInScope, operatorForUserInScope, operatorInScope, orgScopeWhere, ownershipScopeWhere, type TenantScope } from "./db";
import {
  compensationAgreements,
  compensationAgreementVersions,
  compensationEarningRules,
  crewMembers,
  crews,
  dutyRecords,
  employeePayrollProfiles,
  fieldTicketRevisions,
  fieldTickets,
  jobs,
  loads,
  organizationMemberships,
  organizationWorkers,
  payGroups,
  payPeriods,
  payrollEarningEvents,
  payrollExceptions,
  payrollTimeEntries,
  paySchedules,
  resourceBookings,
  trips,
  userRoleAssignments,
} from "../drizzle/schema";
import type { Db, DbOrTx, Tx } from "./_core/dbTypes";
import { grantsInOrganization, type RoleGrant } from "./_core/recordsAuthorization";
import { dateText, resolveEarningCode } from "./payrollCompensationService";
import { versionInForce } from "./_core/payrollCompensation";
import {
  APPROVAL_GATE_KINDS,
  CLOCK_VARIANCE_REVIEW_MINUTES,
  EARNING_STAGE_KINDS,
  EXCEPTION_POLICY,
  LONG_SHIFT_REVIEW_MINUTES,
  candidatesFromSources,
  exceptionConditionKey,
  localDate,
  minutesBetween,
  overlapsFor,
  periodAcceptsNewTime,
  periodAcceptsTimeApproval,
  periodForDate,
  resolvePayrollTimeApprovers,
  resolveTimeEarning,
  scheduleForProfile,
  sourceFingerprint,
  type ApproverResolution,
  type Candidate,
  type CandidateSource,
  type PayrollActivity,
  type PayrollExceptionKind,
  type SourceFact,
  type TimeEntryStatus,
} from "./_core/payrollTime";
import type { DateText } from "./_core/payrollSchedule";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db as unknown as Db;
}
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export type ProfileRow = typeof employeePayrollProfiles.$inferSelect;
export type TimeEntryRow = typeof payrollTimeEntries.$inferSelect;

/* ------------------------------------------------------------------ */
/* Exceptions                                                          */
/* ------------------------------------------------------------------ */

export type RaiseArgs = {
  kind: PayrollExceptionKind;
  financialEntityId: number;
  payPeriodId?: number | null;
  employeePayrollProfileId?: number | null;
  subjectType: string;
  subjectRef: string;
  discriminator?: string | null;
  detail: string;
  raisedByUserId?: number | null;
};

/** Raise an exception once per open condition: a second raise of the same open condition is a no-op. */
export async function raiseException(h: DbOrTx, a: RaiseArgs): Promise<void> {
  const policy = EXCEPTION_POLICY[a.kind];
  await h.insert(payrollExceptions).values({
    exceptionRef: ref("PX"),
    financialEntityId: a.financialEntityId,
    payPeriodId: a.payPeriodId ?? null,
    employeePayrollProfileId: a.employeePayrollProfileId ?? null,
    kind: a.kind,
    severity: policy.severity,
    subjectType: a.subjectType,
    subjectRef: a.subjectRef,
    conditionKey: exceptionConditionKey(a.kind, a.subjectType, a.subjectRef, a.discriminator),
    detail: a.detail.slice(0, 500),
    raisedByUserId: a.raisedByUserId ?? null,
  }).onDuplicateKeyUpdate({ set: { id: sql`id` } });
}

/** Close open exceptions of these kinds on a subject because the condition no longer holds. */
async function closeByCondition(h: DbOrTx, args: { subjectType: string; subjectRef: string; kinds: readonly PayrollExceptionKind[]; actorUserId: number; note: string }) {
  if (!args.kinds.length) return;
  await h.update(payrollExceptions)
    .set({ state: "resolved", resolvedByUserId: args.actorUserId, resolvedAt: new Date(), resolutionNote: args.note })
    .where(and(eq(payrollExceptions.subjectType, args.subjectType), eq(payrollExceptions.subjectRef, args.subjectRef), eq(payrollExceptions.state, "open"), inArray(payrollExceptions.kind, [...args.kinds])));
}

export async function openExceptionsFor(h: DbOrTx, subjectType: string, subjectRef: string) {
  return h.select().from(payrollExceptions).where(and(eq(payrollExceptions.subjectType, subjectType), eq(payrollExceptions.subjectRef, subjectRef), eq(payrollExceptions.state, "open")));
}

export async function listExceptions(args: { entityIds: readonly number[]; state?: "open" | "resolved" | "dismissed"; kind?: PayrollExceptionKind; payPeriodId?: number }) {
  const db = await dbOrThrow();
  if (!args.entityIds.length) return [];
  const where = [inArray(payrollExceptions.financialEntityId, [...args.entityIds])];
  if (args.state) where.push(eq(payrollExceptions.state, args.state));
  if (args.kind) where.push(eq(payrollExceptions.kind, args.kind));
  if (args.payPeriodId != null) where.push(eq(payrollExceptions.payPeriodId, args.payPeriodId));
  return db.select().from(payrollExceptions).where(and(...where)).orderBy(desc(payrollExceptions.id)).limit(500);
}

export async function loadException(exceptionRef: string) {
  const db = await dbOrThrow();
  return (await db.select().from(payrollExceptions).where(eq(payrollExceptions.exceptionRef, exceptionRef)).limit(1))[0] ?? null;
}

export async function resolveException(args: { id: number; state: "resolved" | "dismissed"; actorUserId: number; note: string }): Promise<boolean> {
  const db = await dbOrThrow();
  const r = await db.update(payrollExceptions)
    .set({ state: args.state, resolvedByUserId: args.actorUserId, resolvedAt: new Date(), resolutionNote: args.note })
    .where(and(eq(payrollExceptions.id, args.id), eq(payrollExceptions.state, "open")));
  return (r[0]?.affectedRows ?? 0) === 1;
}

/* ------------------------------------------------------------------ */
/* Profile → schedule → period                                         */
/* ------------------------------------------------------------------ */

export type ScheduleChain = { ok: true; scheduleId: number; timezone: string } | { ok: false; reason: string };

export async function scheduleChainFor(h: DbOrTx, profile: Pick<ProfileRow, "financialEntityId" | "payGroupId">): Promise<ScheduleChain> {
  const group = profile.payGroupId != null ? (await h.select().from(payGroups).where(eq(payGroups.id, profile.payGroupId)).limit(1))[0] ?? null : null;
  const schedule = group?.payScheduleId != null ? (await h.select().from(paySchedules).where(eq(paySchedules.id, group.payScheduleId)).limit(1))[0] ?? null : null;
  return scheduleForProfile({
    profile: { financialEntityId: profile.financialEntityId, payGroupId: profile.payGroupId },
    payGroup: group ? { id: group.id, financialEntityId: group.financialEntityId, active: group.active, payScheduleId: group.payScheduleId } : null,
    schedule: schedule ? { id: schedule.id, financialEntityId: schedule.financialEntityId, status: schedule.status, timezone: schedule.timezone } : null,
  });
}

/** The zone a profile's work dates are read in: its schedule's, else UTC (and the entry will carry a no_pay_schedule exception). */
export async function zoneFor(h: DbOrTx, profile: Pick<ProfileRow, "financialEntityId" | "payGroupId">): Promise<{ chain: ScheduleChain; timezone: string }> {
  const chain = await scheduleChainFor(h, profile);
  return { chain, timezone: chain.ok ? chain.timezone : "UTC" };
}

async function periodsOfSchedule(h: DbOrTx, scheduleId: number) {
  return (await h.select({ id: payPeriods.id, periodRef: payPeriods.periodRef, state: payPeriods.state, periodStartDate: payPeriods.periodStartDate, periodEndDate: payPeriods.periodEndDate })
    .from(payPeriods).where(eq(payPeriods.payScheduleId, scheduleId)))
    .map(p => ({ ...p, periodStartDate: dateText(p.periodStartDate), periodEndDate: dateText(p.periodEndDate) }));
}

export type PeriodPick =
  | { kind: "period"; periodId: number; periodRef: string }
  | { kind: "exception"; exception: "no_pay_schedule" | "no_matching_pay_period"; reason: string };

export async function periodPickFor(h: DbOrTx, chain: ScheduleChain, workDate: DateText): Promise<PeriodPick> {
  if (!chain.ok) return { kind: "exception", exception: "no_pay_schedule", reason: chain.reason };
  const r = periodForDate(await periodsOfSchedule(h, chain.scheduleId), workDate);
  if (r.kind === "period") return { kind: "period", periodId: r.period.id, periodRef: r.period.periodRef };
  return { kind: "exception", exception: r.exception, reason: r.reason };
}

async function lockPeriod(tx: Tx, periodId: number) {
  return (await tx.select({ id: payPeriods.id, periodRef: payPeriods.periodRef, state: payPeriods.state, financialEntityId: payPeriods.financialEntityId }).from(payPeriods).where(eq(payPeriods.id, periodId)).for("update").limit(1))[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Operational sources → facts (read-only)                             */
/* ------------------------------------------------------------------ */

/** The worker's own operator record in the caller's organization, or null (no operator-keyed sources then). */
export async function operatorForProfile(profile: Pick<ProfileRow, "operatorId" | "userId">, scope: TenantScope): Promise<number | null> {
  if (profile.operatorId != null) return (await operatorInScope(profile.operatorId, scope)) ? profile.operatorId : null;
  if (profile.userId == null) return null;
  const r = await operatorForUserInScope(profile.userId, scope);
  return r.kind === "resolved" ? r.operatorId : null;
}

const hosFact = (r: typeof dutyRecords.$inferSelect): SourceFact => ({
  sourceType: "hos_duty",
  sourceRef: `dutyRecords:${r.id}`,
  segment: null,
  // Duty records are insert-only (no update path exists); their material facts are their version.
  sourceVersion: null,
  material: { operatorId: r.operatorId, dutyStatus: r.dutyStatus, durationMinutes: r.durationMinutes, tripId: r.tripId },
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  measurementAuthority: "regulatory_duty_record",
  activity: r.dutyStatus === "driving" ? "driving" : "on_location",
  tripId: r.tripId,
  blockedReason: r.endedAt ? null : "The duty interval is still open",
});

const bookingFact = (r: typeof resourceBookings.$inferSelect): SourceFact => ({
  sourceType: "dispatch_booking",
  sourceRef: `resourceBookings:${r.id}`,
  segment: null,
  sourceVersion: null,
  material: { resourceRef: r.resourceRef, jobId: r.jobId, postingId: r.postingId, bookingState: r.bookingState },
  startedAt: r.startsAt,
  endedAt: r.endsAt,
  measurementAuthority: "planned",
  activity: "on_location",
  jobId: r.jobId,
  blockedReason: r.bookingState === "confirmed" ? null : `The booking is ${r.bookingState}, not confirmed`,
});

const tripFact = (r: typeof trips.$inferSelect): SourceFact => ({
  sourceType: "trip",
  sourceRef: r.tripNumber,
  sourceVersion: iso(r.updatedAt),
  material: { operatorId: r.operatorId, jobId: r.jobId, unitId: r.unitId, status: r.status, distanceKm: r.distanceKm },
  startedAt: r.startedAt,
  endedAt: r.completedAt,
  quantity: r.distanceKm != null ? { value: r.distanceKm, unit: "km" } : null,
  measurementAuthority: "trip_record",
  jobId: r.jobId,
  unitId: r.unitId,
  tripId: r.id,
});

const loadFact = (r: typeof loads.$inferSelect): SourceFact => ({
  sourceType: "load",
  sourceRef: r.loadNumber,
  sourceVersion: null,
  material: { operatorId: r.operatorId, jobId: r.jobId, unitId: r.unitId, quantity: r.quantity, quantityUnit: r.quantityUnit, measurementMethod: r.measurementMethod, chainState: r.chainState },
  startedAt: r.createdAt,
  endedAt: null,
  quantity: r.quantity != null ? { value: r.quantity, unit: r.quantityUnit ?? "unknown" } : null,
  measurementAuthority: r.measurementMethod ?? "unknown",
  jobId: r.jobId,
  unitId: r.unitId,
  tripId: r.tripId,
});

function ticketFact(r: typeof fieldTickets.$inferSelect, rev: { revision: number; snapshotHash: string; kind: string } | null): SourceFact {
  const closed = r.status === "closed" || r.status === "amended_after_signature";
  return {
    sourceType: "field_ticket",
    sourceRef: r.ticketNumber,
    segment: null,
    // The sealed revision is the ticket's version. A ticket with no revision is versioned only by its material facts.
    sourceVersion: rev ? `rev${rev.revision}:${rev.snapshotHash}` : null,
    material: { operatorId: r.operatorId, jobId: r.jobId, unitId: r.unitId, status: r.status, signatureStatus: r.signatureStatus },
    startedAt: r.startedAt,
    endedAt: r.completedAt,
    measurementAuthority: rev ? "sealed_field_ticket" : "field_ticket",
    activity: "on_location",
    jobId: r.jobId,
    unitId: r.unitId,
    tripId: r.tripId,
    warnings: rev ? [] : ["The ticket has no sealed revision; its facts are not versioned"],
    blockedReason: closed || rev ? null : `The field ticket is ${r.status} and unsigned; only a closed or sealed ticket is evidence of time worked`,
  };
}

async function latestRevision(h: DbOrTx, fieldTicketId: number) {
  return (await h.select({ revision: fieldTicketRevisions.revision, snapshotHash: fieldTicketRevisions.snapshotHash, kind: fieldTicketRevisions.kind })
    .from(fieldTicketRevisions).where(eq(fieldTicketRevisions.fieldTicketId, fieldTicketId)).orderBy(desc(fieldTicketRevisions.revision)).limit(1))[0] ?? null;
}

const jobOwned = (scope: TenantScope) => sql`${fieldTickets.jobId} IN (SELECT ${jobs.id} FROM ${jobs} WHERE ${orgScopeWhere(jobs, scope)})`;

/** Every operational fact for one operator in [from, to), read inside the caller's organization. */
export async function sourceFactsFor(args: { operatorId: number; scope: TenantScope; from: Date; to: Date }): Promise<SourceFact[]> {
  const db = await dbOrThrow();
  const { operatorId, scope, from, to } = args;
  const facts: SourceFact[] = [];
  const duty = await db.select().from(dutyRecords)
    .where(and(eq(dutyRecords.operatorId, operatorId), ownershipScopeWhere("operator", dutyRecords.operatorId, scope), gte(dutyRecords.startedAt, from), lt(dutyRecords.startedAt, to), inArray(dutyRecords.dutyStatus, ["driving", "on_duty"])))
    .orderBy(asc(dutyRecords.startedAt)).limit(500);
  facts.push(...duty.map(hosFact));
  // SPINE item 2: a booking's window and state are read only through the one booking rule. The operator's bookings
  // that hold them over the window are exactly the bookings that are candidates (released and cancelled ones are not work).
  const bookings = await db.select().from(resourceBookings)
    .where(conflictingBookingsWhere({ type: "operator", ref: String(operatorId) }, { startsAt: from, endsAt: to }))
    .limit(500);
  for (const b of bookings) {
    // A booking names the operator by id; its job, when it has one, must be the caller's organization's too.
    if (b.jobId != null && !(await jobInScope(b.jobId, scope))) continue;
    facts.push(bookingFact(b));
  }
  const tripRows = await db.select().from(trips)
    .where(and(eq(trips.operatorId, operatorId), orgScopeWhere(trips, scope), gte(trips.startedAt, from), lt(trips.startedAt, to))).limit(500);
  facts.push(...tripRows.map(tripFact));
  const loadRows = await db.select().from(loads)
    .where(and(eq(loads.operatorId, operatorId), sql`${loads.jobId} IN (SELECT ${jobs.id} FROM ${jobs} WHERE ${orgScopeWhere(jobs, scope)})`, gte(loads.createdAt, from), lt(loads.createdAt, to))).limit(500);
  facts.push(...loadRows.map(loadFact));
  const tickets = await db.select().from(fieldTickets)
    .where(and(eq(fieldTickets.operatorId, operatorId), jobOwned(scope), gte(fieldTickets.startedAt, from), lt(fieldTickets.startedAt, to))).limit(500);
  for (const t of tickets) facts.push(ticketFact(t, await latestRevision(db, t.id)));
  return facts;
}

/**
 * Re-read one source by its identity, scoped, optionally `FOR UPDATE` inside an approval transaction so a concurrent
 * edit to the source either waits for the approval or is seen by it. Null when the source is gone or no longer the
 * caller's organization's, or no longer this operator's.
 */
export async function reloadSourceFact(h: DbOrTx, args: { sourceType: CandidateSource; sourceRef: string; operatorId: number; scope: TenantScope; lock: boolean }): Promise<SourceFact | null> {
  const { sourceType, sourceRef, operatorId, scope, lock } = args;
  const idOf = (prefix: string) => (sourceRef.startsWith(`${prefix}:`) ? Number(sourceRef.slice(prefix.length + 1)) : NaN);
  if (sourceType === "hos_duty") {
    const id = idOf("dutyRecords");
    if (!Number.isInteger(id)) return null;
    const q = h.select().from(dutyRecords).where(and(eq(dutyRecords.id, id), eq(dutyRecords.operatorId, operatorId), ownershipScopeWhere("operator", dutyRecords.operatorId, scope))).limit(1);
    const r = (await (lock ? q.for("update") : q))[0];
    return r ? hosFact(r) : null;
  }
  if (sourceType === "dispatch_booking") {
    const id = idOf("resourceBookings");
    if (!Number.isInteger(id)) return null;
    const q = h.select().from(resourceBookings).where(and(eq(resourceBookings.id, id), eq(resourceBookings.resourceType, "operator"), eq(resourceBookings.resourceRef, String(operatorId)))).limit(1);
    const r = (await (lock ? q.for("update") : q))[0];
    if (!r || (r.jobId != null && !(await jobInScope(r.jobId, scope)))) return null;
    return bookingFact(r);
  }
  if (sourceType === "field_ticket") {
    const q = h.select().from(fieldTickets).where(and(eq(fieldTickets.ticketNumber, sourceRef), eq(fieldTickets.operatorId, operatorId), jobOwned(scope))).limit(1);
    const r = (await (lock ? q.for("update") : q))[0];
    return r ? ticketFact(r, await latestRevision(h, r.id)) : null;
  }
  if (sourceType === "trip") {
    const q = h.select().from(trips).where(and(eq(trips.tripNumber, sourceRef), eq(trips.operatorId, operatorId), orgScopeWhere(trips, scope))).limit(1);
    const r = (await (lock ? q.for("update") : q))[0];
    return r ? tripFact(r) : null;
  }
  const q = h.select().from(loads).where(and(eq(loads.loadNumber, sourceRef), eq(loads.operatorId, operatorId), sql`${loads.jobId} IN (SELECT ${jobs.id} FROM ${jobs} WHERE ${orgScopeWhere(jobs, scope)})`)).limit(1);
  const r = (await (lock ? q.for("update") : q))[0];
  return r ? loadFact(r) : null;
}

/** Effective entries carrying any of these source keys, keyed by candidate key → entryRef. */
async function submittedKeys(h: DbOrTx, keys: readonly string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await h.select({ k: payrollTimeEntries.effectiveSourceKey, r: payrollTimeEntries.entryRef }).from(payrollTimeEntries).where(inArray(payrollTimeEntries.effectiveSourceKey, [...keys]));
  return new Map(rows.filter(x => x.k).map(x => [x.k!, x.r ?? "(legacy entry)"]));
}

/** Read-only candidates for one profile over [from, through]. Writes nothing, whatever it finds. */
export async function candidatesForProfile(args: { profile: ProfileRow; scope: TenantScope; from: DateText; through: DateText }): Promise<{ candidates: Candidate[]; timezone: string; operatorResolved: boolean }> {
  const db = await dbOrThrow();
  const { timezone } = await zoneFor(db, args.profile);
  const operatorId = await operatorForProfile(args.profile, args.scope);
  if (operatorId == null) return { candidates: [], timezone, operatorResolved: false };
  // A day either side, then filtered to the schedule's calendar dates: an instant's date depends on the zone.
  const from = new Date(`${args.from}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${args.through}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 2);
  const facts = await sourceFactsFor({ operatorId, scope: args.scope, from, to });
  const draft = candidatesFromSources({ employeePayrollProfileId: args.profile.id, timezone, facts });
  const submitted = await submittedKeys(db, draft.map(c => c.candidateKey));
  const candidates = candidatesFromSources({ employeePayrollProfileId: args.profile.id, timezone, facts, submitted })
    .filter(c => c.workDate == null || (c.workDate >= args.from && c.workDate <= args.through));
  return { candidates, timezone, operatorResolved: true };
}

/* ------------------------------------------------------------------ */
/* Classification and employment                                       */
/* ------------------------------------------------------------------ */

/** True when the person is an owner-operator in the book's organization: contractor settlement, never employee time. */
export async function isOwnerOperator(profile: ProfileRow): Promise<boolean> {
  if (profile.workerClassification === "OWNER_DRIVER") return true;
  const db = await dbOrThrow();
  const rows = await db.select({ workerType: organizationWorkers.workerType }).from(organizationWorkers)
    .where(and(eq(organizationWorkers.status, "active"), or(profile.userId != null ? eq(organizationWorkers.userId, profile.userId) : sql`false`, profile.operatorId != null ? eq(organizationWorkers.operatorId, profile.operatorId) : sql`false`)));
  return rows.some(r => r.workerType === "OWNER_DRIVER");
}

function employmentProblem(profile: ProfileRow, workDate: DateText): string | null {
  if (profile.payrollStatus === "terminated" || profile.payrollStatus === "suspended") return `The payroll profile is ${profile.payrollStatus}`;
  const from = profile.effectiveFrom ? profile.effectiveFrom.toISOString().slice(0, 10) : null;
  if (from && workDate < from) return `The work date ${workDate} is before the profile's employment start ${from}`;
  const term = profile.terminatedAt ? profile.terminatedAt.toISOString().slice(0, 10) : null;
  if (term && workDate >= term) return `The work date ${workDate} is on or after the profile's termination ${term}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

export async function loadEntryByRef(entryRef: string) {
  const db = await dbOrThrow();
  return (await db.select().from(payrollTimeEntries).where(eq(payrollTimeEntries.entryRef, entryRef)).limit(1))[0] ?? null;
}

export async function listEntriesForProfiles(profileIds: readonly number[], filter?: { statuses?: readonly TimeEntryStatus[]; from?: Date; to?: Date }) {
  if (!profileIds.length) return [];
  const db = await dbOrThrow();
  const where = [inArray(payrollTimeEntries.employeePayrollProfileId, [...profileIds])];
  if (filter?.statuses?.length) where.push(inArray(payrollTimeEntries.status, [...filter.statuses]));
  if (filter?.from) where.push(gte(payrollTimeEntries.startedAt, filter.from));
  if (filter?.to) where.push(lt(payrollTimeEntries.startedAt, filter.to));
  return db.select().from(payrollTimeEntries).where(and(...where)).orderBy(desc(payrollTimeEntries.startedAt), desc(payrollTimeEntries.id)).limit(1000);
}

export type SourceProvenance = {
  sourceType: CandidateSource;
  sourceRef: string;
  segment: string | null;
  candidateKey: string;
  sourceVersion: string | null;
  sourceFingerprint: string;
  candidateMinutes: number | null;
};

export type SubmitArgs = {
  profile: ProfileRow;
  actorUserId: number;
  state: "open" | "submitted";
  activity: PayrollActivity;
  startedAt: Date;
  endedAt: Date | null;
  earningCode: string | null;
  jobId: number | null;
  unitId: number | null;
  tripId: number | null;
  notes: string | null;
  locationText: string | null;
  clientCaptureRef: string | null;
  capturedAt: Date | null;
  deviceRef: string | null;
  source: "employee_submitted" | "dispatch_schedule" | "field_ticket" | "time_clock";
  provenance: SourceProvenance | null;
  /** Replace this submitted entry (a correction): it is superseded, never rewritten. */
  supersedes: { id: number } | null;
  /** Promote this open draft to submitted instead of inserting. */
  promote: { id: number } | null;
};

export type SubmitOutcome =
  | { outcome: "created"; entryRef: string; status: "open" | "submitted"; payPeriodId: number | null; exceptions: PayrollExceptionKind[] }
  | { outcome: "replayed"; entryRef: string; status: TimeEntryStatus }
  | { outcome: "refused"; code: "PRECONDITION_FAILED" | "CONFLICT"; kind: PayrollExceptionKind | null; message: string };

const isDuplicate = (e: unknown): boolean => {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    const x = c as { code?: unknown; errno?: unknown };
    if (x.code === "ER_DUP_ENTRY" || x.errno === 1062) return true;
  }
  return false;
};

/**
 * Create (or promote, or correct) a time entry. One transaction: the profile row is locked first, then the capture ref
 * is checked (a replay returns the existing entry), then the period is locked and must be OPEN, then overlaps and the
 * source key are decided, then the row is written, then its exceptions. Refusals that should leave a record write
 * their exception after the transaction rolls back.
 */
export async function submitEntry(a: SubmitArgs): Promise<SubmitOutcome> {
  const db = await dbOrThrow();
  const { chain, timezone } = await zoneFor(db, a.profile);
  const workDate = localDate(a.startedAt, timezone);
  const minutes = a.endedAt ? minutesBetween(a.startedAt, a.endedAt) : null;
  const subjectForRefusal = a.clientCaptureRef ?? a.provenance?.candidateKey ?? `${a.profile.id}:${a.startedAt.toISOString()}`;
  let refusalException: RaiseArgs | null = null;
  try {
    const out = await db.transaction(async (tx: Tx): Promise<SubmitOutcome> => {
      await tx.select({ id: employeePayrollProfiles.id }).from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, a.profile.id)).for("update").limit(1);
      if (a.clientCaptureRef && !a.promote) {
        const prior = (await tx.select({ entryRef: payrollTimeEntries.entryRef, status: payrollTimeEntries.status }).from(payrollTimeEntries)
          .where(and(eq(payrollTimeEntries.employeePayrollProfileId, a.profile.id), eq(payrollTimeEntries.clientCaptureRef, a.clientCaptureRef))).limit(1))[0];
        if (prior) return { outcome: "replayed", entryRef: prior.entryRef ?? "(legacy entry)", status: prior.status };
      }
      // The period is decided only for a submission; a draft is not yet a claim on any period.
      let payPeriodId: number | null = null;
      const pending: RaiseArgs[] = [];
      if (a.state === "submitted") {
        const pick = await periodPickFor(tx, chain, workDate);
        if (pick.kind === "period") {
          const p = await lockPeriod(tx, pick.periodId);
          if (!p || !periodAcceptsNewTime(p.state)) {
            refusalException = { kind: "locked_pay_period", financialEntityId: a.profile.financialEntityId, payPeriodId: pick.periodId, employeePayrollProfileId: a.profile.id, subjectType: "submission", subjectRef: subjectForRefusal, detail: `Pay period ${pick.periodRef} is ${p?.state ?? "missing"}; new time is submitted only into an open period`, raisedByUserId: a.actorUserId };
            return { outcome: "refused", code: "PRECONDITION_FAILED", kind: "locked_pay_period", message: `Pay period ${pick.periodRef} is ${p?.state ?? "missing"}; new time is submitted only into an open period. A correction after the cutoff needs the period reopened.` };
          }
          payPeriodId = p.id;
        } else {
          pending.push({ kind: pick.exception, financialEntityId: a.profile.financialEntityId, employeePayrollProfileId: a.profile.id, subjectType: "time_entry", subjectRef: "", detail: pick.reason, raisedByUserId: a.actorUserId });
        }
      }
      // A source segment already carried by an effective entry is refused, not duplicated.
      if (a.provenance) {
        const holder = (await tx.select({ id: payrollTimeEntries.id, entryRef: payrollTimeEntries.entryRef }).from(payrollTimeEntries).where(eq(payrollTimeEntries.effectiveSourceKey, a.provenance.candidateKey)).limit(1))[0];
        if (holder && holder.id !== a.supersedes?.id && holder.id !== a.promote?.id) {
          refusalException = { kind: "duplicate_entry", financialEntityId: a.profile.financialEntityId, employeePayrollProfileId: a.profile.id, subjectType: "source", subjectRef: `${a.provenance.sourceType}:${a.provenance.sourceRef}`, discriminator: a.provenance.segment, detail: `This source segment is already submitted as ${holder.entryRef ?? "an earlier entry"}`, raisedByUserId: a.actorUserId };
          return { outcome: "refused", code: "CONFLICT", kind: "duplicate_entry", message: `This source is already submitted as ${holder.entryRef ?? "an earlier entry"}; one source segment is one payable entry` };
        }
      }
      const entryRef = ref("PT");
      const values = {
        employeePayrollProfileId: a.profile.id, payPeriodId, activity: a.activity, startedAt: a.startedAt, endedAt: a.endedAt, minutes,
        source: a.source, confirmedByEmployee: a.state === "submitted", jobId: a.jobId, tripId: a.tripId, unitId: a.unitId, status: a.state,
        workDate, earningCode: a.earningCode, sourceRecordType: a.provenance?.sourceType ?? null, sourceRecordRef: a.provenance?.sourceRef ?? null,
        sourceSegment: a.provenance?.segment ?? null, sourceVersion: a.provenance?.sourceVersion ?? null, sourceFingerprint: a.provenance?.sourceFingerprint ?? null,
        notes: a.notes, locationText: a.locationText, capturedAt: a.capturedAt, deviceRef: a.deviceRef,
        submittedByUserId: a.state === "submitted" ? a.actorUserId : null, submittedAt: a.state === "submitted" ? new Date() : null,
      };
      let id: number;
      let finalRef = entryRef;
      if (a.promote) {
        const cur = (await tx.select().from(payrollTimeEntries).where(eq(payrollTimeEntries.id, a.promote.id)).for("update").limit(1))[0];
        if (!cur || cur.status !== "open") return { outcome: "refused", code: "PRECONDITION_FAILED", kind: null, message: "Only an open draft is submitted" };
        await tx.update(payrollTimeEntries).set({ ...values, candidateKey: a.provenance?.candidateKey ?? cur.candidateKey }).where(eq(payrollTimeEntries.id, cur.id));
        id = cur.id; finalRef = cur.entryRef!;
      } else {
        // Insert without the source key first, so a correction can retire the row it replaces before the key moves.
        const r = await tx.insert(payrollTimeEntries).values({ ...values, entryRef, clientCaptureRef: a.clientCaptureRef, createdByUserId: a.actorUserId, supersedesEntryId: a.supersedes?.id ?? null, candidateKey: null });
        id = Number(r[0]?.insertId);
        if (a.supersedes) {
          const old = (await tx.select().from(payrollTimeEntries).where(eq(payrollTimeEntries.id, a.supersedes.id)).for("update").limit(1))[0];
          if (!old || old.supersededByEntryId != null || old.status !== "submitted") throw Object.assign(new Error("Only a submitted, current entry is corrected"), { code: "PRECONDITION_FAILED" });
          await tx.update(payrollTimeEntries).set({ supersededByEntryId: id }).where(eq(payrollTimeEntries.id, old.id));
          if (old.entryRef) await closeByCondition(tx, { subjectType: "time_entry", subjectRef: old.entryRef, kinds: ["overlapping_entries", "source_changed_after_preparation", "no_pay_schedule", "no_matching_pay_period", "no_valid_approver", "self_approval_blocked"], actorUserId: a.actorUserId, note: `Superseded by ${entryRef}` });
        }
        if (a.provenance) await tx.update(payrollTimeEntries).set({ candidateKey: a.provenance.candidateKey }).where(eq(payrollTimeEntries.id, id));
      }
      const exceptions: PayrollExceptionKind[] = [];
      if (a.state === "submitted") {
        for (const p of pending) { await raiseException(tx, { ...p, subjectRef: finalRef }); exceptions.push(p.kind); }
        const problem = employmentProblem(a.profile, workDate);
        if (problem) { await raiseException(tx, { kind: "outside_employment", financialEntityId: a.profile.financialEntityId, payPeriodId, employeePayrollProfileId: a.profile.id, subjectType: "time_entry", subjectRef: finalRef, detail: problem, raisedByUserId: a.actorUserId }); exceptions.push("outside_employment"); }
        if (a.endedAt) {
          const others = await tx.select().from(payrollTimeEntries).where(and(eq(payrollTimeEntries.employeePayrollProfileId, a.profile.id), ne(payrollTimeEntries.id, id), lt(payrollTimeEntries.startedAt, a.endedAt)));
          for (const o of overlapsFor({ startedAt: a.startedAt, endedAt: a.endedAt }, others.map(x => ({ ...x, status: x.status as TimeEntryStatus })))) {
            await raiseException(tx, { kind: "overlapping_entries", financialEntityId: a.profile.financialEntityId, payPeriodId, employeePayrollProfileId: a.profile.id, subjectType: "time_entry", subjectRef: finalRef, discriminator: o.entryRef ?? String(o.id), detail: `Overlaps ${o.entryRef ?? `entry ${o.id}`} (${o.startedAt.toISOString()}–${o.endedAt?.toISOString()}); neither is changed — a person decides`, raisedByUserId: a.actorUserId });
            if (o.entryRef) await raiseException(tx, { kind: "overlapping_entries", financialEntityId: a.profile.financialEntityId, payPeriodId: o.payPeriodId, employeePayrollProfileId: a.profile.id, subjectType: "time_entry", subjectRef: o.entryRef, discriminator: finalRef, detail: `Overlaps ${finalRef}; neither is changed — a person decides`, raisedByUserId: a.actorUserId });
            if (!exceptions.includes("overlapping_entries")) exceptions.push("overlapping_entries");
          }
          if (minutes! > LONG_SHIFT_REVIEW_MINUTES) { await raiseException(tx, { kind: "long_shift", financialEntityId: a.profile.financialEntityId, payPeriodId, employeePayrollProfileId: a.profile.id, subjectType: "time_entry", subjectRef: finalRef, detail: `A single entry of ${minutes} minutes; review it (a diagnostic, not a compliance decision)`, raisedByUserId: a.actorUserId }); exceptions.push("long_shift"); }
          if (a.provenance?.candidateMinutes != null && Math.abs(minutes! - a.provenance.candidateMinutes) > CLOCK_VARIANCE_REVIEW_MINUTES) {
            await raiseException(tx, { kind: "clock_variance", financialEntityId: a.profile.financialEntityId, payPeriodId, employeePayrollProfileId: a.profile.id, subjectType: "time_entry", subjectRef: finalRef, detail: `Submitted ${minutes} minutes; the ${a.provenance.sourceType} source shows ${a.provenance.candidateMinutes}. Different clocks may differ; review it`, raisedByUserId: a.actorUserId });
            exceptions.push("clock_variance");
          }
        }
      }
      return { outcome: "created", entryRef: finalRef, status: a.state, payPeriodId, exceptions };
    });
    if (out.outcome === "refused" && refusalException) await raiseException(db, refusalException);
    return out;
  } catch (e) {
    if (isDuplicate(e)) {
      // Lost a race the profile lock did not cover (a source held by another profile), or a capture replay.
      if (a.clientCaptureRef) {
        const prior = (await db.select({ entryRef: payrollTimeEntries.entryRef, status: payrollTimeEntries.status }).from(payrollTimeEntries)
          .where(and(eq(payrollTimeEntries.employeePayrollProfileId, a.profile.id), eq(payrollTimeEntries.clientCaptureRef, a.clientCaptureRef))).limit(1))[0];
        if (prior) return { outcome: "replayed", entryRef: prior.entryRef ?? "(legacy entry)", status: prior.status };
      }
      if (a.provenance) await raiseException(db, { kind: "duplicate_entry", financialEntityId: a.profile.financialEntityId, employeePayrollProfileId: a.profile.id, subjectType: "source", subjectRef: `${a.provenance.sourceType}:${a.provenance.sourceRef}`, discriminator: a.provenance.segment, detail: "This source segment is already submitted", raisedByUserId: a.actorUserId });
      return { outcome: "refused", code: "CONFLICT", kind: "duplicate_entry", message: "This time is already submitted; one source segment is one payable entry" };
    }
    throw e;
  }
}

/** Edit an open draft in place. A draft is the worker's own scratch: nothing about it is history yet. */
export async function updateDraft(args: { id: number; set: Partial<Pick<TimeEntryRow, "activity" | "startedAt" | "endedAt" | "minutes" | "earningCode" | "jobId" | "unitId" | "tripId" | "notes" | "locationText">> }): Promise<boolean> {
  const db = await dbOrThrow();
  const r = await db.update(payrollTimeEntries).set(args.set).where(and(eq(payrollTimeEntries.id, args.id), eq(payrollTimeEntries.status, "open")));
  return (r[0]?.affectedRows ?? 0) === 1;
}

/** The worker takes back their own draft or submitted entry. It stays visible as void, with who and why. */
export async function withdrawEntry(args: { id: number; actorUserId: number; reason: string }): Promise<boolean> {
  const db = await dbOrThrow();
  const r = await db.update(payrollTimeEntries)
    .set({ status: "void", withdrawnByUserId: args.actorUserId, withdrawnAt: new Date(), withdrawReason: args.reason })
    .where(and(eq(payrollTimeEntries.id, args.id), inArray(payrollTimeEntries.status, ["open", "submitted"]), isNull(payrollTimeEntries.supersededByEntryId)));
  return (r[0]?.affectedRows ?? 0) === 1;
}

/* ------------------------------------------------------------------ */
/* D10 — approvers                                                     */
/* ------------------------------------------------------------------ */

const activeAt = (m: { joinedAt: Date; leftAt: Date | null }, at: Date) => m.joinedAt.getTime() <= at.getTime() && (m.leftAt == null || at.getTime() < m.leftAt.getTime());

/** The book's payroll administrators: a live `payroll_admin` grant that reaches the organization, and a live membership in it. */
export async function payrollAdminsOf(h: DbOrTx, orgRef: string): Promise<number[]> {
  const rows = await h.select({ userId: userRoleAssignments.userId, role: userRoleAssignments.role, scopeType: userRoleAssignments.scopeType, orgRef: userRoleAssignments.orgRef })
    .from(userRoleAssignments)
    .innerJoin(organizationMemberships, and(eq(organizationMemberships.userId, userRoleAssignments.userId), eq(organizationMemberships.orgRef, orgRef), eq(organizationMemberships.status, "active")))
    .where(and(eq(userRoleAssignments.role, "payroll_admin"), isNull(userRoleAssignments.revokedAt)));
  return Array.from(new Set(rows.filter(r => grantsInOrganization([r as unknown as RoleGrant], orgRef).length > 0).map(r => r.userId)));
}

/**
 * D10 for one entry: the worker's crews in this organization at the time worked, and those crews' supervisors as
 * they stand now (a supervisor who has left the crew no longer approves for it); else the book's payroll admins.
 */
export async function approversFor(h: DbOrTx, args: { workerUserId: number | null; workedAt: Date; orgRef: string; now?: Date }): Promise<ApproverResolution & { crewRefs: string[] }> {
  const now = args.now ?? new Date();
  const admins = await payrollAdminsOf(h, args.orgRef);
  if (args.workerUserId == null) {
    const r = resolvePayrollTimeApprovers({ workerUserId: -1, memberships: [], payrollAdminUserIds: admins });
    return { ...r, crewRefs: [] };
  }
  const orgCrews = await h.select({ id: crews.id, crewRef: crews.crewRef }).from(crews).where(and(eq(crews.tenantId, args.orgRef), eq(crews.state, "active")));
  const byRef = new Map(orgCrews.map(c => [c.crewRef, c.id]));
  const rows = orgCrews.length ? await h.select().from(crewMembers).where(inArray(crewMembers.crewRef, orgCrews.map(c => c.crewRef))) : [];
  const memberships = rows.map(m => ({
    crewId: byRef.get(m.crewRef)!,
    userId: m.userId,
    crewRole: m.crewRole,
    active: m.userId === args.workerUserId ? activeAt(m, args.workedAt) : activeAt(m, now),
  }));
  const r = resolvePayrollTimeApprovers({ workerUserId: args.workerUserId, memberships, payrollAdminUserIds: admins });
  const idToRef = new Map(orgCrews.map(c => [c.id, c.crewRef]));
  return { ...r, crewRefs: r.route === "crew_supervisor" ? r.crewIds.map(i => idToRef.get(i)!) : [] };
}

/** The user ids whose time this caller may see in a team view: the current members of crews the caller supervises now. */
export async function supervisedUserIds(h: DbOrTx, args: { supervisorUserId: number; orgRef: string; now?: Date }): Promise<number[]> {
  const now = args.now ?? new Date();
  const orgCrews = await h.select({ crewRef: crews.crewRef }).from(crews).where(and(eq(crews.tenantId, args.orgRef), eq(crews.state, "active")));
  if (!orgCrews.length) return [];
  const rows = await h.select().from(crewMembers).where(inArray(crewMembers.crewRef, orgCrews.map(c => c.crewRef)));
  const mine = new Set(rows.filter(m => m.userId === args.supervisorUserId && m.crewRole === "supervisor" && activeAt(m, now)).map(m => m.crewRef));
  // A worker's past membership still routes their past time to this supervisor (approversFor uses the time worked).
  return Array.from(new Set(rows.filter(m => mine.has(m.crewRef) && m.userId !== args.supervisorUserId).map(m => m.userId)));
}

/* ------------------------------------------------------------------ */
/* Approval, rejection, and the time → earning step                    */
/* ------------------------------------------------------------------ */

export type ApproveOutcome =
  | { outcome: "approved"; entryRef: string; payPeriodId: number; earning: { earningRef: string; amountCents: number } | null; earningBlockedBy: PayrollExceptionKind | null; earningBlockedReason: string | null }
  | { outcome: "refused"; code: "FORBIDDEN" | "PRECONDITION_FAILED"; kind: PayrollExceptionKind | null; message: string };

/** Agreement → version in force → the version's rule for the code, priced from the approved P1 version only. */
async function priceTime(h: DbOrTx, args: { profile: ProfileRow; workDate: DateText; minutes: number | null; earningCode: string | null; jobId: number | null; unitId: number | null }) {
  const code = args.earningCode ? await resolveEarningCode(args.earningCode, args.profile.financialEntityId, args.workDate) : null;
  const agreements = (await h.select().from(compensationAgreements).where(eq(compensationAgreements.employeePayrollProfileId, args.profile.id)))
    .map(a => ({ ...a, startsOn: dateText(a.startsOn)!, endsOn: dateText(a.endsOn) }))
    .filter(a => a.startsOn <= args.workDate && (a.endsOn == null || args.workDate < a.endsOn));
  let inForce: { kind: "version"; versionRef: string; rulesHash: string } | { kind: "none" | "integrity_error"; reason: string } | null = null;
  let versionId: number | null = null;
  if (agreements.length > 1) inForce = { kind: "integrity_error", reason: `${agreements.length} compensation agreements cover ${args.workDate}` };
  else if (agreements.length === 1) {
    const versions = (await h.select().from(compensationAgreementVersions).where(eq(compensationAgreementVersions.agreementId, agreements[0]!.id)))
      .map(v => ({ ...v, effectiveFrom: dateText(v.effectiveFrom)!, effectiveUntil: dateText(v.effectiveUntil) }));
    const r = versionInForce(versions.map(v => ({ versionRef: v.versionRef, status: v.status, effectiveFrom: v.effectiveFrom, effectiveUntil: v.effectiveUntil })), args.workDate);
    if (r.kind === "version") {
      const v = versions.find(x => x.versionRef === r.version.versionRef)!;
      inForce = { kind: "version", versionRef: v.versionRef, rulesHash: v.rulesHash };
      versionId = v.id;
    } else inForce = { kind: r.kind, reason: r.reason };
  }
  const rule = versionId != null && code
    ? (await h.select().from(compensationEarningRules).where(and(eq(compensationEarningRules.versionId, versionId), eq(compensationEarningRules.earningCode, code.code))).limit(1))[0] ?? null
    : null;
  const priced = resolveTimeEarning({
    entry: { workDate: args.workDate, minutes: args.minutes, earningCode: args.earningCode, jobId: args.jobId, unitId: args.unitId },
    code: code ? { code: code.code, calculationType: code.calculationType, requiresJob: code.requiresJob, requiresUnit: code.requiresUnit } : null,
    inForce,
    rule: rule ? { id: rule.id, earningCode: rule.earningCode, calculation: rule.calculation, unit: rule.unit, rateMillis: rule.rateMillis, requiresJob: rule.requiresJob, requiresUnit: rule.requiresUnit } : null,
  });
  return { priced, versionId };
}

/**
 * Generate the approved earning for approved time, inside the caller's transaction (period already locked). An entry
 * produces at most one earning (unique `payrollTimeEntryId`). It is never placed on a pay run: `runCollect` is the
 * only way an earning reaches one.
 */
async function generateEarningInTx(tx: Tx, args: { entry: TimeEntryRow; profile: ProfileRow; payPeriodId: number; approvedByUserId: number; actorUserId: number }) {
  const e = args.entry;
  const workDate = dateText(e.workDate)!;
  const { priced, versionId } = await priceTime(tx, { profile: args.profile, workDate, minutes: e.minutes, earningCode: e.earningCode, jobId: e.jobId, unitId: e.unitId });
  if (!priced.ok) {
    await raiseException(tx, { kind: priced.exception, financialEntityId: args.profile.financialEntityId, payPeriodId: args.payPeriodId, employeePayrollProfileId: args.profile.id, subjectType: "time_entry", subjectRef: e.entryRef!, detail: `${priced.reason}. No earning was created; the approved time stands.`, raisedByUserId: args.actorUserId });
    return { earning: null, blockedBy: priced.exception, reason: priced.reason };
  }
  const earningRef = `ERN-${e.entryRef}`;
  const r = await tx.insert(payrollEarningEvents).values({
    earningRef, employeePayrollProfileId: args.profile.id, payPeriodId: args.payPeriodId, earningType: priced.earningCode, source: "approved_timesheet",
    sourceRecordRef: e.entryRef, quantity: priced.minutes / 60, unit: "hour",
    rateKeyVersion: `${priced.versionRef}:${priced.earningCode}`,
    // The integer shadows are authoritative (B22.3); the legacy doubles are derived from them, never the reverse.
    rateAppliedMillis: priced.rateMillis, rateApplied: priced.rateMillis / 1000,
    calculatedAmountCents: priced.amountCents, calculatedAmount: priced.amountCents / 100,
    measurementAuthority: e.sourceRecordType ? `time_from_${e.sourceRecordType}` : "worker_submitted_time",
    status: "approved",
    earningCode: priced.earningCode, compensationAgreementVersionId: versionId, agreementVersionRef: priced.versionRef, rulesHash: priced.rulesHash,
    compensationRuleId: priced.ruleId, payrollTimeEntryId: e.id, workDate, workedMinutes: priced.minutes,
    approvedByUserId: args.approvedByUserId, approvedAt: new Date(),
  });
  await tx.update(payrollTimeEntries).set({ payrollEarningEventId: Number(r[0]?.insertId) }).where(eq(payrollTimeEntries.id, e.id));
  await closeByCondition(tx, { subjectType: "time_entry", subjectRef: e.entryRef!, kinds: EARNING_STAGE_KINDS, actorUserId: args.actorUserId, note: `Earning ${earningRef} priced from ${priced.versionRef}` });
  return { earning: { earningRef, amountCents: priced.amountCents }, blockedBy: null, reason: null };
}

/**
 * Approve one submitted entry. In one transaction: the entry and its period are locked; the claimant and the submitter
 * are refused; the approver must be the entry's D10 approver; the period must still take approvals; open blocking
 * exceptions that need a person stop it; an operational source is re-read under lock and must be unchanged since
 * preparation. Then the entry is approved and, if the approved P1 compensation prices it, its approved earning is
 * written. Refusals that leave a record commit only that record.
 */
export async function approveEntry(args: { entryId: number; actorUserId: number; scope: TenantScope; earningCode: string | null }): Promise<ApproveOutcome> {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx): Promise<ApproveOutcome> => {
    const e = (await tx.select().from(payrollTimeEntries).where(eq(payrollTimeEntries.id, args.entryId)).for("update").limit(1))[0]!;
    const profile = (await tx.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, e.employeePayrollProfileId)).limit(1))[0]!;
    const subject = { subjectType: "time_entry", subjectRef: e.entryRef! };
    const base = { financialEntityId: profile.financialEntityId, payPeriodId: e.payPeriodId, employeePayrollProfileId: profile.id, ...subject, raisedByUserId: args.actorUserId };
    if (args.actorUserId === profile.userId || args.actorUserId === e.submittedByUserId || args.actorUserId === e.createdByUserId) {
      await raiseException(tx, { ...base, kind: "self_approval_blocked", discriminator: String(args.actorUserId), detail: "The person who claimed or submitted this time tried to approve it" });
      return { outcome: "refused", code: "FORBIDDEN", kind: "self_approval_blocked", message: "You submitted this time, or it is your own; someone else approves it" };
    }
    const route = await approversFor(tx, { workerUserId: profile.userId, workedAt: e.startedAt, orgRef: args.scope.tenantId });
    if (route.route === "none") {
      await raiseException(tx, { ...base, kind: "no_valid_approver", detail: route.reason });
      return { outcome: "refused", code: "PRECONDITION_FAILED", kind: "no_valid_approver", message: route.reason };
    }
    if (!route.approverUserIds.includes(args.actorUserId)) {
      return { outcome: "refused", code: "FORBIDDEN", kind: null, message: route.route === "crew_supervisor" ? "This time is approved by the worker's crew supervisor" : "This time is approved by the book's payroll administrator" };
    }
    if (!(e.status === "submitted" || e.status === "verified") || e.supersededByEntryId != null) return { outcome: "refused", code: "PRECONDITION_FAILED", kind: null, message: `The entry is ${e.supersededByEntryId != null ? "superseded" : e.status}; only a submitted, current entry is approved` };
    if (!e.endedAt || e.minutes == null || e.minutes <= 0) return { outcome: "refused", code: "PRECONDITION_FAILED", kind: null, message: "The entry has no end time; it cannot be approved until it is closed" };
    const workDate = dateText(e.workDate) ?? localDate(e.startedAt, "UTC");
    const pick = await periodPickFor(tx, await scheduleChainFor(tx, profile), workDate);
    if (pick.kind === "exception") {
      await raiseException(tx, { ...base, kind: pick.exception, detail: pick.reason });
      return { outcome: "refused", code: "PRECONDITION_FAILED", kind: pick.exception, message: pick.reason };
    }
    const period = await lockPeriod(tx, pick.periodId);
    if (!period || !periodAcceptsTimeApproval(period.state)) return { outcome: "refused", code: "PRECONDITION_FAILED", kind: null, message: `Pay period ${pick.periodRef} is ${period?.state ?? "missing"}; time is approved only while the period is open or under review` };
    const gate = (await openExceptionsFor(tx, subject.subjectType, subject.subjectRef)).filter(x => APPROVAL_GATE_KINDS.includes(x.kind));
    if (gate.length) return { outcome: "refused", code: "PRECONDITION_FAILED", kind: gate[0]!.kind, message: `Resolve first: ${gate.map(g => `${g.kind} (${g.exceptionRef})`).join(", ")}` };
    if (e.sourceRecordType && e.sourceRecordRef && e.sourceFingerprint) {
      const operatorId = await operatorForProfile(profile, args.scope);
      const fact = operatorId == null ? null : await reloadSourceFact(tx, { sourceType: e.sourceRecordType, sourceRef: e.sourceRecordRef, operatorId, scope: args.scope, lock: true });
      const now = fact ? sourceFingerprint(fact) : null;
      if (now !== e.sourceFingerprint) {
        const detail = fact ? `The ${e.sourceRecordType} ${e.sourceRecordRef} changed after this time was prepared from it (version ${e.sourceVersion ?? "unversioned"} → ${fact.sourceVersion ?? "unversioned"})` : `The ${e.sourceRecordType} ${e.sourceRecordRef} is gone or no longer this worker's`;
        await raiseException(tx, { ...base, kind: "source_changed_after_preparation", discriminator: now ?? "gone", detail: `${detail}. Correct or withdraw the entry from the current source.` });
        return { outcome: "refused", code: "PRECONDITION_FAILED", kind: "source_changed_after_preparation", message: detail };
      }
    }
    const earningCode = e.earningCode ?? args.earningCode;
    await tx.update(payrollTimeEntries).set({
      status: "approved", approvedByUserId: args.actorUserId, approvedAt: new Date(), approvalRoute: route.route,
      approvalCrewRef: route.crewRefs[0] ?? null, payPeriodId: period.id, earningCode,
    }).where(eq(payrollTimeEntries.id, e.id));
    await closeByCondition(tx, { ...subject, kinds: ["no_pay_schedule", "no_matching_pay_period", "no_valid_approver", "self_approval_blocked"], actorUserId: args.actorUserId, note: "Approved by the entry's approver" });
    const g = await generateEarningInTx(tx, { entry: { ...e, earningCode, status: "approved" }, profile, payPeriodId: period.id, approvedByUserId: args.actorUserId, actorUserId: args.actorUserId });
    return { outcome: "approved", entryRef: e.entryRef!, payPeriodId: period.id, earning: g.earning, earningBlockedBy: g.blockedBy, earningBlockedReason: g.reason };
  });
}

/** Retry the earning for approved time once its blocking condition is cured (an agreement approved, a code fixed). */
export async function generateEarningForApproved(args: { entryId: number; actorUserId: number; earningCode: string | null }) {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx) => {
    const e = (await tx.select().from(payrollTimeEntries).where(eq(payrollTimeEntries.id, args.entryId)).for("update").limit(1))[0]!;
    if (e.status !== "approved" || e.supersededByEntryId != null) return { outcome: "refused" as const, message: "Only approved, current time produces an earning" };
    if (e.payrollEarningEventId != null) return { outcome: "refused" as const, message: "This time already has its earning" };
    if (e.payPeriodId == null) return { outcome: "refused" as const, message: "The approved time has no pay period" };
    const period = await lockPeriod(tx, e.payPeriodId);
    if (!period || !periodAcceptsTimeApproval(period.state)) return { outcome: "refused" as const, message: `Pay period is ${period?.state ?? "missing"}; earnings are added only while it is open or under review` };
    const profile = (await tx.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, e.employeePayrollProfileId)).limit(1))[0]!;
    let entry = e;
    if (e.earningCode == null && args.earningCode) {
      await tx.update(payrollTimeEntries).set({ earningCode: args.earningCode }).where(eq(payrollTimeEntries.id, e.id));
      entry = { ...e, earningCode: args.earningCode };
    }
    const g = await generateEarningInTx(tx, { entry, profile, payPeriodId: period.id, approvedByUserId: e.approvedByUserId!, actorUserId: args.actorUserId });
    return { outcome: "done" as const, earning: g.earning, earningBlockedBy: g.blockedBy, earningBlockedReason: g.reason };
  });
}

export type RejectOutcome = { outcome: "rejected"; entryRef: string } | { outcome: "refused"; code: "FORBIDDEN" | "PRECONDITION_FAILED"; message: string };

/** Reject submitted time, with a reason, by its D10 approver. The row stays, void, with the rejection beside it. */
export async function rejectEntry(args: { entryId: number; actorUserId: number; scope: TenantScope; reason: string }): Promise<RejectOutcome> {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx): Promise<RejectOutcome> => {
    const e = (await tx.select().from(payrollTimeEntries).where(eq(payrollTimeEntries.id, args.entryId)).for("update").limit(1))[0]!;
    const profile = (await tx.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, e.employeePayrollProfileId)).limit(1))[0]!;
    if (args.actorUserId === profile.userId || args.actorUserId === e.submittedByUserId) return { outcome: "refused", code: "FORBIDDEN", message: "You cannot decide your own time; withdraw it instead" };
    const route = await approversFor(tx, { workerUserId: profile.userId, workedAt: e.startedAt, orgRef: args.scope.tenantId });
    if (!route.approverUserIds.includes(args.actorUserId)) return { outcome: "refused", code: "FORBIDDEN", message: "Only the entry's approver rejects it" };
    if (!(e.status === "submitted" || e.status === "verified") || e.supersededByEntryId != null) return { outcome: "refused", code: "PRECONDITION_FAILED", message: `The entry is ${e.status}; only submitted time is rejected` };
    await tx.update(payrollTimeEntries).set({ status: "void", rejectedByUserId: args.actorUserId, rejectedAt: new Date(), rejectionReason: args.reason }).where(eq(payrollTimeEntries.id, e.id));
    return { outcome: "rejected", entryRef: e.entryRef! };
  });
}

/* ------------------------------------------------------------------ */
/* Review scan                                                         */
/* ------------------------------------------------------------------ */

/** Raise review exceptions for a period: time still awaiting approval. Idempotent (one open exception per entry). */
export async function scanPeriod(args: { periodId: number; financialEntityId: number; actorUserId: number }): Promise<{ missingApproval: number }> {
  const db = await dbOrThrow();
  const pending = await db.select({ entryRef: payrollTimeEntries.entryRef, profileId: payrollTimeEntries.employeePayrollProfileId }).from(payrollTimeEntries)
    .where(and(eq(payrollTimeEntries.payPeriodId, args.periodId), inArray(payrollTimeEntries.status, ["submitted", "verified"]), isNull(payrollTimeEntries.supersededByEntryId)));
  for (const p of pending) {
    if (!p.entryRef) continue;
    await raiseException(db, { kind: "missing_approval", financialEntityId: args.financialEntityId, payPeriodId: args.periodId, employeePayrollProfileId: p.profileId, subjectType: "time_entry", subjectRef: p.entryRef, detail: "Submitted time in this period is not yet approved", raisedByUserId: args.actorUserId });
  }
  return { missingApproval: pending.length };
}

export async function profilesForUsersInBooks(userIds: readonly number[], entityIds: readonly number[]) {
  if (!userIds.length || !entityIds.length) return [];
  const db = await dbOrThrow();
  return db.select().from(employeePayrollProfiles).where(and(inArray(employeePayrollProfiles.userId, [...userIds]), inArray(employeePayrollProfiles.financialEntityId, [...entityIds])));
}

export async function profilesInBooks(entityIds: readonly number[]) {
  if (!entityIds.length) return [];
  const db = await dbOrThrow();
  return db.select().from(employeePayrollProfiles).where(inArray(employeePayrollProfiles.financialEntityId, [...entityIds])).limit(5000);
}

export async function loadProfileById(id: number) {
  const db = await dbOrThrow();
  return (await db.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, id)).limit(1))[0] ?? null;
}
