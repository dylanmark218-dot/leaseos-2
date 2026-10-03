/** v23.32 — the receivables container: billing.receivables, payments and allocations, customer balance; ReceivablesView is the surface. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { ReceivablesView, type CustomerBalance, type Receivables as ReceivablesData } from "./ReceivablesView";
import { isDenied, offline, stateOf } from "../billing/pageState";

export default function Receivables() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [denied, setDenied] = useState({ record: false, apply: false });
  const [accountRef, setAccountRef] = useState<string | null>(null);
  const q = trpc.billing.receivables.useQuery({});
  const bal = trpc.billing.customerBalance.useQuery({ accountRef: accountRef ?? "" }, { enabled: accountRef !== null });
  const refresh = () => { void utils.billing.receivables.invalidate(); if (accountRef) void utils.billing.customerBalance.invalidate({ accountRef }); };
  const record = trpc.billing.paymentRecord.useMutation({ onSuccess: r => { toast.success(r.replayed ? `${r.paymentRef} was already recorded under that key` : `${r.paymentRef} recorded, unapplied`); refresh(); }, onError: e => { if (isDenied(e)) setDenied(d => ({ ...d, record: true })); toast.error(e.message); } });
  const allocate = trpc.billing.paymentAllocate.useMutation({ onSuccess: r => { toast.success(`${r.invoiceNumber}: ${r.invoiceStatus.replace(/_/g, " ")}`); refresh(); }, onError: e => { if (isDenied(e)) setDenied(d => ({ ...d, apply: true })); toast.error(e.message); } });
  return (
    <ReceivablesView offline={offline()} receivables={stateOf<ReceivablesData>(q, "", () => false)} balance={accountRef ? stateOf<CustomerBalance>(bal, "", () => false) : null} busy={record.isPending || allocate.isPending}
      can={{ record: !denied.record, apply: !denied.apply }}
      onRecord={(p, amountCents) => record.mutate({ financialEntityId: Number(p.financialEntityId), accountRef: p.accountRef.trim(), receivedAt: new Date(`${p.receivedAt}T12:00:00Z`), amountCents, method: p.method, reference: p.reference.trim() || null, payerName: p.payerName.trim() || null, idempotencyKey: p.idempotencyKey.trim() || null, source: p.idempotencyKey.trim() ? "import" : "manual" })}
      onAllocate={(paymentRef, invoiceNumber, amountCents) => allocate.mutate({ paymentRef, invoiceNumber, amountCents })}
      onBalance={setAccountRef} onOpenInvoice={n => navigate(`/invoices/${encodeURIComponent(n)}`)} />
  );
}
