/**
 * PortalShell — one shell, role-composed.
 *
 * The same backend; a different first screen per portal. The shell reads
 * `portals.mine` for which portals this session holds, then the five surfaces
 * — My Day, Exceptions, Inbox, Search, Timeline — all of which the server
 * already filters to what the caller may see or act on. The shell decides
 * nothing about permission; it renders what it is given.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { composeMyDayView, composeOfficeView, contextRibbon, exceptionIndicator, switcherModel, PORTAL_LABELS, type PortalKey } from "./viewModels";
import { isHeldPortal, resolvePortalEntry } from "./entryModel";
import { NoPortalAvailable, OrganizationSelectionRequired, PortalChooser, type ChooserOption } from "./PortalChooser";
import { MyDayPanel } from "./panels/MyDayPanel";
import { ExceptionsPanel } from "./panels/ExceptionsPanel";
import { InboxPanel } from "./panels/InboxPanel";
import { TimelinePanel } from "./panels/TimelinePanel";
import { SetupPanel } from "./panels/SetupPanel";
import { BoardPanel } from "./panels/BoardPanel";
import { UniversalSearch } from "./UniversalSearch";
import { SyncIndicator } from "./SyncIndicator";
import { QuickCapture } from "./QuickCapture";

export type PanelKey = "myday" | "exceptions" | "inbox" | "board" | "timeline" | "setup";

const OFFICE_PORTALS = new Set<PortalKey>(["office_administration", "finance_billing", "management", "executive", "hr_workforce", "auditor_regulator"]);

export function PortalShell({ initialPanel = "myday", displayName = null }: { initialPanel?: PanelKey; displayName?: string | null }) {
  const [, navigate] = useLocation();
  const [panel, setPanel] = useState<PanelKey>(initialPanel);
  const [portalOverride, setPortalOverride] = useState<PortalKey | null>(null);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  // v21.9.1 — subscribe; a value read once at mount is wrong the moment the truck leaves coverage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  const session = trpc.portals.mine.useQuery();
  const myDay = trpc.surfaces.myDay.useQuery(undefined, { refetchInterval: 60_000 });
  const exceptions = trpc.surfaces.exceptions.useQuery({ limit: 200 }, { refetchInterval: 60_000 });
  const inbox = trpc.surfaces.inbox.useQuery(undefined, { refetchInterval: 60_000 });

  const held = useMemo(() => (session.data?.portals ?? []).map(p => p.portal as PortalKey), [session.data]);

  // The `:portal` segment of /portal/:portal. It used to be routed and never
  // read, so a deep link silently landed people wherever defaultPortal chose.
  // It is an input like any other: checked against the held set, never trusted.
  const [, routeParams] = useRoute("/portal/:portal/*?");
  const requested = routeParams?.portal ?? null;

  const organization = session.data?.organization ?? null;
  const savedDefault =
    organization && organization.state !== "ambiguous" && organization.state !== "unresolved"
      ? organization.defaultWorkspace
      : null;

  const entry = useMemo(
    () => resolvePortalEntry({ held, savedDefault, requested, notReached: session.data?.notReached ?? [] }),
    [held, savedDefault, requested, session.data]
  );

  // An override can only ever name a portal this session holds: it is set from
  // the switcher, which is built from `held`, and re-checked here so that stays
  // true however the switcher changes.
  const overridden = isHeldPortal(portalOverride, held) ? portalOverride : null;
  const portal = overridden ?? (entry.kind === "enter" ? entry.portal : null);
  const switcher = switcherModel(held, portal);

  const describe = (key: string): ChooserOption => {
    const surface = (session.data?.portals ?? []).find(p => p.portal === key);
    return {
      portal: key,
      displayName: surface?.displayName ?? PORTAL_LABELS[key as PortalKey] ?? key,
      purpose: surface?.purpose ?? "",
    };
  };

  const view = useMemo(() => {
    if (!portal || !myDay.data) return null;
    return composeMyDayView({ myDay: myDay.data as never, exceptions: (exceptions.data?.items ?? []) as never, portal, now: new Date(), displayName });
  }, [portal, myDay.data, exceptions.data, displayName]);
  const officeView = useMemo(() => composeOfficeView((exceptions.data?.items ?? []) as never, (inbox.data?.items ?? []) as never), [exceptions.data, inbox.data]);
  const indicator = exceptionIndicator(myDay.data?.attention ?? { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {}, headline: "" });
  const ribbon = portal ? contextRibbon({ portal, assignment: view?.assignment ?? null, online, deviceStatus: null }) : [];

  const go = (link: { portal: string; route: string }) => navigate(`/portal/${link.portal}${link.route}`);

  if (session.isLoading) return <div className="p-8 text-sm text-[#5b6b82]">Composing your portal…</div>;

  // Two live memberships and no way to choose. resolveActingScope refuses this
  // rather than picking one; the screen says so rather than rendering a fault.
  if (organization?.state === "ambiguous") {
    return <OrganizationSelectionRequired detail={organization.detail} />;
  }

  if (entry.kind === "none" && !overridden) {
    return <NoPortalAvailable notReached={entry.notReached.map(describe)} />;
  }

  if (!portal && entry.kind === "choose") {
    return (
      <PortalChooser
        options={entry.options.map(describe)}
        notReached={(session.data?.notReached ?? []).map(describe)}
        rejectedDefault={entry.rejectedDefault}
        rejectedRequest={entry.rejectedRequest ?? null}
        onChoose={key => { setPortalOverride(key as PortalKey); navigate(`/portal/${key}`); }}
      />
    );
  }

  if (!portal) return <NoPortalAvailable notReached={(session.data?.notReached ?? []).map(describe)} />;

  return (
    <div className="min-h-screen bg-[#f6f8fb] text-[#172033]">
      <header className="sticky top-0 z-10 border-b border-[#dfe5ee] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <nav aria-label="Portals" className="flex flex-wrap gap-1">
            {switcher.map(s => (
              <button key={s.key} onClick={() => setPortalOverride(s.key)} aria-current={s.current ? "page" : undefined}
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
          {(["myday", "exceptions", "inbox", "board", "timeline", ...(OFFICE_PORTALS.has(portal) ? ["setup" as PanelKey] : [])] as PanelKey[]).map(p => (
            <button key={p} onClick={() => setPanel(p)} className={`rounded-lg px-3 py-1 ${panel === p ? "bg-white shadow" : "text-[#5b6b82]"}`}>{p === "myday" ? "My Day" : p[0]!.toUpperCase() + p.slice(1)}</button>
          ))}
        </div>
        {panel === "myday" && view && (OFFICE_PORTALS.has(portal) ? <MyDayPanel view={view} office={officeView} onGo={go} /> : <MyDayPanel view={view} onGo={go} />)}
        {panel === "exceptions" && <ExceptionsPanel items={(exceptions.data?.items ?? []) as never} summary={myDay.data?.attention as never} onGo={go} />}
        {panel === "inbox" && <InboxPanel items={(inbox.data?.items ?? []) as never} counts={inbox.data?.counts ?? {}} onGo={go} />}
        {/* 0182/0183 — conversations and open work; writes go through the device's board queue. */}
        {panel === "board" && <BoardPanel online={online} />}
        {panel === "timeline" && <TimelinePanel />}
        {panel === "setup" && OFFICE_PORTALS.has(portal) && <SetupPanel />}
        {view && view.quickCapture.length > 0 && <QuickCapture actions={view.quickCapture} />}
      </main>
    </div>
  );
}
