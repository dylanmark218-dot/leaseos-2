/**
 * v22.20 (0086) — the real outbox row, and the consumer that turns it into
 * notifications somebody has to acknowledge.
 *
 * Until now the enqueue was a callback the caller supplied and every test
 * pushed into an array. The invariant it was protecting — an order cannot be
 * saved while the office is never told — was therefore proven against a fake.
 * This writes an actual `domainEventOutbox` row inside the confirm transaction,
 * so the guarantee is the database's rather than a promise.
 *
 * Two halves, deliberately apart:
 *
 *   ENQUEUE   runs in the caller's transaction. It must not do anything that
 *             can fail for reasons unrelated to the commit — no push provider,
 *             no HTTP, no template rendering against a remote service.
 *   CONSUME   runs afterwards, separately, and may be retried. It claims
 *             unclaimed events and writes notifications, keyed so that running
 *             it twice tells nobody twice.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx, Tx } from "./dbTypes";
import { createHash } from "node:crypto";
import { domainEventOutbox, workflowNotifications } from "../../drizzle/schema";
import { DEFAULT_CRITICAL_POLICY, type EscalationPolicy } from "./escalation";

export type EnforcementEventPayload = {
  eventRef: string;
  eventType: string;
  severity: "critical" | "urgent" | "routine";
  orderRefs: string[];
  repairRequired: number;
  unitId: number | null;
  operatorId: number | null;
};

const short = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 32);

/**
 * Write the outbox row. Called with the same `tx` as the enforcement commit, so
 * it lives or dies with the order.
 */
export async function enqueueEnforcementEvent(
  tx: Tx,
  args: { tenantId: string; branchId: string | null; actorUserId: number; occurredAt: Date; payload: EnforcementEventPayload },
): Promise<{ eventId: string }> {
  // Derived from the enforcement event, so a retried confirm cannot enqueue twice.
  const eventId = `EVT-${short(`enforcement:${args.payload.eventRef}`).slice(0, 30)}`;
  await tx.insert(domainEventOutbox).values({
    eventId,
    eventType: args.payload.orderRefs.length ? "enforcement.out_of_service.issued" : "enforcement.event.confirmed",
    eventVersion: 1,
    aggregateType: "enforcementEvent",
    aggregateId: args.payload.eventRef,
    tenantId: args.tenantId,
    branchId: args.branchId,
    // varchar, not int — this passed a number until the transaction handle
    // was typed and the compiler said so.
    unitId: args.payload.unitId != null ? String(args.payload.unitId) : null,
    // The schema's own vocabulary: human, not "user".
    actorSource: "human",
    actorUserId: String(args.actorUserId),
    payloadJson: JSON.stringify(args.payload),
    occurredAt: args.occurredAt,
  });
  return { eventId };
}


/**
 * Process an enforcement event that has already been claimed by the shared
 * domain-event drain worker. This is the production path used by the single
 * claim owner; unlike consumeEnforcementEvents it never claims or marks the
 * outbox row itself.
 */
export async function handleClaimedEnforcementEvent(
  db: DbOrTx,
  args: { aggregateId: string; payloadJson: string; tenantId: string; now: Date },
): Promise<{ notificationsWritten: number; alreadyNotified: number }> {
  const payload = JSON.parse(args.payloadJson) as EnforcementEventPayload;
  const policy = DEFAULT_CRITICAL_POLICY;
  const recipients = payload.severity === "routine" ? [] : [...policy.levels[0].roles];
  let notificationsWritten = 0, alreadyNotified = 0;

  for (const role of recipients) {
    const notificationKey = `enf:${args.aggregateId}:${role}`.slice(0, 200);
    const existing = await db.select({ id: workflowNotifications.id }).from(workflowNotifications)
      .where(eq(workflowNotifications.notificationKey, notificationKey)).limit(1);
    if (existing.length) { alreadyNotified++; continue; }
    try {
      await db.insert(workflowNotifications).values({
        notificationKey, taskId: null, workflowNumber: args.aggregateId.slice(0, 40),
        tenantId: args.tenantId, recipientRole: role, recipientUserId: null,
        title: payload.orderRefs.length
          ? `Out of service — ${payload.orderRefs.length} order(s) from ${payload.eventType.replace(/_/g, " ")}`
          : `Enforcement event recorded (${payload.severity})`,
        body: payload.orderRefs.length
          ? `${payload.orderRefs.join(", ")}. The subject cannot move until the order's own release condition is satisfied and somebody releases it.`
          : `${payload.repairRequired} violation(s) require repair.`,
        deepLink: `/enforcement/${args.aggregateId}`,
        channel: "in_app", status: "queued", queuedAt: args.now,
      });
      notificationsWritten++;
    } catch {
      // notificationKey is unique: a racing/replayed worker already wrote it.
      alreadyNotified++;
    }
  }
  return { notificationsWritten, alreadyNotified };
}

export type ConsumeResult = {
  claimed: number;
  notificationsWritten: number;
  alreadyNotified: number;
  events: { eventId: string; aggregateId: string; recipients: string[] }[];
};

/**
 * Claim unconsumed enforcement events and write the level-0 notifications.
 *
 * Idempotent by notification key: the key is the event plus the recipient role,
 * so a consumer that runs twice — or two consumers racing — cannot tell the
 * same person about the same stop twice.
 */
export async function consumeEnforcementEvents(
  db: DbOrTx,
  args: { now: Date; policy?: EscalationPolicy; limit?: number },
): Promise<ConsumeResult> {
  const policy = args.policy ?? DEFAULT_CRITICAL_POLICY;
  const rows = await db.select().from(domainEventOutbox)
    .where(and(eq(domainEventOutbox.aggregateType, "enforcementEvent"), isNull(domainEventOutbox.claimedAt)))
    .limit(args.limit ?? 100);

  const result: ConsumeResult = { claimed: 0, notificationsWritten: 0, alreadyNotified: 0, events: [] };

  for (const row of rows) {
    const payload = JSON.parse(row.payloadJson) as EnforcementEventPayload;
    // Only a prohibition wakes people at level 0; a routine confirmation is a
    // record, not an alarm.
    const recipients = payload.severity === "routine" ? [] : [...policy.levels[0].roles];

    for (const role of recipients) {
      const notificationKey = `enf:${row.aggregateId}:${role}`.slice(0, 200);
      const existing = await db.select({ id: workflowNotifications.id }).from(workflowNotifications)
        .where(eq(workflowNotifications.notificationKey, notificationKey)).limit(1);
      if (existing.length) { result.alreadyNotified++; continue; }
      await db.insert(workflowNotifications).values({
        notificationKey, taskId: null, workflowNumber: row.aggregateId.slice(0, 40),
        tenantId: row.tenantId, recipientRole: role, recipientUserId: null,
        title: payload.orderRefs.length
          ? `Out of service — ${payload.orderRefs.length} order(s) from ${payload.eventType.replace(/_/g, " ")}`
          : `Enforcement event recorded (${payload.severity})`,
        body: payload.orderRefs.length
          ? `${payload.orderRefs.join(", ")}. The subject cannot move until the order's own release condition is satisfied and somebody releases it.`
          : `${payload.repairRequired} violation(s) require repair.`,
        deepLink: `/enforcement/${row.aggregateId}`,
        channel: "in_app", status: "queued", queuedAt: args.now,
      });
      result.notificationsWritten++;
    }

    await db.update(domainEventOutbox).set({ claimedAt: args.now }).where(eq(domainEventOutbox.id, row.id));
    result.claimed++;
    result.events.push({ eventId: row.eventId, aggregateId: row.aggregateId, recipients });
  }
  return result;
}
