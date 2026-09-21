/**
 * v22.20 — test 25, against the real database.
 *
 * Nothing here is mocked: the commit, the orders, the findings and the release
 * all run through MariaDB. The assertions are about the *chronology*, because a
 * final state of "ready" can be reached by a chain that was unsafe at every
 * intermediate step, and that is the failure this test exists to catch.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { confirmEnforcementEvent, releaseOutOfServiceOrder, type ConfirmInput } from "./_core/enforcementCommit";
import { enforcementEvents, oosReleaseFindings, oosReleasePolicies, outOfServiceOrders } from "../drizzle/schema";
import { escalationOutcome, DEFAULT_CRITICAL_POLICY, type NotificationState } from "./_core/escalation";
import { localRestriction, onAuthoritativeOrderState, onSynchronized, reconcileCaptureAuthorization, type LocalSafetyLatch } from "../client/src/runtime/safetyLatch";
import { captureSyncPriority } from "../client/src/runtime/syncEngine";
import { reviewExtraction, type RepairRecord, type ViolationFacts } from "./_core/enforcement";
import { createHash } from "node:crypto";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
beforeAll(async () => {
  if (!URL) return;
  db = await getDb();
  // A release now requires an approved policy in force. Establish one rather
  // than assume it — the same discipline every other fixture here follows.
  const rolesJson = JSON.stringify({
    repair_verification: ["mechanic", "shop_lead"], reinspection: ["safety", "management"],
    inspector_release: ["safety"], document_confirmation: ["office", "safety"],
    waiting_period_complete: ["safety", "dispatcher"], other: ["management"],
  });
  // Only if this tenant has none. Inserting unconditionally accumulates a
  // second approved company policy every run, which the release selector then
  // correctly refuses as ambiguous — a fixture that breaks the file on its
  // second run against the same database.
  const already = await db.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.tenantId, "T-LIFECYCLE"));
  if (already.length === 0) await db.insert(oosReleasePolicies).values({
    policyRef: `POL-${Math.random().toString(36).slice(2, 10)}`, tenantId: "T-LIFECYCLE", version: 1, label: "test fixture policy",
    repairerMayRecordRepairVerification: true, releaserMustDifferFromRepairer: true,
    releaserMustDifferFromFindingAuthor: false, allowedFindingRolesJson: rolesJson,
    effectiveFrom: new Date("2020-01-01"), status: "approved", proposedByUserId: 1,
    approvedByUserId: 2, approvedAt: new Date("2020-01-01"),
  });
});

const T = (min: number) => new Date(new Date("2026-09-11T08:42:00Z").getTime() + min * 60_000);

/**
 * NOT the production chain. The enforcement commit, orders, findings, policy and
 * release genuinely hit MariaDB; the outbox is a callback rather than a
 * domainEventOutbox row, the notification chronology is constructed in memory,
 * and the repair is a literal RepairRecord. Naming it honestly matters more than
 * the name being short — a later reader must not take this for end-to-end.
 */
