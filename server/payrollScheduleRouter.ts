/**
 * Payroll P2 — pay schedules, generated pay periods, and the pay-period machine
 * (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md, P2 checkpoint).
 *
 * Every procedure wraps its role gate in `moneyScoped`: the caller's books arrive as `ctx.money`, and every
 * schedule or period named in input is proved against them; anything outside is "not found".
 *
 * D6 — the payroll lock is payroll's own. Approving a period locks it against new earnings, new runs and further
 * collection; the accounting period close (`periodCloses`) neither owns nor is owned by this machine.
 * D4 — separation of duties: the person who opened (generated) or submitted a period may not approve it, and a
 * period whose opener is not on record is refused rather than assumed to be someone else's.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { assertProfileInScope, ownsEntity, requireOwnedEntity } from "./_core/entityScope";
import { getDb } from "./db";
import { separationOfDuties } from "./_core/payrollEngine";
import {
  DATE_TEXT,
  PERIOD_STATE_LABEL,
  approveReadiness,
  canTransitionPeriod,
  finalizeReadiness,
  generatePeriods,
  validateSchedule,
  voidReadiness,
  type PayPeriodState,
} from "./_core/payrollSchedule";
import { PAY_FREQUENCIES } from "../drizzle/schema";
import * as sch from "./payrollScheduleService";

const notFound = (m: string) => new TRPCError({ code: "NOT_FOUND", message: m });
const badRequest = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const forbidden = (m: string) => new TRPCError({ code: "FORBIDDEN", message: m });
const DATE = z.string().regex(DATE_TEXT, "a calendar date, YYYY-MM-DD");
const REF = z.string().min(3).max(64);
const REASON = z.string().min(5).max(400);

type Money = { entityIds: readonly number[]; tenantId: string };
async function scheduleInScope(scheduleRef: string, money: Money) {
  const s = await sch.loadSchedule(scheduleRef);
  if (!s || !ownsEntity(money as never, s.financialEntityId)) throw notFound(`Pay schedule ${scheduleRef} not found`);
  return s;
}
async function periodInScope(periodRef: string, money: Money) {
  const p = await sch.loadPeriodByRef(periodRef);
  if (!p || !ownsEntity(money as never, p.financialEntityId)) throw notFound(`Pay period ${periodRef} not found`);
  return p;
}
function requireEdge(from: PayPeriodState, to: PayPeriodState) {
  if (!canTransitionPeriod(from, to)) throw precondition(`Pay period is ${PERIOD_STATE_LABEL[from]} (${from}); it cannot move to ${PERIOD_STATE_LABEL[to]} (${to})`);
}
const view = <T extends { state: string }>(p: T) => ({ ...p, stateLabel: PERIOD_STATE_LABEL[p.state as PayPeriodState] });

export const payrollScheduleRouter = router({
  /* ---------------- Schedules ---------------- */

  schedulesList: moneyScoped(roleProcedure("payrollSchedule.schedulesList")).query(async ({ ctx }) => sch.listSchedules(ctx.money.entityIds)),

  /** A book's payroll calendar. The book is the caller's or "not found"; the calendar must be able to generate. */
  scheduleCreate: moneyScoped(roleProcedure("payrollSchedule.scheduleCreate"))
    .input(z.object({
      financialEntityId: z.number().int(),
      name: z.string().min(1).max(120),
      frequency: z.enum(PAY_FREQUENCIES),
      anchorDate: DATE,
      periodLengthDays: z.number().int().optional(),
      paymentLagDays: z.number().int().default(0),
      cutoffLagDays: z.number().int().default(0),
      timezone: z.string().min(3).max(64),
    }))
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const errors = validateSchedule({ ...input, periodLengthDays: input.periodLengthDays ?? null });
      if (errors.length) throw badRequest(errors.join("; "));
      const scheduleRef = await sch.createSchedule({
        financialEntityId: input.financialEntityId, name: input.name, frequency: input.frequency, anchorDate: input.anchorDate,
        periodLengthDays: input.periodLengthDays ?? null, paymentLagDays: input.paymentLagDays, cutoffLagDays: input.cutoffLagDays,
        timezone: input.timezone, status: "active", createdByUserId: ctx.user.id,
      });
      if (!scheduleRef) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      return { scheduleRef, status: "active" as const };
    }),

  /** Retire a schedule: it generates no more periods. Periods already generated keep their state and their history. */
  scheduleRetire: moneyScoped(roleProcedure("payrollSchedule.scheduleRetire"))
    .input(z.object({ scheduleRef: REF }))
    .mutation(async ({ ctx, input }) => {
      const s = await scheduleInScope(input.scheduleRef, ctx.money);
      if (!(await sch.retireSchedule({ id: s.id, retiredByUserId: ctx.user.id }))) throw precondition("This schedule is already retired");
      return { scheduleRef: s.scheduleRef, status: "retired" as const };
    }),

  /**
   * Generate the schedule's periods that have started by `through` (and not ended before `from`), at most 60 per
   * call. Idempotent: a period that exists is reported, never duplicated. A generated period opens in OPEN.
   */
  periodsGenerate: moneyScoped(roleProcedure("payrollSchedule.periodsGenerate"))
    .input(z.object({ scheduleRef: REF, through: DATE, from: DATE.optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = await scheduleInScope(input.scheduleRef, ctx.money);
      if (s.status !== "active") throw precondition("A retired schedule generates no periods");
      if (input.through < s.anchorDate!) throw badRequest(`Nothing to generate before the schedule's anchor (${s.anchorDate})`);
      const periods = generatePeriods(
        { frequency: s.frequency, anchorDate: s.anchorDate!, periodLengthDays: s.periodLengthDays, paymentLagDays: s.paymentLagDays, cutoffLagDays: s.cutoffLagDays, timezone: s.timezone },
        { from: input.from, through: input.through, max: 60 },
      );
      const r = await sch.insertGeneratedPeriods({ schedule: s, periods, createdByUserId: ctx.user.id });
      return { scheduleRef: s.scheduleRef, created: r.created, existing: r.existing };
    }),

  periodsList: moneyScoped(roleProcedure("payrollSchedule.periodsList"))
    .input(z.object({ scheduleRef: REF }))
    .query(async ({ ctx, input }) => {
      const s = await scheduleInScope(input.scheduleRef, ctx.money);
      return (await sch.listSchedulePeriods(s.id)).map(view);
    }),

  periodGet: moneyScoped(roleProcedure("payrollSchedule.periodGet"))
    .input(z.object({ periodRef: REF }))
    .query(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      return { ...view(p), runStates: await sch.runStatesForPeriod(p.id), earningCount: await sch.earningCountForPeriod(p.id) };
    }),

  /* ---------------- Pay groups → schedules (P3, 0234) ---------------- */

  /** The book's pay groups and the schedule each is paid on. */
  payGroupsList: moneyScoped(roleProcedure("payrollSchedule.payGroupsList")).query(async ({ ctx }) => sch.listPayGroups(ctx.money.entityIds)),

  /**
   * Create a pay group (no `groupKey`) or change one. Its schedule must be an active schedule of the same book: a
   * profile is paid on exactly one schedule, through its one pay group, and that is never guessed.
   */
  payGroupSave: moneyScoped(roleProcedure("payrollSchedule.payGroupSave"))
    .input(z.object({ groupKey: REF.optional(), financialEntityId: z.number().int(), label: z.string().min(1).max(180), scheduleRef: REF.nullable(), active: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      let payScheduleId: number | null = null;
      if (input.scheduleRef) {
        const s = await scheduleInScope(input.scheduleRef, ctx.money);
        if (s.financialEntityId !== input.financialEntityId) throw badRequest("The schedule belongs to a different financial entity than the pay group");
        if (s.status !== "active") throw precondition("A retired schedule pays nobody");
        payScheduleId = s.id;
      }
      if (!input.groupKey) {
        const groupKey = await sch.createPayGroup({ financialEntityId: input.financialEntityId, label: input.label, payScheduleId, active: input.active });
        if (!groupKey) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        return { groupKey, scheduleRef: input.scheduleRef };
      }
      const g = await sch.loadPayGroupByKey(input.groupKey);
      if (!g || g.financialEntityId == null || !ownsEntity(ctx.money, g.financialEntityId)) throw notFound(`Pay group ${input.groupKey} not found`);
      if (g.financialEntityId !== input.financialEntityId) throw badRequest("A pay group does not move between financial entities");
      await sch.updatePayGroup({ id: g.id, label: input.label, payScheduleId, active: input.active });
      return { groupKey: g.groupKey, scheduleRef: input.scheduleRef };
    }),

  /** Put a payroll profile in a pay group of its own book (or take it out with `groupKey: null`). */
  profileAssignPayGroup: moneyScoped(roleProcedure("payrollSchedule.profileAssignPayGroup"))
    .input(z.object({ employeePayrollProfileId: z.number().int(), groupKey: REF.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const profile = await assertProfileInScope(db, input.employeePayrollProfileId, ctx.money);
      let payGroupId: number | null = null;
      if (input.groupKey) {
        const g = await sch.loadPayGroupByKey(input.groupKey);
        if (!g || g.financialEntityId == null || !ownsEntity(ctx.money, g.financialEntityId)) throw notFound(`Pay group ${input.groupKey} not found`);
        if (g.financialEntityId !== profile.financialEntityId) throw badRequest("The pay group belongs to a different financial entity than the profile");
        payGroupId = g.id;
      }
      await sch.setProfilePayGroup({ employeePayrollProfileId: profile.id, payGroupId });
      return { employeePayrollProfileId: profile.id, groupKey: input.groupKey };
    }),

  /* ---------------- The machine ---------------- */

  /** OPEN → REVIEWING: the administrator says the period's time and earnings are in. Runs may still collect. */
  periodSubmit: moneyScoped(roleProcedure("payrollSchedule.periodSubmit"))
    .input(z.object({ periodRef: REF }))
    .mutation(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      requireEdge(p.state as PayPeriodState, "review");
      if (!(await sch.transitionPeriod({ id: p.id, from: p.state as PayPeriodState, to: "review", set: { submittedByUserId: ctx.user.id, submittedAt: new Date() } }))) throw precondition("The period moved while you were acting on it");
      return { periodRef: p.periodRef, state: "review" as const, stateLabel: PERIOD_STATE_LABEL.review };
    }),

  /**
   * REVIEWING → APPROVED, and the lock: from here no earning is proposed into the period, no run is created on it,
   * and no run collects against it. Refused for the person who opened or submitted it, for a period whose opener is
   * not on record, and while any run on the period is still gathering lines.
   */
  periodApprove: moneyScoped(roleProcedure("payrollSchedule.periodApprove"))
    .input(z.object({ periodRef: REF }))
    .mutation(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      requireEdge(p.state as PayPeriodState, "approved");
      const opened = separationOfDuties({ originatorUserId: p.createdByUserId, actorUserId: ctx.user.id, act: "approve this pay period" });
      if (!opened.allowed) throw forbidden(opened.reason!);
      if (p.submittedByUserId != null && p.submittedByUserId === ctx.user.id) throw forbidden("You submitted this pay period for review; it must be approved by someone else");
      const ready = approveReadiness(await sch.runStatesForPeriod(p.id));
      if (!ready.ready) throw precondition(ready.reasons.join("; "));
      const now = new Date();
      if (!(await sch.transitionPeriod({ id: p.id, from: "review", to: "approved", set: { approvedByUserId: ctx.user.id, approvedAt: now, lockedAt: now, lockedByUserId: ctx.user.id } }))) throw precondition("The period moved while you were acting on it");
      return { periodRef: p.periodRef, state: "approved" as const, stateLabel: PERIOD_STATE_LABEL.approved, locked: true };
    }),

  /** Step back one stage, with a reason: REVIEWING → OPEN, or APPROVED → REVIEWING (which releases the lock). */
  periodReopen: moneyScoped(roleProcedure("payrollSchedule.periodReopen"))
    .input(z.object({ periodRef: REF, reason: REASON }))
    .mutation(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      const from = p.state as PayPeriodState;
      const to: PayPeriodState | null = from === "review" ? "collecting" : from === "approved" ? "review" : null;
      if (!to) throw precondition(`A ${PERIOD_STATE_LABEL[from]} (${from}) period is not reopened; a finalized period is corrected by adjustment`);
      const unlock = from === "approved" ? { lockedAt: null, lockedByUserId: null, approvedByUserId: null, approvedAt: null } : {};
      if (!(await sch.transitionPeriod({ id: p.id, from, to, set: { ...unlock, reopenedByUserId: ctx.user.id, reopenedAt: new Date(), reopenReason: input.reason } }))) throw precondition("The period moved while you were acting on it");
      return { periodRef: p.periodRef, state: to, stateLabel: PERIOD_STATE_LABEL[to], locked: false };
    }),

  /** APPROVED → PROCESSING: payment is being made. The period stays locked. */
  periodProcess: moneyScoped(roleProcedure("payrollSchedule.periodProcess"))
    .input(z.object({ periodRef: REF }))
    .mutation(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      requireEdge(p.state as PayPeriodState, "processing");
      if (!(await sch.transitionPeriod({ id: p.id, from: "approved", to: "processing", set: {} }))) throw precondition("The period moved while you were acting on it");
      return { periodRef: p.periodRef, state: "processing" as const, stateLabel: PERIOD_STATE_LABEL.processing, locked: true };
    }),

  /** PROCESSING → FINALIZED, only when every run on the period is paid. A finalized period is never edited; it is corrected. */
  periodFinalize: moneyScoped(roleProcedure("payrollSchedule.periodFinalize"))
    .input(z.object({ periodRef: REF }))
    .mutation(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      requireEdge(p.state as PayPeriodState, "closed");
      const ready = finalizeReadiness(await sch.runStatesForPeriod(p.id));
      if (!ready.ready) throw precondition(ready.reasons.join("; "));
      if (!(await sch.transitionPeriod({ id: p.id, from: "processing", to: "closed", set: { finalizedByUserId: ctx.user.id, finalizedAt: new Date() } }))) throw precondition("The period moved while you were acting on it");
      return { periodRef: p.periodRef, state: "closed" as const, stateLabel: PERIOD_STATE_LABEL.closed, locked: true };
    }),

  /** DRAFT/OPEN → VOIDED, with a reason, only while no run and no earning references the period. */
  periodVoid: moneyScoped(roleProcedure("payrollSchedule.periodVoid"))
    .input(z.object({ periodRef: REF, reason: REASON }))
    .mutation(async ({ ctx, input }) => {
      const p = await periodInScope(input.periodRef, ctx.money);
      requireEdge(p.state as PayPeriodState, "voided");
      const ready = voidReadiness({ runCount: (await sch.runStatesForPeriod(p.id)).length, earningCount: await sch.earningCountForPeriod(p.id), timeEntryCount: await sch.timeEntryCountForPeriod(p.id) });
      if (!ready.ready) throw precondition(ready.reasons.join("; "));
      if (!(await sch.transitionPeriod({ id: p.id, from: p.state as PayPeriodState, to: "voided", set: { voidedByUserId: ctx.user.id, voidedAt: new Date(), voidReason: input.reason, lockedAt: new Date(), lockedByUserId: ctx.user.id } }))) throw precondition("The period moved while you were acting on it");
      return { periodRef: p.periodRef, state: "voided" as const, stateLabel: PERIOD_STATE_LABEL.voided };
    }),
});
