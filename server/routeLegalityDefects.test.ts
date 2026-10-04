/**
 * T2 — defect 1A: the evaluator must apply the CONTROLLING limit for a check, not the first one
 * listed.
 *
 * "Controlling" means the most restrictive of the limits that actually apply. Evidence is
 * comparable only when it is for the same check, on this segment, in force now, for this vehicle,
 * in a unit the check understands. That applicability is decided upstream: the router passes only
 * date-windowed, non-superseded rows recorded against the segment. Among what reaches the
 * evaluator, a lower-authority source may TIGHTEN a limit (`sourcePrecedence`'s asymmetric rule)
 * and never loosen one. So the worst result governs, and among equal results the tightest limit.
 *
 * These tests were written against the untouched baseline (main @ c3f088b) and failed there. The
 * captured failures are in docs/transport/checkpoints/T2_COMMERCIAL_ROUTE_LEGALITY.md.
 */
import { describe, expect, it } from "vitest";
import { evaluateRoute, type RoadSegmentInput, type SegmentAttribute, type VehicleValues } from "./_core/routeEvaluation";

const vehicle = (over: Partial<VehicleValues> = {}): VehicleValues => ({
  grossWeightKg: 30_000, maxAxleGroupKg: 9_000, heightM: 4.0, widthM: 2.6, lengthM: 20,
  dangerousGoods: false, requiresEscort: false, ...over,
});
const verified = (a: Omit<SegmentAttribute, "confidence">): SegmentAttribute => ({ confidence: "authority_confirmed", jurisdiction: "AB", source: "fixture", ...a });
const segment = (attributes: SegmentAttribute[]): RoadSegmentInput => ({ segmentId: "S1", label: "Fixture Road", lengthKm: 5, attributes });

describe("defect 1A — a looser limit listed first must not mask a tighter applicable one", () => {
  it("blocks a 4.5 m vehicle under a 4.2 m structure clearance even when a 5.0 m road clearance is listed first", () => {
    const v = evaluateRoute(["overhead_clearance"], [segment([
      verified({ check: "overhead_clearance", limitValue: 5.0, source: "road restriction" }),
      verified({ check: "overhead_clearance", limitValue: 4.2, source: "structure: overpass" }),
    ])], vehicle({ heightM: 4.5 }));
    expect(v.legal === "fail" || v.physicallyFeasible === "fail").toBe(true);
    expect(v.dispatchStatus).toBe("blocked");
    const governing = v.evidence.find(e => e.check === "overhead_clearance")!;
    expect(governing.inputs.limitValue).toBe(4.2);
  });

  it("blocks a 50,000 kg vehicle on a 45,000 kg bridge even when a 63,500 kg bridge figure is listed first", () => {
    const v = evaluateRoute(["bridge_capacity"], [segment([
      verified({ check: "bridge_capacity", limitValue: 63_500, source: "bridges table" }),
      verified({ check: "bridge_capacity", limitValue: 45_000, source: "structure: B-123" }),
    ])], vehicle({ grossWeightKg: 50_000 }));
    expect(v.dispatchStatus).toBe("blocked");
    expect(v.evidence.find(e => e.check === "bridge_capacity")!.inputs.limitValue).toBe(45_000);
  });

  it("blocks on a recorded 45,000 kg bridge limit even when the caller asked only about the 63,500 kg road gross limit", () => {
    // Road gross and bridge gross are separate checks. A recorded bridge limit on the segment is
    // evidence about this vehicle on this road whether or not the caller listed the check.
    const v = evaluateRoute(["road_weight_restriction"], [segment([
      verified({ check: "road_weight_restriction", limitValue: 63_500 }),
      verified({ check: "bridge_capacity", limitValue: 45_000, source: "structure: B-123" }),
    ])], vehicle({ grossWeightKg: 50_000 }));
    expect(v.dispatchStatus).toBe("blocked");
    expect(v.evidence.some(e => e.check === "bridge_capacity" && e.result === "fail")).toBe(true);
  });

  it("lets a tighter unverified limit tighten a looser verified one, but never the reverse", () => {
    // Lower authority may tighten: an operator's 4.0 m measurement under a verified 4.6 m posting fails a 4.3 m vehicle.
    const tightened = evaluateRoute(["overhead_clearance"], [segment([
      verified({ check: "overhead_clearance", limitValue: 4.6 }),
      { check: "overhead_clearance", limitValue: 4.0, confidence: "operator_supplied", source: "driver measurement" },
    ])], vehicle({ heightM: 4.3 }));
    expect(tightened.dispatchStatus).toBe("blocked");
    // And may not loosen: an unverified 5.5 m figure does not lift a verified 4.2 m limit.
    const notLoosened = evaluateRoute(["overhead_clearance"], [segment([
      { check: "overhead_clearance", limitValue: 5.5, confidence: "unverified", source: "map data" },
      verified({ check: "overhead_clearance", limitValue: 4.2 }),
    ])], vehicle({ heightM: 4.5 }));
    expect(notLoosened.dispatchStatus).toBe("blocked");
  });

  it("does not compare limits recorded in a unit the check does not understand — that evidence is UNKNOWN, not passed", () => {
    const v = evaluateRoute(["road_weight_restriction"], [segment([
      verified({ check: "road_weight_restriction", limitValue: 40, unit: "t" }),
    ])], vehicle({ grossWeightKg: 50_000 }));
    expect(v.legal).toBe("unknown");
    expect(v.dispatchStatus).not.toBe("clear");
  });

  it("still passes when every applicable limit is satisfied, citing the controlling one", () => {
    const v = evaluateRoute(["overhead_clearance"], [segment([
      verified({ check: "overhead_clearance", limitValue: 5.0 }),
      verified({ check: "overhead_clearance", limitValue: 4.6 }),
    ])], vehicle({ heightM: 4.1 }));
    expect(v.legal).toBe("pass");
    expect(v.physicallyFeasible).toBe("pass");
    expect(v.evidence.find(e => e.check === "overhead_clearance")!.inputs.limitValue).toBe(4.6);
  });
});
