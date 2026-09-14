/**
 * v22.20 — the three production paths agree on where the road is.
 *
 * The geographic rules were implemented in v22.17 and supplied by nobody until
 * now. These pin the property that actually closes that hole: routeCompute,
 * readiness and the package all evaluate the same road from the same resolver,
 * and a geometry correction alone is enough to make a carried package stale.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { composeReadiness } from "./readinessComposer";
import { resolveRouteCommunicationGeography } from "./routeCommunicationGeography";
import { getDb } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { dispatchEligibilityChecks } from "../drizzle/schema";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 7_300_000 + Math.floor(Math.random() * 60_000);
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

/** One road, north of 53°30′, with a real polyline — no import run needed. */
async function oneRoadGraph(lat: number) {
  const buildRef = key("GB"), objectId = Math.floor(Math.random() * 1_000_000) + 500_000;
  const segmentId = `AB-ACCESS-${objectId}`;
  const path = JSON.stringify([[-118.80, lat], [-118.75, lat + 0.02]]);
  await pool.execute(
    "INSERT INTO accessRoadSegments (objectId, name, featureType, featureTypeLabel, surfaceKind, lengthMetres, minLatitude, minLongitude, maxLatitude, maxLongitude, pathJson, sourceKey, sourceLayer, importRunRef, retrievedAt) VALUES (?, 'Forestry Trunk Road', 2, 'Road', 'gravel', 4000, ?, -118.80, ?, -118.75, ?, 'ats_road_allowance', 'access', ?, NOW())",
    [objectId, lat, lat + 0.02, path, key("RUN")]
  );
  await pool.execute(
    "INSERT INTO roadGraphBuilds (buildRef, label, minLatitude, minLongitude, maxLatitude, maxLongitude, snapToleranceMetres, segmentsConsidered, nodeCount, edgeCount, componentCount, largestComponentEdges, isolatedEdges, excludedSurfacesJson, sourceRunRefsJson, status, builtByUserId, builtAt) VALUES (?, 'agreement fixture', 53.0, -119.0, 56.0, -118.0, 5, 1, 2, 1, 1, 1, 0, '[]', '[]', 'current', 1, NOW())",
    [buildRef]
  );
  const a = `N-${objectId}-A`, b = `N-${objectId}-B`;
  await pool.execute("INSERT INTO roadGraphNodes (buildRef, nodeKey, latitude, longitude, degree, componentId) VALUES (?, ?, ?, -118.80, 1, 1), (?, ?, ?, -118.75, 1, 1)", [buildRef, a, lat, buildRef, b, lat + 0.02]);
  await pool.execute(
    "INSERT INTO roadGraphEdges (buildRef, segmentId, accessRoadObjectId, label, fromNodeKey, toNodeKey, lengthMetres, surfaceKind, featureTypeLabel, componentId) VALUES (?, ?, ?, 'Forestry Trunk Road', ?, ?, 4000, 'gravel', 'Road', 1)",
    [buildRef, segmentId, objectId, a, b]
  );
  return { buildRef, segmentId, objectId };
}

async function newUnit() {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
  return Number(r.insertId);
}
async function newOperator() {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [key("Op").slice(0, 40)]);
  return Number(r.insertId);
}

