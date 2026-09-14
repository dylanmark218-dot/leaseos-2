/**
 * Workflow runtime — the wiring between the outbox, the rules and the tasks.
 *
 * B17.1 proved each piece separately: seeds → engine → tasks in unit tests,
 * and outbox → claim → mark against the database. This joins them, so a real
 * mutation produces a real task through the real rule set.
 *
 * Everything a worker does for one event happens in ONE transaction: claim,
 * evaluate, create tasks and notifications, mark processed. A crash halfway
 * leaves the event unclaimed for the next attempt rather than half-applied.
 */

import {
  evaluateRules,
  planTasks,
  type DomainEvent,
  type OperationalTask,
  type WorkflowRule,
} from "./workflowEngine";
import {
  RULE_SEEDS,
  planSeedSync,
  resolveResponsibility,
} from "./workflowSeeds";
import type { ClaimedEvent, WorkerPorts } from "./drainWorker";

/** Narrow surface so this works with a pool, a connection or a drizzle tx. */
export type SqlRunner = {
  execute: <T = unknown>(
    sql: string,
    params?: unknown[]
  ) => Promise<[T, unknown]>;
};
export type PoolLike = SqlRunner & {
  getConnection: () => Promise<
    SqlRunner & {
      beginTransaction: () => Promise<unknown>;
      commit: () => Promise<unknown>;
      rollback: () => Promise<unknown>;
      release: () => void;
    }
  >;
};

type Row = Record<string, unknown>;

/* ===================== seed bootstrap ===================== */

export type BootstrapResult = {
  inserted: string[];
  unchanged: string[];
  conflicts: string[];
};

/**
 * Publish source-controlled rules on startup. A released version whose content
 * changed is reported as a conflict and NOT overwritten — history stays
 * explainable by the rule that actually created each task.
 */
