/**
 * The site sign-off chain — internal.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { renderPdf, sha256Hex, ticketLines, type RevisionDoc } from "./_core/ticketPdf";
import { queueCustomerAlert } from "./customerAlertService";
import { MEASUREMENT_BASIS, normaliseUnit, priceLineAndRecord } from "./_core/linePricing";
import { approvalDecision, decideBillable, termsInEffect, type Terms } from "./_core/contractTerms";
import { storagePut } from "./storage";
import { fieldTicketInScope, getDb, jobInScope, tripInScope, unitInScope } from "./db";
import { assertProfileInScope, financeScopeFor } from "./_core/entityScope";
import { clientAdjustmentInScope, contractTermsInScope, customerAccountInScope, requireTicket, ticketRevisionInScope } from "./financeScope";

/**
 * P0-A3 — the closeout router's one scope: the strict money boundary (F1 + P0-A1). A ticket is in
 * scope through its job (P4.1); a customer account, its terms and its client adjustments through
 * the account's book. An ended membership is refused; a foreign record is not found.
 */
async function actingScopeFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return financeScopeFor(db, userId);
}
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { fieldDevices } from "../drizzle/schema";
import { canonicalSignaturePayload, checkSignatureAttestation } from "./_core/deviceSignature";
import { produceFieldTicketSignature } from "./_core/attest/attestProducers";
import { AttestRefusal } from "./_core/attest/attestService";
import { coreRecordOwnership } from "../drizzle/schema";
import { clientAdjustments, customerAccounts, customerContractTerms, delayEvents, disposalTickets, fieldTicketDocuments, fieldTicketEvents, fieldTicketLines, fieldTicketRevisions, fieldTicketSignatures, fieldTickets, jobs, loads, payrollAdjustments, roadHazardObservations, signatoryAuthorities, tripStops, weatherObservations } from "../drizzle/schema";
import { fieldTicketSignatureVerdict, type SignatureVerdict } from "./_core/fieldTicketSignature";
import { EVENT_CLOCK, canonicalJson, classifyDelay, closeoutState, composeSiteSnapshot, lineDecision, postSiteSupplement, sha256, signatureDecision, whyTheseHours, type Authority, type DelayRules, type EventType, type PostSiteAuthorization, type SiteSnapshot, type Supplement, type TicketEvent, type TicketLine } from "./_core/siteCloseout";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const EVENT_TYPES = Object.keys(EVENT_CLOCK) as [EventType, ...EventType[]];
const AUTHORITIES = z.enum(["work_confirmation", "time_confirmation", "quantity_confirmation", "standby_approval", "change_order_authorization", "invoice_approval"]);
const POST_SITE_AUTH = z.object({ disposalRequired: z.boolean(), travelToDisposal: z.boolean(), disposalWait: z.boolean(), disposalUnload: z.boolean(), returnTravel: z.enum(["yes", "no", "per_contract"]), capRule: z.enum(["none", "per_contract"]), restockingBillable: z.literal(false), postTripBillable: z.literal(false) });

export async function loadTicket(ticketNumber: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const t = (await db.select().from(fieldTickets).where(eq(fieldTickets.ticketNumber, ticketNumber)).limit(1))[0];
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Field ticket not found" });
  const [events, lines, sigs, revisions, job, account] = await Promise.all([
    db.select().from(fieldTicketEvents).where(eq(fieldTicketEvents.fieldTicketId, t.id)).orderBy(asc(fieldTicketEvents.occurredAt)),
    db.select().from(fieldTicketLines).where(eq(fieldTicketLines.fieldTicketId, t.id)).orderBy(asc(fieldTicketLines.id)),
    db.select().from(fieldTicketSignatures).where(eq(fieldTicketSignatures.fieldTicketId, t.id)).orderBy(desc(fieldTicketSignatures.revision)),
    db.select().from(fieldTicketRevisions).where(eq(fieldTicketRevisions.fieldTicketId, t.id)).orderBy(asc(fieldTicketRevisions.revision)),
    t.jobId ? db.select().from(jobs).where(eq(jobs.id, t.jobId)).limit(1).then(r => r[0]) : Promise.resolve(undefined),
    t.customerAccountId ? db.select().from(customerAccounts).where(eq(customerAccounts.id, t.customerAccountId)).limit(1).then(r => r[0]) : Promise.resolve(undefined),
  ]);
  const ev: TicketEvent[] = events.map(e => ({ id: e.id, eventType: (EVENT_TYPES.includes(e.eventType as EventType) ? e.eventType : "other") as EventType, occurredAt: e.occurredAt, endedAt: e.endedAt, customerBillable: e.customerBillable, billableMinutes: e.billableMinutes, billingRuleRef: e.billingRuleRef, source: e.source, confidence: e.confidence, detail: e.detail }));
  const ln: TicketLine[] = lines.map(l => ({ id: l.id, lineKind: l.lineKind, description: l.description, quantity: l.quantity, quantityUnit: l.quantityUnit, measurementMethod: l.measurementMethod, sourceTrackingNumber: l.sourceTrackingNumber, disposition: l.disposition, operatorStatement: l.operatorStatement, customerStatement: l.customerStatement }));
  // v22.2 — the account's approved contract terms in effect on the ticket's date, or null.
  const terms = await termsFor(account?.id ?? null, t.completedAt ?? t.createdAt);
  // SPINE item 2 — whether the signature this ticket needs is established is decided once, from every
  // signature row, every revision and the ticket's own record. `signature` stays the evidence the
  // workflow locks and the documents read; `signatureVerdict` is the answer the decisions read.
  const signatureVerdict = fieldTicketSignatureVerdict({ ticket: t, signatures: sigs, revisions });
  return { db, t, terms, events: ev, lines: ln, signature: sigs[0] ?? null, signatureVerdict, revisions, job, account };
}

/** The workflow's own refusal, unchanged for a ticket with no signature; any other unsatisfied verdict names why. */
export function unsignedMessage(message: string, verdict: SignatureVerdict): string {
  return verdict.state === "unsigned" ? message : `${message} — ${verdict.reason}`;
}

export function snapshotFor(x: Awaited<ReturnType<typeof loadTicket>>) {
  return composeSiteSnapshot({ ticket: { ticketNumber: x.t.ticketNumber, jobId: x.t.jobId, customer: x.account?.name ?? x.job?.customer ?? "unknown", site: x.job?.location ?? null, unitId: x.t.unitId, operatorId: x.t.operatorId }, lines: x.lines, events: x.events, siteWorkCompleteAt: x.t.completedAt, minimum: x.terms?.minimumHours ? { hours: x.terms.minimumHours, ruleRef: `${x.terms.termsRef} v${x.terms.version}${x.terms.clauses.minimum ? ` ${x.terms.clauses.minimum}` : ""}` } : null, postSiteRequired: x.t.postSiteRequired });
}

