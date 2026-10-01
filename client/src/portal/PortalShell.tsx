/**
 * PortalShell — one shell, role-composed.
 *
 * The same backend; a different first screen per portal. The shell reads
 * `session.context` for who this is, which company they are acting for and
 * which workspaces are open to them, then the five surfaces — My Day,
 * Exceptions, Inbox, Search, Timeline — all of which the server already
 * filters to what the caller may see or act on. The shell decides nothing
 * about permission; it renders what it is given.
 *
 * v23.26 — the switcher is server-authoritative. It used to read
 * `portals.mine` and hold the current portal in `useState`, so switching was a
 * local variable: correct in practice, because every call behind it was gated
 * anyway, but it meant the shell's idea of "which workspaces do I hold" and the
 * server's could differ, and the shell's was the one on screen. Now the list
 * comes from `session.context`, the switch goes through
 * `session.selectWorkspace` — which refuses one the caller does not hold and
 * remembers one they do — and access revoked server-side takes the tab with it
 * on the next fetch.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { composeMyDayView, composeOfficeView, contextRibbon, exceptionIndicator, switcherModel, type PortalKey } from "./viewModels";
import { MyDayPanel } from "./panels/MyDayPanel";
import { ExceptionsPanel } from "./panels/ExceptionsPanel";
import { InboxPanel } from "./panels/InboxPanel";
import { TimelinePanel } from "./panels/TimelinePanel";
import { SetupPanel } from "./panels/SetupPanel";
import { PeopleAccessPanel } from "./panels/PeopleAccessPanel";
import { FleetPanel } from "./panels/FleetPanel";
import { UniversalSearch } from "./UniversalSearch";
import { SyncIndicator } from "./SyncIndicator";
import { QuickCapture } from "./QuickCapture";
import { SessionGate } from "@/session/SessionGate";

export type PanelKey = "myday" | "exceptions" | "inbox" | "timeline" | "setup" | "people" | "fleet";

/** 0221 — the portals that work units. Drawing the panel elsewhere would only draw a screen that refuses. */
const FLEET_PORTALS = new Set<PortalKey>(["fleet_maintenance", "dispatch_operations", "safety_compliance", "office_administration", "management"]);

const OFFICE_PORTALS = new Set<PortalKey>(["office_administration", "finance_billing", "management", "executive", "hr_workforce", "auditor_regulator"]);

/**
 * The shell, behind the gate.
 *
 * `SessionGate` resolves identity, organization and workspace and renders the
 * sign-in screen, the chooser or a refusal when any of those is unsettled. It
 * hands the shell a workspace only once the server has said this person holds
 * it — which is presentation, not permission: the gate could be deleted and
 * not one call behind it would start succeeding.
 */
export function PortalShell(props: { initialPanel?: PanelKey; displayName?: string | null }) {
  return (
    <SessionGate>
      {({ context, workspace }) => (
        <PortalShellBody
          {...props}
          workspace={workspace as PortalKey}
          held={context.availableWorkspaces.map(w => w.key as PortalKey)}
          displayName={props.displayName ?? context.user?.name ?? null}
        />
      )}
    </SessionGate>
  );
}

