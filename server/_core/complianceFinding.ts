/**
 * C1a — the typed compliance contribution the dispatch readiness composer speaks.
 *
 * Not a second composer and not a new engine. Every engine the composer already calls keeps
 * producing `DispatchBlocker`s exactly as before; this module is the one place that says, for each
 * of them, what KIND of finding it is:
 *
 *   result          SATISFIED | UNSATISFIED | UNKNOWN | NOT_APPLICABLE   — what is true
 *   dispatchEffect  BLOCK | WARN | INFORMATIONAL | NONE                  — what dispatch does about it
 *   overrideClass   NEVER_OVERRIDABLE | APPROVED_POLICY_ONLY | WARNING_ONLY | INFORMATIONAL
 *   authorityClass  where the obligation comes from (statute … best practice)
 *
 * Three things are kept apart on purpose. A legal requirement and a company warning are not the same
 * thing; an unknown is not a failure and is not a pass; and whether something may be overridden is a
 * property of the obligation, not of who happens to be asking.
 *
 * Owner decision D-02 (2026-09-23) is encoded in `CLASSIFICATION` below: an UNKNOWN about anything
 * that could make the trip legally or operationally unauthorized BLOCKS, per finding — there is no
 * global "every unknown blocks" rule, and administrative unknowns still WARN.
 *
 * The classification can only TIGHTEN what the producing engine said. A producer that called its
 * blocker non-overridable, or blocking, is never made overridable or softer here
 * (`classifyBlocker` enforces it; `complianceFinding.test.ts` pins it).
 */

import type { BlockerSeverity, DispatchBlocker } from "./dispatchReadiness";

export type ComplianceResult = "SATISFIED" | "UNSATISFIED" | "UNKNOWN" | "NOT_APPLICABLE";
export type DispatchEffect = "BLOCK" | "WARN" | "INFORMATIONAL" | "NONE";
export type OverrideClass = "NEVER_OVERRIDABLE" | "APPROVED_POLICY_ONLY" | "WARNING_ONLY" | "INFORMATIONAL";
/** The authority ladder from the design (§4). A lower authority never weakens a higher one. */
export type AuthorityClass =
  | "statute_regulation"
  | "regulator_order"
  | "government_permit_exemption"
  | "carrier_safety_policy"
  | "client_contract"
  | "work_site"
  | "company_policy"
  | "best_practice";
export type FindingDomain =
  | "enforcement" | "driver_licence" | "driver_qualification" | "medical" | "hos" | "availability"
  | "vehicle_inspection" | "vehicle_registration" | "insurance" | "defect" | "maintenance" | "trailer"
  | "telematics" | "calibration" | "device" | "load_classification" | "dangerous_goods" | "documents"
  | "permit" | "destination" | "route" | "communications" | "capability" | "unclassified";

/** Bumped whenever CLASSIFICATION changes meaning. Part of the rule-set hash, so a change stales every check. */
export const CLASSIFICATION_VERSION = "c1a.3";

/**
 * A readiness finding. It IS a `DispatchBlocker` — every existing consumer (the checklist, the
 * portal projection, the dispatcher panel, stored `blockersJson`) keeps reading the fields it always
 * read. The additions say what the blocker means.
 */
export type ComplianceFinding = DispatchBlocker & {
  domain: FindingDomain;
  result: ComplianceResult;
  dispatchEffect: DispatchEffect;
  overrideClass: OverrideClass;
  authorityClass: AuthorityClass;
  /** Which classification rule decided the above — the "applicable rule version" for this finding. */
  ruleRef: { key: string; version: string };
  /** Refs of the records actually evaluated, when the producer named them. Merged across duplicates. */
  evidenceRefs: string[];
  /** ISO timestamp of the evaluation this finding belongs to. */
  evaluatedAt: string;
};

/* ------------------------------------------------------------------ */
/* Classification (D-02)                                               */
/* ------------------------------------------------------------------ */

type Rule = {
  key: string;
  match: RegExp;
  domain: FindingDomain;
  authorityClass: AuthorityClass;
  result: ComplianceResult;
  dispatchEffect: DispatchEffect;
  overrideClass: OverrideClass;
};

const r = (key: string, match: RegExp, domain: FindingDomain, authorityClass: AuthorityClass,
  result: ComplianceResult, dispatchEffect: DispatchEffect, overrideClass: OverrideClass): Rule =>
  ({ key, match, domain, authorityClass, result, dispatchEffect, overrideClass });

