/**
 * v22.7 — Commercial Setup & Rate Resolution.
 *
 * Money is cents. Rates and quantities are thousandths. Markups are basis
 * points. The resolver is deterministic and never picks something close: a
 * missing rate is UNKNOWN, two candidates at the same level are a CONFLICT,
 * a unit that does not match is a CONVERSION REVIEW unless a sourced
 * conversion rule is supplied. Four rate kinds — sell, vendor payable,
 * payroll reference, internal cost — are never confused, and a projection
 * decides what each viewer may see.
 */

export type RateKind = "sell" | "vendor_payable" | "payroll_reference" | "internal_cost";
export type ScopeLevel = "job_override" | "change_order" | "po_afe" | "project_site" | "customer_contract" | "customer_rate_card" | "branch" | "company";
export type PricingMethod = "per_unit" | "flat" | "minimum_charge" | "percentage_markup" | "fixed_markup" | "multiplier" | "formula";
export type Unit = "hour" | "half_hour" | "day" | "shift" | "load" | "km" | "mile" | "m3" | "litre" | "kg" | "tonne" | "acre" | "metre" | "foot" | "piece" | "worker" | "crew" | "each" | "none";
export type MeasurementBasis = "any" | "meter" | "tank_calibration" | "certified_scale" | "load_sensor" | "facility_ticket" | "customer_measurement" | "operator_estimate" | "manual_entry" | "clock" | "odometer" | "gps";

/** Precedence, most specific first. Lower index wins; equal index with more than one candidate is a conflict. */
export const PRECEDENCE: readonly ScopeLevel[] = ["job_override", "change_order", "po_afe", "project_site", "customer_contract", "customer_rate_card", "branch", "company"];

export type ChargeDefinition = {
  id: number; definitionRef: string; rateKind: RateKind; serviceCode: string; resourceClass: string | null; unitId: number | null;
  pricingMethod: PricingMethod; unit: Unit; rateMillis: number | null; flatCents: number | null; basisPoints: number | null; multiplierMillis: number | null;
  minimumQuantityMillis: number | null; minimumChargeCents: number | null; billingIncrementMillis: number | null; roundingMode: "nearest" | "up" | "down";
  measurementBasis: MeasurementBasis; conditionKey: string | null;
  scopeLevel: ScopeLevel; customerAccountId: number | null; vendorId: number | null; projectRef: string | null; siteRef: string | null; contractRef: string | null; jobId: number | null; branchCode: string | null;
  effectiveFrom: Date; effectiveTo: Date | null; approvalStatus: "proposed" | "approved" | "rejected" | "superseded"; version: number; sourceClause: string | null; sourceKind: string;
};

export type ResolutionContext = {
  rateKind: RateKind; serviceCode: string; at: Date;
  customerAccountId?: number | null; vendorId?: number | null; projectRef?: string | null; siteRef?: string | null; contractRef?: string | null; jobId?: number | null; branchCode?: string | null; unitId?: number | null; resourceClass?: string | null;
  conditionKey?: string | null;
};

export type Resolution =
  | { outcome: "resolved"; definition: ChargeDefinition; scopeLevel: ScopeLevel; considered: number; reasons: string[] }
  | { outcome: "unknown"; considered: number; reasons: string[] }
  | { outcome: "conflict"; scopeLevel: ScopeLevel; candidates: ChargeDefinition[]; considered: number; reasons: string[] };

function inWindow(d: ChargeDefinition, at: Date) { return d.effectiveFrom.getTime() <= at.getTime() && (d.effectiveTo == null || at.getTime() < d.effectiveTo.getTime()); }

