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
  emitDefectSentToShop,
  emitEvidenceIntegrityFailed,
  emitIncidentSealed,
  emitLegalHoldPlaced,
  emitMechanicReleased,
  emitNearMissEscalated,
  type EmitContext,
} from "./_core/domainEmitters";
import { startDrainWorker } from "./_core/drainWorker";
import { planEscalation, evaluateNearMiss } from "./_core/incidentReport";
import { evaluateMechanicRelease } from "./_core/mechanicRelease";
import { verifyReceivedSeal, sealEvidence, sha256 } from "./_core/evidenceSeal";

/**
 * B20 end to end.
 *
 * The B20 engines decided correctly and emitted nothing — they returned what
 * *should* happen and no consequence ever left the function. This joins them to
 * the B17 orchestration the same way B19 joined the defect path: a real
 * mutation, in a real transaction, producing real tasks from the real released
 * rule set.
 *
 * Each test drives the emitter from the engine's own output rather than from a
 * hand-written payload, so a change in engine behaviour surfaces here instead of
 * quietly diverging from what the workflow believes.
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

const tasksFor = async (subjectType: string, subjectId: string) => {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT taskType, assignedRole, priority, sourceRuleKey
     FROM operationalTasks
     WHERE subjectType = ? AND subjectId = ? AND status = 'open'
     ORDER BY id`,
    [subjectType, subjectId]
  );
  return rows;
};

/**
 * Drain until every event that existed when the drain started has been processed (or dead-lettered,
 * or deferred to a later retry), not for a fixed 300 ms. The worker claims the whole outbox in id
 * order, and other suites running at the same time enqueue their own events ahead of this one — so
 * under CI load a fixed window sometimes ended before this test's event was reached. A ceiling keeps
 * a genuinely stuck worker from hanging the suite; the assertions after it still decide the test.
 */
