/**
 * Payroll P1 — compensation agreements, pure.
 *
 * Four things this module holds, with no database in sight:
 *
 *   The rule set of a version is canonical and hashed. The same financial rules in any order give the
 *   same sha256; a changed rate, code, unit, calculation, percentage, overtime or eligibility setting gives
 *   a different one; a note or a display order does not. A statement can later prove which rules paid it.
 *
 *   A work date resolves to exactly one approved version, or to none, or to an integrity error. The
 *   window is [effectiveFrom, effectiveUntil) by calendar date — inclusive start, exclusive end, NULL end
 *   open. "Take the latest" is never the answer when the date is outside its window.
 *
 *   A new approved version closes the one in force at its own start date and may not start before or
 *   inside an earlier approved window: approved windows of one agreement never overlap.
 *
 *   The worker classification is `organizationWorkers.workerType` or a deterministic legacy mapping; an
 *   unmappable profile fails visibly (D9). An owner-driver never gets an employee agreement (D3, D9).
 */
import { canonicalJson, sha256 } from "./commercialLifecycle";
import { WORKER_CLASSIFICATIONS, COMPENSATION_BASES, RULE_CALCULATIONS, RULE_UNITS } from "../../drizzle/schema";

export type WorkerClassification = (typeof WORKER_CLASSIFICATIONS)[number];
export type CompensationBasis = (typeof COMPENSATION_BASES)[number];
export type RuleCalculation = (typeof RULE_CALCULATIONS)[number];
export type RuleUnit = (typeof RULE_UNITS)[number];
/** A calendar date as text, YYYY-MM-DD. Compared as text; ISO order is date order. */
export type DateText = string;

export const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* Classification (D9)                                                 */
/* ------------------------------------------------------------------ */

export type ClassificationInput = {
  /** The linked organizationWorkers row, when one exists for the profile's book. */
  organizationWorker?: { workerRef: string; workerType: string } | null;
  /** Legacy evidence when no worker row exists. */
  legacy: { hasOperator: boolean; roles: readonly string[] };
};
export type ClassificationResult =
  | { ok: true; classification: WorkerClassification; source: "organization_worker" | "legacy_mapped"; workerRef: string | null }
  | { ok: false; reason: string };

/**
 * The legacy compatibility map, in precedence order. A linked operator record is a driver before any
 * role says otherwise; after that the first role in this list decides. Roles not listed (hr, management,
 * controller, legal, auditor, …) do not describe employment and are not mapped.
 */
export const LEGACY_ROLE_CLASSIFICATION: ReadonlyArray<readonly [role: string, classification: WorkerClassification]> = [
  ["driver", "EMPLOYEE_DRIVER"],
  ["mechanic", "MECHANIC"],
  ["shop_lead", "MAINTENANCE_SUPERVISOR"],
  ["dispatcher", "DISPATCHER"],
  ["bookkeeper", "BOOKKEEPER"],
  ["safety", "SAFETY_COMPLIANCE"],
  ["office", "OFFICE_ADMIN"],
];

export function normalizeClassification(input: ClassificationInput): ClassificationResult {
  const w = input.organizationWorker;
  if (w) {
    if (!(WORKER_CLASSIFICATIONS as readonly string[]).includes(w.workerType)) {
      return { ok: false, reason: `organizationWorkers row ${w.workerRef} carries an unknown workerType "${w.workerType}"` };
    }
    return { ok: true, classification: w.workerType as WorkerClassification, source: "organization_worker", workerRef: w.workerRef };
  }
  if (input.legacy.hasOperator) return { ok: true, classification: "EMPLOYEE_DRIVER", source: "legacy_mapped", workerRef: null };
  for (const [role, classification] of LEGACY_ROLE_CLASSIFICATION) {
    if (input.legacy.roles.includes(role)) return { ok: true, classification, source: "legacy_mapped", workerRef: null };
  }
  return {
    ok: false,
    reason: "This payroll profile has no organizationWorkers row, no operator record and no role that maps to a worker classification — link an organizationWorkers row before writing a compensation agreement",
  };
}

