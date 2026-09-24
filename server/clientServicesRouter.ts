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
import { CUSTOMER_DOCUMENT_KINDS, DOCUMENT_SOURCE_TYPES, customerAccounts, customerAuditEvents, customerDocumentReleases, jobTrackingLinks, jobs, externalIdentities, LIVE_UNTIL_RULES, LOCATION_MODES, TRACKING_LINK_CONTACT_KINDS } from "../drizzle/schema";
import { resolveCatalogueDocument } from "./customerDocuments";
import { fieldTicketInScope } from "./db";
import { customerTicketActions, fieldTicketLines, fieldTicketRevisions, fieldTickets } from "../drizzle/schema";
import { afterLineWrite, beforeLineWrite, linesWithAmounts, lockTicket, orgRefForTicket, ticketTotals, transitionBilling, writeFrozenRevision } from "./serviceTicketService";
import { finalizeCheck, lineWritePermitted } from "./_core/serviceTicketBilling";
import { loadTicket, snapshotFor } from "./closeoutRouter";
import { MEASUREMENT_BASIS, normaliseUnit, priceLineAndRecord } from "./_core/linePricing";
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

/** A ticket in the caller's scope (through its job, else its unit), or "not found". */
async function ownTicket(ticketNumber: string, userId: number) {
  const scope = await actingScopeFor(userId);
  const t = await fieldTicketInScope(ticketNumber, scope);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${ticketNumber} not found` });
  const d = await db();
  return (await d.select({ id: fieldTickets.id, ticketNumber: fieldTickets.ticketNumber, jobId: fieldTickets.jobId }).from(fieldTickets).where(eq(fieldTickets.id, t.id)).limit(1))[0]!;
}

/** A link of the caller's organization, by ref, or "not found". */
async function ownLink(linkRef: string, tenantId: string) {
  const d = await db();
  const l = (await d.select().from(jobTrackingLinks).where(eq(jobTrackingLinks.linkRef, linkRef)).limit(1))[0];
  if (!l || l.orgRef !== tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "Tracking link not found" });
  return l;
}

const scopeInput = z.object({ status: z.boolean().optional(), loads: z.boolean().optional(), documents: z.boolean().optional(), billing: z.boolean().optional(), act: z.boolean().optional(), unit: z.boolean().optional(), operator: z.boolean().optional() }).optional();
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

  /* ---- customer document releases: pointers into the catalogues, never copies ---- */

  /**
   * Release one catalogued document to the customer on a job. The record keeps its own number; the
   * release records who let it out and when. A field-ticket document must belong to a ticket on
   * this job; an evidence record must be on this job. Idempotent: releasing again returns the release.
   */
  documentRelease: roleProcedure("clientServices.documentRelease")
    .input(z.object({ jobId: z.number().int().positive(), sourceType: z.enum(DOCUMENT_SOURCE_TYPES), sourceId: z.number().int().positive(), kind: z.enum(CUSTOMER_DOCUMENT_KINDS), title: z.string().min(1).max(220).optional(), expiresAt: z.coerce.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const job = await jobInScope(input.jobId, scope);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      const d = await db();
      const cat = await resolveCatalogueDocument(d, input.sourceType, input.sourceId);
      // A document that names a job must name this one; a registry document with no job binding is the office's call.
      if (cat.jobId != null && cat.jobId !== job.id) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      const jobRow = (await d.select({ customerAccountId: jobs.customerAccountId }).from(jobs).where(eq(jobs.id, job.id)).limit(1))[0]!;
      const existing = (await d.select().from(customerDocumentReleases).where(and(eq(customerDocumentReleases.sourceType, input.sourceType), eq(customerDocumentReleases.sourceId, input.sourceId))).limit(1))[0];
      if (existing && existing.status === "released") return { releaseRef: existing.releaseRef, documentRef: existing.documentRef, kind: existing.kind, status: "released" as const, alreadyReleased: true };
      const releaseRef = existing?.releaseRef ?? (await nextTrackingNumber(d, { sequenceType: "REL" })).trackingNumber;
      const now = new Date();
      await d.transaction(async tx => {
        if (existing) await tx.update(customerDocumentReleases).set({ status: "released", releasedByUserId: ctx.user.id, releasedAt: now, withdrawnAt: null, withdrawnByUserId: null, withdrawReason: null, expiresAt: input.expiresAt ?? null, kind: input.kind, title: input.title ?? existing.title }).where(eq(customerDocumentReleases.id, existing.id));
        else await tx.insert(customerDocumentReleases).values({ releaseRef, orgRef: scope.tenantId, jobId: job.id, customerAccountId: jobRow.customerAccountId, sourceType: input.sourceType, sourceId: input.sourceId, documentRef: cat.documentRef, kind: input.kind, title: input.title ?? cat.title, contentHash: cat.contentHash, releasedByUserId: ctx.user.id, releasedAt: now, expiresAt: input.expiresAt ?? null });
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "customer_document_released", subjectType: "document", subjectRef: cat.documentRef, jobId: job.id, actorUserId: ctx.user.id, payload: { releaseRef, sourceType: input.sourceType, sourceId: input.sourceId, kind: input.kind, expiresAt: input.expiresAt ?? null, rereleased: !!existing } });
      });
      await queueCustomerAlert({ customerAccountId: jobRow.customerAccountId, kind: "document_ready", ticketNumber: cat.documentRef, jobCode: job.jobCode, subjectRef: releaseRef, tenantId: scope.tenantId });
      return { releaseRef, documentRef: cat.documentRef, kind: input.kind, status: "released" as const, alreadyReleased: false };
    }),

  documentWithdraw: roleProcedure("clientServices.documentWithdraw")
    .input(z.object({ releaseRef: z.string().min(1).max(64), reason: z.string().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const d = await db();
      const r = (await d.select().from(customerDocumentReleases).where(eq(customerDocumentReleases.releaseRef, input.releaseRef)).limit(1))[0];
      if (!r || r.orgRef !== scope.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "Release not found" });
      if (r.status === "withdrawn") return { releaseRef: r.releaseRef, status: "withdrawn" as const, alreadyWithdrawn: true };
      await d.transaction(async tx => {
        await tx.update(customerDocumentReleases).set({ status: "withdrawn", withdrawnAt: new Date(), withdrawnByUserId: ctx.user.id, withdrawReason: input.reason }).where(eq(customerDocumentReleases.id, r.id));
        await appendCustomerAuditEvent(tx, { orgRef: scope.tenantId, eventType: "customer_document_withdrawn", subjectType: "document", subjectRef: r.documentRef, jobId: r.jobId, actorUserId: ctx.user.id, payload: { releaseRef: r.releaseRef, reason: input.reason } });
      });
      return { releaseRef: r.releaseRef, status: "withdrawn" as const, alreadyWithdrawn: false };
    }),

  documentReleases: roleProcedure("clientServices.documentReleases")
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const job = await jobInScope(input.jobId, scope);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      const d = await db();
      const rows = await d.select().from(customerDocumentReleases).where(and(eq(customerDocumentReleases.jobId, job.id), eq(customerDocumentReleases.orgRef, scope.tenantId))).orderBy(desc(customerDocumentReleases.id));
      return { jobCode: job.jobCode, releases: rows.map(r => ({ releaseRef: r.releaseRef, sourceType: r.sourceType, sourceId: r.sourceId, documentRef: r.documentRef, kind: r.kind, title: r.title, contentHash: r.contentHash, status: r.status, releasedAt: r.releasedAt, expiresAt: r.expiresAt, withdrawnAt: r.withdrawnAt, withdrawReason: r.withdrawReason })) };
    }),

  /* ---- the open-ticket billing lifecycle ---- */

  /** Present the open ticket for the customer's review under its current hash. Idempotent; a disputed ticket may be re-presented. */
  ticketPresent: roleProcedure("clientServices.ticketPresent")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), customerPoNumber: z.string().max(80).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const x = await loadTicket(input.ticketNumber);
      const { hash, findings } = snapshotFor(x);
      const d = await db();
      const r = await d.transaction(async tx => {
        if (input.customerPoNumber !== undefined) await tx.update(fieldTickets).set({ customerPoNumber: input.customerPoNumber }).where(eq(fieldTickets.id, t.id));
        return transitionBilling(tx, { ticketId: t.id, action: "present", actor: { userId: ctx.user.id }, eventType: "ticket_presented", payload: { snapshotHash: hash, customerPoNumber: input.customerPoNumber ?? null } });
      });
      if (r.changed) await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "ticket_ready_for_review", ticketNumber: x.t.ticketNumber, jobCode: x.job?.jobCode ?? null, subjectRef: `${x.t.ticketNumber}:${hash.slice(0, 12)}` });
      return { ticketNumber: x.t.ticketNumber, billingState: r.to, snapshotHash: hash, findings };
    }),

  /** Reopen a presented, accepted or disputed ticket for more lines. The customer's earlier decision stands on the ledger; a new hash follows. */
  ticketReopen: roleProcedure("clientServices.ticketReopen")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), reason: z.string().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const d = await db();
      const r = await d.transaction(async tx => transitionBilling(tx, { ticketId: t.id, action: "reopen", actor: { userId: ctx.user.id }, eventType: "ticket_reopened", payload: { reason: input.reason } }));
      return { ticketNumber: t.ticketNumber, billingState: r.to };
    }),

  /**
   * Finalize: freeze the lines and totals behind a `final` revision and its hash. From CUSTOMER_ACCEPTED
   * without ceremony; from review or dispute only with `withoutCustomerAcceptance` and a reason, which the
   * revision and the ledger both carry.
   */
  ticketFinalize: roleProcedure("clientServices.ticketFinalize")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), withoutCustomerAcceptance: z.boolean().default(false), reason: z.string().max(400).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const d = await db();
      const out = await d.transaction(async tx => {
        const locked = await lockTicket(tx, t.id);
        if (locked.billingState === "FINALIZED" && locked.finalRevisionId) {
          const rev = (await tx.select().from(fieldTicketRevisions).where(eq(fieldTicketRevisions.id, locked.finalRevisionId)).limit(1))[0]!;
          return { finalized: true as const, alreadyFinalized: true, documentRef: rev.documentRef, snapshotHash: rev.snapshotHash, billingState: locked.billingState, refusals: [] as string[] };
        }
        const lines = await linesWithAmounts(tx, t.id);
        const check = finalizeCheck({ state: locked.billingState, withoutCustomerAcceptance: input.withoutCustomerAcceptance, reason: input.reason ?? null, lineCount: lines.length });
        if (!check.permitted) return { finalized: false as const, alreadyFinalized: false, refusals: check.refusals, billingState: locked.billingState, documentRef: null, snapshotHash: null };
        const frozen = await writeFrozenRevision(tx, { ticket: locked, kind: "final", actorUserId: ctx.user.id, finalizedWithoutCustomerAcceptance: check.overrides });
        const now = new Date();
        await tx.update(fieldTickets).set({ billingState: "FINALIZED", billingVersion: locked.billingVersion + 1, finalizedAt: now, finalizedByUserId: ctx.user.id, finalRevisionId: frozen.revisionId, updatedAt: now }).where(eq(fieldTickets.id, t.id));
        const org = await orgRefForTicket(tx, t.id);
        await appendCustomerAuditEvent(tx, { orgRef: org.orgRef, eventType: "ticket_finalized", subjectType: "fieldTicket", subjectRef: locked.ticketNumber, jobId: org.jobId, fieldTicketId: t.id, actorUserId: ctx.user.id, payload: { from: locked.billingState, to: "FINALIZED", version: locked.billingVersion + 1, documentRef: frozen.documentRef, snapshotHash: frozen.hash, totals: frozen.snapshot.billing, withoutCustomerAcceptance: check.overrides } });
        return { finalized: true as const, alreadyFinalized: false, documentRef: frozen.documentRef, snapshotHash: frozen.hash, billingState: "FINALIZED" as const, refusals: [] as string[], totals: frozen.snapshot.billing };
      });
      if (out.finalized && !out.alreadyFinalized) { const x = await loadTicket(input.ticketNumber); await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "billing_update", ticketNumber: x.t.ticketNumber, jobCode: x.job?.jobCode ?? null, detail: "ticket finalized", subjectRef: out.documentRef ?? x.t.ticketNumber }); }
      return out;
    }),

  /** Void a ticket that has not been invoiced. Nothing is deleted; the state and the reason are on record. */
  ticketVoid: roleProcedure("clientServices.ticketVoid")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const d = await db();
      const r = await d.transaction(async tx => {
        const r = await transitionBilling(tx, { ticketId: t.id, action: "void", actor: { userId: ctx.user.id }, eventType: "ticket_voided", payload: { reason: input.reason } });
        if (r.changed) await tx.update(fieldTickets).set({ voidedAt: new Date(), voidedByUserId: ctx.user.id, voidReason: input.reason }).where(eq(fieldTickets.id, t.id));
        return r;
      });
      return { ticketNumber: t.ticketNumber, billingState: r.to };
    }),

  /**
   * Amend a finalized ticket: a new line beside the frozen ones (never an edit), priced as it is
   * recorded, and a new `amendment` revision that supersedes the final by reference. The final revision
   * and its hash are untouched. After invoicing, the correction is a credit, not an amendment.
   */
  ticketAmend: roleProcedure("clientServices.ticketAmend")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), reason: z.string().min(5).max(400), lineKind: z.enum(["service", "load", "disposal", "standby", "equipment", "personnel", "mileage", "other"]), serviceCode: z.string().min(1).max(60).optional(), description: z.string().min(1).max(220), quantity: z.number().nullable().optional(), quantityUnit: z.string().max(30).nullable().optional(), amendsLineId: z.number().int().positive().nullable().optional(), customerVisible: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const x = await loadTicket(input.ticketNumber);
      const d = await db();
      return d.transaction(async tx => {
        const locked = await lockTicket(tx, t.id);
        if (locked.billingState !== "FINALIZED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: locked.billingState === "INVOICED" ? "The ticket is invoiced — a correction is a credit against the invoice" : `Only a finalized ticket is amended; this one is ${locked.billingState.replace(/_/g, " ").toLowerCase()}` });
        if (input.amendsLineId != null && !x.lines.some(l => l.id === input.amendsLineId)) throw new TRPCError({ code: "NOT_FOUND", message: "The line to amend is not on this ticket" });
        const ins = await tx.insert(fieldTicketLines).values({ fieldTicketId: t.id, lineKind: input.lineKind, serviceCode: input.serviceCode ?? null, description: input.description, quantity: input.quantity ?? null, quantityUnit: input.quantityUnit ?? null, measurementMethod: "unknown", disposition: "not_presented", customerVisible: input.customerVisible, amendsLineId: input.amendsLineId ?? null, addedByUserId: ctx.user.id });
        const lineId = Number(ins[0]?.insertId ?? 0);
        let pricing: unknown = { skipped: "no service named" };
        const unit = normaliseUnit(input.quantityUnit);
        if (input.serviceCode && input.quantity != null && unit && x.account) {
          const r = await priceLineAndRecord({ db: tx as never, financialEntityId: x.account.financialEntityId, rateKind: "sell", serviceCode: input.serviceCode, at: x.t.startedAt ?? x.t.createdAt, subjectKind: "field_ticket_line", subjectRef: `${x.t.ticketNumber}/L${lineId}`, quantity: input.quantity, unit, measurementSource: MEASUREMENT_BASIS.unknown ?? "manual_entry", decidedByUserId: ctx.user.id, context: { customerAccountId: x.account.id, jobId: x.t.jobId, unitId: x.t.unitId } });
          await tx.update(fieldTicketLines).set({ pricingDecisionRef: r.decisionRef }).where(eq(fieldTicketLines.id, lineId));
          pricing = { decisionRef: r.decisionRef, outcome: r.outcome.outcome, amountCents: r.outcome.amountCents };
        }
        const frozen = await writeFrozenRevision(tx, { ticket: locked, kind: "amendment", actorUserId: ctx.user.id, finalizedWithoutCustomerAcceptance: null });
        const now = new Date();
        await tx.update(fieldTickets).set({ billingVersion: locked.billingVersion + 1, finalRevisionId: frozen.revisionId, updatedAt: now }).where(eq(fieldTickets.id, t.id));
        const org = await orgRefForTicket(tx, t.id);
        await appendCustomerAuditEvent(tx, { orgRef: org.orgRef, eventType: "ticket_amended", subjectType: "fieldTicket", subjectRef: locked.ticketNumber, jobId: org.jobId, fieldTicketId: t.id, actorUserId: ctx.user.id, payload: { reason: input.reason, lineId, amendsLineId: input.amendsLineId ?? null, description: input.description, quantity: input.quantity ?? null, quantityUnit: input.quantityUnit ?? null, pricing, documentRef: frozen.documentRef, snapshotHash: frozen.hash, supersedes: frozen.snapshot.supersedesRevisionHash, totals: frozen.snapshot.billing } });
        return { ticketNumber: locked.ticketNumber, lineId, documentRef: frozen.documentRef, snapshotHash: frozen.hash, supersedesRevisionHash: frozen.snapshot.supersedesRevisionHash, totals: frozen.snapshot.billing, billingVersion: locked.billingVersion + 1 };
      });
    }),

  /** Change a line while the state allows it. The write names the version it read; a moved version is refused. Before and after are on the ledger. */
  lineUpdate: roleProcedure("clientServices.lineUpdate")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), lineId: z.number().int().positive(), expectedVersion: z.number().int().positive().nullable().optional(), description: z.string().min(1).max(220).optional(), quantity: z.number().nullable().optional(), quantityUnit: z.string().max(30).nullable().optional(), customerVisible: z.boolean().optional(), loadId: z.number().int().positive().nullable().optional(), disposalTicketId: z.number().int().positive().nullable().optional(), unitId: z.number().int().positive().nullable().optional(), periodStartAt: z.coerce.date().nullable().optional(), periodEndAt: z.coerce.date().nullable().optional(), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const x = await loadTicket(input.ticketNumber);
      const d = await db();
      return d.transaction(async tx => {
        const locked = await beforeLineWrite(tx, { ticketId: t.id, expectedVersion: input.expectedVersion ?? null });
        const before = (await tx.select().from(fieldTicketLines).where(and(eq(fieldTicketLines.id, input.lineId), eq(fieldTicketLines.fieldTicketId, t.id))).for("update").limit(1))[0];
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Line not found on this ticket" });
        const patch = {
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
          ...(input.quantityUnit !== undefined ? { quantityUnit: input.quantityUnit } : {}),
          ...(input.customerVisible !== undefined ? { customerVisible: input.customerVisible } : {}),
          ...(input.loadId !== undefined ? { loadId: input.loadId } : {}),
          ...(input.disposalTicketId !== undefined ? { disposalTicketId: input.disposalTicketId } : {}),
          ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
          ...(input.periodStartAt !== undefined ? { periodStartAt: input.periodStartAt } : {}),
          ...(input.periodEndAt !== undefined ? { periodEndAt: input.periodEndAt } : {}),
        };
        await tx.update(fieldTicketLines).set(patch).where(eq(fieldTicketLines.id, before.id));
        // A changed quantity or unit is priced again; the earlier decision stays on record and the line carries the new one.
        let repriced: unknown = null;
        const q = input.quantity !== undefined ? input.quantity : before.quantity;
        const u = normaliseUnit(input.quantityUnit !== undefined ? input.quantityUnit : before.quantityUnit);
        if ((input.quantity !== undefined || input.quantityUnit !== undefined) && before.serviceCode && q != null && u && x.account) {
          const r = await priceLineAndRecord({ db: tx as never, financialEntityId: x.account.financialEntityId, rateKind: "sell", serviceCode: before.serviceCode, at: x.t.startedAt ?? x.t.createdAt, subjectKind: "field_ticket_line", subjectRef: `${x.t.ticketNumber}/L${before.id}`, quantity: q, unit: u, measurementSource: MEASUREMENT_BASIS[before.measurementMethod] ?? "manual_entry", decidedByUserId: ctx.user.id, context: { customerAccountId: x.account.id, jobId: x.t.jobId, unitId: x.t.unitId } });
          await tx.update(fieldTicketLines).set({ pricingDecisionRef: r.decisionRef }).where(eq(fieldTicketLines.id, before.id));
          repriced = { decisionRef: r.decisionRef, outcome: r.outcome.outcome, amountCents: r.outcome.amountCents, previousDecisionRef: before.pricingDecisionRef };
        }
        const billing = await afterLineWrite(tx, { ticket: locked, lineId: before.id, eventType: "billing_line_modified", actor: { userId: ctx.user.id }, payload: { reason: input.reason ?? null, before: { description: before.description, quantity: before.quantity, quantityUnit: before.quantityUnit, customerVisible: before.customerVisible, loadId: before.loadId, disposalTicketId: before.disposalTicketId, unitId: before.unitId }, after: patch, repriced } });
        return { lineId: before.id, billingVersion: billing.version, billingState: billing.state, repriced };
      });
    }),

  /** The office's view of the open ticket: every line with its amount (internal ones included), totals, revisions, the customer's actions, and what may happen next. */
  ticketBilling: roleProcedure("clientServices.ticketBilling")
    .input(z.object({ ticketNumber: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const t = await ownTicket(input.ticketNumber, ctx.user.id);
      const d = await db();
      const [row, lines, revisions, actions] = await Promise.all([
        d.select().from(fieldTickets).where(eq(fieldTickets.id, t.id)).limit(1).then(r => r[0]!),
        linesWithAmounts(d, t.id),
        d.select({ id: fieldTicketRevisions.id, documentRef: fieldTicketRevisions.documentRef, revision: fieldTicketRevisions.revision, kind: fieldTicketRevisions.kind, snapshotHash: fieldTicketRevisions.snapshotHash, supersedesRevisionId: fieldTicketRevisions.supersedesRevisionId, generatedAt: fieldTicketRevisions.generatedAt }).from(fieldTicketRevisions).where(eq(fieldTicketRevisions.fieldTicketId, t.id)).orderBy(fieldTicketRevisions.revision),
        d.select().from(customerTicketActions).where(eq(customerTicketActions.fieldTicketId, t.id)).orderBy(customerTicketActions.id),
      ]);
      const x = await loadTicket(input.ticketNumber);
      const totals = ticketTotals(lines.map(l => ({ customerVisible: l.customerVisible, priced: l.priced, amountCents: l.amountCents, amendsLineId: l.amendsLineId })));
      return {
        ticketNumber: row.ticketNumber, billingState: row.billingState, billingVersion: row.billingVersion, customerPoNumber: row.customerPoNumber, finalizedAt: row.finalizedAt, finalRevisionId: row.finalRevisionId, voidedAt: row.voidedAt, voidReason: row.voidReason,
        presentedHash: snapshotFor(x).hash,
        lineWrites: lineWritePermitted(row.billingState),
        lines: lines.map(l => ({ id: l.id, lineKind: l.lineKind, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, quantityUnit: l.quantityUnit, customerVisible: l.customerVisible, disposition: l.disposition, priced: l.priced, amountCents: l.amountCents, pricingDecisionRef: l.pricingDecisionRef, loadId: l.loadId, disposalTicketId: l.disposalTicketId, unitId: l.unitId, periodStartAt: l.periodStartAt, periodEndAt: l.periodEndAt, amendsLineId: l.amendsLineId, addedByUserId: l.addedByUserId })),
        totals, revisions,
        actions: actions.map(a => ({ actionRef: a.actionRef, kind: a.kind, actorKind: a.actorKind, representativeName: a.representativeName, representativeTitle: a.representativeTitle, customerPoNumber: a.customerPoNumber, comment: a.comment, snapshotHash: a.snapshotHash, at: a.at })),
      };
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
