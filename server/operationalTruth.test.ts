/**
 * v22.5.1 — The operational truth boundary.
 *
 * Authorization answers "may this person perform this kind of action".
 * These tests answer the other question: an authorized create or capture may
 * carry an observation or a claim, and may not establish a verified,
 * authenticated, resolved, approved or authoritative state, nor name an
 * identity or a binding the server resolves. Each case is an AUTHORIZED
 * caller — the refusal is the boundary's, not the permission gate's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 4_300_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const REFUSED = /Trust-bearing value refused/;

describe("the monolith's create paths refuse trust-bearing input at the schema", () => {
  it("names every refused field, and none of them has a default that would let a value through", () => {
    const src = readFileSync("server/routers.ts", "utf8");
    const refused = (src.match(/^\s+([a-zA-Z]+): REFUSED,/gm) ?? []).map(l => l.trim().split(":")[0]!);
    expect(refused.sort()).toEqual(["accessRole", "authMethod", "classificationStatus", "confidence", "confidence", "documentHash", "inspectionStatus", "maintenanceStatus", "source", "status", "status", "status", "status", "status", "unitId", "verificationStatus", "verifiedAt", "verifiedAt"]);
    expect(src).toContain('const REFUSED = z.undefined(');
  });
});

d("an authorized caller cannot establish a trusted state through a create", () => {
  it("evidence: verified is refused; a capture lands as needs_review; verification is evidence.verify", async () => {
    const office = await withRole("office");
    await expect(callerFor(office).fieldRoute.evidence.add({ title: "Scale ticket", category: "disposal", capturedAt: new Date(), status: "verified" } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(office).fieldRoute.evidence.add({ title: "Scale ticket", category: "disposal", capturedAt: new Date() });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM evidenceRecords WHERE id = ?", [id]);
    expect(row[0].status).toBe("needs_review");
  });
  it("documents: a verified document cannot be created; it arrives needs_review", async () => {
    const office = await withRole("office");
    await expect(callerFor(office).fieldRoute.identity.documents.create({ ownerType: "operator", ownerId: 1, docType: "drivers_licence", title: "Licence", capturedAt: new Date(), verificationStatus: "verified" } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(office).fieldRoute.identity.documents.create({ ownerType: "operator", ownerId: 1, docType: "drivers_licence", title: "Licence", capturedAt: new Date() });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT verificationStatus FROM complianceDocuments WHERE id = ?", [id]);
    expect(row[0].verificationStatus).toBe("needs_review");
  });
  it("loads: TDG classification is never self-certified", async () => {
    const office = await withRole("office");
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'general', 'general', 'x', 'y', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    await expect(callerFor(office).fieldRoute.compliance.loads.create({ jobId: Number(job.insertId), material: "Produced water", classificationStatus: "verified", verifiedAt: new Date() } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(office).fieldRoute.compliance.loads.create({ jobId: Number(job.insertId), material: "Produced water", unNumber: "UN3082" });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT classificationStatus, verifiedAt FROM loadProfiles WHERE id = ?", [id]);
    expect(row[0]).toMatchObject({ classificationStatus: "needs_verification", verifiedAt: null });
  });
  it("defects and incidents: resolved is refused; both are created open", async () => {
    const driver = await withRole("driver");
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'due', 'review', NOW())", [key("U").slice(0, 20)]);
    await expect(callerFor(driver).fieldRoute.compliance.maintenance.create({ unitId: Number(un.insertId), title: "Brake light out", severity: "advisory", reportedAt: new Date(), status: "resolved" } as never)).rejects.toThrow(REFUSED);
    const did = await callerFor(driver).fieldRoute.compliance.maintenance.create({ unitId: Number(un.insertId), title: "Brake light out", severity: "advisory", reportedAt: new Date() });
    const [drow] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM maintenanceDefects WHERE id = ?", [did]);
    expect(drow[0].status).toBe("open");
    await expect(callerFor(driver).fieldRoute.safety.create({ eventType: "near_miss", title: "Backing", occurredAt: new Date(), status: "resolved" } as never)).rejects.toThrow(REFUSED);
    const sid = await callerFor(driver).fieldRoute.safety.create({ eventType: "near_miss", title: "Backing", occurredAt: new Date() });
    const [srow] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM safetyEvents WHERE id = ?", [sid]);
    expect(srow[0].status).toBe("open");
  });
  it("units: a new row is due and under review, not current and clear", async () => {
    const office = await withRole("office");
    await expect(callerFor(office).fieldRoute.identity.units.create({ unitNumber: key("U").slice(0, 20), vehicleType: "vac truck", inspectionStatus: "current", maintenanceStatus: "clear" } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(office).fieldRoute.identity.units.create({ unitNumber: key("U").slice(0, 20), vehicleType: "vac truck" });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT inspectionStatus, maintenanceStatus FROM units WHERE id = ?", [id]);
    expect(row[0]).toEqual({ inspectionStatus: "due", maintenanceStatus: "review" });
  });
  it("manifests: verified or complete is refused; a manifest is created as a draft", async () => {
    const office = await withRole("office");
    await expect(callerFor(office).fieldRoute.manifests.create({ manifestNumber: key("MF").slice(0, 40), status: "verified" } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(office).fieldRoute.manifests.create({ manifestNumber: key("MF").slice(0, 40) });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM manifests WHERE id = ?", [id]);
    expect(row[0].status).toBe("draft");
  });
  it("legacy signatures: a chosen status, method or hash is refused; what lands is a pending observation that names the frozen chain", async () => {
    const office = await withRole("office");
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'general', 'general', 'x', 'y', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    await expect(callerFor(office).fieldRoute.compliance.sign({ jobId: Number(job.insertId), signerName: "M. Johnson", signedAt: new Date(), status: "authenticated", authMethod: "biometric", documentHash: "a".repeat(64) } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(office).fieldRoute.compliance.sign({ jobId: Number(job.insertId), signerName: "M. Johnson", signedAt: new Date() });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, authMethod, documentHash FROM signatureAudits WHERE id = ?", [id]);
    expect(row[0]).toMatchObject({ status: "pending", documentHash: null });
    expect(row[0].authMethod).toContain("closeout.siteSign");
  });
  it("scans: the access role is the caller's, not the caller's claim", async () => {
    const driver = await withRole("driver");
    /*
     * A real, unowned unit of this suite's own. `subjectId: 1` worked only
     * while nothing else in the database owned unit 1; the cross-tenant matrix
     * now assigns owned units, and a scan on somebody else's unit is correctly
     * refused. The same fix fieldroute.test.ts needed, for the same reason.
     */
    const [unit] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-OT-${Math.random().toString(36).slice(2, 9).toUpperCase()}`, "hydrovac"]);
    const subjectId = unit.insertId;
    await expect(callerFor(driver).fieldRoute.scans.create({ scanType: "qr", subjectType: "unit", subjectId, scannedAt: new Date(), accessRole: "admin" } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(driver).fieldRoute.scans.create({ scanType: "qr", subjectType: "unit", subjectId, scannedAt: new Date() });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT accessRole FROM scanAudits WHERE id = ?", [id]);
    expect(row[0].accessRole).toBe("driver");
    const management = await withRole("management");
    const mid = await callerFor(management).fieldRoute.scans.create({ scanType: "qr", subjectType: "unit", subjectId, scannedAt: new Date() });
    const [mrow] = await pool.execute<mysql.RowDataPacket[]>("SELECT accessRole FROM scanAudits WHERE id = ?", [mid]);
    expect(mrow[0].accessRole).toBe("admin");
  });
  it("duty records: a driver records only their own; another operator needs amendment authority and is marked as an amendment", async () => {
    const driver = await withRole("driver");
    const other = await withRole("driver");
    const [op1] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'A. Driver', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driver]);
    const [op2] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'B. Driver', DATE_ADD(NOW(), INTERVAL 400 DAY))", [other]);
    await expect(callerFor(driver).fieldRoute.dutyRecords.create({ operatorId: Number(op2.insertId), dutyStatus: "on_duty", startedAt: new Date() })).rejects.toThrow(/names the operator of the signed-in driver/);
    const own = await callerFor(driver).fieldRoute.dutyRecords.create({ dutyStatus: "on_duty", startedAt: new Date() });
    const [orow] = await pool.execute<mysql.RowDataPacket[]>("SELECT operatorId, source FROM dutyRecords WHERE id = ?", [own]);
    expect(orow[0]).toMatchObject({ operatorId: Number(op1.insertId), source: "driver_entry" });
    const management = await withRole("management");
    const amended = await callerFor(management).fieldRoute.dutyRecords.create({ operatorId: Number(op2.insertId), dutyStatus: "off_duty", startedAt: new Date() });
    const [arow] = await pool.execute<mysql.RowDataPacket[]>("SELECT operatorId, source FROM dutyRecords WHERE id = ?", [amended]);
    expect(arow[0].operatorId).toBe(Number(op2.insertId));
    expect(arow[0].source).toContain(`amendment by user ${management}`);
    const office = await withRole("office");                                                   // holds hos.write but not amendment authority
    await expect(callerFor(office).fieldRoute.dutyRecords.create({ operatorId: Number(op2.insertId), dutyStatus: "off_duty", startedAt: new Date() })).rejects.toThrow(/amendment for dispatch, HR or management/);
  });
  it("breadcrumbs: a position binds to the signed-in operator's active trip; naming another trip is refused; no active trip means no attachment", async () => {
    const driver = await withRole("driver");
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'C. Driver', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driver]);
    await expect(callerFor(driver).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() })).rejects.toThrow(/No active trip is assigned/);
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'due', 'review', NOW())", [key("U").slice(0, 20)]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'general', 'general', 'x', 'y', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const [trip] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, jobId, unitId, operatorId, status, createdAt) VALUES (?, ?, ?, ?, 'in_transit', NOW())", [key("TR").slice(0, 40), Number(job.insertId), Number(un.insertId), Number(op.insertId)]);
    const [otherTrip] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, jobId, unitId, operatorId, status, createdAt) VALUES (?, ?, ?, 999999, 'in_transit', NOW())", [key("TR").slice(0, 40), Number(job.insertId), Number(un.insertId)]);
    await expect(callerFor(driver).fieldRoute.gps.submitBreadcrumb({ tripId: Number(otherTrip.insertId), latitude: 53.5, longitude: -113.4, recordedAt: new Date() })).rejects.toThrow(/not attached to another trip/);
    await expect(callerFor(driver).fieldRoute.gps.submitBreadcrumb({ tripId: Number(trip.insertId), latitude: 53.5, longitude: -113.4, unitId: 1 } as never)).rejects.toThrow(REFUSED);
    const r = await callerFor(driver).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT tripId, unitId FROM tripBreadcrumbs WHERE id = ?", [r.breadcrumbId]);
    expect(row[0]).toEqual({ tripId: Number(trip.insertId), unitId: Number(un.insertId) });        // bound by the assignment, not the request
  });
  it("route decisions: imported or verified provenance is refused; a stored route is a manual choice that names the unloaded source", async () => {
    const management = await withRole("management");
    const dispatcher = await withRole("dispatcher");
    await expect(callerFor(management).fieldRoute.routeDecisions.create({ tripId: "TR-1", selectedRoute: "Hwy 22 → Twp 452", vehicleType: "vac truck", gvwTonnes: 31, axleCount: 4, heightMetres: 4, widthMetres: 3, lengthMetres: 12, riskLevel: "low", source: "Industrial road graph · Northern Alberta", confidence: "Imported + driver verified" } as never)).rejects.toThrow(REFUSED);
    const id = await callerFor(management).fieldRoute.routeDecisions.create({ tripId: "TR-1", selectedRoute: "Hwy 22 → Twp 452", vehicleType: "vac truck", gvwTonnes: 31, axleCount: 4, heightMetres: 4, widthMetres: 3, lengthMetres: 12, riskLevel: "low" });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT source, confidence FROM routeDecisions WHERE id = ?", [id]);
    expect(row[0].source).toBe("manual choice (routing source not_loaded)");
    expect(row[0].confidence).toBe("manual — not authority data");
    await expect(callerFor(dispatcher).fieldRoute.routeContext.create({ name: "Bridge limits", source: "Provincial transportation authority", effectiveAt: new Date(), verifiedAt: new Date(), confidence: "high" } as never)).rejects.toThrow(REFUSED);
    const cid = await callerFor(dispatcher).fieldRoute.routeContext.create({ name: "Bridge limits", source: "Provincial transportation authority", effectiveAt: new Date() });
    const [crow] = await pool.execute<mysql.RowDataPacket[]>("SELECT source, confidence, verifiedAt FROM routeContexts WHERE id = ?", [cid]);
    expect(crow[0]).toMatchObject({ source: "stated: Provincial transportation authority", confidence: "low", verifiedAt: null });
  });
});
