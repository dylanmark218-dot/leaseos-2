import { describe, expect, it } from "vitest";
import {
  CARGO,
  DEFAULT_THRESHOLDS,
  deriveRequirements,
  deriveRoutingProfile,
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

describe("deriveRoutingProfile", () => {
  it("builds axle groups across truck and trailer", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-SUPER-B"],
      cargoWeightKg: 38000,
      thresholds: CONFIRMED,
    });
    expect(p.totalAxles).toBe(8);
    expect(p.axleGroups.map(g => g.position)).toEqual([
      "steer",
      "drive",
      "trailer",
      "trailer",
    ]);
  });

  it("puts no cargo on the steer axle", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-TANKER-TANDEM"],
      cargoWeightKg: 30000,
      thresholds: CONFIRMED,
    });
    const steer = p.axleGroups.find(g => g.position === "steer")!;
    const drive = p.axleGroups.find(g => g.position === "drive")!;
    expect(steer.loadedKg).toBeLessThan(drive.loadedKg);
  });

  it("flags a group modelled above its manufacturer rating", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TANDEM"],
      cargoWeightKg: 40000,
      thresholds: CONFIRMED,
    });
    expect(p.axleGroups.some(g => g.exceedsRating)).toBe(true);
    expect(p.warnings.join(" ")).toContain("above its");
  });

  it("detects oversize by width and adds only the layers that apply", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargo: CARGO["HVY-EXCAVATOR"],
      cargoWeightKg: 32000,
      loadedWidthM: 3.4,
      loadedHeightM: 4.0,
      thresholds: CONFIRMED,
    });
    expect(p.isOversize).toBe(true);
    expect(p.requiresPermit).toBe(true);
    expect(p.restrictionLayers).toContain("width");
    expect(p.restrictionLayers).toContain("oversize_corridor");
    expect(p.restrictionLayers).not.toContain("height");
  });

  it("adds the dangerous goods layer only for hazardous cargo", () => {
    const base = {
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-TANKER-TANDEM"],
      cargoWeightKg: 30000,
      thresholds: CONFIRMED,
    };
    expect(
      deriveRoutingProfile({ ...base, cargo: CARGO["OIL-PRODUCED-WATER"] })
        .restrictionLayers
    ).not.toContain("dangerous_goods");
    expect(
      deriveRoutingProfile({ ...base, cargo: CARGO["OIL-CRUDE"] })
        .restrictionLayers
    ).toContain("dangerous_goods");
  });

  it("adds lease access and turnaround layers for oilfield work", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRIDEM-VAC"],
      cargo: CARGO["OIL-PRODUCED-WATER"],
      cargoWeightKg: 16000,
      environments: ["oilfield_lease", "gravel"],
      thresholds: CONFIRMED,
    });
    expect(p.restrictionLayers).toEqual(
      expect.arrayContaining([
        "lease_access",
        "turnaround_capability",
        "gravel_surface",
        "seasonal_road_ban",
      ])
    );
  });

  it("reports an unestablished cargo weight instead of modelling zero silently", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TANDEM"],
      thresholds: CONFIRMED,
    });
    expect(p.unknowns.join(" ")).toContain("Cargo weight not established");
  });

  it("warns that loaded height is unmeasured when a trailer is attached", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargoWeightKg: 20000,
      thresholds: CONFIRMED,
    });
    expect(p.unknowns.join(" ")).toContain("Loaded height not measured");
  });

  it("warns loudly when thresholds have not been confirmed with an authority", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TANDEM"],
      cargoWeightKg: 5000,
    });
    expect(p.thresholds.confidence).toBe("unverified");
    expect(p.warnings.join(" ")).toContain("unverified");
  });

  it("does not warn about thresholds once they are authority-confirmed", () => {
    const p = deriveRoutingProfile({
      truck: TRUCKS["TRK-TANDEM"],
      cargoWeightKg: 5000,
      thresholds: CONFIRMED,
    });
    expect(p.warnings.join(" ")).not.toContain("unverified");
  });

  it("raises escort review only well beyond the oversize trigger", () => {
    const near = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargoWeightKg: 30000,
      loadedWidthM: 2.9,
      thresholds: CONFIRMED,
    });
    const far = deriveRoutingProfile({
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargoWeightKg: 30000,
      loadedWidthM: 4.2,
      thresholds: CONFIRMED,
    });
    expect(near.requiresEscortReview).toBe(false);
    expect(far.requiresEscortReview).toBe(true);
    expect(far.restrictionLayers).toContain("escort_route");
  });
});

