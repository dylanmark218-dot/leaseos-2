/**
 * 0177 — Driver Portfolio API.
 *
 * Several deliberately different views, never one employee object everywhere:
 *
 *   myWallet, myCredentialHistory, myShares   the driver, self-scoped: the operator linked to
 *     submitCredential, shareIssue/Revoke     ctx.user.id. No procedure here takes an operator id
 *                                             from the driver.
 *   operatorReadiness                         dispatch: ticks and crosses, derived from
 *                                             `composeReadiness()` — the award's own pipeline.
 *   portfolio, auditHistory, expiryDashboard, Safety/HR/management: the fuller record, tenant-scoped.
 *     verificationQueue, credentialVerify
 *   requirement{List,Get,Create,Update,Retire} Safety/management. Nothing is deleted; an update
 *                                             retires the old binding and creates its successor.
 *   shareRedeem                               public: one credential, minimum detail, re-read now.
 *
 * The organization is always the caller's acting scope. A record another organization owns is
 * "not found", never "forbidden". There is no second readiness decision here: the wallet and the
 * Safety view are projections of the source records; only `operatorReadiness` speaks for dispatch,
 * and it speaks with `composeReadiness()`'s verdict, unchanged.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { publicProcedure, roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, evidenceInScope } from "./db";
import { complianceDocuments, driverCredentialShares, driverRequirementBindings, operators } from "../drizzle/schema";
import {
  bindingProblem, credentialHistory, credentialType, dispatchView, evaluateDriverReadiness, expiryAlerts, normalizeCode,
  requirementFromBinding, shareLifetimeHours, sharedCredentialView, walletView, SHARE_MAX_HOURS,
} from "./_core/driverPortfolio";
import { walletStatusAt } from "../shared/driverWallet";
import { newToken, sha256 } from "./_core/externalIdentityPolicy";
import { assertReadinessSubjectInScope } from "./dispatchEnforcementService";
import { composeReadiness } from "./readinessComposer";
import {
  asBinding, bindingInScopeOrThrow, bindingsInScope, companyBaseline, credentialSummary, dbOrThrow, loadPortfolios, myOperator, newRef,
  notFound, operatorInScopeOrThrow, operatorsInScope, orgRefFor, portfolioEventsPage, readinessImpact, recordPortfolioEvent,
  recordPortfolioView, scopedRequirements, submitterOf, type BindingRow,
} from "./driverPortfolioService";

const LIMIT = z.number().int().min(1).max(200).default(50);
const SUBJECT_TYPE = z.enum(["company", "customer", "site", "job_type", "equipment", "job"]);
const KIND = z.enum(["credential", "licence_class", "equipment"]);
const ENFORCEMENT = z.enum(["mandatory", "informational"]);
const WINDOW = z.union([z.literal("expired"), z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)]);

const bindingOut = (b: BindingRow) => ({
  bindingRef: b.bindingRef, supersedesBindingRef: b.supersedesBindingRef, subjectType: b.subjectType, subjectCode: b.subjectCode,
  requirementKind: b.requirementKind, requirementCode: b.requirementCode, label: b.label, enforcement: b.enforcement,
  effectiveAt: b.effectiveAt, expiresAt: b.expiresAt, active: b.active, createdByUserId: b.createdByUserId, createdAt: b.createdAt,
  retiredByUserId: b.retiredByUserId, retiredAt: b.retiredAt,
});

/** A certificate number reduced to what a gate needs to match it: the last four characters. */
const maskIdentifier = (id: string | null) => (id == null ? null : id.length <= 4 ? "••••" : `••••${id.slice(-4)}`);

/** The dashboard's keyset cursor: the sort key of the last row returned, opaque to the client. */
const encodeCursor = (k: [number, number, string]) => Buffer.from(JSON.stringify(k)).toString("base64url");
function decodeCursor(c: string | null | undefined): [number, number, string] | null {
  if (!c) return null;
  try {
    const k = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(k) && k.length === 3 && typeof k[0] === "number" && typeof k[1] === "number" && typeof k[2] === "string") return k as [number, number, string];
  } catch { /* fall through */ }
  throw new TRPCError({ code: "BAD_REQUEST", message: "Unreadable cursor" });
}

