import { describe, expect, it } from "vitest";
import {
  assessDatasetFreshness,
  evaluateRoute,
  reproduceVerdict,
  type RoadSegmentInput,
  type VehicleValues,
} from "./routeEvaluation";

const VEHICLE: VehicleValues = {
  grossWeightKg: 33500,
  maxAxleGroupKg: 22000,
  heightM: 4.05,
  widthM: 2.59,
  lengthM: 11.6,
  dangerousGoods: false,
  requiresEscort: false,
};

const verified = {
  jurisdiction: "AB",
  source: "AB Transportation",
  sourceVersion: "2026.3",
  verifiedAt: "2026-08-01",
  confidence: "authority_confirmed" as const,
};

const GOOD_SEGMENT: RoadSegmentInput = {
  segmentId: "SEG-101",
  label: "Hwy 40 north",
  lengthKm: 24,
  attributes: [
    { check: "road_weight_restriction", limitValue: 63500, ...verified },
    { check: "bridge_capacity", limitValue: 55000, ...verified },
    { check: "bridge_clearance", limitValue: 5.2, ...verified },
  ],
};

const CHECKS = [
  "road_weight_restriction",
  "bridge_capacity",
  "bridge_clearance",
] as const;

describe("unknown is never treated as clear (gate 4)", () => {
  it("returns unknown when the map holds no attribute at all", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-9",
      label: "Lease Rd 7A",
      lengthKm: 6,
      attributes: [],
    };
    const v = evaluateRoute([...CHECKS], [seg], VEHICLE);
    expect(v.unknownCount).toBe(3);
    expect(v.evidence.every(e => e.result === "unknown")).toBe(true);
  });

  it("returns unknown when an attribute exists but records no limit", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-10",
      label: "Rge Rd 284",
      lengthKm: 4,
      attributes: [{ check: "bridge_capacity", limitValue: null, ...verified }],
    };
    const v = evaluateRoute(["bridge_capacity"], [seg], VEHICLE);
    expect(v.evidence[0].result).toBe("unknown");
    expect(v.evidence[0].reason).toContain("no recorded");
  });

  it("never returns clear while any required check is unknown", () => {
    const partial: RoadSegmentInput = {
      ...GOOD_SEGMENT,
      attributes: GOOD_SEGMENT.attributes.filter(
        a => a.check !== "bridge_clearance"
      ),
    };
    const v = evaluateRoute([...CHECKS], [partial], VEHICLE);
    expect(v.unknownCount).toBe(1);
    expect(v.dispatchStatus).not.toBe("clear");
  });

  it("does not let a neighbouring pass absorb an unknown on the same axis", () => {
    const mixed: RoadSegmentInput = {
      segmentId: "SEG-11",
      label: "Mixed",
      lengthKm: 3,
      attributes: [
        { check: "road_weight_restriction", limitValue: 63500, ...verified },
        { check: "bridge_capacity", limitValue: null, ...verified },
      ],
    };
    const v = evaluateRoute(
      ["road_weight_restriction", "bridge_capacity"],
      [mixed],
      VEHICLE
    );
    expect(v.legal).toBe("unknown");
  });
});

describe("four separate axes (gate 5)", () => {
  it("clears a fully evidenced route", () => {
    const v = evaluateRoute([...CHECKS], [GOOD_SEGMENT], VEHICLE);
    expect(v.legal).toBe("pass");
    expect(v.physicallyFeasible).toBe("pass");
    expect(v.dispatchStatus).toBe("clear");
    expect(v.explanation).toContain("All 3 required checks passed");
  });

  it("separates a legal failure from a physical one", () => {
    const overweight = evaluateRoute(["bridge_capacity"], [GOOD_SEGMENT], {
      ...VEHICLE,
      grossWeightKg: 60000,
    });
    expect(overweight.legal).toBe("fail");
    expect(overweight.physicallyFeasible).toBe("pass");

    const tooTall = evaluateRoute(["bridge_clearance"], [GOOD_SEGMENT], {
      ...VEHICLE,
      heightM: 5.6,
    });
    expect(tooTall.physicallyFeasible).toBe("fail");
    expect(tooTall.legal).toBe("pass");
  });

  it("keeps a legal-but-unpleasant road out of the legal axis", () => {
    const gravel: RoadSegmentInput = {
      segmentId: "SEG-20",
      label: "Rge Rd 12",
      lengthKm: 18,
      attributes: [
        { check: "surface_condition", textValue: "gravel", ...verified },
      ],
    };
    const v = evaluateRoute(["surface_condition"], [gravel], VEHICLE);
    expect(v.legal).toBe("pass");
    expect(v.operationallyPreferred).toBe("pass");
    expect(v.evidence[0].axis).toBe("preferred");
  });

  it("blocks dangerous goods on a prohibited corridor", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-30",
      label: "Memorial Dr",
      lengthKm: 5,
      attributes: [
        { check: "dg_corridor", textValue: "prohibited", ...verified },
      ],
    };
    const v = evaluateRoute(["dg_corridor"], [seg], {
      ...VEHICLE,
      dangerousGoods: true,
    });
    expect(v.dispatchStatus).toBe("blocked");
    expect(v.explanation).toContain("Dangerous goods not permitted");
  });

  it("treats a seasonal closure as a legal failure", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-40",
      label: "Rge Rd 284",
      lengthKm: 9,
      attributes: [
        { check: "seasonal_closure", textValue: "closed", ...verified },
      ],
    };
    expect(evaluateRoute(["seasonal_closure"], [seg], VEHICLE).legal).toBe(
      "fail"
    );
  });
});

