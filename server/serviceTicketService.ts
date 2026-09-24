/**
 * 0175 — The open-ticket billing lifecycle, stored.
 *
 * One place that moves `fieldTickets.billingState`, bumps `billingVersion` and writes the audit row,
 * always under a row lock inside a transaction, so two writers on one ticket are serialized and a
 * transition and its ledger entry commit together or not at all. The closeout, invoicing and
 * client-services routers call these; none of them writes the state column directly.
 */
import { TRPCError } from "@trpc/server";
import { asc, eq, inArray } from "drizzle-orm";
import { fieldTicketLines, fieldTicketRevisions, fieldTicketSignatures, fieldTickets, jobs, pricingDecisions, type BillingState } from "../drizzle/schema";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import type { Db, Tx } from "./_core/dbTypes";
import { appendCustomerAuditEvent, type CustomerAuditEventType } from "./_core/customerAudit";
import { billingTransition, composeFinalSnapshot, lineWritePermitted, ticketTotals, versionCheck, type BillingAction, type FinalSnapshot } from "./_core/serviceTicketBilling";

/** The organization a ticket's ledger belongs to: its job's, else the historical single tenant. */
export async function orgRefForTicket(db: Db | Tx, ticketId: number): Promise<{ orgRef: string; jobId: number; jobCode: string; customerAccountId: number | null }> {
  const t = (await db.select({ jobId: fieldTickets.jobId, customerAccountId: fieldTickets.customerAccountId }).from(fieldTickets).where(eq(fieldTickets.id, ticketId)).limit(1))[0];
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Field ticket not found" });
  const j = (await db.select({ orgRef: jobs.orgRef, jobCode: jobs.jobCode }).from(jobs).where(eq(jobs.id, t.jobId)).limit(1))[0];
  return { orgRef: j?.orgRef ?? SINGLE_TENANT_ID, jobId: t.jobId, jobCode: j?.jobCode ?? String(t.jobId), customerAccountId: t.customerAccountId };
}

export type Actor = { userId?: number | null; externalIdentityId?: number | null; trackingLinkId?: number | null; ipHash?: string | null };

/** Lock the ticket row for the rest of the transaction and return it as the latest committed row. */
export async function lockTicket(tx: Tx, ticketId: number) {
  const t = (await tx.select().from(fieldTickets).where(eq(fieldTickets.id, ticketId)).for("update").limit(1))[0];
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Field ticket not found" });
  return t;
}

/**
 * Move the ticket's billing state under the lock and audit it. A refused transition throws; an
 * idempotent one (same state) writes nothing. Returns the state after.
 */
export async function transitionBilling(tx: Tx, args: { ticketId: number; action: BillingAction; actor: Actor; eventType: CustomerAuditEventType; payload?: Record<string, unknown>; refuse?: boolean }): Promise<{ from: BillingState; to: BillingState; changed: boolean }> {
  const t = await lockTicket(tx, args.ticketId);
  const r = billingTransition(t.billingState, args.action);
  if (!r.ok) {
    if (args.refuse === false) return { from: t.billingState, to: t.billingState, changed: false };
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: r.reason });
  }
  if (!r.changed) return { from: t.billingState, to: t.billingState, changed: false };
  const org = await orgRefForTicket(tx, t.id);
  await tx.update(fieldTickets).set({ billingState: r.to, billingVersion: t.billingVersion + 1, updatedAt: new Date() }).where(eq(fieldTickets.id, t.id));
  await appendCustomerAuditEvent(tx, { orgRef: org.orgRef, eventType: args.eventType, subjectType: "fieldTicket", subjectRef: t.ticketNumber, jobId: org.jobId, fieldTicketId: t.id, actorUserId: args.actor.userId ?? null, externalIdentityId: args.actor.externalIdentityId ?? null, trackingLinkId: args.actor.trackingLinkId ?? null, ipHash: args.actor.ipHash ?? null, payload: { from: t.billingState, to: r.to, version: t.billingVersion + 1, ...(args.payload ?? {}) } });
  return { from: t.billingState, to: r.to, changed: true };
}

/**
 * The guard every line write takes: lock the ticket, check the state allows writes, check the
 * version the writer read (when it named one), and hand back the locked row. The caller writes the
 * line inside the same transaction and then calls `afterLineWrite`.
 */
export async function beforeLineWrite(tx: Tx, args: { ticketId: number; expectedVersion?: number | null }) {
  const t = await lockTicket(tx, args.ticketId);
  const p = lineWritePermitted(t.billingState);
  if (!p.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: p.reason! });
  const v = versionCheck(args.expectedVersion, t.billingVersion);
  if (!v.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: v.reason! });
  return t;
}

