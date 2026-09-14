/**
 * Readiness composition — "Can Unit 142 take this job tomorrow?"
 *
 * Nineteen tranches built the engines: the compliance passport, the
 * insurance gate, calibration effects, mechanic release, roadside state,
 * equipment authorization. B12 built the gate itself: a point-in-time
 * eligibility judgement with named blockers, a fingerprint of the facts it
 * saw, and an award transaction that refuses when the facts have changed.
 *
 * This file is the composition. It gathers every engine's answer, SERVER-SIDE
 * — the caller supplies identities and nothing else — into the readiness
 * input B12 evaluates and the fact set B12 fingerprints, and merges the newer
 * engines' findings as blockers in B12's own vocabulary.
 *
 * Three things do not change here: unknown never rounds up to eligible; a
 * safety or legal blocker is overridable by no one; and what dispatch learns
 * about a person's medical fitness is "eligible" and nothing more.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { faultDispatchEffect } from "./_core/telematics";
import { getDb } from "./db";
import {
  complianceDocuments, dispatchPostings, fieldDevices, insuranceCoveredEntities, insurancePolicies, insurancePolicyCoverages,
  jobs, maintenanceDefects, measurementDeviceAssignments, measurementDevices, calibrationEvents, operators, roadsideServiceEvents,
  units, workOrderReleases,
  faultCodes,
  communicationCoverage, communicationPolicies, companyRadioAuthorizations, radioChannels,
  roadGraphEdges, roadRadioAssignments, routeApprovals, unitRadioCapabilities,
} from "../drizzle/schema";
import {
  evaluateDispatchReadiness, type CredentialState, type DispatchBlocker, type DispatchEligibility, type EligibilityVerdict, type ReadinessInput,
} from "./_core/dispatchReadiness";
import { computeEligibilityFingerprint, type EligibilityFacts } from "./_core/dispatchAward";
import { assessCoverage, type PolicyRecord } from "./_core/insuranceRisk";
import { calibrationEffectOnUse, calibrationStatus, type CalibrationEvent } from "./_core/requirementEngine";
import { medicalFitnessForDispatch } from "./_core/compliancePassport";
import { resolveRouteCommunicationGeography } from "./routeCommunicationGeography";
import { enforcementReadiness, type OosOrder, type OosScope } from "./_core/enforcement";
import {
  ADVISORY_POLICY, communicationBlockers, planCommunications,
  type CommunicationPolicy, type CoverageObservation, type GeoCondition, type PathSegment,
} from "./_core/commRoute";

export type ReadinessSubject = {
  operatorId: number; unitId: number | null; trailerId: number | null; jobId: number | null; postingId?: number | null;
  /**
   * v22.18 — the route this readiness is about. Optional, so every existing
   * caller keeps its exact behaviour: without it the route axis answers what it
   * has always answered, which is that nothing was evaluated.
   */
  routeApprovalRef?: string | null;
  /** Working alone, for the policy rule that only applies then. */
  loneWorker?: boolean;
  /**
   * v22.20 — active out-of-service orders and unresolved inspections covering
   * this operator, unit or trailer.
   *
   * Before this, a mechanic release could report a unit available while a
   * government order prohibited it from moving: the composer had no idea
   * enforcement existed. A mechanic can establish that a truck is mechanically
   * sound. Nobody in this company can establish that an inspector's order has
   * been lifted.
   */
  enforcement?: {
    orders: readonly OosOrder[];
    unresolvedInspections?: readonly { inspectionRef: string; coversSubjectRefs: readonly string[] }[];
    subjects: readonly { subjectRef: string; scope: OosScope }[];
  } | null;
};

