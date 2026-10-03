/**
 * Payroll P3 — payroll time: the worker's own time and candidates, the team view and approval under D10, the
 * time → earning retry, and payroll exceptions (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §26).
 *
 * Every procedure wraps its role gate in `moneyScoped`. Own-time procedures resolve the payroll profile from the
 * session and take no user, employee or profile id; their inputs are strict, so a client that sends `status`,
 * `employeePayrollProfileId` or `userId` is refused rather than ignored. Operational ids in input (job, unit, trip) are
 * proved in the caller's organization; a foreign one is "not found" and leaves a `cross_tenant_reference` exception.
 *
 * D11: `myCandidates` reads operational records and writes nothing. A candidate becomes time only through
 * `myCandidateSubmit`, by the worker, and becomes pay only through approval by someone else.
 * D10: approval and rejection need `payroll.time.approve` / `.reject` AND the relationship — the worker's crew
 * supervisor, else the book's payroll administrator. The role alone approves nothing.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { ownsEntity } from "./_core/entityScope";
import { getDb, jobInScope, tripInScope, unitInScope } from "./db";
import type { Db } from "./_core/dbTypes";
import { DATE_TEXT } from "./_core/payrollSchedule";
import { PAYROLL_ACTIVITIES, PAYROLL_EXCEPTION_KINDS, isPayable, localDate, minutesBetween, serverStateForCapture, sourceFingerprint, type PayrollActivity, type TimeEntryStatus } from "./_core/payrollTime";
import { resolveOwnPayrollProfile } from "./payrollService";
import { dateText, resolveEarningCode } from "./payrollCompensationService";
import { loadPeriodByRef } from "./payrollScheduleService";
import * as t from "./payrollTimeService";

const notFound = (m: string) => new TRPCError({ code: "NOT_FOUND", message: m });
const badRequest = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const forbidden = (m: string) => new TRPCError({ code: "FORBIDDEN", message: m });
const DATE = z.string().regex(DATE_TEXT, "a calendar date, YYYY-MM-DD");
const REF = z.string().min(3).max(64);
const REASON = z.string().min(5).max(400);
const ACTIVITY = z.enum(PAYROLL_ACTIVITIES);
const CODE = z.string().min(1).max(40);

type Money = { tenantId: string; entityIds: readonly number[] };

/** The caller's own payroll profile in this organization's books; never from input. */
async function ownProfile(userId: number, money: Money) {
  const p = await resolveOwnPayrollProfile(userId);
  if (!p || !ownsEntity(money as never, p.financialEntityId)) throw notFound("No payroll profile is linked to your account in this organization");
  if (await t.isOwnerOperator(p)) throw badRequest("An owner-operator is paid through contractor settlement, not employee payroll time");
  return p;
}

/** Prove each operational id in the caller's organization; a foreign id is not found, and the attempt is recorded. */
async function proveRefs(args: { money: Money; profile: t.ProfileRow; actorUserId: number; jobId?: number | null; unitId?: number | null; tripId?: number | null }) {
  const scope = { tenantId: args.money.tenantId };
  const checks: Array<[string, number | null | undefined, (id: number) => Promise<unknown>]> = [
    ["job", args.jobId, id => jobInScope(id, scope)],
    ["unit", args.unitId, id => unitInScope(id, scope)],
    ["trip", args.tripId, id => tripInScope(id, scope)],
  ];
  for (const [kind, id, inScope] of checks) {
    if (id == null) continue;
    if (!(await inScope(id))) {
      await t.raiseException(await dbOrThrow(), { kind: "cross_tenant_reference", financialEntityId: args.profile.financialEntityId, employeePayrollProfileId: args.profile.id, subjectType: "submission", subjectRef: `profile:${args.profile.id}`, discriminator: `${kind}:${id}`, detail: `A time submission named ${kind} ${id}, which is not this organization's`, raisedByUserId: args.actorUserId });
      throw notFound(`${kind[0]!.toUpperCase()}${kind.slice(1)} ${id} not found`);
    }
  }
}
async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db as unknown as Db;
}

