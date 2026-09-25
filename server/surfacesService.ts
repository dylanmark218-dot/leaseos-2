/**
 * Universal surfaces — the service.
 *
 * Reads the exception-bearing tables into the snapshot the engine derives
 * from; assembles the inbox from the two existing task/notification tables
 * plus what awaits the caller; resolves tracking numbers across entities;
 * and walks an entity's history into a timeline. Nothing here is a new store.
 */

import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import { resolveActingScope } from "./_core/actingScope";
import { getDb } from "./db";
import {
  assistantCommitReceipts, assistantProposals, assistantQuestions, calibrationEvents, carrierProfileReviews,
  billingBooks, calibrationSweeps, complianceDocuments, disposalTickets, fieldTickets, manifests, fieldDevices, fuelTransactions, insurancePolicies, invoices, jobs, loads,
  maintenanceDefects, measurementDevices, operationalTasks, operators, purchaseAuthorizations, roadsideServiceEvents,
  syncConflicts, syncPackages, trips, units, vendorBills, vendors, workflowNotifications, workOrderReleases, workOrders, academyInspectorRequests, securityIncidents, privacyBreachAssessments, incidentNotificationObligations, facilities, facilityEvidence, facilitySourceLicences } from "../drizzle/schema";
import { calibrationStatus, type CalibrationEvent } from "./_core/requirementEngine";
import type { ExceptionSources } from "./_core/exceptionCentre";
import { complianceRequirementValidity } from "./_core/complianceDocumentValidity";
import { loadUngatedAssignments } from "./dispatchEnforcementService";
import { loadFuelLineFindings } from "./periodCloseService";

const DAY = 86_400_000;

/* ------------------------------------------------------------------ */
/* Exception sources                                                    */
/* ------------------------------------------------------------------ */

/** The disposal-facility directory's open items, for the Exception Centre. Derived, never stored. */
async function loadFacilityDirectoryExceptions(db: Awaited<ReturnType<typeof getDb>>) {
  if (!db) return undefined;
  const conflicting = await db.select({ facilityKey: facilities.facilityKey, name: facilities.name }).from(facilities).where(and(isNotNull(facilities.facilityKey), eq(facilities.lifecycle, "conflicting")));
  const unreviewed = await db.select({ facilityKey: facilities.facilityKey, name: facilities.name, count: sql<number>`COUNT(*)`, oldest: sql<Date>`MIN(${facilityEvidence.retrievedAt})` })
    .from(facilityEvidence).innerJoin(facilities, eq(facilities.id, facilityEvidence.facilityId)).innerJoin(facilitySourceLicences, eq(facilitySourceLicences.licenceKey, facilityEvidence.licenceKey))
    .where(and(eq(facilityEvidence.reviewState, "lead"), eq(facilityEvidence.confidence, "high"), inArray(facilitySourceLicences.status, ["confirmed"]), sql`${facilitySourceLicences.publisher} NOT IN ('(the operator)')`, isNotNull(facilities.facilityKey)))
    .groupBy(facilities.facilityKey, facilities.name).limit(200);
  const withLsd = await db.select({ facilityKey: facilities.facilityKey, legalLocation: facilities.legalLocation }).from(facilities).where(and(isNotNull(facilities.facilityKey), isNotNull(facilities.legalLocation)));
  const norm = (x: string) => x.toUpperCase().replace(/[\s-]+/g, "-").replace(/-?W(\d)-?M?$/, "-W$1M").replace(/^(\d)-/, "0$1-").replace(/-(\d)-(\d{2,3})-/, "-0$1-$2-");
  const groups = new Map<string, string[]>();
  for (const r of withLsd) { const k = norm(r.legalLocation!); groups.set(k, [...(groups.get(k) ?? []), r.facilityKey!]); }
  return {
    conflicting: conflicting.map(c => ({ facilityKey: c.facilityKey!, name: c.name })),
    unreviewedRegulatorEvidence: unreviewed.map(u => ({ facilityKey: u.facilityKey!, name: u.name, count: Number(u.count), oldestRetrievedAt: new Date(u.oldest) })),
    duplicateGroups: Array.from(groups.entries()).filter(([, ks]) => ks.length > 1).map(([legalLocation, facilityKeys]) => ({ legalLocation, facilityKeys })),
  };
}

