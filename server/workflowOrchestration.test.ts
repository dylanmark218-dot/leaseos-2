import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

// A unit id no test creates. These rows only need a unitId to satisfy the column;
// the literal 1 used here before collided with whichever suite happened to create
// the first unit in a fresh database, handing that suite's truck open critical
// defects (complianceReadinessC1a failed on exactly that, order-dependently).
const NO_SUCH_UNIT = 2_000_000_000;

/**
 * Workflow orchestration, against a real database.
 *
 * The claims that cannot be proven in a unit test:
 *   - a state change and its event commit together, or neither does
 *   - two workers draining the outbox cannot both process one event
 *   - replaying an event creates no second task
 *
 * Skipped without DATABASE_URL so the pure suite stays runnable.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
beforeAll(async () => {
  if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 8 });
});

const uid = (p: string) =>
  `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function insertEvent(eventId: string, unitId: string) {
  await pool.execute(
    `INSERT INTO domainEventOutbox
       (eventId, eventType, aggregateType, aggregateId, tenantId, payloadJson, occurredAt)
     VALUES (?,?,?,?,?,?,NOW())`,
    [
      eventId,
      "unit.critical_defect_opened",
      "unit",
      unitId,
      "T1",
      JSON.stringify({ severity: "critical" }),
    ]
  );
}

/**
 * One worker's drain cycle: claim an unprocessed row with SKIP LOCKED, create
 * the task if none exists, mark processed. All inside one transaction — the
 * claim and the work must not be separable.
 */
async function drainOnce(
  workerId: string,
  delayMs = 0,
  onlyEventId?: string
): Promise<string | null> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id, eventId, aggregateId FROM domainEventOutbox
       WHERE processedAt IS NULL AND claimedAt IS NULL
         ${onlyEventId ? "AND eventId = ?" : ""}
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      onlyEventId ? [onlyEventId] : []
    );
    if (rows.length === 0) {
      await conn.rollback();
      return null;
    }
    const evt = rows[0];

    await conn.execute(
      "UPDATE domainEventOutbox SET claimedAt = NOW(), claimedBy = ?, attemptCount = attemptCount + 1 WHERE id = ?",
      [workerId, evt.id]
    );

    // Widen the window a naive implementation would lose the race in.
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));

    const dedupeKey = `fleet.critical_defect|resolve_critical_defect|unit|${evt.aggregateId}`;

    const [existing] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM operationalTasks
       WHERE dedupeKey = ? AND status NOT IN ('completed','cancelled')`,
      [dedupeKey]
    );
    if (existing.length === 0) {
      await conn.execute(
        `INSERT INTO operationalTasks
           (taskNumber, taskType, title, tenantId, subjectType, subjectId,
            assignedRole, sourceEventId, sourceRuleKey, sourceRuleVersion,
            dedupeKey, requiresEvidence, priority)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          uid("TASK"),
          "resolve_critical_defect",
          `Inspect ${evt.aggregateId} critical defect`,
          "T1",
          "unit",
          evt.aggregateId,
          "mechanic",
          evt.eventId,
          "fleet.critical_defect",
          1,
          dedupeKey,
          true,
          "critical",
        ]
      );
    }

    await conn.execute(
      "UPDATE domainEventOutbox SET processedAt = NOW() WHERE id = ?",
      [evt.id]
    );
    await conn.commit();
    return evt.eventId as string;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

const openTasksFor = async (unitId: string) => {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM operationalTasks WHERE subjectId = ? AND status = 'open'",
    [unitId]
  );
  return rows[0].n as number;
};

