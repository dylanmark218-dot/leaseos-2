/**
 * 0175 — Fixtures for the client portal's rendered tests and the axe suite. A plain module.
 */
import type { ClientPortalViewProps } from "./ClientPortalView";
import { fixtureLoaded, fixtureStatus, fixtureTicket } from "../../tracking/trackingFixtures";

export const fixtureDashboard = (): NonNullable<ClientPortalViewProps["dashboard"]> => ({
  jobs: { active: 2, scheduled: 1, completed: 4, total: 7 }, awaitingCustomerAction: 1, openTickets: 3,
  invoices: { outstanding: 2, outstandingCents: 412_350, disputed: 1 },
  recentDocuments: [{ releaseRef: "REL-2026-000001", documentRef: "FT-2026-000001-R1-PDF", title: "Signed field ticket R1", kind: "signed_field_ticket", releasedAt: "2026-09-24T14:00:00Z", jobReference: "260921-001" }],
});

export const fixtureJobs = (): NonNullable<ClientPortalViewProps["jobs"]> => [
  { jobReference: "260921-001", customerReference: "PO-4500123", serviceType: "Hydrovac excavation (hydrovac)", origin: "10-22-045-06-W5", destination: "Edson TRD", status: { label: "In Progress", basis: "Ticket event site work in progress" }, unit: { unitNumber: "142" }, lastUpdatedAt: "2026-09-24T12:59:00Z", bucket: "active" },
  { jobReference: "260921-002", customerReference: null, serviceType: "Water haul (transport)", origin: "04-12-052-09W5", destination: null, status: { label: "Attention", basis: "An operational event is under review by the contractor" }, unit: null, lastUpdatedAt: "2026-09-24T11:00:00Z", bucket: "active" },
  { jobReference: "260922-001", customerReference: null, serviceType: "Hydrovac excavation (hydrovac)", origin: "07-18-053-18 W5M", destination: null, status: { label: "Scheduled", basis: "Dispatch planning: staffed" }, unit: null, lastUpdatedAt: "2026-09-23T09:00:00Z", bucket: "scheduled" },
  { jobReference: "260919-003", customerReference: "AFE-77", serviceType: "Hydrovac excavation (hydrovac)", origin: "10-22-045-06-W5", destination: "Edson TRD", status: { label: "Completed", basis: "Site work signed off" }, unit: { unitNumber: "142" }, lastUpdatedAt: "2026-09-19T17:00:00Z", bucket: "completed" },
];

export const fixtureInvoices = (): NonNullable<ClientPortalViewProps["invoices"]> => [
  { invoiceNumber: "INV-2026-000009", status: "sent", totalCents: 106_838, balanceCents: 106_838, dueAt: "2026-10-24T00:00:00Z", issuedAt: "2026-09-24T15:00:00Z" },
  { invoiceNumber: "INV-2026-000004", status: "disputed", totalCents: 305_512, balanceCents: 305_512, dueAt: "2026-09-01T00:00:00Z", issuedAt: "2026-08-02T15:00:00Z" },
  { invoiceNumber: "INV-2026-000002", status: "paid", totalCents: 88_000, balanceCents: 0, dueAt: "2026-08-01T00:00:00Z", issuedAt: "2026-07-02T15:00:00Z" },
];

export const fixtureContacts = (): NonNullable<ClientPortalViewProps["contacts"]> => ({
  portalUsers: [{ displayName: "M. Johnson", email: "mj@abc.example", status: "active", you: true }, { displayName: "A. Chen", email: "ac@abc.example", status: "invited", you: false }],
  signatories: [{ name: "R. Patel", role: "Site supervisor", maySignTicket: true, mayApproveInvoice: false, status: "active" }],
  jobContacts: [{ jobReference: "260921-001", kind: "site_supervisor", name: "R. Patel", email: null, phone: "780-555-0199" }],
});

export const fixtureClient = (over: Partial<ClientPortalViewProps> = {}): ClientPortalViewProps => {
  const loaded = fixtureLoaded();
  const t = fixtureTicket();
  return {
    section: "dashboard", onSection: () => {}, me: { displayName: "M. Johnson" },
    dashboard: fixtureDashboard(), jobs: fixtureJobs(), selectedJob: "260921-001", onSelectJob: () => {},
    jobDetail: fixtureStatus(), loads: loaded.kind === "loaded" ? loaded.loads : null,
    documents: [{ releaseRef: "REL-2026-000001", documentRef: "FT-2026-000001-R1-PDF", kind: "signed_field_ticket", title: "Signed field ticket R1", jobReference: "260921-001" }],
    invoices: fixtureInvoices(),
    tickets: [{ jobReference: "260921-001", ...t, accrued: t.accrued as never, finalized: null, invoiced: null, actions: { ...t.actions } } as never],
    contacts: fixtureContacts(),
    ...over,
  };
};
