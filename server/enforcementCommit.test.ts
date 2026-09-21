/**
 * v22.20 (0082) — the atomic commit, and the acts it will not perform.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "./db";
import { affectedRows, confirmEnforcementEvent, idempotencyKey, releaseOutOfServiceOrder, type ConfirmInput } from "./_core/enforcementCommit";
import { enforcementCitations, enforcementViolations, oosReleaseFindings, oosReleasePolicies, outOfServiceOrders } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { RepairRecord, ViolationFacts } from "./_core/enforcement";

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
  const already = await db.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.tenantId, "T-COMMIT"));
  if (already.length === 0) await db.insert(oosReleasePolicies).values({
    policyRef: `POL-${Math.random().toString(36).slice(2, 10)}`, tenantId: "T-COMMIT", version: 1, label: "test fixture policy",
    repairerMayRecordRepairVerification: true, releaserMustDifferFromRepairer: true,
    releaserMustDifferFromFindingAuthor: false, allowedFindingRolesJson: rolesJson,
    effectiveFrom: new Date("2020-01-01"), status: "approved", proposedByUserId: 1,
    approvedByUserId: 2, approvedAt: new Date("2020-01-01"),
  });
});

const NOW = new Date("2026-09-11T12:00:00Z");
let n = 0;
const violation = (o: Partial<ViolationFacts> & { releaseCondition?: string } = {}): ViolationFacts & { releaseCondition?: string } => ({
  violationRef: `V-${++n}`, system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER",
  sourceReference: "official source, cited not reproduced",
  citationIssued: false, outOfService: false, oosScope: null,
  defectRequired: false, repairRequired: false, courtAction: false, ...o,
});
const input = (over: Partial<ConfirmInput> = {}): ConfirmInput => ({
  extractionRef: null, eventType: "roadside_inspection", jurisdiction: "CA-AB",
  agency: `agency-${Math.random().toString(36).slice(2, 8)}`, occurredAt: NOW,
  inspectionReportNumber: `INSP-${Math.random().toString(36).slice(2, 8)}`,
  inspectionLevel: "I", inspectionResult: "out_of_service",
  operatorId: 221, unitId: 127, trailerId: 52,
  subjectRefFor: scope => (scope === "vehicle" ? "UNIT-127" : scope === "driver" ? "D-221" : scope === "trailer" ? "T-52" : null),
  violations: [], confirmedByUserId: 9, tenantId: "T-COMMIT", ...over,
});

d("the commit is atomic and happens once", () => {
  it("writes the event, its violations, citations and orders together", async () => {
    const r = await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({
      violations: [violation({ outOfService: true, oosScope: "vehicle", citationIssued: true, repairRequired: true, releaseCondition: "repair verified and reinspection passed" })],
    })));
    expect(r.created).toBe(true);
    expect(r.violationRefs).toHaveLength(1);
    expect(r.citationRefs).toHaveLength(1);
    expect(r.orderRefs).toHaveLength(1);
    expect(r.repairRequired[0]).toMatchObject({ ownCode: "LEASEOS.BRAKES.CHAMBER" });

    const order = (await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, r.orderRefs[0])))[0];
    expect(order).toMatchObject({ scope: "vehicle", subjectRef: "UNIT-127", status: "active" });
    expect(order.releaseCondition).toBe("repair verified and reinspection passed");
    // A scanned allegation, not a conviction.
    const citation = (await db.select().from(enforcementCitations).where(eq(enforcementCitations.citationRef, r.citationRefs[0])))[0];
    expect(citation.status).toBe("scanned");
  });

  it("cannot create a second set of orders when the same stop is confirmed twice", async () => {
    const i = input({ violations: [violation({ outOfService: true, oosScope: "vehicle", repairRequired: true })] });
    const first = await db.transaction((tx: never) => confirmEnforcementEvent(tx, i));
    const second = await db.transaction((tx: never) => confirmEnforcementEvent(tx, i));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.eventRef).toBe(first.eventRef);
    expect(second.orderRefs).toEqual(first.orderRefs);
    expect(second.notes[0]).toContain("nothing was written a second time");

    const orders = await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.eventRef, first.eventRef));
    expect(orders).toHaveLength(1);
    const violations = await db.select().from(enforcementViolations).where(eq(enforcementViolations.eventRef, first.eventRef));
    expect(violations).toHaveLength(1);
  });

  it("derives its key from what the act is, not from when it ran", () => {
    const a = idempotencyKey(["enforcement", "CA-AB", "agency", "2026-09-11T12:00:00.000Z", "INSP-1", 127, 221]);
    const b = idempotencyKey(["enforcement", "CA-AB", "agency", "2026-09-11T12:00:00.000Z", "INSP-1", 127, 221]);
    expect(a).toBe(b);
    expect(idempotencyKey(["enforcement", "CA-AB", "agency", "2026-09-11T12:00:00.000Z", "INSP-2", 127, 221])).not.toBe(a);
  });
});

d("a citation is still not a prohibition", () => {
  it("creates a citation and no order for a ticket-only violation", async () => {
    const r = await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({
      inspectionResult: "requires_attention",
      violations: [violation({ citationIssued: true, courtAction: true })],
    })));
    expect(r.citationRefs).toHaveLength(1);
    expect(r.orderRefs).toHaveLength(0);
    expect(r.notes.join(" ")).toContain("this does not stop the vehicle");
  });

  it("refuses to guess a scope, and writes no order rather than grounding the wrong thing", async () => {
    const r = await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({
      violations: [violation({ outOfService: true, oosScope: null })],
    })));
    expect(r.orderRefs).toHaveLength(0);
    expect(r.notes.join(" ")).toContain("needs confirming with the inspector");
  });
});

d("releasable is not released", () => {
  const repaired: RepairRecord[] = [{ workOrderRef: "WO-1", repairCompletedAt: NOW, repairCompletedByUserId: 4, functionalTestPassed: true, afterEvidenceRef: "EV-2" }];

  async function anActiveOrder() {
    const r = await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({
      violations: [violation({ outOfService: true, oosScope: "vehicle", repairRequired: true, releaseCondition: "reinspection passed" })],
    })));
    return r.orderRefs[0];
  }

  it("refuses to release while no finding exists, however complete the repair", async () => {
    const orderRef = await anActiveOrder();
    const r = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: null, at: NOW }));
    expect(r.released).toBe(false);
    if (r.released) return;
    expect(r.state).toBe("repair_complete_pending_release");
    const row = (await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0];
    expect(row.status).toBe("active");
    expect(row.releasedAt).toBeNull();
  });

  it("refuses on a finding that says the condition is not satisfied, and keeps the finding", async () => {
    const orderRef = await anActiveOrder();
    await db.insert(oosReleaseFindings).values({ findingRef: `F-${Math.random().toString(36).slice(2, 9)}`, orderRef, finding: "not_satisfied", findingType: "reinspection", recordedByUserId: 8, recordedByRole: "safety", recordedAt: NOW });
    const r = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: null, at: NOW }));
    expect(r.released).toBe(false);
    expect((await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0].status).toBe("active");
    expect(await db.select().from(oosReleaseFindings).where(eq(oosReleaseFindings.orderRef, orderRef))).toHaveLength(1);
  });

  it("releases only on a satisfied finding, and only because release was called", async () => {
    const orderRef = await anActiveOrder();
    await db.insert(oosReleaseFindings).values({ findingRef: `F-${Math.random().toString(36).slice(2, 9)}`, orderRef, finding: "satisfied", findingType: "reinspection", evidenceRef: "EV-9", recordedByUserId: 8, recordedByRole: "safety", recordedAt: NOW });
    const r = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: "EV-9", at: NOW }));
    expect(r.released).toBe(true);
    const row = (await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0];
    expect(row).toMatchObject({ status: "released", releasedByUserId: 7, releaseEvidenceRef: "EV-9" });
    expect(row.releasedAt).toBeTruthy();

    // And it cannot be released twice.
    const again = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: "EV-9", at: NOW }));
    expect(again.released).toBe(false);
  });

  it("keeps the latest finding as the answer and the earlier ones as history", async () => {
    const orderRef = await anActiveOrder();
    await db.insert(oosReleaseFindings).values({ findingRef: `F-${Math.random().toString(36).slice(2, 9)}`, orderRef, finding: "not_satisfied", findingType: "repair_verification", recordedByUserId: 8, recordedByRole: "shop_lead", recordedAt: new Date(NOW.getTime() - 7_200_000) });
    await db.insert(oosReleaseFindings).values({ findingRef: `F-${Math.random().toString(36).slice(2, 9)}`, orderRef, finding: "satisfied", findingType: "reinspection", recordedByUserId: 9, recordedByRole: "safety", recordedAt: NOW });
    const r = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: null, at: NOW }));
    expect(r.released).toBe(true);
    expect(await db.select().from(oosReleaseFindings).where(eq(oosReleaseFindings.orderRef, orderRef))).toHaveLength(2);
  });
});

d("tests 26 and 27 — the two release races", () => {
  const repaired: RepairRecord[] = [{ workOrderRef: "WO-R", repairCompletedAt: NOW, repairCompletedByUserId: 4, functionalTestPassed: true, afterEvidenceRef: "EV-R" }];
  async function anActiveOrder() {
    const r = await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({
      violations: [violation({ outOfService: true, oosScope: "vehicle", repairRequired: true, releaseCondition: "reinspection passed" })],
    })));
    return r.orderRefs[0];
  }
  const finding = (orderRef: string, f: "satisfied" | "not_satisfied", recordedAt: Date) =>
    db.insert(oosReleaseFindings).values({ findingRef: `F-${Math.random().toString(36).slice(2, 10)}`, orderRef, finding: f, findingType: "reinspection", recordedByUserId: 8, recordedByRole: "safety", recordedAt });

  it("26 — resolves two findings recorded in the same second by insertion order, not by array luck", async () => {
    // A finding corrected immediately: same second, and the later row wins.
    const sameSecond = new Date("2026-09-11T12:00:00Z");
    const a = await anActiveOrder();
    await finding(a, "not_satisfied", sameSecond);
    await finding(a, "satisfied", sameSecond);
    const releases = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef: a, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: null, at: NOW }));
    expect(releases.released).toBe(true);

    // And the other way round: the later row is the refusal, so it refuses.
    const b = await anActiveOrder();
    await finding(b, "satisfied", sameSecond);
    await finding(b, "not_satisfied", sameSecond);
    const refuses = await db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef: b, repairs: repaired, releasedByUserId: 7, releaseEvidenceRef: null, at: NOW }));
    expect(refuses.released).toBe(false);
    expect((await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, b)))[0].status).toBe("active");
  });

  it("27 — tells exactly one of two simultaneous callers that they released it", async () => {
    const orderRef = await anActiveOrder();
    await finding(orderRef, "satisfied", NOW);

    const attempt = (userId: number) =>
      db.transaction((tx: never) => releaseOutOfServiceOrder(tx, { orderRef, repairs: repaired, releasedByUserId: userId, releaseEvidenceRef: `EV-${userId}`, at: NOW }));
    const [x, y] = await Promise.all([attempt(11), attempt(22)]);

    const released = [x, y].filter(r => r.released);
    expect(released).toHaveLength(1);
    const refused = [x, y].find(r => !r.released)!;
    if (!refused.released) expect(refused.reasons.join(" ")).toMatch(/already released|Another release completed first/i);

    // One row, one releaser — not two claims on the same order.
    const row = (await db.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)))[0];
    expect(row.status).toBe("released");
    expect([11, 22]).toContain(row.releasedByUserId);
  });

  it("treats an unreadable affected-row count as zero rather than claiming a release", () => {
    expect(affectedRows({ affectedRows: 1 })).toBe(1);
    expect(affectedRows([{ affectedRows: 1 }])).toBe(1);
    expect(affectedRows({ rowsAffected: 1 })).toBe(1);
    // The important one: cannot tell means no.
    expect(affectedRows(undefined)).toBe(0);
    expect(affectedRows({ something: "else" })).toBe(0);
  });
});
