import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  applyEventConsequences,
  bootstrapRuleSeeds,
  createWorkerPorts,
  loadRules,
  type PoolLike,
} from "./_core/workflowRuntime";
import {
  emitCalloutAuthorityUnverified,
  emitCriticalDefectOpened,
  emitDisposalTicketMissing,
  emitAssignmentAtRisk,
  type EmitContext,
} from "./_core/domainEmitters";
import { startDrainWorker } from "./_core/drainWorker";

// A unit id no test creates. These rows only need a unitId to satisfy the column;
// the literal 1 used here before collided with whichever suite happened to create
// the first unit in a fresh database, handing that suite's truck open critical
// defects (complianceReadinessC1a failed on exactly that, order-dependently).
const NO_SUCH_UNIT = 2_000_000_000;

/**
 * The chain end to end.
 *
 * Every previous checkpoint proved this in halves — seeds → engine → tasks in
 * unit tests, outbox → claim → mark against the database. This joins them:
 * a real domain mutation, inside a real transaction, producing a real task
 * from the real released rule set.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool & PoolLike;
const uid = (p: string) =>
  `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const ctx = (): EmitContext => ({
  tenantId: "T1",
  branchId: "GP",
  actor: { source: "human", userId: "u1", role: "driver" },
});

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 8 }) as never;
  await bootstrapRuleSeeds(pool);
});

const openTasks = async (subjectType: string, subjectId: string) => {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT taskNumber, taskType, assignedRole, priority, requiresEvidence,
            rootDedupeKey, sourceRuleKey, sourceRuleVersion
     FROM operationalTasks
     WHERE subjectType = ? AND subjectId = ? AND status = 'open'
     ORDER BY id`,
    [subjectType, subjectId]
  );
  return rows;
};

/**
 * Drain until THIS test's own events are processed, so assertions are about end state.
 *
 * `subject` is the aggregate id the test just emitted against — every test here
 * makes one with `uid()`, so it names nobody else's events.
 *
 * Waiting on the subject rather than on the queue is what makes this correct
 * under concurrency. The condition used to be "no event is CLAIMABLE", i.e. it
 * counted only rows with `claimedAt IS NULL`. The outbox is shared by every
 * database suite in the run and five of them run drain workers, so a concurrent
 * worker could claim THIS test's event between the emit and the check: the loop
 * then saw nothing claimable, called the queue drained, and returned before that
 * worker had created the task, and the assertion read zero. Proven by
 * construction rather than inferred — a single unprocessed row claimed one
 * second earlier by a foreign worker makes the old count report 0 while a real
 * event is still outstanding. It cost one failure in three full-gate runs,
 * always in the same assertion.
 *
 * Still bounded, and still not a fixed window: a fixed 300 ms could end before
 * this test's event was reached, while a stream of other suites' events must not
 * hold the test open.
 */
async function drainAll(workerId = "test-worker", subject?: string) {
  const ports = createWorkerPorts(pool);
  const w = startDrainWorker(ports, {
    workerId,
    pollIntervalMs: 5,
    idleIntervalMs: 5,
    batchSize: 10,
  });
  const deadline = Date.now() + 15_000;
  await new Promise(r => setTimeout(r, 300));
  while (Date.now() < deadline) {
    const [rows] = subject
      ? await pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM domainEventOutbox
            WHERE aggregateId = ? AND processedAt IS NULL AND deadLetteredAt IS NULL
              AND (retryAvailableAt IS NULL OR retryAvailableAt <= NOW())`,
          [subject]
        )
      : await pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM domainEventOutbox
            WHERE processedAt IS NULL AND deadLetteredAt IS NULL
              AND (retryAvailableAt IS NULL OR retryAvailableAt <= NOW()) AND claimedAt IS NULL`
        );
    if (Number(rows[0]!.n) === 0) break;
    await new Promise(r => setTimeout(r, 50));
  }
  w.stop();
  return w.done;
}

d("rule seed bootstrap", () => {
  it("publishes the source-controlled rules exactly once", async () => {
    const second = await bootstrapRuleSeeds(pool);
    expect(second.inserted).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThanOrEqual(7);
    expect(second.conflicts).toEqual([]);
  });

  it("loads only the newest released version of each rule", async () => {
    const rules = await loadRules(pool, "unit.critical_defect_opened");
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules.map(r => r.ruleKey)).size).toBe(rules.length);
  });
});

