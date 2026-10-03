/**
 * The Fleet list, as a screen. Props in, DOM out: it shows what the server derived and promotes nothing.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetListView, type FleetListRow } from "./FleetListView";

afterEach(cleanup);
const row = (o: Partial<FleetListRow> = {}): FleetListRow => ({
  unitId: 1, unitNumber: "27", assetClass: "power_unit", assetType: "hydrovac", make: "Kenworth", model: "T880", modelYear: 2021, plate: "ABC 123",
  lifecycleStatus: "active", status: "available", activeHolds: 0, openCriticalDefects: 0, assignedOperatorName: null, ...o,
});
const filters = { status: null, lifecycle: null, assetClass: null, q: "" };

describe("FleetListView", () => {
  it("sorts held and unestablished units above operational ones and shows each state as a word", () => {
    render(<FleetListView state={{ kind: "loaded", rows: [row({ unitId: 1, unitNumber: "A1", status: "available" }), row({ unitId: 2, unitNumber: "B2", status: "out_of_service", activeHolds: 1 }), row({ unitId: 3, unitNumber: "C3", status: "indeterminate" })], total: 3, cap: 100 }} filters={filters} onFilter={() => {}} onOpen={() => {}} />);
    const table = within(screen.getByRole("table"));
    const order = table.getAllByRole("button", { name: /^Unit / }).map(b => b.textContent);
    expect(order).toEqual(["Unit B2", "Unit C3", "Unit A1"]);
    expect(table.getByText("Out of service")).toBeTruthy();
    expect(table.getByText("Not established")).toBeTruthy();
    expect(table.getByText("1 active")).toBeTruthy();
  });
  it("renders a status it does not recognise as Unavailable, and an unclassified unit as unclassified", () => {
    render(<FleetListView state={{ kind: "loaded", rows: [row({ status: "green", assetClass: null, assetType: null })], total: 1, cap: 100 }} filters={filters} onFilter={() => {}} onOpen={() => {}} />);
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Unavailable")).toBeTruthy();
    expect(table.queryByText("Operational")).toBeNull();
    expect(table.getByText("Unclassified")).toBeTruthy();
  });
  it("opens a unit by id, reports a failed read, and says an empty answer is an empty answer", () => {
    const onOpen = vi.fn();
    const { unmount } = render(<FleetListView state={{ kind: "loaded", rows: [row({ unitId: 9 })], total: 1, cap: 100 }} filters={filters} onFilter={() => {}} onOpen={onOpen} />);
    screen.getByRole("button", { name: "Unit 27" }).click();
    expect(onOpen).toHaveBeenCalledWith(9);
    unmount();
    render(<FleetListView state={{ kind: "failed", message: "FORBIDDEN: fleet.read" }} filters={filters} onFilter={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/FORBIDDEN/);
    cleanup();
    render(<FleetListView state={{ kind: "loaded", rows: [], total: 0, cap: 100 }} filters={filters} onFilter={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/not a demonstration/)).toBeTruthy();
  });
});
