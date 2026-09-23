/**
 * 0172 — Training wallet, renewal and external-training handoff API.
 *
 * Mounted as `trainingWallet`. Five questions kept apart:
 *   studied (Academy assignments) · demonstrated (practical evaluations) ·
 *   holds (workerQualifications through the canonical rule) · expiring
 *   (credentialLifecycle) · must be arranged (externalTrainingHandoffs).
 *
 * Boundaries this router enforces, not just describes:
 *  - an upload is recorded UNVERIFIED; OCR is never verification;
 *  - nobody verifies their own credential, nor one they recorded;
 *  - a renewal supersedes the previous verified holding; nothing is deleted
 *    (0173's triggers refuse it underneath this router as well);
 *  - no endpoint turns an Academy completion or practice result into a
 *    licence, endorsement or external certificate;
 *  - a handoff or booking never touches readiness — only a verified holding does;
 *  - dispatch gets the operational answer, never documents or private notes;
 *  - every person-keyed read or write outside the caller's own is scoped to the
 *    caller's organization and answers "not found" otherwise.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, listActiveUserRoles, listRoleNamesAnyScope, userInScope } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { authorize } from "./_core/recordsAuthorization";
import {
  academyAssignments, academyCourses, academyCourseVersions, academyPracticalEvaluations, academyQualifications, academyRequirements,
  academySourceRecords, credentialCompanySettings, crewMembers, externalTrainingHandoffs, trainingProviderCapabilities, users, vendors, workerQualifications,
} from "../drizzle/schema";
import {
  CREDENTIAL_POLICIES, DEFAULT_WARNING_THRESHOLDS, HANDOFF_CAPABILITIES, crewCoverage, heldForWork, lifecycleFacts, normalizeThresholds,
  operationalView, planRenewalReminders, policyFor, shortageForecast, studiedButNotHeld, supersedePlan, walletRecordDecision, walletVerificationDecision,
  type VerificationMethod, type WalletBoundary, type WalletHolding,
} from "./_core/credentialLifecycle";
import { ADMIN_MARKS, HANDOFF_STATUSES, TERMINAL, handoffTransition, openDuplicate, providerOptions, requestAuthority, workerFacingStatus, type HandoffStatus } from "./_core/externalTrainingHandoff";
import { CAREER_PATHWAYS, evaluatePathway } from "./_core/careerPathway";
import { recentSweepRuns, renewalQueueFor, runRenewalSweepForTenant } from "./renewalOperations";
import { COMPANY_POLICY_LABEL, DEFAULT_ESCALATION, handoffRecoveryNote, validateEscalation, walletStatus, type EscalationPolicy } from "./_core/complianceOperations";

const ESCALATION_CATEGORIES = ["safety_ticket", "driver_licence", "company_review", "regulated_employer", "medical", "other"] as const;
import { academyAudit, academyHoldingsFor, asHolding, tenantsForUsers, deliverReminders, holdingRowsFor, isCurrentVerified, parseList, settingsFor, syncCredentialPolicies, tenantSettings } from "./trainingWalletService";

const ref = (p: string) => `${p}-${randomUUID().toUpperCase()}`;
async function dbOrThrow() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}
type Db = Awaited<ReturnType<typeof dbOrThrow>>;

async function tenantOf(db: Db, userId: number) { return (await resolveActingScope(db, userId)).tenantId; }
async function requirePerson(callerUserId: number, subjectId: number) {
  if (callerUserId === subjectId) return;
  const db = await dbOrThrow();
  const scope = { tenantId: (await resolveActingScope(db, callerUserId)).tenantId };
  if (!(await userInScope(subjectId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${subjectId} not found` });
}
async function holds(userId: number, permission: Parameters<typeof authorize>[0]["permission"]) {
  return authorize({ userId, grants: await listActiveUserRoles(userId), permission }).allowed;
}

const boundaryZ = z.enum(["employer_issued", "company_competency", "regulator_issued", "external_provider", "study_only"]);
const recordInput = z.object({
  code: z.string().min(2).max(60).regex(/^[A-Z0-9_]+$/),
  displayName: z.string().min(2).max(220).optional(),
  issuer: z.string().min(2).max(220).optional(),
  issuingJurisdiction: z.string().min(2).max(40).optional(),
  certificateNumber: z.string().min(1).max(120).optional(),
  issuedAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  endorsements: z.array(z.string().min(1).max(40)).max(20).optional(),
  restrictions: z.array(z.string().min(1).max(60)).max(20).optional(),
  boundary: boundaryZ,
  documentRef: z.string().min(1).max(64).optional(),
  backDocumentRef: z.string().min(1).max(64).optional(),
  handoffRef: z.string().min(1).max(96).optional(),
  /** The only evidence kinds a wallet record may come from. An Academy completion is not one of them. */
  evidenceKind: z.enum(["uploaded_document", "issuer_record"]).default("uploaded_document"),
}).strict();

/** The one open handoff for this person and code that is waiting on a certificate, if exactly one is. */
const AWAITING_CERTIFICATE: HandoffStatus[] = ["TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED"];
async function awaitingCertificate(db: Db, userId: number, code: string) {
  const open = await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.userId, userId), eq(externalTrainingHandoffs.qualificationCode, code), inArray(externalTrainingHandoffs.status, AWAITING_CERTIFICATE))).limit(5);
  return open.length === 1 ? open[0]! : null;
}

/** A date read off a document is a calendar day; the verifier's reading and the claim agree when the day agrees. */
const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * 0174 — handoff → certificate closure, run when a holding is verified.
 * Steps the handoff through the transition rule (never by assertion):
 * TRAINING_COMPLETED / DOCUMENT_PENDING → DOCUMENT_UPLOADED_UNVERIFIED → VERIFIED → ACTIVE
 * (ACTIVE only when the canonical rule now counts the credential as held).
 * Handoff completion alone never creates or verifies a credential; this runs
 * only after the wallet verified one.
 */
async function closeHandoffForVerified(db: Db, actorUserId: number, row: typeof workerQualifications.$inferSelect, now: Date) {
  const h = row.handoffRef
    ? (await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.handoffRef, row.handoffRef), eq(externalTrainingHandoffs.userId, row.userId))).limit(1))[0]
    : await awaitingCertificate(db, row.userId, row.code);
  if (!h || !AWAITING_CERTIFICATE.includes(h.status)) return null;
  const heldNow = heldForWork((await holdingRowsFor(db, [row.userId])).map(asHolding), h.qualificationCode, now).held;
  const linkedHolding = { verificationState: "verified", code: row.code };
  const path: HandoffStatus[] = [...(h.status === "DOCUMENT_UPLOADED_UNVERIFIED" ? [] : ["DOCUMENT_UPLOADED_UNVERIFIED" as const]), "VERIFIED", ...(heldNow ? ["ACTIVE" as const] : [])];
  let from = h.status;
  for (const to of path) {
    const t = handoffTransition({ from, to, actor: "admin", linkedHolding, qualificationCode: h.qualificationCode, heldNow });
    if (!t.permitted) break;
    await db.update(externalTrainingHandoffs).set({ status: to, linkedHoldingRef: row.holdingRef, lastTransitionAt: now, closedAt: TERMINAL.has(to) ? now : null }).where(eq(externalTrainingHandoffs.id, h.id));
    await academyAudit(db, actorUserId, "training_handoff", h.handoffRef, `handoff.${to.toLowerCase()}`, { from, holdingRef: row.holdingRef, via: "credential_verified" });
    from = to;
  }
  return { handoffRef: h.handoffRef, status: from };
}

