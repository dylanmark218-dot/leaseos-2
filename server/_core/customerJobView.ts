/**
 * 0175 — The customer's view of a job: an explicit projection, never a serialized row.
 *
 * Every function here takes typed picks of canonical records and returns a DTO whose fields are
 * enumerated in this file. What is not named here does not cross: internal notes, event detail,
 * driver contact and licence data, hours of service, payroll, rates and cost, safety-event titles,
 * other jobs, tenant administration. The suite feeds those in and checks they do not come out.
 *
 * Three rules carried over from customerProjections.ts: a state comes from ticket events and
 * signatures before it comes from a status column, and never from a vehicle's speed; a position is
 * shown only in the mode a person configured, and a fix older than fifteen minutes is stale, not
 * live; a total that is not final is labelled as an estimate, never as an invoice.
 */
import type { EventType } from "./siteCloseout";
import { operationalState, type OpenSafetyEvent, type OperationalState } from "./customerProjections";
import { STALE_LOCATION_MINUTES, type LocationMode } from "./trackingLinks";

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                     */
/* ------------------------------------------------------------------ */

export const CUSTOMER_STATUSES = ["Scheduled", "Dispatched", "En Route", "On Location", "In Progress", "On Hold", "Transporting", "At Disposal", "Returning", "Attention", "Completed", "Cancelled", "Unknown"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** The customer-facing steps, in order. Attention, On Hold, Cancelled and Unknown are states, not steps. */
export const CUSTOMER_TIMELINE_STEPS: readonly CustomerStatus[] = ["Scheduled", "Dispatched", "En Route", "On Location", "In Progress", "Transporting", "At Disposal", "Returning", "Completed"];

/** An open ticket event decides the step directly; the vocabulary here is the customer's. */
const EVENT_STATUS: Partial<Record<EventType, CustomerStatus>> = {
  site_work: "In Progress", standby: "On Hold", customer_hold: "On Hold", weather_hold: "On Hold",
  travel_to_disposal: "Transporting", disposal_queue: "At Disposal", disposal: "At Disposal", return_travel: "Returning",
  break: "On Location", other: "On Location",
};

/** Internal job status → customer status, when no ticket evidence decides. */
const JOB_STATUS: Record<"dispatched" | "in_transit" | "loading" | "on_site" | "awaiting_docs" | "complete", CustomerStatus> = {
  dispatched: "Dispatched", in_transit: "En Route", loading: "In Progress", on_site: "On Location", awaiting_docs: "Completed", complete: "Completed",
};

/** Dispatch planning state → customer status, for a job that has not been dispatched. */
const POSTING_STATUS: Record<string, CustomerStatus> = {
  draft: "Scheduled", planning: "Scheduled", open_for_bid: "Scheduled", invite_only: "Scheduled", on_call: "Scheduled", direct: "Scheduled", bid_closed: "Scheduled", awarding: "Scheduled", partially_staffed: "Scheduled", staffed: "Scheduled",
  dispatched: "Dispatched", in_progress: "In Progress", completed: "Completed", cancelled: "Cancelled",
};

export type StatusEvent = { eventType: EventType; occurredAt: Date; endedAt: Date | null };

export type CustomerStatusInput = {
  jobStatus: keyof typeof JOB_STATUS;
  postingState: string | null;
  /** Site-phase and post-site events across the job's tickets. */
  events: readonly StatusEvent[];
  siteSigned: boolean;
  safety: readonly OpenSafetyEvent[];
  now: Date;
};

/**
 * Map canonical records to one customer status with its basis. Evidence order: an open safety
 * event → Attention; an open ticket event → its step; a signed site → Completed (or the post-site
 * step still open); otherwise the job's own status; a job never dispatched → the posting's state.
 */
export function customerStatus(i: CustomerStatusInput): { status: CustomerStatus; basis: string; since: Date | null; operational: OperationalState } {
  const op = operationalState({ events: i.events, siteSigned: i.siteSigned, safety: i.safety, now: i.now });
  if (op.state === "BREAKDOWN" || op.state === "INCIDENT") return { status: "Attention", basis: "An operational event is under review by the contractor", since: op.since, operational: op.state };
  const sorted = [...i.events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const open = sorted.filter(e => e.endedAt == null || e.endedAt > i.now).pop();
  if (open && EVENT_STATUS[open.eventType]) return { status: EVENT_STATUS[open.eventType]!, basis: `Ticket event ${open.eventType.replace(/_/g, " ")} in progress`, since: open.occurredAt, operational: op.state };
  if (i.jobStatus === "complete") return { status: "Completed", basis: "Job complete", since: null, operational: op.state };
  if (i.siteSigned) return { status: "Completed", basis: "Site work signed off", since: op.since, operational: op.state };
  if (op.state === "ON_LOCATION") return { status: "On Location", basis: op.basis, since: op.since, operational: op.state };
  if (i.postingState && !["dispatched", "in_progress", "completed"].includes(i.postingState) && i.jobStatus === "dispatched") {
    return { status: POSTING_STATUS[i.postingState] ?? "Scheduled", basis: `Dispatch planning: ${i.postingState.replace(/_/g, " ")}`, since: null, operational: op.state };
  }
  return { status: JOB_STATUS[i.jobStatus] ?? "Unknown", basis: `Job status ${i.jobStatus.replace(/_/g, " ")}`, since: null, operational: op.state };
}

/* ------------------------------------------------------------------ */
/* Location                                                              */
/* ------------------------------------------------------------------ */

export type Fix = { latitude: number; longitude: number; recordedAt: Date; speedKmh: number | null; headingDegrees: number | null; accuracyMetres: number | null; source: string };

export type CustomerLocation = {
  mode: LocationMode;
  position: { latitude: number; longitude: number; precision: "approximate" | "exact" } | null;
  heading: number | null;
  speedKmh: number | null;
  recordedAt: Date | null;
  ageMinutes: number | null;
  /** True when a position is shown but is older than the staleness threshold. Never presented as live. */
  stale: boolean;
  note: string;
};

/** Round to ~1 km so an approximate position names an area, not a lease road. */
const approx = (x: number) => Math.round(x * 100) / 100;

export function projectLocation(args: { mode: LocationMode; live: boolean; fix: Fix | null; now: Date }): CustomerLocation {
  const none = (note: string): CustomerLocation => ({ mode: args.mode, position: null, heading: null, speedKmh: null, recordedAt: null, ageMinutes: null, stale: false, note });
  if (args.mode === "none") return none("Location sharing is off for this link");
  if (!args.live) return none("Live tracking has ended for this link; documents and the ticket remain available");
  if (!args.fix) return none("No position has been recorded for this job's trips");
  const ageMinutes = Math.max(0, Math.round((args.now.getTime() - args.fix.recordedAt.getTime()) / 60_000));
  const stale = ageMinutes > STALE_LOCATION_MINUTES;
  const base = { mode: args.mode, recordedAt: args.fix.recordedAt, ageMinutes, stale, note: stale ? `Last known position is ${ageMinutes} minutes old — stale, not live` : `Position recorded ${ageMinutes} minute(s) ago` };
  if (args.mode === "approximate") return { ...base, position: { latitude: approx(args.fix.latitude), longitude: approx(args.fix.longitude), precision: "approximate" }, heading: null, speedKmh: null };
  return { ...base, position: { latitude: args.fix.latitude, longitude: args.fix.longitude, precision: "exact" }, heading: args.fix.headingDegrees, speedKmh: args.fix.speedKmh };
}

/* ------------------------------------------------------------------ */
/* Loads                                                                 */
/* ------------------------------------------------------------------ */

export type LoadInput = { id: number; loadNumber: string; tripId: number | null; material: string | null; quantity: number | null; quantityUnit: string | null; measurementMethod: string; chainState: string; loadTicketNumber: string | null; createdAt: Date };
export type TripInput = { id: number; tripNumber: string; status: string; startedAt: Date | null; completedAt: Date | null; destinationFacilityId: number | null };
export type DisposalInput = { id: number; loadId: number | null; ticketNumber: string; facilityTicketNumber: string | null; facilityId: number | null; scaleInAt: Date | null; quantity: number | null; quantityUnit: string | null; verificationStatus: string };

export type CustomerLoad = {
  sequence: number;
  loadNumber: string;
  status: "in_progress" | "picked_up" | "in_transit" | "at_disposal" | "completed";
  pickedUpAt: Date | null;
  material: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  /** How the number was obtained, in the customer's words; a customer-stated figure says so. */
  measured: string;
  destination: string | null;
  disposalTicketNumber: string | null;
  disposalVerified: boolean;
  disposalAt: Date | null;
};

const COMPLETE_STATES = new Set(["unloaded", "disposal_verified", "billed"]);
const MEASURED: Record<string, string> = { meter: "metered", scale: "scale", loadsense_calibrated: "calibrated sensor", loadsense_uncalibrated: "sensor (uncalibrated)", gauge: "gauge", estimate: "estimate", customer_stated: "customer stated", unknown: "not recorded" };

export function projectLoads(args: { loads: readonly LoadInput[]; trips: readonly TripInput[]; disposals: readonly DisposalInput[]; facilityNames: ReadonlyMap<number, string> }): { total: number; completed: number; active: number; items: CustomerLoad[] } {
  const items = [...args.loads].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((l, i) => {
    const trip = args.trips.find(t => t.id === l.tripId);
    const dt = args.disposals.find(d => d.loadId === l.id);
    const status: CustomerLoad["status"] = COMPLETE_STATES.has(l.chainState) ? "completed" : l.chainState === "arrived_disposal" || l.chainState === "weighed" ? "at_disposal" : l.chainState === "in_transit" ? "in_transit" : l.chainState === "loaded" ? "picked_up" : "in_progress";
    return {
      sequence: i + 1, loadNumber: l.loadNumber, status, pickedUpAt: l.chainState === "created" || l.chainState === "material_identified" ? null : l.createdAt,
      material: l.material, quantity: l.quantity, quantityUnit: l.quantityUnit, measured: MEASURED[l.measurementMethod] ?? "not recorded",
      destination: args.facilityNames.get(trip?.destinationFacilityId ?? dt?.facilityId ?? -1) ?? null,
      disposalTicketNumber: dt ? (dt.facilityTicketNumber ?? dt.ticketNumber) : null, disposalVerified: dt?.verificationStatus === "verified", disposalAt: dt?.scaleInAt ?? null,
    };
  });
  return { total: items.length, completed: items.filter(x => x.status === "completed").length, active: items.filter(x => x.status !== "completed").length, items };
}

/* ------------------------------------------------------------------ */
/* The job                                                               */
/* ------------------------------------------------------------------ */

export type CustomerJobInput = {
  job: { jobCode: string; type: string; mode: string; location: string; status: keyof typeof JOB_STATUS; eta: string | null; createdAt: Date; updatedAt: Date };
  posting: { planningState: string; scheduledStart: Date | null } | null;
  /** Reference numbers the customer gave: the ticket's PO, else the AFE on file. */
  customerReference: string | null;
  unit: { unitNumber: string; vehicleType: string } | null;
  /** The operator's full name; only the first token is projected, and only when permitted. */
  operatorName: string | null;
  tickets: readonly { ticketNumber: string; events: readonly StatusEvent[]; signedAt: Date | null; completedAt: Date | null }[];
  safety: readonly OpenSafetyEvent[];
  trips: readonly TripInput[];
  destination: string | null;
  firstUnitJoinedAt: Date | null;
  fix: Fix | null;
  visibility: { locationMode: LocationMode; live: boolean; unit: boolean; operator: boolean };
  now: Date;
};

export type CustomerJobView = {
  jobReference: string;
  customerReference: string | null;
  serviceType: string;
  origin: string;
  destination: string | null;
  status: { label: CustomerStatus; basis: string; since: Date | null };
  timeline: { step: CustomerStatus; reached: boolean; at: Date | null }[];
  scheduledAt: Date | null;
  dispatchedAt: Date | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
  unit: { unitNumber: string; vehicleType: string } | null;
  operatorDisplayName: string | null;
  eta: string | null;
  location: CustomerLocation;
  lastUpdatedAt: Date;
  ticketNumbers: string[];
};

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? null;

export function projectCustomerJob(i: CustomerJobInput): CustomerJobView {
  const events = i.tickets.flatMap(t => t.events);
  const siteSigned = i.tickets.length > 0 && i.tickets.every(t => t.signedAt != null);
  const st = customerStatus({ jobStatus: i.job.status, postingState: i.posting?.planningState ?? null, events, siteSigned, safety: i.safety, now: i.now });
  const site = events.filter(e => e.eventType === "site_work").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const arrivedAt = site[0]?.occurredAt ?? null;
  const completedAt = i.job.status === "complete" ? i.job.updatedAt : siteSigned ? (i.tickets.map(t => t.signedAt).filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null) : null;
  const dispatched = i.job.status !== "dispatched" || i.posting == null || ["dispatched", "in_progress", "completed"].includes(i.posting.planningState);
  const dispatchedAt = dispatched ? (i.firstUnitJoinedAt ?? i.job.createdAt) : null;
  const reachedIndex = st.status === "Completed" ? CUSTOMER_TIMELINE_STEPS.length - 1 : st.status === "Attention" || st.status === "On Hold" ? CUSTOMER_TIMELINE_STEPS.indexOf("On Location") : Math.max(CUSTOMER_TIMELINE_STEPS.indexOf(st.status), 0);
  const stepAt: Partial<Record<CustomerStatus, Date | null>> = { Scheduled: i.posting?.scheduledStart ?? i.job.createdAt, Dispatched: dispatchedAt, "En Route": i.trips.map(t => t.startedAt).filter((d): d is Date => d != null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null, "On Location": arrivedAt, "In Progress": arrivedAt, Completed: completedAt };
  return {
    jobReference: i.job.jobCode,
    customerReference: i.customerReference,
    serviceType: i.job.mode === "general" ? i.job.type : `${i.job.type} (${i.job.mode})`,
    origin: i.job.location,
    destination: i.destination,
    status: { label: st.status, basis: st.basis, since: st.since },
    timeline: CUSTOMER_TIMELINE_STEPS.map((step, idx) => ({ step, reached: idx <= reachedIndex, at: idx <= reachedIndex ? (stepAt[step] ?? null) : null })),
    scheduledAt: i.posting?.scheduledStart ?? null,
    dispatchedAt, arrivedAt, completedAt,
    unit: i.visibility.unit ? i.unit : null,
    operatorDisplayName: i.visibility.operator ? firstName(i.operatorName) : null,
    eta: i.visibility.live ? i.job.eta : null,
    location: projectLocation({ mode: i.visibility.locationMode, live: i.visibility.live, fix: i.fix, now: i.now }),
    lastUpdatedAt: i.job.updatedAt,
    ticketNumbers: i.tickets.map(t => t.ticketNumber),
  };
}

/* ------------------------------------------------------------------ */
/* The open service ticket                                               */
/* ------------------------------------------------------------------ */

export type OpenTicketLineInput = { id: number; customerVisible: boolean; lineKind: string; serviceCode: string | null; description: string; quantity: number | null; quantityUnit: string | null; disposition: string; amountCents: number | null; priced: boolean; loadNumber: string | null; periodStartAt: Date | null; periodEndAt: Date | null; amendsLineId: number | null };
export type OpenTicketInput = {
  ticket: { ticketNumber: string; billingState: string; billingVersion: number; customerPoNumber: string | null; completedAt: Date | null; finalizedAt: Date | null; snapshotHash: string | null };
  lines: readonly OpenTicketLineInput[];
  /** The frozen final total, from the final revision's snapshot; null until finalized. */
  finalTotalCents: number | null;
  invoice: { invoiceNumber: string; status: string; subtotalCents: number; taxCents: number; totalCents: number; issuedAt: Date | null } | null;
};

export type CustomerOpenTicket = {
  ticketNumber: string;
  status: string;
  version: number;
  customerPoNumber: string | null;
  lines: { lineId: number; kind: string; description: string; quantity: number | null; unit: string | null; amountCents: number | null; priced: boolean; decision: "accepted" | "disputed" | "pending"; load: string | null; period: { from: Date; to: Date | null } | null; amendment: boolean }[];
  accrued: { subtotalCents: number; pricedLines: number; unpricedLines: number; hiddenLines: number; label: string; isFinal: false };
  finalized: { totalCents: number; at: Date; label: string } | null;
  invoiced: { invoiceNumber: string; status: string; subtotalCents: number; taxCents: number; totalCents: number; issuedAt: Date | null } | null;
  /** What the customer may do now, from the state alone. */
  actions: { acknowledge: boolean; approve: boolean; dispute: boolean; comment: boolean; sign: boolean };
  snapshotHash: string | null;
};

export function projectOpenTicket(i: OpenTicketInput): CustomerOpenTicket {
  const visible = i.lines.filter(l => l.customerVisible);
  const priced = visible.filter(l => l.priced && l.amountCents != null);
  const state = i.ticket.billingState;
  const reviewable = state === "AWAITING_CUSTOMER_REVIEW";
  const notClosed = !["FINALIZED", "INVOICED", "VOID"].includes(state);
  return {
    ticketNumber: i.ticket.ticketNumber, status: state, version: i.ticket.billingVersion, customerPoNumber: i.ticket.customerPoNumber,
    lines: visible.map(l => ({ lineId: l.id, kind: l.lineKind, description: l.description, quantity: l.quantity, unit: l.quantityUnit, amountCents: l.priced ? l.amountCents : null, priced: l.priced && l.amountCents != null, decision: l.disposition === "accepted" ? "accepted" : l.disposition === "disputed" ? "disputed" : "pending", load: l.loadNumber, period: l.periodStartAt ? { from: l.periodStartAt, to: l.periodEndAt } : null, amendment: l.amendsLineId != null })),
    accrued: { subtotalCents: priced.reduce((a, l) => a + (l.amountCents ?? 0), 0), pricedLines: priced.length, unpricedLines: visible.length - priced.length, hiddenLines: i.lines.length - visible.length, label: state === "FINALIZED" || state === "INVOICED" ? "Accrued before finalization — see the finalized total" : "Estimated subtotal — accrued so far, before taxes; not an invoice", isFinal: false },
    finalized: i.finalTotalCents != null && i.ticket.finalizedAt ? { totalCents: i.finalTotalCents, at: i.ticket.finalizedAt, label: "Finalized ticket total, before taxes" } : null,
    invoiced: i.invoice ? { invoiceNumber: i.invoice.invoiceNumber, status: i.invoice.status, subtotalCents: i.invoice.subtotalCents, taxCents: i.invoice.taxCents, totalCents: i.invoice.totalCents, issuedAt: i.invoice.issuedAt } : null,
    actions: { acknowledge: notClosed, approve: reviewable, dispute: reviewable || state === "CUSTOMER_ACCEPTED", comment: notClosed, sign: reviewable && i.ticket.completedAt != null },
    snapshotHash: i.ticket.snapshotHash,
  };
}