/** Does the definition's scope apply to the context? Every scope field the definition sets must match. */
export function scopeApplies(d: ChargeDefinition, ctx: ResolutionContext): boolean {
  if (d.rateKind !== ctx.rateKind || d.serviceCode !== ctx.serviceCode) return false;
  if (d.customerAccountId != null && d.customerAccountId !== (ctx.customerAccountId ?? null)) return false;
  if (d.vendorId != null && d.vendorId !== (ctx.vendorId ?? null)) return false;
  if (d.projectRef != null && d.projectRef !== (ctx.projectRef ?? null)) return false;
  if (d.siteRef != null && d.siteRef !== (ctx.siteRef ?? null)) return false;
  if (d.contractRef != null && d.contractRef !== (ctx.contractRef ?? null)) return false;
  if (d.jobId != null && d.jobId !== (ctx.jobId ?? null)) return false;
  if (d.branchCode != null && d.branchCode !== (ctx.branchCode ?? null)) return false;
  if (d.unitId != null && d.unitId !== (ctx.unitId ?? null)) return false;
  if (d.resourceClass != null && ctx.resourceClass != null && d.resourceClass !== ctx.resourceClass) return false;
  if (d.conditionKey != null && d.conditionKey !== (ctx.conditionKey ?? null)) return false;
  if (d.rateKind === "vendor_payable" && (ctx.vendorId ?? null) == null) return false;   // a payable is owed to someone
  return true;
}

/** How many scope fields a definition names: the more it names, the more specific it is. */
export function specificity(d: ChargeDefinition): number {
  return [d.customerAccountId, d.vendorId, d.projectRef, d.siteRef, d.contractRef, d.jobId, d.branchCode, d.unitId, d.resourceClass, d.conditionKey].filter(x => x != null).length;
}

/** Deterministic precedence over approved, in-window, applicable definitions. Never "something close". */
export function resolveRate(defs: readonly ChargeDefinition[], ctx: ResolutionContext): Resolution {
  const reasons: string[] = [];
  // A superseded definition is no longer current, but it was in effect for its window: a December job prices at December's rate after the January rate replaces it.
  const wasApproved = (d: ChargeDefinition) => d.approvalStatus === "approved" || d.approvalStatus === "superseded";
  const applicable = defs.filter(d => wasApproved(d) && inWindow(d, ctx.at) && scopeApplies(d, ctx));
  const proposedOnly = defs.filter(d => d.approvalStatus === "proposed" && inWindow(d, ctx.at) && scopeApplies(d, ctx));
  const expired = defs.filter(d => wasApproved(d) && !inWindow(d, ctx.at) && scopeApplies(d, ctx));
  if (proposedOnly.length) reasons.push(`${proposedOnly.length} proposed definition(s) apply but are not approved — a proposal prices nothing`);
  if (expired.length) reasons.push(`${expired.length} approved definition(s) match but are outside their effective window at ${ctx.at.toISOString().slice(0, 10)}`);
  for (const level of PRECEDENCE) {
    // Within a level the most specific definition wins — one that names the condition, the unit, the site — and only equal specificity is a conflict.
    const atLevel = applicable.filter(d => d.scopeLevel === level);
    const maxSpec = Math.max(0, ...atLevel.map(specificity));
    const at = atLevel.filter(d => specificity(d) === maxSpec);
    if (atLevel.length > at.length) reasons.push(`${atLevel.length - at.length} less specific definition(s) at ${level} set aside`);
    if (at.length === 1) { reasons.push(`Resolved at ${level}: ${at[0]!.definitionRef} v${at[0]!.version}`); return { outcome: "resolved", definition: at[0]!, scopeLevel: level, considered: applicable.length, reasons }; }
    if (at.length > 1) { reasons.push(`${at.length} approved definitions apply at ${level} — a person decides which governs`); return { outcome: "conflict", scopeLevel: level, candidates: at, considered: applicable.length, reasons }; }
  }
  reasons.push("RATE UNKNOWN — REVIEW REQUIRED: no approved definition applies");
  return { outcome: "unknown", considered: applicable.length, reasons };
}

/** Round thousandths to an increment, in the definition's direction. */
export function applyIncrement(quantityMillis: number, incrementMillis: number | null, mode: "nearest" | "up" | "down"): { billableMillis: number; applied: boolean } {
  if (!incrementMillis || incrementMillis <= 0) return { billableMillis: quantityMillis, applied: false };
  const steps = quantityMillis / incrementMillis;
  const rounded = (mode === "up" ? Math.ceil(steps - 1e-9) : mode === "down" ? Math.floor(steps + 1e-9) : Math.round(steps)) * incrementMillis;
  return { billableMillis: rounded, applied: rounded !== quantityMillis };
}

