/**
 * v23.31 — Customer, Contract and Rate Management: the tRPC door.
 *
 * Every procedure is role-authorized by name; the money scope is resolved server-side from the
 * caller's membership and never read from input. Pricing is confidential: the field summary and
 * the non-confidential views strip every rate term, and only `commercial.rates.read` sees them.
 * The service (`customerCommercialService.ts`) owns the transactions, the audit rows and the
 * outbox events; nothing here writes a row directly.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roleProcedure, router } from "./_core/trpc";
import { authorize } from "./_core/recordsAuthorization";
import * as svc from "./customerCommercialService";
import { financeScopeFor } from "./_core/entityScope";
import { CONDITION_KINDS, CONDITION_OPERATORS, CONTACT_ROLE_KEYS, CONTRACT_STATUSES, CONTRACT_TYPES, CUSTOMER_TYPES, PARTY_ROLES, REFERENCE_KINDS } from "../shared/commercialVocabulary";

const rolesOf = (ctx: unknown) => ((ctx as { roles?: readonly string[] }).roles ?? []) as readonly string[];
const actorOf = (ctx: { user: { id: number } }) => ({ userId: ctx.user.id, roles: rolesOf(ctx) });
/**
 * May this caller see prices? The same permission the setup surface gates rates on; never inferred from a role name.
 * Decided in the organization the gate decided in (B23.1): `ctx.roles` are the roles that organization granted.
 */
const seesRates = (ctx: { user: { id: number } }) => authorize({ userId: ctx.user.id, roles: rolesOf(ctx) as never, permission: "commercial.rates.read", organization: (ctx as { organization?: string | null }).organization ?? null }).allowed;
const FIELD_ONLY_ROLES = new Set(["driver", "mechanic", "shop_lead"]);

const REF = z.string().min(1).max(64);
const KIND = z.enum(REFERENCE_KINDS);
const UNIT = z.enum(["hour", "half_hour", "day", "shift", "load", "km", "mile", "m3", "litre", "kg", "tonne", "acre", "metre", "foot", "piece", "worker", "crew", "each", "none"]);
const BASIS = z.enum(["any", "meter", "tank_calibration", "certified_scale", "load_sensor", "facility_ticket", "customer_measurement", "operator_estimate", "manual_entry", "clock", "odometer", "gps"]);
const condition = z.object({ kind: z.enum(CONDITION_KINDS), op: z.enum(CONDITION_OPERATORS), value: z.union([z.string().max(120), z.number(), z.array(z.union([z.string().max(120), z.number()])).min(1).max(50)]) });
const address = z.object({ line1: z.string().max(200).optional(), line2: z.string().max(200).optional(), city: z.string().max(120).optional(), province: z.string().max(8).optional(), postalCode: z.string().max(12).optional(), country: z.string().max(2).optional(), attention: z.string().max(180).optional() }).nullable();
const customerFields = {
  name: z.string().min(1).max(220), customerNumber: z.string().max(40).nullable().optional(), legalName: z.string().max(220).nullable().optional(), tradeName: z.string().max(220).nullable().optional(), customerType: z.enum(CUSTOMER_TYPES).optional(),
  billingAddress: address.optional(), physicalAddress: address.optional(), province: z.string().max(8).nullable().optional(), country: z.string().length(2).optional(), gstNumber: z.string().max(20).nullable().optional(), taxStatus: z.enum(["taxable", "zero_rated", "exempt", "unknown"]).optional(), defaultCurrency: z.string().length(3).optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(), creditLimitCents: z.number().int().nonnegative().nullable().optional(), requiresPurchaseOrder: z.boolean().optional(), requiresAfe: z.boolean().optional(), requiredReferenceKinds: z.array(KIND).max(8).optional(), billingFrequency: z.enum(["per_job", "weekly", "monthly"]).optional(), notes: z.string().max(4000).nullable().optional(), orgRef: z.string().max(64).nullable().optional(),
};
const lineFields = {
  serviceCode: z.string().min(1).max(60), lineKind: z.string().min(1).max(40), label: z.string().max(220).nullable().optional(), rateKind: z.enum(["sell", "vendor_payable", "payroll_reference", "internal_cost"]).optional(),
  pricingMethod: z.enum(["per_unit", "flat", "minimum_charge", "percentage_markup", "fixed_markup", "multiplier", "formula"]), unit: UNIT,
  rateMillis: z.number().int().nonnegative().nullable().optional(), flatCents: z.number().int().nonnegative().nullable().optional(), basisPoints: z.number().int().min(0).max(100_000).nullable().optional(), multiplierMillis: z.number().int().positive().nullable().optional(), formula: z.string().max(400).nullable().optional(),
  minimumQuantityMillis: z.number().int().positive().nullable().optional(), minimumChargeCents: z.number().int().positive().nullable().optional(), billingIncrementMillis: z.number().int().positive().nullable().optional(), roundingMode: z.enum(["nearest", "up", "down"]).optional(), measurementBasis: BASIS.optional(),
  conditionKey: z.string().max(60).nullable().optional(), resourceClass: z.string().max(80).nullable().optional(), unitId: z.number().int().positive().nullable().optional(), siteRef: z.string().max(120).nullable().optional(), projectRef: z.string().max(80).nullable().optional(), branchCode: z.string().max(40).nullable().optional(),
  applicability: z.array(condition).max(20).nullable().optional(), sourceKind: z.enum(["human", "ai_extracted", "imported", "negotiated"]).optional(), sourceDocumentEvidenceId: z.number().int().positive().nullable().optional(), sourceClause: z.string().max(160).nullable().optional(), notes: z.string().max(600).nullable().optional(),
};
const contractFields = {
  contractNumber: z.string().max(80).nullable().optional(), title: z.string().min(1).max(220), contractType: z.enum(CONTRACT_TYPES).optional(), effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional(),
  poRequirement: z.enum(["inherit", "required", "not_required"]).optional(), requiredReferenceKinds: z.array(KIND).max(8).optional(), customerReferences: z.record(z.string().max(40), z.string().max(120)).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).nullable().optional(), billingInstructions: z.string().max(4000).nullable().optional(), notes: z.string().max(4000).nullable().optional(), termsRef: z.string().max(64).nullable().optional(),
  renewalKind: z.enum(["none", "manual", "auto"]).optional(), renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
};

