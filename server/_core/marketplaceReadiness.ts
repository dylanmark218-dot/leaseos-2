/**
 * Marketplace bid readiness — verified against LeaseOS's own registries (0192, P10.3).
 *
 * PURE. The facts arrive already read from the canonical systems — the organization row, the
 * contractor profile, the organization's financial entities and their carrier credentials
 * (`complianceDocuments`, ownerType `carrier`, keyed by financial entity exactly as
 * `carrierProfileReviews` and `insurancePolicies` are), its insurance policies as the insurance
 * engine's own `PolicyRecord`s, its owned units with their inspection and maintenance flags, its
 * workers' qualification holdings, and any carrier-scope out-of-service order — and this module
 * decides one thing: may this organization SUBMIT a bid on this tender, and why.
 *
 * It does not decide whether a truck or a driver may be dispatched. That is the dispatch gate's
 * question (`readinessComposer` / `evaluateDispatchReadiness`), asked per operator and unit at
 * assignment, after the award. A company allowed to tender is not a driver allowed to drive, and
 * the two verdicts are kept in different vocabularies so nobody reads one as the other:
 *
 *     marketplace bid readiness  ≠  dispatch readiness
 *
 * Rules the rows obey:
 *   - A hard requirement that cannot be verified is UNKNOWN and BLOCKS. Unknown is not satisfied.
 *     (`countsAsHeld`'s rule for a credential with no establishable expiry, applied to the tender.)
 *   - Counts, never names. The client reads the picture; the rows carry how many workers hold a
 *     qualification, never which workers. Private credential detail stays in the registry.
 *   - The insurance rule is the insurance engine's (`matchCustomerRequirements`): MATCH / GAP /
 *     UNKNOWN, with the tender as the "customer".
 *   - The qualification rule is the Academy's (`countsAsHeld`): verified, unexpired, with an
 *     establishable expiry.
 *   - The document rule is the document engine's (`complianceDocumentValidity`).
 */

import { canonicalJson, sha256 } from "./auditPackage";
import { complianceDocumentValidity, type ComplianceDocumentRow } from "./complianceDocumentValidity";
import { matchCustomerRequirements, type PolicyRecord } from "./insuranceRisk";
import { countsAsHeld, type QualificationHolding } from "./qualificationValidity";
import type { BiddingWindow, PostingDistribution } from "./marketplace";

/* ===================== tender requirements ===================== */

/** The Academy's qualification code for TDG road training; what `tdgRequired` resolves to. */
export const TDG_QUALIFICATION_CODE = "TDG_ROAD";

/** The coverage type a plain liability minimum asks for, in the insurance registry's vocabulary. */
export const DEFAULT_LIABILITY_COVERAGE_TYPE = "general_liability";

/**
 * What a tender requires of a bidding organization, typed and deterministic. Every field names a
 * record the canonical registries hold; nothing here is a rule engine.
 */
export type TenderRequirements = {
  /** Qualification codes (`workerQualifications.code` / `academyQualifications.qualificationCode`) a worker must hold. */
  workerQualificationCodes: string[];
  /** Carrier-level compliance document types (`complianceDocuments.docType`, ownerType `carrier`): WCB clearance, safety fitness, permits. */
  organizationDocTypes: string[];
  /** Dangerous goods on the haul: adds the TDG road qualification to the worker codes. */
  tdgRequired: boolean;
  /** Insurance the tender demands, matched by the insurance engine. */
  insurance: { coverageType: string; minimumLimitCents: number | null; additionalInsuredRequired: boolean } | null;
  /** Unit classes (`units.vehicleType`) that can do the work; at least `unitsRequired` compliant units in one of them. */
  equipmentClasses: string[];
  /** Jurisdiction the carrier credentials are read in, e.g. CA-AB. Informational on the picture. */
  jurisdiction: string | null;
  /** Client-stated requirements no registry can check. Listed on the picture, never evaluated. */
  clientSpecific: string[];
};

export const EMPTY_TENDER_REQUIREMENTS: TenderRequirements = {
  workerQualificationCodes: [],
  organizationDocTypes: [],
  tdgRequired: false,
  insurance: null,
  equipmentClasses: [],
  jurisdiction: null,
  clientSpecific: [],
};

/**
 * Reads a posting's stored requirements. Checkpoint 1 stored `certifications`, `permits`,
 * `dangerousGoods`, `insuranceLiabilityMinimumCents` and `equipmentTypes`; those map onto the
 * typed shape here so a posting written before 0192 is evaluated, not ignored.
 */
