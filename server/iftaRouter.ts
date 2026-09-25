/**
 * IFTA — the API.
 *
 * Distance is recorded with its source and enters as needs_review. Fuel is
 * classified to a jurisdiction with its source. The quarter is built from
 * those records and the rate rules; preparing it writes an immutable
 * snapshot; finalizing is refused while the tax is unknown or an exception
 * blocks. Amending is a new return that supersedes the last.
 */

import { TRPCError } from "@trpc/server";
import { requireCallerUnits } from "./unitScope";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { fuelTransactions, iftaReturns, jurisdictionDistanceRecords, operators, trips } from "../drizzle/schema";
import { buildIftaQuarter, finalizeDecision, quarterBounds, splitTripDistance, type DistanceRecord, type FuelRecord } from "./_core/iftaEngine";
import { determine } from "./_core/taxRuleEngine";
import { loadTaxRules } from "./payrollService";
import { IFTA_RATE_RULE_TYPE, IFTA_RATE_SEEDS } from "./_core/iftaSeeds";
import { assertPeriodOpen } from "./periodCloseService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const JUR = z.string().regex(/^(CA|US)-[A-Z]{2}$/, "Jurisdiction like CA-AB or US-MT");
const QUARTER = z.string().regex(/^\d{4}-Q[1-4]$/);

