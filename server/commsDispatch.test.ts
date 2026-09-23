/**
 * v22.18 — Communications reach dispatch.
 *
 * The question these answer is not "does the plan compute" — v22.17 proved
 * that. It is whether the plan changes what dispatch decides, and whether it
 * changes it only as far as the company said it should.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  ADVISORY_POLICY, communicationBlockers, planCommunications, transmitAuthorization,
  type CoverageObservation, type RadioChannel, type RoadRadioAssignment, type UnitRadioCapability,
} from "./_core/commRoute";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { composeReadiness } from "./readinessComposer";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";
import { computeEligibilityFingerprint, type EligibilityFacts } from "./_core/dispatchAward";

const at = new Date("2026-09-11T12:00:00Z");
const channel = (o: Partial<RadioChannel> = {}): RadioChannel => ({
  channelKey: "TEST-1", alias: "Test 1", serviceClass: "land_mobile_b1", systemType: "simplex",
  rxMHz: 154.1, txMHz: 154.1, licenceRequired: true, conditions: [],
  sourceKey: "ised_b1_western", sourceCitation: "ISED B1", verificationStatus: "verified", ...o,
});
const capableUnit = (o: Partial<UnitRadioCapability> = {}): UnitRadioCapability => ({
  unitId: 1, vhf: true, uhf: false, cb: true, satellite: false, cellular: true,
  programmingProfileRef: "AB-NORTH-07", programmedChannelKeys: ["TEST-1"], verificationStatus: "verified", ...o,
});
const assignment = (o: Partial<RoadRadioAssignment> = {}): RoadRadioAssignment => ({
  assignmentRef: "A-1", segmentId: "S-1", channelKey: "TEST-1", authorityTier: "operator_instruction",
  verificationStatus: "verified", ...o,
});

/* ------------------------------------------------------------------ */

