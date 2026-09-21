import { describe, expect, it } from "vitest";
import { academyBindingMatches, type AcademyBindingFacts } from "./readinessComposer";

const facts: AcademyBindingFacts = {
  role: ["driver"],
  equipment: ["Vac Truck"],
  job_type: ["Hydrovac", "transport"],
  customer: ["North Field Energy"],
  site: ["Pad 14"],
};

describe("Academy readiness binding selection", () => {
  it("matches only facts the server actually knows", () => {
    expect(academyBindingMatches({ subjectType: "role", subjectCode: "DRIVER" }, facts)).toBe(true);
    expect(academyBindingMatches({ subjectType: "equipment", subjectCode: "vac-truck" }, facts)).toBe(true);
    expect(academyBindingMatches({ subjectType: "job_type", subjectCode: "hydrovac" }, facts)).toBe(true);
    expect(academyBindingMatches({ subjectType: "customer", subjectCode: "north field energy" }, facts)).toBe(true);
    expect(academyBindingMatches({ subjectType: "site", subjectCode: "pad-14" }, facts)).toBe(true);
  });

  it("does not guess cargo or jurisdiction from job text", () => {
    expect(academyBindingMatches({ subjectType: "cargo", subjectCode: "dangerous_goods" }, facts)).toBe(false);
    expect(academyBindingMatches({ subjectType: "jurisdiction", subjectCode: "CA-AB" }, facts)).toBe(false);
  });

  it("does not apply a different job requirement globally", () => {
    expect(academyBindingMatches({ subjectType: "job_type", subjectCode: "logging" }, facts)).toBe(false);
  });
});
