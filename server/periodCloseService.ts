/**
 * Period close — facts from the ledger, state from the history, and the
 * hook every finance write path calls.
 */

import { entityIdsInScope } from "./_core/entityScope";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb, type TenantScope } from "./db";
import { bankAccounts, bankStatementLines, bankStatements, customerPayments, gstReturns, bulkFuelDispenses, bulkFuelReadings, bulkFuelTanks, expenseRecords, fuelStatementLines, fuelStatements, fuelTransactions, iftaReturns, jurisdictionDistanceRecords, periodCloses, vendorBills } from "../drizzle/schema";
import { closeReadiness, periodBounds, periodOf, periodState, writePermitted, type CloseFacts, type PeriodState } from "./_core/periodClose";
import { reconcileTank } from "./_core/bulkFuel";

export async function loadPeriodState(financialEntityId: number, period: string): Promise<PeriodState> {
  const db = await getDb();
  if (!db) return "open";
  const rows = await db.select({ id: periodCloses.id, period: periodCloses.period, action: periodCloses.action, at: periodCloses.at }).from(periodCloses).where(and(eq(periodCloses.financialEntityId, financialEntityId), eq(periodCloses.period, period))).orderBy(desc(periodCloses.at), desc(periodCloses.id)).limit(50);
  return periodState(rows, period);
}

