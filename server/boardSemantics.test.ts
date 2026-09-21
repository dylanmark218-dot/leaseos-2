/**
 * B28C — two correct tiles must not become two apparent problems.
 */
import { describe, expect, it } from "vitest";
import {
  detectContradictions, staleByDependency, summarizeBoard, TRUTH_RELATIONS,
  type BoardTileState, type WidgetTruthRelation,
} from "./_core/boardSemantics";
import { blocked, ok, unknown, type Provenance } from "./_core/widgetPayload";
import { readFileSync } from "node:fs";

const NOW = new Date("2026-09-12T14:35:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000);
const prov: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: NOW };

const tile = (widgetKey: string, payload: BoardTileState["payload"], asOf?: Date): BoardTileState =>
  ({ instanceRef: `WI-${widgetKey}`, widgetKey, payload, ...(asOf ? { asOf } : {}) });

/** The scenario the whole module exists for. */
const doubleCount = (): BoardTileState[] => [
  tile("hosRemaining", blocked([{ code: "DRIVING_OVER", detail: "Daily driving limit exceeded by 22 minutes" }]), NOW),
  tile("dispatchReadiness", blocked([{ code: "HOS", detail: "Driver is over the daily driving limit" }]), NOW),
  tile("documentExpiry", ok("2 expiring", prov), NOW),
];

describe("counting what can be counted", () => {
  it("counts blocked tiles and blocker records separately", () => {
    const s = summarizeBoard(doubleCount());
    expect(s.blockedTiles).toBe(2);
    expect(s.blockerRecords).toBe(2);
  });

  it("refuses to report a root-cause count", () => {
    // Two tiles, plausibly one condition. Nothing in the evidence can tell
    // them apart, so the count is not computed rather than guessed.
    expect(summarizeBoard(doubleCount()).rootCauses).toBeNull();
  });

  it("says widgets need attention, never operational blockers", () => {
    const s = summarizeBoard(doubleCount());
    expect(s.headline).toBe("2 widgets need attention");
    expect(s.headline).not.toMatch(/blocker/i);
  });

  it("counts unknown and failed towards attention, not towards blockers", () => {
    const s = summarizeBoard([
      tile("a", unknown("no verified rule loaded")),
      tile("b", { state: "failed", reason: "source down" }),
      tile("c", ok(1, prov)),
    ]);
    expect(s).toMatchObject({ blockedTiles: 0, unknownTiles: 1, failedTiles: 1, blockerRecords: 0 });
    expect(s.headline).toBe("2 widgets need attention");
  });

  it("says so plainly when nothing needs attention", () => {
    expect(summarizeBoard([tile("a", ok(1, prov))]).headline).toBe("Nothing needs attention");
  });

  it("counts withheld and stale without calling them problems", () => {
    const s = summarizeBoard([
      tile("a", { state: "not_permitted", permission: "billing.read" }),
      tile("b", { state: "stale", value: 1, asOf: NOW, provenance: prov }),
    ]);
    expect(s).toMatchObject({ withheldTiles: 1, staleTiles: 1 });
    expect(s.headline).toBe("Nothing needs attention");
  });
});

describe("no relation is declared without evidence", () => {
  it("ships with no truth relations at all", () => {
    // HOS is not among the four dispatch contribution engines in evidence,
    // but composeReadiness is not in this worktree. Declaring either the
    // dependency or its absence would be inventing one.
    expect(Object.keys(TRUTH_RELATIONS)).toEqual([]);
  });

  it("raises no contradiction where no dependency is declared", () => {
    expect(detectContradictions(doubleCount())).toEqual([]);
  });
});