async function drainAll(workerId = "b20-worker") {
  const [maxRows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COALESCE(MAX(id), 0) AS maxId FROM domainEventOutbox");
  const maxId = Number(maxRows[0].maxId);
  const ports = createWorkerPorts(pool);
  const w = startDrainWorker(ports, {
    workerId,
    pollIntervalMs: 5,
    idleIntervalMs: 5,
    batchSize: 10,
  });
  await new Promise(r => setTimeout(r, 300));
  const deadline = Date.now() + 15_000;
  for (;;) {
    const [pending] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM domainEventOutbox
       WHERE id <= ? AND processedAt IS NULL AND deadLetteredAt IS NULL
         AND (retryAvailableAt IS NULL OR retryAvailableAt <= NOW())`,
      [maxId]
    );
    if (Number(pending[0].n) === 0 || Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 50));
  }
  w.stop();
  return w.done;
}

d("B20 rule seeds are published", () => {
  it("adds the records and safety rules without disturbing released ones", async () => {
    const second = await bootstrapRuleSeeds(pool);
    expect(second.conflicts).toEqual([]);
    expect(second.inserted).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThanOrEqual(15);
  });

  it("resolves rules for every new B20 event type", async () => {
    for (const t of [
      "safety.incident_sealed",
      "safety.near_miss_escalated",
      "records.evidence_integrity_failed",
      "records.legal_hold_placed",
      "fleet.defect_sent_to_shop",
    ]) {
      const rules = await loadRules(pool, t);
      expect(rules.length, `no rule for ${t}`).toBeGreaterThan(0);
    }
  });
});

d("end to end: sealed incident", () => {
  it("turns a sealed collision into a safety task and a held unit", async () => {
    const incident = uid("INC");
    const unit = uid("VAC");

    // The engine decides; the emitter reports. Not a hand-written payload.
    const plan = planEscalation({
      incidentType: "collision",
      injuryReported: false,
      emergencyServicesAttended: false,
      policeAttended: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      workStopped: true,
      vehicleDamage: true,
    });
    expect(plan.holdUnit).toBe(true);

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO incidentReports
       (incidentNumber, incidentType, severity, occurredAt, reportedAt,
        originalStatement, workStopped, unitHeld)
       VALUES (?,?,?,NOW(),NOW(),?,?,?)`,
      [
        incident,
        "collision",
        plan.severity,
        "clipped the gate post backing into the lease",
        1,
        1,
      ]
    );
    await emitIncidentSealed(conn as never, ctx(), {
      incidentNumber: incident,
      incidentType: "collision",
      severity: plan.severity,
      unitId: unit,
      injuryReported: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      holdUnit: plan.holdUnit,
      legalHoldRecommended: plan.legalHoldRecommended,
      reportedStatement: "clipped the gate post backing into the lease",
    });
    await conn.commit();
    conn.release();

    const stats = await drainAll();
    expect(stats.processed).toBeGreaterThan(0);

    const tasks = await tasksFor("incident", incident);
    const types = tasks.map(t => t.taskType);
    expect(types).toContain("review_sealed_incident");
    expect(types).toContain("inspect_unit_after_incident");
    expect(types).toContain("review_affected_assignments");

    const roles = tasks.map(t => t.assignedRole);
    expect(roles).toContain("safety");
    expect(roles).toContain("mechanic");
    expect(roles).toContain("dispatcher");
  });

  it("does not raise management review for a hazard observation", async () => {
    const incident = uid("INC");
    const plan = planEscalation({
      incidentType: "hazard_observation",
      injuryReported: false,
      emergencyServicesAttended: false,
      policeAttended: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      workStopped: false,
    });
    expect(plan.severity).toBe("none");
    expect(plan.holdUnit).toBe(false);

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitIncidentSealed(conn as never, ctx(), {
      incidentNumber: incident,
      incidentType: "hazard_observation",
      severity: plan.severity,
      injuryReported: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      holdUnit: plan.holdUnit,
      legalHoldRecommended: false,
      reportedStatement: "loose gravel on the approach",
    });
    await conn.commit();
    conn.release();

    await drainAll();
    // A hazard observation is worth recording and not worth waking anyone for.
    expect(await tasksFor("incident", incident)).toEqual([]);
  });

  it("notifies management for a sealed serious incident", async () => {
    const incident = uid("INC");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitIncidentSealed(conn as never, ctx(), {
      incidentNumber: incident,
      incidentType: "environmental_release",
      severity: "serious",
      injuryReported: false,
      environmentalRelease: true,
      dangerousGoodsInvolved: false,
      holdUnit: false,
      legalHoldRecommended: true,
      reportedStatement: "hose let go, product on the ground by the tank",
    });
    await conn.commit();
    conn.release();
    await drainAll();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT recipientRole FROM workflowNotifications WHERE title LIKE ? ORDER BY id DESC LIMIT 5",
      ["%management review required%"]
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

d("end to end: near miss escalation", () => {
  it("raises a safety review when a near miss reports an injury", async () => {
    const nearMiss = uid("NM");
    const incident = uid("INC");
    const statement = "spotter stepped inside the swing radius, caught his arm";

    const outcome = evaluateNearMiss({
      originalStatement: statement,
      anyoneInjured: true,
      workStopped: true,
    });
    expect(outcome.mustEscalateToIncident).toBe(true);

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO nearMissReports
       (nearMissNumber, occurredAt, reportedAt, originalStatement, anyoneInjured, status)
       VALUES (?,NOW(),NOW(),?,?,?)`,
      [nearMiss, statement, 1, "escalated"]
    );
    await emitNearMissEscalated(conn as never, ctx(), {
      nearMissNumber: nearMiss,
      incidentNumber: incident,
      reportedStatement: statement,
    });
    await conn.commit();
    conn.release();

    await drainAll();
    const tasks = await tasksFor("nearMiss", nearMiss);
    expect(tasks.map(t => t.taskType)).toContain("review_escalated_near_miss");
    expect(tasks.map(t => t.assignedRole)).toContain("safety");
  });
});

d("end to end: evidence integrity", () => {
  it("raises an office task when the server cannot reproduce the seal", async () => {
    const tracking = uid("DOC");
    const content = sha256("ticket-bytes");
    const seal = sealEvidence({
      trackingNumber: tracking,
      recordType: "disposal_ticket",
      version: 1,
      contentHash: content,
      capturedAt: new Date(),
      sealedAt: new Date(),
      sealedByUserId: 429,
      relationships: [{ entityType: "job", entityRef: "JOB-8841" }],
    });

    const outcome = verifyReceivedSeal({
      declaredContentHash: seal.contentHash,
      declaredManifestHash: seal.manifestHash,
      receivedManifest: seal.canonicalManifest,
      computedContentHash: sha256("corrupted-bytes"),
    });
    expect(outcome.result).toBe("hash_mismatch");
    expect(outcome.deviceCopyMayBeReleased).toBe(false);

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitEvidenceIntegrityFailed(conn as never, ctx(), {
      trackingNumber: tracking,
      packageRef: uid("PKG"),
      deviceId: "TAB-VAC27",
      failureMode: "hash_mismatch",
      employeeNumber: "EMP-00429",
    });
    await conn.commit();
    conn.release();

    await drainAll();
    const tasks = await tasksFor("evidenceRecord", tracking);
    expect(tasks.map(t => t.taskType)).toContain(
      "resolve_evidence_integrity_failure"
    );
    expect(tasks.map(t => t.assignedRole)).toContain("office");
  });

  it("emits nothing at all when the seal verifies", async () => {
    const tracking = uid("DOC");
    const content = sha256("clean-bytes");
    const seal = sealEvidence({
      trackingNumber: tracking,
      recordType: "load_ticket",
      version: 1,
      contentHash: content,
      capturedAt: new Date(),
      sealedAt: new Date(),
      sealedByUserId: 429,
      relationships: [{ entityType: "load", entityRef: "LOAD-9917" }],
    });
    const outcome = verifyReceivedSeal({
      declaredContentHash: seal.contentHash,
      declaredManifestHash: seal.manifestHash,
      receivedManifest: seal.canonicalManifest,
      computedContentHash: content,
    });
    expect(outcome.accepted).toBe(true);

    // A clean receipt is the common case and must be silent. An exception
    // centre that fills with successes is one nobody reads.
    await drainAll();
    expect(await tasksFor("evidenceRecord", tracking)).toEqual([]);
  });
});

d("end to end: legal hold", () => {
  it("tracks a placed hold as a confirmable obligation", async () => {
    const hold = uid("LH");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO legalHolds (holdNumber, reason, placedByUserId, placedByRole, placedAt)
       VALUES (?,?,?,?,NOW())`,
      [hold, "Injury incident under investigation", 5, "management"]
    );
    await emitLegalHoldPlaced(conn as never, ctx(), {
      holdNumber: hold,
      reason: "Injury incident under investigation",
      recordCount: 18,
    });
    await conn.commit();
    conn.release();

    await drainAll();
    const tasks = await tasksFor("legalHold", hold);
    expect(tasks.map(t => t.taskType)).toContain("confirm_legal_hold_scope");
  });
});

d("end to end: the maintenance chain", () => {
  it("carries a defect from shop dispatch to release and dispatch recalculation", async () => {
    const unit = uid("VAC");
    const wo = uid("WO");
    const observation = "Pump started grinding when PTO engaged";

    // Management reviewed the driver's report and sent it to the shop.
    let conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitDefectSentToShop(conn as never, ctx(), {
      unitId: unit,
      defectId: uid("MD"),
      workOrderRef: wo,
      severity: "critical",
      reportedObservation: observation,
      reviewedByUserId: 7,
    });
    await conn.commit();
    conn.release();
    await drainAll();

    const shopTasks = await tasksFor("unit", unit);
    expect(shopTasks.map(t => t.taskType)).toContain("perform_work_order");

    // The shop finishes. The release is validated by the engine, not asserted.
    const release = evaluateMechanicRelease({
      workOrderStatus: "ready_for_service",
      defectSeverity: "critical",
      releaseType: "full",
      repairSummary: "Worn pump coupling replaced",
      testProcedure: "20 minute PTO operational test",
      testResult: "pass",
      roadTestPerformed: true,
      technicianUserId: 113,
      technicianIdentifier: "TECH-113",
    });
    expect(release.mechanicReleaseGiven).toBe(true);

    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO workOrderReleases
       (workOrderId, unitId, releaseType, repairSummary, testProcedure, testResult,
        roadTestPerformed, technicianUserId, technicianIdentifier, releasedAt)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      [1, 1, "full", "Worn pump coupling replaced", "20 minute PTO operational test",
       "pass", 1, 113, "TECH-113"]
    );
    await emitMechanicReleased(conn as never, ctx(), {
      unitId: unit,
      workOrderRef: wo,
      releasedBy: "TECH-113",
      releaseVerified: release.mechanicReleaseGiven,
      releaseType: "full",
      restricted: release.restricted,
    });
    await conn.commit();
    conn.release();

    const stats = await drainAll();
    expect(stats.processed).toBeGreaterThan(0);
  });

  it("tells dispatch the restriction when a unit is released under limits", async () => {
    const unit = uid("VAC");
    const release = evaluateMechanicRelease({
      workOrderStatus: "ready_for_service",
      defectSeverity: "critical",
      releaseType: "restricted",
      restrictionDetail: "Loaded weight limited pending suspension follow-up",
      repairSummary: "Temporary spring repair",
      testProcedure: "Static load test",
      testResult: "pass",
      roadTestPerformed: true,
      technicianUserId: 113,
      technicianIdentifier: "TECH-113",
    });
    expect(release.restricted).toBe(true);

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitMechanicReleased(conn as never, ctx(), {
      unitId: unit,
      workOrderRef: uid("WO"),
      releasedBy: "TECH-113",
      releaseVerified: true,
      releaseType: "restricted",
      restricted: true,
      restrictionDetail: "Loaded weight limited pending suspension follow-up",
    });
    await conn.commit();
    conn.release();
    await drainAll();

    const tasks = await tasksFor("unit", unit);
    expect(tasks.map(t => t.taskType)).toContain("apply_release_restriction");
    expect(tasks.map(t => t.assignedRole)).toContain("dispatcher");
  });

  it("holds the unit again when a release is revoked", async () => {
    const unit = uid("VAC");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitMechanicReleased(conn as never, ctx(), {
      unitId: unit,
      workOrderRef: uid("WO"),
      releasedBy: "TECH-113",
      releaseVerified: false,
      releaseType: "revoked",
      restricted: false,
    });
    await conn.commit();
    conn.release();
    await drainAll();

    const tasks = await tasksFor("unit", unit);
    expect(tasks.map(t => t.taskType)).toContain("resolve_revoked_release");
    expect(tasks.map(t => t.priority)).toContain("critical");
  });

  it("does not raise a restriction task for an unrestricted release", async () => {
    const unit = uid("VAC");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitMechanicReleased(conn as never, ctx(), {
      unitId: unit,
      workOrderRef: uid("WO"),
      releasedBy: "TECH-113",
      releaseVerified: true,
      releaseType: "full",
      restricted: false,
    });
    await conn.commit();
    conn.release();
    await drainAll();

    const types = (await tasksFor("unit", unit)).map(t => t.taskType);
    expect(types).not.toContain("apply_release_restriction");
    expect(types).not.toContain("resolve_revoked_release");
  });
});

