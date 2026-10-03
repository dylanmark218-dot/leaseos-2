/**
 * Payroll P1 — the pure rules of compensation agreements: canonical hashing, the effective-date contract
 * [effectiveFrom, effectiveUntil), supersession without overlap, and the D9 classification map.
 */
import { describe, expect, it } from "vitest";
import {
  LEGACY_ROLE_CLASSIFICATION,
  agreementEligibility,
  canonicalRuleSet,
  headlineAmountCents,
  normalizeClassification,
  rulesHash,
  supersessionPlan,
  validateRules,
  versionInForce,
  windowContains,
  windowsOverlap,
  type EarningRuleInput,
  type VersionWindow,
} from "./payrollCompensation";

const REG: EarningRuleInput = { earningCode: "REG", calculation: "hourly", unit: "hour", rateMillis: 32_500 };
const OT: EarningRuleInput = { earningCode: "OT", calculation: "hourly", unit: "hour", rateMillis: 48_750, overtimeRule: { dailyThresholdMinutes: 480, weeklyThresholdMinutes: 2400, multiplierMillis: 1500 } };
const LOAD: EarningRuleInput = { earningCode: "LOAD_PAY", calculation: "quantity_times_rate", unit: "load", rateMillis: 35_000, requiresJob: true };
const hashOf = (rules: EarningRuleInput[], v: { basis?: "hourly" | "mixed"; currency?: string } = {}) => rulesHash(canonicalRuleSet({ basis: v.basis ?? "mixed", currency: v.currency ?? "CAD" }, rules));

