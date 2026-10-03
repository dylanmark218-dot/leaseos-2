/** v23.32 — one job's billing container: billing.workspace and the job's billing acts; BillingJobView is the surface. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { BillingJobView, type Workspace } from "./BillingJobView";
import { isDenied, offline, stateOf } from "../billing/pageState";

export default function BillingJob({ jobId }: { jobId: number }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [denied, setDenied] = useState<Record<string, boolean>>({});
  const ws = trpc.billing.workspace.useQuery({ jobId });
  const refresh = () => { void utils.billing.workspace.invalidate({ jobId }); void utils.billing.dashboard.invalidate(); };
  const on = (k: string, done: string) => ({ onSuccess: () => { toast.success(done); refresh(); }, onError: (e: { message: string; data?: { code?: string } | null }) => { if (isDenied(e)) setDenied(d => ({ ...d, [k]: true })); toast.error(e.message); } });
  const prepare = trpc.billing.prepare.useMutation(on("prepare", "Charges prepared from the frozen basis"));
  const recalc = trpc.billing.recalculate.useMutation(on("prepare", "Unbilled charges re-priced; the old ones are superseded"));
  const submit = trpc.billing.reviewSubmit.useMutation(on("review", "Submitted for review"));
  const decide = trpc.billing.reviewDecide.useMutation(on("approve", "Review decided"));
  const hold = trpc.billing.holdSet.useMutation(on("hold", "Billing hold changed"));
  const ovReq = trpc.billing.chargeOverrideRequest.useMutation(on("override", "Override requested — a second person approves"));
  const ovDec = trpc.billing.chargeOverrideDecide.useMutation(on("approveOverride", "Override decided"));
  const manDec = trpc.billing.chargeManualDecide.useMutation(on("approveOverride", "Manual charge decided"));
  const draft = trpc.billing.invoiceDraft.useMutation({ onSuccess: r => { toast.success(`${r.invoiceNumber} drafted`); refresh(); navigate(`/invoices/${encodeURIComponent(r.invoiceNumber)}`); }, onError: e => { if (isDenied(e)) setDenied(d => ({ ...d, draft: true })); toast.error(e.message); } });
  const busy = [prepare, recalc, submit, decide, hold, ovReq, ovDec, manDec, draft].some(m => m.isPending);
  return (
    <BillingJobView offline={offline()} workspace={stateOf<Workspace>(ws, "", () => false)} busy={busy}
      can={{ prepare: !denied.prepare, review: !denied.review, approve: !denied.approve, override: !denied.override, approveOverride: !denied.approveOverride, hold: !denied.hold, draft: !denied.draft }}
      onPrepare={() => prepare.mutate({ jobId })} onRecalculate={reason => recalc.mutate({ jobId, reason })} onSubmitReview={note => submit.mutate({ jobId, note: note || null })}
      onDecideReview={(decision, note) => decide.mutate({ jobId, decision, note })} onHold={(active, reason) => hold.mutate({ jobId, active, reason })}
      onOverrideRequest={(chargeRef, amountCents, quantityMillis, reason) => ovReq.mutate({ chargeRef, amountCents, quantityMillis, reason })}
      onOverrideDecide={(chargeRef, decision, note) => ovDec.mutate({ chargeRef, decision, note })} onManualDecide={(chargeRef, decision, note) => manDec.mutate({ chargeRef, decision, note })}
      onDraft={slices => draft.mutate({ jobIds: [jobId], slices: slices ?? undefined })} onOpenInvoice={n => navigate(`/invoices/${encodeURIComponent(n)}`)} />
  );
}
