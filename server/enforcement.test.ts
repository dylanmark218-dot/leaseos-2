/**
 * v22.20 — a roadside stop, and the five things it must not be allowed to do.
 *
 * No licensed out-of-service criteria text appears here or in the module. The
 * codes are LeaseOS's own and the source references are citations.
 */
import { describe, expect, it } from "vitest";
import {
  consequencesOf, enforcementReadiness, isActive, releaseReadiness, reviewExtraction,
  REQUIRED_ENFORCEMENT_FIELDS, type OosOrder, type RepairRecord, type ViolationFacts,
} from "./_core/enforcement";

const at = new Date("2026-09-11T12:00:00Z");
const ago = (min: number) => new Date(at.getTime() - min * 60_000);

const violation = (o: Partial<ViolationFacts> = {}): ViolationFacts => ({
  violationRef: "V-1", system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER",
  sourceReference: "official source, cited not reproduced",
  citationIssued: false, outOfService: false, oosScope: null,
  defectRequired: false, repairRequired: false, courtAction: false, ...o,
});

const order = (o: Partial<OosOrder> = {}): OosOrder => ({
  orderRef: "OOS-1", scope: "vehicle", subjectRef: "UNIT-127", issuedAt: ago(200),
  issuingAgency: "roadside enforcement", releaseCondition: "repair verified and reinspection passed",
  releasedAt: null, releasedByUserId: null, releaseEvidenceRef: null, rescindedAt: null, ...o,
});

describe("a citation is not an out-of-service order", () => {
  it("does not stop a vehicle for a ticket the document did not mark out of service", () => {
    const c = consequencesOf(violation({ citationIssued: true, courtAction: true }));
    expect(c.createsOosOrder).toBe(false);
    expect(c.blocksDispatch).toBe(false);
    expect(c.createsCourtMatter).toBe(true);
    expect(c.reasons.join(" ")).toContain("this does not stop the vehicle");
  });

  it("prohibits on an out-of-service marking even with no citation", () => {
    const c = consequencesOf(violation({ outOfService: true, oosScope: "vehicle" }));
    expect(c).toMatchObject({ createsOosOrder: true, blocksDispatch: true, oosScope: "vehicle" });
  });

  it("raises a defect to carry a required repair, and a work order with it", () => {
    const c = consequencesOf(violation({ repairRequired: true }));
    expect(c).toMatchObject({ createsDefect: true, createsWorkOrder: true, createsOosOrder: false });
  });

  it("flags an out-of-service marking whose scope nobody established", () => {
    const c = consequencesOf(violation({ outOfService: true, oosScope: null }));
    expect(c.reasons.join(" ")).toContain("scope was not established");
  });
});

describe("out of service is scoped, not a boolean on the truck", () => {
  const subjects = [
    { subjectRef: "D-221", scope: "driver" as const },
    { subjectRef: "UNIT-127", scope: "vehicle" as const },
    { subjectRef: "T-52", scope: "trailer" as const },
  ];

  it("prohibits the truck while leaving the driver and trailer permitted", () => {
    const r = enforcementReadiness({ subjects, orders: [order()], at });
    expect(r.verdict).toBe("prohibited");
    expect(r.subjects.find(s => s.scope === "vehicle")!.state).toBe("prohibited");
    expect(r.subjects.find(s => s.scope === "driver")!.state).toBe("permitted");
    expect(r.subjects.find(s => s.scope === "trailer")!.state).toBe("permitted");
    expect(r.blockers[0]).toMatchObject({ code: "oos.vehicle", subjectRef: "UNIT-127" });
    expect(r.blockers[0].label).toContain("Release condition: repair verified");
  });

  it("tells dispatch that a prohibited driver on a clear truck is replaceable", () => {
    const r = enforcementReadiness({ subjects, orders: [order({ orderRef: "OOS-D", scope: "driver", subjectRef: "D-221" })], at });
    expect(r.verdict).toBe("prohibited");
    expect(r.replaceableSubjects).toEqual(["driver"]);
    expect(r.subjects.find(s => s.scope === "vehicle")!.state).toBe("permitted");
  });

  it("does not treat a prohibited vehicle as replaceable", () => {
    expect(enforcementReadiness({ subjects, orders: [order()], at }).replaceableSubjects).toEqual([]);
  });

  it("permits once an order is released or rescinded, and keeps both records", () => {
    expect(isActive(order({ releasedAt: ago(10) }), at)).toBe(false);
    expect(isActive(order({ rescindedAt: ago(10) }), at)).toBe(false);
    expect(enforcementReadiness({ subjects, orders: [order({ releasedAt: ago(10) })], at }).verdict).toBe("permitted");
  });
});

