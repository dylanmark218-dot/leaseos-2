/**
 * 0182/0183 — the board's and the marketplace's outbox rows, and the consumer that turns them into
 * in-app notifications.
 *
 * Modelled on `enforcementOutbox.ts`, and for the same reason: the invariant "a person was offered
 * work and the office is never told" has to be the database's guarantee, not a callback's. So the
 * enqueue takes the caller's transaction and does nothing that can fail for a reason unrelated to
 * the commit — no push provider, no HTTP, no template against a remote service.
 *
 * Two rules of its own:
 *
 *   NO BODIES. The outbox row is readable by every consumer and every future integration. A
 *   payload carries refs, codes and recipient ids, never the text of a message.
 *
 *   ONE ID PER TRANSITION. The event id is derived from the aggregate and the transition, so a
 *   retried transaction that reaches the same state cannot enqueue the same event twice — the
 *   unique index on `eventId` refuses the second insert and the caller's transaction rolls back with
 *   it, which is the correct outcome for a replay that got past the application's own check.
 *
 * `eventEmitter.emitDomainEvent` is the generic door and is still declared unwired; this helper's
 * shape matches its input so the swap is mechanical when that consolidation is done.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbOrTx, Tx } from "./dbTypes";
import { domainEventOutbox, workflowNotifications } from "../../drizzle/schema";

export type BoardEventType =
  | "work.posted" | "work.offered" | "work.awarded" | "work.cancelled"
  | "message.critical.created" | "message.acknowledged" | "board.member.added";

export type BoardAggregateType = "shiftPost" | "boardMessage" | "messageChannel";

export type BoardEventPayload = {
  /** Who should hear about it in-app. Ids only; the consumer resolves nothing else. */
  recipientUserIds: number[];
  /** What the notification should say. Never a message body. */
  title: string;
  line: string;
  deepLink: string;
  /** Refs and codes for integrations. */
  refs: Record<string, string | number | null>;
};

const short = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 30);

/**
 * Write the outbox row inside the caller's transaction. `transition` names the state change
 * ("published", "offered:OFF-…", "acknowledged:42") so the id is one per transition, not one per
 * aggregate.
 */
export async function enqueueBoardEvent(
  tx: Tx,
  args: {
    eventType: BoardEventType;
    aggregateType: BoardAggregateType;
    aggregateId: string;
    transition: string;
    tenantId: string;
    actorUserId: number;
    occurredAt: Date;
    jobId?: string | null;
    payload: BoardEventPayload;
  },
): Promise<{ eventId: string }> {
  const eventId = `EVT-${short(`board:${args.aggregateType}:${args.aggregateId}:${args.transition}`)}`;
  await tx.insert(domainEventOutbox).values({
    eventId,
    eventType: args.eventType,
    eventVersion: 1,
    aggregateType: args.aggregateType,
    aggregateId: args.aggregateId.slice(0, 64),
    tenantId: args.tenantId,
    branchId: null,
    jobId: args.jobId ?? null,
    actorSource: "human",
    actorUserId: String(args.actorUserId),
    payloadJson: JSON.stringify(args.payload),
    occurredAt: args.occurredAt,
  });
  return { eventId };
}

export const BOARD_AGGREGATE_TYPES: readonly string[] = ["shiftPost", "boardMessage", "messageChannel"];

/**
 * Consume one claimed board event: one in-app notification per recipient, keyed so a worker that
 * runs twice tells nobody twice. The drain worker claims and marks; this only writes.
 */
export async function handleClaimedBoardEvent(
  db: DbOrTx,
  args: { eventId: string; eventType: string; aggregateId: string; payloadJson: string; tenantId: string; now: Date },
): Promise<{ notificationsWritten: number; alreadyNotified: number }> {
  const payload = JSON.parse(args.payloadJson) as BoardEventPayload;
  let notificationsWritten = 0, alreadyNotified = 0;
  for (const userId of Array.from(new Set(payload.recipientUserIds ?? []))) {
    const notificationKey = `board:${args.eventId}:${userId}`.slice(0, 200);
    const existing = await db.select({ id: workflowNotifications.id }).from(workflowNotifications)
      .where(eq(workflowNotifications.notificationKey, notificationKey)).limit(1);
    if (existing.length) { alreadyNotified++; continue; }
    try {
      await db.insert(workflowNotifications).values({
        notificationKey, taskId: null, workflowNumber: args.aggregateId.slice(0, 40),
        tenantId: args.tenantId, recipientRole: null, recipientUserId: userId,
        title: payload.title.slice(0, 220), body: payload.line, deepLink: payload.deepLink.slice(0, 300),
        channel: "in_app", status: "queued", queuedAt: args.now,
      });
      notificationsWritten++;
    } catch {
      // notificationKey is unique: a racing or replayed worker already wrote it.
      alreadyNotified++;
    }
  }
  return { notificationsWritten, alreadyNotified };
}