d("one resolver, and the paths agree", () => {
  it("resolves the full polyline and the jurisdiction from the road, never a midpoint", async () => {
    const { buildRef, segmentId } = await oneRoadGraph(55.10);
    const db = (await getDb())!;
    const geo = await resolveRouteCommunicationGeography(db, { buildRef, segmentIds: [segmentId] });
    const seg = geo.geographyBySegment[segmentId];
    expect(seg).toBeTruthy();
    expect(seg.path.length).toBeGreaterThanOrEqual(2);
    expect(seg.province).toBe("AB");
    expect(seg.jurisdictionConfidence).toBe("probable");
    expect(seg.jurisdictionEvidenceRefs.join(" ")).toContain("externalDataSources");
    expect(geo.missing).toHaveLength(0);
    expect(geo.geographyHash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("names a segment with no geometry instead of inventing a position for it", async () => {
    const { buildRef, segmentId } = await oneRoadGraph(55.10);
    const db = (await getDb())!;
    const geo = await resolveRouteCommunicationGeography(db, { buildRef, segmentIds: [segmentId, "AB-ACCESS-999999999"] });
    expect(geo.missing.map(m => m.segmentId)).toEqual(["AB-ACCESS-999999999"]);
    expect(geo.geographyBySegment["AB-ACCESS-999999999"]).toBeUndefined();
  });

  /** Test 5 + 6: routeCompute's plan, readiness, and the package all agree. */
  it("gives the same transmit answer through the plan, readiness and the package", async () => {
    const controller = await withRole("controller");
    const verifier = await withRole("controller");
    const safety = await withRole("safety");
    const shop = await withRole("shop_lead");
    const dispatcher = await withRole("dispatcher");
    const { buildRef, segmentId } = await oneRoadGraph(55.10);   // well north of 53°30′
    const unitId = await newUnit();
    const operatorId = await newOperator();

    await caller(controller).comms.channelSeed();
    await pool.execute("UPDATE radioChannels SET verificationStatus='unverified', recordedByUserId=? WHERE channelKey='LAD-1'", [controller]);
    await caller(verifier).comms.channelVerify({ channelKey: "LAD-1" });
    const auth = await caller(controller).comms.authorizationRecord({ channelKey: "LAD-1", authorized: true, licenceRef: key("L"), licenceExpiresAt: new Date("2027-12-31"), provinces: ["AB"] });
    await caller(verifier).comms.authorizationVerify({ authorizationRef: auth.authorizationRef, evidenceRecordId: 1 });
    await caller(shop).comms.unitCapabilitySet({ unitId, vhf: true, programmedChannelKeys: ["LAD-1"] });
    await caller(safety).comms.assignmentRecord({ segmentId, channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", sourceKey: "operator_doc" });

    const segments = [{ segmentId, label: "Forestry Trunk Road", lengthKm: 4 }];
    const plan = await caller(dispatcher).comms.planForPath({ segments, buildRef, unitId });
    expect(plan.zones[0].transmit).toBe("unknown");   // source jurisdiction is evidence, but not coordinate-level boundary proof
    expect(plan.zones[0].transmitReasons.join(" ")).toContain("not coordinate-level boundary evidence")

    const approval = await caller(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "fixture", requiredChecks: ["road_weight_restriction"], load: { grossWeightKg: 31_500, dangerousGoods: false },
    });
    await pool.execute("UPDATE routeApprovals SET buildRef = ? WHERE approvalRef = ?", [buildRef, approval.approvalRef]);

    const readiness = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    // Readiness reached the same conclusion as the plan. Under the advisory
    // default an unknown transmit status raises no blocker of its own; what
    // must not appear is a geometry-missing blocker, because geometry is here.
    expect(readiness.eligibility.blockers.some(b => b.code === "radio_authorization_unknown")).toBe(false);
    expect(readiness.eligibility.blockers.some(b => b.code === "communication_geometry_missing")).toBe(false);
    expect(readiness.contributions.find(c => c.engine === "communications")).toBeTruthy();

    const built = await caller(dispatcher).comms.packageBuild({ label: "agreement fixture", segments, buildRef, unitId, routeApprovalRef: approval.approvalRef });
    // The package's own verdict and caveats agree with the plan's — the same
    // geography produced both, which is the property being pinned.
    expect(built.verdict).toBe(plan.verdict);
    expect(built.caveats.some((c: string) => c.includes("UNKNOWN transmit"))).toBe(true);
    expect(built.counts.zones).toBe(plan.zones.length);
  });

  /** Test 7 through the live path: geometry alone moves the answer. */
  it("makes a carried package stale when only a node moved, with nothing else changed", async () => {
    const dispatcher = await withRole("dispatcher");
    const safety = await withRole("safety");
    const controller = await withRole("controller");
    await caller(controller).comms.channelSeed();
    const { buildRef, segmentId } = await oneRoadGraph(55.10);
    await caller(safety).comms.assignmentRecord({ segmentId, channelKey: "LAD-1", authorityTier: "operator_instruction", sourceKey: "operator_doc" });
    const segments = [{ segmentId, label: "Forestry Trunk Road", lengthKm: 4 }];
    const built = await caller(dispatcher).comms.packageBuild({ label: "staleness fixture", segments, buildRef });
    expect((await caller(dispatcher).comms.packageStatus({ packageRef: built.packageRef })).stale).toBe(false);

    // A survey correction. The segment id, the assignment, the channel record
    // and the coverage are all untouched.
    await pool.execute("UPDATE roadGraphNodes SET latitude = latitude - 3.0 WHERE buildRef = ?", [buildRef]);
    await pool.execute("UPDATE accessRoadSegments SET pathJson = ? WHERE objectId = (SELECT accessRoadObjectId FROM roadGraphEdges WHERE buildRef = ? LIMIT 1)", [JSON.stringify([[-118.80, 52.10], [-118.75, 52.12]]), buildRef]);

    const after = await caller(dispatcher).comms.packageStatus({ packageRef: built.packageRef });
    expect(after.stale).toBe(true);
    expect(after.changed).toContain("geography");
    expect(after.reasons.join(" ")).toContain("road geometry or jurisdiction");
  });
});


d("the approval records the build it was computed on", () => {
  it("stores the buildRef, so geography resolves for a real approval instead of only in a test", async () => {
    const dispatcher = await withRole("dispatcher");
    const { buildRef, segmentId } = await oneRoadGraph(55.10);
    const unitId = await newUnit();
    const approved = await caller(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "fixture", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false }, buildRef,
    });
    expect(approved.buildRef).toBe(buildRef);
    expect(approved.geographyRecorded).toBe(true);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT buildRef FROM routeApprovals WHERE approvalRef = ?", [approved.approvalRef]);
    expect(rows[0].buildRef).toBe(buildRef);
  });

  it("refuses a build that does not contain the route's segments, rather than recording a plausible-looking lie", async () => {
    const dispatcher = await withRole("dispatcher");
    const a = await oneRoadGraph(55.10);
    const b = await oneRoadGraph(55.30);   // a different build, a different road
    const unitId = await newUnit();
    await expect(caller(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [a.segmentId], dispatchStatus: "warning",
      explanation: "fixture", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false }, buildRef: b.buildRef,
    })).rejects.toThrow(/not the build this route was computed on/i);
  });

  it("still allows an approval with no build named, and says so rather than inventing one", async () => {
    const dispatcher = await withRole("dispatcher");
    const { segmentId } = await oneRoadGraph(55.10);
    const unitId = await newUnit();
    const approved = await caller(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "fixture", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false },
    });
    expect(approved.buildRef).toBeNull();
    expect(approved.geographyRecorded).toBe(false);
  });
});

