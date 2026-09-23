import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { faultDispatchEffect, odometerReconciliation, reviewDecision, reviewQueue } from "./_core/telematics";
import { intakeDecision } from "./_core/integrationGateway";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const at = (iso: string) => new Date(iso);

describe("the truck's odometer is reconciled, not trusted", () => {
  it("is consistent within tolerance, flags trips that do not account for the advance, and catches a reading below the shop's", () => {
    expect(odometerReconciliation({ telemetryKm: 168_400, telemetryAt: at("2026-09-10T08:00:00Z"), tripsKmSum: 8_300, lastShopKm: 160_000, lastShopAt: at("2026-08-01T00:00:00Z") })).toMatchObject({ determination: "consistent", findings: [] });
    const off = odometerReconciliation({ telemetryKm: 168_400, telemetryAt: at("2026-09-10T08:00:00Z"), tripsKmSum: 5_000, lastShopKm: 160_000, lastShopAt: at("2026-08-01T00:00:00Z") });
    expect(off.determination).toBe("discrepancy");
    expect(off.findings[0]).toBe("Trips since the shop reading account for 5000 km; telemetry advanced 8400 km — 3400 km apart (40%, tolerance 3%)");
    expect(odometerReconciliation({ telemetryKm: 150_000, telemetryAt: at("2026-09-10T08:00:00Z"), tripsKmSum: null, lastShopKm: 160_000, lastShopAt: null }).findings[0]).toContain("rolled-back or swapped unit; REVIEW");
    expect(odometerReconciliation({ telemetryKm: null, telemetryAt: null, tripsKmSum: 100, lastShopKm: null, lastShopAt: null })).toMatchObject({ determination: "unknown" });
  });
});

describe("a fault is an observation until a mechanic decides", () => {
  it("is UNKNOWN while active, blocking once acknowledged critical, review once acknowledged inspection, nothing once cleared", () => {
    expect(faultDispatchEffect({ status: "active", severityDetermination: "unknown", code: "SPN-100", occurrenceCount: 4 })).toEqual({ severity: "unknown", label: "Fault SPN-100 active (4×), severity not determined — no verified fault rule; a mechanic decides" });
    expect(faultDispatchEffect({ status: "acknowledged", severityDetermination: "critical", code: "SPN-100", occurrenceCount: 4 })).toMatchObject({ severity: "blocking" });
    expect(faultDispatchEffect({ status: "acknowledged", severityDetermination: "inspection_required", code: "SPN-100", occurrenceCount: 4 })).toMatchObject({ severity: "review" });
    expect(faultDispatchEffect({ status: "acknowledged", severityDetermination: "advisory", code: "SPN-100", occurrenceCount: 4 })).toMatchObject({ severity: null });
    expect(faultDispatchEffect({ status: "cleared", severityDetermination: "unknown", code: "SPN-100", occurrenceCount: 4 })).toMatchObject({ severity: null });
  });
});

