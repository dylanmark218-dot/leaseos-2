/**
 * 0175 — The one-time tracking link, from the recipient's side.
 *
 * Every procedure here is a `trackingProcedure`: the token resolves to one link, the link to one
 * job in one organization, and the link's scope decides what may be read. The request never names
 * a job. What is returned is an explicit customer-safe projection built in
 * `server/_core/customerJobView.ts` from the canonical records — never a serialized job row.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, trackingProcedure, type TrackingContext } from "./_core/trpc";
import { getDb } from "./db";
import { jobs } from "../drizzle/schema";
import { liveWindow } from "./_core/trackingLinks";
import { customerJobFor, customerLoadsFor, customerOpenTicketsFor, releasedDocumentsFor, type Visibility } from "./customerJobProjection";
import { readReleasedDocument } from "./customerDocuments";
import { appendCustomerAuditEvent } from "./_core/customerAudit";
import { recordCustomerAction, recordCustomerSignature, type CustomerActor } from "./customerActionService";

const trk = (ctx: unknown) => (ctx as { tracking: TrackingContext }).tracking;

async function db() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}

/** Whether this link still shows live status and position: the link's rule against the job's completion. */
async function liveFor(t: TrackingContext, now: Date) {
  const d = await db();
  const job = (await d.select({ status: jobs.status, updatedAt: jobs.updatedAt }).from(jobs).where(eq(jobs.id, t.jobId)).limit(1))[0];
  if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "This tracking link no longer resolves to a job" });
  return liveWindow({ liveUntilRule: t.liveUntilRule, liveGraceHours: t.liveGraceHours, liveExpiresAt: t.liveExpiresAt, jobCompletedAt: job.status === "complete" ? job.updatedAt : null, linkExpiresAt: t.expiresAt, now });
}

const actorOf = (t: TrackingContext): CustomerActor => ({ kind: "tracking_link", trackingLinkId: t.linkId, externalIdentityId: t.externalIdentityId, ipHash: t.ipHash, userAgent: t.userAgent, displayName: t.contactName });

const visibilityFor = (t: TrackingContext, live: boolean): Visibility => ({ locationMode: t.locationMode, live, unit: t.scope.unit, operator: t.scope.operator });

