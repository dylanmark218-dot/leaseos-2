/**
 * 0175 — The tracking page's container: reads the token from `/t/:token`, resolves the link, and
 * fetches only what the link permits. The server decides everything; this composes the calls and
 * hands the results to `TrackingView`. The token never leaves memory.
 */
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { setTrackingToken, trackingClient } from "./trackingClient";
import { TrackingView, type TrackingViewProps } from "./TrackingView";

type Loaded = Extract<TrackingViewProps["state"], { kind: "loaded" }>;

export function TrackingPage() {
  const [, params] = useRoute("/t/:token");
  const token = params?.token ?? null;
  const [state, setState] = useState<TrackingViewProps["state"]>({ kind: "loading" });
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrackingToken(token);
    if (!token) { setState({ kind: "refused", message: null }); return; }
    void (async () => {
      try {
        const link = await trackingClient.tracking.resolve.query();
        const status = link.permits.status ? await trackingClient.tracking.status.query() : null;
        if (!status) { if (!cancelled) setState({ kind: "refused", message: "This tracking link does not permit status" }); return; }
        const [loads, documents, tickets] = await Promise.all([
          link.permits.loads ? trackingClient.tracking.loads.query().catch(() => null) : Promise.resolve(null),
          link.permits.documents ? trackingClient.tracking.documents.query().then(r => r.documents).catch(() => null) : Promise.resolve(null),
          link.permits.billing ? trackingClient.tracking.openTicket.query().then(r => r.tickets).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const loaded: Loaded = { kind: "loaded", issuedTo: link.issuedTo, status: status as never, loads: loads as never, documents: documents as never, tickets: tickets as never };
        setState(loaded);
      } catch (e) {
        if (!cancelled) setState({ kind: "refused", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const download = async (releaseRef: string) => {
    setError(null); setDownloading(releaseRef);
    try {
      const d = await trackingClient.tracking.documentDownload.mutate({ releaseRef });
      const bytes = Uint8Array.from(atob(d.dataBase64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: d.mimeType }));
      const a = document.createElement("a"); a.href = url; a.download = `${d.documentRef}.${d.mimeType === "application/pdf" ? "pdf" : "bin"}`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setDownloading(null); }
  };

  return <TrackingView state={state} onDownload={d => void download(d)} onReviewTicket={() => setError("Ticket review from this link arrives with the customer-actions checkpoint.")} downloading={downloading} error={error} />;
}
