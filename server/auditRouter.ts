/**
 * Audit packages — the API. Preparation gathers what the chain holds for
 * the subject and period; release is a second person's; downloads are rows.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, mintedIn, type TenantScope } from "./db";
import { dispatchEligibilityChecks } from "../drizzle/schema";
import { type SQL } from "drizzle-orm";
import { type CapabilityResult } from "./_core/interEngineStatus";
import { capabilityItems, dispatchContractFor } from "./_core/readinessCapabilities";
import { auditPackageAccess, auditPackageItems, auditPackages, ccaSchedules, clientAdjustments, competencySignoffs, complianceDocuments, disposalTickets, drivingEvents, dutyRecords, faultCodes, fieldTicketDocuments, fieldTicketEvents, fieldTicketRevisions, fieldTicketSignatures, fieldTickets, gstReturns, iftaReturns, inspections, insuranceClaims, insurancePolicies, loads, maintenanceDefects, operators, programAcknowledgements, recallUnitStatus, safetyEvents, tailgateMeetings, tireInstallations, trainingRecords, units, workOrderReleases, workOrders, writtenProgramVersions, vendors, vendorBills, commercialApprovals, commercialApprovalSignatures, contractorPayables, facilityStatements, facilityStatementLines, commercialDocuments, commercialDocumentLinks, commercialDocumentDeliveries } from "../drizzle/schema";
import { assemble, releaseDecision, sha256, type PackageKind, type RawItem } from "./_core/auditPackage";
import { renderPdf } from "./_core/ticketPdf";
import { storagePut, storageGetSignedUrl } from "./storage";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
const inPeriod = <T extends { [k: string]: unknown }>(rows: T[], key: keyof T, from: Date | null, to: Date | null) => rows.filter(r => { const d = r[key] as Date | null; return !d || ((!from || d >= from) && (!to || d <= to)); });
const row = (r: object) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

/** What the chain holds for a subject, by kind. Nothing is asserted here; rows are named and hashed as they are. */
/** P7.7 registry documents linked to any of these records — current versions, with their hashes and delivery log. */
async function registryDocumentsFor(db: Awaited<ReturnType<typeof dbOrThrow>>, keys: [string, string][]): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const seen = new Set<number>();
  for (const [recordType, recordRef] of keys) {
    const links = await db.select({ documentId: commercialDocumentLinks.documentId }).from(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.recordType, recordType), eq(commercialDocumentLinks.recordRef, recordRef)));
    for (const l of links) {
      if (seen.has(l.documentId)) continue; seen.add(l.documentId);
      const d = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, l.documentId)).limit(1))[0];
      if (!d) continue;
      const deliveries = await db.select().from(commercialDocumentDeliveries).where(eq(commercialDocumentDeliveries.documentId, d.id));
      out.push({ itemKind: "registry_document", sourceTable: "commercialDocuments", sourceId: d.id, sourceRef: d.documentRef, title: `${d.documentType} ${d.documentRef} v${d.version} (${d.status}) sha256 ${d.contentHash.slice(0, 12)}… — ${deliveries.length} deliver${deliveries.length === 1 ? "y" : "ies"}`, row: { ...row(d), deliveries: deliveries.map(x => ({ deliveryRef: x.deliveryRef, channel: x.channel, status: x.status, sentAt: x.sentAt?.toISOString() ?? null, deliveredAt: x.deliveredAt?.toISOString() ?? null, failureReason: x.failureReason })) } });
    }
  }
  return out;
}

/**
 * P8.1 — the capability picture the dispatch decisions were made on, as package items.
 *
 * Read from `dispatchEligibilityChecks`, never recomputed. A package assembled months later must
 * say what was and was not evaluated **at the time**; running the composer again would answer with
 * today's configuration for yesterday's dispatch, which would look like evidence and not be any.
 *
 * A check written before `0152` has no picture. That is reported as an item saying so, rather than
 * being skipped — "we do not know what was evaluated" is itself a fact an auditor should see, and
 * silently omitting it would make an old package look as complete as a new one.
 */
