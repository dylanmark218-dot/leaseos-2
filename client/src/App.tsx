import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import { PortalShell } from "./portal/PortalShell";
import Login from "./pages/Login";
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
import CommunicationsPackage from "./pages/CommunicationsPackage";
import TransmitCheck from "./pages/TransmitCheck";
import CommunicationsPackageStatus from "./pages/CommunicationsPackageStatus";
import RoutePreview from "./pages/RoutePreview";
import AssistantAsk from "./pages/AssistantAsk";
import AssistantCalibration from "./pages/AssistantCalibration";
import TripOperationsWorkspace from "./showcase/TripOperationsWorkspace";
import TrainingAcademy from "./pages/TrainingAcademy";
import DispatchReadiness from "./dispatch/DispatchReadiness";

function DashboardRoute({ children }: { children: ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

function Router() {
  return (
    <Switch>
      {/* The sign-in landing. It starts the existing OAuth flow and
          authenticates nobody itself — see client/src/pages/Login.tsx. */}
      <Route path="/login" component={() => <Login />} />
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
      <Route path="/safety" component={() => <SafetySurface />} />
      {/* v22.20 — communications, on real procedures. Not showcase routes:
          these read sealed packages and the transmit engine, so demonstration
          data here would be indistinguishable from an operational answer. */}
      <Route path="/comms/package" component={() => <CommunicationsPackage />} />
      <Route path="/comms/transmit" component={() => <TransmitCheck />} />
      <Route path="/comms/status" component={() => <CommunicationsPackageStatus />} />
      {/* The dispatcher's readiness panel: read-only, one job, exactly what the gate decided. */}
      <Route path="/dispatch/:jobId">{(p: { jobId: string }) => <DispatchReadiness jobId={Number(p.jobId)} />}</Route>
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
      <Route path="/fleet" component={() => <Redirect to="/showcase/fleet" />} />
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
