/**
 * v22.7 — Commercial Setup & Rate Resolution.
 *
 * A charge definition is proposed by one person (or extracted by the AI, or
 * imported) and approved by a different person; until approved it prices
 * nothing. The resolver is deterministic over approved definitions; a
 * pricing decision is written once and never edited. The margin is shown to
 * those permitted to see it; the customer view carries only the sell price
 * unless the account is open-book.
 */
import { z } from "zod";
import { assertEntityInScope, entityIdsInScope, type MoneyScope } from "./_core/entityScope";
import { resolveActingScope } from "./_core/actingScope";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { chargeDefinitions, commercialSetupProfiles, customerAccounts, customerContractTerms, customerPurchaseOrders, fieldTicketLines, fieldTickets, pricingDecisions, units, vendorBillLines, vendorBills, vendors } from "../drizzle/schema";
import { getDb } from "./db";
import { roleProcedure, router } from "./_core/trpc";
import { goLiveReadiness, poExposure, priceQuantity, projectDecision, rateSheetGaps, resolveRate, simulateMargin, type ChargeDefinition, type Guardrails, type ResolutionContext } from "./_core/rateResolution";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const rolesOf = (ctx: unknown) => ((ctx as { roles?: readonly string[] }).roles ?? []) as readonly string[];
const UNIT = z.enum(["hour", "half_hour", "day", "shift", "load", "km", "mile", "m3", "litre", "kg", "tonne", "acre", "metre", "foot", "piece", "worker", "crew", "each", "none"]);
const SCOPE = z.enum(["job_override", "change_order", "po_afe", "project_site", "customer_contract", "customer_rate_card", "branch", "company"]);
const BASIS = z.enum(["any", "meter", "tank_calibration", "certified_scale", "load_sensor", "facility_ticket", "customer_measurement", "operator_estimate", "manual_entry", "clock", "odometer", "gps"]);
const contextInput = z.object({
  financialEntityId: z.number().int(), rateKind: z.enum(["sell", "vendor_payable", "payroll_reference", "internal_cost"]), serviceCode: z.string().min(1).max(60), at: z.coerce.date(),
  customerAccountRef: z.string().max(64).optional(), vendorRef: z.string().max(64).optional(), projectRef: z.string().max(80).optional(), siteRef: z.string().max(120).optional(), contractRef: z.string().max(80).optional(), jobId: z.number().int().optional(), branchCode: z.string().max(40).optional(), unitId: z.number().int().optional(), resourceClass: z.string().max(80).optional(), conditionKey: z.string().max(60).optional(),
});

async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }
async function accountId(d: Awaited<ReturnType<typeof db>>, accountRef: string | undefined) {
  if (!accountRef) return null;
  const a = (await d.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.accountRef, accountRef)).limit(1))[0];
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: `No customer account ${accountRef}` });
  return a.id;
}
async function vendorId(d: Awaited<ReturnType<typeof db>>, vendorRef: string | undefined) {
  if (!vendorRef) return null;
  const v = (await d.select({ id: vendors.id }).from(vendors).where(eq(vendors.vendorRef, vendorRef)).limit(1))[0];
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: `No vendor ${vendorRef}` });
  return v.id;
}
async function context(d: Awaited<ReturnType<typeof db>>, input: z.infer<typeof contextInput>): Promise<ResolutionContext & { financialEntityId: number }> {
  return { financialEntityId: input.financialEntityId, rateKind: input.rateKind, serviceCode: input.serviceCode, at: input.at, customerAccountId: await accountId(d, input.customerAccountRef), vendorId: await vendorId(d, input.vendorRef), projectRef: input.projectRef ?? null, siteRef: input.siteRef ?? null, contractRef: input.contractRef ?? null, jobId: input.jobId ?? null, branchCode: input.branchCode ?? null, unitId: input.unitId ?? null, resourceClass: input.resourceClass ?? null, conditionKey: input.conditionKey ?? null };
}
async function definitionsFor(d: Awaited<ReturnType<typeof db>>, financialEntityId: number, serviceCode: string, rateKind: ChargeDefinition["rateKind"]): Promise<ChargeDefinition[]> {
  return (await d.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.financialEntityId, financialEntityId), eq(chargeDefinitions.serviceCode, serviceCode), eq(chargeDefinitions.rateKind, rateKind)))) as ChargeDefinition[];
}
async function guardrailsFor(d: Awaited<ReturnType<typeof db>>, financialEntityId: number): Promise<Guardrails | null> {
  const p = (await d.select().from(commercialSetupProfiles).where(eq(commercialSetupProfiles.financialEntityId, financialEntityId)).limit(1))[0];
  return p ? { targetMarginBps: p.targetMarginBps, warningMarginBps: p.warningMarginBps, minimumAuthorityMarginBps: p.minimumAuthorityMarginBps, discountAuthority: JSON.parse(p.discountAuthorityJson) } : null;
}

