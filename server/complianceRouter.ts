/**
 * Compliance Master Registry — the API.
 *
 * Requirements come from the registry (the seed until rows are loaded), never
 * from the request. A verified requirement can only be created by a
 * controller from a verified source. Private credential detail leaves HR only
 * as "eligible: yes | no | unknown". Written programs are versioned and never
 * overwritten.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { carrierProfileReviews, complianceConsents, complianceDocuments, complianceRequirements, writtenProgramVersions } from "../drizzle/schema";
import {
  abstractRequestPermitted, buildPassport, composeJobPassport, medicalFitnessForDispatch, nextRenewalDue,
  type Credential, type Passport, type Requirement, type Subject,
} from "./_core/compliancePassport";
import { COMPLIANCE_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import { loadRequirementRegistry, packExists } from "./requirementRegistry";
import {
  COMPLIANCE_KNOWLEDGE_CATALOG,
  evaluateDangerousGoodsAssist,
  evaluateGeneralCargoSecurement,
} from "./_core/complianceSecretary";
import { evaluateDriverQualification } from "./_core/driverTraining";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const SUBJECT = z.enum(["operator", "unit", "trailer", "carrier", "job", "user"]);
/**
 * Every subject a requirement can be written for — the column's enum. `requirementLoad` used
 * `SUBJECT` above, so an equipment, attachment or work-context requirement (which work
 * authorization evaluates) could never be loaded; only its seed could exist (C1b-2).
 */
const REQUIREMENT_SUBJECT = z.enum(["operator", "unit", "trailer", "carrier", "job", "user", "equipment", "attachment", "work_context"]);

/** The registry at `now`: governing stored revisions, then unreplaced seeds (`requirementRegistry.ts`). */
const loadRequirements = (): Promise<Requirement[]> => loadRequirementRegistry(COMPLIANCE_REQUIREMENT_SEEDS);

async function loadCredentials(ownerType: string, ownerId: number): Promise<Credential[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, ownerType as never), eq(complianceDocuments.ownerId, ownerId)));
  return rows.map(r => ({
    docType: r.docType, requirementKey: r.requirementKey, issuedAt: r.issuedAt, expiresAt: r.expiresAt,
    verificationStatus: r.verificationStatus, privateDetail: r.privateDetail, jurisdiction: r.jurisdiction,
  }));
}

async function passportFor(subjectType: Subject["subjectType"], subjectId: number, jurisdiction: string, attributes: Record<string, unknown>): Promise<Passport> {
  const [requirements, credentials] = await Promise.all([loadRequirements(), loadCredentials(subjectType, subjectId)]);
  return buildPassport({ subject: { subjectType, jurisdiction, attributes }, requirements, credentials, now: new Date() });
}