export function normalizeTenderRequirements(raw: unknown): TenderRequirements {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map(x => x.trim()) : []);
  const legacyDg = strings(r.dangerousGoods);
  const legacyInsurance = typeof r.insuranceLiabilityMinimumCents === "number" ? r.insuranceLiabilityMinimumCents : null;
  const ins = r.insurance && typeof r.insurance === "object" ? (r.insurance as Record<string, unknown>) : null;
  const codes = new Set([...strings(r.workerQualificationCodes), ...strings(r.certifications)].map(c => c.toUpperCase()));
  const tdgRequired = r.tdgRequired === true || legacyDg.length > 0;
  if (tdgRequired) codes.add(TDG_QUALIFICATION_CODE);
  return {
    workerQualificationCodes: Array.from(codes).sort(),
    organizationDocTypes: Array.from(new Set([...strings(r.organizationDocTypes), ...strings(r.permits)].map(d => d.toLowerCase()))).sort(),
    tdgRequired,
    insurance: ins
      ? {
          coverageType: typeof ins.coverageType === "string" && ins.coverageType ? ins.coverageType : DEFAULT_LIABILITY_COVERAGE_TYPE,
          minimumLimitCents: typeof ins.minimumLimitCents === "number" ? ins.minimumLimitCents : null,
          additionalInsuredRequired: ins.additionalInsuredRequired === true,
        }
      : legacyInsurance != null
        ? { coverageType: DEFAULT_LIABILITY_COVERAGE_TYPE, minimumLimitCents: legacyInsurance, additionalInsuredRequired: false }
        : null,
    equipmentClasses: Array.from(new Set([...strings(r.equipmentClasses), ...strings(r.equipmentTypes)].map(e => e.toUpperCase()))).sort(),
    jurisdiction: typeof r.jurisdiction === "string" && r.jurisdiction.trim() ? r.jurisdiction.trim() : null,
    clientSpecific: strings(r.clientSpecific),
  };
}

/* ===================== facts ===================== */

/** A unit as the registry holds it; only the fields that decide anything. */
export type UnitFact = { unitId: number; vehicleType: string; inspectionStatus: "current" | "due" | "blocked"; maintenanceStatus: "clear" | "review" | "blocked" };

/** One worker's holdings, from both canonical sources, already converted to the Academy engine's shape. */
export type WorkerFact = { userId: number; holdings: QualificationHolding[] };

/**
 * `submission`: may a bid be submitted now — the bidding window is a question. `standing`: is the
 * organization still eligible on the facts — asked at award and on every later read, when the
 * window has closed by design and is not a mark against the bidder.
 */
export type ReadinessStage = "submission" | "standing";

export type MarketplaceReadinessFacts = {
  stage: ReadinessStage;
  bidderOrgRef: string;
  clientOrgRef: string;
  organizationStatus: "active" | "suspended" | "closed" | "missing";
  contractorProfileStatus: "active" | "suspended" | "closed" | "none";
  distribution: PostingDistribution;
  invited: boolean;
  window: BiddingWindow;
  unitsRequired: number | null;
  /** What the bid offers; null when evaluating the organization alone (a preview with no draft). */
  unitsOffered: number | null;
  requirements: TenderRequirements;
  /** The organization's financial entities — the carrier subjects. Empty = no carrier identity on record. */
  financialEntityIds: number[];
  carrierDocuments: ComplianceDocumentRow[];
  policies: PolicyRecord[];
  units: UnitFact[];
  workers: WorkerFact[];
  /** Workers the organization lists who are not linked to a user, so their holdings cannot be read. */
  unlinkedWorkers: number;
  activeCarrierOutOfServiceOrders: number;
};

/* ===================== the picture ===================== */

export type ReadinessCheckResult = "PASS" | "WARN" | "BLOCK" | "UNKNOWN";

export type MarketplaceReadinessCheck = {
  check: string;
  result: ReadinessCheckResult;
  /** Whether this row stops submission. Every BLOCK does; an UNKNOWN does when the requirement is hard. */
  blocking: boolean;
  /** Explainable, and free of names and identifiers: counts, document types, expiry words. */
  detail: string;
};

export type MarketplaceReadinessVerdict = "submittable" | "blocked";

export type MarketplaceReadiness = {
  verdict: MarketplaceReadinessVerdict;
  checks: MarketplaceReadinessCheck[];
  blockers: MarketplaceReadinessCheck[];
  warnings: MarketplaceReadinessCheck[];
  /** What this picture deliberately does not decide, and who does. */
  notEvaluated: { capability: string; decidedBy: string }[];
  basis: "canonical_registries";
  evaluatedAt: Date;
  /** `MR-` + SHA-256 over the facts (with every governing expiry's lapsed/not-lapsed state at this instant). */
  dependencyFingerprint: string;
};

