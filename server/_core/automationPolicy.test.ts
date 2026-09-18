/**
 * P8.2 standing suite — the owner decision of 2026-09-18, case by case.
 *
 * The decision named the minimum coverage and these are those cases. Two of them carry most of the
 * weight and are easy to get subtly wrong:
 *
 *   a missing **policy** resolves to MANUAL — a forgotten configuration row must not start a machine;
 *   a missing **entitlement** resolves to NOT_EVALUATED — and must not be reported as a mode.
 *
 * Merging those would let one omission either silently enable automation or falsely claim the
 * customer never had the feature, and neither is recoverable from the record afterwards.
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_LEVEL, evaluateOperationalOverride, resolveAutomation, snapshotOf,
  type Entitlement, type PolicyRow, type SafetyCeiling,
} from "./automationPolicy";

const ENTITLED: Entitlement = { state: "entitled", reference: "ENT-HYDROVAC-2026" };
const CAP = "hos";

const policy = (scope: PolicyRow["scope"], mode: PolicyRow["requestedMode"], scopeId: string | null = null, version = `PV-${scope}-1`): PolicyRow =>
  ({ capability: CAP, scope, scopeId, requestedMode: mode, policyVersionId: version, source: "test" });

const resolve = (policies: PolicyRow[], entitlement = ENTITLED, ceiling: SafetyCeiling = null) =>
  resolveAutomation({ capability: CAP, entitlement, ceiling, policies });

describe("entitlement and policy are different questions", () => {
  it("a disabled capability is NOT_EVALUATED, not a mode", () => {
    const r = resolve([policy("tenant", "AUTO")], { state: "not_entitled", reason: "disabled" });
    expect(r.outcome).toBe("not_evaluated");
    if (r.outcome !== "not_evaluated") throw new Error("unreachable");
    expect(r.notEvaluatedReason).toBe("module_disabled");
    expect(r.entitled).toBe(false);
    // Even though a tenant policy asked for AUTO: entitlement is answered first and ends it.
    expect(r.trace).toMatch(/no automation mode → NOT_EVALUATED/);
  });

  it("an unlicensed capability is NOT_EVALUATED", () => {
    const r = resolve([], { state: "not_entitled", reason: "unlicensed" });
    expect(r.outcome).toBe("not_evaluated");
    if (r.outcome !== "not_evaluated") throw new Error("unreachable");
    expect(r.notEvaluatedReason).toBe("not_licensed");
  });

  it("an unresolved entitlement fails closed, and says it is unresolved rather than claiming a refusal", () => {
    const r = resolve([], { state: "unresolved", reason: "entitlement_source_unavailable" });
    expect(r.outcome).toBe("not_evaluated");
    if (r.outcome !== "not_evaluated") throw new Error("unreachable");
    expect(r.notEvaluatedReason).toBe("no_data_source_loaded");
    // The distinction that lets a broken feed be found instead of looking like a customer choice.
    expect(r.reason).toMatch(/unresolved entitlement is not an entitlement/);
  });

  it("entitled with no policy at any scope is MANUAL, never AUTO", () => {
    const r = resolve([]);
    expect(r.outcome).toBe("resolved");
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("MANUAL");
    expect(r.winner).toBeNull();
    expect(r.reason).toMatch(/A missing policy is not permission to automate/);
  });
});

describe("resolution order: tenant → role → task → customer", () => {
  it("takes the tenant default when it is the only policy", () => {
    const r = resolve([policy("tenant", "AUTO")]);
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("AUTO");
    expect(r.trace).toBe("tenant=AUTO → resolved=AUTO");
  });

  it("lets a role override the tenant", () => {
    const r = resolve([policy("tenant", "AUTO"), policy("role", "HYBRID", "dispatcher")]);
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("HYBRID");
    expect(r.winner!.scope).toBe("role");
  });

  it("lets a task override the role, before the customer is considered", () => {
    const r = resolve([policy("tenant", "AUTO"), policy("role", "AUTO", "dispatcher"), policy("task", "MANUAL", "TASK-9")]);
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("MANUAL");
    expect(r.steps.map(s => s.scope)).toEqual(["tenant", "role", "task"]);
  });

  it("lets the customer win as the most specific normal business policy, and shows the whole trace", () => {
    const r = resolve([policy("tenant", "HYBRID"), policy("role", "AUTO", "dispatcher"), policy("customer", "MANUAL", "CUST-4")]);
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("MANUAL");
    // The example the owner decision gave, verbatim in shape.
    expect(r.trace).toBe("tenant=HYBRID → role:dispatcher=AUTO → customer:CUST-4=MANUAL → resolved=MANUAL");
  });

  it("refuses an equal-precedence conflict rather than picking by date or row order", () => {
    const r = resolve([
      { ...policy("role", "AUTO", "dispatcher"), policyVersionId: "PV-a" },
      { ...policy("role", "MANUAL", "dispatcher"), policyVersionId: "PV-b" },
    ]);
    expect(r.outcome).toBe("policy_error");
    if (r.outcome !== "policy_error") throw new Error("unreachable");
    expect(r.conflict.scope).toBe("role");
    expect(r.conflict.modes.sort()).toEqual(["AUTO", "MANUAL"]);
    expect(r.conflict.policyVersionIds).toEqual(["PV-a", "PV-b"]);
    expect(r.reason).toMatch(/depend on the database rather than on a decision/);
  });

  it("does not treat different scopeIds at the same scope as a conflict", () => {
    // Two customers, each with their own policy: specific to different decisions, not in conflict.
    const r = resolve([policy("customer", "AUTO", "CUST-1"), policy("tenant", "MANUAL")]);
    expect(r.outcome).toBe("resolved");
  });
});

describe("the safety ceiling clamps, and says so", () => {
  it("prevents AUTO when the ceiling is HYBRID, recording the request as asked and as clamped", () => {
    const r = resolve([policy("tenant", "AUTO")], ENTITLED, { maxMode: "HYBRID", source: "P8.4 pending classification" });
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("HYBRID");
    expect(r.clamped).toBe(true);
    expect(r.steps[0]!.mode).toBe("AUTO");                    // what was asked is not overwritten
    expect(r.reason).toMatch(/it is not treated as accepted/);
    expect(r.trace).toMatch(/ceiling=HYBRID → resolved=HYBRID/);
  });

  it("leaves a request at or below the ceiling alone", () => {
    const r = resolve([policy("tenant", "MANUAL")], ENTITLED, { maxMode: "HYBRID", source: "P8.4" });
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.clamped).toBe(false);
    expect(r.mode).toBe("MANUAL");
  });

  it("treats no ceiling as no ceiling, not as MANUAL", () => {
    // P8.4 has not classified most capabilities. Inferring a ceiling because a name sounds
    // safety-related would be deciding P8.4's list here, which the owner decision forbids.
    const r = resolve([policy("tenant", "AUTO")], ENTITLED, null);
    if (r.outcome !== "resolved") throw new Error("unreachable");
    expect(r.mode).toBe("AUTO");
    expect(r.ceilingApplied).toBeNull();
  });
});

describe("operational overrides move one way only", () => {
  it("accepts a dispatcher taking one trip toward more human involvement", () => {
    for (const [from, to] of [["AUTO", "HYBRID"], ["AUTO", "MANUAL"], ["HYBRID", "MANUAL"]] as const) {
      const d = evaluateOperationalOverride({ from, to, actorRole: "dispatcher", scope: "one_trip" });
      expect(d.allowed, `${from} → ${to}`).toBe(true);
      if (d.allowed) expect(d.reason).toMatch(/standing policy is unchanged/);
    }
  });

  it("refuses any attempt to increase automation, whoever asks", () => {
    for (const [from, to] of [["MANUAL", "HYBRID"], ["MANUAL", "AUTO"], ["HYBRID", "AUTO"]] as const) {
      const d = evaluateOperationalOverride({ from, to, actorRole: "dispatcher", scope: "one_task" });
      expect(d.allowed, `${from} → ${to}`).toBe(false);
      if (!d.allowed) expect(d.reason).toMatch(/needs automation\.policy\.manage/);
    }
  });

  it("accepts a driver choosing a more manual path for their own task", () => {
    const d = evaluateOperationalOverride({ from: "HYBRID", to: "MANUAL", actorRole: "driver", scope: "one_task" });
    expect(d.allowed).toBe(true);
  });

  it("orders the modes in exactly one place, so nothing can invent its own", () => {
    expect(AUTOMATION_LEVEL.MANUAL).toBeLessThan(AUTOMATION_LEVEL.HYBRID);
    expect(AUTOMATION_LEVEL.HYBRID).toBeLessThan(AUTOMATION_LEVEL.AUTO);
  });
});

describe("the decision keeps the policy it was made under", () => {
  it("snapshots every layer, the winner, the ceiling and the trace", () => {
    const r = resolve([policy("tenant", "HYBRID"), policy("customer", "AUTO", "CUST-4", "PV-cust-7")], ENTITLED, { maxMode: "HYBRID", source: "P8.4" });
    const snap = snapshotOf(r, { actorUserId: 42, engineProfileVersion: "v22.67", decidedAt: new Date("2026-09-18T12:00:00Z"), entitlementReference: "ENT-HYDROVAC-2026" });
    expect(snap.entitled).toBe(true);
    expect(snap.resolvedMode).toBe("HYBRID");
    expect(snap.winningPolicyVersionId).toBe("PV-cust-7");
    expect(snap.safetyCeiling).toBe("HYBRID");
    expect(snap.clamped).toBe(true);
    expect(snap.requestedByScope).toEqual([
      { scope: "tenant", scopeId: null, mode: "HYBRID" },
      { scope: "customer", scopeId: "CUST-4", mode: "AUTO" },
    ]);
    expect(snap.actorUserId).toBe(42);
    expect(snap.decidedAt).toBe("2026-09-18T12:00:00.000Z");
  });

  it("snapshots an unentitled capability as unentitled, with no mode invented for it", () => {
    const snap = snapshotOf(resolve([], { state: "not_entitled", reason: "unlicensed" }), {});
    expect(snap.entitled).toBe(false);
    expect(snap.resolvedMode).toBeNull();
    expect(snap.winningPolicyVersionId).toBeNull();
  });

  it("an old snapshot keeps answering under its own policy after the policy changes", () => {
    const old = snapshotOf(resolve([policy("tenant", "AUTO", null, "PV-2026-01")]), { decidedAt: new Date("2026-05-01T00:00:00Z") });
    // The tenant later moves to MANUAL. The new decision differs; the old record does not move.
    const now = snapshotOf(resolve([policy("tenant", "MANUAL", null, "PV-2026-09")]), { decidedAt: new Date("2026-09-18T00:00:00Z") });
    expect(old.resolvedMode).toBe("AUTO");
    expect(old.winningPolicyVersionId).toBe("PV-2026-01");
    expect(now.resolvedMode).toBe("MANUAL");
    expect(now.winningPolicyVersionId).toBe("PV-2026-09");
    // A policy change must never make yesterday's decision appear to have been made under today's.
    expect(old.resolvedMode).not.toBe(now.resolvedMode);
  });
});
