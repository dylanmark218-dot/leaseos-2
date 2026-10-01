import { describe, expect, it } from "vitest";
import { LEASEOS_HARD_LIMITS, deploymentSwitchOn, resolvePolicy, validatePolicyInput, type PolicyInput } from "./policy";

const ok: PolicyInput = {
  enabled: true, sourcesAllowed: ["photo"], idleSeconds: 90, maxSessionMinutes: 15, retentionHours: 12,
  maxSessionsPerUserPerDay: 10, dailySpendCeilingCents: 5_000,
};
const ON = { LIVE_ASSIST_ENABLED: "true" };

describe("LA-1a policy — the kill switch", () => {
  it("is on only for the exact string 'true'", () => {
    expect(deploymentSwitchOn({ LIVE_ASSIST_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", "yes", "true "]) expect(deploymentSwitchOn({ LIVE_ASSIST_ENABLED: v }), String(v)).toBe(false);
  });

  it("is off unless the deployment switch, an enabled organization policy and a spend ceiling all say on", () => {
    expect(resolvePolicy(ok, ON).enabled).toBe(true);
    expect(resolvePolicy(ok, {}).disabledBecause).toEqual(["deployment_switch_off"]);
    expect(resolvePolicy(null, ON).disabledBecause).toEqual(["no_organization_policy"]);
    expect(resolvePolicy({ ...ok, enabled: false }, ON).disabledBecause).toEqual(["organization_disabled"]);
    expect(resolvePolicy({ ...ok, dailySpendCeilingCents: null }, ON).disabledBecause).toEqual(["no_spend_ceiling"]);
    expect(resolvePolicy(null, {}).enabled).toBe(false);
  });
});

describe("LA-1a policy — organizations can only reduce", () => {
  it("accepts a policy inside the hard limits", () => {
    expect(validatePolicyInput(ok)).toEqual([]);
  });

  it("refuses, rather than clamps, anything above them", () => {
    const v = validatePolicyInput({ ...ok, idleSeconds: 9999, maxSessionMinutes: 999, retentionHours: 999, maxSessionsPerUserPerDay: 999 });
    expect(v.map(x => x.field).sort()).toEqual(["idleSeconds", "maxSessionMinutes", "maxSessionsPerUserPerDay", "retentionHours"]);
  });

  it("refuses sources this release has not built", () => {
    for (const s of ["camera", "screen", "video"] as const) {
      expect(validatePolicyInput({ ...ok, sourcesAllowed: ["photo", s] }).map(x => x.field)).toContain("sourcesAllowed");
    }
    expect(LEASEOS_HARD_LIMITS.sourcesAllowed).toEqual(["photo"]);
  });

  it("refuses non-integers, zero and negatives", () => {
    expect(validatePolicyInput({ ...ok, idleSeconds: 1.5 }).length).toBeGreaterThan(0);
    expect(validatePolicyInput({ ...ok, maxSessionMinutes: 0 }).length).toBeGreaterThan(0);
    expect(validatePolicyInput({ ...ok, dailySpendCeilingCents: -1 }).length).toBeGreaterThan(0);
  });

  it("reads a stored row that exceeds the limits through them, never above them", () => {
    const p = resolvePolicy({ ...ok, idleSeconds: 99_999, maxSessionMinutes: 99_999, retentionHours: 99_999, sourcesAllowed: ["photo", "screen"] }, ON);
    expect(p.limits.idleSeconds).toBe(LEASEOS_HARD_LIMITS.idleSeconds);
    expect(p.limits.maxSessionMinutes).toBe(LEASEOS_HARD_LIMITS.maxSessionMinutes);
    expect(p.limits.retentionHours).toBe(LEASEOS_HARD_LIMITS.retentionHours);
    expect(p.sourcesAllowed).toEqual(["photo"]);
  });
});
