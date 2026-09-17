/**
 * B23 — what a widget may say. Every assertion names an outcome state.
 */
import { describe, expect, it } from "vitest";
import {
  blocked, freshness, isConfirmed, ok, rollup, severityOf, unknown,
  type Provenance, type WidgetPayload,
} from "./_core/widgetPayload";

const NOW = new Date("2026-09-12T12:00:00Z");
const prov = (o: Partial<Provenance> = {}): Provenance => ({
  source: "measured", verification: "verified", exact: true, observedAt: NOW, ...o,
});

describe("the state union", () => {
  it("makes ok the only state carrying a bare value", () => {
    const good = ok(31_500, prov());
    expect(good.state).toBe("ok");
    // @ts-expect-error — unknown has no value to read; that is the whole point.
    const leak = unknown<number>("no rule loaded").value;
    expect(leak).toBeUndefined();
  });

  it("refuses a blocked tile that names no blocker, rather than printing 'incomplete'", () => {
    expect(blocked([])).toMatchObject({ state: "unknown" });
    expect(blocked([{ code: "INSPECTION_EXPIRED", detail: "Annual inspection expired 2026-08-14" }]))
      .toMatchObject({ state: "blocked" });
  });
});

describe("freshness", () => {
  it("returns ok inside the budget and stale past it, never unknown", () => {
    const observed = new Date("2026-09-12T11:30:00Z");
    const inside = freshness(8.2, prov({ observedAt: observed }), 60, NOW);
    expect(inside.state).toBe("ok");

    const outside = freshness(8.2, prov({ observedAt: observed }), 15, NOW);
    expect(outside).toMatchObject({ state: "stale", value: 8.2, asOf: observed });
  });

  it("treats a zero budget as live-only", () => {
    const observed = new Date("2026-09-12T11:59:59Z");
    expect(freshness({ lat: 1, lng: 2 }, prov({ observedAt: observed }), 0, NOW).state).toBe("stale");
  });
});

describe("rollup dominance", () => {
  const mixed: WidgetPayload<unknown>[] = [
    ok(1, prov()),
    { state: "stale", value: 2, asOf: NOW, provenance: prov() },
    unknown("no verified axle limit for this structure"),
  ];

  it("never rounds an unknown contributor up to ok", () => {
    const r = rollup(mixed);
    expect(r.headline).toBe("unknown");
    expect(r.contributing).toContain("ok");
    expect(r.unknowns).toHaveLength(1);
  });

  it("puts blocked at the headline but does not lose the unknown behind it", () => {
    const r = rollup([
      ...mixed,
      blocked([{ code: "NO_MECHANIC_RELEASE", detail: "Critical defect DEF-4471 has no release" }]),
    ]);
    expect(r.headline).toBe("blocked");
    expect(r.blockers.map((b) => b.code)).toEqual(["NO_MECHANIC_RELEASE"]);
    // The failure this pins: clearing the blocker revealing a second problem
    // nobody had been shown.
    expect(r.unknowns).toEqual(["no verified axle limit for this structure"]);
    expect(r.contributing).toContain("unknown");
  });

  it("ranks a withheld contributor below every substantive one", () => {
    const r = rollup([{ state: "not_permitted", permission: "billing.read" }, blocked([{ code: "X", detail: "x" }])]);
    expect(r.headline).toBe("blocked");
    expect(severityOf("not_permitted")).toBeLessThan(severityOf("unknown"));
    expect(severityOf("ok")).toBeLessThan(severityOf("stale"));
  });

  it("summarises an empty board as unknown, not as ok", () => {
    expect(rollup([]).headline).toBe("unknown");
  });

  /**
   * Regression — the ordering array was most-severe-first while `rollup` took
   * the highest rank, so every mixed board summarised as its *best*
   * contributor. Pinned as a full ascending chain so reordering the constant
   * fails here rather than showing a green tile over an unloaded rule.
   */
  it("ranks every state in strictly ascending severity", () => {
    const chain = ["ok", "not_permitted", "stale", "offline", "failed", "unknown", "blocked"] as const;
    for (let i = 1; i < chain.length; i++) {
      expect(severityOf(chain[i]!)).toBeGreaterThan(severityOf(chain[i - 1]!));
    }
  });

  it("ranks a state it has never heard of above every known one", () => {
    // A member added to WidgetState without being ranked must not become the
    // safest thing on the board.
    const future = "quarantined" as unknown as Parameters<typeof severityOf>[0];
    expect(severityOf(future)).toBeGreaterThan(severityOf("blocked"));
  });
});

describe("isConfirmed", () => {
  it("accepts only a verified, exact, live value", () => {
    expect(isConfirmed(ok(8.2, prov()))).toBe(true);
    expect(isConfirmed(ok(8.2, prov({ verification: "unverified" })))).toBe(false);
    // "about 8,000 litres" — recorded, displayable, not billable.
    expect(isConfirmed(ok(8000, prov({ exact: false, source: "driver_voice" })))).toBe(false);
    expect(isConfirmed({ state: "stale", value: 8.2, asOf: NOW, provenance: prov() })).toBe(false);
    expect(isConfirmed(unknown("no scale ticket"))).toBe(false);
  });
});
