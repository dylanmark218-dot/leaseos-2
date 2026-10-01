/**
 * T2 vertical slice — authoritative weight, axle groups, road bans, segment jurisdiction, approval
 * staleness and readiness, through the real procedures against a real database.
 *
 * The defects this slice stands on (1–4) are reproduced in routeLegalityDefects{,.db}.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;

describe("route legality slice — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped route-legality suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 938_000_000 + Math.floor(Math.random() * 50_000);
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = userSeq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

type Cast = { dispatcher: number; safety: number; shop: number; shop2: number };
const cast = async (): Promise<Cast> => ({ dispatcher: await withRole("dispatcher"), safety: await withRole("safety"), shop: await withRole("shop_lead"), shop2: await withRole("shop_lead") });
async function newUnit() {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
  return Number(u.insertId);
}
/** Declared: steer 6,000 + drive 14,000 = 20,000 kg unless overridden. */
async function profile(c: Cast, unitId: number, p: { steerKg?: number; driveKg?: number } = {}) {
  await callerFor(c.shop).spatial.vehicleProfileSet({
    unitId, heightM: 4.0, widthM: 2.6, lengthM: 20, emptyWeightKg: 12_000, source: "shop_measured",
    axleGroups: [{ name: "steer", axles: 1, emptyKg: 5_000, loadedKg: p.steerKg ?? 6_000 }, { name: "drive", axles: 2, emptyKg: 7_000, loadedKg: p.driveKg ?? 14_000 }],
  });
  await callerFor(c.shop2).spatial.vehicleProfileVerify({ unitId });
}
type Check = "road_weight_restriction" | "axle_group_limit" | "overhead_clearance" | "road_ban_level";
async function restriction(c: Cast, segmentId: string, check: Check, limitValue: number | null, unit: string | null, over: { textValue?: string; jurisdiction?: string; effectiveFrom?: Date; effectiveTo?: Date } = {}) {
  const r = await callerFor(c.dispatcher).spatial.restrictionRecord({ jurisdiction: over.jurisdiction ?? "CA-AB", roadRef: "Fixture Rd", segmentId, segmentLabel: "Fixture Rd", check, limitValue, unit, textValue: over.textValue ?? null, effectiveFrom: over.effectiveFrom ?? null, effectiveTo: over.effectiveTo ?? null, source: "fixture posting" });
  await callerFor(c.safety).spatial.restrictionVerify({ restrictionRef: r.restrictionRef, sourceDocumentEvidenceId: 1 });
  return r.restrictionRef;
}
/**
 * A LoadSense or scale reading as ingest leaves it: the legal determination is decided at ingest and
 * stored on the row (0159), so the fixture stores it the same way.
 */
async function reading(unitId: number, r: { source: "certified_scale" | "loadsense_calibrated" | "loadsense_uncalibrated"; grossKg: number; legal: boolean; code?: string; groups?: { key: string; kg: number }[]; at?: Date }) {
  const ref = key("SNAP");
  const [s] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO loadSenseWeightSnapshots (snapshotRef, loadId, unitId, measurementSource, tareKg, grossKg, payloadKg, stable, stabilityScore, measuredAt, payloadHash, legalDetermination, legalDeterminationCode) VALUES (?, 1, ?, ?, 12000, ?, ?, 1, 1, ?, ?, ?, ?)",
    [ref, unitId, r.source, r.grossKg, r.grossKg - 12_000, r.at ?? new Date(Date.now() - 60_000), "0".repeat(64), r.legal ? 1 : 0, r.legal ? null : (r.code ?? "NO_CALIBRATION")],
  );
  for (const g of r.groups ?? []) {
    await pool.execute("INSERT INTO loadSenseAxleWeights (snapshotId, axleGroupKey, label, weightKg, status) VALUES (?, ?, ?, ?, 'unknown_limit')", [s.insertId, g.key, g.key, g.kg]);
  }
  return ref;
}
const evaluate = (c: Cast, unitId: number, segmentIds: string[], requiredChecks: Check[]) =>
  callerFor(c.dispatcher).spatial.routeEvaluateSegments({ unitId, segments: segmentIds.map(segmentId => ({ segmentId, label: "Fixture Rd", lengthKm: 5 })), requiredChecks });