function PortalShellBody({ initialPanel = "myday", displayName = null, workspace, held }: { initialPanel?: PanelKey; displayName?: string | null; workspace: PortalKey; held: readonly PortalKey[] }) {
  const [, navigate] = useLocation();
  const [panel, setPanel] = useState<PanelKey>(initialPanel);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  // v21.9.1 — subscribe; a value read once at mount is wrong the moment the truck leaves coverage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  const selectWorkspace = trpc.session.selectWorkspace.useMutation();
  const myDay = trpc.surfaces.myDay.useQuery(undefined, { refetchInterval: 60_000 });
  const exceptions = trpc.surfaces.exceptions.useQuery({ limit: 200 }, { refetchInterval: 60_000 });
  const inbox = trpc.surfaces.inbox.useQuery(undefined, { refetchInterval: 60_000 });

  // The server named the workspace and the list it came from. The shell picks
  // nothing — there is no local default here any more, because a default the
  // client chooses is a default the client can be wrong about.
  const portal = workspace;
  const switcher = switcherModel(held, portal);

  const view = useMemo(() => {
    if (!portal || !myDay.data) return null;
    return composeMyDayView({ myDay: myDay.data as never, exceptions: (exceptions.data?.items ?? []) as never, portal, now: new Date(), displayName });
  }, [portal, myDay.data, exceptions.data, displayName]);
  const officeView = useMemo(() => composeOfficeView((exceptions.data?.items ?? []) as never, (inbox.data?.items ?? []) as never), [exceptions.data, inbox.data]);
  const indicator = exceptionIndicator(myDay.data?.attention ?? { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {}, headline: "" });
  const ribbon = portal ? contextRibbon({ portal, assignment: view?.assignment ?? null, online, deviceStatus: null }) : [];

  const go = (link: { portal: string; route: string }) => navigate(`/portal/${link.portal}${link.route}`);

  /**
   * Switch workspace. The server decides, and it is the server that says where
   * to land.
   *
   * A refusal here is not a bug to swallow: it means the tab on screen names a
   * workspace this account no longer holds — revoked while they were signed in.
   * The chooser is the right place to land, because it re-reads what is
   * actually open rather than leaving a stale tab looking pressable.
   */
  const switchTo = async (key: PortalKey) => {
    try {
      const chosen = await selectWorkspace.mutateAsync({ workspace: key });
      navigate(chosen.landing);
    } catch {
      navigate("/workspaces");
    }
  };

  return (
    <div className="min-h-screen bg-[#f6f8fb] text-[#172033]">
      <header className="sticky top-0 z-10 border-b border-[#dfe5ee] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <nav aria-label="Portals" className="flex flex-wrap gap-1">
            {switcher.map(s => (
              <button key={s.key} onClick={() => { void switchTo(s.key); }} aria-current={s.current ? "page" : undefined}
                className={`rounded-full px-3 py-1 text-sm ${s.current ? "bg-[#132a4a] text-white" : "bg-[#eef2f7] text-[#172033] hover:bg-[#dfe5ee]"}`}>{s.label}</button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <UniversalSearch onPick={go} />
            <button onClick={() => setPanel("exceptions")} aria-label="Exceptions" className="relative rounded-full bg-[#eef2f7] px-3 py-1 text-sm">
              Attention{indicator.badge && <span className={`ml-2 rounded-full px-2 text-xs text-white ${indicator.tone === "critical" ? "bg-[#b42318]" : indicator.tone === "high" ? "bg-[#c4620a]" : "bg-[#5b6b82]"}`}>{indicator.badge}</span>}
            </button>
            <button onClick={() => setPanel("inbox")} className="rounded-full bg-[#eef2f7] px-3 py-1 text-sm">Inbox{inbox.data?.total ? ` · ${inbox.data.total}` : ""}</button>
            <SyncIndicator online={online} />
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-2 text-xs text-[#5b6b82]" aria-label="Context">{ribbon.join(" · ")}</div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4 flex gap-2 text-sm">
          {/* B23.2 — "People" only in the management workspace. The procedures
              behind it refuse anyone without `roles.grant` regardless, so this
              keeps a door from being drawn rather than being the lock. */}
          {(["myday", "exceptions", "inbox", "timeline",
             ...(FLEET_PORTALS.has(portal) ? ["fleet" as PanelKey] : []),
             ...(OFFICE_PORTALS.has(portal) ? ["setup" as PanelKey] : []),
             ...(portal === "management" ? ["people" as PanelKey] : [])] as PanelKey[]).map(p => (
            <button key={p} onClick={() => setPanel(p)} className={`rounded-lg px-3 py-1 ${panel === p ? "bg-white shadow" : "text-[#5b6b82]"}`}>{p === "myday" ? "My Day" : p === "people" ? "People" : p[0]!.toUpperCase() + p.slice(1)}</button>
          ))}
        </div>
        {panel === "myday" && view && (OFFICE_PORTALS.has(portal) ? <MyDayPanel view={view} office={officeView} onGo={go} /> : <MyDayPanel view={view} onGo={go} />)}
        {panel === "exceptions" && <ExceptionsPanel items={(exceptions.data?.items ?? []) as never} summary={myDay.data?.attention as never} onGo={go} />}
        {panel === "inbox" && <InboxPanel items={(inbox.data?.items ?? []) as never} counts={inbox.data?.counts ?? {}} onGo={go} />}
        {panel === "timeline" && <TimelinePanel />}
        {panel === "setup" && OFFICE_PORTALS.has(portal) && <SetupPanel />}
        {panel === "people" && portal === "management" && <PeopleAccessPanel />}
        {panel === "fleet" && FLEET_PORTALS.has(portal) && <FleetPanel onOpen={unitId => navigate(`/fleet/${unitId}`)} />}
        {view && view.quickCapture.length > 0 && <QuickCapture actions={view.quickCapture} />}
      </main>
    </div>
  );
}
