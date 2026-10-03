/**
 * Payroll, contractor settlement, finance and tax API.
 *
 * Every procedure goes through `roleProcedure`. There is no `protectedProcedure`
 * in this file and the baseline test holds that at zero.
 *
 * P0 (Payroll repair, 2026-10-02): the `payroll` and `contractors` namespaces wrap
 * the role gate in `moneyScoped` — the caller's books arrive as `ctx.money`
 * (F1) and every record named in input is proved against them with the 0146
 * helpers; anything outside is "not found". The `finance` namespace keeps its
 * own in-handler `moneyScope()` and the same helpers, which the coverage test
 * accepts as self-scoped.
 *
 * Three things the request never supplies:
 *
 *   Whose pay it is. Self-service procedures resolve the employee profile from
 *   the session. `employeePayrollProfileId` is not an input to any `my*`
 *   procedure — a client that can name whose payslip it wants can name anyone's.
 *
 *   Whether a tax rule is verified. The service refuses to store a rule as
 *   verified unless its source is verified and names an authority, regardless
 *   of what the caller asked for.
 *
 *   What an earning is worth. The rate in force on the day worked is looked up
 *   server-side; the client supplies the quantity and the evidence, not the money.
 */

import { TRPCError } from "@trpc/server";
import { requireCallerUnits } from "./unitScope";
import { z } from "zod";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import * as svc from "./payrollService";
import { loadPeriodState } from "./payrollScheduleService";
import { PERIOD_STATE_LABEL, periodAcceptsEarnings, periodAcceptsRuns } from "./_core/payrollSchedule";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { assertAdjustmentInScope, assertDisputeInScope, assertEntityInScope, assertPeriodInScope, assertProfileInScope, assertRunInScope, assertSettlementInScope, entityIdsInScope, entityOwnerFor, ownsEntity, requireOwnedEntity, type FinanceScope, type MoneyScope } from "./_core/entityScope";
import { employeePayrollProfiles, expenseRecords } from "../drizzle/schema";
import { eq, inArray } from "drizzle-orm";
import {
  assertPayrollEligibility,
  assertSettlementEligibility,
  calculateEarning,
  canTransitionPayRun,
  correctionRouteFor,
  payRunMayCollect,
  reconcileClocks,
  separationOfDuties,
} from "./_core/payrollEngine";
import {
  assessExpense,
  applyHumanTreatment,
  buildAllocations,
  findDuplicateCandidates,
} from "./_core/expenseTreatment";
import {
  assessRegistrationThreshold,
  buildFilingProfile,
} from "./_core/taxRuleEngine";

const notFound = (m: string) => new TRPCError({ code: "NOT_FOUND", message: m });
const badRequest = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const forbidden = (m: string) => new TRPCError({ code: "FORBIDDEN", message: m });

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** 0146 — the acting scope, as the money boundary: which financial entities this caller may see. (finance namespace) */
async function moneyScope(userId: number): Promise<{ db: Db; scope: MoneyScope; entityIds: number[] }> {
  const db = await dbOrThrow();
  const scope = { tenantId: (await resolveActingScope(db, userId)).tenantId };
  return { db, scope, entityIds: await entityIdsInScope(db, scope) };
}
/** Profile ids the scope may see — the join key for earnings and disputes. */
async function profileIdsInScope(db: Db, entityIds: readonly number[]): Promise<number[]> {
  if (!entityIds.length) return [];
  return (await db.select({ id: employeePayrollProfiles.id }).from(employeePayrollProfiles).where(inArray(employeePayrollProfiles.financialEntityId, [...entityIds]))).map(r => r.id);
}

/**
 * Resolve the caller's own profile or refuse. Never takes an id from input; the profile's
 * book must be one of the caller's (`ctx.money`), or there is no profile "in this organization".
 */
async function ownProfileOrThrow(userId: number, money: FinanceScope) {
  const p = await svc.resolveOwnPayrollProfile(userId);
  if (!p) {
    throw notFound("No payroll profile is linked to your account");
  }
  if (!ownsEntity(money, p.financialEntityId)) throw notFound("No payroll profile is linked to your account in this organization");
  return p;
}

/** Translate a service-level precondition into the tRPC code the client expects. */
function rethrow(e: unknown): never {
  if (e instanceof TRPCError) throw e;
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined;
  if (code === "PRECONDITION_FAILED") throw precondition((e as Error).message);
  throw e;
}