/** The dispatch gate's questions, named here so nobody mistakes their absence for a pass. */
export const NOT_EVALUATED_BY_MARKETPLACE: readonly { capability: string; decidedBy: string }[] = [
  { capability: "hos", decidedBy: "dispatch gate at assignment" },
  { capability: "driver_availability", decidedBy: "dispatch gate at assignment" },
  { capability: "operator_qualification_for_assignment", decidedBy: "dispatch gate at assignment" },
  { capability: "unit_inspection_at_dispatch", decidedBy: "dispatch gate at assignment" },
  { capability: "route_restrictions", decidedBy: "dispatch gate at assignment" },
];

export const FINGERPRINT_PREFIX = "MR-";

/**
 * The fingerprint's facts: everything the verdict read, with the evaluation instant folded in only
 * as whether each governing expiry had passed — the dispatch award's `expiryStateVersion` idea. A
 * certificate lapsing between two evaluations changes the fingerprint; the clock ticking does not.
 */
export function readinessFingerprint(f: MarketplaceReadinessFacts, now: Date): string {
  const lapsed = (d: Date | null | undefined) => (d ? d.getTime() <= now.getTime() : null);
  const facts = {
    bidderOrgRef: f.bidderOrgRef,
    clientOrgRef: f.clientOrgRef,
    organizationStatus: f.organizationStatus,
    contractorProfileStatus: f.contractorProfileStatus,
    distribution: f.distribution,
    invited: f.invited,
    // Not the window and not the stage: the fingerprint says whether the ORGANIZATION's facts moved,
    // and must read the same at submission and at award for the same facts.
    unitsRequired: f.unitsRequired,
    unitsOffered: f.unitsOffered,
    requirements: f.requirements,
    financialEntityIds: [...f.financialEntityIds].sort(),
    carrierDocuments: f.carrierDocuments.map(d => [d.id, d.docType, d.verificationStatus, d.expiresAt?.toISOString() ?? null, lapsed(d.expiresAt)]).sort(),
    policies: f.policies.map(p => [p.policyRef, p.status, p.coverageVerificationStatus, p.expiresAt.toISOString(), lapsed(p.expiresAt), p.coverages.map(c => [c.coverageType, c.limitAmount, c.additionalInsuredEndorsement]).sort(), p.document ? [p.document.verificationStatus, p.document.expiresAt?.toISOString() ?? null, lapsed(p.document.expiresAt)] : null]).sort(),
    units: f.units.map(u => [u.unitId, u.vehicleType, u.inspectionStatus, u.maintenanceStatus]).sort(),
    workers: f.workers.map(w => [w.userId, w.holdings.map(h => [h.holdingRef, h.code, h.verificationState, h.expiresAt?.toISOString() ?? null, lapsed(h.expiresAt)]).sort()]).sort(),
    unlinkedWorkers: f.unlinkedWorkers,
    activeCarrierOutOfServiceOrders: f.activeCarrierOutOfServiceOrders,
  };
  return `${FINGERPRINT_PREFIX}${sha256(canonicalJson(facts))}`;
}

const norm = (s: string) => s.trim().toUpperCase();

