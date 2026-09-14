/**
 * The four production paths that used to land on a demo page. Each is
 * API-backed: it shows what the server holds and states plainly what it
 * does not, and it links to the authoritative portal. No demonstration
 * identifiers, no invented context.
 */
import { trpc } from "@/lib/trpc";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="text-xs uppercase tracking-wide text-[#5b6b82]">LeaseOS · {title}</div>
      {children}
      <div className="mt-6 text-sm text-[#5b6b82]">Authoritative surfaces: <a className="underline" href="/portal">operations portal</a> · <a className="underline" href="/customer">customer portal</a>. The former demonstration pages are under <a className="underline" href="/showcase">/showcase</a> and cannot write production data.</div>
    </div>
  );
}

export function MapSurface() {
  const status = trpc.spatial.routingSourceStatus.useQuery();
  return (
    <Shell title="Map">
      <h1 className="mt-1 text-xl font-semibold">Routing source</h1>
      {status.isLoading ? <p className="mt-2 text-sm">Checking the routing source…</p> : status.error ? <p className="mt-2 text-sm text-[#b42318]">{status.error.message}</p> : (
        <div className="mt-3 rounded-2xl border border-[#dfe5ee] bg-white p-4 text-sm">
          <div><span className="font-medium">Status:</span> {status.data?.status.replace(/_/g, " ")}{status.data?.provider ? ` (${status.data.provider})` : ""}</div>
          <p className="mt-2 text-[#5b6b82]">{status.data?.reason}</p>
          <p className="mt-2 text-[#5b6b82]">No route is drawn here that the server did not compute. Lease locations with verified coordinates, vehicle profiles, road restrictions and segment evaluations are in the operations portal.</p>
        </div>
      )}
    </Shell>
  );
}

export function JobsSurface() {
  return (
    <Shell title="Jobs">
      <h1 className="mt-1 text-xl font-semibold">Jobs</h1>
      <p className="mt-2 text-sm text-[#5b6b82]">Jobs, trips, tickets and readiness are worked from the operations portal, where every list is read from the server and every action is authorized there. This path no longer shows a demonstration job.</p>
      <a className="mt-3 inline-block rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white" href="/portal">Open the operations portal</a>
    </Shell>
  );
}

export function EvidenceSurface() {
  return (
    <Shell title="Evidence">
      <h1 className="mt-1 text-xl font-semibold">Evidence</h1>
      <p className="mt-2 text-sm text-[#5b6b82]">Evidence is captured from a job, trip or ticket in the operations portal, so a capture carries the context it was taken in — or is saved unattached for a person to associate. Nothing captured here is stamped with a job or a coordinate it did not come from, and a capture is verified only by <code>evidence.verify</code>.</p>
      <a className="mt-3 inline-block rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white" href="/portal">Open the operations portal</a>
    </Shell>
  );
}

export function SafetySurface() {
  return (
    <Shell title="Safety">
      <h1 className="mt-1 text-xl font-semibold">Safety</h1>
      <p className="mt-2 text-sm text-[#5b6b82]">Incidents, near misses, tailgates, driving-event review and the safety program's records are in the operations portal. A new event is created open; resolution is a later, recorded act.</p>
      <a className="mt-3 inline-block rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white" href="/portal">Open the operations portal</a>
    </Shell>
  );
}
