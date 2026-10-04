/**
 * T2 — defects 1B, 2, 3 and 4, through the real procedures against a real database.
 *
 *   1B  the router must hand the evaluator every applicable limit — it used to drop a structure's
 *       limit whenever a road restriction already covered the same check.
 *   2   an approval's route verdict comes from the stored evaluation, never from the caller.
 *   3   FAIL and UNKNOWN are judged on the evaluation being approved: an old FAIL on the same
 *       segments stays in the audit trail without blocking a newer passing evaluation, a current
 *       FAIL refuses approval, and a current UNKNOWN can never be stored as a clean pass.
 *   4   a recheck must not claim to have refreshed permit state: permit references are free text
 *       (no permit record exists — D-01), so they are carried as given and SAID to be carried.
 *
 * Written against the untouched baseline (main @ c3f088b), where each of these failed for the
 * reason its name gives; the captured failures are in
 * docs/transport/checkpoints/T2_COMMERCIAL_ROUTE_LEGALITY.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { composeReadiness } from "./readinessComposer";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;

describe("route legality defects — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped route-legality suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 936_000_000 + Math.floor(Math.random() * 50_000);
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = userSeq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

type Cast = { dispatcher: number; safety: number; shop: number; shop2: number };
async function cast(): Promise<Cast> {
  return { dispatcher: await withRole("dispatcher"), safety: await withRole("safety"), shop: await withRole("shop_lead"), shop2: await withRole("shop_lead") };
}
async function newUnit() {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
  return Number(u.insertId);
}
/** A measured, second-person-verified profile. `loadedKg` per group is what the route evaluates. */
async function profile(c: Cast, unitId: number, p: { heightM?: number; steerKg?: number; driveKg?: number }) {
  await callerFor(c.shop).spatial.vehicleProfileSet({
    unitId, heightM: p.heightM ?? 4.0, widthM: 2.6, lengthM: 20, emptyWeightKg: 12_000, source: "shop_measured",
    axleGroups: [{ name: "steer", axles: 1, emptyKg: 5_000, loadedKg: p.steerKg ?? 6_000 }, { name: "drive", axles: 2, emptyKg: 7_000, loadedKg: p.driveKg ?? 14_000 }],
  });
  await callerFor(c.shop2).spatial.vehicleProfileVerify({ unitId });
}
async function restriction(c: Cast, segmentId: string, check: "road_weight_restriction" | "overhead_clearance", limitValue: number, unit: string) {
  const r = await callerFor(c.dispatcher).spatial.restrictionRecord({ jurisdiction: "CA-AB", roadRef: "Fixture Rd", segmentId, segmentLabel: "Fixture Rd", check, limitValue, unit, source: "fixture posting" });
  await callerFor(c.safety).spatial.restrictionVerify({ restrictionRef: r.restrictionRef, sourceDocumentEvidenceId: 1 });
  return r.restrictionRef;
}
const evaluate = (c: Cast, unitId: number, segmentId: string, requiredChecks: ("road_weight_restriction" | "overhead_clearance")[]) =>
  callerFor(c.dispatcher).spatial.routeEvaluateSegments({ unitId, segments: [{ segmentId, label: "Fixture Rd", lengthKm: 5 }], requiredChecks });
const approve = (c: Cast, unitId: number, segmentId: string, over: { dispatchStatus: string; evaluationRef?: string; permitRefs?: string[]; requiredChecks?: string[] }) =>
  callerFor(c.dispatcher).spatial.routeApprove({
    unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [segmentId], explanation: "fixture approval",
    requiredChecks: over.requiredChecks ?? ["road_weight_restriction"], load: { grossWeightKg: 20_000, dangerousGoods: false },
    dispatchStatus: over.dispatchStatus, evaluationRef: over.evaluationRef, permitRefs: over.permitRefs ?? [],
  });
async function storedStatus(approvalRef: string) {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT dispatchStatus FROM routeApprovals WHERE approvalRef = ?", [approvalRef]);
  return rows[0]!.dispatchStatus as string;
}

d("defect 1B — the router passes every applicable limit to the evaluator", () => {
  it("blocks a 4.5 m unit under a verified 4.2 m structure when a verified 5.0 m road clearance covers the same check", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, { heightM: 4.5 });
    const segmentId = key("SEG").slice(0, 60);
    await restriction(c, segmentId, "overhead_clearance", 5.0, "m");
    const st = await callerFor(c.dispatcher).spatial.structureRecord({ kind: "overhead", label: "Rail overpass", jurisdiction: "CA-AB", segmentId, latitude: 53.5, longitude: -113.5, clearanceM: 4.2, source: "posted clearance sign" });
    await callerFor(c.safety).spatial.structureVerify({ structureRef: st.structureRef });

    const v = await evaluate(c, unitId, segmentId, ["overhead_clearance"]);
    expect(v.dispatchStatus).toBe("blocked");
    const governing = v.evidence.find((e: { check: string }) => e.check === "overhead_clearance")!;
    expect(governing.inputs.limitValue).toBe(4.2);
  }, 60_000);
});

