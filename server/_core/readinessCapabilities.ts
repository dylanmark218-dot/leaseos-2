/**
 * P8.1 — the capability picture for the consumers, per the owner decision of 2026-09-18.
 *
 * The readiness composer already decides eligibility, and it keeps deciding it. What was missing is
 * the distinction between *a capability that answered* and *a capability that was never asked*.
 * Today a module that is off, unlicensed or out of scope for the trip contributes no blocker at
 * all, and a verdict assembled from blockers reads the absence of one as satisfaction. That is the
 * hole: silence becoming consent.
 *
 * This derives the capability view from what the composer already produced — the blockers and the
 * facts — and from an evaluation map the composer fills in as it goes. No second engine, no second
 * verdict: `combineForConsumer` reports, and where a *required* capability was not evaluated the
 * composer raises a blocker of severity `unknown`, which is the engine's own existing word for "an
 * unevaluated condition is not a known-minor one". The behaviour change travels through the engine's
 * vocabulary rather than around it.
 *
 * Scope, kept deliberately narrow (the owner drew these lines):
 *   this file answers **status and consumer requirements** only;
 *   AUTO / HYBRID / MANUAL is P8.2 and is not decided here;
 *   which capabilities may never run AUTO is P8.4 and is not decided here.
 */
import {
  combineForConsumer, notEvaluated,
  type CapabilityResult, type CombinedVerdict, type ConsumerContract, type NotEvaluatedReason,
} from "./interEngineStatus";
import type { DispatchBlocker } from "./dispatchReadiness";

/* ------------------------------------------------------------------ */
/* The capabilities, and who requires them                             */
/* ------------------------------------------------------------------ */

export const CAPABILITY = {
  hos: "hos",
  operatorQualification: "operator qualification",
  unitInspection: "unit inspection",
  operatingDocuments: "operating documents",
  mechanicRelease: "mechanic release",
  routeRestrictions: "route restrictions",
  destinationAcceptance: "destination acceptance",
  enforcementOrders: "enforcement orders",
} as const;

/**
 * Dispatch's required set: what decides whether the truck, driver, trip and destination can legally
 * and safely move. Not every LeaseOS module — only what this trip genuinely needs. A capability that
 * does not apply to the trip reports `not_applicable` and, being unrequired in that case, costs
 * nothing; see `dispatchContractFor`.
 */
export const DISPATCH_REQUIRED_ALWAYS: readonly string[] = [
  CAPABILITY.hos,
  CAPABILITY.operatorQualification,
  CAPABILITY.unitInspection,
  CAPABILITY.operatingDocuments,
  CAPABILITY.enforcementOrders,
];

/**
 * The three that depend on the trip: routing only when a route is being used, a destination only
 * when the load needs one, a mechanic release only when a defect or work order makes it applicable.
 * Requiring them unconditionally would make every mapping-only customer stall on a destination they
 * never had, which is the failure this whole contract exists to prevent.
 */
export function dispatchContractFor(applicability: {
  routingInUse: boolean;
  destinationRequired: boolean;
  mechanicReleaseApplicable: boolean;
}): ConsumerContract {
  const requires = [...DISPATCH_REQUIRED_ALWAYS];
  if (applicability.routingInUse) requires.push(CAPABILITY.routeRestrictions);
  if (applicability.destinationRequired) requires.push(CAPABILITY.destinationAcceptance);
  if (applicability.mechanicReleaseApplicable) requires.push(CAPABILITY.mechanicRelease);
  return {
    consumer: "dispatch readiness",
    requires,
    optional: [CAPABILITY.routeRestrictions, CAPABILITY.destinationAcceptance, CAPABILITY.mechanicRelease]
      .filter(c => !requires.includes(c)),
  };
}

/**
 * Billing's set is evidence, not operations. It does not require live hours because dispatch did:
 * an operational capability irrelevant to the billed evidence travels as NOT_EVALUATED and must not
 * hold the invoice.
 */
export const BILLING_CAPABILITY = {
  fieldTicket: "field ticket",
  acceptedLines: "accepted billable lines",
  customerAcceptance: "customer acceptance",
  signatureIntegrity: "signature integrity",
  chargeEvidence: "rate and quantity evidence",
  supportingEvidence: "supporting disposal or scale evidence",
} as const;

