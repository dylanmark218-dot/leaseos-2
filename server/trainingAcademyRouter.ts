/**
 * v22.21 Training Academy API.
 *
 * The router keeps four boundaries explicit:
 *  1. learner actions are self-scoped from ctx.user.id;
 *  2. external credentials are tracked/verified elsewhere and never issued here;
 *  3. assessments and practical evidence are bound to one immutable course version;
 *  4. certificate issuance fails closed until the governing source snapshot is reviewed.
 */
import { randomUUID } from "node:crypto";
import { isSha256HexV1, sha256HexV1 } from "./_core/integrityHash";
import { impactStatus, sourceReviewDecision, type SourceReviewAction } from "./_core/complianceOperations";
import { CREDENTIAL_POLICIES } from "./_core/credentialLifecycle";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { certificateContentDecision, deriveTrainingAspects, TDG_6_2_TOPICS, type Tdg62TopicCode, type TdgMode } from "./_core/tdgCertificateContents";
import { canIssueCertificateFromCoverage, coverageFingerprint, parseTopicCodes, reconcileCoverage, type CoverageRow } from "./_core/tdgTopicCoverage";
import { assembleInspectorPackage, responseDeadline, inspectorRequestSummary } from "./_core/inspectorRequest";
import { allocateSerialBlock } from "./_core/sheetSerialAllocator";
import { resolveSheetScan, ticketClassOf } from "./_core/sheetSerial";
import { academyAssessmentSheets } from "../drizzle/schema";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, userInScope } from "./db";
import {
  academyAssignments,
  academyAssessmentAttempts,
  academyAssessmentItems,
  academyAssessments,
  academyAuditEvents,
  academyCertificates,
  academyCertificateSignatures,
  academyContentBlocks,
  academyCourses,
  academyCourseVersions,
  academyDirectSupervisionRecords,
  academyModuleCompletions,
  academyModules,
  academyPracticalEvaluations,
  academyQualifications,
  academyQuestions,
  academyRegulatoryProfiles,
  academyRequirementBindings,
  academyRequirements,
  academySourceRecords,
  academyStatementsOfExperience,
  academyInspectorRequests,
  complianceKnowledgeItems,
  complianceDocuments,
  users,
  academyQuestionBookmarks,
} from "../drizzle/schema";
import { offlineCopyDecision } from "./_core/studyCentreCatalog";
import { tutorAnswer, type TutorPassage, type TutorQuestion } from "./_core/studyTutor";
import {
  buildAssessment,
  certificateDecision,
  directSupervisionDecision,
  gradeAssessment,
  moduleGate,
  practicalGate,
  stableHash,
  trainingDispatchDecision,
  attemptConsequences,
  weakAreas,
  type AcademyQuestion,
  type AssessmentPolicy,
  type PresentedAssessmentItem,
} from "./_core/trainingAcademy";
import { ACADEMY_COURSES, ACADEMY_REQUIREMENT_SEEDS, ACADEMY_SOURCES, CATALOG_COUNTS } from "./_core/trainingAcademyCatalog";
import { asHolding, canonicalVerdicts, holdingRowsFor, scopeOf, syncCredentialPolicies } from "./trainingWalletService";
import { COMPLIANCE_KNOWLEDGE_CATALOG } from "./_core/complianceSecretary";
import {
  ACADEMY_REGULATORY_PROFILES,
  TDG_REASONABLE_GROUNDS_ATTESTATION,
  certificateFinalizationDecision,
  certificateTerms,
  foreignTdgRoadCertificateDecision,
  regulatoryProfileHash,
} from "./_core/trainingAcademyRegulatory";

const ref = (prefix: string) => `${prefix}-${randomUUID().toUpperCase()}`;
async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
async function audit(db: Awaited<ReturnType<typeof dbOrThrow>>, actorUserId: number | null, subjectType: string, subjectRef: string, eventType: string, payload: unknown) {
  const previous = (await db.select({ eventHash: academyAuditEvents.eventHash }).from(academyAuditEvents).orderBy(desc(academyAuditEvents.id)).limit(1))[0]?.eventHash ?? null;
  const eventRef = ref("ACAD-EVT");
  const body = JSON.stringify(payload ?? {});
  const eventHash = stableHash({ eventRef, actorUserId, subjectType, subjectRef, eventType, body, previous });
  await db.insert(academyAuditEvents).values({ eventRef, actorUserId, subjectType, subjectRef, eventType, eventJson: body, previousHash: previous, eventHash });
  return eventHash;
}

async function assignmentForSelf(db: Awaited<ReturnType<typeof dbOrThrow>>, userId: number, assignmentRef: string) {
  const row = (await db.select().from(academyAssignments).where(and(eq(academyAssignments.assignmentRef, assignmentRef), eq(academyAssignments.userId, userId))).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Training assignment not found" });
  return row;
}
/** 0123 — a course version's coverage as the pure gate reads it: declaration plus the union of its modules. */
async function coverageRowFor(db: Awaited<ReturnType<typeof dbOrThrow>>, courseVersionId: number): Promise<CoverageRow> {
  const v = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.id, courseVersionId)).limit(1))[0];
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Course version not found" });
  const mods = await db.select({ tdgTopicCodesJson: academyModules.tdgTopicCodesJson }).from(academyModules).where(eq(academyModules.courseVersionId, courseVersionId));
  return {
    courseVersionRef: v.versionRef, tdgMode: v.tdgMode ?? null,
    declaredTopicCodesJson: v.tdgTopicCodesJson, reviewStatus: v.tdgTopicReviewStatus, reviewedHash: v.tdgTopicReviewedHash,
    moduleTopicCodesJson: mods.map(m => m.tdgTopicCodesJson),
  };
}

async function assignmentByRef(db: Awaited<ReturnType<typeof dbOrThrow>>, assignmentRef: string) {
  const row = (await db.select().from(academyAssignments).where(eq(academyAssignments.assignmentRef, assignmentRef)).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Training assignment not found" });
  return row;
}
async function versionBundle(db: Awaited<ReturnType<typeof dbOrThrow>>, courseVersionId: number) {
  const version = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.id, courseVersionId)).limit(1))[0];
  if (!version) throw new TRPCError({ code: "NOT_FOUND", message: "Course version not found" });
  const course = (await db.select().from(academyCourses).where(eq(academyCourses.id, version.courseId)).limit(1))[0];
  if (!course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
  return { version, course };
}

async function moduleReadiness(db: Awaited<ReturnType<typeof dbOrThrow>>, assignmentId: number, courseVersionId: number) {
  const modules = await db.select().from(academyModules).where(eq(academyModules.courseVersionId, courseVersionId));
  const completions = await db.select().from(academyModuleCompletions).where(eq(academyModuleCompletions.assignmentId, assignmentId));
  return moduleGate(
    modules.map(m => ({ moduleId: m.id, moduleCode: m.moduleCode, moduleHash: m.moduleHash, required: m.requiresCompletion })),
    completions.map(c => {
      const m = modules.find(x => x.id === c.moduleId);
      return { moduleId: c.moduleId, moduleCode: m?.moduleCode ?? String(c.moduleId), contentVersionHash: c.contentVersionHash, status: c.status };
    }),
  );
}

/** Seed the version-controlled catalog without making a source "reviewed". */
async function synchronizeCatalog(db: Awaited<ReturnType<typeof dbOrThrow>>, actorUserId: number) {
  const created = { sources: 0, regulatoryProfiles: 0, knowledgeItems: 0, courses: 0, versions: 0, modules: 0, blocks: 0, questions: 0, assessments: 0, requirements: 0 };
  for (const src of ACADEMY_SOURCES) {
    const existing = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, src.sourceRef)).limit(1))[0];
    if (!existing) {
      const { sourceKind, licenceStatus, licenceNote, retrievedOn, contentHash, capabilityCodes, ...base } = src;
      await db.insert(academySourceRecords).values({
        ...base, reviewStatus: "unreviewed", snapshotHash: stableHash(src),
        // 0172 — Study Library facts. Seeded as stated by the publisher; still unreviewed.
        sourceKind: sourceKind ?? "study_source", licenceStatus: licenceStatus ?? "unknown", licenceNote: licenceNote ?? null,
        retrievedAt: retrievedOn ? new Date(`${retrievedOn}T00:00:00.000Z`) : null, contentHash: contentHash ?? null,
        capabilityCodesJson: capabilityCodes ? JSON.stringify(capabilityCodes) : null,
      });
      created.sources++;
    }
  }
  for (const profile of ACADEMY_REGULATORY_PROFILES) {
    const existing = (await db.select().from(academyRegulatoryProfiles).where(eq(academyRegulatoryProfiles.profileRef, profile.profileRef)).limit(1))[0];
    if (!existing) {
      await db.insert(academyRegulatoryProfiles).values({
        profileRef: profile.profileRef, qualificationCode: profile.qualificationCode, mode: profile.mode, profileVersion: profile.profileVersion,
        credentialBoundary: profile.credentialBoundary, validityMonths: profile.validityMonths, retentionMonthsAfterExpiry: profile.retentionMonthsAfterExpiry,
        requiresEmployeeSignature: profile.requiresEmployeeSignature, requiresEmployerSignature: profile.requiresEmployerSignature,
        requiresReasonableGroundsAttestation: profile.requiresReasonableGroundsAttestation, sourceSnapshotRef: profile.sourceSnapshotRef,
        effectiveAt: new Date(profile.effectiveAt), profileHash: regulatoryProfileHash(profile), notes: profile.notes,
      });
      created.regulatoryProfiles++;
    }
  }
  for (const item of COMPLIANCE_KNOWLEDGE_CATALOG) {
    const existing = (await db.select().from(complianceKnowledgeItems).where(eq(complianceKnowledgeItems.code, item.code)).limit(1))[0];
    if (!existing) {
      await db.insert(complianceKnowledgeItems).values({
        code: item.code, category: item.category, title: item.title, jurisdiction: item.jurisdiction, summary: item.summary,
        bodyJson: JSON.stringify(item.learningPoints), sourceAuthority: item.source.authority, sourceUrl: item.source.url,
        regulatoryVersion: item.source.regulatoryVersion, sourceVerifiedAt: new Date(`${item.source.verifiedOn}T00:00:00.000Z`),
        companySpecific: item.category === "company_policy", active: true,
      });
      created.knowledgeItems++;
    }
  }
  for (const seed of ACADEMY_COURSES) {
    let course = (await db.select().from(academyCourses).where(eq(academyCourses.courseCode, seed.code)).limit(1))[0];
    if (!course) {
      const ins = await db.insert(academyCourses).values({ courseCode: seed.code, title: seed.title, category: seed.category, credentialBoundary: seed.credentialBoundary, externalCredentialCode: seed.qualificationCode ?? null, jurisdiction: seed.jurisdiction, regulated: !!seed.regulated, requiresPractical: !!seed.requiresPractical, active: true });
      const id = Number(ins[0]?.insertId ?? 0);
      course = (await db.select().from(academyCourses).where(eq(academyCourses.id, id)).limit(1))[0];
      created.courses++;
    }
    if (!course) throw new Error(`Could not create Academy course ${seed.code}`);
    // 0172 — a seed's version number publishes a NEW immutable version; the previous published one is
    // retired, never edited, so attempts taken against it keep their own questions, policy and source.
    const versionNumber = seed.version ?? 1;
    const versionRef = `${seed.code}:${versionNumber}`;
    let version = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.versionRef, versionRef)).limit(1))[0];
    if (!version) {
      const courseHash = stableHash({ code: seed.code, title: seed.title, policy: seed.policy, modules: seed.modules, questions: seed.questions.map(q => ({ code: q.code, prompt: q.prompt, options: q.options, correctIndex: q.correctIndex })) });
      const older = await db.select({ id: academyCourseVersions.id }).from(academyCourseVersions).where(and(eq(academyCourseVersions.courseId, course.id), eq(academyCourseVersions.status, "published")));
      const ins = await db.insert(academyCourseVersions).values({ courseId: course.id, versionRef, versionNumber, status: "published", effectiveAt: new Date(), policyJson: JSON.stringify(seed.policy), courseHash, sourceSnapshotRef: seed.sourceRef ?? null, publishedByUserId: actorUserId, publishedAt: new Date() });
      for (const o of older) await db.update(academyCourseVersions).set({ status: "retired" }).where(eq(academyCourseVersions.id, o.id));
      if (course.title !== seed.title) await db.update(academyCourses).set({ title: seed.title }).where(eq(academyCourses.id, course.id));
      const id = Number(ins[0]?.insertId ?? 0);
      version = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.id, id)).limit(1))[0];
      created.versions++;
    }
    if (!version) throw new Error(`Could not create Academy version ${versionRef}`);

    const existingModules = await db.select().from(academyModules).where(eq(academyModules.courseVersionId, version.id));
    if (existingModules.length === 0) {
      for (let mi = 0; mi < seed.modules.length; mi++) {
        const m = seed.modules[mi];
        const moduleHash = stableHash(m);
        const mins = await db.insert(academyModules).values({ courseVersionId: version.id, moduleCode: m.code, title: m.title, orderIndex: mi, domainCode: m.domain, requiresCompletion: true, requiresPractical: !!m.practical, estimatedMinutes: m.minutes, moduleHash, sourceRef: m.sourceRef ?? seed.sourceRef ?? null, sourceSection: m.sourceSection ?? null, companySpecific: !!m.companySpecific });
        const moduleId = Number(mins[0]?.insertId ?? 0);
        created.modules++;
        for (let bi = 0; bi < m.blocks.length; bi++) {
          const b = m.blocks[bi];
          await db.insert(academyContentBlocks).values({ moduleId, blockCode: b.code, orderIndex: bi, kind: b.kind, title: b.title, bodyJson: JSON.stringify(b.body), contentHash: stableHash(b) });
          created.blocks++;
        }
      }
    }

    const existingQuestions = await db.select({ id: academyQuestions.id }).from(academyQuestions).where(eq(academyQuestions.courseVersionId, version.id)).limit(1);
    if (existingQuestions.length === 0) {
      for (const q of seed.questions) {
        await db.insert(academyQuestions).values({ courseVersionId: version.id, questionCode: q.code, bankCode: seed.code, domainCode: q.domain, prompt: q.prompt, optionsJson: JSON.stringify(q.options), correctAnswerJson: JSON.stringify({ correctIndex: q.correctIndex }), explanation: q.explanation, critical: !!q.critical, active: true, questionHash: stableHash(q), sourceRef: q.sourceRef ?? seed.sourceRef ?? null, sourceSection: q.sourceSection ?? null });
        created.questions++;
      }
    }
    const assessmentCode = `${seed.code}-FINAL`;
    const existingAssessment = (await db.select().from(academyAssessments).where(and(eq(academyAssessments.courseVersionId, version.id), eq(academyAssessments.assessmentCode, assessmentCode))).limit(1))[0];
    if (!existingAssessment) {
      await db.insert(academyAssessments).values({ courseVersionId: version.id, assessmentCode, title: `${seed.title} · Final Assessment`, questionCount: seed.policy.questionCount, passingScorePercent: seed.policy.passingScorePercent, maxAttempts: seed.policy.maxAttempts ?? null, policyJson: JSON.stringify(seed.policy), domainThresholdsJson: seed.policy.domainMinimumPercent ? JSON.stringify(seed.policy.domainMinimumPercent) : null, criticalFailurePolicyJson: JSON.stringify({ failOnCriticalMiss: !!seed.policy.failOnCriticalMiss }), active: true, assessmentKind: "FINAL_INTERNAL" });
      created.assessments++;
    }
    // 0172 — practice and mock exams on the same bank and version. Unlimited attempts; never a credential.
    if (seed.practice) {
      const kinds = [
        { code: `${seed.code}-PRACTICE`, kind: "PRACTICE" as const, title: `${seed.title} · Practice`, policy: { questionCount: Math.min(10, seed.questions.length), passingScorePercent: seed.practice.mockPassingPercent } },
        { code: `${seed.code}-MOCK`, kind: "MOCK_EXAM" as const, title: `${seed.title} · Mock exam`, policy: { questionCount: seed.practice.mockQuestionCount, passingScorePercent: seed.practice.mockPassingPercent, stratifyByDomain: true } },
      ];
      for (const k of kinds) {
        const has = (await db.select({ id: academyAssessments.id }).from(academyAssessments).where(and(eq(academyAssessments.courseVersionId, version.id), eq(academyAssessments.assessmentCode, k.code))).limit(1))[0];
        if (has) continue;
        await db.insert(academyAssessments).values({ courseVersionId: version.id, assessmentCode: k.code, title: k.title, questionCount: k.policy.questionCount, passingScorePercent: k.policy.passingScorePercent, maxAttempts: null, policyJson: JSON.stringify(k.policy), active: true, assessmentKind: k.kind });
        created.assessments++;
      }
    }
  }
  for (const r of ACADEMY_REQUIREMENT_SEEDS) {
    const existing = (await db.select().from(academyRequirements).where(eq(academyRequirements.requirementCode, r.code)).limit(1))[0];
    if (!existing) {
      await db.insert(academyRequirements).values({ requirementCode: r.code, title: r.title, qualificationCode: r.qualificationCode, enforcement: r.enforcement, recoveryPath: r.recoveryPath, active: true, createdByUserId: actorUserId });
      created.requirements++;
    }
  }
  const policySync = await syncCredentialPolicies(db);
  await audit(db, actorUserId, "academy_catalog", "v22.21", "catalog.synchronized", { created, catalogCounts: CATALOG_COUNTS, credentialPolicies: policySync });
  return created;
}


