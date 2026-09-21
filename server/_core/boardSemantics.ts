/**
 * B28C — what a board of tiles is allowed to claim.
 *
 * Pure. No engine calls.
 *
 * The risk this module exists for is not a wrong number in a tile. It is two
 * correct tiles adding up to a false impression. If dispatch readiness already
 * gates on an upstream condition, a board showing that condition's own tile
 * beside the dispatch tile shows one problem twice — and a driver reading
 * "2 blockers" reasonably concludes there are two things to fix.
 *
 * The honest position, given what the 0088 evidence actually supports:
 *
 * **Blockers have no stable identity.** A dispatch contribution is
 * `{ engine, finding }` where `finding` is a sentence — "No route named for
 * this readiness", "Unknown is not coverage". There is no rule key, no record
 * ref, no root-cause id. Two sentences that mean the same thing cannot be
 * recognised as the same thing, and two that differ may still be one condition.
 *
 * So this module **does not deduplicate** and **does not count root causes**.
 * It counts tiles, which it can prove, and says plainly that root causes are
 * not computed. `collectRootCauses` is deliberately absent: implementing it
 * against prose would be the "dedup truth by label" mistake, and a board that
 * merged two real problems into one is worse than one that listed two views of
 * one problem.
 */

import type { WidgetPayload } from "./widgetPayload";

/* ------------------------------------------------------------------ */
/* Relations between tiles                                             */
/* ------------------------------------------------------------------ */

/**
 * How two tiles relate as *truths*, not as data sources.
 *
 * `PROJECTED` is already implemented — tiles sharing a source key share one
 * read. The other two are declarations about meaning that the runtime cannot
 * infer, so they are stated in the registry and carry their evidence with them.
 */
export type WidgetTruthRelation =
  /** Different underlying conditions. Document expiry and HOS. */
  | { kind: "INDEPENDENT" }
  /** Two views of one source answer. Readiness KPI and its blocker list. */
  | { kind: "PROJECTED"; ofWidgetKey: string }
  /**
   * One tile shows a condition that another aggregate already gates on.
   *
   * Both may be worth showing — a driver wants to know their hours *and*
   * whether they can be dispatched — but the board must not present them as
   * two independent problems.
   */
  | {
      kind: "DERIVED_DEPENDENCY";
      upstreamWidgetKey: string;
      /** Where the dependency was established. Never asserted without one. */
      evidence: string;
    };

/**
 * Declared relations.
 *
 * Empty on purpose. The 0088 evidence names four dispatch contribution engines
 * — routing, communications, enforcement, dispatch — and **HOS is not among
 * them**, but `composeReadiness` itself is not in this worktree, so the absence
 * is suggestive rather than settled. Declaring
 * `hosRemaining → DERIVED_DEPENDENCY(dispatchReadiness)` on that basis would be
 * inventing a dependency, and declaring INDEPENDENT would be inventing its
 * absence. Both wait on one read of the composer.
 */
export const TRUTH_RELATIONS: Readonly<Record<string, WidgetTruthRelation>> = {};

/* ------------------------------------------------------------------ */
/* Board summary                                                       */
/* ------------------------------------------------------------------ */

export type BoardTileState = {
  instanceRef: string;
  widgetKey: string;
  payload: WidgetPayload<unknown>;
  /** When this tile's answer was evaluated, where the source supplies one. */
  asOf?: Date;
};

export type BoardSummary = {
  /** Tiles whose payload is `blocked`. Provable by counting. */
  blockedTiles: number;
  unknownTiles: number;
  failedTiles: number;
  withheldTiles: number;
  staleTiles: number;
  /** Every blocker record across every tile. Records, not causes. */
  blockerRecords: number;
  /**
   * Distinct operational problems.
   *
   * `null` means not computed, and null is the only value this can currently
   * take: distinguishing one root cause from two needs blocker identity, and
   * no identity is evidenced. A number here would be a guess wearing a count's
   * clothing.
   */
  rootCauses: null;
  /** The sentence a board may print. Never invents a root-cause count. */
  headline: string;
};

