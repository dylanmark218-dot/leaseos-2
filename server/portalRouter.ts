/**
 * The external portal — customers, vendors, disposal facilities.
 *
 * Every procedure here is an `externalProcedure`: the identity's binding is
 * the only scope, and the request never names an account. Reads are
 * statements of what LeaseOS holds about that account. Writes are
 * submissions: checked, stored as SUBMITTED, idempotent by content, and
 * turned into records only when a person inside accepts them.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { externalProcedure, router, type ExternalContext } from "./_core/trpc";
import { getDb } from "./db";
import { CUSTOMER_ALERT_KINDS, changeOrders, clientAdjustments, customerAccounts, customerCredits, customerPurchaseOrders, disposalTickets, disputeCases, externalAccessLog, externalAlertPreferences, externalIdentities, facilities, fieldTicketDocuments, fieldTicketEvents, fieldTicketRevisions, fieldTickets, invoices, jobs, loads, paymentAllocations, portalSubmissions, quoteLines, quotes, rfis, roadHazardObservations, safetyEvents, trips, vendorBills, vendors, weatherObservations, workflowNotifications, invoiceLines } from "../drizzle/schema";
import { intakeDisposalTicket, intakeVendorBill, type ExternalIdentity } from "./_core/portalIntake";
import { ROTATION_GRACE_MS, TOKEN_TTL_MS, newToken, sha256, totpVerify } from "./_core/externalIdentityPolicy";
import { legacyMfaKey, secretKeyProvider } from "./_core/secretKeys";
import { enrollMfaSecret, mfaStorageOf, resolveMfaSeed } from "./mfaSecretService";
import { ENV } from "./_core/env";
import { decideAdjustment } from "./_core/clientAdjustments";
import { noticeFor, operationalState, projectReadiness } from "./_core/customerProjections";
import { DEFAULT_ON } from "./_core/customerAlerts";
import { queueCustomerAlert } from "./customerAlertService";
import { fromCents } from "./_core/money";
import { changeOrderAuthority, quoteAcceptanceDecision, type Authority } from "./_core/commercialProjects";
import { composeReadiness } from "./readinessComposer";
import { closeoutState, type EventType } from "./_core/siteCloseout";
import { storageRead } from "./storage";
import { invoiceBalanceCents } from "./_core/accountsReceivable";
import { decideLine, loadTicket, recordSignature, snapshotFor, unsignedMessage } from "./closeoutRouter";
import { whyTheseHours, type PostSiteAuthorization, type SiteSnapshot, type Supplement } from "./_core/siteCloseout";
import { fieldTicketSignatures, signatoryAuthorities } from "../drizzle/schema";
import { fieldTicketSignatureVerdict } from "./_core/fieldTicketSignature";
import { ATTEST_INPUT_KINDS, ATTEST_MARK_KINDS, CONSENT_VERSION_V1 } from "../shared/attest";
import { AttestRefusal, declineSession, listRevisions, submitSession, viewRevision, type RefusalCode } from "./_core/attest/attestService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ext = (ctx: unknown) => (ctx as { external: ExternalContext }).external;
const ATTEST_CODE: Record<RefusalCode, TRPCError["code"]> = { not_found: "NOT_FOUND", bad_request: "BAD_REQUEST", conflict: "CONFLICT", precondition: "PRECONDITION_FAILED", forbidden: "FORBIDDEN" };
async function attestRefusing<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (err) { if (err instanceof AttestRefusal) throw new TRPCError({ code: ATTEST_CODE[err.code], message: err.message }); throw err; }
}

async function submit(external: ExternalContext, kind: "vendor_bill" | "disposal_ticket" | "invoice_dispute", payload: unknown) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const payloadJson = JSON.stringify(payload);
  const payloadHash = sha(payloadJson);
  const dup = (await db.select({ submissionRef: portalSubmissions.submissionRef, status: portalSubmissions.status }).from(portalSubmissions).where(and(eq(portalSubmissions.externalIdentityId, external.identityId), eq(portalSubmissions.payloadHash, payloadHash))).limit(1))[0];
  if (dup) return { submissionRef: dup.submissionRef, status: dup.status, duplicate: true as const };
  const submissionRef = ref("SUB");
  await db.insert(portalSubmissions).values({ submissionRef, externalIdentityId: external.identityId, kind, payloadJson, payloadHash, submittedAt: new Date() });
  return { submissionRef, status: "submitted" as const, duplicate: false as const };
}

const identityOf = (e: ExternalContext): ExternalIdentity => ({ id: e.identityId, kind: e.kind, customerAccountId: e.kind === "customer" ? e.accountId : null, vendorId: e.kind === "vendor" ? e.accountId : null, facilityId: e.kind === "facility" ? e.accountId : null, status: "active" });


async function logAccess(e: ExternalContext, action: "view" | "download" | "sign" | "decide" | "authorize" | "accept_invitation" | "mfa_enroll" | "mfa_confirm" | "token_rotate", recordType: string, recordRef: string, recordVersion: string | null, context: string | null) {
  const db = await getDb();
  if (!db) return;
  await db.insert(externalAccessLog).values({ externalIdentityId: e.identityId, action, recordType, recordRef, recordVersion, context, at: new Date() });
}

/** The signatory authority the contractor holds for this identity, or null — never assumed. */
async function authorityFor(e: ExternalContext): Promise<Authority> {
  const db = await getDb();
  if (!db) return null;
  const a = (await db.select().from(signatoryAuthorities).where(and(eq(signatoryAuthorities.customerAccountId, e.accountId), eq(signatoryAuthorities.externalIdentityId, e.identityId))).orderBy(desc(signatoryAuthorities.id)).limit(1))[0];
  return a ? { extraWorkLimitCents: a.extraWorkLimitCents, mayAcceptQuotes: a.mayAcceptQuotes, mayAnswerRfis: a.mayAnswerRfis, status: a.status as "active" | "revoked", validTo: a.validTo } : null;
}