/** Shorthands. */
const HARD = ["UNSATISFIED", "BLOCK", "NEVER_OVERRIDABLE"] as const;
/** D-02: a safety/regulatory UNKNOWN blocks; only an owner-approved policy may ever release it. */
const UNKNOWN_BLOCKS = ["UNKNOWN", "BLOCK", "APPROVED_POLICY_ONLY"] as const;
const UNKNOWN_NEVER = ["UNKNOWN", "BLOCK", "NEVER_OVERRIDABLE"] as const;
const WARN_ACK = ["UNSATISFIED", "WARN", "WARNING_ONLY"] as const;

/**
 * Ordered: the first rule whose pattern matches the code wins. Codes are the producers' own and are
 * stable (P0.6), which is why classification keys on them.
 */
export const CLASSIFICATION: readonly Rule[] = [
  /* enforcement — an inspector's order is not a company rule */
  r("enforcement.oos", /^oos\./, "enforcement", "regulator_order", ...HARD),
  r("enforcement.unknown", /^enforcement_result_unknown$/, "enforcement", "regulator_order", ...UNKNOWN_NEVER),
  r("capability.enforcement_unevaluated", /^capability_not_evaluated_enforcement_orders$/, "capability", "regulator_order", ...UNKNOWN_NEVER),
  r("vehicle.roadside_open", /^roadside_event_open$/, "defect", "carrier_safety_policy", ...HARD),

  /* driver: legal authorization and required qualifications */
  r("driver.licence.unsatisfied", /^operator_licence_(missing|expired)$/, "driver_licence", "statute_regulation", ...HARD),
  r("driver.licence.unknown", /^operator_licence_unknown$/, "driver_licence", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("driver.credential.unsatisfied", /^operator_.+_(missing|expired)$/, "driver_qualification", "statute_regulation", ...HARD),
  r("driver.credential.unknown", /^operator_.+_unknown$/, "driver_qualification", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("driver.medical.unsatisfied", /^medical_fitness_not_current$/, "medical", "statute_regulation", ...HARD),
  r("driver.medical.unknown", /^medical_fitness_unknown$/, "medical", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("driver.academy.unlinked", /^academy_operator_unlinked$/, "driver_qualification", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("driver.academy.conditions", /^academy_binding_conditions_unknown$/, "driver_qualification", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("driver.academy.review", /^academy_review_/, "driver_qualification", "carrier_safety_policy", ...WARN_ACK),
  r("driver.academy.unsatisfied", /^academy_/, "driver_qualification", "carrier_safety_policy", ...HARD),
  /* Driver Portfolio requirement bindings (0202): company, client, site, job-type, equipment and job
   * requirements. Only mandatory bindings produce these codes; informational ones produce none. */
  r("driver.portfolio.unlinked", /^portfolio_operator_unlinked$/, "driver_qualification", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("driver.portfolio.unknown", /^driver_(credential|licence_class|equipment)_.+_(unverified|no_expiry_recorded|class_unknown|unknown_requirement)$/, "driver_qualification", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("driver.portfolio.unsatisfied", /^driver_(credential|licence_class|equipment)_/, "driver_qualification", "carrier_safety_policy", ...HARD),

  /* hours of service */
  r("hos.insufficient", /^hos_insufficient$/, "hos", "statute_regulation", ...HARD),
  r("hos.unknown", /^hos_unknown$/, "hos", "statute_regulation", ...UNKNOWN_BLOCKS),
  // P8.3: a named person reviewed the paper log for today. The check is satisfied by a person's word
  // — the record says whose — and dispatch acknowledges it rather than treating it as computed.
  r("hos.attested", /^hos_attested$/, "hos", "statute_regulation", "SATISFIED", "WARN", "WARNING_ONLY"),
  r("driver.availability", /^availability_not_declared$/, "availability", "company_policy", ...WARN_ACK),
  r("driver.device", /^field_device_revoked$/, "device", "company_policy", ...WARN_ACK),

  /* vehicle and trailer */
  r("vehicle.inspection.unsatisfied", /^(truck|trailer)_inspection_(missing|expired)$/, "vehicle_inspection", "statute_regulation", ...HARD),
  r("vehicle.inspection.unknown", /^(truck|trailer)_inspection_unknown$/, "vehicle_inspection", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("vehicle.registration.unsatisfied", /^(truck|trailer)_registration_(missing|expired)$/, "vehicle_registration", "statute_regulation", ...HARD),
  r("vehicle.registration.unknown", /^(truck|trailer)_registration_unknown$/, "vehicle_registration", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("insurance.unsatisfied", /^(truck|trailer)_insurance_(missing|expired)$|^insurance_coverage_expired$/, "insurance", "statute_regulation", ...HARD),
  r("insurance.unknown", /^(truck|trailer)_insurance_unknown$/, "insurance", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("insurance.none_on_record", /^insurance_coverage_unknown$/, "insurance", "statute_regulation", ...UNKNOWN_NEVER),
  // Reported by the insured, not verified: legally required insurance whose coverage is not established.
  r("insurance.unverified", /^insurance_coverage_unverified$/, "insurance", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("insurance.proof", /^insurance_proof_missing$/, "insurance", "statute_regulation", ...WARN_ACK),
  r("defect.critical", /^(critical_defect|mechanic_release_missing)$/, "defect", "carrier_safety_policy", ...HARD),
  r("maintenance.overdue", /^(trailer_)?maintenance_overdue$/, "maintenance", "carrier_safety_policy", ...WARN_ACK),
  r("trailer.incompatible", /^trailer_incompatible$/, "trailer", "carrier_safety_policy", ...HARD),
  r("trailer.compatibility.unknown", /^trailer_compatibility_unknown$/, "trailer", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("telematics.critical", /^fault_.+_critical$/, "telematics", "carrier_safety_policy", ...HARD),
  r("telematics.inspection", /^fault_.+_inspection$/, "telematics", "carrier_safety_policy", ...WARN_ACK),
  // A fault whose severity nobody has determined is an unresolved possible safety defect.
  r("telematics.undetermined", /^fault_.+_active$/, "telematics", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("calibration.dispatch", /^measurement_device_uncalibrated$/, "calibration", "company_policy", ...WARN_ACK),

  /* load and dangerous goods — structured authority only (C1a-7) */
  r("load.classification_incomplete", /^classification_incomplete$/, "load_classification", "carrier_safety_policy", ...HARD),
  r("dg.classification_blocked", /^dg_classification_blocked$/, "dangerous_goods", "statute_regulation", ...HARD),
  r("dg.classification_unknown", /^dg_classification_(unverified|missing)$/, "dangerous_goods", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("dg.document.missing", /^(tdg_document_missing|erp_missing)$/, "dangerous_goods", "statute_regulation", ...HARD),
  r("dg.document.unknown", /^tdg_document_unknown$/, "dangerous_goods", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("documents.job", /^documents_missing$/, "documents", "company_policy", ...WARN_ACK),
  r("permit.missing", /^permit_missing$/, "permit", "statute_regulation", ...HARD),
  r("permit.unknown", /^permit_unknown$/, "permit", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("destination.refused", /^destination_not_accepting$/, "destination", "work_site", ...HARD),
  r("destination.unverified", /^destination_acceptance_unverified$/, "destination", "work_site", ...WARN_ACK),

  /* route legality */
  r("route.blocked", /^route_blocked$/, "route", "statute_regulation", ...HARD),
  r("route.unknown", /^(route_not_evaluated|route_approval_missing|route_data_unverified)$/, "route", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("route.approval_not_current", /^route_approval_(stale|revoked|superseded)$/, "route", "statute_regulation", ...UNKNOWN_BLOCKS),
  r("route.review", /^route_review$/, "route", "statute_regulation", ...WARN_ACK),

  /* communications — the company's own policy, except radio licensing, which is law */
  r("comms.radio_unlicensed", /^radio_not_authorized$/, "communications", "statute_regulation", ...HARD),
  r("comms.radio_unknown", /^radio_authorization_unknown$/, "communications", "statute_regulation", ...UNKNOWN_BLOCKS),
  // The company's communication policy decides these (its own `unknownPlanBlocks` turns the plan
  // unknown into a blocker at source); absent that, an incomplete plan is administrative and warns.
  // A lone worker beyond cellular with no recorded satellite device is a SAFETY unknown, and must not
  // be easier to release than the confirmed-absent case below (review finding on C1a).
  r("comms.lone_worker_unknown", /^lone_worker_satellite_unknown$/, "communications", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
  r("comms.plan_unknown", /^(communication_plan_unknown|communication_plan_unmeasured_segments|communication_geometry_missing)$/, "communications", "company_policy", "UNKNOWN", "WARN", "WARNING_ONLY"),
  r("comms.policy_breach", /^(communication_gap_exceeds_policy|lone_worker_no_satellite)$/, "communications", "company_policy", "UNSATISFIED", "BLOCK", "APPROVED_POLICY_ONLY"),
  r("comms.satellite_present", /^lone_worker_satellite_present$/, "communications", "company_policy", ...WARN_ACK),

  /* a required capability that was never asked */
  r("capability.unevaluated", /^capability_not_evaluated_/, "capability", "carrier_safety_policy", ...UNKNOWN_BLOCKS),
];

const SEVERITY_RANK: Record<BlockerSeverity, number> = { review: 0, unknown: 1, blocking: 2 };
const EFFECT_RANK: Record<DispatchEffect, number> = { NONE: 0, INFORMATIONAL: 1, WARN: 2, BLOCK: 3 };
const OVERRIDE_RANK: Record<OverrideClass, number> = { INFORMATIONAL: 0, WARNING_ONLY: 1, APPROVED_POLICY_ONLY: 2, NEVER_OVERRIDABLE: 3 };
const RESULT_RANK: Record<ComplianceResult, number> = { NOT_APPLICABLE: 0, SATISFIED: 1, UNKNOWN: 2, UNSATISFIED: 3 };

function severityFor(result: ComplianceResult, effect: DispatchEffect): BlockerSeverity {
  if (result === "UNKNOWN") return "unknown";
  return effect === "BLOCK" ? "blocking" : "review";
}

/** A producer's claim, read in the finding vocabulary. Used for codes no rule names. */
function fromProducer(b: DispatchBlocker): Omit<Rule, "key" | "match"> {
  const effect: DispatchEffect = b.severity === "review" ? "WARN" : "BLOCK";
  return {
    domain: "unclassified",
    authorityClass: "company_policy",
    result: b.severity === "unknown" ? "UNKNOWN" : "UNSATISFIED",
    dispatchEffect: effect,
    // Fail closed: an unregistered unknown or blocker is not warning-grade just because nobody classified it.
    overrideClass: !b.overridable ? "NEVER_OVERRIDABLE" : effect === "WARN" ? "WARNING_ONLY" : "APPROVED_POLICY_ONLY",
  };
}

/**
 * Classify one producer blocker. Monotonic: the result is never softer than the producer said.
 *   - severity is the stronger of the producer's and the classification's;
 *   - a non-overridable producer blocker stays NEVER_OVERRIDABLE;
 *   - a blocking producer blocker cannot become a WARN.
 */
export function classifyBlocker(b: DispatchBlocker, evaluatedAt: Date | string): ComplianceFinding {
  const existing = b as Partial<ComplianceFinding>;
  const rule = CLASSIFICATION.find(x => x.match.test(b.code));
  const base = rule ?? fromProducer(b);
  let dispatchEffect = base.dispatchEffect;
  // A producer that said "blocking" never becomes softer than BLOCK here.
  if (b.severity === "blocking") dispatchEffect = "BLOCK";
  let overrideClass = base.overrideClass;
  if (!b.overridable && OVERRIDE_RANK[overrideClass] < OVERRIDE_RANK.NEVER_OVERRIDABLE) overrideClass = "NEVER_OVERRIDABLE";
  // BLOCK can never be released by a warning acknowledgement.
  if (dispatchEffect === "BLOCK" && OVERRIDE_RANK[overrideClass] < OVERRIDE_RANK.APPROVED_POLICY_ONLY) overrideClass = "APPROVED_POLICY_ONLY";
  const derived = severityFor(base.result, dispatchEffect);
  const severity = SEVERITY_RANK[b.severity] >= SEVERITY_RANK[derived] ? b.severity : derived;
  const overridable = overrideClass === "APPROVED_POLICY_ONLY" || overrideClass === "WARNING_ONLY";
  return {
    code: b.code,
    label: b.label,
    severity,
    subject: b.subject,
    overridable,
    ...(overridable && overrideClass === "WARNING_ONLY" ? { overrideAuthority: b.overrideAuthority ?? "manager" } : {}),
    domain: base.domain,
    result: base.result,
    dispatchEffect,
    overrideClass,
    authorityClass: base.authorityClass,
    ruleRef: { key: rule?.key ?? "unregistered", version: CLASSIFICATION_VERSION },
    evidenceRefs: Array.isArray(existing.evidenceRefs) ? [...existing.evidenceRefs] : [],
    evaluatedAt: typeof evaluatedAt === "string" ? evaluatedAt : evaluatedAt.toISOString(),
  };
}

/** Anything read back from storage (a pre-C1a check included) is re-read as a finding. */
export function asFinding(b: DispatchBlocker, evaluatedAt: Date | string): ComplianceFinding {
  return classifyBlocker(b, evaluatedAt);
}

/* ------------------------------------------------------------------ */
/* Strictest duplicate wins (C1a-4)                                    */
/* ------------------------------------------------------------------ */

const AUTHORITY_RANK: Record<NonNullable<DispatchBlocker["overrideAuthority"]>, number> = { dispatcher: 1, manager: 2, administrator: 3 };
const SUBJECT_ORDER: DispatchBlocker["subject"][] = ["operator", "truck", "trailer", "job", "route"];

/**
 * Total order on how strongly a finding constrains dispatch. Higher = stricter. The authority an
 * acknowledgement needs is part of it: a duplicate that needs a manager outranks one a dispatcher
 * could acknowledge, whichever arrived first.
 */
function strictness(f: ComplianceFinding): number[] {
  return [EFFECT_RANK[f.dispatchEffect], OVERRIDE_RANK[f.overrideClass], SEVERITY_RANK[f.severity], RESULT_RANK[f.result],
    f.overrideAuthority ? AUTHORITY_RANK[f.overrideAuthority] : 0];
}
function compareStrictness(a: ComplianceFinding, b: ComplianceFinding): number {
  const sa = strictness(a), sb = strictness(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
  // Fully deterministic tie-break on everything left, so merge(A,B) and merge(B,A) keep the same finding.
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return SUBJECT_ORDER.indexOf(a.subject) - SUBJECT_ORDER.indexOf(b.subject);
}

/**
 * One finding per code, the strictest of any duplicates, with the evidence of all of them.
 * Order-independent in outcome: the finding kept for a code does not depend on which arrived first.
 * The list keeps first-seen code order so existing readers see a stable sequence.
 */
export function mergeFindings(findings: readonly ComplianceFinding[]): ComplianceFinding[] {
  const order: string[] = [];
  const byCode = new Map<string, ComplianceFinding>();
  for (const f of findings) {
    const prior = byCode.get(f.code);
    if (!prior) { order.push(f.code); byCode.set(f.code, f); continue; }
    const winner = compareStrictness(f, prior) > 0 ? f : prior;
    const evidence = Array.from(new Set([...prior.evidenceRefs, ...f.evidenceRefs])).sort();
    byCode.set(f.code, { ...winner, evidenceRefs: evidence });
  }
  return order.map(c => byCode.get(c)!);
}

/* ------------------------------------------------------------------ */
/* Approved override policies (C1a-2)                                  */
/* ------------------------------------------------------------------ */

/**
 * An owner-approved policy that permits a named person to take responsibility for a specific
 * APPROVED_POLICY_ONLY finding. This is the only way such a finding is ever released without
 * establishing the fact — there is no general "manager may override" rule.
 *
 * Deliberately EMPTY at C1a. Owner decision D-02 says safety/regulatory unknowns block; no policy
 * has been approved that says otherwise, so none is encoded. Adding one is a reviewed code change
 * naming two distinct approvers, like `SAFETY_CEILINGS`.
 */
export type OverridePolicy = {
  policyRef: string;
  version: number;
  /** Finding codes (exact) this policy may release. Never a NEVER_OVERRIDABLE code. */
  findingCodes: readonly string[];
  grantorMinimumRole: "manager" | "administrator";
  /** How long a grant under this policy lasts. */
  maxValidityMinutes: number;
  approvedBy: readonly [string, string];
  approvedAt: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  rationale: string;
};

export const APPROVED_OVERRIDE_POLICIES: readonly OverridePolicy[] = [];

export type PolicyResolution = { ok: true; policy: OverridePolicy } | { ok: false; refusal: string };

export function resolveOverridePolicy(
  policyRef: string | null | undefined,
  finding: Pick<ComplianceFinding, "code" | "overrideClass">,
  at: Date,
  registry: readonly OverridePolicy[] = APPROVED_OVERRIDE_POLICIES,
): PolicyResolution {
  if (finding.overrideClass !== "APPROVED_POLICY_ONLY") return { ok: false, refusal: `${finding.code} is ${finding.overrideClass}; a policy cannot release it` };
  if (!policyRef) return { ok: false, refusal: `${finding.code} may be released only under an approved override policy, and none was named` };
  const candidates = registry.filter(p => p.policyRef === policyRef).sort((a, b) => b.version - a.version);
  const policy = candidates.find(p => Date.parse(p.effectiveFrom) <= at.getTime() && (p.effectiveUntil == null || Date.parse(p.effectiveUntil) > at.getTime()));
  if (!policy) return { ok: false, refusal: `No approved override policy ${policyRef} is in force` };
  if (policy.approvedBy[0].trim() === "" || policy.approvedBy[1].trim() === "" || policy.approvedBy[0].trim() === policy.approvedBy[1].trim()) return { ok: false, refusal: `Override policy ${policyRef} does not carry two distinct approvers` };
  if (!policy.findingCodes.includes(finding.code)) return { ok: false, refusal: `Override policy ${policyRef} does not cover ${finding.code}` };
  return { ok: true, policy };
}

/* ------------------------------------------------------------------ */
/* Coverage: what an award needs, finding by finding                  */
/* ------------------------------------------------------------------ */

/** The override ladder's role ranks, as `dispatchRouter.overrideRoleFor` records them. */
const GRANTOR_RANK: Record<string, number> = { driver: 0, dispatcher: 1, mechanic: 1, office: 1, manager: 2, administrator: 3 };

/** A granted override as the award path reads it: the GRANTOR, never the requester. */
export type OverrideGrant = {
  blockerCode: string;
  requestedByUserId: number;
  grantedByUserId: number;
  grantedByRole: string;
  reason: string;
  grantedAt: Date;
  policyRef: string | null;
  expiresAt: Date | null;
};

/**
 * The refusals a set of findings raises against a set of grants. Shared by the posting award and
 * the enforced legacy assignment, so both decide the same way.
 */
export function uncoveredFindings(
  findings: readonly ComplianceFinding[],
  grants: readonly OverrideGrant[],
  at: Date,
  registry: readonly OverridePolicy[] = APPROVED_OVERRIDE_POLICIES,
): string[] {
  const refusals: string[] = [];
  const live = grants.filter(g => g.grantedByUserId !== g.requestedByUserId && (!g.expiresAt || g.expiresAt.getTime() > at.getTime()));
  for (const f of findings) {
    if (f.dispatchEffect === "NONE" || f.dispatchEffect === "INFORMATIONAL") continue;
    const tag = f.result === "UNKNOWN" ? "UNKNOWN" : f.dispatchEffect === "BLOCK" ? "BLOCKED" : "REVIEW";
    if (f.overrideClass === "NEVER_OVERRIDABLE") { refusals.push(`${tag} — ${f.label}`); continue; }
    const grant = live.find(g => g.blockerCode === f.code);
    if (f.overrideClass === "APPROVED_POLICY_ONLY") {
      const policy = grant ? resolveOverridePolicy(grant.policyRef, f, at, registry) : null;
      if (!grant || !policy?.ok) { refusals.push(`${tag} — ${f.label} (${policy && !policy.ok ? policy.refusal : "released only under an approved override policy"})`); continue; }
      // Re-checked against the policy in force NOW: a grant does not survive a policy that raised its bar.
      if ((GRANTOR_RANK[grant.grantedByRole] ?? 0) < AUTHORITY_RANK[policy.policy.grantorMinimumRole]) {
        refusals.push(`${tag} — ${f.label} (granted by a ${grant.grantedByRole || "role not recorded"}; ${policy.policy.policyRef} now requires ${policy.policy.grantorMinimumRole} or above)`);
      }
      continue;
    }
    if (!grant) refusals.push(`${tag} — ${f.label} (unresolved, no authorised acknowledgement)`);
  }
  // Belt and braces: a grant recorded against a finding nobody may override is itself a refusal.
  for (const g of grants) {
    const f = findings.find(x => x.code === g.blockerCode);
    if (f && f.overrideClass === "NEVER_OVERRIDABLE") refusals.push(`Override of ${f.code} is not permitted for any role`);
  }
  return refusals;
}
