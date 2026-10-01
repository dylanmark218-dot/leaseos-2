/**
 * Workforce lifecycle — the API.
 */
import { TRPCError } from "@trpc/server";
import { actingScopeFor, createOperator, operatorForUserInScope, orgScopeWhere, userInScope, type TenantScope } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, revokeUserRole } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { applicantScreenings, applicants, competencySignoffs, complianceDocuments, fieldDevices, offboardings, onboardingPlans, onboardingTasks, probationReviews, serializedTools, toolCheckouts, trainingRecords, userRoleAssignments } from "../drizzle/schema";
import { COURSE_CREDENTIALS, competencyDecision, hireReadiness, offboardingClose, onboardingGaps, probationDecision, screeningRecordDecision, trainingVerification } from "./_core/workforce";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
const SCREENING = z.enum(["licence_verification", "driver_abstract", "references", "drug_alcohol", "criminal_record", "right_to_work", "medical_fitness", "road_test"]);
/** What a driver's hire requires — the company's own list, editable per applicant. */
const DRIVER_REQUIRED_SCREENINGS = ["licence_verification", "driver_abstract", "references", "right_to_work", "road_test"] as const;
/** The tasks a new driver's plan starts with. A task with a doc type stands for a registry credential once verified. */
const DRIVER_ONBOARDING = [
  { taskCode: "orientation", title: "Company orientation and policy acknowledgement", credentialDocType: null, credentialValidDays: null, dueDays: 3 },
  { taskCode: "device_enrol", title: "Field device enrolled", credentialDocType: null, credentialValidDays: null, dueDays: 3 },
  { taskCode: "h2s_alive", title: "H2S Alive certificate on file", credentialDocType: "h2s_alive", credentialValidDays: 3 * 365, dueDays: 14 },
  { taskCode: "first_aid", title: "Standard first aid on file", credentialDocType: "first_aid", credentialValidDays: 3 * 365, dueDays: 30 },
  { taskCode: "tdg", title: "TDG certificate on file", credentialDocType: "tdg_certificate", credentialValidDays: 3 * 365, dueDays: 14 },
  { taskCode: "ride_along", title: "Ride-along with a senior operator", credentialDocType: null, credentialValidDays: null, dueDays: 14 },
] as const;

/**
 * B23.1A — live grants this person holds that belong to NO organization.
 *
 * `scopeType='global'` is platform-wide authority: it reaches every company in
 * the deployment, so no single company's offboarding can revoke it. Counted so
 * that the one door an offboarding cannot shut is named in its own words
 * instead of vanishing when the revoke was scoped to the acting organization.
 */
async function platformWideGrantsHeldBy(db: Awaited<ReturnType<typeof dbOrThrow>>, userId: number): Promise<number> {
  const rows = await db.select({ id: userRoleAssignments.id }).from(userRoleAssignments).where(and(
    eq(userRoleAssignments.userId, userId),
    eq(userRoleAssignments.scopeType, "global"),
    isNull(userRoleAssignments.revokedAt),
  ));
  return rows.length;
}

/**
 * Whose registry a verified credential is filed under: the person's operator record in the verifying
 * organization, else the person. Another organization's operator record is never it, and two in
 * this organization are refused rather than the first chosen.
 */
async function ownerFor(userId: number, scope: TenantScope): Promise<{ ownerType: "operator" | "user"; ownerId: number }> {
  const op = await operatorForUserInScope(userId, scope);
  if (op.kind === "ambiguous") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "More than one operator record names this person in this organization" });
  return op.kind === "resolved" ? { ownerType: "operator", ownerId: op.operatorId } : { ownerType: "user", ownerId: userId };
}
async function writeCredential(args: { userId: number; docType: string; title: string; issuedAt: Date; expiresAt: Date | null; evidenceRecordId: number; source: string; verifiedByUserId: number }) {
  const db = await dbOrThrow();
  const owner = await ownerFor(args.userId, await actingScopeFor(args.verifiedByUserId));
  const ins = await db.insert(complianceDocuments).values({ ownerType: owner.ownerType, ownerId: owner.ownerId, docType: args.docType, requirementKey: null, title: args.title, identifier: null, storageKey: null, storageUrl: null, capturedAt: new Date(), issuedAt: args.issuedAt, expiresAt: args.expiresAt, jurisdiction: null, verificationStatus: "verified", verifiedByUserId: args.verifiedByUserId, verifiedAt: new Date(), privateDetail: false, evidenceRecordId: args.evidenceRecordId, source: args.source, confidence: "high" } as never);
  return Number(ins[0]?.insertId ?? 0);
}

