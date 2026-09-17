/**
 * B27 — a projection may change the number and nothing else.
 */
import { describe, expect, it } from "vitest";
import {
  DISPATCH_PROJECTORS, dispatchReadinessPayload, HOS_PROJECTORS, hosViolationPayload,
  preservesConfidence, project, projectAll,
  type DispatchGateAnswer, type HosSummary, type Projector,
} from "./_core/widgetProjection";
import { blocked, ok, unknown, type Provenance, type WidgetPayload } from "./_core/widgetPayload";

const NOW = new Date("2026-09-12T14:00:00Z");
const prov: Provenance = {
  source: "system_inferred", verification: "unverified", exact: true, observedAt: NOW,
  datasetVersion: "CA-AB/cycle1/2026.1",
};

const summary = (o: Partial<HosSummary> = {}): HosSummary => ({
  dutyStatus: "driving",
  drivingRemainingMinutes: 252, drivingLimitMinutes: 780,
  onDutyRemainingMinutes: 300, onDutyLimitMinutes: 840,
  cycleRemainingMinutes: 1200, cycleLimitMinutes: 4200,
  breakDueInMinutes: 95, violations: [], hasUncertifiedEdits: false,
  ruleProfile: { jurisdiction: "CA-AB", ruleFamily: "cycle1", version: "2026.1", contentHash: "abc123" },
  calculatedAt: NOW, ...o,
});

const NON_VALUE: WidgetPayload<HosSummary>[] = [
  unknown("no verified rule profile cached on this device"),
  blocked([{ code: "LOG_GAP", detail: "Unassigned driving between 09:12 and 09:40" }]),
  { state: "offline" },
  { state: "not_permitted", permission: "hos.read" },
  { state: "failed", reason: "log store unavailable" },
];

describe("one engine answer, five tiles", () => {
  it("projects five HOS widgets from one summary", () => {
    const parent = ok(summary(), prov);
    const tiles = projectAll(parent, HOS_PROJECTORS);
    expect(Object.keys(tiles)).toHaveLength(6);
    for (const [key, payload] of Object.entries(tiles)) {
      expect(payload.state, key).toBe("ok");
    }
  });

  it("gives each tile its own field, not a re-derivation", () => {
    const parent = ok(summary(), prov);
    const tiles = projectAll(parent, HOS_PROJECTORS);
    const value = (k: string) => (tiles[k] as { value: { current: number } }).value.current;
    expect(value("drivingRemaining")).toBe(252);
    expect(value("onDutyRemaining")).toBe(300);
    expect(value("cycleRemaining")).toBe(1200);
    expect(value("breakCountdown")).toBe(95);
  });

  it("shares one provenance across every projection", () => {
    const parent = ok(summary(), prov);
    const tiles = projectAll(parent, HOS_PROJECTORS);
    for (const payload of Object.values(tiles)) {
      expect((payload as { provenance: Provenance }).provenance).toBe(prov);
    }
  });

  it("carries the rule profile into the duty-status tile", () => {
    const tile = project(ok(summary(), prov), HOS_PROJECTORS.dutyStatus);
    expect(JSON.stringify(tile)).toContain("CA-AB cycle1 v2026.1");
  });
});

