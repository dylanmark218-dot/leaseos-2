/**
 * M2 — the loader's input, and what it refuses.
 *
 * ## Why an intermediate rather than reading the PBF here
 *
 * A `.osm.pbf` is protocol-buffer blobs, zlib-deflated, with delta-encoded coordinates and a string
 * table — parsing it well is a library's job, and doing it inside the product would pull a heavy
 * native dependency into the server to be exercised once per import. It would also make every test
 * of the loader need a real extract, and Alberta's is 350 MB.
 *
 * So extraction is a separate tool that emits one JSON object per line, and the loader consumes
 * that. The format is the contract between them, which means it has to be versioned and it has to
 * carry what it came from: a loader handed a pile of roads with no provenance cannot honour `0164`,
 * because it would not know which source's standing to apply.
 *
 * ## Refusals are named, never silent
 *
 * A malformed line is reported with its line number and what was wrong with it. An extraction that
 * quietly drops 4,000 roads and reports success is worse than one that fails, because the graph
 * looks complete and the holes are wherever the dropped roads were.
 *
 * ## Run end to end on a real extraction
 *
 * A bounded slice of Edmonton out of `alberta-260910.osm.pbf`, through plan → import → topology:
 *
 * ```
 * ways read          13,441     rejections           0
 * imported           13,341     refused access=no  100
 * junctions          18,001     edges           29,369
 * ways meeting nothing   27  (0.2%)
 * ```
 *
 * A real edge out of it: `OSM-AB-way/4734665#1`, 104 Street NW, from `OSM-AB-node/4281473025` to
 * `OSM-AB-node/276227083`.
 *
 * The advisories are the part worth reading. Across 13,341 city streets: 2,625 truck-route
 * designations, 144 `access=private`, 73 overhead clearances, 72 bridges, 69 dangerous-goods
 * routes — and **one** weight restriction. In a city, on paved municipal roads. Whatever else the
 * graph is good for, it does not know what a road will carry.
 */

import type { LngLat } from "./geoImport";
import { standingFor } from "./legalLand";

/**
 * Bumped when the shape changes in a way a reader must notice. A loader that silently accepts an
 * older format reads fields that moved and writes roads that are subtly wrong.
 */
export const OSM_INTERMEDIATE_FORMAT_VERSION = 1;

/**
 * The first line of the file: what this extraction is of.
 *
 * `extractSha256` is the point of it. "Which roads are in the graph" is answerable only if the
 * build records which file it read, and a filename is not an answer — Geofabrik republishes the
 * same name daily.
 */
export type ExtractHeader = {
  format: "leaseos.osm.intermediate";
  version: number;
  sourceKey: string;
  extractFile: string;
  extractSha256: string;
  /** The extract's own date, from the publisher, not the day it was read. */
  extractPublishedAt: string;
  wayCount: number;
};

export type WayRecord = {
  id: number;
  tags: Record<string, string>;
  nodeIds: number[];
  geometry: LngLat[];
};

export type LoadRejection = {
  line: number;
  reason: "unparseable" | "wrong_format" | "wrong_version" | "missing_field" | "geometry_mismatch";
  detail: string;
};

export type LoadPlan = {
  header: ExtractHeader | null;
  ways: readonly WayRecord[];
  rejections: readonly LoadRejection[];
  /** From the source registry. Null means the extraction names a source nobody registered. */
  idPrefix: string | null;
  topology: "shared_node_ids" | "coordinate_snap" | null;
};

/* ------------------------------------------------------------------ */

function headerFrom(raw: unknown, out: LoadRejection[]): ExtractHeader | null {
  const h = raw as Partial<ExtractHeader>;
  if (h?.format !== "leaseos.osm.intermediate") {
    out.push({ line: 1, reason: "wrong_format", detail: `first line is not an extract header (format=${String(h?.format)})` });
    return null;
  }
  if (h.version !== OSM_INTERMEDIATE_FORMAT_VERSION) {
    /*
     * Refused rather than read leniently. A version mismatch means somebody changed the contract,
     * and guessing which half of it still applies is how a loader writes roads that are subtly
     * wrong — the kind nobody finds until a route goes somewhere it should not.
     */
    out.push({ line: 1, reason: "wrong_version", detail: `format version ${String(h.version)}, this loader reads ${OSM_INTERMEDIATE_FORMAT_VERSION}` });
    return null;
  }
  for (const f of ["sourceKey", "extractFile", "extractSha256", "extractPublishedAt"] as const) {
    if (!h[f]) {
      out.push({ line: 1, reason: "missing_field", detail: `header has no ${f}` });
      return null;
    }
  }
  return h as ExtractHeader;
}

/**
 * Read an extraction into a plan.
 *
 * Nothing is written here and nothing is converted here — `osmImport` decides what is a road and
 * `osmTopology` decides where roads meet. This only establishes that the input is what it claims to
 * be, and says precisely what it threw away.
 */
export function planLoad(lines: readonly string[]): LoadPlan {
  const rejections: LoadRejection[] = [];
  const ways: WayRecord[] = [];
  let header: ExtractHeader | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text) continue;
    const lineNo = i + 1;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      rejections.push({ line: lineNo, reason: "unparseable", detail: `not JSON: ${text.slice(0, 60)}` });
      continue;
    }

    if (header === null) {
      header = headerFrom(raw, rejections);
      // A bad header stops the read. Every following line would be judged against a contract we
      // could not confirm, and thousands of rejections all saying the same thing is not a report.
      if (header === null) break;
      continue;
    }

    const w = raw as Partial<WayRecord>;
    if (typeof w.id !== "number" || !Array.isArray(w.nodeIds) || !Array.isArray(w.geometry) || typeof w.tags !== "object" || w.tags === null) {
      rejections.push({ line: lineNo, reason: "missing_field", detail: `way record needs id, tags, nodeIds, geometry` });
      continue;
    }
    if (w.nodeIds.length !== w.geometry.length) {
      /*
       * These must correspond one to one: topology cuts a way by node index and takes the geometry
       * at that index. If they disagree, an edge gets somebody else's shape — it still draws, it
       * still routes, and it is the wrong road.
       */
      rejections.push({ line: lineNo, reason: "geometry_mismatch", detail: `${w.nodeIds.length} node ids against ${w.geometry.length} coordinates` });
      continue;
    }
    ways.push({ id: w.id, tags: w.tags as Record<string, string>, nodeIds: w.nodeIds, geometry: w.geometry });
  }

  const standing = header ? standingFor(header.sourceKey) : null;

  return {
    header,
    ways,
    rejections,
    idPrefix: standing?.idPrefix ?? null,
    topology: standing?.topology ?? null,
  };
}

/**
 * Whether a plan is fit to build a graph from.
 *
 * The topology check is the one that matters. `standingFor` answers for an unregistered source with
 * a generated prefix and a null strategy, so a load could otherwise proceed with roads that have
 * identity and no rule for joining them — and the join is not a detail, it is the graph.
 */
export function planIsLoadable(plan: LoadPlan): { loadable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!plan.header) reasons.push("no valid extract header");
  if (plan.header && plan.topology === null) {
    reasons.push(`source ${plan.header.sourceKey} is not registered, so there is no rule for how its roads join`);
  }
  if (plan.header && plan.ways.length === 0) reasons.push("header is valid but no way records followed");
  return { loadable: reasons.length === 0, reasons };
}