export async function loadExceptionSources(now = new Date()): Promise<ExceptionSources> {
  const db = await getDb();
  const empty: ExceptionSources = {
    now, criticalDefects: [], roadsideOpen: [], vendorBills: [], purchaseRequests: [], credentialsAwaitingVerification: [], credentialVerdicts: [], aiProposals: [], aiQuestions: [],
    syncConflicts: [], revokedDevicesWithQueue: [], measurementDevices: [], openCalibrationSweeps: [], insurancePolicies: [], carrierProfileReviews: [], ungatedAssignments: [], inspectorRequests: [], statementsWithFindings: [], tanksOutOfTolerance: [], periodsSoftClosed: [],
  };
  if (!db) return empty;
  const horizon = new Date(now.getTime() + 90 * DAY);

  const [defects, roadside, bills, pas, creds, proposals, questions, conflicts, revoked, devices, policies, reviews] = await Promise.all([
    db.select({ id: maintenanceDefects.id, unitId: maintenanceDefects.unitId, title: maintenanceDefects.title, reportedAt: maintenanceDefects.reportedAt, status: maintenanceDefects.status, unitNumber: units.unitNumber })
      .from(maintenanceDefects).leftJoin(units, eq(units.id, maintenanceDefects.unitId))
      .where(and(eq(maintenanceDefects.severity, "critical"), inArray(maintenanceDefects.status, ["open", "in_progress"]))).limit(500),
    db.select({ id: roadsideServiceEvents.id, eventRef: roadsideServiceEvents.eventRef, eventType: roadsideServiceEvents.eventType, occurredAt: roadsideServiceEvents.occurredAt, assignedVendorId: roadsideServiceEvents.assignedVendorId, unitNumber: units.unitNumber })
      .from(roadsideServiceEvents).leftJoin(units, eq(units.id, roadsideServiceEvents.unitId))
      .where(inArray(roadsideServiceEvents.status, ["open", "vendor_assigned", "in_repair", "repaired_awaiting_release"])).limit(500),
    db.select({ id: vendorBills.id, billRef: vendorBills.billRef, totalCents: vendorBills.totalCents, status: vendorBills.status, matchOutcome: vendorBills.matchOutcome, receivedAt: vendorBills.receivedAt, dueAt: vendorBills.dueAt, vendorName: vendors.name })
      .from(vendorBills).leftJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(inArray(vendorBills.status, ["needs_coding", "needs_approval", "missing_receipt", "mismatch", "duplicate_suspected"])).limit(500),
    db.select().from(purchaseAuthorizations).where(eq(purchaseAuthorizations.status, "requested")).limit(500),
    db.select({ id: complianceDocuments.id, ownerType: complianceDocuments.ownerType, ownerId: complianceDocuments.ownerId, docType: complianceDocuments.docType, title: complianceDocuments.title, expiresAt: complianceDocuments.expiresAt, pendingReview: sql<boolean>`${complianceDocuments.verificationStatus} = 'needs_review'`.mapWith(Boolean) })
      .from(complianceDocuments)
      .where(or(eq(complianceDocuments.verificationStatus, "needs_review"), and(lte(complianceDocuments.expiresAt, horizon), eq(complianceDocuments.verificationStatus, "verified")))).limit(2000),
    db.select({ proposalId: assistantProposals.proposalId, formKey: assistantProposals.formKey, title: assistantProposals.title, createdAt: assistantProposals.createdAt, commitState: assistantProposals.commitState })
      .from(assistantProposals).where(eq(assistantProposals.commitState, "awaiting_readback")).limit(500),
    db.select({ askedToUserId: assistantQuestions.askedToUserId, count: sql<number>`count(*)`, oldest: sql<Date | null>`min(${assistantQuestions.createdAt})` })
      .from(assistantQuestions).where(eq(assistantQuestions.status, "pending")).groupBy(assistantQuestions.askedToUserId),
    db.select({ id: syncConflicts.id, conflictRef: syncConflicts.conflictRef, recordType: syncConflicts.recordType, recordRef: syncConflicts.recordRef, material: syncConflicts.material, detectedAt: syncConflicts.detectedAt })
      .from(syncConflicts).where(eq(syncConflicts.status, "unresolved")).limit(500),
    db.select({ deviceRef: fieldDevices.deviceRef, userId: fieldDevices.userId, revokedAt: fieldDevices.revokedAt, queued: sql<number>`count(${syncPackages.id})` })
      .from(fieldDevices).innerJoin(syncPackages, and(eq(syncPackages.fieldDeviceId, fieldDevices.id), eq(syncPackages.state, "queued")))
      .where(eq(fieldDevices.status, "revoked")).groupBy(fieldDevices.id),
    db.select().from(measurementDevices).where(inArray(measurementDevices.status, ["active", "out_of_service"])).limit(500),
    db.select({ policyRef: insurancePolicies.policyRef, policyType: insurancePolicies.policyType, expiresAt: insurancePolicies.expiresAt, status: insurancePolicies.status })
      .from(insurancePolicies).where(lte(insurancePolicies.expiresAt, horizon)).limit(500),
    db.select({ reviewRef: carrierProfileReviews.reviewRef, unmatchedExternalEvents: carrierProfileReviews.unmatchedExternalEvents, reviewedAt: carrierProfileReviews.reviewedAt, nextReviewDueAt: carrierProfileReviews.nextReviewDueAt })
      .from(carrierProfileReviews).orderBy(desc(carrierProfileReviews.profileObtainedAt)).limit(50),
  ]);

  // Owner labels for credentials: operator names where the owner is an operator.
  const operatorIds = Array.from(new Set(creds.filter(c => c.ownerType === "operator").map(c => c.ownerId)));
  const opRows = operatorIds.length ? await db.select({ id: operators.id, name: operators.name }).from(operators).where(inArray(operators.id, operatorIds)) : [];
  const opName = new Map(opRows.map(o => [o.id, o.name]));
  const unitIds = Array.from(new Set(creds.filter(c => c.ownerType === "unit").map(c => c.ownerId)));
  const unitRows = unitIds.length ? await db.select({ id: units.id, unitNumber: units.unitNumber }).from(units).where(inArray(units.id, unitIds)) : [];
  const unitNo = new Map(unitRows.map(u => [u.id, u.unitNumber]));

  const ownerLabel = (ownerType: string, ownerId: number) =>
    ownerType === "operator" ? opName.get(ownerId) ?? null : ownerType === "unit" ? (unitNo.get(ownerId) ? `Unit ${unitNo.get(ownerId)}` : null) : null;

  /*
   * SPINE item 2 — the query above only finds which owners and types are worth a look. Whether one
   * has expired is the canonical verdict's call, over EVERY row of that type the owner holds: a
   * licence that expired last year beside the renewal now in force is not an exception.
   */
  const awaiting = creds.filter(c => c.pendingReview);
  const flagged = new Map<string, { ownerType: string; ownerId: number; docType: string }>();
  for (const c of creds) flagged.set(`${c.ownerType}\u0000${c.ownerId}\u0000${c.docType}`, { ownerType: c.ownerType, ownerId: c.ownerId, docType: c.docType });
  const owners = Array.from(new Map(Array.from(flagged.values()).map(f => [`${f.ownerType}\u0000${f.ownerId}`, f])).values());
  const history: (typeof complianceDocuments.$inferSelect)[] = [];
  for (let i = 0; i < owners.length; i += 200) {
    const chunk = owners.slice(i, i + 200);
    history.push(...await db.select().from(complianceDocuments).where(or(...chunk.map(o => and(eq(complianceDocuments.ownerType, o.ownerType as never), eq(complianceDocuments.ownerId, o.ownerId))))));
  }
  const credentialVerdicts = Array.from(flagged.values()).map(f => {
    const rows = history.filter(h => h.ownerType === f.ownerType && h.ownerId === f.ownerId && h.docType === f.docType);
    const verdict = complianceRequirementValidity(rows, [f.docType], now);
    const named = rows.find(r => r.id === verdict.documentId) ?? rows[0];
    return { ownerType: f.ownerType, ownerId: f.ownerId, ownerLabel: ownerLabel(f.ownerType, f.ownerId), docType: f.docType, title: named?.title ?? f.docType, verdict };
  });

  // Calibration state per device from its events.
  const deviceIds = devices.map(d => d.id);
  const evRows = deviceIds.length ? await db.select().from(calibrationEvents).where(inArray(calibrationEvents.measurementDeviceId, deviceIds)) : [];
  const evByDevice = new Map<number, CalibrationEvent[]>();
  for (const e of evRows) evByDevice.set(e.measurementDeviceId, [...(evByDevice.get(e.measurementDeviceId) ?? []), e as CalibrationEvent]);

  // Only the latest review per company matters for "overdue"; unmatched events on any.
  const latestReviews = new Map<string, (typeof reviews)[number]>();
  for (const r of reviews) if (!latestReviews.has(r.reviewRef)) latestReviews.set(r.reviewRef, r);

  // P4.2 (0163): open sweeps only. A triaged one has had its person and is not an exception any more.
  const sweeps = await db.select({
    sweepRef: calibrationSweeps.sweepRef, deviceRef: measurementDevices.deviceRef,
    determinationsInQuestion: calibrationSweeps.determinationsInQuestion,
    measurementsInQuestion: calibrationSweeps.measurementsInQuestion,
    suspectFrom: calibrationSweeps.suspectFrom, runAt: calibrationSweeps.runAt,
  }).from(calibrationSweeps)
    .leftJoin(measurementDevices, eq(measurementDevices.id, calibrationSweeps.measurementDeviceId))
    .where(eq(calibrationSweeps.state, "open")).limit(200);
  const inspector = await db.select({ requestRef: academyInspectorRequests.requestRef, issuingAuthority: academyInspectorRequests.issuingAuthority, dueAt: academyInspectorRequests.dueAt, state: academyInspectorRequests.state, irrecoverable: academyInspectorRequests.irrecoverable })
    .from(academyInspectorRequests).where(inArray(academyInspectorRequests.state, ["received", "assembling", "incomplete"])).limit(200);
  return {
    now,
    openCalibrationSweeps: sweeps,
    inspectorRequests: inspector.map(r => ({ requestRef: r.requestRef, issuingAuthority: r.issuingAuthority, dueAt: r.dueAt, state: r.state, irrecoverable: !!r.irrecoverable })),
    securityIncidents: await loadOpenSecurityIncidents(db),
    facilityDirectory: await loadFacilityDirectoryExceptions(db),
    criticalDefects: defects.map(d => ({ id: d.id, unitId: d.unitId, unitNumber: d.unitNumber ?? null, title: d.title, reportedAt: d.reportedAt, status: d.status })),
    roadsideOpen: roadside.map(r => ({ id: r.id, eventRef: r.eventRef, unitNumber: r.unitNumber ?? null, eventType: r.eventType, occurredAt: r.occurredAt, vendorAssigned: r.assignedVendorId != null })),
    vendorBills: bills.map(b => ({ id: b.id, billRef: b.billRef, vendorName: b.vendorName ?? null, total: b.totalCents / 100, status: b.status, matchOutcome: b.matchOutcome, receivedAt: b.receivedAt, dueAt: b.dueAt })),
    purchaseRequests: pas.map(p => ({ id: p.id, authorizationRef: p.authorizationRef, estimatedAmount: p.estimatedAmount, emergency: p.emergency, requestedAt: p.requestedAt, expiresAt: p.expiresAt, status: p.status })),
    credentialsAwaitingVerification: awaiting.map(c => ({ id: c.id, ownerType: c.ownerType, ownerId: c.ownerId, ownerLabel: ownerLabel(c.ownerType, c.ownerId), docType: c.docType, title: c.title, expiresAt: c.expiresAt })),
    credentialVerdicts,
    aiProposals: proposals,
    aiQuestions: questions.map(q => ({ count: Number(q.count), oldest: q.oldest ? new Date(q.oldest) : null, askedToUserId: q.askedToUserId })),
    syncConflicts: conflicts,
    revokedDevicesWithQueue: revoked.map(r => ({ deviceRef: r.deviceRef, userId: r.userId, queued: Number(r.queued), revokedAt: r.revokedAt })),
    measurementDevices: devices.map(d => { const st = calibrationStatus({ events: evByDevice.get(d.id) ?? [], intervalDays: d.calibrationIntervalDays, now }); return { deviceRef: d.deviceRef, deviceType: d.deviceType, status: d.status, calibrationState: st.status, daysRemaining: st.daysRemaining }; }),
    insurancePolicies: policies,
    carrierProfileReviews: Array.from(latestReviews.values()),
    ungatedAssignments: await loadUngatedAssignments(),
    ...(await loadFuelLineFindings()),
  };
}

