/**
 * Roadside events, purchasing and Accounts Payable.
 *
 * Every procedure through `roleProcedure`. Three things the request never
 * supplies: the spending limits (rows the company set), the approver's
 * identity (the session), and whether a bill releases a unit (it does not).
 */

import { TRPCError } from "@trpc/server";
import { decide as ledgerDecide } from "./_core/commercialApprovalService";
import { z } from "zod";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { ownsEntity, requireOwnedEntity } from "./_core/entityScope";
import { customerAccountInScope, purchaseAuthorizationInScope, requireEvidence, requireJob, requireTrip, requireUnit, roadsideEventInScope, vendorBillInScope, vendorInScope } from "./financeScope";
import { assertPeriodOpen } from "./periodCloseService";
import { fromCents, toCents } from "./_core/money";
import { normaliseUnit, priceLineAndRecord } from "./_core/linePricing";
import { getDb, listActiveUserRoleNames } from "./db";
import {
  maintenanceDefects, purchaseAuthorizations, roadsideServiceEvents, spendingLimits,
  vendorBillLines, vendorBills, vendors, customerRecoveryProposals, units, customerAccounts } from "../drizzle/schema";
import {
  assessAccrual, decideApproval, fourWayMatch, proposeCustomerRecovery,
  reconcileBillLines, roadsideConsequences, routeApproval, type SpendingLimit,
} from "./_core/purchasing";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function limitsFor(entityId: number): Promise<SpendingLimit[]> {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  const rows = await db.select().from(spendingLimits).where(
    and(eq(spendingLimits.financialEntityId, entityId), or(isNull(spendingLimits.effectiveUntil), gte(spendingLimits.effectiveUntil, now)))
  );
  return rows.map(r => ({ role: r.role, emergencyPurchaseLimit: r.emergencyPurchaseLimit, standardPurchaseLimit: r.standardPurchaseLimit, canApproveUpTo: r.canApproveUpTo }));
}

const YES_NO_UNKNOWN = z.enum(["yes", "no", "unknown"]);