describe("a driving event is reviewed by a person, and nothing is scored", () => {
  it("refuses a second review, a note nobody can read, and coaching on unviewed video; escalation may proceed unviewed", () => {
    expect(reviewDecision({ current: "unreviewed", decision: "coached", note: "Discussed following distance with the operator", hasVideo: false, videoViewedByReviewer: false }).permitted).toBe(true);
    const bad = reviewDecision({ current: "coached", decision: "dismissed", note: "ok", hasVideo: true, videoViewedByReviewer: false });
    expect(bad.refusals).toEqual(["Event is already coached — a review is not redone; a second opinion is a note", "A review needs a note a colleague can read", "Video is attached and was not viewed — coach or dismiss only after viewing; escalation may proceed"]);
    expect(reviewDecision({ current: "unreviewed", decision: "escalated", note: "Possible contact with a pump jack — incident", hasVideo: true, videoViewedByReviewer: false }).permitted).toBe(true);
  });
  it("queues by unit, oldest first, and holds no per-driver number", () => {
    const q = reviewQueue([
      { eventRef: "A", unitId: 2, kind: "harsh_brake", recordedAt: at("2026-09-09T10:00:00Z"), reviewStatus: "unreviewed", hasVideo: true },
      { eventRef: "B", unitId: 1, kind: "speeding", recordedAt: at("2026-09-08T10:00:00Z"), reviewStatus: "unreviewed", hasVideo: false },
      { eventRef: "C", unitId: 1, kind: "harsh_brake", recordedAt: at("2026-09-09T12:00:00Z"), reviewStatus: "coached", hasVideo: false },
      { eventRef: "D", unitId: 1, kind: "harsh_cornering", recordedAt: at("2026-09-10T12:00:00Z"), reviewStatus: "unreviewed", hasVideo: false },
    ]);
    expect(q).toEqual([{ unitId: 1, count: 2, oldest: at("2026-09-08T10:00:00Z"), kinds: ["harsh_cornering", "speeding"], withVideo: 0 }, { unitId: 2, count: 1, oldest: at("2026-09-09T10:00:00Z"), kinds: ["harsh_brake"], withVideo: 1 }]);
    expect(JSON.stringify(q)).not.toMatch(/score|operatorId|driver/i);
  });
});