describe("deriveRequirements", () => {
  it("derives a full oilfield vacuum haul from one classification", () => {
    const r = deriveRequirements({
      service: "oilfield",
      truck: TRUCKS["TRK-TRIDEM-VAC"],
      cargo: CARGO["OIL-PRODUCED-WATER"],
      cargoWeightKg: 16000,
      environments: ["oilfield_lease", "gravel"],
      thresholds: CONFIRMED,
    });
    expect(r.licenceClass).toBe("Class 3 / D");
    expect(r.safetyTickets).toEqual(
      expect.arrayContaining(["H2S Alive", "Site orientation"])
    );
    expect(r.ppe).toEqual(
      expect.arrayContaining(["FR coveralls", "Gas monitor"])
    );
    expect(r.documents).toContain("Field ticket");
    expect(r.inspectionItems).toEqual(
      expect.arrayContaining(["Pump / PTO", "Tank and valves"])
    );
    expect(r.billingUnits).toEqual(
      expect.arrayContaining(["Standby", "Per load"])
    );
  });

  it("requires Class 1 as soon as a trailer is attached", () => {
    const straight = deriveRequirements({
      service: "oilfield",
      truck: TRUCKS["TRK-TRIDEM-VAC"],
      cargoWeightKg: 10000,
      thresholds: CONFIRMED,
    });
    const combo = deriveRequirements({
      service: "tanker",
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-SUPER-B"],
      cargoWeightKg: 38000,
      thresholds: CONFIRMED,
    });
    expect(straight.licenceClass).toBe("Class 3 / D");
    expect(combo.licenceClass).toBe("Class 1 / A");
  });

  it("pulls in TDG requirements from the cargo, not the job title", () => {
    const r = deriveRequirements({
      service: "tanker",
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-TANKER-TANDEM"],
      cargo: CARGO["OIL-CRUDE"],
      cargoWeightKg: 30000,
      thresholds: CONFIRMED,
    });
    expect(r.endorsements).toContain("TDG certification");
    expect(r.documents).toEqual(
      expect.arrayContaining([
        "Shipping document",
        "Emergency response information",
      ])
    );
    expect(r.inspectionItems).toContain("Placarding");
    expect(r.notes.join(" ")).toContain("UN1267");
  });

  it("states plainly that TDG requirements must be confirmed, not taken from this list", () => {
    const r = deriveRequirements({
      service: "waste",
      truck: TRUCKS["TRK-TRIDEM-VAC"],
      cargo: CARGO["ENV-LIQUID-WASTE"],
      cargoWeightKg: 14000,
      thresholds: CONFIRMED,
    });
    expect(r.notes.join(" ")).toContain(
      "must be confirmed against current regulations"
    );
  });

  it("adds permit requirements and says permits override routing", () => {
    const r = deriveRequirements({
      service: "heavy_haul",
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-LOWBOY-RGN"],
      cargo: CARGO["HVY-EXCAVATOR"],
      cargoWeightKg: 34000,
      loadedWidthM: 3.6,
      thresholds: CONFIRMED,
    });
    expect(r.permits).toContain("Oversize permit");
    expect(r.documents).toContain("Permit copy carried in unit");
    expect(r.notes.join(" ")).toContain("Permit conditions override routing");
  });

  it("adds waste disposal documents for waste work", () => {
    const r = deriveRequirements({
      service: "waste",
      truck: TRUCKS["TRK-TRIDEM-VAC"],
      cargo: CARGO["ENV-LIQUID-WASTE"],
      cargoWeightKg: 14000,
      thresholds: CONFIRMED,
    });
    expect(r.documents).toEqual(
      expect.arrayContaining([
        "Disposal ticket",
        "Waste manifest",
        "Facility receipt",
      ])
    );
    expect(r.billingUnits).toContain("Disposal fee");
  });

  it("raises the hours-of-service regime question on interprovincial work", () => {
    const r = deriveRequirements({
      service: "general",
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      trailer: TRAILERS["TRL-SUPER-B"],
      cargoWeightKg: 30000,
      radius: "interprovincial",
      thresholds: CONFIRMED,
    });
    expect(r.notes.join(" ")).toContain("hours-of-service");
  });

  it("flags communications coverage for remote environments", () => {
    const r = deriveRequirements({
      service: "forestry",
      truck: TRUCKS["TRK-TRACTOR-TANDEM"],
      cargoWeightKg: 20000,
      environments: ["forestry_road"],
      thresholds: CONFIRMED,
    });
    expect(r.safetyTickets).toContain("Radio protocol");
    expect(r.notes.join(" ")).toContain("communications coverage");
  });
});
