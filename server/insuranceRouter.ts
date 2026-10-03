/**
 * Insurance & Risk — the API.
 *
 * Coverage assessments are read from policies the server holds. A summary
 * reader sees status and policy ref; premiums, deductibles and claim amounts
 * are on procedures with their own permissions. A claim links to an incident
 * whose original statement is not touched here or anywhere.
 */

import { TRPCError } from "@trpc/server";
import { requireCallerUnits } from "./unitScope";
import { z } from "zod";
import { and, eq, inArray, isNull, or, gte } from "drizzle-orm";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { requireOwnedEntity } from "./_core/entityScope";
import { claimInScope, policyInScope, requireCoveredEntity, requireEvidence, requireIncidentReport, requireJob, requireRoadsideEventId, vendorBillIdInScope } from "./financeScope";
import { requireProvableOwnership } from "./ownershipDomain";
import { getDb } from "./db";
import {
  complianceDocuments, evidenceRelationships, incidentReports, insuranceCertificates, insuranceClaimCosts, insuranceClaimRecoveries,
  insuranceClaims, insuranceCoveredEntities, insurancePolicies, insurancePolicyCoverages, insuranceProviders, insuranceRequirements,
} from "../drizzle/schema";
import { policiesForFinancialEntity } from "./_core/insuranceCoverage";
import {
  assessCoverage, certificatesAffectedByRenewal, claimFinancials, dispatchInsuranceGate, matchCustomerRequirements,
  renewalCalendar, roadsideInsuranceItems, type PolicyRecord,
} from "./_core/insuranceRisk";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const ENTITY = z.enum(["unit", "trailer", "equipment", "operator", "branch", "facility", "company"]);

/** 0236 — the loader lives in _core/insuranceCoverage.ts so the marketplace reads cover through the same code. */
async function policiesFor(financialEntityId: number, entity: { type: string; id: number } | null, now: Date): Promise<PolicyRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return policiesForFinancialEntity(db, financialEntityId, entity, now);
}