async function capabilityPictureItems(
  db: Awaited<ReturnType<typeof dbOrThrow>>,
  where: SQL | undefined,
): Promise<RawItem[]> {
  if (!where) return [];
  const checks = await db.select().from(dispatchEligibilityChecks).where(where);
  const items: RawItem[] = [];
  for (const c of checks) {
    if (!c.capabilitiesJson) {
      items.push({
        itemKind: "capability_evaluation",
        sourceTable: "dispatchEligibilityChecks", sourceId: c.id, sourceRef: `check:${c.id}`,
        title: `Eligibility check ${c.id} — capability picture not recorded (predates 0152)`,
        row: { checkId: c.id, evaluatedAt: c.evaluatedAt?.toISOString() ?? null, verdict: c.verdict, capabilityPicture: "not_recorded", note: "This check was made before the capability contract existed; what was not evaluated at the time is unknown and is not assumed." },
      });
      continue;
    }
    const capabilities = JSON.parse(c.capabilitiesJson) as CapabilityResult[];
    const contract = dispatchContractFor({
      routingInUse: c.routeApprovalRef != null,
      destinationRequired: capabilities.some(x => x.capability === "destination acceptance"),
      mechanicReleaseApplicable: capabilities.some(x => x.capability === "mechanic release"),
    });
    for (const item of capabilityItems("dispatch readiness", contract, capabilities, {
      engine: "readinessComposer", profileVersion: c.fingerprint,
    })) {
      items.push({
        ...item,
        sourceTable: "dispatchEligibilityChecks", sourceId: c.id,
        sourceRef: `check:${c.id}:${item.row.capability as string}`,
        row: { ...item.row, checkId: c.id, evaluatedAt: c.evaluatedAt?.toISOString() ?? null, checkVerdict: c.verdict, capabilityVerdict: c.capabilityVerdict },
      });
    }
  }
  return items;
}

