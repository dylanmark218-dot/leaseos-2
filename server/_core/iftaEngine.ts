/**
 * IFTA — the quarterly return, from the fuel ledger and the distance records.
 *
 * The arithmetic is standard: fleet average consumption from total distance
 * and total fuel; each jurisdiction's taxable litres from its distance at
 * that average; net litres from taxable minus tax-paid litres bought there;
 * tax from net litres at the jurisdiction's rate. Every quantity here is
 * computed from records that say where they came from. The rate is a rule
 * row, and a rule row that nobody has verified makes the tax UNKNOWN — the
 * litres are still reported, the dollars are not invented.
 *
 * The reconciliation figures are honest about their sources. There is no
 * routing source loaded, so "distance reconciled" means distance backed by
 * an instrument — odometer — rather than a person's statement, and the
 * odometer readings on fuel receipts give a second, independent estimate of
 * how far each unit went.
 */

import type { Determination } from "./taxRuleEngine";

export type Quarter = { quarter: string; start: Date; end: Date };

export function quarterBounds(q: string): Quarter {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) throw new Error(`Quarter must look like 2026-Q3, got ${q}`);
  const year = Number(m[1]), n = Number(m[2]);
  const start = new Date(Date.UTC(year, (n - 1) * 3, 1));
  const end = new Date(Date.UTC(year, n * 3, 1));
  return { quarter: q, start, end };
}

/* ------------------------------------------------------------------ */
/* Splitting a trip's distance across jurisdictions                    */
/* ------------------------------------------------------------------ */

export type Split = { jurisdiction: string; fraction: number };

/**
 * A trip's odometer distance, split by the operator's statement of how much
 * was in each jurisdiction. The fractions must sum to one — a split that
 * loses or invents kilometres is refused, not normalised.
 */
export function splitTripDistance(args: { distanceKm: number; distanceSource: "odometer" | "operator_stated"; splits: readonly Split[] }): { ok: true; parts: { jurisdiction: string; distanceKm: number; source: "odometer_split" | "operator_stated" }[] } | { ok: false; refusal: string } {
  if (!(args.distanceKm > 0)) return { ok: false, refusal: "Trip distance must be positive" };
  if (args.splits.length === 0) return { ok: false, refusal: "At least one jurisdiction is required" };
  const seen = new Set<string>();
  for (const s of args.splits) {
    if (s.fraction < 0 || s.fraction > 1) return { ok: false, refusal: `Fraction for ${s.jurisdiction} must be between 0 and 1` };
    if (seen.has(s.jurisdiction)) return { ok: false, refusal: `Jurisdiction ${s.jurisdiction} appears twice` };
    seen.add(s.jurisdiction);
  }
  const total = args.splits.reduce((a, s) => a + s.fraction, 0);
  if (Math.abs(total - 1) > 0.001) return { ok: false, refusal: `Fractions sum to ${total.toFixed(3)}, not 1 — the split loses or invents kilometres` };
  const source = args.distanceSource === "odometer" ? "odometer_split" : "operator_stated";
  return { ok: true, parts: args.splits.filter(s => s.fraction > 0).map(s => ({ jurisdiction: s.jurisdiction, distanceKm: r1(args.distanceKm * s.fraction), source })) };
}

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

export type DistanceRecord = {
  unitId: number;
  jurisdiction: string;
  distanceKm: number;
  periodStart: Date;
  periodEnd: Date;
  source: "gps" | "routing" | "odometer_split" | "operator_stated" | "imported" | "system_inferred";
  verificationStatus: "needs_review" | "verified" | "rejected";
};

export type FuelRecord = {
  fuelRef: string;
  unitId: number | null;
  occurredAt: Date;
  quantityLitres: number | null;
  jurisdiction: string | null;
  jurisdictionSource: string | null;
  receiptEvidenceId: number | null;
  odometerKm: number | null;
  fuelType: string;
};

export type RateLookup = (jurisdiction: string) => Determination<{ ratePerLitre?: number | null }>;

/* ------------------------------------------------------------------ */
/* The return                                                           */
/* ------------------------------------------------------------------ */

export type JurisdictionLine = {
  jurisdiction: string;
  distanceKm: number;
  instrumentKm: number;
  taxPaidLitres: number;
  taxableLitres: number | null;
  netLitres: number | null;
  ratePerLitre: number | null;
  rateStatus: "verified" | "unverified" | "missing";
  taxDue: number | null;
};

export type UnitLine = { unitId: number; byJurisdictionKm: Record<string, number>; totalKm: number; litres: number; odometerImpliedKm: number | null; odometerReadings: number };

export type IftaException = { code: string; severity: "blocking" | "review"; subject: string; detail: string };

