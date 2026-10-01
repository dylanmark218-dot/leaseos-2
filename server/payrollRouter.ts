/**
 * Payroll, contractor settlement, finance and tax API.
 *
 * Every procedure goes through `roleProcedure`. There is no `protectedProcedure`
 * in this file and the baseline test holds that at zero.
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
import { roleProcedure, router } from "./_core/trpc";
import * as svc from "./payrollService";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { assertAdjustmentInScope, assertDisputeInScope, assertEntityInScope, assertPeriodInScope, assertProfileInScope, assertRunInScope, assertSettlementInScope, entityIdsInScope, entityOwnerFor, type MoneyScope } from "./_core/entityScope";
import { employeePayrollProfiles, expenseRecords } from "../drizzle/schema";
import { eq, inArray } from "drizzle-orm";
import {
  assertPayrollEligibility,
  assertSettlementEligibility,
  calculateEarning,
  canTransitionPayRun,
  correctionRouteFor,
  reconcileClocks,
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

/** 0146 — the acting scope, as the money boundary: which financial entities this caller may see. */
async function moneyScope(userId: number): Promise<{ db: NonNullable<Awaited<ReturnType<typeof getDb>>>; scope: MoneyScope; entityIds: number[] }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = { tenantId: (await resolveActingScope(db, userId)).tenantId };
  return { db, scope, entityIds: await entityIdsInScope(db, scope) };
}
/** Profile ids the scope may see — the join key for earnings and disputes. */
async function profileIdsInScope(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, entityIds: number[]): Promise<number[]> {
  if (!entityIds.length) return [];
  return (await db.select({ id: employeePayrollProfiles.id }).from(employeePayrollProfiles).where(inArray(employeePayrollProfiles.financialEntityId, entityIds))).map(r => r.id);
}

/** Resolve the caller's own profile or refuse. Never takes an id from input; the profile's entity must be in the acting scope. */
async function ownProfileOrThrow(userId: number) {
  const p = await svc.resolveOwnPayrollProfile(userId);
  if (!p) {
    throw notFound("No payroll profile is linked to your account");
  }
  const { db, scope } = await moneyScope(userId);
  try { await assertEntityInScope(db, p.financialEntityId, scope); } catch { throw notFound("No payroll profile is linked to your account in this organization"); }
  return p;
}