/** The approved communication policy in force, or the advisory default. */
export async function currentCommunicationPolicy(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, now: Date): Promise<{ policy: CommunicationPolicy; policyRef: string | null }> {
  const rows = await db.select().from(communicationPolicies).where(eq(communicationPolicies.status, "approved")).orderBy(desc(communicationPolicies.id));
  const live = rows.find(r => (!r.effectiveFrom || r.effectiveFrom.getTime() <= now.getTime()) && (!r.effectiveTo || r.effectiveTo.getTime() > now.getTime()));
  if (!live) return { policy: ADVISORY_POLICY, policyRef: null };
  return {
    policyRef: live.policyRef,
    policy: {
      unknownPlanBlocks: live.unknownPlanBlocks,
      requireTransmitAuthorization: live.requireTransmitAuthorization,
      toleratedNoCommunicationKm: live.toleratedNoCommunicationKm,
      loneWorkerRequiresSatellite: live.loneWorkerRequiresSatellite,
    },
  };
}

export type ComposedReadiness = {
  eligibility: DispatchEligibility;
  facts: EligibilityFacts;
  fingerprint: string;
  /** What each engine contributed, for the explanation and the audit row. */
  contributions: { engine: string; finding: string }[];
};

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

const versionOf = (parts: (string | number | null | undefined)[]) => parts.map(p => (p == null ? "∅" : String(p))).join("/");

async function credentialsFor(ownerType: "operator" | "unit" | "trailer", ownerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, ownerType), eq(complianceDocuments.ownerId, ownerId)));
}

type CredRow = Awaited<ReturnType<typeof credentialsFor>>[number];

/** Best credential of a type: verified before needs_review; latest expiry; rejected never counts as present. */
function credentialState(rows: readonly CredRow[], docTypes: readonly string[], label: string): CredentialState {
  const c = rows
    .filter(r => docTypes.includes(r.docType) && r.verificationStatus !== "rejected")
    .sort((a, b) => (b.verificationStatus === "verified" ? 1 : 0) - (a.verificationStatus === "verified" ? 1 : 0) || (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
  if (!c) return { label, present: false, expiresAt: null };
  return { label, present: true, expiresAt: c.expiresAt ?? undefined };
}

async function policiesCovering(entityType: "unit" | "trailer", entityId: number, now: Date): Promise<PolicyRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const covered = await db.select({ policyId: insuranceCoveredEntities.insurancePolicyId, until: insuranceCoveredEntities.coveredUntil })
    .from(insuranceCoveredEntities).where(and(eq(insuranceCoveredEntities.entityType, entityType as never), eq(insuranceCoveredEntities.entityId, entityId)));
  const live = covered.filter(c => !c.until || c.until > now);
  if (live.length === 0) return [];
  const policyIds = Array.from(new Set(live.map(c => c.policyId)));
  const [pols, covs, docs] = await Promise.all([
    db.select().from(insurancePolicies).where(inArray(insurancePolicies.id, policyIds)),
    db.select().from(insurancePolicyCoverages).where(inArray(insurancePolicyCoverages.insurancePolicyId, policyIds)),
    db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, entityType), eq(complianceDocuments.ownerId, entityId), inArray(complianceDocuments.docType, ["insurance_proof", "insurance_card"]))),
  ]);
  const proof = docs.sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
  return pols.map(p => ({
    policyRef: p.policyRef, policyType: p.policyType, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt, status: p.status,
    coverageVerificationStatus: p.coverageVerificationStatus,
    coverages: covs.filter(c => c.insurancePolicyId === p.id).map(c => ({ coverageType: c.coverageType, limitAmount: c.limitAmount, additionalInsuredEndorsement: c.additionalInsuredEndorsement })),
    document: proof ? { expiresAt: proof.expiresAt, verificationStatus: proof.verificationStatus } : null,
  }));
}

/* ------------------------------------------------------------------ */
/* Composition                                                          */
/* ------------------------------------------------------------------ */