/** P4.1 — the financial entity is the money boundary (0146); commercial setup keys to it throughout. */
async function moneyScope(userId: number): Promise<{ db: NonNullable<Awaited<ReturnType<typeof db>>>; scope: MoneyScope; entityIds: number[] }> {
  const database = await db();
  const scope = { tenantId: (await resolveActingScope(database, userId)).tenantId };
  return { db: database, scope, entityIds: await entityIdsInScope(database, scope) };
}

export const commercialSetupRouter = router({
  /** The company's service selections and its margin guardrails — business policy, set by management or the controller. */
  profileSet: roleProcedure("commercialSetup.profileSet")
    .input(z.object({ financialEntityId: z.number().int(), services: z.array(z.string().min(1).max(60)).max(40), targetMarginBps: z.number().int().min(0).max(10_000).nullable(), warningMarginBps: z.number().int().min(0).max(10_000).nullable(), minimumAuthorityMarginBps: z.number().int().min(0).max(10_000).nullable(), discountAuthority: z.record(z.string(), z.number().int().min(0).max(10_000)), openBookCustomerRefs: z.array(z.string()).default([]) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

      const d = await db();
      if (input.targetMarginBps != null && input.warningMarginBps != null && input.warningMarginBps > input.targetMarginBps) throw new TRPCError({ code: "BAD_REQUEST", message: "The warning line cannot sit above the target" });
      const row = { financialEntityId: input.financialEntityId, servicesJson: JSON.stringify(input.services), targetMarginBps: input.targetMarginBps, warningMarginBps: input.warningMarginBps, minimumAuthorityMarginBps: input.minimumAuthorityMarginBps, discountAuthorityJson: JSON.stringify(input.discountAuthority), openBookCustomersJson: JSON.stringify(input.openBookCustomerRefs), setByUserId: ctx.user.id };
      await d.insert(commercialSetupProfiles).values(row).onDuplicateKeyUpdate({ set: row });
      return { financialEntityId: input.financialEntityId, services: input.services };
    }),
  profileGet: roleProcedure("commercialSetup.profileGet").input(z.object({ financialEntityId: z.number().int() })).query(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

    const d = await db();
    const p = (await d.select().from(commercialSetupProfiles).where(eq(commercialSetupProfiles.financialEntityId, input.financialEntityId)).limit(1))[0];
    return p ? { services: JSON.parse(p.servicesJson) as string[], targetMarginBps: p.targetMarginBps, warningMarginBps: p.warningMarginBps, minimumAuthorityMarginBps: p.minimumAuthorityMarginBps, discountAuthority: JSON.parse(p.discountAuthorityJson) as Record<string, number>, openBookCustomerRefs: JSON.parse(p.openBookCustomersJson) as string[] } : null;
  }),

  /** A definition enters as a proposal — a person's, the AI's extraction, an import, or a negotiation. It prices nothing until approved by someone else. */
  definitionPropose: roleProcedure("commercialSetup.definitionPropose")
    .input(z.object({
      financialEntityId: z.number().int(), rateKind: z.enum(["sell", "vendor_payable", "payroll_reference", "internal_cost"]), serviceCode: z.string().min(1).max(60), resourceClass: z.string().max(80).optional(), unitId: z.number().int().optional(),
      pricingMethod: z.enum(["per_unit", "flat", "minimum_charge", "percentage_markup", "fixed_markup", "multiplier", "formula"]), unit: UNIT,
      rateMillis: z.number().int().nonnegative().optional(), flatCents: z.number().int().nonnegative().optional(), basisPoints: z.number().int().min(0).max(100_000).optional(), multiplierMillis: z.number().int().positive().optional(), formula: z.string().max(400).optional(),
      minimumQuantityMillis: z.number().int().positive().optional(), minimumChargeCents: z.number().int().positive().optional(), billingIncrementMillis: z.number().int().positive().optional(), roundingMode: z.enum(["nearest", "up", "down"]).default("nearest"), measurementBasis: BASIS.default("any"), conditionKey: z.string().max(60).optional(),
      scopeLevel: SCOPE, customerAccountRef: z.string().max(64).optional(), vendorRef: z.string().max(64).optional(), projectRef: z.string().max(80).optional(), siteRef: z.string().max(120).optional(), contractRef: z.string().max(80).optional(), jobId: z.number().int().optional(), branchCode: z.string().max(40).optional(),
      effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().optional(), sourceKind: z.enum(["human", "ai_extracted", "imported", "negotiated"]), sourceDocumentEvidenceId: z.number().int().optional(), sourceClause: z.string().max(160).optional(), notes: z.string().max(600).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // F1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }
      const d = await db();
      if (input.pricingMethod === "per_unit" && input.rateMillis == null) throw new TRPCError({ code: "BAD_REQUEST", message: "A per-unit definition carries a rate; without one it is a question, not a rate" });
      if (input.pricingMethod === "flat" && input.flatCents == null) throw new TRPCError({ code: "BAD_REQUEST", message: "A flat definition carries an amount" });
      // Reviewed on arrival (v22.7): an extracted or imported rate is a claim about a document; it names the document or it is refused.
      if ((input.sourceKind === "ai_extracted" || input.sourceKind === "imported") && input.sourceDocumentEvidenceId == null) throw new TRPCError({ code: "BAD_REQUEST", message: `A ${input.sourceKind === "ai_extracted" ? "AI-extracted" : "imported"} rate names the source document it was read from — an evidence record — or it is not proposed` });
      if (input.pricingMethod === "percentage_markup" && input.basisPoints == null) throw new TRPCError({ code: "BAD_REQUEST", message: "A percentage markup carries basis points" });
      if (input.rateKind === "vendor_payable" && !input.vendorRef) throw new TRPCError({ code: "BAD_REQUEST", message: "A vendor payable is owed to a named vendor" });
      if (input.scopeLevel === "job_override" && input.jobId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "A job override names the job" });
      if ((input.scopeLevel === "customer_contract" || input.scopeLevel === "customer_rate_card") && !input.customerAccountRef) throw new TRPCError({ code: "BAD_REQUEST", message: `A ${input.scopeLevel} definition names the customer` });
      if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The effective window ends before it begins" });
      const definitionRef = ref("CHG");
      const ins = await d.insert(chargeDefinitions).values({
        definitionRef, financialEntityId: input.financialEntityId, rateKind: input.rateKind, serviceCode: input.serviceCode, resourceClass: input.resourceClass ?? null, unitId: input.unitId ?? null,
        pricingMethod: input.pricingMethod, unit: input.unit, rateMillis: input.rateMillis ?? null, flatCents: input.flatCents ?? null, basisPoints: input.basisPoints ?? null, multiplierMillis: input.multiplierMillis ?? null, formula: input.formula ?? null,
        minimumQuantityMillis: input.minimumQuantityMillis ?? null, minimumChargeCents: input.minimumChargeCents ?? null, billingIncrementMillis: input.billingIncrementMillis ?? null, roundingMode: input.roundingMode, measurementBasis: input.measurementBasis, conditionKey: input.conditionKey ?? null,
        scopeLevel: input.scopeLevel, customerAccountId: await accountId(d, input.customerAccountRef), vendorId: await vendorId(d, input.vendorRef), projectRef: input.projectRef ?? null, siteRef: input.siteRef ?? null, contractRef: input.contractRef ?? null, jobId: input.jobId ?? null, branchCode: input.branchCode ?? null,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, sourceKind: input.sourceKind, sourceDocumentEvidenceId: input.sourceDocumentEvidenceId ?? null, sourceClause: input.sourceClause ?? null, approvalStatus: "proposed", proposedByUserId: ctx.user.id, notes: input.notes ?? null,
      });
      return { id: Number(ins[0]?.insertId ?? 0), definitionRef, approvalStatus: "proposed" as const, message: "Proposed. It prices nothing until a different person approves it." };
    }),

  /** Approval is a second person's act. An approved definition may supersede an earlier approved one, which keeps its history. */
  definitionApprove: roleProcedure("commercialSetup.definitionApprove")
    .input(z.object({ definitionRef: z.string().min(1).max(64), supersedesDefinitionRef: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const def = (await d.select().from(chargeDefinitions).where(eq(chargeDefinitions.definitionRef, input.definitionRef)).limit(1))[0];
      if (!def) throw new TRPCError({ code: "NOT_FOUND", message: "No such definition" });
      if (def.approvalStatus !== "proposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Definition is ${def.approvalStatus}, not proposed` });
      if (def.proposedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who proposed a rate does not approve it — a second person does" });
      let version = 1;
      if (input.supersedesDefinitionRef) {
        const prior = (await d.select().from(chargeDefinitions).where(eq(chargeDefinitions.definitionRef, input.supersedesDefinitionRef)).limit(1))[0];
        if (!prior || prior.approvalStatus !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only an approved definition is superseded" });
        if (prior.serviceCode !== def.serviceCode || prior.rateKind !== def.rateKind) throw new TRPCError({ code: "BAD_REQUEST", message: "A definition supersedes one for the same service and rate kind" });
        version = prior.version + 1;
        await d.update(chargeDefinitions).set({ approvalStatus: "superseded", supersededByDefinitionId: def.id, effectiveTo: prior.effectiveTo ?? def.effectiveFrom }).where(eq(chargeDefinitions.id, prior.id));
      }
      await d.update(chargeDefinitions).set({ approvalStatus: "approved", approvedByUserId: ctx.user.id, approvedAt: new Date(), version, supersedesDefinitionId: input.supersedesDefinitionRef ? (await d.select({ id: chargeDefinitions.id }).from(chargeDefinitions).where(eq(chargeDefinitions.definitionRef, input.supersedesDefinitionRef)))[0]?.id ?? null : null }).where(eq(chargeDefinitions.id, def.id));
      return { definitionRef: def.definitionRef, approvalStatus: "approved" as const, version };
    }),
  definitionReject: roleProcedure("commercialSetup.definitionReject")
    .input(z.object({ definitionRef: z.string().min(1).max(64), reason: z.string().min(3).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const def = (await d.select().from(chargeDefinitions).where(eq(chargeDefinitions.definitionRef, input.definitionRef)).limit(1))[0];
      if (!def || def.approvalStatus !== "proposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a proposal is rejected" });
      await d.update(chargeDefinitions).set({ approvalStatus: "rejected", rejectionReason: input.reason, approvedByUserId: ctx.user.id, approvedAt: new Date() }).where(eq(chargeDefinitions.id, def.id));
      return { definitionRef: def.definitionRef, approvalStatus: "rejected" as const };
    }),
  definitionList: roleProcedure("commercialSetup.definitionList")
    .input(z.object({ financialEntityId: z.number().int(), serviceCode: z.string().max(60).optional(), rateKind: z.enum(["sell", "vendor_payable", "payroll_reference", "internal_cost"]).optional() }))
    .query(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

      const d = await db();
      const rows = await d.select().from(chargeDefinitions).where(eq(chargeDefinitions.financialEntityId, input.financialEntityId)).orderBy(desc(chargeDefinitions.id));
      const roles = rolesOf(ctx);
      const mayCost = roles.includes("management") || roles.includes("controller");
      return rows.filter(r => (!input.serviceCode || r.serviceCode === input.serviceCode) && (!input.rateKind || r.rateKind === input.rateKind)).filter(r => mayCost || r.rateKind === "sell" || r.rateKind === "vendor_payable");   // internal cost and payroll references are management's
    }),

  /** The deterministic answer, with its reasons, and the questions the sheet leaves open. */
  rateResolve: roleProcedure("commercialSetup.rateResolve").input(contextInput).query(async ({ ctx: caller, input }) => {
    // F1: the financial entity must be in the caller's scope; otherwise it does not exist here.
    { const m = await moneyScope(caller.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }
    const d = await db();
    const ctx = await context(d, input);
    const defs = await definitionsFor(d, input.financialEntityId, input.serviceCode, input.rateKind);
    const res = resolveRate(defs, ctx);
    return res.outcome === "resolved" ? { outcome: res.outcome, definitionRef: res.definition.definitionRef, scopeLevel: res.scopeLevel, rateMillis: res.definition.rateMillis, unit: res.definition.unit, pricingMethod: res.definition.pricingMethod, sourceClause: res.definition.sourceClause, version: res.definition.version, considered: res.considered, reasons: res.reasons }
      : res.outcome === "conflict" ? { outcome: res.outcome, scopeLevel: res.scopeLevel, candidates: res.candidates.map(c => c.definitionRef), considered: res.considered, reasons: res.reasons }
      : { outcome: res.outcome, considered: res.considered, reasons: res.reasons };
  }),
  sheetGaps: roleProcedure("commercialSetup.sheetGaps").input(z.object({ financialEntityId: z.number().int(), serviceCode: z.string().min(1).max(60), customerAccountRef: z.string().max(64).optional() })).query(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

    const d = await db();
    const cid = await accountId(d, input.customerAccountRef);
    const defs = (await d.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.financialEntityId, input.financialEntityId), eq(chargeDefinitions.rateKind, "sell")))) as ChargeDefinition[];
    const forService = defs.filter(x => x.approvalStatus !== "rejected" && (x.serviceCode === input.serviceCode || x.serviceCode.startsWith(`${input.serviceCode}_`)) && (cid == null || x.customerAccountId == null || x.customerAccountId === cid));
    return { questions: rateSheetGaps(forService), definitions: forService.length };
  }),

  /** Price a measured quantity and write the decision once. The customer view is returned; the margin is not — that is marginSimulate, under its own permission. */
  pricingDecide: roleProcedure("commercialSetup.pricingDecide")
    .input(contextInput.extend({
      rateKind: z.enum(["sell", "vendor_payable"]), subjectKind: z.enum(["field_ticket_line", "vendor_bill_line", "quote_line", "job_estimate", "simulation"]), subjectRef: z.string().min(1).max(120),
      quantityMillis: z.number().int().nonnegative(), unit: UNIT, measurementSource: BASIS, measurementEvidenceId: z.number().int().optional(), passThroughCents: z.number().int().nonnegative().optional(),
      conversion: z.object({ fromUnit: UNIT, toUnit: UNIT, factorMillis: z.number().int().positive(), source: z.string().min(3).max(200), material: z.string().max(80).optional() }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // F1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }
      const d = await db();
      const rc = await context(d, input);
      const defs = await definitionsFor(d, input.financialEntityId, input.serviceCode, input.rateKind);
      const res = resolveRate(defs, rc);
      const out = priceQuantity(res, { quantityMillis: input.quantityMillis, unit: input.unit, measurementSource: input.measurementSource, passThroughCents: input.passThroughCents ?? null, conversion: input.conversion ? { ...input.conversion, material: input.conversion.material ?? null } : null });
      const decisionRef = ref("PR");
      await d.insert(pricingDecisions).values({
        decisionRef, financialEntityId: input.financialEntityId, rateKind: input.rateKind, subjectKind: input.subjectKind, subjectRef: input.subjectRef, serviceCode: input.serviceCode, quantityMillis: input.quantityMillis, unit: input.unit, measurementSource: input.measurementSource, measurementEvidenceId: input.measurementEvidenceId ?? null,
        outcome: out.outcome, chargeDefinitionId: out.definition?.id ?? null, scopeLevel: out.scopeLevel, rateMillis: out.rateMillis, billableQuantityMillis: out.billableQuantityMillis, minimumApplied: out.minimumApplied, incrementApplied: out.incrementApplied, formula: out.formula, inputsJson: JSON.stringify(out.inputs), amountCents: out.amountCents, reasonsJson: JSON.stringify(out.reasons), decidedByUserId: ctx.user.id,
      });
      return { decisionRef, outcome: out.outcome, amountCents: out.amountCents, rateMillis: out.rateMillis, billableQuantityMillis: out.billableQuantityMillis, minimumApplied: out.minimumApplied, incrementApplied: out.incrementApplied, formula: out.formula, definitionRef: out.definition?.definitionRef ?? null, scopeLevel: out.scopeLevel, sourceClause: out.definition?.sourceClause ?? null, reasons: out.reasons };
    }),
  decisionGet: roleProcedure("commercialSetup.decisionGet").input(z.object({ decisionRef: z.string().min(1).max(64) })).query(async ({ input }) => {
    const d = await db();
    const r = (await d.select().from(pricingDecisions).where(eq(pricingDecisions.decisionRef, input.decisionRef)).limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "No such decision" });
    return { ...r, inputs: JSON.parse(r.inputsJson), reasons: JSON.parse(r.reasonsJson) as string[] };
  }),

  /** Sell against cost under the company's guardrails. Under the margin permission only. */
  marginSimulate: roleProcedure("commercialSetup.marginSimulate")
    .input(z.object({ financialEntityId: z.number().int(), serviceCode: z.string().min(1).max(60), at: z.coerce.date(), customerAccountRef: z.string().max(64).optional(), vendorRef: z.string().max(64).optional(), projectRef: z.string().max(80).optional(), jobId: z.number().int().optional(), unitId: z.number().int().optional(), quantityMillis: z.number().int().positive(), unit: UNIT, proposedSellRateMillis: z.number().int().nonnegative().optional() }))
    .query(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

      const d = await db();
      const base = { financialEntityId: input.financialEntityId, serviceCode: input.serviceCode, at: input.at, customerAccountRef: input.customerAccountRef, vendorRef: input.vendorRef, projectRef: input.projectRef, jobId: input.jobId, unitId: input.unitId };
      const sellRes = resolveRate(await definitionsFor(d, input.financialEntityId, input.serviceCode, "sell"), await context(d, { ...base, rateKind: "sell" }));
      const costKind = input.vendorRef ? "vendor_payable" : "internal_cost";
      const costRes = resolveRate(await definitionsFor(d, input.financialEntityId, input.serviceCode, costKind), await context(d, { ...base, rateKind: costKind }));
      const sellRate = input.proposedSellRateMillis ?? (sellRes.outcome === "resolved" ? sellRes.definition.rateMillis : null);
      const costRate = costRes.outcome === "resolved" ? costRes.definition.rateMillis : null;
      const sellCents = sellRate != null ? Math.round(input.quantityMillis * sellRate / 10_000) : null;
      const costCents = costRate != null ? Math.round(input.quantityMillis * costRate / 10_000) : null;
      const guardrails = await guardrailsFor(d, input.financialEntityId);
      const sim = sellCents != null ? simulateMargin({ sellCents, costCents, guardrails, roles: rolesOf(ctx) }) : null;
      const contractSellCents = sellRes.outcome === "resolved" && sellRes.definition.rateMillis != null ? Math.round(input.quantityMillis * sellRes.definition.rateMillis / 10_000) : null;
      return { sell: sellRes.outcome, cost: costRes.outcome, costKind, contractSellCents, proposedSellCents: sellCents, costCents, differenceCents: contractSellCents != null && sellCents != null ? sellCents - contractSellCents : null, simulation: sim, view: projectDecision("management", { sellCents, vendorCents: input.vendorRef ? costCents : null, internalCostCents: input.vendorRef ? null : costCents }) };
    }),

  /** Before work starts: billed, committed and the estimate against the PO/AFE. */
  poExposure: roleProcedure("commercialSetup.poExposure")
    .input(z.object({ poRef: z.string().min(1).max(64), billedCents: z.number().int().nonnegative(), committedCents: z.number().int().nonnegative().default(0), estimateCents: z.number().int().nonnegative(), at: z.coerce.date().default(() => new Date()) }))
    .query(async ({ input }) => {
      const d = await db();
      const po = (await d.select().from(customerPurchaseOrders).where(eq(customerPurchaseOrders.poRef, input.poRef)).limit(1))[0];
      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "No such PO" });
      return { poRef: po.poRef, poNumber: po.poNumber, afeNumber: po.afeNumber, ...poExposure({ authorizedCents: po.authorizedCents, billedCents: input.billedCents, committedCents: input.committedCents, estimateCents: input.estimateCents, validTo: po.validTo, at: input.at }) };
    }),

  /** What a ticket is priced at, line by line, and what is not — unknown rates, conflicts, reviews and lines that named no service. */
  ticketPricing: roleProcedure("commercialSetup.ticketPricing").input(z.object({ ticketNumber: z.string().min(1).max(64) })).query(async ({ input }) => {
    const d = await db();
    const t = (await d.select().from(fieldTickets).where(eq(fieldTickets.ticketNumber, input.ticketNumber)).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket" });
    const lines = await d.select().from(fieldTicketLines).where(eq(fieldTicketLines.fieldTicketId, t.id));
    const refs = lines.map(l => l.pricingDecisionRef).filter((r): r is string => !!r);
    const decisions = refs.length ? await d.select().from(pricingDecisions).where(inArray(pricingDecisions.decisionRef, refs)) : [];
    const byRef = new Map(decisions.map(x => [x.decisionRef, x]));
    const rows = lines.map(l => {
      const dec = l.pricingDecisionRef ? byRef.get(l.pricingDecisionRef) ?? null : null;
      return { lineId: l.id, lineKind: l.lineKind, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, quantityUnit: l.quantityUnit, measurementMethod: l.measurementMethod, disposition: l.disposition, decisionRef: l.pricingDecisionRef, outcome: dec?.outcome ?? (l.serviceCode ? "not_priced" : "no_service_named"), amountCents: dec?.amountCents ?? null, billableQuantityMillis: dec?.billableQuantityMillis ?? null, rateMillis: dec?.rateMillis ?? null, scopeLevel: dec?.scopeLevel ?? null, reasons: dec ? (JSON.parse(dec.reasonsJson) as string[]) : [] };
    });
    const blockers = rows.filter(r => r.outcome !== "priced").map(r => `Line ${r.lineId} (${r.description}): ${r.outcome === "no_service_named" ? "no service named — cannot price" : r.outcome === "not_priced" ? "named a service but was not priced" : r.outcome.replace(/_/g, " ").toUpperCase()}`);
    return { ticketNumber: t.ticketNumber, lines: rows, pricedCents: rows.reduce((a, r) => a + (r.amountCents ?? 0), 0), blockers };
  }),

  /** Vendor lines whose billed unit price differs from the agreed payable, or that had no agreed rate to compare against. */
  vendorRateVariances: roleProcedure("commercialSetup.vendorRateVariances").input(z.object({ financialEntityId: z.number().int(), vendorRef: z.string().max(64).optional() })).query(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

    const d = await db();
    const vid = await vendorId(d, input.vendorRef);
    const bills = await d.select({ id: vendorBills.id, billRef: vendorBills.billRef, vendorId: vendorBills.vendorId, vendorInvoiceNumber: vendorBills.vendorInvoiceNumber, status: vendorBills.status }).from(vendorBills).where(vid != null ? and(eq(vendorBills.financialEntityId, input.financialEntityId), eq(vendorBills.vendorId, vid)) : eq(vendorBills.financialEntityId, input.financialEntityId));
    if (!bills.length) return { variances: [] };
    const lines = await d.select().from(vendorBillLines).where(inArray(vendorBillLines.vendorBillId, bills.map(b => b.id)));
    const priced = lines.filter(l => l.pricingDecisionRef);
    const decisions = priced.length ? await d.select().from(pricingDecisions).where(inArray(pricingDecisions.decisionRef, priced.map(l => l.pricingDecisionRef!))) : [];
    const byRef = new Map(decisions.map(x => [x.decisionRef, x]));
    const byBill = new Map(bills.map(b => [b.id, b]));
    return { variances: priced.map(l => { const dec = byRef.get(l.pricingDecisionRef!); const b = byBill.get(l.vendorBillId)!; return { billRef: b.billRef, vendorInvoiceNumber: b.vendorInvoiceNumber, billStatus: b.status, lineNo: l.lineNo, serviceCode: l.serviceCode, billedUnitPriceCents: l.unitPriceCents, agreedRateCents: dec?.rateMillis != null ? Math.round(dec.rateMillis / 10) : null, varianceCents: l.rateVarianceCents, outcome: dec?.outcome ?? "not_priced", decisionRef: l.pricingDecisionRef }; }).filter(v => v.varianceCents !== 0) };
  }),

  /** Exactly what remains before the company can dispatch, bill and pay with confidence. */
  goLiveReadiness: roleProcedure("commercialSetup.goLiveReadiness").input(z.object({ financialEntityId: z.number().int() })).query(async ({ ctx, input }) => {
      // P4.1: the financial entity must be in the caller's scope; otherwise it does not exist here.
      { const m = await moneyScope(ctx.user.id); await assertEntityInScope(m.db, input.financialEntityId, m.scope); }

    const d = await db();
    const profile = (await d.select().from(commercialSetupProfiles).where(eq(commercialSetupProfiles.financialEntityId, input.financialEntityId)).limit(1))[0];
    const defs = await d.select().from(chargeDefinitions).where(eq(chargeDefinitions.financialEntityId, input.financialEntityId));
    const accounts = await d.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.financialEntityId, input.financialEntityId));
    const vend = await d.select({ id: vendors.id, status: vendors.status }).from(vendors);
    const activeVendors = vend.filter(v => v.status === "active");
    const unitRows = await d.select({ id: units.id }).from(units);
    const terms = await d.select({ id: customerContractTerms.id, status: customerContractTerms.status, customerAccountId: customerContractTerms.customerAccountId }).from(customerContractTerms).where(accounts.length ? inArray(customerContractTerms.customerAccountId, accounts.map(a => a.id)) : eq(customerContractTerms.id, -1));
    const approved = defs.filter(x => x.approvalStatus === "approved");
    const sellCustomers = new Set(approved.filter(x => x.rateKind === "sell" && x.customerAccountId != null).map(x => x.customerAccountId));
    const companySell = approved.some(x => x.rateKind === "sell" && x.customerAccountId == null);
    const vendorsWithRates = new Set(approved.filter(x => x.rateKind === "vendor_payable").map(x => x.vendorId));
    const unitsWithCost = new Set(approved.filter(x => x.rateKind === "internal_cost" && x.unitId != null).map(x => x.unitId));
    const classCost = approved.some(x => x.rateKind === "internal_cost" && x.unitId == null);
    const readiness = goLiveReadiness({
      services: profile ? (JSON.parse(profile.servicesJson) as string[]) : [], approvedSell: approved.filter(x => x.rateKind === "sell").length, proposedSell: defs.filter(x => x.approvalStatus === "proposed" && x.rateKind === "sell").length, approvedVendor: vendorsWithRates.size,
      vendorsWithoutRates: activeVendors.filter(v => !vendorsWithRates.has(v.id)).length, customersWithoutRates: companySell ? 0 : accounts.filter(a => !sellCustomers.has(a.id)).length, unitsWithoutCost: classCost ? 0 : unitRows.filter(u => !unitsWithCost.has(u.id)).length,
      guardrailsSet: !!profile && profile.targetMarginBps != null, termsApproved: terms.filter(t => t.status === "approved").length, customers: accounts.length,
    });
    return { financialEntityId: input.financialEntityId, ...readiness };
  }),
});
