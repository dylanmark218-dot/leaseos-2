/**
 * Accounts receivable.
 *
 * What a customer owes on an invoice is its total less allocated payments
 * less approved credits. An allocation never exceeds the payment's
 * unallocated amount or the invoice's balance, and never crosses customers.
 * Aging is what is left, bucketed from the due date; a disputed invoice ages
 * in its own bucket, because chasing it is a different conversation. A
 * write-off is requested by one person and decided by another — the
 * collector follows up; the controller authorizes.
 */

export type ArInvoice = { id: number; invoiceNumber: string; customer: string; totalCents: number; dueAt: Date | null; issuedAt: Date; status: string; disputed: boolean; financialEntityId?: number | null; customerAccountId?: number | null };
export type ArAllocation = { invoiceId: number; amountCents: number };
export type ArCredit = { invoiceId: number | null; customer: string; amountCents: number; status: "requested" | "approved" | "refused" };
export type ArPayment = { id: number; customer: string; amountCents: number; financialEntityId?: number | null; customerAccountId?: number | null };

export function invoiceBalanceCents(inv: ArInvoice, allocations: readonly ArAllocation[], credits: readonly ArCredit[]): number {
  const paid = allocations.filter(a => a.invoiceId === inv.id).reduce((a, x) => a + x.amountCents, 0);
  const credited = credits.filter(c => c.invoiceId === inv.id && c.status === "approved").reduce((a, x) => a + x.amountCents, 0);
  return inv.totalCents - paid - credited;
}

export type AllocationDecision = { permitted: true; invoiceBalanceAfterCents: number; paymentUnallocatedAfterCents: number; invoiceStatusAfter: "paid" | "partially_paid" } | { permitted: false; refusals: string[] };

export function allocatePayment(args: { payment: ArPayment; alreadyAllocatedCents: number; invoice: ArInvoice; invoiceAllocations: readonly ArAllocation[]; credits: readonly ArCredit[]; amountCents: number }): AllocationDecision {
  const refusals: string[] = [];
  if (args.amountCents <= 0) refusals.push("Allocation must be positive");
  // v21.9.1 — identity, not a name. Same financial entity, then the same customer
  // account. Two companies can each have an "ABC Energy"; a name proved nothing.
  if (args.invoice.financialEntityId == null) refusals.push(`Invoice ${args.invoice.invoiceNumber} carries no financial entity — assign it before applying cash`);
  else if (args.payment.financialEntityId != null && args.invoice.financialEntityId !== args.payment.financialEntityId) refusals.push(`Payment belongs to entity ${args.payment.financialEntityId}; invoice ${args.invoice.invoiceNumber} to entity ${args.invoice.financialEntityId} — an allocation never crosses entities`);
  if (args.invoice.customerAccountId != null && args.payment.customerAccountId != null) {
    if (args.invoice.customerAccountId !== args.payment.customerAccountId) refusals.push(`Payment is from customer account ${args.payment.customerAccountId}; invoice ${args.invoice.invoiceNumber} is account ${args.invoice.customerAccountId}'s — an allocation never crosses customers`);
  } else if (args.invoice.customer !== args.payment.customer) {
    refusals.push(`Payment is from ${args.payment.customer}; invoice ${args.invoice.invoiceNumber} is ${args.invoice.customer}'s — an allocation never crosses customers`);
  }
  if (args.invoice.status === "void" || args.invoice.status === "draft") refusals.push(`Invoice ${args.invoice.invoiceNumber} is ${args.invoice.status}`);
  const unallocated = args.payment.amountCents - args.alreadyAllocatedCents;
  if (args.amountCents > unallocated) refusals.push(`Payment has ${fmt(unallocated)} unallocated; ${fmt(args.amountCents)} requested`);
  const balance = invoiceBalanceCents(args.invoice, args.invoiceAllocations, args.credits);
  if (args.amountCents > balance) refusals.push(`Invoice ${args.invoice.invoiceNumber} balance is ${fmt(balance)}; ${fmt(args.amountCents)} requested — an overpayment stays unapplied on the payment, it is not forced onto the invoice`);
  if (refusals.length) return { permitted: false, refusals };
  const after = balance - args.amountCents;
  return { permitted: true, invoiceBalanceAfterCents: after, paymentUnallocatedAfterCents: unallocated - args.amountCents, invoiceStatusAfter: after === 0 ? "paid" : "partially_paid" };
}

