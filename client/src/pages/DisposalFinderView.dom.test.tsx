import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import { DisposalFinderView, type DisposalFinderViewProps, type DriverViewData } from "./DisposalFinderView";

const site = (k: string, extra: Partial<DisposalFinderViewProps["result"] extends infer R ? R extends { outcome: "located"; facilities: (infer S)[] } ? S : never : never> = {}) => ({
  facilityKey: k, name: `Site ${k}`, municipality: "Edson", province: "AB", facilityType: "trd", distanceKm: 1.4, coordinatePrecision: "approximate_site", routable: false, phone: "780-723-1912", dispatchPhone: null, afterHoursPhone: null, websiteUrl: null,
  commercialAccess: "commercial_preapproval_required", lifecycle: "operating", legalLocation: "07-18-053-18 W5M", distanceNote: "distance to the LSD centre or regulator site point, ±2 km, not the gate", ...extra,
});
const view = (overrides: Partial<DriverViewData> = {}): DriverViewData => ({
  facility: { name: "Site a", coordinatePrecision: "approximate_site", routable: false, commercialAccess: "commercial_preapproval_required", lifecycle: "operating", legalLocation: "07-18-053-18 W5M", physicalAddress: null, regulatorRef: null, preapprovalRequired: null, manifestRequired: null, normAccepted: null, sourAccepted: null, twentyFourHourCallout: null },
  contact: { phone: "780-723-1912", dispatchPhone: "1-855-591-5360", afterHoursPhone: null, email: null, websiteUrl: null, gateInstructions: null },
  links: { call: "tel:7807231912", googleDirections: null, appleDirections: null, website: null },
  warnings: ["Coordinates are not a verified entrance — no directions link"],
  hoursToday: { state: "unknown", note: "No hours on file — call ahead" },
  currentWait: { state: "unknown", note: "No wait report in the last 6 hours — call ahead" },
  callAhead: { state: "none_valid", note: "No valid call-ahead acceptance — call before travelling" },
  accepts: [], ...overrides,
});
const props = (overrides: Partial<DisposalFinderViewProps> = {}): DisposalFinderViewProps => ({
  lsd: "07-18-053-18 W5M", onLsdChange: vi.fn(), wasteCode: "", onWasteCodeChange: vi.fn(), wasteCodes: ["produced_water", "hydrovac_slurry"], onFind: vi.fn(), finding: false,
  result: { outcome: "located", origin: { latitude: 53.558, longitude: -116.613, basis: "theoretical", descriptor: "07-18-053-18 W5M", note: "the ATS grid for this township is not imported; theoretical DLS centroid, ±2 km" }, facilities: [site("a"), site("b", { lifecycle: "conflicting", lifecycleNote: "sources disagree on whether this site operates", distanceKm: 40 })], note: "Distances are straight-line from the theoretical centroid. Routes come from the spatial engine; call ahead before travelling." },
  selectedKey: "a", onSelect: vi.fn(), view: view(), viewLoading: false, onCallAhead: vi.fn(), callAheadBusy: false, onWaitReport: vi.fn(), waitBusy: false, ...overrides,
});

describe("DisposalFinderView", () => {
  it("says where the origin came from, lists sites with their precision and conflict, and shows no directions for an unverified site", () => {
    render(<DisposalFinderView {...props()} />);
    expect(screen.getByTestId("origin-note").textContent).toContain("theoretical centroid, ±2 km");
    expect(screen.getByTestId("site-a").textContent).toContain("±2 km");
    expect(screen.getByTestId("site-b").textContent).toContain("sources disagree");
    expect(screen.getByTestId("no-directions")).toBeInTheDocument();
    expect(screen.queryByText("Directions")).not.toBeInTheDocument();
    expect(screen.getByTestId("wait").textContent).toContain("call ahead");
  });
  it("offers directions only when the server did, and shows the current wait and call-ahead when they exist", () => {
    render(<DisposalFinderView {...props({ view: view({ links: { call: "tel:1", googleDirections: "https://www.google.com/maps/dir/?api=1&destination=53.6,-116.4", appleDirections: null, website: null }, warnings: [], currentWait: { state: "reported", waitMinutes: 20, trucksInQueue: 3, ageMinutes: 12, source: "facility_stated" }, callAhead: { callAheadRef: "CALL-1", outcome: "accepted", spokeTo: "Dana at the scale", conditions: null, validUntil: null } }) })} />);
    expect(screen.getByText("Directions")).toBeInTheDocument();
    expect(screen.getByTestId("wait").textContent).toContain("20 min, 3 trucks");
    expect(screen.getByTestId("call-ahead-state").textContent).toContain("Dana at the scale");
  });
  it("refuses to save an acceptance without who at the facility said so, and sends the draft once it is complete", () => {
    const onCallAhead = vi.fn();
    render(<DisposalFinderView {...props({ onCallAhead })} />);
    const save = screen.getByTestId("save-call-ahead");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Who at the facility"), { target: { value: "Dana at the scale" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onCallAhead).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted", spokeTo: "Dana at the scale" }));
    fireEvent.change(screen.getByLabelText("Call outcome"), { target: { value: "accepted_with_conditions" } });
    expect(screen.getByTestId("save-call-ahead")).toBeDisabled();   // conditions now required
  });
  it("shows the reason when the description is invalid", () => {
    render(<DisposalFinderView {...props({ result: { outcome: "invalid", reason: "An LSD reads LSD-SEC-TWP-RGE-W#M, for example 10-22-045-06-W5" }, view: null, selectedKey: null })} />);
    expect(screen.getByRole("alert").textContent).toContain("LSD-SEC-TWP-RGE");
  });
});