export type ConversionRule = { fromUnit: Unit; toUnit: Unit; factorMillis: number; source: string; material?: string | null };

export type PricingInput = {
  quantityMillis: number; unit: Unit; measurementSource: MeasurementBasis | string;
  passThroughCents?: number | null;             // for markups: the vendor amount being marked up
  conversion?: ConversionRule | null;           // an explicit, sourced conversion, or nothing
};

export type PricingOutcome = {
  outcome: "priced" | "unknown_rate" | "conflict" | "conversion_review" | "measurement_review";
  amountCents: number | null; rateMillis: number | null; billableQuantityMillis: number | null; minimumApplied: boolean; incrementApplied: boolean;
  formula: string; inputs: Record<string, unknown>; reasons: string[]; definition: ChargeDefinition | null; scopeLevel: ScopeLevel | null;
};

/** Price a measured quantity under a resolution. What was measured is kept; what is billed may be raised or rounded, and the record says so. */
export function priceQuantity(res: Resolution, input: PricingInput): PricingOutcome {
  const base = { rateMillis: null, billableQuantityMillis: null, minimumApplied: false, incrementApplied: false, definition: null, scopeLevel: null } as const;
  if (res.outcome === "unknown") return { ...base, outcome: "unknown_rate", amountCents: null, formula: "none", inputs: { quantityMillis: input.quantityMillis, unit: input.unit }, reasons: res.reasons };
  if (res.outcome === "conflict") return { ...base, outcome: "conflict", amountCents: null, formula: "none", inputs: { quantityMillis: input.quantityMillis, unit: input.unit, candidates: res.candidates.map(c => c.definitionRef) }, reasons: res.reasons };
  const d = res.definition;
  const reasons = [...res.reasons];
  if (d.measurementBasis !== "any" && d.measurementBasis !== input.measurementSource) {
    return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "measurement_review", amountCents: null, formula: "none", inputs: { quantityMillis: input.quantityMillis, unit: input.unit, measurementSource: input.measurementSource, accepted: d.measurementBasis }, reasons: [...reasons, `The contract accepts ${d.measurementBasis} for ${d.serviceCode}; this quantity came from ${input.measurementSource} — REVIEW`] };
  }
  let quantityMillis = input.quantityMillis, unit = input.unit;
  const inputs: Record<string, unknown> = { measuredQuantityMillis: input.quantityMillis, measuredUnit: input.unit, measurementSource: input.measurementSource };
  if (d.pricingMethod === "per_unit" && d.unit !== unit) {
    const c = input.conversion;
    if (!c || c.fromUnit !== unit || c.toUnit !== d.unit) return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "conversion_review", amountCents: null, formula: "none", inputs: { ...inputs, definitionUnit: d.unit }, reasons: [...reasons, `CONVERSION REQUIRES REVIEW: measured in ${unit}, priced per ${d.unit}, and no sourced conversion rule was supplied`] };
    quantityMillis = Math.round(quantityMillis * c.factorMillis / 1000); unit = c.toUnit;
    inputs.conversion = { fromUnit: c.fromUnit, toUnit: c.toUnit, factorMillis: c.factorMillis, source: c.source, material: c.material ?? null };
    reasons.push(`Converted ${input.quantityMillis / 1000} ${c.fromUnit} → ${quantityMillis / 1000} ${c.toUnit} by ${c.factorMillis / 1000} (${c.source})`);
  }
  let minimumApplied = false, incrementApplied = false, billable = quantityMillis;
  if (d.pricingMethod === "per_unit" || d.pricingMethod === "minimum_charge") {
    const inc = applyIncrement(billable, d.billingIncrementMillis, d.roundingMode);
    if (inc.applied) { reasons.push(`Rounded ${billable / 1000} → ${inc.billableMillis / 1000} ${unit} to the ${d.billingIncrementMillis! / 1000} ${unit} increment (${d.roundingMode})`); billable = inc.billableMillis; incrementApplied = true; }
    if (d.minimumQuantityMillis != null && billable > 0 && billable < d.minimumQuantityMillis) { reasons.push(`Minimum ${d.minimumQuantityMillis / 1000} ${unit}${d.sourceClause ? ` per ${d.sourceClause}` : ""}: ${billable / 1000} raised to ${d.minimumQuantityMillis / 1000}`); billable = d.minimumQuantityMillis; minimumApplied = true; }
  }
  let amount: number, formula: string, rateMillis: number | null = d.rateMillis;
  switch (d.pricingMethod) {
    case "per_unit": case "minimum_charge": {
      if (d.rateMillis == null) return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "unknown_rate", amountCents: null, formula: "none", inputs, reasons: [...reasons, "Definition carries no rate"] };
      amount = Math.round(billable * d.rateMillis / 1000 / 10);     // thousandths × thousandths-of-dollar → cents
      formula = `billableQuantity(${billable / 1000} ${unit}) × rate($${(d.rateMillis / 1000).toFixed(3)}/${unit})`;
      if (d.minimumChargeCents != null && amount > 0 && amount < d.minimumChargeCents) { reasons.push(`Minimum charge $${(d.minimumChargeCents / 100).toFixed(2)}: $${(amount / 100).toFixed(2)} raised`); amount = d.minimumChargeCents; minimumApplied = true; formula += ` → minimum charge`; }
      break;
    }
    case "flat": { amount = d.flatCents ?? 0; formula = `flat $${(amount / 100).toFixed(2)}`; break; }
    case "percentage_markup": {
      if (input.passThroughCents == null) return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "unknown_rate", amountCents: null, formula: "none", inputs, reasons: [...reasons, "A markup needs the pass-through amount it marks up — none supplied"] };
      amount = input.passThroughCents + Math.round(input.passThroughCents * (d.basisPoints ?? 0) / 10_000);
      formula = `passThrough($${(input.passThroughCents / 100).toFixed(2)}) + ${(d.basisPoints ?? 0) / 100}%`; inputs.passThroughCents = input.passThroughCents; break;
    }
    case "fixed_markup": {
      if (input.passThroughCents == null) return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "unknown_rate", amountCents: null, formula: "none", inputs, reasons: [...reasons, "A markup needs the pass-through amount it marks up — none supplied"] };
      amount = input.passThroughCents + (d.flatCents ?? 0); formula = `passThrough($${(input.passThroughCents / 100).toFixed(2)}) + $${((d.flatCents ?? 0) / 100).toFixed(2)}`; inputs.passThroughCents = input.passThroughCents; break;
    }
    case "multiplier": {
      if (input.passThroughCents == null) return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "unknown_rate", amountCents: null, formula: "none", inputs, reasons: [...reasons, "A multiplier needs the base amount it multiplies — none supplied"] };
      amount = Math.round(input.passThroughCents * (d.multiplierMillis ?? 1000) / 1000); formula = `base($${(input.passThroughCents / 100).toFixed(2)}) × ${(d.multiplierMillis ?? 1000) / 1000}`; inputs.passThroughCents = input.passThroughCents; break;
    }
    default: return { ...base, definition: d, scopeLevel: res.scopeLevel, outcome: "unknown_rate", amountCents: null, formula: "none", inputs, reasons: [...reasons, "Formula pricing is recorded, not evaluated: a person prices it"] };
  }
  return { outcome: "priced", amountCents: amount, rateMillis, billableQuantityMillis: billable, minimumApplied, incrementApplied, formula, inputs, reasons, definition: d, scopeLevel: res.scopeLevel };
}

