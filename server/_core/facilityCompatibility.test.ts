import { describe, expect, it } from "vitest";
import { assessFacilityCompatibility, type FacilityAssessmentInput } from "./facilityCompatibility";

const input = (overrides: Partial<FacilityAssessmentInput> = {}): FacilityAssessmentInput => ({
  loadWasteCode: "produced_water", capabilityWasteCode: "produced_water", acceptanceStatus: "verified",
  coordinatePrecision: "verified_entrance", coordinateSourceUrl: "https://authority.test/site",
  evidenceIds: [12], evidenceVerifiedAt: new Date("2026-09-01T00:00:00Z"), assessedAt: new Date("2026-09-17T00:00:00Z"),
  accountRequired: false, accountApproved: true, facilityOpen: true, routeReviewPassed: true, ...overrides,
});

describe("facility compatibility", () => {
  it.each([
    ["domestic_septage", "hydrovac_slurry", "incompatible"],
    ["hydrovac_slurry", "domestic_septage", "incompatible"],
    ["produced_water", "produced_water", "compatible_verified"],
  ] as const)("matches %s against %s", (loadWasteCode, capabilityWasteCode, outcome) => {
    expect(assessFacilityCompatibility(input({ loadWasteCode, capabilityWasteCode })).outcome).toBe(outcome);
  });
  it.each(["approximate_site", "community_only", "unknown"] as const)("blocks %s coordinates", coordinatePrecision => {
    expect(assessFacilityCompatibility(input({ coordinatePrecision })).outcome).toBe("insufficient_information");
  });
  it("gives explicit rejection precedence", () => {
    expect(assessFacilityCompatibility(input({ acceptanceStatus: "not_accepted" })).outcome).toBe("incompatible");
  });
  it("requires confirmation for stale evidence", () => {
    expect(assessFacilityCompatibility(input({ evidenceVerifiedAt: new Date("2025-01-01T00:00:00Z") })).outcome).toBe("facility_confirmation_required");
  });
  it("blocks missing account approval and route review", () => {
    const result = assessFacilityCompatibility(input({ accountRequired: true, accountApproved: false, routeReviewPassed: false }));
    expect(result.outcome).toBe("facility_confirmation_required");
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["account_approval_required", "route_review_required"]));
  });
});