/** The hook. A record dated in a period that is not open is refused with the reason. */
export async function assertPeriodOpen(financialEntityId: number, recordDate: Date, what: string): Promise<void> {
  const period = periodOf(recordDate);
  const state = await loadPeriodState(financialEntityId, period);
  const w = writePermitted(state, period);
  if (!w.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${what}: ${w.reason}` });
}

export async function loadCloseFacts(financialEntityId: number, period: string): Promise<CloseFacts> {
  const db = await getDb();
  const { start, end } = periodBounds(period);
  const empty: CloseFacts = { unmatchedStatementLines: 0, ambiguousStatementLines: 0, statementsImported: 0, billsMismatched: 0, billsDuplicateSuspected: 0, billsMissingReceipt: 0, billsAwaitingApproval: 0, billsAwaitingCoding: 0, fuelNeedsReview: 0, fuelJurisdictionUnknown: 0, distanceNeedsReview: 0, tanksOutOfTolerance: [], quarterEndMonth: [3, 6, 9, 12].includes(end.getUTCMonth() === 0 ? 12 : end.getUTCMonth()), iftaReturnStatus: null, gstReturnStatus: null, expensesDraft: 0, proposalsAwaitingReadback: 0, lateArrivalsAfterClose: 0, bankLinesUnexplained: 0, bankStatementsImported: 0, paymentsUnapplied: 0 };
  if (!db) return empty;

  const [statements, bills, fuel, dist, tanks, expenses, proposals, closes] = await Promise.all([
    db.select({ id: fuelStatements.id }).from(fuelStatements).where(and(eq(fuelStatements.financialEntityId, financialEntityId), lt(fuelStatements.periodStart, end), gte(fuelStatements.periodEnd, start))),
    db.select({ status: vendorBills.status }).from(vendorBills).where(and(eq(vendorBills.financialEntityId, financialEntityId), gte(vendorBills.invoiceDate, start), lt(vendorBills.invoiceDate, end))),
    db.select({ status: fuelTransactions.status, jurisdiction: fuelTransactions.jurisdiction, quantity: fuelTransactions.quantity, createdAt: fuelTransactions.createdAt }).from(fuelTransactions).where(and(eq(fuelTransactions.financialEntityId, financialEntityId), gte(fuelTransactions.occurredAt, start), lt(fuelTransactions.occurredAt, end))),
    db.select({ verificationStatus: jurisdictionDistanceRecords.verificationStatus }).from(jurisdictionDistanceRecords).where(and(eq(jurisdictionDistanceRecords.financialEntityId, financialEntityId), gte(jurisdictionDistanceRecords.periodStart, start), lt(jurisdictionDistanceRecords.periodStart, end))),
    db.select().from(bulkFuelTanks).where(and(eq(bulkFuelTanks.financialEntityId, financialEntityId), eq(bulkFuelTanks.status, "active"))),
    db.select({ status: expenseRecords.status }).from(expenseRecords).where(and(eq(expenseRecords.financialEntityId, financialEntityId), gte(expenseRecords.transactionDate, start), lt(expenseRecords.transactionDate, end))),
    // Proposals carry no financial entity until they commit, so a close cannot
    // honestly attribute an uncommitted one to this company. The finding stays
    // in the engine for the day they do; the loader counts none rather than
    // counting every company's. (Found when other suites' proposals blocked
    // this entity's close.)
    Promise.resolve([] as { formKey: string }[]),
    db.select({ action: periodCloses.action, at: periodCloses.at }).from(periodCloses).where(and(eq(periodCloses.financialEntityId, financialEntityId), eq(periodCloses.period, period))).orderBy(desc(periodCloses.at)).limit(1),
  ]);
  const lines = statements.length ? await db.select({ matchOutcome: fuelStatementLines.matchOutcome, matchReason: fuelStatementLines.matchReason }).from(fuelStatementLines).where(inArray(fuelStatementLines.fuelStatementId, statements.map(s => s.id))) : [];
  const tanksOut: CloseFacts["tanksOutOfTolerance"] = [];
  for (const t of tanks) {
    const readings = await db.select().from(bulkFuelReadings).where(and(eq(bulkFuelReadings.bulkFuelTankId, t.id), lt(bulkFuelReadings.readAt, end))).orderBy(desc(bulkFuelReadings.readAt)).limit(2);
    if (readings.length < 2) continue;
    const [disp, purch] = await Promise.all([
      db.select({ litres: bulkFuelDispenses.litres, at: bulkFuelDispenses.occurredAt }).from(bulkFuelDispenses).where(eq(bulkFuelDispenses.bulkFuelTankId, t.id)),
      db.select({ litres: fuelTransactions.quantity, at: fuelTransactions.occurredAt }).from(fuelTransactions).where(and(eq(fuelTransactions.bulkFuelTankId, t.id), eq(fuelTransactions.purpose, "bulk_tank_purchase"))),
    ]);
    const rec = reconcileTank({ opening: { at: readings[1]!.readAt, litresOnHand: readings[1]!.litresOnHand, method: readings[1]!.method }, closing: { at: readings[0]!.readAt, litresOnHand: readings[0]!.litresOnHand, method: readings[0]!.method }, movements: [...disp.map(d => ({ kind: "dispense" as const, litres: d.litres, at: d.at })), ...purch.filter(p => p.litres != null).map(p => ({ kind: "purchase" as const, litres: p.litres!, at: p.at }))], capacityLitres: t.capacityLitres, tolerancePct: t.varianceTolerancePct });
    if (rec.withinTolerance === false && rec.variancePct != null) tanksOut.push({ tankRef: t.tankRef, variancePct: rec.variancePct });
  }
  const lastClose = closes[0]?.action === "close" || closes[0]?.action === "soft_close" ? closes[0].at : null;
  const quarterEnd = [3, 6, 9, 12].includes(start.getUTCMonth() + 1);
  const quarterKey = `${start.getUTCFullYear()}-Q${Math.ceil((start.getUTCMonth() + 1) / 3)}`;
  const ret = quarterEnd ? (await db.select({ status: iftaReturns.status }).from(iftaReturns).where(and(eq(iftaReturns.financialEntityId, financialEntityId), eq(iftaReturns.quarter, quarterKey))).orderBy(desc(iftaReturns.id)).limit(1))[0] : undefined;
  const gst = quarterEnd ? (await db.select({ status: gstReturns.status }).from(gstReturns).where(and(eq(gstReturns.financialEntityId, financialEntityId), eq(gstReturns.period, quarterKey))).orderBy(desc(gstReturns.id)).limit(1))[0] : undefined;
  const accts = await db.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.financialEntityId, financialEntityId));
  const bankStmts = accts.length ? await db.select({ id: bankStatements.id }).from(bankStatements).where(and(inArray(bankStatements.bankAccountId, accts.map(a => a.id)), lt(bankStatements.periodStart, end), gte(bankStatements.periodEnd, start))) : [];
  const bankLines = bankStmts.length ? await db.select({ matchOutcome: bankStatementLines.matchOutcome }).from(bankStatementLines).where(inArray(bankStatementLines.bankStatementId, bankStmts.map(s => s.id))) : [];
  const pays = await db.select({ status: customerPayments.status }).from(customerPayments).where(and(eq(customerPayments.financialEntityId, financialEntityId), gte(customerPayments.receivedAt, start), lt(customerPayments.receivedAt, end)));
  const count = <T,>(xs: readonly T[], p: (x: T) => boolean) => xs.filter(p).length;
  return {
    unmatchedStatementLines: count(lines, l => l.matchOutcome === "unmatched" && !(l.matchReason ?? "").startsWith("Confirmed no receipt")),
    ambiguousStatementLines: count(lines, l => l.matchOutcome === "ambiguous"),
    statementsImported: statements.length,
    billsMismatched: count(bills, b => b.status === "mismatch"), billsDuplicateSuspected: count(bills, b => b.status === "duplicate_suspected"),
    billsMissingReceipt: count(bills, b => b.status === "missing_receipt"), billsAwaitingApproval: count(bills, b => b.status === "needs_approval"), billsAwaitingCoding: count(bills, b => b.status === "needs_coding" || b.status === "received"),
    fuelNeedsReview: count(fuel, f => f.status === "needs_review" || f.status === "draft"),
    fuelJurisdictionUnknown: count(fuel, f => !f.jurisdiction && (f.quantity ?? 0) > 0),
    distanceNeedsReview: count(dist, d => d.verificationStatus === "needs_review"),
    tanksOutOfTolerance: tanksOut,
    quarterEndMonth: quarterEnd,
    iftaReturnStatus: quarterEnd ? (ret?.status ?? "none") : null,
    gstReturnStatus: quarterEnd ? (gst?.status ?? "none") : null,
    expensesDraft: count(expenses, e => e.status === "draft"),
    proposalsAwaitingReadback: proposals.length,
    lateArrivalsAfterClose: lastClose ? count(fuel, f => f.createdAt > lastClose) : 0,
    bankLinesUnexplained: count(bankLines, l => l.matchOutcome !== "matched"),
    bankStatementsImported: bankStmts.length,
    paymentsUnapplied: count(pays, p => p.status === "unapplied" || p.status === "partially_applied"),
  };
}

export async function loadCloseReadiness(financialEntityId: number, period: string) {
  const facts = await loadCloseFacts(financialEntityId, period);
  return { period, state: await loadPeriodState(financialEntityId, period), facts, ...closeReadiness(facts) };
}

/** For the exception centre: statements with findings, tanks out of tolerance, periods sitting soft-closed. */
export async function loadFuelLineFindings(scope: TenantScope): Promise<{ statementsWithFindings: { statementRef: string; provider: string; unmatched: number; ambiguous: number; importedAt: Date }[]; tanksOutOfTolerance: { tankRef: string; name: string; variancePct: number; varianceLitres: number; reason: string }[]; periodsSoftClosed: { financialEntityId: number; period: string; reviewItems: number; since: Date }[] }> {
  const db = await getDb();
  if (!db) return { statementsWithFindings: [], tanksOutOfTolerance: [], periodsSoftClosed: [] };
  // 0174: every row here is keyed to a financial entity — the money boundary — read before the limits.
  const entities = await entityIdsInScope(db as never, scope);
  if (!entities.length) return { statementsWithFindings: [], tanksOutOfTolerance: [], periodsSoftClosed: [] };
  const statements = await db.select().from(fuelStatements).where(inArray(fuelStatements.financialEntityId, entities)).orderBy(desc(fuelStatements.importedAt)).limit(100);
  const withFindings: { statementRef: string; provider: string; unmatched: number; ambiguous: number; importedAt: Date }[] = [];
  for (const st of statements) {
    const lines = await db.select({ matchOutcome: fuelStatementLines.matchOutcome, matchReason: fuelStatementLines.matchReason }).from(fuelStatementLines).where(eq(fuelStatementLines.fuelStatementId, st.id));
    const unmatched = lines.filter(l => l.matchOutcome === "unmatched" && !(l.matchReason ?? "").startsWith("Confirmed no receipt")).length;
    const ambiguous = lines.filter(l => l.matchOutcome === "ambiguous").length;
    if (unmatched + ambiguous > 0) withFindings.push({ statementRef: st.statementRef, provider: st.provider, unmatched, ambiguous, importedAt: st.importedAt });
  }
  const tanks = await db.select().from(bulkFuelTanks).where(and(eq(bulkFuelTanks.status, "active"), inArray(bulkFuelTanks.financialEntityId, entities))).limit(200);
  const tanksOut: { tankRef: string; name: string; variancePct: number; varianceLitres: number; reason: string }[] = [];
  for (const t of tanks) {
    const readings = await db.select().from(bulkFuelReadings).where(eq(bulkFuelReadings.bulkFuelTankId, t.id)).orderBy(desc(bulkFuelReadings.readAt)).limit(2);
    if (readings.length < 2) continue;
    const [disp, purch] = await Promise.all([
      db.select({ litres: bulkFuelDispenses.litres, at: bulkFuelDispenses.occurredAt }).from(bulkFuelDispenses).where(eq(bulkFuelDispenses.bulkFuelTankId, t.id)),
      db.select({ litres: fuelTransactions.quantity, at: fuelTransactions.occurredAt }).from(fuelTransactions).where(and(eq(fuelTransactions.bulkFuelTankId, t.id), eq(fuelTransactions.purpose, "bulk_tank_purchase"))),
    ]);
    const rec = reconcileTank({ opening: { at: readings[1]!.readAt, litresOnHand: readings[1]!.litresOnHand, method: readings[1]!.method }, closing: { at: readings[0]!.readAt, litresOnHand: readings[0]!.litresOnHand, method: readings[0]!.method }, movements: [...disp.map(d => ({ kind: "dispense" as const, litres: d.litres, at: d.at })), ...purch.filter(p => p.litres != null).map(p => ({ kind: "purchase" as const, litres: p.litres!, at: p.at }))], capacityLitres: t.capacityLitres, tolerancePct: t.varianceTolerancePct });
    if (rec.withinTolerance === false && rec.variancePct != null && rec.varianceLitres != null) tanksOut.push({ tankRef: t.tankRef, name: t.name, variancePct: rec.variancePct, varianceLitres: rec.varianceLitres, reason: rec.reason });
  }
  const closes = await db.select().from(periodCloses).where(inArray(periodCloses.financialEntityId, entities)).orderBy(desc(periodCloses.at), desc(periodCloses.id)).limit(500);
  const latest = new Map<string, (typeof closes)[number]>();
  for (const c of closes) { const k = `${c.financialEntityId}:${c.period}`; if (!latest.has(k)) latest.set(k, c); }
  const soft: { financialEntityId: number; period: string; reviewItems: number; since: Date }[] = [];
  for (const c of Array.from(latest.values())) if (c.action === "soft_close") {
    let review = 0;
    try { review = ((JSON.parse(c.readinessJson ?? "{}") as { findings?: { severity: string }[] }).findings ?? []).filter(f => f.severity === "review").length; } catch { review = 0; }
    soft.push({ financialEntityId: c.financialEntityId, period: c.period, reviewItems: review, since: c.at });
  }
  return { statementsWithFindings: withFindings, tanksOutOfTolerance: tanksOut, periodsSoftClosed: soft };
}
