import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardLayout from "./components/DashboardLayout";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import FleetWorkspace from "./pages/FleetWorkspace";
import LocationWorkspace from "./pages/LocationWorkspace";
import ComplianceEngine from "./pages/ComplianceEngine";
import OfflineVault from "./pages/OfflineVault";
import BillingSafetyWorkspace from "./pages/BillingSafetyWorkspace";
import RouteSafetyWorkspace from "./pages/RouteSafetyWorkspace";
import DisposalDirectory from "./pages/DisposalDirectory";
import TripOperationsWorkspace from "./pages/TripOperationsWorkspace";

function DashboardRoute({ children }: { children: ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/map" component={Home} />
      <Route path="/jobs" component={Home} />
      <Route path="/evidence" component={Home} />
      <Route path="/safety" component={Home} />
      <Route
        path="/fleet"
        component={() => (
          <DashboardRoute>
            <FleetWorkspace />
          </DashboardRoute>
        )}
      />
      <Route
        path="/locations"
        component={() => (
          <DashboardRoute>
            <LocationWorkspace />
          </DashboardRoute>
        )}
      />
      <Route
        path="/compliance-engine"
        component={() => (
          <DashboardRoute>
            <ComplianceEngine />
          </DashboardRoute>
        )}
      />
      <Route
        path="/offline-vault"
        component={() => (
          <DashboardRoute>
            <OfflineVault />
          </DashboardRoute>
        )}
      />
      <Route
        path="/billing-safety"
        component={() => (
          <DashboardRoute>
            <BillingSafetyWorkspace />
          </DashboardRoute>
        )}
      />
      <Route
        path="/route-safety"
        component={() => (
          <DashboardRoute>
            <RouteSafetyWorkspace />
          </DashboardRoute>
        )}
      />
      <Route
        path="/disposal-directory"
        component={() => (
          <DashboardRoute>
            <DisposalDirectory />
          </DashboardRoute>
        )}
      />
      <Route
        path="/trip-operations"
        component={() => (
          <DashboardRoute>
            <TripOperationsWorkspace />
          </DashboardRoute>
        )}
      />
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
