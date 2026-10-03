/**
 * v22.9 — An invoice is drawn from a signed ticket's accepted lines and their
 * pricing decisions. Nothing is priced here: the decision already holds the
 * billable quantity, the rate and the reasons. What this decides is which
 * lines may enter the invoice and why the rest may not, and whether the
 * invoice may be finalized — a taxable invoice needs a verified rate, and
 * the rate is a P9 rule, not a figure typed here.
 */
import { createHash } from "node:crypto";
import type { SignatureVerdict } from "./fieldTicketSignature";

export type TicketLineForInvoice = { id: number; description: string; serviceCode: string | null; disposition: "not_presented" | "accepted" | "disputed"; quantity: number | null; quantityUnit: string | null; decision: { decisionRef: string; outcome: string; amountCents: number | null; billableQuantityMillis: number | null; rateMillis: number | null; unit: string; quantityMillis: number; scopeLevel: string | null; reasons: string[] } | null };
export type DraftLine = { lineNo: number; fieldTicketLineId: number; pricingDecisionRef: string; serviceCode: string | null; description: string; quantityMillis: number; billableQuantityMillis: number; unit: string; rateMillis: number | null; amountCents: number; basis: string };
export type Draft = { lines: DraftLine[]; excluded: { fieldTicketLineId: number; description: string; reason: string }[]; blockers: string[]; subtotalCents: number };

/** Which lines enter the invoice, which are excluded and why, and what blocks the draft. */
export function draftFromTicket(args: { signature: SignatureVerdict; lines: readonly TicketLineForInvoice[]; partialAcceptanceAllowed: boolean; alreadyInvoiced?: ReadonlyMap<number, string> }): Draft {
  const blockers: string[] = [];
  const lines: DraftLine[] = [];
  const excluded: Draft["excluded"] = [];
  // SPINE item 2 — billing consumes the site sign-off's verdict; it never decides "signed" itself.
  // Only a satisfied verdict lets the draft proceed: no signature found is not "not required", and
  // records that disagree are not "signed".
  const sig = args.signature;
  if (sig.state === "unsigned") blockers.push("Ticket is not signed — an invoice is drawn from a signed ticket");
  else if (sig.state === "refused") blockers.push("Customer refused the site ticket — an invoice is drawn from a signed ticket");
  else if (sig.state === "no_representative") blockers.push("No customer representative signed — an invoice is drawn from a signed ticket");
  else if (sig.state === "stale") blockers.push(`Signature does not cover the current revision — ${sig.reason}`);
  else if (!sig.satisfied) blockers.push(`Signature not established — ${sig.reason}`);
  let lineNo = 0;
  for (const l of args.lines) {
    const on = args.alreadyInvoiced?.get(l.id);
    if (on) { excluded.push({ fieldTicketLineId: l.id, description: l.description, reason: `Already on invoice ${on}` }); continue; }
    if (l.disposition === "disputed") { if (args.partialAcceptanceAllowed) excluded.push({ fieldTicketLineId: l.id, description: l.description, reason: "Disputed by the customer — held for review; accepted lines proceed under this customer's configuration" }); else blockers.push(`Line ${l.id} (${l.description}) is disputed and this customer does not accept partial invoices`); continue; }
    if (l.disposition === "not_presented") { blockers.push(`Line ${l.id} (${l.description}) was not presented for acceptance`); continue; }
    if (!l.serviceCode) { excluded.push({ fieldTicketLineId: l.id, description: l.description, reason: "No service named — a note, not a charge" }); continue; }
    if (!l.decision) { blockers.push(`Line ${l.id} (${l.description}) has no pricing decision`); continue; }
    if (l.decision.outcome !== "priced" || l.decision.amountCents == null) { blockers.push(`Line ${l.id} (${l.description}): ${l.decision.outcome.replace(/_/g, " ").toUpperCase()}`); continue; }
    lineNo += 1;
    lines.push({ lineNo, fieldTicketLineId: l.id, pricingDecisionRef: l.decision.decisionRef, serviceCode: l.serviceCode, description: l.description, quantityMillis: l.decision.quantityMillis, billableQuantityMillis: l.decision.billableQuantityMillis ?? l.decision.quantityMillis, unit: l.decision.unit, rateMillis: l.decision.rateMillis, amountCents: l.decision.amountCents, basis: `${l.decision.scopeLevel ?? "decision"} · ${l.decision.decisionRef}` });
  }
  if (!lines.length && !blockers.length) blockers.push(args.alreadyInvoiced?.size ? "Nothing new to invoice — every accepted, priced line is already on a live invoice" : "No accepted, priced line to invoice");
  return { lines, excluded, blockers, subtotalCents: lines.reduce((a, l) => a + l.amountCents, 0) };
}

