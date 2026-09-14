/**
 * v22.19 — The offline communication package.
 *
 * The thing being proven is not that a bundle can be produced. It is that the
 * bundle tells a driver the truth about itself when nobody can be asked, that
 * it does not change underneath them, and that dispatch can see what is in the
 * field.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  STANDING_NOTICE, canonical, carriedState, dependencyHash, hashOf,
  packageDependencies, packageStaleness, sealCommunicationPackage,
} from "./_core/commPackage";
import { planCommunications, type CoverageObservation, type RadioChannel, type RoadRadioAssignment, type UnitRadioCapability } from "./_core/commRoute";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const at = new Date("2026-09-11T12:00:00Z");
const channel = (o: Partial<RadioChannel> = {}): RadioChannel => ({
  channelKey: "LAD-4", alias: "LADD 4 — 173.370 MHz", serviceClass: "land_mobile_b1", systemType: "simplex",
  rxMHz: 173.37, txMHz: 173.37, licenceRequired: true, conditions: [],
  sourceKey: "ised_b1_western", sourceCitation: "ISED B1", verificationStatus: "verified", ...o,
});
const assignment = (o: Partial<RoadRadioAssignment> = {}): RoadRadioAssignment => ({
  assignmentRef: "A-1", segmentId: "S-1", channelKey: "LAD-4", authorityTier: "operator_instruction",
  roadName: "Forestry Trunk Road", verificationStatus: "verified", ...o,
});
const unit: UnitRadioCapability = { unitId: 1, vhf: true, uhf: false, cb: true, satellite: false, cellular: true, programmingProfileRef: "AB-NORTH-07", programmedChannelKeys: ["LAD-4", "RR-07"], verificationStatus: "verified" };
const licensed = (channelKey: string) => ({ channelKey, authorized: true, licenceRef: "L-1", licenceExpiresAt: new Date("2027-01-01"), verificationStatus: "verified" as const });

const path = [
  { segmentId: "S-1", label: "Forestry Trunk Road", lengthKm: 20 },
  { segmentId: "S-2", label: "Unnamed", lengthKm: 10 },
];
const plan = (o: { assignments?: RoadRadioAssignment[]; channels?: RadioChannel[]; coverage?: CoverageObservation[] } = {}) =>
  planCommunications({
    path, assignments: o.assignments ?? [assignment()], channels: o.channels ?? [channel()],
    coverage: o.coverage, companyAuthorizations: [licensed("LAD-4")], unit, province: "AB", at,
  });

/* ------------------------------------------------------------------ */

describe("the package says what it does not contain", () => {
  it("names the unverified channels by key, because offline nobody can be asked", () => {
    const sealed = sealCommunicationPackage({ plan: plan({ channels: [channel({ verificationStatus: "unverified" })] }), channels: [channel({ verificationStatus: "unverified" })], assignments: [assignment()] });
    const caveat = sealed.content.caveats.find(c => c.includes("unverified"))!;
    expect(caveat).toContain("LAD-4");
    expect(caveat).toContain("Treat the posted sign as the answer");
    expect(sealed.counts.unverifiedChannels).toBe(1);
  });

  it("says the kilometres with no channel are not known rather than not needed", () => {
    const sealed = sealCommunicationPackage({ plan: plan(), channels: [channel()], assignments: [assignment()] });
    expect(sealed.content.caveats.some(c => c.includes('not "no radio needed"'))).toBe(true);
    expect(sealed.counts.zonesWithoutChannel).toBe(1);
  });

  it("distinguishes no cellular data from no cellular service", () => {
    const sealed = sealCommunicationPackage({ plan: plan(), channels: [channel()], assignments: [assignment()] });
    expect(sealed.content.caveats.some(c => c.includes("Absence of data is not absence of service"))).toBe(true);
  });

  it("carries the standing safety notice on every package, including a complete one", () => {
    const full: CoverageObservation[] = path.flatMap(s => (["cellular", "satellite", "radio"] as const).map(medium => ({ segmentId: s.segmentId, medium, state: "available" as const, sourceKey: "crtc_coverage", authorityTier: "regulatory_authority" as const, verificationStatus: "verified" as const })));
    const complete = plan({ assignments: [assignment(), assignment({ assignmentRef: "A-2", segmentId: "S-2" })], coverage: full });
    const sealed = sealCommunicationPackage({ plan: complete, channels: [channel()], assignments: [], coverage: full });
    expect(complete.verdict).toBe("covered");
    expect(sealed.content.caveats).toEqual(["Every channel on this route is verified, authorized and carried. The posted sign still governs."]);
    expect(sealed.content.standingNotice).toBe(STANDING_NOTICE);
    expect(sealed.content.standingNotice).toContain("Do not rely on radio communication alone");
  });
});