d("defect 2 — the approval's verdict is the evaluation's, not the caller's", () => {
  it("does not store a caller's 'clear' for an evaluation that found no data (UNKNOWN), and readiness does not see a clear route", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, {});
    const segmentId = key("SEG").slice(0, 60);
    const v = await evaluate(c, unitId, segmentId, ["road_weight_restriction"]);
    expect(v.legal).toBe("unknown");

    const a = await approve(c, unitId, segmentId, { dispatchStatus: "clear", evaluationRef: v.evaluationRef });
    expect(await storedStatus(a.approvalRef)).not.toBe("clear");

    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [key("Op").slice(0, 40)]);
    const r = await composeReadiness({ operatorId: Number(op.insertId), unitId, trailerId: null, jobId: null, routeApprovalRef: a.approvalRef });
    expect(r.eligibility.blockers.some(b => b.subject === "route")).toBe(true);
  }, 60_000);

  it("refuses an evaluation made for a different unit — an approval must stand on its own route's evaluation", async () => {
    const c = await cast();
    const unitA = await newUnit(), unitB = await newUnit();
    await profile(c, unitA, {});
    await profile(c, unitB, {});
    const segmentId = key("SEG").slice(0, 60);
    await restriction(c, segmentId, "road_weight_restriction", 40_000, "kg");
    const forA = await evaluate(c, unitA, segmentId, ["road_weight_restriction"]);
    await expect(approve(c, unitB, segmentId, { dispatchStatus: "clear", evaluationRef: forA.evaluationRef })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }, 60_000);
});

d("defect 3 — FAIL and UNKNOWN are judged on the evaluation being approved", () => {
  it("approves a newer passing evaluation even though an older evaluation of the same segment failed — and keeps the old FAIL on record", async () => {
    const c = await cast();
    const unitId = await newUnit();
    const segmentId = key("SEG").slice(0, 60);
    await restriction(c, segmentId, "road_weight_restriction", 30_000, "kg");
    await profile(c, unitId, { steerKg: 8_000, driveKg: 40_000 });          // 48,000 kg over a 30,000 kg posting
    const failed = await evaluate(c, unitId, segmentId, ["road_weight_restriction"]);
    expect(failed.dispatchStatus).toBe("blocked");
    await profile(c, unitId, { steerKg: 6_000, driveKg: 14_000 });          // reloaded light: 20,000 kg
    const passed = await evaluate(c, unitId, segmentId, ["road_weight_restriction"]);
    expect(passed.dispatchStatus).toBe("clear");

    const a = await approve(c, unitId, segmentId, { dispatchStatus: "clear", evaluationRef: passed.evaluationRef });
    expect(a.status).toBe("approved");
    expect(await storedStatus(a.approvalRef)).toBe("clear");
    const [old] = await pool.execute<mysql.RowDataPacket[]>("SELECT result FROM routeEvidenceEntries WHERE evaluationRef = ?", [failed.evaluationRef]);
    expect(old.map(r => r.result)).toContain("fail");                       // audit history kept
  }, 60_000);

  it("refuses to approve the evaluation that failed", async () => {
    const c = await cast();
    const unitId = await newUnit();
    const segmentId = key("SEG").slice(0, 60);
    await restriction(c, segmentId, "road_weight_restriction", 30_000, "kg");
    await profile(c, unitId, { steerKg: 8_000, driveKg: 40_000 });
    const failed = await evaluate(c, unitId, segmentId, ["road_weight_restriction"]);
    await expect(approve(c, unitId, segmentId, { dispatchStatus: "clear", evaluationRef: failed.evaluationRef })).rejects.toThrow(/FAIL/);
  }, 60_000);

  it("never stores a current material UNKNOWN as a clean pass, whatever the caller says", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, {});
    const segmentId = key("SEG").slice(0, 60);
    const unknown = await evaluate(c, unitId, segmentId, ["road_weight_restriction"]);
    for (const claimed of ["clear", "review", "warning"]) {
      const a = await approve(c, unitId, segmentId, { dispatchStatus: claimed, evaluationRef: unknown.evaluationRef });
      expect(await storedStatus(a.approvalRef), claimed).not.toBe("clear");
    }
  }, 60_000);
});

d("defect 4 — a recheck says permits were not re-checked rather than implying they were", () => {
  it("reports the permit references as carried, not refreshed, because no permit record exists to re-read", async () => {
    const c = await cast();
    const unitId = await newUnit();
    await profile(c, unitId, {});
    const segmentId = key("SEG").slice(0, 60);
    const a = await approve(c, unitId, segmentId, { dispatchStatus: "review", permitRefs: ["AB-OS-2026-001234"] });
    const check = await callerFor(c.dispatcher).spatial.routeApprovalCheck({ approvalRef: a.approvalRef });
    expect(check).toMatchObject({ notRechecked: [expect.objectContaining({ dependency: "permitSet" })] });
    expect(JSON.stringify(check.reasons)).not.toMatch(/permit/i);   // nothing claims the permits were found current
  }, 60_000);
});
