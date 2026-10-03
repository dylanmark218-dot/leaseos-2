/**
 * v23.32 — one invoice, pure: its header, customer lines (and, for the office, each line's internal provenance), the
 * receivable derived from its records, the workflow (draft → review → approved → issued), and the corrections that
 * are records rather than edits: allocation reversals, credit notes, adjustments, disputes and voids.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Alert, cents, day, Field, HistoryList, human, millis, type PageState, pct, Section, StateBlock, StatusBadge } from "../commercial/shared";

export type InvoiceDetail = {
  invoice: { invoiceNumber: string; origin: string; status: string; rowVersion: number; customer: string; currency: string; subtotalCents: number; taxCents: number; totalCents: number; taxCode: string | null; taxRateBps: number | null; taxJurisdiction: string | null; purchaseOrder: string | null; afeNumber: string | null; paymentTermsDays: number | null; issuedAt: Date | string | null; dueAt: Date | string | null; submittedByUserId: number | null; approvedByUserId: number | null; voidReason: string | null };
  receivable: { originalCents: number; paidCents: number; creditedCents: number; adjustedCents: number; outstandingCents: number; daysOverdue: number; arStatus: string; bucket: string | null };
  lines: { lineNo: number; description: string; quantityMillis: number; unit: string; rateMillis: number | null; amountCents: number; taxCode: string | null; taxRateBps: number | null; taxCents: number | null; released: boolean; provenance: Record<string, unknown> | null }[];
  jobs: { jobId: number; jobCode: string }[];
  allocations: { allocationRef: string | null; amountCents: number; allocatedAt: Date | string; paymentRef: string; method: string; reversed: boolean; reversesAllocationId: number | null; reason: string | null }[];
  credits: { creditRef: string; amountCents: number; status: string; reason: string; requestedByUserId: number }[];
  adjustments: { adjustmentRef: string; amountCents: number; status: string; reasonCode: string; reason: string; requestedByUserId: number }[];
  disputes: { caseNumber: string; status: string; disputedAmountCents: number | null; reasonStated: string | null; invoiceLineRef: string | null; raisedAt: Date | string }[];
  snapshot: { payloadHash: string; capturedAt: Date | string } | null;
  supportingDocuments: { fieldTickets: { ticketNumber: string; status: string; signatureStatus: string }[]; ticketDocuments: { documentRef: string; kind: string; contentHash: string }[]; disposalTickets: { ticketNumber: string; verificationStatus: string }[]; commercialSnapshots: { snapshotRef: string; payloadHash: string }[] };
  history: { id: number; eventType: string; fromStatus: string | null; toStatus: string | null; reason: string | null; actorUserId: number; actorRole: string; occurredAt: Date | string; changesJson?: string | null }[];
  export: { status: string; externalId: string | null; lastError: string | null; attempts: number } | null;
};
export type InvoiceAction =
  | { kind: "submit" } | { kind: "return"; reason: string } | { kind: "approve" } | { kind: "issue" } | { kind: "void"; reason: string } | { kind: "recalculate" }
  | { kind: "reverse"; allocationRef: string; reason: string } | { kind: "credit"; amountCents: number; reason: string } | { kind: "creditDecide"; creditRef: string; decision: "approved" | "refused"; note: string }
  | { kind: "adjust"; amountCents: number; reasonCode: "late_fee" | "rounding" | "fx" | "correction" | "other"; reason: string } | { kind: "adjustDecide"; adjustmentRef: string; decision: "approved" | "refused"; note: string }
  | { kind: "dispute"; lineNo: number | null; amountCents: number | null; reason: string } | { kind: "resolve"; caseNumber: string; outcome: "upheld" | "credited" | "partial" | "withdrawn"; creditAmountCents: number | null; narrative: string };
export type InvoiceViewProps = { offline: boolean; invoice: PageState<InvoiceDetail>; busy: boolean; onAction: (a: InvoiceAction) => void; onOpenJob: (jobId: number) => void };

const toCents = (s: string) => { const m = /^\s*(-?)(\d+)(?:\.(\d{1,2}))?\s*$/.exec(s); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || 0)) : null; };

export function InvoiceView(p: InvoiceViewProps) {
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [lineNo, setLineNo] = useState("");
  const ok = reason.trim().length >= 5;
  const amt = toCents(amount);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="invoice">
      {p.offline && <StateBlock state={{ kind: "offline" }} what="the invoice" />}
      <StateBlock state={p.invoice} what="the invoice" />
      {p.invoice.kind === "loaded" && (() => {
        const d = p.invoice.data, i = d.invoice, r = d.receivable, cur = i.currency;
        const billing = i.origin === "billing_charges";
        const act = (a: InvoiceAction) => p.onAction(a);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold">Invoice {i.invoiceNumber}</h1>
                <div className="text-sm text-muted-foreground">{i.customer} · {d.jobs.map((j, k) => <span key={j.jobId}>{k ? ", " : ""}<button className="underline" onClick={() => p.onOpenJob(j.jobId)}>{j.jobCode}</button></span>)} · {human(i.origin)}</div>
              </div>
              <div className="flex gap-1"><StatusBadge status={i.status} />{r.arStatus === "overdue" && <StatusBadge status="overdue" />}</div>
            </div>
            {i.status === "void" && <Alert tone="note">Void: {i.voidReason}. The record and its number are kept; the number is never reused.</Alert>}

            <div className="grid gap-3 md:grid-cols-2">
              <Section title="Totals" id="totals"><dl className="space-y-1">
                <Field label="Subtotal" value={cents(i.subtotalCents, cur)} />
                <Field label={`Tax (${i.taxCode ?? "—"}${i.taxRateBps != null ? ` ${pct(i.taxRateBps)}` : ""})`} value={cents(i.taxCents, cur)} />
                <Field label="Total" value={cents(i.totalCents, cur)} />
                <Field label="PO / AFE" value={[i.purchaseOrder, i.afeNumber].filter(Boolean).join(" / ") || "—"} />
                <Field label="Issued / due" value={`${day(i.issuedAt)} / ${day(i.dueAt)}`} />
              </dl>{i.taxCode === "UNDETERMINED" && <Alert tone="note">Tax is undetermined: the customer's tax status or the GST/HST rate is not verified. It is not approved until it is — recalculate once it is.</Alert>}</Section>
              <Section title="Receivable" id="receivable"><dl className="space-y-1">
                <Field label="Original" value={cents(r.originalCents, cur)} /><Field label="Paid" value={cents(r.paidCents, cur)} /><Field label="Credited" value={cents(r.creditedCents, cur)} />
                <Field label="Adjusted" value={cents(r.adjustedCents, cur)} /><Field label="Outstanding" value={<strong>{cents(r.outstandingCents, cur)}</strong>} />
                <Field label="Status" value={<StatusBadge status={r.arStatus} />} /><Field label="Aging" value={r.bucket ? human(r.bucket) : "—"} />
              </dl></Section>
            </div>

            <Section title="Act on this invoice" id="act">
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">Reason or note<Input value={reason} onChange={e => setReason(e.target.value)} /></label>
                <label className="text-sm">Amount ({cur})<Input value={amount} onChange={e => setAmount(e.target.value)} placeholder="92.50" /></label>
                <label className="text-sm">Line (for a line dispute)<Input value={lineNo} onChange={e => setLineNo(e.target.value)} /></label>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {billing && i.status === "draft" && <><Button disabled={p.busy} onClick={() => act({ kind: "submit" })}>Submit for approval</Button><Button variant="outline" disabled={p.busy} onClick={() => act({ kind: "recalculate" })}>Recalculate tax</Button></>}
                {billing && i.status === "in_review" && <><Button disabled={p.busy} onClick={() => act({ kind: "approve" })}>Approve (not your own)</Button><Button variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "return", reason })}>Return to draft</Button></>}
                {billing && i.status === "approved" && <Button disabled={p.busy} onClick={() => act({ kind: "issue" })}>Issue to the customer</Button>}
                {billing && ["draft", "in_review", "approved", "sent", "viewed", "disputed"].includes(i.status) && <Button variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "void", reason })}>Void</Button>}
                {r.bucket && <>
                  <Button variant="outline" disabled={p.busy || !ok || amt == null || amt <= 0} onClick={() => act({ kind: "credit", amountCents: amt!, reason })}>Request credit note</Button>
                  <Button variant="outline" disabled={p.busy || !ok || amt == null || amt === 0} onClick={() => act({ kind: "adjust", amountCents: amt!, reasonCode: amt! > 0 ? "late_fee" : "correction", reason })}>Request adjustment</Button>
                  <Button variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "dispute", lineNo: lineNo ? Number(lineNo) : null, amountCents: amt != null && amt > 0 ? amt : null, reason })}>Record dispute</Button>
                </>}
              </div>
              {!billing && <p className="mt-2 text-xs text-muted-foreground">Drafted from a field ticket before billing charges existed: finalized, rendered and sent on the field-ticket path; receivables apply to it the same way.</p>}
            </Section>

            <Section title={`Lines (${d.lines.length})`} id="lines">
              <table className="w-full text-sm" aria-label="Invoice lines">
                <thead><tr className="text-left"><th scope="col">#</th><th scope="col">Description</th><th scope="col">Quantity</th><th scope="col">Rate</th><th scope="col">Amount</th><th scope="col">Tax</th></tr></thead>
                <tbody>{d.lines.map(l => (
                  <tr key={l.lineNo} className={`border-t align-top ${l.released ? "opacity-60" : ""}`}>
                    <td>{l.lineNo}</td>
                    <td>{l.description}{l.released && <span className="ml-1 text-xs">(released by void)</span>}{l.provenance && <details className="text-xs"><summary className="cursor-pointer">Provenance (internal)</summary><pre className="whitespace-pre-wrap">{JSON.stringify(l.provenance, null, 1)}</pre></details>}</td>
                    <td>{(l.quantityMillis / 1000).toFixed(3)} {l.unit}</td><td>{l.rateMillis != null ? millis(l.rateMillis, cur) : "—"}</td><td>{cents(l.amountCents, cur)}</td><td>{l.taxCode ?? "—"} {cents(l.taxCents, cur)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </Section>

            <Section title="Payments applied" id="payments">
              {d.allocations.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="empty">No payment is applied.</p> : <ul className="space-y-1 text-sm">{d.allocations.map(a => (
                <li key={a.allocationRef ?? `${a.paymentRef}${a.allocatedAt}`} className="flex flex-wrap items-center gap-2">{a.paymentRef} ({human(a.method)}) · {cents(a.amountCents, cur)} · {day(a.allocatedAt)}{a.reversesAllocationId != null && <span className="text-xs">reversal: {a.reason}</span>}{a.reversed && <StatusBadge status="reversed" />}
                  {a.allocationRef && a.amountCents > 0 && !a.reversed && <Button size="sm" variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "reverse", allocationRef: a.allocationRef!, reason })}>Reverse</Button>}
                </li>))}</ul>}
            </Section>
            <Section title="Credit notes, adjustments and disputes" id="corrections">
              <ul className="space-y-1 text-sm">
                {d.credits.map(c => <li key={c.creditRef} className="flex flex-wrap items-center gap-2">Credit {c.creditRef} · {cents(c.amountCents, cur)} · <StatusBadge status={c.status} /> · {c.reason}{c.status === "requested" && <><Button size="sm" disabled={p.busy || !ok} onClick={() => act({ kind: "creditDecide", creditRef: c.creditRef, decision: "approved", note: reason })}>Approve</Button><Button size="sm" variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "creditDecide", creditRef: c.creditRef, decision: "refused", note: reason })}>Refuse</Button></>}</li>)}
                {d.adjustments.map(a => <li key={a.adjustmentRef} className="flex flex-wrap items-center gap-2">Adjustment {a.adjustmentRef} · {cents(a.amountCents, cur)} ({human(a.reasonCode)}) · <StatusBadge status={a.status} />{a.status === "requested" && <><Button size="sm" disabled={p.busy || !ok} onClick={() => act({ kind: "adjustDecide", adjustmentRef: a.adjustmentRef, decision: "approved", note: reason })}>Approve</Button><Button size="sm" variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "adjustDecide", adjustmentRef: a.adjustmentRef, decision: "refused", note: reason })}>Refuse</Button></>}</li>)}
                {d.disputes.map(x => <li key={x.caseNumber} className="flex flex-wrap items-center gap-2">Dispute {x.caseNumber}{x.invoiceLineRef ? ` (${x.invoiceLineRef})` : ""} · {cents(x.disputedAmountCents, cur)} · <StatusBadge status={x.status} /> · {x.reasonStated}
                  {["raised", "investigating", "evidence_gathered", "escalated"].includes(x.status) && <><Button size="sm" disabled={p.busy || !ok} onClick={() => act({ kind: "resolve", caseNumber: x.caseNumber, outcome: "upheld", creditAmountCents: null, narrative: reason })}>Uphold</Button><Button size="sm" variant="outline" disabled={p.busy || !ok || amt == null || amt <= 0} onClick={() => act({ kind: "resolve", caseNumber: x.caseNumber, outcome: amt === x.disputedAmountCents ? "credited" : "partial", creditAmountCents: amt, narrative: reason })}>Credit the amount</Button><Button size="sm" variant="outline" disabled={p.busy || !ok} onClick={() => act({ kind: "resolve", caseNumber: x.caseNumber, outcome: "withdrawn", creditAmountCents: null, narrative: reason })}>Withdrawn</Button></>}
                </li>)}
                {!d.credits.length && !d.adjustments.length && !d.disputes.length && <li className="text-muted-foreground" data-testid="empty">None.</li>}
              </ul>
            </Section>
            <Section title="Supporting documents (by reference)" id="documents">
              <ul className="space-y-1 text-sm">
                {d.supportingDocuments.fieldTickets.map(t => <li key={t.ticketNumber}>Field ticket {t.ticketNumber} · {human(t.status)} · signature {human(t.signatureStatus)}</li>)}
                {d.supportingDocuments.ticketDocuments.map(t => <li key={t.documentRef}>{human(t.kind)} {t.documentRef} · sha256 {t.contentHash.slice(0, 12)}…</li>)}
                {d.supportingDocuments.disposalTickets.map(t => <li key={t.ticketNumber}>Disposal ticket {t.ticketNumber} · {human(t.verificationStatus)}</li>)}
                {d.supportingDocuments.commercialSnapshots.map(s => <li key={s.snapshotRef}>Commercial snapshot {s.snapshotRef} · {s.payloadHash.slice(0, 12)}…</li>)}
                {d.snapshot && <li>Billing snapshot frozen {day(d.snapshot.capturedAt)} · {d.snapshot.payloadHash.slice(0, 12)}…</li>}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">Accounting export: {d.export ? `${human(d.export.status)}${d.export.externalId ? ` as ${d.export.externalId}` : ""}${d.export.lastError ? ` — ${d.export.lastError}` : ""}` : "not queued"}</p>
            </Section>
            <Section title="History" id="history"><HistoryList rows={d.history} /></Section>
          </div>
        );
      })()}
    </div>
  );
}