export async function composeReadiness(subject: ReadinessSubject, now = new Date()): Promise<ComposedReadiness> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const contributions: ComposedReadiness["contributions"] = [];
  const extra: DispatchBlocker[] = [];

  /* ---- operator ---- */
  const op = (await db.select().from(operators).where(eq(operators.id, subject.operatorId)).limit(1))[0];
  if (!op) throw new Error(`Operator ${subject.operatorId} not found`);
  const opCreds = await credentialsFor("operator", op.id);
  let licence = credentialState(opCreds, ["driver_licence"], "Driver licence");
  if (!licence.present && op.licenseExpiresAt) {
    // The flat legacy field is a weak signal: present, unverified. It keeps an
    // unmigrated operator from reading as "no licence" while the structured
    // record is still to be entered.
    licence = { label: "Driver licence (legacy record)", present: true, expiresAt: op.licenseExpiresAt };
    contributions.push({ engine: "compliance", finding: "Licence read from the legacy operator record — no structured credential yet" });
  }
  const job = subject.jobId ? (await db.select().from(jobs).where(eq(jobs.id, subject.jobId)).limit(1))[0] ?? null : null;
  const dangerousGoods = /tdg|dangerous|hazard/i.test(`${job?.type ?? ""} ${job?.mode ?? ""}`);
  const required: CredentialState[] = [];
  if (dangerousGoods) required.push(credentialState(opCreds, ["tdg_certificate"], "TDG certificate"));
  // Medical fitness reaches dispatch as a projection only.
  const medRow = opCreds.filter(c => c.docType === "medical_fitness").sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
  const med = medicalFitnessForDispatch(medRow ? { docType: "medical_fitness", expiresAt: medRow.expiresAt, verificationStatus: medRow.verificationStatus, privateDetail: true } : null, now);
  if (med.eligible === "no") extra.push({ code: "medical_fitness_not_current", label: "Commercial medical fitness not current", severity: "blocking", subject: "operator", overridable: false });
  else if (med.eligible === "unknown") extra.push({ code: "medical_fitness_unknown", label: "Commercial medical fitness not verified", severity: "unknown", subject: "operator", overridable: true, overrideAuthority: "manager" });
  contributions.push({ engine: "compliance", finding: `Medical fitness: ${med.eligible}` });

  const device = (await db.select({ status: fieldDevices.status }).from(fieldDevices).where(eq(fieldDevices.userId, op.userId ?? -1)).orderBy(desc(fieldDevices.enrolledAt)).limit(1))[0];
  if (device && device.status === "revoked") extra.push({ code: "field_device_revoked", label: "Operator's field device is revoked — evidence cannot be captured", severity: "review", subject: "operator", overridable: true, overrideAuthority: "dispatcher" });

  /* ---- unit ---- */
  let truck: ReadinessInput["truck"] = { unitNumber: "—", inspection: { label: "Inspection", present: false, expiresAt: null }, registration: { label: "Registration", present: false, expiresAt: null }, insurance: { label: "Insurance", present: false, expiresAt: null }, maintenanceOverdue: false, criticalDefectOpen: false, mechanicReleaseRequired: false, mechanicReleaseGiven: false };
  let unitVersion = "none", releaseVersion = "none", criticalCount = 0;
  if (subject.unitId) {
    const unit = (await db.select().from(units).where(eq(units.id, subject.unitId)).limit(1))[0];
    if (!unit) throw new Error(`Unit ${subject.unitId} not found`);
    const [uCreds, defects, releases, roadside, pols, assignments] = await Promise.all([
      credentialsFor("unit", unit.id),
      db.select().from(maintenanceDefects).where(and(eq(maintenanceDefects.unitId, unit.id), inArray(maintenanceDefects.status, ["open", "in_progress"]))),
      db.select().from(workOrderReleases).where(eq(workOrderReleases.unitId, unit.id)).orderBy(desc(workOrderReleases.releasedAt)).limit(5),
      db.select().from(roadsideServiceEvents).where(and(eq(roadsideServiceEvents.unitId, unit.id), inArray(roadsideServiceEvents.status, ["open", "vendor_assigned", "in_repair", "repaired_awaiting_release"]))),
      policiesCovering("unit", unit.id, now),
      db.select().from(measurementDeviceAssignments).where(and(eq(measurementDeviceAssignments.assignedToType, "unit"), eq(measurementDeviceAssignments.assignedToId, unit.id))),
    ]);
    const critical = defects.filter(d => d.severity === "critical");
    criticalCount = critical.length;
    const releasedAfter = (d: (typeof critical)[number]) => releases.some(r => r.releasedAt > d.reportedAt);
    const unreleased = critical.filter(d => !releasedAfter(d));
    truck = {
      unitNumber: unit.unitNumber,
      inspection: credentialState(uCreds, ["cvip_certificate", "annual_inspection"], "Annual inspection"),
      registration: credentialState(uCreds, ["vehicle_registration"], "Registration"),
      insurance: { label: "Insurance", present: pols.length > 0, expiresAt: pols.length ? new Date(Math.max(...pols.map(p => p.expiresAt.getTime()))) : null },
      maintenanceOverdue: unit.maintenanceStatus === "blocked",
      criticalDefectOpen: unreleased.length > 0,
      mechanicReleaseRequired: critical.length > 0,
      mechanicReleaseGiven: critical.length > 0 && unreleased.length === 0,
    };
    unitVersion = versionOf([unit.maintenanceStatus, defects.length, ...defects.map(d => `${d.id}:${d.status}`)]);
    releaseVersion = versionOf(releases.map(r => r.id));

    // Insurance: the six statuses, in B12's vocabulary. Policy expiry blocks and
    // is overridable by no one; missing paper is review.
    const auto = assessCoverage({ coverageType: "commercial_auto", policies: pols, now });
    contributions.push({ engine: "insurance", finding: `${auto.status}: ${auto.reason}` });
    if (auto.status === "coverage_expired") extra.push({ code: "insurance_coverage_expired", label: auto.reason, severity: "blocking", subject: "truck", overridable: false });
    // No policy on record at all is BLOCKED, as the insurance engine itself says
    // (its effect is "blocked", not "unknown") — an uninsured truck is not a
    // thing a manager overrides.
    else if (auto.status === "coverage_unknown") extra.push({ code: "insurance_coverage_unknown", label: auto.reason, severity: "blocking", subject: "truck", overridable: false });
    else if (auto.status === "document_missing" || auto.status === "document_expired") extra.push({ code: "insurance_proof_missing", label: auto.reason, severity: "review", subject: "truck", overridable: true, overrideAuthority: "dispatcher" });
    else if (auto.status === "coverage_reported") extra.push({ code: "insurance_coverage_unverified", label: auto.reason, severity: "review", subject: "truck", overridable: true, overrideAuthority: "manager" });

    for (const r of roadside) extra.push({ code: "roadside_event_open", label: `Roadside event ${r.eventRef} open (${r.status.replace(/_/g, " ")})`, severity: "blocking", subject: "truck", overridable: false });

    // Calibration: dispatch is reviewed, not stopped; billing and weight are the uses that hold.
    if (assignments.length) {
      const devIds = assignments.filter(a => !a.assignedUntil || a.assignedUntil > now).map(a => a.measurementDeviceId);
      const devs = devIds.length ? await db.select().from(measurementDevices).where(inArray(measurementDevices.id, devIds)) : [];
      const evs = devIds.length ? await db.select().from(calibrationEvents).where(inArray(calibrationEvents.measurementDeviceId, devIds)) : [];
      for (const dv of devs) {
        const st = calibrationStatus({ events: evs.filter(e => e.measurementDeviceId === dv.id) as CalibrationEvent[], intervalDays: dv.calibrationIntervalDays, now });
        const eff = calibrationEffectOnUse(st, "dispatch_availability");
        contributions.push({ engine: "calibration", finding: `${dv.deviceRef}: ${st.status} — dispatch ${eff.effect}` });
        if (eff.effect !== "ok") extra.push({ code: "measurement_device_uncalibrated", label: `${dv.deviceType.replace(/_/g, " ")} ${dv.deviceRef}: ${st.reason} — billing measurements on hold`, severity: "review", subject: "truck", overridable: true, overrideAuthority: "manager" });
      }
    }
  }

  /* ---- trailer ---- */
  // v21.19 — telematics faults on the truck: undetermined severity is UNKNOWN (a mechanic decides); an acknowledged
  // critical fault blocks; an acknowledged inspection-required one is REVIEW.
  if (subject.unitId) {
    for (const f of await db.select().from(faultCodes).where(and(eq(faultCodes.unitId, subject.unitId), inArray(faultCodes.status, ["active", "acknowledged"])))) {
      const eff = faultDispatchEffect(f);
      contributions.push({ engine: "telematics", finding: `${f.protocol.toUpperCase()} ${f.code}: ${f.status}, severity ${f.severityDetermination}` });
      if (eff.severity === "blocking") extra.push({ code: `fault_${f.code.toLowerCase()}_critical`, label: eff.label, severity: "blocking", subject: "truck", overridable: false });
      else if (eff.severity === "review") extra.push({ code: `fault_${f.code.toLowerCase()}_inspection`, label: eff.label, severity: "review", subject: "truck", overridable: true, overrideAuthority: "manager" });
      else if (eff.severity === "unknown") extra.push({ code: `fault_${f.code.toLowerCase()}_active`, label: eff.label, severity: "unknown", subject: "truck", overridable: true, overrideAuthority: "manager" });
    }
  }

  let trailer: ReadinessInput["trailer"] = null;
  let trailerVersion = "none";
  if (subject.trailerId) {
    // There is no trailers table: a trailer is a unit whose vehicleType says so.
    const tr = (await db.select().from(units).where(eq(units.id, subject.trailerId)).limit(1))[0];
    if (!tr) throw new Error(`Trailer ${subject.trailerId} not found`);
    const [tCreds, pols] = await Promise.all([credentialsFor("trailer", tr.id), policiesCovering("trailer", tr.id, now)]);
    trailer = {
      trailerNumber: tr.unitNumber,
      inspection: credentialState(tCreds, ["cvip_certificate", "annual_inspection"], "Trailer inspection"),
      registration: credentialState(tCreds, ["vehicle_registration"], "Trailer registration"),
      insurance: { label: "Trailer insurance", present: pols.length > 0, expiresAt: pols.length ? new Date(Math.max(...pols.map(p => p.expiresAt.getTime()))) : null },
      maintenanceOverdue: false,
      compatibleWithTruck: null,
    };
    trailerVersion = versionOf([tr.id, tCreds.length]);
  }

  /* ---- job ---- */
  const jobInput: ReadinessInput["job"] = {
    classificationComplete: job ? Boolean(job.type && job.mode) : false,
    dangerousGoods,
    tdgDocumentPrepared: dangerousGoods ? null : true,
    requiredDocumentsPresent: job ? true : false,
    permitRequired: false,
    permitOnFile: null,
    destinationAcceptanceVerified: null,
    emergencyPlanOnFile: dangerousGoods ? null : true,
  };
  if (!job) contributions.push({ engine: "dispatch", finding: "No job supplied — job requirements not evaluated" });

  /* ---- enforcement: an order from outside this company ---- */
  if (subject.enforcement?.subjects.length) {
    const enf = enforcementReadiness({
      subjects: subject.enforcement.subjects,
      orders: subject.enforcement.orders,
      unresolvedInspections: subject.enforcement.unresolvedInspections,
      at: now,
    });
    for (const b of enf.blockers) {
      // Not overridable by anyone here. A manager may override a company rule;
      // an inspector's order is not a company rule.
      extra.push({ code: b.code, label: b.label, severity: "blocking", subject: b.scope === "driver" ? "operator" : b.scope === "trailer" ? "trailer" : "truck", overridable: false });
    }
    for (const s of enf.subjects.filter(x => x.state === "unknown")) {
      extra.push({ code: "enforcement_result_unknown", label: s.reasons[0], severity: "unknown", subject: s.scope === "driver" ? "operator" : "truck", overridable: true, overrideAuthority: "manager" });
    }
    if (enf.replaceableSubjects.includes("driver")) {
      contributions.push({ engine: "enforcement", finding: "The driver is prohibited and the unit is not — dispatch may assign an eligible replacement driver" });
    }
    contributions.push({ engine: "enforcement", finding: `Enforcement: ${enf.verdict}${enf.blockers.length ? ` — ${enf.blockers.length} active order(s)` : ""}` });
  }

  /* ---- route and communications ---- */
  const route: ReadinessInput["route"] = { dispatchStatus: null, dataTrustworthy: null };
  let routeProfileId: string | null = null;
  let routeDecisionVersion = "not_evaluated";
  let communicationPlanVersion = "none";

  if (!subject.routeApprovalRef) {
    // Unchanged, and still true: without a named route there is nothing to read.
    contributions.push({ engine: "routing", finding: "No route named for this readiness — the route axis is not evaluated" });
  } else {
    const approval = (await db.select().from(routeApprovals).where(eq(routeApprovals.approvalRef, subject.routeApprovalRef)).limit(1))[0];
    if (!approval) {
      extra.push({ code: "route_approval_missing", label: `Route ${subject.routeApprovalRef} is not on record`, severity: "unknown", subject: "route", overridable: true, overrideAuthority: "manager" });
      contributions.push({ engine: "routing", finding: `Route approval ${subject.routeApprovalRef} not found` });
    } else {
      routeProfileId = approval.approvalRef;
      routeDecisionVersion = approval.fingerprintHash.slice(0, 16);
      const status = approval.dispatchStatus as ReadinessInput["route"]["dispatchStatus"];
      route.dispatchStatus = status === "clear" || status === "warning" || status === "review" || status === "blocked" ? status : null;
      // The approval records a verdict, not the confidence behind it, so this
      // stays unknown rather than being invented from the verdict.
      route.dataTrustworthy = null;
      if (approval.status === "stale" || approval.status === "revoked" || approval.status === "superseded") {
        extra.push({ code: `route_approval_${approval.status}`, label: `The approved route is ${approval.status} — re-evaluate it before dispatching`, severity: "blocking", subject: "route", overridable: true, overrideAuthority: "manager" });
      }
      contributions.push({ engine: "routing", finding: `Route ${approval.approvalRef}: ${approval.dispatchStatus}, ${approval.status}` });

      /* The communication plan over that route's segments, under the company's own policy. */
      const segmentIds = JSON.parse(approval.segmentIdsJson) as string[];
      const { policy, policyRef } = await currentCommunicationPolicy(db, now);
      const [edgeRows, assignRows, coverRows, channelRows, authRows] = await Promise.all([
        segmentIds.length ? db.select({ segmentId: roadGraphEdges.segmentId, lengthMetres: roadGraphEdges.lengthMetres }).from(roadGraphEdges).where(inArray(roadGraphEdges.segmentId, segmentIds)) : Promise.resolve([]),
        segmentIds.length ? db.select().from(roadRadioAssignments).where(inArray(roadRadioAssignments.segmentId, segmentIds)) : Promise.resolve([]),
        segmentIds.length ? db.select().from(communicationCoverage).where(inArray(communicationCoverage.segmentId, segmentIds)) : Promise.resolve([]),
        db.select().from(radioChannels),
        db.select().from(companyRadioAuthorizations).where(eq(companyRadioAuthorizations.authorized, true)),
      ]);
      const lengthBySegment = new Map<string, number>();
      for (const e of edgeRows) lengthBySegment.set(e.segmentId, e.lengthMetres / 1000);
      const unmeasured = segmentIds.filter(id => !lengthBySegment.has(id));
      const path: PathSegment[] = segmentIds.map(segmentId => ({ segmentId, label: segmentId, lengthKm: lengthBySegment.get(segmentId) ?? 0 }));
      const cap = subject.unitId ? (await db.select().from(unitRadioCapabilities).where(eq(unitRadioCapabilities.unitId, subject.unitId)).limit(1))[0] : undefined;
      const coverage: CoverageObservation[] = coverRows.map(r => ({ segmentId: r.segmentId, medium: r.medium, state: r.state, sourceKey: r.sourceKey, authorityTier: r.authorityTier, observedAt: r.observedAt, verificationStatus: r.verificationStatus }));
      // The same resolver the route path uses. An approval with no recorded
      // buildRef resolves no geography, and every condition reads UNKNOWN —
      // which is the honest answer for a route whose graph build was never
      // recorded, and is never a guess.
      const geo = approval.buildRef ? await resolveRouteCommunicationGeography(db, { buildRef: approval.buildRef, segmentIds }) : null;
      const plan = planCommunications({
        geographyBySegment: geo?.geographyBySegment,
        path,
        assignments: assignRows.map(r => ({ assignmentRef: r.assignmentRef, segmentId: r.segmentId, channelKey: r.channelKey, authorityTier: r.authorityTier, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, callDirectionLoaded: r.callDirectionLoaded, callIntervalKm: r.callIntervalKm, mustCallKm: r.mustCallKmJson ? (JSON.parse(r.mustCallKmJson) as number[]) : null, roadName: r.roadName, observedAt: r.observedAt, verificationStatus: r.verificationStatus, supersedesAssignmentRef: r.supersedesAssignmentRef })),
        channels: channelRows.map(r => ({ channelKey: r.channelKey, alias: r.alias, serviceClass: r.serviceClass, systemType: r.systemType, rxMHz: r.rxMHz, txMHz: r.txMHz, toneRxHz: r.toneRxHz, toneTxHz: r.toneTxHz, bandwidthKHz: r.bandwidthKHz, maxPowerW: r.maxPowerW, licenceRequired: r.licenceRequired, conditions: JSON.parse(r.conditionsJson) as GeoCondition[], sourceKey: r.sourceKey, sourceCitation: r.sourceCitation, sourceVersion: r.sourceVersion, verificationStatus: r.verificationStatus, serviceStatus: r.serviceStatus, retiredNote: r.retiredNote })),
        coverage,
        companyAuthorizations: authRows.map(a => ({ channelKey: a.channelKey, authorized: a.authorized, licenceRef: a.licenceRef, licenceExpiresAt: a.licenceExpiresAt, provinces: a.provincesJson ? (JSON.parse(a.provincesJson) as string[]) : null, approvedUnitIds: a.approvedUnitIdsJson ? (JSON.parse(a.approvedUnitIdsJson) as number[]) : null, verificationStatus: a.verificationStatus })),
        unit: cap ? { unitId: cap.unitId, vhf: cap.vhf, uhf: cap.uhf, cb: cap.cb, satellite: cap.satellite, cellular: cap.cellular, programmingProfileRef: cap.programmingProfileRef, programmedChannelKeys: cap.programmedChannelKeysJson ? (JSON.parse(cap.programmedChannelKeysJson) as string[]) : null, verificationStatus: cap.verificationStatus } : null,
        at: now,
      });
      for (const b of communicationBlockers(plan, policy, { loneWorker: subject.loneWorker === true, dangerousGoods, unitHasSatellite: cap ? cap.satellite : null })) extra.push(b);
      if (unmeasured.length) {
        // A segment with no measured length contributes nothing to the plan's
        // kilometres, which would quietly understate a gap. Say so instead.
        extra.push({ code: "communication_plan_unmeasured_segments", label: `${unmeasured.length} route segment(s) have no measured length — the communication plan's kilometres understate the route`, severity: "unknown", subject: "route", overridable: true, overrideAuthority: "dispatcher" });
      }
      if (geo?.missing.length) {
        extra.push({ code: "communication_geometry_missing", label: `${geo.missing.length} route segment(s) have no usable road geometry — radio authorization there is UNKNOWN, not permitted`, severity: "unknown", subject: "route", overridable: true, overrideAuthority: "dispatcher" });
      }
      communicationPlanVersion = `${plan.verdict}:${geo?.geographyHash?.slice(0, 8) ?? "nogeo"}:${versionOf(plan.zones.map(z => `${z.segmentIds.join(",")}=${z.channelKey ?? "∅"}@${z.authorityTier ?? "∅"}/${z.transmit}`))}`;
      contributions.push({ engine: "communications", finding: `${plan.explanation}${policyRef ? ` (policy ${policyRef})` : " (no approved policy — advisory)"}` });
    }
  }

  const input: ReadinessInput = {
    evaluatedAt: now,
    operator: { operatorId: op.id, name: op.name, licence, requiredCredentials: required, hoursAvailableMinutes: null, projectedJobMinutes: null, availabilityDeclared: false },
    truck, trailer, job: jobInput, route,
  };
  const base = evaluateDispatchReadiness(input);
  const eligibility = mergeBlockers(base, extra);

  const facts: EligibilityFacts = {
    operatorId: op.id,
    operatorCredentialVersion: versionOf(opCreds.map(c => `${c.id}:${c.verificationStatus}:${c.expiresAt?.toISOString() ?? "∅"}`)),
    hoursAvailableMinutes: null,
    unitId: subject.unitId, unitStatusVersion: unitVersion, criticalDefectCount: criticalCount, mechanicReleaseVersion: releaseVersion,
    trailerId: subject.trailerId, trailerStatusVersion: trailerVersion,
    jobClassificationVersion: job ? versionOf([job.id, job.type, job.mode, job.status]) : "none",
    materialClassificationVersion: "none",
    permitVersion: "none",
    destinationAcceptanceVersion: "none",
    routeProfileId, routeDecisionVersion, communicationPlanVersion,
  };
  return { eligibility, facts, fingerprint: computeEligibilityFingerprint(facts), contributions };
}

