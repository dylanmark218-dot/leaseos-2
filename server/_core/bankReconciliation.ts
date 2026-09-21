/**
 * Bank reconciliation.
 *
 * Each statement line matches at most one LeaseOS movement: same signed
 * amount, posted within the window of when LeaseOS recorded it. A line that
 * could be two movements is ambiguous — a person decides. A line nothing
 * explains is an unknown deposit or an unknown withdrawal. Movements the
 * statement has not shown are outstanding: withdrawals not yet cleared are
 * outstanding cheques; deposits not yet posted are in transit.
 *
 * The reconciliation itself is arithmetic:
 *   bank closing − outstanding withdrawals + deposits in transit
 *   = book opening + LeaseOS movements
 * and the difference, if any, is the thing to explain.
 */

export type Movement = { kind: "customer_payment" | "vendor_bill" | "fuel_statement" | "transfer" | "bank_fee" | "other"; id: number; ref: string; amountCents: number; at: Date; alreadyMatched: boolean };
export type BankLine = { lineNo: number; postedAt: Date; amountCents: number; description: string | null; reference: string | null };

export type LineResult = { lineNo: number; outcome: "matched" | "unmatched" | "ambiguous" | "timing_difference"; matched: { kind: Movement["kind"]; id: number; ref: string } | null; reason: string };

const DAY = 86_400_000;

export function reconcileBank(args: { lines: readonly BankLine[]; movements: readonly Movement[]; windowDays?: number; periodEnd: Date }): { results: LineResult[]; outstandingWithdrawals: Movement[]; depositsInTransit: Movement[]; counts: Record<LineResult["outcome"], number> } {
  const window = (args.windowDays ?? 5) * DAY;
  // Movements come from different tables whose ids overlap; a payment and a
  // bill can both be #7. Identity is kind and id together.
  const k = (m: Movement) => `${m.kind}:${m.id}`;
  const taken = new Set<string>(args.movements.filter(m => m.alreadyMatched).map(k));
  const results: LineResult[] = [];
  for (const line of [...args.lines].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())) {
    const sameAmount = args.movements.filter(m => !taken.has(k(m)) && m.amountCents === line.amountCents);
    const inWindow = sameAmount.filter(m => Math.abs(m.at.getTime() - line.postedAt.getTime()) <= window);
    const byRef = line.reference ? inWindow.filter(m => m.ref === line.reference) : [];
    const pool = byRef.length === 1 ? byRef : inWindow;
    if (pool.length === 1) { const m = pool[0]!; taken.add(k(m)); results.push({ lineNo: line.lineNo, outcome: "matched", matched: { kind: m.kind, id: m.id, ref: m.ref }, reason: byRef.length === 1 ? "Same amount, same reference, within the window" : "Same amount within the window" }); continue; }
    if (pool.length > 1) { results.push({ lineNo: line.lineNo, outcome: "ambiguous", matched: null, reason: `${pool.length} movements of ${fmt(line.amountCents)} within the window (${pool.map(m => m.ref).join(", ")}) — a person decides` }); continue; }
    if (sameAmount.length >= 1) { results.push({ lineNo: line.lineNo, outcome: "timing_difference", matched: null, reason: `${fmt(line.amountCents)} matches ${sameAmount.map(m => m.ref).join(", ")} outside the ${args.windowDays ?? 5}-day window — confirm or widen` }); continue; }
    results.push({ lineNo: line.lineNo, outcome: "unmatched", matched: null, reason: line.amountCents >= 0 ? `Unknown deposit of ${fmt(line.amountCents)} — no customer payment or transfer explains it` : `Unknown withdrawal of ${fmt(-line.amountCents)} — no bill, statement or fee explains it` });
  }
  const unmatchedMovements = args.movements.filter(m => !taken.has(k(m)) && m.at <= args.periodEnd);
  const counts: Record<LineResult["outcome"], number> = { matched: 0, unmatched: 0, ambiguous: 0, timing_difference: 0 };
  for (const r of results) counts[r.outcome]++;
  return { results, outstandingWithdrawals: unmatchedMovements.filter(m => m.amountCents < 0), depositsInTransit: unmatchedMovements.filter(m => m.amountCents > 0), counts };
}

export type ReconciliationStatement = {
  bankClosingCents: number;
  lessOutstandingWithdrawalsCents: number;
  plusDepositsInTransitCents: number;
  adjustedBankCents: number;
  bookOpeningCents: number;
  bookMovementsCents: number;
  bookClosingCents: number;
  differenceCents: number;
  reconciled: boolean;
  unexplained: { unknownDeposits: number; unknownWithdrawals: number; ambiguous: number; timing: number };
};

export function reconciliationStatement(args: { bankClosingCents: number; bookOpeningCents: number; movements: readonly Movement[]; periodEnd: Date; rec: ReturnType<typeof reconcileBank>; lines: readonly BankLine[] }): ReconciliationStatement {
  const outstanding = args.rec.outstandingWithdrawals.reduce((a, m) => a + m.amountCents, 0);
  const transit = args.rec.depositsInTransit.reduce((a, m) => a + m.amountCents, 0);
  const adjustedBank = args.bankClosingCents + outstanding + transit; // outstanding is negative
  const bookMovements = args.movements.filter(m => m.at <= args.periodEnd).reduce((a, m) => a + m.amountCents, 0);
  const bookClosing = args.bookOpeningCents + bookMovements;
  const difference = adjustedBank - bookClosing;
  const byLine = new Map(args.rec.results.map(r => [r.lineNo, r]));
  const unknownDeposits = args.lines.filter(l => byLine.get(l.lineNo)?.outcome === "unmatched" && l.amountCents >= 0).length;
  const unknownWithdrawals = args.lines.filter(l => byLine.get(l.lineNo)?.outcome === "unmatched" && l.amountCents < 0).length;
  return { bankClosingCents: args.bankClosingCents, lessOutstandingWithdrawalsCents: outstanding, plusDepositsInTransitCents: transit, adjustedBankCents: adjustedBank, bookOpeningCents: args.bookOpeningCents, bookMovementsCents: bookMovements, bookClosingCents: bookClosing, differenceCents: difference, reconciled: difference === 0 && unknownDeposits + unknownWithdrawals + args.rec.counts.ambiguous === 0, unexplained: { unknownDeposits, unknownWithdrawals, ambiguous: args.rec.counts.ambiguous, timing: args.rec.counts.timing_difference } };
}

const fmt = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`;
