/**
 * Compliance Master Registry — the API.
 *
 * Requirements come from the registry (the seed until rows are loaded), never
 * from the request. A verified requirement can only be created by a
 * controller from a verified source. Private credential detail leaves HR only
 * as "eligible: yes | no | unknown". Written programs are versioned and never
 * overwritten.
 */

import { complianceRequirementValidity } from "./_core/complianceDocumentValidity";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, evidenceInScope, getDb, jobInScope, operatorInScope, unitInScope, userInScope } from "./db";
import { isPrivateDocType } from "./_core/complianceProjection";
import { assertCallerOwnsEntity } from "./_core/entityScope";
import { requireProvableOwnership } from "./ownershipDomain";
import { carrierProfileReviews, complianceConsents, complianceDocuments, complianceRequirements, writtenProgramVersions } from "../drizzle/schema";
import {
  abstractRequestPermitted, buildPassport, composeJobPassport, MEDICAL_FITNESS_DOC_TYPES, medicalFitnessForDispatch, nextRenewalDue,
  type Credential, type Passport, type Requirement, type Subject,
} from "./_core/compliancePassport";
import { COMPLIANCE_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import { loadRequirementRegistry } from "./requirementRegistry";
import {
  VerificationError, proposeRequirement, recordApproval, requirementProvenance, setVerificationPolicy, withdrawRevision,
} from "./requirementVerification";
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

/** The registry at `now` for the caller's organization: governing stored revisions, then unreplaced seeds. */
const loadRequirements = (tenantId: string): Promise<Requirement[]> => loadRequirementRegistry(COMPLIANCE_REQUIREMENT_SEEDS, new Date(), tenantId);

const VERIFY_INPUT = z.object({
  requirementKey: z.string().min(3).max(120), version: z.number().int().positive(),
  target: z.enum(["CITATION_VERIFIED", "SOURCE_DOCUMENT_VERIFIED"]),
  decision: z.enum(["approve", "reject"]), reason: z.string().min(10).max(2000),
  /** Required for SOURCE_DOCUMENT_VERIFIED: the admitted source revision it was checked against. */
  sourceRevisionRef: z.string().max(64).nullable().optional(),
});

/** A verification refusal as the API reports it: another organization's revision is simply not found. */
async function asTrpc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof VerificationError)) throw e;
    const code = e.code === "NOT_FOUND" || e.code === "UNKNOWN_PACK" ? "NOT_FOUND"
      : e.code === "SELF_VERIFICATION" || e.code === "SAME_VERIFIER" ? "FORBIDDEN"
      : e.code === "OVERLAPPING_REVISION" ? "CONFLICT" : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: `${e.code}: ${e.message}` });
  }
}

async function loadCredentials(ownerType: string, ownerId: number): Promise<Credential[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, ownerType as never), eq(complianceDocuments.ownerId, ownerId)));
  return rows.map(r => ({
    id: r.id, capturedAt: r.capturedAt, ownerKey: `${r.ownerType}:${r.ownerId}`,
    docType: r.docType, requirementKey: r.requirementKey, issuedAt: r.issuedAt, expiresAt: r.expiresAt,
    verificationStatus: r.verificationStatus, privateDetail: r.privateDetail, jurisdiction: r.jurisdiction,
  }));
}

type OwnerType = "operator" | "unit" | "job" | "trailer" | "carrier" | "user" | "equipment";
/**
 * F1.2 — the subject of a credential or passport is one the caller's organization may see, through the
 * owner it already has: an operator or unit (trailers are units) through coreRecordOwnership, a job
 * through jobs.orgRef, a person through their membership, a carrier through the company's legal entity
 * (0146 — the id programPublish and profileReviewRecord record carrier compliance against). Anything
 * else answers `what`, the same answer a missing subject gets. Equipment has no owner yet: refused while
 * more than one company exists (UNKNOWN OWNERSHIP != GLOBAL ACCESS).
 */
async function requireSubjectInScope(userId: number, ownerType: OwnerType, ownerId: number, what: string): Promise<void> {
  if (ownerType === "equipment") return requireProvableOwnership("Equipment credentials", "equipment records carry an owner");
  if (ownerType === "carrier") {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return assertCallerOwnsEntity(db as never, userId, ownerId, what);
  }
  const scope = await actingScopeFor(userId);
  const visible = ownerType === "operator" ? await operatorInScope(ownerId, scope)
    : ownerType === "unit" || ownerType === "trailer" ? await unitInScope(ownerId, scope)
    : ownerType === "job" ? await jobInScope(ownerId, scope)
    : await userInScope(ownerId, scope);
  if (!visible) throw new TRPCError({ code: "NOT_FOUND", message: what });
}