/* ---- 0174: source review, applied through the pure two-person decision ---- */
async function sourceImpactOf(db: Awaited<ReturnType<typeof dbOrThrow>>, sourceRef: string) {
  const status = impactStatus((await db.select({ s: academySourceRecords.reviewStatus }).from(academySourceRecords).where(eq(academySourceRecords.sourceRef, sourceRef)).limit(1))[0]?.s);
  const versions = await db.select({ id: academyCourseVersions.id, versionRef: academyCourseVersions.versionRef, status: academyCourseVersions.status, title: academyCourses.title })
    .from(academyCourseVersions).innerJoin(academyCourses, eq(academyCourses.id, academyCourseVersions.courseId)).where(eq(academyCourseVersions.sourceSnapshotRef, sourceRef));
  const moduleRows = await db.select({ versionId: academyModules.courseVersionId, n: sql<number>`COUNT(*)` }).from(academyModules).where(eq(academyModules.sourceRef, sourceRef)).groupBy(academyModules.courseVersionId);
  const questionRows = await db.select({ versionId: academyQuestions.courseVersionId, n: sql<number>`COUNT(*)` }).from(academyQuestions).where(eq(academyQuestions.sourceRef, sourceRef)).groupBy(academyQuestions.courseVersionId);
  const versionIds = Array.from(new Set([...versions.map(v => v.id), ...moduleRows.map(m => m.versionId), ...questionRows.map(q => q.versionId)]));
  const allVersions = versionIds.length ? await db.select({ id: academyCourseVersions.id, versionRef: academyCourseVersions.versionRef, status: academyCourseVersions.status }).from(academyCourseVersions).where(inArray(academyCourseVersions.id, versionIds)) : [];
  const attempts = versionIds.length ? await db.select({ versionId: academyAssessmentAttempts.courseVersionId, n: sql<number>`COUNT(*)` }).from(academyAssessmentAttempts).where(inArray(academyAssessmentAttempts.courseVersionId, versionIds)).groupBy(academyAssessmentAttempts.courseVersionId) : [];
  const policies = CREDENTIAL_POLICIES.filter(p => p.sourceRefs.includes(sourceRef)).map(p => ({ policyRef: p.policyRef, qualificationCode: p.qualificationCode, status }));
  const profiles = (await db.select({ profileRef: academyRegulatoryProfiles.profileRef, qualificationCode: academyRegulatoryProfiles.qualificationCode }).from(academyRegulatoryProfiles).where(eq(academyRegulatoryProfiles.sourceSnapshotRef, sourceRef))).map(p => ({ ...p, status }));
  return {
    status,
    courseVersions: allVersions.map(v => ({ versionRef: v.versionRef, versionStatus: v.status, governing: versions.some(g => g.id === v.id), modules: Number(moduleRows.find(m => m.versionId === v.id)?.n ?? 0), questions: Number(questionRows.find(q => q.versionId === v.id)?.n ?? 0), historicalAttempts: Number(attempts.find(a => a.versionId === v.id)?.n ?? 0), status })),
    modules: moduleRows.reduce((n, m) => n + Number(m.n), 0),
    questions: questionRows.reduce((n, q) => n + Number(q.n), 0),
    policies, regulatoryProfiles: profiles,
    requirements: "Qualification requirements carry no source link; they name qualification codes, whose renewal policies are listed above.",
    notice: "Nothing is rewritten. Historical attempts stay bound to the version they were taken on; content governed by a superseded source needs review.",
  };
}

async function applySourceAction(db: Awaited<ReturnType<typeof dbOrThrow>>, actorUserId: number, args: { sourceRef: string; action: SourceReviewAction; note: string; successorRef: string | null }) {
  const src = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, args.sourceRef)).limit(1))[0];
  if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Academy source record not found" });
  const successor = args.successorRef ? (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, args.successorRef)).limit(1))[0] ?? null : null;
  if (args.successorRef && !successor) throw new TRPCError({ code: "NOT_FOUND", message: "Successor source not found" });
  const view = (r: typeof src) => ({ sourceRef: r.sourceRef, reviewStatus: r.reviewStatus, proposedByUserId: r.proposedByUserId, firstReviewedByUserId: r.firstReviewedByUserId, sourceUrl: r.sourceUrl, edition: r.edition, sourceTier: r.sourceTier });
  const d = sourceReviewDecision({ action: args.action, source: view(src), actorUserId, successor: successor ? view(successor) : null, note: args.note });
  if (!d.permitted) throw new TRPCError({ code: args.action === "APPROVE" && d.blockers.some(b => /second person|may not/.test(b)) ? "FORBIDDEN" : "PRECONDITION_FAILED", message: d.blockers.join("; ") });
  const now = new Date();
  const notes = `${src.notes ?? ""}\n${args.action} by ${actorUserId}: ${args.note}`.trim();
  if (args.action === "REVIEW") await db.update(academySourceRecords).set({ reviewStatus: "under_review", firstReviewedByUserId: actorUserId, firstReviewedAt: now, firstReviewNote: args.note, notes }).where(eq(academySourceRecords.id, src.id));
  if (args.action === "APPROVE") await db.update(academySourceRecords).set({ reviewStatus: "reviewed", approvedByUserId: actorUserId, approvedAt: now, reviewedByUserId: actorUserId, reviewedAt: now, notes }).where(eq(academySourceRecords.id, src.id));
  if (args.action === "REJECT") await db.update(academySourceRecords).set({ reviewStatus: "rejected", rejectionReason: args.note, reviewedByUserId: actorUserId, reviewedAt: now, notes }).where(eq(academySourceRecords.id, src.id));
  if (args.action === "MARK_SUPERSEDED") {
    await db.update(academySourceRecords).set({ reviewStatus: "superseded", supersededBySourceRef: successor!.sourceRef, reviewedByUserId: actorUserId, reviewedAt: now, notes }).where(eq(academySourceRecords.id, src.id));
    if (!successor!.supersedesSourceRef) await db.update(academySourceRecords).set({ supersedesSourceRef: src.sourceRef }).where(eq(academySourceRecords.id, successor!.id));
  }
  await audit(db, actorUserId, "academy_source", src.sourceRef, `source.${args.action.toLowerCase()}`, { from: src.reviewStatus, to: d.next, note: args.note, successor: successor?.sourceRef ?? null, snapshotHash: src.snapshotHash, contentHash: src.contentHash });
  const impact = args.action === "MARK_SUPERSEDED" ? await sourceImpactOf(db, src.sourceRef) : null;
  return { sourceRef: src.sourceRef, reviewStatus: d.next!, impact };
}

