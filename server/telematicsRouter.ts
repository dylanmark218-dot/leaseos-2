/**
 * Telematics and video safety — the API.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, ownershipScopeWhere, unitInScope } from "./db";
import { drivingEvents, faultCodes, maintenanceDefects, telemetrySnapshots, trips, units, videoAccessLog, workOrders } from "../drizzle/schema";
import { faultDispatchEffect, odometerReconciliation, reviewDecision, reviewQueue } from "./_core/telematics";
import { storageGetSignedUrl } from "./storage";

async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
/*
 * 0189 — telematics had no tenant scope: any caller holding the permission read and acted on every
 * organization's faults, driving events and video. Every row here keys to a unit, so the unit's owner
 * decides, as in the shop; out of scope is "not found", never "forbidden".
 */
async function unitOrNotFound(userId: number, unitId: number, what: string) {
  if (!(await unitInScope(unitId, await actingScopeFor(userId)))) throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
}

export const telematicsRouter = router({
  /** The unit as it reports itself, reconciled against what LeaseOS already knows. */
  unit: roleProcedure("telematics.unit").input(z.object({ unitId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await unitOrNotFound(ctx.user.id, input.unitId, `Unit ${input.unitId}`);
    const db = await dbOrThrow();
    const latest = (await db.select().from(telemetrySnapshots).where(eq(telemetrySnapshots.unitId, input.unitId)).orderBy(desc(telemetrySnapshots.recordedAt)).limit(1))[0];
    const shop = (await db.select({ odometerKm: workOrders.odometerKm, at: workOrders.completedAt, opened: workOrders.openedAt }).from(workOrders).where(and(eq(workOrders.unitId, input.unitId), isNotNull(workOrders.odometerKm))).orderBy(desc(workOrders.openedAt)).limit(1))[0];
    const tripRows = await db.select({ distanceKm: trips.distanceKm, completedAt: trips.completedAt }).from(trips).where(and(eq(trips.unitId, input.unitId), isNotNull(trips.distanceKm)));
    const since = shop?.at ?? shop?.opened ?? null;
    const tripsSince = since ? tripRows.filter(t => t.completedAt && t.completedAt >= since) : tripRows;
    const rec = odometerReconciliation({ telemetryKm: latest?.odometerKm ?? null, telemetryAt: latest?.recordedAt ?? null, tripsKmSum: tripsSince.length ? tripsSince.reduce((a, t) => a + (t.distanceKm ?? 0), 0) : null, lastShopKm: shop?.odometerKm ?? null, lastShopAt: since });
    const faults = await db.select().from(faultCodes).where(and(eq(faultCodes.unitId, input.unitId), inArray(faultCodes.status, ["active", "acknowledged"])));
    return { unitId: input.unitId, latest: latest ? { recordedAt: latest.recordedAt, odometerKm: latest.odometerKm, engineHours: latest.engineHours, ptoHours: latest.ptoHours, idleMinutes: latest.idleMinutes, fuelLevelPct: latest.fuelLevelPct } : null, odometer: rec, faults: faults.map(f => ({ id: f.id, protocol: f.protocol, code: f.code, subcode: f.subcode, description: f.description, occurrenceCount: f.occurrenceCount, firstSeenAt: f.firstSeenAt, lastSeenAt: f.lastSeenAt, status: f.status, severityDetermination: f.severityDetermination, dispatch: faultDispatchEffect(f) })) };
  }),

  faults: roleProcedure("telematics.faults").input(z.object({ status: z.enum(["active", "acknowledged", "cleared"]).optional() })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const mine = ownershipScopeWhere("unit", faultCodes.unitId, await actingScopeFor(ctx.user.id));
    const rows = input.status ? await db.select().from(faultCodes).where(and(eq(faultCodes.status, input.status), mine)).orderBy(desc(faultCodes.lastSeenAt)).limit(500) : await db.select().from(faultCodes).where(and(inArray(faultCodes.status, ["active", "acknowledged"]), mine)).orderBy(desc(faultCodes.lastSeenAt)).limit(500);
    return { faults: rows.map(f => ({ id: f.id, unitId: f.unitId, protocol: f.protocol, code: f.code, subcode: f.subcode, occurrenceCount: f.occurrenceCount, lastSeenAt: f.lastSeenAt, status: f.status, severityDetermination: f.severityDetermination, dispatch: faultDispatchEffect(f) })) };
  }),

  /** A mechanic's determination: the fault becomes a defect with the severity the mechanic decided. */
  faultAcknowledge: roleProcedure("telematics.faultAcknowledge").input(z.object({ faultId: z.number().int().positive(), severity: z.enum(["advisory", "inspection_required", "critical"]), title: z.string().min(3).max(220), detail: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const f = (await db.select().from(faultCodes).where(eq(faultCodes.id, input.faultId)).limit(1))[0];
    if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "Fault not found" });
    await unitOrNotFound(ctx.user.id, f.unitId, "Fault");
    if (f.status === "acknowledged") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Already acknowledged — the defect stands" });
    const ins = await db.insert(maintenanceDefects).values({ unitId: f.unitId, title: input.title, severity: input.severity, status: "open", detail: `${input.detail ?? ""}\n[telematics] ${f.protocol.toUpperCase()} ${f.code}${f.subcode ? `/${f.subcode}` : ""} seen ${f.occurrenceCount}× ${f.firstSeenAt.toISOString()} → ${f.lastSeenAt.toISOString()}; severity determined by the acknowledging mechanic, not by a rule`.trim(), reportedAt: new Date(), reportedBy: ctx.user.id });
    const defectId = Number(ins[0]?.insertId ?? 0);
    await db.update(faultCodes).set({ status: "acknowledged", severityDetermination: input.severity, severitySource: `mechanic:${ctx.user.id}`, acknowledgedByUserId: ctx.user.id, acknowledgedAt: new Date(), defectId }).where(eq(faultCodes.id, f.id));
    return { faultId: f.id, defectId, severity: input.severity, dispatch: faultDispatchEffect({ status: "acknowledged", severityDetermination: input.severity, code: f.code, occurrenceCount: f.occurrenceCount }) };
  }),

  faultClear: roleProcedure("telematics.faultClear").input(z.object({ faultId: z.number().int().positive(), reason: z.string().min(5).max(300) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const f = (await db.select().from(faultCodes).where(eq(faultCodes.id, input.faultId)).limit(1))[0];
    if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "Fault not found" });
    await unitOrNotFound(ctx.user.id, f.unitId, "Fault");
    if (f.status === "acknowledged" && f.defectId) { const d = (await db.select({ status: maintenanceDefects.status }).from(maintenanceDefects).where(eq(maintenanceDefects.id, f.defectId)).limit(1))[0]; if (d && d.status !== "resolved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The defect it became is not resolved — resolve the defect; the fault clears with it" }); }
    await db.update(faultCodes).set({ status: "cleared", severitySource: `${f.severitySource ?? ""}; cleared: ${input.reason}`.slice(0, 120) }).where(eq(faultCodes.id, f.id));
    return { faultId: f.id, status: "cleared" as const };
  }),

  /** What awaits review, by unit, oldest first. Nothing per driver is summed. */
  reviewQueue: roleProcedure("telematics.reviewQueue").query(async ({ ctx }) => {
    const db = await dbOrThrow();
    const rows = await db.select().from(drivingEvents).where(and(eq(drivingEvents.reviewStatus, "unreviewed"), ownershipScopeWhere("unit", drivingEvents.unitId, await actingScopeFor(ctx.user.id)))).orderBy(drivingEvents.recordedAt).limit(1000);
    return { queue: reviewQueue(rows.map(e => ({ eventRef: e.eventRef, unitId: e.unitId, kind: e.kind, recordedAt: e.recordedAt, reviewStatus: e.reviewStatus, hasVideo: !!e.videoClipRef }))), events: rows.map(e => ({ eventRef: e.eventRef, unitId: e.unitId, kind: e.kind, recordedAt: e.recordedAt, magnitude: e.magnitude, magnitudeUnit: e.magnitudeUnit, speedKph: e.speedKph, postedLimitKph: e.postedLimitKph, postedLimitSource: e.postedLimitSource, hasVideo: !!e.videoClipRef })) };
  }),

  /** Coach, dismiss, or escalate — once, with a note, and after viewing the video when there is one. */
  eventReview: roleProcedure("telematics.eventReview").input(z.object({ eventRef: z.string().min(1).max(64), decision: z.enum(["coached", "dismissed", "escalated"]), note: z.string().max(600) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const e = (await db.select().from(drivingEvents).where(eq(drivingEvents.eventRef, input.eventRef)).limit(1))[0];
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
    await unitOrNotFound(ctx.user.id, e.unitId, "Event");
    const viewed = e.videoClipRef ? (await db.select({ id: videoAccessLog.id }).from(videoAccessLog).where(and(eq(videoAccessLog.drivingEventId, e.id), eq(videoAccessLog.userId, ctx.user.id))).limit(1)).length > 0 : false;
    const d = reviewDecision({ current: e.reviewStatus, decision: input.decision, note: input.note, hasVideo: !!e.videoClipRef, videoViewedByReviewer: viewed });
    if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
    await db.update(drivingEvents).set({ reviewStatus: input.decision, reviewedByUserId: ctx.user.id, reviewedAt: new Date(), reviewNote: input.note }).where(eq(drivingEvents.id, e.id));
    return { eventRef: e.eventRef, reviewStatus: input.decision, note: input.decision === "escalated" ? "Escalated: open an incident in the safety module with this event as evidence; the event itself does not become an incident." : null };
  }),

  /** A look at the video: its own permission, a stated purpose, a logged row, and a short-lived URL — never the bytes. */
  videoView: roleProcedure("telematics.videoView").input(z.object({ eventRef: z.string().min(1).max(64), purpose: z.string().min(5).max(200) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const e = (await db.select().from(drivingEvents).where(eq(drivingEvents.eventRef, input.eventRef)).limit(1))[0];
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
    await unitOrNotFound(ctx.user.id, e.unitId, "Event");
    if (!e.videoClipRef) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No video on this event" });
    await db.insert(videoAccessLog).values({ drivingEventId: e.id, userId: ctx.user.id, purpose: input.purpose, at: new Date() });
    const url = e.videoStorageKey ? await storageGetSignedUrl(e.videoStorageKey) : null;
    return { eventRef: e.eventRef, clipRef: e.videoClipRef, clipHash: e.videoClipHash, url, note: url ? "Short-lived URL; verify the clip against its hash." : "The clip is referenced by the provider and not yet in the vault; the reference and hash are what LeaseOS holds." };
  }),
});
