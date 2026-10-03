/**
 * v22.20 (0086) — §7 and §8 against real rows.
 *
 * The enqueue was a callback and every test pushed into an array, so the
 * invariant it protected was proven against a fake. These use the database.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { getDb, grantUserRole } from "./db";
import { consumeEnforcementEvents } from "./_core/enforcementOutbox";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let seq = 9_800_000 + Math.floor(Math.random() * 60_000);
// CP1.5 — the stop names a unit of the confirming caller's own (historical, unowned) tenant, not a fixed
// id that on a shared database is whichever unit another test made.
let legacyUnit = 0;
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); db = await getDb();
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${Math.random().toString(36).slice(2, 9).toUpperCase()}`]);
  legacyUnit = Number(u.insertId);
});
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const NOW = new Date("2026-09-11T09:00:00Z");

const stop = (over: Record<string, unknown> = {}) => ({
  eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: `agency-${rnd()}`,
  occurredAt: new Date("2026-09-11T08:42:00Z"), inspectionReportNumber: `INSP-${rnd()}`,
  inspectionResult: "out_of_service" as const, unitId: legacyUnit, subjectRefs: { vehicle: `UNIT-${rnd()}` },
  violations: [{
    system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER", citationIssued: true, outOfService: true,
    oosScope: "vehicle" as const, defectRequired: true, repairRequired: true, courtAction: false,
    releaseCondition: "reinspection passed", requiredFindingType: "reinspection" as const,
  }],
  ...over,
});

d("§7 — the outbox row lives or dies with the order", () => {
  it("writes one row in the same transaction, carrying the server's tenant", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT eventType, aggregateType, aggregateId, tenantId, actorSource, actorUserId, claimedAt, payloadJson FROM domainEventOutbox WHERE aggregateId = ?", [c.eventRef]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "enforcement.out_of_service.issued", aggregateType: "enforcementEvent",
      aggregateId: c.eventRef, tenantId: "default", actorSource: "human", actorUserId: String(safety),
    });
    expect(rows[0].claimedAt).toBeNull();
    expect(JSON.parse(rows[0].payloadJson)).toMatchObject({ severity: "critical", unitId: legacyUnit });
  });

  it("enqueues a confirmation rather than a prohibition when nothing was placed out of service", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop({
      inspectionResult: "requires_attention",
      violations: [{ system: "lamps", ownCode: "LEASEOS.LAMPS.MARKER", citationIssued: false, outOfService: false, oosScope: null, defectRequired: true, repairRequired: true, courtAction: false }],
    }));
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType FROM domainEventOutbox WHERE aggregateId = ?", [c.eventRef]);
    expect(rows[0].eventType).toBe("enforcement.event.confirmed");
  });

  it("writes exactly one row when the same stop is confirmed twice", async () => {
    const safety = await withRole("safety");
    const s = stop();
    const first = await caller(safety).enforcement.eventConfirm(s);
    await caller(safety).enforcement.eventConfirm(s);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM domainEventOutbox WHERE aggregateId = ?", [first.eventRef]);
    expect(Number(rows[0].n)).toBe(1);
  });
});

d("§8 — the consumer tells people, once", () => {
  it("claims the event and writes a notification per level-0 role", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const r = await consumeEnforcementEvents(db, { now: NOW });
    expect(r.claimed).toBeGreaterThanOrEqual(1);

    const [notes] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT recipientRole, status, title, body, deepLink, tenantId FROM workflowNotifications WHERE notificationKey LIKE ?", [`enf:${c.eventRef}:%`]);
    expect(notes.length).toBe(4);   // dispatcher, office, safety, shop_lead
    expect(notes.map(n => n.recipientRole).sort()).toEqual(["dispatcher", "office", "safety", "shop_lead"]);
    expect(notes[0]).toMatchObject({ status: "queued", tenantId: "default" });
    expect(notes[0].title).toContain("Out of service");
    expect(notes[0].body).toContain("cannot move until");
    expect(notes[0].deepLink).toBe(`/enforcement/${c.eventRef}`);

    const [claimed] = await pool.execute<mysql.RowDataPacket[]>("SELECT claimedAt FROM domainEventOutbox WHERE aggregateId = ?", [c.eventRef]);
    expect(claimed[0].claimedAt).toBeTruthy();
  });

  it("running the consumer again tells nobody twice", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    await consumeEnforcementEvents(db, { now: NOW });
    const before = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM workflowNotifications WHERE notificationKey LIKE ?", [`enf:${c.eventRef}:%`]);
    await consumeEnforcementEvents(db, { now: NOW });
    const after = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM workflowNotifications WHERE notificationKey LIKE ?", [`enf:${c.eventRef}:%`]);
    expect(Number(after[0][0].n)).toBe(Number(before[0][0].n));
  });

  it("is idempotent even if the same event is somehow re-offered unclaimed", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    await consumeEnforcementEvents(db, { now: NOW });
    // Simulate a crash between writing notifications and marking it claimed.
    await pool.execute("UPDATE domainEventOutbox SET claimedAt = NULL WHERE aggregateId = ?", [c.eventRef]);
    const again = await consumeEnforcementEvents(db, { now: NOW });
    expect(again.alreadyNotified).toBeGreaterThanOrEqual(4);
    expect(again.notificationsWritten).toBe(0);
  });

  it("wakes nobody for a routine confirmation", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop({
      inspectionResult: "pass",
      violations: [{ system: "paperwork", ownCode: "LEASEOS.DOC.ABSENT", citationIssued: true, outOfService: false, oosScope: null, defectRequired: false, repairRequired: false, courtAction: true }],
    }));
    await consumeEnforcementEvents(db, { now: NOW });
    const [notes] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM workflowNotifications WHERE notificationKey LIKE ?", [`enf:${c.eventRef}:%`]);
    expect(Number(notes[0].n)).toBe(0);
    // The event is still claimed — a record, not an alarm.
    const [claimed] = await pool.execute<mysql.RowDataPacket[]>("SELECT claimedAt FROM domainEventOutbox WHERE aggregateId = ?", [c.eventRef]);
    expect(claimed[0].claimedAt).toBeTruthy();
  });
});
