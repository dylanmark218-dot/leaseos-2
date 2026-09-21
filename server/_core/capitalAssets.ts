/**
 * Capital assets and CCA — the engines.
 *
 * The pool is arithmetic on facts: opening UCC, additions at cost,
 * dispositions at the lesser of cost and proceeds, recapture when the pool
 * goes negative, terminal loss when the class empties with a balance. The
 * CLAIM needs a rate, and the rate is a rule: unverified means the claim is
 * UNKNOWN with the reason — the closing UCC then cannot be stated either,
 * because it depends on the claim. The half-year rule and any accelerated
 * incentive are parameters of the same rule, never assumed.
 *
 * The twin adds what a unit has cost across fuel, shop and tires against
 * what it has done, and names every part it cannot know.
 */

import type { Determination } from "./taxRuleEngine";

export type ClassRule = { ratePercent: number | null; halfYearRule: boolean | null; firstYearFactor: number | null };
export type RateLookup = (ccaClass: string) => Determination<Partial<ClassRule>>;

export type PoolInput = { ccaClass: string; openingUccCents: number; additions: { assetRef: string; costCents: number }[]; dispositions: { assetRef: string; costCents: number; proceedsCents: number }[]; classEmptiedAfterDispositions: boolean };

export type PoolResult = {
  ccaClass: string;
  openingUccCents: number;
  additionsCents: number;
  dispositionsCents: number;
  uccBeforeClaimCents: number;
  recaptureCents: number;
  terminalLossCents: number;
  ccaClaimCents: number | null;
  closingUccCents: number | null;
  rate: { status: "verified" | "unverified" | "missing"; ratePercent: number | null; halfYearApplied: boolean | null };
  determination: "computed" | "unknown";
  reasons: string[];
};

export function ccaPool(input: PoolInput, det: Determination<Partial<ClassRule>>): PoolResult {
  const reasons: string[] = [];
  const additions = input.additions.reduce((a, x) => a + x.costCents, 0);
  const dispositions = input.dispositions.reduce((a, x) => a + Math.min(x.costCents, x.proceedsCents), 0);
  for (const d of input.dispositions) if (d.proceedsCents > d.costCents) reasons.push(`${d.assetRef}: proceeds exceed cost — the excess is a capital gain, outside this schedule`);
  const balance = input.openingUccCents + additions - dispositions;
  let recapture = 0, terminalLoss = 0, uccBefore = balance;
  if (balance < 0) { recapture = -balance; uccBefore = 0; }
  else if (input.classEmptiedAfterDispositions && balance > 0) { terminalLoss = balance; uccBefore = 0; }
  const rateKnown = det.outcome === "determined" && typeof det.parameters?.ratePercent === "number";
  const rateStatus: PoolResult["rate"]["status"] = rateKnown ? "verified" : /unverified/i.test(det.reason ?? "") ? "unverified" : "missing";
  if (!rateKnown) {
    reasons.push(`Rate for ${input.ccaClass} is ${rateStatus} — the claim and the closing UCC cannot be computed until a person verifies the class rate`);
    return { ccaClass: input.ccaClass, openingUccCents: input.openingUccCents, additionsCents: additions, dispositionsCents: dispositions, uccBeforeClaimCents: uccBefore, recaptureCents: recapture, terminalLossCents: terminalLoss, ccaClaimCents: null, closingUccCents: null, rate: { status: rateStatus, ratePercent: null, halfYearApplied: null }, determination: "unknown", reasons };
  }
  const rate = det.parameters!.ratePercent as number;
  const halfYear = det.parameters!.halfYearRule;
  const firstYearFactor = det.parameters!.firstYearFactor;
  if (halfYear == null) reasons.push("The rule does not say whether the half-year rule applies — net additions are claimed at the full rate; REVIEW");
  const netAdditions = Math.max(0, additions - dispositions);
  const base = uccBefore - netAdditions;
  const additionsBase = halfYear === true ? netAdditions * (typeof firstYearFactor === "number" ? firstYearFactor : 0.5) : netAdditions;
  const claim = uccBefore === 0 ? 0 : Math.round((Math.max(0, base) + additionsBase) * rate / 100);
  return { ccaClass: input.ccaClass, openingUccCents: input.openingUccCents, additionsCents: additions, dispositionsCents: dispositions, uccBeforeClaimCents: uccBefore, recaptureCents: recapture, terminalLossCents: terminalLoss, ccaClaimCents: claim, closingUccCents: uccBefore - claim, rate: { status: "verified", ratePercent: rate, halfYearApplied: halfYear === true }, determination: reasons.length ? "unknown" : "computed", reasons };
}