export type IftaQuarter = {
  quarter: string;
  periodStart: Date;
  periodEnd: Date;
  units: UnitLine[];
  jurisdictions: JurisdictionLine[];
  totals: { distanceKm: number; litres: number; kmPerLitre: number | null; taxDue: number | null };
  reconciliation: {
    receiptsMatchedPct: number | null;
    fuelJurisdictionKnownPct: number | null;
    distanceInstrumentPct: number | null;
    distanceVerifiedPct: number | null;
    odometerReconciledPct: number | null;
  };
  exceptions: IftaException[];
  determination: "ready" | "review" | "unknown";
  reasons: string[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const INSTRUMENT: ReadonlySet<DistanceRecord["source"]> = new Set<DistanceRecord["source"]>(["gps", "routing", "odometer_split"]);

export function buildIftaQuarter(args: { quarter: string; distances: readonly DistanceRecord[]; fuel: readonly FuelRecord[]; rateFor: RateLookup }): IftaQuarter {
  const q = quarterBounds(args.quarter);
  const inPeriod = (d: Date) => d >= q.start && d < q.end;
  const exceptions: IftaException[] = [];

  // Distance: only records inside the period and not rejected. Needs-review
  // records count (they are the operator's statement) but are flagged.
  const dist = args.distances.filter(d => d.verificationStatus !== "rejected" && d.periodStart >= q.start && d.periodEnd <= q.end);
  const straddling = args.distances.filter(d => d.verificationStatus !== "rejected" && !(d.periodStart >= q.start && d.periodEnd <= q.end) && d.periodEnd > q.start && d.periodStart < q.end);
  for (const s of straddling) exceptions.push({ code: "distance_straddles_quarter", severity: "review", subject: `unit ${s.unitId}`, detail: `${s.distanceKm} km in ${s.jurisdiction} spans the quarter boundary — split it at ${q.start.toISOString().slice(0, 10)} or ${q.end.toISOString().slice(0, 10)}` });
  const needsReview = dist.filter(d => d.verificationStatus === "needs_review");
  if (needsReview.length) exceptions.push({ code: "distance_unverified", severity: "review", subject: "distance", detail: `${needsReview.length} distance record(s) not yet verified` });

  // Fuel: inside the period, litres known.
  const fuel = args.fuel.filter(f => inPeriod(f.occurredAt));
  const fuelNoLitres = fuel.filter(f => f.quantityLitres == null || f.quantityLitres <= 0);
  for (const f of fuelNoLitres) exceptions.push({ code: "fuel_quantity_missing", severity: "blocking", subject: f.fuelRef, detail: "Fuel transaction has no litre quantity" });
  const fuelOk = fuel.filter(f => f.quantityLitres != null && f.quantityLitres > 0);
  const fuelNoJur = fuelOk.filter(f => !f.jurisdiction);
  for (const f of fuelNoJur) exceptions.push({ code: "fuel_jurisdiction_unknown", severity: "blocking", subject: f.fuelRef, detail: "Litres bought in an unknown jurisdiction cannot be credited as tax-paid anywhere" });
  const fuelNoUnit = fuelOk.filter(f => f.unitId == null);
  for (const f of fuelNoUnit) exceptions.push({ code: "fuel_unit_unknown", severity: "review", subject: f.fuelRef, detail: "Fuel not attributed to a unit — counted in fleet totals, not in a unit line" });

  // Units.
  const unitIds = Array.from(new Set([...dist.map(d => d.unitId), ...fuelOk.map(f => f.unitId).filter((x): x is number => x != null)])).sort((a, b) => a - b);
  const units: UnitLine[] = unitIds.map(unitId => {
    const by: Record<string, number> = {};
    for (const d of dist.filter(x => x.unitId === unitId)) by[d.jurisdiction] = r1((by[d.jurisdiction] ?? 0) + d.distanceKm);
    const totalKm = r1(Object.values(by).reduce((a, b) => a + b, 0));
    const uf = fuelOk.filter(f => f.unitId === unitId);
    const litres = r1(uf.reduce((a, f) => a + (f.quantityLitres ?? 0), 0));
    const odos = uf.map(f => f.odometerKm).filter((o): o is number => o != null && o > 0);
    const odometerImpliedKm = odos.length >= 2 ? r1(Math.max(...odos) - Math.min(...odos)) : null;
    if (totalKm === 0 && litres > 0) exceptions.push({ code: "unit_fuel_without_distance", severity: "blocking", subject: `unit ${unitId}`, detail: `${litres} L bought and no distance recorded — the unit moved or the fuel is misattributed` });
    if (totalKm > 0 && litres === 0) exceptions.push({ code: "unit_distance_without_fuel", severity: "review", subject: `unit ${unitId}`, detail: `${totalKm} km recorded and no fuel — bulk-fuelled, or receipts missing` });
    if (odometerImpliedKm != null && totalKm > 0) {
      const ratio = Math.min(odometerImpliedKm, totalKm) / Math.max(odometerImpliedKm, totalKm);
      if (ratio < 0.85) exceptions.push({ code: "odometer_distance_mismatch", severity: "review", subject: `unit ${unitId}`, detail: `Recorded ${totalKm} km; odometer readings on receipts imply about ${odometerImpliedKm} km` });
    }
    return { unitId, byJurisdictionKm: by, totalKm, litres, odometerImpliedKm, odometerReadings: odos.length };
  });

  // Totals and fleet average. Unattributed fuel counts toward the fleet.
  const totalKm = r1(units.reduce((a, u) => a + u.totalKm, 0));
  const totalLitres = r1(fuelOk.reduce((a, f) => a + (f.quantityLitres ?? 0), 0));
  const kmPerLitre = totalLitres > 0 && totalKm > 0 ? r2(totalKm / totalLitres) : null;
  if (kmPerLitre === null && (totalKm > 0 || totalLitres > 0)) exceptions.push({ code: "fleet_average_undefined", severity: "blocking", subject: "fleet", detail: "Fleet average consumption cannot be computed without both distance and fuel" });

  // Jurisdictions.
  const jurs = Array.from(new Set([...dist.map(d => d.jurisdiction), ...fuelOk.map(f => f.jurisdiction).filter((x): x is string => !!x)])).sort();
  const reasons: string[] = [];
  let anyRateUnknown = false;
  const jurisdictions: JurisdictionLine[] = jurs.map(j => {
    const jd = dist.filter(d => d.jurisdiction === j);
    const distanceKm = r1(jd.reduce((a, d) => a + d.distanceKm, 0));
    const instrumentKm = r1(jd.filter(d => INSTRUMENT.has(d.source)).reduce((a, d) => a + d.distanceKm, 0));
    const taxPaidLitres = r1(fuelOk.filter(f => f.jurisdiction === j).reduce((a, f) => a + (f.quantityLitres ?? 0), 0));
    const taxableLitres = kmPerLitre ? r1(distanceKm / kmPerLitre) : null;
    const netLitres = taxableLitres != null ? r1(taxableLitres - taxPaidLitres) : null;
    const det = args.rateFor(j);
    const rate = det.outcome === "determined" && typeof det.parameters?.ratePerLitre === "number" ? det.parameters.ratePerLitre : null;
    const rateStatus: JurisdictionLine["rateStatus"] = rate != null ? "verified" : /unverified/i.test(det.reason ?? "") ? "unverified" : "missing";
    if (rate == null) { anyRateUnknown = true; reasons.push(`${j}: fuel tax rate ${rateStatus} — tax cannot be computed`); }
    const taxDue = rate != null && netLitres != null ? r2(netLitres * rate) : null;
    return { jurisdiction: j, distanceKm, instrumentKm, taxPaidLitres, taxableLitres, netLitres, ratePerLitre: rate, rateStatus, taxDue };
  });
  const taxDue = anyRateUnknown || jurisdictions.some(l => l.taxDue == null) ? null : r2(jurisdictions.reduce((a, l) => a + (l.taxDue ?? 0), 0));

  // Reconciliation.
  const instrumentKm = r1(dist.filter(d => INSTRUMENT.has(d.source)).reduce((a, d) => a + d.distanceKm, 0));
  const verifiedKm = r1(dist.filter(d => d.verificationStatus === "verified").reduce((a, d) => a + d.distanceKm, 0));
  const withOdo = units.filter(u => u.odometerImpliedKm != null && u.totalKm > 0);
  const odometerReconciledPct = withOdo.length
    ? Math.round(withOdo.reduce((a, u) => a + Math.min(u.odometerImpliedKm!, u.totalKm) / Math.max(u.odometerImpliedKm!, u.totalKm), 0) / withOdo.length * 1000) / 10
    : null;
  const reconciliation = {
    receiptsMatchedPct: pct(fuel.filter(f => f.receiptEvidenceId != null).length, fuel.length),
    fuelJurisdictionKnownPct: pct(fuelOk.length - fuelNoJur.length, fuelOk.length),
    distanceInstrumentPct: pct(instrumentKm, totalKm),
    distanceVerifiedPct: pct(verifiedKm, totalKm),
    odometerReconciledPct,
  };

  const blocking = exceptions.filter(e => e.severity === "blocking");
  const determination: IftaQuarter["determination"] = anyRateUnknown ? "unknown" : blocking.length ? "review" : exceptions.length ? "review" : "ready";
  if (blocking.length) reasons.unshift(`${blocking.length} blocking exception(s)`);
  return { quarter: q.quarter, periodStart: q.start, periodEnd: q.end, units, jurisdictions, totals: { distanceKm: totalKm, litres: totalLitres, kmPerLitre, taxDue }, reconciliation, exceptions, determination, reasons };
}

/** What may be finalized: a return with no blocking exceptions and a computed tax. */
export function finalizeDecision(q: IftaQuarter): { permitted: boolean; refusals: string[] } {
  const refusals: string[] = [];
  if (q.determination === "unknown") refusals.push("Tax is UNKNOWN — a fuel tax rate has not been verified; a return cannot be finalized on an invented rate");
  for (const e of q.exceptions.filter(x => x.severity === "blocking")) refusals.push(`${e.code}: ${e.detail}`);
  return { permitted: refusals.length === 0, refusals };
}
