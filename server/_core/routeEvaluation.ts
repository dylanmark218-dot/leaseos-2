/**
 * Route evaluation + evidence ledger.
 *
 * Answers "why did the system send this truck this way?" with segments,
 * sources, versions and arithmetic — never "the AI chose this route".
 *
 * Four axes are kept separate on purpose, because conflating them is how a
 * routing product ends up telling a driver something untrue:
 *
 *   LEGAL          — is the movement permitted on this segment?
 *   FEASIBLE       — can this vehicle physically do it? (a 30 m combination
 *                    can be legal on a road it cannot turn onto)
 *   PREFERRED      — operational quality: gravel, school zones, grades
 *   DATA CONFIDENCE— how much of the above rests on verified information?
 *
 * Gate 4 is structural here: `unknown` has its own result value and its own
 * counter, and no code path lets it collapse into `pass`. A route with an
 * unevaluated check can never return `clear`.
 */

import type { DispatchStatus, RequiredCheck } from "./routingCompiler";

export type CheckResult = "pass" | "fail" | "review" | "unknown";
export type DataConfidence =
  | "unverified"
  | "operator_supplied"
  | "authority_confirmed";

/** Which axis a check speaks to. A bridge weight limit is legal; a turnaround is physical. */
const CHECK_AXIS: Record<RequiredCheck, "legal" | "feasible" | "preferred"> = {
  road_weight_restriction: "legal",
  axle_group_limit: "legal",
  bridge_capacity: "legal",
  bridge_axle_limit: "legal",
  overhead_clearance: "feasible",
  bridge_clearance: "feasible",
  width_restriction: "legal",
  length_restriction: "legal",
  truck_route_designation: "legal",
  dg_corridor: "legal",
  dg_time_restriction: "legal",
  seasonal_closure: "legal",
  road_ban_level: "legal",
  surface_condition: "preferred",
  weather_interaction: "preferred",
  lease_gate_access: "feasible",
  road_owner_permission: "legal",
  turnaround_suitability: "feasible",
  oversize_corridor_designation: "legal",
  escort_requirement: "legal",
  school_zone_timing: "preferred",
  residential_restriction: "preferred",
};

/** What the map holds about one segment for one check. */
export type SegmentAttribute = {
  check: RequiredCheck;
  /** Absent means the map has no data — which is `unknown`, never `pass`. */
  limitValue?: number | null;
  textValue?: string | null;
  /** The unit the limit was recorded in. Absent means the check's own unit (kg or m). */
  unit?: string | null;
  /**
   * T2 (P2) — a structured road ban, resolved: the allowance for each axle-group type, already the
   * ban's fraction of the jurisdiction's verified legal allowance. Each axle group is compared with
   * the allowance for its own type.
   */
  groupLimitsKg?: Partial<Record<AxleGroupType, number>>;
  /** Evidence exists but could not be resolved into a comparable limit. Always UNKNOWN, with this reason. */
  unresolvedReason?: string | null;
  jurisdiction?: string | null;
  source?: string | null;
  sourceVersion?: string | null;
  verifiedAt?: string | null;
  confidence?: DataConfidence | null;
};

export type RoadSegmentInput = {
  segmentId: string;
  label: string;
  lengthKm: number;
  attributes: SegmentAttribute[];
};

/** One immutable row of the ledger: a single check, on a single segment. */
export type EvidenceEntry = {
  segmentId: string;
  segmentLabel: string;
  check: RequiredCheck;
  axis: "legal" | "feasible" | "preferred";
  result: CheckResult;
  reason: string;
  /** Everything the comparison used, so the decision can be recomputed. */
  inputs: {
    vehicleValue?: number | null;
    limitValue?: number | null;
    unit?: string;
  };
  jurisdiction: string | null;
  source: string | null;
  sourceVersion: string | null;
  verifiedAt: string | null;
  confidence: DataConfidence;
};

export type RouteVerdict = {
  legal: CheckResult;
  physicallyFeasible: CheckResult;
  operationallyPreferred: CheckResult;
  dataConfidence: DataConfidence;
  dispatchStatus: DispatchStatus;
  evidence: EvidenceEntry[];
  failingCount: number;
  unknownCount: number;
  reviewCount: number;
  /** Plain-language account of the decision, assembled from the evidence. */
  explanation: string;
};

/** Axle-group types a legal allowance is stated for. */
export type AxleGroupType = "single" | "tandem" | "tridem";
export const axleGroupType = (axles: number | null | undefined): AxleGroupType | null =>
  axles === 1 ? "single" : axles === 2 ? "tandem" : axles === 3 ? "tridem" : null;