/** The employee/contractor boundary, on the normalized vocabulary. */
export function agreementEligibility(classification: WorkerClassification): { allowed: boolean; reason?: string } {
  if (classification === "OWNER_DRIVER") {
    return { allowed: false, reason: "This worker is an owner-operator — settle through contractor settlement, not an employee compensation agreement" };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ */
/* Rules: validation, canonical form, hash                             */
/* ------------------------------------------------------------------ */

export type EarningRuleInput = {
  earningCode: string;
  calculation: RuleCalculation;
  unit: RuleUnit;
  rateMillis?: number | null;
  percentMillis?: number | null;
  overtimeRule?: unknown;
  eligibleRevenueBasis?: unknown;
  minimumMeasurementAuthority?: string | null;
  requiresJob?: boolean;
  requiresUnit?: boolean;
  /** Display only; never part of the hash. */
  sortOrder?: number;
};

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Refuse a rule set that could not be paid from. Every refusal is by name. */
export function validateRules(basis: CompensationBasis, rules: readonly EarningRuleInput[]): string[] {
  const errors: string[] = [];
  if (rules.length === 0) errors.push("A version needs at least one earning rule");
  const seen = new Set<string>();
  for (const r of rules) {
    const tag = `rule ${r.earningCode}`;
    if (seen.has(r.earningCode)) errors.push(`${tag}: the earning code appears twice in one version`);
    seen.add(r.earningCode);
    if (r.rateMillis != null && (!isInt(r.rateMillis) || r.rateMillis < 0)) errors.push(`${tag}: rateMillis must be a non-negative integer (thousandths)`);
    if (r.percentMillis != null && (!isInt(r.percentMillis) || r.percentMillis < 0 || r.percentMillis > 100_000)) errors.push(`${tag}: percentMillis must be an integer between 0 and 100000 (thousandths of a percent)`);
    switch (r.calculation) {
      case "hourly":
        if (r.unit !== "hour") errors.push(`${tag}: hourly pay is per hour`);
        if (r.rateMillis == null) errors.push(`${tag}: hourly pay needs rateMillis`);
        break;
      case "quantity_times_rate":
        if (r.unit === "percent" || r.unit === "period") errors.push(`${tag}: quantity × rate needs a countable unit`);
        if (r.rateMillis == null) errors.push(`${tag}: quantity × rate needs rateMillis`);
        break;
      case "percentage":
        if (r.unit !== "percent") errors.push(`${tag}: percentage pay is in percent`);
        if (r.percentMillis == null) errors.push(`${tag}: percentage pay needs percentMillis`);
        break;
      case "flat":
        if (r.rateMillis == null) errors.push(`${tag}: a flat amount needs rateMillis`);
        break;
      case "per_period_salary":
        if (r.unit !== "period") errors.push(`${tag}: salary is per period`);
        if (r.rateMillis == null) errors.push(`${tag}: salary needs rateMillis`);
        break;
      case "formula":
        // Formula-capable metadata is configuration only in P1; it must carry something to evaluate later.
        if (r.overtimeRule == null && r.eligibleRevenueBasis == null) errors.push(`${tag}: a formula rule needs its configuration (overtimeRule or eligibleRevenueBasis)`);
        break;
    }
  }
  if (basis === "salary" && !rules.some(r => r.calculation === "per_period_salary")) errors.push("A salary basis needs a per_period_salary rule");
  if (basis === "hourly" && !rules.some(r => r.calculation === "hourly")) errors.push("An hourly basis needs an hourly rule");
  if (basis === "percentage" && !rules.some(r => r.calculation === "percentage")) errors.push("A percentage basis needs a percentage rule");
  return errors;
}

export type CanonicalRule = {
  earningCode: string;
  calculation: RuleCalculation;
  unit: RuleUnit;
  rateMillis: number | null;
  percentMillis: number | null;
  overtimeRule: unknown;
  eligibleRevenueBasis: unknown;
  minimumMeasurementAuthority: string | null;
  requiresJob: boolean;
  requiresUnit: boolean;
};
export type CanonicalRuleSet = { basis: CompensationBasis; currency: string; rules: CanonicalRule[] };

/** Nulls for absent optionals, so "no overtime rule" and "overtimeRule: null" are the same bytes. */
const normalizeJsonValue = (v: unknown): unknown => (v === undefined ? null : v);

/**
 * The financial content of a version, and nothing else, in one order. Rules sort by code, then
 * calculation, then unit, so the hash never depends on the order rules were typed or stored.
 */
export function canonicalRuleSet(version: { basis: CompensationBasis; currency: string }, rules: readonly EarningRuleInput[]): CanonicalRuleSet {
  const canon = rules.map<CanonicalRule>(r => ({
    earningCode: r.earningCode,
    calculation: r.calculation,
    unit: r.unit,
    rateMillis: r.rateMillis ?? null,
    percentMillis: r.percentMillis ?? null,
    overtimeRule: normalizeJsonValue(r.overtimeRule),
    eligibleRevenueBasis: normalizeJsonValue(r.eligibleRevenueBasis),
    minimumMeasurementAuthority: r.minimumMeasurementAuthority ?? null,
    requiresJob: r.requiresJob ?? false,
    requiresUnit: r.requiresUnit ?? false,
  }));
  canon.sort((a, b) => a.earningCode.localeCompare(b.earningCode) || a.calculation.localeCompare(b.calculation) || a.unit.localeCompare(b.unit));
  return { basis: version.basis, currency: version.currency.toUpperCase(), rules: canon };
}

/** sha256 over canonicalJson(canonicalRuleSet): object keys sorted recursively, so property order never matters. */
export function rulesHash(set: CanonicalRuleSet): string {
  return sha256(canonicalJson(set));
}

/** The ledger's informational amount: the largest per-unit rate, in cents. Zero when the version is percentage-only. */
export function headlineAmountCents(rules: readonly EarningRuleInput[]): number {
  const max = Math.max(0, ...rules.map(r => r.rateMillis ?? 0));
  return Math.round(max / 10);
}

/* ------------------------------------------------------------------ */
/* Effective dates: [effectiveFrom, effectiveUntil)                     */
/* ------------------------------------------------------------------ */

export type VersionWindow = { versionRef: string; status: "proposed" | "approved" | "rejected" | "superseded"; effectiveFrom: DateText; effectiveUntil: DateText | null };

export function windowContains(w: { effectiveFrom: DateText; effectiveUntil: DateText | null }, date: DateText): boolean {
  return w.effectiveFrom <= date && (w.effectiveUntil === null || date < w.effectiveUntil);
}

export function windowsOverlap(a: { effectiveFrom: DateText; effectiveUntil: DateText | null }, b: { effectiveFrom: DateText; effectiveUntil: DateText | null }): boolean {
  const aEnd = a.effectiveUntil ?? "9999-12-31";
  const bEnd = b.effectiveUntil ?? "9999-12-31";
  return a.effectiveFrom < bEnd && b.effectiveFrom < aEnd;
}

export type InForce =
  | { kind: "version"; version: VersionWindow }
  | { kind: "none"; reason: string }
  | { kind: "integrity_error"; reason: string; versions: VersionWindow[] };

/**
 * agreement + work date → the approved version in force. Proposed and rejected versions never apply;
 * a superseded version still applies inside its (closed) window; a future version does not apply early;
 * two matches are an integrity error, never an arbitrary winner.
 */
export function versionInForce(versions: readonly VersionWindow[], workDate: DateText): InForce {
  if (!DATE_TEXT.test(workDate)) return { kind: "none", reason: `work date "${workDate}" is not YYYY-MM-DD` };
  const matches = versions.filter(v => (v.status === "approved" || v.status === "superseded") && windowContains(v, workDate));
  if (matches.length === 1) return { kind: "version", version: matches[0]! };
  if (matches.length === 0) return { kind: "none", reason: `no approved compensation version is in force on ${workDate}` };
  return { kind: "integrity_error", reason: `${matches.length} approved versions claim ${workDate}: ${matches.map(m => m.versionRef).join(", ")}`, versions: matches };
}

export type SupersessionPlan =
  | { ok: true; close: Array<{ versionRef: string; effectiveUntil: DateText }> }
  | { ok: false; reason: string };

/**
 * What approving `candidate` does to the approved versions already there. The version in force at the
 * candidate's start is closed at that date (superseded); a candidate that starts on or before an
 * approved version's start, or whose own window would still overlap one, is refused — approved windows
 * never overlap, so history is never rewritten by a later proposal.
 */
export function supersessionPlan(approved: readonly VersionWindow[], candidate: { versionRef: string; effectiveFrom: DateText; effectiveUntil: DateText | null }): SupersessionPlan {
  if (!DATE_TEXT.test(candidate.effectiveFrom) || (candidate.effectiveUntil !== null && !DATE_TEXT.test(candidate.effectiveUntil))) return { ok: false, reason: "effective dates must be YYYY-MM-DD" };
  if (candidate.effectiveUntil !== null && candidate.effectiveUntil <= candidate.effectiveFrom) return { ok: false, reason: "effectiveUntil must be after effectiveFrom (the window is [from, until))" };
  const close: Array<{ versionRef: string; effectiveUntil: DateText }> = [];
  for (const v of approved) {
    if (v.status !== "approved") continue;
    if (v.versionRef === candidate.versionRef) continue;
    if (v.effectiveFrom >= candidate.effectiveFrom) {
      return { ok: false, reason: `version ${v.versionRef} is already approved from ${v.effectiveFrom}; a version effective on or before an approved version's start cannot be approved — propose it with a later effectiveFrom` };
    }
    const closedAlready = v.effectiveUntil !== null && v.effectiveUntil <= candidate.effectiveFrom;
    if (closedAlready) continue;
    // v starts before the candidate and is open (or closes after the candidate starts): it is the one in force.
    close.push({ versionRef: v.versionRef, effectiveUntil: candidate.effectiveFrom });
    if (candidate.effectiveUntil !== null && v.effectiveUntil !== null && v.effectiveUntil > candidate.effectiveUntil) {
      return { ok: false, reason: `version ${v.versionRef} runs past the candidate's own end (${v.effectiveUntil} > ${candidate.effectiveUntil}); a bounded version cannot sit inside an approved one` };
    }
  }
  return { ok: true, close };
}
