/**
 * Domain event emission.
 *
 * One rule, and it is the whole reason the outbox exists:
 *
 *     The state change and its event commit together, or neither does.
 *
 * So `emitDomainEvent` takes the caller's transaction. It never opens its own
 * and never fires after a commit — an event published outside the transaction
 * that produced it is an event that can be lost, or worse, one that describes
 * a state that rolled back.
 *
 * Domain services call this. Routers do not write to the outbox directly.
 */

export type EmitActor = {
  userId?: string | null;
  operatorId?: string | null;
  role?: string | null;
  source: "human" | "system" | "ai" | "integration";
};

export type EmitInput<TPayload = Record<string, unknown>> = {
  type: string;
  version?: number;
  actor: EmitActor;
  subject: { entityType: string; entityId: string };
  tenantId: string;
  branchId?: string | null;
  jobId?: string | null;
  tripId?: string | null;
  unitId?: string | null;
  /** Shared across an entire operational chain. */
  correlationId?: string | null;
  /** The event that caused this one. */
  causationId?: string | null;
  payload: TPayload;
  occurredAt?: Date;
};

export type OutboxRow = {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  branchId: string | null;
  jobId: string | null;
  tripId: string | null;
  unitId: string | null;
  correlationId: string;
  causationId: string | null;
  actorSource: EmitActor["source"];
  actorUserId: string | null;
  payloadJson: string;
  occurredAt: Date;
};

let counter = 0;
export function newEventId(now: Date = new Date()): string {
  counter = (counter + 1) % 1_000_000;
  return `EVT-${now.getTime().toString(36)}-${counter.toString(36).padStart(4, "0")}`;
}

/**
 * Build the row to insert. Pure, so the shape can be tested without a
 * database; `emitDomainEvent` below is the thin transactional wrapper.
 *
 * A missing correlationId starts a new chain rooted at this event, so every
 * event belongs to exactly one chain and "why did this happen?" is always
 * answerable by walking causation backwards.
 */
export function buildOutboxRow(
  input: EmitInput,
  now: Date = new Date()
): OutboxRow {
  const eventId = newEventId(now);
  return {
    eventId,
    eventType: input.type,
    eventVersion: input.version ?? 1,
    aggregateType: input.subject.entityType,
    aggregateId: input.subject.entityId,
    tenantId: input.tenantId,
    branchId: input.branchId ?? null,
    jobId: input.jobId ?? null,
    tripId: input.tripId ?? null,
    unitId: input.unitId ?? null,
    correlationId: input.correlationId ?? eventId,
    causationId: input.causationId ?? null,
    actorSource: input.actor.source,
    actorUserId: input.actor.userId ?? null,
    payloadJson: JSON.stringify(input.payload),
    occurredAt: input.occurredAt ?? now,
  };
}

/** Minimal surface so this works with a drizzle tx or a raw connection. */
export type TxLike = {
  execute: (sql: string, params: unknown[]) => Promise<unknown>;
};

const INSERT_SQL = `
  INSERT INTO domainEventOutbox
    (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, branchId,
     jobId, tripId, unitId, correlationId, causationId, actorSource, actorUserId,
     payloadJson, occurredAt)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Emit inside the caller's transaction. If the insert fails the whole
 * transaction fails, which is the point.
 */
export async function emitDomainEvent(
  tx: TxLike,
  input: EmitInput,
  now: Date = new Date()
): Promise<OutboxRow> {
  const row = buildOutboxRow(input, now);
  await tx.execute(INSERT_SQL, [
    row.eventId,
    row.eventType,
    row.eventVersion,
    row.aggregateType,
    row.aggregateId,
    row.tenantId,
    row.branchId,
    row.jobId,
    row.tripId,
    row.unitId,
    row.correlationId,
    row.causationId,
    row.actorSource,
    row.actorUserId,
    row.payloadJson,
    row.occurredAt,
  ]);
  return row;
}

/* ===================== loop protection ===================== */

export type StateChange<T = unknown> = { previous: T; next: T };

/**
 * Only emit when something meaningful actually changed.
 *
 * The loop this prevents: an assignment is re-evaluated → emits "updated" →
 * a rule triggers re-evaluation → emits "updated" → forever. Comparing the
 * fields that matter is cheaper and more honest than trying to detect the
 * cycle after it starts.
 */
export function isMeaningfulChange<T extends Record<string, unknown>>(
  change: StateChange<T>,
  significantFields: Array<keyof T>
): boolean {
  return significantFields.some(f => change.previous?.[f] !== change.next?.[f]);
}

export const MAX_CAUSATION_DEPTH = 12;

export type CausationLink = { eventId: string; causationId: string | null };

/**
 * Walk the causation chain back to its root. Beyond MAX_CAUSATION_DEPTH the
 * chain is treated as runaway and reported rather than followed — a cycle in
 * stored data must not become an infinite loop in a worker.
 */
export function traceCausation(
  eventId: string,
  chain: CausationLink[]
): { path: string[]; runaway: boolean } {
  const byId = new Map(chain.map(c => [c.eventId, c]));
  const path: string[] = [];
  const seen = new Set<string>();

  let current: string | null = eventId;
  while (current) {
    if (seen.has(current)) return { path, runaway: true };
    if (path.length >= MAX_CAUSATION_DEPTH) return { path, runaway: true };
    seen.add(current);
    path.push(current);
    current = byId.get(current)?.causationId ?? null;
  }
  return { path, runaway: false };
}

/**
 * Refuse to emit a descendant beyond the depth limit. Cheap insurance against
 * a rule set that accidentally feeds itself.
 */
export function guardCausationDepth(depth: number): {
  allowed: boolean;
  reason?: string;
} {
  if (depth >= MAX_CAUSATION_DEPTH) {
    return {
      allowed: false,
      reason: `Causation depth ${depth} reached the limit of ${MAX_CAUSATION_DEPTH} — refusing to emit a further descendant`,
    };
  }
  return { allowed: true };
}
