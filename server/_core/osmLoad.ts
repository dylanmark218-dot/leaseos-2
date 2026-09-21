/**
 * M2 — the loader: an extract becomes a graph build, or says which line stopped it.
 *
 * ## Why this does not read a PBF
 *
 * A `.osm.pbf` is protobuf inside zlib blobs, and reading one well means a parser, a dependency and
 * a 350 MB fixture before a single assertion. So the split is: **extraction is a tool, loading is
 * the product.** A separate extractor walks the PBF and writes one JSON object per line; this
 * consumes those lines.
 *
 * That buys three things. The loader is testable with four lines of text. The extract can be
 * inspected, diffed and checked into a bug report by a person. And the heavy, language-specific
 * part stays outside the code that has to be right about provenance.
 *
 * ## The intermediate record
 *
 * One line per way, and nothing derived:
 *
 * ```json
 * {"id":12345,"tags":{"highway":"track","name":"Range Road 51"},
 *  "nodes":[100,101,102],"geometry":[[-114.1,53.4],[-114.0,53.5],[-113.9,53.6]]}
 * ```
 *
 * `nodes` and `geometry` are parallel arrays — the same vertex in both — because topology needs the
 * ids and the edge needs the shape, and keeping them together means neither can drift from the
 * other in a later pass.
 *
 * ## What the plan records
 *
 * The build is identified by its `buildRef`, and the **extract's SHA-256** is recorded against it.
 * That is the same reasoning as `0167`: months later the useful question is not "what does OSM say
 * now" but "which file produced the graph that approved this route", and a filename does not answer
 * it — Geofabrik reuses names every day.
 */

import { importOsmWay, type ImportRefusal } from "./osmImport";
import { buildTopology, type TopologyEdge, type WayForTopology } from "./osmTopology";
import { standingFor } from "./legalLand";

/** One line of the intermediate, before it is trusted. */
export type ExtractRecord = {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
  geometry: [number, number][];
};

export type LineRefusal = {
  /** 1-based, so it matches what an editor shows when somebody goes to look. */
  line: number;
  reason: ImportRefusal["reason"] | "malformed_json" | "missing_field" | "arrays_disagree";
  detail: string;
};

export type LoadPlan = {
  buildRef: string;
  sourceKey: string;
  /** SHA-256 of the extract file. The answer to "which file was this built from". */
  extractSha256: string;
  edges: readonly TopologyEdge[];
  junctionCount: number;
  isolatedWays: number;
  /** Every line that did not become a road, with the line number and the reason. */
  refusals: readonly LineRefusal[];
  counts: {
    linesRead: number;
    waysImported: number;
    edgesBuilt: number;
  };
};

/**
 * Validate one line into a record, or say what is wrong with it.
 *
 * A malformed line is **refused by number**, never skipped quietly. An extract that silently loses
 * 4,000 ways to a serialisation bug produces a graph with holes in it, and holes in a road graph
 * look exactly like roads that are not there.
 */
export function parseExtractLine(line: string, lineNumber: number): ExtractRecord | LineRefusal {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return { line: lineNumber, reason: "malformed_json", detail: e instanceof Error ? e.message : "unparseable" };
  }
  const r = raw as Partial<ExtractRecord>;
  if (typeof r.id !== "number" || !r.tags || !Array.isArray(r.nodes) || !Array.isArray(r.geometry)) {
    return { line: lineNumber, reason: "missing_field", detail: "needs id, tags, nodes, geometry" };
  }
  if (r.nodes.length !== r.geometry.length) {
    /*
     * The pair has to stay in step. A way whose ids and coordinates are different lengths would
     * cut at the wrong vertex, and the resulting edge would have the right endpoints and the wrong
     * shape — which draws convincingly and routes somebody down the wrong road.
     */
    return { line: lineNumber, reason: "arrays_disagree", detail: `${r.nodes.length} nodes, ${r.geometry.length} coordinates` };
  }
  return r as ExtractRecord;
}

function isRefusal(x: ExtractRecord | LineRefusal): x is LineRefusal {
  return "reason" in x;
}

/**
 * Plan a build from the extract's lines.
 *
 * Pure, and returns a plan rather than writing one. The write is a separate step because a plan can
 * be counted, diffed against the previous build and rejected before anything is committed — and a
 * road graph is the kind of thing worth looking at before it replaces the one in use.
 */
export function planLoad(
  lines: readonly string[],
  opts: { buildRef: string; sourceKey: string; extractSha256: string },
): LoadPlan {
  const standing = standingFor(opts.sourceKey);
  if (standing.topology !== "shared_node_ids") {
    /*
     * This loader joins by node id. A source registered for coordinate snapping has no node ids to
     * join on, and running it through here would produce a graph of fragments — so it is refused
     * rather than attempted. `null` lands here too: an unregistered source has not answered the
     * question, and unanswered is not permission.
     */
    throw new Error(
      `${opts.sourceKey} joins by ${standing.topology ?? "no strategy anyone has recorded"}, not shared node ids; this loader cannot build it`,
    );
  }

  const refusals: LineRefusal[] = [];
  const ways: WayForTopology[] = [];

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const parsed = parseExtractLine(line, i + 1);
    if (isRefusal(parsed)) { refusals.push(parsed); return; }

    const imported = importOsmWay(
      { id: parsed.id, tags: parsed.tags, geometry: parsed.geometry },
      { sourceKey: opts.sourceKey, idPrefix: standing.idPrefix },
    );
    if (!imported.imported) {
      refusals.push({ line: i + 1, reason: imported.reason, detail: imported.detail });
      return;
    }
    ways.push({
      segmentId: imported.segmentId,
      label: imported.label,
      nodeIds: parsed.nodes,
      geometry: parsed.geometry,
      direction: imported.direction,
    });
  });

  const topo = buildTopology(ways, { idPrefix: standing.idPrefix });
  return {
    buildRef: opts.buildRef,
    sourceKey: opts.sourceKey,
    extractSha256: opts.extractSha256,
    edges: topo.edges,
    junctionCount: topo.junctionCount,
    isolatedWays: topo.isolatedWays,
    refusals,
    counts: {
      linesRead: lines.filter(l => l.trim()).length,
      waysImported: ways.length,
      edgesBuilt: topo.edges.length,
    },
  };
}

/**
 * Group refusals by reason for a build report.
 *
 * A build that refuses 223,334 ways is healthy — those are footpaths. A build that refuses 4,000 for
 * `malformed_json` is a broken extract wearing a successful build's clothes. The difference is only
 * visible if the reasons are counted separately, which is why the plan keeps every one.
 */
export function refusalSummary(plan: LoadPlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of plan.refusals) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}