describe("a retired service is not a fallback", () => {
  it("refuses a channel whose service has been shut down, whatever else is on file, and says why", () => {
    // Weatheradio was shut down while its transmitter frequencies stayed
    // published. Without this, a frequency database happily tells a driver to
    // rely on a service that no longer transmits.
    const retired = channel({ serviceStatus: "retired", retiredNote: "Service discontinued by the publisher; the frequencies remain listed as history" });
    const r = transmitAuthorization({
      channel: retired, channelKey: "TEST-1",
      companyAuthorization: { channelKey: "TEST-1", authorized: true, licenceExpiresAt: new Date("2030-01-01"), verificationStatus: "verified" },
      unit: capableUnit(), province: "AB", at,
    });
    expect(r.status).toBe("not_authorized");
    expect(r.reasons.join(" ")).toContain("no longer transmits");
    expect(r.gates).toHaveLength(1);   // it stops at the first gate; nothing further is worth evaluating
  });

  it("treats an absent serviceStatus as active, so every record written before this existed keeps its meaning", () => {
    const legacy = channel({ serviceStatus: undefined });
    const r = transmitAuthorization({
      channel: legacy, channelKey: "TEST-1",
      companyAuthorization: { channelKey: "TEST-1", authorized: true, licenceExpiresAt: new Date("2030-01-01"), verificationStatus: "verified" },
      unit: capableUnit(), province: "AB", at,
    });
    expect(r.status).toBe("authorized");
  });

  it("reports a retired channel as not authorized in a route plan rather than dropping the zone", () => {
    const plan = planCommunications({
      path: [{ segmentId: "S-1", label: "Smoky Main", lengthKm: 12 }],
      assignments: [assignment()],
      channels: [channel({ serviceStatus: "retired", retiredNote: "No longer in service" })],
      companyAuthorizations: [{ channelKey: "TEST-1", authorized: true, verificationStatus: "verified" }],
      unit: capableUnit(), province: "AB", at,
    });
    expect(plan.zones).toHaveLength(1);
    expect(plan.zones[0].transmit).toBe("not_authorized");
    // Not `gaps`: the zone is refused, but nobody has recorded coverage here, so
    // the route still carries unknowns and unknown never rounds to anything else.
    expect(plan.verdict).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */

describe("the lone-worker rule counts unknown against you", () => {
  const path = [{ segmentId: "S-1", label: "Access", lengthKm: 40 }];
  const covered = planCommunications({
    path, assignments: [assignment()], channels: [channel()],
    coverage: [{ segmentId: "S-1", medium: "cellular", state: "available", sourceKey: "crtc_coverage", authorityTier: "regulatory_authority", verificationStatus: "verified" }],
    companyAuthorizations: [{ channelKey: "TEST-1", authorized: true, verificationStatus: "verified" }], unit: capableUnit(), province: "AB", at,
  });
  const silent = planCommunications({ path, assignments: [assignment()], channels: [channel()], companyAuthorizations: [{ channelKey: "TEST-1", authorized: true, verificationStatus: "verified" }], unit: capableUnit(), province: "AB", at });
  const policy = { ...ADVISORY_POLICY, loneWorkerRequiresSatellite: true, toleratedNoCommunicationKm: Number.POSITIVE_INFINITY };

  it("blocks a lone worker with no satellite where cellular is not established, and unknown counts as not established", () => {
    // "We do not know whether there is cellular for 40 km" is not a reason to
    // send somebody out there alone without a satellite device. It is the
    // reason to insist on one.
    const b = communicationBlockers(silent, policy, { loneWorker: true, unitHasSatellite: false });
    expect(b.find(x => x.code === "lone_worker_no_satellite")!.severity).toBe("blocking");
    expect(b.find(x => x.code === "lone_worker_no_satellite")!.label).toContain("40 km beyond established cellular");
  });

  it("is UNKNOWN when nobody has recorded whether the truck carries one", () => {
    const b = communicationBlockers(silent, policy, { loneWorker: true, unitHasSatellite: null });
    expect(b.find(x => x.code === "lone_worker_satellite_unknown")!.severity).toBe("unknown");
  });

  it("drops to review when the device is on record, and says nothing at all where cellular is established", () => {
    expect(communicationBlockers(silent, policy, { loneWorker: true, unitHasSatellite: true }).find(x => x.code === "lone_worker_satellite_present")!.severity).toBe("review");
    expect(communicationBlockers(covered, policy, { loneWorker: true, unitHasSatellite: false }).some(x => x.code.startsWith("lone_worker"))).toBe(false);
  });

  it("does not apply at all when the driver is not working alone, or the company has not set the rule", () => {
    expect(communicationBlockers(silent, policy, { loneWorker: false, unitHasSatellite: false }).some(x => x.code.startsWith("lone_worker"))).toBe(false);
    expect(communicationBlockers(silent, ADVISORY_POLICY, { loneWorker: true, unitHasSatellite: false }).some(x => x.code.startsWith("lone_worker"))).toBe(false);
  });
});

describe("the readiness fingerprint covers the channels", () => {
  const FACTS: EligibilityFacts = {
    operatorId: 47, operatorCredentialVersion: "v9", hoursAvailableMinutes: 600, unitId: 27,
    unitStatusVersion: "v4", criticalDefectCount: 0, mechanicReleaseVersion: "v1", trailerId: null,
    trailerStatusVersion: "v0", jobClassificationVersion: "v2", materialClassificationVersion: "v2",
    permitVersion: "v1", destinationAcceptanceVersion: "v3", routeProfileId: "RA-1", routeDecisionVersion: "v1",
    communicationPlanVersion: "unknown:abc",
  unitCredentialVersion: "none", insuranceVersion: "none", enforcementVersion: "none", roadsideVersion: "none",
  telematicsFaultVersion: "none", calibrationVersion: "none", medicalVersion: "none", hosVersion: "none",
  deviceVersion: "none", ruleSetHash: "rules-v1", policyVersion: "policy-v1", expiryStateVersion: "e",
  };
  it("moves when the plan's verdict or its channels move", () => {
    expect(computeEligibilityFingerprint({ ...FACTS, communicationPlanVersion: "covered:abc" })).not.toBe(computeEligibilityFingerprint(FACTS));
    expect(computeEligibilityFingerprint({ ...FACTS, communicationPlanVersion: "unknown:def" })).not.toBe(computeEligibilityFingerprint(FACTS));
    expect(computeEligibilityFingerprint({ ...FACTS })).toBe(computeEligibilityFingerprint(FACTS));
  });
});

describe("approving the policy is a sensitive act", () => {
  it("fails closed, because it decides whether a driver leaves the yard", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("comms.policy.approve");
    expect(SENSITIVE_PERMISSIONS).not.toContain("comms.policy.manage");
  });
});

/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 6_900_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

/**
 * Establish the precondition rather than assume it. The gate runs from an empty
 * database; this file shares one with every other run against the same instance,
 * and an approved policy written by a test further down would otherwise decide
 * the answer for a test above it.
 */
async function noPolicyInForce() {
  await pool.execute("UPDATE communicationPolicies SET status = 'superseded' WHERE status = 'approved'");
}

async function operatorAndUnit() {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [key("Op").slice(0, 40)]);
  return { unitId: Number(u.insertId), operatorId: Number(o.insertId) };
}

d("the company's policy, approved by a second person", () => {
  it("prices nothing until approved, refuses self-approval, and supersedes its predecessor on approval", async () => {
    const proposer = await withRole("safety");
    const approver = await withRole("management");
    const alsoApprover = await withRole("management");
    const first = await callerFor(proposer).comms.policyPropose({ label: key("P"), unknownPlanBlocks: false, toleratedNoCommunicationKm: 50 });
    expect(first.note).toContain("advisory default");
    // Safety may propose and not approve — the gate refuses before the
    // two-person rule is even reached, which is the right order.
    await expect(callerFor(proposer).comms.policyApprove({ policyRef: first.policyRef, decision: "approve" })).rejects.toThrow(/grants comms\.policy\.approve/i);
    // And somebody who does hold the permission still may not approve their own.
    const own = await callerFor(alsoApprover).comms.policyPropose({ label: key("P") });
    await expect(callerFor(alsoApprover).comms.policyApprove({ policyRef: own.policyRef, decision: "approve" })).rejects.toThrow(/second person/i);
    await callerFor(approver).comms.policyApprove({ policyRef: first.policyRef, decision: "approve" });

    const inForce = await callerFor(approver).comms.policyCurrent({ at: new Date() });
    expect(inForce).toMatchObject({ inForce: true, policyRef: first.policyRef });
    expect(inForce.policy.toleratedNoCommunicationKm).toBe(50);

    const second = await callerFor(proposer).comms.policyPropose({ label: key("P"), unknownPlanBlocks: true, toleratedNoCommunicationKm: 0, supersedesPolicyRef: first.policyRef });
    const approved = await callerFor(approver).comms.policyApprove({ policyRef: second.policyRef, decision: "approve" });
    expect(approved.superseded).toBe(first.policyRef);
    const now = await callerFor(approver).comms.policyCurrent({ at: new Date() });
    expect(now.policyRef).toBe(second.policyRef);
    expect(now.policy.unknownPlanBlocks).toBe(true);
  });

  it("refuses a window that ends before it begins, and records a rejection without applying it", async () => {
    const proposer = await withRole("safety");
    const approver = await withRole("management");
    await expect(callerFor(proposer).comms.policyPropose({ label: key("P"), effectiveFrom: new Date("2026-10-01"), effectiveTo: new Date("2026-09-01") })).rejects.toThrow(/ends before it begins/i);
    const p = await callerFor(proposer).comms.policyPropose({ label: key("P"), unknownPlanBlocks: true });
    const rejected = await callerFor(approver).comms.policyApprove({ policyRef: p.policyRef, decision: "reject", decisionNote: "Too strict for our yard work" });
    expect(rejected.status).toBe("rejected");
    await expect(callerFor(approver).comms.policyApprove({ policyRef: p.policyRef, decision: "approve" })).rejects.toThrow(/is rejected/i);
  });
});

d("a retired service, recorded", () => {
  it("is refused to a driver asking whether they may transmit, and cannot be retired twice", async () => {
    const controller = await withRole("controller");
    const verifier = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    await callerFor(controller).comms.channelSeed();
    await pool.execute("UPDATE radioChannels SET serviceStatus = 'active', retiredNote = NULL, retiredAt = NULL WHERE channelKey = 'LD-14'");
    const retired = await callerFor(verifier).comms.channelRetire({ channelKey: "LD-14", note: "Service discontinued by the publisher; frequency remains listed as history" });
    expect(retired.serviceStatus).toBe("retired");
    const check = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LD-14", province: "BC" });
    expect(check.status).toBe("not_authorized");
    expect(check.reasons.join(" ")).toContain("no longer transmits");
    await expect(callerFor(verifier).comms.channelRetire({ channelKey: "LD-14", note: "again, for good measure" })).rejects.toThrow(/already recorded as retired/i);
  });
});

d("readiness reads the route it is given", () => {
  it("says nothing was evaluated without a route, and reads the approval's verdict with one", async () => {
    const dispatcher = await withRole("dispatcher");
    await noPolicyInForce();
    const { unitId, operatorId } = await operatorAndUnit();

    const silent = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null });
    expect(silent.contributions.find(c => c.engine === "routing")!.finding).toContain("No route named");
    expect(silent.facts.routeProfileId).toBeNull();
    expect(silent.facts.communicationPlanVersion).toBe("none");

    const segmentId = key("SEG").slice(0, 60);
    const approval = await callerFor(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "Computed over imported road data", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false },
    });

    const routed = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    expect(routed.facts.routeProfileId).toBe(approval.approvalRef);
    expect(routed.facts.communicationPlanVersion).not.toBe("none");
    expect(routed.contributions.find(c => c.engine === "communications")!.finding).toContain("Unknown is not coverage");
    // Advisory by default: the unknown plan is named, and it does not block.
    // Asserted on the blocker itself, not the verdict — a bare operator fixture
    // is blocked for a missing licence, which has nothing to do with radio.
    expect(routed.eligibility.blockers.find(b => b.code === "communication_plan_unknown")!.severity).toBe("unknown");
    expect(routed.eligibility.explanation).not.toContain("Communication plan incomplete");
  });

  it("names a missing route rather than quietly evaluating a smaller question", async () => {
    const { unitId, operatorId } = await operatorAndUnit();
    const r = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: "RA-NOT-A-THING" });
    expect(r.eligibility.blockers.find(b => b.code === "route_approval_missing")!.severity).toBe("unknown");
  });

  it("blocks once the company has approved a policy that says an incomplete plan stops the truck", async () => {
    const dispatcher = await withRole("dispatcher");
    const proposer = await withRole("safety");
    const approver = await withRole("management");
    await noPolicyInForce();
    const { unitId, operatorId } = await operatorAndUnit();
    const segmentId = key("SEG").slice(0, 60);
    const approval = await callerFor(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "Computed over imported road data", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false },
    });

    const advisory = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    expect(advisory.eligibility.blockers.find(x => x.code === "communication_plan_unknown")!.severity).toBe("unknown");
    expect(advisory.eligibility.explanation).not.toContain("Communication plan incomplete");

    const p = await callerFor(proposer).comms.policyPropose({ label: key("Remote"), unknownPlanBlocks: true, rationale: "Northern remote operations" });
    await callerFor(approver).comms.policyApprove({ policyRef: p.policyRef, decision: "approve" });

    // Same route, same truck, same day. The only thing that changed is that two
    // people agreed an incomplete plan should stop a truck — and now it does.
    const enforced = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    expect(enforced.eligibility.blockers.find(x => x.code === "communication_plan_unknown")!.severity).toBe("blocking");
    expect(enforced.eligibility.verdict).toBe("blocked");
    expect(enforced.eligibility.explanation).toContain("Communication plan incomplete");
    // The same policy, no route named: communications say nothing, because
    // there is no route to say it about.
    const noRoute = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null });
    expect(noRoute.eligibility.blockers.some(b => b.code.startsWith("communication_"))).toBe(false);
  });

  it("blocks a stale approval by name — a channel change between the brief and the yard is not a detail", async () => {
    const controller = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    await callerFor(controller).comms.channelSeed();
    await noPolicyInForce();
    const { unitId, operatorId } = await operatorAndUnit();
    const segmentId = key("SEG").slice(0, 60);
    await callerFor(safety).comms.assignmentRecord({ segmentId, channelKey: "RR-25", authorityTier: "planning_map", roadName: "Squamish Main", sourceKey: "bc_resource_road_maps" });
    const approval = await callerFor(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], dispatchStatus: "warning",
      explanation: "Computed over imported road data", requiredChecks: ["road_weight_restriction"],
      load: { grossWeightKg: 31_500, dangerousGoods: false },
    });
    const before = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    expect(before.eligibility.blockers.some(b => b.code.startsWith("route_approval_"))).toBe(false);

    const o = await callerFor(driver).comms.signObserve({ observedChannelText: "RR-30", latitude: 49.8, longitude: -123.15, segmentId, roadName: "Squamish Main" });
    await callerFor(safety).comms.signDecide({ observationRef: o.observationRef, decision: "confirm" });
    await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });   // the check is what marks it stale

    const after = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: approval.approvalRef });
    const stale = after.eligibility.blockers.find(b => b.code === "route_approval_stale")!;
    expect(stale.severity).toBe("blocking");
    expect(stale.label).toContain("re-evaluate it before dispatching");
    expect(after.facts.communicationPlanVersion).not.toBe(before.facts.communicationPlanVersion);
  });
});
