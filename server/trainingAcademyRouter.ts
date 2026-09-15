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
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
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
  complianceKnowledgeItems,
  complianceDocuments,
  users,
} from "../drizzle/schema";
import {
  buildAssessment,
  certificateDecision,
  directSupervisionDecision,
  gradeAssessment,
  moduleGate,
  practicalGate,
  stableHash,
  trainingDispatchDecision,
  type AcademyQuestion,
  type AssessmentPolicy,
  type PresentedAssessmentItem,
} from "./_core/trainingAcademy";
import { ACADEMY_COURSES, ACADEMY_REQUIREMENT_SEEDS, ACADEMY_SOURCES, CATALOG_COUNTS } from "./_core/trainingAcademyCatalog";
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
      await db.insert(academySourceRecords).values({ ...src, reviewStatus: "unreviewed", snapshotHash: stableHash(src) });
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
    const versionRef = `${seed.code}:1`;
    let version = (await db.select().from(academyCourseVersions).where(eq(academyCourseVersions.versionRef, versionRef)).limit(1))[0];
    if (!version) {
      const courseHash = stableHash({ code: seed.code, title: seed.title, policy: seed.policy, modules: seed.modules, questions: seed.questions.map(q => ({ code: q.code, prompt: q.prompt, options: q.options, correctIndex: q.correctIndex })) });
      const ins = await db.insert(academyCourseVersions).values({ courseId: course.id, versionRef, versionNumber: 1, status: "published", effectiveAt: new Date(), policyJson: JSON.stringify(seed.policy), courseHash, sourceSnapshotRef: seed.sourceRef ?? null, publishedByUserId: actorUserId, publishedAt: new Date() });
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
        const mins = await db.insert(academyModules).values({ courseVersionId: version.id, moduleCode: m.code, title: m.title, orderIndex: mi, domainCode: m.domain, requiresCompletion: true, requiresPractical: !!m.practical, estimatedMinutes: m.minutes, moduleHash });
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
        await db.insert(academyQuestions).values({ courseVersionId: version.id, questionCode: q.code, bankCode: seed.code, domainCode: q.domain, prompt: q.prompt, optionsJson: JSON.stringify(q.options), correctAnswerJson: JSON.stringify({ correctIndex: q.correctIndex }), explanation: q.explanation, critical: !!q.critical, active: true, questionHash: stableHash(q) });
        created.questions++;
      }
    }
    const assessmentCode = `${seed.code}-FINAL`;
    const existingAssessment = (await db.select().from(academyAssessments).where(and(eq(academyAssessments.courseVersionId, version.id), eq(academyAssessments.assessmentCode, assessmentCode))).limit(1))[0];
    if (!existingAssessment) {
      await db.insert(academyAssessments).values({ courseVersionId: version.id, assessmentCode, title: `${seed.title} · Final Assessment`, questionCount: seed.policy.questionCount, passingScorePercent: seed.policy.passingScorePercent, maxAttempts: seed.policy.maxAttempts ?? null, policyJson: JSON.stringify(seed.policy), domainThresholdsJson: seed.policy.domainMinimumPercent ? JSON.stringify(seed.policy.domainMinimumPercent) : null, criticalFailurePolicyJson: JSON.stringify({ failOnCriticalMiss: !!seed.policy.failOnCriticalMiss }), active: true });
      created.assessments++;
    }
  }
  for (const r of ACADEMY_REQUIREMENT_SEEDS) {
    const existing = (await db.select().from(academyRequirements).where(eq(academyRequirements.requirementCode, r.code)).limit(1))[0];
    if (!existing) {
      await db.insert(academyRequirements).values({ requirementCode: r.code, title: r.title, qualificationCode: r.qualificationCode, enforcement: r.enforcement, recoveryPath: r.recoveryPath, active: true, createdByUserId: actorUserId });
      created.requirements++;
    }
  }
  await audit(db, actorUserId, "academy_catalog", "v22.21", "catalog.synchronized", { created, catalogCounts: CATALOG_COUNTS });
  return created;
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
      const db = await dbOrThrow();
      const a = await assignmentForSelf(db, ctx.user.id, input.assignmentRef);
      const readiness = await moduleReadiness(db, a.id, a.courseVersionId);
      if (!readiness.ready) throw new TRPCError({ code: "PRECONDITION_FAILED", message: readiness.reason ?? "Current modules are not complete" });
      const assessment = (await db.select().from(academyAssessments).where(and(eq(academyAssessments.courseVersionId, a.courseVersionId), eq(academyAssessments.active, true))).limit(1))[0];
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
      const theory = (await db.select().from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.courseVersionId, a.courseVersionId), eq(academyAssessmentAttempts.status, "passed"))).orderBy(desc(academyAssessmentAttempts.id)).limit(1))[0];
      if (!theory) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Current-version theory assessment must be passed first" });
      const evaluationRef = ref("ACAD-PRAC");
      await db.insert(academyPracticalEvaluations).values({ evaluationRef, assignmentId: a.id, courseVersionId: a.courseVersionId, userId: a.userId, competencyCode: input.competencyCode, evaluatorUserId: ctx.user.id, status: input.status, rubricJson: JSON.stringify(input.rubric), evidenceRecordId: input.evidenceRecordId ?? null, observedAt: input.observedAt, signedAt: new Date(), expiresAt: input.expiresAt ?? null });
      await db.update(academyAssignments).set({ status: input.status === "competent" ? "completed" : "practical_pending", completedAt: input.status === "competent" ? new Date() : null, completionReason: input.status === "competent" ? "Theory passed and practical competency signed off" : `Practical evaluation: ${input.status}` }).where(eq(academyAssignments.id, a.id));
      await audit(db, ctx.user.id, "academy_practical", evaluationRef, "practical.signed", { assignmentRef: a.assignmentRef, userId: a.userId, courseVersionId: a.courseVersionId, competencyCode: input.competencyCode, status: input.status });
      return { evaluationRef, status: input.status };
    }),

  sourceReview: roleProcedure("academy.sourceReview")
    .input(z.object({ sourceRef: z.string().min(1).max(96), decision: z.enum(["reviewed", "rejected", "superseded"]), note: z.string().min(3).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const src = (await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceRef, input.sourceRef)).limit(1))[0];
      if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Academy source record not found" });
      await db.update(academySourceRecords).set({ reviewStatus: input.decision, reviewedByUserId: ctx.user.id, reviewedAt: new Date(), notes: `${src.notes ?? ""}\nReview: ${input.note}`.trim() }).where(eq(academySourceRecords.id, src.id));
      await audit(db, ctx.user.id, "academy_source", src.sourceRef, "source.reviewed", { decision: input.decision, note: input.note, snapshotHash: src.snapshotHash });
      return { sourceRef: src.sourceRef, reviewStatus: input.decision };
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
      trainingAspects: z.array(z.string().min(2).max(500)).min(1).max(100).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assignmentByRef(db, input.assignmentRef);
      const { course, version } = await versionBundle(db, a.courseVersionId);
      const passed = !!(await db.select({ id: academyAssessmentAttempts.id }).from(academyAssessmentAttempts).where(and(eq(academyAssessmentAttempts.assignmentId, a.id), eq(academyAssessmentAttempts.courseVersionId, a.courseVersionId), eq(academyAssessmentAttempts.status, "passed"))).limit(1))[0];
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
      if (course.credentialBoundary === "employer_certificate" && qualificationCode === "TDG_ROAD") {
        if (!input.employerName?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TDG certificate requires the employer name" });
        if (!input.employerBusinessAddress?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TDG certificate requires the employer place-of-business address" });
        if (!input.trainingAspects?.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TDG certificate requires the aspects of dangerous-goods work for which the employee is trained" });
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
      const provisionalPayload = { certificateRef, userId: a.userId, employeeNameSnapshot: learner.name, employerNameSnapshot: input.employerName ?? null, employerBusinessAddressSnapshot: input.employerBusinessAddress ?? null, trainingAspects: input.trainingAspects ?? null, courseId: course.id, courseVersionId: version.id, assignmentRef: a.assignmentRef, qualificationCode, credentialBoundary: course.credentialBoundary, issuedAt: issuedAt.toISOString(), expiresAt: terms.expiresAt?.toISOString() ?? null, retentionUntil: terms.retentionUntil?.toISOString() ?? null, sourceSnapshotRef: version.sourceSnapshotRef, sourceHash: source?.snapshotHash ?? null, sourceTier: source?.sourceTier ?? null, regulatoryProfileRef: profileRow?.profileRef ?? null, regulatoryProfileHash: profileRow?.profileHash ?? null, statementOfExperienceHash: experienceRow?.payloadHash ?? null, attestationStatement: requiresAttestation ? input.attestationStatement : null, policySnapshotHash };
      const provisionalHash = stableHash(provisionalPayload);
      const needsEmployeeSignature = !!profileSeed?.requiresEmployeeSignature;
      const needsEmployerSignature = !!profileSeed?.requiresEmployerSignature;
      const status = needsEmployeeSignature ? "pending_signature" as const : "active" as const;
      const ins = await db.insert(academyCertificates).values({ certificateRef, userId: a.userId, courseId: course.id, courseVersionId: version.id, assignmentId: a.id, qualificationCode, credentialBoundary: course.credentialBoundary, status, issuedByUserId: ctx.user.id, employeeNameSnapshot: learner.name, employerNameSnapshot: input.employerName ?? null, employerBusinessAddressSnapshot: input.employerBusinessAddress ?? null, trainingAspectsJson: input.trainingAspects ? JSON.stringify(input.trainingAspects) : null, issuedAt, finalizedAt: status === "active" ? issuedAt : null, expiresAt: terms.expiresAt, retentionUntil: terms.retentionUntil, sourceSnapshotRef: version.sourceSnapshotRef!, regulatoryProfileRef: profileRow?.profileRef ?? null, regulatoryProfileHash: profileRow?.profileHash ?? null, statementOfExperienceId: experienceRow?.id ?? null, attestationStatement: requiresAttestation ? input.attestationStatement! : null, attestedAt: requiresAttestation ? issuedAt : null, policySnapshotHash, certificateHash: provisionalHash });
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

  dispatchCheck: roleProcedure("academy.dispatchCheck")
    .input(z.object({ userId: z.number().int().positive(), requirementCodes: z.array(z.string().min(1).max(100)).min(1).max(50), jobId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
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
      return trainingDispatchDecision(reqs.map(r => ({ code: r.requirementCode, title: r.title, qualificationCode: r.qualificationCode, enforcement: r.enforcement, recoveryPath: r.recoveryPath })), accepted, now);
    }),
});
