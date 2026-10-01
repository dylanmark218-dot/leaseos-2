/**
 * P5.3 — the accessibility suite keeps up with the screens.
 *
 * The suite itself (`client/src/a11y/a11y.dom.test.tsx`) runs the real axe rules. This holds its
 * reach: every component we render under jsdom anywhere in the client is either a surface in that
 * suite or named here with the reason it is not, so a new screen cannot quietly arrive outside
 * the rules. It reads source only; what the rules decide is the suite's business.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const suite = readFileSync("client/src/a11y/a11y.dom.test.tsx", "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

/** Components deliberately outside the suite, and why. */
const NOT_A_SURFACE: Record<string, string> = {
  "client/src/showcase/ShowcaseFrame.tsx": "a banner wrapper with no interactive content of its own; the pages it wraps are the surfaces",
  "client/src/widgets/WidgetContentRenderer.tsx": "renders inside WidgetTileShell, which is a surface; it has no standalone accessible root",
  "client/src/portal/panels/SetupPanel.tsx": "every panel is a live tRPC caller; mounting it here would need a client harness, and the four office-portal screens it drives are covered through CommercialOfficeView",
  "client/src/portal/panels/TimelinePanel.tsx": "a live tRPC caller, as above",
  "client/src/portal/panels/PeopleAccessPanel.tsx": "a live tRPC caller; the screen it renders, PeopleAccessView, is a surface in the suite at every section and in person detail",
  "client/src/portal/panels/MyDayPanel.tsx": "presentational, but reached only through PortalShell's composed view model; covered when the shell is harnessed",
  "client/src/portal/panels/ExceptionsPanel.tsx": "presentational, reached through PortalShell's composed view model, as MyDayPanel",
  "client/src/portal/panels/InboxPanel.tsx": "presentational, reached through PortalShell's composed view model, as MyDayPanel",
  "client/src/portal/PortalShell.tsx": "a live tRPC caller; needs a client harness",
  "client/src/portal/UniversalSearch.tsx": "a live tRPC caller; needs a client harness",
  "client/src/portal/QuickCapture.tsx": "a live tRPC caller; needs a client harness",
  "client/src/portal/SyncIndicator.tsx": "a status chip with no interactive content of its own",
  "client/src/session/SessionGate.tsx": "a live tRPC caller; the three screens it renders — SignInView, WorkspaceChooserView, AccessDeniedView — are each surfaces in the suite",
  "client/src/dispatch/DispatchReadiness.tsx": "the readiness panel's container: a live tRPC caller that resolves the job's assignment and queries the gate; the panel it renders, DispatchReadinessView, is a surface in the suite",
  "client/src/dispatch/DispatchJobDetail.tsx": "the detail screen's container: a live tRPC caller that reads the job, its crew slots and the name lists, writes slot assignments, and composes the readiness panel; the screen it renders, DispatchJobDetailView, is a surface in the suite",
  "client/src/pages/Customers.tsx": "the customers screen's container: a live tRPC caller for the list, the profile, its history and documents; CustomersView is the surface, in eleven states",
  "client/src/pages/Contract.tsx": "the contract screen's container: a live tRPC caller that reads one contract and drives its transitions; ContractView is the surface",
  "client/src/pages/RateSheet.tsx": "the rate sheet screen's container: a live tRPC caller that reads one sheet with every version and drives drafting and approval; RateSheetView is the surface",
  "client/src/portal/panels/FleetPanel.tsx": "the fleet list's container: a live tRPC caller for fleet.list; the screen it renders, FleetListView, is a surface in the suite in three states",
  "client/src/fleet/FleetAssetDetail.tsx": "the asset detail's container: a live tRPC caller that reads one unit and its unit-side readiness and drives holds, lifecycle and components; FleetAssetDetailView is the surface",
  "client/src/commercial/shared.tsx": "a vocabulary of small parts (StatusBadge, StateBlock, HistoryList, TabBar) rendered only inside the three commercial views, which are surfaces",
};

