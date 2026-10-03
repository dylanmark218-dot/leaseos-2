/**
 * v23.31 — the small vocabulary the commercial screens share: page states, money and date text,
 * the status badge, the enum-to-words map. One place, so a status never gets an inline colour.
 */
import { Badge } from "@/components/ui/badge";
import type { ReactNode } from "react";

/** Every screen carries one of these; the view renders the state, never a blank. */
export type PageState<T> =
  | { kind: "loading" }
  | { kind: "loaded"; data: T }
  | { kind: "empty"; note: string }
  | { kind: "failed"; message: string }
  | { kind: "unauthorized" }
  | { kind: "offline" };

export const cents = (c: number | null | undefined, currency = "CAD") => (c == null ? "—" : (c / 100).toLocaleString(undefined, { style: "currency", currency }));
export const millis = (m: number | null | undefined, currency = "CAD") => (m == null ? "—" : (m / 1000).toLocaleString(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 3 }));
export const day = (v: Date | string | null | undefined) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : "—");
export const pct = (bps: number | null | undefined) => (bps == null ? "—" : `${(bps / 100).toFixed(2)}%`);

/** The words a person reads for an identifier. Never inline. */
export const HUMAN: Record<string, string> = {
  active: "Active", on_hold: "On billing hold", inactive: "Inactive", draft: "Draft", pending_approval: "Awaiting approval", approved: "Approved", rejected: "Rejected", superseded: "Superseded", retired: "Retired",
  suspended: "Suspended", expired: "Expired", terminated: "Terminated", current: "Current", ended: "Ended", open: "Open", exhausted: "Exhausted", closed: "Closed",
  producer_operator: "Producer / operator", oilfield_service: "Oilfield service", prime_contractor: "Prime contractor", consultant: "Consultant", disposal_company: "Disposal company", municipality: "Municipality", construction: "Construction", trucking: "Trucking", other: "Other",
  msa: "Master service agreement", rate_agreement: "Rate agreement", service_agreement: "Service agreement", work_order: "Work order", purchase_order: "Purchase order", framework: "Framework", taxable: "Taxable", zero_rated: "Zero-rated", exempt: "Exempt", unknown: "Not established",
  inherit: "As the account", required: "Required", not_required: "Not required", none: "None", manual: "Manual", auto: "Automatic", per_job: "Per job", weekly: "Weekly", monthly: "Monthly",
  in_term: "In term", notice_period: "Notice period", open_ended: "Open-ended", customer_contract: "Contract", customer_rate_card: "Customer sheet", company: "Company default", branch: "Branch", job_override: "Job override",
  resolved: "Resolved", conflict: "Conflict — a person decides", not_selected: "No sheet selected", blocking: "Blocked", review: "Review", activation: "Activation", correction: "Correction", manual_snapshot: "Manual",
  // v23.32 — billing, invoicing and receivables
  not_ready: "Not ready", awaiting_documents: "Awaiting documents", awaiting_signatures: "Awaiting signatures", awaiting_disposal: "Awaiting disposal", awaiting_commercial: "Awaiting commercial basis", ready: "Ready to bill",
  under_review: "Under review", approved_for_invoicing: "Approved for invoicing", invoiced: "Invoiced", partially_paid: "Partially paid", paid: "Paid", disputed: "Disputed", credited: "Credited",
  in_review: "In review", sent: "Issued", viewed: "Issued · viewed", void: "Void", held: "Held", proposed: "Proposed", cancelled: "Cancelled", overdue: "Overdue", credit_pending: "Credit pending",
  priced: "Priced", unknown_rate: "No rate — held", conversion_review: "Unit conversion needs review", measurement_review: "Measurement needs review", requested: "Requested", refused: "Refused", unapplied: "Unapplied", partially_applied: "Partly applied", applied: "Applied", reversed: "Reversed",
  pending: "Pending", exported: "Exported", failed: "Failed", raised: "Raised", investigating: "Investigating", resolved_upheld: "Resolved — upheld", resolved_credited: "Resolved — credited", resolved_partial: "Resolved — partly credited", withdrawn: "Withdrawn",
  d1_30: "1–30 days overdue", d31_60: "31–60 days", d61_90: "61–90 days", d90_plus: "Over 90 days", field_ticket_line: "Field ticket line", billing_charges: "Billing charges", field_ticket: "Field ticket",
};
export const human = (k: string | null | undefined) => (k == null ? "—" : HUMAN[k] ?? k.replace(/_/g, " "));

