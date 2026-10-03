import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import { PortalShell } from "./portal/PortalShell";
import FleetAssetDetail from "./fleet/FleetAssetDetail";
import { SessionGate } from "./session/SessionGate";
import { CustomerPortal } from "./portal/external/CustomerPortal";
import HosVerificationConsole from "./pages/HosVerificationConsole";
import WidgetBoardPage from "./pages/WidgetBoardPage";
import { ShowcaseFrame } from "./showcase/ShowcaseFrame";
import { MapSurface, EvidenceSurface, JobsSurface, SafetySurface } from "./pages/authoritative/Surfaces";
import { VendorFacilityPortal } from "./portal/external/VendorFacilityPortal";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardLayout from "./components/DashboardLayout";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./showcase/Home";
import FleetWorkspace from "./showcase/FleetWorkspace";
import LocationWorkspace from "./showcase/LocationWorkspace";
import ComplianceEngine from "./showcase/ComplianceEngine";
import OfflineVault from "./showcase/OfflineVault";
import BillingSafetyWorkspace from "./showcase/BillingSafetyWorkspace";
import RouteSafetyWorkspace from "./showcase/RouteSafetyWorkspace";
import DisposalDirectory from "./pages/DisposalDirectory";
import DisposalFinder from "./pages/DisposalFinder";
import CommercialOffice from "./pages/CommercialOffice";
import Customers from "./pages/Customers";
import Contract from "./pages/Contract";
import RateSheet from "./pages/RateSheet";
import CommunicationsPackage from "./pages/CommunicationsPackage";
import TransmitCheck from "./pages/TransmitCheck";
import CommunicationsPackageStatus from "./pages/CommunicationsPackageStatus";
import RoutePreview from "./pages/RoutePreview";
import AssistantAsk from "./pages/AssistantAsk";
import AssistantCalibration from "./pages/AssistantCalibration";
import TripOperationsWorkspace from "./showcase/TripOperationsWorkspace";
import TrainingAcademy from "./pages/TrainingAcademy";
import DispatchJobDetail from "./dispatch/DispatchJobDetail";
import FileManager from "./records/FileManager";

