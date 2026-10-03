/**
 * Fleet & Equipment Portfolio — the API for the foundation slice (mounted as `fleet`).
 *
 * Holds, the meter record and the unit's operational state: canonical for LeaseOS (owner decisions
 * 2026-09-25), and consumed by the Mechanic Portal rather than rebuilt in it. Every procedure keys to a
 * unit the caller's organization owns and answers NOT_FOUND otherwise — worded as for a unit that does
 * not exist. Who acted is always the authenticated caller.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, unitInScope } from "./db";
import { fleetPortfolioEvents, unitHolds, unitMeterReadings } from "../drizzle/schema";
import { HOLD_TYPES, actingRoleFor, driverNotice, holdEffectFor, mayPlaceHold, mayReleaseHold, type HoldType } from "./_core/fleetPortfolio";
import { METER_TYPES, meterProgress, meterSequence, type MeterType } from "./_core/fleetMeters";
import { activeHolds, appendEvent, fleetRef, meterObservations, operationalStateFor, orgRefOf, placeHold, releaseHold } from "./fleetPortfolioService";
import { fleetAssetProcedures } from "./fleetAssetRouter";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
/** The unit, if the caller's organization owns it; otherwise NOT_FOUND, exactly as for a unit that does not exist. */
async function unitInCallerScope(userId: number, unitId: number) {
  const scope = await actingScopeFor(userId);
  const u = await unitInScope(unitId, scope);
  if (!u) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${unitId} not found` });
  return { unit: u, orgRef: orgRefOf(scope.tenantId) };
}
const HOLD_TYPE = z.enum(HOLD_TYPES as [HoldType, ...HoldType[]]);
const METER = z.enum(METER_TYPES as [MeterType, ...MeterType[]]);
/** A reading from the future is a typo or a wrong clock. Five minutes covers clock drift. */
const notFuture = (d: Date) => d.getTime() <= Date.now() + 5 * 60_000;
/** Which ledger sources each role may record under (reconciliation R-9: no driver in this slice). */
const LEDGER_SOURCE_BY_ROLE: Record<string, readonly ("mechanic" | "inspection" | "job_closeout" | "imported")[]> = {
  mechanic: ["mechanic", "inspection"],
  shop_lead: ["mechanic", "inspection", "imported"],
  office: ["job_closeout", "imported"],
};

export const fleetPortfolioRouter = router({
  /* 0237 — identity, lifecycle, components, the list, the detail, unit-side readiness, the driver's own units (server/fleetAssetRouter.ts). */
  ...fleetAssetProcedures,
  /** May this unit operate? One status, every reason with its source and the act that lifts it, and what was not evaluated. */
  unitState: roleProcedure("fleet.unitState")
    .input(z.object({ unitId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const { unit } = await unitInCallerScope(ctx.user.id, input.unitId);
      const state = await operationalStateFor(await dbOrThrow(), unit.id);
      return { unitId: unit.id, unitNumber: unit.unitNumber, ...state, driverNotice: driverNotice(state) };
    }),

  /** Active holds, and — when asked — released ones with who released them and why. */
  holdList: roleProcedure("fleet.holdList")
    .input(z.object({ unitId: z.number().int().positive(), includeReleased: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const { unit } = await unitInCallerScope(ctx.user.id, input.unitId);
      const db = await dbOrThrow();
      const rows = input.includeReleased
        ? await db.select().from(unitHolds).where(eq(unitHolds.unitId, unit.id)).orderBy(desc(unitHolds.placedAt), desc(unitHolds.id))
        : await activeHolds(db, unit.id);
      return { unitId: unit.id, holds: rows };
    }),

  /**
   * Place a hold. The type decides the effect (a safety hold is out of service); the caller's role decides
   * which types they may place (a mechanic places maintenance holds only). Sensitive: fail-closed audit.
   */
  holdPlace: roleProcedure("fleet.holdPlace")
    .input(z.object({
      unitId: z.number().int().positive(), holdType: HOLD_TYPE, reason: z.string().min(10).max(600),
      effect: z.enum(["warn", "block"]).nullable().default(null), evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { unit, orgRef } = await unitInCallerScope(ctx.user.id, input.unitId);
      const may = mayPlaceHold(ctx.roles, input.holdType);
      if (!may.allowed) throw new TRPCError({ code: "FORBIDDEN", message: may.reason });
      const eff = holdEffectFor({ holdType: input.holdType, requested: input.effect, roles: ctx.roles });
      if ("refused" in eff) throw new TRPCError({ code: "BAD_REQUEST", message: eff.refused });
      const db = await dbOrThrow();
      const holdRef = await placeHold(db, {
        unitId: unit.id, orgRef, holdType: input.holdType, effect: eff.effect, reason: input.reason, sourceKind: "manual",
        evidenceRecordId: input.evidenceRecordId ?? null, byUserId: ctx.user.id, byRole: actingRoleFor(ctx.roles, input.holdType, "place")!,
      });
      const state = await operationalStateFor(db, unit.id);
      return { holdRef, unitId: unit.id, dispatchEffect: eff.effect, status: state.status, driverNotice: driverNotice(state) };
    }),

  /** Release one active hold: a second person, holding a role that releases its type. Sensitive. */
  holdRelease: roleProcedure("fleet.holdRelease")
    .input(z.object({ holdRef: z.string().min(1).max(96), reason: z.string().min(5).max(600), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const hold = (await db.select().from(unitHolds).where(eq(unitHolds.holdRef, input.holdRef)).limit(1))[0];
      // Another organization's hold is a hold that does not exist.
      if (!hold || !(await unitInScope(hold.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Hold ${input.holdRef} not found` });
      if (hold.sourceKind !== "manual") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A hold placed by ${hold.sourceKind.replace(/_/g, " ")} ${hold.sourceRef ?? ""} is released by the act that resolves it`.trim() });
      const may = mayReleaseHold({ roles: ctx.roles, holdType: hold.holdType, placedByUserId: hold.placedByUserId, userId: ctx.user.id, status: hold.status });
      if (!may.allowed) throw new TRPCError({ code: hold.status !== "active" ? "PRECONDITION_FAILED" : "FORBIDDEN", message: may.reason });
      const released = await releaseHold(db, { hold, byUserId: ctx.user.id, byRole: actingRoleFor(ctx.roles, hold.holdType, "release")!, reason: input.reason, evidenceRecordId: input.evidenceRecordId ?? null });
      if (!released) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This hold is already released" });
      const state = await operationalStateFor(db, hold.unitId);
      return { holdRef: hold.holdRef, unitId: hold.unitId, status: state.status, driverNotice: driverNotice(state) };
    }),

  /** Every meter observation on the unit, from wherever it lives, with its source — and each meter's sequence. */
  meterReadings: roleProcedure("fleet.meterReadings")
    .input(z.object({ unitId: z.number().int().positive(), meterType: METER.optional() }))
    .query(async ({ ctx, input }) => {
      const { unit } = await unitInCallerScope(ctx.user.id, input.unitId);
      const obs = await meterObservations(await dbOrThrow(), unit.id);
      const types = input.meterType ? [input.meterType] : METER_TYPES.filter(t => obs.some(o => o.meterType === t));
      return {
        unitId: unit.id,
        meters: types.map(t => {
          const s = meterSequence(obs, t);
          return { meterType: t, trust: s.trust, current: s.current, regressions: s.regressions.map(r => ({ code: r.code, earlier: r.earlier.ref, later: r.later.ref, drop: r.drop })), observations: s.observations };
        }),
      };
    }),

  /**
   * How far a meter has moved since a baseline observation — the seam maintenance scheduling calls.
   * `indeterminate` with `METER_REGRESSION` when the meter went down from the baseline on.
   */
  meterProgress: roleProcedure("fleet.meterProgress")
    .input(z.object({ unitId: z.number().int().positive(), meterType: METER, baselineRef: z.string().min(1).max(160) }))
    .query(async ({ ctx, input }) => {
      const { unit } = await unitInCallerScope(ctx.user.id, input.unitId);
      return meterProgress(await meterObservations(await dbOrThrow(), unit.id), input.meterType, input.baselineRef);
    }),

  /** A reading with no other home. Recorded unverified; a second person verifies or rejects it. Never edited. */
  meterRecord: roleProcedure("fleet.meterRecord")
    .input(z.object({
      unitId: z.number().int().positive(), meterType: METER, reading: z.number().nonnegative().finite(),
      recordedAt: z.coerce.date().default(() => new Date()), source: z.enum(["mechanic", "inspection", "job_closeout", "imported"]),
      sourceRef: z.string().max(120).optional(), confidence: z.enum(["low", "medium", "high"]).default("medium"), note: z.string().max(400).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { unit, orgRef } = await unitInCallerScope(ctx.user.id, input.unitId);
      if (!notFuture(input.recordedAt)) throw new TRPCError({ code: "BAD_REQUEST", message: "A reading cannot be recorded in the future" });
      const role = ctx.roles.find(r => LEDGER_SOURCE_BY_ROLE[r]?.includes(input.source));
      if (!role) throw new TRPCError({ code: "FORBIDDEN", message: `None of your roles records a reading as "${input.source}"` });
      const db = await dbOrThrow();
      const readingRef = fleetRef("MTR");
      await db.transaction(async tx => {
        await tx.insert(unitMeterReadings).values({
          readingRef, orgRef, unitId: unit.id, meterType: input.meterType, reading: input.reading, recordedAt: input.recordedAt,
          source: input.source, sourceRef: input.sourceRef ?? null, enteredByUserId: ctx.user.id, confidence: input.confidence, note: input.note ?? null,
        });
        await appendEvent(tx, { orgRef, unitId: unit.id, subjectType: "meter_reading", subjectRef: readingRef, eventType: "meter_recorded", newState: "unverified", detail: `${input.meterType} ${input.reading} (${input.source})`, actorUserId: ctx.user.id, actorRole: role });
      });
      const seq = meterSequence(await meterObservations(db, unit.id), input.meterType);
      return { readingRef, verificationStatus: "unverified" as const, trust: seq.trust, regressions: seq.regressions.map(r => ({ code: r.code, earlier: r.earlier.ref, later: r.later.ref, drop: r.drop })) };
    }),

  /** Verify or reject a ledger reading — once, by someone other than who entered it. The reading itself never changes. */
  meterDecide: roleProcedure("fleet.meterDecide")
    .input(z.object({ readingRef: z.string().min(1).max(96), decision: z.enum(["verified", "rejected"]), note: z.string().min(3).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const r = (await db.select().from(unitMeterReadings).where(eq(unitMeterReadings.readingRef, input.readingRef)).limit(1))[0];
      if (!r || !(await unitInScope(r.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Reading ${input.readingRef} not found` });
      if (r.enteredByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who entered a reading may not verify or reject it" });
      if (r.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Reading ${r.readingRef} was already ${r.verificationStatus}` });
      await db.transaction(async tx => {
        const res = await tx.update(unitMeterReadings).set({ verificationStatus: input.decision, verifiedByUserId: ctx.user.id, verifiedAt: new Date() })
          .where(and(eq(unitMeterReadings.id, r.id), eq(unitMeterReadings.verificationStatus, "unverified")));
        if ((res as unknown as [{ affectedRows: number }])[0]?.affectedRows !== 1) throw new TRPCError({ code: "CONFLICT", message: `Reading ${r.readingRef} was decided by someone else a moment ago` });
        await appendEvent(tx, { orgRef: r.orgRef, unitId: r.unitId, subjectType: "meter_reading", subjectRef: r.readingRef, eventType: input.decision === "verified" ? "meter_verified" : "meter_rejected", previousState: "unverified", newState: input.decision, detail: input.note, actorUserId: ctx.user.id, actorRole: ctx.roles[0] ?? null });
      });
      return { readingRef: r.readingRef, verificationStatus: input.decision };
    }),

  /** The portfolio's history for one unit, newest first. Append-only: nothing in it is ever edited. */
  history: roleProcedure("fleet.history")
    .input(z.object({ unitId: z.number().int().positive(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      const { unit } = await unitInCallerScope(ctx.user.id, input.unitId);
      const rows = await (await dbOrThrow()).select().from(fleetPortfolioEvents).where(eq(fleetPortfolioEvents.unitId, unit.id)).orderBy(desc(fleetPortfolioEvents.id)).limit(input.limit);
      return { unitId: unit.id, events: rows };
    }),
});