/** A customer's ticket, or "no such ticket on this account". The binding decides. */
async function ownTicket(e: ExternalContext, ticketNumber: string) {
  const x = await loadTicket(ticketNumber);
  if (x.t.customerAccountId !== e.accountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this account" });
  return x;
}

export const portalRouter = router({




  /* ---- v21.17: commercial commitments ---- */

  quotes: externalProcedure("portal.quotes").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [qs, cos, qsOpen] = await Promise.all([
      db.select().from(quotes).where(and(eq(quotes.customerAccountId, e.accountId), inArray(quotes.status, ["issued", "accepted", "declined", "expired", "superseded"]))).orderBy(desc(quotes.id)).limit(100),
      db.select().from(changeOrders).where(eq(changeOrders.customerAccountId, e.accountId)).orderBy(desc(changeOrders.id)).limit(100),
      db.select().from(rfis).where(eq(rfis.customerAccountId, e.accountId)).orderBy(desc(rfis.id)).limit(100),
    ]);
    const lines = qs.length ? await db.select().from(quoteLines).where(inArray(quoteLines.quoteId, qs.map(q => q.id))) : [];
    await logAccess(e, "view", "quotes", "account", null, `${qs.length} quotes, ${cos.length} change orders, ${qsOpen.length} RFIs`);
    return {
      quotes: qs.map(q => ({ quoteRef: q.quoteRef, version: q.version, title: q.title, scope: q.scope, subtotalCents: q.subtotalCents, validUntil: q.validUntil, status: q.status, snapshotHash: q.snapshotHash, issuedAt: q.issuedAt, lines: lines.filter(l => l.quoteId === q.id).map(l => ({ lineNo: l.lineNo, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents })) })),
      changeOrders: cos.map(c => ({ changeOrderRef: c.changeOrderRef, description: c.description, reason: c.reason, estimatedCents: c.estimatedCents, status: c.status, snapshotHash: c.snapshotHash, withinAuthority: c.withinAuthority, proposedAt: c.proposedAt })),
      rfis: qsOpen.map(r => ({ rfiRef: r.rfiRef, question: r.question, askedAt: r.askedAt, answer: r.answer, answeredAt: r.answeredAt, status: r.status })),
    };
  }),

  /** Accept the quote you saw — by hash — under the authority the contractor holds for you. */
  quoteAccept: externalProcedure("portal.quoteAccept").input(z.object({ quoteRef: z.string().min(1).max(64), snapshotHash: z.string().length(64) })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const q = (await db.select().from(quotes).where(eq(quotes.quoteRef, input.quoteRef)).limit(1))[0];
    if (!q || q.customerAccountId !== e.accountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such quote on this account" });
    const auth = await authorityFor(e);
    const d = quoteAcceptanceDecision({ status: q.status, validUntil: q.validUntil, snapshotHashOnFile: q.snapshotHash, snapshotHashSeen: input.snapshotHash, authority: auth, at: new Date() });
    if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
    await db.update(quotes).set({ status: "accepted", acceptedByName: e.displayName, acceptedByExternalIdentityId: e.identityId, acceptedAt: new Date(), acceptanceWithinAuthority: d.withinAuthority }).where(eq(quotes.id, q.id));
    await logAccess(e, "authorize", "quote", q.quoteRef, q.snapshotHash, `accepted; authority ${d.withinAuthority}`);
    return { quoteRef: q.quoteRef, status: "accepted" as const, withinAuthority: d.withinAuthority };
  }),

  /** Authorize a change order. Within your extra-work limit, above it, or unknown — recorded as it is, never assumed. */
  changeOrderAuthorize: externalProcedure("portal.changeOrderAuthorize").input(z.object({ changeOrderRef: z.string().min(1).max(64), snapshotHash: z.string().length(64), decision: z.enum(["authorized", "declined"]) })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const c = (await db.select().from(changeOrders).where(eq(changeOrders.changeOrderRef, input.changeOrderRef)).limit(1))[0];
    if (!c || c.customerAccountId !== e.accountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such change order on this account" });
    if (c.status !== "proposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Change order is ${c.status}` });
    if (c.snapshotHash !== input.snapshotHash) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The change order differs from what was presented — present it again" });
    const a = changeOrderAuthority({ estimatedCents: c.estimatedCents, authority: await authorityFor(e), at: new Date() });
    await db.update(changeOrders).set({ status: input.decision, authorizedByName: e.displayName, authorizedByExternalIdentityId: e.identityId, authorizedAt: new Date(), withinAuthority: input.decision === "authorized" ? a.withinAuthority : null, authorityDetail: input.decision === "authorized" ? a.detail : null }).where(eq(changeOrders.id, c.id));
    await logAccess(e, "authorize", "changeOrder", c.changeOrderRef, c.snapshotHash, `${input.decision}; authority ${a.withinAuthority}`);
    if (input.decision === "authorized") await queueCustomerAlert({ customerAccountId: e.accountId, kind: "billing_update", ticketNumber: c.changeOrderRef, detail: `change order ${a.withinAuthority === "yes" ? "authorized" : "authorized above the signatory's authority — the office will confirm"}`, subjectRef: c.changeOrderRef });
    return { changeOrderRef: c.changeOrderRef, status: input.decision, withinAuthority: input.decision === "authorized" ? a.withinAuthority : null, detail: input.decision === "authorized" ? a.detail : null };
  }),

  rfiAnswer: externalProcedure("portal.rfiAnswer").input(z.object({ rfiRef: z.string().min(1).max(64), answer: z.string().min(1).max(2000), affectsScope: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const r = (await db.select().from(rfis).where(eq(rfis.rfiRef, input.rfiRef)).limit(1))[0];
    if (!r || r.customerAccountId !== e.accountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such RFI on this account" });
    if (r.status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `RFI is ${r.status} — an answer on record is not replaced` });
    const auth = await authorityFor(e);
    if (auth && !auth.mayAnswerRfis) throw new TRPCError({ code: "FORBIDDEN", message: "This signatory does not answer RFIs for the account" });
    await db.update(rfis).set({ answer: input.answer, answeredByName: e.displayName, answeredByExternalIdentityId: e.identityId, answeredAt: new Date(), affectsScope: input.affectsScope ?? null, status: "answered" }).where(eq(rfis.id, r.id));
    await logAccess(e, "decide", "rfi", r.rfiRef, null, input.affectsScope ? "affects scope" : null);
    return { rfiRef: r.rfiRef, status: "answered" as const };
  }),

  /* ---- v21.14: custody, queue, timeline, alerts ---- */

  /** Every load on this ticket's job: source → unit → movement → destination, quantity with its method and its evidence state. Canonical records, projected; nothing certified that was not. */
  chainOfCustody: externalProcedure("portal.chainOfCustody").input(z.object({ ticketNumber: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const e = ext(ctx);
    const x = await ownTicket(e, input.ticketNumber);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const jobLoads = x.t.jobId ? await db.select().from(loads).where(eq(loads.jobId, x.t.jobId)) : [];
    const tripIds = Array.from(new Set(jobLoads.map(l => l.tripId).filter((t): t is number => t != null)));
    const [tripRows, tickets] = await Promise.all([
      tripIds.length ? db.select({ id: trips.id, tripNumber: trips.tripNumber, startedAt: trips.startedAt, completedAt: trips.completedAt, destinationFacilityId: trips.destinationFacilityId }).from(trips).where(inArray(trips.id, tripIds)) : [],
      jobLoads.length ? db.select().from(disposalTickets).where(inArray(disposalTickets.loadId, jobLoads.map(l => l.id))) : [],
    ]);
    const facIds = Array.from(new Set([...tripRows.map(t => t.destinationFacilityId), ...tickets.map(t => t.facilityId)].filter((f): f is number => f != null)));
    const facs = facIds.length ? await db.select({ id: facilities.id, name: facilities.name }).from(facilities).where(inArray(facilities.id, facIds)) : [];
    const facName = new Map(facs.map(f => [f.id, f.name]));
    const rows = jobLoads.map(l => {
      const trip = tripRows.find(t => t.id === l.tripId);
      const dt = tickets.find(t => t.loadId === l.id);
      const evidence = dt ? (dt.verificationStatus === "verified" ? "verified" : dt.verificationStatus === "rejected" ? "rejected" : "needs_review") : "no_ticket_yet";
      const timeline = [{ at: l.createdAt, what: "Loaded", by: `Unit ${l.unitId ?? "-"}` }, ...(trip?.startedAt ? [{ at: trip.startedAt, what: "Departed", by: trip.tripNumber }] : []), ...(dt?.scaleInAt ? [{ at: dt.scaleInAt, what: `Scaled in at ${facName.get(dt.facilityId ?? -1) ?? "facility"}`, by: dt.facilityTicketNumber ?? dt.ticketNumber }] : []), ...(trip?.completedAt ? [{ at: trip.completedAt, what: "Trip complete", by: trip.tripNumber }] : [])].sort((a, b) => a.at.getTime() - b.at.getTime());
      return {
        loadNumber: l.loadNumber, material: l.material ?? "unspecified", quantity: l.quantity != null ? Number(l.quantity) : null, unit: l.quantityUnit, measurementMethod: l.measurementMethod ?? "unknown",
        chainState: l.chainState, unitId: l.unitId, loadTicketNumber: l.loadTicketNumber,
        destination: facName.get(trip?.destinationFacilityId ?? dt?.facilityId ?? -1) ?? null,
        disposal: dt ? { facilityTicketNumber: dt.facilityTicketNumber, netKg: dt.netKg, quantity: dt.quantity != null ? Number(dt.quantity) : null, quantityUnit: dt.quantityUnit, evidence, confidence: dt.confidence, source: dt.source === "facility_portal" ? "facility submission" : dt.source === "ocr" ? "scan — proposed, not certified" : dt.source ?? "recorded" } : null,
        timeline,
      };
    });
    await logAccess(e, "view", "chainOfCustody", x.t.ticketNumber, null, `${rows.length} loads`);
    return { ticketNumber: x.t.ticketNumber, loads: rows, totals: Object.values(rows.reduce<Record<string, { material: string; quantity: number; unit: string | null }>>((acc, r) => { const k = `${r.material}|${r.unit ?? ""}`; acc[k] = acc[k] ?? { material: r.material, quantity: 0, unit: r.unit }; acc[k].quantity += r.quantity ?? 0; return acc; }, {})), complete: rows.length > 0 && rows.every(r => r.disposal?.evidence === "verified") };
  }),

  /** What awaits the consultant: tickets to sign, lines to decide, alerts unacknowledged. */
  approvalQueue: externalProcedure("portal.approvalQueue").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const tickets = await db.select().from(fieldTickets).where(eq(fieldTickets.customerAccountId, e.accountId));
    const toSign: { ticketNumber: string; siteWorkCompleteAt: Date | null }[] = [];
    const toDecide: { ticketNumber: string; lineId: number; description: string; operatorStatement: string | null }[] = [];
    for (const t of tickets) {
      const x = await loadTicket(t.ticketNumber);
      if (t.completedAt && !x.signature) toSign.push({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: t.completedAt });
      for (const l of x.lines) if (l.disposition === "not_presented") toDecide.push({ ticketNumber: t.ticketNumber, lineId: l.id, description: l.description, operatorStatement: l.operatorStatement });
    }
    const unread = await db.select({ id: workflowNotifications.id }).from(workflowNotifications).where(and(eq(workflowNotifications.recipientRole, `external:${e.identityRef}`), inArray(workflowNotifications.status, ["queued", "sent", "delivered"])));
    await logAccess(e, "view", "approvalQueue", "account", null, `${toSign.length} to sign, ${toDecide.length} to decide`);
    return { toSign, toDecide, unreadAlerts: unread.length };
  }),

  /** One chronological record of the job as the customer may see it: events, signature, revisions, documents, adjustments, observations. */
  jobTimeline: externalProcedure("portal.jobTimeline").input(z.object({ ticketNumber: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const e = ext(ctx);
    const x = await ownTicket(e, input.ticketNumber);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [docs, adj, wx, rh] = await Promise.all([
      db.select().from(fieldTicketDocuments).where(eq(fieldTicketDocuments.fieldTicketId, x.t.id)),
      db.select().from(clientAdjustments).where(and(eq(clientAdjustments.fieldTicketId, x.t.id), eq(clientAdjustments.status, "authorized"))),
      db.select().from(weatherObservations).where(and(eq(weatherObservations.fieldTicketId, x.t.id), eq(weatherObservations.customerVisible, true))),
      db.select().from(roadHazardObservations).where(and(eq(roadHazardObservations.fieldTicketId, x.t.id), eq(roadHazardObservations.customerVisible, true))),
    ]);
    const entries: { at: Date; kind: string; what: string; billing?: string; ref?: string }[] = [
      ...x.events.filter(ev => ev.customerBillable !== "no").map(ev => ({ at: ev.occurredAt, kind: "event", what: `${ev.eventType.replace(/_/g, " ")}${ev.endedAt ? ` until ${ev.endedAt.toISOString().slice(11, 16)}` : " (open)"}`, billing: ev.customerBillable })),
      ...(x.signature ? [{ at: x.signature.capturedAt, kind: "signature", what: `Signed by ${x.signature.signerName ?? "signer"} — ${x.signature.result}` }] : []),
      ...x.revisions.map(r => ({ at: r.generatedAt, kind: "revision", what: `R${r.revision} ${r.kind.replace(/_/g, " ")}`, ref: r.snapshotHash })),
      ...docs.map(d => ({ at: d.generatedAt, kind: "document", what: d.kind.replace(/_/g, " "), ref: d.documentRef })),
      ...adj.map(a => ({ at: a.authorizedAt, kind: "adjustment", what: `${a.kind.replace(/_/g, " ")} $${(a.amountCents / 100).toFixed(2)}${a.hourEquivalentMinutes ? ` (${(a.hourEquivalentMinutes / 60).toFixed(2)} h-equivalent, not worked time)` : ""}`, ref: a.adjustmentRef })),
      ...wx.map(w => ({ at: w.observedAt, kind: "weather", what: `Weather observed: ${(JSON.parse(w.conditionsJson) as string[]).join(", ")} (${w.severity})`, billing: w.billingTreatment })),
      ...rh.map(r => ({ at: r.observedAt, kind: "road_hazard", what: `Road hazard: ${r.hazard.replace(/_/g, " ")} (${r.severity})`, billing: r.billingTreatment })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    await logAccess(e, "view", "jobTimeline", x.t.ticketNumber, null, `${entries.length} entries`);
    return { ticketNumber: x.t.ticketNumber, entries, note: "Company activity after the site — post-trip, restocking, washout, fuel, paperwork — is not on this timeline and is never billed to you." };
  }),

  alerts: externalProcedure("portal.alerts").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const rows = await db.select().from(workflowNotifications).where(eq(workflowNotifications.recipientRole, `external:${e.identityRef}`)).orderBy(desc(workflowNotifications.queuedAt)).limit(100);
    return { alerts: rows.map(r => ({ id: r.id, title: r.title, body: r.body, deepLink: r.deepLink, status: r.status, queuedAt: r.queuedAt, acknowledgedAt: r.acknowledgedAt })) };
  }),

  alertAcknowledge: externalProcedure("portal.alertAcknowledge").input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const row = (await db.select({ id: workflowNotifications.id, recipientRole: workflowNotifications.recipientRole }).from(workflowNotifications).where(eq(workflowNotifications.id, input.id)).limit(1))[0];
    if (!row || row.recipientRole !== `external:${e.identityRef}`) throw new TRPCError({ code: "NOT_FOUND", message: "No such alert for this identity" });
    await db.update(workflowNotifications).set({ status: "acknowledged", acknowledgedAt: new Date() }).where(eq(workflowNotifications.id, row.id));
    return { id: row.id, status: "acknowledged" as const };
  }),

  alertPreferences: externalProcedure("portal.alertPreferences").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const prefs = await db.select().from(externalAlertPreferences).where(eq(externalAlertPreferences.externalIdentityId, e.identityId));
    return { preferences: CUSTOMER_ALERT_KINDS.map(k => ({ eventKind: k, enabled: prefs.find(p => p.eventKind === k)?.enabled ?? DEFAULT_ON[k], isDefault: !prefs.some(p => p.eventKind === k) })) };
  }),

  alertPreferencesSet: externalProcedure("portal.alertPreferencesSet").input(z.object({ eventKind: z.enum(CUSTOMER_ALERT_KINDS), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const cur = (await db.select({ id: externalAlertPreferences.id }).from(externalAlertPreferences).where(and(eq(externalAlertPreferences.externalIdentityId, e.identityId), eq(externalAlertPreferences.eventKind, input.eventKind))).limit(1))[0];
    if (cur) await db.update(externalAlertPreferences).set({ enabled: input.enabled, updatedAt: new Date() }).where(eq(externalAlertPreferences.id, cur.id));
    else await db.insert(externalAlertPreferences).values({ externalIdentityId: e.identityId, eventKind: input.eventKind, enabled: input.enabled });
    return { eventKind: input.eventKind, enabled: input.enabled };
  }),

  /* ---- v21.13: the live view ---- */

  /** Every ticket of this account: who, where, what authority, what state the ticket events establish, loads, delays, billing readiness. */
  jobBoard: externalProcedure("portal.jobBoard").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const now = new Date();
    const tickets = await db.select().from(fieldTickets).where(eq(fieldTickets.customerAccountId, e.accountId)).orderBy(desc(fieldTickets.id)).limit(100);
    const rows = [];
    for (const t of tickets) {
      const x = await loadTicket(t.ticketNumber);
      const jobRow = t.jobId ? (await db.select({ jobCode: jobs.jobCode, location: jobs.location }).from(jobs).where(eq(jobs.id, t.jobId)).limit(1))[0] : undefined;
      const safety = t.jobId ? await db.select({ eventType: safetyEvents.eventType, severity: safetyEvents.severity, status: safetyEvents.status, occurredAt: safetyEvents.occurredAt }).from(safetyEvents).where(eq(safetyEvents.jobId, t.jobId)) : [];
      const events = x.events.map(ev => ({ eventType: ev.eventType as EventType, occurredAt: ev.occurredAt, endedAt: ev.endedAt }));
      const st = operationalState({ events, siteSigned: !!x.signature, safety, now });
      const jobLoads = t.jobId ? await db.select({ material: loads.material, quantity: loads.quantity, quantityUnit: loads.quantityUnit, chainState: loads.chainState }).from(loads).where(eq(loads.jobId, t.jobId)) : [];
      const material = new Map<string, { quantity: number; unit: string }>();
      for (const l of jobLoads) { const k = l.material ?? "unspecified"; const cur = material.get(k) ?? { quantity: 0, unit: l.quantityUnit ?? "" }; cur.quantity += Number(l.quantity ?? 0); material.set(k, cur); }
      const holds = x.events.filter(ev => ["standby", "customer_hold", "weather_hold"].includes(ev.eventType));
      const firstSite = x.events.filter(ev => ev.eventType === "site_work").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
      const state = closeoutState({ events: x.events as never, lines: x.lines as never, siteWorkCompleteAt: x.t.completedAt, signature: x.signatureVerdict, supplement: null, postSiteRequired: x.t.postSiteRequired, loadsWithDisposalEvidence: 0, loads: jobLoads.length });
      rows.push({
        ticketNumber: t.ticketNumber, jobCode: jobRow?.jobCode ?? null, site: jobRow?.location ?? null, purchaseOrder: t.afeNumber ? { afeNumber: t.afeNumber } : null, unitId: t.unitId,
        operational: st,
        arrivalAt: firstSite?.occurredAt ?? null, siteCloseAt: x.signature?.capturedAt ?? null,
        loads: { completed: jobLoads.filter(l => l.chainState === "unloaded" || l.chainState === "disposal_verified" || l.chainState === "billed").length, total: jobLoads.length }, material: Array.from(material.entries()).map(([m, v]) => ({ material: m, quantity: Math.round(v.quantity * 100) / 100, unit: v.unit })),
        delays: { count: holds.length, hours: Math.round(holds.reduce((a, h) => a + (h.endedAt ? (h.endedAt.getTime() - h.occurredAt.getTime()) / 3_600_000 : 0), 0) * 100) / 100, billing: holds.some(h => h.customerBillable === "review") ? "review" : holds.length ? "per_ticket" : "none" },
        underReview: x.events.filter(ev => ev.customerBillable === "review").length,
        closeout: state.state, invoiceReady: state.invoiceReady,
      });
    }
    await logAccess(e, "view", "jobBoard", "account", null, `${rows.length} tickets`);
    return { asOf: now, tickets: rows };
  }),

  /** Pre-clearance: the same readiness dispatch uses, projected. A verdict and a category per finding; nothing else crosses. */
  preClearance: externalProcedure("portal.preClearance").input(z.object({ ticketNumber: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const e = ext(ctx);
    const x = await ownTicket(e, input.ticketNumber);
    if (x.t.operatorId == null || x.t.unitId == null) return { ticketNumber: x.t.ticketNumber, readiness: { verdict: "UNKNOWN" as const, items: [] }, basis: "No operator or unit assigned yet" };
    // The composer refuses a subject it has no record for. To the customer that is UNKNOWN with the reason — never an error, never a guess.
    let composed: Awaited<ReturnType<typeof composeReadiness>>;
    try { composed = await composeReadiness({ operatorId: x.t.operatorId, unitId: x.t.unitId, trailerId: null, jobId: x.t.jobId ?? null }); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) { await logAccess(e, "view", "preClearance", x.t.ticketNumber, null, "UNKNOWN"); return { ticketNumber: x.t.ticketNumber, readiness: { verdict: "UNKNOWN" as const, items: [] }, basis: "The contractor holds no readiness record for the assigned operator or unit" }; }
      throw err;
    }
    const projection = projectReadiness({ verdict: composed.eligibility.verdict, blockers: composed.eligibility.blockers.map(b => ({ code: b.code, severity: b.severity, subject: b.subject })) });
    await logAccess(e, "view", "preClearance", x.t.ticketNumber, null, projection.verdict);
    return { ticketNumber: x.t.ticketNumber, readiness: projection, basis: "Contractor's readiness engine, projected: verdict and category only" };
  }),

  /** Customer-safe notices from the contractor's safety events on this account's jobs. Templates only. */
  notices: externalProcedure("portal.notices").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const tickets = await db.select({ jobId: fieldTickets.jobId, ticketNumber: fieldTickets.ticketNumber }).from(fieldTickets).where(eq(fieldTickets.customerAccountId, e.accountId));
    const jobIds = Array.from(new Set(tickets.map(t => t.jobId).filter((j): j is number => j != null)));
    const evs = jobIds.length ? await db.select({ jobId: safetyEvents.jobId, eventType: safetyEvents.eventType, severity: safetyEvents.severity, status: safetyEvents.status, occurredAt: safetyEvents.occurredAt }).from(safetyEvents).where(inArray(safetyEvents.jobId, jobIds)) : [];
    const byJob = new Map<number, string>(tickets.filter(t => t.jobId != null).map(t => [t.jobId as number, t.ticketNumber]));
    const notices = evs.map(ev => ({ ticketNumber: ev.jobId != null ? byJob.get(ev.jobId) ?? null : null, notice: noticeFor(ev) })).filter((n): n is { ticketNumber: string | null; notice: NonNullable<ReturnType<typeof noticeFor>> } => n.notice != null).map(n => ({ ticketNumber: n.ticketNumber, ...n.notice }));
    await logAccess(e, "view", "notices", "account", null, `${notices.length}`);
    return { notices };
  }),

  /* ---- v21.12: identity lifecycle, through the same gate ---- */

  /** Accept an invitation: the invitation token comes in, the bearer token goes out once. */
  invitationAccept: externalProcedure("portal.invitationAccept").mutation(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const token = newToken();
    const now = new Date();
    await db.update(externalIdentities).set({ status: "active", acceptedAt: now, tokenHash: sha256(token), tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS), invitationTokenHash: null, invitationExpiresAt: null }).where(eq(externalIdentities.id, e.identityId));
    await logAccess(e, "accept_invitation", "externalIdentity", e.identityRef, null, null);
    return { identityRef: e.identityRef, token, tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS), note: "Shown once. Stored only as a hash." };
  }),

  /**
   * Start MFA: the secret is returned once for the authenticator and stored in the canonical
   * secret store; nothing is enforced until confirmed.
   *
   * 0193 — the seed now goes to `encryptedSecrets` under purpose `MFA_SECRET` and the identity
   * keeps only a reference. `mfaSecretEnc` is cleared by the same write, so re-enrolling can never
   * leave the replaced seed behind as a reactivation path.
   */
  mfaEnroll: externalProcedure("portal.mfaEnroll").mutation(async ({ ctx }) => {
    const e = ext(ctx);
    const keys = secretKeyProvider();
    if (!keys.getActiveKey("MFA_SECRET")) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MFA requires an MFA secret key on the server; it is not configured" });
    }
    const { secret } = await enrollMfaSecret(e.identityId, { keys, legacyKey: legacyMfaKey(), isProduction: ENV.isProduction });
    await logAccess(e, "mfa_enroll", "externalIdentity", e.identityRef, null, null);
    return { secret, otpauth: `otpauth://totp/LeaseOS:${encodeURIComponent(e.displayName)}?secret=${secret}&issuer=LeaseOS&digits=6&period=30`, note: "Shown once." };
  }),

  mfaConfirm: externalProcedure("portal.mfaConfirm").input(z.object({ code: z.string().min(6).max(8) })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const row = (await db.select({ mfaSecretEnc: externalIdentities.mfaSecretEnc, mfaSecretRef: externalIdentities.mfaSecretRef }).from(externalIdentities).where(eq(externalIdentities.id, e.identityId)).limit(1))[0];
    if (!row || mfaStorageOf(row) === "none") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enroll first" });
    // Resolution may throw — a present-but-broken reference must fail, not fall back to legacy.
    const seed = await resolveMfaSeed(row, { keys: secretKeyProvider(), legacyKey: legacyMfaKey(), isProduction: ENV.isProduction });
    if (!totpVerify(seed, input.code, new Date())) throw new TRPCError({ code: "FORBIDDEN", message: "Code rejected" });
    await db.update(externalIdentities).set({ mfaEnabled: true }).where(eq(externalIdentities.id, e.identityId));
    await logAccess(e, "mfa_confirm", "externalIdentity", e.identityRef, null, null);
    return { mfaEnabled: true as const };
  }),

  /** Rotate the bearer token; the old one lives for the grace window so a session is not stranded. */
  tokenRotate: externalProcedure("portal.tokenRotate").mutation(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const cur = (await db.select({ tokenHash: externalIdentities.tokenHash }).from(externalIdentities).where(eq(externalIdentities.id, e.identityId)).limit(1))[0]!;
    const token = newToken();
    const now = new Date();
    await db.update(externalIdentities).set({ tokenHash: sha256(token), tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS), previousTokenHash: cur.tokenHash, previousTokenExpiresAt: new Date(now.getTime() + ROTATION_GRACE_MS) }).where(eq(externalIdentities.id, e.identityId));
    await logAccess(e, "token_rotate", "externalIdentity", e.identityRef, null, null);
    return { token, tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS), previousValidUntil: new Date(now.getTime() + ROTATION_GRACE_MS) };
  }),

  /* ---- v21.12: discretionary adjustments ---- */

  /** A tip, a bonus, a flat amount, a percentage, or an hour-equivalent — billing value, never worked time. Idempotent by content. */
  adjustmentAuthorize: externalProcedure("portal.adjustmentAuthorize")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), kind: z.enum(["tip", "crew_bonus", "exceptional_service_bonus", "flat", "percent", "completion_bonus", "callout_bonus", "hour_equivalent"]), amountCents: z.number().int().positive().optional(), percent: z.number().positive().max(100).optional(), hourEquivalent: z.number().positive().max(24).optional(), recipientIntent: z.enum(["company", "crew", "named_workers", "operator", "supervisor", "company_crew_split", "unknown"]).default("unknown"), namedWorkers: z.array(z.string().min(1).max(120)).max(20).optional(), reason: z.string().min(5).max(600), agreedHourlyRateCents: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const x = await ownTicket(e, input.ticketNumber);
      if (!x.signature || !x.signatureVerdict.satisfied) throw new TRPCError({ code: "PRECONDITION_FAILED", message: unsignedMessage("The ticket is not signed — an adjustment is added to a signed ticket, and after R1 it becomes a later revision", x.signatureVerdict) });
      const site = JSON.parse(x.revisions[0]!.snapshotJson) as { siteBillableHours: number };
      const d = decideAdjustment({ kind: input.kind, amountCents: input.amountCents, percent: input.percent, hourEquivalent: input.hourEquivalent, recipientIntent: input.recipientIntent, namedWorkers: input.namedWorkers, reason: input.reason }, { siteSubtotalCents: Math.round(site.siteBillableHours * (input.agreedHourlyRateCents ?? 0)), siteBillableHours: site.siteBillableHours, agreedHourlyRateCents: input.agreedHourlyRateCents ?? null });
      if (!d.permitted) throw new TRPCError({ code: "BAD_REQUEST", message: d.refusals.join("; ") });
      const idem = sha256(JSON.stringify({ t: x.t.id, e: e.identityId, kind: input.kind, a: d.amountCents, h: d.hourEquivalentMinutes, r: input.reason, i: input.recipientIntent }));
      const dup = (await db.select({ adjustmentRef: clientAdjustments.adjustmentRef }).from(clientAdjustments).where(eq(clientAdjustments.idempotencyHash, idem)).limit(1))[0];
      if (dup) return { adjustmentRef: dup.adjustmentRef, duplicate: true as const, amountCents: d.amountCents, hourEquivalentMinutes: d.hourEquivalentMinutes, payrollTreatment: d.payrollTreatment, clocksUnchanged: true as const };
      const adjustmentRef = ref("ADJ");
      const latestRev = [...x.revisions].sort((a, b) => b.revision - a.revision)[0]!;
      await db.insert(clientAdjustments).values({ adjustmentRef, fieldTicketId: x.t.id, customerAccountId: e.accountId, kind: input.kind, basisJson: JSON.stringify(d.basis), amountCents: d.amountCents, hourEquivalentMinutes: d.hourEquivalentMinutes, recipientIntent: input.recipientIntent, recipientDetailJson: input.namedWorkers ? JSON.stringify({ namedWorkers: input.namedWorkers }) : null, reason: input.reason, authorizedByExternalIdentityId: e.identityId, authorizedByName: e.displayName, authorizedAt: new Date(), revisionId: latestRev.id, payrollTreatment: d.payrollTreatment, idempotencyHash: idem });
      await logAccess(e, "authorize", "clientAdjustment", adjustmentRef, `R${latestRev.revision}`, input.kind);
      await queueCustomerAlert({ customerAccountId: e.accountId, kind: "billing_update", ticketNumber: x.t.ticketNumber, detail: `${input.kind.replace(/_/g, " ")} authorized`, subjectRef: adjustmentRef });
      return { adjustmentRef, duplicate: false as const, amountCents: d.amountCents, hourEquivalentMinutes: d.hourEquivalentMinutes, payrollTreatment: d.payrollTreatment, clocksUnchanged: true as const, note: d.hourEquivalentMinutes != null ? "An hour-equivalent is billing value expressed in hours. No duty, payroll, GPS, equipment or standby clock changes." : null };
    }),

  /* ---- v21.12: documents ---- */

  documents: externalProcedure("portal.documents").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const tickets = await db.select({ id: fieldTickets.id, ticketNumber: fieldTickets.ticketNumber }).from(fieldTickets).where(eq(fieldTickets.customerAccountId, e.accountId));
    if (!tickets.length) return { documents: [] };
    const docs = await db.select().from(fieldTicketDocuments).where(inArray(fieldTicketDocuments.fieldTicketId, tickets.map(t => t.id))).orderBy(desc(fieldTicketDocuments.generatedAt));
    const byTicket = new Map(tickets.map(t => [t.id, t.ticketNumber]));
    await logAccess(e, "view", "documentList", "account", null, `${docs.length} documents`);
    return { documents: docs.map(d => ({ documentRef: d.documentRef, ticketNumber: byTicket.get(d.fieldTicketId)!, kind: d.kind, contentHash: d.contentHash, sourceSnapshotHash: d.sourceSnapshotHash, byteLength: d.byteLength, generatedAt: d.generatedAt })) };
  }),

  documentDownload: externalProcedure("portal.documentDownload").input(z.object({ documentRef: z.string().min(1).max(64), purpose: z.string().max(200).optional() })).mutation(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const d = (await db.select().from(fieldTicketDocuments).where(eq(fieldTicketDocuments.documentRef, input.documentRef)).limit(1))[0];
    const t = d ? (await db.select({ customerAccountId: fieldTickets.customerAccountId, ticketNumber: fieldTickets.ticketNumber }).from(fieldTickets).where(eq(fieldTickets.id, d.fieldTicketId)).limit(1))[0] : undefined;
    if (!d || !t || t.customerAccountId !== e.accountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such document on this account" });
    const bytes = await storageRead(d.storageKey);
    if (sha256(bytes.toString("latin1")) !== d.contentHash) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stored document does not match its recorded hash — not served" });
    await logAccess(e, "download", "fieldTicketDocument", d.documentRef, d.contentHash, input.purpose ?? null);
    return { documentRef: d.documentRef, ticketNumber: t.ticketNumber, kind: d.kind, contentHash: d.contentHash, mimeType: "application/pdf", dataBase64: bytes.toString("base64") };
  }),

  /* ---- v21.12: the daily report, and what people saw ---- */

  /** One day, from canonical records only: tickets, events by billing answer, loads, observations. Value is PROPOSED, never invoiced here. */
  dailyReport: externalProcedure("portal.dailyReport").input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).query(async ({ ctx, input }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const start = new Date(`${input.date}T00:00:00Z`), end = new Date(start.getTime() + 86_400_000);
    const tickets = await db.select().from(fieldTickets).where(eq(fieldTickets.customerAccountId, e.accountId));
    const ids = tickets.map(t => t.id);
    const events = ids.length ? (await db.select().from(fieldTicketEvents).where(inArray(fieldTicketEvents.fieldTicketId, ids))).filter(ev => ev.occurredAt >= start && ev.occurredAt < end) : [];
    const hoursOf = (ev: { occurredAt: Date; endedAt: Date | null }) => ev.endedAt ? (ev.endedAt.getTime() - ev.occurredAt.getTime()) / 3_600_000 : 0;
    const byAnswer = { yes: 0, no: 0, review: 0 };
    for (const ev of events) byAnswer[ev.customerBillable as "yes" | "no" | "review"] += hoursOf(ev);
    const jobIds = Array.from(new Set(tickets.map(t => t.jobId).filter((j): j is number => j != null)));
    const dayLoads = jobIds.length ? (await db.select().from(loads).where(inArray(loads.jobId, jobIds))).filter(l => l.createdAt >= start && l.createdAt < end) : [];
    const [wx, rh] = await Promise.all([
      ids.length ? db.select().from(weatherObservations).where(and(inArray(weatherObservations.fieldTicketId, ids), eq(weatherObservations.customerVisible, true))) : [],
      ids.length ? db.select().from(roadHazardObservations).where(and(inArray(roadHazardObservations.fieldTicketId, ids), eq(roadHazardObservations.customerVisible, true))) : [],
    ]);
    // SPINE item 2 — "signed" is the site sign-off's verdict per ticket, not the denormalized column.
    const [sigRows, revRows] = ids.length ? await Promise.all([
      db.select().from(fieldTicketSignatures).where(inArray(fieldTicketSignatures.fieldTicketId, ids)),
      db.select().from(fieldTicketRevisions).where(inArray(fieldTicketRevisions.fieldTicketId, ids)),
    ]) : [[], []];
    const signedCount = tickets.filter(t => fieldTicketSignatureVerdict({ ticket: t, signatures: sigRows.filter(r => r.fieldTicketId === t.id), revisions: revRows.filter(r => r.fieldTicketId === t.id) }).satisfied).length;
    const adj = ids.length ? await db.select().from(clientAdjustments).where(and(inArray(clientAdjustments.fieldTicketId, ids), eq(clientAdjustments.status, "authorized"))) : [];
    const material = new Map<string, { quantity: number; unit: string }>();
    for (const l of dayLoads) { const k = l.material ?? "unspecified"; const cur = material.get(k) ?? { quantity: 0, unit: l.quantityUnit ?? "" }; cur.quantity += Number(l.quantity ?? 0); material.set(k, cur); }
    await logAccess(e, "view", "dailyReport", input.date, null, null);
    return {
      date: input.date,
      tickets: { total: tickets.filter(t => events.some(ev => ev.fieldTicketId === t.id)).length, signed: signedCount },
      hours: { customerBillable: round2(byAnswer.yes), underReview: round2(byAnswer.review), companyInternalNotBilled: round2(byAnswer.no) },
      loads: dayLoads.length,
      material: Array.from(material.entries()).map(([m, v]) => ({ material: m, quantity: round2(v.quantity), unit: v.unit })),
      observations: { weather: wx.filter(w => w.observedAt >= start && w.observedAt < end).length, roadHazards: rh.filter(r => r.observedAt >= start && r.observedAt < end).length },
      adjustmentsCents: adj.reduce((a, x) => a + x.amountCents, 0),
      estimatedValue: { status: "not_computed" as const, reason: "Value needs the customer's rate card applied by the office; hours are shown by billing answer instead. Nothing here is invoiced." },
    };
  }),

  observations: externalProcedure("portal.observations").input(z.object({ ticketNumber: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const e = ext(ctx);
    const x = await ownTicket(e, input.ticketNumber);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [wx, rh] = await Promise.all([
      db.select().from(weatherObservations).where(and(eq(weatherObservations.fieldTicketId, x.t.id), eq(weatherObservations.customerVisible, true))),
      db.select().from(roadHazardObservations).where(and(eq(roadHazardObservations.fieldTicketId, x.t.id), eq(roadHazardObservations.customerVisible, true))),
    ]);
    await logAccess(e, "view", "observations", x.t.ticketNumber, null, null);
    // Customer-safe projection: what, when, how bad, the effect, and the billing answer. Never who, never coordinates.
    return {
      weather: wx.map(w => ({ observedAt: w.observedAt, source: w.observerType === "external_source" ? `external: ${w.externalSourceName ?? "unnamed"}` : "worker observation", conditions: JSON.parse(w.conditionsJson) as unknown, visibility: w.visibility, roadState: w.roadState, severity: w.severity, operationalEffect: w.operationalEffect, billingTreatment: w.billingTreatment })),
      roadHazards: rh.map(r => ({ observedAt: r.observedAt, hazard: r.hazard, severity: r.severity, description: r.description, billingTreatment: r.billingTreatment })),
    };
  }),

  me: externalProcedure("portal.me").query(async ({ ctx }) => {
    const e = ext(ctx);
    return { identityRef: e.identityRef, kind: e.kind, displayName: e.displayName };
  }),

  /** What this customer owes, invoice by invoice, with the POs consumed and the disputes open. Scoped by the binding. */
  customerStatement: externalProcedure("portal.customerStatement").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const acct = (await db.select().from(customerAccounts).where(eq(customerAccounts.id, e.accountId)).limit(1))[0];
    if (!acct) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
    // v23.32 — only what was SENT to the customer: an approved invoice not yet issued is the office's, not the customer's.
    const inv = await db.select().from(invoices).where(and(eq(invoices.customerAccountId, acct.id), inArray(invoices.status, ["sent", "viewed", "approved", "partially_paid", "paid", "disputed"]), or(ne(invoices.status, "approved"), isNotNull(invoices.sentAt))));
    const ids = inv.map(i => i.id);
    const [allocs, creds, pos, disputes] = await Promise.all([
      ids.length ? db.select().from(paymentAllocations).where(inArray(paymentAllocations.invoiceId, ids)) : [],
      db.select().from(customerCredits).where(and(eq(customerCredits.customerAccountId, acct.id), eq(customerCredits.status, "approved"))),
      db.select().from(customerPurchaseOrders).where(eq(customerPurchaseOrders.customerAccountId, acct.id)),
      inv.length ? db.select().from(disputeCases).where(inArray(disputeCases.invoiceNumber, inv.map(i => i.invoiceNumber))) : [],
    ]);
    const rows = inv.map(i => ({ invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt ?? i.createdAt, dueAt: i.dueAt, totalCents: i.totalCents, balanceCents: invoiceBalanceCents({ id: i.id, invoiceNumber: i.invoiceNumber, customer: i.customer, totalCents: i.totalCents, dueAt: i.dueAt, issuedAt: i.issuedAt ?? i.createdAt, status: i.status, disputed: false }, allocs.map(a => ({ invoiceId: a.invoiceId, amountCents: a.amountCents })), creds.map(c => ({ invoiceId: c.invoiceId, customer: c.customer, amountCents: c.amountCents, status: c.status }))), status: i.status, purchaseOrder: i.purchaseOrder, afeNumber: i.afeNumber }));
    await logAccess(e, "view", "customerStatement", "account", null, null);
    return {
      account: { name: acct.name, paymentTermsDays: acct.paymentTermsDays, status: acct.status },
      invoices: rows, outstandingCents: rows.reduce((a, r) => a + Math.max(0, r.balanceCents), 0),
      purchaseOrders: pos.map(p => ({ poNumber: p.poNumber, afeNumber: p.afeNumber, authorizedCents: p.authorizedCents, consumedCents: inv.filter(i => i.customerPurchaseOrderId === p.id).reduce((a, i) => a + i.totalCents, 0), status: p.status, validTo: p.validTo })),
      disputes: disputes.map(d => ({ caseNumber: d.caseNumber, invoiceNumber: d.invoiceNumber, disputedAmountCents: d.disputedAmountCents, status: d.status, raisedAt: d.raisedAt })),
    };
  }),

  /** v22.10 — the account's invoices as issued to it: number, dates, total, balance, status, its document. */
  invoices: externalProcedure("portal.invoices").query(async ({ ctx }) => {
    const e = ctx.external;
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const rows = (await db.select().from(invoices).where(eq(invoices.customerAccountId, e.accountId))).filter(i => i.status !== "draft" && i.status !== "void" && i.sentAt != null);
    const docs = rows.length ? await db.select({ invoiceId: fieldTicketDocuments.invoiceId, documentRef: fieldTicketDocuments.documentRef, contentHash: fieldTicketDocuments.contentHash }).from(fieldTicketDocuments).where(and(eq(fieldTicketDocuments.kind, "invoice"), inArray(fieldTicketDocuments.invoiceId, rows.map(r => r.id)))) : [];
    const docByInvoice = new Map(docs.map(x => [x.invoiceId, x]));
    return { invoices: rows.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0)).map(i => ({ invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, sentAt: i.sentAt, dueAt: i.dueAt, viewedAt: i.viewedAt, status: i.status, currency: i.currency, subtotalCents: i.subtotalCents, taxCents: i.taxCents, totalCents: i.totalCents, purchaseOrder: i.purchaseOrder, afeNumber: i.afeNumber, acceptedAt: i.acceptedAt, acceptedByName: i.acceptedByName, disputedAt: i.disputedAt, documentRef: docByInvoice.get(i.id)?.documentRef ?? null, contentHash: docByInvoice.get(i.id)?.contentHash ?? null })) };
  }),

  /** Viewing marks the invoice viewed, once. The lines shown are the frozen ones. */
  invoiceView: externalProcedure("portal.invoiceView").input(z.object({ invoiceNumber: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    const e = ctx.external;
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const inv = (await db.select().from(invoices).where(and(eq(invoices.invoiceNumber, input.invoiceNumber), eq(invoices.customerAccountId, e.accountId))).limit(1))[0];
    if (!inv || inv.status === "draft" || inv.status === "void" || inv.sentAt == null) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice for this account" });
    if (inv.viewedAt == null) await db.update(invoices).set({ viewedAt: new Date(), status: inv.status === "sent" ? "viewed" : inv.status }).where(eq(invoices.id, inv.id));
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    return { invoiceNumber: inv.invoiceNumber, status: inv.viewedAt == null && inv.status === "sent" ? "viewed" : inv.status, totalCents: inv.totalCents, taxCents: inv.taxCents, subtotalCents: inv.subtotalCents, dueAt: inv.dueAt, lines: lines.sort((a, b) => a.lineNo - b.lineNo).map(l => ({ lineNo: l.lineNo, description: l.description, billableQuantityMillis: l.billableQuantityMillis, unit: l.unit, rateMillis: l.rateMillis, amountCents: l.amountCents })) };   // the customer sees the sell price and nothing of cost
  }),

  /** Acceptance is the customer's act, recorded in the acceptance fields; a disputed invoice is not accepted over its dispute. */
  invoiceAccept: externalProcedure("portal.invoiceAccept").input(z.object({ invoiceNumber: z.string().min(1).max(64), acceptedByRole: z.string().min(1).max(80) })).mutation(async ({ ctx, input }) => {
    const e = ctx.external;
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const inv = (await db.select().from(invoices).where(and(eq(invoices.invoiceNumber, input.invoiceNumber), eq(invoices.customerAccountId, e.accountId))).limit(1))[0];
    if (!inv || inv.sentAt == null || inv.status === "draft" || inv.status === "void") throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice for this account" });
    if (inv.status === "disputed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invoice is disputed — the dispute is resolved before acceptance" });
    if (inv.acceptedAt) return { invoiceNumber: inv.invoiceNumber, acceptedAt: inv.acceptedAt, acceptedByName: inv.acceptedByName, already: true as const };
    const acceptedAt = new Date();
    await db.update(invoices).set({ acceptedAt, acceptedByName: e.displayName, acceptedByRole: input.acceptedByRole, acceptanceToken: `${e.identityRef}:${acceptedAt.toISOString()}` }).where(eq(invoices.id, inv.id));
    return { invoiceNumber: inv.invoiceNumber, acceptedAt, acceptedByName: e.displayName, already: false as const };
  }),

  invoiceDispute: externalProcedure("portal.invoiceDispute")
    .input(z.object({ invoiceNumber: z.string().min(1).max(64), disputedAmountCents: z.number().int().positive(), reason: z.string().min(10).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // The invoice must be THIS account's — resolved from the binding, not the request.
      // v23.32 — numbers are per organization: look the number up on THIS account only; and only an invoice sent to the customer is disputed.
      const inv = (await db.select({ id: invoices.id, customerAccountId: invoices.customerAccountId, totalCents: invoices.totalCents, status: invoices.status, sentAt: invoices.sentAt }).from(invoices).where(and(eq(invoices.invoiceNumber, input.invoiceNumber), eq(invoices.customerAccountId, e.accountId))).limit(1))[0];
      if (!inv || inv.customerAccountId !== e.accountId || inv.status === "draft" || inv.status === "void" || inv.status === "in_review" || (inv.status === "approved" && inv.sentAt == null)) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice on this account" });
      if (input.disputedAmountCents > inv.totalCents) throw new TRPCError({ code: "BAD_REQUEST", message: "Disputed amount exceeds the invoice" });
      return submit(e, "invoice_dispute", { invoiceNumber: input.invoiceNumber, disputedAmountCents: input.disputedAmountCents, reason: input.reason });
    }),

  /** This account's field tickets: the signed snapshot, the supplement, and why the hours are what they are. */
  fieldTicketView: externalProcedure("portal.fieldTicketView")
    .input(z.object({ ticketNumber: z.string().max(64).optional() }))
    .query(async ({ ctx, input }) => {
      const e = ext(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const tickets = await db.select({ ticketNumber: fieldTickets.ticketNumber, status: fieldTickets.status, signatureStatus: fieldTickets.signatureStatus, completedAt: fieldTickets.completedAt, postSiteRequired: fieldTickets.postSiteRequired }).from(fieldTickets).where(eq(fieldTickets.customerAccountId, e.accountId)).orderBy(desc(fieldTickets.id)).limit(100);
      if (!input.ticketNumber) return { tickets, detail: null };
      const t = tickets.find(x => x.ticketNumber === input.ticketNumber);
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this account" });
      const x = await loadTicket(t.ticketNumber);
      const revisions = x.revisions.map(r => ({ documentRef: r.documentRef, revision: r.revision, kind: r.kind, snapshotHash: r.snapshotHash, generatedAt: r.generatedAt }));
      const snap = x.revisions[0] ? (JSON.parse(x.revisions[0].snapshotJson) as SiteSnapshot) : snapshotFor(x).snapshot;
      const supp = [...x.revisions].reverse().find(r => r.kind === "post_site_supplement");
      const supplement = supp ? (JSON.parse(supp.snapshotJson) as { supplement: Supplement }).supplement : null;
      return { tickets, detail: { ticket: t, snapshot: snap, snapshotHash: x.revisions[0]?.snapshotHash ?? snapshotFor(x).hash, lines: x.lines, signature: x.signature ? { signerName: x.signature.signerName, signedAt: x.signature.capturedAt, exercised: x.signature.authoritiesExercised ? JSON.parse(x.signature.authoritiesExercised) : [], withinAuthority: x.signature.withinAuthority, method: x.signature.signatureMethod } : null, revisions, why: whyTheseHours(snap, x.signature?.signerName ?? null, supplement) } };
    }),

  /* ---- SA1: Sign & Attest through the portal. The identity's scope is the signer row that names it; the request never says whose document. ---- */
  attestList: externalProcedure("portal.attestList")
    .input(z.object({ limit: z.number().int().positive().max(200).optional() }).strict().optional())
    .query(async ({ ctx, input }) => {
      const e = ext(ctx); const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await logAccess(e, "view", "attestRevisions", "mine", null, null);
      return listRevisions(db as never, { externalIdentityId: e.identityId }, { limit: input?.limit });
    }),
  attestView: externalProcedure("portal.attestView")
    .input(z.object({ revisionRef: z.string().min(3).max(120) }).strict())
    .query(async ({ ctx, input }) => {
      const e = ext(ctx); const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const view = await attestRefusing(() => viewRevision(db as never, { externalIdentityId: e.identityId }, input.revisionRef));
      await logAccess(e, "view", "attestRevision", input.revisionRef, view.revision.revisionHash, null);
      return view;
    }),
  /** The identity signs its OWN assigned fields; a field assigned to anyone else is refused and the attempt is a row. */
  attestSign: externalProcedure("portal.attestSign")
    .input(z.object({
      revisionRef: z.string().min(3).max(120), signerRef: z.string().min(3).max(120), revisionHashAtStart: z.string().regex(/^[a-f0-9]{64}$/),
      consentVersion: z.string().min(1).max(40).default(CONSENT_VERSION_V1),
      marks: z.array(z.object({ fieldKey: z.string().min(1).max(80), markKind: z.enum(ATTEST_MARK_KINDS), inputKind: z.enum(ATTEST_INPUT_KINDS), valueText: z.string().max(500).nullable().optional(), strokeEvidenceRecordId: z.number().int().positive().nullable().optional(), strokeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), renderedEvidenceRecordId: z.number().int().positive().nullable().optional(), renderedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict()).min(1).max(200),
      gps: z.object({ latitude: z.number(), longitude: z.number() }).strict().nullable().optional(), sessionRef: z.string().min(8).max(120).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx); const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const r = await attestRefusing(() => submitSession(db as never, { kind: "external", externalIdentityId: e.identityId }, { externalIdentityId: e.identityId }, { ...input, authMethod: "portal_link" }));
      await logAccess(e, "sign", "attestRevision", input.revisionRef, input.revisionHashAtStart, r.sessionRef);
      return r;
    }),
  attestDecline: externalProcedure("portal.attestDecline")
    .input(z.object({ revisionRef: z.string().min(3).max(120), signerRef: z.string().min(3).max(120), reason: z.string().min(3).max(500) }).strict())
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx); const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const r = await attestRefusing(() => declineSession(db as never, { kind: "external", externalIdentityId: e.identityId }, { externalIdentityId: e.identityId }, input));
      await logAccess(e, "decide", "attestRevision", input.revisionRef, null, "declined");
      return r;
    }),

  /** The consultant signs on their own device. Authority comes from the binding, never the request. */
  fieldTicketSign: externalProcedure("portal.fieldTicketSign")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), snapshotHash: z.string().length(64), authorities: z.array(z.enum(["work_confirmation", "time_confirmation", "quantity_confirmation", "standby_approval", "change_order_authorization", "invoice_approval"])).min(1), extraWorkCents: z.number().int().nonnegative().default(0), postSiteAuthorization: z.object({ disposalRequired: z.boolean(), travelToDisposal: z.boolean(), disposalWait: z.boolean(), disposalUnload: z.boolean(), returnTravel: z.enum(["yes", "no", "per_contract"]), capRule: z.enum(["none", "per_contract"]), restockingBillable: z.literal(false), postTripBillable: z.literal(false) }).nullable().optional(), gps: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const t = (await db.select({ id: fieldTickets.id, customerAccountId: fieldTickets.customerAccountId }).from(fieldTickets).where(eq(fieldTickets.ticketNumber, input.ticketNumber)).limit(1))[0];
      if (!t || t.customerAccountId !== e.accountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this account" });
      const auth = (await db.select().from(signatoryAuthorities).where(and(eq(signatoryAuthorities.customerAccountId, e.accountId), eq(signatoryAuthorities.externalIdentityId, e.identityId))).orderBy(desc(signatoryAuthorities.id)).limit(1))[0];
      const acct = (await db.select({ name: customerAccounts.name }).from(customerAccounts).where(eq(customerAccounts.id, e.accountId)).limit(1))[0];
      return recordSignature({ ticketNumber: input.ticketNumber, signer: { name: e.displayName, company: acct?.name ?? "", role: auth?.signatoryRole ?? null }, // 0158: what actually happened — identity proved through the signed portal link, paired with
        // externalIdentityId. device_auth would claim an enrolled device the customer never had.
        method: "portal_link" as const, requested: input.authorities, extraWorkCents: input.extraWorkCents, postSiteAuthorization: (input.postSiteAuthorization as PostSiteAuthorization | null | undefined) ?? null, snapshotHash: input.snapshotHash, authority: auth ? { signatoryName: auth.signatoryName, mayConfirmWork: auth.mayConfirmWork, maySignTicket: auth.maySignTicket, mayApproveStandby: auth.mayApproveStandby, extraWorkLimitCents: auth.extraWorkLimitCents, mayApproveInvoice: auth.mayApproveInvoice, mayChangeRates: auth.mayChangeRates, validTo: auth.validTo, status: auth.status } : null, gps: input.gps ?? null, offline: false, witnessedByOperatorId: null, externalIdentityId: e.identityId, paperScanEvidenceRecordId: null, generatedByUserId: null });
    }),

  fieldTicketLineDecide: externalProcedure("portal.fieldTicketLineDecide")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), lineId: z.number().int().positive(), disposition: z.enum(["accepted", "disputed"]), customerQuantity: z.number().nullable().optional(), customerStatement: z.string().max(220).nullable().optional() }))
    .mutation(async ({ ctx, input }) => decideLine({ ticketNumber: input.ticketNumber, lineId: input.lineId, disposition: input.disposition, customerQuantity: input.customerQuantity ?? null, customerStatement: input.customerStatement ?? null, customerAccountIdMustMatch: ext(ctx).accountId })),

  /** What this vendor has submitted and what LeaseOS did with it, bill by bill, to payment. Scoped by the binding. */
  vendorStatement: externalProcedure("portal.vendorStatement").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const v = (await db.select().from(vendors).where(eq(vendors.id, e.accountId)).limit(1))[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor not found" });
    const [subs, bills] = await Promise.all([
      db.select().from(portalSubmissions).where(eq(portalSubmissions.externalIdentityId, e.identityId)).orderBy(desc(portalSubmissions.submittedAt)).limit(200),
      db.select().from(vendorBills).where(eq(vendorBills.vendorId, v.id)).orderBy(desc(vendorBills.invoiceDate)).limit(200),
    ]);
    const stage = (s: string) => s === "paid" ? "paid" : s === "ready_to_pay" ? "approved_for_payment" : s === "disputed" ? "disputed" : s === "cancelled" ? "cancelled" : ["mismatch", "duplicate_suspected", "missing_receipt"].includes(s) ? "held_for_review" : "received";
    await logAccess(e, "view", "vendorStatement", "account", null, null);
    return {
      vendor: { name: v.name, paymentTermsDays: v.paymentTermsDays, requiresPurchaseAuthorization: v.requiresPurchaseAuthorization },
      submissions: subs.map(s => ({ submissionRef: s.submissionRef, kind: s.kind, submittedAt: s.submittedAt, status: s.status, resultRef: s.resultRef, reviewReason: s.status === "rejected" ? s.reviewReason : null })),
      bills: bills.map(b => ({ billRef: b.billRef, vendorInvoiceNumber: b.vendorInvoiceNumber, invoiceDate: b.invoiceDate, total: fromCents(b.totalCents), stage: stage(b.status), paidAt: b.paymentReleasedAt })),
    };
  }),

  vendorBillSubmit: externalProcedure("portal.vendorBillSubmit")
    .input(z.object({ vendorInvoiceNumber: z.string().min(1).max(80), invoiceDate: z.coerce.date(), subtotal: z.number(), taxAmount: z.number().default(0), total: z.number(), lines: z.array(z.object({ description: z.string().min(1).max(300), quantity: z.number().positive(), unitPrice: z.number() })).min(1).max(200), purchaseAuthorizationRef: z.string().max(64).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const v = (await db.select().from(vendors).where(eq(vendors.id, e.accountId)).limit(1))[0];
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor not found" });
      const existing = (await db.select({ n: vendorBills.vendorInvoiceNumber }).from(vendorBills).where(eq(vendorBills.vendorId, v.id))).map(x => x.n);
      const priorSubs = (await db.select({ payloadJson: portalSubmissions.payloadJson }).from(portalSubmissions).where(and(eq(portalSubmissions.externalIdentityId, e.identityId), eq(portalSubmissions.kind, "vendor_bill"), inArray(portalSubmissions.status, ["submitted", "accepted"])))).map(s => (JSON.parse(s.payloadJson) as { vendorInvoiceNumber: string }).vendorInvoiceNumber);
      const d = intakeVendorBill({ identity: identityOf(e), payload: { ...input, purchaseAuthorizationRef: input.purchaseAuthorizationRef ?? null }, vendorRequiresPurchaseAuthorization: v.requiresPurchaseAuthorization, existingInvoiceNumbers: [...existing, ...priorSubs] });
      if (!d.accepted) throw new TRPCError({ code: "BAD_REQUEST", message: d.refusals.join("; ") });
      const r = await submit(e, "vendor_bill", { ...input, purchaseAuthorizationRef: input.purchaseAuthorizationRef ?? null });
      return { ...r, findings: d.findings };
    }),

  facilityStatement: externalProcedure("portal.facilityStatement").query(async ({ ctx }) => {
    const e = ext(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [subs, tickets] = await Promise.all([
      db.select().from(portalSubmissions).where(eq(portalSubmissions.externalIdentityId, e.identityId)).orderBy(desc(portalSubmissions.submittedAt)).limit(200),
      db.select({ ticketNumber: disposalTickets.ticketNumber, facilityTicketNumber: disposalTickets.facilityTicketNumber, scaleInAt: disposalTickets.scaleInAt, verificationStatus: disposalTickets.verificationStatus }).from(disposalTickets).where(eq(disposalTickets.facilityId, e.accountId)).orderBy(desc(disposalTickets.scaleInAt)).limit(200),
    ]);
    await logAccess(e, "view", "facilityStatement", "account", null, null);
    return { submissions: subs.map(s => ({ submissionRef: s.submissionRef, submittedAt: s.submittedAt, status: s.status, resultRef: s.resultRef })), tickets };
  }),

  disposalTicketSubmit: externalProcedure("portal.disposalTicketSubmit")
    .input(z.object({ facilityTicketNumber: z.string().min(1).max(80), scaleInAt: z.coerce.date(), grossKg: z.number().nonnegative().nullable(), tareKg: z.number().nonnegative().nullable(), netKg: z.number().nonnegative().nullable(), quantity: z.number().nonnegative().nullable().optional(), quantityUnit: z.string().max(20).nullable().optional(), carrierUnitNumber: z.string().max(40).nullable().optional(), loadReference: z.string().max(80).nullable().optional(), scaleRecordHash: z.string().max(64).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const e = ext(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const existing = (await db.select({ n: disposalTickets.facilityTicketNumber }).from(disposalTickets).where(eq(disposalTickets.facilityId, e.accountId))).map(x => x.n).filter((x): x is string => !!x);
      const payload = { ...input, quantity: input.quantity ?? null, quantityUnit: input.quantityUnit ?? null, carrierUnitNumber: input.carrierUnitNumber ?? null, loadReference: input.loadReference ?? null, scaleRecordHash: input.scaleRecordHash ?? null };
      const d = intakeDisposalTicket({ identity: identityOf(e), payload, existingTicketNumbers: existing });
      if (!d.accepted) throw new TRPCError({ code: "BAD_REQUEST", message: d.refusals.join("; ") });
      const r = await submit(e, "disposal_ticket", { ...payload, confidence: d.confidence });
      return { ...r, confidence: d.confidence, findings: d.findings };
    }),
});

const round2 = (n: number) => Math.round(n * 100) / 100;