/** One measured or declared axle group. */
export type VehicleAxleGroup = { key: string; label: string; weightKg: number; axles?: number | null };

/**
 * What the weights rest on (T2, P1). `declared` is the unit's profile; `measured_legal` is a reading
 * LoadSense determined legal when it was taken; `measured_not_legal` is a reading that was not — it
 * may tighten a check, and a check it passes is REVIEW, never PASS.
 */
export type WeightBasis = "declared" | "measured_legal" | "measured_not_legal";

/** The vehicle values a check compares against. */
export type VehicleValues = {
  grossWeightKg: number;
  maxAxleGroupKg: number;
  /** Every axle group, when known. `maxAxleGroupKg` is the heaviest of these. */
  axleGroups?: VehicleAxleGroup[];
  /** Absent means `declared`, which is what every caller before T2 supplied. */
  weightBasis?: WeightBasis;
  heightM: number;
  widthM: number;
  lengthM: number;
  dangerousGoods: boolean;
  requiresEscort: boolean;
};

const NUMERIC_CHECKS: Partial<
  Record<RequiredCheck, { field: keyof VehicleValues; unit: string }>
> = {
  road_weight_restriction: { field: "grossWeightKg", unit: "kg" },
  bridge_capacity: { field: "grossWeightKg", unit: "kg" },
  axle_group_limit: { field: "maxAxleGroupKg", unit: "kg" },
  bridge_axle_limit: { field: "maxAxleGroupKg", unit: "kg" },
  overhead_clearance: { field: "heightM", unit: "m" },
  bridge_clearance: { field: "heightM", unit: "m" },
  width_restriction: { field: "widthM", unit: "m" },
  length_restriction: { field: "lengthM", unit: "m" },
};