export type AgingBucket = "current" | "d31_60" | "d61_90" | "d90_plus" | "disputed";
export type Aging = { asOf: Date; buckets: Record<AgingBucket, number>; totalOutstandingCents: number; unappliedPaymentsCents: number; byCustomer: { customer: string; outstandingCents: number; oldestDays: number | null; disputedCents: number }[]; invoices: { invoiceNumber: string; customer: string; balanceCents: number; bucket: AgingBucket; daysPastDue: number | null }[] };

export function aging(args: { invoices: readonly ArInvoice[]; allocations: readonly ArAllocation[]; credits: readonly ArCredit[]; payments: readonly ArPayment[]; paymentAllocatedCents: ReadonlyMap<number, number>; asOf: Date }): Aging {
  const buckets: Record<AgingBucket, number> = { current: 0, d31_60: 0, d61_90: 0, d90_plus: 0, disputed: 0 };
  const rows: Aging["invoices"] = [];
  const byCust = new Map<string, { outstandingCents: number; oldestDays: number | null; disputedCents: number }>();
  for (const inv of args.invoices) {
    if (inv.status === "void" || inv.status === "draft") continue;
    const balance = invoiceBalanceCents(inv, args.allocations, args.credits);
    if (balance <= 0) continue;
    const due = inv.dueAt ?? inv.issuedAt;
    const days = Math.floor((args.asOf.getTime() - due.getTime()) / 86_400_000);
    const bucket: AgingBucket = inv.disputed ? "disputed" : days <= 30 ? "current" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90_plus";
    buckets[bucket] += balance;
    rows.push({ invoiceNumber: inv.invoiceNumber, customer: inv.customer, balanceCents: balance, bucket, daysPastDue: days > 0 ? days : null });
    const c = byCust.get(inv.customer) ?? { outstandingCents: 0, oldestDays: null, disputedCents: 0 };
    c.outstandingCents += balance;
    if (inv.disputed) c.disputedCents += balance;
    if (days > 0 && (c.oldestDays == null || days > c.oldestDays)) c.oldestDays = days;
    byCust.set(inv.customer, c);
  }
  const unapplied = args.payments.reduce((a, p) => a + Math.max(0, p.amountCents - (args.paymentAllocatedCents.get(p.id) ?? 0)), 0);
  return {
    asOf: args.asOf, buckets, totalOutstandingCents: Object.values(buckets).reduce((a, b) => a + b, 0), unappliedPaymentsCents: unapplied,
    byCustomer: Array.from(byCust.entries()).map(([customer, c]) => ({ customer, ...c })).sort((a, b) => b.outstandingCents - a.outstandingCents),
    invoices: rows.sort((a, b) => (b.daysPastDue ?? -1) - (a.daysPastDue ?? -1)),
  };
}

export function writeOffDecision(args: { requestedByUserId: number; deciderUserId: number; amountCents: number; invoiceBalanceCents: number }): { permitted: boolean; refusals: string[] } {
  const refusals: string[] = [];
  if (args.requestedByUserId === args.deciderUserId) refusals.push("The requester may not decide their own write-off");
  if (args.amountCents > args.invoiceBalanceCents) refusals.push(`Write-off ${fmt(args.amountCents)} exceeds the balance ${fmt(args.invoiceBalanceCents)}`);
  if (args.amountCents <= 0) refusals.push("Write-off must be positive");
  return { permitted: refusals.length === 0, refusals };
}

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
