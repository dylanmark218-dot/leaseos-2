/**
 * The customer portal shell. Thin: it calls the external procedures and
 * renders the view-models. Scope is the server's; this shell never names an
 * account.
 */
import { useEffect, useState } from "react";
import { portalClient, setPortalToken, setPortalMfa, hasPortalToken } from "./portalClient";
import { boardOrder, boardSummary, clearanceView, stateLabel, toneOf, adjustmentPreview, queueSummary, type JobBoardTicket, type ReadinessProjection } from "./viewModels";
import { SignOffScreen } from "./SignOffScreen";
import { ChainOfCustody } from "./ChainOfCustody";
import { AlertsPanel } from "./AlertsPanel";

type Panel = "board" | "queue" | "documents" | "report" | "notices" | "alerts";
const TONE_CLASS: Record<string, string> = { working: "bg-[#e6f4ea] text-[#1e6b3a]", hold: "bg-[#fff4e5] text-[#8a4b0a]", attention: "bg-[#fdecec] text-[#b42318]", done: "bg-[#eef2f7] text-[#5b6b82]", moving: "bg-[#e8f0fe] text-[#1a4fa3]", unknown: "bg-[#f3f3f3] text-[#555]" };

export function CustomerPortal() {
  const [entered, setEntered] = useState("");
  const [invitation, setInvitation] = useState("");
  const [me, setMe] = useState<{ displayName: string; kind: string } | null>(null);
  const [panel, setPanel] = useState<Panel>("board");
  const [board, setBoard] = useState<JobBoardTicket[]>([]);
  const [clearance, setClearance] = useState<{ ticketNumber: string; readiness: ReadinessProjection } | null>(null);
  const [docs, setDocs] = useState<{ documentRef: string; ticketNumber: string; kind: string; contentHash: string; generatedAt: string | Date }[]>([]);
  const [notices, setNotices] = useState<{ ticketNumber: string | null; at: string | Date; message: string; customerAction: string }[]>([]);
  const [report, setReport] = useState<unknown>(null);
  const [queue, setQueue] = useState<{ toSign: { ticketNumber: string }[]; toDecide: { ticketNumber: string; lineId: number; description: string }[]; unreadAlerts: number } | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [custody, setCustody] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<{ ticketNumber: string; entries: { at: string | Date; kind: string; what: string; billing?: string }[]; note: string } | null>(null);
  const [adj, setAdj] = useState<{ ticketNumber: string; kind: string; hourEquivalent: string; amount: string; reason: string; intent: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => { setError(null); setPortalToken(entered.trim()); try { setMe(await portalClient.portal.me.query()); } catch (e) { setPortalToken(null); setError(e instanceof Error ? e.message : String(e)); } };
  const accept = async () => { setError(null); setPortalToken(invitation.trim()); try { const r = await portalClient.portal.invitationAccept.mutate(); setPortalToken(r.token); setEntered(""); setMe(await portalClient.portal.me.query()); } catch (e) { setPortalToken(null); setError(e instanceof Error ? e.message : String(e)); } };

  useEffect(() => { if (!me) return; void (async () => { try { if (panel === "board") setBoard((await portalClient.portal.jobBoard.query()).tickets as never); if (panel === "documents") setDocs((await portalClient.portal.documents.query()).documents as never); if (panel === "notices") setNotices((await portalClient.portal.notices.query()).notices as never); if (panel === "report") setReport(await portalClient.portal.dailyReport.query({ date: new Date().toISOString().slice(0, 10) })); if (panel === "queue") setQueue(await portalClient.portal.approvalQueue.query() as never); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } })(); }, [me, panel]);

  if (!me || !hasPortalToken()) return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="text-lg font-semibold">LeaseOS customer portal</h1>
      <p className="mt-2 text-sm text-[#5b6b82]">Your access is scoped to your account by the contractor's server. Nothing here asks you which account.</p>
      <label className="mt-6 block text-xs uppercase text-[#5b6b82]">Portal token</label>
      <input value={entered} onChange={e => setEntered(e.target.value)} className="mt-1 w-full rounded-lg border border-[#dfe5ee] px-3 py-2 text-sm" />
      <button onClick={() => void signIn()} className="mt-2 rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white">Open</button>
      <div className="mt-6 text-xs uppercase text-[#5b6b82]">Or accept an invitation</div>
      <input value={invitation} onChange={e => setInvitation(e.target.value)} placeholder="invitation token" className="mt-1 w-full rounded-lg border border-[#dfe5ee] px-3 py-2 text-sm" />
      <button onClick={() => void accept()} className="mt-2 rounded-lg border border-[#132a4a] px-4 py-2 text-sm">Accept once</button>
      {error && <div className="mt-4 text-sm text-[#b42318]">{error}</div>}
    </div>
  );

  const summary = boardSummary(board);
  return (
    <div className="min-h-screen bg-[#f6f8fb] text-[#172033]">
      <header className="border-b border-[#dfe5ee] bg-white/95"><div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
        <div className="font-medium">{me.displayName}</div><div className="text-xs text-[#5b6b82]">{me.kind} portal</div>
        <nav className="ml-auto flex gap-1">{(["board", "queue", "documents", "report", "notices", "alerts"] as Panel[]).map(p => <button key={p} onClick={() => setPanel(p)} className={`rounded-full px-3 py-1 text-sm ${panel === p ? "bg-[#132a4a] text-white" : "bg-[#eef2f7]"}`}>{p[0]!.toUpperCase() + p.slice(1)}</button>)}</nav>
        <input placeholder="MFA code" onChange={e => setPortalMfa(e.target.value || null)} className="w-24 rounded-lg border border-[#dfe5ee] px-2 py-1 text-xs" aria-label="MFA code" />
      </div></header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {error && <div className="mb-4 text-sm text-[#b42318]">{error}</div>}
        {panel === "board" && (<>
          <div className="grid grid-cols-3 gap-3 text-sm md:grid-cols-6">{Object.entries(summary).slice(0, 6).map(([k, v]) => <div key={k} className="rounded-xl bg-white p-3"><div className="text-xs uppercase text-[#5b6b82]">{k.replace(/([A-Z])/g, " $1")}</div><div className="text-lg font-semibold tabular-nums">{v}</div></div>)}</div>
          <ul className="mt-4 divide-y divide-[#eef2f7] rounded-2xl border border-[#dfe5ee] bg-white">
            {boardOrder(board).map(t => (
              <li key={t.ticketNumber} className="grid gap-2 p-4 md:grid-cols-6">
                <div><div className="font-medium">{t.jobCode ?? t.ticketNumber}</div><div className="text-xs text-[#5b6b82]">{t.site ?? "site unknown"} · Unit {t.unitId ?? "-"}</div></div>
                <div><span className={`rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[toneOf(t)]}`}>{stateLabel(t.operational)}</span></div>
                <div className="text-sm">Loads {t.loads.completed}/{t.loads.total}</div>
                <div className="text-sm">Delays {t.delays.hours} h{t.delays.billing === "review" ? " · billing under review" : ""}</div>
                <div className="text-sm">{t.closeout.replace(/_/g, " ").toLowerCase()}{t.invoiceReady ? " · invoice ready" : ""}</div>
                <div className="flex flex-wrap gap-2 text-sm"><button onClick={() => void portalClient.portal.preClearance.query({ ticketNumber: t.ticketNumber }).then(r => setClearance({ ticketNumber: r.ticketNumber, readiness: r.readiness }))} className="underline">Pre-clearance</button>{t.closeout === "SITE_CLOSE_PENDING" && <button onClick={() => setSigning(t.ticketNumber)} className="underline">Sign</button>}<button onClick={() => setCustody(t.ticketNumber)} className="underline">Loads</button><button onClick={() => void portalClient.portal.jobTimeline.query({ ticketNumber: t.ticketNumber }).then(r => setTimeline(r as never))} className="underline">Timeline</button><button onClick={() => setAdj({ ticketNumber: t.ticketNumber, kind: "tip", hourEquivalent: "1", amount: "", reason: "", intent: "crew" })} className="underline">Add tip/bonus</button></div>
              </li>
            ))}
            {board.length === 0 && <li className="p-4 text-sm text-[#5b6b82]">No tickets on this account.</li>}
          </ul>
          {signing && <div className="mt-4"><SignOffScreen ticketNumber={signing} onDone={() => setSigning(null)} /></div>}
          {custody && <div className="mt-4"><ChainOfCustody ticketNumber={custody} /></div>}
          {timeline && <section className="mt-4 rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="text-xs uppercase text-[#5b6b82]">Timeline · {timeline.ticketNumber}</div><ol className="mt-2 text-sm">{timeline.entries.map((en, i) => <li key={i} className="border-l-2 border-[#dfe5ee] pl-3 py-1"><span className="text-xs text-[#5b6b82]">{new Date(en.at).toLocaleString()} · {en.kind}</span> {en.what}{en.billing ? <span className="ml-2 text-xs text-[#5b6b82]">billing: {en.billing}</span> : null}</li>)}</ol><div className="mt-2 text-xs text-[#5b6b82]">{timeline.note}</div></section>}
          {adj && (() => { const preview = adjustmentPreview({ kind: adj.kind, amountCents: Math.round(Number(adj.amount || 0) * 100), hourEquivalent: Number(adj.hourEquivalent || 0), agreedHourlyRateCents: null }); return (<section className="mt-4 rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="text-xs uppercase text-[#5b6b82]">Tip / bonus · {adj.ticketNumber}</div><div className="mt-2 flex flex-wrap gap-2 text-sm"><select value={adj.kind} onChange={ev => setAdj({ ...adj, kind: ev.target.value })}>{["tip", "crew_bonus", "exceptional_service_bonus", "flat", "completion_bonus", "callout_bonus", "hour_equivalent"].map(k => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</select>{adj.kind === "hour_equivalent" ? <input value={adj.hourEquivalent} onChange={ev => setAdj({ ...adj, hourEquivalent: ev.target.value })} className="w-20 rounded-lg border px-2" placeholder="hours" /> : <input value={adj.amount} onChange={ev => setAdj({ ...adj, amount: ev.target.value })} className="w-24 rounded-lg border px-2" placeholder="$ amount" />}<select value={adj.intent} onChange={ev => setAdj({ ...adj, intent: ev.target.value })}>{["company", "crew", "operator", "supervisor", "company_crew_split", "unknown"].map(k => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</select><input value={adj.reason} onChange={ev => setAdj({ ...adj, reason: ev.target.value })} className="flex-1 rounded-lg border px-2" placeholder="reason" /></div><div className="mt-2 text-xs text-[#5b6b82]">{preview.note}</div><button onClick={() => void portalClient.portal.adjustmentAuthorize.mutate({ ticketNumber: adj.ticketNumber, kind: adj.kind as never, amountCents: adj.kind === "hour_equivalent" ? undefined : Math.round(Number(adj.amount) * 100), hourEquivalent: adj.kind === "hour_equivalent" ? Number(adj.hourEquivalent) : undefined, recipientIntent: adj.intent as never, reason: adj.reason }).then(r => { setError(r.note ?? null); setAdj(null); }).catch(e => setError(String(e)))} className="mt-2 rounded-lg bg-[#132a4a] px-3 py-1 text-sm text-white">Authorize</button></section>); })()}
          {clearance && (() => { const v = clearanceView(clearance.readiness); return (<section className="mt-4 rounded-2xl border border-[#dfe5ee] bg-white p-4"><div className="text-xs uppercase text-[#5b6b82]">{clearance.ticketNumber}</div><div className="font-medium">{v.headline}</div><ul className="mt-2 text-sm">{v.rows.map((r, i) => <li key={i}>{r.subject}: {r.category} — {r.verdict}</li>)}</ul>{v.action && <div className="mt-2 text-sm text-[#5b6b82]">{v.action}</div>}</section>); })()}
        </>)}
        {panel === "documents" && <ul className="divide-y divide-[#eef2f7] rounded-2xl border border-[#dfe5ee] bg-white">{docs.map(d => <li key={d.documentRef} className="flex items-center gap-3 p-4 text-sm"><div className="flex-1"><div className="font-medium">{d.ticketNumber} · {d.kind.replace(/_/g, " ")}</div><div className="text-xs text-[#5b6b82]">hash {d.contentHash.slice(0, 16)}…</div></div><button onClick={() => void portalClient.portal.documentDownload.mutate({ documentRef: d.documentRef, purpose: "portal download" }).then(r => { const a = document.createElement("a"); a.href = `data:application/pdf;base64,${r.dataBase64}`; a.download = `${r.ticketNumber}-${r.kind}.pdf`; a.click(); })} className="rounded-lg bg-[#132a4a] px-3 py-1 text-white">Download</button></li>)}{docs.length === 0 && <li className="p-4 text-sm text-[#5b6b82]">No documents yet.</li>}</ul>}
        {panel === "notices" && <ul className="divide-y divide-[#eef2f7] rounded-2xl border border-[#dfe5ee] bg-white">{notices.map((n, i) => <li key={i} className="p-4 text-sm"><div className="text-xs text-[#5b6b82]">{new Date(n.at).toLocaleString()} · {n.ticketNumber ?? "-"}</div><div>{n.message}</div><div className="text-xs text-[#5b6b82]">Customer action: {n.customerAction.replace(/_/g, " ")}</div></li>)}{notices.length === 0 && <li className="p-4 text-sm text-[#5b6b82]">No notices.</li>}</ul>}
        {panel === "queue" && queue && (<section className="rounded-2xl border border-[#dfe5ee] bg-white p-5"><div className="font-medium">{queueSummary(queue)}</div><ul className="mt-3 text-sm">{queue.toSign.map(t => <li key={t.ticketNumber}>{t.ticketNumber} — awaiting your signature <button className="underline" onClick={() => { setPanel("board"); setSigning(t.ticketNumber); }}>open</button></li>)}{queue.toDecide.map(l => <li key={`${l.ticketNumber}:${l.lineId}`}>{l.ticketNumber} line {l.lineId}: {l.description} <button className="underline" onClick={() => void portalClient.portal.fieldTicketLineDecide.mutate({ ticketNumber: l.ticketNumber, lineId: l.lineId, disposition: "accepted" }).then(() => setPanel("queue"))}>accept</button> <button className="underline" onClick={() => { const why = window.prompt("Why do you dispute this line?"); if (why) void portalClient.portal.fieldTicketLineDecide.mutate({ ticketNumber: l.ticketNumber, lineId: l.lineId, disposition: "disputed", customerStatement: why }).then(() => setPanel("queue")); }}>dispute</button></li>)}</ul></section>)}
        {panel === "alerts" && <AlertsPanel />}
        {panel === "report" && <pre className="overflow-auto rounded-2xl border border-[#dfe5ee] bg-white p-4 text-xs">{JSON.stringify(report, null, 2)}</pre>}
      </main>
    </div>
  );
}
