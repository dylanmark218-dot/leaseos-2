/**
 * 0175 — Fixtures for the tracking page's rendered tests and the axe suite. A plain module, so the
 * axe suite can import them without re-registering the dom test's own cases.
 */
import type { TrackingStatus, TrackingTicket, TrackingViewProps } from "./TrackingView";

export const fixtureStatus = (over: Partial<TrackingStatus> = {}): TrackingStatus => ({
  jobReference: "260921-001", customerReference: "PO-4500123", serviceType: "Hydrovac excavation (hydrovac)", origin: "10-22-045-06-W5", destination: "Edson TRD",
  status: { label: "In Progress", basis: "Ticket event site work in progress", since: "2026-09-24T07:31:00Z" },
  timeline: [
    { step: "Scheduled", reached: true, at: "2026-09-24T07:00:00Z" }, { step: "Dispatched", reached: true, at: "2026-09-24T06:30:00Z" }, { step: "En Route", reached: true, at: "2026-09-24T06:40:00Z" },
    { step: "On Location", reached: true, at: "2026-09-24T07:31:00Z" }, { step: "In Progress", reached: true, at: "2026-09-24T07:31:00Z" }, { step: "Transporting", reached: false, at: null },
    { step: "At Disposal", reached: false, at: null }, { step: "Returning", reached: false, at: null }, { step: "Completed", reached: false, at: null },
  ],
  unit: { unitNumber: "142", vehicleType: "hydrovac" }, operatorDisplayName: "Jane", eta: "14:30",
  location: { mode: "live", position: { latitude: 53.123456, longitude: -116.654321, precision: "exact" }, recordedAt: "2026-09-24T12:55:00Z", ageMinutes: 5, stale: false, note: "Position recorded 5 minute(s) ago" },
  live: { available: true, reason: "until revoked", until: null },
  lastUpdatedAt: "2026-09-24T12:59:00Z",
  ...over,
});

export const fixtureTicket = (over: Partial<TrackingTicket> = {}): TrackingTicket => ({
  ticketNumber: "FT-2026-000001", status: "AWAITING_CUSTOMER_REVIEW", customerPoNumber: "PO-4500123",
  lines: [
    { description: "Truck service", quantity: 4.5, unit: "h", amountCents: 83_250, priced: true, decision: "pending", load: null, amendment: false },
    { description: "Standby", quantity: 1, unit: "h", amountCents: 18_500, priced: true, decision: "pending", load: null, amendment: false },
    { description: "Disposal fee", quantity: 2, unit: "load", amountCents: null, priced: false, decision: "pending", load: "LD-2026-000012", amendment: false },
  ],
  accrued: { subtotalCents: 101_750, pricedLines: 2, unpricedLines: 1, label: "Estimated subtotal — accrued so far, before taxes; not an invoice" },
  finalized: null, invoiced: null,
  actions: { acknowledge: true, approve: true, dispute: true, comment: true, sign: true },
  ...over,
});

export const fixtureLoaded = (over: Partial<Extract<TrackingViewProps["state"], { kind: "loaded" }>> = {}): TrackingViewProps["state"] => ({
  kind: "loaded", issuedTo: { name: "R. Patel", kind: "site_supervisor" }, status: fixtureStatus(),
  loads: { total: 3, completed: 1, active: 2, items: [
    { sequence: 1, loadNumber: "LD-1", status: "completed", pickedUpAt: "2026-09-24T08:00:00Z", material: "produced water", quantity: 12.4, quantityUnit: "m3", measured: "scale", destination: "Edson TRD", disposalTicketNumber: "SEC-44821", disposalVerified: true },
    { sequence: 2, loadNumber: "LD-2", status: "in_transit", pickedUpAt: "2026-09-24T10:00:00Z", material: "slurry", quantity: 11.8, quantityUnit: "m3", measured: "customer stated", destination: "Edson TRD", disposalTicketNumber: null, disposalVerified: false },
    { sequence: 3, loadNumber: "LD-3", status: "in_progress", pickedUpAt: null, material: null, quantity: null, quantityUnit: null, measured: "not recorded", destination: null, disposalTicketNumber: null, disposalVerified: false },
  ] },
  documents: [{ releaseRef: "REL-2026-000001", documentRef: "FT-2026-000001-R1-PDF", kind: "signed_field_ticket", title: "Signed field ticket R1" }],
  tickets: [fixtureTicket()],
  ...over,
});

