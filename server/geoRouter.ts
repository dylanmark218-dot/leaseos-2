/**
 * v22.13 — The mapping foundation's procedures.
 *
 * Importing is a controller's act, logged as a run with its endpoint and
 * query. Locating is a read. Verifying a lease location from the imported
 * grid is a second person's act that writes `ats_v41` as the coordinate
 * source — the very value v22.0 defined and could not yet produce.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, between, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { accessRoadSegments, atsLegalSubdivisions, externalDataSources, geoImportRuns, locationIdentities, roadGraphBuilds, roadGraphEdges, roadGraphNodes, siteAccessConfirmations, siteAccessPoints } from "../drizzle/schema";
import { getDb, seedExternalDataSources } from "./db";
import { roleProcedure, router } from "./_core/trpc";
import { ACCESS_ROADS_ENDPOINT, ACCESS_ROADS_LAYER, ATS_LSD_ENDPOINT, ATS_LSD_LAYER, boundingBox, locateAccess, parseLsdFeature, parseRoadFeature, type FeatureCollection, type LngLat } from "./_core/geoImport";
import { lsdIdentity, parseLsd } from "./_core/dls";
import { accessConfidence, corridorSegments, reverseLookup, roadAsSegment, type ImportedRoad, type ParcelShape } from "./_core/legalLand";
import { evaluateRoute, type RoadSegmentInput } from "./_core/routeEvaluation";
import { NOT_ROUTABLE, buildGraph, shortestPath, snapToGraph, type Graph, type GraphSegment } from "./_core/roadGraph";
import type { RequiredCheck } from "./_core/routingCompiler";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

/** The service call. Injectable so tests run against captured fixtures rather than the network. */
export type GeoFetcher = (endpoint: string, params: Record<string, string>) => Promise<FeatureCollection>;
let fetcher: GeoFetcher = async (endpoint, params) => {
  const res = await fetch(`${endpoint}?${new URLSearchParams(params).toString()}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${endpoint} answered ${res.status}`);
  return (await res.json()) as FeatureCollection;
};
export function setGeoFetcher(f: GeoFetcher) { fetcher = f; }

/** A source must be registered, permitted for commercial use and verified before anything is imported from it. */
async function sourceGate(d: Awaited<ReturnType<typeof db>>, sourceKey: string) {
  // v22.13 — the registry's seeds are the licence record every import stands on. Nothing in the application had ever
  // ensured them (only a test did), so an importer ensures them here: seeding is additive and never overwrites a row.
  let s = (await d.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, sourceKey)).limit(1))[0];
  if (!s) { await seedExternalDataSources(); s = (await d.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, sourceKey)).limit(1))[0]; }
  if (!s) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Source ${sourceKey} is not in the registry` });
  if (s.commercialUsePermitted !== "yes") throw new TRPCError({ code: "FORBIDDEN", message: `Source ${sourceKey} is recorded as commercial use ${s.commercialUsePermitted} — a person clears it before it is imported` });
  if (s.status !== "verified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Source ${sourceKey} is ${s.status} in the registry` });
  return s;
}