async function requireCode(code: string | null | undefined, financialEntityId: number, workDate: string) {
  if (!code) return null;
  const c = await resolveEarningCode(code, financialEntityId, workDate);
  if (!c) throw badRequest(`Earning code ${code} is not active in this book on ${workDate}`);
  if (c.kind !== "earning") throw badRequest(`Earning code ${code} is a ${c.kind}, not an earning`);
  return c.code;
}

function unwrapSubmit(r: t.SubmitOutcome) {
  if (r.outcome === "refused") throw new TRPCError({ code: r.code, message: r.message });
  return r.outcome === "replayed" ? { entryRef: r.entryRef, status: r.status, replayed: true as const, exceptions: [] as string[] } : { entryRef: r.entryRef, status: r.status, replayed: false as const, payPeriodId: r.payPeriodId, exceptions: r.exceptions };
}

/** Own entries: the caller's profile only, so a ref of someone else's entry is not found. */
async function ownEntry(entryRef: string, profileId: number) {
  const e = await t.loadEntryByRef(entryRef);
  if (!e || e.employeePayrollProfileId !== profileId) throw notFound(`Time entry ${entryRef} not found`);
  return e;
}

/** An entry in the caller's books, or not found. */
async function entryInBooks(entryRef: string, money: Money) {
  const e = await t.loadEntryByRef(entryRef);
  if (!e) throw notFound(`Time entry ${entryRef} not found`);
  const p = await t.loadProfileById(e.employeePayrollProfileId);
  if (!p || !ownsEntity(money as never, p.financialEntityId)) throw notFound(`Time entry ${entryRef} not found`);
  return { entry: e, profile: p };
}

const statusLabel = (e: { status: string; supersededByEntryId: number | null; rejectedAt: Date | null; withdrawnAt: Date | null }) =>
  e.supersededByEntryId != null ? "superseded" : e.status === "void" ? (e.rejectedAt ? "rejected" : e.withdrawnAt ? "withdrawn" : "void") : e.status;

/** What a worker sees of their own entry, and what a supervisor sees of a team member's: time, never money. */
function entryView(e: t.TimeEntryRow) {
  return {
    entryRef: e.entryRef, status: e.status, statusLabel: statusLabel(e), payable: isPayable({ status: e.status as TimeEntryStatus, supersededByEntryId: e.supersededByEntryId }),
    activity: e.activity, workDate: dateText(e.workDate), startedAt: e.startedAt, endedAt: e.endedAt, minutes: e.minutes, earningCode: e.earningCode,
    jobId: e.jobId, unitId: e.unitId, tripId: e.tripId, source: e.source, sourceRecordType: e.sourceRecordType, sourceRecordRef: e.sourceRecordRef,
    notes: e.notes, locationText: e.locationText, clientCaptureRef: e.clientCaptureRef, capturedAt: e.capturedAt,
    submittedAt: e.submittedAt, approvedByUserId: e.approvedByUserId, approvedAt: e.approvedAt, approvalRoute: e.approvalRoute,
    rejectedAt: e.rejectedAt, rejectionReason: e.rejectionReason, withdrawnAt: e.withdrawnAt, withdrawReason: e.withdrawReason,
    supersedesEntryId: e.supersedesEntryId, supersededByEntryId: e.supersededByEntryId, payPeriodId: e.payPeriodId,
  };
}

const window = (from: string, through: string) => {
  if (through < from) throw badRequest("`through` is before `from`");
  const days = (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 31) throw badRequest("A window is at most 31 days");
};

const OWN_ENTRY = z.object({
  activity: ACTIVITY,
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  earningCode: CODE.optional(),
  jobId: z.number().int().optional(),
  unitId: z.number().int().optional(),
  tripId: z.number().int().optional(),
  notes: z.string().max(1000).optional(),
  locationText: z.string().max(200).optional(),
});