export const roadsideRouter = router({
  open: moneyScoped(roleProcedure("roadside.open"))
    .input(z.object({
      eventType: z.enum(["flat_tire","tire_blowout","engine_failure","electrical_failure","air_system","brake_issue","coolant_leak","hydraulic_leak","fuel_issue","def_issue","frozen_airline","tow","boost","lockout","collision_recovery","stuck_recovery","trailer_failure","other"]),
      unitId: z.number().int().positive(),
      jobId: z.number().int().positive().nullable().optional(),
      tripId: z.number().int().positive().nullable().optional(),
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      locationDescription: z.string().max(300).nullable().optional(),
      occurredAt: z.coerce.date(),
      vehicleMovable: YES_NO_UNKNOWN.default("unknown"),
      driverSafe: YES_NO_UNKNOWN.default("unknown"),
      loadStatus: z.enum(["empty", "loaded", "unknown"]).default("unknown"),
      dangerousGoods: YES_NO_UNKNOWN.default("unknown"),
      assistanceRequired: z.boolean().default(false),
      driverStatement: z.string().max(4000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // F1 — a roadside event is the unit's; the unit, and any job or trip it names, must be the caller's.
      await requireUnit(ctx.money, input.unitId);
      await requireJob(ctx.money, input.jobId);
      await requireTrip(ctx.money, input.tripId);

      const consequence = roadsideConsequences(input);
      const now = new Date();

      // The defect first, so the unit is held before anything else happens.
      // The driver's words are preserved as their statement, not rewritten.
      const defect = await db.insert(maintenanceDefects).values({
        unitId: input.unitId,
        title: `Roadside: ${input.eventType.replace(/_/g, " ")}`,
        severity: consequence.defectSeverity,
        status: "open",
        detail: input.driverStatement ?? null,
        reportedAt: input.occurredAt,
        reportedBy: ctx.user.id,
      });
      const defectId = Number(defect[0]?.insertId ?? 0);

      const eventRef = ref("RS");
      await db.insert(roadsideServiceEvents).values({
        eventRef, eventType: input.eventType, unitId: input.unitId,
        reportedByUserId: ctx.user.id, jobId: input.jobId ?? null, tripId: input.tripId ?? null,
        latitude: input.latitude ?? null, longitude: input.longitude ?? null,
        locationDescription: input.locationDescription ?? null,
        occurredAt: input.occurredAt, reportedAt: now,
        vehicleMovable: input.vehicleMovable, driverSafe: input.driverSafe,
        loadStatus: input.loadStatus, dangerousGoods: input.dangerousGoods,
        assistanceRequired: input.assistanceRequired,
        driverStatement: input.driverStatement ?? null,
        maintenanceDefectId: defectId || null,
        status: "open",
      });
      return { eventRef, defectId, ...consequence };
    }),

  assignVendor: moneyScoped(roleProcedure("roadside.assignVendor"))
    .input(z.object({ eventRef: z.string().min(1).max(64), vendorId: z.number().int().positive(), estimatedDelayMinutes: z.number().int().nonnegative().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const ev = await roadsideEventInScope(db, ctx.money, input.eventRef);
      const v = await vendorInScope(db, ctx.money, input.vendorId);
      if (v.status === "blocked") throw new TRPCError({ code: "CONFLICT", message: "Vendor is blocked" });
      await db.update(roadsideServiceEvents)
        .set({ assignedVendorId: input.vendorId, estimatedDelayMinutes: input.estimatedDelayMinutes ?? null, status: "vendor_assigned" })
        .where(eq(roadsideServiceEvents.id, ev.id));
      return { eventRef: input.eventRef, vendorId: input.vendorId, emergency24h: v.emergency24h };
    }),
});

export const purchasingRouter = router({
  request: moneyScoped(roleProcedure("purchasing.request"))
    .input(z.object({
      financialEntityId: z.number().int().positive(),
      vendorId: z.number().int().positive().nullable().optional(),
      vendorNameIfNew: z.string().max(180).nullable().optional(),
      unitId: z.number().int().positive().nullable().optional(),
      jobId: z.number().int().positive().nullable().optional(),
      roadsideEventRef: z.string().max(64).nullable().optional(),
      category: z.string().min(2).max(80),
      reason: z.string().min(3).max(400),
      estimatedAmount: z.number().positive(),
      emergency: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (!input.vendorId && !input.vendorNameIfNew) throw new TRPCError({ code: "BAD_REQUEST", message: "Name a vendor or a new vendor" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      if (input.vendorId) await vendorInScope(db, ctx.money, input.vendorId);
      await requireUnit(ctx.money, input.unitId);
      await requireJob(ctx.money, input.jobId);

      let roadsideEventId: number | null = null;
      if (input.roadsideEventRef) roadsideEventId = (await roadsideEventInScope(db, ctx.money, input.roadsideEventRef)).id;

      const roles = await listActiveUserRoleNames(ctx.user.id);
      const limits = await limitsFor(input.financialEntityId);
      const routing = routeApproval({ amount: input.estimatedAmount, emergency: input.emergency, requesterRoles: roles, limits });

      const authorizationRef = ref("PA");
      const now = new Date();
      // Within the requester's own limit: self-authorized, recorded as such.
      // Otherwise it waits for a different person.
      await db.insert(purchaseAuthorizations).values({
        authorizationRef, financialEntityId: input.financialEntityId,
        vendorId: input.vendorId ?? null, vendorNameIfNew: input.vendorNameIfNew ?? null,
        unitId: input.unitId ?? null, jobId: input.jobId ?? null, roadsideEventId,
        category: input.category, reason: input.reason,
        estimatedAmount: input.estimatedAmount,
        authorizedMaximum: routing.withinRequesterLimit ? input.estimatedAmount : null,
        emergency: input.emergency,
        requestedByUserId: ctx.user.id, requestedAt: now,
        approvedByUserId: routing.withinRequesterLimit ? ctx.user.id : null,
        approvedAt: routing.withinRequesterLimit ? now : null,
        decisionReason: routing.reason,
        status: routing.withinRequesterLimit ? "approved" : "requested",
        expiresAt: new Date(now.getTime() + (input.emergency ? 24 : 24 * 14) * 3_600_000),
      });
      return { authorizationRef, ...routing };
    }),

  approve: moneyScoped(roleProcedure("purchasing.approve"))
    .input(z.object({ authorizationRef: z.string().min(1).max(64), authorizedMaximum: z.number().positive(), decisionReason: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const pa = await purchaseAuthorizationInScope(db, ctx.money, input.authorizationRef);
      if (pa.status !== "requested") throw new TRPCError({ code: "CONFLICT", message: `Authorization is ${pa.status}` });

      const roles = await listActiveUserRoleNames(ctx.user.id);
      const limits = await limitsFor(pa.financialEntityId);
      const decision = decideApproval({
        requestedByUserId: pa.requestedByUserId, approverUserId: ctx.user.id, approverRoles: roles,
        estimatedAmount: pa.estimatedAmount, authorizedMaximum: input.authorizedMaximum, limits,
      });
      if (!decision.ok) throw new TRPCError({ code: "FORBIDDEN", message: decision.reason });

      await db.update(purchaseAuthorizations).set({
        authorizedMaximum: decision.authorizedMaximum, approvedByUserId: ctx.user.id, approvedAt: new Date(),
        decisionReason: input.decisionReason ?? null, status: "approved",
      }).where(eq(purchaseAuthorizations.id, pa.id));
      return { authorizationRef: pa.authorizationRef, authorizedMaximum: decision.authorizedMaximum };
    }),
});

const LINE = z.object({
  lineNo: z.number().int().positive(),
  lineType: z.enum(["part","labour","service_call","freight","shop_supplies","environmental_fee","disposal_fee","core_charge","core_credit","tire_levy","tax","warranty_credit","discount","other"]),
  serviceCode: z.string().min(1).max(60).optional(),          // v22.8 — a subcontractor line that names its service is priced against the agreed payable
  unit: z.string().max(30).optional(),
  description: z.string().min(1).max(300),
  quantity: z.number(),
  unitPrice: z.number(),
  amount: z.number(),
});

export const vendorRouter = router({
  billRecord: moneyScoped(roleProcedure("vendor.billRecord"))
    .input(z.object({
      financialEntityId: z.number().int().positive(),
      vendorId: z.number().int().positive(),
      vendorInvoiceNumber: z.string().min(1).max(80),
      invoiceDate: z.coerce.date(),
      serviceDate: z.coerce.date().nullable().optional(),
      subtotal: z.number(), taxAmount: z.number().default(0), total: z.number(),
      lines: z.array(LINE).min(1),
      purchaseAuthorizationRef: z.string().max(64).nullable().optional(),
      roadsideEventRef: z.string().max(64).nullable().optional(),
      unitId: z.number().int().positive().nullable().optional(),
      jobId: z.number().int().positive().nullable().optional(),
      customerAccountRef: z.string().max(64).optional(),           // v22.8 — the customer the subcontracted work was for, so a customer-specific payable resolves
      evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      await vendorInScope(db, ctx.money, input.vendorId);
      await requireUnit(ctx.money, input.unitId);
      await requireJob(ctx.money, input.jobId);
      await requireEvidence(ctx.money, input.evidenceRecordId);
      const recon = reconcileBillLines({ lines: input.lines, statedSubtotal: input.subtotal, statedTax: input.taxAmount, statedTotal: input.total });
      if (!recon.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Bill lines do not reconcile: ${recon.refusals.join("; ")}` });

      const dup = await db.select({ id: vendorBills.id }).from(vendorBills)
        .where(and(eq(vendorBills.vendorId, input.vendorId), eq(vendorBills.vendorInvoiceNumber, input.vendorInvoiceNumber))).limit(1);
      if (dup[0]) throw new TRPCError({ code: "CONFLICT", message: `Invoice ${input.vendorInvoiceNumber} from this vendor is already recorded as bill #${dup[0].id}` });

      let paId: number | null = null;
      if (input.purchaseAuthorizationRef) {
        // As before, a reference that names nothing links nothing — and F1: one in another book names nothing.
        const pa = await db.select({ id: purchaseAuthorizations.id, financialEntityId: purchaseAuthorizations.financialEntityId }).from(purchaseAuthorizations).where(eq(purchaseAuthorizations.authorizationRef, input.purchaseAuthorizationRef)).limit(1);
        paId = pa[0] && pa[0].financialEntityId === input.financialEntityId ? pa[0].id : null;
      }
      let rsId: number | null = null;
      if (input.roadsideEventRef) {
        rsId = await roadsideEventInScope(db, ctx.money, input.roadsideEventRef).then(e => e.id, () => null);
      }

      const accrual = assessAccrual({ serviceDate: input.serviceDate ?? null, invoiceDate: input.invoiceDate });
      const billRef = ref("BILL");
      const ins = await db.insert(vendorBills).values({
        billRef, financialEntityId: input.financialEntityId, vendorId: input.vendorId, recordedByUserId: ctx.user.id,
        vendorInvoiceNumber: input.vendorInvoiceNumber, invoiceDate: input.invoiceDate,
        serviceDate: input.serviceDate ?? null, receivedAt: new Date(),
        currency: "CAD", subtotalCents: toCents(recon.subtotal), taxAmountCents: toCents(recon.tax), totalCents: toCents(recon.total)!,
        purchaseAuthorizationId: paId, roadsideEventId: rsId,
        unitId: input.unitId ?? null, jobId: input.jobId ?? null, evidenceRecordId: input.evidenceRecordId ?? null,
        accountingPeriod: accrual.servicePeriod, accrualCandidate: accrual.accrualCandidate,
        status: input.evidenceRecordId ? "needs_coding" : "missing_receipt",
      });
      const billId = Number(ins[0]?.insertId ?? 0);
      await db.insert(vendorBillLines).values(input.lines.map(l => ({
        serviceCode: l.serviceCode ?? null,
        vendorBillId: billId, lineNo: l.lineNo, lineType: l.lineType, description: l.description,
        quantity: l.quantity, unitPriceCents: toCents(l.unitPrice), amountCents: toCents(l.amount)!,
        coreStatus: l.lineType === "core_charge" ? ("open" as const) : ("not_applicable" as const),
      })));
      // v22.8 — price each service-named line against the vendor's agreed payable in this customer/job context, and record the variance per unit.
      const customerAccountIdForBill = input.customerAccountRef ? await customerAccountInScope(db, ctx.money, input.customerAccountRef).then(a => a.id, () => null) : null;
      const rateVariances: { lineNo: number; serviceCode: string; billedUnitPriceCents: number; agreedRateCents: number | null; varianceCents: number | null; outcome: string; decisionRef: string }[] = [];
      for (const l of input.lines) {
        if (!l.serviceCode) continue;
        const unit = normaliseUnit(l.unit ?? null);
        const lineRow = (await db.select({ id: vendorBillLines.id }).from(vendorBillLines).where(and(eq(vendorBillLines.vendorBillId, billId), eq(vendorBillLines.lineNo, l.lineNo))).limit(1))[0];
        if (!lineRow) continue;
        const r = await priceLineAndRecord({ db: db as never, financialEntityId: input.financialEntityId, rateKind: "vendor_payable", serviceCode: l.serviceCode, at: input.serviceDate ?? input.invoiceDate, subjectKind: "vendor_bill_line", subjectRef: `${billRef}/L${l.lineNo}`, quantity: l.quantity, unit: unit ?? "each", measurementSource: "manual_entry", decidedByUserId: ctx.user.id, context: { vendorId: input.vendorId, customerAccountId: customerAccountIdForBill, jobId: input.jobId ?? null, unitId: input.unitId ?? null } });
        const agreed = r.outcome.rateMillis != null ? Math.round(r.outcome.rateMillis / 10) : null;
        const billed = toCents(l.unitPrice)!;
        const variance = agreed != null ? billed - agreed : null;
        await db.update(vendorBillLines).set({ pricingDecisionRef: r.decisionRef, rateVarianceCents: variance }).where(eq(vendorBillLines.id, lineRow.id));
        rateVariances.push({ lineNo: l.lineNo, serviceCode: l.serviceCode, billedUnitPriceCents: billed, agreedRateCents: agreed, varianceCents: variance, outcome: r.outcome.outcome, decisionRef: r.decisionRef });
      }
      return { billRef, billId, accrual, openCoreCharges: recon.openCoreCharges.length, rateVariances };
    }),

  billMatch: moneyScoped(roleProcedure("vendor.billMatch"))
    .input(z.object({ billRef: z.string().min(1).max(64), confirmedQuantities: z.record(z.string(), z.number()).optional(), billedQuantities: z.record(z.string(), z.number()).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const bill = await vendorBillInScope(db, ctx.money, input.billRef);

      const pa = bill.purchaseAuthorizationId ? (await db.select().from(purchaseAuthorizations).where(eq(purchaseAuthorizations.id, bill.purchaseAuthorizationId)).limit(1))[0] : null;
      const rs = bill.roadsideEventId ? (await db.select().from(roadsideServiceEvents).where(eq(roadsideServiceEvents.id, bill.roadsideEventId)).limit(1))[0] : null;

      const match = fourWayMatch({
        authorization: pa && pa.status === "approved" && pa.authorizedMaximum != null
          ? { authorizedMaximum: pa.authorizedMaximum, vendorId: pa.vendorId, unitId: pa.unitId, category: pa.category }
          : null,
        operationalEvent: rs ? { unitId: rs.unitId, occurredAt: rs.occurredAt, quantities: input.confirmedQuantities } : null,
        evidence: { present: bill.evidenceRecordId != null },
        bill: { vendorId: bill.vendorId, unitId: bill.unitId, serviceDate: bill.serviceDate, total: fromCents(bill.totalCents)!, quantities: input.billedQuantities },
      });
      const status = match.outcome === "mismatch" ? "mismatch" : match.outcome === "partial" && match.missing.includes("receipt or photo evidence") ? "missing_receipt" : "needs_approval";
      await db.update(vendorBills).set({ matchOutcome: match.outcome, matchVariancesJson: JSON.stringify(match), status }).where(eq(vendorBills.id, bill.id));
      return { billRef: bill.billRef, ...match, status };
    }),

  billApprove: moneyScoped(roleProcedure("vendor.billApprove"))
    .input(z.object({ billRef: z.string().min(1).max(64), codingCategory: z.string().min(2).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const bill = await vendorBillInScope(db, ctx.money, input.billRef);
      // A mismatched bill is an exception, not an approval candidate.
      if (bill.matchOutcome === "mismatch") throw new TRPCError({ code: "CONFLICT", message: "Bill has unresolved match variances — resolve them before approval" });
      if (bill.matchOutcome === "unmatched") throw new TRPCError({ code: "CONFLICT", message: "Bill has not been matched" });
      // v21.5 — a bill is approved into its own accounting period; a closed period refuses.
      await assertPeriodOpen(bill.financialEntityId, bill.invoiceDate, "Bill approval");
      if (bill.status === "ready_to_pay" || bill.status === "paid") throw new TRPCError({ code: "CONFLICT", message: `Bill is already ${bill.status}` });
      // P7.5 — the approval ladder (0133/0136): tier by amount, the recorder never approves, a second person above the top tier.
      const ledger = await ledgerDecide(db, { actorUserId: ctx.user.id, category: "vendor_bill", subjectType: "vendor_bill", subjectRef: bill.billRef, amountCents: bill.totalCents, preparedByUserId: bill.recordedByUserId ?? null, decision: "approved", note: `coded ${input.codingCategory}` });
      if (ledger.outcome === "blocked") throw new TRPCError({ code: ledger.reason.startsWith("REVIEW") ? "PRECONDITION_FAILED" : "FORBIDDEN", message: ledger.reason });
      if (ledger.outcome === "awaiting") {
        await db.update(vendorBills).set({ codingCategory: input.codingCategory, codedByUserId: ctx.user.id, status: "needs_approval" }).where(eq(vendorBills.id, bill.id));
        return { billRef: bill.billRef, status: "needs_approval" as const, unitReleased: false as const, ledger };
      }
      await db.update(vendorBills).set({ codingCategory: input.codingCategory, codedByUserId: bill.codedByUserId ?? ctx.user.id, approvedByUserId: ctx.user.id, approvedAt: new Date(), status: "ready_to_pay" }).where(eq(vendorBills.id, bill.id));
      // Explicit, because someone will one day ask: this does NOT release the unit.
      return { billRef: bill.billRef, status: "ready_to_pay" as const, unitReleased: false as const, ledger };
    }),

  paymentRelease: moneyScoped(roleProcedure("vendor.paymentRelease"))
    .input(z.object({ billRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const bill = await vendorBillInScope(db, ctx.money, input.billRef);
      if (bill.status !== "ready_to_pay") throw new TRPCError({ code: "CONFLICT", message: `Bill is ${bill.status}, not ready to pay` });
      // The person who approved coding does not release payment.
      if (bill.approvedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who approved the bill does not release its payment" });
      // P7.5 — a payment is its own decision on the ladder (category `payment`); the approver prepared it.
      const ledger = await ledgerDecide(db, { actorUserId: ctx.user.id, category: "payment", subjectType: "vendor_bill_payment", subjectRef: bill.billRef, amountCents: bill.totalCents, preparedByUserId: bill.approvedByUserId ?? null, decision: "approved" });
      if (ledger.outcome === "blocked") throw new TRPCError({ code: ledger.reason.startsWith("REVIEW") ? "PRECONDITION_FAILED" : "FORBIDDEN", message: ledger.reason });
      if (ledger.outcome === "awaiting") return { billRef: bill.billRef, status: "ready_to_pay" as const, ledger };
      await db.update(vendorBills).set({ paymentReleasedByUserId: ctx.user.id, paymentReleasedAt: new Date(), status: "paid" }).where(eq(vendorBills.id, bill.id));
      return { billRef: bill.billRef, status: "paid" as const, ledger };
    }),
});

export const recoveryRouter = router({
  propose: moneyScoped(roleProcedure("recovery.propose"))
    .input(z.object({
      billRef: z.string().min(1).max(64), jobId: z.number().int().positive(), customerRef: z.string().max(220).nullable().optional(),
      contract: z.object({ passThroughAllowed: z.boolean(), markupPercent: z.number().min(0).max(100).nullable().optional(), recoverableCategories: z.array(z.string()).optional() }).nullable(),
      category: z.string().min(2).max(80), causedByCustomer: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const bill = await vendorBillInScope(db, ctx.money, input.billRef);
      await requireJob(ctx.money, input.jobId);
      const r = proposeCustomerRecovery({ companyCost: fromCents(bill.totalCents)!, contract: input.contract, category: input.category, causedByCustomer: input.causedByCustomer });
      if (r.status === "not_recoverable") return r;
      const proposalRef = ref("REC");
      await db.insert(customerRecoveryProposals).values({
        proposalRef, vendorBillId: bill.id, jobId: input.jobId, customerRef: input.customerRef ?? null,
        companyCost: r.companyCost, proposedRecovery: r.proposedRecovery, markupPercent: r.markupPercent, basis: r.basis,
        status: "review_required",
      });
      return { proposalRef, ...r };
    }),
});

export async function listOpenVendorBills(entityId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(vendorBills).where(eq(vendorBills.financialEntityId, entityId)).orderBy(desc(vendorBills.receivedAt)).limit(200);
}
