/**
 * Safety & Compliance Program Builder — the API.
 *
 * Four boundaries, kept explicit:
 *  1. the library (modules, templates, references) is seeded from code and read
 *     by everyone with the read permission; a company's program, policies and
 *     records are scoped to the caller's acting organization (0132: NULL orgRef
 *     is the historical single tenant) and never chosen from input;
 *  2. a version is immutable once approved; the approver is never the preparer;
 *     the corrective-action verifier is never the completer; a reference is
 *     never verified by the person who recorded it;
 *  3. acknowledgements and "my policies" are self-scoped from ctx.user.id and
 *     bind to the exact version hash the worker saw;
 *  4. every write appends a hash-chained event; the ledger is read-only here.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { roleProcedure, router } from "./_core/trpc";
import { evidenceInScope, getDb, orgScopeWhere, ownershipScopeWhere, userInScope } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { financialEntities } from "../drizzle/schema";
import { effectiveQualifications } from "./qualificationReads";
import { complianceDocumentValidity } from "./_core/complianceDocumentValidity";
import { assertEntityInScope } from "./_core/entityScope";
import {
  clientPolicyOverlays, customerAccounts, companyPolicies, companySafetyPrograms, companyTrainingMatrix, complianceDocuments,
  correctiveActions, incidentActions, incidentReports, inspections, nearMissReports, operators, organizationWorkers,
  policyAcknowledgements, policyRegulatoryLinks, policyReviews, policyTemplates, policyVersions, regulatoryReferences,
  safetyEvents, safetyProgramEvents, safetyProgramModules, tailgateMeetings, trainingRecords, trainingRequirements, units,
  userRoleAssignments,
} from "../drizzle/schema";
import {
  POLICY_TEMPLATE_SEEDS, REGULATORY_REFERENCE_SEEDS, SAFETY_PACKS, SAFETY_PROGRAM_MODULES, moduleByKey,
} from "./_core/safetyProgramCatalog";
import { CONTENT_PACKS } from "./_core/safetyProgramContentPacks";
import {
  acknowledgementDecision, approvalDecision, assembleProgram, completionDecision, contentHash, corReadiness, correctiveActionView,
  editDecision, eventHash, matrixSummary, nextReviewDue, policyCode, programObligations, recommendedModules, recommendedPacks,
  reviewCompletionDecision, sha256, signatureHash, templateSeedHash, trainingMatrixFor, vendorPackageManifest, verificationDecision,
  verifyEventChain, versionHash, versionLabel, contentPackIntegrity, renderMergeFields,
  type MatrixAcknowledgement, type MatrixHolding, type MatrixRequirement, type MatrixWorker, type OperationsProfile, type Section,
} from "./_core/safetyProgram";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const DAY = 86_400_000;
const KIND = z.enum(["policy", "procedure", "safe_work_practice", "plan", "program", "form", "statement"]);
const SECTION = z.object({ heading: z.string().min(1).max(160), body: z.string().max(20_000) });
const PROFILE = z.object({
  jurisdictions: z.array(z.string().min(2).max(10)).default([]), workforceSize: z.number().int().nonnegative().default(0),
  nscCarrier: z.boolean().default(false), federalCarrier: z.boolean().default(false), oilfield: z.boolean().default(false),
  hydrovac: z.boolean().default(false), groundDisturbance: z.boolean().default(false), dangerousGoods: z.boolean().default(false),
  workingAlone: z.boolean().default(false),
});

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
type Db = Awaited<ReturnType<typeof dbOrThrow>>;

/** The acting organization, from the server's scope resolution — never from input. */
async function orgOf(db: Db, userId: number): Promise<string | null> {
  const acting = await resolveActingScope(db, userId);
  return acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId;
}
const scopeKeyOf = (orgRef: string | null) => orgRef ?? "platform";
const tenantOf = (orgRef: string | null) => ({ tenantId: orgRef ?? SINGLE_TENANT_ID });
/** The 0132 rule through main's canonical `orgScopeWhere`: the single tenant reads NULL or 'default', an organization its own rows. */
const scopeWhere = (col: AnyMySqlColumn, orgRef: string | null) => orgScopeWhere({ orgRef: col }, tenantOf(orgRef));
function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
const notFound = (what: string): never => { throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` }); };
const refuse = (reason: string): never => { throw new TRPCError({ code: "FORBIDDEN", message: reason }); };
const bad = (reason: string): never => { throw new TRPCError({ code: "BAD_REQUEST", message: reason }); };

/**
 * Append one event to the hash chain. `previousHash` is UNIQUE (0228), so two writers that read the same head
 * cannot both link to it: the second insert is refused and that writer re-reads the head and tries again. A
 * concurrent write therefore extends the chain instead of forking it — the same discipline main's document
 * register keeps with its unique per-document sequence.
 */
async function audit(db: Db, orgRef: string | null, actorUserId: number | null, subjectType: string, subjectRef: string, eventType: string, payload: unknown) {
  const eventRef = ref("SP-EVT");
  const eventJson = JSON.stringify(payload ?? {});
  for (let attempt = 0; ; attempt++) {
    const previous = (await db.select({ eventHash: safetyProgramEvents.eventHash }).from(safetyProgramEvents).orderBy(desc(safetyProgramEvents.id)).limit(1))[0]?.eventHash ?? null;
    const hash = eventHash({ eventRef, actorUserId, subjectType, subjectRef, eventType, eventJson, previousHash: previous });
    try {
      await db.insert(safetyProgramEvents).values({ eventRef, orgRef, actorUserId, subjectType, subjectRef, eventType, eventJson, previousHash: previous, eventHash: hash });
      return eventRef;
    } catch (e) {
      const dup = /Duplicate entry|ER_DUP_ENTRY/.test(String((e as { message?: string; cause?: { message?: string } }).cause?.message ?? (e as Error).message));
      if (!dup || attempt >= 20) throw e;
    }
  }
}

/*
 * Every identifier a caller supplies is proved against the caller's organization before it is stored or read
 * through. Each refuses as NOT FOUND, never FORBIDDEN: another organization's record does not exist here.
 */
async function requireUserInScope(userId: number, orgRef: string | null) {
  if (!(await userInScope(userId, tenantOf(orgRef)))) notFound(`User ${userId}`);
}
async function requireEvidenceInScope(evidenceRecordId: number, orgRef: string | null) {
  if (!(await evidenceInScope(evidenceRecordId, tenantOf(orgRef)))) notFound(`Evidence record ${evidenceRecordId}`);
}
async function requireCustomerAccountInScope(db: Db, customerAccountId: number, orgRef: string | null) {
  const [row] = await db.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.id, customerAccountId), orgScopeWhere(customerAccounts, tenantOf(orgRef)))).limit(1);
  if (!row) notFound(`Customer account ${customerAccountId}`);
}
async function requireOverlaysInScope(db: Db, overlayRefs: readonly string[], orgRef: string | null) {
  if (overlayRefs.length === 0) return;
  const rows = await db.select({ overlayRef: clientPolicyOverlays.overlayRef }).from(clientPolicyOverlays).where(and(inArray(clientPolicyOverlays.overlayRef, [...overlayRefs]), scopeWhere(clientPolicyOverlays.orgRef, orgRef)));
  const found = new Set(rows.map(r => r.overlayRef));
  const missing = overlayRefs.find(r => !found.has(r));
  if (missing) notFound(`Overlay ${missing}`);
}
/** Regulatory references are platform-wide: every organization reads them, so no single organization writes or verifies them. */
function requirePlatformScope(orgRef: string | null, act: string) {
  if (orgRef != null) refuse(`Regulatory references are shared by every organization; they are ${act} from the platform scope, not by one organization for all the others`);
}

async function policyInScope(db: Db, policyRef: string, orgRef: string | null) {
  const [p] = await db.select().from(companyPolicies).where(and(eq(companyPolicies.policyRef, policyRef), scopeWhere(companyPolicies.orgRef, orgRef))).limit(1);
  return p ?? notFound(`Policy ${policyRef}`);
}
async function versionById(db: Db, id: number) {
  const [v] = await db.select().from(policyVersions).where(eq(policyVersions.id, id)).limit(1);
  return v ?? notFound("Policy version");
}
async function activeProgram(db: Db, orgRef: string | null) {
  const [p] = await db.select().from(companySafetyPrograms).where(and(eq(companySafetyPrograms.scopeKey, scopeKeyOf(orgRef)), inArray(companySafetyPrograms.status, ["draft", "active"]))).orderBy(desc(companySafetyPrograms.id)).limit(1);
  return p ?? null;
}
async function templatesFor(db: Db, orgRef: string | null) {
  return db.select().from(policyTemplates).where(and(eq(policyTemplates.active, true), orgRef == null ? isNull(policyTemplates.orgRef) : sql`(${policyTemplates.orgRef} IS NULL OR ${policyTemplates.orgRef} = ${orgRef})`));
}

/** Who counts as the workforce: the organization's active workers, or in the single tenant everyone holding an active role who belongs to no organization. */
async function workforce(db: Db, orgRef: string | null): Promise<{ userId: number; positionCode: string }[]> {
  if (orgRef != null) {
    const rows = await db.select({ userId: organizationWorkers.userId, workerType: organizationWorkers.workerType }).from(organizationWorkers)
      .where(and(eq(organizationWorkers.orgRef, orgRef), eq(organizationWorkers.status, "active")));
    return rows.filter((r): r is { userId: number; workerType: typeof r.workerType } => r.userId != null).map(r => ({ userId: r.userId, positionCode: r.workerType }));
  }
  // The single tenant's people are those with an active role and no active organization membership — the same
  // rule as main's userInScope — so a member of another organization never appears in this workforce.
  const rows = await db.selectDistinct({ userId: userRoleAssignments.userId, role: userRoleAssignments.role }).from(userRoleAssignments)
    .where(and(isNull(userRoleAssignments.revokedAt), sql`${userRoleAssignments.userId} NOT IN (SELECT m.userId FROM organizationMemberships m WHERE m.status = 'active')`));
  const seen = new Map<number, string>();
  for (const r of rows) if (!seen.has(r.userId)) seen.set(r.userId, String(r.role).toUpperCase());
  return Array.from(seen, ([userId, positionCode]) => ({ userId, positionCode }));
}

/**
 * What each person holds, for the matrix. Qualifications are read ONLY through the canonical adapter
 * (`effectiveQualifications`), which applies the Academy-over-legacy rule, the evidence-document check and
 * the organization boundary; this function maps its verdict and never re-decides it. Company training
 * records are read directly: they are not a qualification store the adapter covers.
 */
async function holdingsFor(db: Db, orgRef: string | null, userIds: number[], codes: readonly string[], at: Date): Promise<Map<number, MatrixHolding[]>> {
  const out = new Map<number, MatrixHolding[]>();
  if (userIds.length === 0) return out;
  const add = (u: number, h: MatrixHolding) => { const a = out.get(u) ?? []; a.push(h); out.set(u, a); };
  const tenantId = orgRef ?? SINGLE_TENANT_ID;
  if (codes.length) for (const userId of userIds) {
    for (const q of await effectiveQualifications(db, { tenantId, userId, at, codes })) {
      if (q.source == null || q.state === "none" || q.state === "rejected") continue;
      add(userId, {
        kind: q.source === "ACADEMY_QUALIFICATION" ? "academy_qualification" : "worker_qualification",
        ref: q.sourceRef ?? q.code, code: q.code, issuedAt: q.issuedAt,
        // An expired verdict is expired even when the source carries no end date: the engine reads it from expiresAt.
        expiresAt: q.state === "expired" ? (q.expiresAt ?? at) : q.expiresAt,
        verified: q.state === "expired" ? true : q.held,
      });
    }
  }
  for (const t of await db.select().from(trainingRecords).where(inArray(trainingRecords.userId, userIds))) {
    if (t.verificationStatus === "rejected") continue;
    add(t.userId, { kind: "training_record", ref: t.trainingRef, code: t.courseCode, issuedAt: t.completedAt, expiresAt: t.expiresAt, verified: t.verificationStatus === "verified" });
  }
  return out;
}

async function acknowledgementsFor(db: Db, orgRef: string | null, userIds: number[]): Promise<Map<number, MatrixAcknowledgement[]>> {
  const out = new Map<number, MatrixAcknowledgement[]>();
  if (userIds.length === 0) return out;
  const rows = await db.select({
    userId: policyAcknowledgements.userId, acknowledgementRef: policyAcknowledgements.acknowledgementRef, signedAt: policyAcknowledgements.signedAt,
    versionId: policyAcknowledgements.policyVersionId, policyRef: companyPolicies.policyRef, currentVersionId: companyPolicies.currentVersionId,
  }).from(policyAcknowledgements).innerJoin(companyPolicies, eq(companyPolicies.id, policyAcknowledgements.companyPolicyId))
    .where(and(scopeWhere(policyAcknowledgements.orgRef, orgRef), inArray(policyAcknowledgements.userId, userIds)));
  for (const r of rows) {
    const a = out.get(r.userId) ?? [];
    a.push({ policyRef: r.policyRef, acknowledgementRef: r.acknowledgementRef, currentVersion: r.currentVersionId === r.versionId, signedAt: r.signedAt });
    out.set(r.userId, a);
  }
  return out;
}

async function currentMatrixSummary(db: Db, orgRef: string | null) {
  const rows = await db.select({ status: companyTrainingMatrix.status }).from(companyTrainingMatrix).where(and(scopeWhere(companyTrainingMatrix.orgRef, orgRef), eq(companyTrainingMatrix.current, true)));
  return matrixSummary(rows.map(r => ({ status: r.status })) as never);
}

/** Counts through a job's organization when the row has a job; the single tenant counts everything. */
function jobScope(jobIdCol: AnyMySqlColumn, orgRef: string | null) {
  // The 0132 rule: the single tenant owns jobs with no organization (or 'default'), and rows with no job; an
  // organization owns its own jobs only.
  return orgRef == null
    ? sql`(${jobIdCol} IS NULL OR ${jobIdCol} IN (SELECT j.id FROM jobs j WHERE j.orgRef IS NULL OR j.orgRef = ${SINGLE_TENANT_ID}))`
    : sql`${jobIdCol} IN (SELECT j.id FROM jobs j WHERE j.orgRef = ${orgRef})`;
}
const count = async (db: Db, q: Promise<{ n: unknown }[]>) => Number((await q)[0]?.n ?? 0);

export const safetyProgramRouter = router({
  /* ---------------- library ---------------- */

  catalog: roleProcedure("safetyProgram.catalog").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const [modules, templates, references] = await Promise.all([
      db.select().from(safetyProgramModules).orderBy(safetyProgramModules.ordinal),
      templatesFor(db, orgRef),
      db.select({ referenceKey: regulatoryReferences.referenceKey, jurisdiction: regulatoryReferences.jurisdiction, instrument: regulatoryReferences.instrument, provision: regulatoryReferences.provision, title: regulatoryReferences.title, verificationStatus: regulatoryReferences.verificationStatus }).from(regulatoryReferences),
    ]);
    return {
      seeded: modules.length > 0,
      modules: modules.length ? modules : SAFETY_PROGRAM_MODULES.map(m => ({ ...m, appliesWhenJson: JSON.stringify(m.appliesWhen) })),
      packs: SAFETY_PACKS,
      templates: templates.map(t => ({ templateKey: t.templateKey, moduleKey: t.moduleKey, packKey: t.packKey, documentKind: t.documentKind, title: t.title, templateVersion: t.templateVersion, contentStatus: t.contentStatus, acknowledgementRequired: t.acknowledgementRequired, reviewIntervalMonths: t.reviewIntervalMonths, regulatoryBasis: t.regulatoryBasis, orgRef: t.orgRef })),
      references,
    };
  }),

  templateDetail: roleProcedure("safetyProgram.templateDetail").input(z.object({ templateKey: z.string().min(3).max(120) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const [t] = await db.select().from(policyTemplates).where(and(eq(policyTemplates.templateKey, input.templateKey), sql`(${policyTemplates.orgRef} IS NULL OR ${policyTemplates.orgRef} = ${orgRef ?? ""})`)).limit(1);
    if (!t) return notFound(`Template ${input.templateKey}`);
    const refKeys = json<string[]>(t.regulatoryReferenceKeysJson, []);
    const refs = refKeys.length ? await db.select().from(regulatoryReferences).where(inArray(regulatoryReferences.referenceKey, refKeys)) : [];
    return { ...t, sections: json<Section[]>(t.sectionsJson, []), references: refs };
  }),

  /** Re-asserts the library from code. Idempotent: a changed seed becomes a new template version; company templates are untouched. */
  syncCatalog: roleProcedure("safetyProgram.syncCatalog").mutation(async ({ ctx }) => {
    const db = await dbOrThrow();
    let modulesUpserted = 0, templatesInserted = 0, templatesRevised = 0, referencesInserted = 0;
    for (const m of SAFETY_PROGRAM_MODULES) {
      const [existing] = await db.select({ id: safetyProgramModules.id }).from(safetyProgramModules).where(eq(safetyProgramModules.moduleKey, m.moduleKey)).limit(1);
      const values = { ordinal: m.ordinal, title: m.title, description: m.description, codePrefix: m.codePrefix, appliesWhenJson: JSON.stringify(m.appliesWhen), active: true };
      if (existing) await db.update(safetyProgramModules).set(values).where(eq(safetyProgramModules.id, existing.id));
      else await db.insert(safetyProgramModules).values({ moduleKey: m.moduleKey, ...values });
      modulesUpserted++;
    }
    for (const t of POLICY_TEMPLATE_SEEDS) {
      const hash = templateSeedHash(t);
      const [existing] = await db.select({ id: policyTemplates.id, contentHash: policyTemplates.contentHash, templateVersion: policyTemplates.templateVersion, contentStatus: policyTemplates.contentStatus }).from(policyTemplates).where(eq(policyTemplates.templateKey, t.templateKey)).limit(1);
      const common = { moduleKey: t.moduleKey, packKey: t.packKey, documentKind: t.documentKind, title: t.title, acknowledgementRequired: t.acknowledgementRequired, reviewIntervalMonths: t.reviewIntervalMonths, defaultOwnerRole: t.defaultOwnerRole, regulatoryReferenceKeysJson: JSON.stringify(t.regulatoryReferenceKeys), active: true };
      if (!existing) {
        await db.insert(policyTemplates).values({ templateKey: t.templateKey, orgRef: null, ...common, sectionsJson: JSON.stringify(t.sections.map(h => ({ heading: h, body: "" }))), contentHash: hash, contentStatus: "skeleton" });
        templatesInserted++;
      } else if (existing.contentStatus === "skeleton" && existing.contentHash !== hash) {
        // A skeleton whose headings changed in code is re-issued; drafted or reviewed content is never overwritten by a seed.
        await db.update(policyTemplates).set({ ...common, sectionsJson: JSON.stringify(t.sections.map(h => ({ heading: h, body: "" }))), contentHash: hash, templateVersion: existing.templateVersion + 1 }).where(eq(policyTemplates.id, existing.id));
        templatesRevised++;
      } else {
        await db.update(policyTemplates).set({ regulatoryReferenceKeysJson: common.regulatoryReferenceKeysJson, active: true }).where(eq(policyTemplates.id, existing.id));
      }
      for (const k of t.regulatoryReferenceKeys) {
        await db.insert(policyRegulatoryLinks).values({ subjectType: "template", subjectRef: t.templateKey, referenceKey: k, linkedByUserId: null }).onDuplicateKeyUpdate({ set: { referenceKey: k } });
      }
    }
    for (const r of REGULATORY_REFERENCE_SEEDS) {
      const [existing] = await db.select({ id: regulatoryReferences.id }).from(regulatoryReferences).where(eq(regulatoryReferences.referenceKey, r.referenceKey)).limit(1);
      if (existing) continue;   // a recorded (possibly verified) reference is never re-seeded
      await db.insert(regulatoryReferences).values({ ...r, verificationStatus: "unverified", recordedByUserId: null });
      referencesInserted++;
    }
    await audit(db, null, ctx.user.id, "catalog", "library", "catalog.synced", { modulesUpserted, templatesInserted, templatesRevised, referencesInserted });
    return { modulesUpserted, templatesInserted, templatesRevised, referencesInserted, templateCount: POLICY_TEMPLATE_SEEDS.length };
  }),

  /**
   * Loads the written content packs into the library. A skeleton becomes a draft; a draft whose text
   * changed in code is re-issued as a new template version; a template a person has REVIEWED is never
   * overwritten, and is listed as skipped. Packs load per category so a company can see which are in.
   */
  syncContent: roleProcedure("safetyProgram.syncContent").input(z.object({ packRef: z.string().max(120).optional() }).default({})).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const packs = CONTENT_PACKS.filter(p => !input.packRef || p.packRef === input.packRef);
    if (input.packRef && packs.length === 0) return notFound(`Content pack ${input.packRef}`);
    const loaded: { packRef: string; drafted: number; revised: number; unchanged: number; skippedReviewed: string[]; missingTemplates: string[] }[] = [];
    for (const pack of packs) {
      const integrity = contentPackIntegrity(pack);
      if (!integrity.ok) return bad(`Content pack ${pack.packRef} is not loadable: ${integrity.problems.join("; ")}`);
      const r = { packRef: pack.packRef, drafted: 0, revised: 0, unchanged: 0, skippedReviewed: [] as string[], missingTemplates: [] as string[] };
      for (const t of pack.templates) {
        const [existing] = await db.select({ id: policyTemplates.id, title: policyTemplates.title, contentStatus: policyTemplates.contentStatus, contentHash: policyTemplates.contentHash, templateVersion: policyTemplates.templateVersion }).from(policyTemplates).where(and(eq(policyTemplates.templateKey, t.templateKey), isNull(policyTemplates.orgRef))).limit(1);
        if (!existing) { r.missingTemplates.push(t.templateKey); continue; }   // syncCatalog first
        if (existing.contentStatus === "reviewed") { r.skippedReviewed.push(t.templateKey); continue; }
        const hash = contentHash(existing.title, t.sections, "");
        if (existing.contentStatus === "draft" && existing.contentHash === hash) { r.unchanged++; continue; }
        await db.update(policyTemplates).set({ sectionsJson: JSON.stringify(t.sections), bodyMarkdown: "", summary: t.summary, contentHash: hash, contentStatus: "draft", templateVersion: existing.contentStatus === "skeleton" ? existing.templateVersion : existing.templateVersion + 1 }).where(eq(policyTemplates.id, existing.id));
        if (existing.contentStatus === "skeleton") r.drafted++; else r.revised++;
      }
      loaded.push(r);
      await audit(db, null, ctx.user.id, "contentPack", pack.packRef, "content.loaded", r);
    }
    return { packs: loaded };
  }),

  /* ---------------- program ---------------- */

  obligations: roleProcedure("safetyProgram.obligations").input(z.object({ profile: PROFILE })).query(({ input }) => {
    const p = input.profile as OperationsProfile;
    return { obligations: programObligations(p), recommendedPacks: recommendedPacks(p), recommendedModules: recommendedModules(p) };
  }),

  programGet: roleProcedure("safetyProgram.programGet").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const p = await activeProgram(db, orgRef);
    if (!p) return { program: null };
    return { program: { ...p, jurisdictionPackKeys: json<string[]>(p.jurisdictionPackKeysJson, []), moduleKeys: json<string[]>(p.moduleKeysJson, []), operationsProfile: json<OperationsProfile>(p.operationsProfileJson, {} as OperationsProfile) } };
  }),

  programSet: roleProcedure("safetyProgram.programSet")
    .input(z.object({
      name: z.string().min(2).max(220), financialEntityId: z.number().int().positive().nullable().optional(), profile: PROFILE,
      packKeys: z.array(z.string().min(2).max(60)).max(20), moduleKeys: z.array(z.string().min(2).max(60)).max(20).optional(), activate: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      // A program may name the company's financial entity; the entity must be one the caller's organization owns.
      if (input.financialEntityId != null) await assertEntityInScope(db as never, input.financialEntityId, tenantOf(orgRef));
      const profile = input.profile as OperationsProfile;
      const modules = input.moduleKeys?.length ? input.moduleKeys : recommendedModules(profile);
      const assembly = assembleProgram({ packKeys: input.packKeys, moduleKeys: modules }, await templatesFor(db, orgRef));
      const existing = await activeProgram(db, orgRef);
      const values = {
        name: input.name, financialEntityId: input.financialEntityId ?? null, jurisdictionPackKeysJson: JSON.stringify(assembly.packKeys), moduleKeysJson: JSON.stringify(assembly.moduleKeys),
        operationsProfileJson: JSON.stringify(profile), status: (input.activate ? "active" : existing?.status ?? "draft") as "draft" | "active", assembledAt: new Date(), assemblyHash: assembly.assemblyHash,
      };
      let programRef = existing?.programRef;
      if (existing) await db.update(companySafetyPrograms).set(values).where(eq(companySafetyPrograms.id, existing.id));
      else { programRef = ref("SPRG"); await db.insert(companySafetyPrograms).values({ programRef, orgRef, scopeKey: scopeKeyOf(orgRef), createdByUserId: ctx.user.id, ...values }); }
      await audit(db, orgRef, ctx.user.id, "program", programRef!, existing ? "program.updated" : "program.created", { packKeys: assembly.packKeys, moduleKeys: assembly.moduleKeys, assemblyHash: assembly.assemblyHash, status: values.status });
      return { programRef: programRef!, packKeys: assembly.packKeys, moduleKeys: assembly.moduleKeys, templateCount: assembly.included.length, assemblyHash: assembly.assemblyHash, obligations: programObligations(profile) };
    }),

  /** The manual outline for the company's selection, with what already exists as a policy and what does not. */
  assemble: roleProcedure("safetyProgram.assemble").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const p = await activeProgram(db, orgRef);
    if (!p) return bad("No safety program has been set up for this organization; call programSet first");
    const assembly = assembleProgram({ packKeys: json<string[]>(p.jurisdictionPackKeysJson, []), moduleKeys: json<string[]>(p.moduleKeysJson, []) }, await templatesFor(db, orgRef));
    const policies = await db.select({ templateKey: companyPolicies.templateKey, policyRef: companyPolicies.policyRef, policyCode: companyPolicies.policyCode, status: companyPolicies.status, currentVersionId: companyPolicies.currentVersionId })
      .from(companyPolicies).where(and(eq(companyPolicies.scopeKey, scopeKeyOf(orgRef)), inArray(companyPolicies.status, ["draft", "active"])));
    const byTemplate = new Map(policies.filter(x => x.templateKey).map(x => [x.templateKey!, x]));
    const outline = assembly.byModule.map(m => ({
      moduleKey: m.moduleKey, title: m.title, codePrefix: m.codePrefix,
      items: m.templates.map(t => { const pol = byTemplate.get(t.templateKey); return { templateKey: t.templateKey, title: t.title, documentKind: t.documentKind, packKey: t.packKey, policyRef: pol?.policyRef ?? null, policyCode: pol?.policyCode ?? null, policyStatus: pol?.status ?? null, hasApprovedVersion: pol?.currentVersionId != null }; }),
    }));
    const total = assembly.included.length; const created = assembly.included.filter(t => byTemplate.has(t.templateKey)).length;
    const approved = assembly.included.filter(t => byTemplate.get(t.templateKey)?.currentVersionId != null).length;
    return { programRef: p.programRef, packKeys: assembly.packKeys, moduleKeys: assembly.moduleKeys, assemblyHash: assembly.assemblyHash, coverage: { templates: total, policiesCreated: created, policiesApproved: approved }, outline };
  }),

  /* ---------------- policies and versions ---------------- */

  policyCreate: roleProcedure("safetyProgram.policyCreate")
    .input(z.object({
      templateKey: z.string().min(3).max(120).nullable().optional(), moduleKey: z.string().min(2).max(60).optional(), documentKind: KIND.optional(), title: z.string().min(3).max(220).optional(),
      packKey: z.string().min(2).max(60).optional(), appliesTo: z.string().min(2).max(300).default("All workers and contractors"), ownerRole: z.string().min(2).max(40).optional(), ownerUserId: z.number().int().positive().nullable().optional(),
      approverRole: z.string().min(2).max(40).default("management"), acknowledgementRequired: z.boolean().optional(), reviewIntervalMonths: z.number().int().min(1).max(60).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      if (input.ownerUserId != null) await requireUserInScope(input.ownerUserId, orgRef);
      let template: typeof policyTemplates.$inferSelect | null = null;
      if (input.templateKey) {
        [template] = await db.select().from(policyTemplates).where(and(eq(policyTemplates.templateKey, input.templateKey), sql`(${policyTemplates.orgRef} IS NULL OR ${policyTemplates.orgRef} = ${orgRef ?? ""})`)).limit(1);
        if (!template) return notFound(`Template ${input.templateKey}`);
      }
      const moduleKey = template?.moduleKey ?? input.moduleKey;
      const module = moduleKey ? moduleByKey(moduleKey) : undefined;
      if (!module) return bad("A policy needs a module (from its template or moduleKey)");
      const documentKind = template?.documentKind ?? input.documentKind;
      if (!documentKind) return bad("A policy needs a document kind (from its template or documentKind)");
      const title = input.title ?? template?.title;
      if (!title) return bad("A policy needs a title");
      const scopeKey = scopeKeyOf(orgRef);
      const program = await activeProgram(db, orgRef);
      // Sequence per (scope, prefix, kind): the next number after the highest already minted. Unique index refuses a race.
      const prefix = `${module.codePrefix}-${policyCode(module.codePrefix, documentKind, 1).split("-")[1]}-`;
      const [last] = await db.select({ policyCode: companyPolicies.policyCode }).from(companyPolicies).where(and(eq(companyPolicies.scopeKey, scopeKey), sql`${companyPolicies.policyCode} LIKE ${prefix + "%"}`)).orderBy(sql`LENGTH(${companyPolicies.policyCode}) DESC`, desc(companyPolicies.policyCode)).limit(1);
      const seq = last ? Number(last.policyCode.slice(prefix.length)) + 1 : 1;
      const code = policyCode(module.codePrefix, documentKind, seq);
      const policyRef = ref("POL");
      await db.insert(companyPolicies).values({
        policyRef, orgRef, scopeKey, programRef: program?.programRef ?? null, policyCode: code, templateKey: template?.templateKey ?? null, templateVersion: template?.templateVersion ?? null,
        moduleKey: module.moduleKey, packKey: input.packKey ?? template?.packKey ?? "company", documentKind, title, appliesTo: input.appliesTo, ownerRole: input.ownerRole ?? template?.defaultOwnerRole ?? "safety",
        ownerUserId: input.ownerUserId ?? null, approverRole: input.approverRole, status: "draft", acknowledgementRequired: input.acknowledgementRequired ?? template?.acknowledgementRequired ?? true,
        reviewIntervalMonths: input.reviewIntervalMonths ?? template?.reviewIntervalMonths ?? 12, createdByUserId: ctx.user.id,
      });
      if (template) for (const k of json<string[]>(template.regulatoryReferenceKeysJson, [])) {
        await db.insert(policyRegulatoryLinks).values({ subjectType: "policy", subjectRef: policyRef, referenceKey: k, linkedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { referenceKey: k } });
      }
      await audit(db, orgRef, ctx.user.id, "policy", policyRef, "policy.created", { policyCode: code, templateKey: template?.templateKey ?? null, moduleKey: module.moduleKey, documentKind, title });
      return { policyRef, policyCode: code, templateKey: template?.templateKey ?? null, sections: template ? json<Section[]>(template.sectionsJson, []) : [] };
    }),

  policyList: roleProcedure("safetyProgram.policyList").input(z.object({ moduleKey: z.string().max(60).optional(), status: z.enum(["draft", "active", "retired"]).optional() }).default({})).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const where = [eq(companyPolicies.scopeKey, scopeKeyOf(orgRef))];
    if (input.moduleKey) where.push(eq(companyPolicies.moduleKey, input.moduleKey));
    if (input.status) where.push(eq(companyPolicies.status, input.status));
    const rows = await db.select().from(companyPolicies).where(and(...where)).orderBy(companyPolicies.policyCode);
    const now = Date.now();
    return rows.map(p => ({ policyRef: p.policyRef, policyCode: p.policyCode, title: p.title, moduleKey: p.moduleKey, packKey: p.packKey, documentKind: p.documentKind, status: p.status, ownerRole: p.ownerRole, hasApprovedVersion: p.currentVersionId != null, acknowledgementRequired: p.acknowledgementRequired, nextReviewDueAt: p.nextReviewDueAt, reviewOverdue: !!p.nextReviewDueAt && p.nextReviewDueAt.getTime() < now && p.status === "active" }));
  }),

  policyDetail: roleProcedure("safetyProgram.policyDetail").input(z.object({ policyRef: z.string().min(3).max(64) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const p = await policyInScope(db, input.policyRef, orgRef);
    const versions = await db.select().from(policyVersions).where(eq(policyVersions.companyPolicyId, p.id)).orderBy(policyVersions.versionNumber);
    const links = await db.select({ referenceKey: policyRegulatoryLinks.referenceKey }).from(policyRegulatoryLinks).where(and(eq(policyRegulatoryLinks.subjectType, "policy"), eq(policyRegulatoryLinks.subjectRef, p.policyRef)));
    const refs = links.length ? await db.select().from(regulatoryReferences).where(inArray(regulatoryReferences.referenceKey, links.map(l => l.referenceKey))) : [];
    const overlays = await db.select().from(clientPolicyOverlays).where(and(eq(clientPolicyOverlays.companyPolicyId, p.id), eq(clientPolicyOverlays.status, "active")));
    const reviews = await db.select().from(policyReviews).where(eq(policyReviews.companyPolicyId, p.id)).orderBy(desc(policyReviews.scheduledFor));
    const [ackCounts] = await db.select({ signed: sql<number>`SUM(CASE WHEN ${policyAcknowledgements.signedAt} IS NOT NULL THEN 1 ELSE 0 END)`, started: sql<number>`COUNT(*)` }).from(policyAcknowledgements).where(and(eq(policyAcknowledgements.companyPolicyId, p.id), p.currentVersionId ? eq(policyAcknowledgements.policyVersionId, p.currentVersionId) : sql`1=0`));
    return {
      policy: p,
      versions: versions.map(v => ({ ...v, sections: json<Section[]>(v.sectionsJson, []) })),
      references: refs, overlays: overlays.map(o => ({ ...o, requirements: json<unknown>(o.requirementsJson, []) })), reviews,
      acknowledgements: { signed: Number(ackCounts?.signed ?? 0), started: Number(ackCounts?.started ?? 0) },
    };
  }),

  versionDraft: roleProcedure("safetyProgram.versionDraft")
    .input(z.object({ policyRef: z.string().min(3).max(64), title: z.string().min(3).max(220).optional(), sections: z.array(SECTION).min(1).max(60), bodyMarkdown: z.string().max(200_000).default(""), changeSummary: z.string().max(500).optional(), clientOverlayRefs: z.array(z.string().max(64)).max(20).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const p = await policyInScope(db, input.policyRef, orgRef);
      if (p.status === "retired") return refuse("A retired policy takes no new versions");
      await requireOverlaysInScope(db, input.clientOverlayRefs ?? [], orgRef);
      const [openDraft] = await db.select({ versionRef: policyVersions.versionRef }).from(policyVersions).where(and(eq(policyVersions.companyPolicyId, p.id), eq(policyVersions.state, "draft"))).limit(1);
      if (openDraft) return bad(`A draft (${openDraft.versionRef}) is already open; edit it or withdraw it`);
      const [last] = await db.select({ versionNumber: policyVersions.versionNumber, versionHash: policyVersions.versionHash, id: policyVersions.id }).from(policyVersions).where(eq(policyVersions.companyPolicyId, p.id)).orderBy(desc(policyVersions.versionNumber)).limit(1);
      const versionNumber = (last?.versionNumber ?? 0) + 1;
      const title = input.title ?? p.title;
      const cHash = contentHash(title, input.sections, input.bodyMarkdown);
      const vHash = versionHash({ policyRef: p.policyRef, versionNumber, contentHash: cHash, previousVersionHash: last?.versionHash ?? null });
      const versionRef = ref("PV");
      const now = new Date();
      await db.insert(policyVersions).values({
        versionRef, companyPolicyId: p.id, versionNumber, versionLabel: versionLabel(versionNumber), state: "draft", title, sectionsJson: JSON.stringify(input.sections), bodyMarkdown: input.bodyMarkdown,
        contentHash: cHash, changeSummary: input.changeSummary ?? null, clientOverlayRefsJson: input.clientOverlayRefs ? JSON.stringify(input.clientOverlayRefs) : null,
        preparedByUserId: ctx.user.id, preparedAt: now, supersedesVersionId: p.currentVersionId ?? null, previousVersionHash: last?.versionHash ?? null, versionHash: vHash,
      });
      await audit(db, orgRef, ctx.user.id, "policyVersion", versionRef, "version.drafted", { policyRef: p.policyRef, versionNumber, contentHash: cHash, versionHash: vHash });
      return { versionRef, versionNumber, versionLabel: versionLabel(versionNumber), contentHash: cHash, versionHash: vHash };
    }),

  /**
   * The first draft, rendered from the policy's template: merge fields are filled from the program
   * (company name, officers) and the policy (code, version, effective date); anything left unfilled is
   * named in the response and stays visible in the text. A template still at skeleton drafts as headings.
   */
  versionDraftFromTemplate: roleProcedure("safetyProgram.versionDraftFromTemplate")
    .input(z.object({ policyRef: z.string().min(3).max(64), president: z.string().max(160).optional(), safetyManager: z.string().max(160).optional(), companyName: z.string().max(220).optional(), effectiveFrom: z.coerce.date().optional(), changeSummary: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const p = await policyInScope(db, input.policyRef, orgRef);
      if (!p.templateKey) return bad("This policy was not created from a template; draft its version with versionDraft");
      if (p.status === "retired") return refuse("A retired policy takes no new versions");
      const [t] = await db.select().from(policyTemplates).where(eq(policyTemplates.templateKey, p.templateKey)).limit(1);
      if (!t) return notFound(`Template ${p.templateKey}`);
      const [openDraft] = await db.select({ versionRef: policyVersions.versionRef }).from(policyVersions).where(and(eq(policyVersions.companyPolicyId, p.id), eq(policyVersions.state, "draft"))).limit(1);
      if (openDraft) return bad(`A draft (${openDraft.versionRef}) is already open; edit it or withdraw it`);
      const [last] = await db.select({ versionNumber: policyVersions.versionNumber, versionHash: policyVersions.versionHash }).from(policyVersions).where(eq(policyVersions.companyPolicyId, p.id)).orderBy(desc(policyVersions.versionNumber)).limit(1);
      const versionNumber = (last?.versionNumber ?? 0) + 1;
      const program = await activeProgram(db, orgRef);
      let companyName = input.companyName ?? program?.name ?? null;
      if (!input.companyName && program?.financialEntityId) {
        const [fe] = await db.select({ legalName: financialEntities.legalName }).from(financialEntities).where(eq(financialEntities.id, program.financialEntityId)).limit(1);
        if (fe) companyName = fe.legalName;
      }
      const effectiveFrom = input.effectiveFrom ?? new Date();
      const rendered = renderMergeFields(json<Section[]>(t.sectionsJson, []), {
        "company.name": companyName ?? undefined, "company.president": input.president, "company.safetyManager": input.safetyManager,
        "policy.code": p.policyCode, "policy.version": versionLabel(versionNumber), "policy.effectiveFrom": effectiveFrom.toISOString().slice(0, 10),
      });
      const cHash = contentHash(p.title, rendered.sections, "");
      const vHash = versionHash({ policyRef: p.policyRef, versionNumber, contentHash: cHash, previousVersionHash: last?.versionHash ?? null });
      const versionRef = ref("PV");
      await db.insert(policyVersions).values({
        versionRef, companyPolicyId: p.id, versionNumber, versionLabel: versionLabel(versionNumber), state: "draft", title: p.title, sectionsJson: JSON.stringify(rendered.sections), bodyMarkdown: "",
        contentHash: cHash, changeSummary: input.changeSummary ?? `Drafted from template ${t.templateKey} v${t.templateVersion} (${t.contentStatus})`, preparedByUserId: ctx.user.id, preparedAt: new Date(),
        supersedesVersionId: p.currentVersionId ?? null, previousVersionHash: last?.versionHash ?? null, versionHash: vHash,
      });
      await db.update(companyPolicies).set({ templateVersion: t.templateVersion }).where(eq(companyPolicies.id, p.id));
      await audit(db, orgRef, ctx.user.id, "policyVersion", versionRef, "version.drafted_from_template", { policyRef: p.policyRef, templateKey: t.templateKey, templateVersion: t.templateVersion, templateContentStatus: t.contentStatus, unresolved: rendered.unresolved, contentHash: cHash, versionHash: vHash });
      return { versionRef, versionNumber, versionLabel: versionLabel(versionNumber), templateKey: t.templateKey, templateVersion: t.templateVersion, templateContentStatus: t.contentStatus, sections: rendered.sections, unresolvedMergeFields: rendered.unresolved, contentHash: cHash, versionHash: vHash };
    }),

  versionEdit: roleProcedure("safetyProgram.versionEdit")
    .input(z.object({ versionRef: z.string().min(3).max(64), title: z.string().min(3).max(220).optional(), sections: z.array(SECTION).min(1).max(60), bodyMarkdown: z.string().max(200_000).default(""), changeSummary: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const [v] = await db.select().from(policyVersions).where(eq(policyVersions.versionRef, input.versionRef)).limit(1);
      if (!v) return notFound("Policy version");
      const p = (await db.select().from(companyPolicies).where(and(eq(companyPolicies.id, v.companyPolicyId), scopeWhere(companyPolicies.orgRef, orgRef))).limit(1))[0] ?? notFound("Policy version");
      const d = editDecision(v.state);
      if (!d.allowed) return refuse(d.reason);
      const title = input.title ?? v.title;
      const cHash = contentHash(title, input.sections, input.bodyMarkdown);
      const vHash = versionHash({ policyRef: p.policyRef, versionNumber: v.versionNumber, contentHash: cHash, previousVersionHash: v.previousVersionHash });
      await db.update(policyVersions).set({ title, sectionsJson: JSON.stringify(input.sections), bodyMarkdown: input.bodyMarkdown, contentHash: cHash, versionHash: vHash, changeSummary: input.changeSummary ?? v.changeSummary }).where(eq(policyVersions.id, v.id));
      await audit(db, orgRef, ctx.user.id, "policyVersion", v.versionRef, "version.edited", { contentHash: cHash, versionHash: vHash });
      return { versionRef: v.versionRef, contentHash: cHash, versionHash: vHash };
    }),

  /** Approval makes the version current and effective; the prior current version is superseded, never touched. */
  versionApprove: roleProcedure("safetyProgram.versionApprove")
    .input(z.object({ versionRef: z.string().min(3).max(64), effectiveFrom: z.coerce.date().optional(), approvalNote: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const [v] = await db.select().from(policyVersions).where(eq(policyVersions.versionRef, input.versionRef)).limit(1);
      if (!v) return notFound("Policy version");
      const p = (await db.select().from(companyPolicies).where(and(eq(companyPolicies.id, v.companyPolicyId), scopeWhere(companyPolicies.orgRef, orgRef))).limit(1))[0] ?? notFound("Policy version");
      const roles = ((ctx as { roles?: readonly string[] }).roles ?? []) as readonly string[];
      const d = approvalDecision({ state: v.state, preparedByUserId: v.preparedByUserId, approverUserId: ctx.user.id, approverRoles: roles, requiredApproverRole: p.approverRole });
      if (!d.allowed) return refuse(d.reason);
      const now = new Date();
      const effectiveFrom = input.effectiveFrom ?? now;
      await db.update(policyVersions).set({ state: "approved", approvedByUserId: ctx.user.id, approvedAt: now, approvalNote: input.approvalNote ?? null, effectiveFrom }).where(eq(policyVersions.id, v.id));
      if (p.currentVersionId) await db.update(policyVersions).set({ state: "superseded", supersededAt: now, supersededByVersionId: v.id }).where(and(eq(policyVersions.id, p.currentVersionId), eq(policyVersions.state, "approved")));
      const nextReviewDueAt = nextReviewDue(effectiveFrom, p.reviewIntervalMonths);
      await db.update(companyPolicies).set({ currentVersionId: v.id, status: "active", nextReviewDueAt }).where(eq(companyPolicies.id, p.id));
      await audit(db, orgRef, ctx.user.id, "policyVersion", v.versionRef, "version.approved", { policyRef: p.policyRef, versionNumber: v.versionNumber, versionHash: v.versionHash, preparedByUserId: v.preparedByUserId, supersededVersionId: p.currentVersionId ?? null, effectiveFrom, nextReviewDueAt });
      return { versionRef: v.versionRef, versionLabel: v.versionLabel, effectiveFrom, supersededVersionId: p.currentVersionId ?? null, nextReviewDueAt, acknowledgementRequired: p.acknowledgementRequired };
    }),

  versionWithdraw: roleProcedure("safetyProgram.versionWithdraw")
    .input(z.object({ versionRef: z.string().min(3).max(64), reason: z.string().min(3).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const [v] = await db.select().from(policyVersions).where(eq(policyVersions.versionRef, input.versionRef)).limit(1);
      if (!v) return notFound("Policy version");
      const p = (await db.select().from(companyPolicies).where(and(eq(companyPolicies.id, v.companyPolicyId), scopeWhere(companyPolicies.orgRef, orgRef))).limit(1))[0] ?? notFound("Policy version");
      if (v.state !== "draft" && v.state !== "approved") return refuse(`A ${v.state} version cannot be withdrawn`);
      const now = new Date();
      await db.update(policyVersions).set({ state: "withdrawn", withdrawnAt: now, withdrawnByUserId: ctx.user.id, withdrawalReason: input.reason }).where(eq(policyVersions.id, v.id));
      // Withdrawing the current version leaves the policy with no effective version: it goes back to draft, and says so.
      if (p.currentVersionId === v.id) await db.update(companyPolicies).set({ currentVersionId: null, status: "draft", nextReviewDueAt: null }).where(eq(companyPolicies.id, p.id));
      await audit(db, orgRef, ctx.user.id, "policyVersion", v.versionRef, "version.withdrawn", { policyRef: p.policyRef, reason: input.reason, wasCurrent: p.currentVersionId === v.id });
      return { versionRef: v.versionRef, policyStatus: p.currentVersionId === v.id ? "draft" : p.status };
    }),

  policyRetire: roleProcedure("safetyProgram.policyRetire").input(z.object({ policyRef: z.string().min(3).max(64), reason: z.string().min(3).max(400) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const p = await policyInScope(db, input.policyRef, orgRef);
    if (p.status === "retired") return bad("Already retired");
    await db.update(companyPolicies).set({ status: "retired", retiredAt: new Date(), retiredByUserId: ctx.user.id }).where(eq(companyPolicies.id, p.id));
    await audit(db, orgRef, ctx.user.id, "policy", p.policyRef, "policy.retired", { reason: input.reason });
    return { policyRef: p.policyRef, status: "retired" as const };
  }),

  /* ---------------- acknowledgements (self-scoped) ---------------- */

  myPolicies: roleProcedure("safetyProgram.myPolicies").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const policies = await db.select().from(companyPolicies).where(and(eq(companyPolicies.scopeKey, scopeKeyOf(orgRef)), eq(companyPolicies.status, "active"), eq(companyPolicies.acknowledgementRequired, true)));
    const ids = policies.map(p => p.currentVersionId).filter((x): x is number => x != null);
    const acks = ids.length ? await db.select().from(policyAcknowledgements).where(and(eq(policyAcknowledgements.userId, ctx.user.id), inArray(policyAcknowledgements.policyVersionId, ids))) : [];
    return policies.filter(p => p.currentVersionId != null).map(p => {
      const a = acks.find(x => x.policyVersionId === p.currentVersionId);
      const step = !a ? "read" : !a.readAt ? "read" : !a.understoodAt ? "understood" : !a.questionsAnsweredAt ? "questions" : !a.signedAt ? "sign" : "done";
      return { policyRef: p.policyRef, policyCode: p.policyCode, title: p.title, moduleKey: p.moduleKey, currentVersionId: p.currentVersionId, nextStep: step, signedAt: a?.signedAt ?? null, acknowledgementRef: a?.acknowledgementRef ?? null };
    });
  }),

  /** Read → Understand → Questions answered → Sign, one step per call, always for the caller, always against the current version. */
  acknowledge: roleProcedure("safetyProgram.acknowledge")
    .input(z.object({ policyRef: z.string().min(3).max(64), step: z.enum(["read", "understood", "questions", "sign"]), questionsNote: z.string().max(500).optional(), method: z.enum(["in_app", "signed_document", "training_session"]).default("in_app"), deviceRef: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const p = await policyInScope(db, input.policyRef, orgRef);
      if (!p.currentVersionId || p.status !== "active") return refuse("This policy has no current approved version to acknowledge");
      const v = await versionById(db, p.currentVersionId);
      const [existing] = await db.select().from(policyAcknowledgements).where(and(eq(policyAcknowledgements.policyVersionId, v.id), eq(policyAcknowledgements.userId, ctx.user.id))).limit(1);
      const progress = { readAt: existing?.readAt ?? null, understoodAt: existing?.understoodAt ?? null, questionsAnsweredAt: existing?.questionsAnsweredAt ?? null, signedAt: existing?.signedAt ?? null };
      const d = acknowledgementDecision({ versionState: v.state, progress, step: input.step });
      if (!d.allowed) return refuse(d.reason);
      const now = new Date();
      let acknowledgementRef = existing?.acknowledgementRef;
      if (!existing) {
        acknowledgementRef = ref("ACK");
        await db.insert(policyAcknowledgements).values({ acknowledgementRef, orgRef, companyPolicyId: p.id, policyVersionId: v.id, userId: ctx.user.id, versionHash: v.versionHash, contentHash: v.contentHash, method: input.method, deviceRef: input.deviceRef ?? null });
      }
      const set: Partial<typeof policyAcknowledgements.$inferInsert> = {};
      if (input.step === "read") set.readAt = now;
      if (input.step === "understood") set.understoodAt = now;
      if (input.step === "questions") { set.questionsAnsweredAt = now; set.questionsNote = input.questionsNote ?? null; }
      if (input.step === "sign") { set.signedAt = now; set.method = input.method; set.signatureHash = signatureHash({ userId: ctx.user.id, versionHash: v.versionHash, signedAt: now, method: input.method }); }
      await db.update(policyAcknowledgements).set(set).where(eq(policyAcknowledgements.acknowledgementRef, acknowledgementRef!));
      await audit(db, orgRef, ctx.user.id, "acknowledgement", acknowledgementRef!, `acknowledgement.${input.step}`, { policyRef: p.policyRef, versionRef: v.versionRef, versionHash: v.versionHash, signatureHash: set.signatureHash ?? null });
      return { acknowledgementRef: acknowledgementRef!, step: input.step, at: now, versionRef: v.versionRef, versionHash: v.versionHash, signatureHash: set.signatureHash ?? null };
    }),

  acknowledgementStatus: roleProcedure("safetyProgram.acknowledgementStatus").input(z.object({ policyRef: z.string().min(3).max(64) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const p = await policyInScope(db, input.policyRef, orgRef);
    if (!p.currentVersionId) return { policyRef: p.policyRef, currentVersionId: null, workforce: 0, signed: [], outstanding: [] as { userId: number; positionCode: string; step: string }[] };
    const people = await workforce(db, orgRef);
    const acks = await db.select().from(policyAcknowledgements).where(eq(policyAcknowledgements.policyVersionId, p.currentVersionId));
    const signed = acks.filter(a => a.signedAt).map(a => ({ userId: a.userId, signedAt: a.signedAt!, method: a.method, signatureHash: a.signatureHash }));
    const signedIds = new Set(signed.map(s => s.userId));
    const outstanding = people.filter(w => !signedIds.has(w.userId)).map(w => { const a = acks.find(x => x.userId === w.userId); return { userId: w.userId, positionCode: w.positionCode, step: !a?.readAt ? "read" : !a.understoodAt ? "understood" : !a.questionsAnsweredAt ? "questions" : "sign" }; });
    return { policyRef: p.policyRef, currentVersionId: p.currentVersionId, workforce: people.length, signed, outstanding };
  }),

  /* ---------------- client overlays ---------------- */

  overlaySet: roleProcedure("safetyProgram.overlaySet")
    .input(z.object({
      overlayRef: z.string().max(64).optional(), clientName: z.string().min(2).max(220), clientOrgRef: z.string().max(64).nullable().optional(), customerAccountId: z.number().int().positive().nullable().optional(),
      moduleKey: z.string().max(60).nullable().optional(), policyRef: z.string().max(64).nullable().optional(), title: z.string().min(2).max(220), requirements: z.array(z.object({ requirement: z.string().min(2).max(500), basis: z.string().max(300).optional() })).min(1).max(100),
      sourceDescription: z.string().max(400).optional(), sourceEvidenceRecordId: z.number().int().positive().nullable().optional(), effectiveFrom: z.coerce.date().optional(), effectiveTo: z.coerce.date().nullable().optional(), status: z.enum(["draft", "active", "retired"]).default("active"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const policy = input.policyRef ? await policyInScope(db, input.policyRef, orgRef) : null;
      if (input.customerAccountId != null) await requireCustomerAccountInScope(db, input.customerAccountId, orgRef);
      if (input.sourceEvidenceRecordId != null) await requireEvidenceInScope(input.sourceEvidenceRecordId, orgRef);
      // clientOrgRef names the counterparty by reference only: nothing here reads or writes through it.
      const values = {
        clientName: input.clientName, clientOrgRef: input.clientOrgRef ?? null, customerAccountId: input.customerAccountId ?? null, moduleKey: input.moduleKey ?? policy?.moduleKey ?? null, companyPolicyId: policy?.id ?? null,
        title: input.title, requirementsJson: JSON.stringify(input.requirements), sourceDescription: input.sourceDescription ?? null, sourceEvidenceRecordId: input.sourceEvidenceRecordId ?? null,
        status: input.status, effectiveFrom: input.effectiveFrom ?? new Date(), effectiveTo: input.effectiveTo ?? null,
      };
      let overlayRef = input.overlayRef;
      if (overlayRef) {
        const [existing] = await db.select({ id: clientPolicyOverlays.id }).from(clientPolicyOverlays).where(and(eq(clientPolicyOverlays.overlayRef, overlayRef), scopeWhere(clientPolicyOverlays.orgRef, orgRef))).limit(1);
        if (!existing) return notFound(`Overlay ${overlayRef}`);
        await db.update(clientPolicyOverlays).set(values).where(eq(clientPolicyOverlays.id, existing.id));
      } else {
        overlayRef = ref("OVL");
        await db.insert(clientPolicyOverlays).values({ overlayRef, orgRef, recordedByUserId: ctx.user.id, ...values });
      }
      await audit(db, orgRef, ctx.user.id, "overlay", overlayRef, input.overlayRef ? "overlay.updated" : "overlay.created", { clientName: input.clientName, policyRef: policy?.policyRef ?? null, requirements: input.requirements.length, status: input.status });
      return { overlayRef };
    }),

  overlayList: roleProcedure("safetyProgram.overlayList").input(z.object({ clientName: z.string().max(220).optional() }).default({})).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const where = [scopeWhere(clientPolicyOverlays.orgRef, orgRef)];
    if (input.clientName) where.push(eq(clientPolicyOverlays.clientName, input.clientName));
    const rows = await db.select().from(clientPolicyOverlays).where(and(...where)).orderBy(clientPolicyOverlays.clientName, clientPolicyOverlays.title);
    return rows.map(o => ({ ...o, requirements: json<unknown[]>(o.requirementsJson, []) }));
  }),

  /* ---------------- reviews ---------------- */

  reviewSchedule: roleProcedure("safetyProgram.reviewSchedule")
    .input(z.object({ policyRef: z.string().min(3).max(64), reviewType: z.enum(["scheduled", "triggered", "post_incident", "regulatory_change", "client_requirement", "audit_finding"]).default("scheduled"), scheduledFor: z.coerce.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const p = await policyInScope(db, input.policyRef, orgRef);
      const reviewRef = ref("PRV");
      const scheduledFor = input.scheduledFor ?? p.nextReviewDueAt ?? new Date();
      await db.insert(policyReviews).values({ reviewRef, orgRef, companyPolicyId: p.id, policyVersionId: p.currentVersionId ?? null, reviewType: input.reviewType, scheduledFor, scheduledByUserId: ctx.user.id });
      await audit(db, orgRef, ctx.user.id, "review", reviewRef, "review.scheduled", { policyRef: p.policyRef, reviewType: input.reviewType, scheduledFor });
      return { reviewRef, scheduledFor };
    }),

  reviewComplete: roleProcedure("safetyProgram.reviewComplete")
    .input(z.object({ reviewRef: z.string().min(3).max(64), outcome: z.enum(["no_change", "revision_required", "retire"]), findings: z.string().max(5000).optional(), nextReviewDueAt: z.coerce.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const [r] = await db.select().from(policyReviews).where(and(eq(policyReviews.reviewRef, input.reviewRef), scopeWhere(policyReviews.orgRef, orgRef))).limit(1);
      if (!r) return notFound(`Review ${input.reviewRef}`);
      const d = reviewCompletionDecision(r, input.outcome);
      if (!d.allowed) return refuse(d.reason);
      const [p] = await db.select().from(companyPolicies).where(eq(companyPolicies.id, r.companyPolicyId)).limit(1);
      const now = new Date();
      const nextReviewDueAt = input.outcome === "retire" ? null : input.nextReviewDueAt ?? nextReviewDue(now, p?.reviewIntervalMonths ?? 12);
      await db.update(policyReviews).set({ status: "completed", completedAt: now, reviewedByUserId: ctx.user.id, outcome: input.outcome, findings: input.findings ?? null, nextReviewDueAt }).where(eq(policyReviews.id, r.id));
      if (p) await db.update(companyPolicies).set(input.outcome === "retire" ? { status: "retired", retiredAt: now, retiredByUserId: ctx.user.id, nextReviewDueAt: null } : { nextReviewDueAt }).where(eq(companyPolicies.id, p.id));
      let correctiveActionRef: string | null = null;
      if (input.outcome === "revision_required" && p) {
        // A revision that nobody owns does not happen. The action is assigned to the policy owner, or the reviewer.
        correctiveActionRef = ref("CA");
        await db.insert(correctiveActions).values({ actionRef: correctiveActionRef, orgRef, sourceType: "policy_review", sourceRef: r.reviewRef, title: `Revise ${p.policyCode} ${p.title}`, description: input.findings ?? "Review found revision required", priority: "medium", assignedToUserId: p.ownerUserId ?? ctx.user.id, dueAt: new Date(now.getTime() + 30 * DAY), openedByUserId: ctx.user.id });
      }
      await audit(db, orgRef, ctx.user.id, "review", r.reviewRef, "review.completed", { policyRef: p?.policyRef ?? null, outcome: input.outcome, nextReviewDueAt, correctiveActionRef });
      return { reviewRef: r.reviewRef, outcome: input.outcome, nextReviewDueAt, correctiveActionRef };
    }),

  /* ---------------- regulatory references ---------------- */

  referenceList: roleProcedure("safetyProgram.referenceList").input(z.object({ jurisdiction: z.string().max(40).optional() }).default({})).query(async ({ input }) => {
    const db = await dbOrThrow();
    return db.select().from(regulatoryReferences).where(input.jurisdiction ? eq(regulatoryReferences.jurisdiction, input.jurisdiction) : sql`1=1`).orderBy(regulatoryReferences.jurisdiction, regulatoryReferences.referenceKey);
  }),

  referenceUpsert: roleProcedure("safetyProgram.referenceUpsert")
    .input(z.object({ referenceKey: z.string().min(3).max(120).regex(/^[a-z0-9_.]+$/), jurisdiction: z.string().min(2).max(40), authority: z.string().min(2).max(160), instrument: z.string().min(2).max(220), provision: z.string().max(160).nullable().optional(), title: z.string().min(3).max(240), url: z.string().url().max(500).nullable().optional(), summary: z.string().max(5000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      requirePlatformScope(await orgOf(db, ctx.user.id), "recorded");
      const [existing] = await db.select({ id: regulatoryReferences.id, verificationStatus: regulatoryReferences.verificationStatus }).from(regulatoryReferences).where(eq(regulatoryReferences.referenceKey, input.referenceKey)).limit(1);
      const values = { jurisdiction: input.jurisdiction, authority: input.authority, instrument: input.instrument, provision: input.provision ?? null, title: input.title, url: input.url ?? null, summary: input.summary ?? null };
      if (existing) {
        // Editing the citation of a verified reference un-verifies it: what was verified is no longer what is written.
        await db.update(regulatoryReferences).set({ ...values, verificationStatus: "unverified", verifiedByUserId: null, verifiedAt: null, verificationNote: null, recordedByUserId: ctx.user.id }).where(eq(regulatoryReferences.id, existing.id));
      } else {
        await db.insert(regulatoryReferences).values({ referenceKey: input.referenceKey, ...values, verificationStatus: "unverified", recordedByUserId: ctx.user.id });
      }
      await audit(db, null, ctx.user.id, "reference", input.referenceKey, existing ? "reference.updated" : "reference.recorded", { wasVerified: existing?.verificationStatus === "verified" });
      return { referenceKey: input.referenceKey, verificationStatus: "unverified" as const };
    }),

  referenceVerify: roleProcedure("safetyProgram.referenceVerify")
    .input(z.object({ referenceKey: z.string().min(3).max(120), verificationNote: z.string().min(3).max(400), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), status: z.enum(["verified", "superseded"]).default("verified") }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      requirePlatformScope(await orgOf(db, ctx.user.id), "verified");
      const [r] = await db.select().from(regulatoryReferences).where(eq(regulatoryReferences.referenceKey, input.referenceKey)).limit(1);
      if (!r) return notFound(`Reference ${input.referenceKey}`);
      if (r.recordedByUserId === ctx.user.id) return refuse("The person who recorded a reference cannot verify it");
      await db.update(regulatoryReferences).set({ verificationStatus: input.status, verifiedByUserId: ctx.user.id, verifiedAt: new Date(), verificationNote: input.verificationNote, sourceSnapshotHash: input.sourceSnapshotHash ?? null }).where(eq(regulatoryReferences.id, r.id));
      await audit(db, null, ctx.user.id, "reference", r.referenceKey, `reference.${input.status}`, { note: input.verificationNote, sourceSnapshotHash: input.sourceSnapshotHash ?? null });
      return { referenceKey: r.referenceKey, verificationStatus: input.status };
    }),

  /* ---------------- training requirements and matrix ---------------- */

  trainingRequirementList: roleProcedure("safetyProgram.trainingRequirementList").input(z.object({ positionCode: z.string().max(60).optional() }).default({})).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const where = [inArray(trainingRequirements.scopeKey, [scopeKeyOf(orgRef), "platform"]), eq(trainingRequirements.active, true)];
    if (input.positionCode) where.push(eq(trainingRequirements.positionCode, input.positionCode));
    return db.select().from(trainingRequirements).where(and(...where)).orderBy(trainingRequirements.positionCode, trainingRequirements.title);
  }),

  trainingRequirementUpsert: roleProcedure("safetyProgram.trainingRequirementUpsert")
    .input(z.object({
      requirementRef: z.string().max(64).optional(), positionCode: z.string().min(2).max(60), requirementKind: z.enum(["external_certificate", "company_training", "client_orientation", "policy_acknowledgement", "equipment_competency"]),
      qualificationCode: z.string().max(100).nullable().optional(), policyRef: z.string().max(64).nullable().optional(), title: z.string().min(2).max(220), source: z.enum(["pack", "company", "client_overlay"]).default("company"),
      packKey: z.string().max(60).nullable().optional(), overlayRef: z.string().max(64).nullable().optional(), renewalMonths: z.number().int().min(1).max(120).nullable().optional(), warnDaysBeforeExpiry: z.number().int().min(0).max(365).default(60),
      enforcement: z.enum(["block", "review", "inform"]).default("block"), active: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      if (input.overlayRef) await requireOverlaysInScope(db, [input.overlayRef], orgRef);
      if (input.requirementKind === "policy_acknowledgement") { if (!input.policyRef) return bad("A policy-acknowledgement requirement names the policy"); await policyInScope(db, input.policyRef, orgRef); }
      else if (!input.qualificationCode) return bad("A certificate, training, orientation or competency requirement names the qualification code the Driver Wallet holds");
      const values = { positionCode: input.positionCode, requirementKind: input.requirementKind, qualificationCode: input.qualificationCode ?? null, policyRef: input.policyRef ?? null, title: input.title, source: input.source, packKey: input.packKey ?? null, overlayRef: input.overlayRef ?? null, renewalMonths: input.renewalMonths ?? null, warnDaysBeforeExpiry: input.warnDaysBeforeExpiry, enforcement: input.enforcement, active: input.active };
      let requirementRef = input.requirementRef;
      if (requirementRef) {
        const [existing] = await db.select({ id: trainingRequirements.id }).from(trainingRequirements).where(and(eq(trainingRequirements.requirementRef, requirementRef), eq(trainingRequirements.scopeKey, scopeKeyOf(orgRef)))).limit(1);
        if (!existing) return notFound(`Requirement ${requirementRef}`);
        await db.update(trainingRequirements).set(values).where(eq(trainingRequirements.id, existing.id));
      } else {
        requirementRef = ref("TRQ");
        await db.insert(trainingRequirements).values({ requirementRef, orgRef, scopeKey: scopeKeyOf(orgRef), createdByUserId: ctx.user.id, ...values });
      }
      await audit(db, orgRef, ctx.user.id, "trainingRequirement", requirementRef, input.requirementRef ? "requirement.updated" : "requirement.created", values);
      return { requirementRef };
    }),

  /** Position → requirement → evidence → status, stored as one computation so the picture on a date can be shown again. */
  trainingMatrixCompute: roleProcedure("safetyProgram.trainingMatrixCompute")
    .input(z.object({ workers: z.array(z.object({ userId: z.number().int().positive(), positionCode: z.string().min(2).max(60) })).max(500).optional() }).default({}))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      // Named workers must be the caller's own: an id from another organization is not found, and is never read.
      if (input.workers?.length) for (const w of input.workers) await requireUserInScope(w.userId, orgRef);
      const people = input.workers?.length ? input.workers : await workforce(db, orgRef);
      const reqRows = await db.select().from(trainingRequirements).where(and(inArray(trainingRequirements.scopeKey, [scopeKeyOf(orgRef), "platform"]), eq(trainingRequirements.active, true)));
      const requirements: MatrixRequirement[] = reqRows.map(r => ({ requirementRef: r.requirementRef, positionCode: r.positionCode, requirementKind: r.requirementKind, qualificationCode: r.qualificationCode, policyRef: r.policyRef, renewalMonths: r.renewalMonths, warnDaysBeforeExpiry: r.warnDaysBeforeExpiry, enforcement: r.enforcement, title: r.title }));
      const ids = people.map(w => w.userId);
      const now = new Date();
      const codes = Array.from(new Set(requirements.map(r => r.qualificationCode).filter((c): c is string => !!c)));
      const [holdings, acks] = await Promise.all([holdingsFor(db, orgRef, ids, codes, now), acknowledgementsFor(db, orgRef, ids)]);
      const workers: MatrixWorker[] = people.map(w => ({ userId: w.userId, positionCode: w.positionCode, holdings: holdings.get(w.userId) ?? [], acknowledgements: acks.get(w.userId) ?? [] }));
      const rows = trainingMatrixFor(requirements, workers, now);
      const computationRef = ref("TMX");
      await db.update(companyTrainingMatrix).set({ current: false }).where(and(scopeWhere(companyTrainingMatrix.orgRef, orgRef), eq(companyTrainingMatrix.current, true)));
      for (const r of rows) {
        await db.insert(companyTrainingMatrix).values({ matrixRef: ref("TMR"), orgRef, computationRef, userId: r.userId, positionCode: r.positionCode, requirementRef: r.requirementRef, requirementKind: r.requirementKind, status: r.status, expiresAt: r.expiresAt, evidenceKind: r.evidenceKind, evidenceRef: r.evidenceRef, detail: r.detail.slice(0, 400), current: true, computedAt: now, computedByUserId: ctx.user.id });
      }
      const summary = matrixSummary(rows);
      await audit(db, orgRef, ctx.user.id, "trainingMatrix", computationRef, "matrix.computed", { workers: people.length, requirements: requirements.length, ...summary, computationHash: sha256(rows.map(r => `${r.userId}:${r.requirementRef}:${r.status}`)) });
      return { computationRef, computedAt: now, workers: people.length, requirements: requirements.length, summary };
    }),

  trainingMatrix: roleProcedure("safetyProgram.trainingMatrix").input(z.object({ userId: z.number().int().positive().optional(), status: z.enum(["compliant", "expiring", "expired", "missing", "pending_verification"]).optional() }).default({})).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const where = [scopeWhere(companyTrainingMatrix.orgRef, orgRef), eq(companyTrainingMatrix.current, true)];
    if (input.userId) where.push(eq(companyTrainingMatrix.userId, input.userId));
    if (input.status) where.push(eq(companyTrainingMatrix.status, input.status));
    const rows = await db.select().from(companyTrainingMatrix).where(and(...where)).orderBy(companyTrainingMatrix.userId, companyTrainingMatrix.requirementRef);
    return { computationRef: rows[0]?.computationRef ?? null, computedAt: rows[0]?.computedAt ?? null, summary: matrixSummary(rows as never), rows };
  }),

  /* ---------------- corrective actions ---------------- */

  correctiveActionOpen: roleProcedure("safetyProgram.correctiveActionOpen")
    .input(z.object({ sourceType: z.enum(["policy_review", "inspection", "incident", "near_miss", "audit_finding", "cor_gap", "acknowledgement_gap", "training_gap", "observation", "client_requirement", "other"]), sourceRef: z.string().max(120).nullable().optional(), title: z.string().min(3).max(220), description: z.string().min(3).max(5000), rootCause: z.string().max(5000).nullable().optional(), priority: z.enum(["low", "medium", "high", "critical"]).default("medium"), assignedToUserId: z.number().int().positive(), dueAt: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      await requireUserInScope(input.assignedToUserId, orgRef);
      const actionRef = ref("CA");
      await db.insert(correctiveActions).values({ actionRef, orgRef, sourceType: input.sourceType, sourceRef: input.sourceRef ?? null, title: input.title, description: input.description, rootCause: input.rootCause ?? null, priority: input.priority, assignedToUserId: input.assignedToUserId, dueAt: input.dueAt, openedByUserId: ctx.user.id });
      await audit(db, orgRef, ctx.user.id, "correctiveAction", actionRef, "action.opened", { sourceType: input.sourceType, sourceRef: input.sourceRef ?? null, assignedToUserId: input.assignedToUserId, dueAt: input.dueAt, priority: input.priority });
      return { actionRef };
    }),

  correctiveActionProgress: roleProcedure("safetyProgram.correctiveActionProgress")
    .input(z.object({ actionRef: z.string().min(3).max(64), transition: z.enum(["start", "complete", "cancel"]), note: z.string().max(500).optional(), rootCause: z.string().max(5000).optional(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const [a] = await db.select().from(correctiveActions).where(and(eq(correctiveActions.actionRef, input.actionRef), scopeWhere(correctiveActions.orgRef, orgRef))).limit(1);
      if (!a) return notFound(`Corrective action ${input.actionRef}`);
      if (input.evidenceRecordId != null) await requireEvidenceInScope(input.evidenceRecordId, orgRef);
      const now = new Date();
      if (input.transition === "start") {
        if (a.status !== "open") return refuse(`A ${a.status} action cannot be started`);
        await db.update(correctiveActions).set({ status: "in_progress", rootCause: input.rootCause ?? a.rootCause }).where(eq(correctiveActions.id, a.id));
      } else if (input.transition === "complete") {
        const d = completionDecision(a); if (!d.allowed) return refuse(d.reason);
        if (!input.note) return bad("Completing an action records what was done");
        await db.update(correctiveActions).set({ status: "completed", completedAt: now, completedByUserId: ctx.user.id, completionNote: input.note, rootCause: input.rootCause ?? a.rootCause, evidenceRecordId: input.evidenceRecordId ?? a.evidenceRecordId }).where(eq(correctiveActions.id, a.id));
      } else {
        if (a.status === "verified" || a.status === "cancelled") return refuse(`A ${a.status} action cannot be cancelled`);
        if (!input.note) return bad("Cancelling an action records why");
        await db.update(correctiveActions).set({ status: "cancelled", cancelledAt: now, cancelledByUserId: ctx.user.id, cancellationReason: input.note }).where(eq(correctiveActions.id, a.id));
      }
      await audit(db, orgRef, ctx.user.id, "correctiveAction", a.actionRef, `action.${input.transition}`, { note: input.note ?? null, evidenceRecordId: input.evidenceRecordId ?? null });
      return { actionRef: a.actionRef, transition: input.transition, at: now };
    }),

  correctiveActionVerify: roleProcedure("safetyProgram.correctiveActionVerify")
    .input(z.object({ actionRef: z.string().min(3).max(64), verificationNote: z.string().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(db, ctx.user.id);
      const [a] = await db.select().from(correctiveActions).where(and(eq(correctiveActions.actionRef, input.actionRef), scopeWhere(correctiveActions.orgRef, orgRef))).limit(1);
      if (!a) return notFound(`Corrective action ${input.actionRef}`);
      const d = verificationDecision(a, ctx.user.id);
      if (!d.allowed) return refuse(d.reason);
      const now = new Date();
      await db.update(correctiveActions).set({ status: "verified", verifiedAt: now, verifiedByUserId: ctx.user.id, verificationNote: input.verificationNote }).where(eq(correctiveActions.id, a.id));
      await audit(db, orgRef, ctx.user.id, "correctiveAction", a.actionRef, "action.verified", { completedByUserId: a.completedByUserId, note: input.verificationNote });
      return { actionRef: a.actionRef, verifiedAt: now };
    }),

  correctiveActionList: roleProcedure("safetyProgram.correctiveActionList").input(z.object({ status: z.enum(["open", "in_progress", "completed", "verified", "cancelled"]).optional(), overdueOnly: z.boolean().default(false) }).default({ overdueOnly: false })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const where = [scopeWhere(correctiveActions.orgRef, orgRef)];
    if (input.status) where.push(eq(correctiveActions.status, input.status));
    const rows = await db.select().from(correctiveActions).where(and(...where)).orderBy(correctiveActions.dueAt);
    const now = new Date();
    return rows.map(a => ({ ...a, ...correctiveActionView(a, now) })).filter(a => !input.overdueOnly || a.overdue);
  }),

  /* ---------------- readiness and packaging ---------------- */

  corReadiness: roleProcedure("safetyProgram.corReadiness").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const now = new Date();
    const d90 = new Date(now.getTime() - 90 * DAY); const d365 = new Date(now.getTime() - 365 * DAY);
    const scope = tenantOf(orgRef);
    const policies = await db.select().from(companyPolicies).where(eq(companyPolicies.scopeKey, scopeKeyOf(orgRef)));
    const ackRequired = policies.filter(p => p.status === "active" && p.acknowledgementRequired && p.currentVersionId != null);
    const people = await workforce(db, orgRef);
    const signed = ackRequired.length ? await count(db, db.select({ n: sql`COUNT(*)` }).from(policyAcknowledgements).where(and(inArray(policyAcknowledgements.policyVersionId, ackRequired.map(p => p.currentVersionId!)), sql`${policyAcknowledgements.signedAt} IS NOT NULL`))) : 0;
    const matrix = await currentMatrixSummary(db, orgRef);
    const inspectionsN = await count(db, db.select({ n: sql`COUNT(*)` }).from(inspections).where(and(gte(inspections.observedAt, d90), ownershipScopeWhere("unit", inspections.unitId, scope))));
    const hazardN = await count(db, db.select({ n: sql`COUNT(*)` }).from(tailgateMeetings).where(and(gte(tailgateMeetings.startedAt, d90), jobScope(tailgateMeetings.jobId, orgRef))));
    const meetingsN = await count(db, db.select({ n: sql`COUNT(*)` }).from(safetyEvents).where(and(gte(safetyEvents.occurredAt, d90), inArray(safetyEvents.eventType, ["safety_meeting", "toolbox_talk"]), jobScope(safetyEvents.jobId, orgRef))));
    const drillsN = await count(db, db.select({ n: sql`COUNT(*)` }).from(safetyEvents).where(and(gte(safetyEvents.occurredAt, d365), eq(safetyEvents.eventType, "emergency_drill"), jobScope(safetyEvents.jobId, orgRef))));
    const incidentsReported = await count(db, db.select({ n: sql`COUNT(*)` }).from(incidentReports).where(and(gte(incidentReports.occurredAt, d365), jobScope(incidentReports.jobId, orgRef))));
    const nearMisses = await count(db, db.select({ n: sql`COUNT(*)` }).from(nearMissReports).where(and(gte(nearMissReports.occurredAt, d365), jobScope(nearMissReports.jobId, orgRef))));
    const investigated = await count(db, db.select({ n: sql`COUNT(DISTINCT ${incidentReports.id})` }).from(incidentReports).innerJoin(incidentActions, eq(incidentActions.incidentReportId, incidentReports.id)).where(and(gte(incidentReports.occurredAt, d365), jobScope(incidentReports.jobId, orgRef))));
    const actions = await db.select({ status: correctiveActions.status, dueAt: correctiveActions.dueAt, completedByUserId: correctiveActions.completedByUserId, completedAt: correctiveActions.completedAt }).from(correctiveActions).where(scopeWhere(correctiveActions.orgRef, orgRef));
    const reviewsOverdue = await count(db, db.select({ n: sql`COUNT(*)` }).from(policyReviews).where(and(scopeWhere(policyReviews.orgRef, orgRef), eq(policyReviews.status, "scheduled"), lt(policyReviews.scheduledFor, now))));
    const reviewsDone = await count(db, db.select({ n: sql`COUNT(*)` }).from(policyReviews).where(and(scopeWhere(policyReviews.orgRef, orgRef), eq(policyReviews.status, "completed"), gte(policyReviews.completedAt, d365))));
    const links = policies.length ? await db.select({ referenceKey: policyRegulatoryLinks.referenceKey }).from(policyRegulatoryLinks).where(and(eq(policyRegulatoryLinks.subjectType, "policy"), inArray(policyRegulatoryLinks.subjectRef, policies.map(p => p.policyRef)))) : [];
    const cited = Array.from(new Set(links.map(l => l.referenceKey)));
    const verified = cited.length ? await count(db, db.select({ n: sql`COUNT(*)` }).from(regulatoryReferences).where(and(inArray(regulatoryReferences.referenceKey, cited), eq(regulatoryReferences.verificationStatus, "verified")))) : 0;
    const readiness = corReadiness({
      now, policies: policies.map(p => ({ moduleKey: p.moduleKey, status: p.status, acknowledgementRequired: p.acknowledgementRequired, nextReviewDueAt: p.nextReviewDueAt, hasApprovedVersion: p.currentVersionId != null })),
      acknowledgement: { required: ackRequired.length * people.length, signed }, matrix,
      inspectionsLast90Days: inspectionsN, hazardAssessmentsLast90Days: hazardN, safetyMeetingsLast90Days: meetingsN,
      incidents: { reported: incidentsReported + nearMisses, investigated, openInvestigations: Math.max(0, incidentsReported - investigated) },
      correctiveActions: { open: actions.filter(a => a.status === "open" || a.status === "in_progress").length, overdue: actions.filter(a => correctiveActionView(a, now).overdue).length, completedUnverified: actions.filter(a => a.status === "completed").length },
      reviews: { overdue: reviewsOverdue, completedLast12Months: reviewsDone }, drillsLast12Months: drillsN, regulatoryReferences: { cited: cited.length, verified },
    });
    return { computedAt: now, ...readiness, evidenceSources: { hazardAssessments: "tailgateMeetings (last 90 days)", safetyMeetings: "safetyEvents eventType safety_meeting|toolbox_talk (last 90 days)", drills: "safetyEvents eventType emergency_drill (last 12 months)", inspections: "inspections.observedAt (last 90 days)", incidents: "incidentReports + nearMissReports (last 12 months); investigated = has an incidentActions row" } };
  }),

  /** The manifest for "Generate Vendor Compliance Package": what is on file, what is missing. The archive itself is not built here. */
  vendorPackageManifest: roleProcedure("safetyProgram.vendorPackageManifest").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    const now = new Date();
    const scope = tenantOf(orgRef);
    const program = await activeProgram(db, orgRef);
    const policies = await db.select().from(companyPolicies).where(and(eq(companyPolicies.scopeKey, scopeKeyOf(orgRef)), eq(companyPolicies.status, "active")));
    const approved = policies.filter(p => p.currentVersionId != null);
    // Documents are judged by the canonical verdict (complianceDocumentValidity), never by a date comparison here.
    const carrierDoc = async (docType: string) => {
      if (!program?.financialEntityId) return { present: false, expiresAt: null, note: "no financial entity on the program" };
      const rows = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, "carrier"), eq(complianceDocuments.ownerId, program.financialEntityId), eq(complianceDocuments.docType, docType)));
      const v = complianceDocumentValidity(rows, docType, now);
      return { present: v.state === "in_force" || v.state === "expiring" || v.state === "expired", expiresAt: v.expiresAt, note: v.state === "unverified" ? "on file, not verified" : undefined };
    };
    const unitIds = (await db.select({ id: units.id }).from(units).where(ownershipScopeWhere("unit", units.id, scope))).map(u => u.id);
    const cvipRows = unitIds.length ? await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, "unit"), inArray(complianceDocuments.ownerId, unitIds), eq(complianceDocuments.docType, "cvip_certificate"))) : [];
    const cvipCurrent = unitIds.filter(id => { const st = complianceDocumentValidity(cvipRows.filter(r => r.ownerId === id), "cvip_certificate", now).state; return st === "in_force" || st === "expiring"; }).length;
    const driversN = await count(db, db.select({ n: sql`COUNT(*)` }).from(operators).where(ownershipScopeWhere("operator", operators.id, scope)));
    const declarationsPolicy = approved.find(p => p.templateKey === "vendor_prequalification.signed_declarations");
    const declarationsSigned = declarationsPolicy ? await count(db, db.select({ n: sql`COUNT(*)` }).from(policyAcknowledgements).where(and(eq(policyAcknowledgements.policyVersionId, declarationsPolicy.currentVersionId!), sql`${policyAcknowledgements.signedAt} IS NOT NULL`))) : 0;
    const [cor, wcb, insurance, sfc] = await Promise.all([carrierDoc("cor_certificate"), carrierDoc("wcb_clearance"), carrierDoc("insurance_proof"), carrierDoc("safety_fitness_certificate")]);
    const manifest = vendorPackageManifest({
      companyProfile: !!program, safetyManual: { activePolicies: approved.length, assembled: !!program?.assembledAt }, corOrSecor: cor, wcbClearance: wcb, insurance, safetyFitnessCertificate: sfc,
      trainingMatrix: await currentMatrixSummary(db, orgRef), driverQualifications: driversN, fleetList: unitIds.length, cvips: { units: unitIds.length, current: cvipCurrent },
      incidentStatistics: !!program, emergencyPlan: approved.some(p => p.moduleKey === "emergency_management" && p.documentKind === "plan"), environmentalProgram: approved.some(p => p.moduleKey === "environmental"),
      references: approved.some(p => p.templateKey === "vendor_prequalification.references") ? 1 : 0, signedDeclarations: declarationsSigned, now,
    });
    return { programRef: program?.programRef ?? null, generatedAt: now, ...manifest, note: "A manifest of what the package would contain. Building the PDF/ZIP is a later checkpoint; a section listed as missing stays missing in the package." };
  }),

  events: roleProcedure("safetyProgram.events").input(z.object({ subjectType: z.string().max(80).optional(), subjectRef: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).default(100), verifyChain: z.boolean().default(false) }).default({ limit: 100, verifyChain: false })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = await orgOf(db, ctx.user.id);
    // Own organization only. Platform events (catalog and reference work, orgRef NULL) belong to the platform scope,
    // which is what the single tenant reads; an organization does not see who across the platform did what.
    const where = [scopeWhere(safetyProgramEvents.orgRef, orgRef)];
    if (input.subjectType) where.push(eq(safetyProgramEvents.subjectType, input.subjectType));
    if (input.subjectRef) where.push(eq(safetyProgramEvents.subjectRef, input.subjectRef));
    const rows = await db.select().from(safetyProgramEvents).where(and(...where)).orderBy(desc(safetyProgramEvents.id)).limit(input.limit);
    // The chain runs over the whole ledger in insertion order, whoever the subject; verifying it reads every row.
    const all = input.verifyChain ? await db.select().from(safetyProgramEvents).orderBy(safetyProgramEvents.id) : [];
    const walked = input.verifyChain ? verifyEventChain(all) : null;
    // A break is named only when it is the caller's own event; otherwise it is reported without its reference.
    const brokenOwn = walked?.brokenAt ? all.find(e => e.eventRef === walked.brokenAt && (orgRef == null ? e.orgRef == null || e.orgRef === SINGLE_TENANT_ID : e.orgRef === orgRef)) : null;
    const chain = walked ? { intact: walked.intact, length: walked.length, brokenAt: walked.brokenAt ? (brokenOwn ? walked.brokenAt : "outside this organization") : null } : null;
    return { events: rows.map(e => ({ ...e, payload: json<unknown>(e.eventJson, {}) })), chain };
  }),
});