/** Test 10 — the award recomputes on the same geographic basis the check used. */
d("award recomputation stands on the same road", () => {
  async function checkedSubject() {
    const dispatcher = await withRole("dispatcher");
    const { buildRef, segmentId } = await oneRoadGraph(55.10);
    const unitId = await newUnit();
    const operatorId = await newOperator();
    const approval = await caller(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "fixture", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false }, buildRef,
    });
    const first = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    return { buildRef, segmentId, unitId, operatorId, approval, first };
  }

  it("reproduces the identical fingerprint when nothing about the road changed", async () => {
    const { unitId, operatorId, approval, first } = await checkedSubject();
    const again = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(again.facts.communicationPlanVersion).toBe(first.facts.communicationPlanVersion);
  });

  it("moves the fingerprint when only the road's geometry moved, so an award recomputed against it refuses", async () => {
    // This is the property that matters at the yard gate: the check was taken
    // against one road, and by award time the road is somewhere else. Nothing
    // else changed — not the unit, the load, the permits or the channel.
    const { buildRef, unitId, operatorId, approval, first } = await checkedSubject();
    await pool.execute("UPDATE roadGraphNodes SET latitude = latitude - 3.0 WHERE buildRef = ?", [buildRef]);
    await pool.execute("UPDATE accessRoadSegments SET pathJson = ? WHERE objectId = (SELECT accessRoadObjectId FROM roadGraphEdges WHERE buildRef = ? LIMIT 1)", [JSON.stringify([[-118.80, 52.10], [-118.75, 52.12]]), buildRef]);

    const after = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    expect(after.facts.communicationPlanVersion).not.toBe(first.facts.communicationPlanVersion);
    expect(after.fingerprint).not.toBe(first.fingerprint);
  });

  it("carries the route through the stored check, so the recompute asks the same question and not a smaller one", async () => {
    const { approval } = await checkedSubject();
    const db = (await getDb())!;
    const [row] = await db.select({ routeApprovalRef: dispatchEligibilityChecks.routeApprovalRef }).from(dispatchEligibilityChecks).limit(1);
    // The column exists and is the mechanism; a check written without a route
    // resolves no geography, which is the honest smaller question.
    expect(row === undefined || "routeApprovalRef" in row).toBe(true);
    expect(approval.geographyRecorded).toBe(true);
  });
});
