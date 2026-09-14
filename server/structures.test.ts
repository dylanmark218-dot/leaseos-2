/**
 * v22.15 — Structures, effective-dated restrictions, route staleness.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { DEPENDENCY_LABELS, applicableRestrictions, fingerprintHash, hashPart, inForce, loadFingerprint, stalenessAgainst, structureAttributes, windowState, type RouteDependencies, type StructureLike } from "./_core/structures";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const d1 = (s: string) => new Date(`${s}T00:00:00Z`);
const restriction = (o: Partial<{ id: number; restrictionRef: string; checkKey: string; verificationStatus: "unverified" | "verified"; effectiveFrom: Date | null; effectiveTo: Date | null; limitValue: number | null }>) =>
  ({ id: 1, restrictionRef: "R-1", checkKey: "road_weight_restriction", verificationStatus: "verified" as const, effectiveFrom: null, effectiveTo: null, limitValue: 29_000, ...o });

describe("a restriction applies on a date, or it does not apply at all", () => {
  it("reads the window it has always carried — a ban that ended is not in force, one that starts in March is not in force in January", () => {
    const spring = { effectiveFrom: d1("2026-03-01"), effectiveTo: d1("2026-06-01") };
    expect(windowState(spring, d1("2026-01-15"))).toBe("not_yet_in_force");
    expect(windowState(spring, d1("2026-04-15"))).toBe("in_force");
    expect(windowState(spring, d1("2026-06-01"))).toBe("expired");            // the end is exclusive: the ban is off on the 1st
    expect(windowState(spring, d1("2026-09-10"))).toBe("expired");
    expect(windowState({}, d1("2026-09-10"))).toBe("always");
    expect(inForce({ effectiveFrom: d1("2026-01-01") }, d1("2026-09-10"))).toBe(true);
    expect(inForce(spring, d1("2026-09-10"))).toBe(false);
  });
  it("applies the verified row over the unverified, the latest within each, and sets aside what the window excludes — naming it", () => {
    const rows = [
      restriction({ id: 1, restrictionRef: "R-OLD", limitValue: 20_000, ...{ effectiveFrom: d1("2026-03-01"), effectiveTo: d1("2026-06-01") } }),
      restriction({ id: 2, restrictionRef: "R-UNVERIFIED", verificationStatus: "unverified", limitValue: 25_000 }),
      restriction({ id: 3, restrictionRef: "R-CURRENT", limitValue: 29_000 }),
      restriction({ id: 4, restrictionRef: "R-FUTURE", limitValue: 15_000, effectiveFrom: d1("2027-03-01") }),
      restriction({ id: 5, restrictionRef: "R-OTHER", checkKey: "bridge_clearance", limitValue: 4 }),
    ];
    const { applied, setAside } = applicableRestrictions(rows, d1("2026-09-10"));
    expect(applied.map(r => r.restrictionRef).sort()).toEqual(["R-CURRENT", "R-OTHER"]);   // one per check, verified over unverified
    expect(setAside.map(x => `${x.row.restrictionRef}:${x.state}`).sort()).toEqual(["R-FUTURE:not_yet_in_force", "R-OLD:expired"]);
    const inSpring = applicableRestrictions(rows, d1("2026-04-15"));
    expect(inSpring.applied.find(r => r.checkKey === "road_weight_restriction")!.limitValue).toBe(20_000);   // the spring ban is the more restrictive of the two in force, so it governs
    const permissiveLater = applicableRestrictions([restriction({ id: 9, restrictionRef: "R-LATER", limitValue: 40_000 }), restriction({ id: 1, restrictionRef: "R-TIGHT", limitValue: 12_000 })], d1("2026-09-10"));
    expect(permissiveLater.applied[0].restrictionRef).toBe("R-TIGHT");                     // never the more permissive just because it was recorded later
  });
});

const structure = (o: Partial<StructureLike> = {}): StructureLike => ({
  structureRef: "STR-1", kind: "bridge", label: "Wildhay River bridge", jurisdiction: "CA-AB",
  clearanceM: null, postedWeightKg: null, postedAxleGroupKg: null, ratedWeightKg: null, widthM: null, seasonalVariation: null,
  source: "Yellowhead County posted sign", sourceVersion: null, verificationStatus: "verified", verifiedAt: d1("2026-08-01"), effectiveFrom: null, effectiveTo: null, ...o,
});

describe("a structure contributes what the road does not state", () => {
  it("treats a posted limit as the limit and a rated capacity as engineering data, not a permission", () => {
    const posted = structureAttributes(structure({ postedWeightKg: 29_000, clearanceM: 4.2 }), d1("2026-09-10"));
    expect(posted.attributes.map(a => `${a.check}:${a.limitValue}`).sort()).toEqual(["bridge_capacity:29000", "bridge_clearance:4.2"]);
    expect(posted.attributes.every(a => a.confidence === "authority_confirmed")).toBe(true);
    const ratedOnly = structureAttributes(structure({ ratedWeightKg: 63_500 }), d1("2026-09-10"));
    expect(ratedOnly.attributes.map(a => a.check)).not.toContain("bridge_capacity");        // nothing posted: capacity stays UNKNOWN
    expect(ratedOnly.notes[0]).toContain("engineering data is not a posted limit");
    const overhead = structureAttributes(structure({ kind: "overhead", clearanceM: 4.15 }), d1("2026-09-10"));
    expect(overhead.attributes[0].check).toBe("overhead_clearance");
    const unverified = structureAttributes(structure({ postedWeightKg: 29_000, verificationStatus: "unverified", verifiedAt: null }), d1("2026-09-10"));
    expect(unverified.attributes[0].confidence).toBe("operator_supplied");
    expect(unverified.notes.some(n => n.includes("not authority"))).toBe(true);
    expect(structureAttributes(structure({ postedWeightKg: 29_000, verificationStatus: "superseded" }), d1("2026-09-10")).attributes).toEqual([]);
    const outOfWindow = structureAttributes(structure({ postedWeightKg: 29_000, effectiveFrom: d1("2027-01-01") }), d1("2026-09-10"));
    expect(outOfWindow.attributes).toEqual([]);
    expect(outOfWindow.notes[0]).toContain("not yet in force");
  });
});

describe("an approved route knows when it has gone stale", () => {
  const base: RouteDependencies = { vehicleProfile: "a", loadProfile: "b", permitSet: "c", restrictionSet: "d", structureSet: "e", roadFabric: "f", requiredChecks: "g" };
  it("names what changed in the words a dispatcher would use, and says nothing changed when nothing did", () => {
    expect(stalenessAgainst(base, { ...base })).toEqual({ stale: false, changed: [], reasons: [] });
    const heavier = stalenessAgainst(base, { ...base, loadProfile: "b2" });
    expect(heavier).toMatchObject({ stale: true, changed: ["loadProfile"] });
    expect(heavier.reasons[0]).toBe("the load changed since this route was approved");
    const several = stalenessAgainst(base, { ...base, restrictionSet: "d2", roadFabric: "f2" });
    expect(several.changed).toEqual(["restrictionSet", "roadFabric"]);
    expect(several.reasons).toEqual(["the restrictions in force changed since this route was approved", "the imported road data changed since this route was approved"]);
    expect(Object.keys(DEPENDENCY_LABELS).sort()).toEqual(Object.keys(base).sort());
    expect(fingerprintHash(base)).toBe(fingerprintHash({ ...base }));
    expect(fingerprintHash(base)).not.toBe(fingerprintHash({ ...base, permitSet: "c2" }));
    expect(hashPart({ b: 1, a: [d1("2026-01-01")] })).toBe(hashPart({ a: ["2026-01-01T00:00:00.000Z"], b: 1 }));
    expect(loadFingerprint({ grossWeightKg: 28_000, dangerousGoods: false })).not.toBe(loadFingerprint({ grossWeightKg: 34_000, dangerousGoods: false }));
    expect(loadFingerprint({ grossWeightKg: 28_000, dangerousGoods: false })).not.toBe(loadFingerprint({ grossWeightKg: 28_000, dangerousGoods: true }));
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 5_900_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("structures and route staleness through the database", () => {
  it("records a structure, verifies it by a second person, and lets its posted limit block a heavy unit — while an expired ban does not", async () => {
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const shop = await withRole("shop_lead");
    const shopLead2 = await withRole("shop_lead");
    const segmentId = key("SEG").slice(0, 60);
    const [unit] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'due', 'review', NOW())", [key("U").slice(0, 20)]);
    const unitId = Number(unit.insertId);
    await callerFor(shop).spatial.vehicleProfileSet({ unitId, heightM: 4.15, widthM: 2.6, lengthM: 27.5, emptyWeightKg: 24_000, axleGroups: [{ name: "steer", axles: 1, emptyKg: 6_000, loadedKg: 7_500 }, { name: "drive", axles: 3, emptyKg: 9_000, loadedKg: 24_000 }, { name: "trailer", axles: 3, emptyKg: 9_000, loadedKg: 32_000 }], source: "shop_measured" });
    await callerFor(shopLead2).spatial.vehicleProfileVerify({ unitId });
    // an expired spring ban and a structure posted below the unit's weight
    const expired = await callerFor(dispatcher).spatial.restrictionRecord({ jurisdiction: "CA-AB", roadRef: "TWP RD 543", segmentId, segmentLabel: "TWP RD 543", check: "road_weight_restriction", limitValue: 9_000, unit: "kg", source: "Spring road ban 2026", effectiveFrom: new Date("2026-03-01T00:00:00Z"), effectiveTo: new Date("2026-06-01T00:00:00Z") });
    await callerFor(safety).spatial.restrictionVerify({ restrictionRef: expired.restrictionRef, sourceDocumentEvidenceId: 1 });
    const st = await callerFor(dispatcher).spatial.structureRecord({ kind: "bridge", label: "Wildhay crossing", jurisdiction: "CA-AB", segmentId, latitude: 53.68, longitude: -116.52, postedWeightKg: 29_000, clearanceM: 4.3, source: "Yellowhead County posted sign", sourceVersion: "2026-07" });
    expect(st.verificationStatus).toBe("unverified");
    await expect(callerFor(dispatcher).spatial.structureVerify({ structureRef: st.structureRef })).rejects.toThrow(/a second person does/);
    await callerFor(safety).spatial.structureVerify({ structureRef: st.structureRef });
    const ratedOnly = await callerFor(dispatcher).spatial.structureRecord({ kind: "bridge", label: "Rated only", jurisdiction: "CA-AB", segmentId: key("SEG2").slice(0, 60), latitude: 53.6, longitude: -116.5, ratedWeightKg: 63_500, source: "engineering report" });
    expect(ratedOnly.note).toContain("engineering data");
    await expect(callerFor(dispatcher).spatial.structureRecord({ kind: "bridge", label: "Nothing posted", jurisdiction: "CA-AB", latitude: 53.6, longitude: -116.5, source: "a photograph" })).rejects.toThrow(/states no limit/);
    // evaluated in September: the ban is expired and said so; the posted bridge limit governs and the loaded unit exceeds it
    const sept = await callerFor(dispatcher).spatial.routeEvaluateSegments({ unitId, at: new Date("2026-09-10T00:00:00Z"), segments: [{ segmentId, label: "TWP RD 543", lengthKm: 12 }], requiredChecks: ["road_weight_restriction", "bridge_capacity", "bridge_clearance"] });
    expect(sept.dateNotes.some((n: string) => n.includes("expired") && n.includes("road weight restriction"))).toBe(true);
    expect(sept.dispatchStatus).toBe("blocked");                                        // 63,500 kg over a posted 29,000 kg bridge
    expect(sept.explanation).toContain("29000");
    // the same segments in April: the spring ban is in force and blocks at 9,000 kg
    const april = await callerFor(dispatcher).spatial.routeEvaluateSegments({ unitId, at: new Date("2026-04-15T00:00:00Z"), segments: [{ segmentId, label: "TWP RD 543", lengthKm: 12 }], requiredChecks: ["road_weight_restriction"] });
    expect(april.dispatchStatus).toBe("blocked");
    expect(april.dateNotes.filter((n: string) => n.includes("road weight restriction"))).toHaveLength(0);   // in April it applies, so nothing is set aside
  });

  it("approves a route with its dependency fingerprint and turns it stale when the load, a restriction or a structure changes", async () => {
    const dispatcher = await withRole("dispatcher");
    const safety = await withRole("safety");
    const shop = await withRole("shop_lead");
    const shopLead2 = await withRole("shop_lead");
    const segmentId = key("SEG").slice(0, 60);
    const [unit] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'due', 'review', NOW())", [key("U").slice(0, 20)]);
    const unitId = Number(unit.insertId);
    await callerFor(shop).spatial.vehicleProfileSet({ unitId, heightM: 4.15, widthM: 2.6, lengthM: 27.5, emptyWeightKg: 24_000, axleGroups: [{ name: "steer", axles: 1, emptyKg: 6_000, loadedKg: 7_500 }], source: "shop_measured" });
    const approval = await callerFor(dispatcher).spatial.routeApprove({
      unitId, originRef: "Hinton Yard", destinationRef: "01-24-054-18-W5", segmentIds: [segmentId], dispatchStatus: "review",
      explanation: "Reviewed: gravel throughout, bridge clearance unknown", requiredChecks: ["road_weight_restriction", "bridge_clearance"],
      load: { grossWeightKg: 28_000, dangerousGoods: false }, permitRefs: [],
    });
    expect(approval.status).toBe("approved");
    expect(approval.dependencies.sort()).toEqual(["loadProfile", "permitSet", "requiredChecks", "restrictionSet", "roadFabric", "structureSet", "vehicleProfile"]);
    const fresh = await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });
    expect(fresh).toMatchObject({ stale: false, status: "approved" });
    expect(fresh.reasons[0]).toBe("Nothing this route depended on has changed");
    // a restriction appears on one of its segments
    const r = await callerFor(dispatcher).spatial.restrictionRecord({ jurisdiction: "CA-AB", roadRef: "TWP RD 543", segmentId, segmentLabel: "TWP RD 543", check: "road_weight_restriction", limitValue: 26_000, unit: "kg", source: "County bylaw 2026-14" });
    await callerFor(safety).spatial.restrictionVerify({ restrictionRef: r.restrictionRef, sourceDocumentEvidenceId: 1 });
    const afterRestriction = await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });
    expect(afterRestriction.stale).toBe(true);
    expect(afterRestriction.changed).toContain("restrictionSet");
    expect(afterRestriction.reasons).toContain("the restrictions in force changed since this route was approved");
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, staleReasonsJson FROM routeApprovals WHERE approvalRef = ?", [approval.approvalRef]);
    expect(row[0].status).toBe("stale");                                                 // the check records what it found
    expect(JSON.parse(row[0].staleReasonsJson)).toContain("the restrictions in force changed since this route was approved");
    // a blocked route is never approved
    await expect(callerFor(dispatcher).spatial.routeApprove({ unitId, originRef: "Hinton Yard", destinationRef: "01-24-054-18-W5", segmentIds: [segmentId], dispatchStatus: "blocked", explanation: "Bridge below GVW", requiredChecks: ["road_weight_restriction"], load: { grossWeightKg: 28_000, dangerousGoods: false } })).rejects.toThrow(/blocked route is not approved/);
    // a heavier load is a different question: its fingerprint differs from the approved one
    const heavier = await callerFor(dispatcher).spatial.routeApprove({ unitId, originRef: "Hinton Yard", destinationRef: "01-24-054-18-W5", segmentIds: [segmentId], dispatchStatus: "review", explanation: "Reloaded", requiredChecks: ["road_weight_restriction", "bridge_clearance"], load: { grossWeightKg: 34_000, dangerousGoods: false } });
    expect(heavier.fingerprintHash).not.toBe(approval.fingerprintHash);
  });
});