/* ------------------------------------------------------------------ */
/* Merge                                                                */
/* ------------------------------------------------------------------ */

const RANK: Record<EligibilityVerdict, number> = { eligible: 0, eligible_review: 1, unknown: 2, blocked: 3 };

/** The newer engines' findings, merged in B12's vocabulary. Blocking beats unknown beats review; unknown never rounds up. */
export function mergeBlockers(base: DispatchEligibility, extra: readonly DispatchBlocker[]): DispatchEligibility {
  const seen = new Set(base.blockers.map(b => b.code));
  const blockers = [...base.blockers, ...extra.filter(b => !seen.has(b.code))];
  const worst = blockers.reduce<EligibilityVerdict>((w, b) => {
    const v: EligibilityVerdict = b.severity === "blocking" ? "blocked" : b.severity === "unknown" ? "unknown" : "eligible_review";
    return RANK[v] > RANK[w] ? v : w;
  }, "eligible");
  const named = blockers.filter(b => b.severity === "blocking").map(b => b.label);
  const explanation = worst === "blocked" ? `BLOCKED — ${named.join("; ")}`
    : worst === "unknown" ? `UNKNOWN — ${blockers.filter(b => b.severity === "unknown").map(b => b.label).join("; ")}`
    : worst === "eligible_review" ? `REVIEW — ${blockers.map(b => b.label).join("; ")}`
    : "READY";
  return { ...base, verdict: worst, blockers, explanation };
}

/** The AI Secretary's "What am I missing?" — the blockers as a checklist, with nothing private on it. */
export function asChecklist(e: DispatchEligibility): { verdict: EligibilityVerdict; items: { code: string; label: string; state: "blocking" | "review" | "unknown"; fixable: string }[] } {
  return {
    verdict: e.verdict,
    items: e.blockers.map(b => ({
      code: b.code, label: b.label, state: b.severity,
      fixable: b.overridable ? (b.severity === "unknown" ? `Needs verification, or a ${b.overrideAuthority ?? "manager"} override with a reason` : `Resolve, or a ${b.overrideAuthority ?? "dispatcher"} may override with a reason`) : "Must be resolved — no override",
    })),
  };
}
