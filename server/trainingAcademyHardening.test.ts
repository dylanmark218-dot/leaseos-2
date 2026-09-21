import { describe, expect, it } from "vitest";
import { certificateDecision, directSupervisionDecision } from "./_core/trainingAcademy";
import {
  ACADEMY_REGULATORY_PROFILES,
  TDG_REASONABLE_GROUNDS_ATTESTATION,
  addCalendarMonths,
  certificateFinalizationDecision,
  certificateRetentionDeletionDecision,
  certificateTerms,
  foreignTdgRoadCertificateDecision,
  sourceTierCanGovernCertificate,
} from "./_core/trainingAcademyRegulatory";

const certBase = {
  credentialBoundary: "employer_certificate" as const,
  courseVersionId: 10,
  assignmentCourseVersionId: 10,
  assessmentPassed: true,
  practicalReady: true,
  sourceSnapshotRef: "SRC-TDG-ROAD-2026",
  sourceReviewStatus: "reviewed" as const,
  sourceTier: "authority" as const,
};

describe("v22.22 certificate blocker matrix", () => {
  const cases: Array<[string, object, RegExp]> = [
    ["external boundary", { credentialBoundary: "external_track_only" }, /external\/track-only/i],
    ["knowledge boundary", { credentialBoundary: "knowledge_only" }, /knowledge-only/i],
    ["version mismatch", { assignmentCourseVersionId: 9 }, /versions do not match/i],
    ["assessment missing", { assessmentPassed: false }, /assessment has not been passed/i],
    ["practical missing", { practicalReady: false }, /practical competency evidence/i],
    ["source missing", { sourceSnapshotRef: null }, /no governing source snapshot/i],
    ["source unreviewed", { sourceReviewStatus: "unreviewed" }, /has not been reviewed/i],
    ["vendor source", { sourceTier: "vendor" }, /vendor-sourced/i],
    ["unknown source tier", { sourceTier: "unknown" }, /source tier is unknown/i],
  ];
  for (const [name, patch, message] of cases) {
    it(`blocks ${name}`, () => {
      const result = certificateDecision({ ...certBase, ...patch } as Parameters<typeof certificateDecision>[0]);
      expect(result.permitted).toBe(false);
      expect(result.blockers.join(" ")).toMatch(message);
    });
  }
  it("permits a reviewed authority-backed employer boundary once prerequisites are complete", () => {
    expect(certificateDecision(certBase)).toEqual({ permitted: true, blockers: [] });
  });
});

describe("v22.22 direct-supervision blocker matrix", () => {
  const base = {
    traineeUserId: 1,
    supervisorUserId: 2,
    supervisorQualificationStatus: "current" as const,
    supervisorQualificationCode: "TDG_ROAD",
    requiredQualificationCode: "TDG_ROAD",
    physicalPresenceAttested: true,
    startsAt: new Date("2026-09-11T10:00:00Z"),
    endsAt: new Date("2026-09-11T12:00:00Z"),
    jobId: 99,
    scope: "UN1203 gasoline loading and road transport",
  };
  const cases: Array<[string, object, RegExp]> = [
    ["self supervision", { supervisorUserId: 1 }, /cannot directly supervise themself/i],
    ["non-current supervisor", { supervisorQualificationStatus: "expired" }, /not current/i],
    ["wrong qualification", { supervisorQualificationCode: "WHMIS_EMPLOYER" }, /does not match/i],
    ["no physical presence", { physicalPresenceAttested: false }, /physical presence/i],
    ["no job", { jobId: null }, /specific job/i],
    ["no scope", { scope: " " }, /explicit task\/material scope/i],
    ["invalid time window", { endsAt: new Date("2026-09-11T09:00:00Z") }, /valid start\/end time window/i],
  ];
  for (const [name, patch, message] of cases) {
    it(`blocks ${name}`, () => {
      const result = directSupervisionDecision({ ...base, ...patch } as Parameters<typeof directSupervisionDecision>[0]);
      expect(result.permitted).toBe(false);
      expect(result.blockers.join(" ")).toMatch(message);
    });
  }
  it("permits a complete physically-present supervision record", () => {
    expect(directSupervisionDecision(base)).toEqual({ permitted: true, blockers: [] });
  });
});