describe("confidence cannot rise through a projection", () => {
  it("passes every non-value state through untouched, in every projector", () => {
    for (const parent of NON_VALUE) {
      for (const [key, projector] of Object.entries(HOS_PROJECTORS) as [string, Projector<HosSummary, unknown>][]) {
        const child = project(parent, projector);
        expect(child.state, `${key} from ${parent.state}`).toBe(parent.state);
        expect(preservesConfidence(parent, child)).toBe(true);
      }
    }
  });

  it("never turns unknown into ok", () => {
    const child = project(unknown<HosSummary>("no rule profile"), HOS_PROJECTORS.hosRemaining);
    expect(child.state).toBe("unknown");
    expect((child as { reason: string }).reason).toBe("no rule profile");
  });

  it("keeps a blocked parent's blockers in the child", () => {
    const parent = blocked<HosSummary>([{ code: "LOG_GAP", detail: "Unassigned driving 09:12–09:40" }]);
    const child = project(parent, HOS_PROJECTORS.cycleRemaining);
    expect(child.state).toBe("blocked");
    expect((child as unknown as { blockers: { code: string }[] }).blockers[0]?.code).toBe("LOG_GAP");
  });

  it("keeps a stale parent stale, with its as-of time", () => {
    const parent: WidgetPayload<HosSummary> = { state: "stale", value: summary(), asOf: NOW, provenance: prov };
    const child = project(parent, HOS_PROJECTORS.onDutyRemaining);
    expect(child).toMatchObject({ state: "stale", asOf: NOW });
    expect(preservesConfidence(parent, child)).toBe(true);
  });

  it("does not call the projector at all for a non-value state", () => {
    let called = 0;
    project(unknown<HosSummary>("x"), { name: "counter", project: () => { called++; return 1; } });
    // Not "the projector returned the right thing" — it was never consulted,
    // which is what makes the rule structural.
    expect(called).toBe(0);
  });

  it("degrades a throwing projector to one failed tile", () => {
    const child = project(ok(summary(), prov), { name: "bad", project: () => { throw new Error("boom"); } });
    expect(child).toMatchObject({ state: "failed" });
    expect((child as { reason: string }).reason).toContain("bad: boom");
    expect(preservesConfidence(ok(summary(), prov), child)).toBe(true);
  });
});

describe("severity is raised in the open, never inside a projector", () => {
  it("turns accrued violations into a blocked tile with the names", () => {
    const parent = ok(summary({ violations: [{ code: "DRIVING_OVER", detail: "Driving limit exceeded by 22 minutes" }] }), prov);
    const tile = hosViolationPayload(parent);
    expect(tile.state).toBe("blocked");
    expect((tile as unknown as { blockers: { code: string }[] }).blockers[0]?.code).toBe("DRIVING_OVER");
  });

  it("says so plainly when there are none", () => {
    expect(hosViolationPayload(ok(summary(), prov))).toMatchObject({ state: "ok", value: "no violations on this log" });
  });

  it("does not invent a violation from an unknown parent", () => {
    expect(hosViolationPayload(unknown("no profile"))).toMatchObject({ state: "unknown" });
  });
});

describe("dispatch gate projections", () => {
  const gate = (o: Partial<DispatchGateAnswer> = {}): DispatchGateAnswer =>
    ({ ready: true, blockers: [], checkedAt: NOW, ...o });

  it("reads one gate answer three ways", () => {
    const blockers = [
      { code: "INSPECTION", detail: "Annual inspection expired" },
      { code: "RELEASE", detail: "DEF-4471 has no mechanic release" },
    ];
    const parent = ok(gate({ ready: false, blockers }), prov);
    expect(dispatchReadinessPayload(parent)).toMatchObject({ state: "blocked" });
    expect(project(parent, DISPATCH_PROJECTORS.blockerCount)).toMatchObject({ state: "ok", value: "2" });
    const list = project(parent, DISPATCH_PROJECTORS.blockerList);
    expect(JSON.stringify(list)).toContain("DEF-4471");
  });

  it("cannot report ready when the gate said not ready", () => {
    const parent = ok(gate({ ready: false, blockers: [{ code: "X", detail: "x" }] }), prov);
    expect(dispatchReadinessPayload(parent).state).toBe("blocked");
  });

  it("never drops a blocker to make a count look better", () => {
    const parent = ok(gate({ ready: false, blockers: [{ code: "A", detail: "a" }, { code: "B", detail: "b" }] }), prov);
    const count = project(parent, DISPATCH_PROJECTORS.blockerCount);
    expect((count as { value: string }).value).toBe("2");
  });
});
