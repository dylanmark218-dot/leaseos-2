/**
 * v22.8 — Pricing at the moment a quantity becomes a line.
 *
 * Shared by the closeout (sell) and purchasing (vendor payable) paths: map
 * the line's measurement and unit vocabulary onto the resolver's, run the
 * resolver over the entity's approved definitions, price, and write the
 * decision once. An unknown rate is a decision that says so; it never
 * stops a line from being recorded, because a line records a fact.
 */
import { and, eq } from "drizzle-orm";
import { chargeDefinitions, pricingDecisions } from "../../drizzle/schema";
import { priceQuantity, resolveRate, type ChargeDefinition, type MeasurementBasis, type PricingOutcome, type RateKind, type ResolutionContext, type Unit } from "./rateResolution";

export const MEASUREMENT_BASIS: Record<string, MeasurementBasis> = { meter: "meter", scale: "certified_scale", gauge: "tank_calibration", estimate: "operator_estimate", customer_stated: "customer_measurement", system_timed: "clock", unknown: "manual_entry" };
const UNIT_ALIASES: Record<string, Unit> = { h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour", "half-hour": "half_hour", half_hour: "half_hour", day: "day", days: "day", shift: "shift", load: "load", loads: "load", km: "km", kms: "km", kilometre: "km", kilometres: "km", mi: "mile", mile: "mile", miles: "mile", m3: "m3", "m³": "m3", l: "litre", litre: "litre", litres: "litre", liter: "litre", kg: "kg", t: "tonne", tonne: "tonne", tonnes: "tonne", ton: "tonne", acre: "acre", acres: "acre", m: "metre", metre: "metre", metres: "metre", ft: "foot", foot: "foot", feet: "foot", piece: "piece", pieces: "piece", pc: "piece", worker: "worker", crew: "crew", each: "each", ea: "each", none: "none" };
export function normaliseUnit(raw: string | null | undefined): Unit | null {
  if (!raw) return null;
  return UNIT_ALIASES[raw.trim().toLowerCase()] ?? null;
}
export const toMillis = (q: number) => Math.round(q * 1000);
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

type Db = { select: (...a: never[]) => unknown; insert: (...a: never[]) => unknown };

export type LinePricingArgs = {
  db: Db; financialEntityId: number; rateKind: Extract<RateKind, "sell" | "vendor_payable">; serviceCode: string; at: Date;
  subjectKind: "field_ticket_line" | "vendor_bill_line"; subjectRef: string; quantity: number; unit: Unit; measurementSource: MeasurementBasis; decidedByUserId: number;
  context: Omit<ResolutionContext, "rateKind" | "serviceCode" | "at">; passThroughCents?: number | null;
};

/** Resolve, price and write the decision. Returns the decision reference and the outcome; never throws for an unknown rate. */
export async function priceLineAndRecord(a: LinePricingArgs): Promise<{ decisionRef: string; outcome: PricingOutcome }> {
  const db = a.db as unknown as { select: () => { from: (t: unknown) => { where: (w: unknown) => Promise<ChargeDefinition[]> } }; insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } };
  const defs = await db.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.financialEntityId, a.financialEntityId), eq(chargeDefinitions.serviceCode, a.serviceCode), eq(chargeDefinitions.rateKind, a.rateKind)));
  const res = resolveRate(defs, { ...a.context, rateKind: a.rateKind, serviceCode: a.serviceCode, at: a.at });
  const out = priceQuantity(res, { quantityMillis: toMillis(a.quantity), unit: a.unit, measurementSource: a.measurementSource, passThroughCents: a.passThroughCents ?? null });
  const decisionRef = ref("PR");
  await db.insert(pricingDecisions).values({
    decisionRef, financialEntityId: a.financialEntityId, rateKind: a.rateKind, subjectKind: a.subjectKind, subjectRef: a.subjectRef, serviceCode: a.serviceCode, quantityMillis: toMillis(a.quantity), unit: a.unit, measurementSource: a.measurementSource, measurementEvidenceId: null,
    outcome: out.outcome, chargeDefinitionId: out.definition?.id ?? null, scopeLevel: out.scopeLevel, rateMillis: out.rateMillis, billableQuantityMillis: out.billableQuantityMillis, minimumApplied: out.minimumApplied, incrementApplied: out.incrementApplied, formula: out.formula, inputsJson: JSON.stringify(out.inputs), amountCents: out.amountCents, reasonsJson: JSON.stringify(out.reasons), decidedByUserId: a.decidedByUserId,
  });
  return { decisionRef, outcome: out };
}