describe("what travels, and what does not", () => {
  it("carries only the channels this route names — not the whole bank", () => {
    const bank = [channel(), channel({ channelKey: "RR-07", alias: "RR-07" }), channel({ channelKey: "CB-19", alias: "CB 19" })];
    const sealed = sealCommunicationPackage({ plan: plan({ channels: bank }), channels: bank, assignments: [assignment()] });
    // Shipping 99 frequencies to drive one road invites selecting one that does
    // not belong to it.
    expect(sealed.content.channels.map(c => c.channelKey)).toEqual(["LAD-4"]);
  });

  it("leaves a retired service out entirely rather than carrying it with a warning", () => {
    const retired = channel({ serviceStatus: "retired", retiredNote: "No longer in service" });
    const sealed = sealCommunicationPackage({ plan: plan({ channels: [retired] }), channels: [retired], assignments: [assignment()] });
    expect(sealed.content.channels).toHaveLength(0);
    expect(sealed.counts.retiredExcluded).toBe(1);
    expect(sealed.content.caveats.some(c => c.includes("retired services and were left out"))).toBe(true);
  });

  it("keeps each channel's transmit answer and its reason beside the frequency, never apart from it", () => {
    const sealed = sealCommunicationPackage({ plan: plan({ channels: [channel({ verificationStatus: "unverified" })] }), channels: [channel({ verificationStatus: "unverified" })], assignments: [assignment()] });
    const c = sealed.content.channels[0];
    expect(c.transmit).toBe("unknown");
    expect(c.transmitReasons.join(" ")).toContain("not yet checked against it by a person");
    expect(c.rxMHz).toBe(173.37);
  });

  it("carries the operator's calling convention and the must-call points", () => {
    const withCalls = assignment({ callDirectionLoaded: "decreasing_km", callIntervalKm: 5, mustCallKm: [5, 10, 15] });
    const sealed = sealCommunicationPackage({ plan: plan({ assignments: [withCalls] }), channels: [channel()], assignments: [withCalls] });
    expect(sealed.content.zones[0].callDirectionLoaded).toBe("decreasing_km");
    expect(sealed.content.mustCall.map(m => m.atKm)).toEqual([5, 10, 15]);
    expect(sealed.counts.mustCall).toBe(3);
  });
});

describe("the manifest hash is the package", () => {
  it("hashes the same facts the same way twice, in any key order", () => {
    expect(hashOf({ b: 1, a: [new Date("2026-01-01T00:00:00Z")] })).toBe(hashOf({ a: ["2026-01-01T00:00:00.000Z"], b: 1 }));
    expect(canonical({ z: 1, a: 2 })).toEqual({ a: 2, z: 1 });
  });

  it("moves when anything a driver would act on moves, and not when nothing does", () => {
    const base = sealCommunicationPackage({ plan: plan(), channels: [channel()], assignments: [assignment()] });
    const same = sealCommunicationPackage({ plan: plan(), channels: [channel()], assignments: [assignment()] });
    expect(base.manifestHash).toBe(same.manifestHash);
    const different = sealCommunicationPackage({ plan: plan({ assignments: [assignment({ channelKey: "RR-07" })], channels: [channel(), channel({ channelKey: "RR-07", alias: "RR-07" })] }), channels: [channel(), channel({ channelKey: "RR-07", alias: "RR-07" })], assignments: [assignment({ channelKey: "RR-07" })] });
    expect(different.manifestHash).not.toBe(base.manifestHash);
  });
});

describe("a package goes stale by arithmetic", () => {
  const segmentIds = ["S-1", "S-2"];
  const sealedDeps = packageDependencies({ segmentIds, assignments: [assignment()], channels: [channel()] });

  it("says nothing changed when nothing did", () => {
    const s = packageStaleness(sealedDeps, packageDependencies({ segmentIds, assignments: [assignment()], channels: [channel()] }));
    expect(s).toEqual({ stale: false, changed: [], reasons: [] });
    expect(dependencyHash(sealedDeps)).toBe(dependencyHash(sealedDeps));
  });

  it("names the channels on these roads when a sign is confirmed — and only that", () => {
    // Recomputed over the keys the package carried, so a new assignment does not
    // also report a corrected frequency that never happened.
    const s = packageStaleness(sealedDeps, packageDependencies({ segmentIds, assignments: [assignment({ assignmentRef: "A-SIGN", channelKey: "RR-30", authorityTier: "posted_sign" })], channels: [channel()], channelKeys: ["LAD-4"] }));
    expect(s.changed).toEqual(["assignments"]);
    expect(s.reasons[0]).toContain("the channels assigned to these roads changed");
  });

  it("names the channel records when a frequency is corrected or a service retires", () => {
    expect(packageStaleness(sealedDeps, packageDependencies({ segmentIds, assignments: [assignment()], channels: [channel({ rxMHz: 173.375 })] })).changed).toEqual(["channelRecords"]);
    expect(packageStaleness(sealedDeps, packageDependencies({ segmentIds, assignments: [assignment()], channels: [channel({ serviceStatus: "retired" })] })).changed).toEqual(["channelRecords"]);
  });

  it("ignores a channel record this route never names", () => {
    // The whole bank moving is not this package's problem; only what it carries is.
    const s = packageStaleness(sealedDeps, packageDependencies({ segmentIds, assignments: [assignment()], channels: [channel(), channel({ channelKey: "CB-19", rxMHz: 27.185 })] }));
    expect(s.stale).toBe(false);
  });

  it("names coverage when a driver reports a dead zone", () => {
    const s = packageStaleness(sealedDeps, packageDependencies({ segmentIds, assignments: [assignment()], channels: [channel()], coverage: [{ segmentId: "S-1", medium: "cellular", state: "unavailable", sourceKey: "field", authorityTier: "driver_observation", verificationStatus: "unverified" }] }));
    expect(s.changed).toEqual(["coverage"]);
  });
});