async function gather(kind: PackageKind, subjectRef: string, from: Date | null, to: Date | null, scope: TenantScope): Promise<{ subjectType: string; items: RawItem[] }> {
  const db = await dbOrThrow();
  const items: RawItem[] = [];
  if (kind === "vehicle") {
    const unit = (await db.select().from(units).where(eq(units.unitNumber, subjectRef)).limit(1))[0];
    if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${subjectRef} not found` });
    for (const c of await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, "unit"), eq(complianceDocuments.ownerId, unit.id)))) items.push({ itemKind: /inspection/i.test(c.docType) ? "inspection_credential" : "unit_credential", sourceTable: "complianceDocuments", sourceId: c.id, sourceRef: c.identifier, title: `${c.docType}: ${c.title}`, row: row(c) });
    items.push(...await capabilityPictureItems(db, eq(dispatchEligibilityChecks.unitId, unit.id)));
    const wos = inPeriod(await db.select().from(workOrders).where(eq(workOrders.unitId, unit.id)), "openedAt", from, to);
    for (const w of wos) items.push({ itemKind: "work_order", sourceTable: "workOrders", sourceId: w.id, sourceRef: w.workOrderNumber, title: `Work order ${w.workOrderNumber} (${w.status})`, row: row(w) });
    for (const d of inPeriod(await db.select().from(maintenanceDefects).where(eq(maintenanceDefects.unitId, unit.id)), "reportedAt", from, to)) items.push({ itemKind: "defect", sourceTable: "maintenanceDefects", sourceId: d.id, sourceRef: null, title: `Defect: ${d.title} (${d.severity}, ${d.status})`, row: row(d) });
    for (const r of await db.select().from(workOrderReleases).where(eq(workOrderReleases.unitId, unit.id))) items.push({ itemKind: "mechanic_release", sourceTable: "workOrderReleases", sourceId: r.id, sourceRef: null, title: `Mechanic release (${r.releaseType})`, row: row(r) });
    for (const t of await db.select().from(tireInstallations).where(eq(tireInstallations.unitId, unit.id))) items.push({ itemKind: "tire_installation", sourceTable: "tireInstallations", sourceId: t.id, sourceRef: t.axlePosition, title: `Tire at ${t.axlePosition}`, row: row(t) });
    for (const f of await db.select().from(faultCodes).where(eq(faultCodes.unitId, unit.id))) items.push({ itemKind: "fault_code", sourceTable: "faultCodes", sourceId: f.id, sourceRef: f.code, title: `Fault ${f.code} (${f.status}, severity ${f.severityDetermination})`, row: row(f) });
    for (const r of await db.select().from(recallUnitStatus).where(eq(recallUnitStatus.unitId, unit.id))) items.push({ itemKind: "recall_status", sourceTable: "recallUnitStatus", sourceId: r.id, sourceRef: null, title: `Recall status: ${r.status}`, row: row(r) });
    return { subjectType: "unit", items };
  }
  if (kind === "driver") {
    const op = (await db.select().from(operators).where(eq(operators.id, Number(subjectRef))).limit(1))[0];
    if (!op) throw new TRPCError({ code: "NOT_FOUND", message: `Operator ${subjectRef} not found` });
    items.push(...await capabilityPictureItems(db, eq(dispatchEligibilityChecks.operatorId, op.id)));
    for (const c of await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, op.id)))) items.push({ itemKind: c.privateDetail ? `medical_${c.docType}` : /licen/i.test(c.docType) ? "licence_credential" : "credential", sourceTable: "complianceDocuments", sourceId: c.id, sourceRef: c.identifier, title: `${c.docType}: ${c.title}`, row: row(c) });
    if (op.userId) {
      for (const t of await db.select().from(trainingRecords).where(and(eq(trainingRecords.userId, op.userId), eq(trainingRecords.verificationStatus, "verified")))) items.push({ itemKind: "training", sourceTable: "trainingRecords", sourceId: t.id, sourceRef: t.trainingRef, title: `Training: ${t.title}`, row: row(t) });
      for (const c of await db.select().from(competencySignoffs).where(eq(competencySignoffs.userId, op.userId))) items.push({ itemKind: "competency", sourceTable: "competencySignoffs", sourceId: c.id, sourceRef: c.competencyCode, title: `Competency ${c.competencyCode}: ${c.level}`, row: row(c) });
    }
    for (const d of inPeriod(await db.select().from(dutyRecords).where(eq(dutyRecords.operatorId, op.id)), "startedAt", from, to)) items.push({ itemKind: "duty_record", sourceTable: "dutyRecords", sourceId: d.id, sourceRef: null, title: `Duty ${d.dutyStatus} ${d.startedAt.toISOString()}`, row: row(d) });
    return { subjectType: "operator", items };
  }
  if (kind === "vendor") {
    const v = (await db.select().from(vendors).where(eq(vendors.vendorRef, subjectRef)).limit(1))[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: `Vendor ${subjectRef} not found` });
    items.push({ itemKind: "vendor", sourceTable: "vendors", sourceId: v.id, sourceRef: v.vendorRef, title: `Vendor ${v.name}${v.orgRef ? ` (organization ${v.orgRef})` : " (not linked to an organization)"}`, row: row(v) });
    const bills = inPeriod(await db.select().from(vendorBills).where(eq(vendorBills.vendorId, v.id)), "invoiceDate", from, to);
    for (const b of bills) {
      items.push({ itemKind: "vendor_bill", sourceTable: "vendorBills", sourceId: b.id, sourceRef: b.billRef, title: `Vendor bill ${b.billRef} — ${b.vendorInvoiceNumber} (${b.status}, ${b.matchOutcome ?? "unmatched"})`, row: row(b) });
      // The approval ledger: what the ladder required at the time, and who signed, in order — the identities withheld by policy, the roles kept.
      for (const subjectType of ["vendor_bill", "vendor_bill_payment"]) {
        const appr = (await db.select().from(commercialApprovals).where(and(eq(commercialApprovals.subjectType, subjectType), eq(commercialApprovals.subjectRef, b.billRef))).limit(1))[0];
        if (!appr) continue;
        const sigs = await db.select().from(commercialApprovalSignatures).where(eq(commercialApprovalSignatures.commercialApprovalId, appr.id)).orderBy(commercialApprovalSignatures.sequence);
        items.push({ itemKind: "approval_ledger", sourceTable: "commercialApprovals", sourceId: appr.id, sourceRef: appr.approvalRef, title: `Approval ledger ${appr.approvalRef} (${subjectType}, ${appr.status}): ${sigs.map(s => `${s.decision} by ${(typeof s.rolesAtApproval === "string" ? JSON.parse(s.rolesAtApproval) : s.rolesAtApproval as string[]).join("/")} #${s.sequence}`).join("; ") || "no signatures"}`, row: { ...row(appr), signatures: sigs.map(s => ({ sequence: s.sequence, decision: s.decision, roles: typeof s.rolesAtApproval === "string" ? JSON.parse(s.rolesAtApproval) : s.rolesAtApproval, at: s.at.toISOString(), note: s.note })) } });
      }
      if (b.status === "ready_to_pay" || b.status === "paid") { if (!(await db.select({ id: commercialApprovals.id }).from(commercialApprovals).where(and(eq(commercialApprovals.subjectType, "vendor_bill"), eq(commercialApprovals.subjectRef, b.billRef))).limit(1))[0]) items.push({ itemKind: "gap_note", sourceTable: "vendorBills", sourceId: b.id, sourceRef: b.billRef, title: `Bill ${b.billRef} is ${b.status} with no approval-ledger record (approved before the ladder existed, or outside it)`, row: {} }); }
    }
    if (v.orgRef) {
      for (const p of inPeriod(await db.select().from(contractorPayables).where(eq(contractorPayables.payeeOrgRef, v.orgRef)), "createdAt", from, to)) items.push({ itemKind: "contractor_payable", sourceTable: "contractorPayables", sourceId: p.id, sourceRef: p.payableRef, title: `Contractor payable ${p.payableRef} (${p.state}) ${p.currency} ${(p.grossAmountCents / 100).toFixed(2)}`, row: row(p) });
      for (const st of inPeriod(await db.select().from(facilityStatements).where(eq(facilityStatements.facilityOrgRef, v.orgRef)), "importedAt", from, to)) {
        items.push({ itemKind: "facility_statement", sourceTable: "facilityStatements", sourceId: st.id, sourceRef: st.statementRef, title: `Facility statement ${st.statementRef} ${st.periodStart}–${st.periodEnd}: ${st.matchedCount} matched, ${st.varianceCount} variance, ${st.unmatchedCount} unmatched, ${st.ambiguousCount} ambiguous (${st.status})`, row: row(st) });
        for (const ln of await db.select().from(facilityStatementLines).where(eq(facilityStatementLines.facilityStatementId, st.id))) items.push({ itemKind: "facility_statement_line", sourceTable: "facilityStatementLines", sourceId: ln.id, sourceRef: `${st.statementRef}#${ln.lineNo}`, title: `Line ${ln.lineNo}: ${ln.matchOutcome}${ln.resolution ? `, resolved ${ln.resolution}` : ""}`, row: row(ln) });
      }
    }
    for (const d of await registryDocumentsFor(db, [["vendor", v.vendorRef ?? String(v.id)], ...(v.orgRef ? [["organization", v.orgRef] as [string, string]] : [])])) items.push(d);
    return { subjectType: "vendor", items };
  }
  if (kind === "job" || kind === "customer") {
    const t = (await db.select().from(fieldTickets).where(mintedIn(fieldTickets, fieldTickets.ticketNumber, subjectRef, scope)).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: `Ticket ${subjectRef} not found` });
    if (t.jobId) items.push(...await capabilityPictureItems(db, eq(dispatchEligibilityChecks.jobId, t.jobId)));
    items.push({ itemKind: "field_ticket", sourceTable: "fieldTickets", sourceId: t.id, sourceRef: t.ticketNumber, title: `Field ticket ${t.ticketNumber}`, row: row(t) });
    for (const d of await registryDocumentsFor(db, [["field_ticket", t.ticketNumber]])) items.push(d);
    for (const e of await db.select().from(fieldTicketEvents).where(eq(fieldTicketEvents.fieldTicketId, t.id))) items.push({ itemKind: e.customerBillable === "no" ? "company_activity" : "ticket_event", sourceTable: "fieldTicketEvents", sourceId: e.id, sourceRef: null, title: `${e.eventType} ${e.occurredAt.toISOString()}`, row: row(e) });
    for (const r of await db.select().from(fieldTicketRevisions).where(eq(fieldTicketRevisions.fieldTicketId, t.id))) items.push({ itemKind: "ticket_revision", sourceTable: "fieldTicketRevisions", sourceId: r.id, sourceRef: r.documentRef, title: `R${r.revision} ${r.kind}`, row: row(r), storedHash: r.snapshotHash });
    for (const s of await db.select().from(fieldTicketSignatures).where(eq(fieldTicketSignatures.fieldTicketId, t.id))) items.push({ itemKind: "signature", sourceTable: "fieldTicketSignatures", sourceId: s.id, sourceRef: null, title: `Signature ${s.signerName ?? ""} (${s.signatureMethod})`, row: row(s), storedHash: s.payloadHash });
    for (const d of await db.select().from(fieldTicketDocuments).where(eq(fieldTicketDocuments.fieldTicketId, t.id))) items.push({ itemKind: "ticket_document", sourceTable: "fieldTicketDocuments", sourceId: d.id, sourceRef: d.documentRef, title: `Document ${d.kind}`, row: row(d), storageKey: d.storageKey, storedHash: d.contentHash });
    for (const a of await db.select().from(clientAdjustments).where(eq(clientAdjustments.fieldTicketId, t.id))) items.push({ itemKind: "client_adjustment", sourceTable: "clientAdjustments", sourceId: a.id, sourceRef: a.adjustmentRef, title: `Adjustment ${a.kind} (${a.status})`, row: row(a) });
    if (t.jobId) {
      const lds = await db.select().from(loads).where(eq(loads.jobId, t.jobId));
      for (const l of lds) items.push({ itemKind: "load", sourceTable: "loads", sourceId: l.id, sourceRef: l.loadNumber, title: `Load ${l.loadNumber}`, row: row(l) });
      const dts = lds.length ? await db.select().from(disposalTickets).where(inArray(disposalTickets.loadId, lds.map(l => l.id))) : [];
      for (const d of dts) items.push({ itemKind: "disposal_ticket", sourceTable: "disposalTickets", sourceId: d.id, sourceRef: d.facilityTicketNumber ?? d.ticketNumber, title: `Disposal ticket ${d.facilityTicketNumber ?? d.ticketNumber} (${d.verificationStatus})`, row: row(d) });
      for (const l of lds) if (!dts.some(d => d.loadId === l.id)) items.push({ itemKind: "gap_note", sourceTable: "loads", sourceId: l.id, sourceRef: l.loadNumber, title: `No disposal ticket on file for load ${l.loadNumber}`, row: { loadNumber: l.loadNumber, gap: "disposal_ticket" } });
    }
    return { subjectType: "fieldTicket", items };
  }
  if (kind === "incident") {
    const inc = (await db.select().from(safetyEvents).where(eq(safetyEvents.id, Number(subjectRef))).limit(1))[0];
    if (!inc) throw new TRPCError({ code: "NOT_FOUND", message: `Incident ${subjectRef} not found` });
    items.push({ itemKind: "incident", sourceTable: "safetyEvents", sourceId: inc.id, sourceRef: null, title: `${inc.eventType}: ${inc.title} (${inc.severity}, ${inc.status})`, row: row(inc) });
    return { subjectType: "incident", items };
  }
  if (kind === "cor") {
    // the safety program's evidence for an entity: approved program versions, acknowledgements, tailgates, inspections, verified training, incidents — as they are
    const entityId = Number(subjectRef);
    const programs = await db.select().from(writtenProgramVersions).where(eq(writtenProgramVersions.financialEntityId, entityId));
    for (const p of programs.filter(x => x.approvedAt)) items.push({ itemKind: "written_program", sourceTable: "writtenProgramVersions", sourceId: p.id, sourceRef: `${p.programKey} v${p.version}`, title: `${p.programType}: ${p.title} v${p.version}`, row: row(p), storedHash: p.contentHash });
    const acks = programs.length ? await db.select().from(programAcknowledgements).where(inArray(programAcknowledgements.writtenProgramVersionId, programs.map(p => p.id))) : [];
    for (const a of inPeriod(acks, "acknowledgedAt", from, to)) items.push({ itemKind: "program_acknowledgement", sourceTable: "programAcknowledgements", sourceId: a.id, sourceRef: null, title: `Acknowledgement of program version ${a.writtenProgramVersionId} (${a.method})`, row: row(a) });
    for (const t of inPeriod(await db.select().from(tailgateMeetings), "startedAt", from, to)) items.push({ itemKind: "tailgate", sourceTable: "tailgateMeetings", sourceId: t.id, sourceRef: t.trackingNumber, title: `Tailgate ${t.trackingNumber} (${t.reviewStatus})`, row: row(t) });
    for (const i of inPeriod(await db.select().from(inspections), "observedAt", from, to)) items.push({ itemKind: "inspection", sourceTable: "inspections", sourceId: i.id, sourceRef: null, title: `Inspection ${i.type} (${i.status})`, row: row(i) });
    for (const t of inPeriod(await db.select().from(trainingRecords).where(eq(trainingRecords.verificationStatus, "verified")), "completedAt", from, to)) items.push({ itemKind: "training", sourceTable: "trainingRecords", sourceId: t.id, sourceRef: t.trainingRef, title: `Training: ${t.title}`, row: row(t) });
    const incidents = inPeriod(await db.select().from(safetyEvents), "occurredAt", from, to);
    for (const inc of incidents) items.push({ itemKind: "incident", sourceTable: "safetyEvents", sourceId: inc.id, sourceRef: null, title: `${inc.eventType}: ${inc.title} (${inc.severity}, ${inc.status})`, row: row(inc) });
    if (!incidents.length && from && to) items.push({ itemKind: "incident", sourceTable: "safetyEvents", sourceId: 0, sourceRef: null, title: `No incidents recorded ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`, row: { statement: "no_incidents_recorded", from: from.toISOString(), to: to.toISOString() } });
    return { subjectType: "financialEntity", items };
  }
  if (kind === "insurance") {
    const entityId = Number(subjectRef);
    const pols = await db.select().from(insurancePolicies).where(eq(insurancePolicies.financialEntityId, entityId));
    for (const p of pols) items.push({ itemKind: "policy", sourceTable: "insurancePolicies", sourceId: p.id, sourceRef: p.policyNumber, title: `${p.policyType} policy ${p.policyNumber} (${p.status}; coverage ${p.coverageVerificationStatus})`, row: row(p) });
    const claims = pols.length ? inPeriod(await db.select().from(insuranceClaims).where(inArray(insuranceClaims.insurancePolicyId, pols.map(p => p.id))), "lossOccurredAt", from, to) : [];
    for (const c of claims) items.push({ itemKind: "claim", sourceTable: "insuranceClaims", sourceId: c.id, sourceRef: c.claimRef, title: `Claim ${c.claimRef} (${c.claimType}, ${c.status})`, row: row(c) });
    for (const inc of inPeriod(await db.select().from(safetyEvents), "occurredAt", from, to)) items.push({ itemKind: "incident", sourceTable: "safetyEvents", sourceId: inc.id, sourceRef: null, title: `${inc.eventType}: ${inc.title} (${inc.severity}, ${inc.status})`, row: row(inc) });
    for (const d of inPeriod(await db.select().from(drivingEvents).where(eq(drivingEvents.reviewStatus, "escalated")), "recordedAt", from, to)) items.push({ itemKind: "driving_event_escalated", sourceTable: "drivingEvents", sourceId: d.id, sourceRef: d.eventRef, title: `Escalated driving event ${d.kind} ${d.recordedAt.toISOString()}`, row: row(d) });
    return { subjectType: "financialEntity", items };
  }
  // tax: an entity's finalized or filed returns in the period, and reviewed CCA schedules
  const entityId = Number(subjectRef);
  for (const g of await db.select().from(gstReturns).where(and(eq(gstReturns.financialEntityId, entityId), inArray(gstReturns.status, ["finalized", "filed", "amended"])))) items.push({ itemKind: "gst_return", sourceTable: "gstReturns", sourceId: g.id, sourceRef: g.returnRef, title: `GST/HST return ${g.returnRef} (${g.status})`, row: row(g), storedHash: g.payloadHash });
  for (const i of await db.select().from(iftaReturns).where(and(eq(iftaReturns.financialEntityId, entityId), inArray(iftaReturns.status, ["finalized", "filed", "amended"])))) items.push({ itemKind: "ifta_return", sourceTable: "iftaReturns", sourceId: i.id, sourceRef: i.returnRef, title: `IFTA return ${i.returnRef} (${i.status})`, row: row(i), storedHash: i.payloadHash });
  for (const c of await db.select().from(ccaSchedules).where(and(eq(ccaSchedules.financialEntityId, entityId), eq(ccaSchedules.status, "reviewed")))) items.push({ itemKind: "cca_schedule", sourceTable: "ccaSchedules", sourceId: c.id, sourceRef: c.scheduleRef, title: `CCA schedule ${c.scheduleRef}`, row: row(c), storedHash: c.payloadHash });
  return { subjectType: "financialEntity", items };
}

