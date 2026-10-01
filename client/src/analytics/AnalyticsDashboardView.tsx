/**
 * Analytics Checkpoint C — the dashboard, as a screen.
 *
 * Props in, DOM out. No tRPC, no fetch. Every number on it is a value `analytics.metric` (or
 * `analytics.mine`) returned, and every word about that number goes through
 * `analyticsPresentation`, so nothing here can round a server answer up.
 *
 * What a tile always shows, because a number without these is the unexplained total the
 * proposal ruled out: the value in its unit or the words "No value"; whether it is complete; the
 * records it could not place, by reason; the interval it covers, or that it is current state; when
 * it was computed; and, once that is older than the metric allows, that it is stale.
 *
 * "Show records" opens the drill-down: the exact rows the value was computed from, fetched with the
 * question the tile's own answer echoed — the same instants, not "today" again — so the count in the
 * panel is the tile's count, and the panel says so.
 *
 * What it does not do: rank anyone, colour a count as good or bad, or compute anything. It reads.
 */
import {
  FAMILY_ORDER, RANGE_CHOICES, familyTitle, fieldLabel, fieldValue, formatValue, freshnessOf,
  lastUpdatedLabel, presentDetermination, rangeText, type RangeChoice, type Tone,
} from "./analyticsPresentation";

/** One answer, as the server sends it. */
export type MetricAnswer = {
  metricId: string;
  value: number | null;
  determination: string;
  unknowns: { reason: string; count: number }[];
  basis: number;
  breakdown: Record<string, number> | null;
  range: { from: Date; to: Date } | null;
  computedAt: Date;
  freshnessSeconds: number;
};

export type DrillRow = {
  key: string;
  record: { table: string; id: number; ref: string | null };
  label: string;
  at: Date | null;
  fields: Record<string, string | number | boolean | null>;
};

export type TileState =
  | { kind: "loading" }
  /** `last` is the previous answer, if one was ever received. It is shown only as stale. */
  | { kind: "failed"; message: string; last: MetricAnswer | null }
  | { kind: "loaded"; answer: MetricAnswer };

export type MetricCard = {
  id: string;
  name: string;
  family: string;
  description: string;
  formula: string;
  unit: string;
  /** For a metric registered without a resolver: the server's reason, shown instead of a value. */
  unavailable: { determination: string; reason: string } | null;
  state: TileState;
};

export type DrillState =
  | null
  | { metricId: string; name: string; unit: string; state: { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; answer: MetricAnswer; rows: DrillRow[]; truncated: boolean } };

export type AnalyticsDashboardViewProps = {
  mode: "organization" | "mine";
  /** Switches between the organization's numbers and the caller's own. Null when only one is open to this caller. */
  onMode: ((m: "organization" | "mine") => void) | null;
  /** The catalog or the caller's own list could not be read at all. */
  failure: string | null;
  loading: boolean;
  cards: MetricCard[];
  /** Metrics the caller's role may not read. Counted, never named or valued. */
  hiddenCount: number;
  /** For `mine`: why there are no numbers, when there are none. */
  emptyReason: string | null;
  /** The scope the server says it answered in. */
  scope: { derivedFrom: "membership" | "single_tenant_fallback" } | null;
  range: RangeChoice;
  onRange: (r: RangeChoice) => void;
  zone: string;
  now: Date;
  onRefresh: () => void;
  refreshing: boolean;
  drill: DrillState;
  onDrill: (metricId: string | null) => void;
};

const TONE: Record<Tone, string> = {
  complete: "border-slate-300 bg-white text-slate-900",
  incomplete: "border-amber-600 bg-amber-50 text-amber-950",
  absent: "border-slate-400 bg-slate-50 text-slate-800",
};

