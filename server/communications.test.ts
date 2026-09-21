/**
 * v22.17 — Communications through the database, the gates and the API.
 *
 * The pure engine is proven in `commRoute.test.ts`. What is proven here is
 * what only the wired system can be: that seeding never walks over a person's
 * verification, that no single person can both record and verify, that the
 * only route to posted-sign authority runs through a confirmed field
 * observation, and that changing the channel on a road makes an approved
 * route stale.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";
import { ALL_CHANNEL_SEEDS } from "./_core/radioChannelSeeds";

describe("the acts that establish a communications fact are sensitive", () => {
  it("fails closed on verifying a channel, an authorization, an assignment, and confirming a sign", () => {
    for (const p of ["comms.channel.verify", "comms.authorization.verify", "comms.assignment.verify", "comms.observation.decide"] as const) {
      expect(SENSITIVE_PERMISSIONS).toContain(p);
    }
    // Reading the registry is not sensitive; knowing a frequency harms nobody.
    expect(SENSITIVE_PERMISSIONS).not.toContain("comms.read");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 6_400_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
async function newUnit() {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'due', 'review', NOW())", [key("U").slice(0, 20)]);
  return Number(r.insertId);
}

d("the channel registry", () => {
  it("seeds the standardized banks unverified, and a second seeding adds nothing and overwrites nothing", async () => {
    const controller = await withRole("controller");
    const first = await callerFor(controller).comms.channelSeed();
    const second = await callerFor(controller).comms.channelSeed();
    expect(second.inserted).toBe(0);
    expect(first.inserted + first.existing).toBeGreaterThanOrEqual(ALL_CHANNEL_SEEDS.length);
    expect(first.caveat).toContain("authorizes no transmission until a person verifies");

    const listed = await callerFor(controller).comms.channelList({ verifiedOnly: false });
    expect(listed.channels.find(c => c.channelKey === "RR-01")).toMatchObject({ rxMHz: 150.08, licenceRequired: true });
    expect(listed.channels.find(c => c.channelKey === "CB-19")!.licenceRequired).toBe(false);
  });

  it("refuses to let the person who recorded a channel verify it, and a second person may", async () => {
    const recorder = await withRole("controller");
    const verifier = await withRole("controller");
    const channelKey = key("TESTCH").slice(0, 30).toUpperCase();
    await pool.execute(
      "INSERT INTO radioChannels (channelKey, alias, serviceClass, systemType, rxMHz, txMHz, licenceRequired, conditionsJson, sourceKey, sourceCitation, verificationStatus, recordedByUserId, createdAt) VALUES (?, 'Test channel', 'land_mobile_b1', 'simplex', 154.1, 154.1, 1, '[]', 'ised_b1_western', 'ISED B1 appendix', 'unverified', ?, NOW())",
      [channelKey, recorder]
    );
    await expect(callerFor(recorder).comms.channelVerify({ channelKey })).rejects.toThrow(/second person/i);
    const ok = await callerFor(verifier).comms.channelVerify({ channelKey });
    expect(ok.verificationStatus).toBe("verified");
    await expect(callerFor(verifier).comms.channelVerify({ channelKey })).rejects.toThrow(/is verified/i);
  });

  it("keeps a verified channel verified when the seeds are loaded again", async () => {
    const controller = await withRole("controller");
    const verifier = await withRole("controller");
    await callerFor(controller).comms.channelSeed();
    await pool.execute("UPDATE radioChannels SET verificationStatus = 'unverified', recordedByUserId = ? WHERE channelKey = 'LAD-4'", [controller]);
    await callerFor(verifier).comms.channelVerify({ channelKey: "LAD-4" });
    await callerFor(controller).comms.channelSeed();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT verificationStatus FROM radioChannels WHERE channelKey = 'LAD-4'");
    expect(rows[0].verificationStatus).toBe("verified");
  });
});

d("may this company transmit", () => {
  it("answers UNKNOWN on a seeded channel, and AUTHORIZED only once the channel, the licence and the truck all say yes", async () => {
    const controller = await withRole("controller");
    const verifier = await withRole("controller");
    const shop = await withRole("shop_lead");
    const dispatcher = await withRole("dispatcher");
    await callerFor(controller).comms.channelSeed();
    const unitId = await newUnit();

    // Establish the precondition rather than assume it. The gate runs from an
    // empty database, but this file shares one with every other run against the
    // same instance, and a previous run verifies LAD-1 further down.
    await pool.execute("UPDATE radioChannels SET verificationStatus = 'unverified', verifiedByUserId = NULL, verifiedAt = NULL WHERE channelKey = 'LAD-1'");
    await pool.execute("UPDATE companyRadioAuthorizations SET verificationStatus = 'superseded' WHERE channelKey = 'LAD-1'");

    // Grande Prairie: north of the 53°30′ line and well clear of Bonnyville.
    const position = { latitude: 55.17, longitude: -118.8, province: "AB" };

    const seededOnly = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, ...position });
    expect(seededOnly.status).toBe("unknown");
    expect(seededOnly.gates.find(g => g.gate === "channel_record")!.result).toBe("unknown");

    await pool.execute("UPDATE radioChannels SET recordedByUserId = ? WHERE channelKey = 'LAD-1'", [controller]);
    await callerFor(verifier).comms.channelVerify({ channelKey: "LAD-1", sourceUrl: "https://ised-isde.canada.ca/", sourceVersion: "B1 as published" });

    const noLicence = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, ...position });
    expect(noLicence.status).toBe("unknown");
    expect(noLicence.gates.find(g => g.gate === "company_authorization")!.reason).toContain("not a permission to transmit");

    const { authorizationRef } = await callerFor(controller).comms.authorizationRecord({ channelKey: "LAD-1", authorized: true, licenceRef: "L-88231", licenceExpiresAt: new Date("2027-06-30"), provinces: ["AB"] });
    const unverifiedLicence = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, ...position });
    expect(unverifiedLicence.status).toBe("unknown");
    await expect(callerFor(controller).comms.authorizationVerify({ authorizationRef, evidenceRecordId: 1 })).rejects.toThrow(/second person/i);
    await callerFor(verifier).comms.authorizationVerify({ authorizationRef, evidenceRecordId: 1 });

    const noRadioRecord = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, ...position });
    expect(noRadioRecord.status).toBe("unknown");
    expect(noRadioRecord.gates.find(g => g.gate === "unit_capability")!.reason).toContain("No radio capability is recorded");

    await callerFor(shop).comms.unitCapabilitySet({ unitId, vhf: true, cb: true, programmingProfileRef: "AB-NORTH-07", programmingProfileVersion: "22", programmedChannelKeys: ["LAD-1", "LAD-4", "CB-19"] });
    // v22.20 changed this deliberately. Every gate that can be established here
    // now says yes — the channel is verified, the licence is verified and in
    // force, the truck is equipped and programmed. What is NOT established is
    // that the truck is in Alberta: the province came off the device, and a
    // tablet 5 km inside BC reporting "AB" would otherwise clear an AB-limited
    // licence. Until a boundary layer can confirm it from the coordinate, this
    // is UNKNOWN, and unknown is the correct answer rather than a false yes.
    const asserted = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, ...position });
    expect(asserted.status).toBe("unknown");
    expect(asserted.gates.find(g => g.gate === "company_authorization")!.reason).toContain("probable rather than confirmed");
    expect(asserted.gates.filter(g => g.result === "yes").map(g => g.gate)).toEqual(expect.arrayContaining(["channel_record", "service_class", "unit_capability"]));
    expect(asserted.rxMHz).toBe(154.1);

    // The same truck, the same licence, 300 km south — and the answer changes.
    const southern = await callerFor(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, latitude: 52.27, longitude: -113.8, province: "AB" });
    expect(southern.status).toBe("not_authorized");
    expect(southern.reasons.join(" ")).toContain("km south of the line");
  });
});

d("the sign on the road is the only way to posted-sign authority", () => {
  it("refuses a posted-sign assignment typed in from a desk", async () => {
    const safety = await withRole("safety");
    await callerFor(await withRole("controller")).comms.channelSeed();
    await expect(callerFor(safety).comms.assignmentRecord({ segmentId: key("SEG").slice(0, 60), channelKey: "RR-07", authorityTier: "posted_sign", sourceKey: "planning" }))
      .rejects.toThrow(/confirming a field observation/i);
  });

  it("takes a driver's photograph as a proposal, refuses self-confirmation, and on confirmation writes the assignment that outranks the map", async () => {
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const safety = await withRole("safety");
    await callerFor(controller).comms.channelSeed();
    const segmentId = key("SEG").slice(0, 60);

    await callerFor(safety).comms.assignmentRecord({ segmentId, channelKey: "RR-25", authorityTier: "planning_map", roadName: "Squamish Main", sourceKey: "bc_resource_road_maps" });

    const observation = await callerFor(driver).comms.signObserve({ observedChannelText: "RR-30", latitude: 49.8, longitude: -123.15, segmentId, roadName: "Squamish Main", photoHash: "a".repeat(64) });
    expect(observation.status).toBe("pending");
    expect(observation.candidateChannelKey).toBe("RR-30");
    expect(observation.note).toContain("governs nothing until the office confirms");

    const queue = await callerFor(safety).comms.signQueue();
    expect(queue.pending.some(p => p.observationRef === observation.observationRef)).toBe(true);

    await expect(callerFor(driver).comms.signDecide({ observationRef: observation.observationRef, decision: "confirm" })).rejects.toThrow();
    const confirmed = await callerFor(safety).comms.signDecide({ observationRef: observation.observationRef, decision: "confirm", callDirectionLoaded: "decreasing_km", mustCallKm: [5, 10, 15] });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.note).toContain("outranks any map");

    const assignments = await callerFor(safety).comms.assignmentsForSegments({ segmentIds: [segmentId] });
    const governing = assignments.assignments.find(a => a.authorityTier === "posted_sign")!;
    expect(governing.channelKey).toBe("RR-30");
    expect(governing.verificationStatus).toBe("verified");

    await expect(callerFor(safety).comms.signDecide({ observationRef: observation.observationRef, decision: "reject" })).rejects.toThrow(/already confirmed/i);
  });

  it("records an unmatched sign as written rather than guessing a channel, and will not confirm one without a channel named", async () => {
    const driver = await withRole("driver");
    const safety = await withRole("safety");
    const o = await callerFor(driver).comms.signObserve({ observedChannelText: "CHANNEL 7 HAUL", latitude: 54.4, longitude: -117.6, segmentId: key("SEG").slice(0, 60) });
    expect(o.candidateChannelKey).toBeNull();
    expect(o.note).toContain("Recorded for review as written");
    await expect(callerFor(safety).comms.signDecide({ observationRef: o.observationRef, decision: "confirm" })).rejects.toThrow(/names the channel/i);
  });
});

d("a temporary operator change governs, then hands the road back", () => {
  it("is in force only inside its window, and the earlier assignment is still there afterwards", async () => {
    const controller = await withRole("controller");
    const safety = await withRole("safety");
    await callerFor(controller).comms.channelSeed();
    const segmentId = key("SEG").slice(0, 60);
    await callerFor(safety).comms.assignmentRecord({ segmentId, channelKey: "RR-01", authorityTier: "operator_instruction", roadName: "Boss Creek FSR", sourceKey: "operator_doc" });
    const temporary = await callerFor(safety).comms.assignmentRecord({
      segmentId, channelKey: "RR-20", authorityTier: "operator_instruction", roadName: "Boss Creek FSR",
      effectiveFrom: new Date("2026-09-08"), effectiveTo: new Date("2026-09-18"), sourceKey: "operator_doc",
      sourceCitation: "Temporary change — heavy hauling activity",
    });
    expect(temporary.temporary).toBe(true);
    expect(temporary.note).toContain("the history is kept, not overwritten");

    const inWindow = await callerFor(safety).comms.planForPath({ segments: [{ segmentId, label: "Boss Creek FSR", lengthKm: 12 }], at: new Date("2026-09-12") });
    expect(inWindow.zones[0].channelKey).toBe("RR-20");
    const after = await callerFor(safety).comms.planForPath({ segments: [{ segmentId, label: "Boss Creek FSR", lengthKm: 12 }], at: new Date("2026-09-25") });
    expect(after.zones[0].channelKey).toBe("RR-01");

    const both = await callerFor(safety).comms.assignmentsForSegments({ segmentIds: [segmentId] });
    expect(both.assignments).toHaveLength(2);
  });

  it("refuses a window that ends before it begins", async () => {
    const safety = await withRole("safety");
    await callerFor(await withRole("controller")).comms.channelSeed();
    await expect(callerFor(safety).comms.assignmentRecord({ segmentId: key("SEG").slice(0, 60), channelKey: "RR-01", authorityTier: "operator_instruction", sourceKey: "operator_doc", effectiveFrom: new Date("2026-09-18"), effectiveTo: new Date("2026-09-08") }))
      .rejects.toThrow(/ends before it begins/i);
  });
});

d("the plan is persisted as evidence", () => {
  it("computes, stores and reads back a plan whose verdict is UNKNOWN while half the route has no channel", async () => {
    const controller = await withRole("controller");
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    await callerFor(controller).comms.channelSeed();
    const a = key("SEG").slice(0, 60), b = key("SEG").slice(0, 60);
    await callerFor(safety).comms.assignmentRecord({ segmentId: a, channelKey: "LAD-4", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", sourceKey: "operator_doc", callDirectionLoaded: "decreasing_km", mustCallKm: [5] });

    const plan = await callerFor(dispatcher).comms.planForPath({
      segments: [{ segmentId: a, label: "Forestry Trunk Road", lengthKm: 20 }, { segmentId: b, label: "Unnamed", lengthKm: 30 }],
      province: "AB",
    });
    expect(plan.verdict).toBe("unknown");
    expect(plan.totalKm).toBe(50);
    expect(plan.unknownChannelKm).toBe(30);
    expect(plan.zones).toHaveLength(2);
    expect(plan.mustCall.map(m => m.atKm)).toEqual([5]);
    expect(plan.blockers.map(x => x.code)).toContain("communication_plan_unknown");
    expect(plan.blockers.find(x => x.code === "communication_plan_unknown")!.severity).toBe("unknown");

    const read = await callerFor(dispatcher).comms.planGet({ planRef: plan.planRef });
    expect(read).toMatchObject({ verdict: "unknown", totalKm: 50, unknownChannelKm: 30, fingerprintHash: plan.fingerprintHash });
  });

  it("blocks instead of advising when the company's policy says an incomplete plan stops the truck", async () => {
    const dispatcher = await withRole("dispatcher");
    const plan = await callerFor(dispatcher).comms.planForPath({
      segments: [{ segmentId: key("SEG").slice(0, 60), label: "Unnamed", lengthKm: 40 }],
      policy: { unknownPlanBlocks: true, requireTransmitAuthorization: true, toleratedNoCommunicationKm: 0 },
    });
    expect(plan.blockers.find(x => x.code === "communication_plan_unknown")!.severity).toBe("blocking");
  });

  it("records a driver's dead-zone report as evidence without turning silence elsewhere into coverage", async () => {
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const segmentId = key("SEG").slice(0, 60);
    await callerFor(safety).comms.coverageRecord({ segmentId, medium: "cellular", state: "unavailable", authorityTier: "driver_observation", sourceKey: "field_observation" });
    const plan = await callerFor(dispatcher).comms.planForPath({ segments: [{ segmentId, label: "Smoky Main", lengthKm: 18 }] });
    const cell = plan.coverage.find(c => c.medium === "cellular")!;
    expect(cell.unavailableKm).toBe(18);
    expect(plan.coverage.find(c => c.medium === "satellite")!.unknownKm).toBe(18);
    expect(plan.ladder.find(l => l.level === 5)!.state).toBe("unknown");
  });
});

d("changing the channel on a road makes an approved route stale", () => {
  it("names the radio channels among what changed, and says nothing changed when nothing did", async () => {
    const controller = await withRole("controller");
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await callerFor(controller).comms.channelSeed();
    const unitId = await newUnit();
    const segmentId = key("SEG").slice(0, 60);

    await callerFor(safety).comms.assignmentRecord({ segmentId, channelKey: "RR-25", authorityTier: "planning_map", roadName: "Squamish Main", sourceKey: "bc_resource_road_maps" });

    const approval = await callerFor(dispatcher).spatial.routeApprove({
      unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId],
      dispatchStatus: "warning", explanation: "Computed over imported road data; unstated limits read UNKNOWN",
      requiredChecks: ["road_weight_restriction"], load: { grossWeightKg: 31_500, dangerousGoods: false },
    });

    const unchanged = await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });
    expect(unchanged.stale).toBe(false);

    // The driver photographs the sign; the office confirms it. The road now
    // carries RR-30 at posted-sign authority, and yesterday's approval stood on RR-25.
    const o = await callerFor(driver).comms.signObserve({ observedChannelText: "RR-30", latitude: 49.8, longitude: -123.15, segmentId, roadName: "Squamish Main" });
    await callerFor(safety).comms.signDecide({ observationRef: o.observationRef, decision: "confirm" });

    const after = await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });
    expect(after.stale).toBe(true);
    expect(after.changed).toContain("communicationsPlan");
    expect(after.reasons.join(" ")).toContain("the radio channels on the route changed");
  });
});

d("the gates are the ones the role map says they are", () => {
  it("lets a driver report a sign and read the registry, and refuses them the acts that establish facts", async () => {
    const driver = await withRole("driver");
    await callerFor(await withRole("controller")).comms.channelSeed();
    await expect(callerFor(driver).comms.channelList({ verifiedOnly: false })).resolves.toBeTruthy();
    await expect(callerFor(driver).comms.channelVerify({ channelKey: "RR-01" })).rejects.toThrow();
    await expect(callerFor(driver).comms.authorizationRecord({ channelKey: "RR-01", authorized: true })).rejects.toThrow();
    await expect(callerFor(driver).comms.assignmentRecord({ segmentId: key("SEG").slice(0, 60), channelKey: "RR-01", authorityTier: "planning_map", sourceKey: "map" })).rejects.toThrow();
  });

  it("refuses an authorization for a channel that is not in the registry", async () => {
    const controller = await withRole("controller");
    await expect(callerFor(controller).comms.authorizationRecord({ channelKey: "NOT-A-CHANNEL", authorized: true })).rejects.toThrow(/not a channel|No channel/i);
  });
});