function evaluateCheck(
  check: RequiredCheck,
  attr: SegmentAttribute | undefined,
  vehicle: VehicleValues,
  segment: RoadSegmentInput
): EvidenceEntry {
  const axis = CHECK_AXIS[check];
  const base = {
    segmentId: segment.segmentId,
    segmentLabel: segment.label,
    check,
    axis,
    jurisdiction: attr?.jurisdiction ?? null,
    source: attr?.source ?? null,
    sourceVersion: attr?.sourceVersion ?? null,
    verifiedAt: attr?.verifiedAt ?? null,
    confidence: attr?.confidence ?? ("unverified" as DataConfidence),
  };

  // No data is not clearance. This is the single most important line here.
  if (!attr) {
    return {
      ...base,
      result: "unknown",
      reason: `No ${check.replace(/_/g, " ")} data held for ${segment.label}`,
      inputs: {},
    };
  }

  // Evidence that exists but could not be made comparable is UNKNOWN, and says why.
  if (attr.unresolvedReason) {
    return { ...base, result: "unknown", reason: attr.unresolvedReason, inputs: {} };
  }

  // T2 (P2) — a resolved road ban: every axle group against the allowance for its own type.
  if (attr.groupLimitsKg) {
    const groups = vehicle.axleGroups ?? [];
    if (!groups.length) {
      return { ...base, result: "unknown", reason: `${segment.label} has a road ban, and the vehicle's axle groups are not known`, inputs: {} };
    }
    const judged = groups.map(g => {
      const type = axleGroupType(g.axles);
      const limit = type ? attr.groupLimitsKg![type] : undefined;
      return { g, type, limit, result: (limit == null ? "unknown" : g.weightKg <= limit ? "pass" : "fail") as CheckResult };
    });
    const worst = judged.reduce((a, j) => (RESULT_SEVERITY[j.result] > RESULT_SEVERITY[a.result] ? j : a));
    const notEstablished = vehicle.weightBasis === "measured_not_legal";
    const result: CheckResult = worst.result === "pass" && (base.confidence === "unverified" || notEstablished) ? "review" : worst.result;
    const reason = worst.result === "unknown"
      ? worst.type
        ? `${segment.label} road ban: the governing rule states no ${worst.type} allowance, so the ${worst.g.label} axle group's allowance is UNKNOWN`
        : `${segment.label} road ban: the ${worst.g.label} axle group's axle count is not recorded, so its type and allowance are UNKNOWN`
      : worst.result === "fail"
        ? `${worst.g.label} ${worst.type} axle group ${worst.g.weightKg} kg exceeds the ${worst.limit} kg road-ban allowance on ${segment.label}`
        : `every axle group within its road-ban allowance on ${segment.label}${notEstablished ? " (measured, not a legal determination — review)" : ""}`;
    return { ...base, result, reason, inputs: { vehicleValue: worst.g.weightKg, limitValue: worst.limit ?? null, unit: "kg" } };
  }

  const numeric = NUMERIC_CHECKS[check];
  if (numeric) {
    const vehicleValue = vehicle[numeric.field] as number;
    if (attr.limitValue === null || attr.limitValue === undefined) {
      return {
        ...base,
        result: "unknown",
        reason: `${segment.label} has no recorded ${check.replace(/_/g, " ")} limit`,
        inputs: { vehicleValue, limitValue: null, unit: numeric.unit },
      };
    }
    // Units are compared only when they are the check's own. A limit recorded in tonnes or feet is
    // real evidence that this evaluator cannot read, so it is UNKNOWN — never silently treated as kg/m.
    if (attr.unit != null && attr.unit.trim() !== "" && canonicalUnit(attr.unit) !== numeric.unit) {
      return {
        ...base,
        result: "unknown",
        reason: `${segment.label} records its ${check.replace(/_/g, " ")} limit as ${attr.limitValue} ${attr.unit}; only ${numeric.unit} is compared, so it is not read`,
        inputs: { vehicleValue, limitValue: null, unit: numeric.unit },
      };
    }
    const passes = vehicleValue <= attr.limitValue;
    const isWeight = numeric.field === "grossWeightKg" || numeric.field === "maxAxleGroupKg";
    // A weight reading that is not a legal determination can tighten a check but cannot satisfy one.
    const weightNotEstablished = isWeight && vehicle.weightBasis === "measured_not_legal";
    // Name the axle group that governs, so "exceeds" says which one.
    const heaviest = numeric.field === "maxAxleGroupKg" && vehicle.axleGroups?.length
      ? vehicle.axleGroups.reduce((a, g) => (g.weightKg > a.weightKg ? g : a))
      : null;
    const what = heaviest ? `${heaviest.label} axle group ${vehicleValue} ${numeric.unit}` : `${vehicleValue} ${numeric.unit}`;
    const basisNote = isWeight && vehicle.weightBasis === "measured_legal" ? " (measured, legally determined)"
      : weightNotEstablished ? " (measured, not a legal determination — review)" : "";
    return {
      ...base,
      // An unverified limit that the vehicle satisfies is still not a clean
      // pass — a human should confirm the number before relying on it.
      result: passes
        ? base.confidence === "unverified" || weightNotEstablished
          ? "review"
          : "pass"
        : "fail",
      reason: passes
        ? `${what} within ${attr.limitValue} ${numeric.unit} on ${segment.label}${basisNote}`
        : `${what} exceeds ${attr.limitValue} ${numeric.unit} on ${segment.label}${basisNote}`,
      inputs: { vehicleValue, limitValue: attr.limitValue, unit: numeric.unit },
    };
  }

  // Categorical checks: the map states a condition in words.
  const text = (attr.textValue ?? "").toLowerCase();
  if (!text) {
    return {
      ...base,
      result: "unknown",
      reason: `${segment.label} has no recorded ${check.replace(/_/g, " ")} status`,
      inputs: {},
    };
  }

  if (
    check === "dg_corridor" &&
    vehicle.dangerousGoods &&
    text !== "permitted"
  ) {
    return {
      ...base,
      result: "fail",
      reason: `Dangerous goods not permitted on ${segment.label} (${text})`,
      inputs: {},
    };
  }
  if (
    check === "escort_requirement" &&
    text === "required" &&
    !vehicle.requiresEscort
  ) {
    return {
      ...base,
      result: "review",
      reason: `${segment.label} requires an escort; none assigned`,
      inputs: {},
    };
  }

  const negative = [
    "closed",
    "prohibited",
    "banned",
    "not_permitted",
    "unsuitable",
    "restricted",
  ];
  if (negative.some(n => text.includes(n))) {
    return {
      ...base,
      result: axis === "preferred" ? "review" : "fail",
      reason: `${segment.label}: ${check.replace(/_/g, " ")} is ${text}`,
      inputs: {},
    };
  }

  return {
    ...base,
    result: base.confidence === "unverified" ? "review" : "pass",
    reason: `${segment.label}: ${check.replace(/_/g, " ")} is ${text}`,
    inputs: {},
  };
}

/** Worst-wins, with `unknown` never absorbed by a neighbouring `pass`. */
function combineAxis(results: CheckResult[]): CheckResult {
  if (results.length === 0) return "pass";
  if (results.includes("fail")) return "fail";
  if (results.includes("unknown")) return "unknown";
  if (results.includes("review")) return "review";
  return "pass";
}