/** What each viewer may see of a decision. The customer never sees the vendor payable or the margin unless the contract is open-book. */
export type Viewer = "customer" | "vendor" | "management";
export function projectDecision(view: Viewer, d: { sellCents: number | null; vendorCents: number | null; internalCostCents: number | null; openBook?: boolean }) {
  if (view === "customer") return d.openBook ? { sellCents: d.sellCents, vendorCents: d.vendorCents, marginCents: d.sellCents != null && d.vendorCents != null ? d.sellCents - d.vendorCents : null } : { sellCents: d.sellCents };
  if (view === "vendor") return { vendorCents: d.vendorCents };
  const cost = d.vendorCents ?? d.internalCostCents;
  return { sellCents: d.sellCents, vendorCents: d.vendorCents, internalCostCents: d.internalCostCents, marginCents: d.sellCents != null && cost != null ? d.sellCents - cost : null, marginBps: d.sellCents ? (cost != null ? Math.round((d.sellCents - cost) * 10_000 / d.sellCents) : null) : null };
}

export type Guardrails = { targetMarginBps: number | null; warningMarginBps: number | null; minimumAuthorityMarginBps: number | null; discountAuthority: Record<string, number> /* role → floor margin bps */ };
export type MarginSimulation = { sellCents: number; costCents: number; marginCents: number; marginBps: number; band: "target" | "warning" | "below_minimum" | "unknown"; approvalRequired: string | null; reasons: string[] };

