import { describe, expect, it } from "vitest";
import {
  filterVisiblePostings,
  matchOperatorToJob,
  type EquipmentProfile,
  type JobRequirements,
  type OperatorProfile,
} from "./dispatchMatching";

const NOW = new Date(Date.UTC(2026, 7, 30, 12, 0));
const future = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
const past = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const cred = (
  code: string,
  label: string,
  expiresAt: Date | null = future(200)
) => ({
  kind: "certification" as const,
  code,
  label,
  expiresAt,
  isCredential: true,
});

const OPERATOR: OperatorProfile = {
  operatorId: 47,
  name: "D. Reid",
  capabilities: [
    {
      kind: "licence",
      code: "CLASS_3",
      label: "Class 3 / D",
      expiresAt: future(120),
      isCredential: true,
    },
    cred("TDG", "TDG certification"),
    cred("H2S", "H2S Alive"),
    cred("FIRST_AID", "First Aid"),
    {
      kind: "experience",
      code: "VAC",
      label: "Vacuum truck experience",
      isCredential: false,
    },
  ],
  specialtyPools: ["vacuum_fluid", "oilfield"],
  operatingRegions: ["Grande Prairie", "Peace River"],
  onCall: true,
  availableFrom: new Date(Date.UTC(2026, 7, 31, 5, 0)),
  maxRadiusKm: 200,
  distanceFromOriginKm: 28,
};

const VAC_UNIT: EquipmentProfile = {
  unitId: 27,
  unitNumber: "VAC-27",
  equipmentClass: "tri_drive_vac",
  tankCapacityL: 16000,
  pumpCapable: true,
  ptoCapable: true,
  dgCompatible: true,
  payloadKg: 16000,
};

const JOB: JobRequirements = {
  jobCode: "JOB-2026-008841",
  specialtyPool: "vacuum_fluid",
  requiredCapabilities: [
    { kind: "certification", code: "TDG", label: "TDG certification" },
    { kind: "certification", code: "H2S", label: "H2S Alive" },
  ],
  preferredCapabilities: [
    { kind: "orientation", code: "NORTHRIDGE", label: "Customer orientation" },
  ],
  requiredEquipmentClass: "tri_drive_vac",
  minTankCapacityL: 12000,
  requiresPump: true,
  operatingRegion: "Grande Prairie",
  scheduledStart: new Date(Date.UTC(2026, 7, 31, 6, 30)),
};

describe("matchOperatorToJob", () => {
  it("matches a qualified operator and explains why", () => {
    const m = matchOperatorToJob(OPERATOR, VAC_UNIT, JOB, NOW);
    expect(m.matched).toBe(true);
    expect(m.score).toBeGreaterThan(0);
    expect(m.explanation).toContain("Suggested because");
    expect(m.explanation).toContain("suitability match only");
  });

  it("never presents a match as an eligibility decision", () => {
    const m = matchOperatorToJob(OPERATOR, VAC_UNIT, JOB, NOW);
    expect(m.explanation).toContain(
      "dispatch eligibility is evaluated separately"
    );
    expect(m).not.toHaveProperty("verdict");
    expect(m).not.toHaveProperty("eligible");
  });

  it("disqualifies on a missing required certification", () => {
    const noTdg = {
      ...OPERATOR,
      capabilities: OPERATOR.capabilities.filter(c => c.code !== "TDG"),
    };
    const m = matchOperatorToJob(noTdg, VAC_UNIT, JOB, NOW);
    expect(m.matched).toBe(false);
    expect(m.score).toBe(0);
    expect(m.missingRequirements).toContain("TDG certification");
  });

  it("treats an expired certification as missing and says so with the date", () => {
    const expired = {
      ...OPERATOR,
      capabilities: OPERATOR.capabilities.map(c =>
        c.code === "H2S" ? cred("H2S", "H2S Alive", past(10)) : c
      ),
    };
    const m = matchOperatorToJob(expired, VAC_UNIT, JOB, NOW);
    expect(m.matched).toBe(false);
    expect(m.missingRequirements).toContain("H2S Alive (expired)");
    expect(m.reasons.find(r => r.factor === "H2S Alive")?.outcome).toBe(
      "expired"
    );
  });

  it("disqualifies an operator outside the specialty pool", () => {
    const m = matchOperatorToJob(
      { ...OPERATOR, specialtyPools: ["freight"] },
      VAC_UNIT,
      JOB,
      NOW
    );
    expect(m.matched).toBe(false);
    expect(m.missingRequirements).toContain("Specialty pool: vacuum_fluid");
  });

  it("disqualifies on the wrong equipment class", () => {
    const m = matchOperatorToJob(
      OPERATOR,
      { ...VAC_UNIT, equipmentClass: "highway_tractor" },
      JOB,
      NOW
    );
    expect(m.matched).toBe(false);
    expect(m.missingRequirements).toContain("Equipment class: tri_drive_vac");
  });

  it("treats an unrecorded tank capacity as unknown, not as sufficient", () => {
    const m = matchOperatorToJob(
      OPERATOR,
      { ...VAC_UNIT, tankCapacityL: null },
      JOB,
      NOW
    );
    expect(m.reasons.find(r => r.factor === "Tank capacity")?.outcome).toBe(
      "unknown"
    );
    expect(m.missingRequirements).toContain("Tank capacity unknown");
  });

  it("does not disqualify on a missing preferred capability", () => {
    const m = matchOperatorToJob(OPERATOR, VAC_UNIT, JOB, NOW);
    expect(m.matched).toBe(true);
    expect(
      m.reasons.find(r => r.factor.includes("preferred"))?.detail
    ).toContain("not disqualifying");
  });

  it("notes an out-of-region operator without disqualifying them", () => {
    const m = matchOperatorToJob(
      { ...OPERATOR, operatingRegions: ["Calgary"] },
      VAC_UNIT,
      JOB,
      NOW
    );
    expect(m.matched).toBe(true);
    expect(m.reasons.find(r => r.factor === "Operating region")?.outcome).toBe(
      "partial"
    );
  });

  it("flags a job beyond the operator's stated working radius", () => {
    const m = matchOperatorToJob(
      { ...OPERATOR, distanceFromOriginKm: 340 },
      VAC_UNIT,
      JOB,
      NOW
    );
    expect(
      m.reasons.find(r => r.factor === "Working radius")?.detail
    ).toContain("exceeds");
  });

  it("shows the arithmetic behind every factor", () => {
    const m = matchOperatorToJob(OPERATOR, VAC_UNIT, JOB, NOW);
    expect(m.reasons.every(r => typeof r.points === "number")).toBe(true);
    expect(m.reasons.every(r => r.detail.length > 0)).toBe(true);
  });

  it("requires a proposed unit when the job specifies equipment", () => {
    const m = matchOperatorToJob(OPERATOR, null, JOB, NOW);
    expect(m.matched).toBe(false);
    expect(m.missingRequirements).toContain("Proposed unit");
  });
});

describe("filterVisiblePostings", () => {
  it("hides a posting the operator could not perform", () => {
    const heavyHaul: JobRequirements = {
      jobCode: "JOB-9001",
      specialtyPool: "heavy_haul",
      requiredCapabilities: [
        { kind: "licence", code: "CLASS_1", label: "Class 1 / A" },
      ],
      requiredEquipmentClass: "lowboy",
    };
    const visible = filterVisiblePostings(
      [{ requirements: JOB }, { requirements: heavyHaul }],
      OPERATOR,
      VAC_UNIT,
      NOW
    );
    expect(visible).toHaveLength(1);
    expect(visible[0].requirements.jobCode).toBe("JOB-2026-008841");
  });
});