export const geoRouter = router({
  /** Import ATS legal subdivisions for one township. Alberta serves 1,000 features per page; the run records what came back. */
  atsImportTownship: roleProcedure("geo.atsImportTownship")
    .input(z.object({ meridian: z.number().int().min(1).max(6), rangeNumber: z.number().int().min(1).max(30), township: z.number().int().min(1).max(126), sections: z.array(z.number().int().min(1).max(36)).max(36).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const source = await sourceGate(d, "ats");
      const where = `M=${input.meridian} AND RGE=${input.rangeNumber} AND TWP=${input.township}${input.sections?.length ? ` AND SEC IN (${input.sections.join(",")})` : ""}`;
      const params = { where, outFields: "PID,M,RGE,TWP,SEC,QS,LS,RA,DESCRIPTOR,SHAPE.STArea()", outSR: "4326", resultRecordCount: "1000", f: "geojson" };
      const runRef = ref("GEO");
      await d.insert(geoImportRuns).values({ runRef, sourceKey: "ats", dataset: "ats_lsd", endpoint: ATS_LSD_ENDPOINT, queryJson: JSON.stringify(params), startedByUserId: ctx.user.id });
      const retrievedAt = new Date();
      let collection: FeatureCollection;
      try { collection = await fetcher(ATS_LSD_ENDPOINT, params); }
      catch (e) {
        await d.update(geoImportRuns).set({ outcome: "failed", failureReason: String(e).slice(0, 600), finishedAt: new Date() }).where(eq(geoImportRuns.runRef, runRef));
        throw new TRPCError({ code: "BAD_GATEWAY", message: `Alberta Township System service: ${String(e)}` });
      }
      const features = collection.features ?? [];
      const skipped: string[] = [];
      let written = 0;
      for (const f of features) {
        const parsed = parseLsdFeature(f);
        if (!parsed.ok) { skipped.push(parsed.reason); continue; }
        const r = parsed.row;
        const row = { pid: r.pid, meridian: r.meridian, rangeNumber: r.rangeNumber, township: r.township, sectionNumber: r.sectionNumber, quarterSection: r.quarterSection, legalSubdivision: r.legalSubdivision, roadAllowance: r.roadAllowance, descriptor: r.descriptor, centroidLatitude: r.centroidLatitude, centroidLongitude: r.centroidLongitude, minLatitude: r.minLatitude, minLongitude: r.minLongitude, maxLatitude: r.maxLatitude, maxLongitude: r.maxLongitude, ringJson: JSON.stringify(r.ring), areaSquareMetres: r.areaSquareMetres, sourceKey: "ats", sourceLayer: ATS_LSD_LAYER, importRunRef: runRef, retrievedAt };
        await d.insert(atsLegalSubdivisions).values(row).onDuplicateKeyUpdate({ set: row });
        written += 1;
      }
      const truncated = features.length >= 1000 || collection.properties?.exceededTransferLimit === true;
      await d.update(geoImportRuns).set({ featuresFetched: features.length, rowsWritten: written, rowsSkipped: skipped.length, truncated, outcome: "complete", finishedAt: new Date() }).where(eq(geoImportRuns.runRef, runRef));
      return { runRef, sourceKey: "ats", attribution: source.attributionText, featuresFetched: features.length, rowsWritten: written, rowsSkipped: skipped.length, skippedReasons: skipped.slice(0, 10), truncated, note: truncated ? "The service returned a full page — import by section to take the rest." : null };
    }),

  /** Import access-road lines over a bounding box. The province's authoritative rural road layer. */
  accessRoadsImport: roleProcedure("geo.accessRoadsImport")
    .input(z.object({ minLatitude: z.number().min(-90).max(90), minLongitude: z.number().min(-180).max(180), maxLatitude: z.number().min(-90).max(90), maxLongitude: z.number().min(-180).max(180) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const source = await sourceGate(d, "ats_road_allowance");
      if (input.maxLatitude <= input.minLatitude || input.maxLongitude <= input.minLongitude) throw new TRPCError({ code: "BAD_REQUEST", message: "The box ends before it begins" });
      const geometry = JSON.stringify({ xmin: input.minLongitude, ymin: input.minLatitude, xmax: input.maxLongitude, ymax: input.maxLatitude, spatialReference: { wkid: 4326 } });
      const params = { geometry, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "OBJECTID,FEATURE_TYPE,NAME,HWY_NUMBER,ROAD_CLASS,GEO_SOURCE,GEO_DATE,UPDATE_DATE", outSR: "4326", resultRecordCount: "2000", f: "geojson" };
      const runRef = ref("GEO");
      await d.insert(geoImportRuns).values({ runRef, sourceKey: "ats_road_allowance", dataset: "access_roads", endpoint: ACCESS_ROADS_ENDPOINT, queryJson: JSON.stringify(params), startedByUserId: ctx.user.id });
      const retrievedAt = new Date();
      let collection: FeatureCollection;
      try { collection = await fetcher(ACCESS_ROADS_ENDPOINT, params); }
      catch (e) {
        await d.update(geoImportRuns).set({ outcome: "failed", failureReason: String(e).slice(0, 600), finishedAt: new Date() }).where(eq(geoImportRuns.runRef, runRef));
        throw new TRPCError({ code: "BAD_GATEWAY", message: `Alberta access roads service: ${String(e)}` });
      }
      const features = collection.features ?? [];
      const skipped: string[] = [];
      let written = 0, droppedParts = 0;
      for (const f of features) {
        const parsed = parseRoadFeature(f);
        if (!parsed.ok) { skipped.push(parsed.reason); continue; }
        droppedParts += parsed.droppedParts;
        const r = parsed.row;
        const row = { objectId: r.objectId, name: r.name, highwayNumber: r.highwayNumber, roadClass: r.roadClass, featureType: r.featureType, featureTypeLabel: r.featureTypeLabel, surfaceKind: r.surfaceKind, lanes: r.lanes, lengthMetres: r.lengthMetres, minLatitude: r.minLatitude, minLongitude: r.minLongitude, maxLatitude: r.maxLatitude, maxLongitude: r.maxLongitude, pathJson: JSON.stringify(r.path), geometrySource: r.geometrySource, geometryDate: r.geometryDate, providerUpdatedAt: r.providerUpdatedAt, sourceKey: "ats_road_allowance", sourceLayer: ACCESS_ROADS_LAYER, importRunRef: runRef, retrievedAt };
        await d.insert(accessRoadSegments).values(row).onDuplicateKeyUpdate({ set: row });
        written += 1;
      }
      const truncated = features.length >= 2000 || collection.properties?.exceededTransferLimit === true;
      await d.update(geoImportRuns).set({ featuresFetched: features.length, rowsWritten: written, rowsSkipped: skipped.length, truncated, outcome: "complete", finishedAt: new Date() }).where(eq(geoImportRuns.runRef, runRef));
      return { runRef, sourceKey: "ats_road_allowance", attribution: source.attributionText, featuresFetched: features.length, rowsWritten: written, rowsSkipped: skipped.length, droppedMultipartSegments: droppedParts, truncated, note: truncated ? "The service returned a full page — import a smaller box to take the rest." : null };
    }),

  /** Find an LSD: its polygon, its centroid, and where a truck reaches it. UNKNOWN where the grid is not imported. */
  lsdLocate: roleProcedure("geo.lsdLocate")
    .input(z.object({ lsd: z.string().min(4).max(80), accessSearchMetres: z.number().int().min(100).max(10_000).default(2_000) }))
    .query(async ({ input }) => {
      const parsed = parseLsd(input.lsd);
      if (!parsed.ok) return { outcome: "invalid" as const, reasons: [parsed.reason], parsed: null, location: null };
      const d = await db();
      const p = parsed.value;
      const rows = await d.select().from(atsLegalSubdivisions).where(and(eq(atsLegalSubdivisions.meridian, p.meridian), eq(atsLegalSubdivisions.rangeNumber, p.range), eq(atsLegalSubdivisions.township, p.township), eq(atsLegalSubdivisions.sectionNumber, p.section), eq(atsLegalSubdivisions.legalSubdivision, p.lsd)));
      const land = rows.filter(r => !r.roadAllowance || r.roadAllowance.trim() === "");
      const row = land[0] ?? rows[0];
      if (!row) return { outcome: "not_imported" as const, reasons: [`The ATS grid for meridian ${p.meridian}, range ${p.range}, township ${p.township} is not imported — import it before this parcel can be located (geo.atsImportTownship)`], parsed: p, location: null };
      const pad = 0.03;   // ~3 km either way: enough to find the road serving a quarter-section
      const near = await d.select().from(accessRoadSegments).where(and(lte(accessRoadSegments.minLatitude, row.maxLatitude + pad), gte(accessRoadSegments.maxLatitude, row.minLatitude - pad), lte(accessRoadSegments.minLongitude, row.maxLongitude + pad), gte(accessRoadSegments.maxLongitude, row.minLongitude - pad)));
      const located = locateAccess(
        { pid: row.pid, descriptor: row.descriptor, centroidLatitude: row.centroidLatitude, centroidLongitude: row.centroidLongitude, roadAllowance: row.roadAllowance, ring: JSON.parse(row.ringJson) as LngLat[] },
        near.map(r => ({ objectId: r.objectId, name: r.name, featureTypeLabel: r.featureTypeLabel, surfaceKind: r.surfaceKind, roadClass: r.roadClass, path: JSON.parse(r.pathJson) as LngLat[] })),
        { maxMetres: input.accessSearchMetres },
      );
      return { outcome: "located" as const, parsed: p, reasons: located.reasons, location: { pid: row.pid, descriptor: row.descriptor, centroidLatitude: located.centroid[1], centroidLongitude: located.centroid[0], roadAllowance: row.roadAllowance, sourceKey: row.sourceKey, sourceLayer: row.sourceLayer, retrievedAt: row.retrievedAt, importRunRef: row.importRunRef }, access: located.access, roadsConsidered: located.considered };
    }),

  /** Where am I, in legal land? A GPS fix read back against the imported grid. */
  positionToLsd: roleProcedure("geo.positionToLsd")
    .input(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }))
    .query(async ({ input }) => {
      const d = await db();
      const pad = 0.02;
      const near = await d.select().from(atsLegalSubdivisions).where(and(lte(atsLegalSubdivisions.minLatitude, input.latitude + pad), gte(atsLegalSubdivisions.maxLatitude, input.latitude - pad), lte(atsLegalSubdivisions.minLongitude, input.longitude + pad), gte(atsLegalSubdivisions.maxLongitude, input.longitude - pad)));
      const parcels: ParcelShape[] = near.map(r => ({ pid: r.pid, descriptor: r.descriptor, identity: lsdIdentity({ meridian: r.meridian, range: r.rangeNumber, township: r.township, section: r.sectionNumber, lsd: r.legalSubdivision ?? 0 }), meridian: r.meridian, rangeNumber: r.rangeNumber, township: r.township, sectionNumber: r.sectionNumber, quarterSection: r.quarterSection, legalSubdivision: r.legalSubdivision, roadAllowance: r.roadAllowance, ring: JSON.parse(r.ringJson) as LngLat[], centroid: [r.centroidLongitude, r.centroidLatitude] }));
      const fix = reverseLookup([input.longitude, input.latitude], parcels);
      if (fix.outcome !== "located") return { outcome: fix.outcome, reasons: fix.reasons, parcelsNearby: fix.candidates, position: null };
      const p = fix.parcel;
      return { outcome: "located" as const, reasons: fix.reasons, parcelsNearby: parcels.length, position: { latitude: input.latitude, longitude: input.longitude, pid: p.pid, descriptor: p.descriptor, identity: p.identity, lsd: p.legalSubdivision, section: p.sectionNumber, township: p.township, range: p.rangeNumber, meridian: p.meridian, quarterSection: p.quarterSection, onRoadAllowance: fix.onRoadAllowance, metresFromCentroid: fix.metresFromCentroid } };
    }),

  /** Propose an entrance for a parcel from the grid and the road fabric. It is a proposal until a person confirms it. */
  accessPropose: roleProcedure("geo.accessPropose")
    .input(z.object({ lsd: z.string().min(4).max(80), locationIdentityId: z.number().int().positive().optional(), label: z.string().max(180).optional(), accessKind: z.enum(["lease_entrance", "emergency_access", "alternate_entrance", "staging"]).default("lease_entrance"), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), originDetail: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const parsed = parseLsd(input.lsd);
      if (!parsed.ok) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.reason });
      const p = parsed.value;
      const rows = await d.select().from(atsLegalSubdivisions).where(and(eq(atsLegalSubdivisions.meridian, p.meridian), eq(atsLegalSubdivisions.rangeNumber, p.range), eq(atsLegalSubdivisions.township, p.township), eq(atsLegalSubdivisions.sectionNumber, p.section), eq(atsLegalSubdivisions.legalSubdivision, p.lsd)));
      const row = rows.find(r => !r.roadAllowance || r.roadAllowance.trim() === "") ?? rows[0];
      if (!row) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The ATS grid for ${p.canonical} is not imported` });
      const derived = input.latitude == null || input.longitude == null;
      let latitude = input.latitude ?? 0, longitude = input.longitude ?? 0, approach: { objectId: number; label: string | null; surface: string; metres: number; touches: boolean } | null = null;
      if (derived) {
        const pad = 0.03;
        const near = await d.select().from(accessRoadSegments).where(and(lte(accessRoadSegments.minLatitude, row.maxLatitude + pad), gte(accessRoadSegments.maxLatitude, row.minLatitude - pad), lte(accessRoadSegments.minLongitude, row.maxLongitude + pad), gte(accessRoadSegments.maxLongitude, row.minLongitude - pad)));
        const located = locateAccess({ pid: row.pid, descriptor: row.descriptor, centroidLatitude: row.centroidLatitude, centroidLongitude: row.centroidLongitude, roadAllowance: row.roadAllowance, ring: JSON.parse(row.ringJson) as LngLat[] }, near.map(r => ({ objectId: r.objectId, name: r.name, featureTypeLabel: r.featureTypeLabel, surfaceKind: r.surfaceKind, roadClass: r.roadClass, path: JSON.parse(r.pathJson) as LngLat[] })));
        if (!located.access) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `No truck-suitable access derived for ${p.canonical}: ${located.reasons.join("; ")} — record the entrance from the field instead` });
        latitude = located.access.latitude; longitude = located.access.longitude;
        approach = { objectId: located.access.objectId, label: located.access.featureTypeLabel, surface: located.access.surfaceKind, metres: located.access.metresFromCentroid, touches: located.access.touchesParcel };
      }
      const accessRef = ref("ACC");
      await d.insert(siteAccessPoints).values({ accessRef, locationIdentityId: input.locationIdentityId ?? null, lsdCanonical: p.identity, label: input.label ?? `${p.canonical} ${input.accessKind.replace(/_/g, " ")}`, accessKind: input.accessKind, latitude, longitude, approachRoadObjectId: approach?.objectId ?? null, approachRoadLabel: approach?.label ?? null, approachSurfaceKind: approach?.surface ?? null, metresFromParcelCentroid: approach?.metres ?? null, touchesParcel: approach?.touches ?? false, originKind: derived ? "derived_from_grid" : "office_recorded", originDetail: input.originDetail ?? null, proposedByUserId: ctx.user.id });
      return { accessRef, lsd: p.canonical, identity: p.identity, latitude, longitude, approach, status: "proposed" as const, message: "Proposed. It is not an entrance the system relies on until a person confirms it." };
    }),

  /** Confirm or reject an entrance. A different person from the one who proposed it. */
  accessDecide: roleProcedure("geo.accessDecide")
    .input(z.object({ accessRef: z.string().min(1).max(64), decision: z.enum(["confirmed", "rejected"]), preferred: z.boolean().default(false), gatePresent: z.enum(["yes", "no", "unknown"]).optional(), turnaroundCapability: z.enum(["confirmed", "none", "unknown"]).optional(), reason: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const a = (await d.select().from(siteAccessPoints).where(eq(siteAccessPoints.accessRef, input.accessRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "No such access point" });
      if (a.status !== "proposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Access point is ${a.status}` });
      if (a.proposedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who proposed an entrance does not confirm it — a second person does" });
      if (input.decision === "rejected" && !input.reason) throw new TRPCError({ code: "BAD_REQUEST", message: "A rejection names its reason" });
      if (input.preferred && input.decision === "confirmed") await d.update(siteAccessPoints).set({ preferred: false }).where(and(eq(siteAccessPoints.lsdCanonical, a.lsdCanonical), eq(siteAccessPoints.preferred, true)));
      await d.update(siteAccessPoints).set({ status: input.decision, confirmedByUserId: ctx.user.id, confirmedAt: new Date(), preferred: input.decision === "confirmed" ? input.preferred : false, gatePresent: input.gatePresent ?? a.gatePresent, turnaroundCapability: input.turnaroundCapability ?? a.turnaroundCapability, rejectionReason: input.decision === "rejected" ? input.reason ?? null : null }).where(eq(siteAccessPoints.id, a.id));
      return { accessRef: a.accessRef, status: input.decision, preferred: input.decision === "confirmed" ? input.preferred : false };
    }),

  /** A passage: what reached the entrance, or did not. Evidence, never a verdict. */
  accessConfirmPassage: roleProcedure("geo.accessConfirmPassage")
    .input(z.object({ accessRef: z.string().min(1).max(64), outcome: z.enum(["reached", "could_not_reach", "reached_with_difficulty"]), tripId: z.number().int().positive().optional(), unitId: z.number().int().positive().optional(), operatorId: z.number().int().positive().optional(), configurationFingerprint: z.string().max(120).optional(), detail: z.string().max(400).optional(), observedAt: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const a = (await d.select().from(siteAccessPoints).where(eq(siteAccessPoints.accessRef, input.accessRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "No such access point" });
      await d.insert(siteAccessConfirmations).values({ siteAccessPointId: a.id, tripId: input.tripId ?? null, unitId: input.unitId ?? null, operatorId: input.operatorId ?? null, configurationFingerprint: input.configurationFingerprint ?? null, outcome: input.outcome, detail: input.detail ?? null, observedAt: input.observedAt, recordedByUserId: ctx.user.id });
      const all = await d.select().from(siteAccessConfirmations).where(eq(siteAccessConfirmations.siteAccessPointId, a.id));
      const confidence = accessConfidence({ status: a.status, confirmations: all.map(c => ({ outcome: c.outcome, configurationFingerprint: c.configurationFingerprint, operatorId: c.operatorId, observedAt: c.observedAt })), configurationFingerprint: input.configurationFingerprint ?? null });
      return { accessRef: a.accessRef, confidence };
    }),

  /** Every entrance known for a parcel, with what has actually reached each. */
  accessForLsd: roleProcedure("geo.accessForLsd")
    .input(z.object({ lsd: z.string().min(4).max(80), configurationFingerprint: z.string().max(120).optional() }))
    .query(async ({ input }) => {
      const d = await db();
      const parsed = parseLsd(input.lsd);
      if (!parsed.ok) return { outcome: "invalid" as const, reason: parsed.reason, field: parsed.field ?? null, accessPoints: [] };
      const points = await d.select().from(siteAccessPoints).where(and(eq(siteAccessPoints.lsdCanonical, parsed.value.identity), inArray(siteAccessPoints.status, ["proposed", "confirmed"])));
      const confirmations = points.length ? await d.select().from(siteAccessConfirmations).where(inArray(siteAccessConfirmations.siteAccessPointId, points.map(p => p.id))) : [];
      const rows = points.map(p => {
        const mine = confirmations.filter(c => c.siteAccessPointId === p.id).map(c => ({ outcome: c.outcome, configurationFingerprint: c.configurationFingerprint, operatorId: c.operatorId, observedAt: c.observedAt }));
        return { accessRef: p.accessRef, label: p.label, accessKind: p.accessKind, latitude: p.latitude, longitude: p.longitude, status: p.status, preferred: p.preferred, originKind: p.originKind, approachRoadLabel: p.approachRoadLabel, approachSurfaceKind: p.approachSurfaceKind, metresFromParcelCentroid: p.metresFromParcelCentroid, touchesParcel: p.touchesParcel, gatePresent: p.gatePresent, turnaroundCapability: p.turnaroundCapability, confidence: accessConfidence({ status: p.status, confirmations: mine, configurationFingerprint: input.configurationFingerprint ?? null }) };
      });
      rows.sort((a, b) => (a.preferred === b.preferred ? b.confidence.reached - a.confidence.reached : a.preferred ? -1 : 1));
      return { outcome: "ok" as const, lsd: parsed.value.canonical, identity: parsed.value.identity, accessPoints: rows };
    }),

  /**
   * Evaluate the imported roads in a corridor for one vehicle. The province's
   * layer states a surface and nothing else, so weight, clearance, width and
   * seasonal checks read UNKNOWN — never pass — until a verified restriction
   * says otherwise.
   */
  corridorEvaluate: roleProcedure("geo.corridorEvaluate")
    .input(z.object({
      fromLatitude: z.number().min(-90).max(90), fromLongitude: z.number().min(-180).max(180), toLatitude: z.number().min(-90).max(90), toLongitude: z.number().min(-180).max(180),
      corridorWidthMetres: z.number().int().min(200).max(5_000).default(1_500), maxSegments: z.number().int().min(1).max(120).default(40),
      vehicle: z.object({ grossWeightKg: z.number().int().positive(), maxAxleGroupKg: z.number().int().positive(), heightM: z.number().positive(), widthM: z.number().positive(), lengthM: z.number().positive(), dangerousGoods: z.boolean().default(false), requiresEscort: z.boolean().default(false) }),
      requiredChecks: z.array(z.string().min(2).max(60)).min(1).max(20),
    }))
    .query(async ({ input }) => {
      const d = await db();
      const pad = 0.05;
      const minLat = Math.min(input.fromLatitude, input.toLatitude) - pad, maxLat = Math.max(input.fromLatitude, input.toLatitude) + pad;
      const minLng = Math.min(input.fromLongitude, input.toLongitude) - pad, maxLng = Math.max(input.fromLongitude, input.toLongitude) + pad;
      const near = await d.select().from(accessRoadSegments).where(and(lte(accessRoadSegments.minLatitude, maxLat), gte(accessRoadSegments.maxLatitude, minLat), lte(accessRoadSegments.minLongitude, maxLng), gte(accessRoadSegments.maxLongitude, minLng)));
      if (!near.length) return { outcome: "no_roads_imported" as const, reasons: ["No imported access roads lie in this corridor — import the area before evaluating it"], segments: [], verdict: null };
      const roads: ImportedRoad[] = near.map(r => ({ objectId: r.objectId, name: r.name, highwayNumber: r.highwayNumber, roadClass: r.roadClass, featureTypeLabel: r.featureTypeLabel, surfaceKind: r.surfaceKind, lanes: r.lanes, lengthMetres: r.lengthMetres ?? 0, path: JSON.parse(r.pathJson) as LngLat[], sourceKey: r.sourceKey, sourceLayer: r.sourceLayer, retrievedAt: r.retrievedAt, geometrySource: r.geometrySource }));
      const corridor = corridorSegments([input.fromLongitude, input.fromLatitude], [input.toLongitude, input.toLatitude], roads, input.corridorWidthMetres).slice(0, input.maxSegments);
      if (!corridor.length) return { outcome: "no_roads_in_corridor" as const, reasons: [`${roads.length} imported road(s) are in the area but none within ${input.corridorWidthMetres} m of the corridor`], segments: [], verdict: null };
      const prepared = corridor.map(c => ({ ...roadAsSegment(c.road), metresFromCorridor: c.metresFromCorridor, surfaceKind: c.road.surfaceKind }));
      const segments: RoadSegmentInput[] = prepared.map(p => ({ segmentId: p.segmentId, label: p.label, lengthKm: p.lengthKm, attributes: p.attributes }));
      const verdict = evaluateRoute(input.requiredChecks as RequiredCheck[], segments, input.vehicle);
      return { outcome: "evaluated" as const, reasons: [`${corridor.length} imported segment(s) evaluated; the province's layer states a surface and no limits, so every limit check reads from verified restrictions or UNKNOWN`], segments: prepared.map(p => ({ segmentId: p.segmentId, label: p.label, lengthKm: p.lengthKm, surfaceKind: p.surfaceKind, metresFromCorridor: p.metresFromCorridor, silentChecks: p.silentChecks })), verdict };
    }),

  /** Build a routing graph over an area from the imported road fabric. A recorded artefact: a route can name the graph it was computed on. */
  graphBuild: roleProcedure("geo.graphBuild")
    .input(z.object({ label: z.string().min(2).max(220), minLatitude: z.number().min(-90).max(90), minLongitude: z.number().min(-180).max(180), maxLatitude: z.number().min(-90).max(90), maxLongitude: z.number().min(-180).max(180), snapToleranceMetres: z.number().int().min(1).max(50).default(5) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.maxLatitude <= input.minLatitude || input.maxLongitude <= input.minLongitude) throw new TRPCError({ code: "BAD_REQUEST", message: "The box ends before it begins" });
      const rows = await d.select().from(accessRoadSegments).where(and(lte(accessRoadSegments.minLatitude, input.maxLatitude), gte(accessRoadSegments.maxLatitude, input.minLatitude), lte(accessRoadSegments.minLongitude, input.maxLongitude), gte(accessRoadSegments.maxLongitude, input.minLongitude)));
      if (!rows.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No imported road segments lie in this area — import them before building a graph over it" });
      const segments: GraphSegment[] = rows.map(r => ({ segmentId: `AB-ACCESS-${r.objectId}`, accessRoadObjectId: r.objectId, label: r.name ?? r.featureTypeLabel ?? `Access road ${r.objectId}`, surfaceKind: r.surfaceKind, path: JSON.parse(r.pathJson) as LngLat[] }));
      const graph = buildGraph(segments, { snapToleranceMetres: input.snapToleranceMetres });
      const buildRef = ref("GRAPH");
      const runRefs = Array.from(new Set(rows.map(r => r.importRunRef)));
      await d.insert(roadGraphBuilds).values({ buildRef, label: input.label, minLatitude: input.minLatitude, minLongitude: input.minLongitude, maxLatitude: input.maxLatitude, maxLongitude: input.maxLongitude, snapToleranceMetres: input.snapToleranceMetres, segmentsConsidered: segments.length, nodeCount: graph.nodes.size, edgeCount: graph.edges.length, componentCount: graph.componentCount, largestComponentEdges: graph.largestComponentEdges, isolatedEdges: graph.isolatedEdges, excludedSurfacesJson: JSON.stringify(graph.excludedSurfaces), sourceRunRefsJson: JSON.stringify(runRefs), status: "current", builtByUserId: ctx.user.id });
      for (const n of Array.from(graph.nodes.values())) await d.insert(roadGraphNodes).values({ buildRef, nodeKey: n.nodeKey, latitude: n.latitude, longitude: n.longitude, degree: n.degree, componentId: n.componentId });
      for (const e of graph.edges) await d.insert(roadGraphEdges).values({ buildRef, segmentId: e.segmentId, accessRoadObjectId: e.accessRoadObjectId, label: e.label.slice(0, 220), fromNodeKey: e.fromNodeKey, toNodeKey: e.toNodeKey, lengthMetres: e.lengthMetres, surfaceKind: e.surfaceKind, featureTypeLabel: null, componentId: e.componentId });
      await d.update(roadGraphBuilds).set({ status: "superseded" }).where(and(eq(roadGraphBuilds.status, "current"), eq(roadGraphBuilds.label, input.label), ne(roadGraphBuilds.buildRef, buildRef)));
      return { buildRef, label: input.label, segmentsConsidered: segments.length, routableEdges: graph.edges.length, excludedSurfaces: graph.excludedSurfaces, nodes: graph.nodes.size, components: graph.componentCount, largestComponentEdges: graph.largestComponentEdges, isolatedEdges: graph.isolatedEdges, sourceRuns: runRefs, note: graph.componentCount > 1 ? `The fabric is in ${graph.componentCount} disconnected pieces; a route between two of them cannot be computed from this data.` : null };
    }),

  /**
   * Compute a route over the graph, then evaluate it for the unit.
   *
   * Two questions, answered separately and in order: what roads connect these
   * points, and whether this truck may travel them. A path is never a
   * permission — the verdict is the evaluator's, and every limit the province
   * does not state is UNKNOWN.
   */
  routeCompute: roleProcedure("geo.routeCompute")
    .input(z.object({
      buildRef: z.string().max(64).optional(),
      fromLatitude: z.number().min(-90).max(90), fromLongitude: z.number().min(-180).max(180), toLatitude: z.number().min(-90).max(90), toLongitude: z.number().min(-180).max(180),
      snapLimitMetres: z.number().int().min(100).max(10_000).default(3_000), preferPaved: z.boolean().default(false),
      unitId: z.number().int().positive().optional(),
      vehicle: z.object({ grossWeightKg: z.number().int().positive(), maxAxleGroupKg: z.number().int().positive(), heightM: z.number().positive(), widthM: z.number().positive(), lengthM: z.number().positive(), dangerousGoods: z.boolean().default(false), requiresEscort: z.boolean().default(false) }).optional(),
      requiredChecks: z.array(z.string().min(2).max(60)).max(20).default([]),
      at: z.coerce.date().default(() => new Date()),
    }))
    .query(async ({ input }) => {
      const d = await db();
      const build = input.buildRef
        ? (await d.select().from(roadGraphBuilds).where(eq(roadGraphBuilds.buildRef, input.buildRef)).limit(1))[0]
        : (await d.select().from(roadGraphBuilds).where(and(eq(roadGraphBuilds.status, "current"), lte(roadGraphBuilds.minLatitude, Math.min(input.fromLatitude, input.toLatitude)), gte(roadGraphBuilds.maxLatitude, Math.max(input.fromLatitude, input.toLatitude)), lte(roadGraphBuilds.minLongitude, Math.min(input.fromLongitude, input.toLongitude)), gte(roadGraphBuilds.maxLongitude, Math.max(input.fromLongitude, input.toLongitude)))).orderBy(sql`id desc`).limit(1))[0];   // the newest covering graph, never whichever was inserted first
      if (!build) return { outcome: "no_graph" as const, reasons: ["No routing graph covers both of these positions. P0 stands outside the areas a person has imported and built: a route is not computed on data that is not there."], buildRef: null, path: null, verdict: null };
      const [edgeRows, nodeRows] = await Promise.all([
        d.select().from(roadGraphEdges).where(eq(roadGraphEdges.buildRef, build.buildRef)),
        d.select().from(roadGraphNodes).where(eq(roadGraphNodes.buildRef, build.buildRef)),
      ]);
      const objectIds = edgeRows.map(e => e.accessRoadObjectId);
      const geometry = objectIds.length ? await d.select({ objectId: accessRoadSegments.objectId, pathJson: accessRoadSegments.pathJson, featureTypeLabel: accessRoadSegments.featureTypeLabel }).from(accessRoadSegments).where(inArray(accessRoadSegments.objectId, objectIds)) : [];
      const pathByObject = new Map(geometry.map(g => [g.objectId, JSON.parse(g.pathJson) as LngLat[]]));
      const labelByObject = new Map(geometry.map(g => [g.objectId, g.featureTypeLabel]));
      const graph: Graph = {
        nodes: new Map(nodeRows.map(n => [n.nodeKey, { nodeKey: n.nodeKey, latitude: n.latitude, longitude: n.longitude, degree: n.degree, componentId: n.componentId }])),
        edges: edgeRows.map(e => ({ segmentId: e.segmentId, accessRoadObjectId: e.accessRoadObjectId, label: e.label, fromNodeKey: e.fromNodeKey, toNodeKey: e.toNodeKey, lengthMetres: e.lengthMetres, surfaceKind: e.surfaceKind as GraphSegment["surfaceKind"], featureTypeLabel: labelByObject.get(e.accessRoadObjectId) ?? null, componentId: e.componentId, path: pathByObject.get(e.accessRoadObjectId) ?? [] })),
        adjacency: new Map(), componentCount: build.componentCount, largestComponentEdges: build.largestComponentEdges, isolatedEdges: build.isolatedEdges, excludedSurfaces: JSON.parse(build.excludedSurfacesJson), segmentsConsidered: build.segmentsConsidered,
      };
      for (const e of graph.edges) for (const k of [e.fromNodeKey, e.toNodeKey]) { const list = graph.adjacency.get(k); if (list) list.push(e); else graph.adjacency.set(k, [e]); }
      const origin = snapToGraph([input.fromLongitude, input.fromLatitude], graph, input.snapLimitMetres);
      if (!origin.ok) return { outcome: "origin_unreachable" as const, reasons: [`Origin: ${origin.reason}`], buildRef: build.buildRef, path: null, verdict: null };
      const destination = snapToGraph([input.toLongitude, input.toLatitude], graph, input.snapLimitMetres);
      if (!destination.ok) return { outcome: "destination_unreachable" as const, reasons: [`Destination: ${destination.reason}`], buildRef: build.buildRef, path: null, verdict: null };
      const result = shortestPath(graph, origin.snap.nodeKey, destination.snap.nodeKey, { preferPaved: input.preferPaved });
      if (result.outcome !== "path") return { outcome: result.outcome, reasons: result.reasons, buildRef: build.buildRef, path: null, verdict: null };
      const reasons = [...result.reasons, `Snapped ${origin.snap.metresFromPosition} m to the road at the origin and ${destination.snap.metresFromPosition} m at the destination — the last stretch to the site is not part of the road network`];
      const path = { buildRef: build.buildRef, metres: result.path.metres, kilometres: Math.round(result.path.metres / 100) / 10, surfaces: result.path.surfaces, segments: result.path.edges.map(e => ({ segmentId: e.segmentId, label: e.label, surfaceKind: e.surfaceKind, featureTypeLabel: e.featureTypeLabel ?? null, kilometres: Math.round(e.lengthMetres / 100) / 10 })) };
      if (!input.vehicle || !input.requiredChecks.length) return { outcome: "path_only" as const, reasons: [...reasons, "No vehicle or checks supplied — this is the road connection only, and it is not a permission to drive it"], buildRef: build.buildRef, path, verdict: null };
      const segments: RoadSegmentInput[] = result.path.edges.map(e => { const prepared = roadAsSegment({ objectId: e.accessRoadObjectId, name: e.label, highwayNumber: null, roadClass: null, featureTypeLabel: e.featureTypeLabel ?? null, surfaceKind: e.surfaceKind, lanes: null, lengthMetres: e.lengthMetres, path: e.path, sourceKey: "ats_road_allowance", sourceLayer: "Access and Facility Roads", retrievedAt: build.builtAt, geometrySource: null }); return { segmentId: prepared.segmentId, label: prepared.label, lengthKm: prepared.lengthKm, attributes: prepared.attributes }; });
      const verdict = evaluateRoute(input.requiredChecks as RequiredCheck[], segments, input.vehicle);
      return { outcome: "evaluated" as const, reasons: [...reasons, "The path is the road connection; the verdict is the evaluator's, and every limit the province does not state reads UNKNOWN"], buildRef: build.buildRef, path, verdict };
    }),

  /** Coverage: which townships hold imported grid, and how many roads. A count, never a claim of completeness. */
  coverage: roleProcedure("geo.coverage").query(async () => {
    const d = await db();
    const townships = await d.select({ meridian: atsLegalSubdivisions.meridian, rangeNumber: atsLegalSubdivisions.rangeNumber, township: atsLegalSubdivisions.township, parcels: sql<number>`count(*)` }).from(atsLegalSubdivisions).groupBy(atsLegalSubdivisions.meridian, atsLegalSubdivisions.rangeNumber, atsLegalSubdivisions.township);
    const roads = (await d.select({ n: sql<number>`count(*)` }).from(accessRoadSegments))[0]?.n ?? 0;
    const runs = await d.select().from(geoImportRuns).orderBy(sql`id desc`).limit(10);
    return { townships: townships.map(t => ({ ...t, parcels: Number(t.parcels), label: `TWP ${t.township} RGE ${t.rangeNumber} W${t.meridian}` })), parcels: townships.reduce((a, t) => a + Number(t.parcels), 0), roadSegments: Number(roads), recentRuns: runs.map(r => ({ runRef: r.runRef, dataset: r.dataset, outcome: r.outcome, featuresFetched: r.featuresFetched, rowsWritten: r.rowsWritten, truncated: r.truncated, startedAt: r.startedAt })) };
  }),

  /** Verify a lease location's coordinates from the imported grid: the ATS polygon's centroid, recorded as ats_v41 by a second person. */
  locationVerifyFromGrid: roleProcedure("geo.locationVerifyFromGrid")
    .input(z.object({ locationId: z.number().int().positive(), useAccessPoint: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const loc = (await d.select().from(locationIdentities).where(eq(locationIdentities.id, input.locationId)).limit(1))[0];
      if (!loc) throw new TRPCError({ code: "NOT_FOUND", message: "No such location" });
      if (!loc.surfaceLsd) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The location carries no surface LSD to verify against" });
      const parsed = parseLsd(loc.surfaceLsd);
      if (!parsed.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The location's surface LSD does not parse: ${parsed.reason}` });
      const p = parsed.value;
      const rows = await d.select().from(atsLegalSubdivisions).where(and(eq(atsLegalSubdivisions.meridian, p.meridian), eq(atsLegalSubdivisions.rangeNumber, p.range), eq(atsLegalSubdivisions.township, p.township), eq(atsLegalSubdivisions.sectionNumber, p.section), eq(atsLegalSubdivisions.legalSubdivision, p.lsd)));
      const row = rows.find(r => !r.roadAllowance || r.roadAllowance.trim() === "") ?? rows[0];
      if (!row) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The ATS grid for ${loc.surfaceLsd} is not imported — import the township first` });
      if (loc.coordinateVerifiedByUserId != null && loc.coordinateVerifiedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "A second person verifies a coordinate" });
      let latitude = row.centroidLatitude, longitude = row.centroidLongitude, basis = "ATS v4.1 legal subdivision centroid";
      if (input.useAccessPoint) {
        const pad = 0.03;
        const near = await d.select().from(accessRoadSegments).where(and(lte(accessRoadSegments.minLatitude, row.maxLatitude + pad), gte(accessRoadSegments.maxLatitude, row.minLatitude - pad), lte(accessRoadSegments.minLongitude, row.maxLongitude + pad), gte(accessRoadSegments.maxLongitude, row.minLongitude - pad)));
        const located = locateAccess({ pid: row.pid, descriptor: row.descriptor, centroidLatitude: row.centroidLatitude, centroidLongitude: row.centroidLongitude, roadAllowance: row.roadAllowance, ring: JSON.parse(row.ringJson) as LngLat[] }, near.map(r => ({ objectId: r.objectId, name: r.name, featureTypeLabel: r.featureTypeLabel, surfaceKind: r.surfaceKind, roadClass: r.roadClass, path: JSON.parse(r.pathJson) as LngLat[] })));
        if (!located.access) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `No truck-suitable access point found for ${loc.surfaceLsd}: ${located.reasons.join("; ")}` });
        latitude = located.access.latitude; longitude = located.access.longitude; basis = `Access point on ${located.access.featureTypeLabel ?? located.access.surfaceKind} (${located.access.metresFromCentroid} m from the parcel centroid)`;
      }
      await d.update(locationIdentities).set({ surfaceLatitude: latitude, surfaceLongitude: longitude, coordinateSource: "ats_v41", coordinateConfidence: "high", coordinateVerificationStatus: "verified", coordinateVerifiedByUserId: ctx.user.id }).where(eq(locationIdentities.id, loc.id));
      return { locationId: loc.id, surfaceLsd: loc.surfaceLsd, latitude, longitude, basis, pid: row.pid, sourceKey: row.sourceKey, sourceLayer: row.sourceLayer, retrievedAt: row.retrievedAt, coordinateSource: "ats_v41" as const };
    }),
});