d("P1 — authoritative measured weight controls routing", () => {
  it("lets a legally determined 50,000 kg scale reading block a route the declared 20,000 kg profile would pass", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId);
    const seg = key("SEG").slice(0, 60);
    await restriction(c, seg, "road_weight_restriction", 30_000, "kg");
    const snap = await reading(unitId, { source: "certified_scale", grossKg: 50_000, legal: true, groups: [{ key: "steer", kg: 7_000 }, { key: "drive", kg: 43_000 }] });
    const v = await evaluate(c, unitId, [seg], ["road_weight_restriction"]);
    expect(v.dispatchStatus).toBe("blocked");
    expect(v.weight).toMatchObject({ basis: "measured_legal", snapshotRef: snap, authority: "authority_certified" });
    expect(v.evidence.find((e: { check: string }) => e.check === "road_weight_restriction")!.inputs.vehicleValue).toBe(50_000);
  }, 60_000);

  it("blocks a legal gross weight when one measured axle group is over its limit, and names the group", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId);
    const seg = key("SEG").slice(0, 60);
    await restriction(c, seg, "road_weight_restriction", 63_500, "kg");
    await restriction(c, seg, "axle_group_limit", 17_000, "kg");
    await reading(unitId, { source: "loadsense_calibrated", grossKg: 26_000, legal: true, groups: [{ key: "steer", kg: 7_000 }, { key: "drive", kg: 19_000 }] });
    const v = await evaluate(c, unitId, [seg], ["road_weight_restriction", "axle_group_limit"]);
    expect(v.dispatchStatus).toBe("blocked");
    const gross = v.evidence.find((e: { check: string }) => e.check === "road_weight_restriction")!;
    const axle = v.evidence.find((e: { check: string }) => e.check === "axle_group_limit")!;
    expect(gross.result).toBe("pass");
    expect(axle.result).toBe("fail");
    expect(axle.reason).toContain("drive axle group 19000 kg exceeds 17000 kg");
    expect(v.vehicle.axleGroups.map((g: { key: string }) => g.key)).toEqual(["steer", "drive"]);   // every group, not just the heaviest
  }, 60_000);

  it("does not let a reading without a legal determination establish compliance — a check it passes is REVIEW", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId);
    const seg = key("SEG").slice(0, 60);
    await restriction(c, seg, "road_weight_restriction", 30_000, "kg");
    await reading(unitId, { source: "loadsense_uncalibrated", grossKg: 25_000, legal: false, code: "SOURCE_NOT_ELIGIBLE", groups: [{ key: "drive", kg: 18_000 }] });
    const v = await evaluate(c, unitId, [seg], ["road_weight_restriction"]);
    expect(v.weight.basis).toBe("measured_not_legal");
    expect(v.dispatchStatus).not.toBe("clear");
    expect(v.evidence.find((e: { check: string }) => e.check === "road_weight_restriction")!.result).toBe("review");
  }, 60_000);

  it("still lets a non-legal reading that is heavier than declared tighten the check", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId);
    const seg = key("SEG").slice(0, 60);
    await restriction(c, seg, "road_weight_restriction", 30_000, "kg");
    await reading(unitId, { source: "loadsense_uncalibrated", grossKg: 41_000, legal: false });
    const v = await evaluate(c, unitId, [seg], ["road_weight_restriction"]);
    expect(v.dispatchStatus).toBe("blocked");
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* P2 / P3 — road bans against verified rules, per segment jurisdiction */
/* ------------------------------------------------------------------ */

/** A jurisdiction code no other run or suite uses, so each run's ledger rules are its own. */
const freshJurisdiction = () => `CA-X${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "Q")}`;

/** A legal axle-load rule, promoted the way any verified rule is: proposer, verifier and an independent second verifier. */
async function axleRule(jurisdiction: string, groups: { single?: number; tandem?: number; tridem?: number }, over: { effectiveFrom?: Date } = {}) {
  const { promoteRule } = await import("./_core/knowledge/promotionLedger");
  const [proposer, verifier, second] = [userSeq++, userSeq++, userSeq++];
  const now = new Date();
  const out = await promoteRule({
    ruleFamily: "axle_load_limit", ruleRef: jurisdiction, domain: "route", dispatchEffect: "BLOCK",
    payload: { groups, unit: "kg" }, jurisdiction, authorityType: "law",
    instrumentTitle: "Fixture Vehicle Weights Regulation", issuingAuthority: "Fixture Ministry of Transportation",
    sourceSection: "Schedule 1", citationUrl: "https://kings-printer.alberta.ca/fixture-vehicle-weights", verificationMethod: "OFFICIAL_CITATION",
    verificationLevel: "CITATION_VERIFIED", sourceRevisionRef: "",
    proposedByUserId: proposer, verifiedByUserId: verifier, verifiedAt: new Date(now.getTime() - 60_000),
    secondVerifierUserId: second, secondVerifiedAt: new Date(now.getTime() - 30_000),
    effectiveFrom: over.effectiveFrom ?? new Date("2020-01-01T00:00:00Z"),
  }, now);
  if (!out.promoted) throw new Error(`rule not promoted: ${out.code} ${out.reason}`);
  return out.promotionRef;
}
const banAt = (c: Cast, seg: string, percent: number, jurisdiction: string, window: { from?: Date; to?: Date } = {}) =>
  restriction(c, seg, "road_ban_level", percent, "percent", { jurisdiction, effectiveFrom: window.from, effectiveTo: window.to });