export const trainingAcademyRouter = router({
  catalog: roleProcedure("academy.catalog").query(async () => {
    const db = await dbOrThrow();
    const rows = await db.select().from(academyCourses).where(eq(academyCourses.active, true));
    const dbByCode = new Map(rows.map(r => [r.courseCode, r]));
    return {
      counts: CATALOG_COUNTS,
      courses: ACADEMY_COURSES.map(c => ({
        courseCode: c.code, title: c.title, category: c.category, jurisdiction: c.jurisdiction,
        credentialBoundary: c.credentialBoundary, qualificationCode: c.qualificationCode ?? null,
        regulated: !!c.regulated, requiresPractical: !!c.requiresPractical,
        moduleCount: c.modules.length, questionBankSize: c.questions.length,
        installed: dbByCode.has(c.code),
        warning: c.credentialBoundary === "external_track_only" ? "LeaseOS may prepare/track this credential, but cannot issue the external credential." : null,
      })),
    };
  }),

  syncCatalog: roleProcedure("academy.syncCatalog").mutation(async ({ ctx }) => {
    const db = await dbOrThrow();
    return { created: await synchronizeCatalog(db, ctx.user.id), counts: CATALOG_COUNTS };
  }),

  myTraining: roleProcedure("academy.myTraining").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const assignments = await db.select().from(academyAssignments).where(eq(academyAssignments.userId, ctx.user.id)).orderBy(desc(academyAssignments.id));
    const out = [];
    for (const a of assignments) {
      const { course, version } = await versionBundle(db, a.courseVersionId);
      const readiness = await moduleReadiness(db, a.id, a.courseVersionId);
      out.push({ assignmentRef: a.assignmentRef, status: a.status, dueAt: a.dueAt, startedAt: a.startedAt, completedAt: a.completedAt, course: { code: course.courseCode, title: course.title, category: course.category, credentialBoundary: course.credentialBoundary, requiresPractical: course.requiresPractical }, version: { ref: version.versionRef, number: version.versionNumber }, assessmentReady: readiness.ready, missingModules: readiness.missing, staleModules: readiness.stale });
    }
    return { assignments: out };
  }),

  assignmentDetail: roleProcedure("academy.assignmentDetail")
    .input(z.object({ assignmentRef: z.string().min(1).max(96) }))
    .query(async ({ ctx, input }) => {
      // P4.1: the assignment's learner must be in the caller's scope; otherwise the assignment does not exist here.
      {
        const scope = await actingScopeFor(ctx.user.id);
        const dbs = await getDb();
        const owner = dbs ? (await dbs.select({ userId: academyAssignments.userId }).from(academyAssignments).where(eq(academyAssignments.assignmentRef, input.assignmentRef)).limit(1))[0] : undefined;
        if (owner && !(await userInScope(owner.userId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Assignment ${input.assignmentRef} not found` });
      }
      const db = await dbOrThrow();
      const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
      const { course, version } = await versionBundle(db, a.courseVersionId);
      const modules = await db.select().from(academyModules).where(eq(academyModules.courseVersionId, a.courseVersionId));
      const completions = await db.select().from(academyModuleCompletions).where(eq(academyModuleCompletions.assignmentId, a.id));
      const responseModules = [];
      for (const m of modules.sort((x, y) => x.orderIndex - y.orderIndex)) {
        const blocks = await db.select().from(academyContentBlocks).where(eq(academyContentBlocks.moduleId, m.id));
        const completion = completions.find(c => c.moduleId === m.id);
        responseModules.push({ moduleCode: m.moduleCode, title: m.title, domain: m.domainCode, estimatedMinutes: m.estimatedMinutes, moduleHash: m.moduleHash, status: completion?.status ?? "not_started", stale: !!completion && completion.contentVersionHash !== m.moduleHash, blocks: blocks.sort((x, y) => x.orderIndex - y.orderIndex).map(b => ({ code: b.blockCode, kind: b.kind, title: b.title, body: json<string[]>(b.bodyJson, []) })) });
      }
      const readiness = await moduleReadiness(db, a.id, a.courseVersionId);
      return { assignment: { ref: a.assignmentRef, status: a.status, dueAt: a.dueAt }, course: { code: course.courseCode, title: course.title, credentialBoundary: course.credentialBoundary, requiresPractical: course.requiresPractical }, version: { ref: version.versionRef, number: version.versionNumber, sourceSnapshotRef: version.sourceSnapshotRef }, modules: responseModules, assessment: { ready: readiness.ready, reason: readiness.reason } };
    }),

  moduleComplete: roleProcedure("academy.moduleComplete")
    .input(z.object({ assignmentRef: z.string().min(1).max(96), moduleCode: z.string().min(1).max(80), evidence: z.record(z.string(), z.unknown()).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
      if (["completed", "cancelled"].includes(a.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Assignment is ${a.status}` });
      const m = (await db.select().from(academyModules).where(and(eq(academyModules.courseVersionId, a.courseVersionId), eq(academyModules.moduleCode, input.moduleCode))).limit(1))[0];
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Current-version module not found" });
      const existing = (await db.select().from(academyModuleCompletions).where(and(eq(academyModuleCompletions.assignmentId, a.id), eq(academyModuleCompletions.moduleId, m.id))).limit(1))[0];
      const now = new Date();
      if (existing) await db.update(academyModuleCompletions).set({ courseVersionId: a.courseVersionId, status: "completed", startedAt: existing.startedAt ?? now, completedAt: now, contentVersionHash: m.moduleHash, evidenceJson: input.evidence ? JSON.stringify(input.evidence) : existing.evidenceJson }).where(eq(academyModuleCompletions.id, existing.id));
      else await db.insert(academyModuleCompletions).values({ assignmentId: a.id, moduleId: m.id, courseVersionId: a.courseVersionId, status: "completed", startedAt: now, completedAt: now, contentVersionHash: m.moduleHash, evidenceJson: input.evidence ? JSON.stringify(input.evidence) : null });
      const readiness = await moduleReadiness(db, a.id, a.courseVersionId);
      await db.update(academyAssignments).set({ status: readiness.ready ? "assessment_ready" : "in_progress", startedAt: a.startedAt ?? now }).where(eq(academyAssignments.id, a.id));
      await audit(db, ctx.user.id, "academy_assignment", a.assignmentRef, "module.completed", { moduleCode: m.moduleCode, moduleHash: m.moduleHash, assessmentReady: readiness.ready });
      return { moduleCode: m.moduleCode, status: "completed" as const, assessmentReady: readiness.ready, remaining: readiness.missing };
    }),

  assessmentOpen: roleProcedure("academy.assessmentOpen")
    .input(z.object({ assignmentRef: z.string().min(1).max(96) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the assignment's learner must be in the caller's scope; otherwise the assignment does not exist here.
      {
        const scope = await actingScopeFor(ctx.user.id);
        const dbs = await getDb();
        const owner = dbs ? (await dbs.select({ userId: academyAssignments.userId }).from(academyAssignments).where(eq(academyAssignments.assignmentRef, input.assignmentRef)).limit(1))[0] : undefined;
        if (owner && !(await userInScope(owner.userId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Assignment ${input.assignmentRef} not found` });
      }
      const db = await dbOrThrow();
      const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
      const readiness = await moduleReadiness(db, a.id, a.courseVersionId);
      if (!readiness.ready) throw new TRPCError({ code: "PRECONDITION_FAILED", message: readiness.reason ?? "Current modules are not complete" });
      // 0172 — only the FINAL_INTERNAL assessment can advance an assignment; practice/mock live beside it.
      const assessment = (await db.select().from(academyAssessments).where(and(eq(academyAssessments.courseVersionId, a.courseVersionId), eq(academyAssessments.active, true), eq(academyAssessments.assessmentKind, "FINAL_INTERNAL"))).limit(1))[0];
      if (!assessment) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active assessment exists for this course version" });
      const previous = await db.select().from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.assessmentId, assessment.id)));
      const open = previous.find(x => x.status === "open");
      if (open) {
        const items = await db.select().from(academyAssessmentItems).where(eq(academyAssessmentItems.attemptId, open.id));
        const qs = await db.select().from(academyQuestions).where(eq(academyQuestions.courseVersionId, a.courseVersionId));
        return { attemptRef: open.attemptRef, attemptNumber: open.attemptNumber, questions: items.sort((x, y) => x.sequenceIndex - y.sequenceIndex).map(i => { const q = qs.find(x => x.id === i.questionId)!; const options = json<string[]>(q.optionsJson, []); const order = json<number[]>(i.answerOrderJson, []); return { questionCode: q.questionCode, domain: i.domainCode, critical: i.critical, prompt: q.prompt, options: order.map(n => options[n]) }; }) };
      }
      if (assessment.maxAttempts != null && previous.filter(x => x.status !== "void").length >= assessment.maxAttempts) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Maximum assessment attempts reached; supervisor review is required" });
      const qrows = await db.select().from(academyQuestions).where(and(eq(academyQuestions.courseVersionId, a.courseVersionId), eq(academyQuestions.active, true)));
      const bank: AcademyQuestion[] = qrows.map(q => ({ id: q.id, code: q.questionCode, domain: q.domainCode, prompt: q.prompt, options: json<string[]>(q.optionsJson, []), correctIndex: json<{ correctIndex: number }>(q.correctAnswerJson, { correctIndex: -1 }).correctIndex, explanation: q.explanation ?? "", critical: q.critical }));
      const policy = json<AssessmentPolicy>(assessment.policyJson, { questionCount: assessment.questionCount, passingScorePercent: assessment.passingScorePercent });
      const attemptRef = ref("ACAD-ATT");
      const built = buildAssessment({ attemptSeed: attemptRef, questions: bank, policy });
      const attemptNumber = previous.filter(x => x.status !== "void").length + 1;
      const ins = await db.insert(academyAssessmentAttempts).values({ attemptRef, assessmentId: assessment.id, assignmentId: a.id, userId: ctx.user.id, courseVersionId: a.courseVersionId, status: "open", attemptNumber, policySnapshotJson: JSON.stringify(built.policySnapshot), questionSetJson: JSON.stringify(built.items.map(i => ({ questionCode: i.questionCode, answerOrder: i.answerOrder, sequenceIndex: i.sequenceIndex }))), questionSetHash: built.questionSetHash });
      const attemptId = Number(ins[0]?.insertId ?? 0);
      for (const item of built.items) {
        const q = qrows.find(x => x.questionCode === item.questionCode);
        if (!q) throw new Error(`Snapshotted question ${item.questionCode} missing`);
        await db.insert(academyAssessmentItems).values({ attemptId, questionId: q.id, sequenceIndex: item.sequenceIndex, domainCode: item.domain, critical: item.critical, presentedPromptHash: item.presentedPromptHash, answerOrderJson: JSON.stringify(item.answerOrder) });
      }
      await audit(db, ctx.user.id, "academy_attempt", attemptRef, "assessment.opened", { assignmentRef: a.assignmentRef, courseVersionId: a.courseVersionId, questionSetHash: built.questionSetHash, attemptNumber });
      return { attemptRef, attemptNumber, questions: built.items.map(i => ({ questionCode: i.questionCode, domain: i.domain, critical: i.critical, prompt: i.prompt, options: i.presentedOptions })) };
    }),

  assessmentSubmit: roleProcedure("academy.assessmentSubmit")
    .input(z.object({ attemptRef: z.string().min(1).max(96), answers: z.record(z.string(), z.number().int().min(0).max(20)) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const attempt = (await db.select().from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.attemptRef, input.attemptRef), eq(academyAssessmentAttempts.userId, ctx.user.id))).limit(1))[0];
      if (!attempt) throw new TRPCError({ code: "NOT_FOUND", message: "Assessment attempt not found" });
      if (attempt.status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Attempt is already ${attempt.status}` });
      if (attempt.assessmentKind !== "FINAL_INTERNAL") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Practice and mock attempts are submitted through practiceSubmit and never advance an assignment" });
      const a = await assignmentForSelf(db, ctx.user.id, (await db.select({ assignmentRef: academyAssignments.assignmentRef }).from(academyAssignments).where(eq(academyAssignments.id, attempt.assignmentId)).limit(1))[0]?.assignmentRef ?? "missing");
      if (a.courseVersionId !== attempt.courseVersionId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Attempt and assignment versions do not match" });
      const rows = await db.select().from(academyAssessmentItems).where(eq(academyAssessmentItems.attemptId, attempt.id));
      const qrows = await db.select().from(academyQuestions).where(eq(academyQuestions.courseVersionId, attempt.courseVersionId));
      const bank: AcademyQuestion[] = qrows.map(q => ({ id: q.id, code: q.questionCode, domain: q.domainCode, prompt: q.prompt, options: json<string[]>(q.optionsJson, []), correctIndex: json<{ correctIndex: number }>(q.correctAnswerJson, { correctIndex: -1 }).correctIndex, explanation: q.explanation ?? "", critical: q.critical }));
      const presented: PresentedAssessmentItem[] = rows.sort((x, y) => x.sequenceIndex - y.sequenceIndex).map(i => { const q = qrows.find(x => x.id === i.questionId)!; const order = json<number[]>(i.answerOrderJson, []); const opts = json<string[]>(q.optionsJson, []); return { questionCode: q.questionCode, sequenceIndex: i.sequenceIndex, domain: i.domainCode, critical: i.critical, prompt: q.prompt, presentedPromptHash: i.presentedPromptHash, answerOrder: order, presentedOptions: order.map(n => opts[n]) }; });
      const policy = json<AssessmentPolicy>(attempt.policySnapshotJson, { questionCount: presented.length, passingScorePercent: 80 });
      const result = gradeAssessment({ bank, presented, responses: input.answers, policy });
      const now = new Date();
      for (const r of result.itemResults) {
        const item = rows.find(x => qrows.find(q => q.id === x.questionId)?.questionCode === r.questionCode);
        if (item) await db.update(academyAssessmentItems).set({ responseJson: JSON.stringify({ presentedIndex: r.responsePresentedIndex }), correct: r.correct, answeredAt: now }).where(eq(academyAssessmentItems.id, item.id));
      }
      await db.update(academyAssessmentAttempts).set({ status: result.passed ? "passed" : "failed", submittedAt: now, scorePercent: result.scorePercent, domainScoresJson: JSON.stringify(result.domainScores), criticalFailuresJson: JSON.stringify(result.criticalFailures) }).where(eq(academyAssessmentAttempts.id, attempt.id));
      const { course } = await versionBundle(db, a.courseVersionId);
      const nextStatus = result.passed ? (course.requiresPractical ? "practical_pending" : "completed") : "failed";
      await db.update(academyAssignments).set({ status: nextStatus, completedAt: result.passed && !course.requiresPractical ? now : null, completionReason: result.passed ? (course.requiresPractical ? "Theory passed; practical competency pending" : "Current-version assessment passed") : "Assessment failed" }).where(eq(academyAssignments.id, a.id));
      await audit(db, ctx.user.id, "academy_attempt", attempt.attemptRef, "assessment.submitted", { scorePercent: result.scorePercent, passed: result.passed, domainFailures: result.domainFailures, criticalFailures: result.criticalFailures, courseVersionId: attempt.courseVersionId });
      return { passed: result.passed, scorePercent: result.scorePercent, domainScores: result.domainScores, domainFailures: result.domainFailures, criticalFailures: result.criticalFailures, nextStatus };
    }),

  ticketPortfolio: roleProcedure("academy.ticketPortfolio").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const certificates = await db.select().from(academyCertificates).where(eq(academyCertificates.userId, ctx.user.id)).orderBy(desc(academyCertificates.id));
    const qualifications = await db.select().from(academyQualifications).where(eq(academyQualifications.userId, ctx.user.id)).orderBy(desc(academyQualifications.id));
    return { certificates: certificates.map(c => ({ certificateRef: c.certificateRef, qualificationCode: c.qualificationCode, credentialBoundary: c.credentialBoundary, status: c.status, issuedAt: c.issuedAt, finalizedAt: c.finalizedAt, expiresAt: c.expiresAt, retentionUntil: c.retentionUntil, revokedAt: c.revokedAt, courseVersionId: c.courseVersionId, regulatoryProfileRef: c.regulatoryProfileRef })), qualifications: qualifications.map(q => ({ qualificationRef: q.qualificationRef, qualificationCode: q.qualificationCode, sourceKind: q.sourceKind, status: q.status, validFrom: q.validFrom, expiresAt: q.expiresAt, courseVersionId: q.courseVersionId })) };
  }),

  assign: roleProcedure("academy.assign")
    .input(z.object({ userId: z.number().int().positive(), courseCode: z.string().min(1).max(80), dueAt: z.coerce.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant); otherwise not found.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await userInScope(input.userId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const db = await dbOrThrow();
      let course = (await db.select().from(academyCourses).where(eq(academyCourses.courseCode, input.courseCode)).limit(1))[0];
      if (!course) { await synchronizeCatalog(db, ctx.user.id); course = (await db.select().from(academyCourses).where(eq(academyCourses.courseCode, input.courseCode)).limit(1))[0]; }
      if (!course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      const version = (await db.select().from(academyCourseVersions).where(and(eq(academyCourseVersions.courseId, course.id), eq(academyCourseVersions.status, "published"))).orderBy(desc(academyCourseVersions.versionNumber)).limit(1))[0];
      if (!version) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Course has no published version" });
      const existing = (await db.select().from(academyAssignments).where(and(eq(academyAssignments.userId, input.userId), eq(academyAssignments.courseVersionId, version.id), inArray(academyAssignments.status, ["assigned", "in_progress", "assessment_ready", "practical_pending"]))).limit(1))[0];
      if (existing) return { assignmentRef: existing.assignmentRef, status: existing.status, reused: true };
      const assignmentRef = ref("ACAD-ASG");
      await db.insert(academyAssignments).values({ assignmentRef, userId: input.userId, courseVersionId: version.id, status: "assigned", assignedByUserId: ctx.user.id, dueAt: input.dueAt ?? null });
      await audit(db, ctx.user.id, "academy_assignment", assignmentRef, "assignment.created", { userId: input.userId, courseCode: course.courseCode, versionRef: version.versionRef, dueAt: input.dueAt ?? null });
      return { assignmentRef, status: "assigned" as const, reused: false };
    }),

  practicalSignoff: roleProcedure("academy.practicalSignoff")
    .input(z.object({ assignmentRef: z.string().min(1).max(96), competencyCode: z.string().min(1).max(100), status: z.enum(["competent", "needs_practice", "failed"]), rubric: z.record(z.string(), z.unknown()), evidenceRecordId: z.number().int().positive().nullable().optional(), observedAt: z.coerce.date(), expiresAt: z.coerce.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assignmentByRef(db, input.assignmentRef);
      if (a.userId === ctx.user.id) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Learners cannot sign their own practical competency" });
      const { course } = await versionBundle(db, a.courseVersionId);
      if (!course.requiresPractical) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This course does not require a practical evaluation" });
      const theory = (await db.select().from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.courseVersionId, a.courseVersionId), eq(academyAssessmentAttempts.status, "passed"), eq(academyAssessmentAttempts.assessmentKind, "FINAL_INTERNAL"))).orderBy(desc(academyAssessmentAttempts.id)).limit(1))[0];
      if (!theory) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Current-version theory assessment must be passed first" });
      const evaluationRef = ref("ACAD-PRAC");
      await db.insert(academyPracticalEvaluations).values({ evaluationRef, assignmentId: a.id, courseVersionId: a.courseVersionId, userId: a.userId, competencyCode: input.competencyCode, evaluatorUserId: ctx.user.id, status: input.status, rubricJson: JSON.stringify(input.rubric), evidenceRecordId: input.evidenceRecordId ?? null, observedAt: input.observedAt, signedAt: new Date(), expiresAt: input.expiresAt ?? null });
      await db.update(academyAssignments).set({ status: input.status === "competent" ? "completed" : "practical_pending", completedAt: input.status === "competent" ? new Date() : null, completionReason: input.status === "competent" ? "Theory passed and practical competency signed off" : `Practical evaluation: ${input.status}` }).where(eq(academyAssignments.id, a.id));
      await audit(db, ctx.user.id, "academy_practical", evaluationRef, "practical.signed", { assignmentRef: a.assignmentRef, userId: a.userId, courseVersionId: a.courseVersionId, competencyCode: input.competencyCode, status: input.status });
      return { evaluationRef, status: input.status };
    }),

  /**
   * The original single-step review, kept for callers, now bound by the two-person rule (0174): "reviewed"
   * takes an unreviewed source into review, and only a different person's second "reviewed" approves it.
   */
  sourceReview: roleProcedure("academy.sourceReview")
    .input(z.object({ sourceRef: z.string().min(1).max(96), decision: z.enum(["reviewed", "rejected", "superseded"]), note: z.string().min(3).max(2000), supersededBy: z.string().min(1).max(96).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const src = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, input.sourceRef)).limit(1))[0];
      if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Academy source record not found" });
      const action = input.decision === "reviewed" ? (src.reviewStatus === "under_review" ? "APPROVE" : "REVIEW") : input.decision === "rejected" ? "REJECT" : "MARK_SUPERSEDED";
      return applySourceAction(db, ctx.user.id, { sourceRef: input.sourceRef, action, note: input.note.length >= 10 ? input.note : `${input.note} (legacy review)`, successorRef: input.supersededBy ?? null });
    }),

  /** 0174 — the Source Review queue: every source version with its state, reviewers, successor and what it governs. */
  sourceReviewQueue: roleProcedure("academy.sourceReviewQueue").query(async () => {
    const db = await dbOrThrow();
    const rows = await db.select().from(academySourceRecords).limit(500);
    const out = [];
    for (const r of rows) {
      const impact = await sourceImpactOf(db, r.sourceRef);
      out.push({
        sourceRef: r.sourceRef, authority: r.authority, title: r.title, jurisdiction: r.jurisdiction, edition: r.edition, url: r.sourceUrl, tier: r.sourceTier,
        retrievedAt: r.retrievedAt, fingerprint: r.contentHash ?? r.snapshotHash, fingerprintKind: r.contentHash ? (isSha256HexV1(r.contentHash) ? "sha256" : "recorded") : "legacy-stableHash",
        reviewStatus: r.reviewStatus, impactStatus: impactStatus(r.reviewStatus), proposedByUserId: r.proposedByUserId,
        firstReviewedByUserId: r.firstReviewedByUserId, firstReviewedAt: r.firstReviewedAt, lastReviewedByUserId: r.approvedByUserId ?? r.reviewedByUserId ?? r.firstReviewedByUserId,
        lastReviewedAt: r.approvedAt ?? r.reviewedAt ?? r.firstReviewedAt, supersededBySourceRef: r.supersededBySourceRef, supersedesSourceRef: r.supersedesSourceRef, rejectionReason: r.rejectionReason,
        affected: { courseVersions: impact.courseVersions.length, modules: impact.modules, questions: impact.questions, policies: impact.policies.length, regulatoryProfiles: impact.regulatoryProfiles.length },
      });
    }
    return out;
  }),

  /** 0174 — REVIEW, APPROVE, REJECT or MARK_SUPERSEDED. Two people make a source trusted. */
  sourceAct: roleProcedure("academy.sourceAct")
    .input(z.object({ sourceRef: z.string().min(1).max(96), action: z.enum(["REVIEW", "APPROVE", "REJECT", "MARK_SUPERSEDED"]), note: z.string().min(10).max(2000), successorRef: z.string().min(1).max(96).nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => applySourceAction(await dbOrThrow(), ctx.user.id, { sourceRef: input.sourceRef, action: input.action, note: input.note, successorRef: input.successorRef ?? null })),

  /** 0174 — a new edition is a new source version; the old one is never edited. It starts unreviewed. */
  sourceProposeVersion: roleProcedure("academy.sourceProposeVersion")
    .input(z.object({ supersedesSourceRef: z.string().min(1).max(96), edition: z.string().min(2).max(120), sourceUrl: z.string().url().max(1024), retrievedAt: z.coerce.date(), contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), note: z.string().min(10).max(2000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const prior = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, input.supersedesSourceRef)).limit(1))[0];
      if (!prior) throw new TRPCError({ code: "NOT_FOUND", message: "Source not found" });
      const versions = await db.select({ ref: academySourceRecords.sourceRef }).from(academySourceRecords).where(sql`${academySourceRecords.sourceRef} LIKE ${`${input.supersedesSourceRef.split("@")[0]}@v%`}`);
      const sourceRef = `${input.supersedesSourceRef.split("@")[0]}@v${versions.length + 2}`.slice(0, 96);
      const record = { sourceRef, authority: prior.authority, sourceTier: prior.sourceTier, title: prior.title, sourceUrl: input.sourceUrl, jurisdiction: prior.jurisdiction, edition: input.edition };
      await db.insert(academySourceRecords).values({
        ...record, reviewStatus: "unreviewed", snapshotHash: sha256HexV1(record), contentHash: input.contentHash ?? null, notes: `Proposed as the successor of ${prior.sourceRef}: ${input.note}`,
        sourceKind: prior.sourceKind, licenceStatus: "unknown", retrievedAt: input.retrievedAt, capabilityCodesJson: prior.capabilityCodesJson, proposedByUserId: ctx.user.id, supersedesSourceRef: prior.sourceRef,
      });
      await audit(db, ctx.user.id, "academy_source", sourceRef, "source.version_proposed", { supersedes: prior.sourceRef, edition: input.edition, url: input.sourceUrl, contentHash: input.contentHash ?? null });
      return { sourceRef, reviewStatus: "unreviewed" as const, notice: "Unreviewed. Nothing uses it until two people have reviewed it; the prior version stays exactly as it was." };
    }),

  /** 0174 — what a source governs. Nothing is rewritten; each item is told the source's status. */
  sourceImpact: roleProcedure("academy.sourceImpact").input(z.object({ sourceRef: z.string().min(1).max(96) }).strict()).query(async ({ input }) => {
    const db = await dbOrThrow();
    const src = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, input.sourceRef)).limit(1))[0];
    if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Source not found" });
    return { sourceRef: src.sourceRef, reviewStatus: src.reviewStatus, impactStatus: impactStatus(src.reviewStatus), supersededBySourceRef: src.supersededBySourceRef, ...(await sourceImpactOf(db, src.sourceRef)) };
  }),

  certificateIssue: roleProcedure("academy.certificateIssue")
    .input(z.object({
      assignmentRef: z.string().min(1).max(96),
      companyValidityMonths: z.number().int().min(1).max(120).nullable().optional(),
      attestationStatement: z.string().min(20).max(2000).nullable().optional(),
      attestationConfirmed: z.boolean().optional(),
      employerSignature: z.object({
        signerRole: z.string().min(2).max(160),
        method: z.enum(["drawn", "electronic_ack", "paper_scan"]),
        evidenceRecordId: z.number().int().positive().nullable().optional(),
        capturedOffline: z.boolean().default(false),
      }).strict().optional(),
      statementOfExperienceRef: z.string().min(1).max(96).nullable().optional(),
      employerName: z.string().min(2).max(220).nullable().optional(),
      employerBusinessAddress: z.string().min(5).max(500).nullable().optional(),
      /** Company (non-regulated) certificates only. For a regulated TDG certificate the aspects are DERIVED from approved course coverage and this field is refused. */
      trainingAspects: z.array(z.string().min(2).max(500)).min(1).max(100).nullable().optional(),
      /** s.6.3(1)(d) — the dangerous-goods scope being certified, e.g. "Class 3, Flammable Liquids". Required for a TDG employer certificate. */
      dangerousGoodsScope: z.string().min(2).max(300).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assignmentByRef(db, input.assignmentRef);
      const { course, version } = await versionBundle(db, a.courseVersionId);
      const passed = !!(await db.select({ id: academyAssessmentAttempts.id }).from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.courseVersionId, a.courseVersionId), eq(academyAssessmentAttempts.status, "passed"), eq(academyAssessmentAttempts.assessmentKind, "FINAL_INTERNAL"))).limit(1))[0];
      const evalRow = (await db.select().from(academyPracticalEvaluations).where(and(eq(academyPracticalEvaluations.assignmentId, a.id), eq(academyPracticalEvaluations.courseVersionId, a.courseVersionId))).orderBy(desc(academyPracticalEvaluations.id)).limit(1))[0] ?? null;
      const p = practicalGate({ requiresPractical: course.requiresPractical, courseVersionId: a.courseVersionId, evaluation: evalRow ? { status: evalRow.status, courseVersionId: evalRow.courseVersionId } : null });
      const source = version.sourceSnapshotRef ? (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, version.sourceSnapshotRef)).limit(1))[0] : null;
      const decision = certificateDecision({ credentialBoundary: course.credentialBoundary, courseVersionId: version.id, assignmentCourseVersionId: a.courseVersionId, assessmentPassed: passed, practicalReady: p.ready, sourceSnapshotRef: version.sourceSnapshotRef, sourceReviewStatus: source?.reviewStatus ?? null, sourceTier: source?.sourceTier ?? null });
      if (!decision.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.blockers.join("; ") });
      if (course.credentialBoundary !== "employer_certificate" && course.credentialBoundary !== "company_certificate") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This course boundary cannot issue a LeaseOS certificate" });
      const qualificationCode = course.externalCredentialCode;
      if (!qualificationCode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Course has no qualification code" });
      const learner = (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, a.userId)).limit(1))[0];
      if (!learner?.name?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Certificate issuance requires the employee name to be present on the authenticated user record" });
      // 0123 — for a regulated TDG certificate the s.6.3(1)(d) aspects are derived
      // from the course version's APPROVED s.6.2 topic coverage. There is no path
      // from client text to the aspects printed on the certificate.
      let derivedAspects: string[] | null = null;
      if (course.credentialBoundary === "employer_certificate" && qualificationCode === "TDG_ROAD") {
        if (input.trainingAspects?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "A regulated TDG certificate does not accept typed training aspects; they are derived from the course version's approved s.6.2 topic coverage" });
        if (!input.employerName?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TDG certificate requires the employer name" });
        if (!input.employerBusinessAddress?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TDG certificate requires the employer place-of-business address" });
        if (!input.dangerousGoodsScope?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "s.6.3(1)(d): TDG certificate requires the dangerous-goods scope being certified" });
        const coverage = await coverageRowFor(db, version.id);
        const gate = canIssueCertificateFromCoverage(coverage, "road");
        if (!gate.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${gate.code}: ${gate.message}` });
        const derived = deriveTrainingAspects({ courseVersionRef: version.versionRef, coveredTopicCodes: gate.topicCodes, dangerousGoodsScope: input.dangerousGoodsScope, mode: gate.mode });
        if (!derived.aspects) throw new TRPCError({ code: "PRECONDITION_FAILED", message: derived.blockers.join("; ") });
        const contents = certificateContentDecision({ regulated: true, credentialBoundary: "employer_certificate", contents: {
          employerName: input.employerName, employerBusinessAddress: input.employerBusinessAddress, employeeName: learner.name,
          // Expiry is computed below from the versioned regulatory profile; the content gate needs only to know one will exist.
          expiresAt: new Date(0), trainingAspects: derived.aspects,
        } });
        if (!contents.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: contents.blockers.join("; ") });
        derivedAspects = [derived.aspects.statement, ...derived.aspects.topicCodes.map((c) => { const t = TDG_6_2_TOPICS.find(x => x.code === c)!; return `${t.ref}: ${t.label}`; })];
      }
      const existing = (await db.select().from(academyCertificates).where(and(eq(academyCertificates.assignmentId, a.id), eq(academyCertificates.courseVersionId, a.courseVersionId))).orderBy(desc(academyCertificates.id)).limit(1))[0];
      if (existing && existing.status !== "revoked" && !existing.revokedAt) return { certificateRef: existing.certificateRef, qualificationCode: existing.qualificationCode, status: existing.status, reused: true };

      const issuedAt = new Date();
      let profileRow = course.credentialBoundary === "employer_certificate"
        ? (await db.select().from(academyRegulatoryProfiles).where(and(eq(academyRegulatoryProfiles.qualificationCode, qualificationCode), eq(academyRegulatoryProfiles.credentialBoundary, "employer_certificate"))).orderBy(desc(academyRegulatoryProfiles.profileVersion)).limit(1))[0] ?? null
        : null;
      if (course.credentialBoundary === "employer_certificate" && !profileRow) {
        await synchronizeCatalog(db, ctx.user.id);
        profileRow = (await db.select().from(academyRegulatoryProfiles).where(and(eq(academyRegulatoryProfiles.qualificationCode, qualificationCode), eq(academyRegulatoryProfiles.credentialBoundary, "employer_certificate"))).orderBy(desc(academyRegulatoryProfiles.profileVersion)).limit(1))[0] ?? null;
      }
      const profileSeed = profileRow ? ACADEMY_REGULATORY_PROFILES.find(x => x.profileRef === profileRow!.profileRef) ?? null : null;
      if (profileRow && (!profileSeed || regulatoryProfileHash(profileSeed) !== profileRow.profileHash)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Regulatory issuance profile is missing or its version hash does not match the installed profile" });
      const terms = certificateTerms({ issuedAt, credentialBoundary: course.credentialBoundary, profile: profileSeed, callerSuppliedExpiry: null, companyValidityMonths: input.companyValidityMonths ?? null });
      if (!terms.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: terms.blockers.join("; ") });
      if (course.credentialBoundary === "employer_certificate" && input.companyValidityMonths != null) throw new TRPCError({ code: "BAD_REQUEST", message: "Employer/regulated certificate expiry is computed from its versioned regulatory profile; companyValidityMonths is not accepted" });

      const requiresAttestation = !!profileSeed?.requiresReasonableGroundsAttestation;
      if (requiresAttestation) {
        if (input.attestationConfirmed !== true || input.attestationStatement !== TDG_REASONABLE_GROUNDS_ATTESTATION) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A non-defaulted employer reasonable-grounds attestation must be explicitly confirmed for TDG certificate issuance" });
        if (!input.employerSignature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Employer representative signature is required for TDG certificate issuance" });
      }
      if (profileSeed?.requiresEmployerSignature && !input.employerSignature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Employer representative signature is required by the regulatory profile" });
      if (input.employerSignature?.method === "paper_scan" && !input.employerSignature.evidenceRecordId) throw new TRPCError({ code: "BAD_REQUEST", message: "Paper-scan employer signature requires an evidence record" });

      let experienceRow: typeof academyStatementsOfExperience.$inferSelect | null = null;
      if (input.statementOfExperienceRef) {
        experienceRow = (await db.select().from(academyStatementsOfExperience).where(eq(academyStatementsOfExperience.statementRef, input.statementOfExperienceRef)).limit(1))[0] ?? null;
        if (!experienceRow) throw new TRPCError({ code: "NOT_FOUND", message: "Statement of experience not found" });
        if (experienceRow.userId !== a.userId || experienceRow.qualificationCode !== qualificationCode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Statement of experience does not belong to this learner/qualification" });
      }

      const certificateRef = ref("ACAD-CERT");
      const policySnapshotHash = stableHash(version.policyJson);
      const provisionalPayload = { certificateRef, userId: a.userId, employeeNameSnapshot: learner.name, employerNameSnapshot: input.employerName ?? null, employerBusinessAddressSnapshot: input.employerBusinessAddress ?? null, trainingAspects: derivedAspects ?? input.trainingAspects ?? null, courseId: course.id, courseVersionId: version.id, assignmentRef: a.assignmentRef, qualificationCode, credentialBoundary: course.credentialBoundary, issuedAt: issuedAt.toISOString(), expiresAt: terms.expiresAt?.toISOString() ?? null, retentionUntil: terms.retentionUntil?.toISOString() ?? null, sourceSnapshotRef: version.sourceSnapshotRef, sourceHash: source?.snapshotHash ?? null, sourceTier: source?.sourceTier ?? null, regulatoryProfileRef: profileRow?.profileRef ?? null, regulatoryProfileHash: profileRow?.profileHash ?? null, statementOfExperienceHash: experienceRow?.payloadHash ?? null, attestationStatement: requiresAttestation ? input.attestationStatement : null, policySnapshotHash };
      const provisionalHash = stableHash(provisionalPayload);
      const needsEmployeeSignature = !!profileSeed?.requiresEmployeeSignature;
      const needsEmployerSignature = !!profileSeed?.requiresEmployerSignature;
      const status = needsEmployeeSignature ? "pending_signature" as const : "active" as const;
      const ins = await db.insert(academyCertificates).values({ certificateRef, userId: a.userId, courseId: course.id, courseVersionId: version.id, assignmentId: a.id, qualificationCode, credentialBoundary: course.credentialBoundary, status, issuedByUserId: ctx.user.id, employeeNameSnapshot: learner.name, employerNameSnapshot: input.employerName ?? null, employerBusinessAddressSnapshot: input.employerBusinessAddress ?? null, trainingAspectsJson: derivedAspects ?? input.trainingAspects ? JSON.stringify(input.trainingAspects) : null, issuedAt, finalizedAt: status === "active" ? issuedAt : null, expiresAt: terms.expiresAt, retentionUntil: terms.retentionUntil, sourceSnapshotRef: version.sourceSnapshotRef!, regulatoryProfileRef: profileRow?.profileRef ?? null, regulatoryProfileHash: profileRow?.profileHash ?? null, statementOfExperienceId: experienceRow?.id ?? null, attestationStatement: requiresAttestation ? input.attestationStatement! : null, attestedAt: requiresAttestation ? issuedAt : null, policySnapshotHash, certificateHash: provisionalHash });
      const certificateId = Number(ins[0]?.insertId ?? 0);

      let employerSignatureHash: string | null = null;
      if (needsEmployerSignature && input.employerSignature) {
        const signedAt = new Date();
        employerSignatureHash = stableHash({ certificateRef, certificatePayloadHash: provisionalHash, signerParty: "employer_representative", signerUserId: ctx.user.id, signerName: ctx.user.name ?? `User ${ctx.user.id}`, signerRole: input.employerSignature.signerRole, signatureMethod: input.employerSignature.method, evidenceRecordId: input.employerSignature.evidenceRecordId ?? null, signedAt: signedAt.toISOString(), capturedOffline: input.employerSignature.capturedOffline });
        await db.insert(academyCertificateSignatures).values({ signatureRef: ref("ACAD-SIG"), certificateId, signerUserId: ctx.user.id, signerParty: "employer_representative", signerName: ctx.user.name ?? `User ${ctx.user.id}`, signerRole: input.employerSignature.signerRole, signatureMethod: input.employerSignature.method, signatureEvidenceRecordId: input.employerSignature.evidenceRecordId ?? null, payloadHash: employerSignatureHash, signedAt, capturedOffline: input.employerSignature.capturedOffline });
      }

      const qualificationRef = ref("ACAD-QUAL");
      await db.insert(academyQualifications).values({ qualificationRef, userId: a.userId, qualificationCode, sourceKind: course.credentialBoundary === "company_certificate" ? "company_signoff" : "academy_certificate", status: status === "active" ? "current" : "pending", courseVersionId: version.id, certificateId, validFrom: status === "active" ? issuedAt : null, expiresAt: terms.expiresAt, verifiedByUserId: status === "active" ? ctx.user.id : null, verifiedAt: status === "active" ? issuedAt : null, scopeJson: JSON.stringify({ courseCode: course.courseCode, versionRef: version.versionRef, regulatoryProfileRef: profileRow?.profileRef ?? null }) });
      let finalHash = provisionalHash;
      if (status === "active") {
        finalHash = stableHash({ provisionalHash, employerSignatureHash, employeeSignatureHash: null, finalizedAt: issuedAt.toISOString() });
        await db.update(academyCertificates).set({ certificateHash: finalHash }).where(eq(academyCertificates.id, certificateId));
      }
      await audit(db, ctx.user.id, "academy_certificate", certificateRef, status === "active" ? "certificate.issued_active" : "certificate.pending_employee_signature", { userId: a.userId, assignmentRef: a.assignmentRef, qualificationRef, qualificationCode, courseVersionId: version.id, sourceSnapshotRef: version.sourceSnapshotRef, regulatoryProfileRef: profileRow?.profileRef ?? null, expiresAt: terms.expiresAt, retentionUntil: terms.retentionUntil, certificateHash: finalHash });
      return { certificateRef, qualificationRef, qualificationCode, status, expiresAt: terms.expiresAt, retentionUntil: terms.retentionUntil, employeeSignatureRequired: needsEmployeeSignature, reused: false };
    }),

  certificateSignOwn: roleProcedure("academy.certificateSignOwn")
    .input(z.object({ certificateRef: z.string().min(1).max(96), method: z.enum(["drawn", "electronic_ack", "paper_scan"]), evidenceRecordId: z.number().int().positive().nullable().optional(), capturedOffline: z.boolean().default(false) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const c = (await db.select().from(academyCertificates).where(eq(academyCertificates.certificateRef, input.certificateRef)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Certificate not found" });
      if (c.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the employee named on the certificate may provide the employee signature" });
      if (c.status === "revoked" || c.revokedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Revoked certificate cannot be signed" });
      if (c.status === "active") return { certificateRef: c.certificateRef, status: "active" as const, alreadyFinal: true };
      if (input.method === "paper_scan" && !input.evidenceRecordId) throw new TRPCError({ code: "BAD_REQUEST", message: "Paper-scan employee signature requires an evidence record" });
      const existing = (await db.select().from(academyCertificateSignatures).where(and(eq(academyCertificateSignatures.certificateId, c.id), eq(academyCertificateSignatures.signerParty, "employee"))).limit(1))[0];
      if (existing && !existing.invalidatedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Employee signature is already recorded for this certificate" });
      const signedAt = new Date();
      const employeeSignatureHash = stableHash({ certificateRef: c.certificateRef, certificatePayloadHash: c.certificateHash, signerParty: "employee", signerUserId: ctx.user.id, signerName: ctx.user.name ?? `User ${ctx.user.id}`, signerRole: "employee", signatureMethod: input.method, evidenceRecordId: input.evidenceRecordId ?? null, signedAt: signedAt.toISOString(), capturedOffline: input.capturedOffline });
      await db.insert(academyCertificateSignatures).values({ signatureRef: ref("ACAD-SIG"), certificateId: c.id, signerUserId: ctx.user.id, signerParty: "employee", signerName: ctx.user.name ?? `User ${ctx.user.id}`, signerRole: "employee", signatureMethod: input.method, signatureEvidenceRecordId: input.evidenceRecordId ?? null, payloadHash: employeeSignatureHash, signedAt, capturedOffline: input.capturedOffline });
      const signatures = await db.select().from(academyCertificateSignatures).where(eq(academyCertificateSignatures.certificateId, c.id));
      const employee = signatures.find(x => x.signerParty === "employee" && !x.invalidatedAt) ?? null;
      const employer = signatures.find(x => x.signerParty === "employer_representative" && !x.invalidatedAt) ?? null;
      const profile = c.regulatoryProfileRef ? (await db.select().from(academyRegulatoryProfiles).where(eq(academyRegulatoryProfiles.profileRef, c.regulatoryProfileRef)).limit(1))[0] ?? null : null;
      const finalization = certificateFinalizationDecision({ requiresEmployeeSignature: !!profile?.requiresEmployeeSignature, requiresEmployerSignature: !!profile?.requiresEmployerSignature, employeeSignaturePresent: !!employee, employerSignaturePresent: !!employer, attestationRequired: !!profile?.requiresReasonableGroundsAttestation, attestationPresent: !!c.attestationStatement && !!c.attestedAt });
      if (!finalization.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: finalization.blockers.join("; ") });
      const finalizedAt = new Date();
      const finalHash = stableHash({ provisionalHash: c.certificateHash, employeeSignatureHash: employee?.payloadHash ?? null, employerSignatureHash: employer?.payloadHash ?? null, finalizedAt: finalizedAt.toISOString() });
      await db.update(academyCertificates).set({ status: "active", finalizedAt, certificateHash: finalHash }).where(eq(academyCertificates.id, c.id));
      await db.update(academyQualifications).set({ status: "current", validFrom: c.issuedAt, expiresAt: c.expiresAt, verifiedByUserId: c.issuedByUserId, verifiedAt: finalizedAt }).where(eq(academyQualifications.certificateId, c.id));
      await audit(db, ctx.user.id, "academy_certificate", c.certificateRef, "certificate.employee_signed_and_activated", { employeeSignatureHash: employee?.payloadHash, employerSignatureHash: employer?.payloadHash, finalHash, finalizedAt });
      return { certificateRef: c.certificateRef, status: "active" as const, finalizedAt, certificateHash: finalHash, alreadyFinal: false };
    }),

  statementOfExperienceCreate: roleProcedure("academy.statementOfExperienceCreate")
    .input(z.object({ userId: z.number().int().positive(), qualificationCode: z.string().min(2).max(100), experienceFrom: z.coerce.date(), experienceTo: z.coerce.date(), duties: z.array(z.string().min(2).max(500)).min(1).max(100), dangerousGoodsScope: z.record(z.string(), z.unknown()).nullable().optional(), employerAttestation: z.string().min(20).max(2000), sourceCertificateRef: z.string().min(1).max(96).nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant); otherwise not found.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await userInScope(input.userId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const db = await dbOrThrow();
      if (!(input.experienceTo > input.experienceFrom)) throw new TRPCError({ code: "BAD_REQUEST", message: "Statement of experience requires a valid experience start/end period" });
      let sourceCertificateId: number | null = null;
      if (input.sourceCertificateRef) {
        const c = (await db.select().from(academyCertificates).where(eq(academyCertificates.certificateRef, input.sourceCertificateRef)).limit(1))[0];
        if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Source certificate not found" });
        if (c.userId !== input.userId || c.qualificationCode !== input.qualificationCode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source certificate does not match the employee/qualification on the statement of experience" });
        sourceCertificateId = c.id;
      }
      const statementRef = ref("ACAD-EXP");
      const payloadHash = stableHash({ statementRef, userId: input.userId, qualificationCode: input.qualificationCode, experienceFrom: input.experienceFrom.toISOString(), experienceTo: input.experienceTo.toISOString(), duties: input.duties, dangerousGoodsScope: input.dangerousGoodsScope ?? null, preparedByUserId: ctx.user.id, employerAttestation: input.employerAttestation, sourceCertificateId });
      await db.insert(academyStatementsOfExperience).values({ statementRef, userId: input.userId, qualificationCode: input.qualificationCode, experienceFrom: input.experienceFrom, experienceTo: input.experienceTo, dutiesJson: JSON.stringify(input.duties), dangerousGoodsScopeJson: input.dangerousGoodsScope ? JSON.stringify(input.dangerousGoodsScope) : null, preparedByUserId: ctx.user.id, employerAttestation: input.employerAttestation, sourceCertificateId, payloadHash });
      await audit(db, ctx.user.id, "academy_experience", statementRef, "statement_of_experience.created", { userId: input.userId, qualificationCode: input.qualificationCode, experienceFrom: input.experienceFrom, experienceTo: input.experienceTo, payloadHash });
      return { statementRef, payloadHash };
    }),

  foreignTdgRoadRecognize: roleProcedure("academy.foreignTdgRoadRecognize")
    .input(z.object({ userId: z.number().int().positive(), complianceDocumentId: z.number().int().positive(), issuingJurisdiction: z.literal("US"), vehicleLicenceJurisdiction: z.literal("US"), trainingStandard: z.string().min(10).max(300), documentValidInIssuingJurisdiction: z.boolean(), expiresAt: z.coerce.date(), issuedAt: z.coerce.date().nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant); otherwise not found.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await userInScope(input.userId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const db = await dbOrThrow();
      const document = (await db.select().from(complianceDocuments).where(eq(complianceDocuments.id, input.complianceDocumentId)).limit(1))[0];
      if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "Foreign TDG compliance document not found" });
      if (document.verificationStatus !== "verified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Foreign TDG recognition requires a verified compliance document" });
      if (document.ownerType !== "user" || document.ownerId !== input.userId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Foreign TDG compliance document does not belong to the selected user" });
      if (!document.expiresAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Foreign TDG recognition requires a verified document expiry" });
      if (document.expiresAt.getTime() !== input.expiresAt.getTime()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Foreign TDG expiry must match the verified compliance document" });
      const d = foreignTdgRoadCertificateDecision({ issuingJurisdiction: input.issuingJurisdiction, vehicleLicenceJurisdiction: input.vehicleLicenceJurisdiction, trainingStandard: input.trainingStandard, documentValidInIssuingJurisdiction: input.documentValidInIssuingJurisdiction, expiresAt: input.expiresAt });
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.blockers.join("; ") });
      const qualificationRef = ref("ACAD-QUAL");
      await db.insert(academyQualifications).values({ qualificationRef, userId: input.userId, qualificationCode: "TDG_ROAD", sourceKind: "external_credential", status: "current", complianceDocumentId: input.complianceDocumentId, validFrom: input.issuedAt ?? new Date(), expiresAt: input.expiresAt, verifiedByUserId: ctx.user.id, verifiedAt: new Date(), scopeJson: JSON.stringify({ recognition: "TDG_6.4_US_ROAD", trainingStandard: input.trainingStandard, issuingJurisdiction: input.issuingJurisdiction, vehicleLicenceJurisdiction: input.vehicleLicenceJurisdiction }) });
      await audit(db, ctx.user.id, "academy_qualification", qualificationRef, "foreign_tdg_road.recognized", { userId: input.userId, complianceDocumentId: input.complianceDocumentId, expiresAt: input.expiresAt, standard: input.trainingStandard });
      return { qualificationRef, qualificationCode: "TDG_ROAD" as const, status: "current" as const, expiresAt: input.expiresAt, recognition: "TDG_6.4_US_ROAD" as const };
    }),

  requirementList: roleProcedure("academy.requirementList").query(async () => {
    const db = await dbOrThrow();
    return { requirements: await db.select().from(academyRequirements).where(eq(academyRequirements.active, true)) };
  }),

  requirementUpsert: roleProcedure("academy.requirementUpsert")
    .input(z.object({ requirementCode: z.string().min(2).max(100), title: z.string().min(2).max(240), qualificationCode: z.string().min(2).max(100), enforcement: z.enum(["block", "review", "inform"]), recoveryPath: z.string().max(500).nullable().optional(), conditions: z.record(z.string(), z.unknown()).nullable().optional(), binding: z.object({ subjectType: z.enum(["role", "equipment", "job_type", "customer", "site", "jurisdiction", "cargo"]), subjectCode: z.string().min(1).max(160), conditions: z.record(z.string(), z.unknown()).nullable().optional() }).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      let r = (await db.select().from(academyRequirements).where(eq(academyRequirements.requirementCode, input.requirementCode)).limit(1))[0];
      if (r) await db.update(academyRequirements).set({ title: input.title, qualificationCode: input.qualificationCode, enforcement: input.enforcement, recoveryPath: input.recoveryPath ?? null, conditionsJson: input.conditions ? JSON.stringify(input.conditions) : null, active: true }).where(eq(academyRequirements.id, r.id));
      else { const ins = await db.insert(academyRequirements).values({ requirementCode: input.requirementCode, title: input.title, qualificationCode: input.qualificationCode, enforcement: input.enforcement, recoveryPath: input.recoveryPath ?? null, conditionsJson: input.conditions ? JSON.stringify(input.conditions) : null, active: true, createdByUserId: ctx.user.id }); const id = Number(ins[0]?.insertId ?? 0); r = (await db.select().from(academyRequirements).where(eq(academyRequirements.id, id)).limit(1))[0]; }
      if (!r) throw new Error("Requirement upsert failed");
      if (input.binding) await db.insert(academyRequirementBindings).values({ bindingRef: ref("ACAD-BIND"), requirementId: r.id, subjectType: input.binding.subjectType, subjectCode: input.binding.subjectCode, conditionsJson: input.binding.conditions ? JSON.stringify(input.binding.conditions) : null, active: true });
      await audit(db, ctx.user.id, "academy_requirement", r.requirementCode, "requirement.upserted", { qualificationCode: r.qualificationCode, enforcement: r.enforcement, binding: input.binding ?? null });
      return { requirementCode: r.requirementCode, active: true };
    }),

  directSupervisionCreate: roleProcedure("academy.directSupervisionCreate")
    .input(z.object({ traineeUserId: z.number().int().positive(), supervisorUserId: z.number().int().positive(), jobId: z.number().int().positive(), qualificationCode: z.string().min(2).max(100), scope: z.record(z.string(), z.unknown()), startsAt: z.coerce.date(), endsAt: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant); otherwise not found.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await userInScope(input.traineeUserId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Trainee ${input.traineeUserId} not found` });
      if (!(await userInScope(input.supervisorUserId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Supervisor ${input.supervisorUserId} not found` });
      const db = await dbOrThrow();
      const q = (await db.select().from(academyQualifications).where(and(eq(academyQualifications.userId, input.supervisorUserId), eq(academyQualifications.qualificationCode, input.qualificationCode), eq(academyQualifications.status, "current"))).orderBy(desc(academyQualifications.id)).limit(1))[0];
      const pre = directSupervisionDecision({ traineeUserId: input.traineeUserId, supervisorUserId: input.supervisorUserId, supervisorQualificationStatus: q?.status ?? "pending", supervisorQualificationCode: q?.qualificationCode ?? "", requiredQualificationCode: input.qualificationCode, physicalPresenceAttested: false, startsAt: input.startsAt, endsAt: input.endsAt, jobId: input.jobId, scope: JSON.stringify(input.scope) });
      const structural = pre.blockers.filter(x => !x.startsWith("Direct supervision requires physical presence"));
      if (structural.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: structural.join("; ") });
      if (!q) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Supervisor has no current matching Academy qualification" });
      const supervisionRef = ref("ACAD-SUP");
      await db.insert(academyDirectSupervisionRecords).values({ supervisionRef, traineeUserId: input.traineeUserId, supervisorUserId: input.supervisorUserId, jobId: input.jobId, qualificationCode: input.qualificationCode, supervisorQualificationId: q.id, scopeJson: JSON.stringify(input.scope), startsAt: input.startsAt, endsAt: input.endsAt, physicalPresenceAttested: false, status: "planned" });
      await audit(db, ctx.user.id, "academy_supervision", supervisionRef, "supervision.planned", { ...input, physicalPresenceAttested: false });
      return { supervisionRef, status: "planned" as const, warning: "Not valid for dispatch until the named qualified supervisor personally attests physical presence." };
    }),

  directSupervisionAttest: roleProcedure("academy.directSupervisionAttest")
    .input(z.object({ supervisionRef: z.string().min(1).max(96), physicalPresenceAttested: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const s = (await db.select().from(academyDirectSupervisionRecords).where(eq(academyDirectSupervisionRecords.supervisionRef, input.supervisionRef)).limit(1))[0];
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Direct-supervision record not found" });
      if (s.supervisorUserId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the named supervisor may attest their own physical presence" });
      const q = (await db.select().from(academyQualifications).where(eq(academyQualifications.id, s.supervisorQualificationId)).limit(1))[0];
      const d = directSupervisionDecision({ traineeUserId: s.traineeUserId, supervisorUserId: s.supervisorUserId, supervisorQualificationStatus: q?.status ?? "pending", supervisorQualificationCode: q?.qualificationCode ?? "", requiredQualificationCode: s.qualificationCode, physicalPresenceAttested: true, startsAt: s.startsAt, endsAt: s.endsAt, jobId: s.jobId, scope: s.scopeJson });
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.blockers.join("; ") });
      await db.update(academyDirectSupervisionRecords).set({ physicalPresenceAttested: true, attestedByUserId: ctx.user.id, attestedAt: new Date(), status: "active" }).where(eq(academyDirectSupervisionRecords.id, s.id));
      await audit(db, ctx.user.id, "academy_supervision", s.supervisionRef, "supervision.physical_presence_attested", { traineeUserId: s.traineeUserId, supervisorUserId: s.supervisorUserId, jobId: s.jobId, qualificationCode: s.qualificationCode, startsAt: s.startsAt, endsAt: s.endsAt });
      return { supervisionRef: s.supervisionRef, status: "active" as const };
    }),

  /* ---- 0123: s.6.2 topic coverage — authored per module, declared per version, approved by a second person ---- */

  /** Author the mapping. Nothing is pre-selected; a human reading the material decides. Any edit returns the version to draft. */
  tdgCoverageSet: roleProcedure("academy.tdgCoverageSet")
    .input(z.object({
      courseVersionRef: z.string().min(1).max(96),
      tdgMode: z.enum(["road", "rail", "vessel", "air"]),
      modules: z.array(z.object({ moduleCode: z.string().min(1).max(80), topicCodes: z.array(z.string().min(1).max(40)).max(13) })).min(1).max(60),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const v = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.versionRef, input.courseVersionRef)).limit(1))[0];
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Course version not found" });
      const mods = await db.select().from(academyModules).where(eq(academyModules.courseVersionId, v.id));
      const byCode = new Map(mods.map(m => [m.moduleCode, m]));
      const union = new Set<Tdg62TopicCode>();
      for (const m of input.modules) {
        const row = byCode.get(m.moduleCode);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `Module ${m.moduleCode} is not part of ${input.courseVersionRef}` });
        if (m.topicCodes.length) {
          const parsed = parseTopicCodes(m.topicCodes);
          if (!parsed.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `${m.moduleCode}: ${parsed.reason}` });
          for (const c of parsed.codes) union.add(c);
        }
        await db.update(academyModules).set({ tdgTopicCodesJson: m.topicCodes.length ? JSON.stringify(m.topicCodes) : null }).where(eq(academyModules.id, row.id));
      }
      const declared = Array.from(union).sort();
      const coverageHash = declared.length ? coverageFingerprint(input.tdgMode as TdgMode, declared) : null;
      // Every edit is a new draft. A previous approval does not survive a change of mapping — the fingerprint sees to that.
      await db.update(academyCourseVersions).set({ tdgMode: input.tdgMode, tdgTopicCodesJson: declared.length ? JSON.stringify(declared) : null, tdgTopicReviewStatus: declared.length ? "draft" : "unmapped", tdgTopicCoverageHash: coverageHash, tdgTopicAuthoredByUserId: ctx.user.id }).where(eq(academyCourseVersions.id, v.id));
      await audit(db, ctx.user.id, "academy_course_version", v.versionRef, "tdg_coverage.authored", { tdgMode: input.tdgMode, declared, coverageHash });
      const reconciled = reconcileCoverage(await coverageRowFor(db, v.id));
      return { courseVersionRef: v.versionRef, declared, coverageHash, reviewStatus: declared.length ? "draft" : "unmapped", reconciled: reconciled.ok, reconciliation: reconciled.ok ? null : `${reconciled.code}: ${reconciled.message}` };
    }),

  /** Approve the mapping. A second person, binding to the exact fingerprint, after reconciliation passes. */
  tdgCoverageApprove: roleProcedure("academy.tdgCoverageApprove")
    .input(z.object({ courseVersionRef: z.string().min(1).max(96), attestReadCourseMaterial: z.literal(true) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const v = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.versionRef, input.courseVersionRef)).limit(1))[0];
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Course version not found" });
      if (v.tdgTopicAuthoredByUserId != null && v.tdgTopicAuthoredByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who authored the coverage mapping does not approve it — a second person does" });
      const row = await coverageRowFor(db, v.id);
      const reconciled = reconcileCoverage(row);
      if (!reconciled.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${reconciled.code}: ${reconciled.message}` });
      if (!v.tdgMode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TDG_MODE_UNSET: set the transport mode before approving coverage" });
      const fingerprint = coverageFingerprint(v.tdgMode, reconciled.declared);
      await db.update(academyCourseVersions).set({ tdgTopicReviewStatus: "approved", tdgTopicCoverageHash: fingerprint, tdgTopicReviewedHash: fingerprint, tdgTopicReviewedByUserId: ctx.user.id, tdgTopicReviewedAt: new Date() }).where(eq(academyCourseVersions.id, v.id));
      await audit(db, ctx.user.id, "academy_course_version", v.versionRef, "tdg_coverage.approved", { fingerprint, declared: reconciled.declared });
      return { courseVersionRef: v.versionRef, reviewStatus: "approved" as const, fingerprint, topicCodes: reconciled.declared };
    }),

  /** What a version's coverage currently supports, with the exact refusal code if it cannot issue. */
  tdgCoverageStatus: roleProcedure("academy.tdgCoverageStatus")
    .input(z.object({ courseVersionRef: z.string().min(1).max(96) }).strict())
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const v = (await db.select({ id: academyCourseVersions.id, tdgMode: academyCourseVersions.tdgMode }).from(academyCourseVersions).where(eq(academyCourseVersions.versionRef, input.courseVersionRef)).limit(1))[0];
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Course version not found" });
      const row = await coverageRowFor(db, v.id);
      const gate = canIssueCertificateFromCoverage(row, (v.tdgMode ?? "road") as TdgMode);
      return { reviewStatus: row.reviewStatus, tdgMode: row.tdgMode, canIssue: gate.ok, refusal: gate.ok ? null : { code: gate.code, message: gate.message }, topics: TDG_6_2_TOPICS.map(t => ({ ref: t.ref, code: t.code, label: t.label })) };
    }),

  /* ---- 0122: inspector requests — s.6.7, fifteen days ---- */

  inspectorRequestCreate: roleProcedure("academy.inspectorRequestCreate")
    .input(z.object({
      certificateRef: z.string().min(1).max(96), issuingAuthority: z.string().min(2).max(220), inspectorName: z.string().max(220).nullable().optional(),
      authorityFileRef: z.string().max(120).nullable().optional(), requestDatedAt: z.coerce.date(), requestReceivedAt: z.coerce.date().nullable().optional(), notes: z.string().max(2000).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const cert = (await db.select().from(academyCertificates).where(eq(academyCertificates.certificateRef, input.certificateRef)).limit(1))[0];
      if (!cert) throw new TRPCError({ code: "NOT_FOUND", message: "Certificate not found" });
      const requestRef = ref("ACAD-INSP");
      const req = { requestRef, requestDatedAt: input.requestDatedAt, requestReceivedAt: input.requestReceivedAt ?? null, subjectUserId: cert.userId, certificateRef: cert.certificateRef };
      const deadline = responseDeadline(req, new Date());
      await db.insert(academyInspectorRequests).values({ requestRef, inspectorName: input.inspectorName ?? null, issuingAuthority: input.issuingAuthority, authorityFileRef: input.authorityFileRef ?? null, requestDatedAt: input.requestDatedAt, requestReceivedAt: input.requestReceivedAt ?? null, dueAt: deadline.dueAt, subjectUserId: cert.userId, certificateId: cert.id, notes: input.notes ?? null });
      await audit(db, ctx.user.id, "academy_inspector_request", requestRef, "inspector_request.received", { certificateRef: cert.certificateRef, dueAt: deadline.dueAt.toISOString(), anchoredOn: deadline.anchoredOn });
      return { requestRef, dueAt: deadline.dueAt, daysRemaining: deadline.daysRemaining, anchoredOn: deadline.anchoredOn, urgent: deadline.urgent };
    }),

  /** Assemble the s.6.7 package from the evidence the retention chain kept. A partial package never reports complete. */
  inspectorRequestAssemble: roleProcedure("academy.inspectorRequestAssemble")
    .input(z.object({ requestRef: z.string().min(1).max(96) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const r = (await db.select().from(academyInspectorRequests).where(eq(academyInspectorRequests.requestRef, input.requestRef)).limit(1))[0];
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Inspector request not found" });
      if (r.state === "withdrawn") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Request was withdrawn" });
      const cert = (await db.select().from(academyCertificates).where(eq(academyCertificates.id, r.certificateId)).limit(1))[0] ?? null;
      // 0172 — the record of training is the FINAL_INTERNAL attempt; practice and mock attempts are study, not a record of training.
      const attempts = cert ? await db.select({ id: academyAssessmentAttempts.id }).from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, cert.assignmentId), eq(academyAssessmentAttempts.assessmentKind, "FINAL_INTERNAL"))) : [];
      const version = cert ? (await db.select({ id: academyCourseVersions.id }).from(academyCourseVersions).where(eq(academyCourseVersions.id, cert.courseVersionId)).limit(1))[0] : null;
      const mods = version ? await db.select({ id: academyModules.id }).from(academyModules).where(eq(academyModules.courseVersionId, version.id)) : [];
      const blocks = mods.length ? await db.select({ id: academyContentBlocks.id }).from(academyContentBlocks).where(inArray(academyContentBlocks.moduleId, mods.map(m => m.id))) : [];
      // 0121 installed the chain guards; a certificate issued before that date may already have lost its material.
      const guardsInstalledAt = new Date("2026-09-16T00:00:00Z");
      const pkg = assembleInspectorPackage({
        certificatePresent: !!cert, recordOfTrainingPresent: attempts.length > 0, statementOfExperiencePresent: !!cert?.statementOfExperienceId,
        contentBlockCount: blocks.length, courseVersionPresent: !!version, predatesRetentionGuards: !!cert && cert.issuedAt < guardsInstalledAt,
      });
      const producedAt = new Date();
      // New integrity value: sha256HexV1 — see server/_core/integrityHash.ts and docs/HASH_CLASSIFICATION.md.
      // `stableHash` is a frozen legacy fingerprint and is not used for new integrity values.
      const packageHash = sha256HexV1({ requestRef: r.requestRef, certificateRef: cert?.certificateRef ?? null, parts: pkg.parts, attemptIds: attempts.map(a => a.id), blockIds: blocks.map(b => b.id), producedAt: producedAt.toISOString() });
      await db.update(academyInspectorRequests).set({ state: pkg.complete ? "produced" : "incomplete", producedAt: pkg.complete ? producedAt : null, producedByUserId: pkg.complete ? ctx.user.id : null, packageHash: pkg.complete ? packageHash : null, packagePartsJson: JSON.stringify(pkg.parts), missingPartsJson: JSON.stringify(pkg.missing), irrecoverable: pkg.irrecoverable }).where(eq(academyInspectorRequests.id, r.id));
      await audit(db, ctx.user.id, "academy_inspector_request", r.requestRef, pkg.complete ? "inspector_request.produced" : "inspector_request.incomplete", { parts: pkg.parts, missing: pkg.missing.map(m => m.code), irrecoverable: pkg.irrecoverable });
      const summary = inspectorRequestSummary({ requestRef: r.requestRef, requestDatedAt: r.requestDatedAt, requestReceivedAt: r.requestReceivedAt, subjectUserId: r.subjectUserId, certificateRef: cert?.certificateRef ?? "" }, { certificatePresent: !!cert, recordOfTrainingPresent: attempts.length > 0, statementOfExperiencePresent: !!cert?.statementOfExperienceId, contentBlockCount: blocks.length, courseVersionPresent: !!version, predatesRetentionGuards: !!cert && cert.issuedAt < guardsInstalledAt }, new Date());
      return { requestRef: r.requestRef, complete: pkg.complete, parts: pkg.parts, missing: pkg.missing, irrecoverable: pkg.irrecoverable, packageHash: pkg.complete ? packageHash : null, summary };
    }),

  /** Open requests with their deadlines — the exception-centre feed. */
  inspectorRequestList: roleProcedure("academy.inspectorRequestList")
    .query(async () => {
      const db = await dbOrThrow();
      const rows = await db.select().from(academyInspectorRequests).orderBy(academyInspectorRequests.dueAt);
      const now = new Date();
      return rows.map(r => {
        const d = responseDeadline({ requestRef: r.requestRef, requestDatedAt: r.requestDatedAt, requestReceivedAt: r.requestReceivedAt, subjectUserId: r.subjectUserId, certificateRef: String(r.certificateId) }, now);
        return { requestRef: r.requestRef, state: r.state, issuingAuthority: r.issuingAuthority, dueAt: r.dueAt, daysRemaining: d.daysRemaining, overdue: d.overdue, urgent: d.urgent, irrecoverable: r.irrecoverable, missingParts: r.missingPartsJson ? JSON.parse(r.missingPartsJson) : [] };
      });
    }),

  /* ---- 0125/0126: paper assessment sheets — minted in blocks, filed exactly once ---- */

  /** A print run: allocate serials under the row lock and register each sheet before it is printed. */
  sheetPrintRun: roleProcedure("academy.sheetPrintRun")
    .input(z.object({
      courseVersionRef: z.string().min(1).max(96),
      /** Ticket code; a code starting with P is a practice sheet and can never support a credential. */
      ticketCode: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/),
      itemSetRef: z.string().min(1).max(96),
      /** Stated at print time; an assessment sheet prints only from an approved item set. */
      itemSetReviewStatus: z.enum(["draft", "in_review", "approved", "retired"]),
      count: z.number().int().min(1).max(500),
      printBatchRef: z.string().max(64).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const v = (await db.select({ id: academyCourseVersions.id }).from(academyCourseVersions).where(eq(academyCourseVersions.versionRef, input.courseVersionRef)).limit(1))[0];
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Course version not found" });
      if (ticketClassOf(input.ticketCode) === "assessment" && input.itemSetReviewStatus !== "approved") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `ITEM_SET_NOT_APPROVED: an assessment sheet prints only from an approved item set (${input.itemSetRef} is ${input.itemSetReviewStatus})` });
      }
      if (input.itemSetReviewStatus === "retired") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ITEM_SET_RETIRED: a retired item set does not print" });
      const block = await allocateSerialBlock(db, { ticketCode: input.ticketCode, courseVersionRef: input.courseVersionRef, count: input.count, allocatedByUserId: ctx.user.id, printBatchRef: input.printBatchRef ?? null });
      await db.insert(academyAssessmentSheets).values(block.serials.map((serial) => ({
        serial, ticketCode: input.ticketCode.toUpperCase(), courseVersionRef: input.courseVersionRef, itemSetRef: input.itemSetRef,
        itemSetReviewStatus: input.itemSetReviewStatus, allocationRef: block.allocationRef, state: "issued" as const,
      })));
      await audit(db, ctx.user.id, "academy_sheet_allocation", block.allocationRef, "sheets.printed", { courseVersionRef: input.courseVersionRef, ticketCode: input.ticketCode, count: input.count, firstSequence: block.firstSequence, lastSequence: block.lastSequence });
      return { allocationRef: block.allocationRef, serials: block.serials, ticketClass: ticketClassOf(input.ticketCode) };
    }),

  /** File a returned sheet by its serial. Refused rather than filed twice; a practice sheet never becomes credential evidence. */
  sheetScanFile: roleProcedure("academy.sheetScanFile")
    .input(z.object({ serial: z.string().min(4).max(40), transcriptionRef: z.string().min(1).max(96) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const scanned = input.serial.trim().toUpperCase();
      const row = (await db.select().from(academyAssessmentSheets).where(eq(academyAssessmentSheets.serial, scanned)).limit(1))[0] ?? null;
      const outcome = resolveSheetScan({ scanned, row: row ? {
        serial: row.serial, ticketCode: row.ticketCode, courseVersionRef: row.courseVersionRef, itemSetRef: row.itemSetRef,
        itemSetReviewStatus: row.itemSetReviewStatus, courseVersionSupersededAt: row.courseVersionSupersededAt, state: row.state,
        voidedReason: row.voidedReason, transcribedAt: row.transcribedAt, transcribedByUserId: row.transcribedByUserId,
      } : null, asOf: new Date() });
      if (outcome.verdict === "reject" || !row) {
        await audit(db, ctx.user.id, "academy_sheet", scanned, "sheet.scan_refused", { code: outcome.code });
        return { filed: false as const, ...outcome };
      }
      // The transcribe-once trigger (0126) refuses a second filing even around this router.
      await db.update(academyAssessmentSheets).set({ state: "transcribed", transcribedAt: new Date(), transcribedByUserId: ctx.user.id, transcriptionRef: input.transcriptionRef }).where(eq(academyAssessmentSheets.id, row.id));
      await audit(db, ctx.user.id, "academy_sheet", scanned, "sheet.filed", { supports: outcome.supports, flags: outcome.flags, transcriptionRef: input.transcriptionRef });
      return { filed: true as const, ...outcome };
    }),

  /* ================================================================
   * 0172 — Commercial Driver Study Centre on the same engine.
   * Every procedure below is self-scoped from ctx.user.id. None of them
   * can create a certificate, a qualification or a wallet credential,
   * advance an assignment, or change dispatch readiness.
   * ================================================================ */

  studyCentre: roleProcedure("academy.studyCentre").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const seeds = ACADEMY_COURSES.filter(c => c.studyCentre);
    const courses = await db.select().from(academyCourses).where(inArray(academyCourses.courseCode, seeds.map(s => s.code)));
    const mine = await db.select({ ref: academyAssignments.assignmentRef, status: academyAssignments.status, courseVersionId: academyAssignments.courseVersionId, lastModuleCode: academyAssignments.lastModuleCode }).from(academyAssignments).where(eq(academyAssignments.userId, ctx.user.id)).limit(500);
    const versions = courses.length ? await db.select().from(academyCourseVersions).where(inArray(academyCourseVersions.courseId, courses.map(c => c.id))) : [];
    const sources = await db.select().from(academySourceRecords).limit(200);
    return seeds.map(seed => {
      const course = courses.find(c => c.courseCode === seed.code);
      const current = versions.filter(v => v.courseId === course?.id && v.status === "published").sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
      const versionIds = new Set(versions.filter(v => v.courseId === course?.id).map(v => v.id));
      const enrolment = mine.find(m => current && m.courseVersionId === current.id) ?? mine.find(m => versionIds.has(m.courseVersionId)) ?? null;
      const srcRefs = Array.from(new Set([seed.sourceRef, ...seed.modules.map(m => m.sourceRef)].filter((x): x is string => !!x)));
      return {
        courseCode: seed.code, title: seed.title, jurisdiction: seed.jurisdiction, track: seed.studyCentre!.track, boundaryNotice: seed.studyCentre!.boundaryNotice,
        credentialBoundary: seed.credentialBoundary, installed: !!course, currentVersion: current ? { ref: current.versionRef, number: current.versionNumber } : null,
        moduleCount: seed.modules.length, bankSize: seed.questions.length, mockQuestionCount: seed.practice?.mockQuestionCount ?? null,
        enrolment: enrolment ? { assignmentRef: enrolment.ref, status: enrolment.status, onCurrentVersion: enrolment.courseVersionId === current?.id, resumeModule: enrolment.lastModuleCode } : null,
        sources: srcRefs.map(r => { const s = sources.find(x => x.sourceRef === r); return { sourceRef: r, title: s?.title ?? r, edition: s?.edition ?? null, url: s?.sourceUrl ?? null, reviewStatus: s?.reviewStatus ?? "not installed" }; }),
      };
    });
  }),

  /** Open a study track for yourself. Preparation only — the enrolment is study, never a credential. */
  studyEnroll: roleProcedure("academy.studyEnroll").input(z.object({ courseCode: z.string().min(1).max(80) }).strict()).mutation(async ({ ctx, input }) => {
    const seed = ACADEMY_COURSES.find(c => c.code === input.courseCode && c.studyCentre);
    if (!seed) throw new TRPCError({ code: "NOT_FOUND", message: "Study Centre course not found" });
    const db = await dbOrThrow();
    let course = (await db.select().from(academyCourses).where(eq(academyCourses.courseCode, seed.code)).limit(1))[0];
    const hasVersion = course ? (await db.select({ id: academyCourseVersions.id }).from(academyCourseVersions).where(and(eq(academyCourseVersions.courseId, course.id), eq(academyCourseVersions.versionRef, `${seed.code}:${seed.version ?? 1}`))).limit(1))[0] : null;
    if (!course || !hasVersion) { await synchronizeCatalog(db, ctx.user.id); course = (await db.select().from(academyCourses).where(eq(academyCourses.courseCode, seed.code)).limit(1))[0]; }
    if (!course) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Course could not be installed" });
    const version = (await db.select().from(academyCourseVersions).where(and(eq(academyCourseVersions.courseId, course.id), eq(academyCourseVersions.status, "published"))).orderBy(desc(academyCourseVersions.versionNumber)).limit(1))[0];
    if (!version) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Course has no published version" });
    const existing = (await db.select().from(academyAssignments).where(and(eq(academyAssignments.userId, ctx.user.id), eq(academyAssignments.courseVersionId, version.id))).limit(1))[0];
    if (existing) return { assignmentRef: existing.assignmentRef, status: existing.status, reused: true, notice: seed.studyCentre!.boundaryNotice };
    const assignmentRef = ref("ACAD-ASG");
    await db.insert(academyAssignments).values({ assignmentRef, userId: ctx.user.id, courseVersionId: version.id, status: "assigned", assignedByUserId: ctx.user.id, selfEnrolled: true });
    await audit(db, ctx.user.id, "academy_assignment", assignmentRef, "assignment.self_enrolled", { courseCode: seed.code, versionRef: version.versionRef });
    return { assignmentRef, status: "assigned" as const, reused: false, notice: seed.studyCentre!.boundaryNotice };
  }),

  /** Save your place so you resume where you left off on any device. */
  moduleResume: roleProcedure("academy.moduleResume").input(z.object({ assignmentRef: z.string().min(1).max(96), moduleCode: z.string().min(1).max(80) }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
    const m = (await db.select({ id: academyModules.id }).from(academyModules).where(and(eq(academyModules.courseVersionId, a.courseVersionId), eq(academyModules.moduleCode, input.moduleCode))).limit(1))[0];
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Module not found in this version" });
    await db.update(academyAssignments).set({ lastModuleCode: input.moduleCode, lastViewedAt: new Date() }).where(eq(academyAssignments.id, a.id));
    return { assignmentRef: a.assignmentRef, lastModuleCode: input.moduleCode };
  }),

  /** Open a PRACTICE or MOCK_EXAM attempt on the assignment's own version. No module gate, no attempt cap. */
  practiceOpen: roleProcedure("academy.practiceOpen").input(z.object({ assignmentRef: z.string().min(1).max(96), kind: z.enum(["PRACTICE", "MOCK_EXAM"]), bookmarkedOnly: z.boolean().optional() }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
    const assessment = (await db.select().from(academyAssessments).where(and(eq(academyAssessments.courseVersionId, a.courseVersionId), eq(academyAssessments.assessmentKind, input.kind), eq(academyAssessments.active, true))).limit(1))[0];
    if (!assessment) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `No ${input.kind.toLowerCase().replace("_", " ")} exists for this course version` });
    let qrows = await db.select().from(academyQuestions).where(and(eq(academyQuestions.courseVersionId, a.courseVersionId), eq(academyQuestions.active, true)));
    if (input.bookmarkedOnly) {
      const marks = new Set((await db.select({ q: academyQuestionBookmarks.questionId }).from(academyQuestionBookmarks).where(eq(academyQuestionBookmarks.userId, ctx.user.id))).map(b => b.q));
      qrows = qrows.filter(q => marks.has(q.id));
      if (!qrows.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No bookmarked questions in this version" });
    }
    const bank: AcademyQuestion[] = qrows.map(q => ({ id: q.id, code: q.questionCode, domain: q.domainCode, prompt: q.prompt, options: json<string[]>(q.optionsJson, []), correctIndex: json<{ correctIndex: number }>(q.correctAnswerJson, { correctIndex: -1 }).correctIndex, explanation: q.explanation ?? "", critical: q.critical }));
    const base = json<AssessmentPolicy>(assessment.policyJson, { questionCount: assessment.questionCount, passingScorePercent: assessment.passingScorePercent });
    const policy = { ...base, questionCount: Math.min(base.questionCount, bank.length) };
    const attemptRef = ref("ACAD-PRA");
    const built = buildAssessment({ attemptSeed: attemptRef, questions: bank, policy });
    const previous = await db.select({ id: academyAssessmentAttempts.id }).from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.assessmentId, assessment.id)));
    const ins = await db.insert(academyAssessmentAttempts).values({ attemptRef, assessmentId: assessment.id, assignmentId: a.id, userId: ctx.user.id, courseVersionId: a.courseVersionId, status: "open", attemptNumber: previous.length + 1, policySnapshotJson: JSON.stringify(built.policySnapshot), questionSetJson: JSON.stringify(built.items.map(i => ({ questionCode: i.questionCode, answerOrder: i.answerOrder, sequenceIndex: i.sequenceIndex }))), questionSetHash: built.questionSetHash, assessmentKind: input.kind });
    const attemptId = Number(ins[0]?.insertId ?? 0);
    for (const item of built.items) {
      const q = qrows.find(x => x.questionCode === item.questionCode)!;
      await db.insert(academyAssessmentItems).values({ attemptId, questionId: q.id, sequenceIndex: item.sequenceIndex, domainCode: item.domain, critical: item.critical, presentedPromptHash: item.presentedPromptHash, answerOrderJson: JSON.stringify(item.answerOrder) });
    }
    await audit(db, ctx.user.id, "academy_attempt", attemptRef, `${input.kind.toLowerCase()}.opened`, { assignmentRef: a.assignmentRef, courseVersionId: a.courseVersionId, questionSetHash: built.questionSetHash });
    return {
      attemptRef, kind: input.kind, notice: "Original LeaseOS practice questions — not government exam questions. Results never create a licence, endorsement or certificate.",
      questions: built.items.map(i => { const q = qrows.find(x => x.questionCode === i.questionCode)!; return { questionCode: i.questionCode, domain: i.domain, prompt: i.prompt, options: i.presentedOptions, sourceSection: input.kind === "PRACTICE" ? q.sourceSection : null }; }),
    };
  }),

  /** PRACTICE only: immediate answer, explanation, source section, and the module to study. */
  practiceAnswer: roleProcedure("academy.practiceAnswer").input(z.object({ attemptRef: z.string().min(1).max(96), questionCode: z.string().min(1).max(100), presentedIndex: z.number().int().min(0).max(20) }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const attempt = (await db.select().from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.attemptRef, input.attemptRef), eq(academyAssessmentAttempts.userId, ctx.user.id))).limit(1))[0];
    if (!attempt) throw new TRPCError({ code: "NOT_FOUND", message: "Attempt not found" });
    if (attempt.assessmentKind !== "PRACTICE") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Immediate answers are for practice mode only; mock and final attempts are graded on submit" });
    if (attempt.status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Attempt is already ${attempt.status}` });
    const q = (await db.select().from(academyQuestions).where(and(eq(academyQuestions.courseVersionId, attempt.courseVersionId), eq(academyQuestions.questionCode, input.questionCode))).limit(1))[0];
    const item = q ? (await db.select().from(academyAssessmentItems).where(and(eq(academyAssessmentItems.attemptId, attempt.id), eq(academyAssessmentItems.questionId, q.id))).limit(1))[0] : undefined;
    if (!q || !item) throw new TRPCError({ code: "NOT_FOUND", message: "Question is not part of this attempt" });
    const order = json<number[]>(item.answerOrderJson, []);
    const correctIndex = json<{ correctIndex: number }>(q.correctAnswerJson, { correctIndex: -1 }).correctIndex;
    const correct = order[input.presentedIndex] === correctIndex;
    await db.update(academyAssessmentItems).set({ responseJson: JSON.stringify({ presentedIndex: input.presentedIndex }), correct, answeredAt: new Date() }).where(eq(academyAssessmentItems.id, item.id));
    const src = q.sourceRef ? (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, q.sourceRef)).limit(1))[0] : undefined;
    const studyModule = (await db.select({ code: academyModules.moduleCode, title: academyModules.title }).from(academyModules).where(and(eq(academyModules.courseVersionId, attempt.courseVersionId), eq(academyModules.domainCode, q.domainCode))).limit(1))[0] ?? null;
    return {
      correct, correctPresentedIndex: order.indexOf(correctIndex), explanation: q.explanation,
      source: { sourceRef: q.sourceRef, section: q.sourceSection, title: src?.title ?? null, edition: src?.edition ?? null, url: src?.sourceUrl ?? null, reviewStatus: src?.reviewStatus ?? null },
      studyThisTopic: studyModule,
    };
  }),

  /** Grade a PRACTICE or MOCK_EXAM attempt: score, domain coverage, weak areas. Never advances anything. */
  practiceSubmit: roleProcedure("academy.practiceSubmit").input(z.object({ attemptRef: z.string().min(1).max(96), answers: z.record(z.string(), z.number().int().min(0).max(20)) }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const attempt = (await db.select().from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.attemptRef, input.attemptRef), eq(academyAssessmentAttempts.userId, ctx.user.id))).limit(1))[0];
    if (!attempt) throw new TRPCError({ code: "NOT_FOUND", message: "Attempt not found" });
    if (attempt.assessmentKind === "FINAL_INTERNAL") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Final assessments are submitted through assessmentSubmit" });
    if (attempt.status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Attempt is already ${attempt.status}` });
    const rows = await db.select().from(academyAssessmentItems).where(eq(academyAssessmentItems.attemptId, attempt.id));
    const qrows = await db.select().from(academyQuestions).where(eq(academyQuestions.courseVersionId, attempt.courseVersionId));
    const bank: AcademyQuestion[] = qrows.map(q => ({ id: q.id, code: q.questionCode, domain: q.domainCode, prompt: q.prompt, options: json<string[]>(q.optionsJson, []), correctIndex: json<{ correctIndex: number }>(q.correctAnswerJson, { correctIndex: -1 }).correctIndex, explanation: q.explanation ?? "", critical: q.critical }));
    const presented: PresentedAssessmentItem[] = rows.sort((x, y) => x.sequenceIndex - y.sequenceIndex).map(i => { const q = qrows.find(x => x.id === i.questionId)!; const order = json<number[]>(i.answerOrderJson, []); const opts = json<string[]>(q.optionsJson, []); return { questionCode: q.questionCode, sequenceIndex: i.sequenceIndex, domain: i.domainCode, critical: i.critical, prompt: q.prompt, presentedPromptHash: i.presentedPromptHash, answerOrder: order, presentedOptions: order.map(n => opts[n]) }; });
    // Practice-mode answers already given count unless overridden in this submission.
    const prior: Record<string, number> = {};
    for (const i of rows) { const r = json<{ presentedIndex?: number } | null>(i.responseJson, null); const q = qrows.find(x => x.id === i.questionId); if (q && Number.isInteger(r?.presentedIndex)) prior[q.questionCode] = r!.presentedIndex!; }
    const policy = json<AssessmentPolicy>(attempt.policySnapshotJson, { questionCount: presented.length, passingScorePercent: 80 });
    const result = gradeAssessment({ bank, presented, responses: { ...prior, ...input.answers }, policy });
    const now = new Date();
    for (const r of result.itemResults) {
      const item = rows.find(x => qrows.find(q => q.id === x.questionId)?.questionCode === r.questionCode);
      if (item) await db.update(academyAssessmentItems).set({ responseJson: JSON.stringify({ presentedIndex: r.responsePresentedIndex }), correct: r.correct, answeredAt: item.answeredAt ?? now }).where(eq(academyAssessmentItems.id, item.id));
    }
    await db.update(academyAssessmentAttempts).set({ status: result.passed ? "passed" : "failed", submittedAt: now, scorePercent: result.scorePercent, domainScoresJson: JSON.stringify(result.domainScores), criticalFailuresJson: JSON.stringify(result.criticalFailures) }).where(eq(academyAssessmentAttempts.id, attempt.id));
    await audit(db, ctx.user.id, "academy_attempt", attempt.attemptRef, `${attempt.assessmentKind.toLowerCase()}.submitted`, { scorePercent: result.scorePercent, courseVersionId: attempt.courseVersionId });
    const consequences = attemptConsequences(attempt.assessmentKind);
    return {
      kind: attempt.assessmentKind, scorePercent: result.scorePercent, reachedPracticeBar: result.passed, domainScores: result.domainScores,
      weakAreas: weakAreas(result.domainScores, policy.passingScorePercent),
      missed: result.itemResults.filter(r => !r.correct).map(r => { const q = qrows.find(x => x.questionCode === r.questionCode)!; return { questionCode: r.questionCode, domain: r.domain, explanation: q.explanation, sourceSection: q.sourceSection }; }),
      consequences, notice: "Practice/mock result only. It does not advance your assignment, create a credential or change dispatch readiness.",
    };
  }),

  practiceHistory: roleProcedure("academy.practiceHistory").input(z.object({ assignmentRef: z.string().min(1).max(96).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const a = input?.assignmentRef ? await assignmentForSelf(db, ctx.user.id, input.assignmentRef) : null;
    const rows = await db.select({ attemptRef: academyAssessmentAttempts.attemptRef, kind: academyAssessmentAttempts.assessmentKind, status: academyAssessmentAttempts.status, scorePercent: academyAssessmentAttempts.scorePercent, domainScoresJson: academyAssessmentAttempts.domainScoresJson, startedAt: academyAssessmentAttempts.startedAt, submittedAt: academyAssessmentAttempts.submittedAt, versionRef: academyCourseVersions.versionRef, courseVersionId: academyAssessmentAttempts.courseVersionId })
      .from(academyAssessmentAttempts).innerJoin(academyCourseVersions, eq(academyCourseVersions.id, academyAssessmentAttempts.courseVersionId))
      .where(a ? and(eq(academyAssessmentAttempts.userId, ctx.user.id), eq(academyAssessmentAttempts.assignmentId, a.id)) : eq(academyAssessmentAttempts.userId, ctx.user.id)).orderBy(desc(academyAssessmentAttempts.id)).limit(200);
    return rows.map(r => ({ ...r, domainScores: json<Record<string, number>>(r.domainScoresJson, {}), domainScoresJson: undefined }));
  }),

  /** Every question you got wrong on this version's practice/mock attempts, with where to study it. */
  missedQuestions: roleProcedure("academy.missedQuestions").input(z.object({ assignmentRef: z.string().min(1).max(96) }).strict()).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
    const attempts = await db.select({ id: academyAssessmentAttempts.id }).from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.userId, ctx.user.id), inArray(academyAssessmentAttempts.assessmentKind, ["PRACTICE", "MOCK_EXAM"])));
    if (!attempts.length) return [];
    const wrong = await db.select().from(academyAssessmentItems).where(and(inArray(academyAssessmentItems.attemptId, attempts.map(x => x.id)), eq(academyAssessmentItems.correct, false)));
    const qids = Array.from(new Set(wrong.map(w => w.questionId)));
    if (!qids.length) return [];
    const qs = await db.select().from(academyQuestions).where(inArray(academyQuestions.id, qids));
    const mods = await db.select({ code: academyModules.moduleCode, title: academyModules.title, domain: academyModules.domainCode }).from(academyModules).where(eq(academyModules.courseVersionId, a.courseVersionId));
    return qs.map(q => ({ questionCode: q.questionCode, prompt: q.prompt, domain: q.domainCode, timesMissed: wrong.filter(w => w.questionId === q.id).length, explanation: q.explanation, sourceRef: q.sourceRef, sourceSection: q.sourceSection, studyModule: mods.find(m => m.domain === q.domainCode) ?? null })).sort((x, y) => y.timesMissed - x.timesMissed);
  }),

  bookmarkToggle: roleProcedure("academy.bookmarkToggle").input(z.object({ assignmentRef: z.string().min(1).max(96), questionCode: z.string().min(1).max(100) }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
    const q = (await db.select({ id: academyQuestions.id }).from(academyQuestions).where(and(eq(academyQuestions.courseVersionId, a.courseVersionId), eq(academyQuestions.questionCode, input.questionCode))).limit(1))[0];
    if (!q) throw new TRPCError({ code: "NOT_FOUND", message: "Question not found in this version" });
    const existing = (await db.select().from(academyQuestionBookmarks).where(and(eq(academyQuestionBookmarks.userId, ctx.user.id), eq(academyQuestionBookmarks.questionId, q.id))).limit(1))[0];
    if (existing) { await db.delete(academyQuestionBookmarks).where(eq(academyQuestionBookmarks.id, existing.id)); return { bookmarked: false }; }
    await db.insert(academyQuestionBookmarks).values({ userId: ctx.user.id, questionId: q.id });
    return { bookmarked: true };
  }),

  bookmarks: roleProcedure("academy.bookmarks").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const marks = await db.select({ questionId: academyQuestionBookmarks.questionId }).from(academyQuestionBookmarks).where(eq(academyQuestionBookmarks.userId, ctx.user.id)).limit(500);
    if (!marks.length) return [];
    const qs = await db.select().from(academyQuestions).where(inArray(academyQuestions.id, marks.map(m => m.questionId)));
    return qs.map(q => ({ questionCode: q.questionCode, courseVersionId: q.courseVersionId, prompt: q.prompt, domain: q.domainCode, sourceSection: q.sourceSection }));
  }),

  /** The Study Library: authority, edition, dates, licence and review state; offline copy only when confirmed. */
  studyLibrary: roleProcedure("academy.studyLibrary").query(async () => {
    const db = await dbOrThrow();
    const rows = await db.select().from(academySourceRecords).limit(300);
    return rows.map(s => ({
      sourceRef: s.sourceRef, authority: s.authority, tier: s.sourceTier, title: s.title, jurisdiction: s.jurisdiction, edition: s.edition, url: s.sourceUrl,
      kind: s.sourceKind, licenceStatus: s.licenceStatus, licenceNote: s.licenceNote, retrievedAt: s.retrievedAt, reviewedAt: s.reviewedAt, reviewStatus: s.reviewStatus, contentHash: s.contentHash,
      capabilityCodes: json<string[]>(s.capabilityCodesJson, []),
      offline: offlineCopyDecision({ reviewStatus: s.reviewStatus, licenceStatus: s.licenceStatus, redistributionConfirmedByUserId: s.redistributionConfirmedByUserId }),
      authoritative: s.reviewStatus === "reviewed",
    }));
  }),

  /** A reviewer confirms the redistribution basis. Required before any offline copy; not implied by a stated licence. */
  sourceConfirmRedistribution: roleProcedure("academy.sourceConfirmRedistribution").input(z.object({ sourceRef: z.string().min(1).max(96), note: z.string().min(10).max(1000) }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const src = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, input.sourceRef)).limit(1))[0];
    if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Source not found" });
    if (src.reviewStatus !== "reviewed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Review the source before confirming redistribution rights" });
    if (src.licenceStatus !== "open_licence_stated") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No stated licence permits redistribution; learners open the official source instead" });
    await db.update(academySourceRecords).set({ redistributionConfirmedByUserId: ctx.user.id, redistributionConfirmedAt: new Date(), notes: `${src.notes ?? ""}\nRedistribution confirmed: ${input.note}`.trim() }).where(eq(academySourceRecords.id, src.id));
    await audit(db, ctx.user.id, "academy_source", src.sourceRef, "source.redistribution_confirmed", { note: input.note, licenceStatus: src.licenceStatus, contentHash: src.contentHash });
    return { sourceRef: src.sourceRef, offlineCopyPermitted: true };
  }),

  /** "Explain this section" — grounded in approved sources for this version, or UNKNOWN / REFER TO AUTHORITY. */
  tutor: roleProcedure("academy.tutor").input(z.object({
    assignmentRef: z.string().min(1).max(96), mode: z.enum(["explain", "quiz", "why_wrong", "more_examples"]),
    question: z.string().min(2).max(500), moduleCode: z.string().max(80).optional(),
    wrongAnswer: z.object({ questionCode: z.string().min(1).max(100), chosenIndex: z.number().int().min(0).max(20) }).optional(),
  }).strict()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
    const { course, version } = await versionBundle(db, a.courseVersionId);
    let mods = await db.select().from(academyModules).where(eq(academyModules.courseVersionId, a.courseVersionId));
    if (input.moduleCode) mods = mods.filter(m => m.moduleCode === input.moduleCode);
    const blocks = mods.length ? await db.select().from(academyContentBlocks).where(inArray(academyContentBlocks.moduleId, mods.map(m => m.id))) : [];
    const srcRefs = Array.from(new Set(mods.map(m => m.sourceRef ?? version.sourceSnapshotRef).filter((x): x is string => !!x)));
    const sources = srcRefs.length ? await db.select().from(academySourceRecords).where(inArray(academySourceRecords.sourceRef, srcRefs)) : [];
    const passages: TutorPassage[] = blocks.map(b => {
      const m = mods.find(x => x.id === b.moduleId)!;
      const sref = m.sourceRef ?? version.sourceSnapshotRef ?? "";
      const src = sources.find(x => x.sourceRef === sref);
      return { passageRef: `${m.moduleCode}/${b.blockCode}`, sourceRef: sref, sourceTitle: src?.title ?? sref, sourceUrl: src?.sourceUrl ?? null, sourceEdition: src?.edition ?? null, sourceReviewStatus: src?.reviewStatus ?? "unreviewed", section: m.sourceSection ?? m.title, jurisdiction: course.jurisdiction === "COMPANY" ? null : course.jurisdiction, text: json<string[]>(b.bodyJson, []).join(" "), companySpecific: m.companySpecific };
    });
    const qrows = await db.select().from(academyQuestions).where(eq(academyQuestions.courseVersionId, a.courseVersionId));
    const bank: TutorQuestion[] = qrows.map(q => ({ code: q.questionCode, domain: q.domainCode, prompt: q.prompt, options: json<string[]>(q.optionsJson, []), correctIndex: json<{ correctIndex: number }>(q.correctAnswerJson, { correctIndex: -1 }).correctIndex, explanation: q.explanation ?? "", sourceRef: q.sourceRef, sourceSection: q.sourceSection }));
    const answer = tutorAnswer({ mode: input.mode, question: input.question, passages, bank, wrongAnswer: input.wrongAnswer ?? null, at: new Date(), jurisdiction: null });
    await audit(db, ctx.user.id, "academy_tutor", a.assignmentRef, "tutor.answered", { mode: input.mode, status: answer.status, citations: answer.citations.map(c => c.sourceRef) });
    return { ...answer, versionRef: version.versionRef };
  }),

  dispatchCheck: roleProcedure("academy.dispatchCheck")
    .input(z.object({ userId: z.number().int().positive(), requirementCodes: z.array(z.string().min(1).max(100)).min(1).max(50), jobId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant); otherwise not found.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await userInScope(input.userId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const db = await dbOrThrow();
      const reqs = await db.select().from(academyRequirements).where(inArray(academyRequirements.requirementCode, input.requirementCodes));
      const quals = await db.select().from(academyQualifications).where(eq(academyQualifications.userId, input.userId));
      const now = new Date();
      const accepted = quals.filter(q => q.status === "current" && (!q.expiresAt || q.expiresAt > now)).map(q => ({ code: q.qualificationCode, status: q.status, expiresAt: q.expiresAt }));
      // A physical direct-supervision record may satisfy only its matching job/time/scope requirement.
      if (input.jobId) {
        const supers = await db.select().from(academyDirectSupervisionRecords).where(and(eq(academyDirectSupervisionRecords.traineeUserId, input.userId), eq(academyDirectSupervisionRecords.jobId, input.jobId), eq(academyDirectSupervisionRecords.status, "active"), eq(academyDirectSupervisionRecords.physicalPresenceAttested, true)));
        for (const s of supers) if (s.startsAt <= now && s.endsAt > now && !accepted.some(q => q.code === s.qualificationCode)) accepted.push({ code: s.qualificationCode, status: "current" as const, expiresAt: s.endsAt });
      }
      // 0172 — verified wallet credentials, through the canonical rule (with Q's parent licence and a
      // Class 1's provincial restriction read against the requirement's own scope).
      const canonical = canonicalVerdicts((await holdingRowsFor(db, [input.userId])).map(asHolding), reqs, now);
      return trainingDispatchDecision(reqs.map(r => ({ code: r.requirementCode, title: r.title, qualificationCode: r.qualificationCode, enforcement: r.enforcement, recoveryPath: r.recoveryPath, requiresInterprovincial: scopeOf(r.conditionsJson).interprovincial })), accepted, now, canonical);
    }),
});