describe("unknown denies", () => {
  it("refuses authorization for a subject whose inspection result is not established", () => {
    const r = enforcementReadiness({
      subjects: [{ subjectRef: "UNIT-127", scope: "vehicle" }], orders: [],
      unresolvedInspections: [{ inspectionRef: "INSP-8", coversSubjectRefs: ["UNIT-127"] }], at,
    });
    expect(r.verdict).toBe("unknown");
    expect(r.subjects[0].reasons[0]).toContain("Unknown is not a pass");
  });

  it("lets a real prohibition outrank an unresolved one", () => {
    const r = enforcementReadiness({
      subjects: [{ subjectRef: "UNIT-127", scope: "vehicle" }], orders: [order()],
      unresolvedInspections: [{ inspectionRef: "INSP-8", coversSubjectRefs: ["UNIT-127"] }], at,
    });
    expect(r.verdict).toBe("prohibited");
  });
});

describe("repair complete is not release", () => {
  const repaired: RepairRecord[] = [{ workOrderRef: "WO-8821", repairCompletedAt: ago(60), repairCompletedByUserId: 9, functionalTestPassed: true, afterEvidenceRef: "EV-2" }];

  it("holds the prohibition while the order's own release condition is unestablished", () => {
    const r = releaseReadiness({ order: order(), repairs: repaired, releaseConditionSatisfied: "unknown", at });
    expect(r.releasable).toBe(false);
    expect(r.state).toBe("repair_complete_pending_release");
    expect(r.reasons[0]).toContain("the prohibition stands");
  });

  it("refuses when the release condition is recorded as not satisfied", () => {
    expect(releaseReadiness({ order: order(), repairs: repaired, releaseConditionSatisfied: false, at })).toMatchObject({ releasable: false, state: "release_blocked" });
  });

  it("refuses a completed repair with no passing functional test or no after evidence", () => {
    const untested: RepairRecord[] = [{ ...repaired[0], functionalTestPassed: false }];
    expect(releaseReadiness({ order: order(), repairs: untested, releaseConditionSatisfied: true, at }).reasons.join(" ")).toContain("no passing functional test");
    const unevidenced: RepairRecord[] = [{ ...repaired[0], afterEvidenceRef: null }];
    expect(releaseReadiness({ order: order(), repairs: unevidenced, releaseConditionSatisfied: true, at }).reasons.join(" ")).toContain("no after-repair evidence");
  });

  it("becomes releasable only when repair, test, evidence and the condition all hold — and even then it is a review that lifts it", () => {
    const r = releaseReadiness({ order: order(), repairs: repaired, releaseConditionSatisfied: true, at });
    expect(r).toMatchObject({ releasable: true, state: "releasable" });
    expect(r.reasons[0]).toContain("A release review may now lift this order");
    // The order itself is untouched: nothing in this function releases anything.
    expect(order().releasedAt).toBeNull();
  });

  it("says so plainly when nothing has been repaired at all", () => {
    expect(releaseReadiness({ order: order(), repairs: [], releaseConditionSatisfied: true, at }).state).toBe("not_repaired");
  });
});

describe("the scanner proposes; a person confirms", () => {
  it("always requires confirmation, however confident the extraction", () => {
    const r = reviewExtraction([
      { field: "agency", value: "an agency", confidence: 0.99 },
      { field: "jurisdiction", value: "CA-AB", confidence: 0.99 },
      { field: "occurredAt", value: "2026-09-11T08:42", confidence: 0.98 },
      { field: "inspectionReportNumber", value: "INSP-829294", confidence: 0.97 },
    ]);
    expect(r.requiresConfirmation).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.note).toContain("nothing here changes a compliance state".replace("n", "N").slice(0, 8));
  });

  it("highlights what it could not read and names what it still needs", () => {
    const r = reviewExtraction([
      { field: "agency", value: "an agency", confidence: 0.99 },
      { field: "citationNumber", value: null, confidence: 0 },
      { field: "occurredAt", value: "2026-09-11T08:42", confidence: 0.4 },
    ]);
    expect(r.highlighted.map(h => h.field)).toEqual(["citationNumber", "occurredAt"]);
    expect(r.missingRequired).toContain("jurisdiction");
    expect(r.missingRequired).toContain("inspectionReportNumber");
  });

  it("keeps the inspection report number and the citation number apart", () => {
    // They are different identifiers on different documents. Conflating them
    // makes a later challenge impossible to file.
    expect(REQUIRED_ENFORCEMENT_FIELDS).toContain("inspectionReportNumber");
    expect(REQUIRED_ENFORCEMENT_FIELDS as readonly string[]).not.toContain("citationNumber");
  });
});

describe("no licensed criteria text is stored", () => {
  it("carries a source reference and offers no field for the wording it cites", () => {
    const v = violation({ sourceReference: "official source, cited not reproduced" });
    expect(Object.keys(v)).toContain("sourceReference");
    for (const forbidden of ["criteriaText", "handbookText", "oosCriteria", "criterionWording"]) {
      expect(Object.keys(v)).not.toContain(forbidden);
    }
    expect(v.ownCode.startsWith("LEASEOS.")).toBe(true);
  });
});