describe("v22.22 regulated certificate lifecycle", () => {
  const tdg = ACADEMY_REGULATORY_PROFILES.find(p => p.qualificationCode === "TDG_ROAD")!;
  it("computes TDG road expiry 36 calendar months server-side and retention 24 months beyond expiry", () => {
    const issuedAt = new Date("2026-09-11T12:00:00Z");
    const result = certificateTerms({ issuedAt, credentialBoundary: "employer_certificate", profile: tdg });
    expect(result.permitted).toBe(true);
    expect(result.expiresAt?.toISOString()).toBe("2029-09-11T12:00:00.000Z");
    expect(result.retentionUntil?.toISOString()).toBe("2031-09-11T12:00:00.000Z");
  });
  it("rejects caller-supplied expiry on regulated employer certificates", () => {
    const result = certificateTerms({ issuedAt: new Date("2026-09-11T12:00:00Z"), credentialBoundary: "employer_certificate", profile: tdg, callerSuppliedExpiry: new Date("2099-01-01T00:00:00Z") });
    expect(result.permitted).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/caller-supplied expiry/i);
  });
  it("clamps calendar-month arithmetic instead of overflowing month-end", () => {
    expect(addCalendarMonths(new Date("2024-01-31T00:00:00Z"), 1).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
  it("requires both signatures and the reasonable-grounds attestation before final activation", () => {
    const blocked = certificateFinalizationDecision({ requiresEmployeeSignature: true, requiresEmployerSignature: true, employeeSignaturePresent: false, employerSignaturePresent: true, attestationRequired: true, attestationPresent: true });
    expect(blocked.permitted).toBe(false);
    expect(blocked.blockers.join(" ")).toMatch(/employee signature/i);
    expect(TDG_REASONABLE_GROUNDS_ATTESTATION).toMatch(/reasonable grounds/i);
    expect(certificateFinalizationDecision({ requiresEmployeeSignature: true, requiresEmployerSignature: true, employeeSignaturePresent: true, employerSignaturePresent: true, attestationRequired: true, attestationPresent: true }).permitted).toBe(true);
  });
  it("prevents deletion before retentionUntil", () => {
    const result = certificateRetentionDeletionDecision({ retentionUntil: new Date("2031-09-11T00:00:00Z"), now: new Date("2030-01-01T00:00:00Z") });
    expect(result.permitted).toBe(false);
    expect(result.blockers[0]).toMatch(/retained until/i);
  });
  it("bars vendor and unknown tiers from governing certificate issuance", () => {
    expect(sourceTierCanGovernCertificate({ tier: "vendor", credentialBoundary: "employer_certificate" })).toBe(false);
    expect(sourceTierCanGovernCertificate({ tier: "unknown", credentialBoundary: "company_certificate" })).toBe(false);
    expect(sourceTierCanGovernCertificate({ tier: "authority", credentialBoundary: "employer_certificate" })).toBe(true);
  });
});

describe("v22.22 foreign TDG road recognition decision", () => {
  const base = { issuingJurisdiction: "US", vehicleLicenceJurisdiction: "US", trainingStandard: "49 CFR 172.700 through 172.704", documentValidInIssuingJurisdiction: true, expiresAt: new Date("2027-09-11T00:00:00Z"), now: new Date("2026-09-11T00:00:00Z") };
  it("recognizes a valid US road pathway only when all rule facts are present", () => expect(foreignTdgRoadCertificateDecision(base).permitted).toBe(true));
  it("blocks non-US issuing jurisdiction", () => expect(foreignTdgRoadCertificateDecision({ ...base, issuingJurisdiction: "CA" }).blockers.join(" ")).toMatch(/only.*United States/i));
  it("blocks non-US vehicle licence", () => expect(foreignTdgRoadCertificateDecision({ ...base, vehicleLicenceJurisdiction: "CA" }).blockers.join(" ")).toMatch(/licensed in the United States/i));
  it("blocks wrong training standard", () => expect(foreignTdgRoadCertificateDecision({ ...base, trainingStandard: "generic hazmat training" }).blockers.join(" ")).toMatch(/49 CFR/i));
  it("blocks an expired foreign certificate", () => expect(foreignTdgRoadCertificateDecision({ ...base, expiresAt: new Date("2025-01-01T00:00:00Z") }).blockers.join(" ")).toMatch(/expired/i));
});
