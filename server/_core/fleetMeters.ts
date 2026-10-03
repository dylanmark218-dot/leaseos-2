/**
 * Fleet & Equipment Portfolio — a unit's meters, read, and the seam maintenance scheduling calls.
 *
 * Pure. The caller gathers observations from where they live; nothing here stores or copies a figure.
 *
 * A unit's odometer and hour meters are recorded in six places — telemetry snapshots, work orders,
 * fuel transactions, trips, tire installations and measurements — plus the portfolio's own ledger for
 * readings with no other home. Master-manifest rule 3 forbids copying those figures into a new table,
 * so they are read in place and put in one sequence here, each observation keeping its source.
 *
 * The owner's rule (2026-09-25): a reading that regresses below a previously accepted reading makes
 * distance-based maintenance evaluation return an explicit cannot-evaluate state, with the
 * machine-readable reason `METER_REGRESSION`. The reading that went down is kept as evidence — it is
 * never repaired, dropped or overwritten here — and the decrease is never read as service progress.
 *
 * Standing (docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md, R-3):
 *   accepted    — a telemetry, work-order, trip, fuel-receipt or tire-service figure, each written in
 *                 its own domain, or a ledger reading a second person verified;
 *   provisional — a ledger reading nobody has verified: shown, never the current value, but it can
 *                 expose a regression;
 *   rejected    — a ledger reading a second person rejected: kept and shown, takes no part.
 */

export type MeterType = "odometer_km" | "engine_hours" | "pto_hours" | "pump_hours" | "blower_hours" | "compressor_hours" | "generator_hours" | "other";
export const METER_TYPES: readonly MeterType[] = ["odometer_km", "engine_hours", "pto_hours", "pump_hours", "blower_hours", "compressor_hours", "generator_hours", "other"];

export type ObservationSource = "telematics" | "work_order" | "tire_service" | "trip" | "fuel_receipt" | "ledger";
export type Standing = "accepted" | "provisional" | "rejected";

export type MeterObservation = {
  /** Stable, unique across sources: `<table>#<id>.<field>`. */
  ref: string;
  meterType: MeterType;
  value: number;
  recordedAt: Date;
  source: ObservationSource;
  standing: Standing;
  /** Where it lives, so a reader can go and look. */
  sourceTable: string;
  sourceId: number;
  sourceField: string;
  /** Ledger rows only: the ledger's own source (mechanic, inspection, …) and reference. */
  ledgerSource?: string | null;
};

/** Reasons a caller can branch on. */
export const METER_REGRESSION = "METER_REGRESSION" as const;
export const UNTRUSTED_METER_SEQUENCE = "UNTRUSTED_METER_SEQUENCE" as const;

/**
 * Two observations are compared after rounding to one decimal of the meter's unit (R-5), so a source
 * that stores 120000.04 km and another that stores 120000 do not manufacture a regression.
 */
export const comparable = (v: number) => Math.round(v * 10) / 10;