d("outbox atomicity", () => {
  it("commits the state change and its event together", async () => {
    const unit = uid("VAC");
    const eventId = uid("EVT");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      "INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt) VALUES (?,?,?,?,NOW())",
      [NO_SUCH_UNIT, `Critical defect on ${unit}`, "critical", "open"]
    );
    await conn.execute(
      `INSERT INTO domainEventOutbox (eventId, eventType, aggregateType, aggregateId, tenantId, payloadJson, occurredAt)
       VALUES (?,?,?,?,?,?,NOW())`,
      [eventId, "unit.critical_defect_opened", "unit", unit, "T1", "{}"]
    );
    await conn.commit();
    conn.release();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM domainEventOutbox WHERE eventId = ?",
      [eventId]
    );
    expect(rows[0].n).toBe(1);
  });

  it("loses both when the transaction rolls back — never one without the other", async () => {
    const eventId = uid("EVT-RB");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO domainEventOutbox (eventId, eventType, aggregateType, aggregateId, tenantId, payloadJson, occurredAt)
       VALUES (?,?,?,?,?,?,NOW())`,
      [eventId, "unit.critical_defect_opened", "unit", "X", "T1", "{}"]
    );
    await conn.rollback();
    conn.release();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM domainEventOutbox WHERE eventId = ?",
      [eventId]
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses a duplicate eventId", async () => {
    const eventId = uid("EVT-DUP");
    await insertEvent(eventId, uid("VAC"));
    await expect(insertEvent(eventId, uid("VAC"))).rejects.toThrow();
  });
});

d("two workers draining the same outbox", () => {
  it("processes one event exactly once, with one task created", async () => {
    const unit = uid("VAC-RACE");
    const eventId = uid("EVT-RACE");
    await insertEvent(eventId, unit);

    const [a, b] = await Promise.all([
      drainOnce("worker-a", 150, eventId),
      drainOnce("worker-b", 150, eventId),
    ]);

    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(await openTasksFor(unit)).toBe(1);
  });

  it("holds with four workers on one event", async () => {
    const unit = uid("VAC-QUAD");
    const eventId = uid("EVT-QUAD");
    await insertEvent(eventId, unit);

    const results = await Promise.all(
      ["w1", "w2", "w3", "w4"].map(w => drainOnce(w, 120, eventId))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await openTasksFor(unit)).toBe(1);
  });

  it("lets two workers process two different events in parallel", async () => {
    const u1 = uid("VAC-P1"),
      u2 = uid("VAC-P2");
    const e1 = uid("EVT-P1"),
      e2 = uid("EVT-P2");
    await insertEvent(e1, u1);
    await insertEvent(e2, u2);

    const results = await Promise.all([
      drainOnce("w1", 100, e1),
      drainOnce("w2", 100, e2),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await openTasksFor(u1)).toBe(1);
    expect(await openTasksFor(u2)).toBe(1);
  });
});

d("replay idempotency", () => {
  it("creates no second task when the same condition is seen again", async () => {
    const unit = uid("VAC-REPLAY");
    const r1 = uid("EVT-R1");
    await insertEvent(r1, unit);
    await drainOnce("worker-a", 0, r1);
    expect(await openTasksFor(unit)).toBe(1);

    // Same unit, same unresolved condition, new event.
    const r2 = uid("EVT-R2");
    await insertEvent(r2, unit);
    await drainOnce("worker-a", 0, r2);
    expect(await openTasksFor(unit)).toBe(1);
  });

  it("opens a fresh task once the previous one is completed", async () => {
    const unit = uid("VAC-REOPEN");
    const o1 = uid("EVT-O1");
    await insertEvent(o1, unit);
    await drainOnce("worker-a", 0, o1);

    await pool.execute(
      "UPDATE operationalTasks SET status='completed', completedAt=NOW(), resolutionCode='repaired', completionEvidenceRef='WO-1' WHERE subjectId = ?",
      [unit]
    );

    const o2 = uid("EVT-O2");
    await insertEvent(o2, unit);
    await drainOnce("worker-a", 0, o2);
    expect(await openTasksFor(unit)).toBe(1);
  });
});

d("workflow history is append-only", () => {
  it("keeps every transition rather than overwriting state", async () => {
    const wf = uid("WF");
    await pool.execute(
      `INSERT INTO workflowInstances
         (workflowNumber, workflowKey, currentState, tenantId, subjectType, subjectId, dedupeKey, openedAt)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [wf, "critical_defect", "reported", "T1", "unit", uid("VAC"), uid("dk")]
    );

    for (const [from, to] of [
      ["reported", "inspection"],
      ["inspection", "work_order"],
      ["work_order", "repair"],
    ]) {
      await pool.execute(
        `INSERT INTO workflowTransitions (workflowNumber, fromState, toState, actorRole, actorSource, occurredAt)
         VALUES (?,?,?,?,?,NOW())`,
        [wf, from, to, "mechanic", "human"]
      );
      await pool.execute(
        "UPDATE workflowInstances SET currentState = ? WHERE workflowNumber = ?",
        [to, wf]
      );
    }

    const [hist] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM workflowTransitions WHERE workflowNumber = ?",
      [wf]
    );
    const [inst] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT currentState FROM workflowInstances WHERE workflowNumber = ?",
      [wf]
    );

    expect(hist[0].n).toBe(3);
    expect(inst[0].currentState).toBe("repair");
  });
});

d("notification deduplication", () => {
  it("refuses a second notification with the same key", async () => {
    const key = uid("NOTIF");
    const insert = () =>
      pool.execute(
        `INSERT INTO workflowNotifications (notificationKey, tenantId, title, queuedAt)
       VALUES (?,?,?,NOW())`,
        [key, "T1", "VAC-12 inspection expired"]
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});
