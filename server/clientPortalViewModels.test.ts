/**
 * 0175 CP7 — the client portal's view-models, tested in Node.
 */
import { describe, expect, it } from "vitest";
import { contactRows, dashboardTiles, invoiceRows, jobRows, sectionFrom, SECTIONS, ticketRows } from "../client/src/portal/client/clientViewModels";

describe("the client portal's view-models", () => {
  it("names the eleven sections and falls back to the dashboard for anything else", () => {
    expect(SECTIONS).toEqual(["dashboard", "active", "scheduled", "completed", "tracking", "loads", "disposal", "documents", "invoices", "billing", "contacts"]);
    expect(sectionFrom("billing")).toBe("billing");
    expect(sectionFrom(undefined)).toBe("dashboard");
    expect(sectionFrom("admin")).toBe("dashboard");
  });
  it("builds the dashboard tiles in the specified order, with attention on what waits for the customer", () => {
    const tiles = dashboardTiles({ jobs: { active: 2, scheduled: 1, completed: 4, total: 7 }, awaitingCustomerAction: 1, openTickets: 3, invoices: { outstanding: 2, outstandingCents: 412_350, disputed: 1 }, recentDocuments: [] });
    expect(tiles.map(t => t.label)).toEqual(["Active Jobs", "Scheduled Jobs", "Awaiting Your Action", "Open Tickets", "Completed Jobs", "Outstanding Invoices", "Recent Documents"]);
    expect(tiles.filter(t => t.attention).map(t => t.label)).toEqual(["Awaiting Your Action", "Outstanding Invoices"]);
    expect(tiles[5]!.sub).toBe("$4,123.50 outstanding · 1 disputed");
    expect(dashboardTiles({ jobs: { active: 0, scheduled: 0, completed: 0, total: 0 }, awaitingCustomerAction: 0, openTickets: 0, invoices: { outstanding: 0, outstandingCents: 0, disputed: 0 }, recentDocuments: [] }).every(t => !t.attention)).toBe(true);
  });
  it("orders jobs attention first then most recent, tickets awaiting the customer first with one figure each", () => {
    const j = (jobReference: string, label: string, at: string) => ({ jobReference, customerReference: null, serviceType: "x", origin: "o", destination: null, status: { label, basis: "" }, unit: null, lastUpdatedAt: at, bucket: "active" as const });
    expect(jobRows([j("A", "In Progress", "2026-09-24T10:00:00Z"), j("B", "Attention", "2026-09-23T10:00:00Z"), j("C", "In Progress", "2026-09-24T12:00:00Z"), j("D", "On Hold", "2026-09-24T13:00:00Z")]).map(x => x.jobReference)).toEqual(["B", "D", "C", "A"]);
    const rows = ticketRows([
      { jobReference: "J1", ticketNumber: "FT-1", status: "OPEN", accrued: { subtotalCents: 1_000 }, finalized: null, invoiced: null, actions: { approve: false, dispute: false } },
      { jobReference: "J1", ticketNumber: "FT-2", status: "AWAITING_CUSTOMER_REVIEW", accrued: { subtotalCents: 2_000 }, finalized: null, invoiced: null, actions: { approve: true, dispute: true } },
      { jobReference: "J2", ticketNumber: "FT-3", status: "INVOICED", accrued: { subtotalCents: 3_000 }, finalized: { totalCents: 3_000 }, invoiced: { invoiceNumber: "INV-1", totalCents: 3_150 }, actions: { approve: false, dispute: false } },
    ]);
    expect(rows.map(r => [r.ticketNumber, r.status, r.figure, r.needsYou])).toEqual([["FT-2", "Ready for your review", "$20.00", true], ["FT-1", "Open", "$10.00", false], ["FT-3", "Invoiced", "$31.50", false]]);
    expect(rows[1]!.figureLabel).toBe("Estimate so far — not an invoice");
    expect(rows[2]!.figureLabel).toBe("Invoice INV-1");
  });
  it("names an overdue invoice and never a paid one, and groups contacts", () => {
    const rows = invoiceRows([{ invoiceNumber: "I-1", status: "sent", totalCents: 100, balanceCents: 100, dueAt: "2000-01-01T00:00:00Z", issuedAt: null }, { invoiceNumber: "I-2", status: "paid", totalCents: 100, balanceCents: 0, dueAt: "2000-01-01T00:00:00Z", issuedAt: null }, { invoiceNumber: "I-3", status: "sent", totalCents: 100, dueAt: null, issuedAt: null }]);
    expect(rows.map(r => [r.invoiceNumber, r.overdue, r.balance, r.due])).toEqual([["I-1", true, "$1.00", new Date("2000-01-01T00:00:00Z").toLocaleDateString()], ["I-2", false, "$0.00", new Date("2000-01-01T00:00:00Z").toLocaleDateString()], ["I-3", false, "$1.00", "—"]]);
    const c = contactRows({ portalUsers: [{ displayName: "M", email: "m@x", status: "active", you: true }], signatories: [{ name: "R", role: "Sup", maySignTicket: true, mayApproveInvoice: true, status: "active" }, { name: "Old", role: null, maySignTicket: true, mayApproveInvoice: false, status: "revoked" }], jobContacts: [{ jobReference: "J", kind: "consultant", name: "K", email: null, phone: "1" }] });
    expect(c.map(g => [g.group, g.rows.length])).toEqual([["Portal users", 1], ["Signatories on file", 1], ["Job contacts", 1]]);
    expect(c[0]!.rows[0]).toEqual({ name: "M (you)", detail: "m@x · active" });
    expect(c[1]!.rows[0]!.detail).toBe("Sup · may sign tickets · may approve invoices");
    expect(c[2]!.rows[0]).toEqual({ name: "K · consultant", detail: "Job J · 1" });
  });
});