export function evaluateMarketplaceReadiness(f: MarketplaceReadinessFacts, now: Date): MarketplaceReadiness {
  const checks: MarketplaceReadinessCheck[] = [];
  const row = (check: string, result: ReadinessCheckResult, detail: string, hard = true) =>
    checks.push({ check, result, blocking: result === "BLOCK" || (result === "UNKNOWN" && hard), detail });
  const req = f.requirements;
  const needed = Math.max(1, f.unitsRequired ?? 1);

  /* ---- who is bidding ---- */
  if (f.bidderOrgRef === f.clientOrgRef) row("counterparty", "BLOCK", "An organization cannot bid on its own posting.");
  else row("counterparty", "PASS", "Bidder and client are different organizations.");

  if (f.organizationStatus === "active") row("organization", "PASS", "Bidding organization is active.");
  else if (f.organizationStatus === "missing") row("organization", "BLOCK", "Bidding organization does not exist.");
  else row("organization", "BLOCK", `Bidding organization is ${f.organizationStatus}.`);

  if (f.contractorProfileStatus === "active") row("contractor_profile", "PASS", "Contractor business profile is active.");
  else if (f.contractorProfileStatus === "none") row("contractor_profile", "WARN", "No contractor business profile on record; the client sees an unprofiled bidder.");
  else row("contractor_profile", "BLOCK", `Contractor business profile is ${f.contractorProfileStatus}.`);

  if (f.distribution === "invite_only") row("invitation", f.invited ? "PASS" : "BLOCK", f.invited ? "Invited to this tender." : "Invite-only tender; this organization was not invited.");
  else row("invitation", "PASS", "Public posting; no invitation needed.");

  if (f.stage === "submission") {
    if (f.window.open) row("bidding_window", "PASS", f.window.closesAt ? `Bidding open; closes ${f.window.closesAt.toISOString()}.` : "Bidding open; no deadline set.");
    else row("bidding_window", "BLOCK", `Bidding is not open (${f.window.reason}).`);
  }

  if (f.activeCarrierOutOfServiceOrders > 0) row("carrier_enforcement", "BLOCK", `${f.activeCarrierOutOfServiceOrders} active carrier-scope out-of-service order(s).`);
  else row("carrier_enforcement", "PASS", "No active carrier-scope out-of-service order.");

  /* ---- organization-level credentials, from the compliance registry ---- */
  if (req.organizationDocTypes.length) {
    if (f.financialEntityIds.length === 0) {
      row("organization_documents", "UNKNOWN", `${req.organizationDocTypes.length} organization document type(s) required, but the organization has no financial entity on record, so its carrier credentials cannot be located.`);
    } else {
      for (const docType of req.organizationDocTypes) {
        const v = complianceDocumentValidity(f.carrierDocuments, docType, now);
        const check = `organization_document:${docType}`;
        switch (v.state) {
          case "in_force": row(check, "PASS", `${docType} verified and in force${v.expiresAt ? `; expires ${v.expiresAt.toISOString().slice(0, 10)}` : ""}.`); break;
          case "expiring": row(check, "WARN", `${docType} verified; ${v.daysRemaining} day(s) to expiry.`); break;
          case "expired": row(check, "BLOCK", `${docType} expired.`); break;
          case "rejected": row(check, "BLOCK", `${docType} was reviewed and rejected.`); break;
          case "unverified": row(check, "UNKNOWN", `${docType} is on file but not verified; unknown is not satisfied.`); break;
          case "none": row(check, "BLOCK", `${docType} not on record for this organization.`); break;
        }
      }
    }
  } else row("organization_documents", "PASS", "No organization-level documents required.");

  /* ---- insurance, by the insurance engine's rule ---- */
  if (req.insurance) {
    const ins = req.insurance;
    if (f.financialEntityIds.length === 0) {
      row("insurance", "UNKNOWN", `${ins.coverageType} cover required, but the organization has no financial entity on record, so its policies cannot be located.`);
    } else {
      const m = matchCustomerRequirements({
        requirements: [{ coverageType: ins.coverageType, minimumLimit: ins.minimumLimitCents == null ? null : ins.minimumLimitCents / 100, additionalInsuredRequired: ins.additionalInsuredRequired }],
        policies: f.policies,
        now,
      }).matches[0]!;
      if (m.outcome === "match") row("insurance", "PASS", m.reason);
      else if (m.outcome === "gap") row("insurance", "BLOCK", m.reason);
      else row("insurance", "UNKNOWN", `${m.reason}; unknown is not satisfied.`);
    }
  } else row("insurance", "PASS", "No insurance minimum stated.");

  /* ---- equipment: owned units in a required class, inspection current, maintenance clear ---- */
  if (req.equipmentClasses.length) {
    const classes = new Set(req.equipmentClasses.map(norm));
    const inClass = f.units.filter(u => classes.has(norm(u.vehicleType)));
    const compliant = inClass.filter(u => u.inspectionStatus === "current" && u.maintenanceStatus === "clear");
    const held = inClass.length - compliant.length;
    const classesText = req.equipmentClasses.join(", ");
    if (inClass.length === 0) row("equipment", "BLOCK", `No owned unit of class ${classesText} on record (${f.units.length} unit(s) owned).`);
    else if (compliant.length === 0) row("equipment", "BLOCK", `${inClass.length} unit(s) of class ${classesText} owned, none with inspection current and maintenance clear.`);
    else if (compliant.length < needed) row("equipment", "WARN", `${compliant.length} of ${needed} required compliant unit(s) of class ${classesText}${held ? ` (${held} more held back by inspection or maintenance)` : ""}.`);
    else row("equipment", "PASS", `${compliant.length} compliant unit(s) of class ${classesText} for ${needed} required${held ? ` (${held} more held back by inspection or maintenance)` : ""}.`);
  } else row("equipment", "PASS", "No equipment class required.");

  /* ---- worker qualifications, by the Academy's rule; counts, never names ---- */
  if (req.workerQualificationCodes.length) {
    const codes = req.workerQualificationCodes;
    if (f.workers.length === 0) {
      row("worker_qualifications", "UNKNOWN", `${codes.join(", ")} required of workers, but the organization has no worker linked to a user, so no holding can be read${f.unlinkedWorkers ? ` (${f.unlinkedWorkers} unlinked worker(s))` : ""}.`);
    } else {
      const perCode = codes.map(code => ({ code, holders: f.workers.filter(w => countsAsHeld(w.holdings, code, now).held).length }));
      const holdAll = f.workers.filter(w => codes.every(code => countsAsHeld(w.holdings, code, now).held)).length;
      const summary = perCode.map(p => `${p.code}: ${p.holders}/${f.workers.length}`).join(", ");
      if (holdAll === 0) row("worker_qualifications", "BLOCK", `No worker holds every required qualification (${summary}); held means verified, unexpired, with an establishable expiry.`);
      else if (holdAll < needed) row("worker_qualifications", "WARN", `${holdAll} of ${needed} required worker(s) hold every required qualification (${summary}).`);
      else row("worker_qualifications", "PASS", `${holdAll} worker(s) hold every required qualification for ${needed} required (${summary}).`);
      if (f.unlinkedWorkers) row("worker_qualifications:unlinked", "WARN", `${f.unlinkedWorkers} worker(s) are not linked to a user; their holdings were not read.`, false);
    }
    if (req.tdgRequired) {
      const tdgHolders = f.workers.filter(w => countsAsHeld(w.holdings, TDG_QUALIFICATION_CODE, now).held).length;
      row("dangerous_goods", tdgHolders > 0 ? "PASS" : f.workers.length === 0 ? "UNKNOWN" : "BLOCK", tdgHolders > 0 ? `${tdgHolders} worker(s) hold ${TDG_QUALIFICATION_CODE}.` : `Dangerous goods on this haul and no worker holds ${TDG_QUALIFICATION_CODE}.`);
    }
  } else row("worker_qualifications", "PASS", "No worker qualification required.");

  /* ---- what the bid itself offers ---- */
  if (f.unitsOffered != null) {
    if (f.unitsRequired == null) row("units_offered", "PASS", `${f.unitsOffered} unit(s) offered; posting states no requirement.`);
    else if (f.unitsOffered >= f.unitsRequired) row("units_offered", "PASS", `${f.unitsOffered} of ${f.unitsRequired} required unit(s) offered.`);
    else row("units_offered", "WARN", `${f.unitsOffered} of ${f.unitsRequired} required unit(s) offered — a partial-capacity bid; the client decides.`);
  }

  for (const c of req.clientSpecific) row(`client_requirement:${c.slice(0, 60)}`, "UNKNOWN", "Stated by the client; not machine-checkable. The client judges it from the bid.", false);

  const blockers = checks.filter(c => c.blocking);
  const warnings = checks.filter(c => c.result === "WARN");
  return {
    verdict: blockers.length ? "blocked" : "submittable",
    checks, blockers, warnings,
    notEvaluated: [...NOT_EVALUATED_BY_MARKETPLACE],
    basis: "canonical_registries",
    evaluatedAt: now,
    dependencyFingerprint: readinessFingerprint(f, now),
  };
}

/* ===================== projections ===================== */

export type ClientEligibility = "eligible" | "eligible_with_warnings" | "not_currently_eligible";

/**
 * What the CLIENT may see of another organization's readiness: the verdict in the client's words,
 * each check's name and result, and the counts. No detail strings — those are the bidder's — and
 * nothing a registry would call private. The client judges eligibility; it does not audit the
 * bidder's HR file.
 */
export function clientReadinessProjection(r: MarketplaceReadiness): {
  eligibility: ClientEligibility;
  checks: { check: string; result: ReadinessCheckResult }[];
  blockerCount: number;
  warningCount: number;
  evaluatedAt: Date;
  dependencyFingerprint: string;
} {
  return {
    eligibility: r.verdict === "blocked" ? "not_currently_eligible" : r.warnings.length ? "eligible_with_warnings" : "eligible",
    checks: r.checks.map(c => ({ check: c.check, result: c.result })),
    blockerCount: r.blockers.length,
    warningCount: r.warnings.length,
    evaluatedAt: r.evaluatedAt,
    dependencyFingerprint: r.dependencyFingerprint,
  };
}
