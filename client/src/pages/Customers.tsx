/** v23.26 — the Customers screen's container: list, profile, history and documents from customerCommercial.*; CustomersView is the surface. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { CustomersView, type CustomerProfile, type CustomerRow, type DocumentRow, type HistoryRow, type ProfileTab } from "./CustomersView";
import type { PageState } from "../commercial/shared";

const isDenied = (e: { data?: { code?: string } | null } | null | undefined) => e?.data?.code === "FORBIDDEN" || e?.data?.code === "UNAUTHORIZED";
function stateOf<T>(q: { isPending: boolean; isError: boolean; error: { message: string; data?: { code?: string } | null } | null; data: unknown }, emptyNote: string, isEmpty: (d: T) => boolean): PageState<T> {
  if (q.isPending) return { kind: "loading" };
  if (q.isError) return isDenied(q.error) ? { kind: "unauthorized" } : { kind: "failed", message: q.error?.message ?? "unknown error" };
  const d = q.data as T;
  return isEmpty(d) ? { kind: "empty", note: emptyNote } : { kind: "loaded", data: d };
}

export default function Customers({ accountRef }: { accountRef?: string }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState({ q: "", status: "", customerType: "", includeArchived: false });
  const [tab, setTab] = useState<ProfileTab>("overview");
  const [financialEntityId, setFinancialEntityId] = useState("");
  const [forbidden, setForbidden] = useState({ write: false, archive: false });
  const selected = accountRef ?? null;
  const list = trpc.customerCommercial.customers.list.useQuery({ q: filter.q || undefined, status: (filter.status || undefined) as never, customerType: (filter.customerType || undefined) as never, includeArchived: filter.includeArchived });
  const profile = trpc.customerCommercial.customers.get.useQuery({ accountRef: selected ?? "" }, { enabled: selected !== null });
  const history = trpc.customerCommercial.customers.history.useQuery({ accountRef: selected ?? "" }, { enabled: selected !== null && tab === "history" });
  const documents = trpc.commercialOffice.documents.list.useQuery({ recordType: "customer_account", recordRef: selected ?? "" }, { enabled: selected !== null && tab === "documents" });
  const refresh = () => { void utils.customerCommercial.customers.list.invalidate(); if (selected) { void utils.customerCommercial.customers.get.invalidate({ accountRef: selected }); void utils.customerCommercial.customers.history.invalidate({ accountRef: selected }); } };
  const onErr = (k: keyof typeof forbidden) => (e: { message: string; data?: { code?: string } | null }) => { if (isDenied(e)) setForbidden(f => ({ ...f, [k]: true })); toast.error(e.message); };
  const create = trpc.customerCommercial.customers.create.useMutation({ onSuccess: r => { toast.success(`${r.customerNumber} created`); refresh(); navigate(`/customers/${r.accountRef}`); }, onError: onErr("write") });
  const hold = trpc.customerCommercial.customers.holdSet.useMutation({ onSuccess: r => { toast.success(`Account is ${r.status}`); refresh(); }, onError: onErr("write") });
  const archive = trpc.customerCommercial.customers.archive.useMutation({ onSuccess: () => { toast.success("Archived; the record is kept"); refresh(); }, onError: onErr("archive") });
  const reactivate = trpc.customerCommercial.customers.reactivate.useMutation({ onSuccess: () => { toast.success("Reactivated"); refresh(); }, onError: onErr("archive") });
  const contactCreate = trpc.customerCommercial.contacts.create.useMutation({ onSuccess: () => { toast.success("Contact added"); refresh(); }, onError: onErr("write") });
  return (
    <CustomersView
      offline={typeof navigator !== "undefined" && !navigator.onLine}
      filter={filter} onFilter={setFilter}
      list={stateOf<CustomerRow[]>(list, "No customer matches. A customer is created here, or arrives through a recorded payment.", d => d.length === 0)}
      selected={selected} onSelect={ref => navigate(ref ? `/customers/${ref}` : "/customers")}
      profile={selected ? stateOf<CustomerProfile>(profile, "", () => false) : { kind: "loading" }} tab={tab} onTab={setTab}
      history={selected && tab === "history" ? stateOf<HistoryRow[]>(history, "", () => false) : { kind: "loading" }}
      documents={selected && tab === "documents" ? stateOf<DocumentRow[]>(documents as never, "", () => false) : { kind: "loading" }}
      canWrite={!forbidden.write} canArchive={!forbidden.archive}
      onCreate={input => create.mutate({ financialEntityId: Number(financialEntityId), name: input.name, customerType: input.customerType as never, customerNumber: input.customerNumber, requiresPurchaseOrder: input.requiresPurchaseOrder, paymentTermsDays: input.paymentTermsDays })} creating={create.isPending}
      financialEntityId={financialEntityId} onFinancialEntityId={setFinancialEntityId}
      onHold={(ref, h, reason) => hold.mutate({ accountRef: ref, hold: h, reason })} onArchive={(ref, reason) => archive.mutate({ accountRef: ref, reason })} onReactivate={ref => reactivate.mutate({ accountRef: ref, reason: "reactivated from the customer profile" })}
      onContactCreate={(ref, c) => contactCreate.mutate({ accountRef: ref, displayName: c.displayName.trim(), phone: c.phone.trim() || null, email: c.email.trim() || null, roles: [{ roleKey: c.roleKey as never }] })}
      onOpenContract={ref => navigate(`/contracts/${ref}`)} onOpenRateSheet={ref => navigate(`/rate-sheets/${ref}`)} onOpenJob={jobId => navigate(`/dispatch/${jobId}`)}
    />
  );
}
