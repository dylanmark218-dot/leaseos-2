/** v23.31 — the contract screen's container: reads one contract, drives its transitions. ContractView is the surface. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { ContractView, type ContractDetail } from "./ContractView";
import type { PageState } from "../commercial/shared";

const isDenied = (e: { data?: { code?: string } | null } | null | undefined) => e?.data?.code === "FORBIDDEN" || e?.data?.code === "UNAUTHORIZED";

export default function Contract({ contractRef }: { contractRef: string }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [forbidden, setForbidden] = useState<{ write: boolean; approve: boolean; govern: boolean }>({ write: false, approve: false, govern: false });
  const q = trpc.customerCommercial.contracts.get.useQuery({ contractRef });
  const state: PageState<ContractDetail> = q.isPending ? { kind: "loading" } : q.isError ? (isDenied(q.error) ? { kind: "unauthorized" } : { kind: "failed", message: q.error.message }) : { kind: "loaded", data: q.data as unknown as ContractDetail };
  const refresh = () => { void utils.customerCommercial.contracts.get.invalidate({ contractRef }); void utils.customerCommercial.customers.get.invalidate(); };
  const onErr = (k: keyof typeof forbidden) => (e: { message: string; data?: { code?: string } | null }) => { if (isDenied(e)) setForbidden(f => ({ ...f, [k]: true })); toast.error(e.message); };
  const submit = trpc.customerCommercial.contracts.submit.useMutation({ onSuccess: () => { toast.success("Submitted for approval"); refresh(); }, onError: onErr("write") });
  const decide = trpc.customerCommercial.contracts.approve.useMutation({ onSuccess: r => { toast.success(`Contract is ${r.status}`); refresh(); }, onError: onErr("approve") });
  const status = trpc.customerCommercial.contracts.statusSet.useMutation({ onSuccess: r => { toast.success(`Contract is ${r.status}`); refresh(); }, onError: onErr("govern") });
  const supersede = trpc.customerCommercial.contracts.supersede.useMutation({ onSuccess: r => { toast.success(`Version ${r.version} drafted`); navigate(`/contracts/${r.contractRef}`); }, onError: onErr("write") });
  const busy = submit.isPending || decide.isPending || status.isPending || supersede.isPending;
  return (
    <ContractView
      offline={typeof navigator !== "undefined" && !navigator.onLine} contract={state}
      canWrite={!forbidden.write} canApprove={!forbidden.approve} canGovern={!forbidden.govern} busy={busy}
      onSubmit={(ref, rowVersion) => submit.mutate({ contractRef: ref, expectedRowVersion: rowVersion })}
      onDecide={(ref, decision, note, rowVersion) => decide.mutate({ contractRef: ref, decision, note: note || undefined, expectedRowVersion: rowVersion })}
      onStatus={(ref, event, reason, rowVersion) => status.mutate({ contractRef: ref, event, reason, expectedRowVersion: rowVersion })}
      onSupersede={(ref, reason) => supersede.mutate({ contractRef: ref, reason })}
      onOpenCustomer={accountRef => navigate(`/customers/${accountRef}`)} onOpenRateSheet={ref => navigate(`/rate-sheets/${ref}`)} onOpenContract={ref => navigate(`/contracts/${ref}`)} onOpenJob={jobId => navigate(`/dispatch/${jobId}`)}
    />
  );
}
