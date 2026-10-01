/**
 * The Asset Detail screen. It shows what the server said about one unit and offers the recorded acts;
 * a FORBIDDEN answer withdraws a control and shows the reason. It never promotes a unit.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetAssetDetailView, type Actions, type AssetDetail } from "./FleetAssetDetailView";

afterEach(cleanup);
const detail = (o: Partial<AssetDetail> = {}): AssetDetail => ({
  identity: { unitId: 7, unitNumber: "27", assetClass: "power_unit", assetType: "hydrovac", assetSubtype: null, vehicleType: "hydrovac", vin: "1XK", serialNumber: null, plate: "ABC 123", plateJurisdiction: "AB", make: "Kenworth", model: "T880", modelYear: 2021, manufacturer: null, ownershipType: "owned", acquiredAt: null, homeTerminal: "Red Deer", assignedBranchRef: null, assignedDivision: null, regulatoryClass: null, companyAssetNumber: null, notes: null },
  lifecycle: { status: "active", changedAt: null, reason: null, retiredAt: null },
  state: { status: "out_of_service", reasons: [{ code: "hold_safety", status: "out_of_service", category: "safety", label: "Steering box leaking", source: { table: "unitHolds", ref: "HOLD-1" }, since: "2026-09-25T00:00:00Z", liftedBy: "fleet.holdRelease" }], restrictions: [], since: "2026-09-25T00:00:00Z", notEvaluated: [{ domain: "documents_and_insurance", reason: "decided at dispatch" }] },
  driverNotice: "Out of service — do not operate: Steering box leaking",
  readiness: { verdict: "blocked", findings: [{ code: "unit_hold_safety", label: "Unit 27 — safety hold", severity: "blocking", subject: "truck", overrideClass: "NEVER_OVERRIDABLE" }], notEvaluated: [{ axis: "operator", reason: "no driver" }, { axis: "job", reason: "no job" }, { axis: "route", reason: "no route" }] },
  assignment: { operatorName: "D. Reid", jobCode: "JOB-1" },
  holds: [{ holdRef: "HOLD-1", holdType: "safety", dispatchEffect: "out_of_service", reason: "Steering box leaking", status: "active", placedAt: "2026-09-25T00:00:00Z", placedByRole: "safety", sourceKind: "manual" }],
  components: [{ componentRef: "CMP-1", direction: "attached", otherUnitId: 9, otherUnitNumber: "VAC-9", relationship: "mounted", removable: false, installedAt: "2026-09-01T00:00:00Z", removedAt: null, criticalDefectOpen: true }],
  meters: [{ meterType: "odometer_km", trust: "trusted", current: { value: 100500, recordedAt: "2026-09-04T00:00:00Z", source: "trip" } }],
  documents: [{ id: 1, docType: "cvip_certificate", title: "CVIP 2026", identifier: "C-1", issuedAt: null, expiresAt: "2027-01-01T00:00:00Z", verificationStatus: "verified", validity: "in_force" }],
  insurance: { status: "coverage_verified", reason: "Policy P-1 in force" },
  defects: [], workOrders: [], inspections: [], events: [],
  ...o,
});
const actions = (o: Partial<Actions> = {}): Actions => ({ forbidden: {}, placeHold: vi.fn(), releaseHold: vi.fn(), setLifecycle: vi.fn(), detachComponent: vi.fn(), busy: null, lastError: null, ...o });

describe("FleetAssetDetailView", () => {
  it("shows the unit's state as the server derived it, the reasons with the act that lifts each, and the unit-side verdict labelled as not a dispatch verdict", () => {
    render(<FleetAssetDetailView state={{ kind: "loaded", detail: detail() }} actions={actions()} />);
    expect(screen.getByText("Out of service")).toBeTruthy();
    expect(screen.getByText(/do not operate/)).toBeTruthy();
    expect(screen.getByText(/lifted by fleet.holdRelease/)).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText(/not a dispatch verdict/)).toBeTruthy();
    expect(screen.getByText(/Not evaluated here: operator, job, route/)).toBeTruthy();
    expect(screen.getByText(/Driver: D. Reid/)).toBeTruthy();
  });
  it("withdraws a control the server refused and shows the reason; offers it otherwise", () => {
    const a = actions({ forbidden: { placeHold: "FORBIDDEN: fleet.hold.place" } });
    render(<FleetAssetDetailView state={{ kind: "loaded", detail: detail() }} actions={a} />);
    expect(screen.queryByRole("button", { name: "Place hold" })).toBeNull();
    expect(screen.getByText("FORBIDDEN: fleet.hold.place")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record lifecycle change" })).toBeTruthy();
  });
  it("records a lifecycle change with its reason and never without one", () => {
    const a = actions();
    render(<FleetAssetDetailView state={{ kind: "loaded", detail: detail() }} actions={a} />);
    const button = screen.getByRole("button", { name: "Record lifecycle change" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Lifecycle to"), { target: { value: "retired" } });
    fireEvent.change(screen.getByLabelText("Lifecycle reason"), { target: { value: "Frame cracked beyond repair" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(a.setLifecycle).toHaveBeenCalledWith({ to: "retired", reason: "Frame cracked beyond repair" });
  });
  it("renders an unrecognised state as Unavailable, and a failed read as an alert", () => {
    render(<FleetAssetDetailView state={{ kind: "loaded", detail: detail({ state: { status: "ok", reasons: [], restrictions: [], since: null, notEvaluated: [] }, readiness: null }) }} actions={actions()} />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("Operational")).toBeNull();
    cleanup();
    render(<FleetAssetDetailView state={{ kind: "failed", message: "Unit 99 not found" }} actions={actions()} />);
    expect(screen.getByRole("alert").textContent).toBe("Unit 99 not found");
  });
  it("shows a component's critical defect on the Equipment tab and offers detach", () => {
    render(<FleetAssetDetailView state={{ kind: "loaded", detail: detail() }} actions={actions()} initialTab="Equipment" />);
    expect(screen.getByText(/Carries unit VAC-9/)).toBeTruthy();
    expect(screen.getByText(/critical defect open on the component/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detach" })).toBeTruthy();
  });
});