const entry = (v: { evidence: { segmentId: string; check: string; result: string; reason: string; jurisdiction: string | null }[] }, seg: string, check = "road_ban_level") =>
  v.evidence.find(e => e.segmentId === seg && e.check === check)!;

d("P2 — a road ban is the verified legal allowance times the ban, or UNKNOWN", () => {
  it("blocks a 14,000 kg tandem under a 75% ban of a verified 17,000 kg tandem allowance (12,750 kg)", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { driveKg: 14_000 });
    const j = freshJurisdiction();
    const ruleRef = await axleRule(j, { single: 9_100, tandem: 17_000, tridem: 24_000 });
    const seg = key("SEG").slice(0, 60);
    await banAt(c, seg, 75, j, { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2037-12-31T00:00:00Z") });
    const v = await evaluate(c, unitId, [seg], ["road_ban_level"]);
    expect(v.dispatchStatus).toBe("blocked");
    expect(entry(v, seg).reason).toContain("drive tandem axle group 14000 kg exceeds the 12750 kg road-ban allowance");
    expect(v.roadBans[0]).toMatchObject({ outcome: "resolved", percent: 75, jurisdiction: j, rulePromotionRef: ruleRef });
  }, 60_000);

  it("does not apply a ban whose window has ended, and says it was set aside", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { driveKg: 14_000 });
    const j = freshJurisdiction();
    await axleRule(j, { tandem: 17_000 });
    const seg = key("SEG").slice(0, 60);
    await banAt(c, seg, 75, j, { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-05-31T00:00:00Z") });
    const v = await evaluate(c, unitId, [seg], ["road_ban_level"]);
    expect(entry(v, seg).result).not.toBe("fail");
    expect(v.roadBans).toHaveLength(0);
    expect(v.dateNotes.some((n: string) => n.includes("expired") && n.includes("road ban level"))).toBe(true);
  }, 60_000);

  it("is UNKNOWN — not estimated — when the ban exists but no verified base axle rule is in force", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { driveKg: 10_000 });
    const j = freshJurisdiction();   // no rule promoted for it
    const seg = key("SEG").slice(0, 60);
    await banAt(c, seg, 75, j);
    const v = await evaluate(c, unitId, [seg], ["road_ban_level"]);
    expect(entry(v, seg).result).toBe("unknown");
    expect(entry(v, seg).reason).toContain("no verified legal axle-load rule");
    expect(v.dispatchStatus).not.toBe("clear");
  }, 60_000);

  it("applies a seasonal increase by the same rule: 110% of 17,000 kg passes an 18,000 kg tandem", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { steerKg: 6_000, driveKg: 18_000 });
    const j = freshJurisdiction();
    await axleRule(j, { single: 9_100, tandem: 17_000 });
    const seg = key("SEG").slice(0, 60);
    await banAt(c, seg, 110, j);
    const v = await evaluate(c, unitId, [seg], ["road_ban_level"]);
    expect(entry(v, seg).result).toBe("pass");
  }, 60_000);
});

