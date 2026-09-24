/**
 * 0175 — The client services portal, presentational.
 *
 * Eleven sections on one shell: Dashboard, Active / Scheduled / Completed Jobs, Job Tracking, Loads,
 * Disposal Tickets, Documents, Invoices, Open Billing, Contacts. Prop-driven, so every section runs
 * through the axe rules without a session. The job-tracking section is the same projection the
 * one-time link renders, drawn with the same view-models. The shell names no account: everything
 * shown was scoped by the server.
 */
import { contactRows, dashboardTiles, invoiceRows, jobRows, SECTION_LABEL, SECTIONS, ticketRows, type ContactsInput, type DashboardInput, type InvoiceRow, type JobRow, type Section, type TicketRow } from "./clientViewModels";
import { loadRows, loadsSummary, locationLine, routeLine, ticketView, timelineRows, toneOf, type Tone } from "../../tracking/trackingViewModels";
import type { TrackingLoads, TrackingStatus, TrackingTicket } from "../../tracking/TrackingView";

export type ClientPortalViewProps = {
  section: Section;
  onSection: (s: Section) => void;
  me: { displayName: string } | null;
  dashboard: DashboardInput | null;
  jobs: readonly JobRow[] | null;
  selectedJob: string | null;
  onSelectJob: (jobReference: string) => void;
  jobDetail: TrackingStatus | null;
  loads: TrackingLoads | null;
  documents: readonly { releaseRef: string; documentRef: string; kind: string; title: string; jobReference: string | null }[] | null;
  invoices: readonly InvoiceRow[] | null;
  tickets: readonly (TicketRow & TrackingTicket & { snapshotHash?: string | null })[] | null;
  contacts: ContactsInput | null;
  onDownload?: (releaseRef: string) => void;
  onTicketAction?: (ticketNumber: string, kind: "acknowledge" | "approve" | "dispute" | "comment") => void;
  error?: string | null;
  loading?: boolean;
};

const TONE_CLASS: Record<Tone, string> = {
  scheduled: "bg-[#eef2f7] text-[#3b4b63]", moving: "bg-[#e8f0fe] text-[#1a4fa3]", working: "bg-[#e6f4ea] text-[#1e6b3a]", hold: "bg-[#fff4e5] text-[#8a4b0a]",
  attention: "bg-[#fdecec] text-[#b42318]", done: "bg-[#eef2f7] text-[#5b6b82]", unknown: "bg-[#f3f3f3] text-[#555]",
};
const card = "rounded-2xl border border-[#dfe5ee] bg-white p-4 dark:border-[#25344a] dark:bg-[#131d2e]";

