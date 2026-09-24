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

import { type CapabilityResult, type CombinedVerdict } from "./_core/interEngineStatus";
import { CAPABILITY, dispatchContractFor, pictureFor, type EvaluationMap } from "./_core/readinessCapabilities";
import { entitlementToEvaluation, snapshotOf, type PolicySnapshot } from "./_core/automationPolicy";
import { resolveCapabilities } from "./_core/automationPolicyStore";
import { destinationAcceptanceForJob } from "./_core/destinationAcceptance";
import { and, desc, eq, inArray, isNull, or as sqlOr } from "drizzle-orm";
import { hosAttestations } from "../drizzle/schema";
import { faultDispatchEffect } from "./_core/telematics";
import { getDb } from "./db";
import {
  complianceDocuments, dispatchPostings, fieldDevices, insuranceCoveredEntities, insurancePolicies, insurancePolicyCoverages,
  jobs, maintenanceDefects, measurementDeviceAssignments, measurementDevices, calibrationEvents, operators, roadsideServiceEvents,
  units, workOrderReleases,
  coreRecordOwnership, enforcementEvents, outOfServiceOrders,
  faultCodes,
  communicationCoverage, communicationPolicies, companyRadioAuthorizations, radioChannels,
  roadGraphEdges, roadRadioAssignments, routeApprovals, unitRadioCapabilities,
  academyQualifications, academyRequirements, academyRequirementBindings, academyDirectSupervisionRecords,
  loadProfiles,
} from "../drizzle/schema";
import { APPROVED_OVERRIDE_POLICIES, CLASSIFICATION_VERSION, classifyBlocker, mergeFindings, type ComplianceFinding } from "./_core/complianceFinding";
import { canonicalJson, sha256 } from "./_core/auditPackage";
import {
  evaluateDispatchReadiness, type CredentialState, type DispatchBlocker, type DispatchEligibility, type EligibilityVerdict, type ReadinessInput,
} from "./_core/dispatchReadiness";
import { computeEligibilityFingerprint, type EligibilityFacts } from "./_core/dispatchAward";
import { assessCoverage, type PolicyRecord } from "./_core/insuranceRisk";
import { calibrationEffectOnUse, calibrationStatus, type CalibrationEvent } from "./_core/requirementEngine";
import { medicalFitnessForDispatch } from "./_core/compliancePassport";
import { trainingDispatchDecision } from "./_core/trainingAcademy";
import { listRoleNamesAnyScope } from "./db";
import { resolveRouteCommunicationGeography } from "./routeCommunicationGeography";
import { enforcementReadiness, type OosOrder, type OosScope } from "./_core/enforcement";
import { currentReleaseEvidenceFor, type StoredRelease } from "./_core/mechanicRelease";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { commercialReadinessForJob } from "./customerCommercialService";
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

/* ------------------------------------------------------------------ */
/* Enforcement state, read from the canonical table                    */
/* ------------------------------------------------------------------ */

/** The refs the evaluator matches on. Synthesized from entity ids, never from free text. */
const subjectRefForUnit = (id: number) => `unit:${id}`;
const subjectRefForTrailer = (id: number) => `trailer:${id}`;
const subjectRefForOperator = (id: number) => `operator:${id}`;

/**
 * Active out-of-service orders and unestablished inspections covering this readiness subject.
 *
 * **Matched structurally, not by string.** `outOfServiceOrders.subjectRef` is free text the
 * confirming caller supplies ("UNIT-127"), so matching a unit against it would be guesswork.
 * `enforcementEvents` — the order's parent, one per stop — carries real `unitId`, `trailerId` and
 * `operatorId` columns and an index on them, so the event is what says whose order this is. The
 * refs handed to the evaluator are synthesized from those ids and the order keeps its own scope,
 * which is what decides whether a prohibited driver can be replaced on a clear truck.
 *
 * **Tenant scoping is not optional.** An order recorded against another organization must not
 * ground this one's truck. The unit's owning organization comes from `coreRecordOwnership`, the
 * same source `ownershipScopeWhere` uses, and an unowned record is this deployment's single tenant
 * — which is what `enforcementEvents.tenantId` already stores for it.
 *
 * One query for the events, one for their orders. No per-subject round trip.
 */
