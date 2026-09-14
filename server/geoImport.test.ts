/**
 * v22.13 — The mapping foundation.
 *
 * The fixtures are real: one section of ATS legal subdivisions and the road
 * segments intersecting township 54, range 18, west of the 5th meridian,
 * captured from Alberta's own services on 2026-09-10.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { ACCESS_SURFACE_PREFERENCE, ROAD_FEATURE_TYPES, boundingBox, distanceToPathMetres, haversineMetres, locateAccess, parseLsdFeature, parseRoadFeature, pathLengthMetres, pointInRing, ringCentroid, type FeatureCollection, type LngLat } from "./_core/geoImport";
import { setGeoFetcher } from "./geoRouter";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const ats = JSON.parse(readFileSync("server/fixtures/geo/ats_54_18_w5_sec24.geojson", "utf8")) as FeatureCollection;
const roads = JSON.parse(readFileSync("server/fixtures/geo/roads_54_18_w5.geojson", "utf8")) as FeatureCollection;

describe("the geometry a parcel and a road imply", () => {
  it("computes a centroid inside the ring, a bounding box around it, and metres between points", () => {
    const square: LngLat[] = [[-114, 53], [-114, 53.01], [-113.98, 53.01], [-113.98, 53], [-114, 53]];
    const [lng, lat] = ringCentroid(square);
    expect(lng).toBeCloseTo(-113.99, 6);
    expect(lat).toBeCloseTo(53.005, 6);
    expect(pointInRing([lng, lat], square)).toBe(true);
    expect(pointInRing([-114.5, 53.005], square)).toBe(false);
    expect(boundingBox(square)).toEqual({ minLatitude: 53, minLongitude: -114, maxLatitude: 53.01, maxLongitude: -113.98 });
    expect(Math.round(haversineMetres([-114, 53], [-114, 53.01]))).toBe(1112);              // 0.01° of latitude
    expect(Math.round(pathLengthMetres([[-114, 53], [-114, 53.01], [-113.98, 53.01]]))).toBe(2450);
    const d = distanceToPathMetres([-113.99, 53.02], [[-114, 53.01], [-113.98, 53.01]]);
    expect(Math.round(d.metres)).toBe(1112);
    expect(d.closest[1]).toBeCloseTo(53.01, 6);                                              // the closest point sits on the segment
  });
});

describe("real Alberta features become rows, or are refused by name", () => {
  it("parses an ATS legal subdivision, keeps its grid, and marks a road allowance", () => {
    const parsed = ats.features.map(parseLsdFeature);
    expect(parsed.every(p => p.ok)).toBe(true);
    const rows = parsed.flatMap(p => (p.ok ? [p.row] : []));
    expect(rows).toHaveLength(20);                                                           // 16 LSDs + 4 road-allowance parcels in this section
    const one = rows.find(r => r.legalSubdivision === 1 && !r.roadAllowance)!;
    expect(one).toMatchObject({ meridian: 5, rangeNumber: 18, township: 54, sectionNumber: 24 });
    expect(one.descriptor).toBe("LSD-01 SEC-24 TWP-054 RGE-18 MER-5");
    expect(one.centroidLatitude).toBeGreaterThan(53.6);
    expect(one.centroidLatitude).toBeLessThan(53.72);
    expect(one.centroidLongitude).toBeGreaterThan(-116.66);
    expect(one.centroidLongitude).toBeLessThan(-116.5);
    expect(pointInRing([one.centroidLongitude, one.centroidLatitude], one.ring)).toBe(true);
    expect(rows.filter(r => r.roadAllowance === "RW").length).toBeGreaterThan(0);
    expect(parseLsdFeature({ type: "Feature", properties: {}, geometry: null })).toEqual({ ok: false, reason: "feature carries no PID" });
    expect(parseLsdFeature({ type: "Feature", properties: { PID: "x", M: 5, RGE: 18, TWP: 54, SEC: 24 }, geometry: { type: "Point", coordinates: [0, 0] } })).toEqual({ ok: false, reason: "PID x: geometry is Point, not Polygon" });
    expect(parseLsdFeature({ type: "Feature", properties: { PID: "y", M: 5 }, geometry: null })).toEqual({ ok: false, reason: "PID y: incomplete grid (M/RGE/TWP/SEC)" });
  });
  it("parses access roads with Alberta's own feature-type labels and surfaces", () => {
    const parsed = roads.features.map(parseRoadFeature);
    expect(parsed.every(p => p.ok)).toBe(true);
    const rows = parsed.flatMap(p => (p.ok ? [p.row] : []));
    expect(rows).toHaveLength(293);
    const kinds = new Map<string, number>();
    for (const r of rows) kinds.set(r.surfaceKind, (kinds.get(r.surfaceKind) ?? 0) + 1);
    expect(kinds.get("gravel")).toBe(204);                                                   // one- and two-lane gravel: the rural network
    expect(kinds.get("driveway")).toBe(46);
    expect(kinds.get("dry_weather")).toBe(36);
    expect(rows.find(r => r.featureType === 4)!.featureTypeLabel).toBe("One Lane Gravel Road");
    expect(rows.every(r => r.lengthMetres > 0 && r.path.length >= 2)).toBe(true);
    expect(rows.some(r => r.geometrySource != null)).toBe(true);
    expect(ROAD_FEATURE_TYPES[6]).toMatchObject({ label: "Divided Paved Road", surface: "paved", lanes: 4 });
    const unknownType = parseRoadFeature({ type: "Feature", properties: { OBJECTID: 1, FEATURE_TYPE: 99 }, geometry: { type: "LineString", coordinates: [[-114, 53], [-114, 53.001]] } });
    expect(unknownType.ok && unknownType.row).toMatchObject({ surfaceKind: "unknown", featureTypeLabel: "Feature type 99 (not in the published legend)" });
    expect(parseRoadFeature({ type: "Feature", properties: { OBJECTID: 2 }, geometry: { type: "Polygon", coordinates: [] } })).toEqual({ ok: false, reason: "OBJECTID 2: geometry is Polygon, not a line" });
  });
  it("locates the access point on the nearest truck-suitable road, and never on a driveway or a ferry", () => {
    const lsd = parseLsdFeature(ats.features.find(f => f.properties.LS === 1 && String(f.properties.RA).trim() === "")!);
    expect(lsd.ok).toBe(true); if (!lsd.ok) return;
    const roadRows = roads.features.map(parseRoadFeature).flatMap(p => (p.ok ? [p.row] : [])).map(r => ({ objectId: r.objectId, name: r.name, featureTypeLabel: r.featureTypeLabel, surfaceKind: r.surfaceKind, roadClass: r.roadClass, path: r.path }));
    const located = locateAccess({ pid: lsd.row.pid, descriptor: lsd.row.descriptor, centroidLatitude: lsd.row.centroidLatitude, centroidLongitude: lsd.row.centroidLongitude, roadAllowance: lsd.row.roadAllowance, ring: lsd.row.ring }, roadRows);
    expect(located.access).not.toBeNull();
    expect(ACCESS_SURFACE_PREFERENCE).toContain(located.access!.surfaceKind);
    expect(located.access!.metresFromCentroid).toBeLessThanOrEqual(2_000);
    expect(located.centroid[1]).toBe(lsd.row.centroidLatitude);                              // the centroid is the land
    expect(located.access!.latitude).not.toBe(lsd.row.centroidLatitude);                     // the access point is the road
    const onlyDriveways = locateAccess({ pid: "x", descriptor: "d", centroidLatitude: 53.65, centroidLongitude: -116.6, roadAllowance: null, ring: lsd.row.ring }, roadRows.filter(r => r.surfaceKind === "driveway"));
    expect(onlyDriveways.access).toBeNull();
    expect(onlyDriveways.reasons[0]).toContain("none truck-suitable");
    const none = locateAccess({ pid: "x", descriptor: "d", centroidLatitude: 53.65, centroidLongitude: -116.6, roadAllowance: null, ring: lsd.row.ring }, []);
    expect(none.reasons).toContain("No access point determined — the centroid is the land, not a destination a truck can reach");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 5_500_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("importing the grid and the roads, then locating a lease", () => {
  it("imports from the registered sources, logs the run, locates the LSD, and verifies a location as ats_v41", async () => {
    const controller = await withRole("controller");
    const management = await withRole("management");
    const dispatcher = await withRole("dispatcher");
    setGeoFetcher(async (endpoint, params) => {
      if (endpoint.includes("alberta_township_system")) { expect(params.where).toContain("M=5 AND RGE=18 AND TWP=54"); return ats; }
      expect(params.geometryType).toBe("esriGeometryEnvelope");
      return roads;
    });
    const geo = callerFor(controller).geo;
    const gridRun = await geo.atsImportTownship({ meridian: 5, rangeNumber: 18, township: 54, sections: [24] });
    expect(gridRun).toMatchObject({ sourceKey: "ats", featuresFetched: 20, rowsWritten: 20, rowsSkipped: 0, truncated: false });
    expect(gridRun.attribution).toBeTruthy();
    const again = await geo.atsImportTownship({ meridian: 5, rangeNumber: 18, township: 54, sections: [24] });
    expect(again.rowsWritten).toBe(20);                                                      // idempotent: the PID is the key
    const roadRun = await geo.accessRoadsImport({ minLatitude: 53.62, minLongitude: -116.66, maxLatitude: 53.72, maxLongitude: -116.5 });
    expect(roadRun).toMatchObject({ sourceKey: "ats_road_allowance", featuresFetched: 293, rowsWritten: 293, rowsSkipped: 0 });
    const [parcels] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM atsLegalSubdivisions WHERE meridian = 5 AND rangeNumber = 18 AND township = 54");
    expect(Number(parcels[0].n)).toBe(20);
    const [runs] = await pool.execute<mysql.RowDataPacket[]>("SELECT runRef, dataset, outcome, featuresFetched, rowsWritten, endpoint FROM geoImportRuns WHERE runRef IN (?, ?, ?) ORDER BY id", [gridRun.runRef, again.runRef, roadRun.runRef]);
    expect(runs).toHaveLength(3);                                                               // the log accumulates across runs; these are this run's
    expect(runs.map(r => r.outcome)).toEqual(["complete", "complete", "complete"]);
    expect(runs[0].endpoint).toContain("geospatial.alberta.ca");
    const located = await callerFor(dispatcher).geo.lsdLocate({ lsd: "01-24-054-18-W5" });
    expect(located.outcome).toBe("located");
    expect(located.location).toMatchObject({ descriptor: "LSD-01 SEC-24 TWP-054 RGE-18 MER-5", sourceKey: "ats", sourceLayer: "ATS Legal Subdivision with Road Allowance Outline" });
    expect(located.access).not.toBeNull();
    expect(located.roadsConsidered).toBeGreaterThan(0);
    const missing = await callerFor(dispatcher).geo.lsdLocate({ lsd: "04-11-082-04-W6" });
    expect(missing.outcome).toBe("not_imported");
    expect(missing.reasons[0]).toContain("is not imported");
    const invalid = await callerFor(dispatcher).geo.lsdLocate({ lsd: "99-99-999-99-W9" });
    expect(invalid.outcome).toBe("invalid");
    const coverage = await callerFor(dispatcher).geo.coverage();
    expect(coverage.townships.some(t => t.label === "TWP 54 RGE 18 W5")).toBe(true);
    expect(coverage.roadSegments).toBeGreaterThanOrEqual(293);
    // a lease location's coordinates verified from the imported grid — the ats_v41 source v22.0 defined and could not produce
    const [loc] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO locationIdentities (name, surfaceLsd, lsdValid, coordinateSource, coordinateConfidence, coordinateVerificationStatus) VALUES ('Test lease', '01-24-054-18-W5', 1, 'theoretical_grid', 'low', 'unverified')");
    const verified = await callerFor(management).geo.locationVerifyFromGrid({ locationId: Number(loc.insertId) });
    expect(verified).toMatchObject({ coordinateSource: "ats_v41", basis: "ATS v4.1 legal subdivision centroid", sourceKey: "ats" });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT coordinateSource, coordinateConfidence, coordinateVerificationStatus, surfaceLatitude FROM locationIdentities WHERE id = ?", [loc.insertId]);
    expect(row[0]).toMatchObject({ coordinateSource: "ats_v41", coordinateConfidence: "high", coordinateVerificationStatus: "verified" });
    expect(Number(row[0].surfaceLatitude)).toBeCloseTo(verified.latitude, 9);
    await expect(callerFor(management).geo.locationVerifyFromGrid({ locationId: Number(loc.insertId) })).rejects.toThrow(/A second person verifies a coordinate/);
    const atAccess = await callerFor(controller).geo.locationVerifyFromGrid({ locationId: Number(loc.insertId), useAccessPoint: true });
    expect(atAccess.basis).toContain("Access point on");
    await expect(callerFor(dispatcher).geo.atsImportTownship({ meridian: 5, rangeNumber: 18, township: 54 })).rejects.toThrow(/geo.import/);   // importing is not a dispatcher's act
  });

  it("refuses to import from a source that is not registered, cleared for commercial use and verified", async () => {
    const controller = await withRole("controller");
    await pool.execute("UPDATE externalDataSources SET status = 'unverified' WHERE sourceKey = 'ats'");
    await expect(callerFor(controller).geo.atsImportTownship({ meridian: 5, rangeNumber: 18, township: 54 })).rejects.toThrow(/is unverified in the registry/);
    await pool.execute("UPDATE externalDataSources SET status = 'verified', commercialUsePermitted = 'unknown' WHERE sourceKey = 'ats'");
    await expect(callerFor(controller).geo.atsImportTownship({ meridian: 5, rangeNumber: 18, township: 54 })).rejects.toThrow(/commercial use unknown/);
    await pool.execute("UPDATE externalDataSources SET commercialUsePermitted = 'yes' WHERE sourceKey = 'ats'");
  });
});
