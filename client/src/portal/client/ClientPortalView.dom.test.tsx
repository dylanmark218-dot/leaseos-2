/**
 * 0175 — The client portal, rendered: each section shows what the server scoped, the dashboard's
 * attention tiles say what waits on the customer, and the billing section labels every figure.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientPortalView } from "./ClientPortalView";
import { fixtureClient } from "./clientFixtures";

afterEach(cleanup);

describe("the client portal", () => {
  it("navigates eleven sections and marks the current one", () => {
    const onSection = vi.fn();
    render(<ClientPortalView {...fixtureClient({ onSection })} />);
    const nav = screen.getByRole("navigation", { name: "Portal sections" });
    expect(nav.querySelectorAll("button")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Open Billing" }));
    expect(onSection).toHaveBeenCalledWith("billing");
  });
  it("shows the dashboard tiles with attention on what waits for the customer", () => {
    render(<ClientPortalView {...fixtureClient()} />);
    const main = within(screen.getByRole("main"));
    expect(main.getByText("Awaiting Your Action").closest("button")).toHaveTextContent("1");
    expect(main.getByText("Outstanding Invoices").closest("button")).toHaveTextContent(/\$4,123\.50 outstanding · 1 disputed/);
    expect(main.getByText("Active Jobs").closest("button")).toHaveTextContent("2");
    expect(main.getByText("Recent Documents").closest("button")).toHaveTextContent("Signed field ticket R1");
  });
  it("lists jobs by bucket, attention first, and opens tracking on selection", () => {
    const onSelectJob = vi.fn();
    render(<ClientPortalView {...fixtureClient({ section: "active", onSelectJob })} />);
    const items = within(screen.getByRole("main")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("#260921-002");   // Attention first
    expect(items[1]).toHaveTextContent("#260921-001");
    expect(screen.queryByText("#260922-001")).toBeNull();   // scheduled is its own section
    fireEvent.click(screen.getByText("#260921-001"));
    expect(onSelectJob).toHaveBeenCalledWith("260921-001");
    cleanup();
    render(<ClientPortalView {...fixtureClient({ section: "scheduled" })} />);
    expect(screen.getByText("#260922-001")).toBeInTheDocument();
    cleanup();
    render(<ClientPortalView {...fixtureClient({ section: "completed" })} />);
    expect(screen.getByText("#260919-003")).toBeInTheDocument();
  });
  it("tracks the selected job with the same projection the link renders", () => {
    render(<ClientPortalView {...fixtureClient({ section: "tracking" })} />);
    expect(screen.getByRole("heading", { level: 2, name: "#260921-001" })).toBeInTheDocument();
    expect(screen.getByText(/Live position · 5 min ago/)).toBeInTheDocument();
    expect(screen.getByText("142").closest("p")).toHaveTextContent(/Truck 142/);
    cleanup();
    render(<ClientPortalView {...fixtureClient({ section: "tracking", jobDetail: null })} />);
    expect(screen.getByText(/Choose a job/)).toBeInTheDocument();
  });
  it("shows loads and only the loads with disposal tickets under Disposal Tickets", () => {
    render(<ClientPortalView {...fixtureClient({ section: "loads" })} />);
    expect(screen.getAllByText(/^Load \d/)).toHaveLength(3);
    cleanup();
    render(<ClientPortalView {...fixtureClient({ section: "disposal" })} />);
    expect(screen.getAllByText(/^Load \d/)).toHaveLength(1);
    expect(screen.getByText(/Disposal ticket SEC-44821 · verified/)).toBeInTheDocument();
  });
  it("lists documents with the record's own number, invoices with overdue named, contacts in three groups", () => {
    const onDownload = vi.fn();
    render(<ClientPortalView {...fixtureClient({ section: "documents", onDownload })} />);
    fireEvent.click(screen.getByRole("button", { name: /Download Signed field ticket R1 \(FT-2026-000001-R1-PDF\)/ }));
    expect(onDownload).toHaveBeenCalledWith("REL-2026-000001");
    cleanup();
    render(<ClientPortalView {...fixtureClient({ section: "invoices" })} />);
    expect(screen.getByText("INV-2026-000004").closest("tr")).toHaveTextContent(/overdue/);
    expect(screen.getByText("INV-2026-000002").closest("tr")).not.toHaveTextContent(/overdue/);
    expect(screen.getAllByText("$1,068.38")).toHaveLength(2);   // total and balance
    cleanup();
    render(<ClientPortalView {...fixtureClient({ section: "contacts" })} />);
    expect(screen.getByText("M. Johnson (you)")).toBeInTheDocument();
    expect(screen.getByText(/R. Patel · site supervisor/)).toBeInTheDocument();
    expect(screen.getByText("R. Patel").closest("li")).toHaveTextContent(/may sign tickets/);
  });
  it("labels every billing figure and offers only the actions the state allows", () => {
    const onTicketAction = vi.fn();
    render(<ClientPortalView {...fixtureClient({ section: "billing", onTicketAction })} />);
    expect(screen.getByText(/Ticket FT-2026-000001 · Job #260921-001/)).toBeInTheDocument();
    expect(screen.getByText(/not an invoice/)).toBeInTheDocument();
    expect(screen.getByText("$1,017.50")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve as shown" }));
    expect(onTicketAction).toHaveBeenCalledWith("FT-2026-000001", "approve");
    expect(screen.getByRole("button", { name: "Dispute" })).toBeInTheDocument();
  });
  it("reports an error as an alert and an empty account plainly", () => {
    render(<ClientPortalView {...fixtureClient({ section: "documents", documents: [], error: "Database unavailable" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.getByText(/No documents have been released/)).toBeInTheDocument();
  });
});
