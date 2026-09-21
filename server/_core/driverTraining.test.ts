import { describe, expect, it } from "vitest";
import { evaluateDriverQualification } from "./driverTraining";

const now = new Date("2026-09-11T15:00:00Z");

function profile(overrides: Record<string, unknown> = {}) {
  return {
    licenceClass: "3" as const,
    licenceVerification: "verified" as const,
    licenceExpiresAt: "2027-01-01T00:00:00Z",
    class1ProvincialRestriction: false,
    credentials: [],
    completedCompetencies: [],
    ...overrides,
  };
}

describe("driver qualification gate", () => {
  it("allows verified Class 3 on a non-air-brake Class 3 movement", () => {
    const result = evaluateDriverQualification(profile(), { requiredLicenceClass: "3", airBrakes: false }, now);
    expect(result.status).toBe("qualified_for_dispatch");
  });

  it("blocks air-brake movement without Q", () => {
    const result = evaluateDriverQualification(profile(), { requiredLicenceClass: "3", airBrakes: true }, now);
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("Q endorsement");
  });

  it("accepts verified Q for air-brake Class 3", () => {
    const result = evaluateDriverQualification(profile({ credentials: [{ code: "Q", verification: "verified" }] }), { requiredLicenceClass: "3", airBrakes: true }, now);
    expect(result.status).toBe("qualified_for_dispatch");
  });

  it("recognizes Class 2 as covering a Class 3 movement", () => {
    const result = evaluateDriverQualification(profile({ licenceClass: "2" }), { requiredLicenceClass: "3", airBrakes: false }, now);
    expect(result.status).toBe("qualified_for_dispatch");
  });

  it("recognizes Class 1 as covering a Class 2 movement", () => {
    const result = evaluateDriverQualification(profile({ licenceClass: "1" }), { requiredLicenceClass: "2", airBrakes: false }, now);
    expect(result.status).toBe("qualified_for_dispatch");
  });

  it("blocks Class 3 from a Class 2 bus movement", () => {
    const result = evaluateDriverQualification(profile(), { requiredLicenceClass: "2", airBrakes: false }, now);
    expect(result.status).toBe("blocked");
  });

  it("allows provincially restricted Class 1 for Alberta-only movement", () => {
    const result = evaluateDriverQualification(
      profile({ licenceClass: "1", class1ProvincialRestriction: true, credentials: [{ code: "Q", verification: "verified" }] }),
      { requiredLicenceClass: "1", airBrakes: true, destinationJurisdiction: "CA-AB" },
      now,
    );
    expect(result.status).toBe("qualified_for_dispatch");
  });

  it("blocks provincially restricted Class 1 from an out-of-Alberta destination", () => {
    const result = evaluateDriverQualification(
      profile({ licenceClass: "1", class1ProvincialRestriction: true, credentials: [{ code: "Q", verification: "verified" }] }),
      { requiredLicenceClass: "1", airBrakes: true, destinationJurisdiction: "CA-SK" },
      now,
    );
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("provincially restricted");
  });

  it("blocks an expired licence", () => {
    const result = evaluateDriverQualification(profile({ licenceExpiresAt: "2026-01-01T00:00:00Z" }), { requiredLicenceClass: "3", airBrakes: false }, now);
    expect(result.status).toBe("blocked");
  });

  it("routes unverified government credentials to human review", () => {
    const result = evaluateDriverQualification(profile({ licenceVerification: "pending" }), { requiredLicenceClass: "3", airBrakes: false }, now);
    expect(result.status).toBe("needs_review");
  });

  it("never treats employer training as a substitute for Q", () => {
    const result = evaluateDriverQualification(
      profile({ completedCompetencies: [{ code: "L3-02", verification: "verified" }] }),
      { requiredLicenceClass: "3", airBrakes: true, requiredEmployerCompetencies: ["L3-02"] },
      now,
    );
    expect(result.status).toBe("blocked");
    expect(result.satisfied).toContain("Employer competency L3-02 verified");
    expect(result.blockers.join(" ")).toContain("Q endorsement");
  });

  it("blocks expired employer competency", () => {
    const result = evaluateDriverQualification(
      profile({ completedCompetencies: [{ code: "LEASE-ROAD", verification: "verified", expiresAt: "2026-01-01T00:00:00Z" }] }),
      { requiredLicenceClass: "3", airBrakes: false, requiredEmployerCompetencies: ["LEASE-ROAD"] },
      now,
    );
    expect(result.status).toBe("blocked");
  });
});

describe("TDG dispatch qualification gate", () => {
  it("blocks a dangerous-goods movement without a verified/current TDG certificate", () => {
    const result = evaluateDriverQualification(
      profile({ credentials: [] }),
      { requiredLicenceClass: "3", airBrakes: false, dangerousGoods: true },
      now,
    );
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("TDG training certificate");
  });

  it("accepts a verified unexpired TDG road certificate", () => {
    const result = evaluateDriverQualification(
      profile({ credentials: [{ code: "TDG", verification: "verified", expiresAt: "2028-09-11T00:00:00Z" }] }),
      { requiredLicenceClass: "3", airBrakes: false, dangerousGoods: true },
      now,
    );
    expect(result.status).toBe("qualified_for_dispatch");
  });

  it("blocks an expired TDG certificate", () => {
    const result = evaluateDriverQualification(
      profile({ credentials: [{ code: "TDG", verification: "verified", expiresAt: "2026-01-01T00:00:00Z" }] }),
      { requiredLicenceClass: "3", airBrakes: false, dangerousGoods: true },
      now,
    );
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("expired");
  });

  it("routes direct-supervision mode to review rather than silently authorizing it", () => {
    const result = evaluateDriverQualification(
      profile({ credentials: [] }),
      { requiredLicenceClass: "3", airBrakes: false, dangerousGoods: true, tdgDirectSupervision: true, tdgSupervisorCertificateVerified: true },
      now,
    );
    expect(result.status).toBe("needs_review");
    expect(result.reviewItems.join(" ")).toContain("physically present");
  });
});
