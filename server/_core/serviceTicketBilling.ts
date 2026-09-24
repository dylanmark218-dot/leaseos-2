/**
 * 0175 — The open-ticket billing lifecycle: pure decisions.
 *
 * A field ticket accumulates lines and events while work happens; this module decides what its
 * commercial state may become and what may still be written to it. The router stores, locks and
 * audits; nothing here touches a database.
 *
 *   DRAFT → OPEN → AWAITING_CUSTOMER_REVIEW → CUSTOMER_ACCEPTED → FINALIZED → INVOICED
 *                              ↕                     ↓
 *                          DISPUTED ─────────────────┘
 *   any state before INVOICED → VOID
 *
 * Amounts are never stored on the ticket: a line's amount is its pricing decision's, and the
 * ticket's totals are derived from its lines every time. What is frozen at FINALIZED is a revision
 * carrying the lines and totals as they stood, under a hash; a later correction is an amendment
 * revision beside it, never an edit of it.
 */
import { createHash } from "node:crypto";
import type { BillingState } from "../../drizzle/schema";

export type BillingAction = "open" | "present" | "reopen" | "accept" | "dispute" | "finalize" | "invoice" | "void" | "invoice_voided";

const TRANSITIONS: Record<BillingState, Partial<Record<BillingAction, BillingState>>> = {
  DRAFT: { open: "OPEN", present: "AWAITING_CUSTOMER_REVIEW", void: "VOID" },
  OPEN: { open: "OPEN", present: "AWAITING_CUSTOMER_REVIEW", void: "VOID" },
  AWAITING_CUSTOMER_REVIEW: { present: "AWAITING_CUSTOMER_REVIEW", accept: "CUSTOMER_ACCEPTED", dispute: "DISPUTED", reopen: "OPEN", finalize: "FINALIZED", void: "VOID" },
  CUSTOMER_ACCEPTED: { accept: "CUSTOMER_ACCEPTED", dispute: "DISPUTED", reopen: "OPEN", finalize: "FINALIZED", invoice: "INVOICED", void: "VOID" },
  DISPUTED: { present: "AWAITING_CUSTOMER_REVIEW", accept: "CUSTOMER_ACCEPTED", dispute: "DISPUTED", reopen: "OPEN", finalize: "FINALIZED", invoice: "INVOICED", void: "VOID" },
  FINALIZED: { finalize: "FINALIZED", invoice: "INVOICED", void: "VOID" },
  INVOICED: { invoice: "INVOICED", invoice_voided: "FINALIZED" },
  VOID: {},
};

/** The next state for an action, or the named reason it is refused. Idempotent actions return the same state. */
export function billingTransition(from: BillingState, action: BillingAction): { ok: true; to: BillingState; changed: boolean } | { ok: false; reason: string } {
  const to = TRANSITIONS[from]?.[action];
  if (!to) return { ok: false, reason: `A ticket that is ${from.replace(/_/g, " ").toLowerCase()} cannot be ${describe(action)}` };
  return { ok: true, to, changed: to !== from };
}

function describe(a: BillingAction): string {
  return { open: "opened", present: "presented for customer review", reopen: "reopened", accept: "accepted", dispute: "disputed", finalize: "finalized", invoice: "invoiced", void: "voided", invoice_voided: "returned from a voided invoice" }[a];
}

/** Finalizing a ticket the customer has not accepted is allowed only when the office says so, by name. */
export function finalizeCheck(args: { state: BillingState; withoutCustomerAcceptance: boolean; reason: string | null; lineCount: number }): { permitted: boolean; refusals: string[]; overrides: string | null } {
  const refusals: string[] = [];
  const t = billingTransition(args.state, "finalize");
  if (!t.ok) refusals.push(t.reason);
  if (args.lineCount === 0) refusals.push("A ticket with no lines has nothing to finalize");
  let overrides: string | null = null;
  if (t.ok && args.state !== "CUSTOMER_ACCEPTED" && args.state !== "FINALIZED") {
    if (!args.withoutCustomerAcceptance) refusals.push(`The customer has not accepted this ticket (${args.state.replace(/_/g, " ").toLowerCase()}); finalize with withoutCustomerAcceptance and a reason, or wait`);
    else if (!args.reason?.trim()) refusals.push("Finalizing without customer acceptance needs a reason");
    else overrides = args.reason.trim();
  }
  return { permitted: refusals.length === 0, refusals, overrides };
}