/** Ties in time break by source precedence, then by reference — the same input always sorts the same. */
const PRECEDENCE: Record<ObservationSource, number> = { telematics: 0, work_order: 1, tire_service: 2, trip: 3, fuel_receipt: 4, ledger: 5 };
export function chronological(a: MeterObservation, b: MeterObservation): number {
  return a.recordedAt.getTime() - b.recordedAt.getTime() || PRECEDENCE[a.source] - PRECEDENCE[b.source] || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

export type Regression = { code: typeof METER_REGRESSION; earlier: MeterObservation; later: MeterObservation; drop: number };

export type MeterSequence = {
  meterType: MeterType;
  /** Every observation, rejected included, oldest first. Nothing is removed. */
  observations: MeterObservation[];
  /** The newest accepted observation, or null. A provisional reading is never the current value. */
  current: MeterObservation | null;
  regressions: Regression[];
  trust: "trusted" | typeof UNTRUSTED_METER_SEQUENCE | "no_accepted_reading";
};

/**
 * Every later observation (accepted or provisional) that is lower than an earlier accepted one.
 * O(n²) in the worst case over one unit's one meter; the caller bounds n.
 */
function regressionsIn(obs: readonly MeterObservation[]): Regression[] {
  const out: Regression[] = [];
  let highest: MeterObservation | null = null;   // the highest accepted observation seen so far
  for (const o of obs) {
    if (o.standing === "rejected") continue;
    if (highest && comparable(o.value) < comparable(highest.value)) {
      out.push({ code: METER_REGRESSION, earlier: highest, later: o, drop: comparable(highest.value - o.value) });
    }
    if (o.standing === "accepted" && (!highest || comparable(o.value) >= comparable(highest.value))) highest = o;
  }
  return out;
}

export function meterSequence(all: readonly MeterObservation[], meterType: MeterType): MeterSequence {
  const observations = all.filter(o => o.meterType === meterType).sort(chronological);
  const accepted = observations.filter(o => o.standing === "accepted");
  const regressions = regressionsIn(observations);
  return {
    meterType,
    observations,
    current: accepted.length ? accepted[accepted.length - 1] : null,
    regressions,
    trust: regressions.length ? UNTRUSTED_METER_SEQUENCE : accepted.length ? "trusted" : "no_accepted_reading",
  };
}

export type MeterProgress =
  | { status: "evaluable"; meterType: MeterType; baseline: MeterObservation; current: MeterObservation; progress: number }
  | {
      status: "indeterminate";
      meterType: MeterType;
      reason: typeof METER_REGRESSION | "NO_BASELINE" | "BASELINE_NOT_ACCEPTED" | "NO_CURRENT_READING";
      detail: string;
      regressions: Regression[];
    };

/**
 * How far this meter has moved since a baseline observation — the question a service interval asks
 * ("10,000 km since the last oil change"). This is the seam maintenance scheduling calls.
 *
 * `indeterminate` is an answer, not an error: the service is neither due nor not due. A regression
 * anywhere from the baseline onward (the baseline included as the earlier side) makes the progress
 * `METER_REGRESSION`, because a decrease is not distance travelled and nothing after it can be trusted
 * to count from the baseline. A regression wholly before the baseline does not: once a verified reading
 * starts a new baseline — in practice at the next service — evaluation resumes, and the drop that came
 * before stays on record, unrepaired.
 */
export function meterProgress(all: readonly MeterObservation[], meterType: MeterType, baselineRef: string | null): MeterProgress {
  const seq = meterSequence(all, meterType);
  const empty = (reason: "NO_BASELINE" | "BASELINE_NOT_ACCEPTED" | "NO_CURRENT_READING", detail: string): MeterProgress =>
    ({ status: "indeterminate", meterType, reason, detail, regressions: [] });
  if (!baselineRef) return empty("NO_BASELINE", "No baseline reading — nothing to count from");
  const baseline = seq.observations.find(o => o.ref === baselineRef);
  if (!baseline) return empty("NO_BASELINE", `Baseline ${baselineRef} is not a ${meterType} reading on this unit`);
  if (baseline.standing !== "accepted") return empty("BASELINE_NOT_ACCEPTED", `Baseline ${baselineRef} is ${baseline.standing}, not accepted`);
  const fromBaseline = seq.observations.filter(o => chronological(o, baseline) >= 0);
  const regressions = regressionsIn(fromBaseline);
  if (regressions.length) {
    const r = regressions[0];
    return {
      status: "indeterminate", meterType, reason: METER_REGRESSION, regressions,
      detail: `${meterType} went down from ${r.earlier.value} (${r.earlier.ref}) to ${r.later.value} (${r.later.ref}); a decrease is not service progress`,
    };
  }
  const acceptedAfter = fromBaseline.filter(o => o.standing === "accepted");
  const current = acceptedAfter[acceptedAfter.length - 1];
  if (!current) return empty("NO_CURRENT_READING", "No accepted reading at or after the baseline");
  return { status: "evaluable", meterType, baseline, current, progress: comparable(current.value - baseline.value) };
}
