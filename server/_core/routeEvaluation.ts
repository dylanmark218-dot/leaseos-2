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

/** The vehicle values a check compares against. */
export type VehicleValues = {
  grossWeightKg: number;
  maxAxleGroupKg: number;
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
    const passes = vehicleValue <= attr.limitValue;
    return {
      ...base,
      // An unverified limit that the vehicle satisfies is still not a clean
      // pass — a human should confirm the number before relying on it.
      result: passes
        ? base.confidence === "unverified"
          ? "review"
          : "pass"
        : "fail",
      reason: passes
        ? `${vehicleValue} ${numeric.unit} within ${attr.limitValue} ${numeric.unit} on ${segment.label}`
        : `${vehicleValue} ${numeric.unit} exceeds ${attr.limitValue} ${numeric.unit} on ${segment.label}`,
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

export function evaluateRoute(
  requiredChecks: RequiredCheck[],
  segments: RoadSegmentInput[],
  vehicle: VehicleValues
): RouteVerdict {
  const evidence: EvidenceEntry[] = [];

  for (const segment of segments) {
    for (const check of requiredChecks) {
      const attr = segment.attributes.find(a => a.check === check);
      evidence.push(evaluateCheck(check, attr, vehicle, segment));
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
