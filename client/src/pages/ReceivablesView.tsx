/**
 * v23.32 — accounts receivable, pure: aging by DUE date (current = not yet due, then 1–30, 31–60, 61–90, 90+, with
 * disputes apart), every open invoice with what is outstanding, unapplied cash beside it, recording and applying a
 * payment, and one customer's balance. A card payment records a reference — never a card number.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Alert, cents, day, Field, human, type PageState, Section, StateBlock, StatusBadge } from "../commercial/shared";

export type AgingTotals = { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; disputed: number; total: number };
export type ReceivableRow = { invoiceNumber: string; customer: string; currency: string; totalCents: number; dueAt: Date | string | null; status: string; receivable: { outstandingCents: number; daysOverdue: number; arStatus: string; bucket: string | null } };
export type UnappliedRow = { paymentRef: string; customer: string; receivedAt: Date | string; amountCents: number; currency: string; method: string; reference: string | null; unappliedCents: number };
export type Receivables = { asOf: Date | string; invoices: ReceivableRow[]; totals: AgingTotals; unapplied: UnappliedRow[]; unappliedCents: number };
export type CustomerBalance = { account: { accountRef: string; name: string; status: string; currency: string; paymentTermsDays: number }; outstandingCents: number; overdueCents: number; unappliedCents: number; netOwingCents: number; disputes: { caseNumber: string; invoiceNumber: string | null; status: string; disputedAmountCents: number | null }[]; recentPayments: { paymentRef: string; receivedAt: Date | string; amountCents: number; currency: string; method: string; status: string }[] };
export type PaymentDraft = { financialEntityId: string; accountRef: string; receivedAt: string; amount: string; method: "eft" | "cheque" | "card" | "cash" | "wire" | "other"; reference: string; payerName: string; idempotencyKey: string };
export type ReceivablesViewProps = {
  offline: boolean; receivables: PageState<Receivables>; balance: PageState<CustomerBalance> | null; busy: boolean;
  can: { record: boolean; apply: boolean };
  onRecord: (p: PaymentDraft, amountCents: number) => void; onAllocate: (paymentRef: string, invoiceNumber: string, amountCents: number) => void;
  onBalance: (accountRef: string) => void; onOpenInvoice: (invoiceNumber: string) => void;
};
const BUCKETS: (keyof AgingTotals)[] = ["current", "d1_30", "d31_60", "d61_90", "d90_plus", "disputed"];
const toCents = (s: string) => { const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(s); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : null; };

export function ReceivablesView(p: ReceivablesViewProps) {
  const [pay, setPay] = useState<PaymentDraft>({ financialEntityId: "", accountRef: "", receivedAt: "", amount: "", method: "eft", reference: "", payerName: "", idempotencyKey: "" });
  const [apply, setApply] = useState({ paymentRef: "", invoiceNumber: "", amount: "" });
  const [lookup, setLookup] = useState("");
  const payAmount = toCents(pay.amount), applyAmount = toCents(apply.amount);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="receivables">
      <h1 className="text-xl font-semibold">Receivables</h1>
      {p.offline && <StateBlock state={{ kind: "offline" }} what="receivables" />}
      <StateBlock state={p.receivables} what="receivables" />
      {p.receivables.kind === "loaded" && (() => {
        const r = p.receivables.data;
        return (
          <div className="space-y-3">
            <Section title={`Aging by due date, as of ${day(r.asOf)}`} id="aging">
              <table className="w-full text-sm" aria-label="Aging buckets"><thead><tr className="text-left">{BUCKETS.map(b => <th key={b} scope="col">{b === "current" ? "Current (not yet due)" : human(b)}</th>)}<th scope="col">Total</th><th scope="col">Unapplied cash</th></tr></thead>
                <tbody><tr>{BUCKETS.map(b => <td key={b}>{cents(r.totals[b])}</td>)}<td><strong>{cents(r.totals.total)}</strong></td><td>{cents(r.unappliedCents)}</td></tr></tbody></table>
            </Section>
            <Section title={`Open invoices (${r.invoices.length})`} id="open">
              {r.invoices.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="empty">Nothing is outstanding.</p> : (
                <table className="w-full text-sm" aria-label="Open invoices"><thead><tr className="text-left"><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Due</th><th scope="col">Outstanding</th><th scope="col">Status</th></tr></thead>
                  <tbody>{r.invoices.map(i => <tr key={i.invoiceNumber} className="border-t"><td><button className="underline" onClick={() => p.onOpenInvoice(i.invoiceNumber)}>{i.invoiceNumber}</button></td><td>{i.customer}</td><td>{day(i.dueAt)}{i.receivable.daysOverdue > 0 && <span className="block text-xs">{i.receivable.daysOverdue} days overdue</span>}</td><td>{cents(i.receivable.outstandingCents, i.currency)} of {cents(i.totalCents, i.currency)}</td><td><StatusBadge status={i.receivable.arStatus} /></td></tr>)}</tbody></table>
              )}
            </Section>
            <Section title={`Unapplied payments (${r.unapplied.length})`} id="unapplied">
              {r.unapplied.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="empty">Every payment received is applied.</p> : <ul className="space-y-1 text-sm">{r.unapplied.map(u => <li key={u.paymentRef}>{u.paymentRef} · {u.customer} · {human(u.method)}{u.reference ? ` ${u.reference}` : ""} · received {day(u.receivedAt)} · <strong>{cents(u.unappliedCents, u.currency)}</strong> unapplied of {cents(u.amountCents, u.currency)}</li>)}</ul>}
            </Section>
          </div>
        );
      })()}

      <div className="grid gap-3 md:grid-cols-2">
        {p.can.record && <Section title="Record a payment received" id="record">
          <form className="space-y-2" aria-label="Record a payment" onSubmit={e => { e.preventDefault(); if (payAmount) p.onRecord(pay, payAmount); }}>
            <label className="block text-sm">Book (financial entity id)<Input value={pay.financialEntityId} onChange={e => setPay({ ...pay, financialEntityId: e.target.value })} /></label>
            <label className="block text-sm">Customer account<Input value={pay.accountRef} onChange={e => setPay({ ...pay, accountRef: e.target.value })} /></label>
            <label className="block text-sm">Received on<Input type="date" value={pay.receivedAt} onChange={e => setPay({ ...pay, receivedAt: e.target.value })} /></label>
            <label className="block text-sm">Amount<Input value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} placeholder="1017.50" /></label>
            <label className="block text-sm">Method
              <select className="block w-full rounded border p-1" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value as PaymentDraft["method"] })}>
                {["eft", "cheque", "wire", "card", "cash", "other"].map(m => <option key={m} value={m}>{m === "card" ? "Card (reference only)" : human(m)}</option>)}
              </select>
            </label>
            <label className="block text-sm">Reference {pay.method === "card" ? "(authorization number — never the card number)" : ""}<Input value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} /></label>
            <label className="block text-sm">Payer<Input value={pay.payerName} onChange={e => setPay({ ...pay, payerName: e.target.value })} /></label>
            <label className="block text-sm">Import key (optional; the same key is the same payment)<Input value={pay.idempotencyKey} onChange={e => setPay({ ...pay, idempotencyKey: e.target.value })} /></label>
            <Button type="submit" disabled={p.busy || !payAmount || !pay.accountRef || !pay.financialEntityId || !pay.receivedAt}>Record payment</Button>
          </form>
        </Section>}
        {p.can.apply && <Section title="Apply a payment to an invoice" id="apply">
          <form className="space-y-2" aria-label="Apply a payment" onSubmit={e => { e.preventDefault(); if (applyAmount) p.onAllocate(apply.paymentRef.trim(), apply.invoiceNumber.trim(), applyAmount); }}>
            <label className="block text-sm">Payment<Input value={apply.paymentRef} onChange={e => setApply({ ...apply, paymentRef: e.target.value })} placeholder="PAY-…" /></label>
            <label className="block text-sm">Invoice<Input value={apply.invoiceNumber} onChange={e => setApply({ ...apply, invoiceNumber: e.target.value })} placeholder="INV-…" /></label>
            <label className="block text-sm">Amount<Input value={apply.amount} onChange={e => setApply({ ...apply, amount: e.target.value })} /></label>
            <Button type="submit" disabled={p.busy || !applyAmount || !apply.paymentRef || !apply.invoiceNumber}>Apply</Button>
            <p className="text-xs text-muted-foreground">Never more than the payment's unapplied amount or the invoice's outstanding balance; an overpayment stays unapplied.</p>
          </form>
        </Section>}
      </div>

      <Section title="Customer balance" id="balance">
        <form className="flex items-end gap-2" role="search" aria-label="Customer balance" onSubmit={e => { e.preventDefault(); if (lookup.trim()) p.onBalance(lookup.trim()); }}>
          <label className="text-sm">Customer account<Input value={lookup} onChange={e => setLookup(e.target.value)} /></label>
          <Button type="submit" variant="outline">Show balance</Button>
        </form>
        {p.balance && <StateBlock state={p.balance} what="the customer's balance" />}
        {p.balance?.kind === "loaded" && (() => {
          const b = p.balance.data, cur = b.account.currency;
          return (
            <><dl className="mt-2 space-y-1">
              <Field label="Customer" value={`${b.account.name} (${human(b.account.status)}, ${b.account.paymentTermsDays} days)`} />
              <Field label="Outstanding" value={cents(b.outstandingCents, cur)} /><Field label="Overdue" value={cents(b.overdueCents, cur)} /><Field label="Unapplied cash" value={cents(b.unappliedCents, cur)} />
              <Field label="Net owing" value={<strong>{cents(b.netOwingCents, cur)}</strong>} /><Field label="Open disputes" value={b.disputes.length ? b.disputes.map(x => `${x.caseNumber} (${x.invoiceNumber ?? "—"})`).join(", ") : "none"} />
              <Field label="Recent payments" value={b.recentPayments.length ? b.recentPayments.map(x => `${x.paymentRef} ${cents(x.amountCents, x.currency)} ${day(x.receivedAt)}`).join("; ") : "none"} />
            </dl>
            {b.account.status === "on_hold" && <Alert tone="note">This customer is on credit hold. Work already done is still billed; the hold governs new work, and an emergency dispatch is not blocked by it.</Alert>}</>
          );
        })()}
      </Section>
    </div>
  );
}