export function billingContractFor(applicability: { lineNeedsSupportingEvidence: boolean }): ConsumerContract {
  const requires: string[] = [
    BILLING_CAPABILITY.fieldTicket,
    BILLING_CAPABILITY.acceptedLines,
    BILLING_CAPABILITY.customerAcceptance,
    BILLING_CAPABILITY.signatureIntegrity,
    BILLING_CAPABILITY.chargeEvidence,
  ];
  if (applicability.lineNeedsSupportingEvidence) requires.push(BILLING_CAPABILITY.supportingEvidence);
  return {
    consumer: "billing readiness",
    requires,
    // Named so their absence is carried on the invoice rather than being invisible.
    optional: [CAPABILITY.hos, CAPABILITY.routeRestrictions, BILLING_CAPABILITY.supportingEvidence]
      .filter(c => !requires.includes(c)),
  };
}

/* ------------------------------------------------------------------ */
/* Deriving the picture from what the engine already produced          */
/* ------------------------------------------------------------------ */

/** What the composer records as it goes: whether each capability was asked, and if not, why. */
export type EvaluationMap = Record<string, { evaluated: true } | { evaluated: false; reason: NotEvaluatedReason; detail?: string }>;

/** Blockers are already tagged by subject; this is the mapping to the capability that raised them. */
const SUBJECT_CAPABILITIES: Record<string, readonly string[]> = {
  operator: [CAPABILITY.operatorQualification, CAPABILITY.hos],
  truck: [CAPABILITY.unitInspection, CAPABILITY.operatingDocuments, CAPABILITY.mechanicRelease],
  trailer: [CAPABILITY.unitInspection, CAPABILITY.operatingDocuments],
  job: [CAPABILITY.destinationAcceptance, CAPABILITY.enforcementOrders],
  route: [CAPABILITY.routeRestrictions],
};

/**
 * Which capability a blocker belongs to. The code is checked first because it is specific; the
 * subject is the fallback. A blocker that matches nothing is attributed to the subject's first
 * capability rather than dropped — losing a blocker here would be the worst possible failure of a
 * safety contract, so the ambiguous case errs toward reporting it.
 */
export function capabilityOf(blocker: Pick<DispatchBlocker, "code" | "subject">): string {
  const code = blocker.code;
  if (/hos|hours|duty|logbook|log_book/i.test(code)) return CAPABILITY.hos;
  if (/mechanic|release|work_order|defect/i.test(code)) return CAPABILITY.mechanicRelease;
  if (/inspection|cvip|roadworth/i.test(code)) return CAPABILITY.unitInspection;
  if (/registration|insurance|permit|operating/i.test(code)) return CAPABILITY.operatingDocuments;
  if (/licence|license|qualification|academy|training|medical/i.test(code)) return CAPABILITY.operatorQualification;
  if (/route|road|bridge|segment|communication/i.test(code)) return CAPABILITY.routeRestrictions;
  if (/destination|facility|disposal|acceptance/i.test(code)) return CAPABILITY.destinationAcceptance;
  if (/enforcement|order|oos|out_of_service/i.test(code)) return CAPABILITY.enforcementOrders;
  return SUBJECT_CAPABILITIES[blocker.subject]?.[0] ?? CAPABILITY.enforcementOrders;
}

/** Worst blocker severity wins, in the engine's own ordering. */
function statusFromBlockers(blockers: readonly DispatchBlocker[]): "PASS" | "REVIEW" | "BLOCKED" | "UNKNOWN" {
  if (blockers.some(b => b.severity === "blocking")) return "BLOCKED";
  if (blockers.some(b => b.severity === "unknown")) return "UNKNOWN";
  if (blockers.some(b => b.severity === "review")) return "REVIEW";
  return "PASS";
}

/**
 * The capability results for one composition: a status per capability the contract mentions, from
 * the blockers it raised, or NOT_EVALUATED with the reason the composer recorded.
 */
