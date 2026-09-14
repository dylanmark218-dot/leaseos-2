/**
 * Fleet Shop — the engines.
 *
 * Stock is a derivation over movements: on-hand is the signed sum, average
 * cost is weighted over receives, cores outstanding are outs less returns.
 * An issue beyond on-hand is refused with the shortfall named. A count is
 * an adjustment movement with the variance kept, never an overwrite.
 *
 * A tire is installed in exactly one position on one unit at a time. Its
 * kilometres run exist only when both odometers were recorded; its cost per
 * kilometre only when kilometres and cost exist. Otherwise UNKNOWN, with the
 * reason — a tire nobody measured is not a cheap tire.
 *
 * A warranty claim is eligible only under a VERIFIED policy still in
 * coverage; an unverified policy makes the answer unknown, not eligible.
 * The claim is raised by one person and decided by another.
 */

export type MovementKind = "receive" | "issue" | "return_to_stock" | "adjust_count" | "core_out" | "core_returned" | "warranty_return" | "scrap" | "transfer_in" | "transfer_out";
export type Movement = { partId: number; bin: string; kind: MovementKind; qtySigned: number; unitCostCents: number | null; at: Date };

/** The sign of a movement is decided by its kind; a caller supplies a positive quantity. */
export function signedQty(kind: MovementKind, qty: number): number {
  if (qty <= 0) throw new Error("Quantity must be positive");
  switch (kind) {
    case "receive": case "return_to_stock": case "transfer_in": return qty;
    case "issue": case "scrap": case "transfer_out": case "warranty_return": return -qty;
    case "core_out": case "core_returned": return qty; // core counts are tracked separately; the part count does not move
    case "adjust_count": throw new Error("A count adjustment is computed from the counted quantity, not supplied");
  }
}

export type StockPosition = { partId: number; bin: string; onHandQty: number; avgUnitCostCents: number | null; coresOutstanding: number; lastMovementAt: Date | null };

export function stockPositions(movements: readonly Movement[]): StockPosition[] {
  const by = new Map<string, StockPosition & { costQty: number; costSum: number }>();
  for (const m of [...movements].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const k = `${m.partId}|${m.bin}`;
    const p = by.get(k) ?? { partId: m.partId, bin: m.bin, onHandQty: 0, avgUnitCostCents: null, coresOutstanding: 0, lastMovementAt: null, costQty: 0, costSum: 0 };
    if (m.kind === "core_out") p.coresOutstanding += m.qtySigned;
    else if (m.kind === "core_returned") p.coresOutstanding -= m.qtySigned;
    else p.onHandQty += m.qtySigned;
    if (m.kind === "receive" && m.unitCostCents != null) { p.costQty += m.qtySigned; p.costSum += m.qtySigned * m.unitCostCents; p.avgUnitCostCents = Math.round(p.costSum / p.costQty); }
    p.lastMovementAt = m.at;
    by.set(k, p);
  }
  return Array.from(by.values()).map(({ costQty: _q, costSum: _s, ...rest }) => rest);
}

export function issueDecision(args: { onHandQty: number; qty: number; partNumber: string }): { permitted: boolean; refusal: string | null } {
  if (args.qty <= 0) return { permitted: false, refusal: "Quantity must be positive" };
  if (args.qty > args.onHandQty) return { permitted: false, refusal: `${args.partNumber}: ${args.onHandQty} on hand, ${args.qty} requested — short by ${args.qty - args.onHandQty}; receive stock or record the shortage` };
  return { permitted: true, refusal: null };
}

export function countAdjustment(onHandQty: number, countedQty: number): { qtySigned: number; variance: number; finding: string | null } {
  const delta = countedQty - onHandQty;
  return { qtySigned: delta, variance: delta, finding: delta === 0 ? null : `Count ${countedQty} against ${onHandQty} on record — variance ${delta > 0 ? "+" : ""}${delta}; the record is adjusted and the variance kept` };
}

export function reorderFindings(parts: readonly { id: number; partNumber: string; minQty: number | null; maxQty: number | null }[], positions: readonly StockPosition[]): { partNumber: string; finding: "below_min" | "above_max" | "no_stock_record"; onHandQty: number; detail: string }[] {
  const out: ReturnType<typeof reorderFindings> = [];
  for (const p of parts) {
    const onHand = positions.filter(x => x.partId === p.id).reduce((a, x) => a + x.onHandQty, 0);
    const has = positions.some(x => x.partId === p.id);
    if (!has && p.minQty != null) out.push({ partNumber: p.partNumber, finding: "no_stock_record", onHandQty: 0, detail: "No movement ever recorded — on-hand is unknown, not zero" });
    else if (p.minQty != null && onHand < p.minQty) out.push({ partNumber: p.partNumber, finding: "below_min", onHandQty: onHand, detail: `${onHand} on hand, minimum ${p.minQty}` });
    else if (p.maxQty != null && onHand > p.maxQty) out.push({ partNumber: p.partNumber, finding: "above_max", onHandQty: onHand, detail: `${onHand} on hand, maximum ${p.maxQty}` });
  }
  return out;
}

/* ---- tires ---- */

export const AXLE_POSITION = /^[1-9][LR][IO]?$/;