async function loadEnforcementState(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ids: { unitId: number | null; trailerId: number | null; operatorId: number },
): Promise<NonNullable<ReadinessSubject["enforcement"]> & { version: string }> {
  const subjects: { subjectRef: string; scope: OosScope }[] = [];
  if (ids.unitId != null) subjects.push({ subjectRef: subjectRefForUnit(ids.unitId), scope: "vehicle" });
  if (ids.trailerId != null) subjects.push({ subjectRef: subjectRefForTrailer(ids.trailerId), scope: "trailer" });
  subjects.push({ subjectRef: subjectRefForOperator(ids.operatorId), scope: "driver" });

  // The organization this readiness belongs to, from the unit when there is one.
  let orgRef: string | null = null;
  if (ids.unitId != null) {
    const owner = await db.select({ orgRef: coreRecordOwnership.orgRef }).from(coreRecordOwnership)
      .where(and(eq(coreRecordOwnership.recordType, "unit"), eq(coreRecordOwnership.recordId, ids.unitId))).limit(1);
    orgRef = owner[0]?.orgRef ?? null;
  }
  const tenantOf = (t: string | null) => t ?? SINGLE_TENANT_ID;
  const ourTenant = tenantOf(orgRef);

  const eventFilters = [
    ids.unitId != null ? eq(enforcementEvents.unitId, ids.unitId) : null,
    ids.trailerId != null ? eq(enforcementEvents.trailerId, ids.trailerId) : null,
    eq(enforcementEvents.operatorId, ids.operatorId),
  ].filter((f): f is NonNullable<typeof f> => f != null);

  const events = (await db.select().from(enforcementEvents).where(sqlOr(...eventFilters)))
    .filter(e => e.status !== "rescinded" && tenantOf(e.tenantId) === ourTenant);
  if (!events.length) return { subjects, orders: [], unresolvedInspections: [], version: "none" };

  /** The ref this event's order should be attributed to, preferring the most specific subject. */
  const refFor = (e: typeof events[number]): string | null =>
    ids.unitId != null && e.unitId === ids.unitId ? subjectRefForUnit(ids.unitId)
      : ids.trailerId != null && e.trailerId === ids.trailerId ? subjectRefForTrailer(ids.trailerId)
        : e.operatorId === ids.operatorId ? subjectRefForOperator(ids.operatorId)
          : null;

  const byRef = new Map(events.map(e => [e.eventRef, e] as const));
  const rows = await db.select().from(outOfServiceOrders).where(and(
    inArray(outOfServiceOrders.eventRef, Array.from(byRef.keys())),
    eq(outOfServiceOrders.status, "active"),
  ));

  const orders: OosOrder[] = [];
  for (const o of rows) {
    const e = byRef.get(o.eventRef);
    const ref = e ? refFor(e) : null;
    if (!ref) continue;
    // The order keeps its own scope; only the ref is normalized. A vehicle order and a cargo order
    // on the same stop are different prohibitions and stay different here.
    subjects.push({ subjectRef: ref, scope: o.scope });
    orders.push({
      orderRef: o.orderRef, scope: o.scope, subjectRef: ref, issuedAt: o.issuedAt,
      issuingAgency: o.issuingAgency, releaseCondition: o.releaseCondition,
      releasedAt: o.releasedAt, releasedByUserId: o.releasedByUserId,
      releaseEvidenceRef: o.releaseEvidenceRef, rescindedAt: o.rescindedAt,
    });
  }

  /*
   * An inspection whose result was never established denies authorization for what it covered —
   * the evaluator's own rule, and "we could not read the document" is not a pass.
   */
  const unresolvedInspections = events
    .filter(e => e.inspectionResult === "unknown")
    .map(e => ({ inspectionRef: e.inspectionReportNumber ?? e.eventRef, coversSubjectRefs: [refFor(e)].filter((r): r is string => r != null) }))
    .filter(i => i.coversSubjectRefs.length > 0);

  const seen = new Set<string>();
  const uniqueSubjects = subjects.filter(s => {
    const k = `${s.subjectRef}|${s.scope}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  /*
   * C1a-6 — what the fingerprint sees of enforcement: every event and order that could govern this
   * subject, by identity and state. An order issued, released or rescinded after a check changes it.
   */
  const version = sha256(canonicalJson({
    events: events.map(e => [e.eventRef, e.status, e.inspectionResult]).sort(),
    orders: rows.map(o => [o.orderRef, o.status, o.scope, o.releasedAt, o.rescindedAt]).sort(),
  }));
  return { subjects: uniqueSubjects, orders, unresolvedInspections, version };
}

export type ComposedReadiness = {
  eligibility: DispatchEligibility;
  facts: EligibilityFacts;
  fingerprint: string;
  /** What each engine contributed, for the explanation and the audit row. */
  contributions: { engine: string; finding: string }[];
  /**
   * P8.1 — one result per capability this dispatch reads, including the ones that were never asked.
   * The eligibility above is unchanged and still governs; this is what the eligibility could not
   * say, because a verdict assembled from blockers cannot distinguish a capability that passed from
   * one that was never consulted.
   */
  capabilities: CapabilityResult[];
  /** The same picture combined against dispatch's declared requirements. */
  capabilityVerdict: CombinedVerdict;
  /**
   * P8.2 — the automation policy each capability was decided under. Stored with the decision so an
   * audit reads the policy that governed it; re-resolving later would answer with today's
   * configuration for yesterday's dispatch.
   */
  automationPolicy: PolicySnapshot[];
  /** C1a-6 — hash of the rules the findings were decided under; also inside `facts`. */
  ruleSetHash: string;
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


type AcademyBindingRow = typeof academyRequirementBindings.$inferSelect;

const academyCode = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Facts the central composer can establish without guessing from free text.
 * Jurisdiction and cargo deliberately are not inferred here: those need an
 * authoritative route/cargo classification, not a substring match.
 */
export type AcademyBindingFacts = {
  role: readonly string[];
  equipment: readonly string[];
  job_type: readonly string[];
  customer: readonly string[];
  site: readonly string[];
};

export function academyBindingMatches(binding: Pick<AcademyBindingRow, "subjectType" | "subjectCode">, facts: AcademyBindingFacts): boolean {
  if (binding.subjectType === "jurisdiction" || binding.subjectType === "cargo") return false;
  return facts[binding.subjectType].map(academyCode).includes(academyCode(binding.subjectCode));
}

/* ------------------------------------------------------------------ */
/* Dangerous goods: structured authority only (C1a-7)                  */
/* ------------------------------------------------------------------ */

type LoadClassificationRow = Pick<typeof loadProfiles.$inferSelect, "id" | "unNumber" | "dgClass" | "packingGroup" | "classificationStatus" | "verifiedAt">;

export type DangerousGoodsAuthority = {
  /** dg: verified DG on a load · not_dg: every load verified and none carries a UN number or class ·
   *  unknown: a load may be DG and its classification is not verified, or there is no load record
   *  and something says it may be DG · blocked: a load's classification was refused ·
   *  not_applicable: no load recorded and no DG signal at all. */
  state: "dg" | "not_dg" | "unknown" | "blocked" | "not_applicable";
  blockers: DispatchBlocker[];
  version: string;
  explanation: string;
};

/**
 * Whether a job moves dangerous goods, from the loads' STRUCTURED classification — `loadProfiles`,
 * whose `classificationStatus` a person verifies. Before C1a the composer decided this with
 * `/tdg|dangerous|hazard/i` over the job's free-text type and mode, so "Hazard tree removal" was a
 * TDG shipment and a verified UN1203 load under a job typed "water_haul" was not.
 *
 * Free text is now only ever a reason for suspicion: `freeTextSuggestsDg` can turn "no load
 * recorded" into UNKNOWN, but it can never establish that a load is, or is not, dangerous goods.
 * No language model is asked either.
 */
export function dangerousGoodsAuthority(loads: readonly LoadClassificationRow[], freeTextSuggestsDg: boolean): DangerousGoodsAuthority {
  const version = sha256(canonicalJson(loads.map(l => [l.id, l.classificationStatus, l.unNumber ?? null, l.dgClass ?? null, l.packingGroup ?? null, l.verifiedAt ?? null]).sort()));
  if (loads.length === 0) {
    return freeTextSuggestsDg
      ? {
          state: "unknown", version,
          explanation: "No load is recorded for this job, and its description suggests dangerous goods — classification is missing",
          blockers: [{ code: "dg_classification_missing", label: "The job's description suggests dangerous goods and no load classification is on record", severity: "unknown", subject: "job", overridable: true }],
        }
      : { state: "not_applicable", version, blockers: [], explanation: "No load recorded for this job and no dangerous-goods signal" };
  }
  const refused = loads.filter(l => l.classificationStatus === "blocked");
  if (refused.length) {
    return {
      state: "blocked", version, explanation: `${refused.length} load classification(s) were refused`,
      blockers: [{ code: "dg_classification_blocked", label: `${refused.length} load classification(s) refused — the material cannot be moved until it is classified`, severity: "blocking", subject: "job", overridable: false }],
    };
  }
  const unverified = loads.filter(l => l.classificationStatus !== "verified");
  if (unverified.length) {
    return {
      state: "unknown", version, explanation: `${unverified.length} load classification(s) not verified`,
      blockers: [{ code: "dg_classification_unverified", label: `${unverified.length} load(s) on this job have no verified classification — whether they are dangerous goods is unknown`, severity: "unknown", subject: "job", overridable: true }],
    };
  }
  const dg = loads.filter(l => (l.unNumber ?? "").trim() !== "" || (l.dgClass ?? "").trim() !== "");
  return dg.length
    ? { state: "dg", version, blockers: [], explanation: `${dg.length} verified dangerous-goods load(s): ${dg.map(l => l.unNumber ?? l.dgClass).join(", ")}` }
    : { state: "not_dg", version, blockers: [], explanation: `${loads.length} load(s), all verified, none classified as dangerous goods` };
}

function bindingHasUnevaluatedConditions(conditionsJson: string | null): boolean {
  if (!conditionsJson?.trim()) return false;
  try {
    const parsed = JSON.parse(conditionsJson) as unknown;
    return Boolean(parsed && typeof parsed === "object" && Object.keys(parsed as Record<string, unknown>).length > 0);
  } catch {
    return true;
  }
}

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
  /*
   * P8.1: what was actually asked. A capability absent from this map was evaluated; one present
   * with evaluated:false was not, and says why. The composer is the only place that knows the
   * difference, which is why the map is filled here rather than inferred downstream.
   */
  const evaluation: EvaluationMap = {};
  /*
   * C1a (review) — every expiry that governs a finding, so the fingerprint records whether each had
   * passed AT THE EVALUATION INSTANT. Hashing only `expiresAt` missed time itself: a policy valid at
   * 23:50 and lapsed at 00:10 left every row unchanged, and an award inside the reuse window went
   * through on the 23:50 answer.
   */
  const governingExpiries: { what: string; at: Date | null | undefined }[] = [];

  /* ---- operator ---- */
  const op = (await db.select().from(operators).where(eq(operators.id, subject.operatorId)).limit(1))[0];
  if (!op) throw new Error(`Operator ${subject.operatorId} not found`);
  const opCreds = await credentialsFor("operator", op.id);
  for (const c of opCreds) governingExpiries.push({ what: `operatorDoc:${c.id}`, at: c.expiresAt });
  governingExpiries.push({ what: "legacyLicence", at: op.licenseExpiresAt });
  let licence = credentialState(opCreds, ["driver_licence"], "Driver licence");
  if (!licence.present && op.licenseExpiresAt) {
    // The flat legacy field is a weak signal: present, unverified. It keeps an
    // unmigrated operator from reading as "no licence" while the structured
    // record is still to be entered.
    licence = { label: "Driver licence (legacy record)", present: true, expiresAt: op.licenseExpiresAt };
    contributions.push({ engine: "compliance", finding: "Licence read from the legacy operator record — no structured credential yet" });
  }
  const job = subject.jobId ? (await db.select().from(jobs).where(eq(jobs.id, subject.jobId)).limit(1))[0] ?? null : null;
  /*
   * C1a-7 — dangerous goods from the loads' verified classification, never from the job's wording.
   * The regex survives only as a suspicion signal (see dangerousGoodsAuthority).
   */
  const jobLoads = job ? await db.select({
    id: loadProfiles.id, unNumber: loadProfiles.unNumber, dgClass: loadProfiles.dgClass, packingGroup: loadProfiles.packingGroup,
    classificationStatus: loadProfiles.classificationStatus, verifiedAt: loadProfiles.verifiedAt,
  }).from(loadProfiles).where(eq(loadProfiles.jobId, job.id)) : [];
  const dgAuthority = dangerousGoodsAuthority(jobLoads, job ? /tdg|dangerous|hazard/i.test(`${job.type ?? ""} ${job.mode ?? ""}`) : false);
  const dangerousGoods = dgAuthority.state === "dg";
  /*
   * v23.26 — the job's commercial basis: customer on hold, contract not usable, a required PO/AFE
   * absent, no governing rate sheet version, no snapshot yet. Company policy, never safety; an
   * emergency posting turns a missing paper reference into a review item and nothing else.
   */
  const commercial = job ? await commercialReadinessForJob(db, job.id, now) : { blockers: [] as DispatchBlocker[], version: "none" };
  extra.push(...commercial.blockers);
  if (job) contributions.push({ engine: "commercial", finding: commercial.blockers.length ? commercial.blockers.map(b => b.code).join(", ") : "commercial basis in order" });
  /** For rules that only tighten (communications): a load that may be DG is treated as DG there. */
  const possiblyDangerousGoods = dgAuthority.state === "dg" || dgAuthority.state === "unknown";
  extra.push(...dgAuthority.blockers);
  if (job) contributions.push({ engine: "dangerous_goods", finding: `${dgAuthority.state}: ${dgAuthority.explanation}` });
  const required: CredentialState[] = [];

  /* ---- Training Academy bindings ----
   * The Academy is applied only when an explicit binding matches facts the
   * server can establish. No global "every driver needs every course" rule,
   * and no province/cargo guesses from free text.
   */
  let academyVersion = "none";
  /** C1a-6 — the training RULES that applied (bindings and requirement definitions), for the rule-set hash. */
  let academyRuleVersion = "none";
  if (job) {
    // Every role, confined ones included: a driver confined to one branch is
    // still a driver and still owes the driver's courses.
    const roles = op.userId ? await listRoleNamesAnyScope(op.userId) : [];
    const unitForBinding = subject.unitId ? (await db.select().from(units).where(eq(units.id, subject.unitId)).limit(1))[0] ?? null : null;
    const bindingFacts: AcademyBindingFacts = {
      role: roles,
      equipment: unitForBinding ? [unitForBinding.vehicleType] : [],
      job_type: [job.type, job.mode],
      customer: [job.customer],
      site: [job.location],
    };
    const bindings = await db.select().from(academyRequirementBindings).where(eq(academyRequirementBindings.active, true));
    const liveBindings = bindings.filter(b => (!b.effectiveAt || b.effectiveAt <= now) && (!b.expiresAt || b.expiresAt > now));
    const matchedBindings = liveBindings.filter(b => academyBindingMatches(b, bindingFacts));
    const matchedRequirementIds = Array.from(new Set(matchedBindings.map(b => b.requirementId)));
    if (matchedRequirementIds.length) {
      const reqs = (await db.select().from(academyRequirements).where(inArray(academyRequirements.id, matchedRequirementIds))).filter(r => r.active);
      academyRuleVersion = sha256(canonicalJson({
        bindings: matchedBindings.map(b => [b.id, b.requirementId, b.subjectType, b.subjectCode, b.active, b.effectiveAt ?? null, b.expiresAt ?? null, b.conditionsJson ?? null]).sort(),
        requirements: reqs.map(r => [r.id, r.requirementCode, r.qualificationCode, r.enforcement, r.active, r.updatedAt]).sort(),
      }));
      if (!op.userId) {
        extra.push({ code: "academy_operator_unlinked", label: "Training requirements apply to this job, but the operator is not linked to a user qualification record", severity: "unknown", subject: "operator", overridable: true, overrideAuthority: "dispatcher" });
        contributions.push({ engine: "academy", finding: `${reqs.length} bound training requirement(s) apply, but operator ${op.id} has no user link` });
        academyVersion = versionOf([...matchedBindings.map(b => `${b.id}:${b.requirementId}:${b.createdAt.toISOString()}`), ...reqs.map(r => `${r.id}:${r.updatedAt.toISOString()}`)]);
      } else {
        const conditional = matchedBindings.filter(b => bindingHasUnevaluatedConditions(b.conditionsJson));
        if (conditional.length) {
          extra.push({ code: "academy_binding_conditions_unknown", label: `${conditional.length} applicable training binding(s) have additional conditions the central dispatch composer cannot yet evaluate`, severity: "unknown", subject: "operator", overridable: true, overrideAuthority: "dispatcher" });
        }
        const conditionlessRequirementIds = new Set(matchedBindings.filter(b => !bindingHasUnevaluatedConditions(b.conditionsJson)).map(b => b.requirementId));
        const applicable = reqs.filter(r => conditionlessRequirementIds.has(r.id));
        const quals = await db.select().from(academyQualifications).where(eq(academyQualifications.userId, op.userId));
        for (const q of quals) governingExpiries.push({ what: `academyQual:${q.id}`, at: q.expiresAt });
        const accepted = quals.filter(q => q.status === "current" && (!q.expiresAt || q.expiresAt > now)).map(q => ({ code: q.qualificationCode, status: q.status, expiresAt: q.expiresAt }));
        const supers = await db.select().from(academyDirectSupervisionRecords).where(and(
          eq(academyDirectSupervisionRecords.traineeUserId, op.userId),
          eq(academyDirectSupervisionRecords.jobId, job.id),
          eq(academyDirectSupervisionRecords.status, "active"),
          eq(academyDirectSupervisionRecords.physicalPresenceAttested, true),
        ));
        for (const sup of supers) governingExpiries.push({ what: `supervisionStart:${sup.id}`, at: sup.startsAt }, { what: `supervisionEnd:${sup.id}`, at: sup.endsAt });
        for (const sup of supers) {
          if (sup.startsAt <= now && sup.endsAt > now && !accepted.some(q => q.code === sup.qualificationCode)) {
            accepted.push({ code: sup.qualificationCode, status: "current" as const, expiresAt: sup.endsAt });
          }
        }
        const decision = trainingDispatchDecision(applicable.map(r => ({ code: r.requirementCode, title: r.title, qualificationCode: r.qualificationCode, enforcement: r.enforcement, recoveryPath: r.recoveryPath })), accepted, now);
        // P0.6: the code is the requirement's own. A code derived from the title changes the moment
        // somebody edits the wording, and every override keyed to the old one stops matching.
        for (const b of decision.blocking) extra.push({ code: `academy_${b.code}`.slice(0, 80), label: b.detail, severity: "blocking", subject: "operator", overridable: false });
        for (const b of decision.reviewing) extra.push({ code: `academy_review_${b.code}`.slice(0, 80), label: b.detail, severity: "review", subject: "operator", overridable: true, overrideAuthority: "manager" });
        contributions.push({ engine: "academy", finding: `${applicable.length} bound requirement(s): ${decision.status}; ${decision.satisfied.length} satisfied` });
        academyVersion = versionOf([
          ...matchedBindings.map(b => `${b.id}:${b.requirementId}:${b.active}:${b.effectiveAt?.toISOString() ?? "∅"}:${b.expiresAt?.toISOString() ?? "∅"}:${b.conditionsJson ?? "∅"}`),
          ...reqs.map(r => `${r.id}:${r.requirementCode}:${r.qualificationCode}:${r.enforcement}:${r.active}:${r.updatedAt.toISOString()}`),
          ...quals.map(q => `${q.id}:${q.qualificationCode}:${q.status}:${q.expiresAt?.toISOString() ?? "∅"}:${q.updatedAt.toISOString()}`),
          ...supers.map(x => `${x.id}:${x.qualificationCode}:${x.status}:${x.physicalPresenceAttested}:${x.startsAt.toISOString()}:${x.endsAt.toISOString()}`),
        ]);
      }
    }
  }
  if (dangerousGoods) required.push(credentialState(opCreds, ["tdg_certificate"], "TDG certificate"));
  // Medical fitness reaches dispatch as a projection only.
  const medRow = opCreds.filter(c => c.docType === "medical_fitness").sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
  const med = medicalFitnessForDispatch(medRow ? { docType: "medical_fitness", expiresAt: medRow.expiresAt, verificationStatus: medRow.verificationStatus, privateDetail: true } : null, now);
  if (med.eligible === "no") extra.push({ code: "medical_fitness_not_current", label: "Commercial medical fitness not current", severity: "blocking", subject: "operator", overridable: false });
  else if (med.eligible === "unknown") extra.push({ code: "medical_fitness_unknown", label: "Commercial medical fitness not verified", severity: "unknown", subject: "operator", overridable: true, overrideAuthority: "manager" });
  contributions.push({ engine: "compliance", finding: `Medical fitness: ${med.eligible}` });
  const medicalVersion = medRow ? versionOf([medRow.id, medRow.verificationStatus, medRow.expiresAt?.toISOString()]) : "none";

  const device = (await db.select({ status: fieldDevices.status }).from(fieldDevices).where(eq(fieldDevices.userId, op.userId ?? -1)).orderBy(desc(fieldDevices.enrolledAt)).limit(1))[0];
  const deviceVersion = device ? device.status : "none";
  if (device && device.status === "revoked") extra.push({ code: "field_device_revoked", label: "Operator's field device is revoked — evidence cannot be captured", severity: "review", subject: "operator", overridable: true, overrideAuthority: "dispatcher" });

  /* ---- unit ---- */
  let truck: ReadinessInput["truck"] = { unitNumber: "—", inspection: { label: "Inspection", present: false, expiresAt: null }, registration: { label: "Registration", present: false, expiresAt: null }, insurance: { label: "Insurance", present: false, expiresAt: null }, maintenanceOverdue: false, criticalDefectOpen: false, mechanicReleaseRequired: false, mechanicReleaseGiven: false };
  let unitVersion = "none", releaseVersion = "none", criticalCount = 0;
  let unitCredentialVersion = "none", insuranceVersion = "none", roadsideVersion = "none", calibrationVersion = "none";
  const credentialVersionOf = (rows: readonly CredRow[]) => versionOf(rows.map(c => `${c.id}:${c.docType}:${c.verificationStatus}:${c.expiresAt?.toISOString() ?? "∅"}`).sort());
  const insuranceVersionOf = (pols: readonly PolicyRecord[]) => versionOf(pols.map(p => `${p.policyRef}:${p.status}:${p.coverageVerificationStatus}:${p.expiresAt.toISOString()}:${p.document?.verificationStatus ?? "∅"}:${p.document?.expiresAt?.toISOString() ?? "∅"}`).sort());
  if (subject.unitId) {
    const unit = (await db.select().from(units).where(eq(units.id, subject.unitId)).limit(1))[0];
    if (!unit) throw new Error(`Unit ${subject.unitId} not found`);
    const [uCreds, defects, releases, roadside, pols, assignments] = await Promise.all([
      credentialsFor("unit", unit.id),
      /*
       * Open defects, AND every critical one whatever its status. A resolved critical defect still
       * matters: the release that evidenced its resolution can be revoked afterwards, and readiness
       * has to be able to notice that.
       */
      db.select().from(maintenanceDefects).where(and(
        eq(maintenanceDefects.unitId, unit.id),
        sqlOr(inArray(maintenanceDefects.status, ["open", "in_progress"]), eq(maintenanceDefects.severity, "critical")),
      )),
      /*
       * Every release on the unit, not the newest five. Under the old timestamp rule a window was
       * harmless because only the newest row could ever matter; matching by defect identity, an
       * older release is the one that names a given defect, and a window would silently drop it.
       */
      db.select().from(workOrderReleases).where(eq(workOrderReleases.unitId, unit.id)).orderBy(desc(workOrderReleases.releasedAt)),
      db.select().from(roadsideServiceEvents).where(and(eq(roadsideServiceEvents.unitId, unit.id), inArray(roadsideServiceEvents.status, ["open", "vendor_assigned", "in_repair", "repaired_awaiting_release"]))),
      policiesCovering("unit", unit.id, now),
      db.select().from(measurementDeviceAssignments).where(and(eq(measurementDeviceAssignments.assignedToType, "unit"), eq(measurementDeviceAssignments.assignedToId, unit.id))),
    ]);
    /*
     * Two conditions, kept apart — the manifest has always listed them separately ("unresolved
     * critical defects" and "critical work-order mechanic release") and collapsing them into one
     * timestamp comparison is what let a revocation read as an approval.
     *
     *   the DEFECT  — is there a critical defect nobody has resolved?
     *   the RELEASE — does the release evidence for each critical defect still stand?
     *
     * Neither is inferred from the other, and neither is inferred from chronology. A release is
     * evidence about the defects it NAMES; `records.maintenance.resolveDefect` is what closes a
     * defect, and it is a separate, recorded act by a named person.
     */
    const critical = defects.filter(d => d.severity === "critical");
    const storedReleases: StoredRelease[] = releases.map(r => ({
      id: r.id, workOrderId: r.workOrderId, releaseType: r.releaseType,
      testResult: r.testResult, resolvedDefectIds: r.resolvedDefectIds, releasedAt: r.releasedAt,
    }));
    const unresolvedCritical = critical.filter(d => d.status !== "resolved");
    criticalCount = unresolvedCritical.length;
    /*
     * Which critical defects owe standing release evidence: the unresolved ones, and the ones that
     * were resolved ON a release — because revoking that release withdraws the evidence the
     * resolution rested on, and readiness must get worse, never better, when that happens.
     */
    const owingEvidence = critical.filter(d => d.status !== "resolved" || d.resolvedByReleaseId != null);
    const withoutEvidence = owingEvidence.filter(d => currentReleaseEvidenceFor(d.id, storedReleases) == null);
    truck = {
      unitNumber: unit.unitNumber,
      inspection: credentialState(uCreds, ["cvip_certificate", "annual_inspection"], "Annual inspection"),
      registration: credentialState(uCreds, ["vehicle_registration"], "Registration"),
      insurance: { label: "Insurance", present: pols.length > 0, expiresAt: pols.length ? new Date(Math.max(...pols.map(p => p.expiresAt.getTime()))) : null },
      maintenanceOverdue: unit.maintenanceStatus === "blocked",
      criticalDefectOpen: unresolvedCritical.length > 0,
      mechanicReleaseRequired: owingEvidence.length > 0,
      mechanicReleaseGiven: owingEvidence.length > 0 && withoutEvidence.length === 0,
    };
    unitVersion = versionOf([unit.maintenanceStatus, defects.length, ...defects.map(d => `${d.id}:${d.status}:${d.resolvedByReleaseId ?? "∅"}`)]);
    releaseVersion = versionOf(releases.map(r => `${r.id}:${r.releaseType}:${r.testResult ?? "∅"}:${r.resolvedDefectIds ?? "∅"}`));
    unitCredentialVersion = credentialVersionOf(uCreds);
    for (const c of uCreds) governingExpiries.push({ what: `unitDoc:${c.id}`, at: c.expiresAt });
    for (const p of pols) governingExpiries.push({ what: `unitPolicy:${p.policyRef}`, at: p.expiresAt }, { what: `unitPolicyProof:${p.policyRef}`, at: p.document?.expiresAt });
    insuranceVersion = `unit=${insuranceVersionOf(pols)}`;
    roadsideVersion = versionOf(roadside.map(r => `${r.id}:${r.status}`).sort());

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
      calibrationVersion = versionOf([...devs.map(d => `${d.id}:${d.calibrationIntervalDays}`), ...evs.map(e => `${e.id}:${e.measurementDeviceId}`)].sort());
      for (const dv of devs) {
        const st = calibrationStatus({ events: evs.filter(e => e.measurementDeviceId === dv.id) as CalibrationEvent[], intervalDays: dv.calibrationIntervalDays, now });
        const eff = calibrationEffectOnUse(st, "dispatch_availability");
        calibrationVersion = `${calibrationVersion};${dv.id}=${st.status}`; // status moves with time (due → expired)
        contributions.push({ engine: "calibration", finding: `${dv.deviceRef}: ${st.status} — dispatch ${eff.effect}` });
        if (eff.effect !== "ok") extra.push({ code: "measurement_device_uncalibrated", label: `${dv.deviceType.replace(/_/g, " ")} ${dv.deviceRef}: ${st.reason} — billing measurements on hold`, severity: "review", subject: "truck", overridable: true, overrideAuthority: "manager" });
      }
    }
  }

  /* ---- trailer ---- */
  // v21.19 — telematics faults on the truck: undetermined severity is UNKNOWN (a mechanic decides); an acknowledged
  // critical fault blocks; an acknowledged inspection-required one is REVIEW.
  let telematicsFaultVersion = "none";
  if (subject.unitId) {
    const faults = await db.select().from(faultCodes).where(and(eq(faultCodes.unitId, subject.unitId), inArray(faultCodes.status, ["active", "acknowledged"])));
    // Identity, status and severity determination only — never last-seen time or counts (high-frequency).
    telematicsFaultVersion = versionOf(faults.map(f => `${f.id}:${f.status}:${f.severityDetermination}`).sort());
    for (const f of faults) {
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
    // C1a-6 — was [id, number of documents]: a trailer inspection replaced by an expired one read as unchanged.
    trailerVersion = versionOf([tr.id, credentialVersionOf(tCreds)]);
    insuranceVersion = `${insuranceVersion};trailer=${insuranceVersionOf(pols)}`;
    for (const c of tCreds) governingExpiries.push({ what: `trailerDoc:${c.id}`, at: c.expiresAt });
    for (const p of pols) governingExpiries.push({ what: `trailerPolicy:${p.policyRef}`, at: p.expiresAt }, { what: `trailerPolicyProof:${p.policyRef}`, at: p.document?.expiresAt });
  }

  /* ---- job ---- */
  // Destination acceptance comes from the facility directory: the latest loadFacilityAssessment per load on this job.
  // No loads or no assessments → null (review); any load whose latest assessment blocks → false; every load non-blocking → true.
  const destination = await destinationAcceptanceForJob(db, job?.id ?? null);
  const jobInput: ReadinessInput["job"] = {
    classificationComplete: job ? Boolean(job.type && job.mode) : false,
    dangerousGoods,
    tdgDocumentPrepared: dangerousGoods ? null : true,
    requiredDocumentsPresent: job ? true : false,
    permitRequired: false,
    permitOnFile: null,
    destinationAcceptanceVerified: destination.verified,
    destinationAssessments: destination.assessments,
    emergencyPlanOnFile: dangerousGoods ? null : true,
  };
  if (!job) contributions.push({ engine: "dispatch", finding: "No job supplied — job requirements not evaluated" });

  /* ---- enforcement: an order from outside this company ---- */
  /*
   * The composer loads this itself.
   *
   * It used to take enforcement only from `subject.enforcement`, and not one production caller
   * supplied it — `dispatchRouter`'s input schema has no field for it. So the capability that this
   * very file calls overridable by nobody ("a manager may override a company rule; an inspector's
   * order is not a company rule") reported PASS on every dispatch, from an input nothing provided,
   * while active orders sat in `outOfServiceOrders`. A caller forgetting to pass an optional object
   * is not evidence that enforcement was checked and found clear.
   *
   * The caller-supplied form is kept as a seam for tests and for a caller that has already
   * resolved the state, but it is now an override of a real read rather than the only source.
   */
  let enforcementSubject = subject.enforcement ?? null;
  let enforcementVersion = enforcementSubject ? `supplied:${sha256(canonicalJson(enforcementSubject))}` : "none";
  if (!enforcementSubject) {
    try {
      const loaded = await loadEnforcementState(db, { unitId: subject.unitId, trailerId: subject.trailerId, operatorId: op.id });
      enforcementVersion = loaded.version;
      enforcementSubject = loaded;
    } catch (error) {
      /*
       * A read that failed is NOT a clear result. It travels as NOT_EVALUATED in P8.1's own
       * vocabulary, which the contract turns into an `unknown` blocker — never silence.
       */
      evaluation[CAPABILITY.enforcementOrders] = {
        evaluated: false, reason: "no_data_source_loaded",
        detail: `Enforcement orders could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
      contributions.push({ engine: "enforcement", finding: "Enforcement state could not be read — reported as not evaluated, not as clear" });
      enforcementSubject = null;
      enforcementVersion = "unreadable";
    }
  }
  if (enforcementSubject?.subjects.length) {
    const enf = enforcementReadiness({
      subjects: enforcementSubject.subjects,
      orders: enforcementSubject.orders,
      unresolvedInspections: enforcementSubject.unresolvedInspections,
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

  /* ---- P8.3: the paper-log fallback ---- */
  /*
   * Scoped to THIS duty day. Hours are a daily fact, so yesterday's statement says nothing about
   * today, and a lookup that ignored the date would quietly make one attestation cover a week.
   */
  const dutyDate = now.toISOString().slice(0, 10);
  const dutyDateValue = new Date(`${dutyDate}T00:00:00Z`);
  const attRow = (await db.select().from(hosAttestations).where(and(
    eq(hosAttestations.operatorId, op.id),
    eq(hosAttestations.dutyDate, dutyDateValue),
    isNull(hosAttestations.supersededAt),
  )).orderBy(desc(hosAttestations.attestedAt)).limit(1))[0];
  const hoursAttestation = attRow
    ? {
        attestedByUserId: attRow.attestedByUserId, attestedAt: attRow.attestedAt,
        dutyDate: attRow.dutyDate instanceof Date ? attRow.dutyDate.toISOString().slice(0, 10) : String(attRow.dutyDate), method: attRow.method,
        statement: attRow.statement, minutesStated: attRow.hoursAvailableMinutesStated ?? null,
      }
    : null;
  const hosVersion = attRow ? versionOf([attRow.id, attRow.method, attRow.hoursAvailableMinutesStated, attRow.supersededAt?.toISOString()]) : `none:${dutyDate}`;
  if (hoursAttestation) {
    contributions.push({ engine: "hos", finding: `Hours attested for ${dutyDate} by user ${hoursAttestation.attestedByUserId} — stated, not computed` });
  }

  /* ---- route and communications ---- */
  const route: ReadinessInput["route"] = { dispatchStatus: null, dataTrustworthy: null };
  let routeProfileId: string | null = null;
  let routeDecisionVersion = "not_evaluated";
  let communicationPlanVersion = "none";
  let communicationPolicyRef: string | null = null;

  if (!subject.routeApprovalRef) {
    // Unchanged, and still true: without a named route there is nothing to read. What is new is
    // that the absence is now structured, so a consumer sees it instead of reading past it.
    contributions.push({ engine: "routing", finding: "No route named for this readiness — the route axis is not evaluated" });
    evaluation[CAPABILITY.routeRestrictions] = { evaluated: false, reason: "not_applicable", detail: "no route named for this readiness" };
  } else {
    const approval = (await db.select().from(routeApprovals).where(eq(routeApprovals.approvalRef, subject.routeApprovalRef)).limit(1))[0];
    if (!approval) {
      extra.push({ code: "route_approval_missing", label: `Route ${subject.routeApprovalRef} is not on record`, severity: "unknown", subject: "route", overridable: true, overrideAuthority: "manager" });
      contributions.push({ engine: "routing", finding: `Route approval ${subject.routeApprovalRef} not found` });
    } else {
      routeProfileId = approval.approvalRef;
      // C1a-6 — the whole dependency hash (permits, restrictions, structures, vehicle and load are all
      // inside it) and the approval's status: a revocation used to leave the fingerprint unchanged.
      routeDecisionVersion = `${approval.status}:${approval.fingerprintHash}`;
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
      communicationPolicyRef = policyRef;
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
      for (const b of communicationBlockers(plan, policy, { loneWorker: subject.loneWorker === true, unitHasSatellite: cap ? cap.satellite : null, dangerousGoods: possiblyDangerousGoods })) extra.push(b);
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
    operator: { operatorId: op.id, name: op.name, licence, requiredCredentials: required, hoursAvailableMinutes: null, hoursAttestation, projectedJobMinutes: null, availabilityDeclared: false },
    truck, trailer, job: jobInput, route,
  };
  const base = evaluateDispatchReadiness(input);
  const eligibilityBeforeCapabilities = mergeBlockers(base, extra, now);

  /*
   * P8.1, per the owner decision of 2026-09-18. Routing, a destination and a mechanic release are
   * required only when the trip uses them — requiring them always would stall every mapping-only
   * customer on a destination they never had, which is the failure this contract exists to prevent.
   */
  /*
   * P8.2 → P8.1. Until now the composer reported every capability as evaluated because it had no
   * way to know otherwise; routing was the single exception, and only because "no route named" is
   * visible locally. The resolver supplies the rest: a capability this tenant is not entitled to
   * has no automation mode and reports NOT_EVALUATED with the reason, rather than being silently
   * counted as satisfied.
   *
   * A capability nobody has ruled on resolves as `unresolved`, which also fails closed — and says
   * so differently, so a missing entitlement feed can be found rather than looking like a customer
   * who never bought the feature.
   */
  const ALL_CAPABILITIES = Object.values(CAPABILITY);
  // The tenant is the job's, when there is a job: policy belongs to the business whose work this is.
  // Without a job this is the historical single tenant, the same NULL rule as 0132.
  const policyOrgRef = (job as { orgRef?: string | null } | null)?.orgRef ?? null;
  const resolutions = await resolveCapabilities(policyOrgRef, ALL_CAPABILITIES, {
    role: null, task: subject.jobId ? `job:${subject.jobId}` : null, customer: null,
  });
  const automationPolicy: PolicySnapshot[] = [];
  for (const capability of ALL_CAPABILITIES) {
    const r = resolutions[capability]!;
    automationPolicy.push(snapshotOf(r, { engineProfileVersion: "readinessComposer", decidedAt: now }));
    const e = entitlementToEvaluation(r);
    // Routing's local "no route named" is more specific than "not entitled" and is kept.
    if (!e.evaluated && !evaluation[capability]) {
      evaluation[capability] = { evaluated: false, reason: e.reason, detail: e.detail };
    }
  }

  const contract = dispatchContractFor({
    routingInUse: subject.routeApprovalRef != null,
    destinationRequired: jobInput?.destinationAcceptanceVerified !== undefined && jobInput?.destinationAcceptanceVerified !== null,
    mechanicReleaseApplicable: eligibilityBeforeCapabilities.blockers.some(b => /defect|work_order|mechanic/i.test(b.code)),
      // The resolver has already answered; an unlicensed capability leaves the contract entirely,
    // so nothing asks for it and nothing reports its silence as a blocker.
    notLicensed: Object.entries(evaluation)
      .filter(([, e]) => !e.evaluated && e.reason === "not_licensed")
      .map(([capability]) => capability),
  });
  const picture = pictureFor(contract, eligibilityBeforeCapabilities.blockers, evaluation);
  /*
   * A required capability that was not evaluated becomes a blocker of severity `unknown` — the
   * engine's own existing word for "an unevaluated condition is not a known-minor one". Dispatch
   * therefore cannot read the silence as satisfaction, and it travels through the engine's
   * vocabulary rather than around it in a second verdict.
   */
  const eligibility = picture.extraBlockers.length
    ? mergeBlockers(eligibilityBeforeCapabilities, picture.extraBlockers, now)
    : eligibilityBeforeCapabilities;

  /*
   * C1a-6 — the rules these findings were decided under. A change to any of them makes every check
   * taken under the old rules stale, even though no fact about the truck or the driver moved.
   */
  const ruleSetHash = sha256(canonicalJson({
    classification: CLASSIFICATION_VERSION,
    overridePolicies: APPROVED_OVERRIDE_POLICIES.map(p => `${p.policyRef}@${p.version}`).sort(),
    academyRules: academyRuleVersion,
    communicationPolicy: communicationPolicyRef,
    dispatchContract: [...contract.requires].sort(),
  }));
  // Decision-bearing fields only: `decidedAt`, `trace` and `reason` change on every call.
  const policyVersion = sha256(canonicalJson({
    automation: automationPolicy.map(a => [a.capability, a.entitled, a.winningPolicyVersionId, a.resolvedMode, a.safetyCeiling, a.clamped]).sort(),
    communicationPolicy: communicationPolicyRef,
  }));

  const facts: EligibilityFacts = {
    operatorId: op.id,
    operatorCredentialVersion: versionOf([
      ...opCreds.map(c => `${c.id}:${c.verificationStatus}:${c.expiresAt?.toISOString() ?? "∅"}`),
      // C1a-6 — the legacy licence field feeds the licence check when no structured record exists,
      // so a change to it must move the fingerprint too.
      `legacyLicence:${op.licenseExpiresAt?.toISOString() ?? "∅"}`,
      `academy:${academyVersion}`,
    ]),
    hoursAvailableMinutes: null,
    unitId: subject.unitId, unitStatusVersion: unitVersion, criticalDefectCount: criticalCount, mechanicReleaseVersion: releaseVersion,
    trailerId: subject.trailerId, trailerStatusVersion: trailerVersion,
    // v23.26 — the commercial basis rides in the job's version: a PO recorded, a hold placed or a
    // snapshot taken between check and award makes the check stale, like every other job fact.
    jobClassificationVersion: job ? versionOf([job.id, job.type, job.mode, job.status, commercial.version]) : "none",
    materialClassificationVersion: dgAuthority.version,
    // Permits reach dispatch only inside a route approval's dependency hash (there is no permit
    // record yet — C6); `routeDecisionVersion` carries that hash in full.
    permitVersion: subject.routeApprovalRef ? `via-route:${routeDecisionVersion}` : "none",
    destinationAcceptanceVersion: sha256(canonicalJson({ verified: destination.verified, assessments: (destination.assessments ?? []).map(a => [a.loadNumber, a.facilityKey, a.outcome, a.blocking, a.assessedAt]).sort() })),
    routeProfileId, routeDecisionVersion, communicationPlanVersion,
    unitCredentialVersion, insuranceVersion, enforcementVersion, roadsideVersion, telematicsFaultVersion,
    calibrationVersion, medicalVersion, hosVersion, deviceVersion, ruleSetHash, policyVersion,
    expiryStateVersion: sha256(canonicalJson(governingExpiries
      .map(e => [e.what, e.at ? e.at.getTime() <= now.getTime() : null])
      .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))),
  };
  return {
    eligibility, facts, fingerprint: computeEligibilityFingerprint(facts), contributions,
    capabilities: picture.capabilities, capabilityVerdict: picture.verdict, automationPolicy, ruleSetHash,
  };
}

/* ------------------------------------------------------------------ */
/* Merge                                                                */
/* ------------------------------------------------------------------ */

const RANK: Record<EligibilityVerdict, number> = { eligible: 0, eligible_review: 1, unknown: 2, blocked: 3 };

/**
 * The newer engines' findings, merged with the base engine's, in one vocabulary.
 *
 * C1a — every blocker is classified into a `ComplianceFinding` (complianceFinding.ts) and duplicates
 * of one code keep the STRICTEST, not the first seen: before C1a a later, non-overridable duplicate
 * was silently dropped if an overridable one with the same code arrived first. The outcome does not
 * depend on arrival order. Blocking beats unknown beats review; unknown never rounds up.
 */
export function mergeBlockers(base: DispatchEligibility, extra: readonly DispatchBlocker[], at: Date = base.evaluatedAt): DispatchEligibility {
  const findings: ComplianceFinding[] = mergeFindings([...base.blockers, ...extra].map(b => classifyBlocker(b, at)));
  const worst = findings.reduce<EligibilityVerdict>((w, b) => {
    const v: EligibilityVerdict = b.severity === "blocking" ? "blocked" : b.severity === "unknown" ? "unknown" : "eligible_review";
    return RANK[v] > RANK[w] ? v : w;
  }, "eligible");
  const named = findings.filter(b => b.severity === "blocking").map(b => b.label);
  const explanation = worst === "blocked" ? `BLOCKED — ${named.join("; ")}`
    : worst === "unknown" ? `UNKNOWN — ${findings.filter(b => b.severity === "unknown").map(b => b.label).join("; ")}`
    : worst === "eligible_review" ? `REVIEW — ${findings.map(b => b.label).join("; ")}`
    : "READY";
  return { ...base, verdict: worst, blockers: findings, explanation };
}

/** The AI Secretary's "What am I missing?" — the blockers as a checklist, with nothing private on it. */
export function asChecklist(e: DispatchEligibility): { verdict: EligibilityVerdict; items: { code: string; label: string; state: "blocking" | "review" | "unknown"; fixable: string }[] } {
  return {
    verdict: e.verdict,
    items: e.blockers.map(b => ({
      code: b.code, label: b.label, state: b.severity,
      fixable: fixableText(b),
    })),
  };
}

/** What the person can legitimately do next, in the finding's own terms. */
function fixableText(b: DispatchBlocker): string {
  const f = classifyBlocker(b, new Date(0));
  switch (f.overrideClass) {
    case "NEVER_OVERRIDABLE": return "Must be resolved — no override";
    case "APPROVED_POLICY_ONLY": return f.result === "UNKNOWN"
      ? "Needs verification — released only under an owner-approved override policy"
      : "Must be resolved — released only under an owner-approved override policy";
    case "WARNING_ONLY": return f.result === "UNKNOWN"
      ? `Needs verification, or acknowledgement by a ${f.overrideAuthority ?? "manager"} with a reason`
      : `Resolve, or acknowledgement by a ${f.overrideAuthority ?? "dispatcher"} with a reason`;
    default: return "Informational";
  }
}
