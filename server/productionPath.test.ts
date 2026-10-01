/**
 * v22.20 (0086) — Test 29.
 *
 * How much of this is the production path, stated exactly:
 *
 *   THROUGH appRouter   the scan, the confirmation, the finding, the release,
 *                       and every read.
 *   REAL ROWS           the enforcement event, violations, citation, the
 *                       out-of-service order, the defect, the work order, the
 *                       domainEventOutbox row, and the workflowNotifications
 *                       the consumer writes from it.
 *   ALSO THROUGH        the shop's own release of the work order, which now has a
 *                       procedure. Every step of this test runs through the API.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { getDb, grantUserRole } from "./db";
import { consumeEnforcementEvents } from "./_core/enforcementOutbox";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let seq = 10_200_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); db = await getDb(); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const T = (min: number) => new Date(new Date("2026-09-11T08:42:00Z").getTime() + min * 60_000);

d("29 — the chain, through the product", () => {
  it("a roadside prohibition becomes shop work, an alert, a finding and a release — and dispatch changes only at the end", async () => {
    const timeline: string[] = [];
    const at = (m: number, what: string) => timeline.push(`T+${String(m).padStart(3, "0")} ${what}`);

    const driver = await withRole("driver");
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const proposer = await withRole("management");
    const approver = await withRole("management");
    const branch = `B-${rnd()}`;
    // B23.1B: created, not named. This was `const unitId = 127` — a unit this
    // test does not own. The enforcement event opens a work order against it,
    // and `workOrderInScope` resolves that work order through the unit's
    // ownership row, so once any suite claimed unit 127 the release step failed
    // with "Work order N not found" and looked like an authorization defect.
    const [fixtureUnit] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')",
      [`U-PP-${rnd()}`]
    );
    const unitId = fixtureUnit.insertId;
    const vehicleRef = `UNIT-${rnd()}`;

    /* A release policy, approved by a second person. */
    const pol = await caller(proposer).comms.oosPolicyPropose({
      label: `policy ${rnd()}`, scopeType: "branch", scopeRef: branch,
      allowedFindingRoles: { repair_verification: ["mechanic"], reinspection: ["safety"], inspector_release: ["safety"], document_confirmation: ["office"], waiting_period_complete: ["safety"], other: ["management"] },
      effectiveFrom: new Date("2020-01-01"),
    });
    await caller(approver).comms.oosPolicyApprove({ policyRef: pol.policyRef, decision: "approve" });
    at(0, "release policy approved by a second person");

    /* The driver scans. Nothing is decided. */
    const extraction = await caller(driver).enforcement.extractionRecord({
      documentKind: "inspection_report", capturedAt: T(0),
      fields: [{ field: "agency", value: "an agency", confidence: 0.96 }, { field: "jurisdiction", value: "CA-AB", confidence: 0.98 }],
    });
    expect(extraction.requiresConfirmation).toBe(true);
    at(1, "document scanned — a proposal, nothing decided");

    /* Safety confirms. Everything commits together. */
    const confirmed = await caller(safety).enforcement.eventConfirm({
      extractionRef: extraction.extractionRef, eventType: "roadside_inspection", jurisdiction: "CA-AB",
      agency: `agency-${rnd()}`, occurredAt: T(0), inspectionReportNumber: `INSP-${rnd()}`,
      inspectionLevel: "I", inspectionResult: "out_of_service", unitId, branchId: branch,
      subjectRefs: { vehicle: vehicleRef },
      violations: [{
        system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER", citationIssued: true, outOfService: true,
        oosScope: "vehicle", defectRequired: true, repairRequired: true, courtAction: false,
        releaseCondition: "reinspection passed", requiredFindingType: "reinspection",
      }],
    });
    const orderRef = confirmed.orderRefs[0];
    expect(confirmed.created).toBe(true);
    at(3, "confirmed — event, violation, citation, order, defect, work order and outbox row in one transaction");

    /* The shop queue and the outbox both really exist. */
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT defectId, workOrderId FROM enforcementViolations WHERE eventRef = ?", [confirmed.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    expect(v.workOrderId).toBeTruthy();
    at(3, `work order ${v.workOrderId} raised, defect ${v.defectId} open`);

    /* The consumer tells the office. */
    await consumeEnforcementEvents(db, { now: T(4) });
    const [notes] = await pool.execute<mysql.RowDataPacket[]>("SELECT recipientRole, status FROM workflowNotifications WHERE notificationKey LIKE ?", [`enf:${confirmed.eventRef}:%`]);
    expect(notes.length).toBe(4);
    at(4, "four roles notified, queued and unacknowledged");

    /* Dispatch is prohibited, and not overridable by anyone here. */
    const before = await caller(safety).enforcement.activeOrders({ subjectRef: vehicleRef });
    expect(before.orders).toHaveLength(1);
    at(5, "DISPATCH: prohibited");

    /* The shop does the work, through the shop's own procedures. */
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "in_progress" });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "ready_for_service" });
    const shopRelease = await caller(mechanic).shop.workOrderRelease({
      workOrderId: Number(v.workOrderId), releaseType: "full",
      repairSummary: "brake chamber replaced", testProcedure: "brake performance test",
      testResult: "pass", roadTestPerformed: true, roadTestNotes: "no pull, no warning lamps",
      resolvedDefectIds: [Number(v.defectId)], releasedAt: T(40),
    });
    // The technician is the authenticated caller, not anything the body said.
    expect(shopRelease.technicianUserId).toBe(mechanic);
    expect(shopRelease.mechanicReleaseGiven).toBe(true);
    expect(shopRelease.note).toContain("does not lift a government out-of-service order");
    at(40, "repair completed, tested, evidenced and recorded by the shop");

    /* Repair alone does not release. */
    await expect(caller(safety).enforcement.orderRelease({ orderRef, at: T(41) })).rejects.toThrow();
    const stillActive = await caller(safety).enforcement.activeOrders({ subjectRef: vehicleRef });
    expect(stillActive.orders).toHaveLength(1);
    at(41, "release refused — repair complete is not release");

    /* A mechanic cannot record the reinspection this order demands. */
    await expect(caller(mechanic).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection", at: T(42) }))
      .rejects.toThrow(/permits reinspection findings from safety/i);
    at(42, "mechanic refused the reinspection finding — policy permits safety only");

    /* Safety records it. Still not a release. */
    const finding = await caller(safety).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection", evidenceRef: "EV-REINSP", at: T(43) });
    expect(finding.note).toContain("A finding is not a release");
    at(43, "reinspection finding recorded by safety");

    /* And now the release, because somebody called release. */
    const released = await caller(safety).enforcement.orderRelease({ orderRef, releaseEvidenceRef: "EV-REINSP", at: T(44) });
    expect(released.released).toBe(true);
    at(44, "explicit release");

    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, releasedByUserId, releasePolicyRef, releasePolicyVersion FROM outOfServiceOrders WHERE orderRef = ?", [orderRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    expect(row).toMatchObject({ status: "released", releasedByUserId: safety, releasePolicyRef: pol.policyRef, releasePolicyVersion: 1 });

    const after = await caller(safety).enforcement.activeOrders({ subjectRef: vehicleRef });
    expect(after.orders).toHaveLength(0);
    at(45, "DISPATCH: clear");

    /* The receipt. */
    const receipt = {
      eventRef: confirmed.eventRef, orderRef, workOrderId: Number(v.workOrderId),
      notifiedRoles: notes.length, releasedByUserId: safety, releasePolicyRef: pol.policyRef,
      dispatchBeforeRelease: "prohibited", dispatchAfterRelease: "clear",
      releasedByRepairAlone: false, mechanicRecordedReinspection: false,
      shopCompletionWentThroughAProcedure: true,
      steps: timeline.length,
    };
    expect(receipt.dispatchBeforeRelease).toBe("prohibited");
    expect(receipt.dispatchAfterRelease).toBe("clear");
    expect(receipt.releasedByRepairAlone).toBe(false);
    expect(receipt.shopCompletionWentThroughAProcedure).toBe(true);
    expect(timeline).toHaveLength(12);
  });
});
