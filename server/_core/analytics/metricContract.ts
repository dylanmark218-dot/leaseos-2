/**
 * Analytics Checkpoint B — the shape of an answer.
 *
 * Pure. No database.
 *
 * One rule carries the whole layer: **a metric's value is computed from exactly the rows its
 * drill-down returns.** A resolver produces the qualifying rows; `aggregate` turns those rows into
 * the number. `analytics.metric` returns the number, `analytics.drilldown` returns the rows, and both
 * run the same resolver with the same scope, range and filters. So "14 open critical defects" and
 * the list behind it cannot disagree, because there is only one list.
 *
 * The second rule is the repository's own: absence is not a fact. A row whose determining field is
 * missing is never counted as zero and never silently dropped — it is named in `unknowns`, and the
 * answer says `partial`. An average over nothing is `not_applicable`, not 0. A metric the records
 * cannot support is still registered, and answers `not_derivable` with the reason, so a dashboard
 * shows why it is blank instead of showing nothing and letting a reader assume.
 *
 * Vocabulary is reused, not invented: `computed | partial | unknown` is the determination the asset
 * twin, CCA schedule and project forecast already return; `not_applicable` and `not_evaluated` are
 * the reasons `interEngineStatus` already names; there is deliberately no colour and no score here.
 */
import type { Permission } from "../recordsAuthorization";

export type Determination =
  /** Every qualifying record was placed; the value is complete for this scope, range and filters. */
  | "computed"
  /** A value is stated, and `unknowns` names records that could not be placed. */
  | "partial"
  /** No value can be stated; `unknowns` says why. */
  | "unknown"
  /** Nothing to state: an average over no records. Not zero. */
  | "not_applicable"
  /** The records LeaseOS keeps cannot support this metric at all. */
  | "not_derivable"
  /** Derivable, but deliberately not evaluated yet — the reason names the decision it waits on. */
  | "not_evaluated";

export type MetricUnit = "count" | "minutes" | "hours";

export type MetricFamily = "operations" | "fleet" | "maintenance" | "compliance" | "safety" | "hours_of_service" | "workforce";

/** Filters a metric may accept. Each is checked against the caller's scope before it is applied. */
export type FilterKey = "unitId" | "operatorId" | "jobId";

export type Aggregation =
  | { kind: "count" }
  /** Sum of a numeric row field. */
  | { kind: "sum"; field: string }
  /** Mean of a numeric row field over the rows; `not_applicable` when there are none. */
  | { kind: "mean"; field: string };

export type MetricDefinition = {
  id: string;
  name: string;
  family: MetricFamily;
  description: string;
  /** The formula in words, precise enough that two people computing it by hand agree. */
  formula: string;
  /** Tables read. The registry test holds every one of them to a known scope rule. */
  sources: readonly string[];
  unit: MetricUnit;
  aggregation: Aggregation;
  /** `range`: records placed in [from, to). `current`: the state of records at the moment asked. */
  temporal: "range" | "current";
  filters: readonly FilterKey[];
  /** The existing read permission of the source records. A metric never reveals more than they do. */
  requiredPermission: Permission;
  /** Available through `analytics.mine`, scoped to the caller's own operator record. */
  selfScoped: boolean;
  /** A row field whose values the answer also counts by, e.g. severity or status. */
  breakdownBy?: string;
  /** How old an answer may be before a screen must call it stale. */
  freshnessSeconds: number;
  /** What happens to records whose determining field is missing. */
  incompleteness: string;
  /**
   * Set for a metric registered so it can answer honestly rather than be omitted. The metric never
   * reads a table; it answers with this determination and reason.
   */
  unavailable?: { determination: "not_derivable" | "not_evaluated" | "unknown"; reason: string };
};

/** A pointer back to the authoritative record. Analytics never carries a copy of the record itself. */
export type RecordRef = { table: string; id: number; ref: string | null };

export type DrillRow = {
  /** Stable for the same underlying record; screens key on it. */
  key: string;
  record: RecordRef;
  label: string;
  /** The timestamp that placed the row in the range or state, when it has one. */
  at: Date | null;
  fields: Readonly<Record<string, string | number | boolean | null>>;
};

export type Unknown = { reason: string; count: number };

/** What a resolver hands back: the qualifying rows, and what it could not place. */
export type SourceAnswer = { rows: DrillRow[]; unknowns: Unknown[]; truncated: boolean };

/** Resolvers stop reading here and say so, rather than count a partial list as complete. */
export const ROW_CAP = 20_000;

export type Aggregate = {
  value: number | null;
  determination: Determination;
  unknowns: Unknown[];
  /** The number of rows the value was computed over. For a count it equals the value. */
  basis: number;
  breakdown: Record<string, number> | null;
};

const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The one place a value comes from. Pure over the rows, so the drill-down equivalence is a
 * property of this function rather than something each resolver has to remember.
 */
export function aggregate(def: MetricDefinition, answer: SourceAnswer): Aggregate {
  if (def.unavailable) {
    return { value: null, determination: def.unavailable.determination, unknowns: [{ reason: def.unavailable.reason, count: 0 }], basis: 0, breakdown: null };
  }
  const unknowns = answer.unknowns.filter(u => u.count > 0);
  if (answer.truncated) unknowns.push({ reason: `More than ${ROW_CAP} qualifying records; the value covers the first ${ROW_CAP} only`, count: 1 });
  const incomplete = unknowns.length > 0;
  const rows = answer.rows;

  let breakdown: Record<string, number> | null = null;
  const by = def.breakdownBy;
  if (by) {
    breakdown = {};
    for (const r of rows) {
      const k: string | number | boolean | null | undefined = r.fields[by];
      const label = k === null || k === undefined || k === "" ? "(not recorded)" : String(k);
      breakdown[label] = (breakdown[label] ?? 0) + 1;
    }
  }

  const agg = def.aggregation;
  if (agg.kind === "count") {
    return { value: rows.length, determination: incomplete ? "partial" : "computed", unknowns, basis: rows.length, breakdown };
  }
  const values = rows.map(r => r.fields[agg.field]).filter(numeric);
  if (values.length !== rows.length) {
    // A resolver that emits a row without the aggregated field has broken its own contract; that is
    // a defect to surface, not a record to quietly leave out of the arithmetic.
    throw new Error(`Metric ${def.id}: ${rows.length - values.length} row(s) lack a numeric "${agg.field}"`);
  }
  if (agg.kind === "sum") {
    const total = values.reduce((a, b) => a + b, 0);
    return { value: round2(total), determination: incomplete ? "partial" : "computed", unknowns, basis: rows.length, breakdown };
  }
  if (values.length === 0) {
    return { value: null, determination: incomplete ? "unknown" : "not_applicable", unknowns, basis: 0, breakdown };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { value: round2(mean), determination: incomplete ? "partial" : "computed", unknowns, basis: values.length, breakdown };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minutes of [start, end) that fall inside [from, to). Never negative. */
export function overlapMinutes(start: Date, end: Date, from: Date, to: Date): number {
  const s = Math.max(start.getTime(), from.getTime());
  const e = Math.min(end.getTime(), to.getTime());
  return e > s ? (e - s) / 60_000 : 0;
}