/* ------------------------------------------------------------------ */
/* Inbox                                                                */
/* ------------------------------------------------------------------ */

export type InboxItem = {
  kind: "task" | "approval" | "notification" | "ai_proposal" | "ai_question" | "conflict" | "my_request";
  ref: string; title: string; detail: string | null; dueAt: Date | null; since: Date; deepLink: { portal: string; route: string };
};

/**
 * v22.20 — the inbox, scoped to the caller's organization.
 *
 * Tasks and notifications are addressed to a person OR to a role. The
 * person-addressed half was always safe; the role-addressed half was not, and
 * became actively unsafe once enforcement started writing role-addressed alerts:
 * an out-of-service notification for "dispatcher" reached every dispatcher in
 * every organization, because the read matched on the role string alone.
 *
 * A row with no organization on it is still shown. Legacy rows predate the
 * column and hiding them would empty real people's inboxes to fix a leak that
 * only exists between organizations.
 */
export async function loadInbox(args: { userId: number; roles: readonly string[]; canApprovePurchases: boolean; canResolveConflicts: boolean; canReviewAssistant: boolean }): Promise<InboxItem[]> {
  const db = await getDb();
  if (!db) return [];
  const roles = args.roles.length ? args.roles : ["__none__"];
  const acting = await resolveActingScope(db, args.userId);
  const [tasks, notes, myProposals, myQuestions, myRequests] = await Promise.all([
    db.select().from(operationalTasks).where(and(
      inArray(operationalTasks.status, ["open", "acknowledged", "in_progress"] as never),
      or(eq(operationalTasks.assignedUserId, args.userId), inArray(operationalTasks.assignedRole, roles)),
      or(eq(operationalTasks.tenantId, acting.tenantId), isNull(operationalTasks.tenantId)),
    )).limit(200),
    db.select().from(workflowNotifications).where(and(
      or(eq(workflowNotifications.recipientUserId, args.userId), inArray(workflowNotifications.recipientRole, roles)),
      isNull(workflowNotifications.acknowledgedAt),
      or(eq(workflowNotifications.tenantId, acting.tenantId), isNull(workflowNotifications.tenantId)),
    )).orderBy(desc(workflowNotifications.queuedAt)).limit(100),
    db.select({ proposalId: assistantProposals.proposalId, title: assistantProposals.title, formKey: assistantProposals.formKey, createdAt: assistantProposals.createdAt }).from(assistantProposals).where(and(eq(assistantProposals.createdByUserId, args.userId), eq(assistantProposals.commitState, "awaiting_readback"))).limit(50),
    db.select({ questionRef: assistantQuestions.questionRef, question: assistantQuestions.question, createdAt: assistantQuestions.createdAt }).from(assistantQuestions).where(and(eq(assistantQuestions.askedToUserId, args.userId), eq(assistantQuestions.status, "pending"))).limit(50),
    db.select({ authorizationRef: purchaseAuthorizations.authorizationRef, status: purchaseAuthorizations.status, estimatedAmount: purchaseAuthorizations.estimatedAmount, requestedAt: purchaseAuthorizations.requestedAt }).from(purchaseAuthorizations).where(and(eq(purchaseAuthorizations.requestedByUserId, args.userId), eq(purchaseAuthorizations.status, "requested"))).limit(50),
  ]);
  const items: InboxItem[] = [];
  for (const t of tasks) items.push({ kind: "task", ref: t.taskNumber, title: t.title, detail: t.description ?? null, dueAt: t.dueAt, since: t.createdAt, deepLink: { portal: "office_administration", route: `/tasks/${t.taskNumber}` } });
  for (const n of notes) items.push({ kind: "notification", ref: n.notificationKey, title: n.title, detail: n.body ?? null, dueAt: null, since: n.queuedAt, deepLink: { portal: "office_administration", route: n.deepLink ?? "/inbox" } });
  for (const p of myProposals) items.push({ kind: "ai_proposal", ref: p.proposalId, title: `Confirm your ${p.formKey.replace(/_/g, " ")}: ${p.title}`, detail: "Read-back awaits your confirmation", dueAt: null, since: p.createdAt, deepLink: { portal: "field_workforce", route: `/assistant/proposals/${p.proposalId}` } });
  for (const q of myQuestions) items.push({ kind: "ai_question", ref: q.questionRef, title: q.question, detail: null, dueAt: null, since: q.createdAt, deepLink: { portal: "field_workforce", route: `/assistant/questions/${q.questionRef}` } });
  for (const r of myRequests) items.push({ kind: "my_request", ref: r.authorizationRef, title: `Your purchase request $${r.estimatedAmount.toFixed(2)} is awaiting approval`, detail: null, dueAt: null, since: r.requestedAt, deepLink: { portal: "field_workforce", route: `/purchasing/${r.authorizationRef}` } });
  if (args.canApprovePurchases) {
    const pending = await db.select({ authorizationRef: purchaseAuthorizations.authorizationRef, estimatedAmount: purchaseAuthorizations.estimatedAmount, emergency: purchaseAuthorizations.emergency, requestedAt: purchaseAuthorizations.requestedAt, requestedByUserId: purchaseAuthorizations.requestedByUserId }).from(purchaseAuthorizations).where(eq(purchaseAuthorizations.status, "requested")).limit(50);
    // Never one's own request — that is not an approval one may give.
    for (const p of pending.filter(p => p.requestedByUserId !== args.userId)) items.push({ kind: "approval", ref: p.authorizationRef, title: `${p.emergency ? "Emergency " : ""}purchase approval: $${p.estimatedAmount.toFixed(2)}`, detail: null, dueAt: null, since: p.requestedAt, deepLink: { portal: "management", route: `/purchasing/${p.authorizationRef}` } });
  }
  if (args.canResolveConflicts) {
    const conflicts = await db.select({ conflictRef: syncConflicts.conflictRef, recordType: syncConflicts.recordType, recordRef: syncConflicts.recordRef, detectedAt: syncConflicts.detectedAt }).from(syncConflicts).where(eq(syncConflicts.status, "unresolved")).limit(50);
    for (const c of conflicts) items.push({ kind: "conflict", ref: c.conflictRef, title: `Resolve sync conflict on ${c.recordType} ${c.recordRef}`, detail: null, dueAt: null, since: c.detectedAt, deepLink: { portal: "office_administration", route: `/sync/conflicts/${c.conflictRef}` } });
  }
  return items.sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || b.since.getTime() - a.since.getTime());
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