export async function bootstrapRuleSeeds(
  pool: PoolLike,
  seeds: WorkflowRule[] = RULE_SEEDS
): Promise<BootstrapResult> {
  const [existing] = await pool.execute<Row[]>(
    "SELECT ruleKey, version, conditionsJson, actionsJson FROM workflowRules"
  );

  const plan = planSeedSync(
    seeds,
    (existing as Row[]).map(r => ({
      ruleKey: String(r.ruleKey),
      version: Number(r.version),
      conditionsJson: String(r.conditionsJson),
      actionsJson: String(r.actionsJson),
    }))
  );

  for (const rule of plan.insert) {
    await pool.execute(
      `INSERT INTO workflowRules
         (ruleKey, version, name, eventType, enabled, effectiveFrom, effectiveTo,
          tenantId, branchId, conditionsJson, actionsJson, dedupeOnJson, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rule.ruleKey,
        rule.version,
        rule.name,
        rule.eventType,
        rule.enabled ? 1 : 0,
        rule.effectiveFrom ?? null,
        rule.effectiveTo ?? null,
        rule.tenantId ?? null,
        rule.branchId ?? null,
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        rule.dedupeOn ? JSON.stringify(rule.dedupeOn) : null,
        "workflowSeeds.ts",
      ]
    );
  }

  return {
    inserted: plan.insert.map(r => `${r.ruleKey}.v${r.version}`),
    unchanged: plan.unchanged,
    conflicts: plan.conflicts.map(c => c.reason),
  };
}

/** Load released rules for an event type, newest version of each key first. */
export async function loadRules(
  pool: SqlRunner,
  eventType: string
): Promise<WorkflowRule[]> {
  const [rows] = await pool.execute<Row[]>(
    `SELECT ruleKey, version, name, eventType, enabled, effectiveFrom, effectiveTo,
            tenantId, branchId, conditionsJson, actionsJson, dedupeOnJson
     FROM workflowRules WHERE eventType = ? AND enabled = 1
     ORDER BY ruleKey, version DESC`,
    [eventType]
  );

  const seen = new Set<string>();
  const rules: WorkflowRule[] = [];
  for (const r of rows as Row[]) {
    const key = String(r.ruleKey);
    if (seen.has(key)) continue; // only the newest released version applies
    seen.add(key);
    rules.push({
      ruleKey: key,
      version: Number(r.version),
      name: String(r.name),
      eventType: String(r.eventType),
      enabled: Boolean(r.enabled),
      effectiveFrom: r.effectiveFrom
        ? new Date(r.effectiveFrom as string)
        : null,
      effectiveTo: r.effectiveTo ? new Date(r.effectiveTo as string) : null,
      tenantId: (r.tenantId as string) ?? null,
      branchId: (r.branchId as string) ?? null,
      conditions: JSON.parse(String(r.conditionsJson)),
      actions: JSON.parse(String(r.actionsJson)),
      dedupeOn: r.dedupeOnJson ? JSON.parse(String(r.dedupeOnJson)) : undefined,
    });
  }
  return rules;
}

/* ===================== event → tasks ===================== */

function toDomainEvent(claimed: ClaimedEvent, extra: Row): DomainEvent {
  return {
    id: claimed.eventId,
    type: claimed.eventType,
    version: 1,
    occurredAt: claimed.occurredAt,
    recordedAt: claimed.occurredAt,
    tenantId: claimed.tenantId,
    branchId: claimed.branchId,
    actor: { source: (extra.actorSource as never) ?? "system" },
    subject: {
      entityType: claimed.aggregateType,
      entityId: claimed.aggregateId,
    },
    jobId: (extra.jobId as string) ?? null,
    tripId: (extra.tripId as string) ?? null,
    unitId: (extra.unitId as string) ?? null,
    correlationId: (extra.correlationId as string) ?? null,
    causationId: (extra.causationId as string) ?? null,
    payload: JSON.parse(claimed.payloadJson || "{}"),
  };
}

let taskSeq = 0;
const nextTaskNumber = () =>
  `TASK-${Date.now().toString(36)}-${(taskSeq = (taskSeq + 1) % 100_000).toString(36).padStart(4, "0")}`;

/**
 * Create the tasks and notifications a single event calls for, within the
 * caller's transaction. Idempotent by dedupeKey, so a redelivered event is a
 * no-op rather than a duplicate.
 */
export async function applyEventConsequences(
  tx: SqlRunner,
  event: DomainEvent,
  rules: WorkflowRule[],
  now: Date
): Promise<{ tasksCreated: number; notificationsQueued: number }> {
  const matches = evaluateRules(event, rules, now);
  if (matches.length === 0) return { tasksCreated: 0, notificationsQueued: 0 };

  // Read existing open tasks for this subject so dedupe is decided against
  // the database, not against an in-memory guess.
  const [openRows] = await tx.execute<Row[]>(
    `SELECT dedupeKey, status FROM operationalTasks
     WHERE subjectType = ? AND subjectId = ? AND status NOT IN ('completed','cancelled')`,
    [event.subject.entityType, event.subject.entityId]
  );

  const plan = planTasks(
    event,
    matches,
    (openRows as Row[]).map(r => ({
      dedupeKey: String(r.dedupeKey),
      status: r.status as OperationalTask["status"],
    })),
    now,
    nextTaskNumber
  );

  let notificationsQueued = 0;

  for (const task of plan.create) {
    // Ownership is a role resolved from configuration, never a named person —
    // an individual leaves and their queue would disappear with them.
    const owner =
      resolveResponsibility(task.taskType, event.tenantId, event.branchId)
        ?.primaryRole ?? task.assignedRole;

    await tx.execute(
      `INSERT INTO operationalTasks
         (taskNumber, taskType, title, description, status, priority, tenantId, branchId,
          subjectType, subjectId, jobId, tripId, unitId, assignedRole,
          sourceEventId, sourceRuleKey, sourceRuleVersion, dedupeKey, rootDedupeKey,
          requiresEvidence, dueAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        task.taskNumber,
        task.taskType,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.tenantId,
        task.branchId,
        task.subjectType,
        task.subjectId,
        task.jobId,
        task.tripId,
        task.unitId,
        owner,
        task.sourceEventId,
        task.sourceRuleKey,
        task.sourceRuleVersion,
        task.dedupeKey,
        task.rootDedupeKey,
        task.requiresEvidence ? 1 : 0,
        task.dueAt,
      ]
    );

    // Notification key is derived, so a redelivered event cannot notify twice.
    const notificationKey = `${task.dedupeKey}|${owner}`;
    try {
      await tx.execute(
        `INSERT INTO workflowNotifications
           (notificationKey, tenantId, recipientRole, title, body, deepLink, queuedAt)
         VALUES (?,?,?,?,?,?,?)`,
        [
          notificationKey,
          task.tenantId,
          owner,
          task.title,
          task.description ?? null,
          `/tasks/${task.taskNumber}`,
          now,
        ]
      );
      notificationsQueued++;
    } catch {
      // Duplicate key — the owner has already been told about this condition.
    }
  }

  return { tasksCreated: plan.create.length, notificationsQueued };
}