/** May a line be added or changed in this state? Once the customer has accepted a hash, or the ticket is frozen, no. */
export function lineWritePermitted(state: BillingState): { permitted: boolean; reason: string | null } {
  switch (state) {
    case "DRAFT": case "OPEN": case "AWAITING_CUSTOMER_REVIEW": case "DISPUTED": return { permitted: true, reason: null };
    case "CUSTOMER_ACCEPTED": return { permitted: false, reason: "The customer accepted this ticket as presented — reopen it before changing a line" };
    case "FINALIZED": return { permitted: false, reason: "The ticket is finalized — a correction is an amendment, never an edit" };
    case "INVOICED": return { permitted: false, reason: "The ticket is invoiced — a correction is a credit against the invoice" };
    case "VOID": return { permitted: false, reason: "The ticket is void" };
  }
}

/** A write that names the version it read is refused when the version moved. A write that names none is serialized by the lock alone. */
export function versionCheck(expected: number | null | undefined, current: number): { ok: boolean; reason: string | null } {
  if (expected == null || expected === current) return { ok: true, reason: null };
  return { ok: false, reason: `The ticket changed since you read it (version ${expected} → ${current}) — reload and try again` };
}

export type TotalsLine = { customerVisible: boolean; priced: boolean; amountCents: number | null; amendsLineId?: number | null };

/** Derived every time, never stored. Customer figures count only customer-visible priced lines. */
export function ticketTotals(lines: readonly TotalsLine[]): { subtotalCents: number; customerSubtotalCents: number; internalCents: number; pricedLines: number; unpricedLines: number; visibleLines: number; amendmentLines: number } {
  let subtotal = 0, customer = 0, priced = 0, unpriced = 0, visible = 0, amendments = 0;
  for (const l of lines) {
    if (l.customerVisible) visible++;
    if (l.amendsLineId != null) amendments++;
    if (l.priced && l.amountCents != null) { priced++; subtotal += l.amountCents; if (l.customerVisible) customer += l.amountCents; }
    else unpriced++;
  }
  return { subtotalCents: subtotal, customerSubtotalCents: customer, internalCents: subtotal - customer, pricedLines: priced, unpricedLines: unpriced, visibleLines: visible, amendmentLines: amendments };
}

export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
export const hashOf = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");

export type FinalSnapshot = {
  kind: "final" | "amendment";
  ticketNumber: string;
  billingVersion: number;
  lines: { id: number; lineKind: string; serviceCode: string | null; description: string; quantity: number | null; quantityUnit: string | null; customerVisible: boolean; disposition: string; pricingDecisionRef: string | null; amountCents: number | null; amendsLineId: number | null }[];
  billing: ReturnType<typeof ticketTotals>;
  siteSnapshotHash: string | null;
  signaturePayloadHash: string | null;
  supersedesRevisionHash: string | null;
  finalizedWithoutCustomerAcceptance: string | null;
  at: string;
};

/** The frozen record. Same lines, same hash — a second computation over unchanged rows reproduces it. */
export function composeFinalSnapshot(args: Omit<FinalSnapshot, "billing"> & { lines: FinalSnapshot["lines"] }): { snapshot: FinalSnapshot; hash: string } {
  const snapshot: FinalSnapshot = { ...args, billing: ticketTotals(args.lines.map(l => ({ customerVisible: l.customerVisible, priced: l.amountCents != null, amountCents: l.amountCents, amendsLineId: l.amendsLineId }))) };
  return { snapshot, hash: hashOf(snapshot) };
}