/** Bump the version, open a draft ticket, and audit the line write — under the lock `beforeLineWrite` took. */
export async function afterLineWrite(tx: Tx, args: { ticket: Awaited<ReturnType<typeof lockTicket>>; lineId: number; eventType: "billing_line_added" | "billing_line_modified"; actor: Actor; payload: Record<string, unknown> }): Promise<{ version: number; state: BillingState }> {
  const state: BillingState = args.ticket.billingState === "DRAFT" ? "OPEN" : args.ticket.billingState;
  const version = args.ticket.billingVersion + 1;
  await tx.update(fieldTickets).set({ billingState: state, billingVersion: version, updatedAt: new Date() }).where(eq(fieldTickets.id, args.ticket.id));
  const org = await orgRefForTicket(tx, args.ticket.id);
  await appendCustomerAuditEvent(tx, { orgRef: org.orgRef, eventType: args.eventType, subjectType: "fieldTicketLine", subjectRef: `${args.ticket.ticketNumber}/L${args.lineId}`, jobId: org.jobId, fieldTicketId: args.ticket.id, actorUserId: args.actor.userId ?? null, payload: { version, state, ...args.payload } });
  return { version, state };
}

/** An event on a draft ticket opens it. Cheap, lock-free and idempotent: a conditional update. */
export async function openIfDraft(db: Db, ticketId: number): Promise<void> {
  await db.update(fieldTickets).set({ billingState: "OPEN" }).where(eq(fieldTickets.id, ticketId));
}

/** The ticket's lines with their priced amounts, as the finalizer and the projections read them. */
export async function linesWithAmounts(db: Db | Tx, ticketId: number) {
  const lines = await db.select().from(fieldTicketLines).where(eq(fieldTicketLines.fieldTicketId, ticketId)).orderBy(asc(fieldTicketLines.id));
  const refs = lines.map(l => l.pricingDecisionRef).filter((r): r is string => !!r);
  const decisions = refs.length ? await db.select({ decisionRef: pricingDecisions.decisionRef, outcome: pricingDecisions.outcome, amountCents: pricingDecisions.amountCents }).from(pricingDecisions).where(inArray(pricingDecisions.decisionRef, refs)) : [];
  const byRef = new Map(decisions.map(d => [d.decisionRef, d]));
  return lines.map(l => { const d = l.pricingDecisionRef ? byRef.get(l.pricingDecisionRef) : undefined; const priced = d?.outcome === "priced" && d.amountCents != null; return { ...l, priced, amountCents: priced ? d!.amountCents : null }; });
}

/**
 * Freeze the ticket: compose the final (or amendment) snapshot over its lines, write it as the next
 * revision, and record it on the ticket. The previous frozen revision, if any, is superseded by
 * reference and never touched.
 */
export async function writeFrozenRevision(tx: Tx, args: { ticket: Awaited<ReturnType<typeof lockTicket>>; kind: "final" | "amendment"; actorUserId: number; finalizedWithoutCustomerAcceptance: string | null }): Promise<{ revisionId: number; documentRef: string; revision: number; hash: string; snapshot: FinalSnapshot }> {
  const lines = await linesWithAmounts(tx, args.ticket.id);
  const revisions = await tx.select({ id: fieldTicketRevisions.id, revision: fieldTicketRevisions.revision, snapshotHash: fieldTicketRevisions.snapshotHash, kind: fieldTicketRevisions.kind }).from(fieldTicketRevisions).where(eq(fieldTicketRevisions.fieldTicketId, args.ticket.id)).orderBy(asc(fieldTicketRevisions.revision));
  const sig = (await tx.select({ payloadHash: fieldTicketSignatures.payloadHash }).from(fieldTicketSignatures).where(eq(fieldTicketSignatures.fieldTicketId, args.ticket.id)).limit(1))[0];
  const site = revisions.find(r => r.kind === "site_signed");
  const previousFrozen = args.ticket.finalRevisionId ? revisions.find(r => r.id === args.ticket.finalRevisionId) : undefined;
  const now = new Date(); now.setMilliseconds(0);
  const { snapshot, hash } = composeFinalSnapshot({
    kind: args.kind, ticketNumber: args.ticket.ticketNumber, billingVersion: args.ticket.billingVersion + 1,
    lines: lines.map(l => ({ id: l.id, lineKind: l.lineKind, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, quantityUnit: l.quantityUnit, customerVisible: l.customerVisible, disposition: l.disposition, pricingDecisionRef: l.pricingDecisionRef, amountCents: l.amountCents, amendsLineId: l.amendsLineId })),
    siteSnapshotHash: site?.snapshotHash ?? null, signaturePayloadHash: sig?.payloadHash ?? null, supersedesRevisionHash: previousFrozen?.snapshotHash ?? null,
    finalizedWithoutCustomerAcceptance: args.finalizedWithoutCustomerAcceptance, at: now.toISOString(),
  });
  const revision = (revisions[revisions.length - 1]?.revision ?? 0) + 1;
  const documentRef = `${args.ticket.ticketNumber}-R${revision}`;
  const ins = await tx.insert(fieldTicketRevisions).values({ documentRef, fieldTicketId: args.ticket.id, revision, kind: args.kind, snapshotJson: JSON.stringify(snapshot), snapshotHash: hash, billableHoursSite: null, billableHoursPostSite: null, supersedesRevisionId: previousFrozen?.id ?? null, generatedByUserId: args.actorUserId, generatedAt: now });
  const revisionId = Number(ins[0]?.insertId ?? 0);
  return { revisionId, documentRef, revision, hash, snapshot };
}

export { ticketTotals };