/** "kg", "kilograms", "M", "metres"… → the check's own unit, or the input lower-cased when it is not one. */
function canonicalUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["m", "metre", "metres", "meter", "meters"].includes(u)) return "m";
  return u;
}

const RESULT_SEVERITY: Record<CheckResult, number> = { fail: 3, unknown: 2, review: 1, pass: 0 };

/**
 * T2 (defect 1A) — the controlling entry for one check on one segment.
 *
 * Every attribute handed in for the check is evaluated, and the worst result governs: a FAIL from
 * any applicable limit is a FAIL, an UNKNOWN limit is never outvoted by a passing one, and among
 * equal results the tightest numeric limit is the one cited. Applicability — the right segment,
 * in force at the evaluation instant, not superseded — is settled before evidence reaches here
 * (`applicableRestrictions`, `structureAttributes`), so this compares only like with like.
 *
 * That is `sourcePrecedence`'s asymmetric rule in evaluator terms: a lower-authority source can
 * tighten a limit (its FAIL governs) and can never loosen one (its PASS cannot outvote another
 * source's FAIL). It used to take whichever attribute was listed first, so a 5.0 m road clearance
 * listed before a 4.2 m overpass passed a 4.5 m truck.
 */
function controllingEntry(check: RequiredCheck, attrs: SegmentAttribute[], vehicle: VehicleValues, segment: RoadSegmentInput): EvidenceEntry {
  if (attrs.length === 0) return evaluateCheck(check, undefined, vehicle, segment);
  const entries = attrs.map(a => evaluateCheck(check, a, vehicle, segment));
  const governing = entries.reduce((best, e) => {
    const d = RESULT_SEVERITY[e.result] - RESULT_SEVERITY[best.result];
    if (d !== 0) return d > 0 ? e : best;
    const el = e.inputs.limitValue, bl = best.inputs.limitValue;
    return el != null && (bl == null || el < bl) ? e : best;
  });
  return entries.length > 1
    ? { ...governing, reason: `${governing.reason} (controlling of ${entries.length} applicable ${check.replace(/_/g, " ")} records)` }
    : governing;
}

export function evaluateRoute(
  requiredChecks: RequiredCheck[],
  segments: RoadSegmentInput[],
  vehicle: VehicleValues
): RouteVerdict {
  const evidence: EvidenceEntry[] = [];

  for (const segment of segments) {
    /*
     * The checks asked for, plus every legal or physical check this segment holds recorded evidence
     * for. A posted 45,000 kg bridge on the segment is a fact about this truck on this road whether
     * or not the caller listed `bridge_capacity`; leaving it out because nobody asked is how a road
     * gross limit of 63,500 kg passed a 50,000 kg truck over it.
     */
    const evidenced = segment.attributes.map(a => a.check).filter(c => CHECK_AXIS[c] === "legal" || CHECK_AXIS[c] === "feasible");
    const checks = Array.from(new Set([...requiredChecks, ...evidenced]));
    for (const check of checks) {
      evidence.push(controllingEntry(check, segment.attributes.filter(a => a.check === check), vehicle, segment));
    }
  }

  const byAxis = (axis: EvidenceEntry["axis"]) =>
    combineAxis(evidence.filter(e => e.axis === axis).map(e => e.result));

  const legal = byAxis("legal");
  const physicallyFeasible = byAxis("feasible");
  const operationallyPreferred = byAxis("preferred");

  const failingCount = evidence.filter(e => e.result === "fail").length;
  const unknownCount = evidence.filter(e => e.result === "unknown").length;
  const reviewCount = evidence.filter(e => e.result === "review").length;

  const confidences = evidence.map(e => e.confidence);
  const dataConfidence: DataConfidence = confidences.includes("unverified")
    ? "unverified"
    : confidences.includes("operator_supplied")
      ? "operator_supplied"
      : "authority_confirmed";

  let dispatchStatus: DispatchStatus;
  if (legal === "fail" || physicallyFeasible === "fail")
    dispatchStatus = "blocked";
  else if (legal === "unknown" || physicallyFeasible === "unknown")
    dispatchStatus = "warning";
  else if (
    legal === "review" ||
    physicallyFeasible === "review" ||
    reviewCount > 0
  )
    dispatchStatus = "review";
  else if (operationallyPreferred === "unknown") dispatchStatus = "warning";
  else dispatchStatus = "clear";

  return {
    legal,
    physicallyFeasible,
    operationallyPreferred,
    dataConfidence,
    dispatchStatus,
    evidence,
    failingCount,
    unknownCount,
    reviewCount,
    explanation: explainVerdict({
      legal,
      physicallyFeasible,
      operationallyPreferred,
      dataConfidence,
      dispatchStatus,
      evidence,
      failingCount,
      unknownCount,
      reviewCount,
      explanation: "",
    }),
  };
}