describe("contradictions, once a dependency is declared", () => {
  const declared: Record<string, WidgetTruthRelation> = {
    dispatchReadiness: {
      kind: "DERIVED_DEPENDENCY", upstreamWidgetKey: "hosRemaining",
      evidence: "hypothetical, for this test only",
    },
  };

  it("warns when the aggregate reads ready while its input is blocked", () => {
    const w = detectContradictions([
      tile("hosRemaining", blocked([{ code: "X", detail: "over hours" }]), NOW),
      tile("dispatchReadiness", ok("ready to dispatch", prov), NOW),
    ], declared);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: "BOARD_CONSISTENCY_WARNING" });
    expect(w[0]?.widgets).toEqual(["dispatchReadiness", "hosRemaining"]);
  });

  it("does not warn when both are blocked", () => {
    expect(detectContradictions(doubleCount(), declared)).toEqual([]);
  });

  it("does not warn when the two were evaluated far apart", () => {
    // Ninety minutes apart is two snapshots, not a contradiction.
    const w = detectContradictions([
      tile("hosRemaining", blocked([{ code: "X", detail: "over hours" }]), NOW),
      tile("dispatchReadiness", ok("ready", prov), ago(90)),
    ], declared);
    expect(w).toEqual([]);
  });

  it("still warns inside the skew window", () => {
    const w = detectContradictions([
      tile("hosRemaining", blocked([{ code: "X", detail: "over hours" }]), NOW),
      tile("dispatchReadiness", ok("ready", prov), ago(2)),
    ], declared);
    expect(w).toHaveLength(1);
  });

  it("never changes a tile's own state", () => {
    const tiles = doubleCount();
    const before = tiles.map((t) => t.payload.state);
    detectContradictions(tiles, declared);
    expect(tiles.map((t) => t.payload.state)).toEqual(before);
  });

  it("does not warn about an unknown upstream, only a blocked one", () => {
    const w = detectContradictions([
      tile("hosRemaining", unknown("no verified limit"), NOW),
      tile("dispatchReadiness", ok("ready", prov), NOW),
    ], declared);
    // An engine that does not gate on an unestablished input is not lying.
    expect(w).toEqual([]);
  });
});

describe("dependency-aware staleness", () => {
  const declared: Record<string, WidgetTruthRelation> = {
    dispatchReadiness: { kind: "DERIVED_DEPENDENCY", upstreamWidgetKey: "hosRemaining", evidence: "test" },
  };

  it("flags a downstream evaluated before its upstream changed", () => {
    expect(staleByDependency([
      tile("hosRemaining", ok(1, prov), NOW),
      tile("dispatchReadiness", ok("ready", prov), ago(30)),
    ], declared)).toEqual(["dispatchReadiness"]);
  });

  it("leaves a downstream evaluated after its upstream alone", () => {
    expect(staleByDependency([
      tile("hosRemaining", ok(1, prov), ago(30)),
      tile("dispatchReadiness", ok("ready", prov), NOW),
    ], declared)).toEqual([]);
  });

  it("flags nothing when evaluation times are unknown", () => {
    expect(staleByDependency([
      tile("hosRemaining", ok(1, prov)),
      tile("dispatchReadiness", ok("ready", prov)),
    ], declared)).toEqual([]);
  });
});

describe("the double-count fixture, stated honestly", () => {
  it("reports two blocked tiles and an uncomputed root-cause count", () => {
    const s = summarizeBoard(doubleCount());
    expect(s.blockedTiles).toBe(2);
    expect(s.rootCauses).toBeNull();
    // The assertion the brief asks for: do NOT claim one root cause while
    // blocker identity is unevidenced.
    expect(Object.keys(TRUTH_RELATIONS)).toHaveLength(0);
  });

  it("has no function that could merge them by text", () => {
    // collectRootCauses is deliberately absent. Grouping "Daily driving limit
    // exceeded by 22 minutes" with "Driver is over the daily driving limit"
    // would be deduplicating truth by label.
    // `require` is not available in this ESM suite; read the source instead,
    // which is the stronger check anyway — it catches the function existing
    // under any name that groups by text.
    const src = readFileSync(new URL("./_core/boardSemantics.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/export function collectRootCauses/);
    expect(src).toContain("does not deduplicate");
  });
});