async function recordHolding(db: Db, args: { callerId: number; subjectId: number; tenantId: string; input: z.infer<typeof recordInput>; correctsHoldingRef?: string }) {
  const policy = policyFor(args.input.code);
  const boundary = args.input.boundary as WalletBoundary;
  const decision = walletRecordDecision({ boundary, evidenceKind: args.input.evidenceKind });
  if (!decision.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.blockers.join("; ") });
  if (policy && policy.boundary !== boundary) throw new TRPCError({ code: "BAD_REQUEST", message: `${policy.displayName} is a ${policy.boundary.replaceAll("_", " ")} credential` });
  if (policy?.lifecycle === "no_expiry_endorsement" && args.input.expiresAt) throw new TRPCError({ code: "BAD_REQUEST", message: `${policy.displayName} has no renewal by rule; do not record a fabricated expiry` });
  const holdingRef = ref("WQ");
  const now = new Date();
  // 0174: an upload for a code with exactly one handoff waiting on its certificate links to it,
  // so the credential can be traced back to the request that produced it.
  const handoffRef = args.input.handoffRef ?? (await awaitingCertificate(db, args.subjectId, args.input.code))?.handoffRef;
  await db.insert(workerQualifications).values({
    holdingRef, tenantId: args.tenantId, userId: args.subjectId, code: args.input.code, certificateNumber: args.input.certificateNumber ?? null,
    issuedAt: args.input.issuedAt ?? null, expiresAt: args.input.expiresAt ?? null, verificationState: "unverified",
    documentRef: args.input.documentRef ?? null, backDocumentRef: args.input.backDocumentRef ?? null,
    recordedByUserId: args.callerId, recordedAt: now,
    displayName: args.input.displayName ?? policy?.displayName ?? null, issuer: args.input.issuer ?? null, issuingJurisdiction: args.input.issuingJurisdiction ?? null,
    endorsementsJson: args.input.endorsements ? JSON.stringify(args.input.endorsements) : null,
    restrictionsJson: args.input.restrictions ? JSON.stringify(args.input.restrictions) : null,
    walletBoundary: boundary, policyRef: policy?.policyRef ?? null, handoffRef: handoffRef ?? null,
    correctsHoldingRef: args.correctsHoldingRef ?? null,
  });
  await academyAudit(db, args.callerId, "wallet_holding", holdingRef, "holding.recorded_unverified", { userId: args.subjectId, code: args.input.code, boundary, evidenceKind: args.input.evidenceKind, documentRef: args.input.documentRef ?? null, handoffRef: handoffRef ?? null, correctsHoldingRef: args.correctsHoldingRef ?? null });
  if (handoffRef) {
    const h = (await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.handoffRef, handoffRef), eq(externalTrainingHandoffs.userId, args.subjectId))).limit(1))[0];
    if (h && !TERMINAL.has(h.status) && ["TRAINING_COMPLETED", "DOCUMENT_PENDING"].includes(h.status)) {
      await db.update(externalTrainingHandoffs).set({ status: "DOCUMENT_UPLOADED_UNVERIFIED", linkedHoldingRef: holdingRef, lastTransitionAt: now }).where(eq(externalTrainingHandoffs.id, h.id));
      await academyAudit(db, args.callerId, "training_handoff", h.handoffRef, "handoff.document_uploaded_unverified", { holdingRef });
    }
  }
  return { holdingRef, verificationState: "unverified" as const, notice: "Recorded as UNVERIFIED. An uploaded certificate does not satisfy any work until safety/admin verifies it." };
}

/** The wallet as its owner or a manager sees it. `includePrivate` only for safety/HR/management. */
async function walletFor(db: Db, userId: number, includePrivate: boolean, now: Date) {
  const tenantId = await tenantOf(db, userId);
  const rows = await holdingRowsFor(db, [userId]);
  const holdings = rows.map(asHolding);
  const settings = await tenantSettings(db, tenantId);
  const codes = Array.from(new Set([...rows.map(r => r.code)]));
  const academyQuals = await db.select().from(academyQualifications).where(eq(academyQualifications.userId, userId)).orderBy(desc(academyQualifications.id));
  const assignments = await db.select({ ref: academyAssignments.assignmentRef, status: academyAssignments.status, completedAt: academyAssignments.completedAt, courseCode: academyCourses.courseCode, title: academyCourses.title, boundary: academyCourses.credentialBoundary, qualificationCode: academyCourses.externalCredentialCode, dueAt: academyAssignments.dueAt })
    .from(academyAssignments).innerJoin(academyCourseVersions, eq(academyCourseVersions.id, academyAssignments.courseVersionId)).innerJoin(academyCourses, eq(academyCourses.id, academyCourseVersions.courseId))
    .where(eq(academyAssignments.userId, userId)).limit(200);
  const practicals = await db.select().from(academyPracticalEvaluations).where(eq(academyPracticalEvaluations.userId, userId)).limit(200);
  const handoffs = await db.select().from(externalTrainingHandoffs).where(eq(externalTrainingHandoffs.userId, userId)).orderBy(desc(externalTrainingHandoffs.id)).limit(100);
  return {
    disclaimer: "Studied, demonstrated, held, expiring and arranged are five different answers. Only a verified credential in this wallet satisfies work, and only through the canonical qualification rule.",
    studied: assignments.map(a => ({ ...a, note: a.boundary === "external_track_only" ? "Study/preparation only — not a licence, endorsement or external certificate" : null })),
    demonstrated: practicals.map(p => ({ evaluationRef: p.evaluationRef, competencyCode: p.competencyCode, status: p.status, evaluatorUserId: p.evaluatorUserId, observedAt: p.observedAt, expiresAt: p.expiresAt })),
    credentials: rows.sort((a, b) => Number(isCurrentVerified(b)) - Number(isCurrentVerified(a)) || b.recordedAt.getTime() - a.recordedAt.getTime() || b.id - a.id).map(r => {
      const policy = policyFor(r.code);
      return {
        holdingRef: r.holdingRef, code: r.code, displayName: r.displayName ?? policy?.displayName ?? r.code, issuer: r.issuer, issuingJurisdiction: r.issuingJurisdiction,
        certificateNumber: r.certificateNumber, issuedAt: r.issuedAt, expiresAt: r.expiresAt,
        endorsements: parseList(r.endorsementsJson), restrictions: parseList(r.restrictionsJson),
        documentRef: r.documentRef, backDocumentRef: r.backDocumentRef,
        verificationState: r.verificationState, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt,
        verificationMethod: r.verificationMethod, verificationSource: r.verificationSource,
        supersededByHoldingRef: r.supersededByHoldingRef, supersedesHoldingRef: r.supersedesHoldingRef,
        boundary: r.walletBoundary ?? policy?.boundary ?? null, lifecycle: policy?.lifecycle ?? "unknown",
        current: isCurrentVerified(r),
        correction: r.correctionRequestedAt && (r.verificationState === "unverified" || r.verificationState === "extracted") ? { requestedAt: r.correctionRequestedAt, note: r.correctionNote } : null,
        correctsHoldingRef: r.correctsHoldingRef,
        privateNotes: includePrivate ? r.privateNotes : undefined,
      };
    }),
    academyCertificates: academyQuals.map(q => ({ qualificationRef: q.qualificationRef, code: q.qualificationCode, sourceKind: q.sourceKind, status: q.status, validFrom: q.validFrom, expiresAt: q.expiresAt })),
    expiring: codes.map(code => {
      const f = lifecycleFacts({ code, holdings, policy: policyFor(code), settings: settingsFor(settings, code), now });
      const v = heldForWork(holdings, code, now);
      const open = handoffs.filter(h => h.qualificationCode === code && !TERMINAL.has(h.status)).sort((a, b) => b.id - a.id)[0] ?? null;
      const w = walletStatus({ facts: f, verdict: v, handoff: open ? { status: open.status, requestedAt: open.requestedAt, appointmentAt: open.appointmentAt } : null, now });
      const pendingCorrection = rows.some(r => r.code === code && r.correctionRequestedAt && (r.verificationState === "unverified" || r.verificationState === "extracted"));
      return { code, basis: f.basis, legalExpiry: f.legalExpiry, employerReviewAt: f.employerReviewAt, recommendedRefresherAt: f.recommendedRefresherAt, renewalWindow: f.renewalWindow, labels: f.labels, held: v.held, heldReason: v.reason, canRequestTraining: !!policyFor(code)?.handoffCapabilities?.length,
        walletStatus: w.status, renewalStatus: w.renewal, statusLine: w.line, renewalSteps: w.renewalSteps, validityNote: w.validityNote, correctionRequested: pendingCorrection };
    }),
    arranged: handoffs.map(h => ({ handoffRef: h.handoffRef, code: h.qualificationCode, status: h.status, worker: workerFacingStatus(h.status), appointmentAt: h.appointmentAt, bookingReference: h.bookingReference, requestedAt: h.requestedAt, dueAt: h.dueAt })),
  };
}

