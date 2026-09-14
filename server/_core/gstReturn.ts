/**
 * GST/HST — the return, from the ledger.
 *
 *   Line 101  sales and other revenue, excluding the tax — every invoice
 *   Line 105  tax collected — what the invoices say, a fact
 *   Line 108  input tax credits — tax on purchases that carry evidence, and
 *             only when the company is registered; a purchase without
 *             evidence is withheld and named, never claimed
 *   Line 104 / 107  adjustments, each with a reason and a person
 *   Line 109  net tax — 105 + 104 − 108 − 107; negative is a refund
 *
 * The rate is a rule row. When a person has verified it, the return checks
 * each taxable sale's tax against it and names the ones that differ. When
 * nobody has, the return says its figures are unchecked — it does not invent
 * five percent to check them with.
 */

import type { Determination } from "./taxRuleEngine";

export type GstTreatment = "taxable" | "zero_rated" | "exempt" | "unknown";

export type SaleRecord = { ref: string; issuedAt: Date; subtotalCents: number; taxCents: number; treatment: GstTreatment; jurisdiction: string; entityAssigned: boolean };
export type PurchaseRecord = { ref: string; kind: "vendor_bill" | "expense" | "fuel"; date: Date; subtotalCents: number; taxCents: number; hasEvidence: boolean; treatment: GstTreatment | null };
export type Adjustment = { ref: string; line: "104" | "107"; amountCents: number; reason: string };
export type Registration = { registered: boolean; identifierPresent: boolean } | null;
export type RateLookup = (jurisdiction: string) => Determination<{ ratePercent?: number | null }>;

export type ReturnException = { code: string; severity: "blocking" | "review"; subject: string; detail: string };

export type GstReturn = {
  period: string;
  periodStart: Date;
  periodEnd: Date;
  lines: {
    line101SalesCents: number;
    line105CollectedCents: number;
    line104AdjustmentsCents: number;
    line108ItcCents: number;
    line107AdjustmentsCents: number;
    line109NetTaxCents: number;
  };
  itc: { claimedCents: number; withheldNoEvidenceCents: number; withheldNotRegisteredCents: number; purchasesWithEvidence: number; purchasesWithout: number };
  rateCheck: { status: "checked" | "unverified" | "missing"; jurisdiction: string; ratePercent: number | null; salesChecked: number; salesDiffering: number };
  exceptions: ReturnException[];
  determination: "ready" | "review" | "blocked";
  reasons: string[];
};

export function gstPeriodBounds(period: string): { start: Date; end: Date } {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) { const y = Number(q[1]), n = Number(q[2]); return { start: new Date(Date.UTC(y, (n - 1) * 3, 1)), end: new Date(Date.UTC(y, n * 3, 1)) }; }
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) { const y = Number(m[1]), mo = Number(m[2]); if (mo >= 1 && mo <= 12) return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) }; }
  throw new Error(`Period must look like 2026-Q3 or 2026-08, got ${period}`);
}

