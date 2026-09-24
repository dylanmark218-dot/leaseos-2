/**
 * The organization-switch contract.
 *
 * The switch is where a handset is closest to mixing two companies' material,
 * so these tests are about ORDER and REFUSAL rather than about the steps being
 * present: a plan with every right step in the wrong sequence still leaks.
 */
import { describe, expect, it } from "vitest";
import { organizationSwitchPlan, syncNamespace, type DeviceSwitchState } from "@shared/organizationSwitch";

const state = (over: Partial<DeviceSwitchState> = {}): DeviceSwitchState => ({
  holding: "ORG-A", target: "ORG-B", deviceBoundTo: "ORG-B", unsentCaptures: 0, ...over,
});
const names = (p: ReturnType<typeof organizationSwitchPlan>) => p.steps.map(s => s.step);

describe("the sync namespace", () => {
  it("gives each organization its own, and never lets one be a prefix of another's key space", () => {
    expect(syncNamespace("ORG-A")).toBe("org:ORG-A");
    expect(syncNamespace("ORG-A")).not.toBe(syncNamespace("ORG-AB"));
    // A reference that looks like a namespace is still only ever a value.
    expect(syncNamespace("org:ORG-A")).toBe("org:org:ORG-A");
  });

  it("gives the caller with no organization a namespace of its own, not the root", () => {
    expect(syncNamespace(null)).toBe("org:~unattributed");
    expect(syncNamespace(null)).not.toBe("");
  });
});

describe("what the device must do on a switch", () => {
  it("does nothing at all when the organization has not changed", () => {
    const p = organizationSwitchPlan(state({ holding: "ORG-A", target: "ORG-A" }));
    expect(p.outcome).toBe("no_change");
    expect(p.steps).toEqual([]);
  });

  it("halts sync before anything that changes what a package would be sent under", () => {
    const steps = names(organizationSwitchPlan(state()));
    expect(steps[0]).toBe("halt_sync");
    // Everything else is after it, which is the claim — not just that it appears.
    expect(steps.indexOf("halt_sync")).toBeLessThan(steps.indexOf("switch_namespace"));
    expect(steps.indexOf("halt_sync")).toBeLessThan(steps.indexOf("resync"));
  });

  it("reloads permissions before dropping the cache, so the old answers never request the new data", () => {
    const steps = names(organizationSwitchPlan(state()));
    expect(steps.indexOf("reload_permissions")).toBeLessThan(steps.indexOf("purge_tenant_cache"));
  });

  it("purges the OLD namespace, and does it before the namespace moves", () => {
    const p = organizationSwitchPlan(state({ holding: "ORG-A", target: "ORG-B" }));
    const purge = p.steps.find(s => s.step === "purge_tenant_cache");
    expect(purge).toEqual({ step: "purge_tenant_cache", of: "org:ORG-A" });
    expect(names(p).indexOf("purge_tenant_cache")).toBeLessThan(names(p).indexOf("switch_namespace"));
  });

  it("fetches exactly once, and not until the namespace has already moved", () => {
    const steps = names(organizationSwitchPlan(state()));
    expect(steps[steps.length - 1]).toBe("resync");
    /*
     * The count matters as much as the position. Asserting only that the LAST
     * step is `resync` let a mutant add a second one immediately after
     * `halt_sync` and survive — and that early fetch is the whole bug this
     * ordering exists to prevent, because it pulls the new organization's
     * records down into the old organization's namespace, where the purge has
     * already run and will not run again.
     */
    expect(steps.filter(s => s === "resync")).toHaveLength(1);
    expect(steps.indexOf("resync")).toBeGreaterThan(steps.indexOf("switch_namespace"));
  });

  it("emits each step at most once, whatever the device state", () => {
    // A repeated step is always either wasted work or, for the ordered ones, a
    // second chance to do it at the wrong moment.
    for (const st of [state(), state({ deviceBoundTo: null }), state({ holding: null }), state({ target: null })]) {
      const steps = names(organizationSwitchPlan(st));
      expect(new Set(steps).size, steps.join(" > ")).toBe(steps.length);
    }
  });

  it("says the device must be re-enrolled when it is bound elsewhere, and stays quiet when it is not", () => {
    const elsewhere = organizationSwitchPlan(state({ deviceBoundTo: "ORG-A", target: "ORG-B" }));
    expect(elsewhere.steps).toContainEqual({ step: "reenrol_device", boundTo: "ORG-A", requiredFor: "ORG-B" });
    expect(names(organizationSwitchPlan(state({ deviceBoundTo: "ORG-B", target: "ORG-B" })))).not.toContain("reenrol_device");
    // A device that was never enrolled is the same case: it is not bound to the target.
    expect(organizationSwitchPlan(state({ deviceBoundTo: null })).steps)
      .toContainEqual({ step: "reenrol_device", boundTo: null, requiredFor: "ORG-B" });
  });

  it("switches into and out of the unattributed namespace like any other", () => {
    const joining = organizationSwitchPlan(state({ holding: null, target: "ORG-B" }));
    expect(joining.steps).toContainEqual({ step: "purge_tenant_cache", of: "org:~unattributed" });
    const leaving = organizationSwitchPlan(state({ holding: "ORG-A", target: null, deviceBoundTo: null }));
    expect(leaving.steps).toContainEqual({ step: "switch_namespace", from: "org:ORG-A", to: "org:~unattributed" });
  });
});

describe("unsent captures stop the switch", () => {
  it("refuses rather than carrying them into another organization, and emits no steps at all", () => {
    const p = organizationSwitchPlan(state({ unsentCaptures: 12, holding: "ORG-A" }));
    expect(p.outcome).toBe("blocked");
    expect(p.steps).toEqual([]);   // a caller that ignores `outcome` still does nothing
    if (p.outcome !== "blocked") throw new Error("unreachable");
    expect(p.unsentCaptures).toBe(12);
    expect(p.belongingTo).toBe("ORG-A");
  });

  it("refuses before considering anything else, including a device that is already correctly bound", () => {
    expect(organizationSwitchPlan(state({ unsentCaptures: 1, deviceBoundTo: "ORG-B" })).outcome).toBe("blocked");
  });

  it("does not refuse a no-op switch, which moves nothing anywhere", () => {
    // The captures are not going anywhere: the device is already on that
    // organization, so there is nothing to protect them from.
    expect(organizationSwitchPlan(state({ holding: "ORG-A", target: "ORG-A", unsentCaptures: 9 })).outcome).toBe("no_change");
  });

  it("names a count and an owner, so the refusal can be acted on without a second call", () => {
    const p = organizationSwitchPlan(state({ unsentCaptures: 3, holding: "ORG-A" }));
    if (p.outcome !== "blocked") throw new Error("unreachable");
    expect(p.reason).toMatch(/synchronize them first/i);
    expect(p.reason).not.toContain("ORG-B");   // the destination is not the captures' business
  });
});