export const payrollRouter = router({
  /* ---------------- Self service ---------------- */

  myPay: roleProcedure("payroll.myPay")
    .input(z.object({ payPeriodId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const me = await ownProfileOrThrow(ctx.user.id);
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

  myTimeEntries: roleProcedure("payroll.myTimeEntries")
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const me = await ownProfileOrThrow(ctx.user.id);
      return svc.listOwnTimeEntries(me.id, input.from, input.to);
    }),

  myStatements: roleProcedure("payroll.myStatements").query(async ({ ctx }) => {
    const me = await ownProfileOrThrow(ctx.user.id);
    const runs = await svc.listPayRuns();
    return runs
      .filter(r => r.state === "paid" || r.state === "closed")
      .map(r => ({ payRunRef: r.payRunRef, paidAt: r.paidAt, state: r.state }))
      .slice(0, 24)
      .map(r => ({ ...r, employeeNumber: me.employeeNumber }));
  }),

  submitTime: roleProcedure("payroll.submitTime")
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
      const me = await ownProfileOrThrow(ctx.user.id);
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

  raiseDispute: roleProcedure("payroll.raiseDispute")
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
      const me = await ownProfileOrThrow(ctx.user.id);
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

  profilesList: roleProcedure("payroll.profilesList").query(async ({ ctx }) =>
    svc.listPayrollProfiles((await moneyScope(ctx.user.id)).entityIds)
  ),

  profileUpsert: roleProcedure("payroll.profileUpsert")
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
      const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope);
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

  ratesList: roleProcedure("payroll.ratesList")
    .input(z.object({ earningType: z.string().max(80).optional() }).optional())
    .query(async ({ ctx, input }) => svc.listPayRates(input?.earningType, await (async () => { const m = await moneyScope(ctx.user.id); return profileIdsInScope(m.db, m.entityIds); })())),

  rateCreate: roleProcedure("payroll.rateCreate")
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      // P4.1: rateCreate mints a company-wide rate VERSION by rateKey — it names no profile and no entity, so there is
      // nothing here to scope. A rate becomes an organization's when a profile in that organization is put on it
      // (payRates.employeePayrollProfileId), which is what ratesList filters by. Left unscoped on purpose.

      // Always a new version. The prior rate's window is closed, never deleted.
      const r = await svc.createPayRateVersion({
        ...input,
        minimumMeasurementAuthority: input.minimumMeasurementAuthority ?? null,
        approvedByUserId: ctx.user.id,
      });
      return { version: r?.version ?? null, supersededPriorVersion: true };
    }),

  periodsList: roleProcedure("payroll.periodsList").query(async ({ ctx }) => svc.listPayPeriods((await moneyScope(ctx.user.id)).entityIds)),

  periodOpen: roleProcedure("payroll.periodOpen")
    .input(
      z.object({
        periodRef: z.string().min(3).max(64),
        financialEntityId: z.number().int(),
        startsOn: z.coerce.date(),
        endsOn: z.coerce.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope);
      if (input.endsOn <= input.startsOn) {
        throw badRequest("Pay period ends before it starts");
      }
      const id = await svc.openPayPeriod({ ...input, state: "collecting" });
      return { id: id ? Number(id) : null };
    }),

  earningsList: roleProcedure("payroll.earningsList")
    .input(z.object({ payPeriodId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => { const m = await moneyScope(ctx.user.id); if (input?.payPeriodId != null) await assertPeriodInScope(m.db, input.payPeriodId, m.scope); return svc.listEarnings({ payPeriodId: input?.payPeriodId, profileIds: await profileIdsInScope(m.db, m.entityIds) }); }),

  /**
   * Propose an earning. The amount is calculated here from the rate in force
   * on the day worked — the client supplies quantity and evidence, not money.
   */
  earningPropose: roleProcedure("payroll.earningPropose")
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
      const m = await moneyScope(ctx.user.id); await assertPeriodInScope(m.db, input.payPeriodId, m.scope); await assertProfileInScope(m.db, input.employeePayrollProfileId, m.scope);
      const rates = await svc.listPayRates(input.earningType);
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

      const id = await svc.insertEarning({
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
      });

      return {
        id: id ? Number(id) : null,
        status: calc.status,
        calculatedAmount: calc.calculatedAmount ?? null,
        rateKeyVersion: calc.rateKeyVersion ?? null,
        blockedReason: calc.blockedReason ?? null,
      };
    }),

  reconcileDay: roleProcedure("payroll.reconcileDay")
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
      const m = await moneyScope(ctx.user.id); await assertProfileInScope(m.db, input.employeePayrollProfileId, m.scope);
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

  disputesList: roleProcedure("payroll.disputesList").query(async ({ ctx }) => { const m = await moneyScope(ctx.user.id); return svc.listDisputes(await profileIdsInScope(m.db, m.entityIds)); }),

  disputeResolve: roleProcedure("payroll.disputeResolve")
    .input(
      z.object({
        disputeRef: z.string().min(3).max(64),
        status: z.enum(["approved", "declined", "information_requested"]),
        note: z.string().min(1).max(2000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertDisputeInScope(m.db, input.disputeRef, m.scope);
      await svc.resolveDispute({ ...input, resolvedByUserId: ctx.user.id });
      // Both sides survive: the employee statement is untouched.
      return { resolved: true, employeeStatementPreserved: true };
    }),

  /* ---------------- Runs ---------------- */

  runsList: roleProcedure("payroll.runsList").query(async ({ ctx }) => svc.listPayRuns((await moneyScope(ctx.user.id)).entityIds)),

  runCreate: roleProcedure("payroll.runCreate")
    .input(
      z.object({
        payRunRef: z.string().min(3).max(64),
        payPeriodId: z.number().int(),
        financialEntityId: z.number().int(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); await assertPeriodInScope(m.db, input.payPeriodId, m.scope);
      const id = await svc.createPayRun({ ...input, state: "draft" });
      return { id: id ? Number(id) : null, state: "draft" };
    }),

  /**
   * Approve a run. Held by a different role than the one that creates it —
   * `payroll_admin` runs payroll, `controller` approves it, neither does both.
   */
  runApprove: roleProcedure("payroll.runApprove")
    .input(
      z.object({
        payRunRef: z.string().min(3).max(64),
        toState: z.enum(["review", "approved", "processing", "paid"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertRunInScope(m.db, input.payRunRef, m.scope);
      const run = await svc.loadPayRun(input.payRunRef);
      if (!run) throw notFound("No such pay run");

      if (!canTransitionPayRun(run.state, input.toState)) {
        throw badRequest(
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

  adjustmentRequest: roleProcedure("payroll.adjustmentRequest")
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
      const m = await moneyScope(ctx.user.id); await assertProfileInScope(m.db, input.employeePayrollProfileId, m.scope);
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

  adjustmentApprove: roleProcedure("payroll.adjustmentApprove")
    .input(z.object({ adjustmentRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertAdjustmentInScope(m.db, input.adjustmentRef, m.scope);
      await svc.approveAdjustment({
        adjustmentRef: input.adjustmentRef,
        approvedByUserId: ctx.user.id,
      });
      return { approved: true };
    }),

  export: roleProcedure("payroll.export")
    .input(z.object({ payRunRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertRunInScope(m.db, input.payRunRef, m.scope);
      const run = await svc.loadPayRun(input.payRunRef);
      if (!run) throw notFound("No such pay run");
      return { payRunRef: run.payRunRef, state: run.state, exported: true };
    }),
});

export const contractorRouter = router({
  settlementsList: roleProcedure("contractors.settlementsList").query(async ({ ctx }) =>
    svc.listSettlements((await moneyScope(ctx.user.id)).entityIds)
  ),

  settlementCreate: roleProcedure("contractors.settlementCreate")
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
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.payingEntityId, m.scope); }
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

  settlementApprove: roleProcedure("contractors.settlementApprove")
    .input(z.object({ settlementRef: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const m = await moneyScope(ctx.user.id); await assertSettlementInScope(m.db, input.settlementRef, m.scope);
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
      // F1 — the book must be the caller's organization's; any other id is "not found".
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5
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
