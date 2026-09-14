/**
 * v22.14 — Legal land both ways, entrances as records, imported roads evaluated.
 * The fixtures are the same real Alberta features captured for v22.13.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { lsdIdentity, parseLsd } from "./_core/dls";
import { accessConfidence, configurationFingerprint, corridorSegments, reverseLookup, roadAsSegment, type ImportedRoad, type ParcelShape } from "./_core/legalLand";
import { parseLsdFeature, parseRoadFeature, type FeatureCollection } from "./_core/geoImport";
import { setGeoFetcher } from "./geoRouter";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const atsFixture = JSON.parse(readFileSync("server/fixtures/geo/ats_54_18_w5_sec24.geojson", "utf8")) as FeatureCollection;
const roadsFixture = JSON.parse(readFileSync("server/fixtures/geo/roads_54_18_w5.geojson", "utf8")) as FeatureCollection;
const parcels: ParcelShape[] = atsFixture.features.map(parseLsdFeature).flatMap(p => (p.ok ? [{ pid: p.row.pid, descriptor: p.row.descriptor, identity: lsdIdentity({ meridian: p.row.meridian, range: p.row.rangeNumber, township: p.row.township, section: p.row.sectionNumber, lsd: p.row.legalSubdivision ?? 0 }), meridian: p.row.meridian, rangeNumber: p.row.rangeNumber, township: p.row.township, sectionNumber: p.row.sectionNumber, quarterSection: p.row.quarterSection, legalSubdivision: p.row.legalSubdivision, roadAllowance: p.row.roadAllowance, ring: p.row.ring, centroid: [p.row.centroidLongitude, p.row.centroidLatitude] as [number, number] }] : []));
const roads: ImportedRoad[] = roadsFixture.features.map(parseRoadFeature).flatMap(p => (p.ok ? [{ objectId: p.row.objectId, name: p.row.name, highwayNumber: p.row.highwayNumber, roadClass: p.row.roadClass, featureTypeLabel: p.row.featureTypeLabel, surfaceKind: p.row.surfaceKind, lanes: p.row.lanes, lengthMetres: p.row.lengthMetres, path: p.row.path, sourceKey: "ats_road_allowance", sourceLayer: "Access and Facility Roads", retrievedAt: new Date("2026-09-10T00:00:00Z"), geometrySource: p.row.geometrySource }] : []));

describe("the parser reads what people write and refuses what cannot exist", () => {
  it("takes every common spelling as one parcel, and names the field that is wrong", () => {
    const forms = ["13-24-54-18-W5", "13/24-54-18-W5", "13-24-054-18W5", "LSD 13 SEC 24 TWP 54 RGE 18 W5M", "13 24 54 18 W5", "13-24-54-18-5", " 13-24-054-18-w5 "];
    const identities = forms.map(f => { const r = parseLsd(f); expect(r.ok, f).toBe(true); return r.ok ? r.value.identity : null; });
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toBe("AB:M5:R18:T54:S24:L13");
    const one = parseLsd("13/24-54-18-W5");
    expect(one.ok && one.value).toMatchObject({ lsd: 13, section: 24, township: 54, range: 18, meridian: 5, canonical: "13-24-054-18-W5" });
    const bad = parseLsd("13-44-54-18-W5");
    expect(bad).toMatchObject({ ok: false, field: "section", reason: "Section 44 is outside 1–36" });
    expect(parseLsd("17-24-54-18-W5")).toMatchObject({ field: "lsd" });
    expect(parseLsd("13-24-54-18-W9")).toMatchObject({ field: "meridian" });
    expect(parseLsd("not an lsd")).toMatchObject({ field: "format" });
  });
});

describe("a GPS fix read back as legal land", () => {
  it("names the parcel it is inside, says when it is on a road allowance, and says when the grid is not imported", () => {
    const land = parcels.find(p => p.legalSubdivision === 1 && !p.roadAllowance)!;
    const fix = reverseLookup(land.centroid, parcels);
    expect(fix.outcome).toBe("located");
    if (fix.outcome !== "located") return;
    expect(fix.parcel.descriptor).toBe(land.descriptor);
    expect(fix.parcel.identity).toBe("AB:M5:R18:T54:S24:L1");
    expect(fix.onRoadAllowance).toBe(false);
    expect(fix.metresFromCentroid).toBeLessThan(5);
    const allowance = parcels.find(p => p.roadAllowance === "RW")!;
    const onRw = reverseLookup(allowance.centroid, parcels.filter(p => p.roadAllowance === "RW"));
    expect(onRw.outcome === "located" && onRw.onRoadAllowance).toBe(true);
    expect(onRw.outcome === "located" && onRw.reasons.some(r => r.includes("road allowance"))).toBe(true);
    const far = reverseLookup([-110, 51], parcels);
    expect(far.outcome).toBe("outside_imported_grid");
    expect(far.outcome === "outside_imported_grid" && far.reasons[0]).toContain("not imported");
    expect(reverseLookup([-110, 51], []).reasons[0]).toBe("No ATS grid is imported near this position");
  });
});

describe("an entrance's confidence is a count of what reached it", () => {
  const at = (d: string) => new Date(`${d}T12:00:00Z`);
  it("rises with passages and operators, never from a single trip, and a failure disputes it", () => {
    const proposed = accessConfidence({ status: "proposed", confirmations: [] });
    expect(proposed).toMatchObject({ level: "proposed", reached: 0 });
    expect(proposed.reasons[0]).toContain("nothing has reached it yet");
    const once = accessConfidence({ status: "proposed", confirmations: [{ outcome: "reached", configurationFingerprint: null, operatorId: 1, observedAt: at("2026-09-01") }] });
    expect(once.level).toBe("reported");                                              // reached, but no person has confirmed it
    const confirmedOnce = accessConfidence({ status: "confirmed", confirmations: [{ outcome: "reached", configurationFingerprint: null, operatorId: 1, observedAt: at("2026-09-01") }] });
    expect(confirmedOnce.level).toBe("probable");                                     // a person confirmed it; one passage is not three
    const many = accessConfidence({ status: "confirmed", confirmations: [
      { outcome: "reached", configurationFingerprint: "TRIDRIVE|3AX|63.5T|4.15H|2.60W|27.5L", operatorId: 1, observedAt: at("2026-09-01") },
      { outcome: "reached", configurationFingerprint: "TRIDRIVE|3AX|63.5T|4.15H|2.60W|27.5L", operatorId: 2, observedAt: at("2026-09-05") },
      { outcome: "reached_with_difficulty", configurationFingerprint: "TANDEM|2AX|41.0T|4.15H|2.60W|20.0L", operatorId: 3, observedAt: at("2026-09-08") },
      { outcome: "reached", configurationFingerprint: null, operatorId: 2, observedAt: at("2026-09-09") },
    ], configurationFingerprint: "TRIDRIVE|3AX|63.5T|4.15H|2.60W|27.5L" });
    expect(many).toMatchObject({ level: "confirmed", reached: 3, difficult: 1, distinctOperators: 3, matchingConfiguration: "exact" });
    expect(many.lastReachedAt).toEqual(at("2026-09-09"));
    const other = accessConfidence({ status: "confirmed", confirmations: many.reached ? [{ outcome: "reached", configurationFingerprint: "TANDEM|2AX|41.0T|4.15H|2.60W|20.0L", operatorId: 1, observedAt: at("2026-09-01") }] : [], configurationFingerprint: "TRIDRIVE|3AX|63.5T|4.15H|2.60W|27.5L" });
    expect(other.matchingConfiguration).toBe("similar");
    expect(other.reasons.some(r => r.includes("a different truck's passage does not prove this one's"))).toBe(true);
    const disputed = accessConfidence({ status: "confirmed", confirmations: [
      { outcome: "reached", configurationFingerprint: null, operatorId: 1, observedAt: at("2026-09-01") },
      { outcome: "could_not_reach", configurationFingerprint: null, operatorId: 2, observedAt: at("2026-09-06") },
    ] });
    expect(disputed.level).toBe("disputed");
    expect(disputed.reasons[0]).toContain("a person settles this");
    expect(configurationFingerprint({ grossWeightKg: 63_500, heightM: 4.15, widthM: 2.6, lengthM: 27.5, axleGroups: 3, trailerKind: "super-b" })).toBe("SUPERB|3AX|63.5T|4.15H|2.60W|27.5L");
  });
});

describe("an imported road as evaluator input", () => {
  it("states the surface Alberta states, and stays silent — UNKNOWN, never pass — on every limit it does not state", () => {
    const gravel = roads.find(r => r.surfaceKind === "gravel")!;
    const seg = roadAsSegment(gravel);
    expect(seg.segmentId).toBe(`AB-ACCESS-${gravel.objectId}`);
    expect(seg.lengthKm).toBeGreaterThan(0);
    expect(seg.attributes).toHaveLength(1);
    expect(seg.attributes[0]).toMatchObject({ check: "surface_condition", textValue: "gravel", confidence: "authority_confirmed", jurisdiction: "CA-AB" });
    expect(seg.silentChecks).toEqual(expect.arrayContaining(["road_weight_restriction", "bridge_clearance", "width_restriction", "seasonal_closure"]));
    expect(seg.attributes.map(a => a.check)).not.toContain("road_weight_restriction");   // the map's silence is not a permission
    const ferry = roadAsSegment({ ...gravel, surfaceKind: "ferry" });
    expect(ferry.attributes[0].textValue).toBe("ferry_crossing");
  });
  it("finds the roads a corridor touches, nearest first, and none beyond its width", () => {
    const from: [number, number] = [-116.60, 53.65], to: [number, number] = [-116.52, 53.70];
    const wide = corridorSegments(from, to, roads, 1_500);
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.length).toBeLessThan(roads.length);
    expect(wide.every(c => c.metresFromCorridor <= 1_500)).toBe(true);
    expect(wide[0]!.metresFromCorridor).toBeLessThanOrEqual(wide.at(-1)!.metresFromCorridor);
    expect(corridorSegments(from, to, roads, 300).length).toBeLessThan(wide.length);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 5_700_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("legal land, entrances and corridors over imported data", () => {
  it("locates a position, proposes and confirms an entrance, counts passages, and evaluates a corridor with limits UNKNOWN", async () => {
    const controller = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    setGeoFetcher(async endpoint => (endpoint.includes("alberta_township_system") ? atsFixture : roadsFixture));
    await callerFor(controller).geo.atsImportTownship({ meridian: 5, rangeNumber: 18, township: 54, sections: [24] });
    await callerFor(controller).geo.accessRoadsImport({ minLatitude: 53.62, minLongitude: -116.66, maxLatitude: 53.72, maxLongitude: -116.5 });
    const land = parcels.find(p => p.legalSubdivision === 1 && !p.roadAllowance)!;
    const where = await callerFor(driver).geo.positionToLsd({ latitude: land.centroid[1], longitude: land.centroid[0] });
    expect(where.outcome).toBe("located");
    expect(where.position).toMatchObject({ identity: "AB:M5:R18:T54:S24:L1", lsd: 1, section: 24, township: 54, range: 18, meridian: 5, onRoadAllowance: false });
    const nowhere = await callerFor(driver).geo.positionToLsd({ latitude: 51.0, longitude: -110.0 });
    expect(nowhere.outcome).toBe("outside_imported_grid");
    // an entrance derived from the grid and the road fabric, then confirmed by a second person
    const proposed = await callerFor(dispatcher).geo.accessPropose({ lsd: "01-24-054-18-W5", label: "North gate" });
    expect(proposed).toMatchObject({ status: "proposed", identity: "AB:M5:R18:T54:S24:L1" });
    expect(proposed.approach).not.toBeNull();
    expect(proposed.message).toContain("until a person confirms it");
    await expect(callerFor(dispatcher).geo.accessDecide({ accessRef: proposed.accessRef, decision: "confirmed" })).rejects.toThrow(/a second person does/);
    const decided = await callerFor(controller).geo.accessDecide({ accessRef: proposed.accessRef, decision: "confirmed", preferred: true, gatePresent: "yes", turnaroundCapability: "confirmed" });
    expect(decided).toMatchObject({ status: "confirmed", preferred: true });
    const listed = await callerFor(driver).geo.accessForLsd({ lsd: "13/24-54-18-W5" });          // a different spelling resolves to a different parcel — LSD 13, not LSD 1
    expect(listed.outcome).toBe("ok");
    expect(listed.identity).toBe("AB:M5:R18:T54:S24:L13");
    expect(listed.accessPoints.some(a => a.accessRef === proposed.accessRef)).toBe(false);
    const forParcel = await callerFor(driver).geo.accessForLsd({ lsd: "LSD 1 SEC 24 TWP 54 RGE 18 W5M", configurationFingerprint: "SUPERB|3AX|63.5T|4.15H|2.60W|27.5L" });
    const mine = forParcel.accessPoints.find(a => a.accessRef === proposed.accessRef)!;          // the table accumulates real entrances; assert on the one this run made
    expect(mine).toMatchObject({ preferred: true, gatePresent: "yes", status: "confirmed" });
    expect(mine.confidence.level).toBe("probable");                                              // confirmed by a person, nothing has driven it
    expect(forParcel.accessPoints[0].accessRef).toBe(proposed.accessRef);                        // preferred sorts first
    const fp = "SUPERB|3AX|63.5T|4.15H|2.60W|27.5L";
    for (const [operatorId, day] of [[7, "2026-09-01"], [8, "2026-09-04"], [7, "2026-09-08"]] as const) {
      await callerFor(driver).geo.accessConfirmPassage({ accessRef: proposed.accessRef, outcome: "reached", operatorId, configurationFingerprint: fp, observedAt: new Date(`${day}T12:00:00Z`) });
    }
    const after = await callerFor(driver).geo.accessForLsd({ lsd: "01-24-054-18-W5", configurationFingerprint: fp });
    expect(after.accessPoints.find(a => a.accessRef === proposed.accessRef)!.confidence).toMatchObject({ level: "confirmed", reached: 3, distinctOperators: 2, matchingConfiguration: "exact" });
    const otherRig = await callerFor(driver).geo.accessForLsd({ lsd: "01-24-054-18-W5", configurationFingerprint: "TRIDRIVE|4AX|63.5T|4.60H|3.20W|31.0L" });
    expect(otherRig.accessPoints.find(a => a.accessRef === proposed.accessRef)!.confidence.matchingConfiguration).toBe("similar");
    // the corridor: real roads, surface stated, every limit unknown
    const corridor = await callerFor(dispatcher).geo.corridorEvaluate({
      fromLatitude: 53.65, fromLongitude: -116.60, toLatitude: 53.70, toLongitude: -116.52,
      vehicle: { grossWeightKg: 63_500, maxAxleGroupKg: 24_000, heightM: 4.15, widthM: 2.6, lengthM: 27.5, dangerousGoods: false, requiresEscort: false },
      requiredChecks: ["road_weight_restriction", "bridge_clearance", "surface_condition"],
    });
    expect(corridor.outcome).toBe("evaluated");
    expect(corridor.segments.length).toBeGreaterThan(0);
    expect(corridor.verdict).not.toBeNull();
    expect(corridor.verdict!.unknownCount).toBeGreaterThan(0);
    expect(corridor.verdict!.dispatchStatus).not.toBe("clear_to_dispatch");                      // unknown never renders as clear
    expect(corridor.reasons[0]).toContain("every limit check reads from verified restrictions or UNKNOWN");
    const empty = await callerFor(dispatcher).geo.corridorEvaluate({
      fromLatitude: 51.0, fromLongitude: -110.0, toLatitude: 51.1, toLongitude: -110.1,
      vehicle: { grossWeightKg: 63_500, maxAxleGroupKg: 24_000, heightM: 4.15, widthM: 2.6, lengthM: 27.5, dangerousGoods: false, requiresEscort: false },
      requiredChecks: ["road_weight_restriction"],
    });
    expect(empty.outcome).toBe("no_roads_imported");
    expect(empty.verdict).toBeNull();
  });
});
