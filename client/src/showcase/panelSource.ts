/**
 * P5.1 — where a showcase panel's content came from.
 *
 * A showcase page runs real queries, but its demonstration identifiers often name records that do
 * not exist in the database it is pointed at, and some panels were never backed by a query at all.
 * Both cases used to look identical on screen: a plausible panel of invented rows. A panel now
 * declares its source, and the badge says which — "from records" with the procedure and the row
 * count, or "demonstration layout" with the reason it has no records to show.
 *
 * The rule the whole thing exists for: a query that returns nothing is NOT records. It is a
 * demonstration layout with a named reason, and it says so.
 */
export type PanelSource =
  | { kind: "records"; query: string; rows: number }
  | { kind: "demonstration"; reason: string };

/** The source for a panel fed by a query: records when it returned rows, a named demonstration otherwise. */
export function fromQuery(query: string, data: unknown, opts?: { whenEmpty?: string }): PanelSource {
  const rows = Array.isArray(data) ? data.length : data == null ? 0 : 1;
  if (rows > 0) return { kind: "records", query, rows };
  return { kind: "demonstration", reason: opts?.whenEmpty ?? `${query} returned nothing on this database` };
}

/** The source for a panel that is a layout, not a read: the reason is required and must say something. */
export function demonstration(reason: string): Extract<PanelSource, { kind: "demonstration" }> {
  const r = reason.trim();
  if (r.length < 10) throw new Error("A demonstration panel must say why it has no records (at least ten characters)");
  return { kind: "demonstration", reason: r };
}

export function sourceLabel(s: PanelSource): string {
  return s.kind === "records"
    ? `from records — ${s.query}, ${s.rows} row${s.rows === 1 ? "" : "s"}`
    : `demonstration layout — ${s.reason}`;
}

/** Whether a panel may be read as evidence of anything. Only records may. */
export const isEvidence = (s: PanelSource): boolean => s.kind === "records";
