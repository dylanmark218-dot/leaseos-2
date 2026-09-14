/**
 * Bulk fuel, statement reconciliation, anomalies.
 *
 * Three questions, each a pure function of records that say where they came
 * from:
 *
 *   What should be in the tank, and what is?   in − out versus the reading.
 *   Which statement lines have no receipt?      the purchases nobody scanned.
 *   Which fills do not add up?                  more than the tank holds, two
 *                                               fills an hour apart, an
 *                                               odometer that went backwards,
 *                                               consumption far off the
 *                                               unit's own norm.
 *
 * A variance tolerance is a company's parameter about its own yard, not a
 * regulatory figure; a match window is a company's tolerance for card-clock
 * drift. Neither claims to be law.
 */

import { matchStatementLine, type StatementLine } from "./fuelLedger";

const r1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/* Tank reconciliation                                                  */
/* ------------------------------------------------------------------ */

export type TankMovement = { kind: "purchase" | "dispense"; litres: number; at: Date };
export type TankReading = { at: Date; litresOnHand: number; method: string };

export type TankReconciliation = {
  openingLitres: number | null;
  purchasedLitres: number;
  dispensedLitres: number;
  expectedLitres: number | null;
  measuredLitres: number | null;
  varianceLitres: number | null;
  variancePct: number | null;
  withinTolerance: boolean | null;
  reason: string;
};

/**
 * Between two readings: expected = opening + in − out; variance = measured −
 * expected. Positive variance is fuel that appeared; negative is fuel that
 * left without a dispense — theft, leak, or an unrecorded fill.
 */
export function reconcileTank(args: { opening: TankReading | null; closing: TankReading | null; movements: readonly TankMovement[]; capacityLitres: number; tolerancePct: number }): TankReconciliation {
  const from = args.opening?.at ?? null;
  const to = args.closing?.at ?? null;
  const inWindow = (m: TankMovement) => (!from || m.at > from) && (!to || m.at <= to);
  const mv = args.movements.filter(inWindow);
  const purchased = r1(mv.filter(m => m.kind === "purchase").reduce((a, m) => a + m.litres, 0));
  const dispensed = r1(mv.filter(m => m.kind === "dispense").reduce((a, m) => a + m.litres, 0));
  if (!args.opening || !args.closing) {
    return { openingLitres: args.opening?.litresOnHand ?? null, purchasedLitres: purchased, dispensedLitres: dispensed, expectedLitres: null, measuredLitres: args.closing?.litresOnHand ?? null, varianceLitres: null, variancePct: null, withinTolerance: null, reason: "Two readings are needed to reconcile — an opening and a closing" };
  }
  const expected = r1(args.opening.litresOnHand + purchased - dispensed);
  const measured = args.closing.litresOnHand;
  const variance = r1(measured - expected);
  const base = Math.max(expected, 1);
  const pct = Math.round((variance / base) * 1000) / 10;
  const within = Math.abs(pct) <= args.tolerancePct;
  const over = expected > args.capacityLitres;
  return {
    openingLitres: args.opening.litresOnHand, purchasedLitres: purchased, dispensedLitres: dispensed, expectedLitres: expected, measuredLitres: measured,
    varianceLitres: variance, variancePct: pct, withinTolerance: within && !over,
    reason: over ? `Expected ${expected} L exceeds the tank's ${args.capacityLitres} L capacity — a purchase or reading is wrong`
      : within ? `Variance ${variance} L (${pct}%) within ${args.tolerancePct}%`
      : variance < 0 ? `${-variance} L (${-pct}%) left the tank without a dispense — unrecorded fill, leak or theft`
      : `${variance} L (${pct}%) more than expected — an unrecorded purchase or a misread`,
  };
}

/* ------------------------------------------------------------------ */
/* Statement reconciliation                                             */
/* ------------------------------------------------------------------ */

export type LedgerFuel = { id: number; fuelRef: string; cardLastFour: string | null; occurredAt: Date; total: number; quantity: number | null; unitNumber: string | null; statementLineId: number | null };

export type LineResult = {
  lineNo: number;
  outcome: "match" | "match_with_variance" | "unmatched" | "ambiguous";
  matchedFuelId: number | null;
  reason: string;
};

/**
 * Each line finds its transaction, if it has one. A line that matches two
 * transactions is ambiguous, not matched to the first; a transaction already
 * matched to another line is not available. Unmatched lines are the finding.
 */