describe("P1 — the rule-set hash is canonical", () => {
  it("is the same for the same rules in any order", () => {
    expect(hashOf([REG, OT, LOAD])).toBe(hashOf([LOAD, REG, OT]));
    expect(hashOf([REG, OT, LOAD])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on object property insertion order, including nested configuration", () => {
    const a: EarningRuleInput = { earningCode: "OT", unit: "hour", calculation: "hourly", rateMillis: 48_750, overtimeRule: { multiplierMillis: 1500, weeklyThresholdMinutes: 2400, dailyThresholdMinutes: 480 } };
    expect(hashOf([REG, a, LOAD])).toBe(hashOf([REG, OT, LOAD]));
  });

  it("ignores display order and treats an absent optional as null", () => {
    expect(hashOf([{ ...REG, sortOrder: 7 }])).toBe(hashOf([{ ...REG, sortOrder: 0 }]));
    expect(hashOf([{ ...REG, overtimeRule: null, percentMillis: null }])).toBe(hashOf([REG]));
    expect(hashOf([REG], { currency: "cad" })).toBe(hashOf([REG], { currency: "CAD" }));
  });

  it("changes when any financial term changes", () => {
    const base = hashOf([REG, OT, LOAD]);
    const variants: EarningRuleInput[][] = [
      [{ ...REG, rateMillis: 32_501 }, OT, LOAD],                                   // rate
      [{ ...REG, earningCode: "SHOP" }, OT, LOAD],                                  // earning code
      [REG, OT, { ...LOAD, unit: "trip" }],                                         // unit
      [REG, OT, { ...LOAD, calculation: "flat" }],                                  // calculation
      [REG, { ...OT, overtimeRule: { dailyThresholdMinutes: 600, weeklyThresholdMinutes: 2400, multiplierMillis: 1500 } }, LOAD], // overtime
      [REG, OT, { ...LOAD, eligibleRevenueBasis: { exclude: ["fuel_surcharge"] } }], // eligibility
      [REG, OT, { ...LOAD, requiresJob: false }],                                   // job requirement
      [REG, OT, { ...LOAD, minimumMeasurementAuthority: "instrument_measured" }],   // measurement floor
      [REG, OT],                                                                    // a rule removed
    ];
    for (const v of variants) expect(hashOf(v)).not.toBe(base);
    expect(hashOf([{ earningCode: "COMMISSION", calculation: "percentage", unit: "percent", percentMillis: 25_000 }])).not.toBe(hashOf([{ earningCode: "COMMISSION", calculation: "percentage", unit: "percent", percentMillis: 25_001 }]));
    expect(hashOf([REG], { basis: "hourly" })).not.toBe(hashOf([REG], { basis: "mixed" }));
    expect(hashOf([REG], { currency: "USD" })).not.toBe(hashOf([REG], { currency: "CAD" }));
  });
});

describe("P1 — a rule set that could not be paid from is refused by name", () => {
  it("accepts a coherent mixed version", () => {
    expect(validateRules("mixed", [REG, OT, LOAD])).toEqual([]);
  });
  it("refuses mismatched units, missing rates, duplicates, bad percentages and basis without its rule", () => {
    expect(validateRules("hourly", [{ ...REG, unit: "km" }])).toContain("rule REG: hourly pay is per hour");
    expect(validateRules("mixed", [{ ...LOAD, rateMillis: null }])).toContain("rule LOAD_PAY: quantity × rate needs rateMillis");
    expect(validateRules("mixed", [REG, REG])).toContain("rule REG: the earning code appears twice in one version");
    expect(validateRules("percentage", [{ earningCode: "COMMISSION", calculation: "percentage", unit: "percent", percentMillis: 100_001 }]).join()).toMatch(/percentMillis must be an integer/);
    expect(validateRules("salary", [REG])).toContain("A salary basis needs a per_period_salary rule");
    expect(validateRules("hourly", [])).toContain("A version needs at least one earning rule");
    expect(validateRules("mixed", [{ ...REG, rateMillis: 12.5 }]).join()).toMatch(/non-negative integer/);
  });
  it("reports the ledger's informational amount in cents from the largest per-unit rate", () => {
    expect(headlineAmountCents([REG, OT, LOAD])).toBe(4875);
    expect(headlineAmountCents([{ earningCode: "COMMISSION", calculation: "percentage", unit: "percent", percentMillis: 25_000 }])).toBe(0);
  });
});

describe("P1 — the effective-date contract is [effectiveFrom, effectiveUntil)", () => {
  const v1: VersionWindow = { versionRef: "V1", status: "superseded", effectiveFrom: "2026-01-01", effectiveUntil: "2026-07-01" };
  const v2: VersionWindow = { versionRef: "V2", status: "approved", effectiveFrom: "2026-07-01", effectiveUntil: null };
  const future: VersionWindow = { versionRef: "VF", status: "approved", effectiveFrom: "2027-01-01", effectiveUntil: null };

  it("includes the start date and excludes the end date", () => {
    expect(windowContains(v1, "2026-01-01")).toBe(true);
    expect(windowContains(v1, "2025-12-31")).toBe(false);
    expect(windowContains(v1, "2026-06-30")).toBe(true);
    expect(windowContains(v1, "2026-07-01")).toBe(false);
  });

  it("resolves the version on its exact start date, and the predecessor the day before", () => {
    const r = versionInForce([v1, v2], "2026-07-01");
    expect(r.kind === "version" && r.version.versionRef).toBe("V2");
    const before = versionInForce([v1, v2], "2026-06-30");
    expect(before.kind === "version" && before.version.versionRef).toBe("V1");
  });

  it("still resolves a superseded version for a historical date inside its window", () => {
    const r = versionInForce([v1, v2], "2026-03-15");
    expect(r.kind === "version" && r.version.versionRef).toBe("V1");
  });

  it("returns no version before any version starts, and a future version does not apply early", () => {
    expect(versionInForce([v1, v2], "2025-12-31").kind).toBe("none");
    const open: VersionWindow = { ...v2, effectiveUntil: "2026-12-01" };
    expect(versionInForce([open, future], "2026-12-15")).toEqual({ kind: "none", reason: "no approved compensation version is in force on 2026-12-15" });
    expect(versionInForce([open, future], "2026-12-31").kind).toBe("none");
    const r = versionInForce([open, future], "2027-01-01");
    expect(r.kind === "version" && r.version.versionRef).toBe("VF");
  });

  it("never resolves a proposed or rejected version", () => {
    const proposed: VersionWindow = { versionRef: "VP", status: "proposed", effectiveFrom: "2026-01-01", effectiveUntil: null };
    const rejected: VersionWindow = { versionRef: "VR", status: "rejected", effectiveFrom: "2026-01-01", effectiveUntil: null };
    expect(versionInForce([proposed, rejected], "2026-05-01").kind).toBe("none");
  });

  it("reports overlapping approved windows as an integrity error, never an arbitrary winner", () => {
    const a: VersionWindow = { versionRef: "A", status: "approved", effectiveFrom: "2026-01-01", effectiveUntil: null };
    const b: VersionWindow = { versionRef: "B", status: "approved", effectiveFrom: "2026-03-01", effectiveUntil: null };
    const r = versionInForce([a, b], "2026-04-01");
    expect(r.kind).toBe("integrity_error");
    expect(r.kind === "integrity_error" && r.versions.map(v => v.versionRef).sort()).toEqual(["A", "B"]);
    expect(windowsOverlap(a, b)).toBe(true);
    expect(windowsOverlap(v1, v2)).toBe(false);
  });

  it("rejects a malformed work date rather than comparing it", () => {
    expect(versionInForce([v2], "2026-7-1").kind).toBe("none");
  });
});

describe("P1 — approving a version closes its predecessor and never overlaps", () => {
  const approved: VersionWindow = { versionRef: "V1", status: "approved", effectiveFrom: "2026-01-01", effectiveUntil: null };

  it("closes the open version at the candidate's start", () => {
    expect(supersessionPlan([approved], { versionRef: "V2", effectiveFrom: "2026-07-01", effectiveUntil: null })).toEqual({ ok: true, close: [{ versionRef: "V1", effectiveUntil: "2026-07-01" }] });
  });

  it("closes nothing when the candidate starts in a gap after the last window", () => {
    const closed = { ...approved, effectiveUntil: "2026-03-01" };
    expect(supersessionPlan([closed], { versionRef: "V2", effectiveFrom: "2026-05-01", effectiveUntil: null })).toEqual({ ok: true, close: [] });
  });

  it("refuses a candidate that starts on or before an approved start (history is not rewritten)", () => {
    for (const from of ["2026-01-01", "2025-06-01"]) {
      const r = supersessionPlan([approved], { versionRef: "V2", effectiveFrom: from, effectiveUntil: null });
      expect(r.ok).toBe(false);
    }
  });

  it("refuses a bounded candidate inside an approved bounded window that runs past it", () => {
    const bounded = { ...approved, effectiveUntil: "2026-12-01" };
    expect(supersessionPlan([bounded], { versionRef: "V2", effectiveFrom: "2026-03-01", effectiveUntil: "2026-06-01" }).ok).toBe(false);
  });

  it("refuses an inverted or empty window", () => {
    expect(supersessionPlan([], { versionRef: "V", effectiveFrom: "2026-03-01", effectiveUntil: "2026-03-01" }).ok).toBe(false);
  });

  it("ignores proposed, rejected and superseded rows when planning", () => {
    const others: VersionWindow[] = [
      { versionRef: "P", status: "proposed", effectiveFrom: "2026-01-01", effectiveUntil: null },
      { versionRef: "R", status: "rejected", effectiveFrom: "2026-01-01", effectiveUntil: null },
    ];
    expect(supersessionPlan(others, { versionRef: "V", effectiveFrom: "2026-01-01", effectiveUntil: null })).toEqual({ ok: true, close: [] });
  });
});

describe("P1 — D9: one classification vocabulary, mapped deterministically", () => {
  it("takes the organizationWorkers type when the worker is linked, over any legacy evidence", () => {
    expect(normalizeClassification({ organizationWorker: { workerRef: "W-1", workerType: "MECHANIC" }, legacy: { hasOperator: true, roles: ["driver"] } }))
      .toEqual({ ok: true, classification: "MECHANIC", source: "organization_worker", workerRef: "W-1" });
  });

  it("maps each supported legacy signal, in precedence order", () => {
    expect(normalizeClassification({ legacy: { hasOperator: true, roles: ["dispatcher"] } })).toMatchObject({ ok: true, classification: "EMPLOYEE_DRIVER", source: "legacy_mapped" });
    for (const [role, classification] of LEGACY_ROLE_CLASSIFICATION) {
      expect(normalizeClassification({ legacy: { hasOperator: false, roles: [role] } }), role).toEqual({ ok: true, classification, source: "legacy_mapped", workerRef: null });
    }
    expect(normalizeClassification({ legacy: { hasOperator: false, roles: ["office", "mechanic"] } })).toMatchObject({ classification: "MECHANIC" });
  });

  it("fails visibly when nothing maps, instead of defaulting to employee", () => {
    for (const roles of [[], ["hr"], ["management", "controller"], ["payroll_admin"]]) {
      const r = normalizeClassification({ legacy: { hasOperator: false, roles } });
      expect(r.ok, roles.join()).toBe(false);
    }
    expect(normalizeClassification({ organizationWorker: { workerRef: "W-2", workerType: "ASTRONAUT" }, legacy: { hasOperator: false, roles: [] } }).ok).toBe(false);
  });

  it("refuses an owner-driver an employee agreement and allows everyone else", () => {
    expect(agreementEligibility("OWNER_DRIVER").allowed).toBe(false);
    expect(agreementEligibility("OWNER_DRIVER").reason).toMatch(/contractor settlement/);
    for (const c of ["EMPLOYEE_DRIVER", "MECHANIC", "DISPATCHER", "OFFICE_ADMIN"] as const) expect(agreementEligibility(c).allowed, c).toBe(true);
  });
});
