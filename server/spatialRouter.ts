/**
 * Spatial foundation — the API. Locations with coordinate provenance,
 * vehicle profiles, road restrictions, the four-axis evaluation over named
 * segments (the existing engine, its evidence persisted), and route requests
 * that say no source is loaded.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { applicableRestrictions, fingerprintHash, structureAttributes } from "./_core/structures";
import { recheckRouteApproval, routeDependencies } from "./routeDependencies";
import { actingScopeFor, getDb, jobInScope, unitInScope } from "./db";
import { accessRoadSegments, roadGraphBuilds, roadGraphEdges, roadRadioAssignments, routeApprovals, structures, bridges, inboundEvents, integrationClients, locationIdentities, roadRestrictions, routeEvidenceEntries, routeRequests, units, vehicleProfiles } from "../drizzle/schema";
import { resolveAssignment } from "./_core/commRoute";
import { parseLsd, parseUwi, theoreticalCentroid } from "./_core/dls";
import { routeAgainstNetwork, routingSourceStatus } from "./_core/routingSource";
import { evaluateRoute, type RoadSegmentInput, type SegmentAttribute } from "./_core/routeEvaluation";
import type { RequiredCheck } from "./_core/routingCompiler";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
const CHECK = z.enum(["road_weight_restriction", "axle_group_limit", "bridge_capacity", "bridge_axle_limit", "overhead_clearance", "bridge_clearance", "width_restriction", "length_restriction", "truck_route_designation", "dg_corridor", "dg_time_restriction", "seasonal_closure", "road_ban_level", "road_owner_permission", "oversize_corridor_designation", "escort_requirement"]);
const AXLE_GROUP = z.object({ name: z.string().min(1).max(40), axles: z.number().int().positive().max(6), emptyKg: z.number().int().nonnegative(), loadedKg: z.number().int().nonnegative() });

export const spatialRouter = router({
  /** Register a lease or well. The LSD and UWI are validated; the coordinate, if none is given, is the THEORETICAL grid, and says so. */
  locationRegister: roleProcedure("spatial.locationRegister")
    .input(z.object({ name: z.string().min(1).max(220), surfaceLsd: z.string().min(1).max(80), uwi: z.string().max(80).optional(), operator: z.string().max(200).optional(), lease: z.string().max(120).optional(), province: z.string().max(40).default("AB"), customerStated: z.object({ latitude: z.number(), longitude: z.number() }).optional() }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      const lsd = parseLsd(input.surfaceLsd);
      if (!lsd.ok) throw new TRPCError({ code: "BAD_REQUEST", message: lsd.reason });
      const uwi = input.uwi ? parseUwi(input.uwi) : null;
      if (uwi && !uwi.ok) throw new TRPCError({ code: "BAD_REQUEST", message: uwi.reason });
      const theo = theoreticalCentroid(lsd.value);
      const coord = input.customerStated ? { latitude: input.customerStated.latitude, longitude: input.customerStated.longitude, source: "customer_stated" as const, confidence: "medium" as const } : { latitude: theo.latitude, longitude: theo.longitude, source: "theoretical_grid" as const, confidence: "low" as const };
      const ins = await db.insert(locationIdentities).values({ name: input.name, surfaceLsd: lsd.value.canonical, lsdValid: true, uwi: uwi && uwi.ok ? uwi.value.canonical : null, uwiValid: uwi ? uwi.ok : null, operator: input.operator ?? null, lease: input.lease ?? null, province: input.province, surfaceLatitude: coord.latitude, surfaceLongitude: coord.longitude, coordinateSource: coord.source, coordinateConfidence: coord.confidence, coordinateVerificationStatus: "unverified", source: coord.source } as never);
      return { locationId: Number(ins[0]?.insertId ?? 0), surfaceLsd: lsd.value.canonical, uwi: uwi && uwi.ok ? uwi.value.canonical : null, coordinate: { ...coord, verificationStatus: "unverified" as const }, caveat: coord.source === "theoretical_grid" ? theo.caveat : "Customer-stated coordinate — unverified until ATS or a field fix confirms it" };
    }),

  /** A verified coordinate: from ATS v4.1 or a field GPS fix, with the evidence, by someone with the authority. */
  locationVerify: roleProcedure("spatial.locationVerify")
    .input(z.object({ locationId: z.number().int().positive(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), source: z.enum(["ats_v41", "field_gps"]), evidenceRecordId: z.number().int().positive(), datasetVersion: z.string().max(80).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const loc = (await db.select().from(locationIdentities).where(eq(locationIdentities.id, input.locationId)).limit(1))[0];
      if (!loc) throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      if (input.source === "ats_v41" && !input.datasetVersion) throw new TRPCError({ code: "BAD_REQUEST", message: "An ATS coordinate names its dataset version" });
      const prior = loc.surfaceLatitude != null && loc.surfaceLongitude != null ? { latitude: loc.surfaceLatitude, longitude: loc.surfaceLongitude, source: loc.coordinateSource } : null;
      await db.update(locationIdentities).set({ surfaceLatitude: input.latitude, surfaceLongitude: input.longitude, coordinateSource: input.source, coordinateConfidence: "high", coordinateVerificationStatus: "verified", coordinateVerifiedByUserId: ctx.user.id, coordinateEvidenceRecordId: input.evidenceRecordId, source: input.datasetVersion ? `${input.source} ${input.datasetVersion}` : input.source, lastVerifiedAt: new Date() }).where(eq(locationIdentities.id, loc.id));
      return { locationId: loc.id, coordinate: { latitude: input.latitude, longitude: input.longitude, source: input.source, confidence: "high" as const, verificationStatus: "verified" as const }, replaced: prior };
    }),

  locationGet: roleProcedure("spatial.locationGet").input(z.object({ locationId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await dbOrThrow();
    const loc = (await db.select().from(locationIdentities).where(eq(locationIdentities.id, input.locationId)).limit(1))[0];
    if (!loc) throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
    return { locationId: loc.id, name: loc.name, surfaceLsd: loc.surfaceLsd, lsdValid: loc.lsdValid, uwi: loc.uwi, uwiValid: loc.uwiValid, coordinate: loc.surfaceLatitude != null ? { latitude: loc.surfaceLatitude, longitude: loc.surfaceLongitude, source: loc.coordinateSource, confidence: loc.coordinateConfidence, verificationStatus: loc.coordinateVerificationStatus } : null, navigable: loc.coordinateVerificationStatus === "verified", note: loc.coordinateVerificationStatus === "verified" ? null : "Coordinate is unverified — not for navigation" };
  }),

  vehicleProfileSet: roleProcedure("spatial.vehicleProfileSet")
    .input(z.object({ unitId: z.number().int().positive(), heightM: z.number().positive().max(6), widthM: z.number().positive().max(5), lengthM: z.number().positive().max(40), emptyWeightKg: z.number().int().positive(), axleGroups: z.array(AXLE_GROUP).min(1).max(6), source: z.enum(["shop_measured", "spec_sheet", "operator_stated"]), measuredAt: z.coerce.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit must be in the caller's scope (coreRecordOwnership); otherwise it does not exist here.
      if (!(await unitInScope(input.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      const db = await dbOrThrow();
      for (const g of input.axleGroups) if (g.loadedKg < g.emptyKg) throw new TRPCError({ code: "BAD_REQUEST", message: `${g.name}: loaded below empty` });
      const values = { unitId: input.unitId, heightM: input.heightM, widthM: input.widthM, lengthM: input.lengthM, emptyWeightKg: input.emptyWeightKg, axleGroupsJson: JSON.stringify(input.axleGroups), source: input.source, measuredAt: input.measuredAt ?? null, verificationStatus: "unverified" as const, verifiedByUserId: null, recordedByUserId: ctx.user.id };
      const cur = (await db.select({ id: vehicleProfiles.id }).from(vehicleProfiles).where(eq(vehicleProfiles.unitId, input.unitId)).limit(1))[0];
      if (cur) await db.update(vehicleProfiles).set(values).where(eq(vehicleProfiles.id, cur.id)); else await db.insert(vehicleProfiles).values(values);
      return { unitId: input.unitId, verificationStatus: "unverified" as const, loadedGrossKg: input.axleGroups.reduce((a, g) => a + g.loadedKg, 0), maxAxleGroupKg: Math.max(...input.axleGroups.map(g => g.loadedKg)) };
    }),

  vehicleProfileVerify: roleProcedure("spatial.vehicleProfileVerify").input(z.object({ unitId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      // P4.1: the unit must be in the caller's scope (coreRecordOwnership); otherwise it does not exist here.
      if (!(await unitInScope(input.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
    const db = await dbOrThrow();
    const p = (await db.select().from(vehicleProfiles).where(eq(vehicleProfiles.unitId, input.unitId)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No profile" });
    if (p.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded the profile may not verify it" });
    if (p.source === "operator_stated") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An operator-stated profile is not verified — measure it or record the spec sheet" });
    await db.update(vehicleProfiles).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id }).where(eq(vehicleProfiles.id, p.id));
    return { unitId: input.unitId, verificationStatus: "verified" as const };
  }),

  /** A road restriction is a rule row with its source. Recorded unverified; nothing is seeded. */
  restrictionRecord: roleProcedure("spatial.restrictionRecord")
    .input(z.object({ jurisdiction: z.string().min(2).max(40), roadRef: z.string().min(1).max(120), segmentId: z.string().min(1).max(80), segmentLabel: z.string().min(1).max(220), check: CHECK, limitValue: z.number().nullable().optional(), textValue: z.string().max(200).nullable().optional(), unit: z.string().max(20).nullable().optional(), effectiveFrom: z.coerce.date().nullable().optional(), effectiveTo: z.coerce.date().nullable().optional(), source: z.string().min(2).max(220), sourceUrl: z.string().max(500).optional(), sourceVersion: z.string().max(80).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      if (input.limitValue == null && !input.textValue) throw new TRPCError({ code: "BAD_REQUEST", message: "A restriction carries a limit or a text value" });
      const restrictionRef = ref("RST");
      await db.insert(roadRestrictions).values({ restrictionRef, jurisdiction: input.jurisdiction, roadRef: input.roadRef, segmentId: input.segmentId, segmentLabel: input.segmentLabel, checkKey: input.check, limitValue: input.limitValue ?? null, textValue: input.textValue ?? null, unit: input.unit ?? null, effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null, source: input.source, sourceUrl: input.sourceUrl ?? null, sourceVersion: input.sourceVersion ?? null, recordedByUserId: ctx.user.id });
      return { restrictionRef, verificationStatus: "unverified" as const, note: "Unverified: the evaluation treats it as unknown data until a second person verifies it against its source document." };
    }),

  restrictionVerify: roleProcedure("spatial.restrictionVerify").input(z.object({ restrictionRef: z.string().min(1).max(64), sourceDocumentEvidenceId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const r = (await db.select().from(roadRestrictions).where(eq(roadRestrictions.restrictionRef, input.restrictionRef)).limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Restriction not found" });
    if (r.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded the restriction may not verify it" });
    await db.update(roadRestrictions).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), sourceDocumentEvidenceId: input.sourceDocumentEvidenceId }).where(eq(roadRestrictions.id, r.id));
    return { restrictionRef: r.restrictionRef, verificationStatus: "verified" as const };
  }),

  /**
   * The four-axis evaluation over segments the caller names, with the unit's
   * profile. Verified restrictions and bridges are authority data; unverified
   * ones are unknown data; a segment with no data for a check is unknown.
   * The evidence is persisted so the verdict can be reproduced.
   */
  routeEvaluateSegments: roleProcedure("spatial.routeEvaluateSegments")
    .input(z.object({ unitId: z.number().int().positive(), segments: z.array(z.object({ segmentId: z.string().min(1).max(80), label: z.string().min(1).max(220), lengthKm: z.number().nonnegative() })).min(1).max(200), at: z.coerce.date().default(() => new Date()), requiredChecks: z.array(CHECK).min(1), dangerousGoods: z.boolean().default(false), requiresEscort: z.boolean().default(false), tripId: z.number().int().positive().optional(), jobId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit must be in the caller's scope (coreRecordOwnership); otherwise it does not exist here.
      if (!(await unitInScope(input.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      const db = await dbOrThrow();
      const p = (await db.select().from(vehicleProfiles).where(eq(vehicleProfiles.unitId, input.unitId)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No vehicle profile for this unit — record its dimensions and axle weights first" });
      const groups = JSON.parse(p.axleGroupsJson) as { loadedKg: number }[];
      const vehicle = { grossWeightKg: groups.reduce((a, g) => a + g.loadedKg, 0), maxAxleGroupKg: Math.max(...groups.map(g => g.loadedKg)), heightM: p.heightM, widthM: p.widthM, lengthM: p.lengthM, dangerousGoods: input.dangerousGoods, requiresEscort: input.requiresEscort };
      const ids = input.segments.map(s => s.segmentId);
      const [rs, bs] = await Promise.all([db.select().from(roadRestrictions).where(inArray(roadRestrictions.segmentId, ids)), db.select().from(bridges).where(inArray(bridges.segmentId, ids))]);
      const dateNotes: string[] = [];
      const structureNotes: string[] = [];
      const live = await db.select().from(structures).where(inArray(structures.segmentId, ids));
      const segments: RoadSegmentInput[] = input.segments.map(s => {
        const attrs: SegmentAttribute[] = [];
        // One row per check: a verified row over an unverified one, and the latest within each; superseded rows do not apply.
        // v22.15 — a restriction applies on a date or it does not apply at all; what its window excludes is reported, never silently dropped.
        const windowed = applicableRestrictions(rs.filter(x => x.segmentId === s.segmentId), input.at);
        for (const { row, state } of windowed.setAside) dateNotes.push(`${s.label}: ${row.checkKey.replace(/_/g, " ")} restriction ${row.restrictionRef} is ${state.replace(/_/g, " ")} on ${input.at.toISOString().slice(0, 10)} and was not applied`);
        const mine = windowed.applied;
        const seen = new Set<string>();
        for (const r of mine) { if (seen.has(r.checkKey)) continue; seen.add(r.checkKey); attrs.push({ check: r.checkKey as RequiredCheck, limitValue: r.limitValue, textValue: r.textValue, jurisdiction: r.jurisdiction, source: r.source, sourceVersion: r.sourceVersion, verifiedAt: r.verifiedAt?.toISOString() ?? null, confidence: r.verificationStatus === "verified" ? "authority_confirmed" : "unverified" }); }
        for (const b of bs.filter(x => x.segmentId === s.segmentId)) {
          const conf = b.verifiedAt ? "authority_confirmed" : "unverified";
          if (b.postedWeightKg != null) attrs.push({ check: "bridge_capacity", limitValue: b.postedWeightKg, jurisdiction: b.jurisdiction, source: b.source, sourceVersion: b.sourceVersion, verifiedAt: b.verifiedAt?.toISOString() ?? null, confidence: conf });
          if (b.postedAxleGroupKg != null) attrs.push({ check: "bridge_axle_limit", limitValue: b.postedAxleGroupKg, jurisdiction: b.jurisdiction, source: b.source, sourceVersion: b.sourceVersion, verifiedAt: b.verifiedAt?.toISOString() ?? null, confidence: conf });
          if (b.clearanceM != null) attrs.push({ check: "bridge_clearance", limitValue: b.clearanceM, jurisdiction: b.jurisdiction, source: b.source, sourceVersion: b.sourceVersion, verifiedAt: b.verifiedAt?.toISOString() ?? null, confidence: conf });
        }
        // v22.15 — structures recorded against this segment contribute what the road itself does not state.
        for (const st of live.filter(x => x.segmentId === s.segmentId)) {
          const contributed = structureAttributes(st, input.at);
          for (const a of contributed.attributes) { if (seen.has(a.check)) continue; seen.add(a.check); attrs.push(a); }
          structureNotes.push(...contributed.notes);
        }
        return { segmentId: s.segmentId, label: s.label, lengthKm: s.lengthKm, attributes: attrs };
      });
      const verdict = evaluateRoute(input.requiredChecks as RequiredCheck[], segments, vehicle);
      const evaluatedAt = new Date();
      // The evidence is written against the unit's profile, as the B12 table requires: a verdict is always about a profile.
      const routeProfileId = `unit:${input.unitId}:vp${p.id}:${p.verificationStatus}`;
      /*
       * 0167 — this evaluation's identity. Evidence rows are written per check per segment and were
       * tagged only with trip, job and segment, so a trip evaluated three times left three
       * indistinguishable sets. An approval that cannot name its own set cannot produce the
       * evidence it rests on, which is the detail behind the coverage numbers 0165 stores.
       */
      const evaluationRef = `RE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      for (const e of verdict.evidence) await db.insert(routeEvidenceEntries).values({ evaluationRef, routeDecisionId: null, routeProfileId, tripId: input.tripId ?? null, jobId: input.jobId ?? null, segmentId: e.segmentId.slice(0, 64), segmentLabel: e.segmentLabel.slice(0, 220), checkKey: e.check, axis: e.axis, result: e.result, reason: e.reason.slice(0, 400), vehicleValue: e.inputs.vehicleValue ?? null, limitValue: e.inputs.limitValue ?? null, unit: e.inputs.unit ?? null, jurisdiction: e.jurisdiction, source: e.source?.slice(0, 300) ?? null, sourceVersion: e.sourceVersion?.slice(0, 60) ?? null, verifiedAt: e.verifiedAt ? new Date(e.verifiedAt) : null, confidence: e.confidence, evaluatedAt } as never);
      // Returned so an approval can name the evaluation it was made from rather than guessing.
      return { evaluationRef, unitId: input.unitId, profileVerified: p.verificationStatus === "verified", vehicle, legal: verdict.legal, physicallyFeasible: verdict.physicallyFeasible, operationallyPreferred: verdict.operationallyPreferred, dataConfidence: verdict.dataConfidence, dispatchStatus: verdict.dispatchStatus, explanation: verdict.explanation, counts: { failing: verdict.failingCount, unknown: verdict.unknownCount, review: verdict.reviewCount }, evidence: verdict.evidence, routingSource: routingSourceStatus().status, evaluatedAt: input.at, dateNotes, structureNotes };
    }),

  /** A route against the road network. With no source loaded, the answer is UNKNOWN and the request is kept as a record of the ask. */
  /** Record a structure on a road: a bridge, culvert, overhead or cattle guard, with what is posted and where it came from. Unverified until a second person verifies it. */
  structureRecord: roleProcedure("spatial.structureRecord")
    .input(z.object({
      kind: z.enum(["bridge", "culvert", "overhead", "cattle_guard", "ford", "narrow_passage", "other"]), label: z.string().min(2).max(220), jurisdiction: z.string().min(2).max(60),
      segmentId: z.string().max(80).optional(), accessRoadObjectId: z.number().int().positive().optional(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
      clearanceM: z.number().positive().max(30).optional(), postedWeightKg: z.number().int().positive().optional(), postedAxleGroupKg: z.number().int().positive().optional(), ratedWeightKg: z.number().int().positive().optional(), loadRatingClass: z.string().max(40).optional(), widthM: z.number().positive().max(20).optional(),
      seasonalVariation: z.string().max(220).optional(), effectiveFrom: z.coerce.date().optional(), effectiveTo: z.coerce.date().optional(),
      source: z.string().min(3).max(300), sourceUrl: z.string().max(600).optional(), sourceVersion: z.string().max(60).optional(), sourceDocumentEvidenceId: z.number().int().positive().optional(), notes: z.string().max(600).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (input.effectiveTo && input.effectiveFrom && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The effective window ends before it begins" });
      if (input.postedWeightKg == null && input.postedAxleGroupKg == null && input.clearanceM == null && input.widthM == null && input.ratedWeightKg == null && !input.seasonalVariation) throw new TRPCError({ code: "BAD_REQUEST", message: "A structure with nothing posted, rated or seasonal states no limit — record what is on the sign" });
      const structureRef = `STR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.insert(structures).values({ structureRef, kind: input.kind, label: input.label, jurisdiction: input.jurisdiction, segmentId: input.segmentId ?? null, accessRoadObjectId: input.accessRoadObjectId ?? null, latitude: input.latitude, longitude: input.longitude, clearanceM: input.clearanceM ?? null, postedWeightKg: input.postedWeightKg ?? null, postedAxleGroupKg: input.postedAxleGroupKg ?? null, ratedWeightKg: input.ratedWeightKg ?? null, loadRatingClass: input.loadRatingClass ?? null, widthM: input.widthM ?? null, seasonalVariation: input.seasonalVariation ?? null, effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null, source: input.source, sourceUrl: input.sourceUrl ?? null, sourceVersion: input.sourceVersion ?? null, sourceDocumentEvidenceId: input.sourceDocumentEvidenceId ?? null, recordedByUserId: ctx.user.id, notes: input.notes ?? null });
      const postedOnly = input.postedWeightKg == null && input.ratedWeightKg != null;
      return { structureRef, verificationStatus: "unverified" as const, note: postedOnly ? "Recorded. A rated capacity with nothing posted is engineering data, not a posted limit — bridge capacity stays UNKNOWN until a posted limit is recorded." : "Recorded. Its limits carry operator-supplied confidence until a second person verifies it." };
    }),

  /** Verify a structure against its source. A second person, and never the recorder. */
  structureVerify: roleProcedure("spatial.structureVerify")
    .input(z.object({ structureRef: z.string().min(1).max(64), supersedesStructureRef: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const st = (await db.select().from(structures).where(eq(structures.structureRef, input.structureRef)).limit(1))[0];
      if (!st) throw new TRPCError({ code: "NOT_FOUND", message: "No such structure" });
      if (st.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Structure is ${st.verificationStatus}` });
      if (st.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded a structure does not verify it — a second person does" });
      let supersedesId: number | null = null;
      if (input.supersedesStructureRef) {
        const prior = (await db.select().from(structures).where(eq(structures.structureRef, input.supersedesStructureRef)).limit(1))[0];
        if (!prior || prior.verificationStatus !== "verified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a verified structure is superseded" });
        supersedesId = prior.id;
        await db.update(structures).set({ verificationStatus: "superseded" }).where(eq(structures.id, prior.id));
      }
      await db.update(structures).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), supersedesStructureId: supersedesId }).where(eq(structures.id, st.id));
      return { structureRef: st.structureRef, verificationStatus: "verified" as const, supersededStructureRef: input.supersedesStructureRef ?? null };
    }),

  /** Approve a route with the fingerprint of everything it depended on. */
  routeApprove: roleProcedure("spatial.routeApprove")
    .input(z.object({
      unitId: z.number().int().positive(), originRef: z.string().min(1).max(120), destinationRef: z.string().min(1).max(120), segmentIds: z.array(z.string().min(1).max(80)).min(1).max(200),
      dispatchStatus: z.string().min(3).max(40), explanation: z.string().min(3).max(2000), requiredChecks: z.array(z.string().min(2).max(60)).min(1).max(20),
      load: z.object({ grossWeightKg: z.number().int().positive(), dangerousGoods: z.boolean().default(false), unNumber: z.string().max(12).optional(), heightM: z.number().positive().optional(), widthM: z.number().positive().optional(), lengthM: z.number().positive().optional() }),
      permitRefs: z.array(z.string().max(64)).max(20).default([]), tripId: z.number().int().positive().optional(), jobId: z.number().int().positive().optional(),
      /*
       * 0167 — the evaluation this approval is being made from, as returned by
       * `routeEvaluateSegments`. Optional because an approval can legitimately be recorded without
       * one; when it is absent the coverage summary still stands and the evidence behind it simply
       * cannot be retrieved, which is a weaker record and should look like one rather than silently
       * borrowing whichever evaluation ran most recently.
       */
      evaluationRef: z.string().min(1).max(64).optional(),
      /**
       * v22.20 — the graph build this route was computed on, as `routeCompute`
       * returned it. Optional, and NULL means exactly "not recorded": an
       * approval that never carried a build is not backfilled with today's.
       * But a build that IS named is checked, because naming the wrong one
       * would make the geography look established when it was evaluated
       * against a different road.
       */
      buildRef: z.string().max(64).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit must be in the caller's scope (coreRecordOwnership); otherwise it does not exist here.
      if (!(await unitInScope(input.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      /*
       * S10.4 — "a known FAIL remains a FAIL; a second signature cannot turn it into PASS."
       *
       * The refusal used to read `input.dispatchStatus`, a free-form string the caller supplies.
       * So the rule protecting route approval checked what the caller SAID about the route rather
       * than what the evaluation FOUND, and approving a failing route needed nothing more than
       * sending "review" instead of "blocked". Not an exploit — a caller assembling the input from
       * a stale verdict would do it by accident, and the approval would look ordinary afterwards.
       *
       * The stored evidence is the authority. It is already written per segment and per check by
       * the evaluator, so there is a fact to consult instead of a claim to trust.
       */
      if (input.dispatchStatus === "blocked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A blocked route is not approved" });
      const failing = await db.select({ segmentId: routeEvidenceEntries.segmentId, checkKey: routeEvidenceEntries.checkKey, reason: routeEvidenceEntries.reason })
        .from(routeEvidenceEntries)
        .where(and(inArray(routeEvidenceEntries.segmentId, input.segmentIds), eq(routeEvidenceEntries.result, "fail")));
      if (failing.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `ROUTE_HAS_FAILING_EVIDENCE: ${failing.length} check(s) on this route evaluated FAIL and no approval clears them — ${failing.slice(0, 3).map(f => `${f.segmentId} ${f.checkKey}: ${f.reason}`).join("; ")}`,
        });
      }
      if (input.buildRef) {
        const build = (await db.select({ buildRef: roadGraphBuilds.buildRef, status: roadGraphBuilds.status }).from(roadGraphBuilds).where(eq(roadGraphBuilds.buildRef, input.buildRef)).limit(1))[0];
        if (!build) throw new TRPCError({ code: "NOT_FOUND", message: `No routing graph build ${input.buildRef}` });
        const edges = await db.select({ segmentId: roadGraphEdges.segmentId }).from(roadGraphEdges).where(and(eq(roadGraphEdges.buildRef, input.buildRef), inArray(roadGraphEdges.segmentId, input.segmentIds)));
        const covered = new Set(edges.map(e => e.segmentId));
        const absent = input.segmentIds.filter(id => !covered.has(id));
        if (absent.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Graph build ${input.buildRef} does not contain ${absent.length} of this route's segments (${absent.slice(0, 3).join(", ")}) — it is not the build this route was computed on` });
      }
      const deps = await routeDependencies(db, { unitId: input.unitId, segmentIds: input.segmentIds, load: input.load, permitRefs: input.permitRefs, requiredChecks: input.requiredChecks, at: input.at, buildRef: input.buildRef ?? null });
      const approvalRef = `RA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.insert(routeApprovals).values({ approvalRef, evaluationRef: input.evaluationRef ?? null, tripId: input.tripId ?? null, jobId: input.jobId ?? null, unitId: input.unitId, originRef: input.originRef, destinationRef: input.destinationRef, dispatchStatus: input.dispatchStatus, segmentIdsJson: JSON.stringify(input.segmentIds), buildRef: input.buildRef ?? null, fingerprintJson: JSON.stringify(deps), fingerprintHash: fingerprintHash(deps), explanation: input.explanation, approvedByUserId: ctx.user.id });
      return { approvalRef, status: "approved" as const, buildRef: input.buildRef ?? null, geographyRecorded: !!input.buildRef, fingerprintHash: fingerprintHash(deps), dependencies: Object.keys(deps) };
    }),

  /** Is this approval still the answer? Anything that changed is named in the words a dispatcher would use. */
  routeApprovalCheck: roleProcedure("spatial.routeApprovalCheck")
    .input(z.object({ approvalRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .query(async ({ ctx, input }) => {
      // P4.1: the approval's unit must be in the caller's scope; otherwise the approval does not exist here.
      {
        const dbs = await getDb();
        const ap = dbs ? (await dbs.select({ unitId: routeApprovals.unitId }).from(routeApprovals).where(eq(routeApprovals.approvalRef, input.approvalRef)).limit(1))[0] : undefined;
        if (ap && !(await unitInScope(ap.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Approval ${input.approvalRef} not found` });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const a = (await db.select().from(routeApprovals).where(eq(routeApprovals.approvalRef, input.approvalRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
      if (a.status === "revoked" || a.status === "superseded") return { approvalRef: a.approvalRef, status: a.status, stale: true, changed: [], reasons: [`This approval is ${a.status}`] };
      // The one recheck, shared with the provincial feed runtime (server/routeDependencies.ts).
      const s = await recheckRouteApproval(db, a, input.at);
      return { approvalRef: a.approvalRef, status: s.stale ? "stale" as const : "approved" as const, stale: s.stale, changed: s.changed, reasons: s.stale ? s.reasons : ["Nothing this route depended on has changed"], dispatchStatus: a.dispatchStatus, approvedAt: a.approvedAt };
    }),

  routeRequest: roleProcedure("spatial.routeRequest").input(z.object({ unitId: z.number().int().positive(), originRef: z.string().min(1).max(120), destinationRef: z.string().min(1).max(120), tripId: z.number().int().positive().optional(), jobId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
      // P4.1: the unit, and the job when one is named, must be in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        if (!(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
        if (input.jobId != null && !(await jobInScope(input.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
      }
    const db = await dbOrThrow();
    const status = routingSourceStatus();
    const answer = routeAgainstNetwork({ originRef: input.originRef, destinationRef: input.destinationRef }, status);
    const requestRef = ref("RTQ");
    await db.insert(routeRequests).values({ requestRef, tripId: input.tripId ?? null, jobId: input.jobId ?? null, unitId: input.unitId, originRef: input.originRef, destinationRef: input.destinationRef, sourceStatus: status.status, determination: answer.determination, reason: answer.reason.slice(0, 400), requestedByUserId: ctx.user.id, requestedAt: new Date() });
    return { requestRef, ...answer };
  }),

  routingSourceStatus: roleProcedure("spatial.routingSourceStatus").query(async () => routingSourceStatus()),

  /** The last position a machine reported for a unit — evidence with its age and source, never a claim the unit is working. */
  lastPosition: roleProcedure("spatial.lastPosition").input(z.object({ unitId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      // P4.1: the unit must be in the caller's scope (coreRecordOwnership); otherwise it does not exist here.
      if (!(await unitInScope(input.unitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
    const db = await dbOrThrow();
    const u = (await db.select({ unitNumber: units.unitNumber }).from(units).where(eq(units.id, input.unitId)).limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "Unit not found" });
    const rows = await db.select().from(inboundEvents).where(and(eq(inboundEvents.feed, "gps_position"), eq(inboundEvents.status, "accepted"))).orderBy(desc(inboundEvents.id)).limit(500);
    const mine = rows.map(r => ({ r, p: JSON.parse(r.payloadJson) as { unitRef?: string; latitude?: number; longitude?: number; recordedAt?: string } })).filter(x => x.p.unitRef === u.unitNumber).sort((a, b) => Date.parse(b.p.recordedAt ?? "") - Date.parse(a.p.recordedAt ?? ""))[0];
    if (!mine) return { unitId: input.unitId, position: null, note: "No position evidence on record for this unit" };
    // 0229: a Hub-received event has no machine client; its source is the connector.
    const client = mine.r.clientId == null ? undefined : (await db.select({ name: integrationClients.name }).from(integrationClients).where(eq(integrationClients.id, mine.r.clientId)).limit(1))[0];
    const ageMinutes = Math.round((Date.now() - Date.parse(mine.p.recordedAt!)) / 60_000);
    return { unitId: input.unitId, position: { latitude: mine.p.latitude!, longitude: mine.p.longitude!, recordedAt: mine.p.recordedAt!, ageMinutes, source: client?.name ?? "integration", inboundRef: mine.r.inboundRef }, note: `Evidence from ${client?.name ?? "a feed"}, ${ageMinutes} min old. A position is not a work state.` };
  }),
});