export type SearchHit = { entityType: string; entityId: number | string; label: string; status: string | null; deepLink: { portal: string; route: string }; readPermission: string };

/** Resolve a tracking number or free text across entities. Permission filtering is the router's job. */
export async function searchEverything(q: string): Promise<SearchHit[]> {
  const db = await getDb();
  if (!db) return [];
  const term = q.trim();
  if (term.length < 2) return [];
  const pat = `%${term}%`;
  const hits: SearchHit[] = [];
  const [u, j, t, l, d, i, wo, pa, vb, rs, fd, md, ip, fx] = await Promise.all([
    db.select({ id: units.id, unitNumber: units.unitNumber, maintenanceStatus: units.maintenanceStatus }).from(units).where(like(units.unitNumber, pat)).limit(10),
    db.select({ id: jobs.id, jobNumber: jobs.jobCode, status: jobs.status, customer: jobs.customer }).from(jobs).where(or(like(jobs.jobCode, pat), like(jobs.customer, pat))).limit(10),
    db.select({ id: trips.id, tripNumber: trips.tripNumber, status: trips.status }).from(trips).where(like(trips.tripNumber, pat)).limit(10),
    db.select({ id: loads.id, loadNumber: loads.loadNumber, chainState: loads.chainState }).from(loads).where(like(loads.loadNumber, pat)).limit(10),
    db.select({ id: disposalTickets.id, ticketNumber: disposalTickets.ticketNumber, facilityTicketNumber: disposalTickets.facilityTicketNumber, verificationStatus: disposalTickets.verificationStatus }).from(disposalTickets).where(or(like(disposalTickets.ticketNumber, pat), like(disposalTickets.facilityTicketNumber, pat))).limit(10),
    db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status }).from(invoices).where(like(invoices.invoiceNumber, pat)).limit(10),
    db.select({ id: workOrders.id, workOrderNumber: workOrders.workOrderNumber, status: workOrders.status }).from(workOrders).where(like(workOrders.workOrderNumber, pat)).limit(10),
    db.select({ id: purchaseAuthorizations.id, authorizationRef: purchaseAuthorizations.authorizationRef, status: purchaseAuthorizations.status }).from(purchaseAuthorizations).where(like(purchaseAuthorizations.authorizationRef, pat)).limit(10),
    db.select({ id: vendorBills.id, billRef: vendorBills.billRef, vendorInvoiceNumber: vendorBills.vendorInvoiceNumber, status: vendorBills.status }).from(vendorBills).where(or(like(vendorBills.billRef, pat), like(vendorBills.vendorInvoiceNumber, pat))).limit(10),
    db.select({ id: roadsideServiceEvents.id, eventRef: roadsideServiceEvents.eventRef, status: roadsideServiceEvents.status }).from(roadsideServiceEvents).where(like(roadsideServiceEvents.eventRef, pat)).limit(10),
    db.select({ deviceRef: fieldDevices.deviceRef, status: fieldDevices.status }).from(fieldDevices).where(like(fieldDevices.deviceRef, pat)).limit(10),
    db.select({ deviceRef: measurementDevices.deviceRef, status: measurementDevices.status, deviceType: measurementDevices.deviceType }).from(measurementDevices).where(like(measurementDevices.deviceRef, pat)).limit(10),
    db.select({ policyRef: insurancePolicies.policyRef, policyNumber: insurancePolicies.policyNumber, status: insurancePolicies.status }).from(insurancePolicies).where(or(like(insurancePolicies.policyRef, pat), like(insurancePolicies.policyNumber, pat))).limit(10),
    db.select({ id: fuelTransactions.id, fuelRef: fuelTransactions.fuelRef, status: fuelTransactions.status }).from(fuelTransactions).where(like(fuelTransactions.fuelRef, pat)).limit(10),
  ]);
  for (const x of u) hits.push({ entityType: "unit", entityId: x.id, label: `Unit ${x.unitNumber}`, status: x.maintenanceStatus ?? null, deepLink: { portal: "fleet_maintenance", route: `/units/${x.id}` }, readPermission: "roadside.report" }); // every operational role may name a unit; deeper detail is gated on the unit's own routes
  for (const x of j) hits.push({ entityType: "job", entityId: x.id, label: `${x.jobNumber}${x.customer ? ` — ${x.customer}` : ""}`, status: x.status, deepLink: { portal: "dispatch_operations", route: `/jobs/${x.id}` }, readPermission: "job.read" });
  for (const x of t) hits.push({ entityType: "trip", entityId: x.id, label: x.tripNumber, status: x.status, deepLink: { portal: "dispatch_operations", route: `/trips/${x.id}` }, readPermission: "trip.read" });
  for (const x of l) hits.push({ entityType: "load", entityId: x.id, label: x.loadNumber ?? `Load #${x.id}`, status: x.chainState, deepLink: { portal: "dispatch_operations", route: `/loads/${x.id}` }, readPermission: "load.read" });
  for (const x of d) hits.push({ entityType: "disposalTicket", entityId: x.id, label: `${x.ticketNumber}${x.facilityTicketNumber ? ` (facility ${x.facilityTicketNumber})` : ""}`, status: x.verificationStatus, deepLink: { portal: "office_administration", route: `/disposal/${x.id}` }, readPermission: "evidence.read_job_operational" });
  for (const x of i) hits.push({ entityType: "invoice", entityId: x.id, label: x.invoiceNumber, status: x.status, deepLink: { portal: "finance_billing", route: `/invoices/${x.id}` }, readPermission: "billing.read" });
  for (const x of wo) hits.push({ entityType: "workOrder", entityId: x.id, label: x.workOrderNumber, status: x.status, deepLink: { portal: "fleet_maintenance", route: `/work-orders/${x.id}` }, readPermission: "maintenance.read_defect" });
  for (const x of pa) hits.push({ entityType: "purchaseAuthorization", entityId: x.id, label: x.authorizationRef, status: x.status, deepLink: { portal: "management", route: `/purchasing/${x.authorizationRef}` }, readPermission: "purchasing.request" });
  for (const x of vb) hits.push({ entityType: "vendorBill", entityId: x.id, label: `${x.billRef} (${x.vendorInvoiceNumber})`, status: x.status, deepLink: { portal: "finance_billing", route: `/ap/bills/${x.billRef}` }, readPermission: "vendor.bill.review" });
  for (const x of rs) hits.push({ entityType: "roadsideEvent", entityId: x.id, label: x.eventRef, status: x.status, deepLink: { portal: "dispatch_operations", route: `/roadside/${x.eventRef}` }, readPermission: "roadside.report" });
  for (const x of fd) hits.push({ entityType: "fieldDevice", entityId: x.deviceRef, label: x.deviceRef, status: x.status, deepLink: { portal: "safety_compliance", route: `/devices/${x.deviceRef}` }, readPermission: "device.manage" });
  for (const x of md) hits.push({ entityType: "measurementDevice", entityId: x.deviceRef, label: `${x.deviceType.replace(/_/g, " ")} ${x.deviceRef}`, status: x.status, deepLink: { portal: "fleet_maintenance", route: `/calibration/${x.deviceRef}` }, readPermission: "calibration.impact" });
  for (const x of ip) hits.push({ entityType: "insurancePolicy", entityId: x.policyRef, label: `Policy ${x.policyRef} (${x.policyNumber})`, status: x.status, deepLink: { portal: "finance_billing", route: `/insurance/policies/${x.policyRef}` }, readPermission: "insurance.read_summary" });
  for (const x of fx) hits.push({ entityType: "fuelTransaction", entityId: x.id, label: x.fuelRef, status: x.status, deepLink: { portal: "finance_billing", route: `/fuel/${x.id}` }, readPermission: "tax.expense.review" });
  return hits;
}