export const payrollTimeRouter = router({
  /* ---------------- The worker's own time ---------------- */

  /** Read-only: operational facts about the caller's own work, as candidates. Writes nothing, however often called. */
  myCandidates: moneyScoped(roleProcedure("payrollTime.myCandidates"))
    .input(z.object({ from: DATE, through: DATE }).strict())
    .query(async ({ ctx, input }) => {
      window(input.from, input.through);
      const me = await ownProfile(ctx.user.id, ctx.money);
      return t.candidatesForProfile({ profile: me, scope: { tenantId: ctx.money.tenantId }, from: input.from, through: input.through });
    }),

  myEntries: moneyScoped(roleProcedure("payrollTime.myEntries"))
    .input(z.object({ from: DATE.optional(), through: DATE.optional() }).strict().optional())
    .query(async ({ ctx, input }) => {
      const me = await ownProfile(ctx.user.id, ctx.money);
      const rows = await t.listEntriesForProfiles([me.id], {
        from: input?.from ? new Date(`${input.from}T00:00:00Z`) : undefined,
        to: input?.through ? new Date(Date.parse(`${input.through}T00:00:00Z`) + 2 * 86_400_000) : undefined,
      });
      return rows.map(entryView);
    }),

  /**
   * Record own time: a draft (`captureState: "open"`) or a submission (the default). Offline-prepared captures carry
   * `clientCaptureRef` (a replay returns the first entry), `capturedAt` and `deviceRef` as the device's claims. A
   * capture can never ask for approval: the server chooses the state.
   */
  myEntryCreate: moneyScoped(roleProcedure("payrollTime.myEntryCreate"))
    .input(OWN_ENTRY.extend({
      clientCaptureRef: z.string().min(6).max(80).optional(),
      capturedAt: z.coerce.date().optional(),
      deviceRef: z.string().max(120).optional(),
      captureState: z.string().max(20).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const state = serverStateForCapture(input.captureState);
      if (!state.ok) throw badRequest(state.reason);
      if (input.endedAt && input.endedAt <= input.startedAt) throw badRequest("The end is not after the start");
      const me = await ownProfile(ctx.user.id, ctx.money);
      await proveRefs({ money: ctx.money, profile: me, actorUserId: ctx.user.id, jobId: input.jobId, unitId: input.unitId, tripId: input.tripId });
      const { timezone } = await t.zoneFor(await dbOrThrow(), me);
      const earningCode = await requireCode(input.earningCode, me.financialEntityId, localDate(input.startedAt, timezone));
      return unwrapSubmit(await t.submitEntry({
        profile: me, actorUserId: ctx.user.id, state: state.state, activity: input.activity, startedAt: input.startedAt, endedAt: input.endedAt ?? null,
        earningCode, jobId: input.jobId ?? null, unitId: input.unitId ?? null, tripId: input.tripId ?? null, notes: input.notes ?? null,
        locationText: input.locationText ?? null, clientCaptureRef: input.clientCaptureRef ?? null, capturedAt: input.capturedAt ?? null,
        deviceRef: input.deviceRef ?? null, source: "employee_submitted", provenance: null, supersedes: null, promote: null,
      }));
    }),

  /** Edit one's own draft. A submitted entry is not edited: it is corrected (superseded). */
  myEntryUpdate: moneyScoped(roleProcedure("payrollTime.myEntryUpdate"))
    .input(OWN_ENTRY.partial().extend({ entryRef: REF }).strict())
    .mutation(async ({ ctx, input }) => {
      const me = await ownProfile(ctx.user.id, ctx.money);
      const e = await ownEntry(input.entryRef, me.id);
      if (e.status !== "open") throw precondition(`The entry is ${e.status}; a submitted entry is corrected, not edited`);
      await proveRefs({ money: ctx.money, profile: me, actorUserId: ctx.user.id, jobId: input.jobId, unitId: input.unitId, tripId: input.tripId });
      const startedAt = input.startedAt ?? e.startedAt;
      const endedAt = input.endedAt ?? e.endedAt;
      if (endedAt && endedAt <= startedAt) throw badRequest("The end is not after the start");
      const { timezone } = await t.zoneFor(await dbOrThrow(), me);
      const earningCode = input.earningCode !== undefined ? await requireCode(input.earningCode, me.financialEntityId, localDate(startedAt, timezone)) : undefined;
      const ok = await t.updateDraft({ id: e.id, set: {
        activity: input.activity, startedAt: input.startedAt, endedAt: input.endedAt, minutes: endedAt ? minutesBetween(startedAt, endedAt) : null,
        earningCode, jobId: input.jobId, unitId: input.unitId, tripId: input.tripId, notes: input.notes, locationText: input.locationText,
      } });
      if (!ok) throw precondition("The entry is no longer a draft");
      return { entryRef: e.entryRef, status: "open" as const };
    }),

  /** Submit one's own draft: the period must be open now, and overlaps and duplicates are decided now. */
  myEntrySubmit: moneyScoped(roleProcedure("payrollTime.myEntrySubmit"))
    .input(z.object({ entryRef: REF }).strict())
    .mutation(async ({ ctx, input }) => {
      const me = await ownProfile(ctx.user.id, ctx.money);
      const e = await ownEntry(input.entryRef, me.id);
      if (e.status !== "open") throw precondition(`The entry is ${e.status}; only a draft is submitted`);
      return unwrapSubmit(await t.submitEntry({
        profile: me, actorUserId: ctx.user.id, state: "submitted", activity: e.activity as PayrollActivity, startedAt: e.startedAt, endedAt: e.endedAt,
        earningCode: e.earningCode, jobId: e.jobId, unitId: e.unitId, tripId: e.tripId, notes: e.notes, locationText: e.locationText,
        clientCaptureRef: e.clientCaptureRef, capturedAt: e.capturedAt, deviceRef: e.deviceRef, source: "employee_submitted", provenance: null, supersedes: null, promote: { id: e.id },
      }));
    }),

  /**
   * Submit one of one's own candidates. The server re-resolves the candidate from the source (the client names it
   * by key; its facts are never taken from input), records its identity, version and fingerprint, and submits. The
   * worker may state a different window; the difference is flagged for review, not refused.
   */
  myCandidateSubmit: moneyScoped(roleProcedure("payrollTime.myCandidateSubmit"))
    .input(z.object({
      candidateKey: z.string().length(64),
      from: DATE, through: DATE,
      earningCode: CODE.optional(),
      activity: ACTIVITY.optional(),
      startedAt: z.coerce.date().optional(),
      endedAt: z.coerce.date().optional(),
      notes: z.string().max(1000).optional(),
      clientCaptureRef: z.string().min(6).max(80).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      window(input.from, input.through);
      const me = await ownProfile(ctx.user.id, ctx.money);
      const { candidates } = await t.candidatesForProfile({ profile: me, scope: { tenantId: ctx.money.tenantId }, from: input.from, through: input.through });
      const c = candidates.find(x => x.candidateKey === input.candidateKey);
      if (!c) throw notFound("Candidate not found in your own work for that window");
      if (!c.eligible) throw precondition(c.ineligibleReason ?? "This candidate cannot be submitted");
      const startedAt = input.startedAt ?? new Date(c.startedAt!);
      const endedAt = input.endedAt ?? new Date(c.endedAt!);
      if (endedAt <= startedAt) throw badRequest("The end is not after the start");
      if ((input.startedAt || input.endedAt) && !input.notes) throw badRequest("Say why the time differs from the source (notes)");
      const earningCode = await requireCode(input.earningCode, me.financialEntityId, c.workDate!);
      return unwrapSubmit(await t.submitEntry({
        profile: me, actorUserId: ctx.user.id, state: "submitted", activity: input.activity ?? c.activity ?? "on_location", startedAt, endedAt, earningCode,
        jobId: c.jobId, unitId: c.unitId, tripId: c.tripId, notes: input.notes ?? null, locationText: null, clientCaptureRef: input.clientCaptureRef ?? null,
        capturedAt: null, deviceRef: null,
        source: c.sourceType === "field_ticket" ? "field_ticket" : c.sourceType === "dispatch_booking" ? "dispatch_schedule" : "employee_submitted",
        provenance: { sourceType: c.sourceType, sourceRef: c.sourceRef, segment: c.segment, candidateKey: c.candidateKey, sourceVersion: c.sourceVersion, sourceFingerprint: c.sourceFingerprint, candidateMinutes: c.minutes },
        supersedes: null, promote: null,
      }));
    }),

  /**
   * Correct one's own submitted entry: a new submitted entry supersedes it; the old row stays, marked superseded, and
   * never counts as payable. `refreshSource` re-reads the source the entry came from and adopts its current version.
   */
  myEntryCorrect: moneyScoped(roleProcedure("payrollTime.myEntryCorrect"))
    .input(OWN_ENTRY.partial().extend({ entryRef: REF, notes: z.string().min(3).max(1000), refreshSource: z.boolean().default(false) }).strict())
    .mutation(async ({ ctx, input }) => {
      const me = await ownProfile(ctx.user.id, ctx.money);
      const e = await ownEntry(input.entryRef, me.id);
      if (e.status !== "submitted" || e.supersededByEntryId != null) throw precondition(`The entry is ${statusLabel(e)}; only a submitted, current entry is corrected (approved time is changed by adjustment)`);
      await proveRefs({ money: ctx.money, profile: me, actorUserId: ctx.user.id, jobId: input.jobId, unitId: input.unitId, tripId: input.tripId });
      const startedAt = input.startedAt ?? e.startedAt;
      const endedAt = input.endedAt ?? e.endedAt;
      if (!endedAt || endedAt <= startedAt) throw badRequest("A correction needs an end after its start");
      const { timezone } = await t.zoneFor(await dbOrThrow(), me);
      const earningCode = input.earningCode !== undefined ? await requireCode(input.earningCode, me.financialEntityId, localDate(startedAt, timezone)) : e.earningCode;
      let provenance: t.SourceProvenance | null = null;
      if (e.sourceRecordType && e.sourceRecordRef && e.candidateKey) {
        let fingerprint = e.sourceFingerprint!;
        let version = e.sourceVersion;
        let candidateMinutes: number | null = null;
        if (input.refreshSource) {
          const operatorId = await t.operatorForProfile(me, { tenantId: ctx.money.tenantId });
          const fact = operatorId == null ? null : await t.reloadSourceFact(await dbOrThrow(), { sourceType: e.sourceRecordType, sourceRef: e.sourceRecordRef, operatorId, scope: { tenantId: ctx.money.tenantId }, lock: false });
          if (!fact) throw precondition("The source this entry came from is gone; withdraw the entry and record the time directly");
          fingerprint = sourceFingerprint(fact);
          version = fact.sourceVersion ?? null;
          candidateMinutes = fact.startedAt && fact.endedAt ? minutesBetween(fact.startedAt, fact.endedAt) : null;
        }
        provenance = { sourceType: e.sourceRecordType, sourceRef: e.sourceRecordRef, segment: e.sourceSegment, candidateKey: e.candidateKey, sourceVersion: version, sourceFingerprint: fingerprint, candidateMinutes };
      }
      return unwrapSubmit(await t.submitEntry({
        profile: me, actorUserId: ctx.user.id, state: "submitted", activity: (input.activity ?? e.activity) as PayrollActivity, startedAt, endedAt, earningCode,
        jobId: input.jobId ?? e.jobId, unitId: input.unitId ?? e.unitId, tripId: input.tripId ?? e.tripId, notes: input.notes, locationText: input.locationText ?? e.locationText,
        clientCaptureRef: null, capturedAt: null, deviceRef: null, source: e.source as never, provenance, supersedes: { id: e.id }, promote: null,
      }));
    }),

  /** Take back one's own draft or submitted entry, with a reason. It stays visible as withdrawn. */
  myEntryWithdraw: moneyScoped(roleProcedure("payrollTime.myEntryWithdraw"))
    .input(z.object({ entryRef: REF, reason: REASON }).strict())
    .mutation(async ({ ctx, input }) => {
      const me = await ownProfile(ctx.user.id, ctx.money);
      const e = await ownEntry(input.entryRef, me.id);
      if (!(await t.withdrawEntry({ id: e.id, actorUserId: ctx.user.id, reason: input.reason }))) throw precondition(`The entry is ${statusLabel(e)}; only a draft or submitted, current entry is withdrawn`);
      return { entryRef: e.entryRef, status: "void" as const, statusLabel: "withdrawn" as const };
    }),

  /* ---------------- The team: D10 ---------------- */

  /**
   * The time this caller approves: their crews' members' time when they supervise a crew; the book's time when they
   * are its payroll administrator. Time, status and exceptions only — no rate, agreement, salary or gross.
   */
  teamEntries: moneyScoped(roleProcedure("payrollTime.teamEntries"))
    .input(z.object({ status: z.enum(["open", "submitted", "verified", "disputed", "approved", "void"]).optional() }).strict().optional())
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const isAdmin = (await t.payrollAdminsOf(db, ctx.money.tenantId)).includes(ctx.user.id);
      const supervised = await t.supervisedUserIds(db, { supervisorUserId: ctx.user.id, orgRef: ctx.money.tenantId });
      const profiles = isAdmin ? await t.profilesInBooks(ctx.money.entityIds) : await t.profilesForUsersInBooks(supervised, ctx.money.entityIds);
      const others = profiles.filter(p => p.userId !== ctx.user.id);
      const byId = new Map(others.map(p => [p.id, p]));
      const rows = await t.listEntriesForProfiles(others.map(p => p.id), { statuses: input?.status ? [input.status] : undefined });
      const out = [];
      for (const e of rows) {
        const p = byId.get(e.employeePayrollProfileId)!;
        const open = e.entryRef ? await t.openExceptionsFor(db, "time_entry", e.entryRef) : [];
        out.push({ ...entryView(e), worker: { employeeNumber: p.employeeNumber, userId: p.userId }, openExceptions: open.map(x => ({ exceptionRef: x.exceptionRef, kind: x.kind, severity: x.severity })) });
      }
      return { scope: isAdmin ? ("book" as const) : ("crew" as const), entries: out };
    }),

  /** Approve submitted time: only its D10 approver, never its claimant or submitter. Approved time may produce an approved earning; it never enters a run. */
  entryApprove: moneyScoped(roleProcedure("payrollTime.entryApprove"))
    .input(z.object({ entryRef: REF }).strict())
    .mutation(async ({ ctx, input }) => {
      const { entry } = await entryInBooks(input.entryRef, ctx.money);
      const r = await t.approveEntry({ entryId: entry.id, actorUserId: ctx.user.id, scope: { tenantId: ctx.money.tenantId }, earningCode: null });
      if (r.outcome === "refused") throw new TRPCError({ code: r.code, message: r.message });
      return { entryRef: r.entryRef, status: "approved" as const, earningCreated: r.earning != null, earningBlockedBy: r.earningBlockedBy, earningBlockedReason: r.earningBlockedReason };
    }),

  entryReject: moneyScoped(roleProcedure("payrollTime.entryReject"))
    .input(z.object({ entryRef: REF, reason: REASON }).strict())
    .mutation(async ({ ctx, input }) => {
      const { entry } = await entryInBooks(input.entryRef, ctx.money);
      const r = await t.rejectEntry({ entryId: entry.id, actorUserId: ctx.user.id, scope: { tenantId: ctx.money.tenantId }, reason: input.reason });
      if (r.outcome === "refused") throw new TRPCError({ code: r.code, message: r.message });
      return { entryRef: r.entryRef, status: "void" as const, statusLabel: "rejected" as const };
    }),

  /* ---------------- Payroll administration ---------------- */

  /**
   * Produce the earning for approved time whose earning was blocked (no agreement then, no code, a rule mismatch),
   * once the cause is cured. May fill a missing earning code; never changes the approved hours.
   */
  earningGenerate: moneyScoped(roleProcedure("payrollTime.earningGenerate"))
    .input(z.object({ entryRef: REF, earningCode: CODE.optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const { entry, profile } = await entryInBooks(input.entryRef, ctx.money);
      if (input.earningCode && entry.earningCode) throw precondition("The entry already has an earning code");
      const code = input.earningCode ? await requireCode(input.earningCode, profile.financialEntityId, dateText(entry.workDate)!) : null;
      const r = await t.generateEarningForApproved({ entryId: entry.id, actorUserId: ctx.user.id, earningCode: code });
      if (r.outcome === "refused") throw precondition(r.message);
      return { entryRef: entry.entryRef, earningCreated: r.earning != null, earningRef: r.earning?.earningRef ?? null, earningBlockedBy: r.earningBlockedBy, earningBlockedReason: r.earningBlockedReason };
    }),

  exceptionsList: moneyScoped(roleProcedure("payrollTime.exceptionsList"))
    .input(z.object({ state: z.enum(["open", "resolved", "dismissed"]).optional(), kind: z.enum(PAYROLL_EXCEPTION_KINDS).optional(), periodRef: REF.optional() }).strict().optional())
    .query(async ({ ctx, input }) => {
      let payPeriodId: number | undefined;
      if (input?.periodRef) {
        const p = await loadPeriodByRef(input.periodRef);
        if (!p || !ownsEntity(ctx.money as never, p.financialEntityId)) throw notFound(`Pay period ${input.periodRef} not found`);
        payPeriodId = p.id;
      }
      return t.listExceptions({ entityIds: ctx.money.entityIds, state: input?.state, kind: input?.kind, payPeriodId });
    }),

  /** Raise review exceptions for a period (time still awaiting approval). Idempotent. */
  exceptionsScan: moneyScoped(roleProcedure("payrollTime.exceptionsScan"))
    .input(z.object({ periodRef: REF }).strict())
    .mutation(async ({ ctx, input }) => {
      const p = await loadPeriodByRef(input.periodRef);
      if (!p || !ownsEntity(ctx.money as never, p.financialEntityId)) throw notFound(`Pay period ${input.periodRef} not found`);
      return t.scanPeriod({ periodId: p.id, financialEntityId: p.financialEntityId, actorUserId: ctx.user.id });
    }),

  /** Resolve or dismiss an open exception, with a note. Resolving changes no pay; it records a person's decision. */
  exceptionResolve: moneyScoped(roleProcedure("payrollTime.exceptionResolve"))
    .input(z.object({ exceptionRef: REF, outcome: z.enum(["resolved", "dismissed"]), note: z.string().min(5).max(1000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const x = await t.loadException(input.exceptionRef);
      if (!x || !ownsEntity(ctx.money as never, x.financialEntityId)) throw notFound(`Exception ${input.exceptionRef} not found`);
      if (x.raisedByUserId === ctx.user.id && x.kind === "self_approval_blocked") throw forbidden("You raised this by trying to approve your own time; someone else resolves it");
      if (!(await t.resolveException({ id: x.id, state: input.outcome, actorUserId: ctx.user.id, note: input.note }))) throw precondition("The exception is no longer open");
      return { exceptionRef: x.exceptionRef, state: input.outcome };
    }),
});