export type ScheduleAsset = { assetRef: string; ccaClass: string | null; ccaClassVerified: boolean; acquiredAt: Date; acquisitionCostCents: number; disposedAt: Date | null; disposalProceedsCents: number | null; status: string };

export function buildSchedule(args: { fiscalYearStart: Date; fiscalYearEnd: Date; assets: readonly ScheduleAsset[]; openingByClass: ReadonlyMap<string, number>; rateFor: RateLookup }): { pools: PoolResult[]; unclassified: { assetRef: string; reason: string }[]; totalClaimCents: number | null; determination: "computed" | "partial" | "unknown"; reasons: string[] } {
  const inYear = (d: Date) => d >= args.fiscalYearStart && d <= args.fiscalYearEnd;
  const unclassified: { assetRef: string; reason: string }[] = [];
  const byClass = new Map<string, PoolInput>();
  for (const a of args.assets) {
    if (a.status === "pending_capital_review" || a.status === "expensed") continue;
    if (!a.ccaClass) { unclassified.push({ assetRef: a.assetRef, reason: "No CCA class candidate" }); continue; }
    if (!a.ccaClassVerified) { unclassified.push({ assetRef: a.assetRef, reason: `Class ${a.ccaClass} is a candidate, not verified` }); continue; }
    const p = byClass.get(a.ccaClass) ?? { ccaClass: a.ccaClass, openingUccCents: args.openingByClass.get(a.ccaClass) ?? 0, additions: [], dispositions: [], classEmptiedAfterDispositions: false };
    if (inYear(a.acquiredAt)) p.additions.push({ assetRef: a.assetRef, costCents: a.acquisitionCostCents });
    if (a.disposedAt && inYear(a.disposedAt)) p.dispositions.push({ assetRef: a.assetRef, costCents: a.acquisitionCostCents, proceedsCents: a.disposalProceedsCents ?? 0 });
    byClass.set(a.ccaClass, p);
  }
  for (const [cls, p] of Array.from(byClass.entries())) {
    const remaining = args.assets.filter(a => a.ccaClass === cls && a.ccaClassVerified && a.status !== "disposed" && a.status !== "expensed" && a.status !== "pending_capital_review");
    p.classEmptiedAfterDispositions = remaining.length === 0 && p.dispositions.length > 0;
  }
  const pools = Array.from(byClass.values()).map(p => ccaPool(p, args.rateFor(p.ccaClass)));
  const reasons = [...unclassified.map(u => `${u.assetRef}: ${u.reason}`), ...pools.flatMap(p => p.reasons)];
  const allKnown = pools.every(p => p.ccaClaimCents != null);
  const total = allKnown ? pools.reduce((a, p) => a + (p.ccaClaimCents ?? 0), 0) : null;
  return { pools, unclassified, totalClaimCents: total, determination: unclassified.length === 0 && allKnown && reasons.length === 0 ? "computed" : pools.some(p => p.ccaClaimCents != null) ? "partial" : "unknown", reasons };
}

export function capitalizationProposal(args: { costCents: number; thresholdCents: number | null; description: string }): { proposal: "capitalize" | "expense" | "review"; reason: string } {
  if (args.thresholdCents == null) return { proposal: "review", reason: "No capitalization threshold is configured for this entity — a person decides" };
  return args.costCents >= args.thresholdCents ? { proposal: "capitalize", reason: `${fmt(args.costCents)} is at or above the ${fmt(args.thresholdCents)} threshold` } : { proposal: "expense", reason: `${fmt(args.costCents)} is below the ${fmt(args.thresholdCents)} threshold` };
}

