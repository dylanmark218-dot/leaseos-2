/**
 * Commercial core.
 *
 * Before an invoice is issued: is the account on hold; does it require a PO
 * or an AFE, and is one on file, live, and not exhausted; would this invoice
 * take the account over its credit limit. Each answer is a named blocker or
 * a named review item; none is a score. Pricing: a customer's rate card
 * prices a service line by code and unit; a line with no rate on the card is
 * a finding, not a zero.
 */

export type CustomerTerms = { status: "active" | "on_hold" | "inactive"; holdReason: string | null; paymentTermsDays: number; creditLimitCents: number | null; requiresPurchaseOrder: boolean; requiresAfe: boolean };
export type PurchaseOrder = { poRef: string; poNumber: string; afeNumber: string | null; authorizedCents: number; consumedCents: number; validFrom: Date; validTo: Date | null; status: "open" | "exhausted" | "expired" | "closed" };

export type PoAvailability = { available: boolean; remainingCents: number; reason: string };

export function poAvailability(po: PurchaseOrder, amountCents: number, at: Date): PoAvailability {
  const remaining = po.authorizedCents - po.consumedCents;
  if (po.status === "closed") return { available: false, remainingCents: remaining, reason: `PO ${po.poNumber} is closed` };
  if (at < po.validFrom) return { available: false, remainingCents: remaining, reason: `PO ${po.poNumber} is not valid until ${po.validFrom.toISOString().slice(0, 10)}` };
  if (po.validTo && at >= po.validTo) return { available: false, remainingCents: remaining, reason: `PO ${po.poNumber} expired ${po.validTo.toISOString().slice(0, 10)}` };
  if (amountCents > remaining) return { available: false, remainingCents: remaining, reason: `PO ${po.poNumber} has ${fmt(remaining)} remaining of ${fmt(po.authorizedCents)}; ${fmt(amountCents)} requested` };
  return { available: true, remainingCents: remaining - amountCents, reason: `PO ${po.poNumber}: ${fmt(remaining - amountCents)} will remain` };
}

export type CommercialFinding = { code: string; severity: "blocking" | "review"; detail: string; action: string };

export function commercialBillingCheck(args: { terms: CustomerTerms; invoiceTotalCents: number; outstandingCents: number; po: PurchaseOrder | null; afeSupplied: string | null; at: Date }): { verdict: "ready" | "review" | "blocked"; findings: CommercialFinding[]; dueAt: Date } {
  const f: CommercialFinding[] = [];
  const t = args.terms;
  if (t.status === "on_hold") f.push({ code: "account_on_hold", severity: "blocking", detail: `Account is on hold${t.holdReason ? `: ${t.holdReason}` : ""}`, action: "Release the hold before invoicing" });
  if (t.status === "inactive") f.push({ code: "account_inactive", severity: "blocking", detail: "Account is inactive", action: "Reactivate the account, or bill another" });
  if (t.requiresPurchaseOrder) {
    if (!args.po) f.push({ code: "po_required", severity: "blocking", detail: "Customer requires a purchase order and none is on the invoice", action: "Attach the customer's PO" });
    else { const a = poAvailability(args.po, args.invoiceTotalCents, args.at); if (!a.available) f.push({ code: "po_unavailable", severity: "blocking", detail: a.reason, action: "Obtain a new PO or an amendment" }); }
  }
  if (t.requiresAfe && !(args.afeSupplied || args.po?.afeNumber)) f.push({ code: "afe_required", severity: "blocking", detail: "Customer requires an AFE and none is on the invoice", action: "Attach the AFE" });
  if (t.creditLimitCents != null && args.outstandingCents + args.invoiceTotalCents > t.creditLimitCents) f.push({ code: "over_credit_limit", severity: "review", detail: `${fmt(args.outstandingCents)} outstanding plus ${fmt(args.invoiceTotalCents)} exceeds the ${fmt(t.creditLimitCents)} limit`, action: "Collect first, or management approves the exposure" });
  const dueAt = new Date(args.at.getTime() + t.paymentTermsDays * 86_400_000);
  const blocking = f.some(x => x.severity === "blocking");
  return { verdict: blocking ? "blocked" : f.length ? "review" : "ready", findings: f, dueAt };
}

export type RateLine = { serviceCode: string; unit: "hour" | "day" | "km" | "m3" | "tonne" | "load" | "each"; rateCents: number; minimumCents: number | null };
export type ServiceLine = { serviceCode: string; quantity: number; unit: RateLine["unit"] };

export function priceLines(card: readonly RateLine[], lines: readonly ServiceLine[]): { priced: { serviceCode: string; quantity: number; unit: string; rateCents: number; amountCents: number; minimumApplied: boolean }[]; unpriced: { serviceCode: string; reason: string }[]; totalCents: number } {
  const priced: ReturnType<typeof priceLines>["priced"] = [];
  const unpriced: ReturnType<typeof priceLines>["unpriced"] = [];
  for (const l of lines) {
    const r = card.find(c => c.serviceCode === l.serviceCode);
    if (!r) { unpriced.push({ serviceCode: l.serviceCode, reason: "No rate on the customer's card — price it explicitly or add the line to the card" }); continue; }
    if (r.unit !== l.unit) { unpriced.push({ serviceCode: l.serviceCode, reason: `Card prices ${l.serviceCode} per ${r.unit}; the line is in ${l.unit}` }); continue; }
    const raw = Math.round(l.quantity * r.rateCents);
    const amount = r.minimumCents != null && raw < r.minimumCents ? r.minimumCents : raw;
    priced.push({ serviceCode: l.serviceCode, quantity: l.quantity, unit: l.unit, rateCents: r.rateCents, amountCents: amount, minimumApplied: amount !== raw });
  }
  return { priced, unpriced, totalCents: priced.reduce((a, p) => a + p.amountCents, 0) };
}

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