describe("behind and stale are different facts", () => {
  it("separates carrying an older package from carrying the latest one that is out of date", () => {
    expect(carriedState({ carriedManifestHash: null, currentManifestHash: "a", currentIsStale: false }).state).toBe("none");
    expect(carriedState({ carriedManifestHash: "old", currentManifestHash: "new", currentIsStale: false }).state).toBe("behind");
    // The case dispatch most needs: the driver has the latest, and the latest is wrong.
    const stale = carriedState({ carriedManifestHash: "a", currentManifestHash: "a", currentIsStale: true });
    expect(stale.state).toBe("stale");
    expect(stale.note).toContain("rebuild it before departure");
    expect(carriedState({ carriedManifestHash: "a", currentManifestHash: "a", currentIsStale: false }).state).toBe("current");
  });
});

/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 7_300_000 + Math.floor(Math.random() * 50_000);
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = userSeq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("building, carrying and refreshing a package", () => {
  it("builds, hands it to a driver, and refuses to call it carried when the device stored something else", async () => {
    const controller = await withRole("controller");
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await callerFor(controller).comms.channelSeed();
    // Establish the precondition. Another file's test verifies LAD-4 against its
    // citation, and this one is about what an *unverified* seed does.
    await pool.execute("UPDATE radioChannels SET verificationStatus = 'unverified', verifiedByUserId = NULL, verifiedAt = NULL WHERE channelKey = 'LAD-4'");
    const segmentId = key("SEG").slice(0, 60);
    const label = key("Route");
    await callerFor(safety).comms.assignmentRecord({ segmentId, channelKey: "LAD-4", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", sourceKey: "operator_doc", callDirectionLoaded: "decreasing_km", mustCallKm: [5, 10] });

    const built = await callerFor(dispatcher).comms.packageBuild({ label, segments: [{ segmentId, label: "Forestry Trunk Road", lengthKm: 18 }], province: "AB" });
    expect(built.version).toBe(1);
    expect(built.counts.channels).toBe(1);
    expect(built.counts.unverifiedChannels).toBe(1);      // seeded and unverified, and the package says so
    expect(built.caveats.some(c => c.includes("unverified"))).toBe(true);

    const fetched = await callerFor(driver).comms.packageFetch({ label, deviceRef: "TAB-118" });
    expect(fetched.manifestHash).toBe(built.manifestHash);
    expect(fetched.content.standingNotice).toContain("posted on the road governs");
    expect(fetched.content.mustCall.map((m: { atKm: number }) => m.atKm)).toEqual([5, 10]);

    await expect(callerFor(driver).comms.packageAcknowledge({ downloadRef: fetched.downloadRef, manifestHash: "0".repeat(64) })).rejects.toThrow(/download is incomplete/i);
    await expect(callerFor(dispatcher).comms.packageAcknowledge({ downloadRef: fetched.downloadRef, manifestHash: fetched.manifestHash })).rejects.toThrow(/person who took it/i);
    const ack = await callerFor(driver).comms.packageAcknowledge({ downloadRef: fetched.downloadRef, manifestHash: fetched.manifestHash });
    expect(ack.acknowledged).toBe(true);

    const status = await callerFor(dispatcher).comms.packageStatus({ label });
    expect(status.stale).toBe(false);
    expect(status.carriedBy).toHaveLength(1);
    expect(status.carriedBy[0]).toMatchObject({ userId: driver, deviceRef: "TAB-118", acknowledged: true, state: "current" });
  });

  it("goes stale when a driver's sign is confirmed, and says so to the next driver who fetches it", async () => {
    const controller = await withRole("controller");
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const driver2 = await withRole("driver");
    await callerFor(controller).comms.channelSeed();
    const segmentId = key("SEG").slice(0, 60);
    const label = key("Route");
    await callerFor(safety).comms.assignmentRecord({ segmentId, channelKey: "RR-25", authorityTier: "planning_map", roadName: "Squamish Main", sourceKey: "bc_resource_road_maps" });
    const built = await callerFor(dispatcher).comms.packageBuild({ label, segments: [{ segmentId, label: "Squamish Main", lengthKm: 22 }], province: "BC" });
    const carried = await callerFor(driver).comms.packageFetch({ label, deviceRef: "TAB-204" });
    await callerFor(driver).comms.packageAcknowledge({ downloadRef: carried.downloadRef, manifestHash: carried.manifestHash });

    const o = await callerFor(driver2).comms.signObserve({ observedChannelText: "RR-30", latitude: 49.8, longitude: -123.15, segmentId, roadName: "Squamish Main" });
    await callerFor(safety).comms.signDecide({ observationRef: o.observationRef, decision: "confirm" });

    const status = await callerFor(dispatcher).comms.packageStatus({ label });
    expect(status.stale).toBe(true);
    expect(status.changed).toContain("assignments");
    expect(status.reasons[0]).toContain("the channels assigned to these roads changed");
    // The driver holds the latest package, and the latest package is wrong.
    expect(status.carriedBy[0].state).toBe("stale");
    expect(status.carriedBy[0].note).toContain("rebuild it before departure");

    const refetch = await callerFor(driver).comms.packageFetch({ label });
    expect(refetch.warning).toContain("Rebuild before departure");

    const rebuilt = await callerFor(dispatcher).comms.packageBuild({ label, segments: [{ segmentId, label: "Squamish Main", lengthKm: 22 }], province: "BC" });
    expect(rebuilt.version).toBe(2);
    expect(rebuilt.supersedes).toBe(built.packageRef);
    expect(rebuilt.manifestHash).not.toBe(built.manifestHash);
    const after = await callerFor(dispatcher).comms.packageStatus({ label });
    expect(after.packageRef).toBe(rebuilt.packageRef);
    expect(after.stale).toBe(false);
    expect(after.carriedBy).toHaveLength(0);          // nobody has taken the new one yet
    await expect(callerFor(driver).comms.packageFetch({ packageRef: built.packageRef })).rejects.toThrow(/superseded/i);
  });

  it("refuses to hand out a package for a route nobody has built one for", async () => {
    const driver = await withRole("driver");
    await expect(callerFor(driver).comms.packageFetch({ label: key("Nothing") })).rejects.toThrow(/build one before departure/i);
    await expect(callerFor(driver).comms.packageFetch({})).rejects.toThrow(/Name the package/i);
  });

  it("lets a driver fetch and not build — carrying a package is not authoring one", async () => {
    const driver = await withRole("driver");
    await expect(callerFor(driver).comms.packageBuild({ label: key("Route"), segments: [{ segmentId: key("SEG").slice(0, 60), label: "x", lengthKm: 5 }] })).rejects.toThrow();
  });
});

describe("v22.20 — geometry is a dependency, and route order is part of the route", () => {
  it("makes a package stale when only the road's geometry changed", () => {
    // The segment id, the assignment, the frequency record and the coverage are
    // all identical. A survey correction moved a node, which is the fact the
    // radio answer actually stood on.
    const base = { segmentIds: ["SEG-1", "SEG-2"], assignments: [], channels: [] };
    const before = packageDependencies({ ...base, geographyHash: "geo-aaa" });
    const after = packageDependencies({ ...base, geographyHash: "geo-bbb" });
    const s = packageStaleness(before, after);
    expect(s.stale).toBe(true);
    expect(s.changed).toEqual(["geography"]);
    expect(s.reasons.join(" ")).toContain("road geometry or jurisdiction");
  });

  it("makes a package sealed before geography existed stale against one built with it", () => {
    const legacy = packageDependencies({ segmentIds: ["SEG-1"], assignments: [], channels: [] });
    const now = packageDependencies({ segmentIds: ["SEG-1"], assignments: [], channels: [], geographyHash: "geo-aaa" });
    expect(packageStaleness(legacy, now).changed).toEqual(["geography"]);
  });

  it("treats a reversed route as a different route", () => {
    // Sorting the ids made an out-and-back and its reverse the same dependency.
    const forward = packageDependencies({ segmentIds: ["SEG-1", "SEG-2", "SEG-3"], assignments: [], channels: [] });
    const reverse = packageDependencies({ segmentIds: ["SEG-3", "SEG-2", "SEG-1"], assignments: [], channels: [] });
    expect(forward.segments).not.toBe(reverse.segments);
    expect(packageStaleness(forward, reverse).changed).toEqual(["segments"]);
  });
});