export function ClientPortalView(p: ClientPortalViewProps) {
  const jobsFor = (bucket: JobRow["bucket"]) => jobRows((p.jobs ?? []).filter(j => j.bucket === bucket));
  const heading = SECTION_LABEL[p.section];
  return (
    <div className="min-h-screen bg-[#f6f8fb] text-[#172033] dark:bg-[#0d1522] dark:text-[#e8eef7]">
      <header className="border-b border-[#dfe5ee] bg-white/95 dark:border-[#25344a] dark:bg-[#131d2e]/95">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#6e7f96]">LeaseOS · Client Services</p>
          {p.me && <p className="text-sm text-[#6e7f96]">{p.me.displayName}</p>}
        </div>
        <nav aria-label="Portal sections" className="mx-auto max-w-6xl overflow-x-auto px-4 pb-2">
          <ul className="flex gap-1">
            {SECTIONS.map(s => (
              <li key={s}><button type="button" onClick={() => p.onSection(s)} aria-current={p.section === s ? "page" : undefined} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm ${p.section === s ? "bg-[#132a4a] text-white" : "bg-[#eef2f7] text-[#3b4b63] dark:bg-[#1c2a40] dark:text-[#b7c4d6]"}`}>{SECTION_LABEL[s]}</button></li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{heading}</h1>
        {p.error && <p role="alert" className="rounded-xl border border-[#f1c9c9] bg-[#fdecec] px-4 py-2 text-sm text-[#b42318]">{p.error}</p>}
        {p.loading && <p role="status" className="text-sm text-[#6e7f96]">Loading…</p>}

        {p.section === "dashboard" && p.dashboard && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {dashboardTiles(p.dashboard).map((t, i) => (
              <li key={i}>
                <button type="button" onClick={() => p.onSection(t.section)} className={`w-full ${card} text-left ${t.attention ? "border-[#f1c9c9]" : ""}`}>
                  <p className="text-xs uppercase tracking-[0.14em] text-[#6e7f96]">{t.label}</p>
                  <p className={`mt-1 text-2xl font-semibold tabular-nums ${t.attention ? "text-[#b42318]" : ""}`}>{t.value}</p>
                  {t.sub && <p className="mt-1 text-xs text-[#6e7f96]">{t.sub}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {(p.section === "active" || p.section === "scheduled" || p.section === "completed") && (
          <ul className={`divide-y divide-[#eef2f7] ${card} p-0 dark:divide-[#25344a]`}>
            {jobsFor(p.section).map(j => (
              <li key={j.jobReference}>
                <button type="button" onClick={() => p.onSelectJob(j.jobReference)} className="grid w-full gap-1 p-4 text-left sm:grid-cols-4 sm:items-center">
                  <span><span className="font-semibold">#{j.jobReference}</span>{j.customerReference && <span className="block text-xs text-[#6e7f96]">Ref {j.customerReference}</span>}</span>
                  <span className="text-sm text-[#3b4b63] dark:text-[#b7c4d6] sm:col-span-2">{routeLine(j)}</span>
                  <span className="justify-self-start sm:justify-self-end"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${TONE_CLASS[toneOf(j.status.label)]}`}>{j.status.label}</span>{j.unit && <span className="ml-2 text-xs text-[#6e7f96]">Truck {j.unit.unitNumber}</span>}</span>
                </button>
              </li>
            ))}
            {jobsFor(p.section).length === 0 && <li className="p-4 text-sm text-[#6e7f96]">No {p.section} jobs on this account.</li>}
          </ul>
        )}

        {p.section === "tracking" && (p.jobDetail ? (() => {
          const s = p.jobDetail; const tone = toneOf(s.status.label); const loc = locationLine(s.location, s.eta);
          return (
            <section aria-labelledby="job-heading" className={card}>
              <p className="text-xs uppercase tracking-[0.18em] text-[#6e7f96]">Job</p>
              <h2 id="job-heading" className="text-2xl font-semibold">#{s.jobReference}</h2>
              <p className="mt-1 text-sm text-[#3b4b63] dark:text-[#b7c4d6]">{routeLine(s)}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2"><span className={`rounded-full px-3 py-1 text-sm font-semibold uppercase ${TONE_CLASS[tone]}`}>{s.status.label}</span><span className="text-xs text-[#6e7f96]">{s.status.basis}</span></div>
              <ol className="mt-4 grid grid-cols-3 gap-y-2 sm:grid-cols-9">
                {timelineRows(s.timeline, s.status.label).map(r => <li key={r.step} aria-current={r.current ? "step" : undefined} className={`text-xs ${r.reached ? "font-semibold" : "text-[#8a9bb5]"}`}>{r.step}<span className="block text-[11px] font-normal text-[#6e7f96]">{r.reached ? r.at : ""}</span></li>)}
              </ol>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div><p className="text-xs uppercase text-[#6e7f96]">Driver / Unit</p>{s.unit ? <p className="text-sm">Truck <span className="font-semibold">{s.unit.unitNumber}</span> · {s.unit.vehicleType}</p> : <p className="text-sm text-[#6e7f96]">Unit identity not shared</p>}{s.operatorDisplayName && <p className="text-sm">Operator {s.operatorDisplayName}</p>}</div>
                <div><p className="text-xs uppercase text-[#6e7f96]">ETA / Location</p><p className={`text-sm ${loc.stale ? "font-semibold text-[#8a4b0a]" : ""}`}>{loc.headline}</p>{loc.coordinates && <p className="font-mono text-xs text-[#6e7f96]">{loc.coordinates}</p>}{loc.detail && <p className="text-xs text-[#6e7f96]">{loc.detail}</p>}</div>
              </div>
              {!s.live.available && <p className="mt-3 text-xs text-[#6e7f96]">Live tracking has ended for this job ({s.live.reason}).</p>}
            </section>
          );
        })() : <p className="text-sm text-[#6e7f96]">Choose a job from Active, Scheduled or Completed to track it.</p>)}

        {(p.section === "loads" || p.section === "disposal") && (p.loads ? (
          <section className={card} aria-labelledby="loads-heading">
            <h2 id="loads-heading" className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6e7f96]">{p.section === "loads" ? "Loads" : "Disposal tickets"} · {p.selectedJob ? `#${p.selectedJob}` : ""} · {loadsSummary(p.loads)}</h2>
            <ul className="mt-3 divide-y divide-[#eef2f7] dark:divide-[#25344a]">
              {loadRows(p.loads.items).filter(l => p.section === "loads" || l.lines.some(x => x.startsWith("Disposal ticket"))).map(l => (
                <li key={l.title} className="flex items-start justify-between gap-3 py-3"><div><p className="text-sm font-semibold">{l.title}</p>{l.lines.map((x, i) => <p key={i} className="text-xs text-[#6e7f96]">{x}</p>)}</div><span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[l.tone]}`}>{l.state}</span></li>
              ))}
              {p.loads.items.length === 0 && <li className="py-3 text-sm text-[#6e7f96]">No loads recorded yet.</li>}
            </ul>
          </section>
        ) : <p className="text-sm text-[#6e7f96]">Choose a job to see its loads.</p>)}

        {p.section === "documents" && p.documents && (
          <ul className={`divide-y divide-[#eef2f7] ${card} p-0 dark:divide-[#25344a]`}>
            {p.documents.map(d => (
              <li key={d.releaseRef} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <span><span className="font-medium">{d.title}</span><span className="block text-xs text-[#6e7f96]">{d.documentRef} · {d.kind.replace(/_/g, " ")}{d.jobReference ? ` · Job #${d.jobReference}` : ""}</span></span>
                <button type="button" onClick={() => p.onDownload?.(d.releaseRef)} className="rounded-xl border border-[#132a4a] px-3 py-1.5 text-sm font-medium text-[#132a4a] dark:border-[#8fb0e0] dark:text-[#8fb0e0]" aria-label={`Download ${d.title} (${d.documentRef})`}>Download</button>
              </li>
            ))}
            {p.documents.length === 0 && <li className="p-4 text-sm text-[#6e7f96]">No documents have been released to this account yet.</li>}
          </ul>
        )}

        {p.section === "invoices" && p.invoices && (
          <table className={`w-full text-sm ${card}`}>
            <caption className="sr-only">Invoices issued to this account</caption>
            <thead><tr className="text-left text-xs uppercase text-[#6e7f96]"><th scope="col" className="pb-2">Invoice</th><th scope="col" className="pb-2">Status</th><th scope="col" className="pb-2 text-right">Total</th><th scope="col" className="pb-2 text-right">Balance</th><th scope="col" className="pb-2 text-right">Due</th></tr></thead>
            <tbody>
              {invoiceRows(p.invoices).map(r => <tr key={r.invoiceNumber} className="border-t border-[#eef2f7] dark:border-[#25344a]"><td className="py-2 font-medium">{r.invoiceNumber}</td><td className="py-2">{r.status}</td><td className="py-2 text-right tabular-nums">{r.total}</td><td className="py-2 text-right tabular-nums">{r.balance}</td><td className={`py-2 text-right ${r.overdue ? "font-semibold text-[#b42318]" : ""}`}>{r.due}{r.overdue ? " · overdue" : ""}</td></tr>)}
              {p.invoices.length === 0 && <tr><td colSpan={5} className="py-2 text-[#6e7f96]">No invoices issued yet.</td></tr>}
            </tbody>
          </table>
        )}

        {p.section === "billing" && p.tickets && (
          <div className="space-y-4">
            {ticketRows(p.tickets).map(row => {
              const full = p.tickets!.find(t => t.ticketNumber === row.ticketNumber)!; const v = ticketView(full);
              return (
                <section key={row.ticketNumber} className={`${card} ${row.needsYou ? "border-[#f1c9c9]" : ""}`} aria-labelledby={`t-${row.ticketNumber}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id={`t-${row.ticketNumber}`} className="text-sm font-semibold">Ticket {row.ticketNumber} · Job #{row.jobReference}</h2><span className="text-xs text-[#6e7f96]">{row.status}</span></div>
                  <table className="mt-2 w-full text-sm"><caption className="sr-only">Lines on {row.ticketNumber}</caption><thead className="sr-only"><tr><th scope="col">Line</th><th scope="col">Quantity</th><th scope="col">Amount</th></tr></thead>
                    <tbody>{v.lines.map((l, i) => <tr key={i} className="border-t border-[#eef2f7] dark:border-[#25344a]"><td className="py-1.5 pr-2">{l.description}</td><td className="py-1.5 pr-2 text-right tabular-nums text-[#3b4b63] dark:text-[#b7c4d6]">{l.quantity}</td><td className="py-1.5 text-right tabular-nums">{l.amount}</td></tr>)}</tbody></table>
                  <dl className="mt-3 space-y-2">{v.figures.map(f => <div key={f.kind} className={`flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 ${f.kind === "invoice" ? "bg-[#132a4a] text-white" : f.kind === "final" ? "bg-[#e6f4ea]" : "bg-[#f6f8fb] dark:bg-[#0d1522]"}`}><dt className="text-xs">{f.label}<span className="block text-[11px] opacity-80">{f.sub}</span></dt><dd className="text-base font-semibold tabular-nums">{f.value}</dd></div>)}</dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {v.actions.approve && <button type="button" onClick={() => p.onTicketAction?.(row.ticketNumber, "approve")} className="rounded-xl bg-[#132a4a] px-4 py-2 text-sm font-semibold text-white">Approve as shown</button>}
                    {v.actions.dispute && <button type="button" onClick={() => p.onTicketAction?.(row.ticketNumber, "dispute")} className="rounded-xl border border-[#b42318] px-4 py-2 text-sm font-semibold text-[#b42318]">Dispute</button>}
                    {v.actions.acknowledge && <button type="button" onClick={() => p.onTicketAction?.(row.ticketNumber, "acknowledge")} className="rounded-xl border border-[#132a4a] px-4 py-2 text-sm text-[#132a4a] dark:border-[#8fb0e0] dark:text-[#8fb0e0]">Acknowledge</button>}
                    {v.actions.comment && <button type="button" onClick={() => p.onTicketAction?.(row.ticketNumber, "comment")} className="rounded-xl border border-[#dfe5ee] px-4 py-2 text-sm">Comment</button>}
                  </div>
                </section>
              );
            })}
            {p.tickets.length === 0 && <p className="text-sm text-[#6e7f96]">No open tickets on this account.</p>}
          </div>
        )}

        {p.section === "contacts" && p.contacts && contactRows(p.contacts).map(g => (
          <section key={g.group} className={card} aria-labelledby={`c-${g.group.replace(/\s+/g, "-")}`}>
            <h2 id={`c-${g.group.replace(/\s+/g, "-")}`} className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6e7f96]">{g.group}</h2>
            <ul className="mt-2 divide-y divide-[#eef2f7] dark:divide-[#25344a]">{g.rows.map((r, i) => <li key={i} className="py-2 text-sm"><span className="font-medium">{r.name}</span><span className="block text-xs text-[#6e7f96]">{r.detail}</span></li>)}{g.rows.length === 0 && <li className="py-2 text-sm text-[#6e7f96]">None on file.</li>}</ul>
          </section>
        ))}
      </main>
    </div>
  );
}