describe("the accessibility suite keeps up with the screens", () => {
  /** Components with a jsdom suite of their own: rendered somewhere, so renderable here. */
  const rendered = walk("client/src")
    .filter(f => f.endsWith(".dom.test.tsx"))
    .flatMap(f => Array.from(readFileSync(f, "utf8").matchAll(/render\(<([A-Z]\w+)/g)).map(m => m[1]!))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  it("renders every component that has a jsdom suite, or the suite would be narrower than our own tests", () => {
    const missing = rendered.filter(c => !new RegExp(`<${c}\\b`).test(suite));
    expect(missing, "components tested under jsdom but never run through the axe rules").toEqual([]);
  });

  it("names every client component it does not treat as a surface, with a reason", () => {
    const components = walk("client/src")
      .filter(f => /\.tsx$/.test(f) && !f.endsWith(".test.tsx") && !/\/(components\/ui|test)\//.test(f) && !/(main|App)\.tsx$/.test(f));
    const uncovered = components.filter(f => {
      const name = f.split("/").pop()!.replace(/\.tsx$/, "");
      return !new RegExp(`<${name}\\b`).test(suite) && !(f in NOT_A_SURFACE);
    });
    // The gap, recorded rather than guessed: client components with no jsdom harness and so no axe run. Layout
    // shells, contexts and full pages need a client harness (a tRPC provider and a router) before they can be
    // rendered here; that harness is the remaining P5.3 work, alongside the Chromium run.
    expect(uncovered.sort(), "a client component that is neither an accessibility surface nor declared as not-a-surface").toEqual([
      "client/src/components/AIChatBox.tsx",
      "client/src/components/DashboardLayout.tsx",
      "client/src/components/DashboardLayoutSkeleton.tsx",
      "client/src/components/ErrorBoundary.tsx",
      "client/src/components/ManusDialog.tsx",
      "client/src/components/Map.tsx",
      "client/src/contexts/ThemeContext.tsx",
      "client/src/hooks/useMobile.tsx",
      "client/src/pages/AssistantAsk.tsx",
      "client/src/pages/AssistantCalibration.tsx",
      "client/src/pages/CommercialOffice.tsx",
      "client/src/pages/CommunicationsPackage.tsx",
      "client/src/pages/CommunicationsPackageStatus.tsx",
      "client/src/pages/ComponentShowcase.tsx",
      "client/src/pages/DisposalDirectory.tsx",
      "client/src/pages/DisposalFinder.tsx",
      "client/src/pages/HosVerificationConsole.tsx",
      "client/src/pages/NotFound.tsx",
      "client/src/pages/RoutePreview.tsx",
      "client/src/pages/TrainingAcademy.tsx",
      "client/src/pages/TransmitCheck.tsx",
      "client/src/pages/WidgetBoardPage.tsx",
      "client/src/pages/authoritative/Surfaces.tsx",
      "client/src/portal/external/AlertsPanel.tsx",
      "client/src/portal/external/ChainOfCustody.tsx",
      "client/src/portal/external/CustomerPortal.tsx",
      "client/src/portal/external/SignOffScreen.tsx",
      "client/src/portal/external/VendorFacilityPortal.tsx",
      "client/src/showcase/BillingSafetyWorkspace.tsx",
      "client/src/showcase/ComplianceEngine.tsx",
      "client/src/showcase/FleetWorkspace.tsx",
      "client/src/showcase/Home.tsx",
      "client/src/showcase/LocationWorkspace.tsx",
      "client/src/showcase/OfflineVault.tsx",
      "client/src/showcase/RouteSafetyWorkspace.tsx",
      "client/src/showcase/TripOperationsWorkspace.tsx",
    ].sort());
  });

  it("gives every excluded component a reason that says something", () => {
    for (const [file, reason] of Object.entries(NOT_A_SURFACE)) expect(reason.length, file).toBeGreaterThan(20);
  });
});