export const workforceRouter = router({
  applicantCreate: roleProcedure("workforce.applicantCreate")
    .input(z.object({ fullName: z.string().min(2).max(180), contact: z.record(z.string(), z.string()).optional(), roleApplied: z.string().min(1).max(120), source: z.string().max(120).optional(), requiredScreenings: z.array(SCREENING).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const applicantRef = ref("APP");
      const scope = await actingScopeFor(ctx.user.id);
      const ins = await db.insert(applicants).values({ orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId, applicantRef, fullName: input.fullName, contactJson: input.contact ? JSON.stringify(input.contact) : null, roleApplied: input.roleApplied, source: input.source ?? null, status: "screening", createdByUserId: ctx.user.id });
      const id = Number(ins[0]?.insertId ?? 0);
      const required = input.requiredScreenings ?? (/driver|operator/i.test(input.roleApplied) ? [...DRIVER_REQUIRED_SCREENINGS] : ["references", "right_to_work"]);
      for (const k of required) await db.insert(applicantScreenings).values({ applicantId: id, kind: k, required: true });
      return { applicantRef, status: "screening" as const, requiredScreenings: required };
    }),

  screeningRecord: roleProcedure("workforce.screeningRecord")
    .input(z.object({ applicantRef: z.string().min(1).max(64), kind: SCREENING, result: z.enum(["pass", "fail", "not_required"]), evidenceRecordId: z.number().int().positive().nullable().optional(), note: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = (await db.select().from(applicants).where(and(eq(applicants.applicantRef, input.applicantRef), orgScopeWhere(applicants, await actingScopeFor(ctx.user.id)))).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Applicant not found" });
      const cur = (await db.select().from(applicantScreenings).where(and(eq(applicantScreenings.applicantId, a.id), eq(applicantScreenings.kind, input.kind))).limit(1))[0];
      const d = screeningRecordDecision({ result: input.result, evidenceRecordId: input.evidenceRecordId ?? null, required: cur?.required ?? false });
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusal! });
      if (cur) await db.update(applicantScreenings).set({ result: input.result, evidenceRecordId: input.evidenceRecordId ?? null, note: input.note ?? null, recordedByUserId: ctx.user.id, recordedAt: new Date() }).where(eq(applicantScreenings.id, cur.id));
      else await db.insert(applicantScreenings).values({ applicantId: a.id, kind: input.kind, required: false, result: input.result, evidenceRecordId: input.evidenceRecordId ?? null, note: input.note ?? null, recordedByUserId: ctx.user.id, recordedAt: new Date() });
      const all = await db.select().from(applicantScreenings).where(eq(applicantScreenings.applicantId, a.id));
      return { applicantRef: a.applicantRef, kind: input.kind, result: input.result, readiness: hireReadiness(all, all.filter(s => s.required).map(s => s.kind)) };
    }),

  /** Hire, decline, or record a withdrawal. A hire needs every required screening passed with evidence, and the user account the person will use; a driver gets an operator record and a plan. */
  applicantDecide: roleProcedure("workforce.applicantDecide")
    .input(z.object({ applicantRef: z.string().min(1).max(64), decision: z.enum(["hired", "declined", "withdrawn"]), reason: z.string().min(3).max(400), userId: z.number().int().positive().optional(), startDate: z.coerce.date().optional(), probationDays: z.number().int().positive().max(365).default(90), licenseExpiresAt: z.coerce.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = (await db.select().from(applicants).where(and(eq(applicants.applicantRef, input.applicantRef), orgScopeWhere(applicants, await actingScopeFor(ctx.user.id)))).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Applicant not found" });
      if (a.status === "hired" || a.status === "declined" || a.status === "withdrawn") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Applicant is ${a.status}` });
      if (input.decision !== "hired") { await db.update(applicants).set({ status: input.decision, decisionReason: input.reason, decidedByUserId: ctx.user.id, decidedAt: new Date() }).where(eq(applicants.id, a.id)); return { applicantRef: a.applicantRef, status: input.decision, planRef: null }; }
      const all = await db.select().from(applicantScreenings).where(eq(applicantScreenings.applicantId, a.id));
      const r = hireReadiness(all, all.filter(s => s.required).map(s => s.kind));
      if (!r.ready) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot hire: ${r.blockers.join("; ")}` });
      if (!input.userId || !input.startDate) throw new TRPCError({ code: "BAD_REQUEST", message: "A hire needs the user account and the start date" });
      const existing = (await db.select({ id: onboardingPlans.id }).from(onboardingPlans).where(eq(onboardingPlans.userId, input.userId)).limit(1))[0];
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "This user already has an onboarding plan" });
      const isDriver = /driver|operator/i.test(a.roleApplied);
      // The driver's operator record belongs to the hiring organization: one there already counts, one elsewhere does not.
      if (isDriver) {
        const scope = await actingScopeFor(ctx.user.id);
        if ((await operatorForUserInScope(input.userId, scope)).kind === "none") await createOperator({ userId: input.userId, name: a.fullName, licenseExpiresAt: input.licenseExpiresAt ?? null } as never, scope, ctx.user.id);
      }
      const planRef = ref("ONB");
      const probationEndsAt = new Date(input.startDate.getTime() + input.probationDays * 86_400_000);
      const ins = await db.insert(onboardingPlans).values({ planRef, userId: input.userId, applicantId: a.id, position: a.roleApplied, startDate: input.startDate, probationEndsAt, createdByUserId: ctx.user.id });
      const planId = Number(ins[0]?.insertId ?? 0);
      const tasks = isDriver ? DRIVER_ONBOARDING : DRIVER_ONBOARDING.filter(t => t.taskCode === "orientation");
      for (const t of tasks) await db.insert(onboardingTasks).values({ planId, taskCode: t.taskCode, title: t.title, required: true, dueBy: new Date(input.startDate.getTime() + t.dueDays * 86_400_000), credentialDocType: t.credentialDocType, credentialValidDays: t.credentialValidDays });
      await db.update(applicants).set({ status: "hired", hiredUserId: input.userId, decisionReason: input.reason, decidedByUserId: ctx.user.id, decidedAt: new Date() }).where(eq(applicants.id, a.id));
      return { applicantRef: a.applicantRef, status: "hired" as const, planRef, tasks: tasks.length, probationEndsAt };
    }),

  applicantList: roleProcedure("workforce.applicantList").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const rows = await db.select().from(applicants).where(orgScopeWhere(applicants, await actingScopeFor(ctx.user.id))).orderBy(desc(applicants.id)).limit(200);
    return { applicants: rows.map(a => ({ applicantRef: a.applicantRef, fullName: a.fullName, roleApplied: a.roleApplied, status: a.status })) }; // contact stays out of the list
  }),

  onboardingStatus: roleProcedure("workforce.onboardingStatus").input(z.object({ planRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
      // P4.1: the plan's person must be in the caller's scope; otherwise the plan does not exist here.
      {
        const plan = (await dbOrThrow().then(d => d.select({ userId: onboardingPlans.userId }).from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1)))[0];
        if (plan && !(await userInScope(plan.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Plan ${input.planRef} not found` });
      }
    const db = await dbOrThrow();
    const p = (await db.select().from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
    const tasks = await db.select().from(onboardingTasks).where(eq(onboardingTasks.planId, p.id));
    return { planRef: p.planRef, userId: p.userId, position: p.position, startDate: p.startDate, probationEndsAt: p.probationEndsAt, status: p.status, ...onboardingGaps(tasks, new Date()), tasks: tasks.map(t => ({ taskCode: t.taskCode, title: t.title, dueBy: t.dueBy, completedAt: t.completedAt, credentialDocType: t.credentialDocType, verifiedAt: t.verifiedAt, complianceDocumentId: t.complianceDocumentId })) };
  }),

  taskComplete: roleProcedure("workforce.taskComplete").input(z.object({ planRef: z.string().min(1).max(64), taskCode: z.string().min(1).max(60), evidenceRecordId: z.number().int().positive().nullable().optional() })).mutation(async ({ ctx, input }) => {
      // P4.1: the plan's person must be in the caller's scope; otherwise the plan does not exist here.
      {
        const plan = (await dbOrThrow().then(d => d.select({ userId: onboardingPlans.userId }).from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1)))[0];
        if (plan && !(await userInScope(plan.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Plan ${input.planRef} not found` });
      }
    const db = await dbOrThrow();
    const p = (await db.select().from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
    const t = (await db.select().from(onboardingTasks).where(and(eq(onboardingTasks.planId, p.id), eq(onboardingTasks.taskCode, input.taskCode))).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
    if (t.credentialDocType && !input.evidenceRecordId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This task stands for a credential — the certificate goes in the evidence vault first" });
    await db.update(onboardingTasks).set({ completedAt: new Date(), completedByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null }).where(eq(onboardingTasks.id, t.id));
    return { taskCode: t.taskCode, completed: true, awaitingVerification: !!t.credentialDocType };
  }),

  /** A credential task verified by someone other than its completer: the registry gets a verified document. */
  taskVerify: roleProcedure("workforce.taskVerify").input(z.object({ planRef: z.string().min(1).max(64), taskCode: z.string().min(1).max(60) })).mutation(async ({ ctx, input }) => {
      // P4.1: the plan's person must be in the caller's scope; otherwise the plan does not exist here.
      {
        const plan = (await dbOrThrow().then(d => d.select({ userId: onboardingPlans.userId }).from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1)))[0];
        if (plan && !(await userInScope(plan.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Plan ${input.planRef} not found` });
      }
    const db = await dbOrThrow();
    const p = (await db.select().from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
    const t = (await db.select().from(onboardingTasks).where(and(eq(onboardingTasks.planId, p.id), eq(onboardingTasks.taskCode, input.taskCode))).limit(1))[0];
    if (!t || !t.credentialDocType) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Not a credential task" });
    if (!t.completedAt || !t.evidenceRecordId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Not completed with evidence" });
    if (t.completedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who completed the task may not verify it" });
    if (t.verifiedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Already verified" });
    const docId = await writeCredential({ userId: p.userId, docType: t.credentialDocType, title: t.title, issuedAt: t.completedAt, expiresAt: t.credentialValidDays ? new Date(t.completedAt.getTime() + t.credentialValidDays * 86_400_000) : null, evidenceRecordId: t.evidenceRecordId, source: `onboarding ${p.planRef}/${t.taskCode}`, verifiedByUserId: ctx.user.id });
    await db.update(onboardingTasks).set({ verifiedByUserId: ctx.user.id, verifiedAt: new Date(), complianceDocumentId: docId }).where(eq(onboardingTasks.id, t.id));
    const tasks = await db.select().from(onboardingTasks).where(eq(onboardingTasks.planId, p.id));
    const gaps = onboardingGaps(tasks, new Date());
    if (gaps.complete && p.status === "in_progress") await db.update(onboardingPlans).set({ status: "complete" }).where(eq(onboardingPlans.id, p.id));
    return { taskCode: t.taskCode, complianceDocumentId: docId, docType: t.credentialDocType, onboarding: gaps.summary };
  }),

  trainingRecord: roleProcedure("workforce.trainingRecord").input(z.object({ userId: z.number().int().positive(), courseCode: z.string().min(1).max(60), title: z.string().min(1).max(220), provider: z.string().max(160).optional(), completedAt: z.coerce.date(), expiresAt: z.coerce.date().nullable().optional(), certificateNumber: z.string().max(120).optional(), evidenceRecordId: z.number().int().positive().nullable().optional() })).mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant).
      if (!(await userInScope(input.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
    const db = await dbOrThrow();
    const trainingRef = ref("TRN");
    const map = COURSE_CREDENTIALS[input.courseCode];
    await db.insert(trainingRecords).values({ trainingRef, userId: input.userId, courseCode: input.courseCode, title: input.title, provider: input.provider ?? null, completedAt: input.completedAt, expiresAt: input.expiresAt ?? null, certificateNumber: input.certificateNumber ?? null, evidenceRecordId: input.evidenceRecordId ?? null, credentialDocType: map?.docType ?? null, recordedByUserId: ctx.user.id });
    return { trainingRef, verificationStatus: "unverified" as const, becomesCredential: map?.docType ?? null, note: map ? "Verified by a second person, it enters the registry dispatch reads." : "Not mapped to a credential — training only." };
  }),

  trainingVerify: roleProcedure("workforce.trainingVerify").input(z.object({ trainingRef: z.string().min(1).max(64), decision: z.enum(["verified", "rejected"]) })).mutation(async ({ ctx, input }) => {
      // P4.1: the training record's person must be in the caller's scope.
      {
        const tr = (await dbOrThrow().then(d => d.select({ userId: trainingRecords.userId }).from(trainingRecords).where(eq(trainingRecords.trainingRef, input.trainingRef)).limit(1)))[0];
        if (tr && !(await userInScope(tr.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Training ${input.trainingRef} not found` });
      }
    const db = await dbOrThrow();
    const t = (await db.select().from(trainingRecords).where(eq(trainingRecords.trainingRef, input.trainingRef)).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Training record not found" });
    if (t.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Already ${t.verificationStatus}` });
    if (input.decision === "rejected") { await db.update(trainingRecords).set({ verificationStatus: "rejected", verifiedByUserId: ctx.user.id, verifiedAt: new Date() }).where(eq(trainingRecords.id, t.id)); return { trainingRef: t.trainingRef, verificationStatus: "rejected" as const, complianceDocumentId: null }; }
    const v = trainingVerification({ courseCode: t.courseCode, evidenceRecordId: t.evidenceRecordId, expiresAt: t.expiresAt, completedAt: t.completedAt, recordedByUserId: t.recordedByUserId, verifierUserId: ctx.user.id });
    if (!v.permitted) throw new TRPCError({ code: v.refusals.some(r => r.includes("may not verify")) ? "FORBIDDEN" : "PRECONDITION_FAILED", message: v.refusals.join("; ") });
    let docId: number | null = null;
    if (v.credential) docId = await writeCredential({ userId: t.userId, docType: v.credential.docType, title: t.title, issuedAt: t.completedAt, expiresAt: v.credential.expiresAt, evidenceRecordId: t.evidenceRecordId!, source: `training ${t.trainingRef}${t.certificateNumber ? ` #${t.certificateNumber}` : ""}`, verifiedByUserId: ctx.user.id });
    await db.update(trainingRecords).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), complianceDocumentId: docId }).where(eq(trainingRecords.id, t.id));
    return { trainingRef: t.trainingRef, verificationStatus: "verified" as const, complianceDocumentId: docId, expiresAt: v.credential?.expiresAt ?? null, note: v.refusals[0] ?? null };
  }),

  competencySignoff: roleProcedure("workforce.competencySignoff").input(z.object({ userId: z.number().int().positive(), competencyCode: z.string().min(1).max(60), level: z.enum(["trainee", "competent", "senior"]), note: z.string().max(400).optional(), evidenceRecordId: z.number().int().positive().nullable().optional(), expiresAt: z.coerce.date().nullable().optional() })).mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant).
      if (!(await userInScope(input.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
    const db = await dbOrThrow();
    const prior = (await db.select().from(competencySignoffs).where(and(eq(competencySignoffs.userId, input.userId), eq(competencySignoffs.competencyCode, input.competencyCode))).orderBy(desc(competencySignoffs.id)).limit(1))[0];
    const d = competencyDecision({ workerUserId: input.userId, signerUserId: ctx.user.id, level: input.level, priorLevel: prior?.level ?? null });
    if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
    await db.insert(competencySignoffs).values({ userId: input.userId, competencyCode: input.competencyCode, level: input.level, signedOffByUserId: ctx.user.id, signedOffAt: new Date(), evidenceRecordId: input.evidenceRecordId ?? null, note: input.note ?? null, expiresAt: input.expiresAt ?? null });
    return { userId: input.userId, competencyCode: input.competencyCode, level: input.level, priorLevel: prior?.level ?? null };
  }),

  probationRecommend: roleProcedure("workforce.probationRecommend").input(z.object({ planRef: z.string().min(1).max(64), recommendation: z.enum(["confirm", "extend", "end"]), note: z.string().min(10).max(600) })).mutation(async ({ ctx, input }) => {
      // P4.1: the plan's person must be in the caller's scope; otherwise the plan does not exist here.
      {
        const plan = (await dbOrThrow().then(d => d.select({ userId: onboardingPlans.userId }).from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1)))[0];
        if (plan && !(await userInScope(plan.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Plan ${input.planRef} not found` });
      }
    const db = await dbOrThrow();
    const p = (await db.select().from(onboardingPlans).where(eq(onboardingPlans.planRef, input.planRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
    const ins = await db.insert(probationReviews).values({ planId: p.id, recommendation: input.recommendation, recommendedByUserId: ctx.user.id, recommendedAt: new Date(), recommendationNote: input.note });
    return { reviewId: Number(ins[0]?.insertId ?? 0), recommendation: input.recommendation };
  }),

  probationDecide: roleProcedure("workforce.probationDecide").input(z.object({ reviewId: z.number().int().positive(), decision: z.enum(["confirm", "extend", "end"]), note: z.string().min(5).max(600), extendedTo: z.coerce.date().nullable().optional() })).mutation(async ({ ctx, input }) => {
      // P4.1: the review's person must be in the caller's scope.
      {
        const rv = (await dbOrThrow().then(d => d.select({ userId: onboardingPlans.userId }).from(probationReviews).innerJoin(onboardingPlans, eq(onboardingPlans.id, probationReviews.planId)).where(eq(probationReviews.id, input.reviewId)).limit(1)))[0];
        if (rv && !(await userInScope(rv.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Review ${input.reviewId} not found` });
      }
    const db = await dbOrThrow();
    const r = (await db.select().from(probationReviews).where(eq(probationReviews.id, input.reviewId)).limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Review not found" });
    if (r.decision) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Already decided" });
    const p = (await db.select().from(onboardingPlans).where(eq(onboardingPlans.id, r.planId)).limit(1))[0]!;
    const d = probationDecision({ recommendedByUserId: r.recommendedByUserId, deciderUserId: ctx.user.id, recommendation: r.recommendation, decision: input.decision, extendedTo: input.extendedTo ?? null, probationEndsAt: p.probationEndsAt });
    if (!d.permitted) throw new TRPCError({ code: d.refusals[0]?.includes("may not decide") ? "FORBIDDEN" : "PRECONDITION_FAILED", message: d.refusals.join("; ") });
    await db.update(probationReviews).set({ decision: input.decision, decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionNote: input.note, extendedTo: input.extendedTo ?? null }).where(eq(probationReviews.id, r.id));
    if (input.decision === "extend") await db.update(onboardingPlans).set({ probationEndsAt: input.extendedTo! }).where(eq(onboardingPlans.id, p.id));
    if (input.decision === "end") await db.update(onboardingPlans).set({ status: "ended" }).where(eq(onboardingPlans.id, p.id));
    return { reviewId: r.id, decision: input.decision, differsFromRecommendation: input.decision !== r.recommendation };
  }),

  offboardingOpen: roleProcedure("workforce.offboardingOpen").input(z.object({ userId: z.number().int().positive(), reason: z.enum(["resigned", "ended_by_company", "contract_end", "retired", "deceased", "other"]), lastDay: z.coerce.date() })).mutation(async ({ ctx, input }) => {
      // P4.1: the person must be in the caller's scope (an active member of the organization, or unaffiliated for the single tenant).
      if (!(await userInScope(input.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
    const db = await dbOrThrow();
    const open = (await db.select({ offboardingRef: offboardings.offboardingRef }).from(offboardings).where(and(eq(offboardings.userId, input.userId), eq(offboardings.status, "open"))).limit(1))[0];
    if (open) return { offboardingRef: open.offboardingRef, alreadyOpen: true as const };
    const offboardingRef = ref("OFF");
    await db.insert(offboardings).values({ offboardingRef, userId: input.userId, reason: input.reason, lastDay: input.lastDay, initiatedByUserId: ctx.user.id });
    return { offboardingRef, alreadyOpen: false as const };
  }),

  /** Every door at once: role grants and field devices revoked with the offboarding as the reason. */
  offboardingRevokeAccess: roleProcedure("workforce.offboardingRevokeAccess").input(z.object({ offboardingRef: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      // P4.1: the offboarding's person must be in the caller's scope.
      {
        const off = (await dbOrThrow().then(d => d.select({ userId: offboardings.userId }).from(offboardings).where(eq(offboardings.offboardingRef, input.offboardingRef)).limit(1)))[0];
        if (off && !(await userInScope(off.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Offboarding ${input.offboardingRef} not found` });
      }
    const db = await dbOrThrow();
    const o = (await db.select().from(offboardings).where(eq(offboardings.offboardingRef, input.offboardingRef)).limit(1))[0];
    if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding not found" });
    // B23.1 — offboarding ends employment at THIS company, not everywhere.
    //
    // This used to select every un-revoked grant the account held and revoke
    // each one, so a driver who also wrenched for a different employer lost
    // that job too the moment one of them processed an offboarding. The grants
    // revoked are now only the ones this organization issued.
    const acting = await resolveActingScope(db, ctx.user.id);
    const roles = await db.select().from(userRoleAssignments).where(and(
      eq(userRoleAssignments.userId, o.userId),
      eq(userRoleAssignments.orgRef, acting.tenantId),
      isNull(userRoleAssignments.revokedAt),
    ));
    for (const r of roles) await revokeUserRole({ userId: o.userId, role: r.role, organization: acting.tenantId, revokedByUserId: ctx.user.id, reason: `offboarding ${o.offboardingRef}` });
    const devices = await db.select().from(fieldDevices).where(and(eq(fieldDevices.userId, o.userId), isNull(fieldDevices.revokedAt)));
    for (const d of devices) await db.update(fieldDevices).set({ status: "revoked", revokedAt: new Date(), revokedByUserId: ctx.user.id, revocationReason: `offboarding ${o.offboardingRef}` }).where(eq(fieldDevices.id, d.id));
    await db.update(offboardings).set({ rolesRevokedAt: new Date(), devicesRevokedAt: new Date() }).where(eq(offboardings.id, o.id));
    return {
      offboardingRef: o.offboardingRef,
      rolesRevoked: roles.length,
      devicesRevoked: devices.length,
      // B23.1A — a door this company cannot shut, counted rather than ignored.
      //
      // Scoping the revoke to the acting organization was the fix for a
      // dual-employed worker losing their other job. It also means a
      // PLATFORM-WIDE grant (`scopeType='global'`, belonging to no
      // organization) survives an offboarding untouched, and the person walks
      // out still holding authority in every company in the deployment.
      //
      // It is not revoked here: one employer cannot unilaterally strip
      // platform authority, and if it could, so could any other. 0170's
      // backfill creates none of these and nothing in the codebase issues one
      // any more, so the honest treatment is to report the number in the act
      // that would otherwise have hidden it. Close is not blocked on it —
      // there is no procedure that could clear it, and a door with no key is a
      // dead end rather than a control.
      platformWideGrantsUntouched: await platformWideGrantsHeldBy(db, o.userId),
    };
  }),

  offboardingStatus: roleProcedure("workforce.offboardingStatus").input(z.object({ offboardingRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
      // P4.1: the offboarding's person must be in the caller's scope.
      {
        const off = (await dbOrThrow().then(d => d.select({ userId: offboardings.userId }).from(offboardings).where(eq(offboardings.offboardingRef, input.offboardingRef)).limit(1)))[0];
        if (off && !(await userInScope(off.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Offboarding ${input.offboardingRef} not found` });
      }
    const db = await dbOrThrow();
    const o = (await db.select().from(offboardings).where(eq(offboardings.offboardingRef, input.offboardingRef)).limit(1))[0];
    if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding not found" });
    const [roles, devices, tools] = await Promise.all([
      // B23.1A — this organization's grants only. Offboarding revokes what
      // THIS company issued, so counting a person's other employer's roles
      // here would mean a dual-employed worker's offboarding could never
      // close: it would forever report roles the revoke step cannot touch.
      db.select({ id: userRoleAssignments.id }).from(userRoleAssignments).where(and(eq(userRoleAssignments.userId, o.userId), eq(userRoleAssignments.orgRef, (await actingScopeFor(ctx.user.id)).tenantId), isNull(userRoleAssignments.revokedAt))),
      db.select({ id: fieldDevices.id }).from(fieldDevices).where(and(eq(fieldDevices.userId, o.userId), isNull(fieldDevices.revokedAt))),
      db.select({ id: toolCheckouts.id, toolId: toolCheckouts.toolId }).from(toolCheckouts).where(and(eq(toolCheckouts.workerUserId, o.userId), isNull(toolCheckouts.returnedAt))),
    ]);
    const c = offboardingClose({ activeRoles: roles.length, activeDevices: devices.length, activeIdentities: 0, toolsOut: tools.length, finalPayProposed: !!o.finalPayProposedAt, lastDay: o.lastDay, now: new Date() });
    const toolRows = tools.length ? await db.select({ id: serializedTools.id, serial: serializedTools.serial }).from(serializedTools) : [];
    return {
      offboardingRef: o.offboardingRef, status: o.status, canClose: c.permitted, open: c.open,
      toolsOut: tools.map(t => toolRows.find(x => x.id === t.toolId)?.serial ?? String(t.toolId)),
      // B23.1A — see offboardingRevokeAccess. Reported beside `open` rather
      // than inside it: `open` is what THIS offboarding can close, and this is
      // the one thing it cannot.
      platformWideGrants: await platformWideGrantsHeldBy(db, o.userId),
    };
  }),

  offboardingClose: roleProcedure("workforce.offboardingClose").input(z.object({ offboardingRef: z.string().min(1).max(64), finalPayProposed: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      // P4.1: the offboarding's person must be in the caller's scope.
      {
        const off = (await dbOrThrow().then(d => d.select({ userId: offboardings.userId }).from(offboardings).where(eq(offboardings.offboardingRef, input.offboardingRef)).limit(1)))[0];
        if (off && !(await userInScope(off.userId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Offboarding ${input.offboardingRef} not found` });
      }
    const db = await dbOrThrow();
    const o = (await db.select().from(offboardings).where(eq(offboardings.offboardingRef, input.offboardingRef)).limit(1))[0];
    if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding not found" });
    if (o.status === "complete") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Already complete" });
    if (input.finalPayProposed && !o.finalPayProposedAt) await db.update(offboardings).set({ finalPayProposedAt: new Date() }).where(eq(offboardings.id, o.id));
    const [roles, devices, tools] = await Promise.all([
      // B23.1A — this organization's grants only. Offboarding revokes what
      // THIS company issued, so counting a person's other employer's roles
      // here would mean a dual-employed worker's offboarding could never
      // close: it would forever report roles the revoke step cannot touch.
      db.select({ id: userRoleAssignments.id }).from(userRoleAssignments).where(and(eq(userRoleAssignments.userId, o.userId), eq(userRoleAssignments.orgRef, (await actingScopeFor(ctx.user.id)).tenantId), isNull(userRoleAssignments.revokedAt))),
      db.select({ id: fieldDevices.id }).from(fieldDevices).where(and(eq(fieldDevices.userId, o.userId), isNull(fieldDevices.revokedAt))),
      db.select({ id: toolCheckouts.id }).from(toolCheckouts).where(and(eq(toolCheckouts.workerUserId, o.userId), isNull(toolCheckouts.returnedAt))),
    ]);
    const c = offboardingClose({ activeRoles: roles.length, activeDevices: devices.length, activeIdentities: 0, toolsOut: tools.length, finalPayProposed: input.finalPayProposed || !!o.finalPayProposedAt, lastDay: o.lastDay, now: new Date() });
    if (!c.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot close: ${c.open.join("; ")}` });
    await db.update(offboardings).set({ status: "complete", toolsReturnedAt: new Date(), completedByUserId: ctx.user.id, completedAt: new Date() }).where(eq(offboardings.id, o.id));
    return { offboardingRef: o.offboardingRef, status: "complete" as const };
  }),
});