export function summarizeBoard(tiles: readonly BoardTileState[]): BoardSummary {
  const count = (s: WidgetPayload<unknown>["state"]) => tiles.filter((t) => t.payload.state === s).length;

  const blockerRecords = tiles.reduce(
    (n, t) => n + (t.payload.state === "blocked" ? t.payload.blockers.length : 0), 0);

  const blockedTiles = count("blocked");
  const unknownTiles = count("unknown");
  const failedTiles = count("failed");
  const needingAttention = blockedTiles + unknownTiles + failedTiles;

  return {
    blockedTiles, unknownTiles, failedTiles,
    withheldTiles: count("not_permitted"),
    staleTiles: count("stale"),
    blockerRecords,
    rootCauses: null,
    // "3 widgets need attention" is true by counting. "3 operational blockers"
    // is a claim about the world that this board cannot support.
    headline: needingAttention === 0
      ? "Nothing needs attention"
      : `${needingAttention} widget${needingAttention === 1 ? "" : "s"} need${needingAttention === 1 ? "s" : ""} attention`,
  };
}

/* ------------------------------------------------------------------ */
/* Contradiction detection                                             */
/* ------------------------------------------------------------------ */

export type ConsistencyWarning = {
  code: "BOARD_CONSISTENCY_WARNING";
  detail: string;
  widgets: readonly string[];
};

/**
 * Diagnostic only. Never changes what a tile says.
 *
 * A warning requires a **declared** dependency with evidence. Without one there
 * is no such thing as a contradiction: an upstream tile reading blocked while a
 * downstream aggregate reads ready is perfectly ordinary when the downstream
 * does not gate on that upstream.
 *
 * Evaluation time is checked before meaning is. Two engines evaluated ninety
 * seconds apart can legitimately disagree, and calling that a defect would
 * bury the real ones.
 */
export function detectContradictions(
  tiles: readonly BoardTileState[],
  relations: Readonly<Record<string, WidgetTruthRelation>> = TRUTH_RELATIONS,
  maxSnapshotSkewMinutes = 5,
): readonly ConsistencyWarning[] {
  const byKey = new Map(tiles.map((t) => [t.widgetKey, t]));
  const warnings: ConsistencyWarning[] = [];

  for (const [key, relation] of Object.entries(relations)) {
    if (relation.kind !== "DERIVED_DEPENDENCY") continue;
    const downstream = byKey.get(key);
    const upstream = byKey.get(relation.upstreamWidgetKey);
    if (!downstream || !upstream) continue;

    if (upstream.payload.state !== "blocked") continue;
    if (downstream.payload.state === "blocked") continue;
    if (downstream.payload.state !== "ok" && downstream.payload.state !== "stale") continue;

    if (upstream.asOf && downstream.asOf) {
      const skew = Math.abs(downstream.asOf.getTime() - upstream.asOf.getTime()) / 60_000;
      if (skew > maxSnapshotSkewMinutes) continue; // different snapshots, not a contradiction
    }

    warnings.push({
      code: "BOARD_CONSISTENCY_WARNING",
      detail: `${key} reads ${downstream.payload.state} while ${relation.upstreamWidgetKey}, which it gates on, is blocked (${relation.evidence})`,
      widgets: [key, relation.upstreamWidgetKey],
    });
  }

  return warnings;
}

/* ------------------------------------------------------------------ */
/* Dependency-aware staleness                                          */
/* ------------------------------------------------------------------ */

/**
 * Downstream tiles whose upstream has changed since they were evaluated.
 *
 * A dispatch tile computed before an HOS change is not wrong, it is out of
 * date, and the honest move is to mark it `stale` rather than leave a green
 * aggregate over a changed input. Returns keys; the caller decides.
 */
export function staleByDependency(
  tiles: readonly BoardTileState[],
  relations: Readonly<Record<string, WidgetTruthRelation>> = TRUTH_RELATIONS,
): readonly string[] {
  const byKey = new Map(tiles.map((t) => [t.widgetKey, t]));
  const out: string[] = [];
  for (const [key, relation] of Object.entries(relations)) {
    if (relation.kind !== "DERIVED_DEPENDENCY") continue;
    const downstream = byKey.get(key);
    const upstream = byKey.get(relation.upstreamWidgetKey);
    if (!downstream?.asOf || !upstream?.asOf) continue;
    if (upstream.asOf.getTime() > downstream.asOf.getTime()) out.push(key);
  }
  return out;
}
