/**
 * Client discretionary adjustments.
 *
 * A customer may add money to a ticket: a tip, a bonus, a flat amount, a
 * percentage, or an HOUR-EQUIVALENT — billing value expressed in hours
 * because the customer's accounting wants an hour on the invoice. An
 * hour-equivalent is not worked time. It changes what is billed and
 * nothing else: no duty, payroll, GPS, equipment or standby clock moves.
 * Every adjustment says who it is for; one meant for workers is PROPOSED
 * to payroll for an authorized person to decide — the customer never writes
 * payroll, and tax treatment is not decided here.
 */

export type AdjustmentKind = "tip" | "crew_bonus" | "exceptional_service_bonus" | "flat" | "percent" | "completion_bonus" | "callout_bonus" | "hour_equivalent";
export type RecipientIntent = "company" | "crew" | "named_workers" | "operator" | "supervisor" | "company_crew_split" | "unknown";

export type AdjustmentRequest = { kind: AdjustmentKind; amountCents?: number; percent?: number; hourEquivalent?: number; recipientIntent: RecipientIntent; namedWorkers?: string[]; reason: string };
export type TicketBilling = { siteSubtotalCents: number; siteBillableHours: number; agreedHourlyRateCents: number | null };

export type AdjustmentDecision =
  | { permitted: true; amountCents: number; hourEquivalentMinutes: number | null; basis: Record<string, unknown>; payrollTreatment: "not_applicable" | "awaiting_recipient" | "proposed"; clocksUnchanged: true }
  | { permitted: false; refusals: string[] };

export function decideAdjustment(req: AdjustmentRequest, billing: TicketBilling): AdjustmentDecision {
  const refusals: string[] = [];
  if (req.reason.trim().length < 5) refusals.push("An adjustment needs a reason");
  let amount = 0, minutes: number | null = null;
  const basis: Record<string, unknown> = { kind: req.kind };
  switch (req.kind) {
    case "percent": {
      if (req.percent == null || req.percent <= 0 || req.percent > 100) refusals.push("Percent must be between 0 and 100");
      else { amount = Math.round(billing.siteSubtotalCents * req.percent / 100); Object.assign(basis, { percent: req.percent, ofSiteSubtotalCents: billing.siteSubtotalCents }); }
      break;
    }
    case "hour_equivalent": {
      if (req.hourEquivalent == null || req.hourEquivalent <= 0 || req.hourEquivalent > 24) refusals.push("Hour-equivalent must be between 0 and 24 hours");
      else if (billing.agreedHourlyRateCents == null) refusals.push("An hour-equivalent needs the agreed hourly rate on the ticket; none is priced — record a flat amount, or price the ticket first");
      else { minutes = Math.round(req.hourEquivalent * 60); amount = Math.round(req.hourEquivalent * billing.agreedHourlyRateCents); Object.assign(basis, { hourEquivalent: req.hourEquivalent, agreedHourlyRateCents: billing.agreedHourlyRateCents, note: "billing value expressed in hours — NOT worked time; no clock changes" }); }
      break;
    }
    default: {
      if (req.amountCents == null || req.amountCents <= 0) refusals.push("Amount must be positive");
      else { amount = req.amountCents; Object.assign(basis, { amountCents: req.amountCents }); }
    }
  }
  if (req.recipientIntent === "named_workers" && !(req.namedWorkers && req.namedWorkers.length)) refusals.push("Named workers were intended and none were named");
  if (refusals.length) return { permitted: false, refusals };
  const forWorkers = ["crew", "named_workers", "operator", "supervisor", "company_crew_split"].includes(req.recipientIntent);
  return { permitted: true, amountCents: amount, hourEquivalentMinutes: minutes, basis, payrollTreatment: req.recipientIntent === "unknown" ? "awaiting_recipient" : forWorkers ? "proposed" : "not_applicable", clocksUnchanged: true };
}

/** The invoice view of a ticket after adjustments: billed hours may include hour-equivalents; worked hours never do. */
export function billedView(siteBillableHours: number, postSiteBillableHours: number, adjustments: readonly { kind: AdjustmentKind; amountCents: number; hourEquivalentMinutes: number | null; status: "authorized" | "withdrawn" }[]) {
  const live = adjustments.filter(a => a.status === "authorized");
  const heqHours = live.reduce((a, x) => a + (x.hourEquivalentMinutes ?? 0), 0) / 60;
  return {
    workedHoursVerified: siteBillableHours + postSiteBillableHours,
    hourEquivalentHours: heqHours,
    invoiceHours: siteBillableHours + postSiteBillableHours + heqHours,
    adjustmentCents: live.reduce((a, x) => a + x.amountCents, 0),
    note: heqHours > 0 ? `${heqHours.toFixed(2)} h of the invoice quantity is hour-equivalent — billing value, not worked time` : null,
  };
}
