/**
 * Dispatch ↔ facility directory. A job's destination acceptance is the loads' latest
 * facility assessments: blocking → a named, non-overridable dispatch blocker; every load
 * non-blocking → verified; any load unassessed → review. The Exception Centre shows the
 * directory's open items.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { destinationAcceptanceForJob } from "./_core/destinationAcceptance";
import { evaluateDispatchReadiness, type ReadinessInput } from "./_core/dispatchReadiness";
import { deriveExceptions } from "./_core/exceptionCentre";
import { actingScopeFor, getDb } from "./db";
import { loadExceptionSources } from "./surfacesService";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 260_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: string) { const userId = seq++; await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]); return userId; }

describe("dispatch blocker text from facility assessments (pure)", () => {
  const base = (): ReadinessInput["job"] => ({ classificationComplete: true, dangerousGoods: false, tdgDocumentPrepared: true, requiredDocumentsPresent: true, permitRequired: false, permitOnFile: null, destinationAcceptanceVerified: null, emergencyPlanOnFile: true });
  const input = (job: ReadinessInput["job"]): ReadinessInput => ({ evaluatedAt: new Date(), operator: { operatorId: 1, name: "x", licence: { label: "licence", expiresAt: new Date(Date.now() + 86_400_000 * 300), present: true }, requiredCredentials: [], hoursAvailableMinutes: 600, projectedJobMinutes: 300, availabilityDeclared: true }, truck: { unitNumber: "U", inspection: { label: "i", expiresAt: new Date(Date.now() + 86_400_000 * 300), present: true }, registration: { label: "r", expiresAt: new Date(Date.now() + 86_400_000 * 300), present: true }, insurance: { label: "n", expiresAt: new Date(Date.now() + 86_400_000 * 300), present: true }, maintenanceOverdue: false, criticalDefectOpen: false, mechanicReleaseRequired: false, mechanicReleaseGiven: false }, job, route: { corridorState: "pass", restrictionDataFresh: true } as never } as never);
  it("names the load, the facility and the engine's reasons when an assessment blocks; says why review when nothing was assessed", () => {
    const blocked = evaluateDispatchReadiness(input({ ...base(), destinationAcceptanceVerified: false, destinationAssessments: [{ loadNumber: "LD-7", facilityKey: "x", facilityName: "Edson TRD", outcome: "facility_confirmation_required", blocking: true, reasonCodes: ["facility_confirmation_required"], assessedAt: new Date() }] }));
    const b = blocked.blockers.find(x => x.code === "destination_not_accepting")!;
    expect(b.label).toBe("Load LD-7 → Edson TRD: facility confirmation required (facility_confirmation_required)");
    expect(b.overridable).toBe(false);
    const review = evaluateDispatchReadiness(input(base()));
    expect(review.blockers.find(x => x.code === "destination_acceptance_unverified")).toMatchObject({ severity: "review", label: expect.stringContaining("no non-blocking facility assessment") });
    const ok = evaluateDispatchReadiness(input({ ...base(), destinationAcceptanceVerified: true }));
    expect(ok.blockers.some(x => x.code.startsWith("destination"))).toBe(false);
  });
});

d("destination acceptance from the loads' latest assessments", () => {
  it("is null with no loads or an unassessed load, false when the latest assessment on any load blocks, true when every load's latest is non-blocking — and the Exception Centre lists the directory's open items", async () => {
    const dispatcher = await withRole("dispatcher"), safety = await withRole("safety"), safety2 = await withRole("safety");
    const db = (await getDb())!;
    const jobCode = `JOB-${rnd()}`;
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status) VALUES (?,?,?,?,'dispatched')", [jobCode, "Hydrovac", "Fixture Energy", "LSD 04-12-045-08W4"]);
    expect(await destinationAcceptanceForJob(db as never, j.insertId)).toEqual({ verified: null, assessments: [] });
    const [l1] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, material) VALUES (?, ?, 'hydrovac slurry')", [`LD-${rnd()}`, j.insertId]);
    const [l2] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, material) VALUES (?, ?, 'hydrovac slurry')", [`LD-${rnd()}`, j.insertId]);
    // A verified facility with a confirmation-required capability.
    const facilityKey = `fac-${rnd()}`;
    await pool.execute("INSERT INTO facilities (facilityKey, name, status, province, facilityType, latitude, longitude, coordinatePrecision, coordinateSourceUrl, disposition, lifecycle, commercialAccess) VALUES (?,?,'open','AB','trd',53.6,-116.4,'verified_site','https://example.org/v','verified_facility','operating','commercial_preapproval_required')", [facilityKey, `TRD ${rnd()}`]);
    const ev = await callerFor(safety).facilityDirectory.evidenceRecord({ facilityKey, publisher: "Facility", title: "acceptance", sourceUrl: "https://example.org/a", licenceKey: "company_website", claimType: "accepts_waste_stream", retrievedAt: new Date(), confidence: "medium" });
    await callerFor(safety2).facilityDirectory.evidenceReview({ evidenceId: ev.evidenceId, reviewState: "reviewed", note: "confirmed by phone" });
    await callerFor(safety).facilityDirectory.capabilitySet({ facilityKey, wasteCode: "hydrovac_slurry", acceptanceStatus: "confirmation_required", evidenceId: ev.evidenceId });
    // Load 1 assessed without a call-ahead: blocking → the job's destination acceptance is false, and the blocker carries the load and facility.
    await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId: l1.insertId, facilityKey, loadWasteCode: "hydrovac_slurry", routeReviewPassed: true });
    const blockedState = await destinationAcceptanceForJob(db as never, j.insertId);
    expect(blockedState.verified).toBe(false);
    expect(blockedState.assessments).toHaveLength(1);
    expect(blockedState.assessments[0]).toMatchObject({ facilityKey, outcome: "facility_confirmation_required", blocking: true });
    // The driver calls ahead; both loads reassessed and non-blocking → verified true (latest wins, the earlier blocking row stays in history).
    await callerFor(dispatcher).facilityDirectory.callAhead.record({ facilityKey, wasteCode: "hydrovac_slurry", outcome: "accepted", spokeTo: "Dana at the scale", validForHours: 6 });
    const a1 = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId: l1.insertId, facilityKey, loadWasteCode: "hydrovac_slurry", routeReviewPassed: true });
    expect(a1.dispatchable).toBe(true);
    expect((await destinationAcceptanceForJob(db as never, j.insertId)).verified).toBeNull();   // load 2 still unassessed
    await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId: l2.insertId, facilityKey, loadWasteCode: "hydrovac_slurry", routeReviewPassed: true });
    const ok = await destinationAcceptanceForJob(db as never, j.insertId);
    expect(ok.verified).toBe(true);
    expect(ok.assessments.every(a => !a.blocking)).toBe(true);
    // Exception Centre: the Virden conflict and the regulator-evidence and duplicate rows surface with their permissions.
    await callerFor(safety).facilityDirectory.seedBrief();
    const sources = await loadExceptionSources(new Date(), await actingScopeFor(safety));
    expect(sources.facilityDirectory?.conflicting.some(c => c.facilityKey === "virden-facility-conflicting")).toBe(true);
    const xs = deriveExceptions(sources);
    expect(xs.find(x => x.key === "facility-conflict:virden-facility-conflicting")).toMatchObject({ category: "dispatch", severity: "high", requiredPermission: "facility.directory.review" });
    expect(xs.some(x => x.key.startsWith("facility-duplicate:"))).toBe(true);
  }, 60_000);
});