export const payrollRouter = router({
  /* ---------------- Self service ---------------- */

  myPay: moneyScoped(roleProcedure("payroll.myPay"))
    .input(z.object({ payPeriodId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const me = await ownProfileOrThrow(ctx.user.id, ctx.money);
      const earnings = await svc.listEarnings({
        profileId: me.id,
        payPeriodId: input?.payPeriodId,
      });
      // Purpose-built shape. No banking, no tax identifier, no other employee.
      return {
        employeeNumber: me.employeeNumber,
        payrollStatus: me.payrollStatus,
        earnings: earnings.map(e => ({
          earningRef: e.earningRef,
          earningType: e.earningType,
          quantity: e.quantity,
          unit: e.unit,
          rateApplied: e.rateApplied,
          calculatedAmount: e.calculatedAmount,
          status: e.status,
          blockedReason: e.blockedReason,
          sourceRecordRef: e.sourceRecordRef,
        })),
      };
    }),

  myTimeEntries: moneyScoped(roleProcedure("payroll.myTimeEntries"))
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const me = await ownProfileOrThrow(ctx.user.id, ctx.money);
      return svc.listOwnTimeEntries(me.id, input.from, input.to);
    }),

  /**
   * P0.1 — the caller's own statements: the runs that carry a line for the caller's profile, in the
   * book that pays the profile. Nothing else. A run in another book, or a run in this book with no
   * line for this person, is not this person's statement — the previous version listed every book's
   * paid runs and stamped the caller's employee number on them.
   */
  myStatements: moneyScoped(roleProcedure("payroll.myStatements")).query(async ({ ctx }) => {
    const me = await ownProfileOrThrow(ctx.user.id, ctx.money);
    const statements = await svc.listOwnStatements({ profileId: me.id, financialEntityId: me.financialEntityId });
    return statements.map(s => ({ ...s, employeeNumber: me.employeeNumber }));
  }),

  submitTime: moneyScoped(roleProcedure("payroll.submitTime"))
    .input(
      z.object({
        activity: z.enum([
          "driving", "on_location", "loading", "unloading", "waiting",
          "standby", "shop", "training", "safety_meeting", "travel",
          "break", "off_duty",
        ]),
        startedAt: z.coerce.date(),
        endedAt: z.coerce.date().optional(),
        jobId: z.number().int().optional(),
        tripId: z.number().int().optional(),
        unitId: z.number().int().optional(),
        // No employeePayrollProfileId. It is the caller's own, always.
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5 — the profile is the caller's own; the unit must be too
      const me = await ownProfileOrThrow(ctx.user.id, ctx.money);
      const minutes = input.endedAt
        ? Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 60000)
        : null;
      if (minutes !== null && minutes < 0) {
        throw badRequest("End time is before start time");
      }
      const id = await svc.submitTimeEntry({
        employeePayrollProfileId: me.id,
        activity: input.activity,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        minutes,
        source: "employee_submitted",
        confirmedByEmployee: true,
        jobId: input.jobId ?? null,
        tripId: input.tripId ?? null,
        unitId: input.unitId ?? null,
        status: "submitted",
      });
      // Recording payroll activity never writes an HOS duty status.
      return { id: id ? Number(id) : null, hosDutyStatusChanged: false };
    }),

  raiseDispute: moneyScoped(roleProcedure("payroll.raiseDispute"))
    .input(
      z.object({
        disputeRef: z.string().min(3).max(64),
        recordedValue: z.string().max(120).optional(),
        claimedValue: z.string().max(120).optional(),
        statement: z.string().min(1).max(4000),
        payrollTimeEntryId: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const me = await ownProfileOrThrow(ctx.user.id, ctx.money);
      const id = await svc.raiseDispute({
        disputeRef: input.disputeRef,
        employeePayrollProfileId: me.id,
        payrollTimeEntryId: input.payrollTimeEntryId ?? null,
        recordedValue: input.recordedValue ?? null,
        claimedValue: input.claimedValue ?? null,
        // Stored verbatim. The recorded value is not altered by raising this.
        employeeStatement: input.statement,
      });
      return { id: id ? Number(id) : null, recordedValueChanged: false };
    }),

  /* ---------------- Administration ---------------- */

  profilesList: moneyScoped(roleProcedure("payroll.profilesList")).query(async ({ ctx }) =>
    svc.listPayrollProfiles([...ctx.money.entityIds])
  ),

  profileUpsert: moneyScoped(roleProcedure("payroll.profileUpsert"))
    .input(
      z.object({
        employeeNumber: z.string().min(1).max(40),
        financialEntityId: z.number().int(),
        employmentType: z.enum(["full_time", "part_time", "casual", "seasonal"]),
        defaultPayMethod: z.enum([
          "hourly", "salary", "mileage", "load", "tonne",
          "percentage", "piecework", "mixed",
        ]),
        operatorId: z.number().int().optional(),
        userId: z.number().int().optional(),
        payGroupId: z.number().int().optional(),
        workerKind: z.enum(["employee", "contractor"]).default("employee"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      // A contractor does not get an employee payroll profile because they
      // drove a truck. Hard refusal, not a warning.
      const eligible = assertPayrollEligibility({ kind: input.workerKind });
      if (!eligible.allowed) throw badRequest(eligible.reason!);

      const id = await svc.upsertPayrollProfile({
        employeeNumber: input.employeeNumber,
        financialEntityId: input.financialEntityId,
        employmentType: input.employmentType,
        defaultPayMethod: input.defaultPayMethod,
        operatorId: input.operatorId ?? null,
        userId: input.userId ?? null,
        payGroupId: input.payGroupId ?? null,
        effectiveFrom: new Date(),
      });
      return { id: id ? Number(id) : null };
    }),

  ratesList: moneyScoped(roleProcedure("payroll.ratesList"))
    .input(z.object({ earningType: z.string().max(80).optional() }).optional())
    .query(async ({ ctx, input }) => svc.listPayRates(input?.earningType, await profileIdsInScope(await dbOrThrow(), ctx.money.entityIds))),

  /**
   * P0.2 — the legacy rate path, scoped. A rate version belongs to a book through the profile or
   * the pay group it is attached to, so a new rate names one of them and the book must be the
   * caller's; superseding an existing key is refused unless the key's current version is already
   * in the caller's books. A key with no owner (neither profile nor group) is nobody's to
   * supersede. Before this, a controller anywhere could close any organization's rate window.
   * Compensation agreements (P1) replace this path for new configuration; it stays readable.
   */
  rateCreate: moneyScoped(roleProcedure("payroll.rateCreate"))
    .input(
      z.object({
        rateKey: z.string().min(1).max(120),
        earningType: z.string().min(1).max(80),
        calculation: z.enum(["hourly", "quantity_times_rate", "percentage", "flat", "formula"]),
        rate: z.number().nonnegative(),
        unit: z.enum(["hour", "km", "load", "tonne", "m3", "percent", "each"]),
        effectiveFrom: z.coerce.date(),
        minimumMeasurementAuthority: z
          .enum(["authority_certified", "instrument_measured", "system_derived"])
          .optional(),
        employeePayrollProfileId: z.number().int().optional(),
        payGroupId: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      if ((input.employeePayrollProfileId == null) === (input.payGroupId == null)) {
        throw badRequest("A pay rate is attached to exactly one of a payroll profile or a pay group");
      }
      // The owner named in input must be the caller's.
      if (input.employeePayrollProfileId != null) await assertProfileInScope(db, input.employeePayrollProfileId, ctx.money);
      if (input.payGroupId != null) {
        const g = await svc.loadPayGroup(input.payGroupId);
        if (!g || !ownsEntity(ctx.money, g.financialEntityId)) throw notFound(`Pay group ${input.payGroupId} not found`);
      }
      // The key being superseded, if it exists, must already be the caller's.
      const prior = await svc.loadLatestPayRate(input.rateKey);
      if (prior) {
        const ownerEntityId = await svc.payRateOwnerEntityId(prior);
        if (!ownsEntity(ctx.money, ownerEntityId)) throw notFound(`Pay rate ${input.rateKey} not found`);
      }

      // Always a new version. The prior rate's window is closed, never deleted.
      const r = await svc.createPayRateVersion({
        ...input,
        minimumMeasurementAuthority: input.minimumMeasurementAuthority ?? null,
        approvedByUserId: ctx.user.id,
        payGroupId: input.payGroupId ?? null,
        employeePayrollProfileId: input.employeePayrollProfileId ?? null,
      });
      return { version: r?.version ?? null, supersededPriorVersion: prior != null };
    }),

  periodsList: moneyScoped(roleProcedure("payroll.periodsList")).query(async ({ ctx }) => svc.listPayPeriods([...ctx.money.entityIds])),

  periodOpen: moneyScoped(roleProcedure("payroll.periodOpen"))
    .input(
      z.object({
        periodRef: z.string().min(3).max(64),
        financialEntityId: z.number().int(),
        startsOn: z.coerce.date(),
        endsOn: z.coerce.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      if (input.endsOn <= input.startsOn) {
        throw badRequest("Pay period ends before it starts");
      }
      // P2: an ad-hoc period records who opened it, so its approval can be refused to them.
      const id = await svc.openPayPeriod({ ...input, state: "collecting", createdByUserId: ctx.user.id });
      return { id: id ? Number(id) : null };
    }),

  earningsList: moneyScoped(roleProcedure("payroll.earningsList"))
    .input(z.object({ payPeriodId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      if (input?.payPeriodId != null) await assertPeriodInScope(db, input.payPeriodId, ctx.money);
      return svc.listEarnings({ payPeriodId: input?.payPeriodId, profileIds: await profileIdsInScope(db, ctx.money.entityIds) });
    }),

  /**
   * Propose an earning. The amount is calculated here from the rate in force
   * on the day worked — the client supplies quantity and evidence, not money.
   * The proposer is written to the trail beside the row (P0.3): approving an
   * earning is a different person's act.
   */
  earningPropose: moneyScoped(roleProcedure("payroll.earningPropose"))
    .input(
      z.object({
        earningRef: z.string().min(3).max(64),
        employeePayrollProfileId: z.number().int(),
        payPeriodId: z.number().int(),
        earningType: z.string().min(1).max(80),
        source: z.enum([
          "approved_timesheet", "trip", "load", "field_ticket",
          "safety_meeting", "work_order", "manual_hr_adjustment",
        ]),
        quantity: z.number(),
        unit: z.enum(["hour", "km", "load", "tonne", "m3", "percent", "each"]),
        workedOn: z.coerce.date(),
        evidenceRefs: z.array(z.string().max(120)).default([]),
        measurementMethod: z.string().max(60).optional(),
        sourceRecordRef: z.string().max(120).optional(),
        // No rate, no amount. Those are server business.
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const period = await assertPeriodInScope(db, input.payPeriodId, ctx.money);
      const profile = await assertProfileInScope(db, input.employeePayrollProfileId, ctx.money);
      // The period and the profile must share a book: an earning is paid from the book that employs the person.
      if (period.financialEntityId !== profile.financialEntityId) throw badRequest("The pay period and the payroll profile belong to different financial entities");
      // P2 lock: earnings are proposed only into an OPEN period.
      const pstate = await loadPeriodState(input.payPeriodId);
      if (!pstate || !periodAcceptsEarnings(pstate)) throw precondition(`Pay period is ${pstate ? PERIOD_STATE_LABEL[pstate] : "unknown"}; earnings are proposed only into an open period`);
      const rates = await svc.listPayRates(input.earningType, await profileIdsInScope(db, ctx.money.entityIds));
      const calc = calculateEarning({
        proposal: {
          earningType: input.earningType,
          source: input.source,
          sourceRecordRef: input.sourceRecordRef ?? null,
          quantity: input.quantity,
          unit: input.unit,
          workedOn: input.workedOn,
          evidenceRefs: input.evidenceRefs,
          measurementMethod: input.measurementMethod ?? null,
        },
        rates,
      });

      const id = await svc.insertEarningWithTrail({
        earning: {
          earningRef: input.earningRef,
          employeePayrollProfileId: input.employeePayrollProfileId,
          payPeriodId: input.payPeriodId,
          earningType: input.earningType,
          source: input.source,
          sourceRecordRef: input.sourceRecordRef ?? null,
          quantity: input.quantity,
          unit: input.unit,
          rateApplied: calc.rateApplied ?? null,
          rateKeyVersion: calc.rateKeyVersion ?? null,
          calculatedAmount: calc.calculatedAmount ?? null,
          measurementAuthority: calc.measurementAuthority ?? null,
          blockedReason: calc.blockedReason ?? null,
          // A blocked earning is recorded as held, not silently dropped — the
          // exception centre needs to see it.
          status: calc.status === "calculated" ? "pending" : "held",
        },
        trail: { actorUserId: ctx.user.id, procedureName: "payroll.earningPropose", permission: "payroll.run", subjectType: "payrollEarning", subjectId: input.earningRef, detail: "proposed" },
      }).catch(rethrow);

      return {
        id: id ? Number(id) : null,
        status: calc.status,
        calculatedAmount: calc.calculatedAmount ?? null,
        rateKeyVersion: calc.rateKeyVersion ?? null,
        blockedReason: calc.blockedReason ?? null,
      };
    }),

  /**
   * P0.5 — the human door between a proposed earning and a payable line. `pending → approved`,
   * by someone other than the proposer, in the caller's books. A `held` earning is blocked for a
   * stated reason and is not approvable; it needs a new proposal with the defect cured.
   */
  earningApprove: moneyScoped(roleProcedure("payroll.earningApprove"))
    .input(z.object({ earningRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const e = await svc.loadEarning(input.earningRef);
      if (!e) throw notFound(`Earning ${input.earningRef} not found`);
      try { await assertProfileInScope(db, e.employeePayrollProfileId, ctx.money); } catch { throw notFound(`Earning ${input.earningRef} not found`); }
      const proposer = await svc.findOriginator({ subjectType: "payrollEarning", subjectId: input.earningRef, procedureName: "payroll.earningPropose" });
      const sod = separationOfDuties({ originatorUserId: proposer, actorUserId: ctx.user.id, act: "approve this earning" });
      if (!sod.allowed) throw forbidden(sod.reason!);
      if (e.status !== "pending") throw precondition(`Earning is ${e.status}; only a pending earning can be approved${e.status === "held" ? ` (held: ${e.blockedReason ?? "blocked"})` : ""}`);
      const r = await svc.approveEarning({ earningRef: input.earningRef });
      if (r !== "approved") throw precondition("Earning is no longer pending");
      return { earningRef: input.earningRef, status: "approved" as const };
    }),

  reconcileDay: moneyScoped(roleProcedure("payroll.reconcileDay"))
    .input(
      z.object({
        employeePayrollProfileId: z.number().int(),
        forDate: z.coerce.date(),
        employeeSubmittedMinutes: z.number().int().optional(),
        hosOnDutyMinutes: z.number().int().optional(),
        leaseosActivityMinutes: z.number().int().optional(),
        toleranceMinutes: z.number().int().min(0).max(240).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertProfileInScope(await dbOrThrow(), input.employeePayrollProfileId, ctx.money);
      const r = reconcileClocks({
        readings: {
          employeeSubmittedMinutes: input.employeeSubmittedMinutes ?? null,
          hosOnDutyMinutes: input.hosOnDutyMinutes ?? null,
          leaseosActivityMinutes: input.leaseosActivityMinutes ?? null,
        },
        toleranceMinutes: input.toleranceMinutes,
      });
      await svc.recordReconciliation({
        employeePayrollProfileId: input.employeePayrollProfileId,
        forDate: input.forDate,
        employeeSubmittedMinutes: input.employeeSubmittedMinutes ?? null,
        hosOnDutyMinutes: input.hosOnDutyMinutes ?? null,
        leaseosActivityMinutes: input.leaseosActivityMinutes ?? null,
        varianceMinutes: r.varianceMinutes,
        outcome: r.outcome,
      });
      // The employee's submitted time is not altered by reconciling.
      return { ...r, employeeSubmittedTimeChanged: false };
    }),

  disputesList: moneyScoped(roleProcedure("payroll.disputesList")).query(async ({ ctx }) => svc.listDisputes(await profileIdsInScope(await dbOrThrow(), ctx.money.entityIds))),

  disputeResolve: moneyScoped(roleProcedure("payroll.disputeResolve"))
    .input(
      z.object({
        disputeRef: z.string().min(3).max(64),
        status: z.enum(["approved", "declined", "information_requested"]),
        note: z.string().min(1).max(2000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDisputeInScope(await dbOrThrow(), input.disputeRef, ctx.money);
      await svc.resolveDispute({ ...input, resolvedByUserId: ctx.user.id });
      // Both sides survive: the employee statement is untouched.
      return { resolved: true, employeeStatementPreserved: true };
    }),

  /* ---------------- Runs ---------------- */

  runsList: moneyScoped(roleProcedure("payroll.runsList")).query(async ({ ctx }) => svc.listPayRuns([...ctx.money.entityIds])),

  /**
   * Create a run in `draft`, and write who created it to the trail in the same transaction
   * (P0.3): `runApprove` refuses the creator. The period must belong to the run's book.
   */
  runCreate: moneyScoped(roleProcedure("payroll.runCreate"))
    .input(
      z.object({
        payRunRef: z.string().min(3).max(64),
        payPeriodId: z.number().int(),
        financialEntityId: z.number().int(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const period = await assertPeriodInScope(db, input.payPeriodId, ctx.money);
      if (period.financialEntityId !== input.financialEntityId) throw badRequest("The pay period belongs to a different financial entity than the run");
      // P2 lock: a run is created only while its period is OPEN or REVIEWING.
      const pstate = await loadPeriodState(input.payPeriodId);
      if (!pstate || !periodAcceptsRuns(pstate)) throw precondition(`Pay period is ${pstate ? PERIOD_STATE_LABEL[pstate] : "unknown"}; a pay run is created only on an open or reviewing period`);
      let id: number | undefined;
      try {
        id = await svc.createPayRunWithTrail({
          run: { ...input, state: "draft" },
          trail: { actorUserId: ctx.user.id, procedureName: "payroll.runCreate", permission: "payroll.run", subjectType: "payRun", subjectId: input.payRunRef, detail: "created" },
        });
      } catch (e) { rethrow(e); }
      return { id: id ? Number(id) : null, state: "draft" as const };
    }),

  /**
   * P0.4 / P0.5 — collect approved earnings into the run's lines. `draft → collecting` on first
   * call (the engine's transition), then every call adds only what is approved, in this book and
   * period, with an integer amount, and not already carried by any run. Idempotent: calling it
   * again collects nothing new and says so. Nothing operational (HOS, dispatch, tickets) is read
   * here — only earning events a person proposed and another person approved.
   */
  runCollect: moneyScoped(roleProcedure("payroll.runCollect"))
    .input(z.object({ payRunRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertRunInScope(await dbOrThrow(), input.payRunRef, ctx.money);
      const run = await svc.loadPayRun(input.payRunRef);
      if (!run) throw notFound("No such pay run");
      if (!payRunMayCollect(run.state)) throw precondition(`Pay run is ${run.state}; lines may be collected only in draft or collecting`);
      if (run.state === "draft" && !canTransitionPayRun(run.state, "collecting")) throw precondition(`Illegal pay run transition ${run.state} → collecting`);
      let result: Awaited<ReturnType<typeof svc.collectApprovedEarnings>> = null;
      try { result = await svc.collectApprovedEarnings({ payRunRef: input.payRunRef }); } catch (e) { rethrow(e); }
      if (!result) throw notFound("No such pay run");
      return result;
    }),

  /** `collecting → review`: the administrator says the lines are complete; approval is someone else's. */
  runSubmit: moneyScoped(roleProcedure("payroll.runSubmit"))
    .input(z.object({ payRunRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertRunInScope(await dbOrThrow(), input.payRunRef, ctx.money);
      const run = await svc.loadPayRun(input.payRunRef);
      if (!run) throw notFound("No such pay run");
      if (!canTransitionPayRun(run.state, "review")) throw precondition(`Illegal pay run transition ${run.state} → review`);
      await svc.setPayRunState({ payRunRef: input.payRunRef, state: "review" });
      return { state: "review" as const };
    }),

  /**
   * Approve a run. Held by a different role than the one that creates it —
   * `payroll_admin` runs payroll, `controller` approves it, neither does both —
   * and, since P0.3, by a different PERSON: the run's creator is refused whatever
   * roles they hold, and a run whose creator is not on the trail is refused too.
   */
  runApprove: moneyScoped(roleProcedure("payroll.runApprove"))
    .input(
      z.object({
        payRunRef: z.string().min(3).max(64),
        toState: z.enum(["review", "approved", "processing", "paid"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertRunInScope(await dbOrThrow(), input.payRunRef, ctx.money);
      const run = await svc.loadPayRun(input.payRunRef);
      if (!run) throw notFound("No such pay run");

      const creator = await svc.findOriginator({ subjectType: "payRun", subjectId: input.payRunRef, procedureName: "payroll.runCreate" });
      const sod = separationOfDuties({ originatorUserId: creator, actorUserId: ctx.user.id, act: "approve this pay run" });
      if (!sod.allowed) throw forbidden(sod.reason!);

      if (!canTransitionPayRun(run.state, input.toState)) {
        throw precondition(
          `Illegal pay run transition ${run.state} → ${input.toState}` +
            (correctionRouteFor(run.state) === "adjustment_required"
              ? " — a paid run is corrected by adjustment, never edited in place"
              : "")
        );
      }

      await svc.setPayRunState({
        payRunRef: input.payRunRef,
        state: input.toState,
        approvedByUserId: ctx.user.id,
      });
      return { state: input.toState };
    }),

  adjustmentRequest: moneyScoped(roleProcedure("payroll.adjustmentRequest"))
    .input(
      z.object({
        adjustmentRef: z.string().min(3).max(64),
        employeePayrollProfileId: z.number().int(),
        amount: z.number(),
        reason: z.string().min(3).max(2000),
        originalPayRunId: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertProfileInScope(await dbOrThrow(), input.employeePayrollProfileId, ctx.money);
      const id = await svc.requestAdjustment({
        adjustmentRef: input.adjustmentRef,
        employeePayrollProfileId: input.employeePayrollProfileId,
        originalPayRunId: input.originalPayRunId ?? null,
        amount: input.amount,
        reason: input.reason,
        requestedByUserId: ctx.user.id,
        requestedAt: new Date(),
      });
      return { id: id ? Number(id) : null, status: "requested" };
    }),

  adjustmentApprove: moneyScoped(roleProcedure("payroll.adjustmentApprove"))
    .input(z.object({ adjustmentRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertAdjustmentInScope(await dbOrThrow(), input.adjustmentRef, ctx.money);
      await svc.approveAdjustment({
        adjustmentRef: input.adjustmentRef,
        approvedByUserId: ctx.user.id,
      });
      return { approved: true };
    }),

  /** Still a stub: the export boundary (generic CSV, D5) is P6. It no longer claims `exported: true`. */
  export: moneyScoped(roleProcedure("payroll.export"))
    .input(z.object({ payRunRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertRunInScope(await dbOrThrow(), input.payRunRef, ctx.money);
      const run = await svc.loadPayRun(input.payRunRef);
      if (!run) throw notFound("No such pay run");
      return { payRunRef: run.payRunRef, state: run.state, exported: false, reason: "Export adapters are not built yet (payroll P6)" };
    }),
});

export const contractorRouter = router({
  settlementsList: moneyScoped(roleProcedure("contractors.settlementsList")).query(async ({ ctx }) =>
    svc.listSettlements([...ctx.money.entityIds])
  ),

  settlementCreate: moneyScoped(roleProcedure("contractors.settlementCreate"))
    .input(
      z.object({
        settlementRef: z.string().min(3).max(64),
        contractorEntityId: z.number().int(),
        payingEntityId: z.number().int(),
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
        workerKind: z.enum(["employee", "contractor"]).default("contractor"),
        lines: z
          .array(
            z.object({
              lineType: z.enum([
                "freight", "fuel_advance", "insurance",
                "equipment_rental", "deduction", "reimbursement", "other",
              ]),
              description: z.string().min(1).max(300),
              amount: z.number(),
              quantity: z.number().optional(),
              rateApplied: z.number().optional(),
              sourceRecordRef: z.string().max(120).optional(),
            })
          )
          .min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.payingEntityId, `Financial entity ${input.payingEntityId}`);
      // An employee is not settled as a contractor.
      const eligible = assertSettlementEligibility({ kind: input.workerKind });
      if (!eligible.allowed) throw badRequest(eligible.reason!);

      const gross = input.lines
        .filter(l => l.lineType === "freight" || l.lineType === "reimbursement")
        .reduce((s, l) => s + l.amount, 0);
      const deductions = input.lines
        .filter(l => l.lineType !== "freight" && l.lineType !== "reimbursement")
        .reduce((s, l) => s + Math.abs(l.amount), 0);

      const id = await svc.createSettlement({
        settlement: {
          settlementRef: input.settlementRef,
          contractorEntityId: input.contractorEntityId,
          payingEntityId: input.payingEntityId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          grossAmount: gross,
          deductionTotal: deductions,
          netAmount: Math.round((gross - deductions) * 100) / 100,
          // Whether an information return applies is a rules question, and no
          // verified rule is loaded. It stays unassessed rather than guessed.
          informationReturnAssessment: "rule_unverified",
          informationReturnNote:
            "No verified information-return rule loaded for this jurisdiction and year",
          state: "draft",
        },
        lines: input.lines.map(l => ({
          lineType: l.lineType,
          description: l.description,
          amount: l.amount,
          quantity: l.quantity ?? null,
          rateApplied: l.rateApplied ?? null,
          sourceRecordRef: l.sourceRecordRef ?? null,
        })),
      });
      return { id: id ?? null, grossAmount: gross, netAmount: gross - deductions };
    }),

  settlementApprove: moneyScoped(roleProcedure("contractors.settlementApprove"))
    .input(z.object({ settlementRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertSettlementInScope(await dbOrThrow(), input.settlementRef, ctx.money);
      await svc.approveSettlement({
        settlementRef: input.settlementRef,
        approvedByUserId: ctx.user.id,
      });
      return { approved: true };
    }),
});

export const financeRouter = router({
  entitiesList: roleProcedure("finance.entitiesList").query(async ({ ctx }) =>
    svc.listFinancialEntities((await moneyScope(ctx.user.id)).entityIds)
  ),

  entityCreate: roleProcedure("finance.entityCreate")
    .input(
      z.object({
        entityRef: z.string().min(2).max(64),
        legalName: z.string().min(1).max(220),
        operatingName: z.string().max(220).optional(),
        taxpayerType: z.enum([
          "corporation", "sole_proprietor", "partnership",
          "employee", "independent_contractor",
        ]),
        jurisdiction: z.string().min(2).max(80),
        fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
        fiscalYearEndDay: z.number().int().min(1).max(31).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id);
      const id = await svc.createFinancialEntity({
        orgRef: entityOwnerFor(m.scope),   // 0146: owned by the acting organization, or unowned under the default scope
        ...input,
        operatingName: input.operatingName ?? null,
        fiscalYearEndMonth: input.fiscalYearEndMonth ?? null,
        fiscalYearEndDay: input.fiscalYearEndDay ?? null,
      });
      return { id: id ? Number(id) : null };
    }),

  registrationsList: roleProcedure("finance.registrationsList")
    .input(z.object({ financialEntityId: z.number().int() }))
    .query(async ({ ctx, input }) => { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); return svc.listRegistrations(input.financialEntityId); }),

  expensesList: roleProcedure("finance.expensesList")
    .input(z.object({ financialEntityId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => { const m = await moneyScope(ctx.user.id); if (input?.financialEntityId != null) { await assertEntityInScope(m.db, input.financialEntityId, m.scope); return svc.listExpenses(input.financialEntityId); } const all = await svc.listExpenses(); return all.filter(e => m.entityIds.includes(e.financialEntityId)); }),

  /** Assess without persisting — what a human needs to look at, and why. */
  expenseAssess: roleProcedure("finance.expenseAssess")
    .input(
      z.object({
        total: z.number().positive(),
        transactionDate: z.coerce.date(),
        vendorName: z.string().max(220).optional(),
        categoryKey: z.string().max(120).optional(),
        categorySource: z
          .enum(["human", "ai_proposed", "ai_confirmed", "merchant_memory"])
          .default("human"),
        businessUsePercent: z.number().min(0).max(100).default(100),
        paidPersonally: z.boolean().default(false),
        hasReceiptEvidence: z.boolean(),
        capitalReviewThreshold: z.number().optional(),
      })
    )
    .query(({ input }) => assessExpense(input)),

  expenseCreate: roleProcedure("finance.expenseCreate")
    .input(
      z.object({
        expenseRef: z.string().min(3).max(64),
        financialEntityId: z.number().int(),
        total: z.number().positive(),
        transactionDate: z.coerce.date(),
        vendorName: z.string().max(220).optional(),
        subtotal: z.number().optional(),
        salesTaxAmount: z.number().optional(),
        categoryId: z.number().int().optional(),
        categorySource: z
          .enum(["human", "ai_proposed", "ai_confirmed", "merchant_memory"])
          .default("human"),
        businessUsePercent: z.number().min(0).max(100).default(100),
        paidPersonally: z.boolean().default(false),
        jobId: z.number().int().optional(),
        unitId: z.number().int().optional(),
        evidenceRecordId: z.number().int().optional(),
        allocationBasis: z.string().max(220).default("stated business use"),
        // `taxTreatment` is deliberately not an input. It defaults to review.
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5
      // F1 — the book must be the caller's organization's; any other id is "not found".
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }
      const allocations = buildAllocations({
        total: input.total,
        businessUsePercent: input.businessUsePercent,
        basis: input.allocationBasis,
      });

      const id = await svc.createExpense({
        expense: {
          expenseRef: input.expenseRef,
          financialEntityId: input.financialEntityId,
          vendorName: input.vendorName ?? null,
          transactionDate: input.transactionDate,
          subtotal: input.subtotal ?? null,
          salesTaxAmount: input.salesTaxAmount ?? null,
          total: input.total,
          categoryId: input.categoryId ?? null,
          categorySource: input.categorySource,
          businessUsePercent: input.businessUsePercent,
          paidByUserId: ctx.user.id,
          paidPersonally: input.paidPersonally,
          reimbursementRequired: input.paidPersonally,
          jobId: input.jobId ?? null,
          unitId: input.unitId ?? null,
          evidenceRecordId: input.evidenceRecordId ?? null,
          status: "submitted",
        },
        allocations: allocations.map(a => ({
          allocationType: a.allocationType,
          percent: a.percent,
          amount: a.amount,
          basis: a.basis,
          jobId: input.jobId ?? null,
          unitId: input.unitId ?? null,
        })),
      });

      return {
        id: id ?? null,
        taxTreatment: "unknown_review_required",
        allocations,
        // Both halves are stored. The personal portion is not discarded.
        personalPortionStored: allocations.some(a => a.allocationType === "personal"),
      };
    }),

  expenseSetTreatment: roleProcedure("finance.expenseSetTreatment")
    .input(
      z.object({
        expenseRef: z.string().min(3).max(64),
        treatment: z.enum([
          "potentially_deductible", "capital_asset", "inventory",
          "employee_reimbursement", "personal", "mixed_use",
          "non_deductible", "taxable_benefit_review",
        ]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // F1.1 — the expense is looked up and its book proved before its treatment changes.
      { const m = await moneyScope(ctx.user.id); const exp = (await m.db.select({ financialEntityId: expenseRecords.financialEntityId }).from(expenseRecords).where(eq(expenseRecords.expenseRef, input.expenseRef)).limit(1))[0]; if (!exp) throw notFound("Expense not found"); try { await assertEntityInScope(m.db, exp.financialEntityId, m.scope); } catch { throw notFound("Expense not found"); } }
      const applied = applyHumanTreatment({
        treatment: input.treatment,
        determinedByUserId: ctx.user.id,
      });
      if (!applied.ok) throw badRequest(applied.reason);

      await svc.setExpenseTreatment({
        expenseRef: input.expenseRef,
        treatment: input.treatment,
        determinedByUserId: ctx.user.id,
      });
      return { treatment: input.treatment, determinedBy: ctx.user.id };
    }),

  expenseDuplicates: roleProcedure("finance.expenseDuplicates")
    .input(
      z.object({
        financialEntityId: z.number().int(),
        vendorName: z.string().max(220).optional(),
        total: z.number(),
        transactionDate: z.coerce.date(),
      })
    )
    .query(async ({ ctx, input }) => {
      // F1 — another book's expenses are not duplicate candidates; they are not found.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }
      const existing = await svc.listExpenses(input.financialEntityId);
      // Candidates, never an automatic merge — merging the wrong pair loses a
      // real cost silently.
      return findDuplicateCandidates({
        candidate: {
          vendorName: input.vendorName ?? null,
          total: input.total,
          transactionDate: input.transactionDate,
        },
        existing: existing.map(e => ({
          expenseRef: e.expenseRef,
          vendorName: e.vendorName,
          total: e.total,
          transactionDate: e.transactionDate,
        })),
      });
    }),

  taxRulesList: roleProcedure("finance.taxRulesList")
    .input(z.object({ jurisdiction: z.string().max(80).optional() }).optional())
    .query(async ({ input }) => {
      const rules = await svc.loadTaxRules(input?.jurisdiction);
      return rules.map(r => ({
        ruleKey: r.ruleKey,
        version: r.version,
        jurisdiction: r.jurisdiction,
        ruleType: r.ruleType,
        taxYear: r.taxYear,
        status: r.status,
        effectiveFrom: r.effectiveFrom,
        sourceAuthority: r.source?.authority ?? null,
      }));
    }),

  /**
   * Load an authority-sourced rule. The only path from UNKNOWN to a number, and
   * held by exactly one role. A rule is stored `verified` only when its source
   * is itself verified and names an authority — the service downgrades it
   * otherwise, regardless of what was requested.
   */
  taxRuleLoad: roleProcedure("finance.taxRuleLoad")
    .input(
      z.object({
        ruleKey: z.string().min(3).max(120),
        jurisdiction: z.string().min(2).max(80),
        ruleType: z.string().min(2).max(80),
        taxYear: z.number().int().optional(),
        entityType: z.string().max(60).optional(),
        parameters: z.record(z.string(), z.unknown()),
        effectiveFrom: z.coerce.date(),
        effectiveUntil: z.coerce.date().optional(),
        requestedStatus: z.enum(["unverified", "verified"]).default("unverified"),
        source: z.object({
          sourceKey: z.string().min(2).max(120),
          authority: z.string().min(2).max(220),
          reference: z.string().max(500).optional(),
          verified: z.boolean().default(false),
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const r = await svc.upsertTaxRule({
        ruleKey: input.ruleKey,
        jurisdiction: input.jurisdiction,
        ruleType: input.ruleType,
        taxYear: input.taxYear ?? null,
        entityType: input.entityType ?? null,
        parameters: input.parameters,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil ?? null,
        requestedStatus: input.requestedStatus,
        source: {
          sourceKey: input.source.sourceKey,
          authority: input.source.authority,
          reference: input.source.reference ?? null,
          verified: input.source.verified,
          verifiedByUserId: input.source.verified ? ctx.user.id : null,
        },
      });
      return r;
    }),

  filingProfile: roleProcedure("finance.filingProfile")
    .input(
      z.object({
        taxpayerType: z.enum([
          "corporation", "sole_proprietor", "partnership",
          "employee", "independent_contractor",
        ]),
        jurisdiction: z.string().min(2).max(80),
        taxYear: z.number().int(),
      })
    )
    .query(async ({ input }) => {
      const rules = await svc.loadTaxRules(input.jurisdiction);
      // Returns zero obligations and incomplete=true when nothing is loaded.
      // Not even the obvious ones are asserted from code.
      return buildFilingProfile({ ...input, asOf: new Date(), rules });
    }),

  thresholdCheck: roleProcedure("finance.thresholdCheck")
    .input(
      z.object({
        jurisdiction: z.string().min(2).max(80),
        rollingRevenue: z.number().nonnegative(),
      })
    )
    .query(async ({ input }) => {
      const rules = await svc.loadTaxRules(input.jurisdiction);
      return assessRegistrationThreshold({
        rollingRevenue: input.rollingRevenue,
        jurisdiction: input.jurisdiction,
        asOf: new Date(),
        rules,
      });
    }),

  /* ---------------- Private personal organizer ---------------- */

  myTaxDocs: roleProcedure("finance.myTaxDocs").query(({ ctx }) =>
    // Scoped to the session user by construction. No employer role reaches this.
    svc.listOwnTaxDocuments(ctx.user.id)
  ),

  myTaxDocAdd: roleProcedure("finance.myTaxDocAdd")
    .input(
      z.object({
        documentKind: z.string().min(1).max(80),
        taxYear: z.number().int().optional(),
        evidenceRecordId: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = await svc.addOwnTaxDocument({
        ownerUserId: ctx.user.id,
        documentKind: input.documentKind,
        taxYear: input.taxYear ?? null,
        evidenceRecordId: input.evidenceRecordId ?? null,
      });
      return { id: id ? Number(id) : null };
    }),

  myTaxDocShare: roleProcedure("finance.myTaxDocShare")
    .input(z.object({ documentId: z.number().int(), entityId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const r = await svc.shareOwnTaxDocument({
        documentId: input.documentId,
        ownerUserId: ctx.user.id,
        entityId: input.entityId,
      });
      if (!r.ok) throw new TRPCError({ code: "FORBIDDEN", message: r.reason! });
      return { shared: true };
    }),
});