export function installDecision(args: { tireStatus: string; positionType: string; axlePosition: string; occupiedPositions: readonly string[]; tireCurrentlyInstalled: boolean }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (!AXLE_POSITION.test(args.axlePosition)) r.push(`Axle position ${args.axlePosition} is not of the form 1L, 2LO, 3RI`);
  if (args.tireCurrentlyInstalled) r.push("Tire is installed elsewhere — remove it first; a tire is in one place");
  if (args.tireStatus === "scrapped") r.push("Tire is scrapped");
  if (args.tireStatus === "retread_out") r.push("Tire is out for retread");
  if (args.occupiedPositions.includes(args.axlePosition)) r.push(`Position ${args.axlePosition} is occupied — remove that tire first`);
  const steer = args.axlePosition.startsWith("1");
  if (steer && args.positionType === "trailer") r.push("A trailer tire is not installed on a steer axle");
  return { permitted: r.length === 0, refusals: r };
}

export type TireRun = { kmRun: number | null; costPerKmCents: number | null; treadUsedMm: number | null; determination: "computed" | "unknown"; reasons: string[] };

export function tireRun(args: { installOdometerKm: number | null; removeOdometerKm: number | null; installTreadMm: number | null; removeTreadMm: number | null; purchaseCostCents: number | null }): TireRun {
  const reasons: string[] = [];
  let km: number | null = null;
  if (args.installOdometerKm == null || args.removeOdometerKm == null) reasons.push("Kilometres unknown — install and removal odometers are both required");
  else if (args.removeOdometerKm < args.installOdometerKm) reasons.push(`Removal odometer ${args.removeOdometerKm} is below install odometer ${args.installOdometerKm} — REVIEW`);
  else km = args.removeOdometerKm - args.installOdometerKm;
  let cpk: number | null = null;
  if (km != null && km > 0 && args.purchaseCostCents != null) cpk = args.purchaseCostCents / km;
  else if (km != null && args.purchaseCostCents == null) reasons.push("Cost per km unknown — no purchase cost on record");
  const tread = args.installTreadMm != null && args.removeTreadMm != null ? Math.round((args.installTreadMm - args.removeTreadMm) * 10) / 10 : null;
  return { kmRun: km, costPerKmCents: cpk == null ? null : Math.round(cpk * 100) / 100, treadUsedMm: tread, determination: km != null && cpk != null ? "computed" : "unknown", reasons };
}

export function treadStatus(treadMm: number | null, limitMm: number): "ok" | "approaching_limit" | "below_limit" | "unknown" {
  if (treadMm == null) return "unknown";
  if (treadMm < limitMm) return "below_limit";
  if (treadMm < limitMm + 1.5) return "approaching_limit";
  return "ok";
}

/* ---- warranty ---- */

export function claimEligibility(args: { policy: { verificationStatus: "unverified" | "verified"; coverageUntil: Date | null; coverageKm: number | null; coverageHours: number | null } | null; at: Date; kmSincePurchase: number | null; hoursSincePurchase: number | null }): { eligibility: "eligible" | "expired" | "unknown"; reason: string } {
  const p = args.policy;
  if (!p) return { eligibility: "unknown", reason: "No warranty policy on record for this subject" };
  if (p.verificationStatus !== "verified") return { eligibility: "unknown", reason: "Policy is unverified — eligibility cannot be asserted until a person verifies the terms" };
  if (p.coverageUntil && args.at >= p.coverageUntil) return { eligibility: "expired", reason: `Coverage ended ${p.coverageUntil.toISOString().slice(0, 10)}` };
  if (p.coverageKm != null) { if (args.kmSincePurchase == null) return { eligibility: "unknown", reason: "Coverage is by kilometres and the kilometres since purchase are not on record" }; if (args.kmSincePurchase > p.coverageKm) return { eligibility: "expired", reason: `${args.kmSincePurchase} km exceeds the ${p.coverageKm} km coverage` }; }
  if (p.coverageHours != null) { if (args.hoursSincePurchase == null) return { eligibility: "unknown", reason: "Coverage is by hours and the hours since purchase are not on record" }; if (args.hoursSincePurchase > p.coverageHours) return { eligibility: "expired", reason: `${args.hoursSincePurchase} h exceeds the ${p.coverageHours} h coverage` }; }
  return { eligibility: "eligible", reason: "Within verified coverage" };
}

export function claimDecision(args: { raisedByUserId: number; deciderUserId: number; decision: "approved" | "denied"; eligibility: "eligible" | "expired" | "unknown" }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.raisedByUserId === args.deciderUserId) r.push("The person who raised the claim may not decide it");
  if (args.decision === "approved" && args.eligibility === "unknown") r.push("Eligibility is unknown — verify the policy before approving");
  return { permitted: r.length === 0, refusals: r };
}

/* ---- cost ---- */

export type WorkOrderCost = { partsCents: number; partsUnknownCount: number; labourCents: number | null; labourMinutes: number; totalCents: number | null; determination: "computed" | "partial" | "unknown"; reasons: string[] };

export function workOrderCost(args: { laborMinutes: number; labourRateCentsPerHour: number | null; issues: readonly { qty: number; unitCostCents: number | null }[] }): WorkOrderCost {
  const reasons: string[] = [];
  let parts = 0, unknown = 0;
  for (const i of args.issues) { if (i.unitCostCents == null) unknown++; else parts += i.qty * i.unitCostCents; }
  if (unknown) reasons.push(`${unknown} issued part(s) have no cost on record — parts cost is a floor, not a total`);
  const labour = args.labourRateCentsPerHour == null ? null : Math.round(args.laborMinutes / 60 * args.labourRateCentsPerHour);
  if (labour == null && args.laborMinutes > 0) reasons.push("Labour rate not configured — labour cost unknown");
  const total = labour == null ? null : parts + labour;
  return { partsCents: parts, partsUnknownCount: unknown, labourCents: labour, labourMinutes: args.laborMinutes, totalCents: total, determination: total != null && unknown === 0 ? "computed" : total != null || parts > 0 ? "partial" : "unknown", reasons };
}