export const customerCommercialRouter = router({
  customers: router({
    create: roleProcedure("customerCommercial.customerCreate")
      .input(z.object({ financialEntityId: z.number().int().positive(), ...customerFields }))
      .mutation(async ({ ctx, input }) => svc.customerCreate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    update: roleProcedure("customerCommercial.customerUpdate")
      .input(z.object({ accountRef: REF, expectedRowVersion: z.number().int().positive().optional(), ...Object.fromEntries(Object.entries(customerFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof customerFields]: z.ZodOptional<(typeof customerFields)[K]> } }))
      .mutation(async ({ ctx, input }) => { const { accountRef, ...patch } = input; return svc.customerUpdate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), accountRef, patch); }),
    holdSet: roleProcedure("customerCommercial.customerHoldSet")
      .input(z.object({ accountRef: REF, hold: z.boolean(), reason: z.string().min(3).max(300), expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.customerHoldSet(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    archive: roleProcedure("customerCommercial.customerArchive")
      .input(z.object({ accountRef: REF, reason: z.string().min(3).max(400), expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.customerArchive(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    reactivate: roleProcedure("customerCommercial.customerReactivate")
      .input(z.object({ accountRef: REF, reason: z.string().min(3).max(400) }))
      .mutation(async ({ ctx, input }) => svc.customerReactivate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    list: roleProcedure("customerCommercial.customersList")
      .input(z.object({ q: z.string().max(120).optional(), status: z.enum(["active", "on_hold", "inactive"]).optional(), customerType: z.enum(CUSTOMER_TYPES).optional(), includeArchived: z.boolean().optional(), financialEntityId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
      .query(async ({ ctx, input }) => svc.customersList(await svc.commercialScope(ctx.user.id, financeScopeFor), input ?? {})),
    get: roleProcedure("customerCommercial.customerGet")
      .input(z.object({ accountRef: REF }))
      .query(async ({ ctx, input }) => svc.customerGet(await svc.commercialScope(ctx.user.id, financeScopeFor), input.accountRef)),
    history: roleProcedure("customerCommercial.customerHistory")
      .input(z.object({ accountRef: REF, limit: z.number().int().min(1).max(500).optional() }))
      .query(async ({ ctx, input }) => svc.auditHistoryForAccount(await svc.commercialScope(ctx.user.id, financeScopeFor), input.accountRef, input.limit)),
  }),

  contacts: router({
    create: roleProcedure("customerCommercial.contactCreate")
      .input(z.object({ accountRef: REF, displayName: z.string().min(1).max(180), title: z.string().max(120).nullable().optional(), company: z.string().max(220).nullable().optional(), phone: z.string().max(60).nullable().optional(), mobile: z.string().max(60).nullable().optional(), email: z.string().email().max(220).nullable().optional(), preferredChannel: z.enum(["phone", "sms", "email", "portal"]).nullable().optional(), externalIdentityId: z.number().int().positive().nullable().optional(), signatoryAuthorityId: z.number().int().positive().nullable().optional(), effectiveFrom: z.coerce.date().optional(), notes: z.string().max(600).nullable().optional(), roles: z.array(z.object({ roleKey: z.enum(CONTACT_ROLE_KEYS), isPrimary: z.boolean().optional() })).max(10).optional() }))
      .mutation(async ({ ctx, input }) => { const { accountRef, ...rest } = input; return svc.contactCreate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), accountRef, rest); }),
    update: roleProcedure("customerCommercial.contactUpdate")
      .input(z.object({ contactRef: REF, expectedRowVersion: z.number().int().positive().optional(), displayName: z.string().min(1).max(180).optional(), title: z.string().max(120).nullable().optional(), company: z.string().max(220).nullable().optional(), phone: z.string().max(60).nullable().optional(), mobile: z.string().max(60).nullable().optional(), email: z.string().email().max(220).nullable().optional(), preferredChannel: z.enum(["phone", "sms", "email", "portal"]).nullable().optional(), externalIdentityId: z.number().int().positive().nullable().optional(), signatoryAuthorityId: z.number().int().positive().nullable().optional(), status: z.enum(["active", "inactive"]).optional(), effectiveTo: z.coerce.date().nullable().optional(), notes: z.string().max(600).nullable().optional() }))
      .mutation(async ({ ctx, input }) => { const { contactRef, ...patch } = input; return svc.contactUpdate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), contactRef, patch); }),
    roleSet: roleProcedure("customerCommercial.contactRoleSet")
      .input(z.object({ contactRef: REF, roleKey: z.enum(CONTACT_ROLE_KEYS), isPrimary: z.boolean().optional(), effectiveFrom: z.coerce.date().optional() }))
      .mutation(async ({ ctx, input }) => svc.contactRoleSet(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    roleEnd: roleProcedure("customerCommercial.contactRoleEnd")
      .input(z.object({ contactRef: REF, roleKey: z.enum(CONTACT_ROLE_KEYS), reason: z.string().max(300).optional() }))
      .mutation(async ({ ctx, input }) => svc.contactRoleEnd(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
  }),

  contracts: router({
    create: roleProcedure("customerCommercial.contractCreate")
      .input(z.object({ accountRef: REF, ...contractFields }))
      .mutation(async ({ ctx, input }) => svc.contractCreate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    update: roleProcedure("customerCommercial.contractUpdate")
      .input(z.object({ contractRef: REF, expectedRowVersion: z.number().int().positive().optional(), ...Object.fromEntries(Object.entries(contractFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof contractFields]: z.ZodOptional<(typeof contractFields)[K]> } }))
      .mutation(async ({ ctx, input }) => { const { contractRef, ...patch } = input; return svc.contractUpdate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), contractRef, patch); }),
    /** submit → pending_approval; approve → active (a second person); reject → draft. */
    submit: roleProcedure("customerCommercial.contractSubmit")
      .input(z.object({ contractRef: REF, expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.contractTransitionApply(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), { ...input, event: "submit" })),
    approve: roleProcedure("customerCommercial.contractApprove")
      .input(z.object({ contractRef: REF, decision: z.enum(["approve", "reject"]), note: z.string().max(400).optional(), expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.contractTransitionApply(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), { contractRef: input.contractRef, event: input.decision, reason: input.note, expectedRowVersion: input.expectedRowVersion })),
    /** suspend / resume / terminate / expire — the governance transitions on a live contract. */
    statusSet: roleProcedure("customerCommercial.contractStatusSet")
      .input(z.object({ contractRef: REF, event: z.enum(["suspend", "resume", "terminate", "expire"]), reason: z.string().min(3).max(400), expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.contractTransitionApply(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    supersede: roleProcedure("customerCommercial.contractSupersede")
      .input(z.object({ contractRef: REF, reason: z.string().min(3).max(400), changes: z.object(Object.fromEntries(Object.entries(contractFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof contractFields]: z.ZodOptional<(typeof contractFields)[K]> }).optional() }))
      .mutation(async ({ ctx, input }) => svc.contractSupersede(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    list: roleProcedure("customerCommercial.contractsList")
      .input(z.object({ status: z.enum(CONTRACT_STATUSES).optional(), expiringWithinDays: z.number().int().min(0).max(730).optional(), q: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
      .query(async ({ ctx, input }) => svc.contractsList(await svc.commercialScope(ctx.user.id, financeScopeFor), input ?? {})),
    get: roleProcedure("customerCommercial.contractGet")
      .input(z.object({ contractRef: REF }))
      .query(async ({ ctx, input }) => svc.contractGet(await svc.commercialScope(ctx.user.id, financeScopeFor), input.contractRef)),
  }),

  rateSheets: router({
    create: roleProcedure("customerCommercial.rateSheetCreate")
      .input(z.object({ accountRef: REF, contractRef: REF.nullable().optional(), name: z.string().min(1).max(220), sheetNumber: z.string().max(80).nullable().optional(), currency: z.string().length(3).optional(), notes: z.string().max(4000).nullable().optional(), effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional() }))
      .mutation(async ({ ctx, input }) => svc.rateSheetCreate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    versionCreate: roleProcedure("customerCommercial.rateSheetVersionCreate")
      .input(z.object({ rateSheetRef: REF, effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional(), copyFromVersionRef: REF.nullable().optional(), notes: z.string().max(4000).nullable().optional() }))
      .mutation(async ({ ctx, input }) => svc.rateSheetVersionCreate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    lineAdd: roleProcedure("customerCommercial.rateLineAdd")
      .input(z.object({ versionRef: REF, ...lineFields }))
      .mutation(async ({ ctx, input }) => { const { versionRef, ...line } = input; return svc.rateLineAdd(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), versionRef, line); }),
    lineUpdate: roleProcedure("customerCommercial.rateLineUpdate")
      .input(z.object({ definitionRef: REF, ...Object.fromEntries(Object.entries(lineFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof lineFields]: z.ZodOptional<(typeof lineFields)[K]> } }))
      .mutation(async ({ ctx, input }) => { const { definitionRef, ...patch } = input; return svc.rateLineUpdate(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), definitionRef, patch); }),
    lineRemove: roleProcedure("customerCommercial.rateLineRemove")
      .input(z.object({ definitionRef: REF }))
      .mutation(async ({ ctx, input }) => svc.rateLineRemove(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input.definitionRef)),
    /** submit (proposer) — approve / reject / retire (a second person, sensitive) — reopen a rejected draft. */
    versionSubmit: roleProcedure("customerCommercial.rateSheetVersionSubmit")
      .input(z.object({ versionRef: REF, event: z.enum(["submit", "reopen"]), expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.rateSheetVersionTransition(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    versionDecide: roleProcedure("customerCommercial.rateSheetVersionDecide")
      .input(z.object({ versionRef: REF, event: z.enum(["approve", "reject", "retire"]), reason: z.string().max(400).optional(), expectedRowVersion: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => svc.rateSheetVersionTransition(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    list: roleProcedure("customerCommercial.rateSheetsList")
      .input(z.object({ status: z.enum(["active", "retired"]).optional(), q: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
      .query(async ({ ctx, input }) => svc.rateSheetsList(await svc.commercialScope(ctx.user.id, financeScopeFor), input ?? {})),
    get: roleProcedure("customerCommercial.rateSheetGet")
      .input(z.object({ rateSheetRef: REF }))
      .query(async ({ ctx, input }) => svc.rateSheetGet(await svc.commercialScope(ctx.user.id, financeScopeFor), input.rateSheetRef, true)),
  }),

  jobs: router({
    /** Dispatch selects customer → contract → PO → sheet. Approved rates are not touched here. */
    contextSet: roleProcedure("customerCommercial.jobContextSet")
      .input(z.object({ jobId: z.number().int().positive(), accountRef: REF, billToAccountRef: REF.nullable().optional(), contractRef: REF.nullable().optional(), rateSheetRef: REF.nullable().optional(), pinnedVersionRef: REF.nullable().optional(), poRef: REF.nullable().optional(), notes: z.string().max(600).nullable().optional(), expectedRowVersion: z.number().int().positive().optional(), reason: z.string().max(400).nullable().optional() }))
      .mutation(async ({ ctx, input }) => svc.jobContextSet(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    referenceAdd: roleProcedure("customerCommercial.jobReferenceAdd")
      .input(z.object({ jobId: z.number().int().positive(), referenceKind: KIND, referenceValue: z.string().min(1).max(120), source: z.enum(["office", "dispatch", "customer_portal", "field", "import"]).optional() }))
      .mutation(async ({ ctx, input }) => svc.jobReferenceAdd(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    referenceEnd: roleProcedure("customerCommercial.jobReferenceEnd")
      .input(z.object({ jobId: z.number().int().positive(), referenceId: z.number().int().positive(), reason: z.string().min(3).max(300) }))
      .mutation(async ({ ctx, input }) => svc.jobReferenceEnd(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    partySet: roleProcedure("customerCommercial.jobPartySet")
      .input(z.object({ jobId: z.number().int().positive(), partyRole: z.enum(PARTY_ROLES), accountRef: REF.nullable().optional(), contactRef: REF.nullable().optional(), orgRef: z.string().max(64).nullable().optional(), freeText: z.string().max(220).nullable().optional() }))
      .mutation(async ({ ctx, input }) => svc.jobPartySet(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    referenceWaive: roleProcedure("customerCommercial.jobReferenceWaive")
      .input(z.object({ jobId: z.number().int().positive(), reason: z.string().min(5).max(400) }))
      .mutation(async ({ ctx, input }) => svc.jobReferenceWaive(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    snapshotCapture: roleProcedure("customerCommercial.jobSnapshotCapture")
      .input(z.object({ jobId: z.number().int().positive(), reason: z.enum(["activation", "correction", "manual"]).default("manual"), asOf: z.coerce.date().optional(), note: z.string().max(400).optional() }))
      .mutation(async ({ ctx, input }) => svc.jobSnapshotCapture(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), input)),
    /** The office view. Rates appear only for a caller who holds commercial.rates.read. */
    get: roleProcedure("customerCommercial.jobCommercialGet")
      .input(z.object({ jobId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => svc.jobCommercialGet(await svc.commercialScope(ctx.user.id, financeScopeFor), input.jobId, seesRates(ctx))),
    /** The field view: nothing priced. A field-only caller sees only a job they are assigned to. */
    fieldSummary: roleProcedure("customerCommercial.jobFieldSummary")
      .input(z.object({ jobId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        const s = await svc.commercialScope(ctx.user.id, financeScopeFor);
        const roles = rolesOf(ctx);
        if (roles.length && roles.every(r => FIELD_ONLY_ROLES.has(r)) && !(await svc.callerAssignedToJob(s.db, ctx.user.id, input.jobId))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return svc.jobCommercialFieldSummary(s, input.jobId);
      }),
    billableContext: roleProcedure("customerCommercial.billableContext")
      .input(z.object({ jobId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => svc.getBillableCommercialContext(await svc.commercialScope(ctx.user.id, financeScopeFor), input.jobId)),
    resolveRate: roleProcedure("customerCommercial.jobRateResolve")
      .input(z.object({ jobId: z.number().int().positive(), serviceCode: z.string().min(1).max(60), at: z.coerce.date().optional(), rateKind: z.enum(["sell", "vendor_payable", "payroll_reference", "internal_cost"]).optional(), attributes: z.partialRecord(z.enum(CONDITION_KINDS), z.union([z.string().max(120), z.number(), z.null()])).optional() }))
      .query(async ({ ctx, input }) => svc.resolveRateForJob(await svc.commercialScope(ctx.user.id, financeScopeFor), input)),
  }),

  /** Contracts and sheet versions ending soon: emits the events once a day, expires what has ended. A worker may call it on its heartbeat later; for now it is a door. */
  expirySweep: roleProcedure("customerCommercial.expirySweep")
    .input(z.object({ withinDays: z.number().int().min(1).max(365).default(30) }).optional())
    .mutation(async ({ ctx, input }) => svc.expirySweep(await svc.commercialScope(ctx.user.id, financeScopeFor), actorOf(ctx), { withinDays: input?.withinDays ?? 30 })),
});
