/**
 * Vendor and facility shells. A vendor sees its submissions and its bills'
 * stages and submits a bill; a facility sees its tickets and submits one with
 * its scale hash. The identity's kind decides which; the shell asks the
 * server who it is.
 */
import { useEffect, useState } from "react";
import { portalClient, setPortalToken } from "./portalClient";

export function VendorFacilityPortal() {
  const [entered, setEntered] = useState("");
  const [me, setMe] = useState<{ displayName: string; kind: string } | null>(null);
  const [vendor, setVendor] = useState<Awaited<ReturnType<typeof portalClient.portal.vendorStatement.query>> | null>(null);
  const [facility, setFacility] = useState<Awaited<ReturnType<typeof portalClient.portal.facilityStatement.query>> | null>(null);
  const [bill, setBill] = useState({ vendorInvoiceNumber: "", invoiceDate: new Date().toISOString().slice(0, 10), subtotal: "", taxAmount: "0", description: "" });
  const [ticket, setTicket] = useState({ facilityTicketNumber: "", scaleInAt: new Date().toISOString().slice(0, 16), grossKg: "", tareKg: "", netKg: "", carrierUnitNumber: "", scaleRecordHash: "" });
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async (kind: string) => { if (kind === "vendor") setVendor(await portalClient.portal.vendorStatement.query()); if (kind === "facility") setFacility(await portalClient.portal.facilityStatement.query()); };
  const open = async () => { setMsg(null); setPortalToken(entered.trim()); try { const m = await portalClient.portal.me.query(); setMe(m); await refresh(m.kind); } catch (e) { setPortalToken(null); setMsg(e instanceof Error ? e.message : String(e)); } };

  if (!me) return (<div className="mx-auto max-w-md p-8"><h1 className="text-lg font-semibold">LeaseOS vendor / facility portal</h1><input value={entered} onChange={e => setEntered(e.target.value)} placeholder="portal token" className="mt-4 w-full rounded-lg border border-[#dfe5ee] px-3 py-2 text-sm" /><button onClick={() => void open()} className="mt-2 rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white">Open</button>{msg && <div className="mt-3 text-sm text-[#b42318]">{msg}</div>}</div>);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="font-medium">{me.displayName} <span className="text-xs text-[#5b6b82]">{me.kind} portal</span></div>
      {msg && <div className="mt-2 text-sm">{msg}</div>}
      {me.kind === "vendor" && vendor && (<div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="font-medium">Your bills</div><ul className="mt-2 divide-y divide-[#eef2f7] text-sm">{vendor.bills.map(b => <li key={b.billRef} className="py-2">{b.vendorInvoiceNumber} · ${b.total} · <span className="text-[#5b6b82]">{b.stage.replace(/_/g, " ")}{b.paidAt ? ` · paid ${new Date(b.paidAt).toLocaleDateString()}` : ""}</span></li>)}{vendor.bills.length === 0 && <li className="py-2 text-[#5b6b82]">None yet.</li>}</ul><div className="mt-3 font-medium">Submissions</div><ul className="text-sm">{vendor.submissions.map(s => <li key={s.submissionRef}>{s.submissionRef} · {s.status}{s.resultRef ? ` → ${s.resultRef}` : ""}{s.reviewReason ? ` — ${s.reviewReason}` : ""}</li>)}</ul></section>
        <section className="rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="font-medium">Submit a bill</div><div className="mt-2 grid gap-2 text-sm">{(["vendorInvoiceNumber", "invoiceDate", "subtotal", "taxAmount", "description"] as const).map(k => <input key={k} value={bill[k]} onChange={e => setBill({ ...bill, [k]: e.target.value })} placeholder={k} className="rounded-lg border border-[#dfe5ee] px-2 py-1" />)}</div><div className="mt-1 text-xs text-[#5b6b82]">It must add up; it enters as a submission and becomes a bill only when the contractor's office accepts it{vendor.vendor.requiresPurchaseAuthorization ? "; this vendor's bills need a purchase authorization" : ""}.</div><button onClick={() => void portalClient.portal.vendorBillSubmit.mutate({ vendorInvoiceNumber: bill.vendorInvoiceNumber, invoiceDate: new Date(bill.invoiceDate), subtotal: Number(bill.subtotal), taxAmount: Number(bill.taxAmount), total: Number(bill.subtotal) + Number(bill.taxAmount), lines: [{ description: bill.description || "Services", quantity: 1, unitPrice: Number(bill.subtotal) }] }).then(r => { setMsg(`${r.status} ${r.submissionRef}${r.duplicate ? " (already submitted)" : ""}`); void refresh("vendor"); }).catch(e => setMsg(String(e)))} className="mt-2 rounded-lg bg-[#132a4a] px-3 py-1 text-sm text-white">Submit</button></section>
      </div>)}
      {me.kind === "facility" && facility && (<div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="font-medium">Your tickets</div><ul className="mt-2 text-sm">{facility.tickets.map(t => <li key={t.ticketNumber}>{t.facilityTicketNumber} · {t.scaleInAt ? new Date(t.scaleInAt).toLocaleString() : "-"} · <span className="text-[#5b6b82]">{t.verificationStatus.replace(/_/g, " ")}</span></li>)}{facility.tickets.length === 0 && <li className="text-[#5b6b82]">None yet.</li>}</ul></section>
        <section className="rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="font-medium">Submit a scale ticket</div><div className="mt-2 grid gap-2 text-sm">{(["facilityTicketNumber", "scaleInAt", "grossKg", "tareKg", "netKg", "carrierUnitNumber", "scaleRecordHash"] as const).map(k => <input key={k} value={ticket[k]} onChange={e => setTicket({ ...ticket, [k]: e.target.value })} placeholder={k} className="rounded-lg border border-[#dfe5ee] px-2 py-1" />)}</div><div className="mt-1 text-xs text-[#5b6b82]">Weights must reconcile; your scale record's SHA-256 makes the ticket high-confidence. It enters for the contractor's verification.</div><button onClick={() => void portalClient.portal.disposalTicketSubmit.mutate({ facilityTicketNumber: ticket.facilityTicketNumber, scaleInAt: new Date(ticket.scaleInAt), grossKg: ticket.grossKg ? Number(ticket.grossKg) : null, tareKg: ticket.tareKg ? Number(ticket.tareKg) : null, netKg: ticket.netKg ? Number(ticket.netKg) : null, carrierUnitNumber: ticket.carrierUnitNumber || null, scaleRecordHash: ticket.scaleRecordHash || null }).then(r => { setMsg(`${r.status} ${r.submissionRef} · confidence ${r.confidence}`); void refresh("facility"); }).catch(e => setMsg(String(e)))} className="mt-2 rounded-lg bg-[#132a4a] px-3 py-1 text-sm text-white">Submit</button></section>
      </div>)}
      {me.kind === "customer" && <div className="mt-4 text-sm">This is the vendor and facility portal; customers use <a className="underline" href="/customer">/customer</a>.</div>}
    </div>
  );
}