export const insuranceRouter = router({
  policyRecord: moneyScoped(roleProcedure("insurance.policyRecord"))
    .input(z.object({
      financialEntityId: z.number().int().positive(),
      policyType: z.enum(["commercial_auto","physical_damage","cargo","general_liability","property","equipment","pollution_environmental","garage","cyber","professional_liability","umbrella_excess","non_owned_auto","wcb","surety_bond","other"]),
      insurerName: z.string().min(1).max(220), brokerName: z.string().max(220).nullable().optional(),
      policyNumber: z.string().min(1).max(120), effectiveAt: z.coerce.date(), expiresAt: z.coerce.date(),
      annualPremium: z.number().nonnegative().nullable().optional(), deductible: z.number().nonnegative().nullable().optional(),
      evidenceRecordId: z.number().int().positive().nullable().optional(),
      coverages: z.array(z.object({ coverageType: z.string().min(1).max(80), limitAmount: z.number().nonnegative().nullable().optional(), limitBasis: z.enum(["per_occurrence","aggregate","per_vehicle","per_load","other"]).nullable().optional(), additionalInsuredEndorsement: z.boolean().default(false) })).min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // F1.1 — the policy is recorded into the caller's own book. (Insurers and brokers are a shared directory.)
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      await requireEvidence(ctx.money, input.evidenceRecordId);
      if (input.expiresAt <= input.effectiveAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Policy expires before it takes effect" });
      const provider = async (name: string, role: "insurer" | "broker") => {
        const ex = (await db.select({ id: insuranceProviders.id }).from(insuranceProviders).where(and(eq(insuranceProviders.name, name), eq(insuranceProviders.role, role))).limit(1))[0];
        if (ex) return ex.id;
        const ins = await db.insert(insuranceProviders).values({ providerRef: ref("PRV"), name, role });
        return Number(ins[0]?.insertId ?? 0);
      };
      const insurerId = await provider(input.insurerName, "insurer");
      const brokerId = input.brokerName ? await provider(input.brokerName, "broker") : null;
      const policyRef = ref("POL");
      const ins = await db.insert(insurancePolicies).values({
        policyRef, financialEntityId: input.financialEntityId, policyType: input.policyType, insurerId, brokerId, policyNumber: input.policyNumber,
        effectiveAt: input.effectiveAt, expiresAt: input.expiresAt, status: "active", annualPremium: input.annualPremium ?? null, deductible: input.deductible ?? null,
        evidenceRecordId: input.evidenceRecordId ?? null,
        // Recorded is reported. Verified is a separate act by a separate permission.
        coverageVerificationStatus: "coverage_reported",
      });
      const policyId = Number(ins[0]?.insertId ?? 0);
      await db.insert(insurancePolicyCoverages).values(input.coverages.map(c => ({ insurancePolicyId: policyId, coverageType: c.coverageType, limitAmount: c.limitAmount ?? null, limitBasis: c.limitBasis ?? null, additionalInsuredEndorsement: c.additionalInsuredEndorsement })));
      return { policyRef, policyId, coverageVerificationStatus: "coverage_reported" as const };
    }),

  coverageAssign: moneyScoped(roleProcedure("insurance.coverageAssign"))
    .input(z.object({ policyRef: z.string().min(1).max(64), entities: z.array(z.object({ entityType: ENTITY, entityId: z.number().int().positive(), statedValue: z.number().nonnegative().nullable().optional() })).min(1), coveredFrom: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const p = await policyInScope(db, ctx.money, input.policyRef);
      // F1.1 — a policy covers the caller's own units and operators, never another organization's.
      for (const e of input.entities) await requireCoveredEntity(ctx.money, e.entityType, e.entityId);
      await db.insert(insuranceCoveredEntities).values(input.entities.map(e => ({ insurancePolicyId: p.id, entityType: e.entityType, entityId: e.entityId, coveredFrom: input.coveredFrom, statedValue: e.statedValue ?? null })));
      // One policy document, related to every covered unit. Zero copies.
      if (p.evidenceRecordId) {
        const rels = input.entities.filter(e => ["unit", "trailer", "equipment", "operator", "facility"].includes(e.entityType)).map(e => ({ evidenceRecordId: p.evidenceRecordId!, entityType: e.entityType as never, entityId: e.entityId, role: "insured_under" }));
        if (rels.length) await db.insert(evidenceRelationships).values(rels);
      }
      return { policyRef: p.policyRef, covered: input.entities.length, documentRelated: !!p.evidenceRecordId };
    }),

  coverageVerify: moneyScoped(roleProcedure("insurance.coverageVerify"))
    .input(z.object({ policyRef: z.string().min(1).max(64), outcome: z.enum(["coverage_verified", "coverage_unknown"]), note: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const p = await policyInScope(db, ctx.money, input.policyRef);
      await db.update(insurancePolicies).set({ coverageVerificationStatus: input.outcome, coverageVerifiedAt: new Date(), coverageVerifiedByUserId: ctx.user.id }).where(eq(insurancePolicies.id, p.id));
      return { policyRef: p.policyRef, coverageVerificationStatus: input.outcome };
    }),

  /** Summary readers get status and policy ref. Not premiums. */
  coverageForEntity: moneyScoped(roleProcedure("insurance.coverageForEntity"))
    .input(z.object({ financialEntityId: z.number().int().positive(), entityType: ENTITY, entityId: z.number().int().positive(), coverageTypes: z.array(z.string()).default(["commercial_auto", "cargo", "general_liability"]) }))
    .query(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      await requireCoveredEntity(ctx.money, input.entityType, input.entityId);   // its compliance documents are read below
      const now = new Date();
      const policies = await policiesFor(input.financialEntityId, { type: input.entityType, id: input.entityId }, now);
      const assessments = input.coverageTypes.map(t => assessCoverage({ coverageType: t, policies, now }));
      return { assessments, dispatch: dispatchInsuranceGate(assessments), roadside: roadsideInsuranceItems(assessments) };
    }),

  requirementSet: moneyScoped(roleProcedure("insurance.requirementSet"))
    .input(z.object({ customerRef: z.string().min(1).max(220), requirements: z.array(z.object({ coverageType: z.string().min(1).max(80), minimumLimit: z.number().nonnegative().nullable().optional(), additionalInsuredRequired: z.boolean().default(false), contractingEntityRef: z.string().max(220).nullable().optional() })).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // F1.1 — requirements are keyed by a free-text customer name and carry no owner, and this REPLACES every
      // row for that name. With organizations present it would delete another company's requirements.
      await requireProvableOwnership("Setting customer insurance requirements", "insuranceRequirements carries a book (the next finance schema checkpoint, F2)");
      await db.delete(insuranceRequirements).where(eq(insuranceRequirements.customerRef, input.customerRef));
      await db.insert(insuranceRequirements).values(input.requirements.map(r => ({ customerRef: input.customerRef, coverageType: r.coverageType, minimumLimit: r.minimumLimit ?? null, additionalInsuredRequired: r.additionalInsuredRequired, contractingEntityRef: r.contractingEntityRef ?? null })));
      return { customerRef: input.customerRef, requirements: input.requirements.length };
    }),

  requirementMatch: moneyScoped(roleProcedure("insurance.requirementMatch"))
    .input(z.object({ financialEntityId: z.number().int().positive(), customerRef: z.string().min(1).max(220) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      await requireProvableOwnership("Matching customer insurance requirements", "insuranceRequirements carries a book (the next finance schema checkpoint, F2)");
      const now = new Date();
      const reqs = await db.select().from(insuranceRequirements).where(eq(insuranceRequirements.customerRef, input.customerRef));
      const policies = await policiesFor(input.financialEntityId, null, now);
      // Company-level policies have no per-entity document; the policy's own record stands as its
      // proof. Named as that, not dressed up as a verified document: no document is being judged.
      const withDocs = policies.map(p => ({ ...p, document: p.document ?? { source: "policy_record" as const } }));
      return { customerRef: input.customerRef, ...matchCustomerRequirements({ requirements: reqs.map(r => ({ coverageType: r.coverageType, minimumLimit: r.minimumLimit, additionalInsuredRequired: r.additionalInsuredRequired })), policies: withDocs, now }) };
    }),

  certificateIssue: moneyScoped(roleProcedure("insurance.certificateIssue"))
    .input(z.object({ policyRef: z.string().min(1).max(64), recipientCustomerRef: z.string().min(1).max(220), additionalInsuredNamed: z.boolean().default(false), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const p = await policyInScope(db, ctx.money, input.policyRef);
      await requireEvidence(ctx.money, input.evidenceRecordId);
      if (p.coverageVerificationStatus !== "coverage_verified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A certificate attests to coverage; verify the coverage before issuing one" });
      const certificateRef = ref("COI");
      await db.insert(insuranceCertificates).values({ certificateRef, insurancePolicyId: p.id, recipientCustomerRef: input.recipientCustomerRef, issuedAt: new Date(), expiresAt: p.expiresAt, additionalInsuredNamed: input.additionalInsuredNamed, evidenceRecordId: input.evidenceRecordId ?? null, sharedAt: new Date(), sharedByUserId: ctx.user.id });
      return { certificateRef, expiresAt: p.expiresAt };
    }),

  renewalCalendar: moneyScoped(roleProcedure("insurance.renewalCalendar"))
    .input(z.object({ financialEntityId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const now = new Date();
      const policies = await db.select().from(insurancePolicies).where(eq(insurancePolicies.financialEntityId, input.financialEntityId));
      // F1.1 — this book's certificates only (this read used to take every company's).
      const certs = policies.length ? await db.select({ certificateRef: insuranceCertificates.certificateRef, insurancePolicyId: insuranceCertificates.insurancePolicyId, recipientCustomerRef: insuranceCertificates.recipientCustomerRef, expiresAt: insuranceCertificates.expiresAt }).from(insuranceCertificates).where(inArray(insuranceCertificates.insurancePolicyId, policies.map(p => p.id))) : [];
      const byId = new Map(policies.map(p => [p.id, p.policyRef]));
      const calendar = renewalCalendar(policies, now).map(entry => ({
        ...entry,
        certificatesToReissue: certificatesAffectedByRenewal({ policyRef: entry.policyRef, certificates: certs.map(c => ({ certificateRef: c.certificateRef, policyRef: byId.get(c.insurancePolicyId) ?? "", recipientCustomerRef: c.recipientCustomerRef, expiresAt: c.expiresAt })), now }),
      }));
      return { calendar };
    }),

  claimOpen: moneyScoped(roleProcedure("insurance.claimOpen"))
    .input(z.object({
      policyRef: z.string().min(1).max(64), incidentReportId: z.number().int().positive().nullable().optional(), roadsideEventId: z.number().int().positive().nullable().optional(),
      unitId: z.number().int().positive().nullable().optional(), jobId: z.number().int().positive().nullable().optional(), lossOccurredAt: z.coerce.date(),
      claimType: z.enum(["collision","cargo","property","equipment","environmental","theft","glass","liability","other"]), estimatedLoss: z.number().nonnegative().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const p = await policyInScope(db, ctx.money, input.policyRef);
      await requireIncidentReport(db, ctx.money, input.incidentReportId);
      await requireRoadsideEventId(db, ctx.money, input.roadsideEventId);
      await requireJob(ctx.money, input.jobId);
      if (input.lossOccurredAt < p.effectiveAt || input.lossOccurredAt > p.expiresAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Loss date falls outside the policy period" });
      let statementPreserved: boolean | null = null;
      if (input.incidentReportId) {
        const inc = (await db.select({ id: incidentReports.id, originalStatement: incidentReports.originalStatement }).from(incidentReports).where(eq(incidentReports.id, input.incidentReportId)).limit(1))[0];
        if (!inc) throw new TRPCError({ code: "NOT_FOUND", message: "Incident not found" });
        statementPreserved = inc.originalStatement != null;
      }
      const claimRef = ref("CLM");
      await db.insert(insuranceClaims).values({ claimRef, insurancePolicyId: p.id, incidentReportId: input.incidentReportId ?? null, roadsideEventId: input.roadsideEventId ?? null, unitId: input.unitId ?? null, jobId: input.jobId ?? null, lossOccurredAt: input.lossOccurredAt, claimType: input.claimType, deductible: p.deductible, estimatedLoss: input.estimatedLoss ?? null, openedByUserId: ctx.user.id, openedAt: new Date(), status: "potential" });
      return { claimRef, status: "potential" as const, deductible: p.deductible, incidentStatementPreserved: statementPreserved };
    }),

  claimCostRecord: moneyScoped(roleProcedure("insurance.claimCostRecord"))
    .input(z.object({ claimRef: z.string().min(1).max(64), costType: z.enum(["tow","repair","rental_replacement","cleanup","cargo_loss","downtime","legal","other"]), amount: z.number().positive(), vendorBillId: z.number().int().positive().nullable().optional(), incurredAt: z.coerce.date(), note: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { claim: c, financialEntityId } = await claimInScope(db, ctx.money, input.claimRef);
      if (input.vendorBillId != null) await vendorBillIdInScope(db, ctx.money, input.vendorBillId, financialEntityId);
      await db.insert(insuranceClaimCosts).values({ insuranceClaimId: c.id, costType: input.costType, amount: input.amount, vendorBillId: input.vendorBillId ?? null, incurredAt: input.incurredAt, note: input.note ?? null });
      return { claimRef: input.claimRef, recorded: input.amount };
    }),

  claimRecoveryRecord: moneyScoped(roleProcedure("insurance.claimRecoveryRecord"))
    .input(z.object({ claimRef: z.string().min(1).max(64), recoveryType: z.enum(["approved","received","denied","adjustment"]), amount: z.number(), reference: z.string().max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { claim: c } = await claimInScope(db, ctx.money, input.claimRef);
      if (input.recoveryType !== "adjustment" && input.amount <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be positive" });
      await db.insert(insuranceClaimRecoveries).values({ insuranceClaimId: c.id, recoveryType: input.recoveryType, amount: input.amount, recordedAt: new Date(), reference: input.reference ?? null, recordedByUserId: ctx.user.id });
      if (input.recoveryType === "approved") await db.update(insuranceClaims).set({ status: "approved", approvedAmount: input.amount }).where(eq(insuranceClaims.id, c.id));
      if (input.recoveryType === "denied") await db.update(insuranceClaims).set({ status: "denied" }).where(eq(insuranceClaims.id, c.id));
      return { claimRef: input.claimRef, recoveryType: input.recoveryType };
    }),

  claimFinancials: moneyScoped(roleProcedure("insurance.claimFinancials"))
    .input(z.object({ claimRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { claim: c } = await claimInScope(db, ctx.money, input.claimRef);
      const costs = await db.select().from(insuranceClaimCosts).where(eq(insuranceClaimCosts.insuranceClaimId, c.id));
      const recs = await db.select().from(insuranceClaimRecoveries).where(eq(insuranceClaimRecoveries.insuranceClaimId, c.id));
      return { claimRef: c.claimRef, status: c.status, ...claimFinancials({ costs, recoveries: recs, deductible: c.deductible }) };
    }),
});
