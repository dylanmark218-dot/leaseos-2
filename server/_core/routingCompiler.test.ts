import { describe, expect, it } from "vitest";
import {
  compileConstraintProfile,
  isProfileStale,
  type CompilerInput,
} from "./routingCompiler";
import {
  CARGO,
  DEFAULT_THRESHOLDS,
  TRAILERS,
  TRUCKS,
  type RegulatoryThresholds,
} from "./taxonomy";

const CONFIRMED: RegulatoryThresholds = {
  ...DEFAULT_THRESHOLDS,
  jurisdiction: "AB",
  source: "Provincial permit office",
  lastVerified: "2026-08-01",
  confidence: "authority_confirmed",
};

const VAC: CompilerInput = {
  truck: TRUCKS["TRK-TRIDEM-VAC"],
  cargo: CARGO["OIL-PRODUCED-WATER"],
  cargoWeightKg: 16000,
  environments: ["oilfield_lease", "gravel"],
  jurisdiction: "AB",
  thresholds: CONFIRMED,
};

describe("compileConstraintProfile — determinism (gate 1)", () => {
  it("produces the same id for the same classification", () => {
    expect(compileConstraintProfile(VAC).routeProfileId).toBe(
      compileConstraintProfile(VAC).routeProfileId
    );
  });

  it("is insensitive to the order environments are listed in", () => {
    const a = compileConstraintProfile({
      ...VAC,
      environments: ["oilfield_lease", "gravel"],
    });
    const b = compileConstraintProfile({
      ...VAC,
      environments: ["gravel", "oilfield_lease"],
    });
    expect(a.routeProfileId).toBe(b.routeProfileId);
  });

  it("changes the id when the load changes", () => {
    const a = compileConstraintProfile(VAC);
    const b = compileConstraintProfile({ ...VAC, cargoWeightKg: 18000 });
    expect(a.routeProfileId).not.toBe(b.routeProfileId);
  });

  it("changes the id when the cargo classification changes", () => {
    const a = compileConstraintProfile(VAC);
    const b = compileConstraintProfile({ ...VAC, cargo: CARGO["OIL-CRUDE"] });
    expect(a.routeProfileId).not.toBe(b.routeProfileId);
  });
});

describe("compileConstraintProfile — check subtraction (gate 2)", () => {
  it("emits only the checks this load needs", () => {
    const p = compileConstraintProfile(VAC);
    expect(p.requiredChecks).toEqual(
      expect.arrayContaining([
        "road_weight_restriction",
        "axle_group_limit",
        "bridge_capacity",
        "seasonal_closure",
        "lease_gate_access",
        "turnaround_suitability",
        "surface_condition",
      ])
    );
    expect(p.requiredChecks).not.toContain("dg_corridor");
    expect(p.requiredChecks).not.toContain("width_restriction");
    expect(p.requiredChecks).not.toContain("school_zone_timing");
  });

  it("adds dangerous goods checks when the cargo is hazardous", () => {
    const p = compileConstraintProfile({ ...VAC, cargo: CARGO["OIL-CRUDE"] });
    expect(p.cargo.dangerousGoods).toBe(true);
    expect(p.cargo.unNumber).toBe("UN1267");
    expect(p.requiredChecks).toEqual(
      expect.arrayContaining(["dg_corridor", "dg_time_restriction"])
    );
  });

  it("adds only the dimension actually exceeded", () => {
    const p = compileConstraintProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargo: CARGO["HVY-EXCAVATOR"],
      cargoWeightKg: 32000,
      loadedWidthM: 3.4,
      loadedHeightM: 4.0,
      jurisdiction: "AB",
      thresholds: CONFIRMED,
    });
    expect(p.requiredChecks).toContain("width_restriction");
    expect(p.requiredChecks).not.toContain("length_restriction");
  });

  it("keeps a simple highway run to a small check set", () => {
    const p = compileConstraintProfile({
      truck: TRUCKS["TRK-TANDEM"],
      cargoWeightKg: 8000,
      environments: ["highway"],
      jurisdiction: "AB",
      thresholds: CONFIRMED,
    });
    expect(p.requiredChecks.length).toBeLessThan(8);
    expect(p.requiredChecks).not.toContain("lease_gate_access");
  });
});

describe("compileConstraintProfile — dispatch status", () => {
  it("blocks on a group modelled past its manufacturer rating", () => {
    const p = compileConstraintProfile({
      truck: TRUCKS["TRK-TANDEM"],
      cargoWeightKg: 40000,
      jurisdiction: "AB",
      thresholds: CONFIRMED,
    });
    expect(p.dispatchStatus).toBe("blocked");
  });

  it("warns whenever regulatory thresholds are unverified (gate 3)", () => {
    const p = compileConstraintProfile({
      ...VAC,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(p.regulatoryConfidence).toBe("unverified");
    expect(p.dispatchStatus).toBe("warning");
  });

  it("routes an oversize load to review rather than clear", () => {
    const p = compileConstraintProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargo: CARGO["HVY-EXCAVATOR"],
      cargoWeightKg: 24000,
      loadedWidthM: 3.4,
      loadedHeightM: 4.0,
      loadedLengthM: 22,
      jurisdiction: "AB",
      thresholds: CONFIRMED,
    });
    expect(p.dispatchStatus).toBe("review");
  });

  it("carries unknowns through to the profile rather than defaulting them", () => {
    const p = compileConstraintProfile({
      truck: TRUCKS["TRK-TANDEM"],
      jurisdiction: "AB",
      thresholds: CONFIRMED,
    });
    expect(p.unknowns.join(" ")).toContain("Cargo weight not established");
    expect(p.dispatchStatus).toBe("warning");
  });
});

describe("isProfileStale (gate 9)", () => {
  it("holds a stored route valid while the classification is unchanged", () => {
    const id = compileConstraintProfile(VAC).routeProfileId;
    expect(isProfileStale(id, VAC)).toBe(false);
  });

  it("invalidates the stored route when the load weight changes", () => {
    const id = compileConstraintProfile(VAC).routeProfileId;
    expect(isProfileStale(id, { ...VAC, cargoWeightKg: 19000 })).toBe(true);
  });

  it("invalidates when the operating environment changes", () => {
    const id = compileConstraintProfile(VAC).routeProfileId;
    expect(isProfileStale(id, { ...VAC, environments: ["highway"] })).toBe(
      true
    );
  });

  it("invalidates when the regulatory thresholds are replaced", () => {
    const id = compileConstraintProfile(VAC).routeProfileId;
    expect(isProfileStale(id, { ...VAC, thresholds: DEFAULT_THRESHOLDS })).toBe(
      true
    );
  });
});