async function loadQuarter(financialEntityId: number, quarter: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const q = quarterBounds(quarter);
  const [dist, fuel, rules] = await Promise.all([
    db.select().from(jurisdictionDistanceRecords).where(and(eq(jurisdictionDistanceRecords.financialEntityId, financialEntityId), lt(jurisdictionDistanceRecords.periodStart, q.end), gte(jurisdictionDistanceRecords.periodEnd, q.start))),
    db.select().from(fuelTransactions).where(and(eq(fuelTransactions.financialEntityId, financialEntityId), gte(fuelTransactions.occurredAt, q.start), lt(fuelTransactions.occurredAt, q.end))),
    loadTaxRules(),
  ]);
  const distances: DistanceRecord[] = dist.map(d => ({ unitId: d.unitId, jurisdiction: d.jurisdiction, distanceKm: d.distanceKm, periodStart: d.periodStart, periodEnd: d.periodEnd, source: d.source, verificationStatus: d.verificationStatus }));
  const fuelRecords: FuelRecord[] = fuel.map(f => ({
    fuelRef: f.fuelRef, unitId: f.unitId, occurredAt: f.occurredAt,
    quantityLitres: f.quantity != null ? (f.quantityUnit === "gal" ? f.quantity * 3.785411784 : f.quantityUnit === "L" || f.quantityUnit == null ? f.quantity : null) : null,
    jurisdiction: f.jurisdiction, jurisdictionSource: f.jurisdictionSource, receiptEvidenceId: f.evidenceRecordId, odometerKm: f.odometerKm, fuelType: f.fuelType,
  }));
  // Loaded rules supersede seeds of the same key; seeds fill the shape otherwise.
  const keys = new Set(rules.map(r => r.ruleKey));
  const allRules = [...rules, ...IFTA_RATE_SEEDS.filter(s => !keys.has(s.ruleKey))];
  const rateFor = (jurisdiction: string) => determine(allRules, { jurisdiction, ruleType: IFTA_RATE_RULE_TYPE, asOf: q.start }) as ReturnType<typeof determine> & { parameters?: { ratePerLitre?: number | null } };
  return buildIftaQuarter({ quarter, distances, fuel: fuelRecords, rateFor });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const iftaRouter = router({
  distanceRecord: roleProcedure("ifta.distanceRecord")
    .input(z.object({
      financialEntityId: z.number().int().positive(), unitId: z.number().int().positive(), tripId: z.number().int().positive().nullable().optional(),
      jurisdiction: JUR, distanceKm: z.number().positive(), periodStart: z.coerce.date(), periodEnd: z.coerce.date(),
      source: z.enum(["operator_stated", "imported"]), notes: z.string().max(400).optional(), evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (input.periodEnd <= input.periodStart) throw new TRPCError({ code: "BAD_REQUEST", message: "periodEnd must be after periodStart" });
      await assertPeriodOpen(input.financialEntityId, input.periodStart, "Distance record");
      const distanceRef = ref("DIST");
      await db.insert(jurisdictionDistanceRecords).values({ distanceRef, financialEntityId: input.financialEntityId, unitId: input.unitId, tripId: input.tripId ?? null, jurisdiction: input.jurisdiction, distanceKm: input.distanceKm, periodStart: input.periodStart, periodEnd: input.periodEnd, source: input.source, recordedByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null, notes: input.notes ?? null });
      return { distanceRef, verificationStatus: "needs_review" as const };
    }),

  /** Split a trip's odometer distance by the operator's statement of jurisdictions. Refused if the fractions do not sum to one. */
  tripSplit: roleProcedure("ifta.tripSplit")
    .input(z.object({ financialEntityId: z.number().int().positive(), tripId: z.number().int().positive(), splits: z.array(z.object({ jurisdiction: JUR, fraction: z.number().min(0).max(1) })).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const trip = (await db.select().from(trips).where(eq(trips.id, input.tripId)).limit(1))[0];
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "Trip not found" });
      if (trip.unitId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trip has no unit" });
      const odo = trip.odometerStartKm != null && trip.odometerEndKm != null && trip.odometerEndKm > trip.odometerStartKm ? trip.odometerEndKm - trip.odometerStartKm : null;
      const distanceKm = odo ?? trip.distanceKm ?? null;
      if (distanceKm == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trip has neither odometer readings nor a recorded distance" });
      const split = splitTripDistance({ distanceKm, distanceSource: odo != null ? "odometer" : "operator_stated", splits: input.splits });
      if (!split.ok) throw new TRPCError({ code: "BAD_REQUEST", message: split.refusal });
      const start = trip.startedAt ?? trip.createdAt;
      const end = trip.completedAt ?? new Date(start.getTime() + 1);
      await assertPeriodOpen(input.financialEntityId, start, "Trip split");
      const refs: string[] = [];
      for (const part of split.parts) {
        const distanceRef = ref("DIST");
        await db.insert(jurisdictionDistanceRecords).values({ distanceRef, financialEntityId: input.financialEntityId, unitId: trip.unitId, tripId: trip.id, jurisdiction: part.jurisdiction, distanceKm: part.distanceKm, periodStart: start, periodEnd: end, source: part.source, recordedByUserId: ctx.user.id, notes: `Split of trip ${trip.tripNumber}` });
        refs.push(distanceRef);
      }
      return { tripId: trip.id, distanceKm, distanceSource: odo != null ? "odometer" : "operator_stated", parts: split.parts, distanceRefs: refs };
    }),

  distanceVerify: roleProcedure("ifta.distanceVerify")
    .input(z.object({ distanceRef: z.string().min(1).max(64), outcome: z.enum(["verified", "rejected"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const row = (await db.select().from(jurisdictionDistanceRecords).where(eq(jurisdictionDistanceRecords.distanceRef, input.distanceRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Distance record not found" });
      if (row.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded a distance may not verify it" });
      await db.update(jurisdictionDistanceRecords).set({ verificationStatus: input.outcome, verifiedByUserId: ctx.user.id, verifiedAt: new Date() }).where(eq(jurisdictionDistanceRecords.id, row.id));
      return { distanceRef: input.distanceRef, verificationStatus: input.outcome };
    }),

  fuelJurisdictionSet: roleProcedure("ifta.fuelJurisdictionSet")
    .input(z.object({ fuelRef: z.string().min(1).max(64), jurisdiction: JUR, source: z.enum(["receipt", "vendor_location", "operator_stated", "fleet_card_statement"]) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const row = (await db.select({ id: fuelTransactions.id, jurisdiction: fuelTransactions.jurisdiction, jurisdictionSource: fuelTransactions.jurisdictionSource }).from(fuelTransactions).where(eq(fuelTransactions.fuelRef, input.fuelRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Fuel transaction not found" });
      // A receipt beats a statement beats a person's recollection; a weaker source does not overwrite a stronger one.
      const rank: Record<string, number> = { receipt: 3, fleet_card_statement: 2, vendor_location: 2, gps: 3, operator_stated: 1, unknown: 0 };
      if (row.jurisdiction && row.jurisdictionSource && rank[row.jurisdictionSource] > rank[input.source] && row.jurisdiction !== input.jurisdiction) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Jurisdiction already ${row.jurisdiction} from ${row.jurisdictionSource}; a ${input.source} source does not override it` });
      }
      await db.update(fuelTransactions).set({ jurisdiction: input.jurisdiction, jurisdictionSource: input.source }).where(eq(fuelTransactions.id, row.id));
      return { fuelRef: input.fuelRef, jurisdiction: input.jurisdiction, source: input.source };
    }),

  quarter: roleProcedure("ifta.quarter")
    .input(z.object({ financialEntityId: z.number().int().positive(), quarter: QUARTER }))
    .query(async ({ input }) => loadQuarter(input.financialEntityId, input.quarter)),

  quarterPrepare: roleProcedure("ifta.quarterPrepare")
    .input(z.object({ financialEntityId: z.number().int().positive(), quarter: QUARTER }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const q = await loadQuarter(input.financialEntityId, input.quarter);
      const summaryJson = JSON.stringify(q);
      const returnRef = ref("IFTA");
      const prior = (await db.select({ id: iftaReturns.id, status: iftaReturns.status }).from(iftaReturns).where(and(eq(iftaReturns.financialEntityId, input.financialEntityId), eq(iftaReturns.quarter, input.quarter))).orderBy(desc(iftaReturns.id)).limit(1))[0];
      await db.insert(iftaReturns).values({
        returnRef, financialEntityId: input.financialEntityId, quarter: input.quarter, periodStart: q.periodStart, periodEnd: q.periodEnd,
        status: "prepared", summaryJson, payloadHash: sha(summaryJson), taxDetermination: q.totals.taxDue == null ? "unknown" : "computed",
        preparedByUserId: ctx.user.id, preparedAt: new Date(), supersedesReturnId: prior && (prior.status === "finalized" || prior.status === "filed") ? prior.id : null,
      });
      return { returnRef, determination: q.determination, taxDue: q.totals.taxDue, exceptions: q.exceptions.length, supersedes: prior && (prior.status === "finalized" || prior.status === "filed") ? prior.id : null };
    }),

  quarterFinalize: roleProcedure("ifta.quarterFinalize")
    .input(z.object({ returnRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const row = (await db.select().from(iftaReturns).where(eq(iftaReturns.returnRef, input.returnRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Return not found" });
      if (row.status !== "prepared") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Return is ${row.status}` });
      if (row.preparedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The preparer may not finalize their own return" });
      // The snapshot must still be what the ledger says. If the ledger moved, prepare again.
      const current = await loadQuarter(row.financialEntityId, row.quarter);
      if (sha(JSON.stringify(current)) !== row.payloadHash) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The ledger has changed since this return was prepared — prepare it again" });
      const decision = finalizeDecision(current);
      if (!decision.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.refusals.join("; ") });
      await db.update(iftaReturns).set({ status: "finalized", finalizedByUserId: ctx.user.id, finalizedAt: new Date() }).where(eq(iftaReturns.id, row.id));
      if (row.supersedesReturnId) await db.update(iftaReturns).set({ status: "amended" }).where(eq(iftaReturns.id, row.supersedesReturnId));
      return { returnRef: row.returnRef, status: "finalized" as const, taxDue: current.totals.taxDue };
    }),
});

export const _operatorsRef = operators;
