import { describe, expect, it } from "vitest";
import { evaluateDangerousGoodsAssist, evaluateGeneralCargoSecurement } from "./complianceSecretary";

describe("AI Secretary dangerous-goods compliance helper", () => {
  it("fails closed when classification is unverified", () => {
    const result = evaluateDangerousGoodsAssist({
      classificationStatus: "needs_verification",
      tdgShippingDocumentPresent: true,
      marksConfirmed: true,
      driverTdgCertificateStatus: "verified",
    });
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("must not guess");
  });

  it("requires a current driver TDG certificate unless verified direct supervision is configured", () => {
    const result = evaluateDangerousGoodsAssist({
      classificationStatus: "verified",
      unNumber: "UN1203",
      properShippingName: "GASOLINE",
      dgClass: "3",
      tdgShippingDocumentPresent: true,
      marksConfirmed: true,
      containerCategory: "large",
      driverTdgCertificateStatus: "missing",
    });
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("TDG training certificate");
  });

  it("routes in-province dangerous oilfield waste away from Alberta hazardous-waste manifest workflow", () => {
    const result = evaluateDangerousGoodsAssist({
      classificationStatus: "verified",
      unNumber: "UN1993",
      properShippingName: "FLAMMABLE LIQUID, N.O.S.",
      dgClass: "3",
      tdgShippingDocumentPresent: true,
      marksConfirmed: true,
      containerCategory: "large",
      driverTdgCertificateStatus: "verified",
      isDangerousOilfieldWaste: true,
      exportFromAlberta: false,
    });
    expect(result.wasteWorkflow).toBe("oilfield_waste_workflow");
    expect(result.status).toBe("blocked");
  });
});

describe("general cargo securement helper", () => {
  it("passes the general 50 percent aggregate-WLL threshold when inputs are complete", () => {
    const result = evaluateGeneralCargoSecurement({
      cargoWeightKg: 10000,
      cargoImmobilizedOrContained: true,
      generalRuleApplicable: true,
      preTripInspectionComplete: true,
      tiedowns: [
        { id: "A", workingLoadLimitKg: 2500, attachedEndSections: 2, markedByManufacturer: true },
        { id: "B", workingLoadLimitKg: 2500, attachedEndSections: 2, markedByManufacturer: true },
      ],
    });
    expect(result.aggregateWorkingLoadLimitKg).toBe(5000);
    expect(result.status).toBe("ready_for_human_confirmation");
  });

  it("rejects unmarked tiedown capacity from the calculation", () => {
    const result = evaluateGeneralCargoSecurement({
      cargoWeightKg: 4000,
      cargoImmobilizedOrContained: true,
      generalRuleApplicable: true,
      preTripInspectionComplete: true,
      tiedowns: [{ id: "A", workingLoadLimitKg: 4000, attachedEndSections: 2, markedByManufacturer: false }],
    });
    expect(result.aggregateWorkingLoadLimitKg).toBe(0);
    expect(result.status).toBe("blocked");
  });

  it("does not treat a general-WLL pass as a substitute for a commodity-specific rule", () => {
    const result = evaluateGeneralCargoSecurement({
      cargoWeightKg: 4000,
      cargoImmobilizedOrContained: true,
      generalRuleApplicable: true,
      preTripInspectionComplete: true,
      commoditySpecificRuleRequired: true,
      commoditySpecificRuleConfirmed: false,
      tiedowns: [{ id: "A", workingLoadLimitKg: 4000, attachedEndSections: 2, markedByManufacturer: true }],
    });
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("commodity-specific");
  });
});