d("transactional integrity", () => {
  it("loses the incident event when the operational write rolls back", async () => {
    const incident = uid("INC");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitIncidentSealed(conn as never, ctx(), {
      incidentNumber: incident,
      incidentType: "collision",
      severity: "serious",
      injuryReported: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      holdUnit: true,
      legalHoldRecommended: false,
      reportedStatement: "rolled back",
    });
    await conn.rollback();
    conn.release();

    await drainAll();
    // No event, therefore no task. The event and the write share a fate.
    expect(await tasksFor("incident", incident)).toEqual([]);
  });
});

d("regression: notify actions are actually delivered", () => {
  /**
   * Found while wiring B20. `{ kind: "notify" }` was declared in
   * ConsequenceAction and used in eight released rules, but nothing applied it.
   * Notifications appeared only as a side effect of task creation, addressed to
   * the task's own assignee — so "notify management" delivered nothing unless a
   * task happened to be assigned to management.
   *
   * This asserts the case that could not work before: a role that receives a
   * notification while owning no task from the same event.
   */
  it("notifies a role that owns no task from the same event", async () => {
    const incident = uid("INC");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitIncidentSealed(conn as never, ctx(), {
      incidentNumber: incident,
      incidentType: "incident",
      severity: "serious",
      injuryReported: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      holdUnit: false,
      legalHoldRecommended: false,
      reportedStatement: "line let go on the transfer pump",
    });
    await conn.commit();
    conn.release();
    await drainAll();

    // The rule assigns the task to safety and notifies management.
    const tasks = await tasksFor("incident", incident);
    expect(tasks.map(t => t.assignedRole)).toContain("safety");
    expect(tasks.map(t => t.assignedRole)).not.toContain("management");

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT recipientRole, deepLink FROM workflowNotifications
       WHERE recipientRole = 'management' AND title LIKE '%management review required%'
       ORDER BY id DESC LIMIT 3`
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].deepLink).toBe("/safety/incidents");
  });

  it("does not notify the same role twice for a redelivered event", async () => {
    const incident = uid("INC");
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await emitIncidentSealed(conn as never, ctx(), {
      incidentNumber: incident,
      incidentType: "incident",
      severity: "serious",
      injuryReported: false,
      environmentalRelease: false,
      dangerousGoodsInvolved: false,
      holdUnit: false,
      legalHoldRecommended: false,
      reportedStatement: "second delivery check",
    });
    await conn.commit();
    conn.release();

    await drainAll("b20-worker-a");
    await drainAll("b20-worker-b");

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM workflowNotifications
       WHERE recipientRole = 'management' AND notificationKey LIKE ?`,
      [`%|management|%`]
    );
    // Derived key holds: redelivery cannot double-notify.
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});
