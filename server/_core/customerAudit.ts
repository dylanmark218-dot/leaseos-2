/**
 * 0175 — The customer audit ledger.
 *
 * Append-only and hash-chained per organization, in the `academyAuditEvents` shape: each row
 * carries the hash of the previous row and its own hash over its content. Unlike the academy's
 * helper, the chain tail is read under a row lock inside the caller's transaction, so two
 * concurrent appends cannot both claim the same predecessor and fork the chain.
 *
 * Everything the specification lists as auditable goes through `appendCustomerAuditEvent`:
 * link created / viewed / revoked / regenerated / reconfigured, ticket viewed, document viewed
 * or downloaded, comment, acknowledgement, approval, dispute, signature, billing line added or
 * modified, ticket finalized, invoice generated. `verifyCustomerAuditChain` re-walks a chain.
 */
import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { customerAuditEvents } from "../../drizzle/schema";
import type { Db, Tx } from "./dbTypes";

export const CUSTOMER_AUDIT_EVENT_TYPES = [
  "tracking_link_created", "tracking_link_viewed", "tracking_link_revoked", "tracking_link_regenerated", "tracking_link_permissions_changed", "tracking_link_refused",
  "customer_ticket_viewed", "customer_document_viewed", "customer_document_downloaded", "customer_document_released", "customer_document_withdrawn",
  "customer_comment", "customer_acknowledgement", "customer_approval", "customer_dispute", "customer_signature",
  "billing_line_added", "billing_line_modified", "ticket_presented", "ticket_reopened", "ticket_finalized", "ticket_amended", "ticket_voided", "invoice_generated",
  "job_customer_assigned",
] as const;
export type CustomerAuditEventType = (typeof CUSTOMER_AUDIT_EVENT_TYPES)[number];

export type CustomerAuditInput = {
  orgRef: string;
  eventType: CustomerAuditEventType;
  subjectType: string;
  subjectRef: string;
  jobId?: number | null;
  fieldTicketId?: number | null;
  trackingLinkId?: number | null;
  externalIdentityId?: number | null;
  actorUserId?: number | null;
  ipHash?: string | null;
  payload?: unknown;
  occurredAt?: Date;
};

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** The hash of one event over its content and its predecessor. Pure, so a chain can be re-verified from rows alone. */
export function customerAuditHash(row: { eventRef: string; orgRef: string; eventType: string; subjectType: string; subjectRef: string; eventJson: string; occurredAt: Date; previousHash: string | null; actorUserId: number | null; trackingLinkId: number | null; externalIdentityId: number | null }): string {
  return createHash("sha256").update(canonical({ eventRef: row.eventRef, orgRef: row.orgRef, eventType: row.eventType, subjectType: row.subjectType, subjectRef: row.subjectRef, eventJson: row.eventJson, occurredAt: row.occurredAt.toISOString(), previousHash: row.previousHash, actorUserId: row.actorUserId, trackingLinkId: row.trackingLinkId, externalIdentityId: row.externalIdentityId })).digest("hex");
}

let seq = 0;
const newRef = () => `CAE-${Date.now().toString(36).toUpperCase()}-${(seq++ % 46_655).toString(36).toUpperCase().padStart(3, "0")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/**
 * Append one event inside the caller's transaction. The previous row of this organization's chain
 * is read with `FOR UPDATE`, which serialises appends per organization for the life of the
 * transaction; the caller's own writes therefore commit with their audit row or not at all.
 */
export async function appendCustomerAuditEvent(tx: Tx, input: CustomerAuditInput): Promise<{ eventRef: string; eventHash: string; previousHash: string | null }> {
  const prev = (await tx.select({ eventHash: customerAuditEvents.eventHash }).from(customerAuditEvents).where(eq(customerAuditEvents.orgRef, input.orgRef)).orderBy(desc(customerAuditEvents.id)).limit(1).for("update"))[0];
  const previousHash = prev?.eventHash ?? null;
  const occurredAt = input.occurredAt ?? new Date();
  // Whole seconds: the column is a timestamp, and the hash must survive a round trip through it.
  occurredAt.setMilliseconds(0);
  const eventRef = newRef();
  const eventJson = canonical(input.payload ?? {});
  const row = { eventRef, orgRef: input.orgRef, eventType: input.eventType, subjectType: input.subjectType, subjectRef: input.subjectRef, eventJson, occurredAt, previousHash, actorUserId: input.actorUserId ?? null, trackingLinkId: input.trackingLinkId ?? null, externalIdentityId: input.externalIdentityId ?? null };
  const eventHash = customerAuditHash(row);
  await tx.insert(customerAuditEvents).values({ ...row, jobId: input.jobId ?? null, fieldTicketId: input.fieldTicketId ?? null, ipHash: input.ipHash ?? null, eventHash });
  return { eventRef, eventHash, previousHash };
}

/** Re-walk one organization's chain. Any row whose hash or predecessor disagrees is named. */
export async function verifyCustomerAuditChain(db: Db | Tx, orgRef: string): Promise<{ ok: boolean; rows: number; firstBreak: { eventRef: string; reason: string } | null }> {
  const rows = await db.select().from(customerAuditEvents).where(eq(customerAuditEvents.orgRef, orgRef)).orderBy(sql`${customerAuditEvents.id} asc`);
  let previous: string | null = null;
  for (const r of rows) {
    if (r.previousHash !== previous) return { ok: false, rows: rows.length, firstBreak: { eventRef: r.eventRef, reason: `previousHash ${r.previousHash ?? "null"} does not match the chain tail ${previous ?? "null"}` } };
    const expected = customerAuditHash({ eventRef: r.eventRef, orgRef: r.orgRef, eventType: r.eventType, subjectType: r.subjectType, subjectRef: r.subjectRef, eventJson: r.eventJson, occurredAt: r.occurredAt, previousHash: r.previousHash, actorUserId: r.actorUserId, trackingLinkId: r.trackingLinkId, externalIdentityId: r.externalIdentityId });
    if (expected !== r.eventHash) return { ok: false, rows: rows.length, firstBreak: { eventRef: r.eventRef, reason: "eventHash does not match the row's content" } };
    previous = r.eventHash;
  }
  return { ok: true, rows: rows.length, firstBreak: null };
}