d("P3 — each segment uses its own jurisdiction's rule", () => {
  it("applies one province's allowance on its segment and the other's on the next (AB → BC style transition)", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { driveKg: 13_000 });
    const [jA, jB] = [freshJurisdiction(), freshJurisdiction()];
    // Both rules state a single allowance too: the steer axle is a single group, and a rule silent on
    // a group the vehicle has leaves that group's allowance UNKNOWN (proven by the next assertion block).
    await axleRule(jA, { single: 9_100, tandem: 17_000 });   // 75% → tandem 12,750: 13,000 fails
    await axleRule(jB, { single: 9_100, tandem: 18_000 });   // 75% → tandem 13,500: 13,000 passes
    const [segA, segB] = [key("SEGA").slice(0, 60), key("SEGB").slice(0, 60)];
    await banAt(c, segA, 75, jA);
    await banAt(c, segB, 75, jB);
    const v = await evaluate(c, unitId, [segA, segB], ["road_ban_level"]);
    expect(entry(v, segA)).toMatchObject({ result: "fail", jurisdiction: jA });
    expect(entry(v, segB)).toMatchObject({ result: "pass", jurisdiction: jB });
  }, 60_000);

  it("is UNKNOWN when the rule states no allowance for one of the vehicle's axle groups — never estimated from another", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { driveKg: 10_000 });
    const j = freshJurisdiction();
    await axleRule(j, { tandem: 17_000 });          // silent on single axles
    const seg = key("SEG").slice(0, 60);
    await banAt(c, seg, 75, j);
    const v = await evaluate(c, unitId, [seg], ["road_ban_level"]);
    expect(entry(v, seg).result).toBe("unknown");
    expect(entry(v, seg).reason).toContain("states no single allowance, so the steer axle group's allowance is UNKNOWN");
  }, 60_000);

  it("is UNKNOWN when the ban's jurisdiction cannot be resolved to one whose rules LeaseOS can select", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId);
    const seg = key("SEG").slice(0, 60);
    await banAt(c, seg, 75, "Municipal District 15");
    const v = await evaluate(c, unitId, [seg], ["road_ban_level"]);
    expect(entry(v, seg).result).toBe("unknown");
    expect(entry(v, seg).reason).toContain("rather than borrowed from a neighbouring jurisdiction");
  }, 60_000);

  it("is UNKNOWN when the road data places the segment in a different province from the ban — the resolver is a cross-check", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId);
    const road = await albertaRoad();                   // road source: ats_road_allowance → verified CA-AB
    await axleRule("CA-AB", { tandem: 17_000 });
    await banAt(c, road.segmentId, 75, "CA-BC");         // posted as BC on a road the data places in AB
    const v = await callerFor(c.dispatcher).spatial.routeEvaluateSegments({ unitId, buildRef: road.buildRef, segments: [{ segmentId: road.segmentId, label: "Fixture Rd", lengthKm: 4 }], requiredChecks: ["road_ban_level"] });
    expect(entry(v, road.segmentId).result).toBe("unknown");
    expect(entry(v, road.segmentId).reason).toContain("places it in CA-AB");
  }, 60_000);
});

/** One road in a graph build, from the Alberta road source, so the geography resolver places it in AB. */
async function albertaRoad() {
  const buildRef = key("GB"), objectId = 700_000_000 + Math.floor(Math.random() * 200_000_000);
  const segmentId = `AB-ACCESS-${objectId}`;
  const lat = 54 + Math.random();
  await pool.execute(
    "INSERT INTO accessRoadSegments (objectId, name, featureType, featureTypeLabel, surfaceKind, lengthMetres, minLatitude, minLongitude, maxLatitude, maxLongitude, pathJson, sourceKey, sourceLayer, importRunRef, retrievedAt) VALUES (?, 'Fixture Rd', 2, 'Road', 'gravel', 4000, ?, -116.9, ?, -116.85, ?, 'ats_road_allowance', 'access', ?, NOW())",
    [objectId, lat, lat + 0.01, JSON.stringify([[-116.9, lat], [-116.85, lat + 0.01]]), key("RUN")],
  );
  await pool.execute("INSERT INTO roadGraphBuilds (buildRef, label, minLatitude, minLongitude, maxLatitude, maxLongitude, snapToleranceMetres, segmentsConsidered, nodeCount, edgeCount, componentCount, largestComponentEdges, isolatedEdges, excludedSurfacesJson, sourceRunRefsJson, status, builtByUserId, builtAt) VALUES (?, 'legality fixture', 53, -118, 56, -115, 5, 1, 2, 1, 1, 1, 0, '[]', '[]', 'current', 1, NOW())", [buildRef]);
  const a = `N-${objectId}-A`, b = `N-${objectId}-B`;
  await pool.execute("INSERT INTO roadGraphNodes (buildRef, nodeKey, latitude, longitude, degree, componentId) VALUES (?, ?, ?, -116.9, 1, 1), (?, ?, ?, -116.85, 1, 1)", [buildRef, a, lat, buildRef, b, lat + 0.01]);
  await pool.execute("INSERT INTO roadGraphEdges (buildRef, segmentId, accessRoadObjectId, label, fromNodeKey, toNodeKey, lengthMetres, surfaceKind, featureTypeLabel, componentId) VALUES (?, ?, ?, 'Fixture Rd', ?, ?, 4000, 'gravel', 'Road', 1)", [buildRef, segmentId, objectId, a, b]);
  return { buildRef, segmentId };
}
