/**
 * 0175 — Loads the canonical records a customer projection is built from, and builds it.
 *
 * Shared by the one-time tracking router and the authenticated client portal so the two ways a
 * customer reaches a job read the same records through the same projection. Nothing is cached and
 * nothing is copied: each call reads jobs, dispatchPostings, dispatchRoles, jobUnits, units,
 * operators, fieldTickets (+events, +lines, +signatures, +revisions), loads, trips, disposalTickets,
 * facilities, safetyEvents, tripBreadcrumbs, pricingDecisions and invoices, and hands typed picks
 * to `server/_core/customerJobView.ts`.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { customerDocumentReleases, disposalTickets, dispatchPostings, dispatchRoles, facilities, fieldTicketEvents, fieldTicketLines, fieldTicketRevisions, fieldTicketSignatures, fieldTickets, invoiceLines, invoices, jobUnits, jobs, loads, operators, pricingDecisions, safetyEvents, tripBreadcrumbs, trips, units } from "../drizzle/schema";
import type { Db } from "./_core/dbTypes";
import { EVENT_CLOCK, type EventType } from "./_core/siteCloseout";

const EVENT_TYPES = Object.keys(EVENT_CLOCK) as EventType[];
import { projectCustomerJob, projectLoads, projectOpenTicket, type CustomerJobView, type CustomerOpenTicket, type Fix, type StatusEvent } from "./_core/customerJobView";
import type { LocationMode } from "./_core/trackingLinks";

export type Visibility = { locationMode: LocationMode; live: boolean; unit: boolean; operator: boolean };

const asEventType = (t: string): EventType => (EVENT_TYPES.includes(t as EventType) ? (t as EventType) : "other");

export async function jobRowOrGone(db: Db, jobId: number) {
  const job = (await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0];
  if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "This tracking link no longer resolves to a job" });
  return job;
}

/** The tickets on a job with their events and signatures, oldest first. */
async function ticketsFor(db: Db, jobId: number) {
  const ts = await db.select().from(fieldTickets).where(eq(fieldTickets.jobId, jobId)).orderBy(asc(fieldTickets.id));
  if (!ts.length) return [];
  const ids = ts.map(t => t.id);
  const [events, sigs] = await Promise.all([
    db.select().from(fieldTicketEvents).where(inArray(fieldTicketEvents.fieldTicketId, ids)).orderBy(asc(fieldTicketEvents.occurredAt)),
    db.select({ fieldTicketId: fieldTicketSignatures.fieldTicketId, capturedAt: fieldTicketSignatures.capturedAt, result: fieldTicketSignatures.result }).from(fieldTicketSignatures).where(inArray(fieldTicketSignatures.fieldTicketId, ids)),
  ]);
  return ts.map(t => ({
    row: t,
    events: events.filter(e => e.fieldTicketId === t.id).map((e): StatusEvent => ({ eventType: asEventType(e.eventType), occurredAt: e.occurredAt, endedAt: e.endedAt })),
    signedAt: sigs.filter(s => s.fieldTicketId === t.id && (s.result === "accepted" || s.result === "partially_accepted")).map(s => s.capturedAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  }));
}

async function facilityNames(db: Db, ids: number[]) {
  const uniq = Array.from(new Set(ids.filter(x => x > 0)));
  const rows = uniq.length ? await db.select({ id: facilities.id, name: facilities.name }).from(facilities).where(inArray(facilities.id, uniq)) : [];
  return new Map(rows.map(r => [r.id, r.name]));
}

/** The job as the customer may see it. `visibility` is the link's or the account's, decided by the caller. */
export async function customerJobFor(db: Db, jobId: number, visibility: Visibility, now = new Date()): Promise<CustomerJobView> {
  const job = await jobRowOrGone(db, jobId);
  const [posting, tickets, safety, jobTrips, joined, roles] = await Promise.all([
    db.select({ planningState: dispatchPostings.planningState, scheduledStart: dispatchPostings.scheduledStart, id: dispatchPostings.id }).from(dispatchPostings).where(eq(dispatchPostings.jobId, job.id)).orderBy(desc(dispatchPostings.id)).limit(1).then(r => r[0] ?? null),
    ticketsFor(db, job.id),
    db.select({ eventType: safetyEvents.eventType, severity: safetyEvents.severity, status: safetyEvents.status, occurredAt: safetyEvents.occurredAt }).from(safetyEvents).where(eq(safetyEvents.jobId, job.id)),
    db.select({ id: trips.id, tripNumber: trips.tripNumber, status: trips.status, startedAt: trips.startedAt, completedAt: trips.completedAt, destinationFacilityId: trips.destinationFacilityId, unitId: trips.unitId, operatorId: trips.operatorId }).from(trips).where(eq(trips.jobId, job.id)).orderBy(asc(trips.id)),
    db.select({ unitId: jobUnits.unitId, operatorId: jobUnits.operatorId, joinedAt: jobUnits.joinedAt, departedAt: jobUnits.departedAt }).from(jobUnits).where(eq(jobUnits.jobId, job.id)).orderBy(asc(jobUnits.joinedAt)),
    db.select({ assignedUnitId: dispatchRoles.assignedUnitId, assignedOperatorId: dispatchRoles.assignedOperatorId, status: dispatchRoles.status }).from(dispatchRoles).innerJoin(dispatchPostings, eq(dispatchRoles.postingId, dispatchPostings.id)).where(eq(dispatchPostings.jobId, job.id)),
  ]);
  // The unit and operator on the job: the open ticket's, else the active job unit's, else the dispatch assignment's, else the trip's.
  const activeTicket = tickets.find(t => !t.signedAt) ?? tickets[tickets.length - 1];
  const activeJoin = joined.find(j => !j.departedAt) ?? joined[joined.length - 1];
  const assigned = roles.find(r => r.status === "assigned" && r.assignedUnitId != null);
  const unitId = activeTicket?.row.unitId ?? activeJoin?.unitId ?? assigned?.assignedUnitId ?? jobTrips[jobTrips.length - 1]?.unitId ?? null;
  const operatorId = activeTicket?.row.operatorId ?? activeJoin?.operatorId ?? assigned?.assignedOperatorId ?? jobTrips[jobTrips.length - 1]?.operatorId ?? null;
  const [unit, operator] = await Promise.all([
    unitId != null ? db.select({ unitNumber: units.unitNumber, vehicleType: units.vehicleType }).from(units).where(eq(units.id, unitId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
    operatorId != null ? db.select({ name: operators.name }).from(operators).where(eq(operators.id, operatorId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
  ]);
  const facNames = await facilityNames(db, jobTrips.map(t => t.destinationFacilityId ?? -1));
  const latestTrip = [...jobTrips].reverse().find(t => t.destinationFacilityId != null);
  const fix = jobTrips.length && visibility.locationMode !== "none" && visibility.live
    ? (await db.select().from(tripBreadcrumbs).where(inArray(tripBreadcrumbs.tripId, jobTrips.map(t => t.id))).orderBy(desc(tripBreadcrumbs.recordedAt)).limit(1))[0] ?? null
    : null;
  const fixView: Fix | null = fix ? { latitude: fix.latitude, longitude: fix.longitude, recordedAt: fix.recordedAt, speedKmh: fix.speedKmh, headingDegrees: fix.headingDegrees, accuracyMetres: fix.accuracyMetres, source: fix.source } : null;
  const customerReference = tickets.map(t => t.row.customerPoNumber ?? t.row.afeNumber).find((x): x is string => !!x) ?? null;
  return projectCustomerJob({
    job: { jobCode: job.jobCode, type: job.type, mode: job.mode, location: job.location, status: job.status, eta: job.eta, createdAt: job.createdAt, updatedAt: job.updatedAt },
    posting: posting ? { planningState: posting.planningState, scheduledStart: posting.scheduledStart } : null,
    customerReference,
    unit, operatorName: operator?.name ?? null,
    tickets: tickets.map(t => ({ ticketNumber: t.row.ticketNumber, events: t.events, signedAt: t.signedAt, completedAt: t.row.completedAt })),
    safety, trips: jobTrips, destination: facNames.get(latestTrip?.destinationFacilityId ?? -1) ?? null,
    firstUnitJoinedAt: joined[0]?.joinedAt ?? null,
    fix: fixView, visibility, now,
  });
}

/** The job's loads, from the canonical load, trip and disposal records. */
export async function customerLoadsFor(db: Db, jobId: number) {
  const job = await jobRowOrGone(db, jobId);
  const jobLoads = await db.select().from(loads).where(eq(loads.jobId, job.id));
  const tripIds = Array.from(new Set(jobLoads.map(l => l.tripId).filter((t): t is number => t != null)));
  const [tripRows, dts] = await Promise.all([
    tripIds.length ? db.select({ id: trips.id, tripNumber: trips.tripNumber, status: trips.status, startedAt: trips.startedAt, completedAt: trips.completedAt, destinationFacilityId: trips.destinationFacilityId }).from(trips).where(inArray(trips.id, tripIds)) : Promise.resolve([]),
    jobLoads.length ? db.select({ id: disposalTickets.id, loadId: disposalTickets.loadId, ticketNumber: disposalTickets.ticketNumber, facilityTicketNumber: disposalTickets.facilityTicketNumber, facilityId: disposalTickets.facilityId, scaleInAt: disposalTickets.scaleInAt, quantity: disposalTickets.quantity, quantityUnit: disposalTickets.quantityUnit, verificationStatus: disposalTickets.verificationStatus }).from(disposalTickets).where(inArray(disposalTickets.loadId, jobLoads.map(l => l.id))) : Promise.resolve([]),
  ]);
  const names = await facilityNames(db, [...tripRows.map(t => t.destinationFacilityId ?? -1), ...dts.map(d => d.facilityId ?? -1)]);
  return { jobReference: job.jobCode, ...projectLoads({ loads: jobLoads.map(l => ({ id: l.id, loadNumber: l.loadNumber, tripId: l.tripId, material: l.material, quantity: l.quantity, quantityUnit: l.quantityUnit, measurementMethod: l.measurementMethod, chainState: l.chainState, loadTicketNumber: l.loadTicketNumber, createdAt: l.createdAt })), trips: tripRows, disposals: dts, facilityNames: names }) };
}

/** The customer-visible open service ticket(s) on a job. Amounts come from pricing decisions, totals from revisions and invoices. */
export async function customerOpenTicketsFor(db: Db, jobId: number): Promise<CustomerOpenTicket[]> {
  const job = await jobRowOrGone(db, jobId);
  const ts = await db.select().from(fieldTickets).where(eq(fieldTickets.jobId, job.id)).orderBy(asc(fieldTickets.id));
  const out: CustomerOpenTicket[] = [];
  for (const t of ts) {
    if (t.billingState === "VOID") continue;
    const lines = await db.select().from(fieldTicketLines).where(eq(fieldTicketLines.fieldTicketId, t.id)).orderBy(asc(fieldTicketLines.id));
    const refs = lines.map(l => l.pricingDecisionRef).filter((r): r is string => !!r);
    const decisions = refs.length ? await db.select({ decisionRef: pricingDecisions.decisionRef, outcome: pricingDecisions.outcome, amountCents: pricingDecisions.amountCents }).from(pricingDecisions).where(inArray(pricingDecisions.decisionRef, refs)) : [];
    const loadIds = lines.map(l => l.loadId).filter((x): x is number => x != null);
    const loadNumbers = loadIds.length ? new Map((await db.select({ id: loads.id, loadNumber: loads.loadNumber }).from(loads).where(inArray(loads.id, loadIds))).map(r => [r.id, r.loadNumber])) : new Map<number, string>();
    const finalRev = t.finalRevisionId ? (await db.select().from(fieldTicketRevisions).where(eq(fieldTicketRevisions.id, t.finalRevisionId)).limit(1))[0] : undefined;
    const presented = (await db.select({ snapshotHash: fieldTicketRevisions.snapshotHash }).from(fieldTicketRevisions).where(eq(fieldTicketRevisions.fieldTicketId, t.id)).orderBy(desc(fieldTicketRevisions.revision)).limit(1))[0];
    const finalTotalCents = finalRev ? ((JSON.parse(finalRev.snapshotJson) as { billing?: { subtotalCents?: number } }).billing?.subtotalCents ?? null) : null;
    // The live invoice drawn from this ticket's lines, if any.
    const invLine = lines.length ? (await db.select({ invoiceId: invoiceLines.invoiceId }).from(invoiceLines).where(inArray(invoiceLines.fieldTicketLineId, lines.map(l => l.id))).limit(1))[0] : undefined;
    const inv = invLine ? (await db.select({ invoiceNumber: invoices.invoiceNumber, status: invoices.status, subtotalCents: invoices.subtotalCents, taxCents: invoices.taxCents, totalCents: invoices.totalCents, issuedAt: invoices.issuedAt }).from(invoices).where(and(eq(invoices.id, invLine.invoiceId))).limit(1))[0] : undefined;
    out.push(projectOpenTicket({
      ticket: { ticketNumber: t.ticketNumber, billingState: t.billingState, billingVersion: t.billingVersion, customerPoNumber: t.customerPoNumber, completedAt: t.completedAt, finalizedAt: t.finalizedAt, snapshotHash: presented?.snapshotHash ?? null },
      lines: lines.map(l => { const d = decisions.find(x => x.decisionRef === l.pricingDecisionRef); return { id: l.id, customerVisible: l.customerVisible, lineKind: l.lineKind, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, quantityUnit: l.quantityUnit, disposition: l.disposition, amountCents: d?.outcome === "priced" ? d.amountCents : null, priced: d?.outcome === "priced" && d.amountCents != null, loadNumber: l.loadId != null ? (loadNumbers.get(l.loadId) ?? null) : null, periodStartAt: l.periodStartAt, periodEndAt: l.periodEndAt, amendsLineId: l.amendsLineId }; }),
      finalTotalCents,
      invoice: inv && inv.status !== "void" && inv.status !== "draft" ? inv : null,
    }));
  }
  return out;
}

/** Documents released to the customer on a job: pointers into the catalogues, current only. */
export async function releasedDocumentsFor(db: Db, jobId: number, now = new Date()) {
  const rows = await db.select().from(customerDocumentReleases).where(and(eq(customerDocumentReleases.jobId, jobId), eq(customerDocumentReleases.status, "released"))).orderBy(desc(customerDocumentReleases.releasedAt));
  return rows.filter(r => !r.expiresAt || r.expiresAt > now).map(r => ({ releaseRef: r.releaseRef, documentRef: r.documentRef, kind: r.kind, title: r.title, contentHash: r.contentHash, releasedAt: r.releasedAt, expiresAt: r.expiresAt }));
}
