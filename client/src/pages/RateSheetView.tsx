/**
 * v23.31 — one rate sheet, pure: the current version and every other, each version's lines with
 * their conditions, the approvals, the contract it sits under and the jobs that froze it.
 * Prices appear only when the server said the caller may see them (`confidential`).
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { RATE_LINE_KINDS } from "@shared/commercialVocabulary";
import { Alert, cents, day, Field, HistoryList, human, millis, type PageState, pct, Section, StateBlock, StatusBadge } from "../commercial/shared";
import type { DocumentRow, HistoryRow } from "./CustomersView";

export type RateLineRow = {
  definitionRef: string; lineNo: number | null; serviceCode: string; lineKind: string | null; label: string | null; pricingMethod: string; unit: string; measurementBasis: string; conditionKey: string | null; applicability: { kind: string; op: string; value: unknown }[];
  approvalStatus: string; version: number; sourceClause: string | null; effectiveFrom: Date | string; effectiveTo: Date | string | null;
  rateMillis?: number | null; flatCents?: number | null; basisPoints?: number | null; multiplierMillis?: number | null; minimumQuantityMillis?: number | null; minimumChargeCents?: number | null; billingIncrementMillis?: number | null; roundingMode?: string; currency?: string;
};
export type RateSheetVersionRow = { versionRef: string; version: number; status: string; effectiveFrom: Date | string; effectiveTo: Date | string | null; contentHash: string | null; notes: string | null; submittedByUserId: number | null; approvedByUserId: number | null; approvedAt: Date | string | null; rejectionReason: string | null; usedOperationallyAt: Date | string | null; rowVersion: number; lines: RateLineRow[]; jobs: { snapshotRef: string; jobId: number; status: string; capturedAt: Date | string; job: { jobCode: string } | null }[] };
export type RateSheetDetail = {
  rateSheetRef: string; name: string; sheetNumber: string | null; currency: string; status: string; notes: string | null; confidential: boolean; currentVersion: string | null;
  customer: { accountRef: string; name: string; customerNumber: string | null }; contract: { contractRef: string; contractNumber: string; title: string; status: string } | null;
  versions: RateSheetVersionRow[]; documents: DocumentRow[]; history: HistoryRow[];
};
export type LineDraft = { serviceCode: string; lineKind: string; label: string; pricingMethod: "per_unit" | "flat" | "percentage_markup"; unit: string; amount: string; minimumQuantity: string; increment: string; shift: string; province: string };
export type RateSheetViewProps = {
  offline: boolean; sheet: PageState<RateSheetDetail>; selectedVersion: string | null; onSelectVersion: (ref: string) => void;
  canPropose: boolean; canApprove: boolean; busy: boolean;
  onVersionCreate: (rateSheetRef: string, effectiveFrom: string) => void; onLineAdd: (versionRef: string, draft: LineDraft) => void; onLineRemove: (definitionRef: string) => void;
  onSubmit: (versionRef: string, rowVersion: number) => void; onDecide: (versionRef: string, event: "approve" | "reject" | "retire", reason: string, rowVersion: number) => void;
  onOpenCustomer: (accountRef: string) => void; onOpenContract: (contractRef: string) => void; onOpenJob: (jobId: number) => void;
};

const priceText = (l: RateLineRow, currency: string) => {
  if (l.rateMillis === undefined && l.flatCents === undefined && l.basisPoints === undefined) return "withheld";
  if (l.pricingMethod === "per_unit" || l.pricingMethod === "minimum_charge") return `${millis(l.rateMillis, currency)} / ${l.unit}`;
  if (l.pricingMethod === "flat" || l.pricingMethod === "fixed_markup") return cents(l.flatCents, currency);
  if (l.pricingMethod === "percentage_markup") return `+${pct(l.basisPoints)}`;
  if (l.pricingMethod === "multiplier") return `× ${((l.multiplierMillis ?? 1000) / 1000).toFixed(3)}`;
  return "formula (recorded, not evaluated)";
};

export function RateSheetView(p: RateSheetViewProps) {
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<LineDraft>({ serviceCode: "", lineKind: "hourly_equipment", label: "", pricingMethod: "per_unit", unit: "hour", amount: "", minimumQuantity: "", increment: "", shift: "", province: "" });
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="rate-sheet">
      {p.offline && <StateBlock state={{ kind: "offline" }} what="the rate sheet" />}
      <StateBlock state={p.sheet} what="the rate sheet" />
      {p.sheet.kind === "loaded" && (() => {
        const s = p.sheet.data;
        const v = s.versions.find(x => x.versionRef === (p.selectedVersion ?? s.currentVersion)) ?? s.versions[0] ?? null;
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold">{s.sheetNumber ?? s.rateSheetRef} · {s.name}</h1>
                <div className="text-sm text-muted-foreground"><button className="underline" onClick={() => p.onOpenCustomer(s.customer.accountRef)}>{s.customer.name}</button>{s.contract ? <> · under <button className="underline" onClick={() => p.onOpenContract(s.contract!.contractRef)}>{s.contract.contractNumber}</button> (prices at the contract level)</> : " · the customer's own sheet (prices at the customer level)"} · {s.currency}</div>
              </div>
              <StatusBadge status={s.status} />
            </div>
            {!s.confidential && <Alert tone="note"><span data-testid="prices-withheld">Prices are withheld: this account does not hold the rates permission. Lines, conditions and approvals are shown.</span></Alert>}
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
              <Section title="Versions" id="versions">
                {!s.versions.length && <p className="text-sm text-muted-foreground" data-testid="empty">No version yet.</p>}
                <ul className="space-y-1" aria-label="Version history">
                  {s.versions.map(x => <li key={x.versionRef}><button className={`w-full rounded border p-2 text-left text-sm ${v?.versionRef === x.versionRef ? "border-slate-900" : ""}`} aria-current={v?.versionRef === x.versionRef ? "true" : undefined} onClick={() => p.onSelectVersion(x.versionRef)}><div className="flex items-center justify-between gap-2"><span className="font-medium">v{x.version}{s.currentVersion === x.versionRef ? " (current)" : ""}</span><StatusBadge status={x.status} /></div><div className="text-xs text-muted-foreground">{day(x.effectiveFrom)} → {x.effectiveTo ? day(x.effectiveTo) : "open"} · {x.lines.length} line{x.lines.length === 1 ? "" : "s"}</div></button></li>)}
                </ul>
                {p.canPropose && s.status === "active" && (
                  <form className="mt-3 grid gap-2" onSubmit={e => { e.preventDefault(); p.onVersionCreate(s.rateSheetRef, effectiveFrom); }}>
                    <label className="text-xs">New version effective from<Input aria-label="New version effective from" type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></label>
                    <Button type="submit" size="sm" variant="outline" disabled={p.busy || p.offline || !effectiveFrom}>Draft a new version</Button>
                    <p className="text-xs text-muted-foreground">Lines are copied from the current version; edit what changed.</p>
                  </form>
                )}
              </Section>
              <div className="space-y-3">
                {v && (
                  <>
                    <Section title={`Version ${v.version} — ${human(v.status)}`} id="version">
                      <dl className="space-y-1"><Field label="Effective" value={`${day(v.effectiveFrom)} → ${v.effectiveTo ? day(v.effectiveTo) : "open"}`} /><Field label="Content hash" value={v.contentHash ? <code className="text-xs">{v.contentHash.slice(0, 16)}…</code> : "not yet approved"} /><Field label="Approved" value={v.approvedAt ? `${day(v.approvedAt)} by user ${v.approvedByUserId}` : "—"} /><Field label="Rejected" value={v.rejectionReason} /><Field label="Used by a job since" value={day(v.usedOperationallyAt)} /></dl>
                      {v.usedOperationallyAt && <Alert tone="note"><span data-testid="frozen">A job froze this version: its lines are history. A correction is a new version.</span></Alert>}
                    </Section>
                    <Section title="Rate lines" id="lines">
                      {!v.lines.length && <p className="text-sm text-muted-foreground" data-testid="empty">No lines on this version.</p>}
                      {v.lines.length > 0 && (
                        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th scope="col">#</th><th scope="col">Service</th><th scope="col">Kind</th><th scope="col">Price</th><th scope="col">Conditions</th><th scope="col">Status</th>{p.canPropose && v.status === "draft" && <th scope="col"><span className="sr-only">Remove</span></th>}</tr></thead>
                          <tbody>{v.lines.map(l => (
                            <tr key={l.definitionRef} className="border-t align-top">
                              <td className="pr-2">{l.lineNo ?? "—"}</td>
                              <td className="pr-2"><div className="font-medium">{l.label ?? l.serviceCode}</div><div className="text-xs text-muted-foreground">{l.serviceCode}{l.sourceClause ? ` · ${l.sourceClause}` : ""}</div></td>
                              <td className="pr-2">{human(l.lineKind)}</td>
                              <td className="pr-2"><div>{priceText(l, s.currency)}</div>{s.confidential && (l.minimumQuantityMillis || l.billingIncrementMillis || l.minimumChargeCents) ? <div className="text-xs text-muted-foreground">{[l.minimumQuantityMillis ? `min ${l.minimumQuantityMillis / 1000} ${l.unit}` : null, l.billingIncrementMillis ? `increment ${l.billingIncrementMillis / 1000} ${l.unit} (${l.roundingMode})` : null, l.minimumChargeCents ? `min charge ${cents(l.minimumChargeCents, s.currency)}` : null].filter(Boolean).join(" · ")}</div> : null}</td>
                              <td className="pr-2 text-xs">{l.applicability.length ? l.applicability.map((c, i) => <div key={i}>{c.kind} {c.op} {Array.isArray(c.value) ? c.value.join(", ") : String(c.value)}</div>) : l.conditionKey ? <div>{l.conditionKey}</div> : <span className="text-muted-foreground">always</span>}{l.measurementBasis !== "any" && <div>measured by {l.measurementBasis}</div>}</td>
                              <td className="pr-2"><StatusBadge status={l.approvalStatus} /></td>
                              {p.canPropose && v.status === "draft" && <td><Button size="sm" variant="ghost" disabled={p.busy || p.offline} onClick={() => p.onLineRemove(l.definitionRef)} aria-label={`Remove line ${l.serviceCode}`}>Remove</Button></td>}
                            </tr>
                          ))}</tbody>
                        </table>
                      )}
                      {p.canPropose && v.status === "draft" && (
                        <form className="mt-3 grid gap-2 md:grid-cols-3" onSubmit={e => { e.preventDefault(); p.onLineAdd(v.versionRef, draft); }}>
                          <Input aria-label="Service code" placeholder="service code (e.g. hydrovac_hour)" value={draft.serviceCode} onChange={e => setDraft({ ...draft, serviceCode: e.target.value })} />
                          <select aria-label="Line kind" className="rounded border bg-background px-2 py-1 text-sm" value={draft.lineKind} onChange={e => setDraft({ ...draft, lineKind: e.target.value })}>{RATE_LINE_KINDS.map(k => <option key={k} value={k}>{human(k)}</option>)}</select>
                          <Input aria-label="Line label" placeholder="label" value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} />
                          <select aria-label="Pricing method" className="rounded border bg-background px-2 py-1 text-sm" value={draft.pricingMethod} onChange={e => setDraft({ ...draft, pricingMethod: e.target.value as LineDraft["pricingMethod"] })}><option value="per_unit">Per unit</option><option value="flat">Flat</option><option value="percentage_markup">Percentage</option></select>
                          <Input aria-label="Unit" placeholder="unit (hour, km, load, m3, each, none)" value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value })} />
                          <Input aria-label="Amount in dollars, or percent" placeholder={draft.pricingMethod === "percentage_markup" ? "percent, e.g. 8.5" : "dollars, e.g. 185.00"} value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} />
                          <Input aria-label="Minimum quantity" placeholder="minimum quantity (optional)" value={draft.minimumQuantity} onChange={e => setDraft({ ...draft, minimumQuantity: e.target.value })} />
                          <Input aria-label="Billing increment" placeholder="billing increment (optional, e.g. 0.25)" value={draft.increment} onChange={e => setDraft({ ...draft, increment: e.target.value })} />
                          <select aria-label="Shift condition" className="rounded border bg-background px-2 py-1 text-sm" value={draft.shift} onChange={e => setDraft({ ...draft, shift: e.target.value })}><option value="">any shift</option><option value="day">day</option><option value="night">night</option><option value="after_hours">after hours</option><option value="weekend">weekend</option><option value="statutory_holiday">statutory holiday</option></select>
                          <Input aria-label="Province condition" placeholder="province condition (optional)" value={draft.province} onChange={e => setDraft({ ...draft, province: e.target.value })} />
                          <Button type="submit" size="sm" disabled={p.busy || p.offline || !draft.serviceCode.trim() || !draft.amount.trim()}>Add line</Button>
                          <p className="text-xs text-muted-foreground md:col-span-3">Money is stored in cents and rates in thousandths; the server refuses a float. A line prices nothing until the version is approved by a second person.</p>
                        </form>
                      )}
                    </Section>
                    <Section title="Jobs frozen on this version" id="jobs">{v.jobs.length ? <ul className="space-y-1 text-sm">{v.jobs.map(j => <li key={j.snapshotRef}><button className="underline" onClick={() => p.onOpenJob(j.jobId)}>{j.job?.jobCode ?? `job ${j.jobId}`}</button> · {human(j.status)} · {day(j.capturedAt)}</li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">None yet.</p>}</Section>
                    {(p.canPropose || p.canApprove) && (
                      <Section title="Approval" id="approval">
                        <div className="grid gap-2">
                          <Input aria-label="Reason" placeholder="reason (for a rejection or retirement)" value={reason} onChange={e => setReason(e.target.value)} />
                          <div className="flex flex-wrap gap-2">
                            {p.canPropose && v.status === "draft" && <Button size="sm" disabled={p.busy || p.offline || !v.lines.length} onClick={() => p.onSubmit(v.versionRef, v.rowVersion)}>Submit for approval</Button>}
                            {p.canApprove && v.status === "pending_approval" && <><Button size="sm" disabled={p.busy || p.offline} onClick={() => p.onDecide(v.versionRef, "approve", reason, v.rowVersion)}>Approve version</Button><Button size="sm" variant="outline" disabled={p.busy || p.offline || reason.trim().length < 3} onClick={() => { p.onDecide(v.versionRef, "reject", reason, v.rowVersion); setReason(""); }}>Reject</Button></>}
                            {p.canApprove && v.status === "approved" && !v.usedOperationallyAt && <Button size="sm" variant="destructive" disabled={p.busy || p.offline || reason.trim().length < 3} onClick={() => { p.onDecide(v.versionRef, "retire", reason, v.rowVersion); setReason(""); }}>Retire version</Button>}
                          </div>
                          <p className="text-xs text-muted-foreground">Approving a version approves every line as one unit and closes the previous approved version where this one opens. The person who drafted or submitted it does not approve it.</p>
                        </div>
                      </Section>
                    )}
                  </>
                )}
              </div>
            </div>
            <Section title="Documents" id="documents">{s.documents.length ? <ul className="space-y-1 text-sm">{s.documents.map(dd => <li key={dd.documentRef}>{dd.title} · v{dd.version} <StatusBadge status={dd.status} /></li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">No registered document is linked (record type <code>rate_sheet</code>, reference <code>{s.rateSheetRef}</code>).</p>}</Section>
            <Section title="History" id="history"><HistoryList rows={s.history} /></Section>
          </div>
        );
      })()}
    </div>
  );
}