function DashboardRoute({ children }: { children: ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

function Router() {
  return (
    <Switch>
      {/* v23.26 — identity first. `/login` is the one screen an anonymous
          caller may reach; `/workspaces` is the chooser a person with more
          than one job sees. Neither is a security boundary: every procedure
          behind them refuses on its own, and `server/sessionWorkspace.db.test.ts`
          makes the calls with no client at all to prove it. */}
      <Route path="/login" component={() => <SessionGate alwaysSignIn />} />
      <Route path="/workspaces" component={() => <SessionGate alwaysChoose />} />
      <Route path="/" component={() => <PortalShell />} />
      {/* v21.7 — the role-composed portal, on the five surfaces. */}
      <Route path="/portal" component={() => <PortalShell />} />
      <Route path="/portal/:portal/*?" component={() => <PortalShell />} />
      {/* v21.13 — the customer's portal, on external procedures only. */}
      <Route path="/customer" component={() => <CustomerPortal />} />
      <Route path="/hos-verification" component={() => <HosVerificationConsole />} />
      <Route path="/widgets" component={() => <WidgetBoardPage />} />
      <Route path="/vendor" component={() => <VendorFacilityPortal />} />
      <Route path="/facility" component={() => <VendorFacilityPortal />} />
      <Route path="/map" component={() => <MapSurface />} />
      <Route path="/jobs" component={() => <JobsSurface />} />
      <Route path="/evidence" component={() => <EvidenceSurface />} />
      {/* The Records & File Manager: browse, inspect and download records the
          server has already decided this caller may see. */}
      <Route path="/records" component={() => <FileManager />} />
      <Route path="/files" component={() => <Redirect to="/records" />} />
      <Route path="/safety" component={() => <SafetySurface />} />
      {/* v22.20 — communications, on real procedures. Not showcase routes:
          these read sealed packages and the transmit engine, so demonstration
          data here would be indistinguishable from an operational answer. */}
      <Route path="/comms/package" component={() => <CommunicationsPackage />} />
      <Route path="/comms/transmit" component={() => <TransmitCheck />} />
      <Route path="/comms/status" component={() => <CommunicationsPackageStatus />} />
      {/* The dispatcher's detail screen: read-only, one job — header, assignment and the readiness the gate decided. */}
      <Route path="/dispatch/:jobId">{(p: { jobId: string }) => <DispatchJobDetail jobId={Number(p.jobId)} />}</Route>
      <Route path="/route/preview" component={() => <RoutePreview />} />
      <Route path="/documents/ask" component={() => <AssistantAsk />} />
      <Route path="/documents/calibration" component={() => <AssistantCalibration />} />
      {/* v22.5.1 — showcase surfaces: demonstration data, mutations refused by the client */}
      <Route path="/showcase" component={() => <ShowcaseFrame title="Home"><Home /></ShowcaseFrame>} />
      <Route path="/showcase/route-safety" component={() => <ShowcaseFrame title="Route safety"><RouteSafetyWorkspace /></ShowcaseFrame>} />
      <Route path="/showcase/locations" component={() => <ShowcaseFrame title="Locations"><LocationWorkspace /></ShowcaseFrame>} />
      <Route path="/showcase/trips" component={() => <ShowcaseFrame title="Trip operations"><TripOperationsWorkspace /></ShowcaseFrame>} />
      <Route path="/showcase/fleet" component={() => <ShowcaseFrame title="Fleet"><FleetWorkspace /></ShowcaseFrame>} />
      <Route path="/showcase/billing-safety" component={() => <ShowcaseFrame title="Billing and safety"><BillingSafetyWorkspace /></ShowcaseFrame>} />
      <Route path="/showcase/compliance-engine" component={() => <ShowcaseFrame title="Compliance engine"><ComplianceEngine /></ShowcaseFrame>} />
      <Route path="/showcase/offline-vault" component={() => <ShowcaseFrame title="Offline vault"><OfflineVault /></ShowcaseFrame>} />
      {/* 0237 — the authoritative Fleet surface: the portal's Fleet panel, and one unit by id. The deep
          link the server already emits (`/portal/fleet_maintenance/units/:id`) lands here too. The
          former demonstration stays under /showcase/fleet. */}
      <Route path="/fleet" component={() => <PortalShell initialPanel="fleet" />} />
      <Route path="/fleet/:unitId">{(p: { unitId: string }) => <FleetAssetDetail unitId={Number(p.unitId)} />}</Route>
      <Route path="/portal/:portal/units/:unitId">{(p: { unitId: string }) => <FleetAssetDetail unitId={Number(p.unitId)} />}</Route>
      <Route path="/locations" component={() => <Redirect to="/showcase/locations" />} />
      <Route path="/compliance-engine" component={() => <Redirect to="/showcase/compliance-engine" />} />
      <Route path="/offline-vault" component={() => <Redirect to="/showcase/offline-vault" />} />
      <Route path="/billing-safety" component={() => <Redirect to="/showcase/billing-safety" />} />
      <Route path="/route-safety" component={() => <Redirect to="/showcase/route-safety" />} />
      <Route
        path="/disposal-directory"
        component={() => (
          <DashboardRoute>
            <DisposalDirectory />
          </DashboardRoute>
        )}
      />
      <Route
        path="/disposal-finder"
        component={() => (
          <DashboardRoute>
            <DisposalFinder />
          </DashboardRoute>
        )}
      />
      <Route
        path="/commercial-office"
        component={() => (
          <DashboardRoute>
            <CommercialOffice />
          </DashboardRoute>
        )}
      />
      <Route path="/customers" component={() => <DashboardRoute><Customers /></DashboardRoute>} />
      <Route path="/customers/:accountRef">{(p: { accountRef: string }) => <DashboardRoute><Customers accountRef={p.accountRef} /></DashboardRoute>}</Route>
      <Route path="/contracts/:contractRef">{(p: { contractRef: string }) => <DashboardRoute><Contract contractRef={p.contractRef} /></DashboardRoute>}</Route>
      <Route path="/rate-sheets/:rateSheetRef">{(p: { rateSheetRef: string }) => <DashboardRoute><RateSheet rateSheetRef={p.rateSheetRef} /></DashboardRoute>}</Route>
      <Route path="/trip-operations" component={() => <Redirect to="/showcase/trips" />} />
      <Route path="/training-academy" component={() => <DashboardRoute><TrainingAcademy /></DashboardRoute>} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="top-right" />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