export function buildGstReturn(args: { period: string; jurisdiction: string; registration: Registration; sales: readonly SaleRecord[]; purchases: readonly PurchaseRecord[]; adjustments: readonly Adjustment[]; rateFor: RateLookup; unassignedSalesExcluded?: number }): GstReturn {
  const { start, end } = gstPeriodBounds(args.period);
  const inPeriod = (d: Date) => d >= start && d < end;
  const ex: ReturnException[] = [];
  const reasons: string[] = [];

  /* ---- sales ---- */
  const sales = args.sales.filter(s => inPeriod(s.issuedAt));
  const line101 = sales.reduce((a, s) => a + s.subtotalCents, 0);
  const line105 = sales.reduce((a, s) => a + s.taxCents, 0);
  for (const s of sales) {
    if (s.treatment === "unknown") ex.push({ code: "sale_treatment_unknown", severity: "blocking", subject: s.ref, detail: "Tax treatment not classified — taxable, zero-rated or exempt" });
    else if ((s.treatment === "zero_rated" || s.treatment === "exempt") && s.taxCents !== 0) ex.push({ code: "tax_charged_on_untaxable_sale", severity: "blocking", subject: s.ref, detail: `${s.treatment.replace("_", "-")} sale invoiced with ${fmt(s.taxCents)} tax` });
    else if (s.treatment === "taxable" && s.taxCents === 0 && s.subtotalCents > 0) ex.push({ code: "no_tax_on_taxable_sale", severity: "review", subject: s.ref, detail: "Taxable sale invoiced with no tax" });
    if (!s.entityAssigned) ex.push({ code: "sale_entity_unassigned", severity: "review", subject: s.ref, detail: "Invoice carries no financial entity — included by default" });
  }

  // Invoices that carry no entity are not attributed to this return unless the caller says so;
  // their existence is a finding — assign them, or include them on purpose.
  if (args.unassignedSalesExcluded) ex.push({ code: "sales_unassigned_excluded", severity: "review", subject: "invoices", detail: `${args.unassignedSalesExcluded} invoice(s) in the period carry no financial entity and were not included — assign them, or include them explicitly` });

  /* ---- the rate: a check, never a figure ---- */
  const det = args.rateFor(args.jurisdiction);
  const rate = det.outcome === "determined" && typeof det.parameters?.ratePercent === "number" ? det.parameters.ratePercent : null;
  const rateStatus: GstReturn["rateCheck"]["status"] = rate != null ? "checked" : /unverified/i.test(det.reason ?? "") ? "unverified" : "missing";
  let salesChecked = 0, salesDiffering = 0;
  if (rate != null) {
    // A taxable sale with no tax is already named above; checking it against the rate would name it twice.
    for (const s of sales.filter(x => x.treatment === "taxable" && !(x.taxCents === 0 && x.subtotalCents > 0))) {
      salesChecked++;
      const expected = Math.round(s.subtotalCents * rate / 100);
      if (Math.abs(expected - s.taxCents) > 2) { salesDiffering++; ex.push({ code: "collected_tax_differs_from_rate", severity: "review", subject: s.ref, detail: `Invoiced ${fmt(s.taxCents)} tax; ${rate}% of ${fmt(s.subtotalCents)} is ${fmt(expected)}` }); }
    }
  } else {
    reasons.push(`Rate ${rateStatus} for ${args.jurisdiction} — collected tax cannot be checked against a verified rate`);
    ex.push({ code: "rate_unverified", severity: "review", subject: args.jurisdiction, detail: `No verified GST/HST rate for ${args.jurisdiction}; line 105 is reported as invoiced, unchecked` });
  }

  /* ---- purchases: input tax credits ---- */
  const purchases = args.purchases.filter(p => inPeriod(p.date));
  const registered = !!args.registration?.registered;
  let claimed = 0, withheldNoEvidence = 0, withheldNotRegistered = 0, withEv = 0, without = 0;
  for (const p of purchases) {
    if (p.taxCents <= 0) continue;
    if (!registered) { withheldNotRegistered += p.taxCents; continue; }
    if (!p.hasEvidence) { withheldNoEvidence += p.taxCents; without++; ex.push({ code: "itc_withheld_no_evidence", severity: "review", subject: p.ref, detail: `${fmt(p.taxCents)} of tax on a ${p.kind.replace("_", " ")} with no evidence — not claimed until a receipt or invoice is attached` }); continue; }
    claimed += p.taxCents; withEv++;
  }
  if (!registered && purchases.some(p => p.taxCents > 0)) ex.push({ code: "not_registered", severity: "blocking", subject: "registration", detail: args.registration ? "GST/HST registration on record is not active — no input tax credits may be claimed" : "No GST/HST registration on record — the return cannot claim input tax credits, and may not be a return this entity files" });
  if (registered && args.registration && !args.registration.identifierPresent) ex.push({ code: "registration_number_missing", severity: "review", subject: "registration", detail: "Registered, but the account number is not on record" });

  /* ---- adjustments ---- */
  const adj = args.adjustments;
  const line104 = adj.filter(a => a.line === "104").reduce((a, x) => a + x.amountCents, 0);
  const line107 = adj.filter(a => a.line === "107").reduce((a, x) => a + x.amountCents, 0);
  const line109 = line105 + line104 - claimed - line107;

  const blocking = ex.some(e => e.severity === "blocking");
  const determination: GstReturn["determination"] = blocking ? "blocked" : ex.length ? "review" : "ready";
  if (blocking) reasons.unshift(`${ex.filter(e => e.severity === "blocking").length} blocking exception(s)`);
  return {
    period: args.period, periodStart: start, periodEnd: end,
    lines: { line101SalesCents: line101, line105CollectedCents: line105, line104AdjustmentsCents: line104, line108ItcCents: claimed, line107AdjustmentsCents: line107, line109NetTaxCents: line109 },
    itc: { claimedCents: claimed, withheldNoEvidenceCents: withheldNoEvidence, withheldNotRegisteredCents: withheldNotRegistered, purchasesWithEvidence: withEv, purchasesWithout: without },
    rateCheck: { status: rateStatus, jurisdiction: args.jurisdiction, ratePercent: rate, salesChecked, salesDiffering },
    exceptions: ex, determination, reasons,
  };
}

/**
 * Finalizing: nothing blocking, and every review item acknowledged by the
 * filer, by code, on the record. A review item nobody acknowledged is a
 * refusal, not a footnote.
 */
export function finalizeDecision(ret: GstReturn, acknowledged: readonly string[]): { permitted: boolean; refusals: string[]; unacknowledged: string[] } {
  const refusals: string[] = [];
  for (const e of ret.exceptions.filter(x => x.severity === "blocking")) refusals.push(`${e.code}: ${e.detail}`);
  const reviewCodes = Array.from(new Set(ret.exceptions.filter(x => x.severity === "review").map(x => x.code)));
  const unacknowledged = reviewCodes.filter(c => !acknowledged.includes(c));
  if (unacknowledged.length) refusals.push(`Review items not acknowledged: ${unacknowledged.join(", ")}`);
  return { permitted: refusals.length === 0, refusals, unacknowledged };
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
