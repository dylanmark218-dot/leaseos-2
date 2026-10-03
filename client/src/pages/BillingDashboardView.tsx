/**
 * v23.32 — the billing dashboard, pure: what needs a person, what is ready, what is drafted, what awaits approval,
 * what is issued, overdue, disputed and paid. Every row opens the job's billing or the invoice; nothing is decided
 * here — the server decided who may read this, and every action is a procedure that checks again.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, cents, day, human, type PageState, StateBlock, StatusBadge, TabBar } from "../commercial/shared";

export const DASHBOARD_BUCKETS = ["needs_attention", "ready", "draft", "awaiting_approval", "issued", "overdue", "disputed", "paid"] as const;
export type DashboardBucket = (typeof DASHBOARD_BUCKETS)[number];
const BUCKET_LABEL: Record<DashboardBucket, string> = { needs_attention: "Needs attention", ready: "Ready", draft: "Draft", awaiting_approval: "Awaiting approval", issued: "Issued", overdue: "Overdue", disputed: "Disputed", paid: "Paid" };

export type JobRow = { jobId: number; jobCode: string; customer: string; state: string; holdActive: boolean; blockers: { code: string; message: string }[]; attention: number; updatedAt: Date | string };
export type InvoiceRow = { invoiceNumber: string; origin: string; status: string; customer: string; currency: string; totalCents: number; issuedAt: Date | string | null; dueAt: Date | string | null; createdAt: Date | string; receivable: { outstandingCents: number; arStatus: string; daysOverdue: number } };
export type Dashboard = { asOf: Date | string; counts: Record<DashboardBucket, number>; buckets: Record<DashboardBucket, (JobRow | InvoiceRow)[]> };
export type BillingDashboardViewProps = {
  offline: boolean; dashboard: PageState<Dashboard>; bucket: DashboardBucket; onBucket: (b: DashboardBucket) => void;
  filter: { q: string; accountRef: string }; onFilter: (f: { q: string; accountRef: string }) => void;
  onOpenJob: (jobId: number) => void; onOpenInvoice: (invoiceNumber: string) => void; onOpenReceivables: () => void;
};
const isJob = (r: JobRow | InvoiceRow): r is JobRow => "jobId" in r && "state" in r;

export function BillingDashboardView(p: BillingDashboardViewProps) {
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="billing-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Billing</h1>
        <Button variant="outline" onClick={p.onOpenReceivables}>Receivables and payments</Button>
      </div>
      {p.offline && <StateBlock state={{ kind: "offline" }} what="billing" />}
      <form className="flex flex-wrap items-end gap-2" role="search" aria-label="Filter billing" onSubmit={e => e.preventDefault()}>
        <label className="text-sm">Job or invoice
          <Input value={p.filter.q} onChange={e => p.onFilter({ ...p.filter, q: e.target.value })} placeholder="JOB-… or INV-…" />
        </label>
        <label className="text-sm">Customer account
          <Input value={p.filter.accountRef} onChange={e => p.onFilter({ ...p.filter, accountRef: e.target.value })} placeholder="CUST-…" />
        </label>
      </form>
      <StateBlock state={p.dashboard} what="the billing dashboard" />
      {p.dashboard.kind === "loaded" && (() => {
        const d = p.dashboard.data;
        const rows = d.buckets[p.bucket] ?? [];
        return (
          <div className="space-y-3">
            <TabBar tabs={DASHBOARD_BUCKETS.map(k => ({ key: k, label: `${BUCKET_LABEL[k]} (${d.counts[k] ?? 0})` }))} active={p.bucket} onTab={p.onBucket} />
            {rows.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="empty">Nothing is {BUCKET_LABEL[p.bucket].toLowerCase()} right now.</p> : (
              <table className="w-full text-sm" aria-label={BUCKET_LABEL[p.bucket]}>
                <thead><tr className="text-left"><th scope="col">Record</th><th scope="col">Customer</th><th scope="col">State</th><th scope="col">Amount / what is needed</th><th scope="col">Date</th></tr></thead>
                <tbody>
                  {rows.map(r => isJob(r) ? (
                    <tr key={`j${r.jobId}`} className="border-t align-top">
                      <td><button className="underline" onClick={() => p.onOpenJob(r.jobId)}>{r.jobCode}</button></td>
                      <td>{r.customer}</td>
                      <td><StatusBadge status={r.state} />{r.holdActive && <span className="ml-1"><StatusBadge status="on_hold" /></span>}</td>
                      <td>{r.blockers.length ? <ul className="list-disc pl-4">{r.blockers.slice(0, 3).map(b => <li key={b.code + b.message}>{b.message}</li>)}</ul> : r.attention ? `${r.attention} charge(s) need a decision` : "—"}</td>
                      <td>{day(r.updatedAt)}</td>
                    </tr>
                  ) : (
                    <tr key={`i${r.invoiceNumber}`} className="border-t align-top">
                      <td><button className="underline" onClick={() => p.onOpenInvoice(r.invoiceNumber)}>{r.invoiceNumber}</button>{r.origin === "field_ticket" && <span className="ml-1 text-xs text-muted-foreground">(field-ticket path)</span>}</td>
                      <td>{r.customer}</td>
                      <td><StatusBadge status={r.receivable.arStatus === "overdue" ? "overdue" : r.status} /></td>
                      <td>{cents(r.totalCents, r.currency)}{r.receivable.outstandingCents !== r.totalCents && <span className="block text-xs text-muted-foreground">outstanding {cents(r.receivable.outstandingCents, r.currency)}{r.receivable.daysOverdue > 0 ? ` · ${r.receivable.daysOverdue} days overdue` : ""}</span>}</td>
                      <td>{r.dueAt ? `due ${day(r.dueAt)}` : day(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Alert tone="note">Money is shown in the invoice's currency, in cents as recorded. A job enters billing once its commercial basis is frozen; {human("needs_attention")} lists jobs with blockers, holds or charges awaiting a decision.</Alert>
          </div>
        );
      })()}
    </div>
  );
}