/** Whether an invoice may be voided: never a draft or a void, never one with money applied to it — that is a credit. */
export function voidCheck(args: { status: string; allocatedCents: number; approvedCreditCents: number }): { permitted: boolean; refusals: string[] } {
  const refusals: string[] = [];
  if (args.status === "draft" || args.status === "void") refusals.push(`Invoice is ${args.status}`);
  if (args.status === "paid" || args.status === "partially_paid") refusals.push(`Invoice is ${args.status} — a paid invoice is credited, not voided`);
  if (args.allocatedCents > 0) refusals.push(`$${(args.allocatedCents / 100).toFixed(2)} of payments are allocated to it — credit instead`);
  if (args.approvedCreditCents > 0) refusals.push(`$${(args.approvedCreditCents / 100).toFixed(2)} of approved credits stand against it — the credit already answers`);
  return { permitted: refusals.length === 0, refusals };
}

/** How a dispute may be resolved: the credit is bounded by the disputed amount, and its approval is a second person's act elsewhere. */
export function disputeResolution(args: { caseStatus: string; outcome: "upheld" | "credited" | "partial"; disputedAmountCents: number; creditAmountCents: number | null }): { permitted: boolean; caseStatus: "resolved_upheld" | "resolved_credited" | "resolved_partial" | null; creditCents: number; refusals: string[] } {
  const refusals: string[] = [];
  if (!["raised", "investigating", "evidence_gathered", "escalated"].includes(args.caseStatus)) refusals.push(`Case is ${args.caseStatus}`);
  let creditCents = 0;
  if (args.outcome === "upheld") { if (args.creditAmountCents) refusals.push("An upheld dispute carries no credit"); }
  else {
    if (args.creditAmountCents == null || args.creditAmountCents <= 0) refusals.push("A credited resolution names the credit amount");
    else if (args.creditAmountCents > args.disputedAmountCents) refusals.push(`Credit $${(args.creditAmountCents / 100).toFixed(2)} exceeds the disputed $${(args.disputedAmountCents / 100).toFixed(2)}`);
    else if (args.outcome === "credited" && args.creditAmountCents !== args.disputedAmountCents) refusals.push("A full credit equals the disputed amount; a smaller one is a partial resolution");
    else if (args.outcome === "partial" && args.creditAmountCents === args.disputedAmountCents) refusals.push("A partial resolution credits less than the disputed amount");
    else creditCents = args.creditAmountCents;
  }
  return { permitted: refusals.length === 0, caseStatus: refusals.length ? null : args.outcome === "upheld" ? "resolved_upheld" : args.outcome === "credited" ? "resolved_credited" : "resolved_partial", creditCents, refusals };
}

export type RateDetermination = { outcome: "determined" | "unverified" | "missing"; ratePercent: number | null; reason: string | null };
/** Whether the invoice may be finalized, and the tax it carries if so. */
export function finalizeCheck(args: { status: string; gstTreatment: "taxable" | "zero_rated" | "exempt" | "unknown"; jurisdiction: string; rate: RateDetermination; subtotalCents: number; lineCount: number }): { permitted: boolean; taxCents: number | null; refusals: string[] } {
  const refusals: string[] = [];
  if (args.status !== "draft") refusals.push(`Invoice is ${args.status}, not a draft`);
  if (args.lineCount === 0) refusals.push("Invoice has no lines");
  let taxCents: number | null = null;
  if (args.gstTreatment === "unknown") refusals.push("GST/HST treatment not set — a person sets it (gst.treatmentSet) before finalization");
  else if (args.gstTreatment === "taxable") {
    if (args.rate.outcome === "determined" && args.rate.ratePercent != null) taxCents = Math.round(args.subtotalCents * args.rate.ratePercent / 100);
    else refusals.push(`GST/HST rate for ${args.jurisdiction} is ${args.rate.outcome} — a taxable invoice is not finalized on an unverified rate (P9)${args.rate.reason ? `: ${args.rate.reason}` : ""}`);
  } else taxCents = 0;
  return { permitted: refusals.length === 0, taxCents, refusals };
}

export function snapshotHash(payload: unknown): string {
  const canonical = (v: unknown): unknown => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
