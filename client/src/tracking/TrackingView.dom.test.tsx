/**
 * 0175 — The tracking page, rendered. What a recipient sees for each state, and what the page never
 * shows even when handed it: a stale fix is named stale, an estimate is never called an invoice, and
 * a refused link says why without saying whether a job exists.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackingView } from "./TrackingView";
import { fixtureLoaded, fixtureStatus, fixtureTicket } from "./trackingFixtures";

afterEach(cleanup);

describe("the tracking page", () => {
  it("shows the job, its status, the timeline, the unit, the loads, the documents and the ticket figures each labelled", () => {
    render(<TrackingView state={fixtureLoaded()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("#260921-001");
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);   // the status chip and the timeline step
    expect(screen.getByText("For R. Patel")).toBeInTheDocument();
    expect(screen.getByText("142").closest("p")).toHaveTextContent(/Truck 142 · hydrovac/);
    expect(screen.getByText("Operator Jane")).toBeInTheDocument();
    expect(screen.getByText(/Live position · 5 min ago/)).toBeInTheDocument();
    expect(screen.getByText("3 total · 1 completed · 2 active")).toBeInTheDocument();
    expect(screen.getByText(/Disposal ticket SEC-44821 · verified/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download Signed field ticket R1/ })).toBeInTheDocument();
    expect(screen.getByText("$1,017.50")).toBeInTheDocument();
    expect(screen.getAllByText(/not an invoice/).length).toBeGreaterThanOrEqual(1);   // the estimate label and the footer
    expect(screen.getByText("not yet priced")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review ticket" })).toBeInTheDocument();
    expect(screen.getByText(/FT-2026-000001 · Ready for your review/)).toBeInTheDocument();
  });
  it("names a stale position as stale and never as live, and says when live tracking has ended", () => {
    render(<TrackingView state={fixtureLoaded({ status: fixtureStatus({ location: { mode: "live", position: { latitude: 53.12, longitude: -116.65, precision: "approximate" }, recordedAt: "2026-09-24T12:00:00Z", ageMinutes: 60, stale: true, note: "stale" } }) })} />);
    expect(screen.getByText(/Last known position — stale \(60 min ago\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Live position/)).toBeNull();
    cleanup();
    render(<TrackingView state={fixtureLoaded({ status: fixtureStatus({ live: { available: false, reason: "live tracking ended 24 h after completion", until: null }, eta: null, location: { mode: "live", position: null, recordedAt: null, ageMinutes: null, stale: false, note: "Live tracking has ended for this link; documents and the ticket remain available" } }) })} />);
    expect(screen.getByText(/Live tracking has ended for this link \(live tracking ended 24 h after completion\)/)).toBeInTheDocument();
    expect(screen.getByText("Location not shared")).toBeInTheDocument();
  });
  it("distinguishes the estimate, the finalized total and the invoice", () => {
    render(<TrackingView state={fixtureLoaded({ tickets: [fixtureTicket({ status: "INVOICED", accrued: { subtotalCents: 101_750, pricedLines: 2, unpricedLines: 1, label: "Accrued before finalization — see the finalized total" }, finalized: { totalCents: 101_750, at: "2026-09-24T14:00:00Z", label: "Finalized ticket total, before taxes" }, invoiced: { invoiceNumber: "INV-2026-000009", status: "sent", subtotalCents: 101_750, taxCents: 5_088, totalCents: 106_838 }, actions: { acknowledge: false, approve: false, dispute: false, comment: false, sign: false } })] })} />);
    expect(screen.getByText(/Invoice INV-2026-000009 \(sent\)/)).toBeInTheDocument();
    expect(screen.getByText("$1,068.38")).toBeInTheDocument();
    expect(screen.getByText("Finalized ticket total, before taxes")).toBeInTheDocument();
    expect(screen.getByText(/Accrued before finalization/)).toBeInTheDocument();
    expect(screen.queryByText(/Estimated subtotal/)).toBeNull();
    expect(screen.getByText(/FT-2026-000001 · Invoiced/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review ticket" })).toBeNull();
  });
  it("hides the unit and operator when the link says so, and shows nothing private it was never given", () => {
    const { container } = render(<TrackingView state={fixtureLoaded({ status: fixtureStatus({ unit: null, operatorDisplayName: null, customerReference: null }) })} />);
    expect(screen.getByText("Unit identity not shared")).toBeInTheDocument();
    expect(screen.queryByText(/Operator/)).toBeNull();
    for (const forbidden of ["780-555", "licence", "license", "HOS", "payroll", "cost", "note"]) expect(container.textContent).not.toMatch(new RegExp(forbidden, "i"));
  });
  it("refuses in the recipient's words, naming the reason and never a job", () => {
    for (const [message, headline] of [["This tracking link has been revoked", "This link has been revoked"], ["This tracking link has expired", "This link has expired"], ["This tracking link was replaced — ask for the current one", "This link was replaced"], ["Unknown tracking link", "This link cannot be opened"], [null, "This link cannot be opened"]] as const) {
      cleanup();
      const { container } = render(<TrackingView state={{ kind: "refused", message }} />);
      expect(screen.getByRole("alert")).toHaveTextContent(headline);
      expect(container.textContent).not.toMatch(/JOB-|260921/);
    }
  });
  it("downloads through the callback and reports a failure as an alert", () => {
    const onDownload = vi.fn();
    render(<TrackingView state={fixtureLoaded()} onDownload={onDownload} error="Stored document does not match its recorded hash — not served" />);
    fireEvent.click(screen.getByRole("button", { name: /Download Signed field ticket R1/ }));
    expect(onDownload).toHaveBeenCalledWith("REL-2026-000001");
    expect(screen.getByRole("alert")).toHaveTextContent(/not served/);
  });
  it("shows a loading status while the link resolves", () => {
    render(<TrackingView state={{ kind: "loading" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Opening your tracking link/);
  });
});
