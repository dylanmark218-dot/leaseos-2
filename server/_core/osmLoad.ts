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

/**
 * Bumped when the intermediate's shape changes in a way a reader must notice.
 *
 * Without it a format change is silent: the loader reads fields that moved, writes roads that are
 * subtly wrong, and reports success. Refusing an unknown version costs one line and removes a whole
 * class of failure nobody would find until a route went somewhere it should not.
 */
export const OSM_EXTRACT_FORMAT_VERSION = 1;

/**
 * The extraction's first line: what file this is of.
 *
 * `extractSha256` appears both here and in the caller's `opts`, deliberately. The header's copy is
 * written by the extractor from the bytes it actually read; the caller's is whatever it was told.
 * Comparing them catches the case neither catches alone — **the file you hashed is not the file you
 * are reading** — which is what happens when an extraction is rerun and only one of the two is
 * updated.
 */
export type ExtractHeader = {
  format: "leaseos.osm.intermediate";
  version: number;
  sourceKey: string;
  extractFile: string;
  extractSha256: string;
  extractPublishedAt: string;
};

/** Every header field a build is traced back by. A header missing one is refused and names it. */
const HEADER_FIELDS = ["sourceKey", "extractFile", "extractSha256", "extractPublishedAt"] as const;

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
  reason: ImportRefusal["reason"] | "malformed_json" | "missing_field" | "arrays_disagree" | "bad_header" | "wrong_version" | "extract_mismatch" | "source_mismatch";
  detail: string;
};

export type LoadPlan = {
  buildRef: string;
  /**
   * The extract's own header, once every check on it passed; null when it did not. Carried so a
   * build records which file, published when, it was read from — not only the caller's word for it.
   */
  header: ExtractHeader | null;
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

  /*
   * The header is read first and a bad one stops the read. Judging thousands of following lines
   * against a contract we could not confirm produces thousands of identical rejections, and that is
   * not a report — it is noise with the real answer buried in line one.
   */
  const firstIdx = lines.findIndex(l => l.trim());
  let header: ExtractHeader | null = null;
  if (firstIdx >= 0) {
    let h: Partial<ExtractHeader> | null = null;
    try { h = JSON.parse(lines[firstIdx]!) as Partial<ExtractHeader>; } catch { h = null; }
    const missing = h ? HEADER_FIELDS.find(f => typeof h![f] !== "string" || !(h![f] as string).trim()) : undefined;
    if (!h || h.format !== "leaseos.osm.intermediate") {
      refusals.push({ line: firstIdx + 1, reason: "bad_header", detail: "first line is not an extract header" });
    } else if (h.version !== OSM_EXTRACT_FORMAT_VERSION) {
      refusals.push({ line: firstIdx + 1, reason: "wrong_version", detail: `extract is format version ${String(h.version)}, this loader reads ${OSM_EXTRACT_FORMAT_VERSION}` });
    } else if (missing) {
      /*
       * A header without its provenance is not a header. An extract that does not say which file it
       * came from, or when that file was published, produces a build nobody can later trace back —
       * which is the one question the header exists to answer. (Carried from osmLoadPlan.)
       */
      refusals.push({ line: firstIdx + 1, reason: "bad_header", detail: `header has no ${missing}` });
    } else if (h.sourceKey !== opts.sourceKey) {
      /*
       * The caller chooses the source, and with it the standing, id prefix, jurisdiction and joining
       * rule. An extract that says it is of another source is refused rather than loaded under the
       * caller's: a British Columbia extract loaded as Alberta would carry Alberta's jurisdiction onto
       * every edge, and nothing downstream could tell. (osmLoadPlan read the source from the header;
       * this loader reads it from the caller, so the two have to agree.)
       */
      refusals.push({ line: firstIdx + 1, reason: "source_mismatch", detail: `header is an extract of ${h.sourceKey}, caller is loading ${opts.sourceKey}` });
    } else if (h.extractSha256 !== opts.extractSha256) {
      // The file you hashed is not the file you are reading.
      refusals.push({ line: firstIdx + 1, reason: "extract_mismatch", detail: `header names ${h.extractSha256!.slice(0, 12)}…, caller passed ${opts.extractSha256.slice(0, 12)}…` });
    } else {
      header = h as ExtractHeader;
    }
  } else {
    refusals.push({ line: 1, reason: "bad_header", detail: "empty extract" });
  }
  const headerOk = header !== null;

  lines.forEach((line, i) => {
    if (!headerOk || i <= firstIdx) return;
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
    header,
    sourceKey: opts.sourceKey,
    extractSha256: opts.extractSha256,
    edges: topo.edges,
    junctionCount: topo.junctionCount,
    isolatedWays: topo.isolatedWays,
    refusals,
    counts: {
      // The header is not a record, so it does not count as one. Including it would put every
      // report one over and quietly break the invariant that makes the numbers auditable:
      // linesRead == waysImported + refusals for a well-formed extract.
      linesRead: lines.filter((l, i) => l.trim() && i !== firstIdx).length,
      waysImported: ways.length,
      edgesBuilt: topo.edges.length,
    },
  };
}

/**
 * Whether a plan is fit to build a graph from. (Carried from osmLoadPlan's `planIsLoadable`.)
 *
 * Per-line refusals do not make a plan unloadable — a real Alberta build refuses 223,334 footpaths
 * and is healthy; `refusalSummary` is where a person judges those. Two things do: a header that did
 * not pass, because then nothing after it was read against a contract anyone confirmed; and a valid
 * header with no records behind it, because a build of nothing would replace the graph in use with
 * an empty one and report success. An unregistered or non-id-joining source never reaches here:
 * `planLoad` refuses it outright.
 */
export function planIsLoadable(plan: LoadPlan): { loadable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!plan.header) reasons.push("no valid extract header");
  else if (plan.counts.linesRead === 0) reasons.push("header is valid but no way records followed");
  return { loadable: reasons.length === 0, reasons };
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
