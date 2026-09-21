import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync, readdirSync } from "node:fs";
import { lsdRowCol, parseLsd, parseUwi, sectionRowCol, theoreticalCentroid } from "./_core/dls";
import { routeAgainstNetwork, routingSourceStatus } from "./_core/routingSource";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

describe("the survey identifiers are validated, and the grid position labels itself", () => {
  it("parses the common spellings to one canonical form and refuses what is outside the system", () => {
    for (const s of ["10-22-045-06-W5", "10-22-45-6 W5M", " 10 - 22 - 045 - 06 W5 "]) { const p = parseLsd(s); expect(p.ok && p.value.canonical).toBe("10-22-045-06-W5"); }
    expect(parseLsd("17-22-045-06-W5")).toMatchObject({ ok: false, reason: "LSD 17 is outside 1–16" });
    expect(parseLsd("10-37-045-06-W5")).toMatchObject({ ok: false, reason: "Section 37 is outside 1–36" });
    expect(parseLsd("10-22-045-06-W7")).toMatchObject({ ok: false, reason: "Meridian W7 is not W1–W6" });
    expect(parseLsd("Nisku yard")).toMatchObject({ ok: false });
    const u = parseUwi("100/10-22-045-06W5/00");
    expect(u.ok && u.value).toMatchObject({ locationException: "100", eventSequence: "00", canonical: "100/10-22-045-06W5/00" });
    expect(parseUwi("100/10-22-045-06W5")).toMatchObject({ ok: false });
  });
  it("numbers sections and LSDs boustrophedon from the southeast corner", () => {
    expect([1, 6, 7, 12, 13, 36].map(sectionRowCol)).toEqual([{ row: 0, col: 0 }, { row: 0, col: 5 }, { row: 1, col: 5 }, { row: 1, col: 0 }, { row: 2, col: 0 }, { row: 5, col: 0 }]);
    expect([1, 4, 5, 8, 16].map(lsdRowCol)).toEqual([{ row: 0, col: 0 }, { row: 0, col: 3 }, { row: 1, col: 3 }, { row: 1, col: 0 }, { row: 3, col: 0 }]);
  });
  it("computes a theoretical position that says what it is, and moves the right way", () => {
    const a = theoreticalCentroid(parseLsd("10-22-045-06-W5").ok ? (parseLsd("10-22-045-06-W5") as { ok: true; value: never }).value : (null as never));
    expect(a).toMatchObject({ source: "theoretical_grid", confidence: "low" });
    expect(a.caveat).toContain("Not for navigation");
    expect(a.latitude).toBeGreaterThan(52.5); expect(a.latitude).toBeLessThan(53.3);       // township 45 north of the 49th parallel
    expect(a.longitude).toBeGreaterThan(-115.2); expect(a.longitude).toBeLessThan(-114.3);  // range 6 west of the 5th meridian
    const north = theoreticalCentroid((parseLsd("10-22-046-06-W5") as { ok: true; value: never }).value);
    const west = theoreticalCentroid((parseLsd("10-22-045-07-W5") as { ok: true; value: never }).value);
    expect(north.latitude).toBeGreaterThan(a.latitude); expect(Math.abs(north.latitude - a.latitude - 0.087)).toBeLessThan(0.002); // one township ≈ 6 miles
    expect(west.longitude).toBeLessThan(a.longitude);
    expect(theoreticalCentroid((parseLsd("01-01-001-01-W4") as { ok: true; value: never }).value).latitude).toBeCloseTo(49.0018, 3); // the first LSD sits just north of the border
  });
});

