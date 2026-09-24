/**
 * 0175 — What a customer does to a ticket, recorded.
 *
 * One entry point for the one-time link (CP6) and the authenticated portal (CP7): acknowledge,
 * approve, dispute, comment, sign. Each action is an append-only `customerTicketActions` row, a
 * ledger entry with the actor and the hashed address, and — for approve, dispute and sign — the
 * billing transition that goes with it, all in one transaction. A page visit is never an action:
 * nothing here is called by a read.
 *
 * Approval and signature carry the hash the customer was shown. If the ticket changed since, the
 * action is refused and the customer is asked to review it again.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customerTicketActions, fieldTickets, signatoryAuthorities } from "../drizzle/schema";
import { and } from "drizzle-orm";
import type { Db } from "./_core/dbTypes";
import { appendCustomerAuditEvent } from "./_core/customerAudit";
import { projectOpenTicket } from "./_core/customerJobView";
import { loadTicket, recordSignature, snapshotFor } from "./closeoutRouter";
import { orgRefForTicket, transitionBilling, type Actor } from "./serviceTicketService";
import { enqueueCustomerEvent } from "./_core/customerEvents";
import type { Authority, PostSiteAuthorization } from "./_core/siteCloseout";

export type CustomerActor = Actor & { kind: "tracking_link" | "portal_identity"; userAgent?: string | null; displayName?: string | null };

/** The ticket, if it is the one the actor may act on: by job (a link) or by account (an identity). "Not found" otherwise. */
export async function ownTicketFor(ticketNumber: string, scope: { jobId?: number; customerAccountId?: number }) {
  let x: Awaited<ReturnType<typeof loadTicket>>;
  try { x = await loadTicket(ticketNumber); } catch { throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this job" }); }
  if (scope.jobId != null && x.t.jobId !== scope.jobId) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this job" });
  if (scope.customerAccountId != null && x.t.customerAccountId !== scope.customerAccountId) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this account" });
  if (x.t.billingState === "VOID") throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket on this job" });
  return x;
}

const ref = () => `CTA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** What the state allows, from the same projection the customer reads. */
function allowed(x: Awaited<ReturnType<typeof loadTicket>>) {
  return projectOpenTicket({ ticket: { ticketNumber: x.t.ticketNumber, billingState: x.t.billingState, billingVersion: x.t.billingVersion, customerPoNumber: x.t.customerPoNumber, completedAt: x.t.completedAt, finalizedAt: x.t.finalizedAt, snapshotHash: null }, lines: [], finalTotalCents: null, invoice: null }).actions;
}

export type ActionInput = {
  db: Db;
  ticketNumber: string;
  scope: { jobId?: number; customerAccountId?: number };
  kind: "acknowledge" | "approve" | "dispute" | "comment";
  actor: CustomerActor;
  representativeName?: string | null;
  representativeTitle?: string | null;
  customerPoNumber?: string | null;
  comment?: string | null;
  /** The hash the customer was shown. Required for approve; compared for dispute when given. */
  snapshotHash?: string | null;
};

export async function recordCustomerAction(i: ActionInput): Promise<{ actionRef: string; kind: ActionInput["kind"]; billingState: string; snapshotHash: string; at: Date }> {
  const x = await ownTicketFor(i.ticketNumber, i.scope);
  const can = allowed(x);
  const current = snapshotFor(x).hash;
  if (i.kind === "approve") {
    if (!can.approve) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This ticket is not awaiting your review (it is ${x.t.billingState.replace(/_/g, " ").toLowerCase()})` });
    if (!i.representativeName?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "An approval names the representative giving it" });
    if (!i.snapshotHash) throw new TRPCError({ code: "BAD_REQUEST", message: "An approval carries the hash of the ticket you reviewed" });
    if (i.snapshotHash !== current) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The ticket changed since you reviewed it — review it again before approving" });
  }
  if (i.kind === "dispute") {
    if (!can.dispute) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This ticket cannot be disputed now (it is ${x.t.billingState.replace(/_/g, " ").toLowerCase()})` });
    if (!i.comment?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "A dispute says what is disputed and why" });
  }
  if (i.kind === "acknowledge" && !can.acknowledge) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This ticket is closed" });
  if (i.kind === "comment") { if (!can.comment) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This ticket is closed" }); if (!i.comment?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "A comment needs text" }); }
  const org = await orgRefForTicket(i.db, x.t.id);
  const at = new Date(); at.setMilliseconds(0);
  const actionRef = ref();
  const eventType = ({ acknowledge: "customer_acknowledgement", approve: "customer_approval", dispute: "customer_dispute", comment: "customer_comment" } as const)[i.kind];
  const result = await i.db.transaction(async tx => {
    const transition = i.kind === "approve" ? await transitionBilling(tx, { ticketId: x.t.id, action: "accept", actor: i.actor, eventType: "customer_approval", payload: { actionRef, representativeName: i.representativeName, customerPoNumber: i.customerPoNumber ?? null, snapshotHash: current, via: i.actor.kind }, refuse: false })
      : i.kind === "dispute" ? await transitionBilling(tx, { ticketId: x.t.id, action: "dispute", actor: i.actor, eventType: "customer_dispute", payload: { actionRef, representativeName: i.representativeName ?? null, comment: i.comment, snapshotHash: i.snapshotHash ?? current, via: i.actor.kind }, refuse: false })
      : null;
    if (i.customerPoNumber !== undefined && i.customerPoNumber !== null && i.customerPoNumber !== x.t.customerPoNumber) await tx.update(fieldTickets).set({ customerPoNumber: i.customerPoNumber }).where(eq(fieldTickets.id, x.t.id));
    await tx.insert(customerTicketActions).values({ actionRef, orgRef: org.orgRef, jobId: org.jobId, fieldTicketId: x.t.id, customerAccountId: x.t.customerAccountId, kind: i.kind, actorKind: i.actor.kind, trackingLinkId: i.actor.trackingLinkId ?? null, externalIdentityId: i.actor.externalIdentityId ?? null, userId: null, representativeName: i.representativeName ?? i.actor.displayName ?? null, representativeTitle: i.representativeTitle ?? null, customerPoNumber: i.customerPoNumber ?? null, comment: i.comment ?? null, snapshotHash: i.snapshotHash ?? current, ipHash: i.actor.ipHash ?? null, userAgent: i.actor.userAgent ?? null, at });
    if (transition?.changed) await enqueueCustomerEvent(tx, { eventType: i.kind === "approve" ? "customer.ticket.approved" : "customer.ticket.disputed", tenantId: org.orgRef, subjectRef: x.t.ticketNumber, occurrence: actionRef, jobId: org.jobId, customerAccountId: x.t.customerAccountId, payload: { actionRef, via: i.actor.kind, representativeName: i.representativeName ?? null } });
    // The transition already put approve / dispute on the ledger; acknowledge and comment get their own entry.
    if (!transition) await appendCustomerAuditEvent(tx, { orgRef: org.orgRef, eventType, subjectType: "fieldTicket", subjectRef: x.t.ticketNumber, jobId: org.jobId, fieldTicketId: x.t.id, trackingLinkId: i.actor.trackingLinkId ?? null, externalIdentityId: i.actor.externalIdentityId ?? null, ipHash: i.actor.ipHash ?? null, occurredAt: at, payload: { actionRef, representativeName: i.representativeName ?? null, comment: i.comment ?? null, snapshotHash: i.snapshotHash ?? current, via: i.actor.kind } });
    return transition;
  });
  return { actionRef, kind: i.kind, billingState: result?.to ?? x.t.billingState, snapshotHash: current, at };
}

export type SignInput = {
  db: Db;
  ticketNumber: string;
  scope: { jobId?: number; customerAccountId?: number };
  actor: CustomerActor;
  signerName: string;
  signerTitle?: string | null;
  authorities: Authority[];
  extraWorkCents?: number;
  postSiteAuthorization?: PostSiteAuthorization | null;
  snapshotHash: string;
  gps?: { latitude: number; longitude: number } | null;
};

/**
 * An electronic signature from a link or an identity, through the canonical signature chain
 * (`recordSignature`, method `portal_link`). Authority is the signatory's on file when the actor is a
 * known contact, else unknown — recorded as exercised and marked, never refused and never assumed.
 */
export async function recordCustomerSignature(i: SignInput) {
  const x = await ownTicketFor(i.ticketNumber, i.scope);
  const auth = i.actor.externalIdentityId != null && x.t.customerAccountId != null
    ? (await i.db.select().from(signatoryAuthorities).where(and(eq(signatoryAuthorities.customerAccountId, x.t.customerAccountId), eq(signatoryAuthorities.externalIdentityId, i.actor.externalIdentityId))).limit(1))[0]
    : undefined;
  return recordSignature({
    ticketNumber: x.t.ticketNumber, signer: { name: i.signerName, company: x.account?.name ?? x.job?.customer ?? "", role: i.signerTitle ?? auth?.signatoryRole ?? null },
    method: "portal_link", requested: i.authorities, extraWorkCents: i.extraWorkCents ?? 0, postSiteAuthorization: i.postSiteAuthorization ?? null, snapshotHash: i.snapshotHash,
    authority: auth ? { signatoryName: auth.signatoryName, mayConfirmWork: auth.mayConfirmWork, maySignTicket: auth.maySignTicket, mayApproveStandby: auth.mayApproveStandby, extraWorkLimitCents: auth.extraWorkLimitCents, mayApproveInvoice: auth.mayApproveInvoice, mayChangeRates: auth.mayChangeRates, validTo: auth.validTo, status: auth.status } : null,
    gps: i.gps ?? null, offline: false, witnessedByOperatorId: null, externalIdentityId: i.actor.externalIdentityId ?? null, paperScanEvidenceRecordId: null, generatedByUserId: null,
    actor: { userId: null, externalIdentityId: i.actor.externalIdentityId ?? null, trackingLinkId: i.actor.trackingLinkId ?? null, ipHash: i.actor.ipHash ?? null },
  });
}
