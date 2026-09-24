/**
 * 0175 — The client services portal, the container. Authenticates with the same portal token as the
 * customer shell (held in memory, sent as `x-portal-token`), reads `/client/:section`, and calls only
 * the `portal.client*` procedures. The server scopes everything to the identity's account; this
 * composes calls and hands results to `ClientPortalView`.
 */
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { hasPortalToken, portalClient, setPortalToken } from "../external/portalClient";
import { ClientPortalView, type ClientPortalViewProps } from "./ClientPortalView";
import { sectionFrom, type Section } from "./clientViewModels";

type Data = Pick<ClientPortalViewProps, "dashboard" | "jobs" | "jobDetail" | "loads" | "documents" | "invoices" | "tickets" | "contacts">;
const empty: Data = { dashboard: null, jobs: null, jobDetail: null, loads: null, documents: null, invoices: null, tickets: null, contacts: null };

export function ClientPortal() {
  const [, params] = useRoute("/client/:section?");
  const [, navigate] = useLocation();
  const section = sectionFrom(params?.section);
  const [entered, setEntered] = useState("");
  const [me, setMe] = useState<{ displayName: string } | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [data, setData] = useState<Data>(empty);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const signIn = async () => { setError(null); setPortalToken(entered.trim()); try { setMe(await portalClient.portal.me.query()); } catch (e) { setPortalToken(null); setError(e instanceof Error ? e.message : String(e)); } };
  const go = (s: Section) => navigate(`/client/${s}`);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const patch: Partial<Data> = {};
        if (section === "dashboard") patch.dashboard = await portalClient.portal.clientDashboard.query();
        if (section === "active" || section === "scheduled" || section === "completed") patch.jobs = (await portalClient.portal.clientJobs.query({ bucket: section })).jobs as never;
        if (section === "tracking" && selectedJob) patch.jobDetail = (await portalClient.portal.clientJob.query({ jobReference: selectedJob })) as never;
        if ((section === "loads" || section === "disposal") && selectedJob) patch.loads = (await portalClient.portal.clientJobLoads.query({ jobReference: selectedJob })) as never;
        if (section === "documents") patch.documents = (await portalClient.portal.clientDocuments.query()).documents;
        if (section === "invoices") patch.invoices = (await portalClient.portal.invoices.query()).invoices as never;
        if (section === "billing") patch.tickets = (await portalClient.portal.clientTickets.query()).tickets as never;
        if (section === "contacts") patch.contacts = await portalClient.portal.clientContacts.query();
        if (!cancelled) setData(d => ({ ...d, ...patch }));
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [me, section, selectedJob]);

  const download = async (releaseRef: string) => {
    setError(null);
    try {
      const d = await portalClient.portal.clientDocumentDownload.mutate({ releaseRef });
      const bytes = Uint8Array.from(atob(d.dataBase64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: d.mimeType }));
      const a = document.createElement("a"); a.href = url; a.download = `${d.documentRef}.${d.mimeType === "application/pdf" ? "pdf" : "bin"}`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const act = async (ticketNumber: string, kind: "acknowledge" | "approve" | "dispute" | "comment") => {
    setError(null);
    const ticket = data.tickets?.find(t => t.ticketNumber === ticketNumber);
    try {
      if (kind === "dispute") { const comment = window.prompt("What is disputed, and why?"); if (!comment?.trim()) return; await portalClient.portal.clientTicketDispute.mutate({ ticketNumber, snapshotHash: ticket?.snapshotHash ?? null, comment }); }
      else if (kind === "approve") { const customerPoNumber = window.prompt("PO or reference number (optional):") || null; await portalClient.portal.clientTicketAct.mutate({ ticketNumber, kind, snapshotHash: ticket?.snapshotHash ?? null, customerPoNumber }); }
      else if (kind === "comment") { const comment = window.prompt("Your comment:"); if (!comment?.trim()) return; await portalClient.portal.clientTicketAct.mutate({ ticketNumber, kind, comment }); }
      else await portalClient.portal.clientTicketAct.mutate({ ticketNumber, kind });
      setData(d => ({ ...d, tickets: null }));
      setData(d => ({ ...d, tickets: d.tickets }));
      const tickets = (await portalClient.portal.clientTickets.query()).tickets as never;
      setData(d => ({ ...d, tickets }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (!me || !hasPortalToken()) return (
    <main className="mx-auto max-w-md p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#6e7f96]">LeaseOS</p>
      <h1 className="mt-1 text-lg font-semibold">Client services portal</h1>
      <p className="mt-2 text-sm text-[#5b6b82]">Your access is scoped to your account by the contractor's server. Nothing here asks you which account. Accept an invitation on the customer portal first; then open this portal with your token.</p>
      <label htmlFor="portal-token" className="mt-6 block text-xs uppercase text-[#5b6b82]">Portal token</label>
      <input id="portal-token" value={entered} onChange={e => setEntered(e.target.value)} className="mt-1 w-full rounded-lg border border-[#dfe5ee] px-3 py-2 text-sm" />
      <button type="button" onClick={() => void signIn()} className="mt-2 rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white">Open</button>
      {error && <p role="alert" className="mt-4 text-sm text-[#b42318]">{error}</p>}
    </main>
  );

  return <ClientPortalView section={section} onSection={go} me={me} {...data} selectedJob={selectedJob} onSelectJob={j => { setSelectedJob(j); go("tracking"); }} onDownload={d => void download(d)} onTicketAction={(t, k) => void act(t, k)} error={error} loading={loading} />;
}