describe("the feeds are known to intake", () => {
  it("names the shape of each and says what it becomes", () => {
    expect(intakeDecision({ feed: "vehicle_telemetry", scopes: ["vehicle_telemetry"], payload: { recordedAt: "2026-09-10T08:00:00Z", unitRef: "142", odometerKm: 168_400 } })).toMatchObject({ accepted: true, becomes: "telemetry snapshot" });
    expect(intakeDecision({ feed: "vehicle_telemetry", scopes: ["vehicle_telemetry"], payload: { recordedAt: "2026-09-10T08:00:00Z", unitRef: "142" } }).refusals[0]).toContain("at least one of");
    expect(intakeDecision({ feed: "fault_code", scopes: ["fault_code"], payload: { code: "SPN-100/FMI-1", protocol: "j1939", seenAt: "2026-09-10T08:00:00Z", unitRef: "142" } }).note).toContain("REVIEW until a mechanic acknowledges");
    expect(intakeDecision({ feed: "safety_event", scopes: ["safety_event"], payload: { kind: "harsh_brake", recordedAt: "2026-09-10T08:00:00Z", unitRef: "142" } }).note).toContain("No score is computed about the driver");
    expect(intakeDecision({ feed: "video_clip", scopes: ["video_clip"], payload: { clipRef: "cam/1", clipHash: "zz", eventRef: "DRV-1" } }).refusals[0]).toBe("clipHash must be the clip's SHA-256");
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who acknowledges, who reviews, who watches", () => {
  it("keeps acknowledgement in the shop, review with safety and management, and video to those two", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "telematics.fault.acknowledge" }).allowed).sort()).toEqual(["mechanic", "shop_lead"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "safety.event.review" }).allowed).sort()).toEqual(["management", "safety"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "safety.video.read" }).allowed).sort()).toEqual(["management", "safety"]);
    expect(authorize({ userId: 1, roles: ["dispatcher"], permission: "safety.video.read" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_300_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const machine = (k: string) => appRouter.createCaller({ req: { headers: { "x-integration-key": k } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a truck talks, and people decide", () => {
  it("ingests telemetry, a repeated fault, an event and its clip; puts the fault on dispatch as UNKNOWN; the mechanic makes it a defect that blocks; safety reviews after viewing; another unit is untouched", async () => {
    const controller = await withRole("controller");
    const mechanic = await withRole("mechanic");
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const unitNo = key("U").slice(0, 20);
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [unitNo]);
    const unitId = Number(un.insertId);
    await pool.execute("INSERT INTO workOrders (workOrderNumber, unitId, status, priority, openedAt, completedAt, odometerKm, createdAt, updatedAt) VALUES (?, ?, 'closed', 'routine', '2026-08-01 00:00:00', '2026-08-01 08:00:00', 160000, NOW(), NOW())", [key("WO").slice(0, 40), unitId]);
    const tel = await callerFor(controller).integration.clientRegister({ name: "Telematics Co", kind: "telematics", scopes: ["vehicle_telemetry", "fault_code", "safety_event", "video_clip"] });
    const m = machine(tel.key);

    // Telemetry: a snapshot; the odometer is reconciled and, with no trips since the shop, is reported without pretending.
    const t1 = await m.inbound.ingest({ feed: "vehicle_telemetry", idempotencyKey: "tel-1", payload: { recordedAt: "2026-09-10T08:00:00Z", unitRef: unitNo, odometerKm: 168_400, engineHours: 4_120.5, idleMinutes: 44 } });
    expect(t1).toMatchObject({ status: "accepted", becomes: "telemetry snapshot" });
    const u1 = await callerFor(dispatcher).telematics.unit({ unitId });
    expect(u1.latest).toMatchObject({ odometerKm: 168_400, engineHours: 4_120.5, idleMinutes: 44 });
    expect(u1.odometer).toMatchObject({ telemetryKm: 168_400, lastShopKm: 160_000, tripsKm: null, determination: "consistent" });
    await expect(m.inbound.ingest({ feed: "vehicle_telemetry", idempotencyKey: "tel-x", payload: { recordedAt: "2026-09-10T08:00:00Z", unitRef: "NOPE", odometerKm: 1 } })).resolves.toMatchObject({ status: "rejected" });

    // A fault, three times: one row, count 3, active, severity unknown — and dispatch says UNKNOWN, not clear.
    for (let i = 1; i <= 3; i++) await m.inbound.ingest({ feed: "fault_code", idempotencyKey: `flt-${i}`, payload: { code: "SPN-100", subcode: "FMI-1", protocol: "j1939", seenAt: `2026-09-10T0${i}:00:00Z`, unitRef: unitNo, description: "Engine oil pressure low" } });
    const faults = (await callerFor(dispatcher).telematics.unit({ unitId })).faults;
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ code: "SPN-100", subcode: "FMI-1", occurrenceCount: 3, status: "active", severityDetermination: "unknown", dispatch: { severity: "unknown" } });
    const driverUser = await withRole("driver");
    const [opIns] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'T. Nguyen', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
    const op = [{ id: Number(opIns.insertId) }];
    const r1 = await callerFor(dispatcher).dispatch.readiness({ operatorId: Number(op[0].id), unitId });
    const faultItem = r1.blockers.find(b => b.code === "fault_spn-100_active");
    // C1a / D-02 — a fault nobody has assessed is a possible unresolved safety defect: UNKNOWN, and it
    // BLOCKS. No manager may take it on alone; only an owner-approved policy could, and none exists.
    expect(faultItem).toMatchObject({ severity: "unknown", subject: "truck", result: "UNKNOWN", dispatchEffect: "BLOCK", overrideClass: "APPROVED_POLICY_ONLY" });
    expect(faultItem!.label).toContain("a mechanic decides");

    // The mechanic acknowledges it as critical: a defect exists with the mechanic's words, the fault is acknowledged, dispatch is BLOCKED and not overridable; clearing is refused until the defect resolves.
    await expect(callerFor(dispatcher).telematics.faultAcknowledge({ faultId: faults[0].id, severity: "critical", title: "x" })).rejects.toBeTruthy();
    const ack = await callerFor(mechanic).telematics.faultAcknowledge({ faultId: faults[0].id, severity: "critical", title: "Low oil pressure — do not run", detail: "Confirmed at the gauge; pressure 8 psi at idle" });
    expect(ack).toMatchObject({ severity: "critical", dispatch: { severity: "blocking" } });
    const [def] = await pool.execute<mysql.RowDataPacket[]>("SELECT severity, status, detail FROM maintenanceDefects WHERE id = ?", [ack.defectId]);
    expect(def[0]).toMatchObject({ severity: "critical", status: "open" });
    expect(def[0].detail).toContain("severity determined by the acknowledging mechanic, not by a rule");
    const r2 = await callerFor(dispatcher).dispatch.readiness({ operatorId: Number(op[0].id), unitId });
    expect(r2.blockers.find(b => b.code === "fault_spn-100_critical")).toMatchObject({ severity: "blocking", overridable: false });
    await expect(callerFor(mechanic).telematics.faultClear({ faultId: faults[0].id, reason: "Feels fine now" })).rejects.toThrow(/resolve the defect/);
    // The fault seen again after acknowledgement keeps its acknowledged status and its count grows.
    await m.inbound.ingest({ feed: "fault_code", idempotencyKey: "flt-4", payload: { code: "SPN-100", subcode: "FMI-1", protocol: "j1939", seenAt: "2026-09-10T05:00:00Z", unitRef: unitNo } });
    expect((await callerFor(dispatcher).telematics.unit({ unitId })).faults[0]).toMatchObject({ occurrenceCount: 4, status: "acknowledged" });

    // A harsh-brake event, then its clip by eventRef: queued for review; coaching without viewing the video is refused; the safety lead views (logged), then coaches; a second review is refused; a dispatcher cannot view video.
    const ev = await m.inbound.ingest({ feed: "safety_event", idempotencyKey: "evt-1", payload: { kind: "harsh_brake", recordedAt: "2026-09-10T09:12:00Z", unitRef: unitNo, magnitude: -0.62, magnitudeUnit: "g", speedKph: 78, postedLimitKph: 80 } });
    expect(ev).toMatchObject({ status: "accepted", becomes: "driving event for review" });
    const clip = await m.inbound.ingest({ feed: "video_clip", idempotencyKey: "clip-1", payload: { clipRef: "cam7/2026-09-10/091200", clipHash: "a".repeat(64), eventRef: ev.resultRef } });
    expect(clip).toMatchObject({ status: "accepted", resultRef: ev.resultRef });
    const q = await callerFor(safety).telematics.reviewQueue();
    expect(q.queue.find(g => g.unitId === unitId)).toMatchObject({ count: 1, kinds: ["harsh_brake"], withVideo: 1 });
    expect(q.events.find(e => e.eventRef === ev.resultRef)).toMatchObject({ speedKph: 78, postedLimitKph: 80, postedLimitSource: "Telematics Co feed — unverified", hasVideo: true });
    await expect(callerFor(safety).telematics.eventReview({ eventRef: ev.resultRef!, decision: "coached", note: "Talked through following distance on lease roads" })).rejects.toThrow(/was not viewed/);
    await expect(callerFor(dispatcher).telematics.videoView({ eventRef: ev.resultRef!, purpose: "curious" })).rejects.toBeTruthy();
    const view = await callerFor(safety).telematics.videoView({ eventRef: ev.resultRef!, purpose: "Review of harsh-brake event before coaching" });
    expect(view).toMatchObject({ clipRef: "cam7/2026-09-10/091200", clipHash: "a".repeat(64), url: null });
    const [log] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM videoAccessLog WHERE userId = ?", [safety]);
    expect(Number(log[0].n)).toBe(1);
    expect((await callerFor(safety).telematics.eventReview({ eventRef: ev.resultRef!, decision: "coached", note: "Talked through following distance on lease roads" })).reviewStatus).toBe("coached");
    await expect(callerFor(safety).telematics.eventReview({ eventRef: ev.resultRef!, decision: "dismissed", note: "Changed my mind about it" })).rejects.toThrow(/already coached/);
    expect((await callerFor(safety).telematics.reviewQueue()).queue.find(g => g.unitId === unitId)).toBeUndefined();

    // Another unit has none of it.
    const [un2] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
    const u2 = await callerFor(dispatcher).telematics.unit({ unitId: Number(un2.insertId) });
    expect(u2).toMatchObject({ latest: null, faults: [], odometer: { determination: "unknown" } });
  });
});