/** Business policy, not law: which band a proposed price falls in and who may approve it. */
export function simulateMargin(args: { sellCents: number; costCents: number | null; guardrails: Guardrails | null; roles: readonly string[] }): MarginSimulation {
  const reasons: string[] = [];
  if (args.costCents == null) return { sellCents: args.sellCents, costCents: 0, marginCents: 0, marginBps: 0, band: "unknown", approvalRequired: "controller", reasons: ["Cost unknown — the margin cannot be stated; a controller decides"] };
  const marginCents = args.sellCents - args.costCents;
  const marginBps = args.sellCents > 0 ? Math.round(marginCents * 10_000 / args.sellCents) : 0;
  const g = args.guardrails;
  let band: MarginSimulation["band"] = "unknown";
  if (g?.targetMarginBps != null && marginBps >= g.targetMarginBps) band = "target";
  else if (g?.warningMarginBps != null && marginBps >= g.warningMarginBps) { band = "warning"; reasons.push(`Margin ${(marginBps / 100).toFixed(1)}% is below the ${(g.targetMarginBps ?? 0) / 100}% target`); }
  else if (g?.minimumAuthorityMarginBps != null) { band = "below_minimum"; reasons.push(`Margin ${(marginBps / 100).toFixed(1)}% is below the ${(g.warningMarginBps ?? 0) / 100}% warning line`); }
  let approvalRequired: string | null = null;
  if (g) {
    const floors = Object.entries(g.discountAuthority).sort((a, b) => a[1] - b[1]);       // lowest floor = widest authority
    const allowed = args.roles.some(r => (g.discountAuthority[r] ?? Number.POSITIVE_INFINITY) <= marginBps);
    if (!allowed) { const who = floors.find(([, floor]) => floor <= marginBps)?.[0] ?? "controller"; approvalRequired = who; reasons.push(`Below the caller's discount authority — ${who} approval required`); }
  }
  return { sellCents: args.sellCents, costCents: args.costCents, marginCents, marginBps, band, approvalRequired, reasons };
}

export type PoExposure = { authorizedCents: number; billedCents: number; committedCents: number; projectedCents: number; remainingCents: number; overrunCents: number; status: "within" | "warning" | "overrun" | "expired"; reasons: string[] };
/** Before work starts: authorized, billed, committed and the current estimate against the PO/AFE. */
export function poExposure(args: { authorizedCents: number; billedCents: number; committedCents: number; estimateCents: number; validTo: Date | null; at: Date; warningBps?: number }): PoExposure {
  const projected = args.billedCents + args.committedCents + args.estimateCents;
  const remaining = args.authorizedCents - projected;
  const reasons: string[] = [];
  if (args.validTo && args.at.getTime() > args.validTo.getTime()) { reasons.push(`PO expired ${args.validTo.toISOString().slice(0, 10)}`); return { authorizedCents: args.authorizedCents, billedCents: args.billedCents, committedCents: args.committedCents, projectedCents: projected, remainingCents: remaining, overrunCents: Math.max(0, -remaining), status: "expired", reasons }; }
  if (remaining < 0) { reasons.push(`Projected PO overrun: $${(-remaining / 100).toFixed(2)} — request an increase, obtain a change order, or stop work per company rules`); return { authorizedCents: args.authorizedCents, billedCents: args.billedCents, committedCents: args.committedCents, projectedCents: projected, remainingCents: remaining, overrunCents: -remaining, status: "overrun", reasons }; }
  const warn = args.warningBps ?? 1000;
  if (remaining * 10_000 <= args.authorizedCents * warn) reasons.push(`Within ${(warn / 100).toFixed(0)}% of the authorization after this work`);
  return { authorizedCents: args.authorizedCents, billedCents: args.billedCents, committedCents: args.committedCents, projectedCents: projected, remainingCents: remaining, overrunCents: 0, status: reasons.length ? "warning" : "within", reasons };
}

