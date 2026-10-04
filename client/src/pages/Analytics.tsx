/**
 * Analytics Checkpoint C — the dashboard's container.
 *
 * The only file on this screen that talks to the server. It asks four things:
 *
 *   `analytics.catalog`    which metrics exist and which this role may read. A role refused the
 *                          catalog (a driver) is not shown an error: it is shown its own numbers.
 *   `analytics.metric`     one call per readable metric, each refreshed on the metric's own
 *                          freshness budget rather than one timer for everything.
 *   `analytics.mine`       the caller's own numbers, resolved from the session on the server.
 *   `analytics.drilldown`  (or `mineDrilldown`) asked with the input the tile's answer echoed —
 *                          the same resolved instants, not "today" again — so the records in the
 *                          panel are the records behind the number on the tile.
 *
 * The zone is the browser's, sent with every question and shown on the screen, so "today" means
 * the reader's day and the reader is told whose day it is.
 *
 * Nothing here computes a value. A failed refresh keeps the last answer only because React Query
 * keeps it, and the view marks it stale and says the refresh failed.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  AnalyticsDashboardView,
  type DrillState,
  type MetricAnswer,
  type MetricCard,
  type TileState,
} from "@/analytics/AnalyticsDashboardView";
import type { RangeChoice } from "@/analytics/analyticsPresentation";

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

type Answer = {
  metricId: string; value: number | null; determination: string; unknowns: { reason: string; count: number }[];
  basis: number; breakdown: Record<string, number> | null; range: { from: Date; to: Date } | null;
  computedAt: Date; freshnessSeconds: number;
};
const toAnswer = (a: Answer): MetricAnswer => ({
  metricId: a.metricId, value: a.value, determination: a.determination, unknowns: a.unknowns, basis: a.basis,
  breakdown: a.breakdown, range: a.range ? { from: a.range.from, to: a.range.to } : null,
  computedAt: a.computedAt, freshnessSeconds: a.freshnessSeconds,
});

type QueryLike<T> = { isPending: boolean; isError: boolean; error: { message: string } | null; data: T | undefined };
function tileOf<T extends Answer>(q: QueryLike<T> | undefined): TileState {
  if (!q || q.isPending) return { kind: "loading" };
  if (q.isError) return { kind: "failed", message: q.error?.message ?? "unknown error", last: q.data ? toAnswer(q.data) : null };
  return q.data ? { kind: "loaded", answer: toAnswer(q.data) } : { kind: "loading" };
}

export default function Analytics() {
  const zone = useMemo(browserZone, []);
  const [range, setRange] = useState<RangeChoice>("today");
  const [chosenMode, setChosenMode] = useState<"organization" | "mine">("organization");
  const [drillId, setDrillId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const catalog = trpc.analytics.catalog.useQuery(undefined, { retry: false });
  const refusedCatalog = catalog.error?.data?.code === "FORBIDDEN";
  const mode = refusedCatalog ? "mine" : chosenMode;

  const all = catalog.data?.metrics ?? [];
  const permitted = all.filter(m => m.permitted);
  const resolvable = permitted.filter(m => m.availability.determination === "resolvable");

  const metricQueries = trpc.useQueries(t => (mode === "organization" ? resolvable : []).map(m =>
    t.analytics.metric(
      { metricId: m.id, range: { label: range, zone } },
      { refetchInterval: Math.max(60, m.freshnessSeconds) * 1000, retry: 1 },
    )));
  const mine = trpc.analytics.mine.useQuery({ range: { label: range, zone } }, { enabled: mode === "mine", retry: 1, refetchInterval: 60_000 });

  const byId = new Map(resolvable.map((m, i) => [m.id, metricQueries[i]]));
  const orgCards: MetricCard[] = permitted.map(m => ({
    id: m.id, name: m.name, family: m.family, description: m.description, formula: m.formula, unit: m.unit,
    unavailable: m.availability.determination === "resolvable" ? null : { determination: m.availability.determination, reason: m.availability.reason ?? "" },
    state: tileOf(byId.get(m.id) as QueryLike<Answer> | undefined),
  }));
  const mineCards: MetricCard[] = (mine.data?.metrics ?? []).map(e => ({
    id: e.metricId, name: e.name, family: e.family, description: e.description, formula: e.formula, unit: e.unit,
    unavailable: null, state: { kind: "loaded", answer: toAnswer(e) },
  }));
  const cards = mode === "mine" ? mineCards : orgCards;

  // The drill-down asks exactly what the tile's answer says it answered.
  const drillSource = mode === "mine"
    ? mine.data?.metrics.find(e => e.metricId === drillId)
    : byId.get(drillId ?? "")?.data;
  const drillInput = drillSource?.drilldown.input;
  const orgDrill = trpc.analytics.drilldown.useQuery(drillInput as never, { enabled: mode === "organization" && !!drillInput, retry: 1 });
  const mineDrill = trpc.analytics.mineDrilldown.useQuery(drillInput as never, { enabled: mode === "mine" && !!drillInput, retry: 1 });
  const drillQuery = mode === "mine" ? mineDrill : orgDrill;
  const drillCard = cards.find(c => c.id === drillId);
  const drill: DrillState = !drillId || !drillCard ? null : {
    metricId: drillId, name: drillCard.name, unit: drillCard.unit,
    state: !drillInput || drillQuery.isPending ? { kind: "loading" }
      : drillQuery.isError ? { kind: "failed", message: drillQuery.error.message }
      : !drillQuery.data ? { kind: "loading" }
      : { kind: "loaded", answer: toAnswer(drillQuery.data), rows: drillQuery.data.rows, truncated: drillQuery.data.truncated },
  };

  const firstScope = mode === "mine"
    ? mine.data?.metrics[0]?.scope
    : metricQueries.find(q => q.data)?.data?.scope;
  const loading = mode === "mine" ? mine.isPending : catalog.isPending;
  const failure = mode === "mine"
    ? (mine.isError ? mine.error.message : null)
    : (catalog.isError && !refusedCatalog ? catalog.error.message : null);

  return (
    <AnalyticsDashboardView
      mode={mode}
      onMode={refusedCatalog ? null : m => { setDrillId(null); setChosenMode(m); }}
      failure={failure}
      loading={loading}
      cards={cards}
      hiddenCount={mode === "organization" ? all.length - permitted.length : 0}
      emptyReason={mode === "mine" ? (mine.data?.reason ?? null) : null}
      scope={firstScope ? { derivedFrom: firstScope.derivedFrom } : null}
      range={range}
      onRange={r => { setDrillId(null); setRange(r); }}
      zone={zone}
      now={now}
      onRefresh={() => { void catalog.refetch(); metricQueries.forEach(q => void q.refetch()); if (mode === "mine") void mine.refetch(); if (drillInput) void drillQuery.refetch(); }}
      refreshing={catalog.isFetching || metricQueries.some(q => q.isFetching) || mine.isFetching}
      drill={drill}
      onDrill={setDrillId}
    />
  );
}
