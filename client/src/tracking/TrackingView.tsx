/**
 * 0175 — The customer's tracking page, presentational.
 *
 * Deliberately simpler than Dispatch or Field: one job, one status, a timeline, the unit, where it
 * is, the loads, the documents released, and the open service ticket with its figures each labelled
 * for what they are. Prop-driven so every state runs through the axe rules and the privacy checks
 * without a browser session. Phone first; the same markup widens to a tablet and a desktop.
 */
import { loadRows, loadsSummary, locationLine, refusalMessage, routeLine, ticketView, timelineRows, toneOf, type Tone } from "./trackingViewModels";

export type TrackingStatus = {
  jobReference: string; customerReference: string | null; serviceType: string; origin: string; destination: string | null;
  status: { label: string; basis: string; since: string | Date | null };
  timeline: { step: string; reached: boolean; at: string | Date | null }[];
  unit: { unitNumber: string; vehicleType: string } | null; operatorDisplayName: string | null; eta: string | null;
  location: { mode: string; position: { latitude: number; longitude: number; precision: string } | null; recordedAt: string | Date | null; ageMinutes: number | null; stale: boolean; note: string };
  live: { available: boolean; reason: string; until: string | Date | null };
  lastUpdatedAt: string | Date;
};
export type TrackingLoads = { total: number; completed: number; active: number; items: Parameters<typeof loadRows>[0] };
export type TrackingDocument = { releaseRef: string; documentRef: string; kind: string; title: string };
export type TrackingTicket = Parameters<typeof ticketView>[0];

export type TrackingViewProps = {
  state:
    | { kind: "loading" }
    | { kind: "refused"; message: string | null }
    | { kind: "loaded"; issuedTo: { name: string; kind: string | null } | null; status: TrackingStatus; loads: TrackingLoads | null; documents: TrackingDocument[] | null; tickets: TrackingTicket[] | null };
  onDownload?: (releaseRef: string) => void;
  onReviewTicket?: (ticketNumber: string) => void;
  downloading?: string | null;
  error?: string | null;
};

