/**
 * The signing screen. The signer sees exactly what is signed and what is
 * not; authority is what the server holds for them, never assumed here. A
 * paper signature requires the scan's evidence record. R1 is what the
 * server freezes; this screen only presents and submits.
 */
import { useEffect, useState } from "react";
import { portalClient } from "./portalClient";
import { signOffModel, type SignOffReview } from "./viewModels";

const AUTHORITIES = ["work_confirmation", "time_confirmation", "quantity_confirmation", "standby_approval", "change_order_authorization", "invoice_approval"] as const;

export function SignOffScreen({ ticketNumber, onDone }: { ticketNumber: string; onDone: () => void }) {
  const [detail, setDetail] = useState<{ snapshot: { siteBillableHours: number; standbyHours: number; standbyBillable: "yes" | "no" | "review"; loads: number; lines: SignOffReview["lines"]; postSiteRequired: boolean; events: { eventType: string; customerBillable: string; hours: number | null }[] }; snapshotHash: string; signature: unknown } | null>(null);
  const [authorities, setAuthorities] = useState<string[]>(["work_confirmation", "time_confirmation"]);
  const [method, setMethod] = useState<"drawn" | "paper_scan">("drawn");
  const [scanEvidenceId, setScanEvidenceId] = useState("");
  const [postSite, setPostSite] = useState({ travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract" as "yes" | "no" | "per_contract" });
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void portalClient.portal.fieldTicketView.query({ ticketNumber }).then(r => setDetail(r.detail as never)).catch(e => setError(String(e))); }, [ticketNumber]);
  if (error) return <div className="text-sm text-[#b42318]">{error}</div>;
  if (!detail) return <div className="text-sm text-[#5b6b82]">Loading the ticket…</div>;
  const m = signOffModel({ ticketNumber, siteBillableHours: detail.snapshot.siteBillableHours, standbyHours: detail.snapshot.standbyHours, standbyBillable: detail.snapshot.standbyBillable, loads: detail.snapshot.loads, lines: detail.snapshot.lines, excluded: detail.snapshot.events.filter(e => e.customerBillable === "no").map(e => ({ what: `${e.eventType.replace(/_/g, " ")}${e.hours != null ? ` ${e.hours.toFixed(2)} h` : ""}` })), postSiteRequired: detail.snapshot.postSiteRequired, authoritiesAvailable: authorities });

  const sign = async () => {
    setError(null);
    try {
      const r = await portalClient.portal.fieldTicketSign.mutate({ ticketNumber, snapshotHash: detail.snapshotHash, authorities: authorities as never, postSiteAuthorization: detail.snapshot.postSiteRequired ? { disposalRequired: true, ...postSite, capRule: "none", restockingBillable: false, postTripBillable: false } as never : null, ...(method === "paper_scan" ? { method: "paper_scan", paperScanEvidenceRecordId: Number(scanEvidenceId) } : {}) } as never);
      setResult(`Signed. R1 ${String((r as { documentRef?: string }).documentRef ?? "")} — snapshot ${detail.snapshotHash.slice(0, 12)}… Authority exercised: ${((r as { exercised?: string[] }).exercised ?? []).join(", ") || "recorded as unknown, for review"}.`);
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
      <div className="text-xs uppercase text-[#5b6b82]">Sign-off · {ticketNumber} · snapshot {detail.snapshotHash.slice(0, 12)}…</div>
      {m.sections.map(s => <div key={s.title} className="mt-4"><div className="font-medium">{s.title}</div><ul className="mt-1 text-sm">{s.rows.map((r, i) => <li key={i}>{r}</li>)}</ul></div>)}
      <div className="mt-4"><div className="font-medium">Your signature covers</div><div className="mt-1 flex flex-wrap gap-2">{AUTHORITIES.map(a => <label key={a} className="rounded-full bg-[#eef2f7] px-3 py-1 text-sm"><input type="checkbox" checked={authorities.includes(a)} onChange={ev => setAuthorities(ev.target.checked ? [...authorities, a] : authorities.filter(x => x !== a))} /> {a.replace(/_/g, " ")}</label>)}</div><div className="mt-1 text-xs text-[#5b6b82]">Whether you may exercise each is decided by the authority the contractor holds on file for you; anything outside it is recorded and reviewed, not assumed.</div></div>
      <div className="mt-4"><div className="font-medium">Your signature does not cover</div><ul className="mt-1 text-sm text-[#5b6b82]">{m.signatureDoesNotCover.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
      {m.postSiteNote && <div className="mt-4 rounded-xl bg-[#fff4e5] p-3 text-sm"><div className="font-medium">Post-site billing basis</div><div>{m.postSiteNote}</div><div className="mt-2 flex flex-wrap gap-3 text-sm">{(["travelToDisposal", "disposalWait", "disposalUnload"] as const).map(k => <label key={k}><input type="checkbox" checked={postSite[k]} onChange={ev => setPostSite({ ...postSite, [k]: ev.target.checked })} /> {k.replace(/([A-Z])/g, " $1").toLowerCase()}</label>)}<label>return travel <select value={postSite.returnTravel} onChange={ev => setPostSite({ ...postSite, returnTravel: ev.target.value as never })}><option value="per_contract">per contract</option><option value="yes">yes</option><option value="no">no</option></select></label></div><div className="mt-1 text-xs">Restocking and post-trip: never customer-billable.</div></div>}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm"><label><input type="radio" checked={method === "drawn"} onChange={() => setMethod("drawn")} /> Sign in LeaseOS</label><label><input type="radio" checked={method === "paper_scan"} onChange={() => setMethod("paper_scan")} /> Signed on paper</label>{method === "paper_scan" && <input value={scanEvidenceId} onChange={ev => setScanEvidenceId(ev.target.value)} placeholder="scan evidence record id" className="rounded-lg border border-[#dfe5ee] px-2 py-1" />}</div>
      <button onClick={() => void sign()} disabled={method === "paper_scan" && !scanEvidenceId} className="mt-4 rounded-lg bg-[#132a4a] px-4 py-2 text-white disabled:opacity-50">Sign R1</button>
      {result && <div className="mt-3 text-sm text-[#1e6b3a]">{result}</div>}
      {error && <div className="mt-3 text-sm text-[#b42318]">{error}</div>}
    </section>
  );
}