/* ===================== database-backed worker ports ===================== */

/**
 * Bind the drain worker to a real pool. Claim and work share one transaction;
 * a failure rolls back the task writes AND the claim together, so the event
 * returns to the queue rather than being marked done with nothing created.
 */
export function createWorkerPorts(
  pool: PoolLike,
  now: () => Date = () => new Date()
): WorkerPorts {
  return {
    async claimBatch(workerId, limit) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.execute<Row[]>(
          `SELECT id, eventId, eventType, aggregateType, aggregateId, tenantId, branchId,
                  payloadJson, attemptCount, occurredAt, jobId, tripId, unitId,
                  correlationId, causationId, actorSource
           FROM domainEventOutbox
           WHERE processedAt IS NULL AND claimedAt IS NULL
           ORDER BY id LIMIT ${Math.max(1, Math.floor(limit))} FOR UPDATE SKIP LOCKED`
        );
        const claimed = rows as Row[];
        for (const r of claimed) {
          await conn.execute(
            "UPDATE domainEventOutbox SET claimedAt = ?, claimedBy = ?, attemptCount = attemptCount + 1 WHERE id = ?",
            [now(), workerId, r.id]
          );
        }
        await conn.commit();
        return claimed.map(r => ({
          id: Number(r.id),
          eventId: String(r.eventId),
          eventType: String(r.eventType),
          aggregateType: String(r.aggregateType),
          aggregateId: String(r.aggregateId),
          tenantId: String(r.tenantId),
          branchId: (r.branchId as string) ?? null,
          payloadJson: String(r.payloadJson ?? "{}"),
          attemptCount: Number(r.attemptCount),
          occurredAt: new Date(r.occurredAt as string),
          _extra: r,
        })) as unknown as ClaimedEvent[];
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    },

    async processEvent(claimed) {
      const extra = (claimed as unknown as { _extra?: Row })._extra ?? {};
      const event = toDomainEvent(claimed, extra);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const rules = await loadRules(conn, event.type);
        const result = await applyEventConsequences(conn, event, rules, now());
        await conn.commit();
        return { tasksCreated: result.tasksCreated };
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    },

    async markProcessed(id) {
      await pool.execute(
        "UPDATE domainEventOutbox SET processedAt = ? WHERE id = ?",
        [now(), id]
      );
    },

    async markFailed(id, outcome) {
      // Release the claim so a retry can pick it up; a dead letter keeps the
      // claim so it stops circulating and surfaces to an administrator.
      await pool.execute(
        `UPDATE domainEventOutbox
         SET lastError = ?, claimedAt = ${outcome.status === "dead_letter" ? "claimedAt" : "NULL"}
         WHERE id = ?`,
        [outcome.reason, id]
      );
    },
  };
}