const TONE_CLASS: Record<Tone, string> = {
  scheduled: "bg-[#eef2f7] text-[#3b4b63]", moving: "bg-[#e8f0fe] text-[#1a4fa3]", working: "bg-[#e6f4ea] text-[#1e6b3a]", hold: "bg-[#fff4e5] text-[#8a4b0a]",
  attention: "bg-[#fdecec] text-[#b42318]", done: "bg-[#eef2f7] text-[#5b6b82]", unknown: "bg-[#f3f3f3] text-[#555]",
};
const DOT_CLASS: Record<Tone, string> = { scheduled: "bg-[#8a9bb5]", moving: "bg-[#1a4fa3]", working: "bg-[#1e6b3a]", hold: "bg-[#8a4b0a]", attention: "bg-[#b42318]", done: "bg-[#5b6b82]", unknown: "bg-[#999]" };

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-4 dark:border-[#25344a] dark:bg-[#131d2e]" aria-labelledby={`sec-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`sec-${title.replace(/\s+/g, "-").toLowerCase()}`} className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6e7f96]">{title}</h2>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function TrackingView({ state, onDownload, onReviewTicket, downloading, error }: TrackingViewProps) {
  return (
    <main className="min-h-screen bg-[#f6f8fb] text-[#172033] dark:bg-[#0d1522] dark:text-[#e8eef7]">
      <header className="border-b border-[#dfe5ee] bg-white/95 dark:border-[#25344a] dark:bg-[#131d2e]/95">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#6e7f96]">LeaseOS</p>
          {state.kind === "loaded" && state.issuedTo && <p className="text-xs text-[#6e7f96]">For {state.issuedTo.name}</p>}
        </div>
      </header>
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5">
        {state.kind === "loading" && <p role="status" className="text-sm text-[#6e7f96]">Opening your tracking link…</p>}
        {state.kind === "refused" && (() => { const r = refusalMessage(state.message); return (
          <div role="alert" className="rounded-2xl border border-[#f1c9c9] bg-[#fdecec] p-5">
            <h1 className="text-lg font-semibold text-[#b42318]">{r.headline}</h1>
            <p className="mt-2 text-sm text-[#7a2a22]">{r.detail}</p>
          </div>); })()}
        {error && <p role="alert" className="rounded-xl border border-[#f1c9c9] bg-[#fdecec] px-4 py-2 text-sm text-[#b42318]">{error}</p>}
        {state.kind === "loaded" && (() => {
          const s = state.status;
          const tone = toneOf(s.status.label);
          const loc = locationLine(s.location, s.eta);
          const rows = timelineRows(s.timeline, s.status.label);
          return (<>
            <section aria-labelledby="job-heading" className="rounded-2xl border border-[#dfe5ee] bg-white p-5 dark:border-[#25344a] dark:bg-[#131d2e]">
              <p className="text-xs uppercase tracking-[0.18em] text-[#6e7f96]">Job</p>
              <h1 id="job-heading" className="mt-1 text-2xl font-semibold tracking-[-0.02em]">#{s.jobReference}</h1>
              {s.customerReference && <p className="mt-1 text-sm text-[#6e7f96]">Your reference {s.customerReference}</p>}
              <p className="mt-2 text-sm text-[#3b4b63] dark:text-[#b7c4d6]">{routeLine(s)}</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-sm font-semibold uppercase tracking-wide ${TONE_CLASS[tone]}`}>{s.status.label}</span>
                <span className="text-xs text-[#6e7f96]">{s.status.basis}</span>
              </div>
              {!s.live.available && <p className="mt-3 text-xs text-[#6e7f96]">Live tracking has ended for this link ({s.live.reason}). Documents and the service ticket remain available.</p>}
            </section>

            <Section title="Progress">
              <ol className="grid grid-cols-3 gap-y-3 sm:grid-cols-9 sm:gap-y-0">
                {rows.map(r => (
                  <li key={r.step} className="flex flex-col items-start sm:items-center" aria-current={r.current ? "step" : undefined}>
                    <span aria-hidden="true" className={`mb-1 h-3 w-3 rounded-full ${r.reached ? DOT_CLASS[tone === "done" ? "done" : "working"] : "border border-[#c9d3e0] bg-white"}`} />
                    <span className={`text-xs ${r.reached ? "font-semibold" : "text-[#8a9bb5]"}`}>{r.step}</span>
                    <span className="text-[11px] text-[#6e7f96]">{r.reached ? r.at : ""}</span>
                  </li>
                ))}
              </ol>
            </Section>

            <div className="grid gap-4 sm:grid-cols-2">
              <Section title="Driver / Unit">
                {s.unit ? <p className="text-sm">Truck <span className="font-semibold">{s.unit.unitNumber}</span> · {s.unit.vehicleType}</p> : <p className="text-sm text-[#6e7f96]">Unit identity not shared</p>}
                {s.operatorDisplayName && <p className="mt-1 text-sm">Operator {s.operatorDisplayName}</p>}
              </Section>
              <Section title="ETA / Location">
                <p className={`text-sm ${loc.stale ? "font-semibold text-[#8a4b0a]" : ""}`}>{loc.headline}</p>
                {loc.coordinates && <p className="mt-1 font-mono text-xs text-[#6e7f96]">{loc.coordinates}</p>}
                {loc.detail && <p className="mt-1 text-xs text-[#6e7f96]">{loc.detail}</p>}
              </Section>
            </div>

            {state.loads && (
              <Section title="Loads" aside={<span className="text-xs text-[#6e7f96]">{loadsSummary(state.loads)}</span>}>
                {state.loads.items.length === 0 ? <p className="text-sm text-[#6e7f96]">No loads recorded yet.</p> : (
                  <ul className="divide-y divide-[#eef2f7] dark:divide-[#25344a]">
                    {loadRows(state.loads.items).map(l => (
                      <li key={l.title} className="flex items-start justify-between gap-3 py-3">
                        <div><p className="text-sm font-semibold">{l.title}</p>{l.lines.map((x, i) => <p key={i} className="text-xs text-[#6e7f96]">{x}</p>)}</div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[l.tone]}`}>{l.state}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {state.documents && (
              <Section title="Documents">
                {state.documents.length === 0 ? <p className="text-sm text-[#6e7f96]">No documents have been released yet.</p> : (
                  <ul className="flex flex-wrap gap-2">
                    {state.documents.map(d => (
                      <li key={d.releaseRef}>
                        <button type="button" onClick={() => onDownload?.(d.releaseRef)} disabled={downloading === d.releaseRef} className="rounded-xl border border-[#132a4a] px-3 py-2 text-sm font-medium text-[#132a4a] disabled:opacity-60 dark:border-[#8fb0e0] dark:text-[#8fb0e0]" aria-label={`Download ${d.title} (${d.documentRef})`}>
                          {downloading === d.releaseRef ? "Preparing…" : `${d.title} · ${d.documentRef}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {state.tickets && state.tickets.map(ticketView).map(t => (
              <Section key={t.ticketNumber} title="Open Service Ticket" aside={<span className="text-xs text-[#6e7f96]">{t.ticketNumber} · {t.status}</span>}>
                {t.po && <p className="text-xs text-[#6e7f96]">PO {t.po}</p>}
                <table className="mt-2 w-full text-sm">
                  <caption className="sr-only">Customer-visible lines on service ticket {t.ticketNumber}</caption>
                  <thead className="sr-only"><tr><th scope="col">Line</th><th scope="col">Quantity</th><th scope="col">Amount</th></tr></thead>
                  <tbody>
                    {t.lines.map((l, i) => (
                      <tr key={i} className="border-t border-[#eef2f7] dark:border-[#25344a]">
                        <td className="py-2 pr-2">{l.description}{l.detail && <span className="block text-xs text-[#6e7f96]">{l.detail}</span>}{l.decision !== "pending" && <span className="block text-xs text-[#6e7f96]">{l.decision}</span>}</td>
                        <td className="py-2 pr-2 text-right tabular-nums text-[#3b4b63] dark:text-[#b7c4d6]">{l.quantity}</td>
                        <td className="py-2 text-right tabular-nums">{l.amount}</td>
                      </tr>
                    ))}
                    {t.lines.length === 0 && <tr><td colSpan={3} className="py-2 text-[#6e7f96]">No lines yet.</td></tr>}
                  </tbody>
                </table>
                <dl className="mt-3 space-y-2">
                  {t.figures.map(f => (
                    <div key={f.kind} className={`flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 ${f.kind === "invoice" ? "bg-[#132a4a] text-white" : f.kind === "final" ? "bg-[#e6f4ea]" : "bg-[#f6f8fb] dark:bg-[#0d1522]"}`}>
                      <dt className="text-xs">{f.label}<span className="block text-[11px] opacity-80">{f.sub}</span></dt>
                      <dd className="text-base font-semibold tabular-nums">{f.value}</dd>
                    </div>
                  ))}
                </dl>
                {t.reviewable && <button type="button" onClick={() => onReviewTicket?.(t.ticketNumber)} className="mt-3 w-full rounded-xl bg-[#132a4a] px-4 py-3 text-sm font-semibold text-white sm:w-auto">Review ticket</button>}
              </Section>
            ))}
            <p className="pb-6 text-center text-[11px] text-[#8a9bb5]">Last updated {new Date(s.lastUpdatedAt).toLocaleString()}. Figures marked as estimates are not an invoice.</p>
          </>);
        })()}
      </div>
    </main>
  );
}
