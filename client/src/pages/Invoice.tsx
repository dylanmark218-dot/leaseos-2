/** v23.32 — one invoice's container: billing.invoiceGet and the invoice and receivable acts; InvoiceView is the surface. */
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { InvoiceView, type InvoiceAction, type InvoiceDetail } from "./InvoiceView";
import { offline, stateOf } from "../billing/pageState";

export default function Invoice({ invoiceNumber }: { invoiceNumber: string }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const q = trpc.billing.invoiceGet.useQuery({ invoiceNumber });
  const done = (msg: string) => ({ onSuccess: () => { toast.success(msg); void utils.billing.invoiceGet.invalidate({ invoiceNumber }); void utils.billing.dashboard.invalidate(); }, onError: (e: { message: string }) => toast.error(e.message) });
  const m = {
    submit: trpc.billing.invoiceSubmit.useMutation(done("Submitted for approval")), ret: trpc.billing.invoiceReturn.useMutation(done("Returned to draft")), approve: trpc.billing.invoiceApprove.useMutation(done("Approved; the snapshot is frozen")),
    issue: trpc.billing.invoiceIssue.useMutation(done("Issued")), void: trpc.billing.invoiceVoid.useMutation(done("Voided; the record is kept")), recalc: trpc.billing.invoiceRecalculate.useMutation(done("Recalculated")),
    reverse: trpc.billing.allocationReverse.useMutation(done("Allocation reversed")), credit: trpc.billing.creditCreate.useMutation(done("Credit note requested")), creditDecide: trpc.billing.creditDecide.useMutation(done("Credit decided")),
    adjust: trpc.billing.adjustmentRequest.useMutation(done("Adjustment requested")), adjustDecide: trpc.billing.adjustmentDecide.useMutation(done("Adjustment decided")),
    dispute: trpc.billing.disputeOpen.useMutation(done("Dispute recorded")), resolve: trpc.billing.disputeResolve.useMutation(done("Dispute resolved")),
  };
  const onAction = (a: InvoiceAction) => {
    switch (a.kind) {
      case "submit": return m.submit.mutate({ invoiceNumber });
      case "return": return m.ret.mutate({ invoiceNumber, reason: a.reason });
      case "approve": return m.approve.mutate({ invoiceNumber });
      case "issue": return m.issue.mutate({ invoiceNumber });
      case "void": return m.void.mutate({ invoiceNumber, reason: a.reason });
      case "recalculate": return m.recalc.mutate({ invoiceNumber });
      case "reverse": return m.reverse.mutate({ allocationRef: a.allocationRef, reason: a.reason });
      case "credit": return m.credit.mutate({ invoiceNumber, amountCents: a.amountCents, reason: a.reason });
      case "creditDecide": return m.creditDecide.mutate({ creditRef: a.creditRef, decision: a.decision, note: a.note });
      case "adjust": return m.adjust.mutate({ invoiceNumber, amountCents: a.amountCents, reasonCode: a.reasonCode, reason: a.reason });
      case "adjustDecide": return m.adjustDecide.mutate({ adjustmentRef: a.adjustmentRef, decision: a.decision, note: a.note });
      case "dispute": return m.dispute.mutate({ invoiceNumber, lineNo: a.lineNo, amountCents: a.amountCents, reason: a.reason });
      case "resolve": return m.resolve.mutate({ caseNumber: a.caseNumber, outcome: a.outcome, creditAmountCents: a.creditAmountCents, narrative: a.narrative });
    }
  };
  return <InvoiceView offline={offline()} invoice={stateOf<InvoiceDetail>(q, "", () => false)} busy={Object.values(m).some(x => x.isPending)} onAction={onAction} onOpenJob={id => navigate(`/billing/jobs/${id}`)} />;
}