/* ------------------------------------------------------------------ */
/* Timeline                                                             */
/* ------------------------------------------------------------------ */

export type TimelineEvent = {
  occurredAt: Date; recordedAt: Date | null; kind: string; title: string; detail: string | null;
  actor: string | null; ref: string | null; readPermission: string;
};

/** An entity's history from the records that mention it. occurredAt is the event; recordedAt is when LeaseOS learned of it. */
export async function loadTimeline(args: { entityType: "unit" | "job" | "trip" | "load"; entityId: number; limit?: number }): Promise<TimelineEvent[]> {
  const db = await getDb();
  if (!db) return [];
  const ev: TimelineEvent[] = [];
  const id = args.entityId;

  if (args.entityType === "unit") {
    const [defects, releases, roadside, fuel, tickets, cal] = await Promise.all([
      db.select().from(maintenanceDefects).where(eq(maintenanceDefects.unitId, id)).limit(200),
      db.select().from(workOrderReleases).where(eq(workOrderReleases.unitId, id)).limit(100),
      db.select().from(roadsideServiceEvents).where(eq(roadsideServiceEvents.unitId, id)).limit(100),
      db.select().from(fuelTransactions).where(eq(fuelTransactions.unitId, id)).limit(200),
      db.select().from(disposalTickets).where(eq(disposalTickets.unitId, id)).limit(200),
      db.select({ deviceRef: measurementDevices.deviceRef }).from(measurementDevices).limit(0),
    ]);
    void cal;
    for (const d of defects) ev.push({ occurredAt: d.reportedAt, recordedAt: d.createdAt, kind: "defect", title: `Defect reported: ${d.title}`, detail: d.detail, actor: d.reportedBy != null ? `user ${d.reportedBy}` : null, ref: `defect:${d.id}`, readPermission: "maintenance.read_defect" });
    for (const r of releases) ev.push({ occurredAt: r.releasedAt, recordedAt: r.createdAt, kind: "mechanic_release", title: `Mechanic release: ${r.releaseType}`, detail: r.repairSummary, actor: r.technicianIdentifier ?? null, ref: `release:${r.id}`, readPermission: "maintenance.read_defect" });
    for (const r of roadside) ev.push({ occurredAt: r.occurredAt, recordedAt: r.reportedAt, kind: "roadside", title: `Roadside: ${r.eventType.replace(/_/g, " ")}`, detail: r.driverStatement, actor: `user ${r.reportedByUserId}`, ref: r.eventRef, readPermission: "roadside.report" });
    for (const f of fuel) ev.push({ occurredAt: f.occurredAt, recordedAt: f.createdAt, kind: "fuel", title: `Fuel: ${f.quantity ?? "?"} ${f.quantityUnit ?? ""} ${f.fuelType}`, detail: f.vendorName, actor: f.fueledByUserId != null ? `user ${f.fueledByUserId}` : null, ref: f.fuelRef, readPermission: "tax.expense.review" });
    for (const t of tickets) ev.push({ occurredAt: t.scaleInAt ?? t.createdAt, recordedAt: t.createdAt, kind: "disposal_ticket", title: `Disposal ticket ${t.facilityTicketNumber ?? t.ticketNumber} (${t.verificationStatus})`, detail: t.netKg != null ? `${t.netKg} kg net` : null, actor: null, ref: t.ticketNumber, readPermission: "evidence.read_job_operational" });
  } else if (args.entityType === "job") {
    const [tr, ld, tk] = await Promise.all([
      db.select().from(trips).where(eq(trips.jobId, id)).limit(100),
      db.select().from(loads).where(eq(loads.jobId, id)).limit(200),
      db.select().from(disposalTickets).where(eq(disposalTickets.jobId, id)).limit(200),
    ]);
    for (const t of tr) ev.push({ occurredAt: t.startedAt ?? t.createdAt, recordedAt: t.createdAt, kind: "trip", title: `Trip ${t.tripNumber} (${t.status})`, detail: null, actor: null, ref: t.tripNumber, readPermission: "trip.read" });
    for (const l of ld) ev.push({ occurredAt: l.createdAt, recordedAt: l.createdAt, kind: "load", title: `Load ${l.loadNumber ?? l.id}: ${l.chainState}`, detail: l.material, actor: null, ref: l.loadNumber, readPermission: "load.read" });
    for (const t of tk) ev.push({ occurredAt: t.scaleInAt ?? t.createdAt, recordedAt: t.createdAt, kind: "disposal_ticket", title: `Disposal ticket ${t.facilityTicketNumber ?? t.ticketNumber} (${t.verificationStatus})`, detail: null, actor: null, ref: t.ticketNumber, readPermission: "evidence.read_job_operational" });
  } else if (args.entityType === "trip") {
    const [ld, tk, fuel] = await Promise.all([
      db.select().from(loads).where(eq(loads.tripId, id)).limit(100),
      db.select().from(disposalTickets).where(eq(disposalTickets.tripId, id)).limit(100),
      db.select().from(fuelTransactions).where(eq(fuelTransactions.tripId, id)).limit(100),
    ]);
    for (const l of ld) ev.push({ occurredAt: l.createdAt, recordedAt: l.createdAt, kind: "load", title: `Load ${l.loadNumber ?? l.id}: ${l.chainState}`, detail: l.material, actor: null, ref: l.loadNumber, readPermission: "load.read" });
    for (const t of tk) ev.push({ occurredAt: t.scaleInAt ?? t.createdAt, recordedAt: t.createdAt, kind: "disposal_ticket", title: `Disposal ticket ${t.facilityTicketNumber ?? t.ticketNumber}`, detail: null, actor: null, ref: t.ticketNumber, readPermission: "evidence.read_job_operational" });
    for (const f of fuel) ev.push({ occurredAt: f.occurredAt, recordedAt: f.createdAt, kind: "fuel", title: `Fuel: ${f.quantity ?? "?"} ${f.quantityUnit ?? ""}`, detail: f.vendorName, actor: null, ref: f.fuelRef, readPermission: "tax.expense.review" });
  } else {
    const [tk, receipts] = await Promise.all([
      db.select().from(disposalTickets).where(eq(disposalTickets.loadId, id)).limit(50),
      db.select().from(assistantCommitReceipts).where(and(eq(assistantCommitReceipts.targetType, "disposal_ticket"))).limit(0),
    ]);
    void receipts;
    for (const t of tk) ev.push({ occurredAt: t.scaleInAt ?? t.createdAt, recordedAt: t.createdAt, kind: "disposal_ticket", title: `Disposal ticket ${t.facilityTicketNumber ?? t.ticketNumber} (${t.verificationStatus})`, detail: t.netKg != null ? `${t.netKg} kg net` : null, actor: null, ref: t.ticketNumber, readPermission: "evidence.read_job_operational" });
  }
  return ev.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).slice(-(args.limit ?? 200));
}