async function scoped(userId: number) {
  const db = await dbOrThrow();
  return { db, scope: await actingScopeFor(userId) };
}

const bindingInput = z.object({
  subjectType: SUBJECT_TYPE,
  subjectCode: z.string().trim().min(1).max(160),
  requirementKind: KIND,
  requirementCode: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(220).nullable().optional(),
  enforcement: ENFORCEMENT.default("mandatory"),
  effectiveAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

function checkBinding(b: z.infer<typeof bindingInput>) {
  const problem = bindingProblem(b);
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
  if (b.effectiveAt && b.expiresAt && b.expiresAt.getTime() <= b.effectiveAt.getTime()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A requirement must end after it starts" });
  }
}

/** Stored the way it is compared: catalogue codes normalized, orientation codes kept whole. */
const storedCode = (kind: z.infer<typeof KIND>, code: string) =>
  kind === "credential" ? (credentialType(code)?.code ?? code) : kind === "licence_class" ? code.trim().replace(/^class\s*/i, "") : normalizeCode(code);

const describeBinding = (b: { subjectType: string; subjectCode: string; requirementKind: string; requirementCode: string; enforcement: string }) =>
  `${b.enforcement} ${b.requirementKind} ${b.requirementCode} for ${b.subjectType === "company" ? "the company" : `${b.subjectType.replace(/_/g, " ")} ${b.subjectCode}`}`;

export const driverPortfolioRouter = router({
  /* ================================================================ */
  /* The driver: self-scoped                                            */
  /* ================================================================ */

  /**
   * GET /driver-portfolio/me/wallet. Built to be cached on the phone: `cache` says when it was
   * made, until when it holds, and what shortened that. `status` is computed at generation; the
   * phone recomputes it with the same shared `walletStatusAt`, so a cached READY past `validUntil`
   * reads STALE rather than READY.
   */
  myWallet: roleProcedure("driverPortfolio.myWallet")
    .query(async ({ ctx }) => {
      const now = new Date();
      const { db, scope } = await scoped(ctx.user.id);
      const op = await myOperator(db, ctx.user.id, scope);
      const [{ portfolio, rows }] = await loadPortfolios(db, [op]);
      const bindings = await bindingsInScope(db, scope);
      const wallet = walletView({ portfolio, baseline: companyBaseline(bindings, now), at: now });
      const others = scopedRequirements(bindings, now).map(b => {
        const item = evaluateDriverReadiness({ portfolio, requirements: [requirementFromBinding(asBinding(b))], at: now }).items[0]!;
        return {
          bindingRef: b.bindingRef, appliesTo: { subjectType: b.subjectType, subjectCode: b.subjectCode },
          kind: item.kind, code: item.code, label: item.label, enforcement: item.enforcement,
          state: item.state, satisfied: item.satisfied, expiresAt: item.expiresAt, warningTier: item.warningTier,
          reason: item.satisfied ? null : item.detail, action: item.action,
        };
      });
      return {
        operator: { operatorId: op.id, name: op.name },
        status: walletStatusAt(wallet, now),
        headline: wallet.headline,
        verdict: wallet.verdict,
        /** Against the company baseline; the dispatch gate decides any particular job. */
        scope: wallet.scope,
        cards: wallet.cards,
        requirementsForSomeWork: others,
        upcomingExpirations: expiryAlerts([portfolio], now),
        equipment: portfolio.equipment,
        credentials: rows.map(credentialSummary),
        cache: {
          generatedAt: wallet.generatedAt,
          validUntil: wallet.validUntil,
          offlineAllowanceHours: wallet.freshness.offlineAllowanceHours,
          limitedBy: wallet.freshness.limitedBy,
          limitingCredential: wallet.freshness.limitingCredential,
          staleRule: "shared/driverWallet.walletStatusAt: READY FOR WORK and ACTION REQUIRED read STALE from validUntil; NOT READY stays NOT READY",
        },
      };
    }),

  myCredentialHistory: roleProcedure("driverPortfolio.myCredentialHistory")
    .input(z.object({ code: z.string().trim().min(1).max(160) }))
    .query(async ({ ctx, input }) => {
      const type = credentialType(input.code);
      if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: `${input.code} is not a known credential` });
      const { db, scope } = await scoped(ctx.user.id);
      const op = await myOperator(db, ctx.user.id, scope);
      const [{ portfolio, rows }] = await loadPortfolios(db, [op]);
      const h = credentialHistory(portfolio.credentials, type.code, new Date());
      const row = (id: number) => credentialSummary(rows.find(r => r.id === id)!);
      return { code: type.code, label: type.label, current: h.current ? row(h.current.id) : null, history: h.history.map(x => ({ ...row(x.credential.id), reason: x.reason })) };
    }),

  /** Operator uploads a credential. It enters as needs_review; a second person verifies it. */
  submitCredential: roleProcedure("driverPortfolio.submitCredential")
    .input(z.object({
      code: z.string().trim().min(1).max(160),
      title: z.string().trim().min(1).max(220).optional(),
      identifier: z.string().trim().max(120).nullable().optional(),
      issuedAt: z.coerce.date().nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      source: z.string().trim().max(220).nullable().optional(),
      evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const type = credentialType(input.code);
      // Medical fitness and other private documents are not portfolio credentials: they go through HR.
      if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: `${input.code} is not a credential the portfolio accepts` });
      const { db, scope } = await scoped(ctx.user.id);
      const op = await myOperator(db, ctx.user.id, scope);
      if (input.evidenceRecordId != null && !(await evidenceInScope(input.evidenceRecordId, scope))) throw notFound("Evidence record");
      const now = new Date();
      return db.transaction(async tx => {
        const ins = await tx.insert(complianceDocuments).values({
          ownerType: "operator", ownerId: op.id, docType: type.docTypes[0]!, title: input.title ?? type.label,
          identifier: input.identifier ?? null, capturedAt: now, issuedAt: input.issuedAt ?? null, expiresAt: input.expiresAt ?? null,
          verificationStatus: "needs_review", source: input.source ?? "driver portfolio", confidence: "medium", privateDetail: false,
          evidenceRecordId: input.evidenceRecordId ?? null,
        });
        const credentialId = Number(ins[0]?.insertId ?? 0);
        await recordPortfolioEvent(tx, { orgRef: orgRefFor(scope), operatorId: op.id, credentialId, actorUserId: ctx.user.id, eventType: "credential_uploaded", detail: `${type.label} submitted by the operator for verification`, at: now });
        return { credentialId, code: type.code, verificationStatus: "needs_review" as const };
      });
    }),

  myShares: roleProcedure("driverPortfolio.myShares")
    .query(async ({ ctx }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const op = await myOperator(db, ctx.user.id, scope);
      const rows = await db.select().from(driverCredentialShares).where(eq(driverCredentialShares.operatorId, op.id)).orderBy(desc(driverCredentialShares.id)).limit(50);
      const now = Date.now();
      return rows.map(s => ({
        shareRef: s.shareRef, credentialId: s.credentialId, code: s.credentialCode, audience: s.audience, issuedAt: s.issuedAt, expiresAt: s.expiresAt,
        revokedAt: s.revokedAt, live: !s.revokedAt && s.expiresAt.getTime() > now,
      }));
    }),

  /**
   * One credential, for one audience, for at most seven days. The token is returned once and only
   * its hash is kept; losing it means issuing another.
   */
  shareIssue: roleProcedure("driverPortfolio.shareIssue")
    .input(z.object({ credentialId: z.number().int().positive(), audience: z.string().trim().min(2).max(160), hours: z.number().positive().max(SHARE_MAX_HOURS).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const op = await myOperator(db, ctx.user.id, scope);
      const [{ portfolio }] = await loadPortfolios(db, [op]);
      const row = portfolio.credentials.find(c => c.id === input.credentialId);
      // Another driver's credential, a private one, or none: all the same answer.
      if (!row) throw notFound("Credential");
      const type = credentialType(row.docType);
      if (!type) throw notFound("Credential");
      const now = new Date();
      const view = sharedCredentialView({ credentialId: row.id, code: type.code, holderName: op.name, credentials: portfolio.credentials, at: now });
      if (!view?.valid) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Only a verified, current credential can be shared (${type.label} is ${view?.state ?? "unavailable"})` });
      let hours: number;
      try { hours = shareLifetimeHours(input.hours); } catch (e) { throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message }); }
      const token = newToken();
      const shareRef = newRef("DCS");
      const expiresAt = new Date(now.getTime() + hours * 3_600_000);
      await db.transaction(async tx => {
        await tx.insert(driverCredentialShares).values({
          shareRef, orgRef: orgRefFor(scope), operatorId: op.id, credentialId: row.id, credentialCode: type.code, tokenHash: sha256(token),
          audience: input.audience, issuedByUserId: ctx.user.id, issuedAt: now, expiresAt,
        });
        await recordPortfolioEvent(tx, { orgRef: orgRefFor(scope), operatorId: op.id, credentialId: row.id, actorUserId: ctx.user.id, eventType: "credential_shared", detail: `${type.label} shared as ${shareRef} with "${input.audience}" until ${expiresAt.toISOString()}`, at: now });
      });
      return { shareRef, token, expiresAt };
    }),

  shareRevoke: roleProcedure("driverPortfolio.shareRevoke")
    .input(z.object({ shareRef: z.string().min(1).max(96) }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const op = await myOperator(db, ctx.user.id, scope);
      const s = (await db.select().from(driverCredentialShares).where(and(eq(driverCredentialShares.shareRef, input.shareRef), eq(driverCredentialShares.operatorId, op.id))).limit(1))[0];
      if (!s) throw notFound("Share");
      if (s.revokedAt) return { shareRef: s.shareRef, revokedAt: s.revokedAt };
      const now = new Date();
      await db.transaction(async tx => {
        await tx.update(driverCredentialShares).set({ revokedAt: now, revokedByUserId: ctx.user.id }).where(and(eq(driverCredentialShares.id, s.id), isNull(driverCredentialShares.revokedAt)));
        await recordPortfolioEvent(tx, { orgRef: orgRefFor(scope), operatorId: op.id, credentialId: s.credentialId, actorUserId: ctx.user.id, eventType: "share_revoked", detail: `Share ${s.shareRef} revoked`, at: now });
      });
      return { shareRef: s.shareRef, revokedAt: now };
    }),

  /* ================================================================ */
  /* Dispatch: the canonical verdict, summarized                       */
  /* ================================================================ */

  /**
   * GET /dispatch/operators/:operatorId/readiness. The verdict and every finding come from
   * `composeReadiness()`, the pipeline evaluate and award use; this procedure decides nothing. What
   * it removes is detail dispatch does not need: no certificate numbers, documents, providers,
   * private detail or HR file.
   */
  operatorReadiness: roleProcedure("driverPortfolio.operatorReadiness")
    .input(z.object({
      operatorId: z.number().int().positive(),
      unitId: z.number().int().positive().nullable().optional(),
      trailerId: z.number().int().positive().nullable().optional(),
      jobId: z.number().int().positive().nullable().optional(),
      workEndsAt: z.coerce.date().nullable().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const subject = { operatorId: input.operatorId, unitId: input.unitId ?? null, trailerId: input.trailerId ?? null, jobId: input.jobId ?? null };
      await assertReadinessSubjectInScope(db, scope, subject);
      const r = await composeReadiness({ ...subject, workEndsAt: input.workEndsAt ?? null });
      const operatorFindings = r.eligibility.blockers.filter(b => b.subject === "operator");
      const licence = operatorFindings.find(b => b.code.startsWith("operator_licence_"));
      return {
        operatorId: input.operatorId,
        verdict: r.eligibility.verdict,
        explanation: r.eligibility.explanation,
        evaluatedAt: r.eligibility.evaluatedAt,
        licence: { ok: !licence, reason: licence?.label ?? null },
        requirements: dispatchView(r.driverReadiness).lines,
        operatorFindings: operatorFindings.map(b => ({ code: b.code, label: b.label, severity: b.severity, overridable: b.overridable })),
      };
    }),

  /* ================================================================ */
  /* Safety / HR / management                                          */
  /* ================================================================ */

  portfolio: roleProcedure("driverPortfolio.portfolio")
    .input(z.object({ operatorId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const { db, scope } = await scoped(ctx.user.id);
      const op = await operatorInScopeOrThrow(db, input.operatorId, scope);
      const [{ portfolio, rows }] = await loadPortfolios(db, [op]);
      const privateWithheld = (await db.select({ id: complianceDocuments.id }).from(complianceDocuments)
        .where(and(eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, op.id), eq(complianceDocuments.privateDetail, true)))).length;
      const bindings = await bindingsInScope(db, scope);
      const codes = Array.from(new Set(rows.map(r => credentialType(r.docType)?.code).filter((c): c is string => !!c)));
      const byCode = codes.map(code => {
        const h = credentialHistory(portfolio.credentials, code, now);
        const row = (id: number) => credentialSummary(rows.find(r => r.id === id)!);
        return { code, label: credentialType(code)!.label, current: h.current ? row(h.current.id) : null, history: h.history.map(x => ({ ...row(x.credential.id), reason: x.reason })) };
      });
      const events = await portfolioEventsPage(db, scope, op.id, 25, null);
      await recordPortfolioView(db, { orgRef: orgRefFor(scope), operatorId: op.id, actorUserId: ctx.user.id, eventType: "portfolio_viewed", detail: "Portfolio opened by Safety/Admin", at: now });
      return {
        operator: { operatorId: op.id, name: op.name, licenceClass: op.licenseClass },
        credentials: byCode,
        unrecognisedCredentials: rows.filter(r => !credentialType(r.docType)).map(credentialSummary),
        privateCredentialsWithheld: privateWithheld,
        equipment: portfolio.equipment,
        companyBaseline: evaluateDriverReadiness({ portfolio, requirements: companyBaseline(bindings, now), at: now }).items,
        expiryWarnings: expiryAlerts([portfolio], now),
        recentEvents: events.events,
      };
    }),

  auditHistory: roleProcedure("driverPortfolio.auditHistory")
    .input(z.object({ operatorId: z.number().int().positive(), limit: LIMIT, beforeId: z.number().int().positive().nullable().optional() }))
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      await operatorInScopeOrThrow(db, input.operatorId, scope);
      return portfolioEventsPage(db, scope, input.operatorId, input.limit, input.beforeId ?? null);
    }),

  /**
   * Every operator in the caller's organization whose current credential has lapsed or falls in
   * the window. A lapsed ticket already replaced by a verified renewal is history, not an alert.
   */
  expiryDashboard: roleProcedure("driverPortfolio.expiryDashboard")
    .input(z.object({
      within: WINDOW.default(90),
      operatorId: z.number().int().positive().nullable().optional(),
      code: z.string().trim().min(1).max(160).nullable().optional(),
      verification: z.enum(["verified", "unverified"]).nullable().optional(),
      readinessImpact: z.enum(["mandatory", "informational", "none"]).nullable().optional(),
      limit: LIMIT,
      cursor: z.string().max(400).nullable().optional(),
    }).prefault({}))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const { db, scope } = await scoped(ctx.user.id);
      let ops = await operatorsInScope(db, scope);
      if (input.operatorId != null) {
        ops = ops.filter(o => o.id === input.operatorId);
        if (!ops.length) throw notFound("Operator");
      }
      const portfolios = (await loadPortfolios(db, ops)).map(p => p.portfolio);
      const impactOf = readinessImpact(await bindingsInScope(db, scope), now);
      const equipmentCodes = new Set(portfolios.flatMap(p => p.equipment.map(e => normalizeCode(e.equipmentType))));
      const code = input.code ? (credentialType(input.code)?.code ?? normalizeCode(input.code)) : null;
      const rows = expiryAlerts(portfolios, now)
        .map(a => ({ ...a, readinessImpact: impactOf(credentialType(a.code) ? "credential" : equipmentCodes.has(a.code) ? "equipment" : "credential", a.code) }))
        .filter(a => (code == null || a.code === code)
          && (input.verification == null || a.verification === input.verification)
          && (input.readinessImpact == null || a.readinessImpact === input.readinessImpact));
      const summary = { expired: 0, within7: 0, within14: 0, within30: 0, within60: 0, within90: 0 };
      for (const a of rows) {
        if (a.daysRemaining < 0) { summary.expired++; continue; }
        if (a.daysRemaining <= 7) summary.within7++;
        if (a.daysRemaining <= 14) summary.within14++;
        if (a.daysRemaining <= 30) summary.within30++;
        if (a.daysRemaining <= 60) summary.within60++;
        summary.within90++;
      }
      const windowed = rows.filter(a => (input.within === "expired" ? a.daysRemaining < 0 : a.daysRemaining >= 0 && a.daysRemaining <= input.within));
      const after = decodeCursor(input.cursor);
      const key = (a: (typeof windowed)[number]): [number, number, string] => [a.expiresAt.getTime(), a.operatorId, a.code];
      const cmp = (x: [number, number, string], y: [number, number, string]) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
      const ordered = windowed.slice().sort((a, b) => cmp(key(a), key(b)));
      const remaining = after ? ordered.filter(a => cmp(key(a), after) > 0) : ordered;
      const page = remaining.slice(0, input.limit);
      return {
        summary,
        alerts: page,
        nextCursor: remaining.length > input.limit ? encodeCursor(key(page[page.length - 1]!)) : null,
      };
    }),

  verificationQueue: roleProcedure("driverPortfolio.verificationQueue")
    .input(z.object({ limit: LIMIT }).prefault({}))
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const ops = await operatorsInScope(db, scope);
      const loaded = await loadPortfolios(db, ops);
      return loaded.flatMap(({ portfolio, rows }) => rows
        .filter(r => r.verificationStatus === "needs_review" && credentialType(r.docType))
        .map(r => ({ operatorId: portfolio.operatorId, operatorName: portfolio.name, ...credentialSummary(r) })))
        .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
        .slice(0, input.limit);
    }),

  /**
   * The second person's check. Refused for the operator's own credential and for the person who
   * submitted it, as workforce verification is. Verifying a renewal records that it superseded the
   * credential that was in force.
   */
  credentialVerify: roleProcedure("driverPortfolio.credentialVerify")
    .input(z.object({
      credentialId: z.number().int().positive(),
      outcome: z.enum(["verified", "rejected"]),
      note: z.string().trim().max(300).optional(),
      /** The expiry and issue dates as read from the certificate, when the upload's differ or are missing. */
      expiresAt: z.coerce.date().nullable().optional(),
      issuedAt: z.coerce.date().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const doc = (await db.select().from(complianceDocuments).where(eq(complianceDocuments.id, input.credentialId)).limit(1))[0];
      if (!doc || doc.ownerType !== "operator" || doc.privateDetail || !credentialType(doc.docType)) throw notFound("Credential");
      const op = await operatorInScopeOrThrow(db, doc.ownerId, scope).catch(() => { throw notFound("Credential"); });
      if (op.userId != null && op.userId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "You may not verify your own credential" });
      if ((await submitterOf(db, doc.id)) === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who submitted the credential may not verify it" });
      if (doc.verificationStatus !== "needs_review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Credential is already ${doc.verificationStatus}` });
      const type = credentialType(doc.docType)!;
      const now = new Date();
      const orgRef = orgRefFor(scope);
      await db.transaction(async tx => {
        // What was in force before this decision, so a renewal can say what it replaced.
        const [{ portfolio: before }] = await loadPortfolios(tx, [op]);
        const previous = credentialHistory(before.credentials, type.code, now).current
          ?? before.credentials.filter(c => c.id !== doc.id && c.verificationStatus === "verified" && credentialType(c.docType)?.code === type.code)
            .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0] ?? null;
        await tx.update(complianceDocuments).set({
          verificationStatus: input.outcome, verifiedByUserId: ctx.user.id, verifiedAt: now,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
        }).where(and(eq(complianceDocuments.id, doc.id), eq(complianceDocuments.verificationStatus, "needs_review")));
        await recordPortfolioEvent(tx, {
          orgRef, operatorId: op.id, credentialId: doc.id, actorUserId: ctx.user.id,
          eventType: input.outcome === "verified" ? "credential_verified" : "credential_rejected",
          detail: `${type.label} ${input.outcome}${input.note ? `: ${input.note}` : ""}`, at: now,
        });
        if (input.outcome === "verified" && previous && previous.id !== doc.id && previous.capturedAt.getTime() < doc.capturedAt.getTime()) {
          await recordPortfolioEvent(tx, { orgRef, operatorId: op.id, credentialId: previous.id, actorUserId: ctx.user.id, eventType: "credential_superseded", detail: `${type.label} superseded by credential ${doc.id}`, at: now });
        }
      });
      return { credentialId: doc.id, verificationStatus: input.outcome };
    }),

  /* ================================================================ */
  /* Requirements                                                       */
  /* ================================================================ */

  requirementList: roleProcedure("driverPortfolio.requirementList")
    .input(z.object({ includeRetired: z.boolean().default(false), subjectType: SUBJECT_TYPE.nullable().optional(), limit: LIMIT }).prefault({}))
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const rows = await bindingsInScope(db, scope, { includeRetired: input.includeRetired });
      return rows.filter(b => input.subjectType == null || b.subjectType === input.subjectType).slice(0, input.limit).map(bindingOut);
    }),

  requirementGet: roleProcedure("driverPortfolio.requirementGet")
    .input(z.object({ bindingRef: z.string().min(1).max(96) }))
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const b = await bindingInScopeOrThrow(db, input.bindingRef, scope);
      const successor = (await db.select({ ref: driverRequirementBindings.bindingRef }).from(driverRequirementBindings)
        .where(eq(driverRequirementBindings.supersedesBindingRef, b.bindingRef)).limit(1))[0]?.ref ?? null;
      return { ...bindingOut(b), supersededByBindingRef: successor };
    }),

  requirementCreate: roleProcedure("driverPortfolio.requirementCreate")
    .input(bindingInput)
    .mutation(async ({ ctx, input }) => {
      checkBinding(input);
      const { db, scope } = await scoped(ctx.user.id);
      const now = new Date();
      const bindingRef = newRef("DRB");
      const row = { ...input, requirementCode: storedCode(input.requirementKind, input.requirementCode) };
      await db.transaction(async tx => {
        await tx.insert(driverRequirementBindings).values({
          bindingRef, orgRef: orgRefFor(scope), subjectType: row.subjectType, subjectCode: row.subjectCode, requirementKind: row.requirementKind,
          requirementCode: row.requirementCode, label: row.label ?? null, enforcement: row.enforcement, effectiveAt: row.effectiveAt ?? null,
          expiresAt: row.expiresAt ?? null, active: true, createdByUserId: ctx.user.id,
        });
        await recordPortfolioEvent(tx, { orgRef: orgRefFor(scope), operatorId: null, actorUserId: ctx.user.id, eventType: "requirement_bound", detail: `${bindingRef}: ${describeBinding(row)}`, at: now });
      });
      return { bindingRef };
    }),

  /**
   * A binding may already have governed a dispatch decision, so it is never edited in place: the
   * old one is retired and a successor that names it is created, in one transaction.
   */
  requirementUpdate: roleProcedure("driverPortfolio.requirementUpdate")
    .input(z.object({ bindingRef: z.string().min(1).max(96), changes: bindingInput.partial() }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const old = await bindingInScopeOrThrow(db, input.bindingRef, scope);
      if (!old.active) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A retired requirement cannot be changed; create a new one" });
      const merged = {
        subjectType: input.changes.subjectType ?? old.subjectType, subjectCode: input.changes.subjectCode ?? old.subjectCode,
        requirementKind: input.changes.requirementKind ?? old.requirementKind, requirementCode: input.changes.requirementCode ?? old.requirementCode,
        label: input.changes.label !== undefined ? input.changes.label : old.label, enforcement: input.changes.enforcement ?? old.enforcement,
        effectiveAt: input.changes.effectiveAt !== undefined ? input.changes.effectiveAt : old.effectiveAt,
        expiresAt: input.changes.expiresAt !== undefined ? input.changes.expiresAt : old.expiresAt,
      };
      checkBinding(merged);
      const now = new Date();
      const bindingRef = newRef("DRB");
      const code = storedCode(merged.requirementKind, merged.requirementCode);
      await db.transaction(async tx => {
        const retired = await tx.update(driverRequirementBindings).set({ active: false, retiredAt: now, retiredByUserId: ctx.user.id })
          .where(and(eq(driverRequirementBindings.id, old.id), eq(driverRequirementBindings.active, true)));
        if (Number((retired as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 1) === 0) throw new TRPCError({ code: "CONFLICT", message: "The requirement changed while this update was being made" });
        await tx.insert(driverRequirementBindings).values({
          bindingRef, supersedesBindingRef: old.bindingRef, orgRef: old.orgRef, subjectType: merged.subjectType, subjectCode: merged.subjectCode,
          requirementKind: merged.requirementKind, requirementCode: code, label: merged.label ?? null, enforcement: merged.enforcement,
          effectiveAt: merged.effectiveAt ?? null, expiresAt: merged.expiresAt ?? null, active: true, createdByUserId: ctx.user.id,
        });
        await recordPortfolioEvent(tx, { orgRef: orgRefFor(scope), operatorId: null, actorUserId: ctx.user.id, eventType: "requirement_modified", detail: `${old.bindingRef} → ${bindingRef}: ${describeBinding(old)} → ${describeBinding({ ...merged, requirementCode: code })}`, at: now });
      });
      return { bindingRef, supersedesBindingRef: old.bindingRef };
    }),

  requirementRetire: roleProcedure("driverPortfolio.requirementRetire")
    .input(z.object({ bindingRef: z.string().min(1).max(96), reason: z.string().trim().min(5).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scoped(ctx.user.id);
      const b = await bindingInScopeOrThrow(db, input.bindingRef, scope);
      if (!b.active) return { bindingRef: b.bindingRef, retiredAt: b.retiredAt };
      const now = new Date();
      await db.transaction(async tx => {
        await tx.update(driverRequirementBindings).set({ active: false, retiredAt: now, retiredByUserId: ctx.user.id })
          .where(and(eq(driverRequirementBindings.id, b.id), eq(driverRequirementBindings.active, true)));
        await recordPortfolioEvent(tx, { orgRef: orgRefFor(scope), operatorId: null, actorUserId: ctx.user.id, eventType: "requirement_retired", detail: `${b.bindingRef} retired (${describeBinding(b)}): ${input.reason}`, at: now });
      });
      return { bindingRef: b.bindingRef, retiredAt: now };
    }),

  /* ================================================================ */
  /* Public: redeeming a share                                          */
  /* ================================================================ */

  /**
   * The one unauthenticated procedure. A 256-bit token names one credential. The answer is
   * re-read now, from the credential itself: a share never outlives the credential being valid,
   * and a revoked, expired or unknown share says so without saying anything else.
   */
  shareRedeem: publicProcedure
    .input(z.object({ token: z.string().min(20).max(200) }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const now = new Date();
      const s = (await db.select().from(driverCredentialShares).where(eq(driverCredentialShares.tokenHash, sha256(input.token))).limit(1))[0];
      if (!s) return { valid: false as const, reason: "not_found" as const };
      if (s.revokedAt) return { valid: false as const, reason: "revoked" as const };
      if (s.expiresAt.getTime() <= now.getTime()) return { valid: false as const, reason: "expired" as const };
      const op = (await db.select().from(operators).where(eq(operators.id, s.operatorId)).limit(1))[0];
      const rows = op ? (await loadPortfolios(db, [op]))[0]!.portfolio.credentials : [];
      const view = op ? sharedCredentialView({ credentialId: s.credentialId, code: s.credentialCode, holderName: op.name, credentials: rows, at: now }) : null;
      if (!view) return { valid: false as const, reason: "unavailable" as const };
      await recordPortfolioView(db, { orgRef: s.orgRef, operatorId: s.operatorId, credentialId: s.credentialId, actorUserId: null, eventType: "share_verified", detail: `Share ${s.shareRef} redeemed: ${view.state}`, at: now });
      return {
        valid: view.valid,
        reason: view.valid ? null : view.state,
        credential: { holderName: view.holderName, label: view.label, state: view.state, expiresOn: view.expiresOn, verifiedOn: view.verifiedOn, identifierEnding: maskIdentifier(view.identifier) },
        shareExpiresAt: s.expiresAt,
      };
    }),
});
