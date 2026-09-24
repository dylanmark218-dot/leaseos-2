/**
 * 0175 — The client portal's view-models: pure, tested in Node. The shell renders these and decides
 * nothing about permission; every list arrives already scoped by the server.
 */
import { money } from "../../tracking/trackingViewModels";

export const SECTIONS = ["dashboard", "active", "scheduled", "completed", "tracking", "loads", "disposal", "documents", "invoices", "billing", "contacts"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
  dashboard: "Dashboard", active: "Active Jobs", scheduled: "Scheduled Jobs", completed: "Completed Jobs", tracking: "Job Tracking", loads: "Loads", disposal: "Disposal Tickets",
  documents: "Documents", invoices: "Invoices", billing: "Open Billing", contacts: "Contacts",
};

/** The URL segment → section, defaulting to the dashboard; anything unknown is the dashboard rather than an error. */
export function sectionFrom(segment: string | null | undefined): Section {
  return (SECTIONS as readonly string[]).includes(segment ?? "") ? (segment as Section) : "dashboard";
}

export type DashboardInput = {
  jobs: { active: number; scheduled: number; completed: number; total: number };
  awaitingCustomerAction: number;
  openTickets: number;
  invoices: { outstanding: number; outstandingCents: number; disputed: number };
  recentDocuments: readonly { releaseRef: string; documentRef: string; title: string; kind: string; releasedAt: string | Date; jobReference: string | null }[];
};

export type Tile = { section: Section; label: string; value: string; sub: string | null; attention: boolean };

/** The dashboard's tiles, in the order the specification lists them. Attention is what waits on the customer. */
export function dashboardTiles(d: DashboardInput): Tile[] {
  return [
    { section: "active", label: "Active Jobs", value: String(d.jobs.active), sub: null, attention: false },
    { section: "scheduled", label: "Scheduled Jobs", value: String(d.jobs.scheduled), sub: null, attention: false },
    { section: "billing", label: "Awaiting Your Action", value: String(d.awaitingCustomerAction), sub: d.awaitingCustomerAction ? "tickets to review" : null, attention: d.awaitingCustomerAction > 0 },
    { section: "billing", label: "Open Tickets", value: String(d.openTickets), sub: null, attention: false },
    { section: "completed", label: "Completed Jobs", value: String(d.jobs.completed), sub: null, attention: false },
    { section: "invoices", label: "Outstanding Invoices", value: String(d.invoices.outstanding), sub: d.invoices.outstanding ? `${money(d.invoices.outstandingCents)} outstanding${d.invoices.disputed ? ` · ${d.invoices.disputed} disputed` : ""}` : null, attention: d.invoices.disputed > 0 },
    { section: "documents", label: "Recent Documents", value: String(d.recentDocuments.length), sub: d.recentDocuments[0] ? `${d.recentDocuments[0].title}` : null, attention: false },
  ];
}

export type JobRow = { jobReference: string; customerReference: string | null; serviceType: string; origin: string; destination: string | null; status: { label: string; basis: string }; unit: { unitNumber: string } | null; lastUpdatedAt: string | Date; bucket: "active" | "scheduled" | "completed" };

/** Jobs ordered for a client: attention first, then most recently updated. */
export function jobRows(jobs: readonly JobRow[]): JobRow[] {
  const rank = (s: string) => (s === "Attention" ? 0 : s === "On Hold" ? 1 : s === "Completed" || s === "Cancelled" ? 3 : 2);
  return [...jobs].sort((a, b) => rank(a.status.label) - rank(b.status.label) || new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
}

export type TicketRow = { jobReference: string; ticketNumber: string; status: string; accrued: { subtotalCents: number }; finalized: { totalCents: number } | null; invoiced: { invoiceNumber: string; totalCents: number } | null; actions: { approve: boolean; dispute: boolean } };

/** Tickets that wait on the customer first; each with the one figure that applies to its stage. */
export function ticketRows(tickets: readonly TicketRow[]): { jobReference: string; ticketNumber: string; status: string; figure: string; figureLabel: string; needsYou: boolean }[] {
  const label: Record<string, string> = { DRAFT: "Draft", OPEN: "Open", AWAITING_CUSTOMER_REVIEW: "Ready for your review", CUSTOMER_ACCEPTED: "Accepted", DISPUTED: "Disputed", FINALIZED: "Finalized", INVOICED: "Invoiced", VOID: "Void" };
  return [...tickets].sort((a, b) => Number(b.actions.approve) - Number(a.actions.approve)).map(t => ({
    jobReference: t.jobReference, ticketNumber: t.ticketNumber, status: label[t.status] ?? t.status, needsYou: t.actions.approve,
    figure: t.invoiced ? money(t.invoiced.totalCents) : t.finalized ? money(t.finalized.totalCents) : money(t.accrued.subtotalCents),
    figureLabel: t.invoiced ? `Invoice ${t.invoiced.invoiceNumber}` : t.finalized ? "Finalized total, before taxes" : "Estimate so far — not an invoice",
  }));
}

export type InvoiceRow = { invoiceNumber: string; status: string; totalCents: number; balanceCents?: number; dueAt: string | Date | null; issuedAt: string | Date | null };

export function invoiceRows(invoices: readonly InvoiceRow[]): { invoiceNumber: string; status: string; total: string; balance: string; due: string; overdue: boolean }[] {
  const now = Date.now();
  return invoices.map(i => ({ invoiceNumber: i.invoiceNumber, status: i.status.replace(/_/g, " "), total: money(i.totalCents), balance: money(i.balanceCents ?? i.totalCents), due: i.dueAt ? new Date(i.dueAt).toLocaleDateString() : "—", overdue: !!i.dueAt && new Date(i.dueAt).getTime() < now && i.status !== "paid" }));
}

export type ContactsInput = { portalUsers: readonly { displayName: string; email: string; status: string; you: boolean }[]; signatories: readonly { name: string; role: string | null; maySignTicket: boolean; mayApproveInvoice: boolean; status: string }[]; jobContacts: readonly { jobReference: string | null; kind: string | null; name: string | null; email: string | null; phone: string | null }[] };

export function contactRows(c: ContactsInput): { group: string; rows: { name: string; detail: string }[] }[] {
  return [
    { group: "Portal users", rows: c.portalUsers.map(u => ({ name: `${u.displayName}${u.you ? " (you)" : ""}`, detail: `${u.email} · ${u.status}` })) },
    { group: "Signatories on file", rows: c.signatories.filter(s => s.status === "active").map(s => ({ name: s.name, detail: [s.role, s.maySignTicket ? "may sign tickets" : null, s.mayApproveInvoice ? "may approve invoices" : null].filter(Boolean).join(" · ") })) },
    { group: "Job contacts", rows: c.jobContacts.map(j => ({ name: `${j.name ?? "—"}${j.kind ? ` · ${j.kind.replace(/_/g, " ")}` : ""}`, detail: [j.jobReference ? `Job ${j.jobReference}` : null, j.email, j.phone].filter(Boolean).join(" · ") })) },
  ];
}
