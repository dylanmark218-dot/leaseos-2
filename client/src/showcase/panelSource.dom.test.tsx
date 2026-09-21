import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { demonstration, fromQuery, isEvidence, sourceLabel } from "./panelSource";
import { SourcedPanel } from "./SourcedPanel";

afterEach(cleanup);

describe("a showcase panel says where its content came from", () => {
  it("counts rows as records, and treats a query that returned nothing as a demonstration with the reason named", () => {
    expect(fromQuery("fieldRoute.routeDecisions.list", [{ id: 1 }, { id: 2 }])).toEqual({ kind: "records", query: "fieldRoute.routeDecisions.list", rows: 2 });
    expect(sourceLabel(fromQuery("x.list", [{ id: 1 }]))).toBe("from records — x.list, 1 row");
    expect(fromQuery("x.list", [])).toEqual({ kind: "demonstration", reason: "x.list returned nothing on this database" });
    expect(fromQuery("x.get", undefined, { whenEmpty: "JOB-08421 is not a job on this database" })).toEqual({ kind: "demonstration", reason: "JOB-08421 is not a job on this database" });
    expect(fromQuery("x.get", { id: 7 })).toMatchObject({ kind: "records", rows: 1 });
  });
  it("refuses a demonstration panel that does not say why, and only records count as evidence", () => {
    expect(() => demonstration("because")).toThrow(/at least ten characters/);
    expect(demonstration("no routing engine result is read on this page").reason).toBe("no routing engine result is read on this page");
    expect(isEvidence(fromQuery("x.list", [{ id: 1 }]))).toBe(true);
    expect(isEvidence(demonstration("laid out to show the shape of the screen"))).toBe(false);
  });
  it("renders the label on the panel, and marks which kind it is for the eye and for a test", () => {
    render(<SourcedPanel title="Route alternatives" source={demonstration("laid out to show the shape of the screen")}><p>body</p></SourcedPanel>);
    expect(screen.getByTestId("panel-route-alternatives").getAttribute("data-panel-source")).toBe("demonstration");
    expect(screen.getByText(/demonstration layout — laid out to show the shape/)).toBeInTheDocument();
    cleanup();
    render(<SourcedPanel title="Saved decisions" source={fromQuery("fieldRoute.routeDecisions.list", [{ id: 1 }, { id: 2 }, { id: 3 }])}><p>body</p></SourcedPanel>);
    expect(screen.getByTestId("panel-saved-decisions").getAttribute("data-panel-source")).toBe("records");
    expect(screen.getByText("from records — fieldRoute.routeDecisions.list, 3 rows")).toBeInTheDocument();
  });
});
