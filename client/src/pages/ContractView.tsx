/**
 * v23.31 — one contract, pure: the customer, the status and its transitions, the dates and the
 * renewal state, the documents linked to it, the rate sheets under it, the jobs that froze it,
 * and the approval history from the ledger.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Alert, day, Field, HistoryList, human, type PageState, Section, StateBlock, StatusBadge } from "../commercial/shared";
import type { DocumentRow, HistoryRow } from "./CustomersView";

export type ContractDetail = {
  contractRef: string; contractNumber: string; title: string; contractType: string; status: string; version: number; effectiveFrom: Date | string; effectiveTo: Date | string | null; poRequirement: string; requiredReferenceKinds: string[]; customerReferences: Record<string, string>;
  paymentTermsDays: number | null; billingInstructions: string | null; notes: string | null; renewalKind: string; renewalNoticeDays: number | null; usedOperationallyAt: Date | string | null; rowVersion: number;
  submittedByUserId: number | null; submittedAt: Date | string | null; approvedByUserId: number | null; approvedAt: Date | string | null; approvalNote: string | null; suspensionReason: string | null; terminationReason: string | null;
  customer: { accountRef: string; name: string; customerNumber: string | null }; terms: { termsRef: string; version: number; title: string; status: string } | null;
  rateSheets: { rateSheetRef: string; name: string; sheetNumber: string | null; status: string }[]; documents: DocumentRow[];
  jobs: { snapshotRef: string; jobId: number; status: string; capturedAt: Date | string; job: { jobCode: string; status: string } | null }[];
  lineage: { contractRef: string; version: number; status: string; effectiveFrom: Date | string; effectiveTo: Date | string | null }[];
  history: HistoryRow[]; renewal: { state: string; daysRemaining: number | null; noticeDue: Date | string | null };
};
export type ContractViewProps = {
  offline: boolean; contract: PageState<ContractDetail>; canWrite: boolean; canApprove: boolean; canGovern: boolean; busy: boolean;
  onSubmit: (ref: string, rowVersion: number) => void; onDecide: (ref: string, decision: "approve" | "reject", note: string, rowVersion: number) => void;
  onStatus: (ref: string, event: "suspend" | "resume" | "terminate" | "expire", reason: string, rowVersion: number) => void; onSupersede: (ref: string, reason: string) => void;
  onOpenCustomer: (accountRef: string) => void; onOpenRateSheet: (rateSheetRef: string) => void; onOpenContract: (contractRef: string) => void; onOpenJob: (jobId: number) => void;
};

export function ContractView(p: ContractViewProps) {
  const [note, setNote] = useState("");
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4" data-testid="contract">
      {p.offline && <StateBlock state={{ kind: "offline" }} what="the contract" />}
      <StateBlock state={p.contract} what="the contract" />
      {p.contract.kind === "loaded" && (() => {
        const c = p.contract.data;
        const editable = c.status === "draft" || c.status === "pending_approval";
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold">{c.contractNumber} · {c.title}</h1>
                <div className="text-sm text-muted-foreground">{human(c.contractType)} · version {c.version} · <button className="underline" onClick={() => p.onOpenCustomer(c.customer.accountRef)}>{c.customer.name}{c.customer.customerNumber ? ` (${c.customer.customerNumber})` : ""}</button></div>
              </div>
              <StatusBadge status={c.status} />
            </div>
            {c.usedOperationallyAt && <Alert tone="note"><span data-testid="frozen">Used by a job since {day(c.usedOperationallyAt)}: this version is frozen. A change is a new version that supersedes it.</span></Alert>}
            {c.status === "suspended" && <Alert tone="failed">Suspended{c.suspensionReason ? `: ${c.suspensionReason}` : ""}. No job is worked under it until it is resumed.</Alert>}
            {c.status === "terminated" && <Alert tone="failed">Terminated{c.terminationReason ? `: ${c.terminationReason}` : ""}.</Alert>}
            <div className="grid gap-3 md:grid-cols-2">
              <Section title="Term" id="term"><dl className="space-y-1"><Field label="Effective" value={`${day(c.effectiveFrom)} → ${c.effectiveTo ? day(c.effectiveTo) : "open"}`} /><Field label="Renewal" value={`${human(c.renewalKind)}${c.renewalNoticeDays != null ? ` · ${c.renewalNoticeDays} days notice` : ""}`} /><Field label="Renewal state" value={<StatusBadge status={c.renewal.state} />} /><Field label="Days remaining" value={c.renewal.daysRemaining ?? "open-ended"} /><Field label="Notice due" value={day(c.renewal.noticeDue)} /></dl></Section>
              <Section title="Commercial terms" id="commercial"><dl className="space-y-1"><Field label="PO requirement" value={human(c.poRequirement)} /><Field label="Other required references" value={c.requiredReferenceKinds.length ? c.requiredReferenceKinds.map(human).join(", ") : "none"} /><Field label="Payment terms" value={c.paymentTermsDays != null ? `${c.paymentTermsDays} days` : "as the account"} /><Field label="Billability terms" value={c.terms ? `${c.terms.termsRef} v${c.terms.version} (${human(c.terms.status)})` : "none linked"} /><Field label="Customer references" value={Object.keys(c.customerReferences).length ? Object.entries(c.customerReferences).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"} /></dl>{c.billingInstructions && <p className="mt-2 whitespace-pre-wrap text-sm"><span className="text-muted-foreground">Billing instructions: </span>{c.billingInstructions}</p>}</Section>
              <Section title="Approval" id="approval"><dl className="space-y-1"><Field label="Submitted" value={c.submittedAt ? `${day(c.submittedAt)} by user ${c.submittedByUserId}` : "—"} /><Field label="Approved" value={c.approvedAt ? `${day(c.approvedAt)} by user ${c.approvedByUserId}` : "—"} /><Field label="Note" value={c.approvalNote} /></dl></Section>
              <Section title="Versions" id="versions">{c.lineage.length ? <ul className="space-y-1 text-sm">{c.lineage.map(l => <li key={l.contractRef}><button className="underline" onClick={() => p.onOpenContract(l.contractRef)}>v{l.version}</button> · <StatusBadge status={l.status} /> · {day(l.effectiveFrom)} → {l.effectiveTo ? day(l.effectiveTo) : "open"}</li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">No other version.</p>}</Section>
              <Section title="Rate sheets under this contract" id="sheets">{c.rateSheets.length ? <ul className="space-y-1 text-sm">{c.rateSheets.map(s => <li key={s.rateSheetRef}><button className="underline" onClick={() => p.onOpenRateSheet(s.rateSheetRef)}>{s.sheetNumber ?? s.rateSheetRef} · {s.name}</button> <StatusBadge status={s.status} /></li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">None. Lines price from the customer's own sheet or the company default.</p>}</Section>
              <Section title="Documents" id="documents">{c.documents.length ? <ul className="space-y-1 text-sm">{c.documents.map(dd => <li key={dd.documentRef}>{dd.title} · {dd.documentType} · v{dd.version} <StatusBadge status={dd.status} /></li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">No registered document is linked. Register the signed agreement in the Commercial Office and link it to record type <code>customer_contract</code>, reference <code>{c.contractRef}</code>.</p>}</Section>
              <Section title="Jobs worked under it" id="jobs">{c.jobs.length ? <ul className="space-y-1 text-sm">{c.jobs.map(j => <li key={j.snapshotRef}><button className="underline" onClick={() => p.onOpenJob(j.jobId)}>{j.job?.jobCode ?? `job ${j.jobId}`}</button> · snapshot {human(j.status)} · {day(j.capturedAt)}</li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">No job has frozen this contract yet.</p>}</Section>
            </div>
            {(p.canWrite || p.canApprove || p.canGovern) && (
              <Section title="Actions" id="actions">
                <div className="grid gap-2">
                  <Input aria-label="Note or reason" placeholder="note or reason (recorded in the ledger)" value={note} onChange={e => setNote(e.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    {p.canWrite && c.status === "draft" && <Button size="sm" disabled={p.busy || p.offline} onClick={() => p.onSubmit(c.contractRef, c.rowVersion)}>Submit for approval</Button>}
                    {p.canApprove && c.status === "pending_approval" && <><Button size="sm" disabled={p.busy || p.offline} onClick={() => { p.onDecide(c.contractRef, "approve", note, c.rowVersion); setNote(""); }}>Approve and activate</Button><Button size="sm" variant="outline" disabled={p.busy || p.offline || note.trim().length < 3} onClick={() => { p.onDecide(c.contractRef, "reject", note, c.rowVersion); setNote(""); }}>Reject</Button></>}
                    {p.canGovern && c.status === "active" && <><Button size="sm" variant="outline" disabled={p.busy || p.offline || note.trim().length < 3} onClick={() => { p.onStatus(c.contractRef, "suspend", note, c.rowVersion); setNote(""); }}>Suspend</Button><Button size="sm" variant="destructive" disabled={p.busy || p.offline || note.trim().length < 3} onClick={() => { p.onStatus(c.contractRef, "terminate", note, c.rowVersion); setNote(""); }}>Terminate</Button></>}
                    {p.canGovern && c.status === "suspended" && <Button size="sm" disabled={p.busy || p.offline || note.trim().length < 3} onClick={() => { p.onStatus(c.contractRef, "resume", note, c.rowVersion); setNote(""); }}>Resume</Button>}
                    {p.canWrite && !editable && ["active", "suspended", "expired"].includes(c.status) && <Button size="sm" variant="outline" disabled={p.busy || p.offline || note.trim().length < 3} onClick={() => { p.onSupersede(c.contractRef, note); setNote(""); }}>Draft a superseding version</Button>}
                  </div>
                  <p className="text-xs text-muted-foreground">The person who drafted or submitted a contract does not approve it. Suspending and terminating are recorded governance acts.</p>
                </div>
              </Section>
            )}
            <Section title="Approval history" id="history"><HistoryList rows={c.history} /></Section>
          </div>
        );
      })()}
    </div>
  );
}
