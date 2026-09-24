/**
 * 0175 — Client services, the office side: one-time tracking links, the job's customer account,
 * customer document releases, the open-ticket billing lifecycle, and the customer audit ledger.
 *
 * Every procedure is a `roleProcedure`. Scope is the caller's acting organization, resolved on the
 * server; a job, account or link outside it is "not found", never "forbidden". A link's token is
 * shown exactly once — at creation and at regeneration — and stored only as its hash, which is why
 * the QR payload (the URL) is returned with it and cannot be asked for later.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, jobInScope } from "./db";
import { customerAccounts, customerAuditEvents, jobTrackingLinks, jobs, externalIdentities, LIVE_UNTIL_RULES, LOCATION_MODES, TRACKING_LINK_CONTACT_KINDS } from "../drizzle/schema";
import { assertEntityInScope } from "./_core/entityScope";
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { DEFAULT_SCOPE, LIVE_PRESETS, hashTrackingToken, newTrackingToken, parseScope, qrPayload, serializeScope, trackingUrl, type TrackingScope } from "./_core/trackingLinks";
import { appendCustomerAuditEvent, verifyCustomerAuditChain } from "./_core/customerAudit";
import { queueCustomerAlert } from "./customerAlertService";
import { ENV } from "./_core/env";

async function db() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}

/** A customer account the caller's organization may bill, by ref, or "not found". */
async function accountInScope(accountRef: string, tenantId: string) {
  const d = await db();
  const a = (await d.select({ id: customerAccounts.id, financialEntityId: customerAccounts.financialEntityId, name: customerAccounts.name }).from(customerAccounts).where(eq(customerAccounts.accountRef, accountRef)).limit(1))[0];
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" });
  try { await assertEntityInScope(d, a.financialEntityId, { tenantId }); } catch { throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" }); }
  return a;
}

/** A link of the caller's organization, by ref, or "not found". */
async function ownLink(linkRef: string, tenantId: string) {
  const d = await db();
  const l = (await d.select().from(jobTrackingLinks).where(eq(jobTrackingLinks.linkRef, linkRef)).limit(1))[0];
  if (!l || l.orgRef !== tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "Tracking link not found" });
  return l;
}

const scopeInput = z.object({ status: z.boolean().optional(), loads: z.boolean().optional(), documents: z.boolean().optional(), billing: z.boolean().optional(), act: z.boolean().optional() }).optional();
const livePresetInput = z.enum(["until_completion", "24h", "7d", "30d", "custom", "manual"]);

function liveRuleFrom(preset: z.infer<typeof livePresetInput>, liveExpiresAt: Date | null | undefined): { liveUntilRule: (typeof LIVE_UNTIL_RULES)[number]; liveGraceHours: number | null; liveExpiresAt: Date | null } {
  if (preset === "custom") {
    if (!liveExpiresAt) throw new TRPCError({ code: "BAD_REQUEST", message: "A custom live window needs liveExpiresAt" });
    return { liveUntilRule: "custom", liveGraceHours: null, liveExpiresAt };
  }
  if (preset === "manual") return { liveUntilRule: "manual", liveGraceHours: null, liveExpiresAt: null };
  return { ...LIVE_PRESETS[preset], liveExpiresAt: null };
}

/** What the office sees of a link: never the token, never its hash. */
const linkView = (l: typeof jobTrackingLinks.$inferSelect) => ({
  linkRef: l.linkRef, jobId: l.jobId, customerAccountId: l.customerAccountId, label: l.label, contactKind: l.contactKind, contactName: l.contactName, contactEmail: l.contactEmail, contactPhone: l.contactPhone,
  scope: parseScope(l.scopeJson), locationMode: l.locationMode, liveUntilRule: l.liveUntilRule, liveGraceHours: l.liveGraceHours, liveExpiresAt: l.liveExpiresAt, expiresAt: l.expiresAt,
  maxAccessCount: l.maxAccessCount, accessCount: l.accessCount, lastAccessedAt: l.lastAccessedAt, status: l.status, revokedAt: l.revokedAt, revokedReason: l.revokedReason, supersededByLinkId: l.supersededByLinkId, createdAt: l.createdAt,
});