describe("the routing source is not loaded, and a named provider is not a loaded one", () => {
  it("answers UNKNOWN with the reason, whether nothing or a provider name is in the environment", () => {
    expect(routingSourceStatus({})).toMatchObject({ status: "not_loaded", provider: null });
    expect(routingSourceStatus({ LEASEOS_ROUTING_PROVIDER: "here" })).toMatchObject({ status: "configured_not_implemented", provider: "here" });
    const a = routeAgainstNetwork({ originRef: "Nisku yard", destinationRef: "10-22-045-06-W5" }, routingSourceStatus({}));
    expect(a).toMatchObject({ determination: "unknown", sourceStatus: "not_loaded" });
    expect(a.reason).toContain("nothing was computed");
  });
  it("keeps Google Maps Platform out of the server tree, so Places cannot be combined with HERE or Mapbox", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [`${dir}/${e.name}`] : []);
    const offenders = walk("server").filter(f => /maps\.googleapis\.com|googleapis\.com\/maps|places\.googleapis/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who verifies a coordinate, a profile, a restriction", () => {
  it("keeps coordinate and restriction verification with safety and management, profile verification with the shop lead", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "spatial.location.verify" }).allowed).sort()).toEqual(["management", "safety"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "spatial.vehicle.verify" }).allowed)).toEqual(["shop_lead"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "spatial.restriction.verify" }).allowed).sort()).toEqual(["management", "safety"]);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "spatial.read" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "spatial.route.evaluate" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_700_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const machine = (k: string) => appRouter.createCaller({ req: { headers: { "x-integration-key": k } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a lease, a truck, a bridge, and the four axes", () => {
  it("registers the lease on the theoretical grid and verifies it from ATS, verifies the profile by a second person, evaluates named segments with evidence a person can read, leaves unverified data unknown, refuses a route against the network, and reads the last position as evidence", async () => {
    const office = await withRole("office");
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const lead = await withRole("shop_lead");
    const dispatcher = await withRole("dispatcher");
    const controller = await withRole("controller");

    // The lease: registered with a valid LSD and UWI on the theoretical grid, low confidence, not navigable; verified from ATS with a dataset version → high, navigable, the theoretical position named as replaced.
    await expect(callerFor(office).spatial.locationRegister({ name: "Bad LSD", surfaceLsd: "10-22-045-06-W9" })).rejects.toThrow(/Meridian W9/);
    const loc = await callerFor(office).spatial.locationRegister({ name: "ABC 10-22 pad", surfaceLsd: "10-22-45-6 W5M", uwi: "100/10-22-045-06W5/00", operator: "ABC Energy", lease: "ABC-0451" });
    expect(loc).toMatchObject({ surfaceLsd: "10-22-045-06-W5", uwi: "100/10-22-045-06W5/00", coordinate: { source: "theoretical_grid", confidence: "low", verificationStatus: "unverified" } });
    expect(loc.caveat).toContain("Not for navigation");
    expect((await callerFor(dispatcher).spatial.locationGet({ locationId: loc.locationId })).navigable).toBe(false);
    await expect(callerFor(safety).spatial.locationVerify({ locationId: loc.locationId, latitude: 52.8791, longitude: -114.7801, source: "ats_v41", evidenceRecordId: 1 })).rejects.toThrow(/names its dataset version/);
    await expect(callerFor(office).spatial.locationVerify({ locationId: loc.locationId, latitude: 52.8791, longitude: -114.7801, source: "ats_v41", evidenceRecordId: 1, datasetVersion: "ATS v4.1 2026-06" })).rejects.toBeTruthy();
    const ver = await callerFor(safety).spatial.locationVerify({ locationId: loc.locationId, latitude: 52.8791, longitude: -114.7801, source: "ats_v41", evidenceRecordId: 1, datasetVersion: "ATS v4.1 2026-06" });
    expect(ver.coordinate).toMatchObject({ source: "ats_v41", confidence: "high", verificationStatus: "verified" });
    expect(ver.replaced?.source).toBe("theoretical_grid");
    expect((await callerFor(dispatcher).spatial.locationGet({ locationId: loc.locationId })).navigable).toBe(true);

    // The truck: a profile from the shop's measurement, verified by the shop lead and not by the mechanic who recorded it; an operator-stated profile cannot be verified.
    const unitNo = key("U").slice(0, 20);
    const SEG_ROAD = key("SEG-TR452").slice(0, 40), SEG_BRIDGE = key("SEG-CW").slice(0, 40);
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [unitNo]);
    const unitId = Number(un.insertId);
    const prof = await callerFor(mechanic).spatial.vehicleProfileSet({ unitId, heightM: 4.1, widthM: 2.6, lengthM: 12.4, emptyWeightKg: 18_500, axleGroups: [{ name: "steer", axles: 1, emptyKg: 5_500, loadedKg: 6_800 }, { name: "drive", axles: 2, emptyKg: 9_000, loadedKg: 17_000 }, { name: "pusher", axles: 1, emptyKg: 4_000, loadedKg: 7_700 }], source: "shop_measured" });
    expect(prof).toMatchObject({ loadedGrossKg: 31_500, maxAxleGroupKg: 17_000 });
    await expect(callerFor(mechanic).spatial.vehicleProfileVerify({ unitId })).rejects.toBeTruthy();
    expect((await callerFor(lead).spatial.vehicleProfileVerify({ unitId })).verificationStatus).toBe("verified");

    // Data: a bridge posted at 29,000 kg (verified authority data) and a road weight restriction recorded but not yet verified.
    await pool.execute("INSERT INTO bridges (structureId, label, segmentId, latitude, longitude, direction, clearanceM, postedWeightKg, jurisdiction, source, sourceVersion, verifiedAt, confidence, createdAt) VALUES (?, 'Clearwater Creek bridge', ?, 52.87, -114.79, 'both', 4.6, 29000, 'AB', 'Alberta Transportation bridge file', '2026-05', NOW(), 'authority_confirmed', NOW())", [key("BR").slice(0, 40), SEG_BRIDGE]);
    const rst = await callerFor(dispatcher).spatial.restrictionRecord({ jurisdiction: "AB", roadRef: "Twp Rd 452", segmentId: SEG_ROAD, segmentLabel: "Township Road 452 west of Range Road 64", check: "road_weight_restriction", limitValue: 39_500, unit: "kg", source: "Clearwater County posted limit", sourceVersion: "2026-04-14" });
    expect(rst.verificationStatus).toBe("unverified");

    // The evaluation: the bridge fails legally with a sentence a person can read; the unverified ban is unknown data, not a pass; the width check with no data is unknown; the verdict is not clear.
    const ev = await callerFor(dispatcher).spatial.routeEvaluateSegments({ unitId, segments: [{ segmentId: SEG_ROAD, label: "Township Road 452 west of RR 64", lengthKm: 6.4 }, { segmentId: SEG_BRIDGE, label: "Clearwater Creek bridge", lengthKm: 0.1 }], requiredChecks: ["road_weight_restriction", "bridge_capacity", "width_restriction"] });
    expect(ev).toMatchObject({ profileVerified: true, vehicle: { grossWeightKg: 31_500, maxAxleGroupKg: 17_000, widthM: 2.6 }, legal: "fail", routingSource: "not_loaded" });
    const bridge = ev.evidence.find(e => e.segmentId === SEG_BRIDGE && e.check === "bridge_capacity")!;
    expect(bridge).toMatchObject({ axis: "legal", result: "fail", inputs: { vehicleValue: 31_500, limitValue: 29_000, unit: "kg" }, confidence: "authority_confirmed" });
    expect(bridge.reason).toMatch(/31,?500/); expect(bridge.reason).toMatch(/29,?000/);
    const ban = ev.evidence.find(e => e.segmentId === SEG_ROAD && e.check === "road_weight_restriction")!;
    expect(ban.result).not.toBe("pass");
    expect(ban.confidence).toBe("unverified");
    expect(ev.evidence.filter(e => e.check === "width_restriction").every(e => e.result === "unknown")).toBe(true);
    expect(ev.dispatchStatus).not.toBe("clear");
    const [persisted] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM routeEvidenceEntries WHERE segmentId IN (?, ?) AND vehicleValue = 31500", [SEG_BRIDGE, SEG_ROAD]);
    expect(Number(persisted[0].n)).toBeGreaterThan(0);
    // Verified by safety, the ban becomes authority data on the next evaluation.
    await callerFor(safety).spatial.restrictionVerify({ restrictionRef: rst.restrictionRef, sourceDocumentEvidenceId: 2 });
    const ev2 = await callerFor(dispatcher).spatial.routeEvaluateSegments({ unitId, segments: [{ segmentId: SEG_ROAD, label: "Township Road 452 west of RR 64", lengthKm: 6.4 }], requiredChecks: ["road_weight_restriction"] });
    const ban2 = ev2.evidence.find(e => e.check === "road_weight_restriction")!;
    expect(ban2, JSON.stringify(ev2.evidence)).toMatchObject({ confidence: "authority_confirmed", result: "pass", inputs: { vehicleValue: 31_500, limitValue: 39_500 } }); // 31,500 kg under a verified 39,500 kg limit

    // A later, unverified row on the same segment and check does not displace the verified one.
    await callerFor(dispatcher).spatial.restrictionRecord({ jurisdiction: "AB", roadRef: "Twp Rd 452", segmentId: SEG_ROAD, segmentLabel: "Township Road 452 west of RR 64", check: "road_weight_restriction", limitValue: 20_000, unit: "kg", source: "unconfirmed phone call", sourceVersion: "today" });
    const ev3 = await callerFor(dispatcher).spatial.routeEvaluateSegments({ unitId, segments: [{ segmentId: SEG_ROAD, label: "Township Road 452 west of RR 64", lengthKm: 6.4 }], requiredChecks: ["road_weight_restriction"] });
    expect(ev3.evidence.find(e => e.check === "road_weight_restriction")).toMatchObject({ confidence: "authority_confirmed", inputs: { limitValue: 39_500 } });

    // A route against the network: UNKNOWN, recorded as the ask; the source status says why.
    const rq = await callerFor(dispatcher).spatial.routeRequest({ unitId, originRef: "Nisku yard", destinationRef: "10-22-045-06-W5" });
    expect(rq).toMatchObject({ determination: "unknown", sourceStatus: "not_loaded" });
    const [rr] = await pool.execute<mysql.RowDataPacket[]>("SELECT sourceStatus, determination FROM routeRequests WHERE requestRef = ?", [rq.requestRef]);
    expect(rr[0]).toMatchObject({ sourceStatus: "not_loaded", determination: "unknown" });
    expect((await callerFor(dispatcher).spatial.routingSourceStatus()).status).toBe("not_loaded");

    // The last position: none, then one from a telematics feed, read as evidence with its age — and the note that a position is not a work state.
    expect((await callerFor(dispatcher).spatial.lastPosition({ unitId })).position).toBeNull();
    const tel = await callerFor(controller).integration.clientRegister({ name: "Telematics Co", kind: "telematics", scopes: ["gps_position"] });
    await machine(tel.key).inbound.ingest({ feed: "gps_position", idempotencyKey: `pos-${unitNo}`, payload: { latitude: 52.871, longitude: -114.788, recordedAt: new Date(Date.now() - 7 * 60_000).toISOString(), unitRef: unitNo } });
    const lp = await callerFor(dispatcher).spatial.lastPosition({ unitId });
    expect(lp.position).toMatchObject({ latitude: 52.871, longitude: -114.788, source: "Telematics Co" });
    expect(lp.position!.ageMinutes).toBeGreaterThanOrEqual(6);
    expect(lp.note).toContain("A position is not a work state");
  });
});