export const complianceRouter = router({
  passport: roleProcedure("compliance.passport")
    .input(z.object({ subjectType: SUBJECT, subjectId: z.number().int().positive(), jurisdiction: z.string().min(2).max(80), attributes: z.record(z.string(), z.unknown()).default({}) }))
    .query(async ({ input }) => {
      const p = await passportFor(input.subjectType, input.subjectId, input.jurisdiction, input.attributes);
      // Private detail never rides out on a passport. Items are requirement
      // level; the credential row is not included.
      return p;
    }),

  jobPassport: roleProcedure("compliance.jobPassport")
    .input(z.object({
      jurisdiction: z.string().min(2).max(80),
      carrier: z.object({ id: z.number().int().positive(), attributes: z.record(z.string(), z.unknown()).default({}) }).nullable(),
      operator: z.object({ id: z.number().int().positive(), attributes: z.record(z.string(), z.unknown()).default({}) }).nullable(),
      unit: z.object({ id: z.number().int().positive(), attributes: z.record(z.string(), z.unknown()).default({}) }).nullable(),
      trailer: z.object({ id: z.number().int().positive(), attributes: z.record(z.string(), z.unknown()).default({}) }).nullable().optional(),
    }))
    .query(async ({ input }) => {
      const parts: Record<string, Passport | null> = {
        carrier: input.carrier ? await passportFor("carrier", input.carrier.id, input.jurisdiction, input.carrier.attributes) : null,
        operator: input.operator ? await passportFor("operator", input.operator.id, input.jurisdiction, input.operator.attributes) : null,
        unit: input.unit ? await passportFor("unit", input.unit.id, input.jurisdiction, input.unit.attributes) : null,
      };
      if (input.trailer !== undefined) parts.trailer = input.trailer ? await passportFor("trailer", input.trailer.id, input.jurisdiction, input.trailer.attributes) : null;
      return composeJobPassport(parts);
    }),

  /** The only shape medical fitness takes outside HR. */
  medicalEligibility: roleProcedure("compliance.medicalEligibility")
    .input(z.object({ operatorId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { eligible: "unknown" as const, reviewDue: null };
      const rows = await db.select().from(complianceDocuments)
        .where(and(eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, input.operatorId), eq(complianceDocuments.docType, "medical_fitness")))
        .orderBy(desc(complianceDocuments.expiresAt)).limit(1);
      const r = rows[0];
      return medicalFitnessForDispatch(r ? { docType: r.docType, expiresAt: r.expiresAt, verificationStatus: r.verificationStatus, privateDetail: r.privateDetail } : null, new Date());
    }),

  credentialRecord: roleProcedure("compliance.credentialRecord")
    .input(z.object({
      ownerType: z.enum(["operator", "unit", "job", "trailer", "carrier", "user", "equipment"]), ownerId: z.number().int().positive(),
      docType: z.string().min(2).max(100), requirementKey: z.string().max(120).nullable().optional(),
      title: z.string().min(1).max(220), identifier: z.string().max(120).nullable().optional(),
      issuedAt: z.coerce.date().nullable().optional(), expiresAt: z.coerce.date().nullable().optional(),
      jurisdiction: z.string().max(80).nullable().optional(), source: z.string().max(220).nullable().optional(),
      privateDetail: z.boolean().default(false), evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // Recorded is not verified. Every credential enters as needs_review.
      const ins = await db.insert(complianceDocuments).values({
        ownerType: input.ownerType, ownerId: input.ownerId, docType: input.docType, requirementKey: input.requirementKey ?? null,
        title: input.title, identifier: input.identifier ?? null, capturedAt: new Date(), issuedAt: input.issuedAt ?? null,
        expiresAt: input.expiresAt ?? null, jurisdiction: input.jurisdiction ?? null, verificationStatus: "needs_review",
        source: input.source ?? null, confidence: "medium", privateDetail: input.privateDetail || input.docType === "medical_fitness",
        evidenceRecordId: input.evidenceRecordId ?? null,
      });
      return { credentialId: Number(ins[0]?.insertId ?? 0), verificationStatus: "needs_review" as const };
    }),

  credentialVerify: roleProcedure("compliance.credentialVerify")
    .input(z.object({ credentialId: z.number().int().positive(), outcome: z.enum(["verified", "rejected"]), note: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const rows = await db.select().from(complianceDocuments).where(eq(complianceDocuments.id, input.credentialId)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      await db.update(complianceDocuments).set({ verificationStatus: input.outcome, verifiedByUserId: ctx.user.id, verifiedAt: new Date() }).where(eq(complianceDocuments.id, input.credentialId));
      return { credentialId: input.credentialId, verificationStatus: input.outcome };
    }),

  consentRecord: roleProcedure("compliance.consentRecord")
    .input(z.object({
      subjectUserId: z.number().int().positive(),
      consentType: z.enum(["driver_abstract", "commercial_driver_abstract", "medical_fitness_confirmation", "experience_record_release", "background_check", "other"]),
      purpose: z.string().min(3).max(300), signedAt: z.coerce.date(), validUntil: z.coerce.date().nullable().optional(),
      signatureEvidenceRecordId: z.number().int().positive().nullable().optional(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const consentRef = ref("CONSENT");
      await db.insert(complianceConsents).values({
        consentRef, subjectUserId: input.subjectUserId, consentType: input.consentType, purpose: input.purpose,
        requestedByUserId: ctx.user.id, signedAt: input.signedAt, validUntil: input.validUntil ?? null,
        signatureEvidenceRecordId: input.signatureEvidenceRecordId ?? null, payloadHash: input.payloadHash ?? null,
      });
      const permitted = abstractRequestPermitted({ consent: { signedAt: input.signedAt, validUntil: input.validUntil ?? null, consentType: input.consentType }, now: new Date() });
      return { consentRef, abstractRequestPermitted: permitted.permitted };
    }),

  /**
   * Load or verify a requirement. Controller-only and sensitive, for the same
   * reason as tax rules: this is the act that lets a passport say READY. An
   * unverified source cannot produce a verified requirement.
   */
  requirementLoad: roleProcedure("compliance.requirementLoad")
    .input(z.object({
      requirementKey: z.string().min(3).max(120), family: z.string().min(2).max(60), title: z.string().min(3).max(220),
      /** C1b-2: the pack this requirement belongs to; it applies only where the pack is active. */
      packKey: z.string().min(2).max(80).nullable().optional(),
      subjectType: REQUIREMENT_SUBJECT, jurisdiction: z.string().min(1).max(80), appliesWhen: z.record(z.string(), z.unknown()).nullable().optional(),
      satisfiedByDocTypes: z.array(z.string().min(1)).min(1), renewalIntervalDays: z.number().int().positive().nullable().optional(),
      warnDaysBeforeExpiry: z.number().int().nonnegative().default(30), missingSeverity: z.enum(["review", "blocked"]).default("review"),
      sourceAuthority: z.string().max(220).nullable().optional(), sourceUrl: z.string().max(600).nullable().optional(), sourceReference: z.string().max(300).nullable().optional(),
      sourceVerified: z.boolean().default(false), requestedStatus: z.enum(["unverified", "verified"]).default("unverified"), effectiveFrom: z.coerce.date(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (input.packKey && !(await packExists(input.packKey))) throw new TRPCError({ code: "NOT_FOUND", message: `Unknown pack ${input.packKey}` });
      const stored = input.requestedStatus === "verified" && input.sourceVerified && input.sourceAuthority?.trim() ? "verified" : "unverified";
      const prior = await db.select({ version: complianceRequirements.version }).from(complianceRequirements).where(eq(complianceRequirements.requirementKey, input.requirementKey)).orderBy(desc(complianceRequirements.version)).limit(1);
      const version = (prior[0]?.version ?? 0) + 1;
      // C1b-2: revisions are immutable. The previous version is not touched — not its status, not
      // its dates. Which revision governs on a date is read from the versions by
      // `requirementRegistry.governingRevisions`, so the earlier one keeps applying until this one's
      // `effectiveFrom`, instead of stopping the moment this one is loaded.
      await db.insert(complianceRequirements).values({
        requirementKey: input.requirementKey, version, family: input.family, packKey: input.packKey ?? null, title: input.title, subjectType: input.subjectType, jurisdiction: input.jurisdiction,
        appliesWhenJson: input.appliesWhen ? JSON.stringify(input.appliesWhen) : null, satisfiedByDocTypes: JSON.stringify(input.satisfiedByDocTypes),
        renewalIntervalDays: input.renewalIntervalDays ?? null, warnDaysBeforeExpiry: input.warnDaysBeforeExpiry, missingSeverity: input.missingSeverity,
        sourceAuthority: input.sourceAuthority ?? null, sourceUrl: input.sourceUrl ?? null, sourceReference: input.sourceReference ?? null,
        effectiveFrom: input.effectiveFrom, verificationStatus: stored, verifiedByUserId: stored === "verified" ? ctx.user.id : null, verifiedAt: stored === "verified" ? new Date() : null,
      });
      return { requirementKey: input.requirementKey, version, storedStatus: stored, note: stored === "unverified" && input.requestedStatus === "verified" ? "Stored unverified: a requirement cannot be verified unless its source is verified and names an authority" : undefined };
    }),

  programPublish: roleProcedure("compliance.programPublish")
    .input(z.object({
      programKey: z.string().min(2).max(80), title: z.string().min(3).max(220), programType: z.enum(["safety", "maintenance", "ohs", "emergency_response", "other"]),
      financialEntityId: z.number().int().positive(), effectiveFrom: z.coerce.date(), reviewDueAt: z.coerce.date().nullable().optional(),
      documentEvidenceRecordId: z.number().int().positive().nullable().optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const prior = await db.select({ id: writtenProgramVersions.id, version: writtenProgramVersions.version }).from(writtenProgramVersions)
        .where(and(eq(writtenProgramVersions.programKey, input.programKey), isNull(writtenProgramVersions.supersededAt))).orderBy(desc(writtenProgramVersions.version)).limit(1);
      const version = (prior[0]?.version ?? 0) + 1;
      const now = new Date();
      await db.insert(writtenProgramVersions).values({
        programKey: input.programKey, version, title: input.title, programType: input.programType, financialEntityId: input.financialEntityId,
        effectiveFrom: input.effectiveFrom, approvedByUserId: ctx.user.id, approvedAt: now, reviewDueAt: input.reviewDueAt ?? null,
        documentEvidenceRecordId: input.documentEvidenceRecordId ?? null, contentHash: input.contentHash ?? null,
      });
      if (prior[0]) {
        // Previous version stays; it is marked superseded, with a pointer forward.
        await db.update(writtenProgramVersions).set({ supersededAt: now, supersededByVersion: version }).where(eq(writtenProgramVersions.id, prior[0].id));
      }
      return { programKey: input.programKey, version, supersededVersion: prior[0]?.version ?? null };
    }),

  profileReviewRecord: roleProcedure("compliance.profileReviewRecord")
    .input(z.object({
      financialEntityId: z.number().int().positive(), jurisdiction: z.string().min(2).max(80), profileObtainedAt: z.coerce.date(),
      inspectionsOnProfile: z.number().int().nonnegative(), convictionsOnProfile: z.number().int().nonnegative(), collisionsOnProfile: z.number().int().nonnegative(),
      knownInspections: z.number().int().nonnegative(), knownConvictions: z.number().int().nonnegative(), knownCollisions: z.number().int().nonnegative(),
      riskTrend: z.enum(["improving", "stable", "worsening", "unknown"]).default("unknown"), evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // Anything on the regulator's profile that LeaseOS does not know about is
      // an exception to investigate, not a number to file.
      const unmatched = Math.max(0, input.inspectionsOnProfile - input.knownInspections) + Math.max(0, input.convictionsOnProfile - input.knownConvictions) + Math.max(0, input.collisionsOnProfile - input.knownCollisions);
      const reviewRef = ref("CPR");
      const next = nextRenewalDue({ lastObtainedAt: input.profileObtainedAt, intervalDays: 91 });
      await db.insert(carrierProfileReviews).values({
        reviewRef, financialEntityId: input.financialEntityId, jurisdiction: input.jurisdiction, profileObtainedAt: input.profileObtainedAt,
        reviewedAt: new Date(), reviewedByUserId: ctx.user.id, nextReviewDueAt: next.dueAt,
        inspectionsOnProfile: input.inspectionsOnProfile, convictionsOnProfile: input.convictionsOnProfile, collisionsOnProfile: input.collisionsOnProfile,
        unmatchedExternalEvents: unmatched, riskTrend: input.riskTrend, evidenceRecordId: input.evidenceRecordId ?? null,
      });
      return { reviewRef, unmatchedExternalEvents: unmatched, nextReviewDueAt: next.dueAt, exception: unmatched > 0 ? `${unmatched} external compliance event(s) unmatched — investigate` : null };
    }),  /** v22.22 — source-backed field knowledge restored from the v8 operational engine. */
  knowledgeCatalog: roleProcedure("compliance.knowledgeCatalog")
    .input(z.object({ category: z.enum(["tdg", "whmis", "erg", "placards", "waste_manifest", "cargo_securement", "company_policy"]).nullable().optional() }).optional())
    .query(({ input }) => ({
      items: COMPLIANCE_KNOWLEDGE_CATALOG.filter(item => !input?.category || item.category === input.category),
      source: "canonical_source_backed_catalog" as const,
    })),

  /** Fail-closed AI Secretary: organizes verified DG facts; never invents classification or final placarding. */
  dangerousGoodsAssist: roleProcedure("compliance.dangerousGoodsAssist")
    .input(z.object({
      jurisdiction: z.string().max(80).nullable().optional(),
      classificationStatus: z.enum(["verified", "needs_verification", "blocked"]),
      unNumber: z.string().max(40).nullable().optional(),
      properShippingName: z.string().max(220).nullable().optional(),
      dgClass: z.string().max(40).nullable().optional(),
      packingGroup: z.string().max(40).nullable().optional(),
      quantity: z.string().max(80).nullable().optional(),
      containerCategory: z.enum(["small", "large", "unknown"]).optional(),
      tdgShippingDocumentPresent: z.boolean().optional(),
      tdgExemptionVerified: z.boolean().optional(),
      marksConfirmed: z.boolean().optional(),
      driverTdgCertificateStatus: z.enum(["verified", "pending", "missing", "expired", "rejected"]).optional(),
      tdgDirectSupervision: z.boolean().optional(),
      supervisorTdgCertificateVerified: z.boolean().optional(),
      isHazardousWaste: z.boolean().optional(),
      isHazardousRecyclable: z.boolean().optional(),
      isDangerousOilfieldWaste: z.boolean().optional(),
      exportFromAlberta: z.boolean().optional(),
      hazardousWasteManifestPresent: z.boolean().optional(),
      recycleDocketPresent: z.boolean().optional(),
      whmisWorkplaceExposure: z.boolean().optional(),
      whmisTrainingStatus: z.enum(["current", "due", "missing", "unknown"]).optional(),
      ergGuideNumber: z.string().max(40).nullable().optional(),
      ergLookupVerified: z.boolean().optional(),
    }).strict())
    .query(({ input }) => evaluateDangerousGoodsAssist(input)),

  /** General NSC10 WLL helper. Commodity-specific rules remain an independent fail-closed gate. */
  securementAssist: roleProcedure("compliance.securementAssist")
    .input(z.object({
      cargoWeightKg: z.number().positive().nullable().optional(),
      cargoImmobilizedOrContained: z.boolean(),
      generalRuleApplicable: z.boolean(),
      commoditySpecificRuleRequired: z.boolean().optional(),
      commoditySpecificRuleConfirmed: z.boolean().optional(),
      preTripInspectionComplete: z.boolean().optional(),
      tiedowns: z.array(z.object({
        id: z.string().min(1).max(80),
        workingLoadLimitKg: z.number().positive().nullable().optional(),
        attachedEndSections: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        markedByManufacturer: z.boolean(),
        damagedOrDefective: z.boolean().optional(),
      }).strict()).max(100),
    }).strict())
    .query(({ input }) => evaluateGeneralCargoSecurement(input)),

  /** Driver-specific licence/Q/S/provincial restriction gate, complementary to Academy requirements. */
  driverQualification: roleProcedure("compliance.driverQualification")
    .input(z.object({
      profile: z.object({
        operatorId: z.number().int().positive().optional(),
        licenceClass: z.enum(["1", "2", "3", "4", "5"]).nullable().optional(),
        licenceVerification: z.enum(["verified", "pending", "rejected", "unknown"]),
        licenceExpiresAt: z.string().datetime().nullable().optional(),
        class1ProvincialRestriction: z.boolean().optional(),
        credentials: z.array(z.object({ code: z.string().min(1).max(100), verification: z.enum(["verified", "pending", "rejected", "unknown"]), expiresAt: z.string().datetime().nullable().optional() }).strict()),
        completedCompetencies: z.array(z.object({ code: z.string().min(1).max(100), verification: z.enum(["verified", "pending", "rejected", "unknown"]), expiresAt: z.string().datetime().nullable().optional() }).strict()).optional(),
      }).strict(),
      requirement: z.object({
        requiredLicenceClass: z.enum(["1", "2", "3"]),
        airBrakes: z.boolean(),
        schoolBus: z.boolean().optional(),
        dangerousGoods: z.boolean().optional(),
        tdgDirectSupervision: z.boolean().optional(),
        tdgSupervisorCertificateVerified: z.boolean().optional(),
        destinationJurisdiction: z.string().max(80).nullable().optional(),
        requiredEmployerCompetencies: z.array(z.string().min(1).max(100)).optional(),
      }).strict(),
    }).strict())
    .query(({ input }) => evaluateDriverQualification(input.profile, input.requirement)),

});