/** Six states, one vocabulary (design system §3): the icon and the word carry it; colour reinforces. */
const TONE: Record<string, { mark: string; className: string }> = {
  ready: { mark: "✓", className: "border-emerald-700 text-emerald-800 bg-emerald-50" },
  review: { mark: "!", className: "border-amber-700 text-amber-800 bg-amber-50" },
  blocked: { mark: "×", className: "border-red-700 text-red-800 bg-red-50" },
  unknown: { mark: "?", className: "border-slate-500 text-slate-700 bg-slate-50" },
  pending: { mark: "○", className: "border-slate-400 text-slate-700 bg-white" },
};
const STATUS_TONE: Record<string, keyof typeof TONE> = {
  active: "ready", approved: "ready", current: "ready", resolved: "ready", open: "ready", in_term: "ready",
  on_hold: "blocked", suspended: "blocked", terminated: "blocked", blocking: "blocked", conflict: "blocked", exhausted: "blocked",
  pending_approval: "review", draft: "pending", review: "review", notice_period: "review", expired: "review",
  inactive: "unknown", superseded: "unknown", retired: "unknown", rejected: "unknown", ended: "unknown", closed: "unknown", unknown: "unknown", not_selected: "unknown",
  // v23.32
  ready: "ready", approved_for_invoicing: "ready", paid: "ready", priced: "ready", applied: "ready", exported: "ready", resolved_upheld: "ready", sent: "ready", viewed: "ready", invoiced: "ready",
  not_ready: "blocked", held: "blocked", overdue: "blocked", disputed: "blocked", failed: "blocked", unknown_rate: "blocked", raised: "blocked",
  awaiting_documents: "review", awaiting_signatures: "review", awaiting_disposal: "review", awaiting_commercial: "review", under_review: "review", in_review: "review", partially_paid: "review", proposed: "review", requested: "review",
  credit_pending: "review", partially_applied: "review", conversion_review: "review", measurement_review: "review", investigating: "review", conflict_export: "review",
  credited: "unknown", void: "unknown", cancelled: "unknown", reversed: "unknown", refused: "unknown", withdrawn: "unknown", resolved_credited: "unknown", resolved_partial: "unknown", unapplied: "pending", pending: "pending",
};
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const t = TONE[STATUS_TONE[status ?? "unknown"] ?? "unknown"]!;
  return <Badge variant="outline" className={t.className}><span aria-hidden="true" className="mr-1">{t.mark}</span>{human(status)}</Badge>;
}

export function Alert({ tone, children }: { tone: "failed" | "note"; children: ReactNode }) {
  return <div role={tone === "failed" ? "alert" : "status"} className={`rounded border p-3 text-sm ${tone === "failed" ? "border-red-700 bg-red-50 text-red-900" : "border-slate-300 bg-slate-50 text-slate-800"}`}>{children}</div>;
}
export function Loading({ what }: { what: string }) { return <p role="status" className="text-sm text-slate-600" data-testid="commercial-loading">Reading {what}…</p>; }

/** The states every screen shares. Returns null when the data is loaded and the caller renders it. */
export function StateBlock<T>({ state, what }: { state: PageState<T>; what: string }) {
  switch (state.kind) {
    case "loading": return <Loading what={what} />;
    case "failed": return <Alert tone="failed">This could not be read: {state.message}. A read that failed is not a record that is empty.</Alert>;
    case "unauthorized": return <Alert tone="note" ><span data-testid="not-permitted">You do not hold the permission this screen needs. Nothing here is hidden by the browser; the server refused the read.</span></Alert>;
    case "offline": return <Alert tone="note"><span data-testid="offline">You are offline. What is shown was read earlier; approvals and edits wait for a connection.</span></Alert>;
    case "empty": return <p className="text-sm text-muted-foreground" data-testid="empty">{state.note}</p>;
    default: return null;
  }
}
export const Section = ({ title, children, id }: { title: string; children: ReactNode; id: string }) => (
  <section aria-labelledby={`${id}-heading`} className="rounded border bg-background p-3">
    <h3 id={`${id}-heading`} className="mb-2 text-sm font-semibold">{title}</h3>
    {children}
  </section>
);
export const Field = ({ label, value }: { label: string; value: ReactNode }) => <div className="flex justify-between gap-3 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="text-right">{value ?? "—"}</dd></div>;
export function TabBar<K extends string>({ tabs, active, onTab }: { tabs: { key: K; label: string }[]; active: K; onTab: (k: K) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist">
      {tabs.map(t => <button key={t.key} role="tab" aria-selected={active === t.key} className={`rounded border px-3 py-1 text-sm ${active === t.key ? "bg-slate-900 text-white" : "bg-white text-slate-800"}`} onClick={() => onTab(t.key)}>{t.label}</button>)}
    </div>
  );
}
export function HistoryList({ rows }: { rows: { id: number; eventType: string; fromStatus: string | null; toStatus: string | null; reason: string | null; actorUserId: number; actorRole: string; occurredAt: Date | string; changesJson?: string | null }[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground" data-testid="empty">Nothing has happened to this record yet.</p>;
  return (
    <ol className="space-y-1 text-sm" aria-label="Audit history">
      {rows.map(r => (
        <li key={r.id} className="rounded border p-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{human(r.eventType)}</span><span className="text-xs text-muted-foreground">{day(r.occurredAt)} · user {r.actorUserId} ({r.actorRole})</span></div>
          {(r.fromStatus || r.toStatus) && <div className="text-xs">{human(r.fromStatus)} → {human(r.toStatus)}</div>}
          {r.reason && <div className="text-xs text-muted-foreground">{r.reason}</div>}
          {r.changesJson && <details className="text-xs"><summary className="cursor-pointer">Changes</summary><pre className="whitespace-pre-wrap">{r.changesJson}</pre></details>}
        </li>
      ))}
    </ol>
  );
}
