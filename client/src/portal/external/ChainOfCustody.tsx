import { useEffect, useState } from "react";
import { portalClient } from "./portalClient";
import { custodyRows } from "./viewModels";

export function ChainOfCustody({ ticketNumber }: { ticketNumber: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof portalClient.portal.chainOfCustody.query>> | null>(null);
  useEffect(() => { void portalClient.portal.chainOfCustody.query({ ticketNumber }).then(setData); }, [ticketNumber]);
  if (!data) return <div className="text-sm text-[#5b6b82]">Loading loads…</div>;
  const rows = custodyRows(data.loads as never);
  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
      <div className="flex items-baseline gap-3"><div className="font-medium">Loads and material · {ticketNumber}</div><div className="text-xs text-[#5b6b82]">{data.complete ? "Chain complete — every load has a verified disposal ticket" : "Chain incomplete — see the evidence state on each load"}</div></div>
      <ul className="mt-3 divide-y divide-[#eef2f7]">{rows.map(r => <li key={r.loadNumber} className="py-3 text-sm"><div className="font-medium">{r.loadNumber} · {r.material} · {r.quantityText}</div><div className="text-[#5b6b82]">{r.route}</div><div className={r.evidenceTone === "ok" ? "text-[#1e6b3a]" : r.evidenceTone === "warn" ? "text-[#8a4b0a]" : "text-[#5b6b82]"}>{r.evidenceText}</div></li>)}</ul>
      <div className="mt-3 text-xs text-[#5b6b82]">Totals: {data.totals.map(t => `${t.material} ${Math.round(t.quantity * 100) / 100} ${t.unit ?? ""}`).join(" · ") || "none"}</div>
    </section>
  );
}