describe("evidence and explanation", () => {
  it("records source, version and verification date on every entry", () => {
    const v = evaluateRoute([...CHECKS], [GOOD_SEGMENT], VEHICLE);
    for (const e of v.evidence) {
      expect(e.source).toBe("AB Transportation");
      expect(e.sourceVersion).toBe("2026.3");
      expect(e.verifiedAt).toBe("2026-08-01");
      expect(e.jurisdiction).toBe("AB");
    }
  });

  it("stores the arithmetic, not just the outcome", () => {
    const v = evaluateRoute(["bridge_capacity"], [GOOD_SEGMENT], VEHICLE);
    expect(v.evidence[0].inputs).toEqual({
      vehicleValue: 33500,
      limitValue: 55000,
      unit: "kg",
    });
  });

  it("explains a refusal with the actual numbers and segment", () => {
    const v = evaluateRoute(["bridge_capacity"], [GOOD_SEGMENT], {
      ...VEHICLE,
      grossWeightKg: 60000,
    });
    expect(v.explanation).toContain(
      "60000 kg exceeds 55000 kg on Hwy 40 north"
    );
  });

  it("states plainly that unknown is not clear", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-50",
      label: "Unknown Rd",
      lengthKm: 2,
      attributes: [],
    };
    expect(
      evaluateRoute(["bridge_capacity"], [seg], VEHICLE).explanation
    ).toContain("unknown is not treated as clear");
  });

  it("raises the unverified-data warning verbatim", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-60",
      label: "Rge Rd 55",
      lengthKm: 7,
      attributes: [
        {
          check: "bridge_capacity",
          limitValue: 55000,
          source: "Driver report",
          confidence: "unverified",
          jurisdiction: "AB",
          sourceVersion: null,
          verifiedAt: null,
        },
      ],
    };
    const v = evaluateRoute(["bridge_capacity"], [seg], VEHICLE);
    expect(v.dataConfidence).toBe("unverified");
    expect(v.explanation).toContain(
      "ROUTING WARNING — regulatory data unverified"
    );
  });

  it("does not pass a satisfied limit that rests on unverified data", () => {
    const seg: RoadSegmentInput = {
      segmentId: "SEG-61",
      label: "Rge Rd 56",
      lengthKm: 7,
      attributes: [
        {
          check: "bridge_capacity",
          limitValue: 55000,
          source: "Driver report",
          confidence: "unverified",
          jurisdiction: "AB",
          sourceVersion: null,
          verifiedAt: null,
        },
      ],
    };
    expect(
      evaluateRoute(["bridge_capacity"], [seg], VEHICLE).evidence[0].result
    ).toBe("review");
  });
});

describe("reproduceVerdict (gate 7)", () => {
  it("recomputes the same verdict from the stored ledger alone", () => {
    const original = evaluateRoute([...CHECKS], [GOOD_SEGMENT], VEHICLE);
    const replay = reproduceVerdict(original.evidence);
    expect(replay.legal).toBe(original.legal);
    expect(replay.physicallyFeasible).toBe(original.physicallyFeasible);
    expect(replay.dispatchStatus).toBe(original.dispatchStatus);
    expect(replay.explanation).toBe(original.explanation);
  });

  it("reproduces a blocked decision years later without the original map", () => {
    const original = evaluateRoute(["bridge_capacity"], [GOOD_SEGMENT], {
      ...VEHICLE,
      grossWeightKg: 60000,
    });
    const replay = reproduceVerdict(original.evidence);
    expect(replay.dispatchStatus).toBe("blocked");
    expect(replay.explanation).toContain("60000 kg exceeds 55000 kg");
  });
});

describe("assessDatasetFreshness (gate 8)", () => {
  const snap = {
    datasetVersion: "AB-2026.3",
    jurisdiction: "AB",
    capturedAt: new Date(Date.UTC(2026, 7, 1)),
    staleAfterDays: 30,
  };

  it("reports a fresh dataset with its age", () => {
    const f = assessDatasetFreshness(snap, new Date(Date.UTC(2026, 7, 5)));
    expect(f.state).toBe("fresh");
    expect(f.ageDays).toBe(4);
    expect(f.message).toContain("4 days old");
  });

  it("flags an aging dataset before it goes stale", () => {
    expect(
      assessDatasetFreshness(snap, new Date(Date.UTC(2026, 7, 21))).state
    ).toBe("aging");
  });

  it("says plainly that a stale dataset may have changed", () => {
    const f = assessDatasetFreshness(snap, new Date(Date.UTC(2026, 8, 10)));
    expect(f.state).toBe("stale");
    expect(f.message).toContain("Restrictions may have changed");
  });

  it("always names the dataset version, so age is never anonymous", () => {
    expect(
      assessDatasetFreshness(snap, new Date(Date.UTC(2026, 7, 3))).message
    ).toContain("AB-2026.3");
  });
});