async function passportFor(tenantId: string, subjectType: Subject["subjectType"], subjectId: number, jurisdiction: string, attributes: Record<string, unknown>): Promise<Passport> {
  const [requirements, credentials] = await Promise.all([loadRequirements(tenantId), loadCredentials(subjectType, subjectId)]);
  return buildPassport({ subject: { subjectType, jurisdiction, attributes }, requirements, credentials, now: new Date() });
}

export const complianceRouter = router({
  passport: roleProcedure("compliance.passport")
    .input(z.object({ subjectType: SUBJECT, subjectId: z.number().int().positive(), jurisdiction: z.string().min(2).max(80), attributes: z.record(z.string(), z.unknown()).default({}) }))
    .query(async ({ ctx, input }) => {
      await requireSubjectInScope(ctx.user.id, input.subjectType, input.subjectId, "Subject not found");
      const tenantId = (await actingScopeFor(ctx.user.id)).tenantId;
      const p = await passportFor(tenantId, input.subjectType, input.subjectId, input.jurisdiction, input.attributes);
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
    .query(async ({ ctx, input }) => {
      // F1.2 — every named subject is proven before any is read: one foreign subject refuses the whole job.
      for (const [type, s] of [["carrier", input.carrier], ["operator", input.operator], ["unit", input.unit], ["trailer", input.trailer]] as const)
        if (s) await requireSubjectInScope(ctx.user.id, type, s.id, "Subject not found");
      const tenantId = (await actingScopeFor(ctx.user.id)).tenantId;
      const parts: Record<string, Passport | null> = {
        carrier: input.carrier ? await passportFor(tenantId, "carrier", input.carrier.id, input.jurisdiction, input.carrier.attributes) : null,
        operator: input.operator ? await passportFor(tenantId, "operator", input.operator.id, input.jurisdiction, input.operator.attributes) : null,
        unit: input.unit ? await passportFor(tenantId, "unit", input.unit.id, input.jurisdiction, input.unit.attributes) : null,
      };
      if (input.trailer !== undefined) parts.trailer = input.trailer ? await passportFor(tenantId, "trailer", input.trailer.id, input.jurisdiction, input.trailer.attributes) : null;
      return composeJobPassport(parts);
    }),

  /** The only shape medical fitness takes outside HR. */
  medicalEligibility: roleProcedure("compliance.medicalEligibility")
    .input(z.object({ operatorId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { eligible: "unknown" as const, reviewDue: null };
      await requireSubjectInScope(ctx.user.id, "operator", input.operatorId, "Operator not found");
      // Every medical_fitness row, not the one with the latest date: which row is in force is the
      // canonical verdict's decision, and the dispatch composer asks it the same way.
      const rows = await db.select().from(complianceDocuments)
        .where(and(eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, input.operatorId), inArray(complianceDocuments.docType, [...MEDICAL_FITNESS_DOC_TYPES])));
      return medicalFitnessForDispatch(complianceRequirementValidity(rows, MEDICAL_FITNESS_DOC_TYPES, new Date()));
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
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // F1.2 — a credential is filed only against the caller's own subject, with the caller's own evidence.
      await requireSubjectInScope(ctx.user.id, input.ownerType, input.ownerId, "Credential owner not found");
      if (input.evidenceRecordId != null && !(await evidenceInScope(input.evidenceRecordId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence record not found" });
      // Recorded is not verified. Every credential enters as needs_review.
      const ins = await db.insert(complianceDocuments).values({
        ownerType: input.ownerType, ownerId: input.ownerId, docType: input.docType, requirementKey: input.requirementKey ?? null,
        title: input.title, identifier: input.identifier ?? null, capturedAt: new Date(), issuedAt: input.issuedAt ?? null,
        expiresAt: input.expiresAt ?? null, jurisdiction: input.jurisdiction ?? null, verificationStatus: "needs_review",
        source: input.source ?? null, confidence: "medium", privateDetail: input.privateDetail || isPrivateDocType(input.docType),
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
      // F1.2 — another company's credential is not found, not verifiable.
      await requireSubjectInScope(ctx.user.id, rows[0].ownerType, rows[0].ownerId, "Credential not found");
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
      // F1.2 — consent is recorded for the caller's own people, against the caller's own signature evidence.
      await requireSubjectInScope(ctx.user.id, "user", input.subjectUserId, "Subject not found");
      if (input.signatureEvidenceRecordId != null && !(await evidenceInScope(input.signatureEvidenceRecordId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence record not found" });
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
   * Propose a requirement revision (C1b-2b). The name is kept for existing callers; what it does is
   * proposal creation, and nothing else. It used to let a controller store a requirement as `verified`
   * in one step by saying its source was verified — the proposer verifying their own rule. That path is
   * gone: `sourceVerified` and `requestedStatus` are still accepted so old callers do not break, and are
   * ignored. Verification is `requirementVerify` (and `requirementSecondApprove` for a blocking rule),
   * by other people, through the ledger.
   */
  requirementLoad: roleProcedure("compliance.requirementLoad")
    .input(z.object({
      requirementKey: z.string().min(3).max(120), family: z.string().min(2).max(60), title: z.string().min(3).max(220),
      /** C1b-2: the pack this requirement belongs to; it applies only where the pack is active. */
      packKey: z.string().min(2).max(80).nullable().optional(),
      subjectType: REQUIREMENT_SUBJECT, jurisdiction: z.string().min(1).max(80), appliesWhen: z.record(z.string(), z.unknown()).nullable().optional(),
      satisfiedByDocTypes: z.array(z.string().min(1)).min(1), renewalIntervalDays: z.number().int().positive().nullable().optional(),
      warnDaysBeforeExpiry: z.number().int().nonnegative().default(30), missingSeverity: z.enum(["review", "blocked"]).default("review"),
      /** The citation: issuing authority, section or equally precise citation, official URL, instrument. */
      sourceAuthority: z.string().max(220).nullable().optional(), sourceUrl: z.string().max(600).nullable().optional(), sourceReference: z.string().max(300).nullable().optional(),
      instrumentTitle: z.string().max(400).nullable().optional(),
      authorityType: z.enum(["law", "official_guidance", "recognized_standard", "manufacturer"]).nullable().optional(),
      /** The date the rule takes effect, or `effectiveDateUnknown: true` — recorded, never guessed. */
      effectiveFrom: z.coerce.date().nullable().optional(), effectiveDateUnknown: z.boolean().default(false),
      effectiveUntil: z.coerce.date().nullable().optional(),
      /** Accepted for old callers; ignored. A proposal is never verified. */
      sourceVerified: z.boolean().default(false), requestedStatus: z.enum(["unverified", "verified"]).default("unverified"),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!input.effectiveFrom && !input.effectiveDateUnknown) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Record the effective date, or record explicitly that it is unknown (effectiveDateUnknown)" });
      }
      const orgRef = (await actingScopeFor(ctx.user.id)).tenantId;
      const r = await asTrpc(() => proposeRequirement({
        requirementKey: input.requirementKey, family: input.family, title: input.title, packKey: input.packKey ?? null,
        subjectType: input.subjectType, jurisdiction: input.jurisdiction, appliesWhen: input.appliesWhen ?? null,
        satisfiedByDocTypes: input.satisfiedByDocTypes, renewalIntervalDays: input.renewalIntervalDays ?? null,
        warnDaysBeforeExpiry: input.warnDaysBeforeExpiry, missingSeverity: input.missingSeverity,
        instrumentTitle: input.instrumentTitle ?? null, issuingAuthority: input.sourceAuthority ?? null,
        citation: input.sourceReference ?? null, officialUrl: input.sourceUrl ?? null, authorityType: input.authorityType ?? null,
        effectiveFrom: input.effectiveFrom ?? null, effectiveDateUnknown: input.effectiveDateUnknown, effectiveUntil: input.effectiveUntil ?? null,
      }, ctx.user.id, orgRef, new Date()));
      return {
        requirementKey: r.requirementKey, version: r.version, storedStatus: "unverified" as const, level: r.level,
        note: input.requestedStatus === "verified" || input.sourceVerified
          ? "Stored as a proposal. A requirement is verified by people other than its proposer (requirementVerify), never by the proposer's own flag"
          : undefined,
      };
    }),

  /** First verification of a revision — citation or source document. Never the proposer. */
  requirementVerify: roleProcedure("compliance.requirementVerify")
    .input(VERIFY_INPUT)
    .mutation(async ({ ctx, input }) => {
      const orgRef = (await actingScopeFor(ctx.user.id)).tenantId;
      return asTrpc(() => recordApproval({ ...input, step: 1 }, ctx.user.id, orgRef, new Date()));
    }),

  /** Second, independent verification of a dispatch-blocking revision. Neither the proposer nor the first verifier. */
  requirementSecondApprove: roleProcedure("compliance.requirementSecondApprove")
    .input(VERIFY_INPUT)
    .mutation(async ({ ctx, input }) => {
      const orgRef = (await actingScopeFor(ctx.user.id)).tenantId;
      return asTrpc(() => recordApproval({ ...input, step: 2 }, ctx.user.id, orgRef, new Date()));
    }),

  /** Withdraw a revision. Recorded as an event; the revision and its verification history remain. */
  requirementWithdraw: roleProcedure("compliance.requirementWithdraw")
    .input(z.object({ requirementKey: z.string().min(3).max(120), version: z.number().int().positive(), reason: z.string().min(10).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const orgRef = (await actingScopeFor(ctx.user.id)).tenantId;
      return asTrpc(() => withdrawRevision(input.requirementKey, input.version, input.reason, ctx.user.id, orgRef, new Date()));
    }),

  /**
   * Governance policy: whether an authority / domain / jurisdiction may still be verified by citation
   * alone. Append-only; a change is a new row. Not a UI toggle: it is the act that closes the
   * citation route for an authority once its source documents are admitted.
   */
  verificationPolicySet: roleProcedure("compliance.verificationPolicySet")
    .input(z.object({
      issuingAuthority: z.string().max(220).nullable().optional(), domain: z.string().max(60).nullable().optional(),
      jurisdiction: z.string().max(80).nullable().optional(),
      mode: z.enum(["CITATION_ALLOWED", "SOURCE_DOCUMENT_REQUIRED"]), reason: z.string().min(20).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const orgRef = (await actingScopeFor(ctx.user.id)).tenantId;
      return setVerificationPolicy(input, input.mode, input.reason, ctx.user.id, orgRef);
    }),

  /** Why LeaseOS trusted each revision of a requirement: citation, fingerprint and every event. */
  requirementProvenance: roleProcedure("compliance.requirementProvenance")
    .input(z.object({ requirementKey: z.string().min(3).max(120) }))
    .query(async ({ ctx, input }) => {
      const orgRef = (await actingScopeFor(ctx.user.id)).tenantId;
      return asTrpc(() => requirementProvenance(input.requirementKey, orgRef));
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
      // F1.1 — the program is the caller's own company's; so is the version it supersedes. (A program key is
      // not unique across companies: publishing "safety-manual" must never supersede another company's.)
      await assertCallerOwnsEntity(db as never, ctx.user.id, input.financialEntityId);
      if (input.documentEvidenceRecordId != null && !(await evidenceInScope(input.documentEvidenceRecordId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence record not found" });
      const prior = await db.select({ id: writtenProgramVersions.id, version: writtenProgramVersions.version }).from(writtenProgramVersions)
        .where(and(eq(writtenProgramVersions.programKey, input.programKey), eq(writtenProgramVersions.financialEntityId, input.financialEntityId), isNull(writtenProgramVersions.supersededAt))).orderBy(desc(writtenProgramVersions.version)).limit(1);
      // Program keys are unique across LeaseOS (UNIQUE programKey+version) until the schema scopes them per company.
      // A key another company holds is refused as taken — never superseded, never a database error.
      if (!prior[0]) {
        const elsewhere = (await db.select({ id: writtenProgramVersions.id }).from(writtenProgramVersions).where(and(eq(writtenProgramVersions.programKey, input.programKey), ne(writtenProgramVersions.financialEntityId, input.financialEntityId))).limit(1))[0];
        if (elsewhere) throw new TRPCError({ code: "CONFLICT", message: `Program key ${input.programKey} is already in use — choose another key` });
      }
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
      // F1.1 — recorded against the caller's own company only.
      await assertCallerOwnsEntity(db as never, ctx.user.id, input.financialEntityId);
      if (input.evidenceRecordId != null && !(await evidenceInScope(input.evidenceRecordId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence record not found" });
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