/** 0131 — open security incidents with what the exception centre needs to know about them. */
async function loadOpenSecurityIncidents(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  const open = await db.select({ id: securityIncidents.id, incidentRef: securityIncidents.incidentRef, title: securityIncidents.title, severity: securityIncidents.severity, personalInformationSuspected: securityIncidents.personalInformationSuspected })
    .from(securityIncidents).where(inArray(securityIncidents.status, ["open", "triaging", "contained", "investigating", "recovering", "monitoring"])).limit(200);
  if (!open.length) return [];
  const ids = open.map(o => o.id);
  const [assessed, unsent] = await Promise.all([
    db.select({ securityIncidentId: privacyBreachAssessments.securityIncidentId }).from(privacyBreachAssessments).where(and(inArray(privacyBreachAssessments.securityIncidentId, ids), eq(privacyBreachAssessments.status, "complete"))),
    db.select({ securityIncidentId: incidentNotificationObligations.securityIncidentId, recipientType: incidentNotificationObligations.recipientType, dueAt: incidentNotificationObligations.dueAt }).from(incidentNotificationObligations).where(and(inArray(incidentNotificationObligations.securityIncidentId, ids), eq(incidentNotificationObligations.state, "required"))),
  ]);
  const assessedIds = new Set(assessed.map(a => a.securityIncidentId));
  return open.map(o => ({ incidentRef: o.incidentRef, title: o.title, severity: o.severity, personalInformationSuspected: !!o.personalInformationSuspected, assessed: assessedIds.has(o.id), unsentNotifications: unsent.filter(u => u.securityIncidentId === o.id).map(u => ({ recipientType: u.recipientType, dueAt: u.dueAt })) }));
}

