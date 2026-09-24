/**
 * P5.2 — what each portal component may mount.
 *
 * The server already refuses a portal a session does not hold (`portals.panelsFor` answers
 * FORBIDDEN) and the external and machine surfaces are pinned by the 7b/7c gates. What was
 * unstated is the internal half: which procedures a portal component is allowed to call at all,
 * and which portals may mount the component that calls them. A driver's shell has no business
 * holding a finance query, even one that would be refused server-side — the refusal is the last
 * line, not the only one.
 *
 * The contract below is the statement; `panelContract.test.ts` reads the components and fails if
 * their real calls differ from it, so a new call cannot appear in a field portal unnoticed.
 */
export const OFFICE_PORTALS = [
  "office_administration", "finance_billing", "management", "executive", "hr_workforce", "auditor_regulator",
] as const;

export type PortalRestriction = "every_portal" | readonly string[];

export type PanelContract = {
  /** The component file, under client/src/portal/. */
  file: string;
  /** Every procedure it may mount, exactly — no more, no less. */
  procedures: readonly string[];
  /** Which portals may mount it. */
  portals: PortalRestriction;
  /** Why it is restricted, when it is. */
  reason?: string;
};

export const PANEL_CONTRACTS: readonly PanelContract[] = [
  { file: "PortalShell.tsx", procedures: ["portals.mine", "surfaces.myDay", "surfaces.exceptions", "surfaces.inbox"], portals: "every_portal" },
  { file: "UniversalSearch.tsx", procedures: ["surfaces.search"], portals: "every_portal" },
  // The chooser and its neighbouring states are rendered BEFORE a portal is
  // settled, so "every_portal" is the only honest restriction: at the moment it
  // is on screen there is no portal to restrict it to. It calls nothing — every
  // option arrives as a prop from PortalShell's own `portals.mine` — which is
  // what keeps that true rather than merely stated.
  { file: "PortalChooser.tsx", procedures: [], portals: "every_portal" },
  { file: "QuickCapture.tsx", procedures: [], portals: "every_portal" },
  { file: "SyncIndicator.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/MyDayPanel.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/ExceptionsPanel.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/InboxPanel.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/TimelinePanel.tsx", procedures: ["surfaces.timeline"], portals: "every_portal" },
  // 0182/0183 — the Board. Conversations and open work are every portal's: a dispatcher, a
  // mechanic and a driver all message and all see work. The server decides what each may open,
  // post or answer; nothing here is office work.
  {
    file: "panels/BoardPanel.tsx",
    procedures: [
      "auth.me", "board.mine", "board.read", "board.post", "board.acknowledge",
      "shifts.list", "shifts.get", "shifts.respond", "shifts.offerRespond",
    ],
    portals: "every_portal",
  },
  { file: "panels/BoardPanelView.tsx", procedures: [], portals: "every_portal" },
  {
    file: "panels/SetupPanel.tsx",
    procedures: [
      "commercialSetup.profileGet", "commercialSetup.profileSet", "commercialSetup.definitionList",
      "commercialSetup.definitionPropose", "commercialSetup.definitionApprove", "commercialSetup.goLiveReadiness",
      "finance.entitiesList", "finance.entityCreate",
    ],
    portals: OFFICE_PORTALS,
    reason: "commercial setup and the financial entities behind it are office work; a field portal never mounts them",
  },
];

export const contractFor = (file: string): PanelContract | undefined => PANEL_CONTRACTS.find(c => c.file === file);
/** Whether a portal may mount a component. */
export function mayMount(contract: PanelContract, portal: string): boolean {
  return contract.portals === "every_portal" || contract.portals.includes(portal);
}
