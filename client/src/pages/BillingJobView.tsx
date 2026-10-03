/**
 * v23.32 — one job's billing, pure: readiness (blockers stop billing, warnings do not), the frozen commercial basis,
 * every charge with its provenance (evidence → snapshot → sheet version → rate line → inputs → amount), the review,
 * the hold, overrides and the invoice draft. Rate-backed: the server refuses this read to field roles.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Alert, cents, day, Field, HistoryList, human, millis, type PageState, Section, StateBlock, StatusBadge } from "../commercial/shared";

export type ChargeRow = {
  chargeRef: string; status: string; sourceKind: string; sourceRef: string | null; serviceCode: string | null; lineKind: string | null; description: string; quantityMillis: number; unit: string; measurementSource: string | null;
  definitionRef: string | null; definitionVersion: number | null; scopeLevel: string | null; pricingMethod: string | null; rateMillis: number | null; billableQuantityMillis: number | null; pricedAmountCents: number | null; amountCents: number | null; currency: string;
  pricingOutcome: string; formula: string | null; reasons: string[]; holdReason: string | null; billedQuantityMillis: number; billedAmountCents: number; remainingQuantityMillis: number; remainingAmountCents: number;
  overrideStatus: string; overrideAmountCents: number | null; overrideReason: string | null; commercialSnapshotRef: string | null; rateSheetVersionRef: string | null; contractRef: string | null;
};
export type Issue = { code: string; severity: string; message: string; subject?: string | null };
export type Workspace = {
  job: { id: number; jobCode: string; status: string; customer: string; location: string };
  workspace: { workspaceRef: string; state: string; rowVersion: number; holdActive: boolean; holdReason: string | null; reviewSubmittedByUserId: number | null; reviewSubmittedAt: Date | string | null; reviewDecidedByUserId: number | null; reviewNote: string | null } | null;
  readiness: { ready: boolean; blockers: Issue[]; warnings: Issue[]; suggestedState: string; billableCents: number; remainingCents: number };
  commercial: { snapshotRef: string; customer: string; billTo: string; contract: string | null; rateSheetVersion: string | null; currency: string; paymentTermsDays: number; purchaseOrder: string | null } | null;
  charges: ChargeRow[]; invoices: { invoiceNumber: string; status: string; totalCents: number; currency: string; createdAt: Date | string }[];
  history: { id: number; eventType: string; fromStatus: string | null; toStatus: string | null; reason: string | null; actorUserId: number; actorRole: string; occurredAt: Date | string; changesJson?: string | null }[];
};
export type BillingJobViewProps = {
  offline: boolean; workspace: PageState<Workspace>; busy: boolean;
  can: { prepare: boolean; review: boolean; approve: boolean; override: boolean; approveOverride: boolean; hold: boolean; draft: boolean };
  onPrepare: () => void; onRecalculate: (reason: string) => void; onSubmitReview: (note: string) => void; onDecideReview: (decision: "approve" | "return", note: string) => void;
  onHold: (active: boolean, reason: string) => void; onOverrideRequest: (chargeRef: string, amountCents: number, quantityMillis: number | null, reason: string) => void; onOverrideDecide: (chargeRef: string, decision: "approve" | "refuse", note: string) => void;
  onManualDecide: (chargeRef: string, decision: "approve" | "refuse", note: string) => void; onDraft: (slices: { chargeRef: string; quantityMillis: number }[] | null) => void; onOpenInvoice: (invoiceNumber: string) => void;
};

/** dollars typed by a person → integer cents, or null; never a float stored */
const toCents = (s: string) => { const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(s); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : null; };
const toMillis = (s: string) => { const m = /^\s*(\d+)(?:\.(\d{1,3}))?\s*$/.exec(s); return m ? Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0") || 0) : null; };

export function BillingJobView(p: BillingJobViewProps) {
  const [note, setNote] = useState("");
  const [override, setOverride] = useState<{ chargeRef: string; amount: string; quantity: string } | null>(null);
  const [slices, setSlices] = useState<Record<string, string>>({});
  const noteOk = note.trim().length >= 5;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="billing-job">
      {p.offline && <StateBlock state={{ kind: "offline" }} what="the job's billing" />}
      <StateBlock state={p.workspace} what="the job's billing" />
      {p.workspace.kind === "loaded" && (() => {
        const w = p.workspace.data;
        const state = w.workspace?.state ?? w.readiness.suggestedState;
        const cur = w.commercial?.currency ?? "CAD";
        const sliceList = Object.entries(slices).map(([chargeRef, v]) => ({ chargeRef, quantityMillis: toMillis(v) })).filter((x): x is { chargeRef: string; quantityMillis: number } => x.quantityMillis != null && x.quantityMillis > 0);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold">Billing · {w.job.jobCode}</h1>
                <div className="text-sm text-muted-foreground">{w.commercial?.billTo ?? w.job.customer} · {w.job.location} · job {human(w.job.status)}</div>
              </div>
              <div className="flex gap-1"><StatusBadge status={state} />{w.workspace?.holdActive && <StatusBadge status="on_hold" />}</div>
            </div>

            <Section title={w.readiness.ready ? "Ready to bill" : "What stops billing"} id="readiness">
              {w.readiness.blockers.length === 0 ? <p className="text-sm">No blocker. {cents(w.readiness.remainingCents, cur)} remains to invoice of {cents(w.readiness.billableCents, cur)} ready.</p> : (
                <ul className="space-y-1 text-sm" aria-label="Blockers">{w.readiness.blockers.map(b => <li key={b.code + (b.subject ?? "")} className="rounded border border-red-300 p-2"><StatusBadge status="blocking" /> <span className="font-mono text-xs">{b.code}</span> — {b.message}</li>)}</ul>
              )}
              {w.readiness.warnings.length > 0 && <ul className="mt-2 space-y-1 text-sm" aria-label="Warnings">{w.readiness.warnings.map(b => <li key={b.code + (b.subject ?? "")} className="rounded border border-amber-300 p-2"><StatusBadge status="review" /> <span className="font-mono text-xs">{b.code}</span> — {b.message}</li>)}</ul>}
              {w.workspace?.holdActive && <Alert tone="note">On hold: {w.workspace.holdReason}</Alert>}
            </Section>

            <Section title="Commercial basis (frozen)" id="basis">
              {w.commercial ? <dl className="space-y-1">
                <Field label="Snapshot" value={w.commercial.snapshotRef} /><Field label="Bill to" value={w.commercial.billTo} /><Field label="Contract" value={w.commercial.contract} />
                <Field label="Rate sheet version" value={w.commercial.rateSheetVersion ?? "none — company definitions only"} /><Field label="Terms" value={`${w.commercial.paymentTermsDays} days`} /><Field label="PO" value={w.commercial.purchaseOrder} />
              </dl> : <Alert tone="note">No commercial basis is frozen for this job. Billing never prices from live rates: assign the customer and capture the snapshot first.</Alert>}
            </Section>

            <Section title="Act on this job" id="actions">
              <label className="block text-sm">Reason or note (required for every decision)
                <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Why — kept on the audit history" />
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {p.can.prepare && <Button disabled={p.busy} onClick={p.onPrepare}>Prepare charges</Button>}
                {p.can.prepare && <Button variant="outline" disabled={p.busy || !noteOk} onClick={() => p.onRecalculate(note)}>Recalculate unbilled charges</Button>}
                {p.can.review && <Button variant="outline" disabled={p.busy || !w.readiness.ready} onClick={() => p.onSubmitReview(note)}>Submit for review</Button>}
                {p.can.approve && state === "under_review" && <><Button disabled={p.busy || !noteOk} onClick={() => p.onDecideReview("approve", note)}>Approve for invoicing</Button><Button variant="outline" disabled={p.busy || !noteOk} onClick={() => p.onDecideReview("return", note)}>Return</Button></>}
                {p.can.hold && <Button variant="outline" disabled={p.busy || !noteOk} onClick={() => p.onHold(!w.workspace?.holdActive, note)}>{w.workspace?.holdActive ? "Release billing hold" : "Place billing hold"}</Button>}
                {p.can.draft && state === "approved_for_invoicing" && <Button disabled={p.busy} onClick={() => p.onDraft(sliceList.length ? sliceList : null)}>{sliceList.length ? `Draft invoice for ${sliceList.length} slice(s)` : "Draft invoice for everything remaining"}</Button>}
              </div>
              {w.workspace?.reviewSubmittedByUserId != null && <p className="mt-2 text-xs text-muted-foreground">Submitted by user {w.workspace.reviewSubmittedByUserId}{w.workspace.reviewSubmittedAt ? ` on ${day(w.workspace.reviewSubmittedAt)}` : ""}. The submitter does not approve.</p>}
            </Section>

            <Section title={`Charges (${w.charges.length})`} id="charges">
              {w.charges.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="empty">No charge yet. Preparing turns accepted, signed ticket lines into charges priced from the frozen basis.</p> : (
                <table className="w-full text-sm" aria-label="Charges">
                  <thead><tr className="text-left"><th scope="col">Charge</th><th scope="col">Quantity</th><th scope="col">Rate</th><th scope="col">Amount</th><th scope="col">Invoiced</th><th scope="col">State</th></tr></thead>
                  <tbody>{w.charges.map(c => (
                    <tr key={c.chargeRef} className="border-t align-top">
                      <td>
                        <div>{c.description}</div>
                        <details className="text-xs"><summary className="cursor-pointer">Provenance</summary>
                          <div>{human(c.sourceKind)} {c.sourceRef ?? ""} → snapshot {c.commercialSnapshotRef ?? "—"} → sheet {c.rateSheetVersionRef ?? "—"} → line {c.definitionRef ?? "—"}{c.definitionVersion ? ` v${c.definitionVersion}` : ""} ({human(c.scopeLevel)})</div>
                          <div>{c.formula}</div>
                          <ul className="list-disc pl-4">{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        </details>
                      </td>
                      <td>{(c.quantityMillis / 1000).toFixed(3)} {c.unit}{c.billableQuantityMillis != null && c.billableQuantityMillis !== c.quantityMillis && <span className="block text-xs">billed {(c.billableQuantityMillis / 1000).toFixed(3)}</span>}</td>
                      <td>{c.rateMillis != null ? `${millis(c.rateMillis, c.currency)} / ${c.unit}` : "—"}</td>
                      <td>{cents(c.amountCents, c.currency)}{c.overrideStatus === "approved" && <span className="block text-xs">override of {cents(c.pricedAmountCents, c.currency)}</span>}</td>
                      <td>{(c.billedQuantityMillis / 1000).toFixed(3)} · {cents(c.billedAmountCents, c.currency)}
                        {state === "approved_for_invoicing" && c.status === "ready" && c.remainingQuantityMillis > 0 && <label className="mt-1 block text-xs">Slice to bill ({c.unit}, of {(c.remainingQuantityMillis / 1000).toFixed(3)})<Input value={slices[c.chargeRef] ?? ""} onChange={e => setSlices(s => ({ ...s, [c.chargeRef]: e.target.value }))} /></label>}
                      </td>
                      <td>
                        <StatusBadge status={c.status === "held" ? c.pricingOutcome : c.status} />
                        {c.overrideStatus === "pending" && <div className="text-xs">override to {cents(c.overrideAmountCents, c.currency)} pending: {c.overrideReason}</div>}
                        {p.can.approveOverride && c.overrideStatus === "pending" && <div className="mt-1 flex gap-1"><Button size="sm" disabled={p.busy || !noteOk} onClick={() => p.onOverrideDecide(c.chargeRef, "approve", note)}>Approve override</Button><Button size="sm" variant="outline" disabled={p.busy || !noteOk} onClick={() => p.onOverrideDecide(c.chargeRef, "refuse", note)}>Refuse</Button></div>}
                        {p.can.approveOverride && c.sourceKind === "manual" && c.status === "proposed" && <div className="mt-1 flex gap-1"><Button size="sm" disabled={p.busy || !noteOk} onClick={() => p.onManualDecide(c.chargeRef, "approve", note)}>Approve charge</Button><Button size="sm" variant="outline" disabled={p.busy || !noteOk} onClick={() => p.onManualDecide(c.chargeRef, "refuse", note)}>Refuse</Button></div>}
                        {p.can.override && (c.status === "ready" || c.status === "held") && c.overrideStatus !== "pending" && <Button size="sm" variant="outline" className="mt-1" onClick={() => setOverride({ chargeRef: c.chargeRef, amount: "", quantity: "" })}>Request override</Button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {override && (
                <form className="mt-2 flex flex-wrap items-end gap-2 rounded border p-2" aria-label="Override request" onSubmit={e => { e.preventDefault(); const a = toCents(override.amount); if (a != null && noteOk) { p.onOverrideRequest(override.chargeRef, a, override.quantity ? toMillis(override.quantity) : null, note); setOverride(null); } }}>
                  <span className="text-sm">Override {override.chargeRef}</span>
                  <label className="text-sm">New amount ({cur})<Input value={override.amount} onChange={e => setOverride({ ...override, amount: e.target.value })} placeholder="1017.50" /></label>
                  <label className="text-sm">New quantity (optional)<Input value={override.quantity} onChange={e => setOverride({ ...override, quantity: e.target.value })} /></label>
                  <Button type="submit" disabled={p.busy || !noteOk || toCents(override.amount) == null}>Request — a second person approves</Button>
                  <Button type="button" variant="outline" onClick={() => setOverride(null)}>Cancel</Button>
                </form>
              )}
            </Section>

            <Section title="Invoices for this job" id="invoices">
              {w.invoices.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="empty">Not invoiced yet.</p> : <ul className="space-y-1 text-sm">{w.invoices.map(i => <li key={i.invoiceNumber}><button className="underline" onClick={() => p.onOpenInvoice(i.invoiceNumber)}>{i.invoiceNumber}</button> · {cents(i.totalCents, i.currency)} · <StatusBadge status={i.status} /></li>)}</ul>}
            </Section>
            <Section title="History" id="history"><HistoryList rows={w.history} /></Section>
          </div>
        );
      })()}
    </div>
  );
}
