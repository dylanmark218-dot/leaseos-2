/**
 * v22.20 — the tile that would rather say nothing than say something stale.
 */
import { describe, expect, it } from "vitest";
import {
  applyLayout, complianceTile, ContractViolation, freshnessOf, isPinnedCategory,
  PinnedWidget, render, type Provenance, type WidgetContract,
} from "./_core/dashboardWidget";

const NOW = new Date("2026-10-20T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const policy = { liveSeconds: 60, recentSeconds: 900, agingSeconds: 3_600 };

const contract = (o: Partial<WidgetContract> = {}): WidgetContract => ({
  widgetKey: "fuel_level", title: "Fuel level", category: "operations",
  requiresPermission: null, policy, emptyState: "No reading yet", pinned: false, ...o,
});
const provenance = (o: Partial<Provenance> = {}): Provenance => ({
  sourceType: "unitTelemetry", sourceRef: "UNIT-127", observedAt: ago(30), method: "telemetry", ...o,
});

describe("a value must be able to explain itself", () => {
  it("renders with its source, age and method", () => {
    const r = render({ contract: contract(), value: { display: "62%", provenance: provenance() }, heldPermissions: [], now: NOW });
    expect(r.state).toBe("value");
    if (r.state !== "value") return;
    expect(r.display).toBe("62%");
    expect(r.source).toBe("unitTelemetry:UNIT-127");
    expect(r.footnote).toBe("telemetry, 30s ago");
  });

  it("refuses to render a value with no source at all", () => {
    expect(() => render({
      contract: contract(),
      value: { display: "62%", provenance: { sourceType: "", sourceRef: "", observedAt: NOW, method: "derived" } },
      heldPermissions: [], now: NOW,
    })).toThrow(ContractViolation);
  });
});

describe("stale does not render as a number with a warning", () => {
  it("grades freshness from the observation time", () => {
    expect(freshnessOf(provenance({ observedAt: ago(10) }), NOW, policy).freshness).toBe("live");
    expect(freshnessOf(provenance({ observedAt: ago(300) }), NOW, policy).freshness).toBe("recent");
    expect(freshnessOf(provenance({ observedAt: ago(2_000) }), NOW, policy).freshness).toBe("aging");
    expect(freshnessOf(provenance({ observedAt: ago(20_000) }), NOW, policy).freshness).toBe("stale");
  });

  it("shows unavailable instead of the value once it is stale", () => {
    // A truck that lost signal at 06:00 must not look like one reporting now.
    const r = render({ contract: contract(), value: { display: "62%", provenance: provenance({ observedAt: ago(21_600) }) }, heldPermissions: [], now: NOW });
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toBe("stale");
    expect(r.message).toContain("Last observed 6 h ago — too old to show as current");
    expect(JSON.stringify(r)).not.toContain("62%");
  });

  it("refuses a value whose age cannot be established", () => {
    const r = render({ contract: contract(), value: { display: "62%", provenance: provenance({ observedAt: null }) }, heldPermissions: [], now: NOW });
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toBe("unknown");
    expect(r.message).toContain("age cannot be established");
  });

  it("still renders an aging value, because aging is not stale", () => {
    const r = render({ contract: contract(), value: { display: "62%", provenance: provenance({ observedAt: ago(2_000) }) }, heldPermissions: [], now: NOW });
    expect(r.state).toBe("value");
    if (r.state !== "value") return;
    expect(r.freshness).toBe("aging");
    expect(r.footnote).toContain("33 min ago");
  });

  it("distinguishes nothing to show from something withheld", () => {
    expect(render({ contract: contract(), value: null, heldPermissions: [], now: NOW }))
      .toMatchObject({ state: "empty", message: "No reading yet" });
  });
});

describe("permission decides whether the tile exists at all", () => {
  const payroll = contract({ widgetKey: "ytd_pay", title: "YTD earnings", category: "financial", requiresPermission: "payroll.read" });

  it("hides the tile from somebody without the permission", () => {
    expect(render({ contract: payroll, value: { display: "$48,210", provenance: provenance() }, heldPermissions: [], now: NOW }))
      .toEqual({ state: "forbidden" });
  });

  it("renders it for somebody with it", () => {
    expect(render({ contract: payroll, value: { display: "$48,210", provenance: provenance() }, heldPermissions: ["payroll.read"], now: NOW }).state)
      .toBe("value");
  });
});

describe("a compliance tile never rounds up to green", () => {
  it("shows unknown rather than clear when something could not be checked", () => {
    const t = complianceTile([
      { label: "Licence", state: "clear" }, { label: "CVIP", state: "clear" },
      { label: "Insurance", state: "clear" }, { label: "TDG", state: "unknown" },
    ]);
    expect(t.state).toBe("unknown");
    expect(t.summary).toContain("1 could not be checked: TDG");
  });

  it("puts blocking above unknown, and unknown above attention", () => {
    expect(complianceTile([{ label: "A", state: "attention" }, { label: "B", state: "unknown" }]).state).toBe("unknown");
    expect(complianceTile([{ label: "A", state: "unknown" }, { label: "B", state: "blocked" }]).state).toBe("blocked");
  });

  it("is clear only when everything is", () => {
    expect(complianceTile([{ label: "A", state: "clear" }, { label: "B", state: "clear" }]))
      .toMatchObject({ state: "clear", summary: "All 2 checks current" });
  });

  it("shows unknown for an empty tile rather than clear", () => {
    expect(complianceTile([]).state).toBe("unknown");
  });
});

describe("personalization has a floor", () => {
  const contracts = [
    contract({ widgetKey: "defect_alert", title: "Critical defect", category: "safety", pinned: true }),
    contract({ widgetKey: "fuel_level", position: undefined as never }),
    contract({ widgetKey: "ytd_pay", category: "financial", requiresPermission: "payroll.read" }),
  ];

  it("lets somebody reorder and hide an ordinary tile", () => {
    const out = applyLayout(contracts, [
      { widgetKey: "fuel_level", position: 0, hidden: false },
      { widgetKey: "defect_alert", position: 1, hidden: false },
    ], []);
    expect(out.map(c => c.widgetKey)).toEqual(["fuel_level", "defect_alert"]);
  });

  it("refuses to hide a pinned safety tile", () => {
    // Hiding the alert does not resolve what it is alerting about.
    expect(() => applyLayout(contracts, [{ widgetKey: "defect_alert", position: 0, hidden: true }], []))
      .toThrow(PinnedWidget);
    expect(() => applyLayout(contracts, [{ widgetKey: "defect_alert", position: 0, hidden: true }], []))
      .toThrow(/does not resolve what it is alerting about/);
  });

  it("drops a tile the viewer may not see before layout is even considered", () => {
    const out = applyLayout(contracts, [], []);
    expect(out.map(c => c.widgetKey)).not.toContain("ytd_pay");
    expect(applyLayout(contracts, [], ["payroll.read"]).map(c => c.widgetKey)).toContain("ytd_pay");
  });

  it("pins by category rather than per tile, so a new safety widget inherits it", () => {
    expect(isPinnedCategory("safety")).toBe(true);
    expect(isPinnedCategory("compliance")).toBe(true);
    expect(isPinnedCategory("financial")).toBe(false);
    expect(isPinnedCategory("personal")).toBe(false);
  });
});