export const clientServicesRouter = router({
  /** Assign the customer account a job is for. The portal lists the job by it; nothing on the job is copied. */
  jobCustomerAssign: roleProcedure("clientServices.jobCustomerAssign")
    .input(z.object({ jobId: z.number().int().positive(), customerAccountRef: z.string().min(1).max(64).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const job = await jobInScope(input.jobId, scope);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      const account = input.customerAccountRef ? await accountInScope(input.customerAccountRef, scope.tenantId) : null;
      const d = await db();
      await d.transaction(async tx => {
        await tx.update(jobs).set({ customerAccountId: account?.id ?? null }).where(eq(jobs.id, job.id));
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "job_customer_assigned", subjectType: "job", subjectRef: job.jobCode, jobId: job.id, actorUserId: ctx.user.id, payload: { customerAccountRef: input.customerAccountRef, customerAccountId: account?.id ?? null } });
      });
      return { jobCode: job.jobCode, customerAccountId: account?.id ?? null };
    }),

  /**
   * Mint a tracking link. The token is returned once, with the URL that is also the QR payload.
   * Scope defaults to status + loads + documents; billing and actions are opted into per link.
   */
  trackingLinkCreate: roleProcedure("clientServices.trackingLinkCreate")
    .input(z.object({
      jobId: z.number().int().positive(),
      customerAccountRef: z.string().min(1).max(64).nullable().optional(),
      label: z.string().max(120).nullable().optional(),
      contactKind: z.enum(TRACKING_LINK_CONTACT_KINDS).nullable().optional(),
      contactName: z.string().max(180).nullable().optional(),
      contactEmail: z.string().email().max(220).nullable().optional(),
      contactPhone: z.string().max(60).nullable().optional(),
      externalIdentityRef: z.string().max(64).nullable().optional(),
      scope: scopeInput,
      locationMode: z.enum(LOCATION_MODES).default("none"),
      livePreset: livePresetInput.default("24h"),
      liveExpiresAt: z.coerce.date().nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxAccessCount: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const job = await jobInScope(input.jobId, scope);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      const d = await db();
      const jobRow = (await d.select({ customerAccountId: jobs.customerAccountId, jobCode: jobs.jobCode }).from(jobs).where(eq(jobs.id, job.id)).limit(1))[0]!;
      const account = input.customerAccountRef ? await accountInScope(input.customerAccountRef, scope.tenantId) : null;
      const customerAccountId = account?.id ?? jobRow.customerAccountId ?? null;
      let externalIdentityId: number | null = null;
      if (input.externalIdentityRef) {
        const ident = (await d.select({ id: externalIdentities.id, customerAccountId: externalIdentities.customerAccountId }).from(externalIdentities).where(eq(externalIdentities.identityRef, input.externalIdentityRef)).limit(1))[0];
        // A known contact must belong to the account the link is for; anything else is "not found".
        if (!ident || customerAccountId == null || ident.customerAccountId !== customerAccountId) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found on this account" });
        externalIdentityId = ident.id;
      }
      const linkScope: TrackingScope = { ...DEFAULT_SCOPE, ...(input.scope ?? {}) };
      const live = liveRuleFrom(input.livePreset, input.liveExpiresAt);
      const token = newTrackingToken();
      const linkRef = (await nextTrackingNumber(d, { sequenceType: "TL" })).trackingNumber;
      const now = new Date();
      await d.transaction(async tx => {
        const ins = await tx.insert(jobTrackingLinks).values({
          linkRef, orgRef: scope.tenantId, jobId: job.id, customerAccountId, tokenHash: hashTrackingToken(token), label: input.label ?? null,
          contactKind: input.contactKind ?? null, contactName: input.contactName ?? null, contactEmail: input.contactEmail ?? null, contactPhone: input.contactPhone ?? null, externalIdentityId,
          scopeJson: serializeScope(linkScope), locationMode: input.locationMode, ...live, expiresAt: input.expiresAt ?? null, maxAccessCount: input.maxAccessCount ?? null, createdByUserId: ctx.user.id, createdAt: now,
        });
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "tracking_link_created", subjectType: "trackingLink", subjectRef: linkRef, jobId: job.id, trackingLinkId: Number(ins[0]?.insertId ?? 0), externalIdentityId, actorUserId: ctx.user.id, payload: { scope: linkScope, locationMode: input.locationMode, livePreset: input.livePreset, expiresAt: input.expiresAt ?? null, maxAccessCount: input.maxAccessCount ?? null, contactKind: input.contactKind ?? null, contactName: input.contactName ?? null } });
      });
      await queueCustomerAlert({ customerAccountId, kind: "tracking_link_created", ticketNumber: linkRef, jobCode: jobRow.jobCode, detail: input.contactName ?? null, subjectRef: linkRef, tenantId: scope.tenantId });
      const url = trackingUrl(ENV.publicBaseUrl, token);
      return { linkRef, token, url, qr: qrPayload(ENV.publicBaseUrl, token), scope: linkScope, locationMode: input.locationMode, expiresAt: input.expiresAt ?? null, note: "The token is shown once and stored only as a hash. Send the URL; the QR payload is the same URL." };
    }),

  trackingLinkRevoke: roleProcedure("clientServices.trackingLinkRevoke")
    .input(z.object({ linkRef: z.string().min(1).max(64), reason: z.string().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const l = await ownLink(input.linkRef, scope.tenantId);
      if (l.status === "revoked") return { linkRef: l.linkRef, status: "revoked" as const, alreadyRevoked: true };
      const d = await db();
      const now = new Date();
      await d.transaction(async tx => {
        await tx.update(jobTrackingLinks).set({ status: "revoked", revokedAt: now, revokedByUserId: ctx.user.id, revokedReason: input.reason }).where(eq(jobTrackingLinks.id, l.id));
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "tracking_link_revoked", subjectType: "trackingLink", subjectRef: l.linkRef, jobId: l.jobId, trackingLinkId: l.id, actorUserId: ctx.user.id, payload: { reason: input.reason, previousStatus: l.status } });
      });
      return { linkRef: l.linkRef, status: "revoked" as const, alreadyRevoked: false };
    }),

  /** A new token for the same recipient and configuration; the old link is superseded and its token stops working. */
  trackingLinkRegenerate: roleProcedure("clientServices.trackingLinkRegenerate")
    .input(z.object({ linkRef: z.string().min(1).max(64), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const l = await ownLink(input.linkRef, scope.tenantId);
      if (!(await jobInScope(l.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: "Tracking link not found" });
      const d = await db();
      const token = newTrackingToken();
      const linkRef = (await nextTrackingNumber(d, { sequenceType: "TL" })).trackingNumber;
      const now = new Date();
      await d.transaction(async tx => {
        const ins = await tx.insert(jobTrackingLinks).values({
          linkRef, orgRef: l.orgRef, jobId: l.jobId, customerAccountId: l.customerAccountId, tokenHash: hashTrackingToken(token), label: l.label, contactKind: l.contactKind, contactName: l.contactName, contactEmail: l.contactEmail, contactPhone: l.contactPhone, externalIdentityId: l.externalIdentityId,
          scopeJson: l.scopeJson, locationMode: l.locationMode, liveUntilRule: l.liveUntilRule, liveGraceHours: l.liveGraceHours, liveExpiresAt: l.liveExpiresAt, expiresAt: l.expiresAt, maxAccessCount: l.maxAccessCount, createdByUserId: ctx.user.id, createdAt: now,
        });
        const newId = Number(ins[0]?.insertId ?? 0);
        await tx.update(jobTrackingLinks).set({ status: "superseded", supersededByLinkId: newId, revokedAt: now, revokedByUserId: ctx.user.id, revokedReason: input.reason ?? "regenerated" }).where(eq(jobTrackingLinks.id, l.id));
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "tracking_link_regenerated", subjectType: "trackingLink", subjectRef: l.linkRef, jobId: l.jobId, trackingLinkId: l.id, actorUserId: ctx.user.id, payload: { supersededBy: linkRef, reason: input.reason ?? null } });
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "tracking_link_created", subjectType: "trackingLink", subjectRef: linkRef, jobId: l.jobId, trackingLinkId: newId, externalIdentityId: l.externalIdentityId, actorUserId: ctx.user.id, payload: { regeneratedFrom: l.linkRef, scope: parseScope(l.scopeJson), locationMode: l.locationMode } });
      });
      const url = trackingUrl(ENV.publicBaseUrl, token);
      return { linkRef, supersedes: l.linkRef, token, url, qr: qrPayload(ENV.publicBaseUrl, token), note: "The previous link no longer resolves. The new token is shown once." };
    }),

  /** Change what a link may show, whether it is live, and when it ends. Every change is audited with before and after. */
  trackingLinkConfigure: roleProcedure("clientServices.trackingLinkConfigure")
    .input(z.object({
      linkRef: z.string().min(1).max(64),
      scope: scopeInput,
      locationMode: z.enum(LOCATION_MODES).optional(),
      livePreset: livePresetInput.optional(),
      liveExpiresAt: z.coerce.date().nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxAccessCount: z.number().int().positive().nullable().optional(),
      disabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const l = await ownLink(input.linkRef, scope.tenantId);
      if (l.status === "revoked" || l.status === "superseded") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Tracking link is ${l.status} — regenerate it instead` });
      const before = linkView(l);
      const nextScope: TrackingScope = { ...parseScope(l.scopeJson), ...(input.scope ?? {}) };
      const live = input.livePreset ? liveRuleFrom(input.livePreset, input.liveExpiresAt ?? l.liveExpiresAt) : {};
      const patch = {
        scopeJson: serializeScope(nextScope),
        ...(input.locationMode ? { locationMode: input.locationMode } : {}),
        ...live,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.maxAccessCount !== undefined ? { maxAccessCount: input.maxAccessCount } : {}),
        ...(input.disabled !== undefined ? { status: input.disabled ? ("disabled" as const) : ("active" as const) } : {}),
      };
      const d = await db();
      await d.transaction(async tx => {
        await tx.update(jobTrackingLinks).set(patch).where(eq(jobTrackingLinks.id, l.id));
        const after = linkView((await tx.select().from(jobTrackingLinks).where(eq(jobTrackingLinks.id, l.id)).limit(1))[0]!);
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "tracking_link_permissions_changed", subjectType: "trackingLink", subjectRef: l.linkRef, jobId: l.jobId, trackingLinkId: l.id, actorUserId: ctx.user.id, payload: { before: { scope: before.scope, locationMode: before.locationMode, liveUntilRule: before.liveUntilRule, liveGraceHours: before.liveGraceHours, expiresAt: before.expiresAt, maxAccessCount: before.maxAccessCount, status: before.status }, after: { scope: after.scope, locationMode: after.locationMode, liveUntilRule: after.liveUntilRule, liveGraceHours: after.liveGraceHours, expiresAt: after.expiresAt, maxAccessCount: after.maxAccessCount, status: after.status } } });
      });
      return linkView((await d.select().from(jobTrackingLinks).where(eq(jobTrackingLinks.id, l.id)).limit(1))[0]!);
    }),

  /** The links on a job in the caller's organization — configuration and use, never a token. */
  trackingLinks: roleProcedure("clientServices.trackingLinks")
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const job = await jobInScope(input.jobId, scope);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      const d = await db();
      const rows = await d.select().from(jobTrackingLinks).where(and(eq(jobTrackingLinks.jobId, job.id), eq(jobTrackingLinks.orgRef, scope.tenantId))).orderBy(desc(jobTrackingLinks.id));
      return { jobCode: job.jobCode, links: rows.map(linkView) };
    }),

  /** The customer audit ledger for one job of the caller's organization. */
  auditTrail: roleProcedure("clientServices.auditTrail")
    .input(z.object({ jobId: z.number().int().positive(), limit: z.number().int().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const job = await jobInScope(input.jobId, scope);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      const d = await db();
      const rows = await d.select().from(customerAuditEvents).where(and(eq(customerAuditEvents.jobId, job.id), eq(customerAuditEvents.orgRef, scope.tenantId))).orderBy(desc(customerAuditEvents.id)).limit(input.limit);
      return { jobCode: job.jobCode, events: rows.map(r => ({ eventRef: r.eventRef, eventType: r.eventType, subjectType: r.subjectType, subjectRef: r.subjectRef, trackingLinkId: r.trackingLinkId, externalIdentityId: r.externalIdentityId, actorUserId: r.actorUserId, payload: JSON.parse(r.eventJson) as unknown, previousHash: r.previousHash, eventHash: r.eventHash, occurredAt: r.occurredAt })) };
    }),

  /** Re-walk the caller's organization's chain. A break is named; nothing is repaired here. */
  auditVerify: roleProcedure("clientServices.auditVerify").query(async ({ ctx }) => {
    const scope = await actingScopeFor(ctx.user.id);
    return verifyCustomerAuditChain(await db(), scope.tenantId);
  }),
});
