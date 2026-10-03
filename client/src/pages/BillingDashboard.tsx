/** v23.32 — the billing dashboard's container: billing.dashboard; BillingDashboardView is the surface. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { BillingDashboardView, type Dashboard, type DashboardBucket } from "./BillingDashboardView";
import { offline, stateOf } from "../billing/pageState";

export default function BillingDashboard() {
  const [, navigate] = useLocation();
  const [bucket, setBucket] = useState<DashboardBucket>("needs_attention");
  const [filter, setFilter] = useState({ q: "", accountRef: "" });
  const q = trpc.billing.dashboard.useQuery({ q: filter.q || undefined, accountRef: filter.accountRef || undefined });
  return (
    <BillingDashboardView offline={offline()} dashboard={stateOf<Dashboard>(q, "", () => false)} bucket={bucket} onBucket={setBucket} filter={filter} onFilter={setFilter}
      onOpenJob={id => navigate(`/billing/jobs/${id}`)} onOpenInvoice={n => navigate(`/invoices/${encodeURIComponent(n)}`)} onOpenReceivables={() => navigate("/receivables")} />
  );
}
