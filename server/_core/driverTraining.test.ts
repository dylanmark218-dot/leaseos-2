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
      { requiredLicenceClass: "1", airBrakes: true, originJurisdiction: "CA-AB", destinationJurisdiction: "CA-AB" },
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

  /*
   * The Alberta Class 1 provincial restriction: an unknown end of the movement is unknown, never
   * Alberta. Only a movement known at both ends to be in Alberta satisfies it; a known end outside
   * Alberta blocks; anything not established goes to review.
   */
  describe("Class 1 provincial restriction never assumes Alberta", () => {
    const restricted = () => profile({ licenceClass: "1", class1ProvincialRestriction: true, credentials: [{ code: "Q", verification: "verified" }] });
    const move = (origin: string | null | undefined, destination: string | null | undefined) =>
      evaluateDriverQualification(restricted(), { requiredLicenceClass: "1", airBrakes: true, originJurisdiction: origin, destinationJurisdiction: destination }, now);

    it("AB → AB: the restriction is satisfied", () => {
      const r = move("CA-AB", "CA-AB");
      expect(r.status).toBe("qualified_for_dispatch");
      expect(r.satisfied.join(" ")).toContain("Alberta-only movement");
    });
    it("AB → BC: blocked", () => {
      const r = move("CA-AB", "CA-BC");
      expect(r.status).toBe("blocked");
      expect(r.blockers.join(" ")).toContain("provincially restricted");
    });
    it("BC → AB: blocked — a known origin outside Alberta is not an Alberta-only movement", () => {
      expect(move("CA-BC", "CA-AB").status).toBe("blocked");
    });
    it("destination unknown: review, not Alberta", () => {
      const r = move("CA-AB", null);
      expect(r.status).toBe("needs_review");
      expect(r.satisfied.join(" ")).not.toContain("Alberta-only");
      expect(r.reviewItems.join(" ")).toContain("destination jurisdiction is not established");
    });
    it("origin unknown: review, not Alberta", () => {
      const r = move(undefined, "CA-AB");
      expect(r.status).toBe("needs_review");
      expect(r.reviewItems.join(" ")).toContain("origin jurisdiction is not established");
    });
    it("both unknown: review, never 'compatible with an Alberta-only movement'", () => {
      const r = move(null, null);
      expect(r.status).toBe("needs_review");
      expect(r.satisfied.join(" ")).not.toContain("Alberta-only");
    });
    it("conflicting or unrecognized geography is unknown, not Alberta and not a guess", () => {
      // An unrecognized code is not evidence of anything — not of Alberta, and not of elsewhere.
      for (const bad of ["Alberta", "AB?", "", "XX-YY-ZZ"]) {
        const r = move("CA-AB", bad);
        expect(r.status, bad).toBe("needs_review");
        expect(r.satisfied.join(" "), bad).not.toContain("Alberta-only");
      }
      // A known out-of-Alberta end still blocks even when the other end is unrecognized.
      expect(move("garbage", "CA-SK").status).toBe("blocked");
    });
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
