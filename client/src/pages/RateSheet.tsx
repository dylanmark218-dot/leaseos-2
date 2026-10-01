/** v23.31 — the rate sheet screen's container: reads one sheet with every version, drives drafting, lines and approval. RateSheetView is the surface. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { RateSheetView, type LineDraft, type RateSheetDetail } from "./RateSheetView";
import type { PageState } from "../commercial/shared";

const isDenied = (e: { data?: { code?: string } | null } | null | undefined) => e?.data?.code === "FORBIDDEN" || e?.data?.code === "UNAUTHORIZED";
/** Dollars typed by a person → integer thousandths of a dollar; a value the server would refuse is refused here first. */
const toMillis = (text: string) => { const n = Number(text); if (!Number.isFinite(n)) return null; return Math.round(n * 1000); };
const toBps = (text: string) => { const n = Number(text); if (!Number.isFinite(n)) return null; return Math.round(n * 100); };

export default function RateSheet({ rateSheetRef }: { rateSheetRef: string }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState({ propose: false, approve: false });
  const q = trpc.customerCommercial.rateSheets.get.useQuery({ rateSheetRef });
  const state: PageState<RateSheetDetail> = q.isPending ? { kind: "loading" } : q.isError ? (isDenied(q.error) ? { kind: "unauthorized" } : { kind: "failed", message: q.error.message }) : { kind: "loaded", data: q.data as unknown as RateSheetDetail };
  const refresh = () => { void utils.customerCommercial.rateSheets.get.invalidate({ rateSheetRef }); };
  const onErr = (k: keyof typeof forbidden) => (e: { message: string; data?: { code?: string } | null }) => { if (isDenied(e)) setForbidden(f => ({ ...f, [k]: true })); toast.error(e.message); };
  const versionCreate = trpc.customerCommercial.rateSheets.versionCreate.useMutation({ onSuccess: r => { toast.success(`Version ${r.version} drafted (${r.linesCopied} lines copied)`); setSelectedVersion(r.versionRef); refresh(); }, onError: onErr("propose") });
  const lineAdd = trpc.customerCommercial.rateSheets.lineAdd.useMutation({ onSuccess: () => { toast.success("Line added"); refresh(); }, onError: onErr("propose") });
  const lineRemove = trpc.customerCommercial.rateSheets.lineRemove.useMutation({ onSuccess: () => { toast.success("Line removed from the draft"); refresh(); }, onError: onErr("propose") });
  const submit = trpc.customerCommercial.rateSheets.versionSubmit.useMutation({ onSuccess: () => { toast.success("Submitted for approval"); refresh(); }, onError: onErr("propose") });
  const decide = trpc.customerCommercial.rateSheets.versionDecide.useMutation({ onSuccess: r => { toast.success(`Version is ${r.status}${r.supersedes ? ` — supersedes ${r.supersedes}` : ""}`); refresh(); }, onError: onErr("approve") });
  const busy = versionCreate.isPending || lineAdd.isPending || lineRemove.isPending || submit.isPending || decide.isPending;
  return (
    <RateSheetView
      offline={typeof navigator !== "undefined" && !navigator.onLine} sheet={state} selectedVersion={selectedVersion} onSelectVersion={setSelectedVersion}
      canPropose={!forbidden.propose} canApprove={!forbidden.approve} busy={busy}
      onVersionCreate={(ref, effectiveFrom) => versionCreate.mutate({ rateSheetRef: ref, effectiveFrom: new Date(effectiveFrom) })}
      onLineAdd={(versionRef, d: LineDraft) => {
        const applicability = [d.shift ? { kind: "shift" as const, op: "eq" as const, value: d.shift } : null, d.province ? { kind: "province" as const, op: "eq" as const, value: d.province.trim().toUpperCase() } : null].filter((x): x is NonNullable<typeof x> => x != null);
        const base = { versionRef, serviceCode: d.serviceCode.trim(), lineKind: d.lineKind, label: d.label.trim() || null, unit: d.unit.trim() as never, minimumQuantityMillis: d.minimumQuantity ? toMillis(d.minimumQuantity) : null, billingIncrementMillis: d.increment ? toMillis(d.increment) : null, applicability: applicability.length ? applicability : null };
        if (d.pricingMethod === "per_unit") { const rateMillis = toMillis(d.amount); if (rateMillis == null) return toast.error("Rate is not a number"); lineAdd.mutate({ ...base, pricingMethod: "per_unit", rateMillis }); }
        else if (d.pricingMethod === "flat") { const m = toMillis(d.amount); if (m == null) return toast.error("Amount is not a number"); lineAdd.mutate({ ...base, pricingMethod: "flat", flatCents: Math.round(m / 10) }); }
        else { const basisPoints = toBps(d.amount); if (basisPoints == null) return toast.error("Percent is not a number"); lineAdd.mutate({ ...base, pricingMethod: "percentage_markup", basisPoints }); }
      }}
      onLineRemove={definitionRef => lineRemove.mutate({ definitionRef })}
      onSubmit={(versionRef, rowVersion) => submit.mutate({ versionRef, event: "submit", expectedRowVersion: rowVersion })}
      onDecide={(versionRef, event, reason, rowVersion) => decide.mutate({ versionRef, event, reason: reason || undefined, expectedRowVersion: rowVersion })}
      onOpenCustomer={accountRef => navigate(`/customers/${accountRef}`)} onOpenContract={ref => navigate(`/contracts/${ref}`)} onOpenJob={jobId => navigate(`/dispatch/${jobId}`)}
    />
  );
}