/** Shared by the internal witness path and the portal's own-signature path. */
export async function recordSignature(args: { ticketNumber: string; signer: { name: string; company: string; role: string | null; phone?: string | null }; method: "drawn" | "device_auth" | "pin" | "paper_scan" | "portal_link"; /**
 * P1.4 (0157) — proof the enrolled device made this signature. Required when the method claims
 * `device_auth`: a method that names a device without proving one is a label, which is what this
 * replaces.
 */
deviceAttestation?: { deviceRef: string; keyFingerprint: string; signatureP1363Base64: string; signedAt: Date } | null; requested: Authority[]; extraWorkCents: number; postSiteAuthorization: PostSiteAuthorization | null; snapshotHash: string; authority: { signatoryName: string; mayConfirmWork: boolean; maySignTicket: boolean; mayApproveStandby: boolean; extraWorkLimitCents: number | null; mayApproveInvoice: boolean; mayChangeRates: boolean; validTo: Date | null; status: "active" | "revoked" } | null; gps: { latitude: number; longitude: number } | null; offline: boolean; witnessedByOperatorId: number | null; externalIdentityId: number | null; paperScanEvidenceRecordId: number | null; generatedByUserId: number | null }) {
  const x = await loadTicket(args.ticketNumber);
  if (x.signature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Ticket already signed (revision ${x.signature.revision}); a later change is a new revision, not a second signature` });
  if (!x.t.completedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Site work has not been marked complete — prepare the ticket first" });
  if (args.method === "paper_scan" && !args.paperScanEvidenceRecordId) throw new TRPCError({ code: "BAD_REQUEST", message: "A paper signature needs the scan in the evidence vault — the original is preserved, OCR never replaces it" });
  const { snapshot, hash, findings } = snapshotFor(x);
  if (snapshot.unclosedSiteEvents) throw new TRPCError({ code: "PRECONDITION_FAILED", message: findings.join("; ") });
  const now = new Date();
  const d = signatureDecision({ requested: args.requested, authority: args.authority, extraWorkCents: args.extraWorkCents, signedAt: now, snapshotHashAtSigning: args.snapshotHash, currentSnapshotHash: hash });
  if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
  if (snapshot.postSiteRequired && !args.postSiteAuthorization) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Post-site work is expected — the consultant signs the billing basis, not a future number" });
  const scope = `Work performed confirmed: ${snapshot.siteBillableHours} h site billable, ${snapshot.loads} load(s), standby ${snapshot.standbyHours} h (${snapshot.standbyBillable}). Exercised: ${d.exercised.join(", ")}.${d.refused.length ? ` Not within authority: ${d.refused.map(r => r.authority).join(", ")}.` : ""}${snapshot.postSiteRequired ? " Post-site: billing basis signed; final time pending." : ""}`;
  /*
   * P1.4 — a device_auth signature must prove the device, and a proof offered under any other
   * method is refused rather than quietly stored. Both directions matter: a claim with no proof is
   * the label this replaced, and a proof filed under `drawn` would put an attestation on a row
   * nobody would think to check.
   */
  if (args.method === "device_auth" && !args.deviceAttestation) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A device_auth signature must carry the device attestation. Without it the method is a label: this row would read exactly like one typed on a laptop." });
  }
  if (args.method !== "device_auth" && args.deviceAttestation) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `A ${args.method} signature carries no device attestation; state the method as device_auth or remove it.` });
  }
  if (args.deviceAttestation) {
    const a = args.deviceAttestation;
    const dev = (await x.db.select().from(fieldDevices).where(eq(fieldDevices.deviceRef, a.deviceRef)).limit(1))[0] ?? null;
    const verdict = checkSignatureAttestation({
      attestation: a, now,
      device: dev ? { deviceRef: dev.deviceRef, keyFingerprint: dev.keyFingerprint ?? "", publicKeySpkiBase64: dev.publicKeySpkiBase64 ?? "", status: dev.status, revokedAt: dev.revokedAt, suspendedAt: dev.suspendedAt } : null,
      // The same payload the device signed: this ticket, this revision, this scope hash, this signer.
      payload: canonicalSignaturePayload({ ticketNumber: x.t.ticketNumber, revision: 1, payloadHash: hash, signerName: args.signer.name, signedAt: a.signedAt }),
    });
    if (!verdict.ok) throw new TRPCError({ code: "FORBIDDEN", message: `${verdict.code}: ${verdict.reason}` });
  }
  const documentRef = `${x.t.ticketNumber}-R1`;
  /*
   * SA1 — the on-spine producer (docs/sign-attest/SIGN_ATTEST_DESIGN.md §11.1). The R1 revision is
   * written first because it is the document the signature is OF; Sign & Attest opens a signing
   * revision on its hash, assigns the consultant, runs the one session and hands back the refs the
   * signature row keeps. All of it commits with the signature and the ticket's state, or none does.
   * The ticket's organization is its job's (else its unit's owner, else the single tenant) — the same
   * answer fieldTicketInScope gives — never taken from the request.
   */
  const orgRef = x.job?.orgRef ?? (x.t.unitId != null
    ? ((await x.db.select({ orgRef: coreRecordOwnership.orgRef }).from(coreRecordOwnership).where(and(eq(coreRecordOwnership.recordType, "unit"), eq(coreRecordOwnership.recordId, x.t.unitId))).limit(1))[0]?.orgRef ?? null)
    : null);
  let produced: Awaited<ReturnType<typeof produceFieldTicketSignature>>;
  try {
    produced = await x.db.transaction(async tx => {
      await tx.insert(fieldTicketRevisions).values({ documentRef, fieldTicketId: x.t.id, revision: 1, kind: "site_signed", snapshotJson: canonicalJson(snapshot), snapshotHash: hash, billableHoursSite: snapshot.siteBillableHours, billableHoursPostSite: null, generatedByUserId: args.generatedByUserId, generatedAt: now });
      const p = await produceFieldTicketSignature(tx, { orgRef, documentRef, signer: { name: args.signer.name, company: args.signer.company, role: args.signer.role }, method: args.method, externalIdentityId: args.externalIdentityId, witnessUserId: args.generatedByUserId, deviceAttestation: args.deviceAttestation ?? null, paperScanEvidenceRecordId: args.paperScanEvidenceRecordId, offline: args.offline, gps: args.gps, now });
      await tx.insert(fieldTicketSignatures).values({ ...{ fieldTicketId: x.t.id, revision: 1, result: d.refused.length ? "partially_accepted" : "accepted", signerName: args.signer.name, signerCompany: args.signer.company, signerRole: args.signer.role, signerPhone: args.signer.phone ?? null, authoritiesExercised: JSON.stringify(d.exercised), withinAuthority: d.withinAuthority, signedScopeStatement: scope, postSiteAuthorizationJson: args.postSiteAuthorization ? JSON.stringify(args.postSiteAuthorization) : null, signatureStorageKey: args.paperScanEvidenceRecordId ? `evidence:${args.paperScanEvidenceRecordId}` : null, signatureMethod: args.method, payloadHash: hash, capturedAt: now, capturedLatitude: args.gps?.latitude ?? null, capturedLongitude: args.gps?.longitude ?? null, capturedOffline: args.offline, witnessedByOperatorId: args.witnessedByOperatorId, deviceRef: args.deviceAttestation?.deviceRef ?? null, deviceKeyFingerprint: args.deviceAttestation?.keyFingerprint ?? null, deviceSignatureBase64: args.deviceAttestation?.signatureP1363Base64 ?? null, deviceSignedAt: args.deviceAttestation?.signedAt ?? null, externalIdentityId: args.externalIdentityId }, attestSessionRef: p.sessionRef });
      await tx.update(fieldTickets).set({ status: "closed", signatureStatus: d.refused.length ? "partially_accepted" : "accepted" }).where(eq(fieldTickets.id, x.t.id));
      return p;
    });
  } catch (e) {
    if (e instanceof AttestRefusal) throw new TRPCError({ code: e.code === "not_found" ? "NOT_FOUND" : e.code === "forbidden" ? "FORBIDDEN" : e.code === "conflict" ? "CONFLICT" : e.code === "bad_request" ? "BAD_REQUEST" : "PRECONDITION_FAILED", message: e.message });
    throw e;
  }
  await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "r1_available", ticketNumber: x.t.ticketNumber, subjectRef: documentRef });
  return { documentRef, revision: 1, snapshotHash: hash, exercised: d.exercised, refused: d.refused, withinAuthority: d.withinAuthority, signedAt: now, attest: { revisionRef: produced.revisionRef, sessionRef: produced.sessionRef, payloadHash: produced.payloadHash } };
}

export async function decideLine(args: { ticketNumber: string; lineId: number; disposition: "accepted" | "disputed"; customerQuantity: number | null; customerStatement: string | null; customerAccountIdMustMatch: number | null }) {
  const x = await loadTicket(args.ticketNumber);
  if (args.customerAccountIdMustMatch != null && x.t.customerAccountId !== args.customerAccountIdMustMatch) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this account" });
  if (!x.signatureVerdict.satisfied) throw new TRPCError({ code: "PRECONDITION_FAILED", message: unsignedMessage("Lines are decided against a signed ticket", x.signatureVerdict) });
  const line = x.lines.find(l => l.id === args.lineId);
  if (!line) throw new TRPCError({ code: "NOT_FOUND", message: "Line not found" });
  const d = lineDecision(line, { disposition: args.disposition, customerQuantity: args.customerQuantity, customerStatement: args.customerStatement });
  if (d.refusal) throw new TRPCError({ code: "BAD_REQUEST", message: d.refusal });
  await x.db.update(fieldTicketLines).set({ disposition: d.line.disposition, customerStatement: d.line.customerStatement }).where(eq(fieldTicketLines.id, line.id));
  return { lineId: line.id, disposition: d.line.disposition, operatorStatement: line.operatorStatement, operatorQuantity: line.quantity, customerStatement: d.line.customerStatement };
}

async function latestSupplement(x: Awaited<ReturnType<typeof loadTicket>>): Promise<Supplement | null> {
  const r = [...x.revisions].reverse().find(r => r.kind === "post_site_supplement");
  return r ? (JSON.parse(r.snapshotJson) as { supplement: Supplement }).supplement : null;
}


/** The approved contract terms in effect for the ticket's account at a date, or null — never assumed. */
async function termsFor(customerAccountId: number | null, at: Date): Promise<Terms | null> {
  const db = await getDb();
  if (!db || customerAccountId == null) return null;
  const rows = await db.select().from(customerContractTerms).where(eq(customerContractTerms.customerAccountId, customerAccountId));
  return termsInEffect(rows.map(r => ({ termsRef: r.termsRef, version: r.version, title: r.title, standbyBillable: r.standbyBillable, standbyFreeMinutes: r.standbyFreeMinutes, customerHoldBillable: r.customerHoldBillable, weatherHoldBillable: r.weatherHoldBillable, travelToDisposalBillable: r.travelToDisposalBillable, disposalQueueBillable: r.disposalQueueBillable, disposalBillable: r.disposalBillable, returnTravelBillable: r.returnTravelBillable, minimumHours: r.minimumHours, clauses: JSON.parse(r.clausesJson) as Record<string, string>, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, status: r.status })), at);
}

export const closeoutRouter = router({
  ticketOpen: roleProcedure("closeout.ticketOpen")
    .input(z.object({ scope: z.enum(["job", "trip", "load", "service_event"]).default("job"), jobId: z.number().int().positive(), tripId: z.number().int().positive().nullable().optional(), customerAccountRef: z.string().max(64).nullable().optional(), unitId: z.number().int().positive().nullable().optional(), operatorId: z.number().int().positive().nullable().optional(), serviceDescription: z.string().max(220).nullable().optional(), afeNumber: z.string().max(80).nullable().optional(), postSiteRequired: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: a ticket opens only on a job or unit in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        if (input.jobId != null && !(await jobInScope(input.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        if (input.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: the account a ticket bills to must be in a book the caller's organization owns — the portal shows a
      // customer identity every ticket on its account, so a foreign account here would hand this ticket to another company's customer.
      const acct = input.customerAccountRef ? await customerAccountInScope(db, await actingScopeFor(ctx.user.id), input.customerAccountRef) : undefined;
      // Configured, transactional sequence (rule §18): FT-<year>-<000001>, format from trackingSequences.
      const ticketNumber = (await nextTrackingNumber(db, { sequenceType: "FT" })).trackingNumber;
      const job = (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1))[0];
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found — a field ticket always belongs to a job" });
      await db.insert(fieldTickets).values({ ticketNumber, scope: input.scope, jobId: input.jobId, tripId: input.tripId ?? null, customerAccountId: acct?.id ?? null, unitId: input.unitId ?? null, operatorId: input.operatorId ?? null, serviceDescription: input.serviceDescription ?? null, afeNumber: input.afeNumber ?? null, postSiteRequired: input.postSiteRequired, status: "draft", signatureStatus: "unsigned", updatedAt: new Date() });
      return { ticketNumber };
    }),

  lineAdd: roleProcedure("closeout.lineAdd")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), lineKind: z.enum(["service", "load", "disposal", "standby", "equipment", "personnel", "mileage", "other"]), serviceCode: z.string().min(1).max(60).optional(), description: z.string().min(1).max(220), quantity: z.number().nullable().optional(), quantityUnit: z.string().max(30).nullable().optional(), measurementMethod: z.enum(["meter", "scale", "loadsense_calibrated", "loadsense_uncalibrated", "gauge", "estimate", "customer_stated", "system_timed", "unknown"]).default("unknown"), sourceTrackingNumber: z.string().max(64).nullable().optional(), operatorStatement: z.string().max(220).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      if (x.signature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ticket is signed — a later addition is a supplement, not an edit" });
      const ins = await x.db.insert(fieldTicketLines).values({ fieldTicketId: x.t.id, lineKind: input.lineKind, serviceCode: input.serviceCode ?? null, description: input.description, quantity: input.quantity ?? null, quantityUnit: input.quantityUnit ?? null, measurementMethod: input.measurementMethod, sourceTrackingNumber: input.sourceTrackingNumber ?? null, disposition: "not_presented", operatorStatement: input.operatorStatement ?? null });
      const lineId = Number(ins[0]?.insertId ?? 0);
      // v22.8 — a line that names its service is priced as it is recorded; the decision is written once and the line carries it. A line still records a fact: an unknown rate never stops it.
      let pricing: { decisionRef: string; outcome: string; amountCents: number | null; reasons: string[] } | { skipped: string } = { skipped: "no service named" };
      if (input.serviceCode) {
        const unit = normaliseUnit(input.quantityUnit);
        if (input.quantity == null || !unit) pricing = { skipped: input.quantity == null ? "no quantity" : `unit "${input.quantityUnit}" is not in the pricing vocabulary` };
        else if (!x.account) pricing = { skipped: "ticket has no customer account" };
        else {
          const r = await priceLineAndRecord({ db: x.db as never, financialEntityId: x.account.financialEntityId, rateKind: "sell", serviceCode: input.serviceCode, at: x.t.startedAt ?? x.t.createdAt, subjectKind: "field_ticket_line", subjectRef: `${x.t.ticketNumber}/L${lineId}`, quantity: input.quantity, unit, measurementSource: MEASUREMENT_BASIS[input.measurementMethod] ?? "manual_entry", decidedByUserId: ctx.user.id, context: { customerAccountId: x.account.id, jobId: x.t.jobId, unitId: x.t.unitId } });
          await x.db.update(fieldTicketLines).set({ pricingDecisionRef: r.decisionRef }).where(eq(fieldTicketLines.id, lineId));
          pricing = { decisionRef: r.decisionRef, outcome: r.outcome.outcome, amountCents: r.outcome.amountCents, reasons: r.outcome.reasons };
        }
      }
      return { lineId, pricing };
    }),

  /** An event on one clock. Standby and post-site kinds are REVIEW until a rule or a signed basis says otherwise. */
  eventRecord: roleProcedure("closeout.eventRecord")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), eventType: z.enum(EVENT_TYPES), occurredAt: z.coerce.date(), endedAt: z.coerce.date().nullable().optional(), source: z.enum(["driver_stated", "gps", "pto", "ticket", "system_inferred", "human_corrected"]).default("driver_stated"), confidence: z.enum(["low", "medium", "high"]).default("medium"), detail: z.string().max(600).nullable().optional(), tripStopId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      const meta = EVENT_CLOCK[input.eventType];
      if (x.signature && meta.phase === "site") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The site is signed — site events are frozen in the signed revision" });
      if (input.endedAt && input.endedAt < input.occurredAt) throw new TRPCError({ code: "BAD_REQUEST", message: "An event cannot end before it starts" });
      let billable = meta.customerBillable;
      if (billable === "review" && meta.phase === "site" && x.account?.delayBillingRulesJson) {
        const rules = JSON.parse(x.account.delayBillingRulesJson) as DelayRules;
        const k = input.eventType === "customer_hold" ? "customer_hold" : input.eventType === "weather_hold" ? "weather" : null;
        if (k) { const c = classifyDelay(k, rules); if (c.classification !== "review_required") billable = c.classification === "billable" ? "yes" : "no"; }
      }
      // v22.1 — a review answer is decided by the account's approved contract terms, when there are any, and cited.
      const durationMinutes = input.endedAt ? Math.round((input.endedAt.getTime() - input.occurredAt.getTime()) / 60_000) : null;
      let decided: { customerBillable: "yes" | "no" | "review"; billableMinutes: number | null; ruleRef: string | null } = { customerBillable: billable, billableMinutes: null, ruleRef: null };
      if (billable === "review") { const d = decideBillable({ eventType: input.eventType, occurredAt: input.occurredAt, durationMinutes, terms: await termsFor(x.t.customerAccountId, input.occurredAt) }); decided = { customerBillable: d.customerBillable, billableMinutes: d.billableMinutes, ruleRef: d.ruleRef }; }
      const ins = await x.db.insert(fieldTicketEvents).values({ fieldTicketId: x.t.id, eventType: input.eventType, clock: meta.clock, customerBillable: decided.customerBillable, billingRuleRef: decided.ruleRef, occurredAt: input.occurredAt, endedAt: input.endedAt ?? null, durationMinutes, billableMinutes: decided.billableMinutes, sourceTripStopId: input.tripStopId ?? null, detail: input.detail ?? null, source: input.source, confidence: input.confidence });
      // v21.14 — the customer's alerts, from the same events: first site work is arrival and work start; a hold is a delay.
      if (input.eventType === "site_work" && !x.events.some(ev => ev.eventType === "site_work")) { await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "arrival", ticketNumber: x.t.ticketNumber }); await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "work_start", ticketNumber: x.t.ticketNumber }); }
      if (input.eventType === "standby" || input.eventType === "customer_hold" || input.eventType === "weather_hold") await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "delay", ticketNumber: x.t.ticketNumber, detail: input.eventType.replace(/_/g, " "), subjectRef: `${x.t.ticketNumber}:${Number(ins[0]?.insertId ?? 0)}` });
      return { eventId: Number(ins[0]?.insertId ?? 0), clock: meta.clock, customerBillable: decided.customerBillable, billingRuleRef: decided.ruleRef };
    }),

  eventClose: roleProcedure("closeout.eventClose")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), eventId: z.number().int().positive(), endedAt: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      const e = x.events.find(v => v.id === input.eventId);
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      if (e.endedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Event already ended — a correction is a new event with source human_corrected" });
      if (input.endedAt < e.occurredAt) throw new TRPCError({ code: "BAD_REQUEST", message: "An event cannot end before it starts" });
      const durationMinutes = Math.round((input.endedAt.getTime() - e.occurredAt.getTime()) / 60_000);
      const redecided = e.billingRuleRef || e.customerBillable === "review" ? decideBillable({ eventType: e.eventType, occurredAt: e.occurredAt, durationMinutes, terms: await termsFor(x.t.customerAccountId, e.occurredAt) }) : null;
      await x.db.update(fieldTicketEvents).set({ endedAt: input.endedAt, durationMinutes, ...(redecided && redecided.ruleRef ? { customerBillable: redecided.customerBillable, billableMinutes: redecided.billableMinutes, billingRuleRef: redecided.ruleRef } : {}) }).where(eq(fieldTicketEvents.id, e.id));
      return { eventId: e.id, endedAt: input.endedAt };
    }),

  /** Observed weather, a road hazard, a hold: contemporaneous evidence, classified by the contract or held at REVIEW. */
  delayRecord: roleProcedure("closeout.delayRecord")
    .input(z.object({ ticketNumber: z.string().max(64).nullable().optional(), jobId: z.number().int().positive().nullable().optional(), tripId: z.number().int().positive().nullable().optional(), unitId: z.number().int().positive().nullable().optional(), kind: z.enum(["customer_hold", "disposal_queue", "weather", "road_hazard", "collision", "driver_break", "breakdown", "other"]), hazardType: z.string().max(60).nullable().optional(), severity: z.enum(["low", "medium", "high"]).default("medium"), observedAt: z.coerce.date(), endedAt: z.coerce.date().nullable().optional(), observedByOperatorId: z.number().int().positive().nullable().optional(), observation: z.string().min(3).max(600), latitude: z.number().nullable().optional(), longitude: z.number().nullable().optional(), externalSourceStatus: z.enum(["available", "unavailable", "not_checked"]).default("not_checked"), externalSourceNote: z.string().max(300).nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: whatever the delay is attached to — ticket, job, trip, unit — must be the caller's organization's.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.ticketNumber) await requireTicket(scope, input.ticketNumber);
      if (input.jobId != null && !(await jobInScope(input.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      if (input.tripId != null && !(await tripInScope(input.tripId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Trip ${input.tripId} not found` });
      if (input.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      const x = input.ticketNumber ? await loadTicket(input.ticketNumber) : null;
      const rules = x?.account?.delayBillingRulesJson ? (JSON.parse(x.account.delayBillingRulesJson) as DelayRules) : null;
      const c = classifyDelay(input.kind, rules);
      const delayRef = (await nextTrackingNumber(db, { sequenceType: "DLY" })).trackingNumber;
      await db.insert(delayEvents).values({ delayRef, jobId: input.jobId ?? x?.t.jobId ?? null, tripId: input.tripId ?? x?.t.tripId ?? null, unitId: input.unitId ?? x?.t.unitId ?? null, fieldTicketId: x?.t.id ?? null, kind: input.kind, hazardType: input.hazardType ?? null, severity: input.severity, observedAt: input.observedAt, endedAt: input.endedAt ?? null, observedByOperatorId: input.observedByOperatorId ?? null, observation: input.observation, latitude: input.latitude ?? null, longitude: input.longitude ?? null, externalSourceStatus: input.externalSourceStatus, externalSourceNote: input.externalSourceNote ?? null, billingClassification: c.classification, classificationRuleRef: c.ruleRef, broadcast: input.kind === "road_hazard", evidenceRecordId: input.evidenceRecordId ?? null });
      return { delayRef, billingClassification: c.classification, ruleRef: c.ruleRef, broadcast: input.kind === "road_hazard" };
    }),

  authoritySet: roleProcedure("closeout.authoritySet")
    .input(z.object({ customerAccountRef: z.string().min(1).max(64), signatoryName: z.string().min(1).max(180), signatoryRole: z.string().max(120).nullable().optional(), externalIdentityRef: z.string().max(64).nullable().optional(), mayConfirmWork: z.boolean().default(true), maySignTicket: z.boolean().default(true), mayApproveStandby: z.boolean().default(false), extraWorkLimitCents: z.number().int().nonnegative().nullable().optional(), mayApproveInvoice: z.boolean().default(false), mayChangeRates: z.boolean().default(false), mayAcceptQuotes: z.boolean().default(false), mayAnswerRfis: z.boolean().default(true), validTo: z.coerce.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: the account must be in a book the caller's organization owns; a foreign one is "Customer account not found".
      const acct = await customerAccountInScope(db, await actingScopeFor(ctx.user.id), input.customerAccountRef);
      let externalIdentityId: number | null = null;
      if (input.externalIdentityRef) { const { externalIdentities } = await import("../drizzle/schema"); const ei = (await db.select({ id: externalIdentities.id, customerAccountId: externalIdentities.customerAccountId }).from(externalIdentities).where(eq(externalIdentities.identityRef, input.externalIdentityRef)).limit(1))[0]; if (!ei || ei.customerAccountId !== acct.id) throw new TRPCError({ code: "BAD_REQUEST", message: "External identity is not this account's" }); externalIdentityId = ei.id; }
      const authorityRef = (await nextTrackingNumber(db, { sequenceType: "SIG" })).trackingNumber;
      await db.insert(signatoryAuthorities).values({ authorityRef, customerAccountId: acct.id, signatoryName: input.signatoryName, signatoryRole: input.signatoryRole ?? null, externalIdentityId, mayConfirmWork: input.mayConfirmWork, maySignTicket: input.maySignTicket, mayApproveStandby: input.mayApproveStandby, extraWorkLimitCents: input.extraWorkLimitCents ?? null, mayApproveInvoice: input.mayApproveInvoice, mayChangeRates: input.mayChangeRates, mayAcceptQuotes: input.mayAcceptQuotes, mayAnswerRfis: input.mayAnswerRfis, validTo: input.validTo ?? null, recordedByUserId: ctx.user.id });
      return { authorityRef };
    }),

  /** Site work complete: the snapshot the consultant will review, and its hash. Nothing is frozen yet. */
  sitePrepare: roleProcedure("closeout.sitePrepare")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), siteWorkCompleteAt: z.coerce.date(), postSiteRequired: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      if (x.signature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ticket is signed" });
      await x.db.update(fieldTickets).set({ completedAt: input.siteWorkCompleteAt, status: "presented", ...(input.postSiteRequired != null ? { postSiteRequired: input.postSiteRequired } : {}), updatedAt: new Date() }).where(eq(fieldTickets.id, x.t.id));
      const y = await loadTicket(input.ticketNumber);
      const { snapshot, hash, findings } = snapshotFor(y);
      await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "signoff_ready", ticketNumber: x.t.ticketNumber, subjectRef: `${x.t.ticketNumber}:${hash.slice(0, 12)}` });
      return { snapshot, snapshotHash: hash, findings };
    }),

  /** The operator or office witnesses the consultant's signature — drawn on the tablet, or a paper scan in the vault. */
  siteSign: roleProcedure("closeout.siteSign")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), snapshotHash: z.string().length(64), signer: z.object({ name: z.string().min(1).max(180), company: z.string().min(1).max(180), role: z.string().max(120).nullable().optional(), phone: z.string().max(60).nullable().optional() }), method: z.enum(["drawn", "paper_scan", "pin"]), paperScanEvidenceRecordId: z.number().int().positive().nullable().optional(), authorities: z.array(AUTHORITIES).min(1), extraWorkCents: z.number().int().nonnegative().default(0), postSiteAuthorization: POST_SITE_AUTH.nullable().optional(), gps: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional(), offline: z.boolean().default(false), witnessedByOperatorId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      const auth = x.t.customerAccountId ? (await x.db.select().from(signatoryAuthorities).where(and(eq(signatoryAuthorities.customerAccountId, x.t.customerAccountId), eq(signatoryAuthorities.signatoryName, input.signer.name))).orderBy(desc(signatoryAuthorities.id)).limit(1))[0] : undefined;
      return recordSignature({ ticketNumber: input.ticketNumber, signer: { name: input.signer.name, company: input.signer.company, role: input.signer.role ?? null, phone: input.signer.phone ?? null }, method: input.method, requested: input.authorities, extraWorkCents: input.extraWorkCents, postSiteAuthorization: input.postSiteAuthorization ?? null, snapshotHash: input.snapshotHash, authority: auth ? { signatoryName: auth.signatoryName, mayConfirmWork: auth.mayConfirmWork, maySignTicket: auth.maySignTicket, mayApproveStandby: auth.mayApproveStandby, extraWorkLimitCents: auth.extraWorkLimitCents, mayApproveInvoice: auth.mayApproveInvoice, mayChangeRates: auth.mayChangeRates, validTo: auth.validTo, status: auth.status } : null, gps: input.gps ?? null, offline: input.offline, witnessedByOperatorId: input.witnessedByOperatorId ?? null, externalIdentityId: null, paperScanEvidenceRecordId: input.paperScanEvidenceRecordId ?? null, generatedByUserId: ctx.user.id });
    }),

  /** The office records the customer's per-line position from a paper ticket. Both sides stay. */
  lineDecide: roleProcedure("closeout.lineDecide")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), lineId: z.number().int().positive(), disposition: z.enum(["accepted", "disputed"]), customerQuantity: z.number().nullable().optional(), customerStatement: z.string().max(220).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P0-A3: the ticket must be the caller's organization's before a line on it is decided.
      await requireTicket(await actingScopeFor(ctx.user.id), input.ticketNumber);
      return decideLine({ ticketNumber: input.ticketNumber, lineId: input.lineId, disposition: input.disposition, customerQuantity: input.customerQuantity ?? null, customerStatement: input.customerStatement ?? null, customerAccountIdMustMatch: null });
    }),

  /** Stage 2: what happened after the lease, under what was signed, with the disposal ticket and GPS beside each other. */
  supplementPrepare: roleProcedure("closeout.supplementPrepare")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), disposalTicketNumber: z.string().max(64).nullable().optional(), facilityTripStopId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      if (!x.signature || !x.signatureVerdict.satisfied) throw new TRPCError({ code: "PRECONDITION_FAILED", message: unsignedMessage("A supplement follows a signed site ticket", x.signatureVerdict) });
      if (!x.t.completedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Site work completion is not recorded" });
      const authorization = x.signature.postSiteAuthorizationJson ? (JSON.parse(x.signature.postSiteAuthorizationJson) as PostSiteAuthorization) : null;
      const dt = input.disposalTicketNumber ? (await x.db.select().from(disposalTickets).where(eq(disposalTickets.ticketNumber, input.disposalTicketNumber)).limit(1))[0] : undefined;
      const stop = input.facilityTripStopId ? (await x.db.select().from(tripStops).where(eq(tripStops.id, input.facilityTripStopId)).limit(1))[0] : undefined;
      // v22.2 — approved terms decide return travel where the signatory wrote "per contract"; the v21.11 JSON placeholder is the fallback.
      const contract = x.terms ? { returnTravel: x.terms.returnTravelBillable } : x.account?.postSiteBillingRuleJson ? (JSON.parse(x.account.postSiteBillingRuleJson) as { returnTravel?: "yes" | "no" }) : null;
      const supplement = postSiteSupplement({ authorization, events: x.events, siteWorkCompleteAt: x.t.completedAt, disposalTicket: dt ? { receivedAt: dt.scaleInAt, releasedAt: null, ticketNumber: dt.ticketNumber } : null, gpsFacilityArrivalAt: stop?.arrivedAt ?? null, contractReturnTravel: contract?.returnTravel ?? null });
      const prior = [...x.revisions].reverse().find(r => r.kind === "post_site_supplement");
      const revision = (x.revisions[x.revisions.length - 1]?.revision ?? 1) + 1;
      const documentRef = `${x.t.ticketNumber}-R${revision}`;
      const body = { supplement, siteRevisionHash: x.signature.payloadHash, disposalTicketNumber: dt?.ticketNumber ?? null };
      await x.db.insert(fieldTicketRevisions).values({ documentRef, fieldTicketId: x.t.id, revision, kind: "post_site_supplement", snapshotJson: canonicalJson(body), snapshotHash: sha256(canonicalJson(body)), billableHoursSite: (JSON.parse(x.revisions[0]!.snapshotJson) as SiteSnapshot).siteBillableHours, billableHoursPostSite: supplement.postSiteBillableHours, supersedesRevisionId: prior?.id ?? null, generatedByUserId: ctx.user.id, generatedAt: new Date() });
      await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "r2_available", ticketNumber: x.t.ticketNumber, subjectRef: documentRef });
      return { documentRef, revision, ...supplement };
    }),

  state: roleProcedure("closeout.state")
    .input(z.object({ ticketNumber: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      const supplement = await latestSupplement(x);
      const loads = x.lines.filter(l => l.lineKind === "load").length;
      const withEvidence = x.lines.filter(l => l.lineKind === "load" && l.sourceTrackingNumber).length;
      return { ticketNumber: x.t.ticketNumber, ...closeoutState({ events: x.events, lines: x.lines, siteWorkCompleteAt: x.t.completedAt, signature: x.signatureVerdict, supplement, postSiteRequired: x.t.postSiteRequired, loadsWithDisposalEvidence: withEvidence, loads }), revisions: x.revisions.map(r => ({ documentRef: r.documentRef, revision: r.revision, kind: r.kind, snapshotHash: r.snapshotHash, generatedAt: r.generatedAt })) };
    }),

  whyTheseHours: roleProcedure("closeout.whyTheseHours")
    .input(z.object({ ticketNumber: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      const snap = x.revisions[0] ? (JSON.parse(x.revisions[0].snapshotJson) as SiteSnapshot) : snapshotFor(x).snapshot;
      return whyTheseHours(snap, x.signature?.signerName ?? null, await latestSupplement(x));
    }),

  /* ---- v21.12 ---- */

  /**
   * Render a frozen revision to a PDF. The source is the persisted snapshot
   * and its hash — never the live ticket. Same revision, same bytes; a
   * second render returns the record that exists and writes nothing.
   */
  documentRender: roleProcedure("closeout.documentRender")
    .input(z.object({ documentRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: a revision is its ticket's, and the ticket must be the caller's organization's.
      const { rev } = await ticketRevisionInScope(db, await actingScopeFor(ctx.user.id), input.documentRef);
      const kind = rev.kind === "site_signed" ? "site_ticket_r1" as const : "post_site_ticket" as const;
      const existing = (await db.select().from(fieldTicketDocuments).where(and(eq(fieldTicketDocuments.revisionId, rev.id), eq(fieldTicketDocuments.kind, kind))).limit(1))[0];
      if (existing) return { documentRef: existing.documentRef, contentHash: existing.contentHash, byteLength: existing.byteLength, alreadyRendered: true as const };
      const t = (await db.select().from(fieldTickets).where(eq(fieldTickets.id, rev.fieldTicketId)).limit(1))[0]!;
      const x = await loadTicket(t.ticketNumber);
      const r1 = x.revisions.find(r => r.revision === 1) ?? x.revisions[0]!;
      const snap = JSON.parse(r1.snapshotJson) as SiteSnapshot;
      const body = rev.kind === "site_signed" ? null : JSON.parse(rev.snapshotJson) as { supplement: Supplement };
      const adj = await db.select().from(clientAdjustments).where(and(eq(clientAdjustments.fieldTicketId, t.id), eq(clientAdjustments.status, "authorized")));
      const comments = x.lines.filter(l => l.customerStatement).map(l => `Line ${l.id}: ${l.customerStatement}`);
      const generatedAt = new Date();
      const doc: RevisionDoc = {
        ticketNumber: t.ticketNumber, revision: rev.revision, kind: rev.kind, snapshotHash: rev.snapshotHash, generatedAt,
        signatory: x.signature ? { name: x.signature.signerName ?? "unknown", company: x.signature.signerCompany ?? "", exercised: JSON.parse(x.signature.authoritiesExercised ?? "[]") as string[], withinAuthority: x.signature.withinAuthority, signedAt: x.signature.capturedAt } : null,
        postSiteAuthorization: x.signature?.postSiteAuthorizationJson ? JSON.parse(x.signature.postSiteAuthorizationJson) as Record<string, unknown> : null,
        customerComments: comments,
        supplement: body ? { rows: body.supplement.included.map(i => ({ window: `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`, what: i.eventType, hours: i.hours, evidence: i.evidence })), excluded: body.supplement.excluded.map(e => ({ what: e.eventType, reason: e.reason })) } : null,
        adjustments: adj.filter(a => a.revisionId == null || a.revisionId <= rev.id).map(a => ({ kind: a.kind, amountCents: a.amountCents, hourEquivalentMinutes: a.hourEquivalentMinutes, reason: a.reason })),
      };
      const bytes = renderPdf(`LeaseOS Field Ticket ${t.ticketNumber} — R${rev.revision}`, ticketLines(snap, doc));
      const contentHash = sha256Hex(bytes);
      const stored = await storagePut(`tickets/${t.ticketNumber}/R${rev.revision}-${contentHash.slice(0, 12)}.pdf`, bytes, "application/pdf");
      const documentRef = `${rev.documentRef}-PDF`;
      await db.insert(fieldTicketDocuments).values({ documentRef, fieldTicketId: t.id, revisionId: rev.id, kind, storageKey: stored.key, contentHash, sourceSnapshotHash: rev.snapshotHash, byteLength: bytes.length, generatedByUserId: ctx.user.id, generatedAt });
      await queueCustomerAlert({ customerAccountId: t.customerAccountId, kind: "document_ready", ticketNumber: t.ticketNumber, subjectRef: documentRef });
      return { documentRef, contentHash, byteLength: bytes.length, alreadyRendered: false as const };
    }),

  /** A worker-intended client bonus becomes a payroll adjustment REQUEST for a named profile — proposed, not applied. The customer never wrote this. */
  adjustmentPayrollPropose: roleProcedure("closeout.adjustmentPayrollPropose")
    .input(z.object({ adjustmentRef: z.string().min(1).max(64), employeePayrollProfileId: z.number().int().positive(), amountCents: z.number().int().positive(), note: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: the client adjustment is its account's (book), and the payroll profile it is proposed for is a book's too.
      const scope = await actingScopeFor(ctx.user.id);
      const a = await clientAdjustmentInScope(db, scope, input.adjustmentRef);
      await assertProfileInScope(db, input.employeePayrollProfileId, scope);
      if (a.payrollTreatment !== "proposed" && a.payrollTreatment !== "awaiting_recipient") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Adjustment is ${a.payrollTreatment} for payroll — it was not intended for workers` });
      if (input.amountCents > a.amountCents) throw new TRPCError({ code: "BAD_REQUEST", message: `Proposal ${input.amountCents} exceeds the client's ${a.amountCents}` });
      const adjustmentRef = `PADJ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.insert(payrollAdjustments).values({ adjustmentRef, employeePayrollProfileId: input.employeePayrollProfileId, reason: `Client ${a.kind.replace(/_/g, " ")} ${a.adjustmentRef}: ${input.note} — tax treatment to be decided by payroll`, amount: input.amountCents / 100, requestedByUserId: ctx.user.id, requestedAt: new Date(), status: "requested" });
      await db.update(clientAdjustments).set({ payrollTreatment: "decided", payrollAdjustmentRef: adjustmentRef }).where(eq(clientAdjustments.id, a.id));
      return { payrollAdjustmentRef: adjustmentRef, status: "requested" as const };
    }),

  weatherObserve: roleProcedure("closeout.weatherObserve")
    .input(z.object({ ticketNumber: z.string().max(64).optional(), jobId: z.number().int().positive().optional(), unitId: z.number().int().positive().optional(), observedAt: z.coerce.date(), observerType: z.enum(["worker", "supervisor", "external_source"]), externalSourceName: z.string().max(120).optional(), conditions: z.array(z.string().min(1).max(40)).min(1).max(12), visibility: z.enum(["good", "reduced", "poor", "nil", "unknown"]).default("unknown"), roadState: z.enum(["dry", "wet", "snow", "ice", "mud", "flooded", "unknown"]).default("unknown"), severity: z.enum(["minor", "moderate", "severe"]), operationalEffect: z.string().max(400).optional(), gps: z.object({ latitude: z.number(), longitude: z.number() }).optional(), evidenceRecordId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: whichever anchor the observation names must be in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        if (input.ticketNumber && !(await fieldTicketInScope(input.ticketNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
        if (input.jobId != null && !(await jobInScope(input.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        if (input.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (input.observerType === "external_source" && !input.externalSourceName) throw new TRPCError({ code: "BAD_REQUEST", message: "An external source must be named — it is never recorded as a worker's observation" });
      const t = input.ticketNumber ? (await db.select({ id: fieldTickets.id, jobId: fieldTickets.jobId }).from(fieldTickets).where(eq(fieldTickets.ticketNumber, input.ticketNumber)).limit(1))[0] : undefined;
      if (input.ticketNumber && !t) throw new TRPCError({ code: "NOT_FOUND", message: "Ticket not found" });
      const observationRef = `WX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.insert(weatherObservations).values({ observationRef, jobId: input.jobId ?? t?.jobId ?? null, unitId: input.unitId ?? null, fieldTicketId: t?.id ?? null, observedAt: input.observedAt, observerType: input.observerType, observerUserId: input.observerType === "external_source" ? null : ctx.user.id, externalSourceName: input.externalSourceName ?? null, conditionsJson: JSON.stringify(input.conditions), visibility: input.visibility, roadState: input.roadState, severity: input.severity, operationalEffect: input.operationalEffect ?? null, latitude: input.gps?.latitude ?? null, longitude: input.gps?.longitude ?? null, evidenceRecordId: input.evidenceRecordId ?? null });
      return { observationRef, billingTreatment: "review" as const };
    }),

  roadHazardReport: roleProcedure("closeout.roadHazardReport")
    .input(z.object({ ticketNumber: z.string().max(64).optional(), jobId: z.number().int().positive().optional(), unitId: z.number().int().positive().optional(), observedAt: z.coerce.date(), hazard: z.enum(["snow_ice", "mud", "flooding", "washout", "poor_visibility", "high_wind", "construction", "road_closure", "restricted_access", "soft_road", "steep_grade", "chain_up", "traffic", "collision_ahead", "wildlife", "bridge_restriction", "lease_road_damage", "locked_gate", "customer_traffic_control", "other"]), severity: z.enum(["minor", "moderate", "severe"]), direction: z.string().max(40).optional(), routeRef: z.string().max(120).optional(), description: z.string().max(600).optional(), gps: z.object({ latitude: z.number(), longitude: z.number() }).optional(), evidenceRecordId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: whichever anchor the observation names must be in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        if (input.ticketNumber && !(await fieldTicketInScope(input.ticketNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
        if (input.jobId != null && !(await jobInScope(input.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        if (input.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const t = input.ticketNumber ? (await db.select({ id: fieldTickets.id, jobId: fieldTickets.jobId }).from(fieldTickets).where(eq(fieldTickets.ticketNumber, input.ticketNumber)).limit(1))[0] : undefined;
      if (input.ticketNumber && !t) throw new TRPCError({ code: "NOT_FOUND", message: "Ticket not found" });
      const observationRef = `RH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.insert(roadHazardObservations).values({ observationRef, jobId: input.jobId ?? t?.jobId ?? null, unitId: input.unitId ?? null, fieldTicketId: t?.id ?? null, observedAt: input.observedAt, reportedByUserId: ctx.user.id, hazard: input.hazard, severity: input.severity, direction: input.direction ?? null, routeRef: input.routeRef ?? null, description: input.description ?? null, latitude: input.gps?.latitude ?? null, longitude: input.gps?.longitude ?? null, evidenceRecordId: input.evidenceRecordId ?? null });
      return { observationRef, billingTreatment: "review" as const };
    }),


  /* ---- v22.1: contract terms ---- */

  /** Terms per account, versioned. Recorded as a draft; approved by another person against the contract document. */
  termsRecord: roleProcedure("closeout.termsRecord")
    .input(z.object({ customerAccountRef: z.string().min(1).max(64), title: z.string().min(1).max(160), standbyBillable: z.enum(["yes", "no"]), standbyFreeMinutes: z.number().int().nonnegative().max(600).default(0), customerHoldBillable: z.enum(["yes", "no"]), weatherHoldBillable: z.enum(["yes", "no"]), travelToDisposalBillable: z.enum(["yes", "no"]), disposalQueueBillable: z.enum(["yes", "no"]), disposalBillable: z.enum(["yes", "no"]), returnTravelBillable: z.enum(["yes", "no"]), minimumHours: z.number().positive().max(24).nullable().optional(), clauses: z.record(z.string(), z.string().max(40)).default({}), effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional(), sourceDocumentEvidenceId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: terms are recorded against an account in a book the caller's organization owns.
      const acct = await customerAccountInScope(db, await actingScopeFor(ctx.user.id), input.customerAccountRef);
      const prior = (await db.select({ id: customerContractTerms.id, version: customerContractTerms.version }).from(customerContractTerms).where(eq(customerContractTerms.customerAccountId, acct.id)).orderBy(desc(customerContractTerms.version)).limit(1))[0];
      const termsRef = `TERMS-${input.customerAccountRef.slice(0, 20)}`;
      const version = (prior?.version ?? 0) + 1;
      await db.insert(customerContractTerms).values({ termsRef: `${termsRef}-${version}`, customerAccountId: acct.id, version, title: input.title, standbyBillable: input.standbyBillable, standbyFreeMinutes: input.standbyFreeMinutes, customerHoldBillable: input.customerHoldBillable, weatherHoldBillable: input.weatherHoldBillable, travelToDisposalBillable: input.travelToDisposalBillable, disposalQueueBillable: input.disposalQueueBillable, disposalBillable: input.disposalBillable, returnTravelBillable: input.returnTravelBillable, minimumHours: input.minimumHours ?? null, clausesJson: JSON.stringify(input.clauses), effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, sourceDocumentEvidenceId: input.sourceDocumentEvidenceId ?? null, recordedByUserId: ctx.user.id, supersedesTermsId: prior?.id ?? null });
      return { termsRef: `${termsRef}-${version}`, version, status: "draft" as const };
    }),

  termsApprove: roleProcedure("closeout.termsApprove")
    .input(z.object({ termsRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // P0-A3: the terms are their account's, and the account's book must be the caller's.
      const t = await contractTermsInScope(db, await actingScopeFor(ctx.user.id), input.termsRef);
      const d = approvalDecision({ recordedByUserId: t.recordedByUserId, approverUserId: ctx.user.id, status: t.status, sourceDocumentEvidenceId: t.sourceDocumentEvidenceId });
      if (!d.permitted) throw new TRPCError({ code: d.refusals.some(r => r.includes("may not approve")) ? "FORBIDDEN" : "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.update(customerContractTerms).set({ status: "approved", approvedByUserId: ctx.user.id, approvedAt: new Date() }).where(eq(customerContractTerms.id, t.id));
      if (t.supersedesTermsId) await db.update(customerContractTerms).set({ status: "superseded" }).where(eq(customerContractTerms.id, t.supersedesTermsId));
      return { termsRef: t.termsRef, status: "approved" as const };
    }),

  /** Re-decide the open REVIEW answers on a ticket now that terms exist. Decided answers and signed snapshots are not touched. */
  termsApply: roleProcedure("closeout.termsApply")
    .input(z.object({ ticketNumber: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const x = await loadTicket(input.ticketNumber);
      if (x.signature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The ticket is signed — its snapshot stands; a supplement carries later decisions" });
      let decided = 0; const results: { eventId: number; customerBillable: string; ruleRef: string | null }[] = [];
      for (const e of x.events) {
        if (e.customerBillable !== "review") continue;
        const d = decideBillable({ eventType: e.eventType, occurredAt: e.occurredAt, durationMinutes: e.endedAt ? Math.round((e.endedAt.getTime() - e.occurredAt.getTime()) / 60_000) : null, terms: await termsFor(x.t.customerAccountId, e.occurredAt) });
        if (!d.ruleRef) continue;
        await x.db.update(fieldTicketEvents).set({ customerBillable: d.customerBillable, billableMinutes: d.billableMinutes, billingRuleRef: d.ruleRef }).where(eq(fieldTicketEvents.id, e.id));
        decided++; results.push({ eventId: e.id, customerBillable: d.customerBillable, ruleRef: d.ruleRef });
      }
      return { ticketNumber: x.t.ticketNumber, decided, stillReview: x.events.filter(e => e.customerBillable === "review").length - decided, results };
    }),

  /**
   * v21.14 — The job completion package: one PDF over the ticket's frozen
   * revisions, the loads and their tickets, the signature, the adjustments
   * and the documents already rendered — each named with its hash. Rendered
   * once per ticket state; a re-render after new records is a new document.
   */
  completionPackageRender: roleProcedure("closeout.completionPackageRender")
    .input(z.object({ ticketNumber: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the ticket must be in the caller's scope (through its job, else its unit); otherwise it does not exist here.
      if (!(await fieldTicketInScope(input.ticketNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${input.ticketNumber} not found` });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const x = await loadTicket(input.ticketNumber);
      if (!x.signature || !x.signatureVerdict.satisfied) throw new TRPCError({ code: "PRECONDITION_FAILED", message: unsignedMessage("A completion package needs a signed ticket", x.signatureVerdict) });
      const latest = [...x.revisions].sort((a, b) => b.revision - a.revision)[0]!;
      const [docs, adj, jobLoads] = await Promise.all([
        db.select().from(fieldTicketDocuments).where(eq(fieldTicketDocuments.fieldTicketId, x.t.id)),
        db.select().from(clientAdjustments).where(and(eq(clientAdjustments.fieldTicketId, x.t.id), eq(clientAdjustments.status, "authorized"))),
        x.t.jobId ? db.select().from(loads).where(eq(loads.jobId, x.t.jobId)) : Promise.resolve([] as never[]),
      ]);
      const tickets = jobLoads.length ? await db.select().from(disposalTickets).where(inArray(disposalTickets.loadId, jobLoads.map(l => l.id))) : [];
      const existing = docs.find(d => d.kind === "completion_package" && d.revisionId === latest.id);
      if (existing) return { documentRef: existing.documentRef, contentHash: existing.contentHash, alreadyRendered: true as const };
      const snap = JSON.parse(x.revisions[0]!.snapshotJson) as SiteSnapshot;
      const generatedAt = new Date();
      const L: string[] = [
        `Job completion package — ticket ${x.t.ticketNumber}   customer ${snap.customer}   site ${snap.site ?? "-"}`,
        `Generated ${generatedAt.toISOString()}   latest revision R${latest.revision} (${latest.kind}) ${latest.snapshotHash}`,
        "", "REVISIONS", "---------",
        ...x.revisions.map(r => `R${r.revision}  ${r.kind.padEnd(22)} ${r.snapshotHash}  ${r.generatedAt.toISOString()}${r.supersedesRevisionId ? "  (supersedes an earlier revision; that revision stands)" : ""}`),
        "", "SIGNATURE", "---------",
        `${x.signature.signerName ?? "unknown"}, ${x.signature.signerCompany ?? ""}   ${x.signature.capturedAt.toISOString()}   authority ${JSON.parse(x.signature.authoritiesExercised ?? "[]").join(", ") || "-"} (${x.signature.withinAuthority})   method ${x.signature.signatureMethod}`,
        "", "LOADS AND DISPOSAL", "------------------",
        ...(jobLoads.length ? jobLoads.map(l => { const dt = tickets.find(t => t.loadId === l.id); return `${l.loadNumber.padEnd(22)} ${(l.material ?? "unspecified").padEnd(18)} ${l.quantity ?? "-"} ${l.quantityUnit ?? ""}  [${l.measurementMethod ?? "method unknown"}]  ${dt ? `ticket ${dt.facilityTicketNumber ?? dt.ticketNumber} — ${dt.verificationStatus} (${dt.confidence})` : "no disposal ticket on file"}`; }) : ["(no loads on this job)"]),
        "", "CLIENT ADJUSTMENTS", "------------------",
        ...(adj.length ? adj.map(a => `${a.kind.padEnd(26)} $${(a.amountCents / 100).toFixed(2).padStart(10)}${a.hourEquivalentMinutes ? `  ${(a.hourEquivalentMinutes / 60).toFixed(2)} h-equivalent — billing value, not worked time` : ""}  ${a.reason.slice(0, 40)}`) : ["(none)"]),
        "", "DOCUMENTS IN THIS PACKAGE", "-------------------------",
        ...(docs.length ? docs.map(d => `${d.kind.padEnd(20)} ${d.documentRef.padEnd(30)} sha256 ${d.contentHash}`) : ["(no rendered documents yet)"]),
        "", "NOT INCLUDED", "------------",
        "Post-trip inspection, restocking, washout, fuelling and internal paperwork: the contractor's clock, never billed.",
      ];
      const bytes = renderPdf(`LeaseOS Job Completion Package — ${x.t.ticketNumber}`, L);
      const contentHash = sha256Hex(bytes);
      const stored = await storagePut(`tickets/${x.t.ticketNumber}/package-${contentHash.slice(0, 12)}.pdf`, bytes, "application/pdf");
      const documentRef = `${x.t.ticketNumber}-PKG-${contentHash.slice(0, 8).toUpperCase()}`;
      await db.insert(fieldTicketDocuments).values({ documentRef, fieldTicketId: x.t.id, revisionId: latest.id, kind: "completion_package", storageKey: stored.key, contentHash, sourceSnapshotHash: latest.snapshotHash, byteLength: bytes.length, generatedByUserId: ctx.user.id, generatedAt });
      await queueCustomerAlert({ customerAccountId: x.t.customerAccountId, kind: "job_complete", ticketNumber: x.t.ticketNumber, subjectRef: documentRef });
      return { documentRef, contentHash, alreadyRendered: false as const };
    }),
});
