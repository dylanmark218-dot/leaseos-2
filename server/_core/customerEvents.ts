/**
 * 0175 — Customer-facing domain events on the existing outbox.
 *
 * Delivery is never in the transaction. What the transaction does is append one `domainEventOutbox`
 * row beside the domain write (the `enqueueEnforcementEvent` pattern); the production worker drains
 * it, the workflow rules and webhook subscriptions consume it, and an email / SMS channel joins later
 * by subscribing rather than by editing a router. The in-app alert (`queueCustomerAlert`) stays what
 * it is: a notification row keyed once per identity per subject.
 *
 * The event id is derived from the subject, so a retried commit cannot enqueue the same event twice.
 */
import { createHash } from "node:crypto";
import { domainEventOutbox } from "../../drizzle/schema";
import type { Tx } from "./dbTypes";

export const CUSTOMER_EVENT_TYPES = [
  "customer.tracking_link.created",
  "customer.tracking_link.revoked",
  "customer.job.dispatched",
  "customer.job.en_route",
  "customer.job.on_location",
  "customer.load.completed",
  "customer.disposal.completed",
  "customer.document.released",
  "customer.ticket.ready_for_review",
  "customer.ticket.approved",
  "customer.ticket.disputed",
  "customer.ticket.finalized",
  "customer.invoice.issued",
  "customer.job.completed",
] as const;
export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number];

export type CustomerEventInput = {
  eventType: CustomerEventType;
  /** The organization the event belongs to — the job's, from server-owned context. */
  tenantId: string;
  /** What the event is about: a link ref, a ticket number, a job code, a release ref, an invoice number. */
  subjectRef: string;
  jobId?: number | null;
  customerAccountId?: number | null;
  actorUserId?: number | null;
  /** A discriminator when one subject can raise the same event more than once (a re-present, a second release). */
  occurrence?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
};

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 30);

/** Append the event inside the caller's transaction. Idempotent per (type, subject, occurrence). */
export async function enqueueCustomerEvent(tx: Tx, i: CustomerEventInput): Promise<{ eventId: string; duplicate: boolean }> {
  const eventId = `EVT-${short(`customer:${i.eventType}:${i.subjectRef}:${i.occurrence ?? ""}`)}`;
  try {
    await tx.insert(domainEventOutbox).values({
      eventId, eventType: i.eventType, eventVersion: 1, aggregateType: "customerJob", aggregateId: i.subjectRef.slice(0, 64),
      tenantId: i.tenantId, jobId: i.jobId != null ? String(i.jobId) : null,
      actorSource: i.actorUserId != null ? "human" : "system", actorUserId: i.actorUserId != null ? String(i.actorUserId) : null,
      payloadJson: JSON.stringify({ subjectRef: i.subjectRef, customerAccountId: i.customerAccountId ?? null, ...(i.payload ?? {}) }),
      occurredAt: i.occurredAt ?? new Date(),
    });
    return { eventId, duplicate: false };
  } catch (e) {
    // The unique event id is the idempotency guard: a retried commit finds its own row and moves on.
    if (String((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? "") === "ER_DUP_ENTRY") return { eventId, duplicate: true };
    throw e;
  }
}
