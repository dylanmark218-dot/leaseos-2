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
  // v23.26 — `portals.mine` is gone from the shell: which workspaces this
  // session holds now arrives with the identity and the organization, in one
  // server-authoritative answer, and the switch itself goes through a procedure
  // that refuses a workspace the caller does not hold.
  { file: "PortalShell.tsx", procedures: ["session.selectWorkspace", "surfaces.myDay", "surfaces.exceptions", "surfaces.inbox"], portals: "every_portal" },
  { file: "UniversalSearch.tsx", procedures: ["surfaces.search"], portals: "every_portal" },
  { file: "QuickCapture.tsx", procedures: [], portals: "every_portal" },
  { file: "SyncIndicator.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/MyDayPanel.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/ExceptionsPanel.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/InboxPanel.tsx", procedures: [], portals: "every_portal" },
  { file: "panels/TimelinePanel.tsx", procedures: ["surfaces.timeline"], portals: "every_portal" },
  // 0205/0206 — the Board. Conversations and open work are every portal's: a dispatcher, a
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
    file: "panels/PeopleAccessPanel.tsx",
    procedures: [
      "people.list", "people.roleCatalogue", "people.detail", "people.setRoles",
      "people.setDefaultWorkspace", "people.removeFromOrganization",
      "people.invitations.list", "people.invitations.create", "people.invitations.cancel",
      "people.accessResolution.list", "records.roles.resolveLegacy",
    ],
    portals: ["management"],
    reason:
      "B23.2 — who belongs to this organization and what they may do here. `roles.grant` is held by `management` alone and every procedure re-derives it, so this restriction is about not showing a screen that would refuse; it is not the boundary.",
  },
  {
    file: "panels/FleetPanel.tsx",
    procedures: ["fleet.list"],
    portals: ["fleet_maintenance", "dispatch_operations", "safety_compliance", "office_administration", "management"],
    reason: "0237 — the fleet list is read by the portals that work units; a field portal reads its own assigned units through fleet.myAssignedUnits instead, and the server refuses fleet.read to a driver regardless.",
  },
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