export function reconcileStatement(args: { lines: readonly (StatementLine & { lineNo: number })[]; ledger: readonly LedgerFuel[]; windowHours?: number }): { results: LineResult[]; counts: { match: number; match_with_variance: number; unmatched: number; ambiguous: number }; receiptsWithoutLine: LedgerFuel[] } {
  const taken = new Set<number>(args.ledger.filter(t => t.statementLineId != null).map(t => t.id));
  const results: LineResult[] = [];
  for (const line of args.lines) {
    const candidates = args.ledger
      .filter(t => !taken.has(t.id))
      .map(t => ({ t, m: matchStatementLine({ transaction: { cardLastFour: t.cardLastFour, occurredAt: t.occurredAt, total: t.total, quantity: t.quantity, unitNumber: t.unitNumber }, line, windowHours: args.windowHours }) }))
      .filter(x => x.m.outcome !== "no_match");
    if (candidates.length === 0) { results.push({ lineNo: line.lineNo, outcome: "unmatched", matchedFuelId: null, reason: "No receipt on the ledger for this purchase — nobody scanned it" }); continue; }
    const exact = candidates.filter(c => c.m.outcome === "match");
    const pool = exact.length ? exact : candidates;
    if (pool.length > 1) { results.push({ lineNo: line.lineNo, outcome: "ambiguous", matchedFuelId: null, reason: `${pool.length} receipts could be this purchase (${pool.map(c => c.t.fuelRef).join(", ")}) — a person decides` }); continue; }
    const { t, m } = pool[0]!;
    taken.add(t.id);
    results.push({ lineNo: line.lineNo, outcome: m.outcome === "match" ? "match" : "match_with_variance", matchedFuelId: t.id, reason: m.outcome === "match_with_variance" ? `${m.reason}: ${m.variances.join("; ")}` : m.reason });
  }
  const counts = { match: 0, match_with_variance: 0, unmatched: 0, ambiguous: 0 };
  for (const r of results) counts[r.outcome]++;
  // Receipts on a company card in the period that no line claimed: not on the statement.
  const from = args.lines.length ? new Date(Math.min(...args.lines.map(l => l.occurredAt.getTime()))) : null;
  const to = args.lines.length ? new Date(Math.max(...args.lines.map(l => l.occurredAt.getTime()))) : null;
  const receiptsWithoutLine = args.ledger.filter(t => !taken.has(t.id) && t.cardLastFour && from && to && t.occurredAt >= from && t.occurredAt <= to);
  return { results, counts, receiptsWithoutLine };
}

/* ------------------------------------------------------------------ */
/* Anomalies                                                            */
/* ------------------------------------------------------------------ */

export type FillRecord = { fuelRef: string; unitId: number | null; occurredAt: Date; quantityLitres: number | null; odometerKm: number | null; cardLastFour: string | null };

export type FuelAnomaly = { code: "fill_exceeds_capacity" | "fills_too_close" | "odometer_regressed" | "consumption_outlier"; severity: "high" | "medium"; fuelRef: string; unitId: number | null; detail: string };

/** A unit's fills in order, compared with the tank it has and with its own history. */
export function fuelAnomalies(args: { fills: readonly FillRecord[]; tankCapacityByUnit: ReadonlyMap<number, number>; minHoursBetweenFills?: number; outlierFactor?: number }): FuelAnomaly[] {
  const out: FuelAnomaly[] = [];
  const minHours = args.minHoursBetweenFills ?? 2;
  const factor = args.outlierFactor ?? 2;
  const byUnit = new Map<number, FillRecord[]>();
  for (const f of args.fills) if (f.unitId != null) byUnit.set(f.unitId, [...(byUnit.get(f.unitId) ?? []), f]);
  for (const [unitId, fills] of Array.from(byUnit.entries())) {
    const sorted = [...fills].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const cap = args.tankCapacityByUnit.get(unitId);
    const rates: { fuelRef: string; lPer100: number }[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i]!;
      if (cap != null && f.quantityLitres != null && f.quantityLitres > cap * 1.02) out.push({ code: "fill_exceeds_capacity", severity: "high", fuelRef: f.fuelRef, unitId, detail: `${f.quantityLitres} L into a ${cap} L tank` });
      const prev = sorted[i - 1];
      if (prev) {
        const hours = (f.occurredAt.getTime() - prev.occurredAt.getTime()) / 3_600_000;
        if (hours < minHours && (f.quantityLitres ?? 0) > 20 && (prev.quantityLitres ?? 0) > 20) out.push({ code: "fills_too_close", severity: "medium", fuelRef: f.fuelRef, unitId, detail: `${r1(hours)} h after ${prev.fuelRef}` });
        if (f.odometerKm != null && prev.odometerKm != null) {
          if (f.odometerKm < prev.odometerKm) out.push({ code: "odometer_regressed", severity: "high", fuelRef: f.fuelRef, unitId, detail: `Odometer ${f.odometerKm} km after ${prev.odometerKm} km on ${prev.fuelRef}` });
          else if (f.odometerKm > prev.odometerKm && f.quantityLitres != null) rates.push({ fuelRef: f.fuelRef, lPer100: (f.quantityLitres / (f.odometerKm - prev.odometerKm)) * 100 });
        }
      }
    }
    if (rates.length >= 4) {
      const sortedRates = [...rates].sort((a, b) => a.lPer100 - b.lPer100);
      const median = sortedRates[Math.floor(sortedRates.length / 2)]!.lPer100;
      for (const r of rates) if (r.lPer100 > median * factor) out.push({ code: "consumption_outlier", severity: "medium", fuelRef: r.fuelRef, unitId, detail: `${r1(r.lPer100)} L/100 km against the unit's median ${r1(median)}` });
    }
  }
  return out;
}