/**
 * Assemble the sentence a dispatcher can defend. Cites the segments and
 * numbers that drove the outcome rather than summarising it away.
 */
export function explainVerdict(v: RouteVerdict): string {
  const parts: string[] = [];

  const fails = v.evidence.filter(e => e.result === "fail");
  for (const f of fails) parts.push(f.reason);

  const unknowns = v.evidence.filter(e => e.result === "unknown");
  if (unknowns.length) {
    const segs = Array.from(new Set(unknowns.map(u => u.segmentLabel)));
    parts.push(
      `${unknowns.length} check(s) could not be evaluated on ${segs.join(", ")} — unknown is not treated as clear`
    );
  }

  const reviews = v.evidence.filter(e => e.result === "review");
  if (reviews.length)
    parts.push(`${reviews.length} check(s) need human confirmation`);

  if (v.dataConfidence === "unverified") {
    parts.push(
      "ROUTING WARNING — regulatory data unverified. Human confirmation required."
    );
  }

  if (!parts.length) {
    const passes = v.evidence.filter(e => e.result === "pass").length;
    return `All ${passes} required checks passed against verified data.`;
  }
  return parts.join(". ") + ".";
}

/**
 * Gate 7: recompute the verdict from the stored ledger alone. If a decision
 * cannot be reproduced from its own evidence, the evidence was incomplete.
 */
export function reproduceVerdict(evidence: EvidenceEntry[]): Omit<
  RouteVerdict,
  "evidence"
> & {
  evidence: EvidenceEntry[];
} {
  const byAxis = (axis: EvidenceEntry["axis"]) =>
    combineAxis(evidence.filter(e => e.axis === axis).map(e => e.result));

  const legal = byAxis("legal");
  const physicallyFeasible = byAxis("feasible");
  const operationallyPreferred = byAxis("preferred");
  const failingCount = evidence.filter(e => e.result === "fail").length;
  const unknownCount = evidence.filter(e => e.result === "unknown").length;
  const reviewCount = evidence.filter(e => e.result === "review").length;
  const confidences = evidence.map(e => e.confidence);
  const dataConfidence: DataConfidence = confidences.includes("unverified")
    ? "unverified"
    : confidences.includes("operator_supplied")
      ? "operator_supplied"
      : "authority_confirmed";

  let dispatchStatus: DispatchStatus;
  if (legal === "fail" || physicallyFeasible === "fail")
    dispatchStatus = "blocked";
  else if (legal === "unknown" || physicallyFeasible === "unknown")
    dispatchStatus = "warning";
  else if (
    legal === "review" ||
    physicallyFeasible === "review" ||
    reviewCount > 0
  )
    dispatchStatus = "review";
  else if (operationallyPreferred === "unknown") dispatchStatus = "warning";
  else dispatchStatus = "clear";

  const v: RouteVerdict = {
    legal,
    physicallyFeasible,
    operationallyPreferred,
    dataConfidence,
    dispatchStatus,
    evidence,
    failingCount,
    unknownCount,
    reviewCount,
    explanation: "",
  };
  return { ...v, explanation: explainVerdict(v) };
}

/* ===================== offline dataset freshness ===================== */

export type DatasetSnapshot = {
  datasetVersion: string;
  jurisdiction: string;
  capturedAt: Date;
  staleAfterDays: number;
};

export type DatasetFreshness = {
  ageDays: number;
  state: "fresh" | "aging" | "stale";
  message: string;
};

/**
 * Gate 8: offline routing keeps the last verified dataset and states its age
 * plainly. An old map is usable; an old map presented as current is not.
 */
export function assessDatasetFreshness(
  snapshot: DatasetSnapshot,
  now: Date
): DatasetFreshness {
  const ageDays = Math.floor(
    (now.getTime() - snapshot.capturedAt.getTime()) / 86_400_000
  );
  const state: DatasetFreshness["state"] =
    ageDays >= snapshot.staleAfterDays
      ? "stale"
      : ageDays >= snapshot.staleAfterDays * 0.6
        ? "aging"
        : "fresh";

  const message =
    state === "stale"
      ? `Offline ${snapshot.jurisdiction} data is ${ageDays} days old (${snapshot.datasetVersion}) — past its ${snapshot.staleAfterDays}-day review window. Restrictions may have changed.`
      : `Offline ${snapshot.jurisdiction} data is ${ageDays} days old (${snapshot.datasetVersion}).`;

  return { ageDays, state, message };
}
