/**
 * Contract terms — the rule the closeout was waiting for.
 *
 * A term decides an event's customer-billable answer and is cited on the
 * event with its clause. Grace minutes reduce what the customer pays for on
 * a standby; the event's clock is never touched. Without approved terms in
 * effect, the answer is REVIEW, as before. Terms are recorded by one person
 * and approved by another against the contract document.
 */

export type Terms = {
  termsRef: string; version: number; title: string;
  standbyBillable: "yes" | "no"; standbyFreeMinutes: number;
  customerHoldBillable: "yes" | "no"; weatherHoldBillable: "yes" | "no";
  travelToDisposalBillable: "yes" | "no"; disposalQueueBillable: "yes" | "no"; disposalBillable: "yes" | "no"; returnTravelBillable: "yes" | "no";
  minimumHours: number | null;
  clauses: Record<string, string>;
  effectiveFrom: Date; effectiveTo: Date | null; status: "draft" | "approved" | "superseded";
};

export type BillingDecision = { customerBillable: "yes" | "no" | "review"; billableMinutes: number | null; ruleRef: string | null; reason: string };

const TERM_FOR: Record<string, keyof Terms> = { standby: "standbyBillable", customer_hold: "customerHoldBillable", weather_hold: "weatherHoldBillable", travel_to_disposal: "travelToDisposalBillable", disposal_queue: "disposalQueueBillable", disposal: "disposalBillable", return_travel: "returnTravelBillable" };

export function termsInEffect(terms: readonly Terms[], at: Date): Terms | null {
  return terms.filter(t => t.status === "approved" && t.effectiveFrom <= at && (!t.effectiveTo || at <= t.effectiveTo)).sort((a, b) => b.version - a.version)[0] ?? null;
}

export function decideBillable(args: { eventType: string; occurredAt: Date; durationMinutes: number | null; terms: Terms | null }): BillingDecision {
  const key = TERM_FOR[args.eventType];
  if (!key) return { customerBillable: "review", billableMinutes: null, ruleRef: null, reason: "No contract term covers this event kind" };
  if (!args.terms) return { customerBillable: "review", billableMinutes: null, ruleRef: null, reason: "No approved contract terms in effect on the event's date — REVIEW" };
  const t = args.terms;
  const answer = t[key] as "yes" | "no";
  const clause = t.clauses[args.eventType] ?? t.clauses[String(key)] ?? null;
  const ruleRef = `${t.termsRef} v${t.version}${clause ? ` ${clause}` : ""}`.slice(0, 80);
  if (answer === "no") return { customerBillable: "no", billableMinutes: 0, ruleRef, reason: `${t.title}${clause ? ` ${clause}` : ""}: ${args.eventType.replace(/_/g, " ")} is not billable` };
  if (args.eventType === "standby" && t.standbyFreeMinutes > 0) {
    if (args.durationMinutes == null) return { customerBillable: "yes", billableMinutes: null, ruleRef, reason: `${t.title}: standby billable after the first ${t.standbyFreeMinutes} min — billable minutes computed when the event closes` };
    const billable = Math.max(0, args.durationMinutes - t.standbyFreeMinutes);
    return { customerBillable: billable > 0 ? "yes" : "no", billableMinutes: billable, ruleRef, reason: billable > 0 ? `${t.title}${clause ? ` ${clause}` : ""}: standby billable after the first ${t.standbyFreeMinutes} min — ${billable} of ${args.durationMinutes} min billable` : `${t.title}: standby of ${args.durationMinutes} min is within the ${t.standbyFreeMinutes} min grace — not billable` };
  }
  return { customerBillable: "yes", billableMinutes: args.durationMinutes, ruleRef, reason: `${t.title}${clause ? ` ${clause}` : ""}: ${args.eventType.replace(/_/g, " ")} is billable` };
}

export function approvalDecision(args: { recordedByUserId: number; approverUserId: number; status: string; sourceDocumentEvidenceId: number | null }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.status !== "draft") r.push(`Terms are ${args.status}`);
  if (args.recordedByUserId === args.approverUserId) r.push("The person who recorded the terms may not approve them");
  if (!args.sourceDocumentEvidenceId) r.push("Approval needs the contract document in the evidence vault");
  return { permitted: r.length === 0, refusals: r };
}