export const auditRouter = router({
  packagePrepare: roleProcedure("audit.packagePrepare")
    .input(z.object({ kind: z.enum(["vehicle", "driver", "job", "customer", "incident", "tax", "cor", "insurance", "vendor"]), subjectRef: z.string().min(1).max(80), periodFrom: z.coerce.date().nullable().optional(), periodTo: z.coerce.date().nullable().optional(), recipient: z.string().min(2).max(200), purpose: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const g = await gather(input.kind, input.subjectRef, input.periodFrom ?? null, input.periodTo ?? null, await actingScopeFor(ctx.user.id));
      const a = assemble(input.kind, g.items);
      const packageRef = ref("PKG");
      const lines = [`Audit package ${packageRef} — ${input.kind} — subject ${g.subjectType} ${input.subjectRef}`, `For: ${input.recipient}`, `Purpose: ${input.purpose}`, `Period: ${input.periodFrom?.toISOString().slice(0, 10) ?? "open"} to ${input.periodTo?.toISOString().slice(0, 10) ?? "open"}`, `Manifest sha256 ${a.manifestHash}`, `Redaction policy ${a.manifest.policy}: ${a.manifest.redactionCount} redaction(s), ${a.manifest.withheld.length} item(s) withheld`, "", "ITEMS", "-----", ...a.manifest.items.map(i => `${String(i.seq).padStart(3)}  ${i.itemKind.padEnd(22)} ${(i.sourceRef ?? "").padEnd(24)} ${i.contentHash.slice(0, 16)}  ${i.title}${i.redactions.length ? `  [${i.redactions.length} redaction(s)]` : ""}`), "", "WITHHELD", "--------", ...(a.manifest.withheld.length ? a.manifest.withheld.map(w => `${w.itemKind} ${w.sourceRef ?? ""}: ${w.reason}`) : ["(none)"]), "", "MISSING", "-------", ...(a.manifest.missing.length ? a.manifest.missing.map(m => `${m.label} — not on file`) : ["(nothing required is missing)"]), "", "This package asserts nothing beyond the records it names. Each item's hash is over the record as released."];
      const cover = renderPdf(`LeaseOS Audit Package ${packageRef}`, lines);
      const coverHash = sha256(cover.toString("latin1"));
      const stored = await storagePut(`audit/${packageRef}/cover.pdf`, cover, "application/pdf");
      const prior = (await db.select({ id: auditPackages.id, status: auditPackages.status }).from(auditPackages).where(and(eq(auditPackages.kind, input.kind), eq(auditPackages.subjectRef, input.subjectRef), eq(auditPackages.status, "released"))).orderBy(desc(auditPackages.id)).limit(1))[0];
      const ins = await db.insert(auditPackages).values({ packageRef, kind: input.kind, subjectType: g.subjectType, subjectRef: input.subjectRef, periodFrom: input.periodFrom ?? null, periodTo: input.periodTo ?? null, recipient: input.recipient, purpose: input.purpose, redactionPolicy: a.manifest.policy, manifestJson: a.manifestJson, manifestHash: a.manifestHash, coverStorageKey: stored.key, coverHash, itemCount: a.manifest.itemCount, redactionCount: a.manifest.redactionCount, missingJson: JSON.stringify(a.manifest.missing), preparedByUserId: ctx.user.id, preparedAt: new Date(), supersedesPackageId: prior?.id ?? null });
      const id = Number(ins[0]?.insertId ?? 0);
      for (const i of a.manifest.items) await db.insert(auditPackageItems).values({ packageId: id, seq: i.seq, itemKind: i.itemKind, sourceTable: i.sourceTable, sourceId: i.sourceId, sourceRef: i.sourceRef, title: i.title, contentHash: i.contentHash, storageKey: i.storageKey, redactionsJson: i.redactions.length ? JSON.stringify(i.redactions) : null });
      return { packageRef, manifestHash: a.manifestHash, itemCount: a.manifest.itemCount, redactionCount: a.manifest.redactionCount, withheld: a.manifest.withheld, missing: a.manifest.missing, supersedes: prior ? true : false };
    }),

  /** Released by a second person. An incomplete package is released only with each gap named in the note. */
  packageRelease: roleProcedure("audit.packageRelease")
    .input(z.object({ packageRef: z.string().min(1).max(64), note: z.string().max(600), acknowledgeGaps: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const p = (await db.select().from(auditPackages).where(eq(auditPackages.packageRef, input.packageRef)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Package not found" });
      const missing = JSON.parse(p.missingJson) as { label: string }[];
      const d = releaseDecision({ status: p.status, preparedByUserId: p.preparedByUserId, releaserUserId: ctx.user.id, missing, acknowledgeGaps: input.acknowledgeGaps, note: input.note });
      if (!d.permitted) throw new TRPCError({ code: d.refusals.some(r => r.includes("preparer")) ? "FORBIDDEN" : "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      if (sha256(p.manifestJson) !== p.manifestHash) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Manifest hash does not match its content — the package is not released" });
      await db.update(auditPackages).set({ status: "released", releasedByUserId: ctx.user.id, releasedAt: new Date(), releaseNote: input.note, gapsAcknowledged: input.acknowledgeGaps }).where(eq(auditPackages.id, p.id));
      if (p.supersedesPackageId) await db.update(auditPackages).set({ status: "superseded" }).where(eq(auditPackages.id, p.supersedesPackageId));
      await db.insert(auditPackageAccess).values({ packageId: p.id, userId: ctx.user.id, action: "send", purpose: `released to ${p.recipient}: ${input.note}`.slice(0, 300), at: new Date() });
      return { packageRef: p.packageRef, status: "released" as const, manifestHash: p.manifestHash, gapsAcknowledged: missing.length ? input.acknowledgeGaps : false };
    }),

  packageWithdraw: roleProcedure("audit.packageWithdraw").input(z.object({ packageRef: z.string().min(1).max(64), reason: z.string().min(5).max(600) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const p = (await db.select().from(auditPackages).where(eq(auditPackages.packageRef, input.packageRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Package not found" });
    await db.update(auditPackages).set({ status: "withdrawn", releaseNote: `${p.releaseNote ?? ""}\nWITHDRAWN: ${input.reason}`.slice(0, 600) }).where(eq(auditPackages.id, p.id));
    await db.insert(auditPackageAccess).values({ packageId: p.id, userId: ctx.user.id, action: "send", purpose: `withdrawn: ${input.reason}`.slice(0, 300), at: new Date() });
    return { packageRef: p.packageRef, status: "withdrawn" as const, note: "The package on record does not change; its withdrawal is a row. Tell the recipient." };
  }),

  packageGet: roleProcedure("audit.packageGet").input(z.object({ packageRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const p = (await db.select().from(auditPackages).where(eq(auditPackages.packageRef, input.packageRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Package not found" });
    const items = await db.select().from(auditPackageItems).where(eq(auditPackageItems.packageId, p.id)).orderBy(auditPackageItems.seq);
    await db.insert(auditPackageAccess).values({ packageId: p.id, userId: ctx.user.id, action: "view", purpose: "manifest view", at: new Date() });
    return { packageRef: p.packageRef, kind: p.kind, subjectType: p.subjectType, subjectRef: p.subjectRef, recipient: p.recipient, purpose: p.purpose, status: p.status, manifestHash: p.manifestHash, coverHash: p.coverHash, itemCount: p.itemCount, redactionCount: p.redactionCount, missing: JSON.parse(p.missingJson) as { itemKind: string; label: string }[], preparedByUserId: p.preparedByUserId, releasedByUserId: p.releasedByUserId, releasedAt: p.releasedAt, gapsAcknowledged: p.gapsAcknowledged, supersedesPackageId: p.supersedesPackageId, items: items.map(i => ({ seq: i.seq, itemKind: i.itemKind, sourceTable: i.sourceTable, sourceRef: i.sourceRef, title: i.title, contentHash: i.contentHash, redactions: i.redactionsJson ? JSON.parse(i.redactionsJson) as string[] : [] })) };
  }),

  /** The manifest and the cover, of a released package, with the download as a row. */
  packageDownload: roleProcedure("audit.packageDownload").input(z.object({ packageRef: z.string().min(1).max(64), purpose: z.string().min(5).max(300) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const p = (await db.select().from(auditPackages).where(eq(auditPackages.packageRef, input.packageRef)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Package not found" });
    if (p.status !== "released" && p.status !== "superseded") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Package is ${p.status} — only a released package is downloaded` });
    await db.insert(auditPackageAccess).values({ packageId: p.id, userId: ctx.user.id, action: "download", purpose: input.purpose, at: new Date() });
    return { packageRef: p.packageRef, manifestJson: p.manifestJson, manifestHash: p.manifestHash, coverUrl: p.coverStorageKey ? await storageGetSignedUrl(p.coverStorageKey) : null, coverHash: p.coverHash, status: p.status };
  }),

  packageList: roleProcedure("audit.packageList").input(z.object({ subjectRef: z.string().max(80).optional() })).query(async ({ input }) => {
    const db = await dbOrThrow();
    const rows = input.subjectRef ? await db.select().from(auditPackages).where(eq(auditPackages.subjectRef, input.subjectRef)).orderBy(desc(auditPackages.id)).limit(200) : await db.select().from(auditPackages).orderBy(desc(auditPackages.id)).limit(200);
    return { packages: rows.map(p => ({ packageRef: p.packageRef, kind: p.kind, subjectRef: p.subjectRef, recipient: p.recipient, status: p.status, itemCount: p.itemCount, redactionCount: p.redactionCount, missingCount: (JSON.parse(p.missingJson) as unknown[]).length, preparedAt: p.preparedAt, releasedAt: p.releasedAt })) };
  }),
});