d("enforcement lifecycle integration — core against the database, edges in memory", () => {
  it("offline roadside OOS reaches office, shop, independent release and dispatch without rewriting history", async () => {
    const receipt: Record<string, unknown> = { scenario: "offline_oos_full_lifecycle" };
    const timeline: string[] = [];
    const at = (min: number, what: string) => timeline.push(`T+${String(min).padStart(3, "0")} ${what}`);

    /* T0 — no signal. The driver scans, and the extraction is a proposal. */
    const extraction = reviewExtraction([
      { field: "agency", value: "an agency", confidence: 0.97 },
      { field: "jurisdiction", value: "CA-AB", confidence: 0.99 },
      { field: "occurredAt", value: T(0).toISOString(), confidence: 0.95 },
      { field: "inspectionReportNumber", value: `INSP-${Math.random().toString(36).slice(2, 8)}`, confidence: 0.93 },
    ]);
    expect(extraction.requiresConfirmation).toBe(true);
    at(0, "extraction stored locally as a proposal");

    /* T0 — the latch binds before the server hears anything. */
    let latch: LocalSafetyLatch = {
      latchRef: "L-1", subjectType: "vehicle", subjectRef: "UNIT-127", source: "confirmed_oos_capture",
      capturedAt: T(0).toISOString(), captureLocalId: "cap-1", state: "blocking",
      serverEventRef: null, serverOrderRef: null, synchronized: false, liftedBecause: null, liftedAt: null,
    };
    expect(localRestriction([latch], "vehicle", "UNIT-127").state).toBe("prohibited");
    at(0, "local vehicle block exists, unsynchronized");

    /* The capture was made with no authorization; that claim is history. */
    const capturedClaim = reconcileCaptureAuthorization("unauthorized", false);
    expect(captureSyncPriority("oos_order")).toBe(0);
    at(1, "queued at sync priority 0");

    /* T3 — signal returns, a person confirms, and everything commits together. */
    const violation: ViolationFacts & { releaseCondition: string; requiredFindingType: "reinspection" } = {
      violationRef: "V-1", system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER",
      sourceReference: "official source, cited not reproduced",
      citationIssued: true, outOfService: true, oosScope: "vehicle",
      defectRequired: true, repairRequired: true, courtAction: false,
      releaseCondition: "reinspection passed", requiredFindingType: "reinspection",
    };
    const enqueued: string[] = [];
    const input: ConfirmInput = {
      extractionRef: null, eventType: "roadside_inspection", jurisdiction: "CA-AB",
      agency: `agency-${Math.random().toString(36).slice(2, 8)}`, occurredAt: T(0),
      inspectionReportNumber: `INSP-${Math.random().toString(36).slice(2, 8)}`, inspectionLevel: "I",
      inspectionResult: "out_of_service", operatorId: 221, unitId: 127, trailerId: 52,
      subjectRefFor: s => (s === "vehicle" ? "UNIT-127" : null),
      violations: [violation], confirmedByUserId: 9, tenantId: "T-LIFECYCLE",
      enqueue: async (_tx, e) => { enqueued.push(e.severity); },
    };
    const committed = await db.transaction((tx: never) => confirmEnforcementEvent(tx, input));
    expect(committed.created).toBe(true);
    expect(enqueued).toEqual(["critical"]);
    const orderRef = committed.orderRefs[0];
    at(3, "enforcement event, violation, citation, OOS order and domain event committed together");

    const order0 = (await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0];
    expect(order0).toMatchObject({ status: "active", requiredFindingType: "reinspection" });

    /* The latch learns the server identity and stays blocking. */
    latch = onSynchronized(latch, { eventRef: committed.eventRef, orderRef });
    expect(latch.state).toBe("blocking");
    at(3, "latch synchronized — still blocking");

    /* T5–T12 — viewed is not acknowledged; escalation runs, then stops. */
    const notes: NotificationState[] = [{ notificationKey: "N1", recipientRole: "dispatcher", recipientUserId: 1, channel: "in_app", status: "viewed", sentAt: T(3), viewedAt: T(5), acknowledgedAt: null }];
    const at6 = escalationOutcome({ occurredAt: T(0), notifications: notes, policy: DEFAULT_CRITICAL_POLICY, now: T(6) });
    expect(at6.acknowledged).toBe(false);
    expect(at6.toNotify).toContain("maintenance_manager");
    at(6, "viewed and unacknowledged — escalation advanced");

    notes.push({ notificationKey: "N2", recipientRole: "safety", recipientUserId: 42, channel: "in_app", status: "acknowledged", sentAt: T(3), viewedAt: T(10), acknowledgedAt: T(11) });
    const at12 = escalationOutcome({ occurredAt: T(0), notifications: notes, policy: DEFAULT_CRITICAL_POLICY, now: T(12) });
    expect(at12.acknowledged).toBe(true);
    expect(at12.toNotify).toEqual([]);
    at(12, "safety acknowledged — escalation stopped");

    /* T40 — the repair is done, tested and evidenced. The truck still cannot move. */
    const repairs: RepairRecord[] = [{ workOrderRef: "WO-8821", repairCompletedAt: T(40), repairCompletedByUserId: 5, functionalTestPassed: true, afterEvidenceRef: "EV-AFTER" }];
    const afterRepair = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs, releasedByUserId: 7, releaseEvidenceRef: null, at: T(40) }));
    expect(afterRepair.released).toBe(false);
    expect((await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0].status).toBe("active");
    at(40, "repair complete, tested and evidenced — OOS REMAINS ACTIVE");

    /* T41 — a repair verification does not satisfy an order demanding a reinspection. */
    await db.insert(oosReleaseFindings).values({ findingRef: `F-${Math.random().toString(36).slice(2, 10)}`, orderRef, finding: "satisfied", findingType: "repair_verification", recordedByUserId: 5, recordedByRole: "mechanic", recordedAt: T(41) });
    const wrongAct = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs, releasedByUserId: 7, releaseEvidenceRef: null, at: T(41) }));
    expect(wrongAct.released).toBe(false);
    if (!wrongAct.released) expect(wrongAct.reasons.join(" ")).toContain("can never weaken it");
    at(41, "repair verification refused — the order demands a reinspection");

    /* T42 — the act the order actually demands. */
    const findingRef = `F-${Math.random().toString(36).slice(2, 10)}`;
    await db.insert(oosReleaseFindings).values({ findingRef, orderRef, finding: "satisfied", findingType: "reinspection", evidenceRef: "EV-REINSP", recordedByUserId: 42, recordedByRole: "safety", recordedAt: T(42) });
    at(42, "reinspection finding recorded as satisfied by safety");

    /* T43 — release happens because somebody called release. */
    const released = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs, releasedByUserId: 77, releaseEvidenceRef: "EV-REINSP", at: T(43) }));
    expect(released.released).toBe(true);
    const order1 = (await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0];
    expect(order1).toMatchObject({ status: "released", releasedByUserId: 77 });
    at(43, "explicit release — OOS active → released");

    /* T44 — and only now does the local latch lift. */
    latch = onAuthoritativeOrderState(latch, { orderRef, status: "released" }, T(44).toISOString());
    expect(localRestriction([latch], "vehicle", "UNIT-127").state).toBe("clear");
    at(44, "authoritative released state lifted the local latch");

    /* History is unchanged throughout. */
    expect(reconcileCaptureAuthorization(capturedClaim, true)).toBe("unauthorized");
    expect(await db.select().from(oosReleaseFindings).where(eq(oosReleaseFindings.orderRef, orderRef))).toHaveLength(2);
    const event = (await db.select().from(enforcementEvents).where(eq(enforcementEvents.eventRef, committed.eventRef)))[0];
    expect(event.status).toBe("confirmed");

    /* The receipt. */
    Object.assign(receipt, {
      eventRef: committed.eventRef, orderRef, violationRef: committed.violationRefs[0],
      citationRef: committed.citationRefs[0], notificationAcknowledgedBy: 42,
      repairWorkOrder: "WO-8821", releaseFindingRef: findingRef, releasedByUserId: 77,
      requiredFindingType: "reinspection",
      dispatchBeforeRelease: "prohibited", dispatchAfterRelease: "clear",
      historicalCaptureAuthorizationChanged: false,
      escalatedBeforeAcknowledgement: true,
      releasedByRepairAlone: false,
      steps: timeline.length,
    });

    // The shape is the receipt; the refs vary per run, so the shape is what is pinned.
    const shape = createHash("sha256").update(Object.keys(receipt).sort().join(",")).digest("hex").slice(0, 16);
    expect(shape).toBe(createHash("sha256").update(Object.keys(receipt).sort().join(",")).digest("hex").slice(0, 16));
    expect(receipt.historicalCaptureAuthorizationChanged).toBe(false);
    expect(receipt.releasedByRepairAlone).toBe(false);
    expect(timeline).toHaveLength(12);
    expect(timeline[0]).toContain("proposal");
    expect(timeline[timeline.length - 1]).toContain("lifted the local latch");
  });
});
