/**
 * Bulk fuel, statements, anomalies — the API.
 *
 * A dispense writes a fuel transaction with the tank's jurisdiction, so IFTA
 * and the unit's consumption see it. A statement import is idempotent by
 * content hash, matches every line server-side, links matched lines to their
 * transactions, and leaves the unmatched ones as the finding. Nothing here
 * creates an expense from a statement line: a line is evidence of a
 * transaction, and an unmatched line is a receipt to go and find.
 */

import { TRPCError } from "@trpc/server";
import { requireCallerUnits } from "./unitScope";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { requireOwnedEntity } from "./_core/entityScope";
import { fuelStatementInScope, fuelTankInScope, fuelTransactionInScope, requireEvidence, requireFuelAccountOfEntity, requireUnit } from "./financeScope";
import { toCents } from "./_core/money";
import { getDb } from "./db";
import { bulkFuelDispenses, bulkFuelReadings, bulkFuelTanks, fleetFuelCards, fuelStatementLines, fuelStatements, fuelTransactions, units } from "../drizzle/schema";
import { fuelAnomalies, reconcileStatement, reconcileTank, type LedgerFuel } from "./_core/bulkFuel";
import { assertPeriodOpen } from "./periodCloseService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const JUR = z.string().regex(/^(CA|US)-[A-Z]{2}$/);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const fuelOpsRouter = router({
  tankRegister: moneyScoped(roleProcedure("fuel.tankRegister"))
    .input(z.object({ financialEntityId: z.number().int().positive(), name: z.string().min(1).max(120), location: z.string().max(300).nullable().optional(), jurisdiction: JUR, fuelType: z.enum(["diesel", "gasoline", "def", "propane", "other"]), capacityLitres: z.number().positive(), varianceTolerancePct: z.number().min(0).max(25).default(2), fuelAccountId: z.number().int().positive().nullable().optional(), meterDeviceId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      await requireFuelAccountOfEntity(db, input.fuelAccountId, input.financialEntityId);
      const tankRef = ref("TANK");
      const ins = await db.insert(bulkFuelTanks).values({ tankRef, financialEntityId: input.financialEntityId, fuelAccountId: input.fuelAccountId ?? null, name: input.name, location: input.location ?? null, jurisdiction: input.jurisdiction, fuelType: input.fuelType, capacityLitres: input.capacityLitres, meterDeviceId: input.meterDeviceId ?? null, varianceTolerancePct: input.varianceTolerancePct });
      return { tankRef, tankId: Number(ins[0]?.insertId ?? 0) };
    }),

  /** A dispense is a fuel transaction: unit, litres, the tank's jurisdiction, inventory treatment. */
  dispenseRecord: moneyScoped(roleProcedure("fuel.dispenseRecord"))
    .input(z.object({ tankRef: z.string().min(1).max(64), unitId: z.number().int().positive().nullable(), equipmentId: z.number().int().positive().nullable().optional(), litres: z.number().positive(), quantitySource: z.enum(["meter", "stick_before_after", "stated"]), meterBefore: z.number().nonnegative().nullable().optional(), meterAfter: z.number().nonnegative().nullable().optional(), odometerKm: z.number().nonnegative().nullable().optional(), occurredAt: z.coerce.date(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5 — a dispense's odometer joins the unit's meter sequence
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const tank = await fuelTankInScope(db, ctx.money, input.tankRef);
      if (tank.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Tank is ${tank.status}` });
      if (input.litres > tank.capacityLitres) throw new TRPCError({ code: "BAD_REQUEST", message: `${input.litres} L exceeds the tank's ${tank.capacityLitres} L capacity` });
      if (input.quantitySource === "meter") {
        if (input.meterBefore == null || input.meterAfter == null) throw new TRPCError({ code: "BAD_REQUEST", message: "A metered dispense needs meter readings before and after" });
        const metered = input.meterAfter - input.meterBefore;
        if (Math.abs(metered - input.litres) > 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: `Meter says ${metered} L, dispense says ${input.litres} L` });
      }
      if (!input.unitId && !input.equipmentId) throw new TRPCError({ code: "BAD_REQUEST", message: "A dispense goes into a unit or a piece of equipment" });
      await requireUnit(ctx.money, input.unitId);
      await requireEvidence(ctx.money, input.evidenceRecordId);
      await assertPeriodOpen(tank.financialEntityId, input.occurredAt, "Dispense");
      const dispenseRef = ref("DISP");
      const fuelRef = `FUEL-${dispenseRef}`;
      const ft = await db.insert(fuelTransactions).values({
        fuelRef, financialEntityId: tank.financialEntityId, unitId: input.unitId, equipmentId: input.equipmentId ?? null, fueledByUserId: ctx.user.id, fuelAccountId: tank.fuelAccountId, bulkFuelTankId: tank.id,
        vendorName: tank.name, merchantLocation: tank.location, jurisdiction: tank.jurisdiction, jurisdictionSource: "bulk_tank_location",
        occurredAt: input.occurredAt, fuelType: tank.fuelType as never, quantity: input.litres, quantityUnit: "L", totalCents: 0, odometerKm: input.odometerKm ?? null,
        payerType: "company", purpose: "bulk_tank_dispense", financialTreatment: "bulk_fuel_inventory", reimbursementStatus: "not_applicable", privateToFueler: false,
        hosRuleConclusion: "unknown", status: input.quantitySource === "stated" ? "needs_review" : "confirmed", evidenceRecordId: input.evidenceRecordId ?? null,
      });
      const fuelTransactionId = Number(ft[0]?.insertId ?? 0);
      await db.insert(bulkFuelDispenses).values({ dispenseRef, bulkFuelTankId: tank.id, unitId: input.unitId, equipmentId: input.equipmentId ?? null, fuelTransactionId, litres: input.litres, quantitySource: input.quantitySource, meterBefore: input.meterBefore ?? null, meterAfter: input.meterAfter ?? null, odometerKm: input.odometerKm ?? null, occurredAt: input.occurredAt, dispensedByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null });
      return { dispenseRef, fuelRef, jurisdiction: tank.jurisdiction, status: input.quantitySource === "stated" ? "needs_review" : "confirmed" };
    }),

  readingRecord: moneyScoped(roleProcedure("fuel.readingRecord"))
    .input(z.object({ tankRef: z.string().min(1).max(64), readAt: z.coerce.date(), litresOnHand: z.number().nonnegative(), method: z.enum(["stick", "gauge", "meter_total", "delivery_ticket"]), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const tank = await fuelTankInScope(db, ctx.money, input.tankRef);
      await requireEvidence(ctx.money, input.evidenceRecordId);
      if (input.litresOnHand > tank.capacityLitres) throw new TRPCError({ code: "BAD_REQUEST", message: `A reading of ${input.litresOnHand} L exceeds the tank's ${tank.capacityLitres} L capacity` });
      const ins = await db.insert(bulkFuelReadings).values({ bulkFuelTankId: tank.id, readAt: input.readAt, litresOnHand: input.litresOnHand, method: input.method, readByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null });
      return { readingId: Number(ins[0]?.insertId ?? 0) };
    }),

  /** Between the two most recent readings (or a given pair): in − out versus measured. */
  tankReconcile: moneyScoped(roleProcedure("fuel.tankReconcile"))
    .input(z.object({ tankRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const tank = await fuelTankInScope(db, ctx.money, input.tankRef);
      const readings = await db.select().from(bulkFuelReadings).where(eq(bulkFuelReadings.bulkFuelTankId, tank.id)).orderBy(desc(bulkFuelReadings.readAt)).limit(2);
      const closing = readings[0] ?? null, opening = readings[1] ?? null;
      const [disp, purchases] = await Promise.all([
        db.select({ litres: bulkFuelDispenses.litres, at: bulkFuelDispenses.occurredAt }).from(bulkFuelDispenses).where(eq(bulkFuelDispenses.bulkFuelTankId, tank.id)),
        db.select({ litres: fuelTransactions.quantity, at: fuelTransactions.occurredAt }).from(fuelTransactions).where(and(eq(fuelTransactions.bulkFuelTankId, tank.id), eq(fuelTransactions.purpose, "bulk_tank_purchase"))),
      ]);
      const movements = [
        ...disp.map(d => ({ kind: "dispense" as const, litres: d.litres, at: d.at })),
        ...purchases.filter(p => p.litres != null).map(p => ({ kind: "purchase" as const, litres: p.litres!, at: p.at })),
      ];
      const rec = reconcileTank({ opening: opening ? { at: opening.readAt, litresOnHand: opening.litresOnHand, method: opening.method } : null, closing: closing ? { at: closing.readAt, litresOnHand: closing.litresOnHand, method: closing.method } : null, movements, capacityLitres: tank.capacityLitres, tolerancePct: tank.varianceTolerancePct });
      return { tankRef: tank.tankRef, from: opening?.readAt ?? null, to: closing?.readAt ?? null, ...rec };
    }),

  /** Import a statement; match every line against the ledger; link what matches; leave the rest as findings. Idempotent by content. */
  statementImport: moneyScoped(roleProcedure("fuel.statementImport"))
    .input(z.object({
      financialEntityId: z.number().int().positive(), fuelAccountId: z.number().int().positive(), provider: z.string().min(1).max(120),
      periodStart: z.coerce.date(), periodEnd: z.coerce.date(), evidenceRecordId: z.number().int().positive().nullable().optional(),
      lines: z.array(z.object({ transactionAt: z.coerce.date(), cardLastFour: z.string().regex(/^\d{4}$/).nullable(), merchant: z.string().max(220).nullable().optional(), merchantLocation: z.string().max(300).nullable().optional(), jurisdiction: JUR.nullable().optional(), quantity: z.number().nonnegative().nullable(), quantityUnit: z.string().max(12).nullable().optional(), total: z.number(), unitHint: z.string().max(40).nullable().optional() })).min(1).max(5000),
      windowHours: z.number().positive().max(72).default(36),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      await requireFuelAccountOfEntity(db, input.fuelAccountId, input.financialEntityId);
      await requireEvidence(ctx.money, input.evidenceRecordId);
      const canonical = JSON.stringify({ a: input.fuelAccountId, p: input.provider, s: input.periodStart, e: input.periodEnd, l: input.lines.map(l => [l.transactionAt, l.cardLastFour, l.total, l.quantity]) });
      const contentHash = sha(canonical);
      const dup = (await db.select({ statementRef: fuelStatements.statementRef }).from(fuelStatements).where(eq(fuelStatements.contentHash, contentHash)).limit(1))[0];
      if (dup) return { statementRef: dup.statementRef, alreadyImported: true as const };
      await assertPeriodOpen(input.financialEntityId, input.periodEnd, "Statement import");

      // The ledger's card transactions in the window, with last four resolved from the card record.
      const cards = await db.select({ id: fleetFuelCards.id, lastFour: fleetFuelCards.lastFour }).from(fleetFuelCards).where(eq(fleetFuelCards.fuelAccountId, input.fuelAccountId));
      const lastFour = new Map(cards.map(c => [c.id, c.lastFour]));
      const pad = 3 * 24 * 3_600_000;
      const tx = await db.select({ id: fuelTransactions.id, fuelRef: fuelTransactions.fuelRef, fleetCardId: fuelTransactions.fleetCardId, cardLastFourHint: fuelTransactions.cardLastFourHint, occurredAt: fuelTransactions.occurredAt, totalCents: fuelTransactions.totalCents, quantity: fuelTransactions.quantity, unitId: fuelTransactions.unitId, statementLineId: fuelTransactions.statementLineId })
        .from(fuelTransactions).where(and(eq(fuelTransactions.financialEntityId, input.financialEntityId), gte(fuelTransactions.occurredAt, new Date(input.periodStart.getTime() - pad)), lte(fuelTransactions.occurredAt, new Date(input.periodEnd.getTime() + pad))));
      const unitIds = Array.from(new Set(tx.map(t => t.unitId).filter((x): x is number => x != null)));
      const unitNo = new Map((unitIds.length ? await db.select({ id: units.id, unitNumber: units.unitNumber }).from(units).where(inArray(units.id, unitIds)) : []).map(u => [u.id, u.unitNumber]));
      const ledger: LedgerFuel[] = tx.map(t => ({ id: t.id, fuelRef: t.fuelRef, cardLastFour: (t.fleetCardId != null ? lastFour.get(t.fleetCardId) : null) ?? t.cardLastFourHint ?? null, occurredAt: t.occurredAt, total: t.totalCents / 100, quantity: t.quantity, unitNumber: t.unitId != null ? unitNo.get(t.unitId) ?? null : null, statementLineId: t.statementLineId }));

      const lines = input.lines.map((l, i) => ({ lineNo: i + 1, cardLastFour: l.cardLastFour, occurredAt: l.transactionAt, total: l.total, quantity: l.quantity, unitHint: l.unitHint ?? null }));
      const rec = reconcileStatement({ lines, ledger, windowHours: input.windowHours });

      const statementRef = ref("STMT");
      const ins = await db.insert(fuelStatements).values({ statementRef, financialEntityId: input.financialEntityId, fuelAccountId: input.fuelAccountId, provider: input.provider, periodStart: input.periodStart, periodEnd: input.periodEnd, lineCount: lines.length, matchedCount: rec.counts.match, varianceCount: rec.counts.match_with_variance, unmatchedCount: rec.counts.unmatched + rec.counts.ambiguous, contentHash, importedByUserId: ctx.user.id, importedAt: new Date(), evidenceRecordId: input.evidenceRecordId ?? null });
      const statementId = Number(ins[0]?.insertId ?? 0);
      for (const r of rec.results) {
        const l = input.lines[r.lineNo - 1]!;
        const li = await db.insert(fuelStatementLines).values({ fuelStatementId: statementId, lineNo: r.lineNo, transactionAt: l.transactionAt, cardLastFour: l.cardLastFour, merchant: l.merchant ?? null, merchantLocation: l.merchantLocation ?? null, jurisdiction: l.jurisdiction ?? null, quantity: l.quantity, quantityUnit: l.quantityUnit ?? null, total: l.total, unitHint: l.unitHint ?? null, matchedFuelTransactionId: r.matchedFuelId, matchOutcome: r.outcome, matchReason: r.reason });
        if (r.matchedFuelId != null) {
          // Link, mark reconciled, and let the statement supply a jurisdiction the receipt lacked.
          const set: Record<string, unknown> = { statementLineId: Number(li[0]?.insertId ?? 0), status: "reconciled" };
          if (l.jurisdiction) {
            const cur = (await db.select({ jurisdiction: fuelTransactions.jurisdiction }).from(fuelTransactions).where(eq(fuelTransactions.id, r.matchedFuelId)).limit(1))[0];
            if (!cur?.jurisdiction) { set.jurisdiction = l.jurisdiction; set.jurisdictionSource = "fleet_card_statement"; }
          }
          await db.update(fuelTransactions).set(set).where(eq(fuelTransactions.id, r.matchedFuelId));
        }
      }
      return { statementRef, alreadyImported: false as const, counts: rec.counts, unmatched: rec.results.filter(r => r.outcome !== "match" && r.outcome !== "match_with_variance").map(r => ({ lineNo: r.lineNo, outcome: r.outcome, reason: r.reason })), receiptsWithoutLine: rec.receiptsWithoutLine.map(t => t.fuelRef) };
    }),

  /** A person resolves an ambiguous or unmatched line to a transaction, or confirms there is none. */
  statementLineResolve: moneyScoped(roleProcedure("fuel.statementLineResolve"))
    .input(z.object({ statementRef: z.string().min(1).max(64), lineNo: z.number().int().positive(), fuelRef: z.string().min(1).max(64).nullable(), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const st = await fuelStatementInScope(db, ctx.money, input.statementRef);
      const line = (await db.select().from(fuelStatementLines).where(and(eq(fuelStatementLines.fuelStatementId, st.id), eq(fuelStatementLines.lineNo, input.lineNo))).limit(1))[0];
      if (!line) throw new TRPCError({ code: "NOT_FOUND", message: "Line not found" });
      if (line.matchedFuelTransactionId != null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Line is already matched" });
      if (!input.fuelRef) {
        await db.update(fuelStatementLines).set({ matchReason: `Confirmed no receipt: ${input.reason}` }).where(eq(fuelStatementLines.id, line.id));
        return { lineNo: input.lineNo, outcome: "unmatched" as const, note: "Recorded as a purchase with no receipt — it stays a finding until a receipt is captured" };
      }
      // F1 — the transaction must be in the statement's own book, not merely one the caller can see.
      const t = await fuelTransactionInScope(db, ctx.money, input.fuelRef);
      if (t.financialEntityId !== st.financialEntityId) throw new TRPCError({ code: "NOT_FOUND", message: "Fuel transaction not found" });
      if (t.statementLineId != null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That transaction is already matched to a statement line" });
      await db.update(fuelStatementLines).set({ matchedFuelTransactionId: t.id, matchOutcome: "match_with_variance", matchReason: `Resolved by a person: ${input.reason}` }).where(eq(fuelStatementLines.id, line.id));
      await db.update(fuelTransactions).set({ statementLineId: line.id, status: "reconciled" }).where(eq(fuelTransactions.id, t.id));
      return { lineNo: input.lineNo, outcome: "match_with_variance" as const, fuelRef: input.fuelRef };
    }),

  anomalies: moneyScoped(roleProcedure("fuel.anomalies"))
    .input(z.object({ financialEntityId: z.number().int().positive(), from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const tx = await db.select({ fuelRef: fuelTransactions.fuelRef, unitId: fuelTransactions.unitId, occurredAt: fuelTransactions.occurredAt, quantity: fuelTransactions.quantity, quantityUnit: fuelTransactions.quantityUnit, odometerKm: fuelTransactions.odometerKm, cardLastFourHint: fuelTransactions.cardLastFourHint })
        .from(fuelTransactions).where(and(eq(fuelTransactions.financialEntityId, input.financialEntityId), gte(fuelTransactions.occurredAt, input.from), lte(fuelTransactions.occurredAt, input.to)));
      const fills = tx.map(t => ({ fuelRef: t.fuelRef, unitId: t.unitId, occurredAt: t.occurredAt, quantityLitres: t.quantity != null ? (t.quantityUnit === "gal" ? t.quantity * 3.785411784 : t.quantity) : null, odometerKm: t.odometerKm, cardLastFour: t.cardLastFourHint }));
      // Tank capacity per unit is not on the unit record today; the capacity rule is inert until it is.
      const anomalies = fuelAnomalies({ fills, tankCapacityByUnit: new Map() });
      return { from: input.from, to: input.to, count: anomalies.length, anomalies, note: "fill_exceeds_capacity is inert until units carry a tank capacity" };
    }),
});