const queueStatuses: HandoffStatus[] = HANDOFF_STATUSES.filter(s => !TERMINAL.has(s));

export const trainingWalletRouter = router({
  /** Your own wallet: all five answers, never your private HR/safety notes. */
  myWallet: roleProcedure("trainingWallet.myWallet").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    return walletFor(db, ctx.user.id, false, new Date());
  }),

  /** Upload your own certificate/licence. Always recorded UNVERIFIED. */
  recordOwn: roleProcedure("trainingWallet.recordOwn").input(recordInput).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    return recordHolding(db, { callerId: ctx.user.id, subjectId: ctx.user.id, tenantId: await tenantOf(db, ctx.user.id), input });
  }),

  /** Safety/HR record on somebody's behalf — still UNVERIFIED, and the recorder may not then verify it. */
  recordFor: roleProcedure("trainingWallet.recordFor").input(recordInput.extend({ userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requirePerson(ctx.user.id, input.userId);
    const db = await dbOrThrow();
    const { userId, ...rest } = input;
    return recordHolding(db, { callerId: ctx.user.id, subjectId: userId, tenantId: await tenantOf(db, ctx.user.id), input: rest });
  }),

  /**
   * Verify against the document or the issuer. A renewal supersedes the
   * previous verified holding of the same code; nothing is deleted.
   */
  verify: roleProcedure("trainingWallet.verify")
    .input(z.object({
      holdingRef: z.string().min(1).max(64),
      method: z.enum(["original_sighted", "document_inspection", "issuer_registry_check", "issuer_confirmation", "ocr_extraction"]),
      verificationSource: z.string().min(3).max(300),
      /** The verifier confirms the dates from the document; they are not taken from OCR. */
      issuedAt: z.coerce.date().nullable(),
      expiresAt: z.coerce.date().nullable(),
      privateNote: z.string().max(2000).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const row = (await db.select().from(workerQualifications).where(eq(workerQualifications.holdingRef, input.holdingRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      await requirePerson(ctx.user.id, row.userId);
      if (row.userId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Nobody may verify their own credential" });
      if (row.verificationState !== "unverified" && row.verificationState !== "extracted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Credential is already ${row.verificationState}` });
      if (row.correctionRequestedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A correction was requested on this upload; verify the corrected record the employee submits" });
      // 0174: the verifier confirms what was uploaded; they cannot edit it into validity. A claimed
      // date the document does not bear is a correction request, not a verifier's edit. A date the
      // upload left blank is read off the document by the verifier (and audited as such).
      for (const [k, claimed, read] of [["issue date", row.issuedAt, input.issuedAt], ["expiry date", row.expiresAt, input.expiresAt]] as const) {
        if (claimed && dayOf(claimed) !== dayOf(read)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The ${k} on the document (${dayOf(read) ?? "none"}) differs from the uploaded claim (${dayOf(claimed)}); request a correction instead of changing it` });
      }
      const policy = policyFor(row.code);
      const boundary = (row.walletBoundary ?? policy?.boundary ?? "external_provider") as WalletBoundary;
      const decision = walletVerificationDecision({
        subjectUserId: row.userId, verifierUserId: ctx.user.id, recordedByUserId: row.recordedByUserId, policy, boundary,
        method: input.method as VerificationMethod, documentRefs: [row.documentRef, row.backDocumentRef].filter((x): x is string => !!x),
        expiresAt: input.expiresAt, issuedAt: input.issuedAt,
      });
      if (!decision.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.blockers.join("; ") });
      const now = new Date();
      const all = (await holdingRowsFor(db, [row.userId])).map(asHolding);
      const plan = supersedePlan(all, { ...asHolding(row), verificationState: "verified" });
      await db.update(workerQualifications).set({
        verificationState: "verified", verifiedByUserId: ctx.user.id, verifiedAt: now, issuedAt: input.issuedAt, expiresAt: input.expiresAt,
        verificationMethod: input.method, verificationSource: input.verificationSource,
        supersedesHoldingRef: plan[0]?.holdingRef ?? null,
        privateNotes: input.privateNote ? `${row.privateNotes ? `${row.privateNotes}\n` : ""}${input.privateNote}` : row.privateNotes,
      }).where(eq(workerQualifications.id, row.id));
      for (const s of plan) {
        await db.update(workerQualifications).set({ verificationState: "superseded", supersededByHoldingRef: s.supersededByHoldingRef }).where(eq(workerQualifications.holdingRef, s.holdingRef));
        await academyAudit(db, ctx.user.id, "wallet_holding", s.holdingRef, "holding.superseded", { by: s.supersededByHoldingRef });
      }
      await academyAudit(db, ctx.user.id, "wallet_holding", row.holdingRef, "holding.verified", { userId: row.userId, code: row.code, method: input.method, issuedAt: input.issuedAt, expiresAt: input.expiresAt, superseded: plan.map(p => p.holdingRef) });
      // A linked handoff may now close — through the same transition rule, never by assertion.
      const handoff = await closeHandoffForVerified(db, ctx.user.id, { ...row, verificationState: "verified" }, now);
      return { holdingRef: row.holdingRef, verificationState: "verified" as const, superseded: plan.map(p => p.holdingRef), handoff };
    }),

  reject: roleProcedure("trainingWallet.reject")
    .input(z.object({ holdingRef: z.string().min(1).max(64), reason: z.string().min(3).max(1000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const row = (await db.select().from(workerQualifications).where(eq(workerQualifications.holdingRef, input.holdingRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      await requirePerson(ctx.user.id, row.userId);
      if (row.userId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Nobody may review their own credential" });
      if (row.verificationState !== "unverified" && row.verificationState !== "extracted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Credential is already ${row.verificationState}` });
      await db.update(workerQualifications).set({ verificationState: "rejected", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), privateNotes: `${row.privateNotes ? `${row.privateNotes}\n` : ""}Rejected: ${input.reason}` }).where(eq(workerQualifications.id, row.id));
      await academyAudit(db, ctx.user.id, "wallet_holding", row.holdingRef, "holding.rejected", { reason: input.reason });
      return { holdingRef: row.holdingRef, verificationState: "rejected" as const };
    }),

  /**
   * 0174 — "Uploaded — Verification Required". Everything the verifier needs to decide
   * without leaving the screen, scoped to the caller's organization at the query.
   */
  verificationQueue: roleProcedure("trainingWallet.verificationQueue").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const tenantId = await tenantOf(db, ctx.user.id);
    const tenantWhere = tenantId === SINGLE_TENANT_ID ? or(isNull(workerQualifications.tenantId), eq(workerQualifications.tenantId, SINGLE_TENANT_ID)) : eq(workerQualifications.tenantId, tenantId);
    const pending = await db.select().from(workerQualifications).where(and(tenantWhere, inArray(workerQualifications.verificationState, ["unverified", "extracted"]))).orderBy(workerQualifications.recordedAt).limit(300);
    const userIds = Array.from(new Set(pending.map(r => r.userId)));
    const people = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
    const all = await holdingRowsFor(db, userIds);
    const handoffRefs = Array.from(new Set(pending.map(r => r.handoffRef).filter((x): x is string => !!x)));
    const handoffs = handoffRefs.length ? await db.select().from(externalTrainingHandoffs).where(inArray(externalTrainingHandoffs.handoffRef, handoffRefs)) : [];
    const codes = Array.from(new Set(pending.map(r => r.code)));
    const bound = codes.length ? await db.select({ code: academyRequirements.qualificationCode, title: academyRequirements.title }).from(academyRequirements).where(and(inArray(academyRequirements.qualificationCode, codes), eq(academyRequirements.active, true))) : [];
    const now = new Date();
    return pending.map(r => {
      const policy = policyFor(r.code);
      const mine = all.filter(x => x.userId === r.userId);
      const previous = mine.filter(x => x.code === r.code && isCurrentVerified(x)).sort((a, b) => b.id - a.id)[0] ?? null;
      const heldNow = heldForWork(mine.map(asHolding), r.code, now);
      const ifVerified = heldForWork([...mine.filter(x => x.id !== r.id).map(asHolding), { ...asHolding(r), verificationState: "verified" as const }], r.code, now);
      const h = handoffs.find(x => x.handoffRef === r.handoffRef) ?? null;
      return {
        holdingRef: r.holdingRef, employee: { userId: r.userId, name: people.find(p => p.id === r.userId)?.name ?? null },
        code: r.code, displayName: r.displayName ?? policy?.displayName ?? r.code, issuer: r.issuer, issuingJurisdiction: r.issuingJurisdiction,
        certificateNumber: r.certificateNumber, issuedAt: r.issuedAt, expiresAt: r.expiresAt, documentRef: r.documentRef, backDocumentRef: r.backDocumentRef,
        endorsements: parseList(r.endorsementsJson), restrictions: parseList(r.restrictionsJson), recordedAt: r.recordedAt, recordedByUserId: r.recordedByUserId,
        verificationState: r.verificationState, correctsHoldingRef: r.correctsHoldingRef,
        correction: r.correctionRequestedAt ? { requestedAt: r.correctionRequestedAt, byUserId: r.correctionRequestedByUserId, note: r.correctionNote } : null,
        previousVerified: previous ? { holdingRef: previous.holdingRef, issuedAt: previous.issuedAt, expiresAt: previous.expiresAt, verifiedAt: previous.verifiedAt } : null,
        implications: {
          heldNow: heldNow.held, heldNowReason: heldNow.reason, heldIfVerified: ifVerified.held,
          requirements: bound.filter(b => b.code === r.code).map(b => b.title),
          note: "Verification is what makes this count. Until then dispatch reads it as UNVERIFIED.",
        },
        handoff: h ? { handoffRef: h.handoffRef, status: h.status, requestedAt: h.requestedAt, bookingReference: h.bookingReference } : null,
        callerMayAct: r.userId !== ctx.user.id && r.recordedByUserId !== ctx.user.id,
        callerBlockedBecause: r.userId === ctx.user.id ? "This is your own credential" : r.recordedByUserId === ctx.user.id ? "You recorded this credential" : null,
      };
    });
  }),

  /**
   * The verifier found something wrong with the upload. The upload is not edited:
   * the employee is asked for a corrected record, which is a new holding.
   */
  requestCorrection: roleProcedure("trainingWallet.requestCorrection")
    .input(z.object({ holdingRef: z.string().min(1).max(64), note: z.string().min(10).max(1000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const row = (await db.select().from(workerQualifications).where(eq(workerQualifications.holdingRef, input.holdingRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      await requirePerson(ctx.user.id, row.userId);
      if (row.userId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Nobody may review their own credential" });
      if (row.verificationState !== "unverified" && row.verificationState !== "extracted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Credential is already ${row.verificationState}` });
      if (row.correctionRequestedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A correction has already been requested" });
      const now = new Date();
      await db.update(workerQualifications).set({ correctionRequestedAt: now, correctionRequestedByUserId: ctx.user.id, correctionNote: input.note }).where(eq(workerQualifications.id, row.id));
      await academyAudit(db, ctx.user.id, "wallet_holding", row.holdingRef, "holding.correction_requested", { userId: row.userId, code: row.code, note: input.note });
      const tenantId = row.tenantId ?? SINGLE_TENANT_ID;
      await deliverReminders(db, tenantId, [{
        notificationKey: `wallet-correction:${row.holdingRef}`, recipient: { kind: "user" as const, userId: row.userId }, holdingRef: row.holdingRef, code: row.code,
        threshold: 0, targetKind: "legal_expiry" as const, escalation: "employee" as const,
        title: `Correction needed: ${row.displayName ?? row.code}`, body: `Safety/admin could not verify your upload: ${input.note} Upload a corrected record from your wallet. Until then it does not count for any work.`,
      }], now);
      return { holdingRef: row.holdingRef, correctionRequested: true as const };
    }),

  /** The employee's corrected record: a new UNVERIFIED holding that names the one it corrects. */
  submitCorrection: roleProcedure("trainingWallet.submitCorrection")
    .input(recordInput.extend({ correctsHoldingRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { correctsHoldingRef, ...rest } = input;
      const old = (await db.select().from(workerQualifications).where(and(eq(workerQualifications.holdingRef, correctsHoldingRef), eq(workerQualifications.userId, ctx.user.id))).limit(1))[0];
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "Credential not found" });
      if (!old.correctionRequestedAt || (old.verificationState !== "unverified" && old.verificationState !== "extracted")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No correction is outstanding on that record" });
      if (rest.code !== old.code) throw new TRPCError({ code: "BAD_REQUEST", message: `A correction is for the same credential (${old.code}); record a different credential separately` });
      const created = await recordHolding(db, { callerId: ctx.user.id, subjectId: ctx.user.id, tenantId: old.tenantId ?? await tenantOf(db, ctx.user.id), input: { ...rest, handoffRef: rest.handoffRef ?? old.handoffRef ?? undefined }, correctsHoldingRef });
      await db.update(workerQualifications).set({ verificationState: "rejected", privateNotes: `${old.privateNotes ? `${old.privateNotes}\n` : ""}Replaced by corrected record ${created.holdingRef}` }).where(eq(workerQualifications.id, old.id));
      await academyAudit(db, ctx.user.id, "wallet_holding", old.holdingRef, "holding.corrected", { by: created.holdingRef });
      return { ...created, correctsHoldingRef };
    }),

  /** Safety/HR/management view of one person, including private notes. */
  personWallet: roleProcedure("trainingWallet.personWallet").input(z.object({ userId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await requirePerson(ctx.user.id, input.userId);
    return walletFor(await dbOrThrow(), input.userId, true, new Date());
  }),

  /**
   * What dispatch sees: held / expired / unverified / unknown / restricted,
   * with the recovery path. No certificate numbers, documents or notes.
   */
  operationalView: roleProcedure("trainingWallet.operationalView")
    .input(z.object({ userId: z.number().int().positive(), codes: z.array(z.string().min(1).max(100)).min(1).max(30), interprovincial: z.boolean().optional(), at: z.coerce.date().optional() }))
    .query(async ({ ctx, input }) => {
      await requirePerson(ctx.user.id, input.userId);
      const db = await dbOrThrow();
      const holdings = (await holdingRowsFor(db, [input.userId])).map(asHolding);
      const open = await db.select({ code: externalTrainingHandoffs.qualificationCode, status: externalTrainingHandoffs.status, appointmentAt: externalTrainingHandoffs.appointmentAt }).from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.userId, input.userId), inArray(externalTrainingHandoffs.qualificationCode, input.codes))).limit(100);
      const results = operationalView({ holdings, codes: input.codes, at: input.at ?? new Date(), scope: { interprovincial: !!input.interprovincial } });
      // 0174: the renewal in motion is explanation only; `state` is the canonical rule's answer, unchanged.
      return { userId: input.userId, results: results.map(r => ({ ...r, renewalProgress: r.state === "held" ? null : handoffRecoveryNote(open.find(h => h.code === r.code && !TERMINAL.has(h.status))) })) };
    }),

  policies: roleProcedure("trainingWallet.policies").query(async () => ({
    policies: CREDENTIAL_POLICIES.map(p => ({ ...p, notice: p.typicalValidityMonths ? `Typical validity ${p.typicalValidityMonths} months is context only; LeaseOS reads the actual expiry from the verified certificate.` : null })),
    defaultThresholds: DEFAULT_WARNING_THRESHOLDS,
    capabilities: HANDOFF_CAPABILITIES,
  })),

  settingsGet: roleProcedure("trainingWallet.settingsGet").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const s = await tenantSettings(db, await tenantOf(db, ctx.user.id));
    return {
      thresholds: s.thresholds ?? [...DEFAULT_WARNING_THRESHOLDS], perCode: s.perCode,
      escalation: s.escalation ?? {}, defaultEscalation: DEFAULT_ESCALATION, categories: ESCALATION_CATEGORIES, malformed: s.malformed,
      notice: "Notification thresholds, escalation ladders and review intervals here are company policy — never a regulatory expiry.",
    };
  }),

  settingsSet: roleProcedure("trainingWallet.settingsSet")
    .input(z.object({
      thresholds: z.array(z.number().int().min(1).max(730)).min(1).max(12),
      perCode: z.record(z.string().regex(/^[A-Z0-9_]+$/), z.object({ employerReviewMonths: z.number().int().min(1).max(120).nullable().optional(), recommendedRefresherMonths: z.number().int().min(1).max(120).nullable().optional() })).optional(),
      /** 0174 — escalation ladders by credential category (or "default"). Omitted = unchanged; {} = LeaseOS defaults. */
      escalation: z.record(z.enum(["default", ...ESCALATION_CATEGORIES] as [string, ...string[]]), z.object({
        steps: z.array(z.object({ threshold: z.union([z.number().int(), z.literal("expired")]), recipients: z.array(z.enum(["employee", "supervisor", "safety", "hr", "management"])).min(1).max(5), urgency: z.enum(["awareness", "notice", "urgent", "critical", "exception"]) }).strict()).min(1).max(12),
      }).strict()).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const tenantId = await tenantOf(db, ctx.user.id);
      for (const [code, v] of Object.entries(input.perCode ?? {})) {
        const p = policyFor(code);
        if (v.employerReviewMonths != null && p && p.lifecycle !== "employer_review") throw new TRPCError({ code: "BAD_REQUEST", message: `${code} is governed by ${p.lifecycle.replaceAll("_", " ")}; a company review interval would read as an expiry it does not have` });
      }
      const thresholds = normalizeThresholds(input.thresholds);
      const ladders: Record<string, EscalationPolicy> = {};
      for (const [category, p] of Object.entries(input.escalation ?? {})) {
        const policy: EscalationPolicy = { label: COMPANY_POLICY_LABEL, steps: p.steps as EscalationPolicy["steps"] };
        const problems = validateEscalation(policy);
        if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${category}: ${problems.join("; ")}` });
        ladders[category] = policy;
      }
      const escalationJson = input.escalation === undefined ? undefined : Object.keys(ladders).length ? JSON.stringify(ladders) : null;
      const existing = (await db.select().from(credentialCompanySettings).where(eq(credentialCompanySettings.tenantId, tenantId)).limit(1))[0];
      if (existing) await db.update(credentialCompanySettings).set({ warningThresholdsJson: JSON.stringify(thresholds), perCodeJson: JSON.stringify(input.perCode ?? {}), updatedByUserId: ctx.user.id, ...(escalationJson !== undefined ? { escalationPolicyJson: escalationJson } : {}) }).where(eq(credentialCompanySettings.id, existing.id));
      else await db.insert(credentialCompanySettings).values({ tenantId, warningThresholdsJson: JSON.stringify(thresholds), perCodeJson: JSON.stringify(input.perCode ?? {}), updatedByUserId: ctx.user.id, escalationPolicyJson: escalationJson ?? null });
      await academyAudit(db, ctx.user.id, "credential_settings", tenantId, "settings.updated", { thresholds, perCode: input.perCode ?? {}, escalation: input.escalation === undefined ? "unchanged" : ladders });
      return { thresholds };
    }),

  /**
   * Plan and deliver renewal reminders for the caller's organization.
   * Idempotent: re-running it sends nothing already sent.
   */
  renewalSweep: roleProcedure("trainingWallet.renewalSweep").input(z.object({ at: z.coerce.date().optional() }).optional()).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    await syncCredentialPolicies(db);
    const tenantId = await tenantOf(db, ctx.user.id);
    // 0174: the same engine call the production worker makes on its schedule.
    const r = await runRenewalSweepForTenant(db, tenantId, input?.at ?? new Date(), ctx.user.id);
    return { planned: r.planned, sent: r.notificationsCreated, suppressed: r.suppressed, sentKeys: r.sentKeys, inspected: r.inspected, actionable: r.actionable, failures: r.failures };
  }),

  /** 0174 — the Renewal Queue: who, what, when, readiness impact, handoff, last reminder, next escalation. */
  renewalQueue: roleProcedure("trainingWallet.renewalQueue").input(z.object({ at: z.coerce.date().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const tenantId = await tenantOf(db, ctx.user.id);
    const rows = await renewalQueueFor(db, tenantId, input?.at ?? new Date());
    const ids = Array.from(new Set(rows.map(r => r.userId)));
    const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
    return { rows: rows.map(r => ({ ...r, employeeName: people.find(p => p.id === r.userId)?.name ?? null })), notice: COMPANY_POLICY_LABEL };
  }),

  /** 0174 — the scheduled sweep's own health: recent runs and whether any failed. */
  sweepRuns: roleProcedure("trainingWallet.sweepRuns").query(async () => {
    const db = await dbOrThrow();
    return { runs: await recentSweepRuns(db, 20), notice: "A failed or partial run is a SYSTEM FAILURE — it says nothing about whether any credential is valid." };
  }),

  /** "Request Training / Renewal" — for yourself, or for someone else with workforce authority. */
  requestTraining: roleProcedure("trainingWallet.requestTraining")
    .input(z.object({
      userId: z.number().int().positive().optional(),
      qualificationCode: z.string().min(2).max(100).regex(/^[A-Z0-9_]+$/),
      reason: z.string().max(500).optional(),
      preferredArea: z.string().max(220).optional(),
      requiredBy: z.coerce.date().nullable().optional(),
      triggerKind: z.enum(["expiring", "expired", "missing_required", "new_hire", "career_development", "employee_request", "admin_initiated"]).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const subject = input.userId ?? ctx.user.id;
      const authority = requestAuthority({ callerUserId: ctx.user.id, subjectUserId: subject, callerHasWorkforceAuthority: subject !== ctx.user.id && (await holds(ctx.user.id, "training.handoff.manage")) });
      if (!authority.permitted) throw new TRPCError({ code: "FORBIDDEN", message: authority.reason! });
      await requirePerson(ctx.user.id, subject);
      const db = await dbOrThrow();
      const policy = policyFor(input.qualificationCode);
      if (!policy?.handoffCapabilities?.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${input.qualificationCode} is not an external credential LeaseOS hands off; internal training is assigned through the Academy` });
      const tenantId = await tenantOf(db, subject);
      const existing = await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.userId, subject), eq(externalTrainingHandoffs.qualificationCode, input.qualificationCode))).limit(50);
      const dup = openDuplicate(existing, subject, input.qualificationCode);
      if (dup) return { handoffRef: dup.handoffRef, status: dup.status, reused: true };
      const now = new Date();
      const holdings = (await holdingRowsFor(db, [subject])).map(asHolding);
      const facts = lifecycleFacts({ code: input.qualificationCode, holdings, policy, now });
      const bound = await db.select({ code: academyRequirements.requirementCode, title: academyRequirements.title }).from(academyRequirements).where(and(eq(academyRequirements.qualificationCode, input.qualificationCode), eq(academyRequirements.active, true))).limit(20);
      const handoffRef = ref("HANDOFF");
      const trigger = input.triggerKind ?? (facts.legalExpiry ? (facts.legalExpiry < now ? "expired" : "expiring") : subject === ctx.user.id ? "employee_request" : "admin_initiated");
      await db.insert(externalTrainingHandoffs).values({
        handoffRef, tenantId, userId: subject, qualificationCode: input.qualificationCode, capabilityCode: policy.handoffCapabilities[0] ?? null,
        triggerKind: trigger, reason: input.reason ?? null, status: "REQUESTED", dueAt: input.requiredBy ?? facts.legalExpiry ?? null,
        currentExpiresAt: facts.legalExpiry, preferredArea: input.preferredArea ?? null, officialSourceRef: policy.sourceRefs[0] ?? null,
        requestedByUserId: ctx.user.id, requestedAt: now, lastTransitionAt: now,
        dispatchImpact: bound.length ? `Required by ${bound.map(b => b.title).join("; ")}` : "No bound dispatch requirement",
      });
      await academyAudit(db, ctx.user.id, "training_handoff", handoffRef, "handoff.requested", { userId: subject, qualificationCode: input.qualificationCode, trigger });
      await deliverReminders(db, tenantId, (["safety", "hr"] as const).map(role => ({
        notificationKey: `handoff:${handoffRef}:requested:${role}`, recipient: { kind: "role" as const, role }, holdingRef: handoffRef, code: input.qualificationCode,
        threshold: 0, targetKind: "legal_expiry" as const, escalation: "supervisor_safety_admin" as const,
        title: `Training requested: ${policy.displayName} — employee ${subject}`, body: `Requested ${now.toISOString().slice(0, 10)}. ${facts.legalExpiry ? `Current expiry ${facts.legalExpiry.toISOString().slice(0, 10)}.` : "No current verified credential."} This request does not change dispatch readiness.`,
      })), now);
      return { handoffRef, status: "REQUESTED" as const, reused: false, notice: "Requested. A request or booking does not satisfy any work; only a verified certificate does." };
    }),

  myHandoffs: roleProcedure("trainingWallet.myHandoffs").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const rows = await db.select().from(externalTrainingHandoffs).where(eq(externalTrainingHandoffs.userId, ctx.user.id)).orderBy(desc(externalTrainingHandoffs.id)).limit(100);
    return rows.map(h => ({ handoffRef: h.handoffRef, code: h.qualificationCode, status: h.status, worker: workerFacingStatus(h.status), appointmentAt: h.appointmentAt, bookingReference: h.bookingReference, providerContact: h.providerContact, providerUrl: h.providerUrl, requestedAt: h.requestedAt, dueAt: h.dueAt }));
  }),

  /** The worker's own moves: finished training, uploaded the certificate, or cancelled. */
  handoffSelfUpdate: roleProcedure("trainingWallet.handoffSelfUpdate")
    .input(z.object({ handoffRef: z.string().min(1).max(96), to: z.enum(["TRAINING_COMPLETED", "CANCELLED"]) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const h = (await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.handoffRef, input.handoffRef), eq(externalTrainingHandoffs.userId, ctx.user.id))).limit(1))[0];
      if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "Training request not found" });
      const t = handoffTransition({ from: h.status, to: input.to, actor: "employee", qualificationCode: h.qualificationCode });
      if (!t.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t.blockers.join("; ") });
      const now = new Date();
      await db.update(externalTrainingHandoffs).set({ status: input.to, lastTransitionAt: now, closedAt: input.to === "CANCELLED" ? now : null }).where(eq(externalTrainingHandoffs.id, h.id));
      await academyAudit(db, ctx.user.id, "training_handoff", h.handoffRef, `handoff.${input.to.toLowerCase()}`, { from: h.status });
      return { handoffRef: h.handoffRef, status: input.to };
    }),

  /** Administration's actionable queue, with everything needed to act without phoning the worker. */
  handoffQueue: roleProcedure("trainingWallet.handoffQueue").input(z.object({ statuses: z.array(z.enum(HANDOFF_STATUSES as [HandoffStatus, ...HandoffStatus[]])).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const tenantId = await tenantOf(db, ctx.user.id);
    const rows = await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.tenantId, tenantId), inArray(externalTrainingHandoffs.status, input?.statuses?.length ? input.statuses : queueStatuses))).orderBy(externalTrainingHandoffs.dueAt).limit(300);
    const userIds = Array.from(new Set(rows.map(r => r.userId)));
    const people = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
    const holdingsByUser = new Map<number, ReturnType<typeof asHolding>[]>();
    for (const r of await holdingRowsFor(db, userIds)) holdingsByUser.set(r.userId, [...(holdingsByUser.get(r.userId) ?? []), asHolding(r)]);
    const sources = await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceKind, "provider_directory")).limit(100);
    const caps = await db.select({ vendorRef: vendors.vendorRef, vendorId: vendors.id, name: vendors.name, phone: vendors.phone, email: vendors.email, bookOrgRef: vendors.bookOrgRef, capabilityCode: trainingProviderCapabilities.capabilityCode, preferred: trainingProviderCapabilities.preferred, bookingUrl: trainingProviderCapabilities.bookingUrl, active: trainingProviderCapabilities.active })
      .from(trainingProviderCapabilities).innerJoin(vendors, eq(vendors.id, trainingProviderCapabilities.vendorId)).where(eq(trainingProviderCapabilities.bookOrgRef, tenantId)).limit(500);
    return rows.map(h => {
      const policy = policyFor(h.qualificationCode);
      const hs = holdingsByUser.get(h.userId) ?? [];
      const latest = hs.filter(x => x.code === h.qualificationCode && x.verificationState === "verified").sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0] ?? null;
      return {
        handoffRef: h.handoffRef, status: h.status, employee: { userId: h.userId, name: people.find(p => p.id === h.userId)?.name ?? null },
        credential: { code: h.qualificationCode, displayName: policy?.displayName ?? h.qualificationCode }, currentExpiry: h.currentExpiresAt, reason: h.reason, trigger: h.triggerKind,
        latestVerified: latest ? { holdingRef: latest.holdingRef, expiresAt: latest.expiresAt } : null,
        providerOptions: providerOptions({
          capabilities: policy?.handoffCapabilities ?? [],
          authoritativeSources: sources.map(s => ({ sourceRef: s.sourceRef, title: s.title, sourceUrl: s.sourceUrl, capabilityCodes: parseList(s.capabilityCodesJson), reviewStatus: s.reviewStatus })),
          companyProviders: caps.map(c => ({ vendorRef: c.vendorRef ?? String(c.vendorId), name: c.name, phone: c.phone, email: c.email, capabilityCode: c.capabilityCode, preferred: c.preferred, bookingUrl: c.bookingUrl, active: c.active })),
        }),
        requiredBy: h.dueAt, dispatchImpact: h.dispatchImpact, requestedAt: h.requestedAt, appointmentAt: h.appointmentAt, bookingReference: h.bookingReference, ownerUserId: h.ownerUserId,
        providerContact: h.providerContact, providerUrl: h.providerUrl,
      };
    });
  }),

  /** Contacted / booked / awaiting completion / awaiting certificate / complete — through the transition rule. */
  handoffUpdate: roleProcedure("trainingWallet.handoffUpdate")
    .input(z.object({
      handoffRef: z.string().min(1).max(96),
      mark: z.enum(["contacted", "booking", "booked", "awaiting_completion", "awaiting_certificate", "complete"]).optional(),
      to: z.enum(HANDOFF_STATUSES as [HandoffStatus, ...HandoffStatus[]]).optional(),
      providerVendorId: z.number().int().positive().nullable().optional(),
      providerContact: z.string().max(300).nullable().optional(),
      providerUrl: z.string().url().max(1024).nullable().optional(),
      bookingReference: z.string().max(120).nullable().optional(),
      appointmentAt: z.coerce.date().nullable().optional(),
      appointmentEndsAt: z.coerce.date().nullable().optional(),
      linkedHoldingRef: z.string().max(64).nullable().optional(),
      note: z.string().max(1000).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const tenantId = await tenantOf(db, ctx.user.id);
      const h = (await db.select().from(externalTrainingHandoffs).where(and(eq(externalTrainingHandoffs.handoffRef, input.handoffRef), eq(externalTrainingHandoffs.tenantId, tenantId))).limit(1))[0];
      if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "Training request not found" });
      const to: HandoffStatus | null = input.to ?? (input.mark ? ADMIN_MARKS[input.mark] : null);
      const now = new Date();
      const patch: Partial<typeof externalTrainingHandoffs.$inferInsert> = { ownerUserId: h.ownerUserId ?? ctx.user.id };
      if (input.providerVendorId !== undefined) {
        if (input.providerVendorId != null) {
          const v = (await db.select({ id: vendors.id, bookOrgRef: vendors.bookOrgRef }).from(vendors).where(eq(vendors.id, input.providerVendorId)).limit(1))[0];
          if (!v || (v.bookOrgRef ?? SINGLE_TENANT_ID) !== tenantId) throw new TRPCError({ code: "NOT_FOUND", message: `Provider ${input.providerVendorId} not found` });
        }
        patch.providerVendorId = input.providerVendorId;
      }
      for (const k of ["providerContact", "providerUrl", "bookingReference", "appointmentAt", "appointmentEndsAt"] as const) if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
      if (to && to !== h.status) {
        const linkedRef = input.linkedHoldingRef ?? h.linkedHoldingRef;
        const linked = linkedRef ? (await db.select().from(workerQualifications).where(and(eq(workerQualifications.holdingRef, linkedRef), eq(workerQualifications.userId, h.userId))).limit(1))[0] : null;
        const heldNow = heldForWork((await holdingRowsFor(db, [h.userId])).map(asHolding), h.qualificationCode, now).held;
        const t = handoffTransition({ from: h.status, to, actor: "admin", linkedHolding: linked ? { verificationState: linked.verificationState, code: linked.code } : null, qualificationCode: h.qualificationCode, heldNow });
        if (!t.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t.blockers.join("; ") });
        patch.status = to; patch.lastTransitionAt = now;
        if (linked) patch.linkedHoldingRef = linked.holdingRef;
        if (TERMINAL.has(to)) patch.closedAt = now;
      }
      await db.update(externalTrainingHandoffs).set(patch).where(eq(externalTrainingHandoffs.id, h.id));
      await academyAudit(db, ctx.user.id, "training_handoff", h.handoffRef, to && to !== h.status ? `handoff.${to.toLowerCase()}` : "handoff.updated", { from: h.status, to: to ?? h.status, note: input.note ?? null, booking: input.bookingReference ?? null, appointmentAt: input.appointmentAt ?? null });
      return { handoffRef: h.handoffRef, status: (patch.status ?? h.status) as HandoffStatus, readinessNotice: "Handoff status never changes dispatch readiness." };
    }),

  /** Authoritative directories and company providers, kept apart. */
  providerOptions: roleProcedure("trainingWallet.providerOptions").input(z.object({ qualificationCode: z.string().min(2).max(100) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const tenantId = await tenantOf(db, ctx.user.id);
    const policy = policyFor(input.qualificationCode);
    const sources = await db.select().from(academySourceRecords).where(eq(academySourceRecords.sourceKind, "provider_directory")).limit(100);
    const caps = await db.select({ vendorRef: vendors.vendorRef, vendorId: vendors.id, name: vendors.name, phone: vendors.phone, email: vendors.email, capabilityCode: trainingProviderCapabilities.capabilityCode, preferred: trainingProviderCapabilities.preferred, bookingUrl: trainingProviderCapabilities.bookingUrl, active: trainingProviderCapabilities.active })
      .from(trainingProviderCapabilities).innerJoin(vendors, eq(vendors.id, trainingProviderCapabilities.vendorId)).where(eq(trainingProviderCapabilities.bookOrgRef, tenantId)).limit(500);
    return providerOptions({
      capabilities: policy?.handoffCapabilities ?? [],
      authoritativeSources: sources.map(s => ({ sourceRef: s.sourceRef, title: s.title, sourceUrl: s.sourceUrl, capabilityCodes: parseList(s.capabilityCodesJson), reviewStatus: s.reviewStatus })),
      companyProviders: caps.map(c => ({ vendorRef: c.vendorRef ?? String(c.vendorId), name: c.name, phone: c.phone, email: c.email, capabilityCode: c.capabilityCode, preferred: c.preferred, bookingUrl: c.bookingUrl, active: c.active })),
    });
  }),

  /** Tag a company vendor with what it teaches. The vendor must belong to the caller's organization. */
  providerCapabilitySet: roleProcedure("trainingWallet.providerCapabilitySet")
    .input(z.object({ vendorId: z.number().int().positive(), capabilityCode: z.enum(HANDOFF_CAPABILITIES as [string, ...string[]]), preferred: z.boolean().default(false), bookingUrl: z.string().url().max(1024).nullable().optional(), serviceArea: z.string().max(220).nullable().optional(), notes: z.string().max(1000).nullable().optional(), active: z.boolean().default(true) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const tenantId = await tenantOf(db, ctx.user.id);
      const v = (await db.select().from(vendors).where(eq(vendors.id, input.vendorId)).limit(1))[0];
      if (!v || (v.bookOrgRef ?? SINGLE_TENANT_ID) !== tenantId) throw new TRPCError({ code: "NOT_FOUND", message: `Provider ${input.vendorId} not found` });
      const existing = (await db.select().from(trainingProviderCapabilities).where(and(eq(trainingProviderCapabilities.vendorId, v.id), eq(trainingProviderCapabilities.capabilityCode, input.capabilityCode))).limit(1))[0];
      const values = { preferred: input.preferred, bookingUrl: input.bookingUrl ?? null, serviceArea: input.serviceArea ?? null, notes: input.notes ?? null, active: input.active };
      let capabilityRef = existing?.capabilityRef;
      if (existing) await db.update(trainingProviderCapabilities).set(values).where(eq(trainingProviderCapabilities.id, existing.id));
      else { capabilityRef = ref("TPC"); await db.insert(trainingProviderCapabilities).values({ capabilityRef, bookOrgRef: tenantId, vendorId: v.id, capabilityCode: input.capabilityCode, createdByUserId: ctx.user.id, ...values }); }
      await academyAudit(db, ctx.user.id, "training_provider", capabilityRef!, "provider.capability_set", { ...input, vendorId: v.id });
      return { capabilityRef: capabilityRef!, vendorId: v.id, capabilityCode: input.capabilityCode, preferred: input.preferred };
    }),

  /** The Training Compliance dashboard. Every number is computed from records, not stored. */
  complianceDashboard: roleProcedure("trainingWallet.complianceDashboard")
    .input(z.object({
      userId: z.number().int().positive().optional(), crewRef: z.string().max(64).optional(), role: z.string().max(40).optional(),
      qualificationCode: z.string().max(100).optional(), expiryWindowDays: z.number().int().min(1).max(730).default(90),
      jobRequirementCodes: z.array(z.string().max(100)).max(20).optional(), interprovincial: z.boolean().optional(),
      handoffStatus: z.enum(HANDOFF_STATUSES as [HandoffStatus, ...HandoffStatus[]]).optional(), providerVendorId: z.number().int().positive().optional(),
      at: z.coerce.date().optional(),
    }).strict().optional())
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const now = input?.at ?? new Date();
      const tenantId = await tenantOf(db, ctx.user.id);
      const window = input?.expiryWindowDays ?? 90;
      // People in this organization: holders, learners and requesters here. Crew/role narrow it.
      let people = Array.from(new Set([
        ...(await db.select({ u: workerQualifications.userId }).from(workerQualifications).where(eq(workerQualifications.tenantId, tenantId)).limit(5000)).map(r => r.u),
        ...(await db.select({ u: externalTrainingHandoffs.userId }).from(externalTrainingHandoffs).where(eq(externalTrainingHandoffs.tenantId, tenantId)).limit(5000)).map(r => r.u),
      ]));
      const inScope: number[] = [];
      for (const u of people) if (await userInScope(u, { tenantId })) inScope.push(u);
      people = inScope;
      if (input?.userId) people = people.filter(p => p === input.userId);
      if (input?.crewRef) { const m = await db.select({ u: crewMembers.userId }).from(crewMembers).where(eq(crewMembers.crewRef, input.crewRef)).limit(500); const set = new Set(m.map(x => x.u)); people = people.filter(p => set.has(p)); }
      if (input?.role) { const keep: number[] = []; for (const p of people) if ((await listRoleNamesAnyScope(p)).includes(input.role)) keep.push(p); people = keep; }
      const rows = (await holdingRowsFor(db, people)).filter(r => r.tenantId === tenantId || r.tenantId == null);
      const byUser = new Map<number, WalletHolding[]>();
      for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), asHolding(r)]);
      const matchesCode = (c: string) => !input?.qualificationCode || c === input.qualificationCode;
      const expiringSoon: { userId: number; code: string; expiresAt: Date; days: number }[] = [], expired: typeof expiringSoon = [];
      for (const r of rows.filter(r => isCurrentVerified(r) && matchesCode(r.code))) {
        if (policyFor(r.code)?.lifecycle === "no_expiry_endorsement" || !r.expiresAt) continue;
        const days = Math.ceil((r.expiresAt.getTime() - now.getTime()) / 86_400_000);
        if (days < 0) expired.push({ userId: r.userId, code: r.code, expiresAt: r.expiresAt, days });
        else if (days <= window) expiringSoon.push({ userId: r.userId, code: r.code, expiresAt: r.expiresAt, days });
      }
      const uploadedVerificationRequired = rows.filter(r => (r.verificationState === "unverified" || r.verificationState === "extracted") && matchesCode(r.code)).map(r => ({ userId: r.userId, code: r.code, holdingRef: r.holdingRef, recordedAt: r.recordedAt }));
      const qualificationUnknown = rows.filter(r => isCurrentVerified(r) && !r.expiresAt && matchesCode(r.code) && ["actual_expiry", "server_profile_expiry", "unknown"].includes(policyFor(r.code)?.lifecycle ?? "unknown")).map(r => ({ userId: r.userId, code: r.code, reason: "Verified, but no expiry recorded — currency unknown" }));
      let handoffs = await db.select().from(externalTrainingHandoffs).where(eq(externalTrainingHandoffs.tenantId, tenantId)).limit(2000);
      handoffs = handoffs.filter(h => people.includes(h.userId) && matchesCode(h.qualificationCode) && (!input?.handoffStatus || h.status === input.handoffStatus) && (!input?.providerVendorId || h.providerVendorId === input.providerVendorId));
      const hmap = (ss: HandoffStatus[]) => handoffs.filter(h => ss.includes(h.status)).map(h => ({ handoffRef: h.handoffRef, userId: h.userId, code: h.qualificationCode, status: h.status, dueAt: h.dueAt, appointmentAt: h.appointmentAt }));
      const assignments = people.length ? await db.select({ userId: academyAssignments.userId, status: academyAssignments.status, dueAt: academyAssignments.dueAt, completedAt: academyAssignments.completedAt, courseCode: academyCourses.courseCode, boundary: academyCourses.credentialBoundary, qualificationCode: academyCourses.externalCredentialCode, assignedAt: academyAssignments.assignedAt })
        .from(academyAssignments).innerJoin(academyCourseVersions, eq(academyCourseVersions.id, academyAssignments.courseVersionId)).innerJoin(academyCourses, eq(academyCourses.id, academyCourseVersions.courseId)).where(inArray(academyAssignments.userId, people)).limit(5000) : [];
      const open = ["assigned", "in_progress", "assessment_ready", "practical_pending", "overdue"];
      const companyTrainingOverdue = assignments.filter(a => a.dueAt && a.dueAt < now && open.includes(a.status) && a.boundary !== "external_track_only").map(a => ({ userId: a.userId, courseCode: a.courseCode, dueAt: a.dueAt }));
      const practicalPending = assignments.filter(a => a.status === "practical_pending").map(a => ({ userId: a.userId, courseCode: a.courseCode }));
      const onboarding = assignments.filter(a => a.courseCode.startsWith("COMPANY") && open.includes(a.status) && a.assignedAt.getTime() > now.getTime() - 90 * 86_400_000).map(a => ({ userId: a.userId, courseCode: a.courseCode, status: a.status }));
      const studiedNotHeld = studiedButNotHeld({
        studied: assignments.filter(a => a.boundary === "external_track_only" && a.qualificationCode && matchesCode(a.qualificationCode)).map(a => ({ userId: a.userId, qualificationCode: a.qualificationCode!, courseCode: a.courseCode, completedAt: a.completedAt ?? (a.status === "practical_pending" ? now : null) })),
        holdingsByUser: byUser, at: now,
      });
      const required = await db.select().from(academyRequirements).where(eq(academyRequirements.active, true)).limit(200);
      const missingRequired: { userId: number; code: string; reason: string }[] = [];
      for (const r of required.filter(r => r.enforcement === "block" && matchesCode(r.qualificationCode))) {
        for (const u of people) {
          const v = heldForWork(byUser.get(u) ?? [], r.qualificationCode, now);
          if (!v.held && v.code === "unknown" && !(byUser.get(u) ?? []).some(h => h.code === r.qualificationCode)) missingRequired.push({ userId: u, code: r.qualificationCode, reason: `${r.title}: ${v.reason}` });
        }
      }
      const gapCodes = input?.jobRequirementCodes ?? [];
      const crewGap = gapCodes.length ? crewCoverage({ people: people.map(u => ({ userId: u, holdings: byUser.get(u) ?? [] })), requiredCodes: gapCodes, at: now, scope: { interprovincial: !!input?.interprovincial } }) : null;
      const codes = Array.from(new Set(rows.map(r => r.code).filter(matchesCode)));
      const forecast = shortageForecast({ holdingsByUser: byUser, codes, now, windowDays: [30, 60, 90] });
      const headlines = [
        ...forecast.flatMap(f => f.expiring.filter(e => e.days === 30 && e.count > 0).map(e => `${e.count} ${e.count === 1 ? "person's" : "people's"} ${f.code} expire${e.count === 1 ? "s" : ""} within 30 days.`)),
        ...(crewGap ? [`${crewGap.headline}.`] : []),
        ...studiedNotHeld.slice(0, 5).map(s => `Employee ${s.userId} completed ${s.courseCode} study material but has no verified ${s.qualificationCode}.`),
      ];
      return {
        at: now, people: people.length, headlines,
        views: {
          expiringSoon, expired, missingRequired, uploadedVerificationRequired,
          renewalRequested: hmap(["REQUESTED", "ADMIN_REVIEW"]), bookingRequired: hmap(["PROVIDER_SELECTED", "BOOKING_IN_PROGRESS"]), booked: hmap(["BOOKED"]),
          awaitingCertificate: hmap(["TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED"]),
          qualificationUnknown, companyTrainingOverdue, practicalPending, onboarding, studiedNotHeld, crewGap, forecast,
        },
      };
    }),

  /** Optional development path — a visualization, never an eligibility decision. */
  pathway: roleProcedure("trainingWallet.pathway").input(z.object({ pathwayCode: z.string().max(60).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const now = new Date();
    const holdings = (await holdingRowsFor(db, [ctx.user.id])).map(asHolding);
    const studied = await db.select({ courseCode: academyCourses.courseCode, status: academyAssignments.status }).from(academyAssignments).innerJoin(academyCourseVersions, eq(academyCourseVersions.id, academyAssignments.courseVersionId)).innerJoin(academyCourses, eq(academyCourses.id, academyCourseVersions.courseId)).where(eq(academyAssignments.userId, ctx.user.id)).limit(200);
    const competent = (await db.select().from(academyPracticalEvaluations).where(and(eq(academyPracticalEvaluations.userId, ctx.user.id), eq(academyPracticalEvaluations.status, "competent"))).limit(200)).map(p => p.competencyCode);
    const roles = await listRoleNamesAnyScope(ctx.user.id);
    const pathways = CAREER_PATHWAYS.filter(p => !input?.pathwayCode || p.code === input.pathwayCode);
    return pathways.map(p => evaluatePathway({ pathway: p, roles, studied, holdings, competentCodes: competent, at: now }));
  }),
});