export function capabilityResults(
  contract: ConsumerContract,
  blockers: readonly DispatchBlocker[],
  evaluation: EvaluationMap,
): CapabilityResult[] {
  const names = Array.from(new Set([...contract.requires, ...(contract.optional ?? []), ...Object.keys(evaluation)]));
  return names.map((capability) => {
    const e = evaluation[capability];
    if (e && !e.evaluated) return notEvaluated(capability, e.reason, e.detail);
    const mine = blockers.filter(b => capabilityOf(b) === capability);
    return { capability, status: statusFromBlockers(mine), detail: mine.map(b => b.label).join("; ") || undefined };
  });
}

/**
 * The blockers a required-but-unevaluated capability must raise, so the engine's own verdict stops
 * reading the absence as satisfaction. Severity `unknown`, never `blocking`: blocked is an answer,
 * and the point is that no answer was given. Overridable, like the engine's other unknowns — a
 * person may still take responsibility, and now they can see what they are taking it for.
 */
export function blockersForUnevaluatedRequired(verdict: CombinedVerdict, evaluation: EvaluationMap): DispatchBlocker[] {
  return verdict.missingRequired.map((capability) => {
    const e = evaluation[capability];
    const reason = e && !e.evaluated ? e.reason : "module_disabled";
    return {
      code: `capability_not_evaluated_${capability.replace(/\s+/g, "_")}`,
      label: `${capability} is required for this dispatch and was not evaluated (${reason})`,
      severity: "unknown" as const,
      subject: (Object.entries(SUBJECT_CAPABILITIES).find(([, caps]) => caps.includes(capability))?.[0] ?? "job") as DispatchBlocker["subject"],
      overridable: true,
      minimumRole: "supervisor",
    } as DispatchBlocker;
  });
}

/** Compose the whole picture in one call, for a consumer that has both parts. */
export function pictureFor(
  contract: ConsumerContract,
  blockers: readonly DispatchBlocker[],
  evaluation: EvaluationMap,
): { capabilities: CapabilityResult[]; verdict: CombinedVerdict; extraBlockers: DispatchBlocker[] } {
  const capabilities = capabilityResults(contract, blockers, evaluation);
  const verdict = combineForConsumer(contract, capabilities);
  return { capabilities, verdict, extraBlockers: blockersForUnevaluatedRequired(verdict, evaluation) };
}

/* ------------------------------------------------------------------ */
/* The audit package: preserve the picture, do not collapse it         */
/* ------------------------------------------------------------------ */

/**
 * The capability picture as audit-package items, per the owner decision: the package is evidence of
 * what happened, **including what was not evaluated**. So NOT_EVALUATED is written out as itself —
 * not dropped, not rounded to a neighbouring state, not summarised into a count — and a capability
 * being unevaluated does not on its own stop a package being produced. Package completeness rules
 * may still name missing evidence; that is a separate judgement from this record of the facts.
 *
 * Both statuses are carried. The raw engine status is what the producing engine said in its own
 * vocabulary; the normalized one is the inter-engine word. Keeping only the normalized status would
 * lose the engine's own terms, and keeping only the raw one would make packages from different
 * engines incomparable.
 */
export function capabilityItems(
  consumer: string,
  contract: ConsumerContract,
  capabilities: readonly CapabilityResult[],
  provenance: { engine: string; profileVersion?: string | null; rawStatusOf?: (capability: string) => string | null },
): { itemKind: string; sourceTable: string; sourceId: number; sourceRef: string | null; title: string; row: Record<string, unknown> }[] {
  const required = new Set(contract.requires);
  return capabilities.map((c, i) => ({
    itemKind: "capability_evaluation",
    sourceTable: "interEngineStatus",
    sourceId: i + 1,
    sourceRef: `${consumer}:${c.capability}`,
    title: `${c.capability} — ${c.status}${c.status === "NOT_EVALUATED" ? ` (${c.reason})` : ""}`,
    row: {
      consumer,
      capability: c.capability,
      // The engine's own word, kept beside the shared one.
      rawEngineStatus: provenance.rawStatusOf?.(c.capability) ?? null,
      interEngineStatus: c.status,
      requiredByConsumer: required.has(c.capability),
      notEvaluated: c.status === "NOT_EVALUATED",
      notEvaluatedReason: c.status === "NOT_EVALUATED" ? c.reason ?? null : null,
      detail: c.detail ?? null,
      engine: provenance.engine,
      profileVersion: provenance.profileVersion ?? null,
    },
  }));
}