/** What a rate sheet leaves unanswered for a service, named — never guessed. */
export const SHEET_QUESTIONS: readonly { key: string; question: string; test: (defs: readonly ChargeDefinition[]) => boolean }[] = [
  { key: "minimum", question: "Is there a minimum charge or minimum hours?", test: defs => defs.some(d => d.minimumQuantityMillis != null || d.minimumChargeCents != null) },
  { key: "increment", question: "What billing increment applies (15 min, 30 min, nearest 0.25 h)?", test: defs => defs.some(d => d.billingIncrementMillis != null) },
  { key: "after_hours", question: "Is there an after-hours, weekend or holiday rate?", test: defs => defs.some(d => ["after_hours", "weekend", "holiday", "night"].includes(d.conditionKey ?? "")) },
  { key: "standby", question: "Is standby billable, and at what rate?", test: defs => defs.some(d => d.serviceCode.endsWith("_standby") || d.conditionKey === "standby") },
  { key: "travel", question: "Is travel billable, at what rate, and is return travel included?", test: defs => defs.some(d => d.serviceCode.endsWith("_travel") || d.conditionKey === "travel") },
  { key: "disposal", question: "How is disposal billed — pass-through, marked up, or per unit?", test: defs => defs.some(d => d.serviceCode.includes("disposal")) },
];
export function rateSheetGaps(defs: readonly ChargeDefinition[]): { key: string; question: string }[] {
  return SHEET_QUESTIONS.filter(q => !q.test(defs)).map(q => ({ key: q.key, question: q.question }));
}

export type ReadinessInput = { services: string[]; approvedSell: number; proposedSell: number; approvedVendor: number; vendorsWithoutRates: number; customersWithoutRates: number; unitsWithoutCost: number; guardrailsSet: boolean; termsApproved: number; customers: number };
/** Go-live readiness: a percentage with exactly what is missing. Unknown is never rounded to ready. */
export function goLiveReadiness(r: ReadinessInput): { percent: number; ready: boolean; missing: string[]; checks: { key: string; ok: boolean; detail: string }[] } {
  const checks = [
    { key: "services", ok: r.services.length > 0, detail: r.services.length ? `${r.services.length} service(s) declared` : "No services declared" },
    { key: "sell_rates", ok: r.approvedSell > 0, detail: r.approvedSell ? `${r.approvedSell} approved sell definition(s)` : "No approved sell rate" },
    { key: "proposals_pending", ok: r.proposedSell === 0, detail: r.proposedSell ? `${r.proposedSell} sell proposal(s) awaiting approval` : "No proposals pending" },
    { key: "customer_rates", ok: r.customersWithoutRates === 0, detail: r.customersWithoutRates ? `${r.customersWithoutRates} customer(s) without an approved rate` : "Every customer has a rate" },
    { key: "vendor_rates", ok: r.vendorsWithoutRates === 0, detail: r.vendorsWithoutRates ? `${r.vendorsWithoutRates} vendor(s) without a payable rate` : "Every vendor has a payable rate" },
    { key: "unit_cost", ok: r.unitsWithoutCost === 0, detail: r.unitsWithoutCost ? `${r.unitsWithoutCost} unit(s) without an internal cost` : "Every unit has an internal cost" },
    { key: "guardrails", ok: r.guardrailsSet, detail: r.guardrailsSet ? "Margin guardrails set" : "Margin guardrails not set" },
    { key: "terms", ok: r.customers === 0 || r.termsApproved > 0, detail: r.termsApproved ? `${r.termsApproved} approved contract terms` : "No approved contract terms" },
  ];
  const ok = checks.filter(c => c.ok).length;
  return { percent: Math.round(ok * 100 / checks.length), ready: ok === checks.length, missing: checks.filter(c => !c.ok).map(c => c.detail), checks };
}