function Badge({ determination }: { determination: string }) {
  const p = presentDetermination(determination);
  return (
    <span data-testid="determination" data-tone={p.tone} title={p.meaning}
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${TONE[p.tone]}`}>{p.label}</span>
  );
}

function Unknowns({ unknowns }: { unknowns: MetricAnswer["unknowns"] }) {
  const counted = unknowns.filter(u => u.count > 0);
  if (!counted.length) return null;
  return (
    <ul data-testid="unknowns" className="space-y-1 text-sm">
      {counted.map(u => <li key={u.reason}><span className="font-medium">{u.count}</span> not placed: {u.reason}</li>)}
    </ul>
  );
}

function Breakdown({ breakdown }: { breakdown: Record<string, number> | null }) {
  if (!breakdown || !Object.keys(breakdown).length) return null;
  return (
    <ul data-testid="breakdown" aria-label="Breakdown" className="flex flex-wrap gap-1">
      {Object.entries(breakdown).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => (
        <li key={k} className="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-700">{k.replace(/_/g, " ")}: {n}</li>
      ))}
    </ul>
  );
}

function Age({ answer, now, zone, failedMessage }: { answer: MetricAnswer; now: Date; zone: string; failedMessage: string | null }) {
  const f = freshnessOf(answer.computedAt, answer.freshnessSeconds, now);
  const stale = f.stale || failedMessage !== null;
  return (
    <div className="space-y-1 text-xs text-slate-600">
      <p data-testid="last-updated" data-stale={stale ? "yes" : "no"}>
        {lastUpdatedLabel(answer.computedAt, now, zone)}
        {stale && <span data-testid="stale" className="ml-2 rounded border border-slate-500 px-1 font-medium text-slate-800">Stale</span>}
      </p>
      {failedMessage !== null && (
        <p data-testid="refresh-failed" role="status" className="text-slate-800">Could not refresh: {failedMessage}. The value above is the last one received and is not current.</p>
      )}
    </div>
  );
}

function Tile({ card, zone, now, onDrill }: { card: MetricCard; zone: string; now: Date; onDrill: (id: string) => void }) {
  const headingId = `metric-${card.id.replace(/\./g, "-")}`;
  const frame = (tone: Tone, children: React.ReactNode) => (
    <article data-testid={`tile-${card.id}`} aria-labelledby={headingId} className={`flex flex-col gap-2 rounded border p-4 ${TONE[tone]}`}>
      <h3 id={headingId} className="text-sm font-semibold">{card.name}</h3>
      {children}
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer">How this is counted</summary>
        <p className="mt-1">{card.description}</p>
        <p data-testid="formula" className="mt-1">{card.formula}</p>
      </details>
    </article>
  );

  if (card.unavailable) {
    return frame("absent", <>
      <p data-testid="value" className="text-2xl font-semibold">No value</p>
      <Badge determination={card.unavailable.determination} />
      <p data-testid="unavailable-reason" className="text-sm">{card.unavailable.reason}</p>
    </>);
  }

  const s = card.state;
  if (s.kind === "loading") return frame("absent", <p data-testid="tile-loading" className="text-sm">Counting…</p>);
  if (s.kind === "failed" && !s.last) {
    return frame("absent", <p data-testid="tile-failed" role="status" className="text-sm">This metric could not be read: {s.message}. No value is shown.</p>);
  }

  const answer = s.kind === "loaded" ? s.answer : s.last!;
  const failedMessage = s.kind === "failed" ? s.message : null;
  const p = presentDetermination(answer.determination);
  return frame(p.tone, <>
    <p data-testid="value" className="text-2xl font-semibold">{formatValue(answer.value, card.unit)}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Badge determination={answer.determination} />
      <span data-testid="range" className="text-xs text-slate-600">{rangeText(answer.range, zone)}</span>
    </div>
    <Unknowns unknowns={answer.unknowns} />
    <Breakdown breakdown={answer.breakdown} />
    <Age answer={answer} now={now} zone={zone} failedMessage={failedMessage} />
    <button type="button" data-testid={`drill-${card.id}`} onClick={() => onDrill(card.id)}
      className="self-start rounded border px-2 py-1 text-xs">Show records</button>
  </>);
}

function DrillPanel({ drill, zone, onClose }: { drill: NonNullable<DrillState>; zone: string; onClose: () => void }) {
  const at = (d: Date | null) => d ? new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(d) : "not recorded";
  const fieldKeys = drill.state.kind === "loaded" ? Array.from(new Set(drill.state.rows.flatMap(r => Object.keys(r.fields)))) : [];
  return (
    <section data-testid="drill-panel" aria-labelledby="drill-heading" className="space-y-3 rounded border border-slate-400 p-4">
      <header className="flex items-start justify-between gap-4">
        <h2 id="drill-heading" className="text-lg font-semibold">Records behind “{drill.name}”</h2>
        <button type="button" data-testid="drill-close" onClick={onClose} className="rounded border px-2 py-1 text-sm">Close</button>
      </header>
      {drill.state.kind === "loading" && <p data-testid="drill-loading" className="text-sm">Reading the records…</p>}
      {drill.state.kind === "failed" && <p data-testid="drill-failed" role="status" className="text-sm">The records could not be read: {drill.state.message}</p>}
      {drill.state.kind === "loaded" && (() => {
        const { answer, rows, truncated } = drill.state;
        return <>
          <p data-testid="drill-summary" className="text-sm">
            {rows.length} record{rows.length === 1 ? "" : "s"} · value {formatValue(answer.value, drill.unit)} · {presentDetermination(answer.determination).label.toLowerCase()} · {rangeText(answer.range, zone)}.
            {" "}These are the records the value was computed from, read with the same question.
          </p>
          {truncated && <p data-testid="drill-truncated" className="text-sm font-medium">More records qualify than are listed here; the value is marked incomplete for the same reason.</p>}
          <Unknowns unknowns={answer.unknowns} />
          {rows.length === 0
            ? <p data-testid="drill-empty" className="text-sm text-slate-600">No record qualifies. That is a counted zero, not a missing answer.</p>
            : (
              <div className="overflow-x-auto">
                <table data-testid="drill-table" className="w-full text-left text-sm">
                  <caption className="sr-only">Records behind {drill.name}</caption>
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="py-1 pr-3">Record</th>
                      <th scope="col" className="py-1 pr-3">When</th>
                      {fieldKeys.map(k => <th key={k} scope="col" className="py-1 pr-3">{fieldLabel(k)}</th>)}
                      <th scope="col" className="py-1 pr-3">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.key} data-testid="drill-row" className="border-b align-top">
                        <td className="py-1 pr-3">{r.label}</td>
                        <td className="py-1 pr-3">{at(r.at)}</td>
                        {fieldKeys.map(k => <td key={k} className="py-1 pr-3">{fieldValue(r.fields[k])}</td>)}
                        <td className="py-1 pr-3 text-xs text-slate-600">{r.record.table} #{r.record.id}{r.record.ref ? ` (${r.record.ref})` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </>;
      })()}
    </section>
  );
}

export function AnalyticsDashboardView(props: AnalyticsDashboardViewProps) {
  const { mode, onMode, failure, loading, cards, hiddenCount, emptyReason, scope, range, onRange, zone, now, onRefresh, refreshing, drill, onDrill } = props;
  const title = mode === "mine" ? "My numbers" : "Operations analytics";
  const families = [...FAMILY_ORDER, ...Array.from(new Set(cards.map(c => c.family))).filter(f => !(FAMILY_ORDER as readonly string[]).includes(f))];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6" aria-labelledby="analytics-heading">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 id="analytics-heading" className="text-2xl font-semibold">{title}</h1>
          <p data-testid="zone" className="text-sm text-slate-600">Times are shown in {zone}.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex flex-col text-sm">
            <span>Range</span>
            <select data-testid="range-select" value={range} onChange={e => onRange(e.target.value as RangeChoice)} className="rounded border px-2 py-1">
              {RANGE_CHOICES.map(c => <option key={c.label} value={c.label}>{c.text}</option>)}
            </select>
          </label>
          <button type="button" data-testid="refresh" onClick={onRefresh} disabled={refreshing} className="rounded border px-3 py-1 text-sm">
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {onMode && (
        <nav aria-label="Whose numbers" className="flex gap-2">
          {(["organization", "mine"] as const).map(m => (
            <button key={m} type="button" data-testid={`mode-${m}`} aria-pressed={mode === m} onClick={() => onMode(m)}
              className={`rounded border px-3 py-1 text-sm ${mode === m ? "border-slate-900 font-semibold" : ""}`}>
              {m === "organization" ? "Organization" : "My numbers"}
            </button>
          ))}
        </nav>
      )}
      {mode === "mine" && (
        <p data-testid="mine-note" className="text-sm text-slate-700">
          These count your own records only. Nobody is ranked or scored, and nothing here is compared with anyone else.
        </p>
      )}
      {scope?.derivedFrom === "single_tenant_fallback" && (
        <p data-testid="scope-note" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">
          Your login is not a member of an organization, so these numbers cover the records that belong to no organization.
        </p>
      )}

      {failure !== null && (
        <div role="alert" data-testid="failure" className="rounded border border-red-700 bg-red-50 p-4 text-sm text-red-900">
          Analytics could not be read: {failure}. No numbers are shown, and none are reused from an earlier visit.
        </div>
      )}
      {failure === null && loading && <p data-testid="loading" className="text-sm text-slate-600">Reading metrics…</p>}
      {failure === null && !loading && emptyReason !== null && <p data-testid="empty-reason" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">{emptyReason}</p>}

      {drill && <DrillPanel drill={drill} zone={zone} onClose={() => onDrill(null)} />}

      {failure === null && !loading && families.map(f => {
        const inFamily = cards.filter(c => c.family === f);
        if (!inFamily.length) return null;
        const id = `family-${f}`;
        return (
          <section key={f} data-testid={id} aria-labelledby={id} className="space-y-2">
            <h2 id={id} className="text-sm font-semibold uppercase tracking-wide text-slate-600">{familyTitle(f)}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {inFamily.map(card => <Tile key={card.id} card={card} zone={zone} now={now} onDrill={id => onDrill(id)} />)}
            </div>
          </section>
        );
      })}

      {hiddenCount > 0 && (
        <p data-testid="hidden-count" className="text-xs text-slate-600">
          {hiddenCount} further metric{hiddenCount === 1 ? " is" : "s are"} not shown because your role does not read the records behind {hiddenCount === 1 ? "it" : "them"}.
        </p>
      )}
    </main>
  );
}