export function fiscalYearFor(now: Date, endMonth: number, endDay: number): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  let end = new Date(Date.UTC(y, endMonth - 1, endDay, 23, 59, 59));
  if (now > end) end = new Date(Date.UTC(y + 1, endMonth - 1, endDay, 23, 59, 59));
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, endMonth - 1, endDay + 1));
  return { start, end };
}

/* ---- the twin ---- */

export type TwinInput = {
  asset: { acquisitionCostCents: number; acquiredAt: Date; expectedLifeKm: number | null; expectedLifeYears: number | null; financing: string; status: string } | null;
  fuel: { cents: number | null; litres: number | null; transactions: number };
  shop: { partsCents: number; labourCents: number | null; reasons: string[] };
  tires: { costPerKmCentsKnown: number[]; unknownRuns: number };
  distanceKm: number | null;
  engineHours: number | null;
  downtimeHours: number | null;
  trips: number;
  asOf: Date;
};

export function assetTwin(t: TwinInput): { operatingCostCents: number | null; knownCostCents: number; costPerKmCents: number | null; costPerHourCents: number | null; fuelLitresPer100Km: number | null; downtimeHours: number | null; replacement: { projectedAt: Date | null; basis: string }; determination: "computed" | "partial" | "unknown"; unknowns: string[] } {
  const unknowns: string[] = [];
  if (!t.asset) unknowns.push("No capital asset record — acquisition cost and life are unknown");
  if (t.fuel.cents == null) unknowns.push("Fuel cost unknown — no company-paid fuel transactions carry a total");
  if (t.shop.labourCents == null) unknowns.push("Shop labour cost unknown — no labour rate configured");
  unknowns.push(...t.shop.reasons.filter(r => !r.includes("Labour rate")));
  if (t.tires.unknownRuns) unknowns.push(`${t.tires.unknownRuns} tire run(s) without both odometers`);
  if (t.distanceKm == null) unknowns.push("Distance unknown — no completed trips with a recorded distance");
  const known = (t.fuel.cents ?? 0) + t.shop.partsCents + (t.shop.labourCents ?? 0);
  const operating = t.fuel.cents != null && t.shop.labourCents != null && t.shop.reasons.length === 0 ? known : null;
  const perKm = operating != null && t.distanceKm != null && t.distanceKm > 0 ? Math.round(operating / t.distanceKm * 100) / 100 : null;
  const perHour = operating != null && t.engineHours != null && t.engineHours > 0 ? Math.round(operating / t.engineHours) : null;
  const l100 = t.fuel.litres != null && t.distanceKm != null && t.distanceKm > 0 ? Math.round(t.fuel.litres / t.distanceKm * 100 * 10) / 10 : null;
  let projectedAt: Date | null = null, basis = "No expected life on the asset — replacement is not projected";
  if (t.asset?.expectedLifeYears) { projectedAt = new Date(t.asset.acquiredAt.getTime() + t.asset.expectedLifeYears * 365.25 * 86_400_000); basis = `Owner-stated life of ${t.asset.expectedLifeYears} years from acquisition`; }
  if (t.asset?.expectedLifeKm && t.distanceKm != null && t.distanceKm > 0) {
    const days = (t.asOf.getTime() - t.asset.acquiredAt.getTime()) / 86_400_000;
    if (days > 30) { const kmPerDay = t.distanceKm / days; const byKm = new Date(t.asset.acquiredAt.getTime() + (t.asset.expectedLifeKm / kmPerDay) * 86_400_000); if (!projectedAt || byKm < projectedAt) { projectedAt = byKm; basis = `Owner-stated life of ${t.asset.expectedLifeKm} km at the observed ${Math.round(kmPerDay)} km/day`; } }
  }
  return { operatingCostCents: operating, knownCostCents: known, costPerKmCents: perKm, costPerHourCents: perHour, fuelLitresPer100Km: l100, downtimeHours: t.downtimeHours, replacement: { projectedAt, basis }, determination: unknowns.length === 0 ? "computed" : known > 0 || t.distanceKm != null ? "partial" : "unknown", unknowns };
}

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