/* ------------------------------------------------------------------ */
/* P3.6 — walking the chain around a resolved record                   */
/* ------------------------------------------------------------------ */

/** The read permission each hop needs, so the walk can tell "not allowed" from "not there". */
export const CHAIN_READ_PERMISSION: Record<string, string> = {
  customer: "customer.read", job: "job.read", trip: "trip.read", load: "load.read",
  manifest: "manifest.read", disposal_ticket: "disposal.read", field_ticket: "closeout.read",
  billing_book: "billing.read", invoice: "billing.read",
};

/**
 * Resolve the records around an anchor, reading each hop only if the caller may.
 *
 * Every hop is reached by walking **up** to the job and back down, because that is how the data is
 * shaped: a load knows its job and trip, a disposal ticket knows its load, and an invoice knows its
 * billing book. A hop the caller may not read is never queried at all — not queried and discarded,
 * which would still let timing say something.
 */
export async function resolveChainAround(
  anchor: { kind: string; id: number },
  can: (permission: string) => boolean,
): Promise<{ found: Record<string, { ref: string; id: number | null; status?: string | null }>; unreadable: string[] }> {
  const db = await getDb();
  const found: Record<string, { ref: string; id: number | null; status?: string | null }> = {};
  if (!db) return { found, unreadable: Object.keys(CHAIN_READ_PERMISSION).filter(k => !can(CHAIN_READ_PERMISSION[k]!)) };
  const unreadable = Object.keys(CHAIN_READ_PERMISSION).filter(k => !can(CHAIN_READ_PERMISSION[k]!));
  const allowed = (k: string) => !unreadable.includes(k);

  // Find the load the anchor hangs from, since the rest of the chain hangs from it too.
  let loadId: number | null = anchor.kind === "load" ? anchor.id : null;
  if (loadId == null && anchor.kind === "disposal_ticket" && allowed("disposal_ticket")) {
    const [d] = await db.select({ l: disposalTickets.loadId }).from(disposalTickets).where(eq(disposalTickets.id, anchor.id)).limit(1);
    loadId = d?.l ?? null;
  }

  if (loadId != null && allowed("load")) {
    const [l] = await db.select().from(loads).where(eq(loads.id, loadId)).limit(1);
    if (l) {
      found.load = { ref: l.loadNumber, id: l.id, status: l.chainState };
      if (l.jobId && allowed("job")) {
        const [j] = await db.select().from(jobs).where(eq(jobs.id, l.jobId)).limit(1);
        if (j) {
          found.job = { ref: j.jobCode, id: j.id, status: j.status };
          if (j.customer && allowed("customer")) found.customer = { ref: j.customer, id: null };
        }
      }
      if (l.tripId && allowed("trip")) {
        const [t] = await db.select().from(trips).where(eq(trips.id, l.tripId)).limit(1);
        if (t) found.trip = { ref: t.tripNumber, id: t.id, status: t.status };
      }
      if (l.billingBookId && allowed("billing_book")) {
        const [b] = await db.select().from(billingBooks).where(eq(billingBooks.id, l.billingBookId)).limit(1);
        if (b) found.billing_book = { ref: b.bookNumber, id: b.id, status: null };
      }
      if (allowed("disposal_ticket")) {
        const [d] = await db.select().from(disposalTickets).where(eq(disposalTickets.loadId, l.id)).limit(1);
        if (d) found.disposal_ticket = { ref: d.ticketNumber, id: d.id, status: d.verificationStatus };
      }
      if (allowed("manifest")) {
        const [mf] = await db.select().from(manifests).where(eq(manifests.loadId, l.id)).limit(1);
        if (mf) found.manifest = { ref: mf.manifestNumber, id: mf.id, status: mf.status };
      }
    }
  }
  if (found.job?.id && allowed("field_ticket")) {
    const [ft] = await db.select().from(fieldTickets).where(eq(fieldTickets.jobId, found.job.id)).limit(1);
    if (ft) found.field_ticket = { ref: ft.ticketNumber, id: ft.id, status: ft.status };
  }
  if (found.billing_book?.id && allowed("invoice")) {
    const [inv] = await db.select().from(invoices).where(eq(invoices.billingBookId, found.billing_book.id)).limit(1);
    if (inv) found.invoice = { ref: inv.invoiceNumber, id: inv.id, status: inv.status };
  }
  return { found, unreadable };
}