d("end to end: critical defect", () => {
  it("turns a real mutation into a mechanic task and a dispatcher consequence", async () => {
    const unit = uid("VAC");
    const conn = await pool.getConnection();

    // The operational write and its event, in ONE transaction.
    await conn.beginTransaction();
    await conn.execute(
      "INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt) VALUES (?,?,?,?,NOW())",
      [NO_SUCH_UNIT, `Grinding on start-up — ${unit}`, "critical", "open"]
    );
    await emitCriticalDefectOpened(conn as never, ctx(), {
      unitId: unit,
      defectId: uid("MD"),
      severity: "critical",
      reportedObservation: "Grinding when I first started it",
      affectedAssignments: ["JOB-8851"],
    });
    await conn.commit();
    conn.release();

    const stats = await drainAll("test-worker", unit);
    expect(stats.processed).toBeGreaterThan(0);

    const tasks = await openTasks("unit", unit);
    expect(tasks).toHaveLength(2);

    const root = tasks.find(t => t.rootDedupeKey === null)!;
    expect(root.taskType).toBe("resolve_critical_defect");
    expect(root.assignedRole).toBe("mechanic");
    expect(root.priority).toBe("critical");
    expect(root.requiresEvidence).toBe(1);
    expect(root.sourceRuleKey).toBe("fleet.critical_defect.opened");

    const consequence = tasks.find(t => t.rootDedupeKey !== null)!;
    expect(consequence.assignedRole).toBe("dispatcher");
  });

  it("queues a notification for the owning role", async () => {
    const unit = uid("VAC-N");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitCriticalDefectOpened(conn as never, ctx(), {
      unitId: unit,
      defectId: uid("MD"),
      severity: "critical",
      reportedObservation: "noise",
      affectedAssignments: [],
    });
    await conn.commit();
    conn.release();

    await drainAll("test-worker", unit);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT recipientRole, status FROM workflowNotifications WHERE title LIKE ? ORDER BY id DESC LIMIT 5",
      ["%critical defect%"]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(r => r.recipientRole)).toContain("mechanic");
  });

  it("creates no second task when the same defect is reported again", async () => {
    const unit = uid("VAC-DUP");
    for (const n of [1, 2, 3]) {
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      await emitCriticalDefectOpened(conn as never, ctx(), {
        unitId: unit,
        defectId: `MD-${n}`,
        severity: "critical",
        reportedObservation: `report ${n}`,
        affectedAssignments: [],
      });
      await conn.commit();
      conn.release();
      await drainAll("test-worker", unit);
    }
    expect(await openTasks("unit", unit)).toHaveLength(2);
  });

  it("does not fire for an advisory defect", async () => {
    const unit = uid("VAC-ADV");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitCriticalDefectOpened(conn as never, ctx(), {
      unitId: unit,
      defectId: uid("MD"),
      severity: "advisory",
      reportedObservation: "marker light out",
      affectedAssignments: [],
    });
    await conn.commit();
    conn.release();

    await drainAll("test-worker", unit);
    expect(await openTasks("unit", unit)).toHaveLength(0);
  });
});

d("end to end: disposal ticket", () => {
  it("raises a driver task naming the specific evidence", async () => {
    const load = uid("LD");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitDisposalTicketMissing(conn as never, ctx(), {
      loadId: load,
      tripId: "TR-1",
      jobId: "JOB-1",
      facilityId: "F-3",
      facilityIssuesTicket: true,
      missingChecks: ["Facility ticket"],
    });
    await conn.commit();
    conn.release();

    await drainAll("test-worker", load);
    const tasks = await openTasks("load", load);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskType).toBe("upload_disposal_ticket");
    expect(tasks[0].assignedRole).toBe("driver");
  });

  it("emits nothing at all for a facility that issues no tickets", async () => {
    const load = uid("LD-NOTICKET");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const row = await emitDisposalTicketMissing(conn as never, ctx(), {
      loadId: load,
      tripId: "TR-2",
      jobId: "JOB-2",
      facilityId: "F-9",
      facilityIssuesTicket: false,
      missingChecks: [],
    });
    await conn.commit();
    conn.release();

    expect(row).toBeNull();
    await drainAll("test-worker", load);
    expect(await openTasks("load", load)).toHaveLength(0);
  });
});

d("end to end: dispatch invalidation", () => {
  it("raises a dispatcher task when the verdict actually moved", async () => {
    const assignment = uid("ASG");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitAssignmentAtRisk(conn as never, ctx(), {
      assignmentId: assignment,
      postingId: "P-1",
      operatorId: "OP-47",
      unitId: "VAC-27",
      invalidationCause: "Unit inspection expired after assignment",
      previousVerdict: "eligible",
      nextVerdict: "blocked",
    });
    await conn.commit();
    conn.release();

    await drainAll("test-worker", assignment);
    const tasks = await openTasks("assignment", assignment);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedRole).toBe("dispatcher");
  });

  it("emits nothing when a re-evaluation produced the same verdict", async () => {
    const assignment = uid("ASG-SAME");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const row = await emitAssignmentAtRisk(conn as never, ctx(), {
      assignmentId: assignment,
      postingId: "P-2",
      operatorId: "OP-47",
      unitId: null,
      invalidationCause: "recheck",
      previousVerdict: "eligible_review",
      nextVerdict: "eligible_review",
    });
    await conn.commit();
    conn.release();

    // This is the loop guard: without it, re-evaluate → emit → re-evaluate.
    expect(row).toBeNull();
    await drainAll("test-worker", assignment);
    expect(await openTasks("assignment", assignment)).toHaveLength(0);
  });
});

d("transactional integrity of emission", () => {
  it("loses the event when the operational write rolls back", async () => {
    const unit = uid("VAC-RB");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitCriticalDefectOpened(conn as never, ctx(), {
      unitId: unit,
      defectId: uid("MD"),
      severity: "critical",
      reportedObservation: "x",
      affectedAssignments: [],
    });
    await conn.rollback();
    conn.release();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM domainEventOutbox WHERE aggregateId = ?",
      [unit]
    );
    expect(rows[0].n).toBe(0);

    await drainAll("test-worker", unit);
    expect(await openTasks("unit", unit)).toHaveLength(0);
  });
});

d("unmatched events", () => {
  it("marks an event with no matching rule processed rather than retrying it forever", async () => {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const calloutRef = uid("CO");
    await emitCalloutAuthorityUnverified(conn as never, ctx(), {
      calloutRef,
      callerName: "Unknown",
      callerCompany: "Bearpaw Drilling",
      claimedAuthority: "third_party_operator",
      billToParty: null,
    });
    await conn.commit();
    conn.release();

    const stats = await drainAll("test-worker", calloutRef);
    expect(stats.processed).toBeGreaterThan(0);
    expect(stats.deadLettered).toBe(0);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM domainEventOutbox WHERE eventType = ? AND processedAt IS NULL",
      ["billing.callout_authority_unverified"]
    );
    expect(rows[0].n).toBe(0);
  });
});