export const trackingRouter = router({
  /** The job as this link may see it: status, timeline, unit, position (in the configured mode), references. */
  status: trackingProcedure("tracking.status").query(async ({ ctx }) => {
    const t = trk(ctx);
    const now = new Date();
    const live = await liveFor(t, now);
    const view = await customerJobFor(await db(), t.jobId, visibilityFor(t, live.live), now);
    return { ...view, live: { available: live.live, reason: live.reason, until: live.until } };
  }),

  /** Loads, disposal tickets and destinations on the job, from the canonical load records. */
  loads: trackingProcedure("tracking.loads").query(async ({ ctx }) => customerLoadsFor(await db(), trk(ctx).jobId)),

  /** Documents released to the customer on this job — pointers with the records' own numbers. */
  documents: trackingProcedure("tracking.documents").query(async ({ ctx }) => {
    const t = trk(ctx);
    const d = await db();
    const docs = await releasedDocumentsFor(d, t.jobId);
    await d.transaction(async tx => { await appendCustomerAuditEvent(tx, { orgRef: t.orgRef, eventType: "customer_document_viewed", subjectType: "job", subjectRef: String(t.linkRef), jobId: t.jobId, trackingLinkId: t.linkId, externalIdentityId: t.externalIdentityId, ipHash: t.ipHash, payload: { listed: docs.map(x => x.documentRef) } }); });
    return { documents: docs };
  }),

  /** One released document's bytes, after the hash check. Every download is on the ledger. */
  documentDownload: trackingProcedure("tracking.documentDownload").input(z.object({ releaseRef: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    const t = trk(ctx);
    const d = await db();
    const r = await readReleasedDocument(d, { jobId: t.jobId, releaseRef: input.releaseRef });
    await d.transaction(async tx => { await appendCustomerAuditEvent(tx, { orgRef: t.orgRef, eventType: "customer_document_downloaded", subjectType: "document", subjectRef: r.doc.documentRef, jobId: t.jobId, trackingLinkId: t.linkId, externalIdentityId: t.externalIdentityId, ipHash: t.ipHash, payload: { releaseRef: r.release.releaseRef, contentHash: r.contentHash, kind: r.release.kind } }); });
    return { releaseRef: r.release.releaseRef, documentRef: r.doc.documentRef, kind: r.release.kind, title: r.release.title, mimeType: r.doc.mimeType, contentHash: r.contentHash, byteLength: r.bytes.length, dataBase64: r.bytes.toString("base64") };
  }),

  /** The open service ticket(s): customer-visible lines and the accrued estimate, the finalized total and the invoice when they exist. */
  openTicket: trackingProcedure("tracking.openTicket").query(async ({ ctx }) => {
    const t = trk(ctx);
    const d = await db();
    const tickets = await customerOpenTicketsFor(d, t.jobId);
    await d.transaction(async tx => { await appendCustomerAuditEvent(tx, { orgRef: t.orgRef, eventType: "customer_ticket_viewed", subjectType: "job", subjectRef: String(t.linkRef), jobId: t.jobId, trackingLinkId: t.linkId, externalIdentityId: t.externalIdentityId, ipHash: t.ipHash, payload: { tickets: tickets.map(x => ({ ticketNumber: x.ticketNumber, status: x.status, version: x.version })) } }); });
    return { tickets, note: "Amounts marked as estimates are accrued so far and are not an invoice. A finalized total and an invoice are shown only when they exist." };
  }),

  /* ---- customer actions: never a page visit, always a record ---- */

  /** "I have seen this ticket." Recorded with who said so; changes no state. */
  acknowledge: trackingProcedure("tracking.acknowledge").input(z.object({ ticketNumber: z.string().min(1).max(64), representativeName: z.string().min(1).max(180), representativeTitle: z.string().max(120).nullable().optional(), comment: z.string().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const t = trk(ctx);
    return recordCustomerAction({ db: await db(), ticketNumber: input.ticketNumber, scope: { jobId: t.jobId }, kind: "acknowledge", actor: actorOf(t), representativeName: input.representativeName, representativeTitle: input.representativeTitle ?? null, comment: input.comment ?? null });
  }),

  /** Approve the ticket as reviewed — by hash — naming the representative and, when they have one, the PO or reference. */
  approve: trackingProcedure("tracking.approve").input(z.object({ ticketNumber: z.string().min(1).max(64), snapshotHash: z.string().length(64), representativeName: z.string().min(1).max(180), representativeTitle: z.string().max(120).nullable().optional(), customerPoNumber: z.string().max(80).nullable().optional(), comment: z.string().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const t = trk(ctx);
    return recordCustomerAction({ db: await db(), ticketNumber: input.ticketNumber, scope: { jobId: t.jobId }, kind: "approve", actor: actorOf(t), representativeName: input.representativeName, representativeTitle: input.representativeTitle ?? null, customerPoNumber: input.customerPoNumber ?? null, comment: input.comment ?? null, snapshotHash: input.snapshotHash });
  }),

  /** Dispute the ticket, saying what and why. Both sides stay on record. */
  dispute: trackingProcedure("tracking.dispute").input(z.object({ ticketNumber: z.string().min(1).max(64), snapshotHash: z.string().length(64).nullable().optional(), representativeName: z.string().min(1).max(180), representativeTitle: z.string().max(120).nullable().optional(), comment: z.string().min(3).max(2000) })).mutation(async ({ ctx, input }) => {
    const t = trk(ctx);
    return recordCustomerAction({ db: await db(), ticketNumber: input.ticketNumber, scope: { jobId: t.jobId }, kind: "dispute", actor: actorOf(t), representativeName: input.representativeName, representativeTitle: input.representativeTitle ?? null, comment: input.comment, snapshotHash: input.snapshotHash ?? null });
  }),

  comment: trackingProcedure("tracking.comment").input(z.object({ ticketNumber: z.string().min(1).max(64), representativeName: z.string().max(180).nullable().optional(), comment: z.string().min(1).max(2000) })).mutation(async ({ ctx, input }) => {
    const t = trk(ctx);
    return recordCustomerAction({ db: await db(), ticketNumber: input.ticketNumber, scope: { jobId: t.jobId }, kind: "comment", actor: actorOf(t), representativeName: input.representativeName ?? null, comment: input.comment });
  }),

  /** Sign the presented site ticket electronically, through the canonical signature chain. Authority is unknown unless the link names a known signatory. */
  sign: trackingProcedure("tracking.sign").input(z.object({ ticketNumber: z.string().min(1).max(64), snapshotHash: z.string().length(64), signerName: z.string().min(1).max(180), signerTitle: z.string().max(120).nullable().optional(), authorities: z.array(z.enum(["work_confirmation", "time_confirmation", "quantity_confirmation", "standby_approval", "change_order_authorization", "invoice_approval"])).min(1), extraWorkCents: z.number().int().nonnegative().default(0), postSiteAuthorization: z.object({ disposalRequired: z.boolean(), travelToDisposal: z.boolean(), disposalWait: z.boolean(), disposalUnload: z.boolean(), returnTravel: z.enum(["yes", "no", "per_contract"]), capRule: z.enum(["none", "per_contract"]), restockingBillable: z.literal(false), postTripBillable: z.literal(false) }).nullable().optional(), gps: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const t = trk(ctx);
    return recordCustomerSignature({ db: await db(), ticketNumber: input.ticketNumber, scope: { jobId: t.jobId }, actor: actorOf(t), signerName: input.signerName, signerTitle: input.signerTitle ?? null, authorities: input.authorities, extraWorkCents: input.extraWorkCents, postSiteAuthorization: input.postSiteAuthorization ?? null, snapshotHash: input.snapshotHash, gps: input.gps ?? null });
  }),

  /** What this link is: the job's reference, who it was issued to, what it permits, and whether live tracking is still on. */
  resolve: trackingProcedure("tracking.resolve").query(async ({ ctx }) => {
    const t = trk(ctx);
    const d = await db();
    const job = (await d.select({ jobCode: jobs.jobCode, status: jobs.status, updatedAt: jobs.updatedAt }).from(jobs).where(eq(jobs.id, t.jobId)).limit(1))[0];
    if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "This tracking link no longer resolves to a job" });
    const now = new Date();
    const live = liveWindow({ liveUntilRule: t.liveUntilRule, liveGraceHours: t.liveGraceHours, liveExpiresAt: t.liveExpiresAt, jobCompletedAt: job.status === "complete" ? job.updatedAt : null, linkExpiresAt: t.expiresAt, now });
    return {
      linkRef: t.linkRef,
      jobReference: job.jobCode,
      issuedTo: t.contactName ? { name: t.contactName, kind: t.contactKind } : null,
      permits: t.scope,
      locationMode: t.locationMode,
      live: { available: live.live, reason: live.reason, until: live.until },
      expiresAt: t.expiresAt,
    };
  }),
});
