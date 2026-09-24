/**
 * Fleet maintenance, checkpoint 1 — against a real database, through the procedures a person calls.
 *
 * Who owns a work order (as history), what cancelling one does not do, the legacy update's status
 * bypass closed, the forward-only advance leaving a trace, and the organization boundary on work
 * orders and telematics (docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 175_000_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(...roles: DomainRole[]) {
  const id = nextUser();
  for (const role of roles) await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}
async function unit(tag = "U") {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [key(tag).slice(0, 38)]);
  return Number(u.insertId);
}
async function workOrder(unitId: number, status = "in_progress", defectId: number | null = null) {
  const [w] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO workOrders (workOrderNumber, unitId, defectId, status, priority, openedAt) VALUES (?, ?, ?, ?, 'routine', DATE_SUB(NOW(), INTERVAL 2 HOUR))", [key("WO").slice(0, 60), unitId, defectId, status]);
  return Number(w.insertId);
}

let shopLead = 0, shopLead2 = 0, mechanic = 0, driver = 0, dispatcher = 0, management = 0, office = 0;

describe("fleet maintenance checkpoint 1 — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped maintenance suite proves nothing").toBeTruthy();
  });
});
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  shopLead = await withRole("shop_lead");
  shopLead2 = await withRole("shop_lead");
  mechanic = await withRole("mechanic");
  driver = await withRole("driver");
  dispatcher = await withRole("dispatcher");
  management = await withRole("management");
  office = await withRole("office");
});
afterAll(async () => { await pool?.end(); });

d("who owns a work order, and what cancelling does not do", () => {
  it("assigns to a person with a shop role, keeps every change as history, and refuses a stranger to the shop", async () => {
    const unitId = await unit();
    const wo = await workOrder(unitId, "open");
    await expect(caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo, toUserId: driver })).rejects.toThrow(/holds no shop role/);
    await expect(caller(mechanic).maintenance.workOrderAssign({ workOrderId: wo, toUserId: mechanic })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo, toUserId: null })).rejects.toThrow(/not assigned/);
    // Clock-relative, to the second (timestamp precision): a fixed near-future date would be passed by the real clock.
    const due = new Date(Math.floor(Date.now() / 1000) * 1000 + 7 * 86_400_000);
    expect(await caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo, toUserId: mechanic, expectedCompletionAt: due, reason: "brakes" })).toMatchObject({ eventType: "assigned" });
    await expect(caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo, toUserId: mechanic })).rejects.toThrow(/already assigned/);
    expect(await caller(management).maintenance.workOrderAssign({ workOrderId: wo, toUserId: shopLead2 })).toMatchObject({ eventType: "reassigned" });
    const a = await caller(dispatcher).maintenance.workOrderAssignment({ workOrderId: wo });
    expect(a.current).toMatchObject({ userId: shopLead2 });
    expect(a.current?.expectedCompletionAt?.toISOString()).toBe(due.toISOString());   // carried forward, not dropped
    expect(a.history.map(h => [h.eventType, h.fromUserId, h.toUserId, h.actorUserId])).toEqual([
      ["reassigned", mechanic, shopLead2, management],
      ["assigned", null, mechanic, shopLead],
    ]);
    expect((await caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo, toUserId: null, reason: "parts on backorder" })).eventType).toBe("unassigned");
    expect((await caller(dispatcher).maintenance.workOrderAssignment({ workOrderId: wo })).current).toBeNull();
  });

  it("a cancelled work order leaves its defect open, cannot advance, take parts or evidence a release", async () => {
    const unitId = await unit();
    const [df] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, 'Air leak at brake chamber', 'critical', 'open', NOW(), 1)", [unitId]);
    const defectId = Number(df.insertId);
    const wo = await workOrder(unitId, "in_progress", defectId);
    await expect(caller(mechanic).maintenance.workOrderCancel({ workOrderId: wo, reason: "customer pulled it" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const c = await caller(shopLead).maintenance.workOrderCancel({ workOrderId: wo, reason: "Unit going to the dealer under warranty" });
    expect(c).toMatchObject({ status: "cancelled" });
    expect(c.note).toMatch(new RegExp(`Defect ${defectId} stays open`));
    const [row] = (await pool.execute<mysql.RowDataPacket[]>("SELECT d.status AS defectStatus, w.cancelledByUserId, w.cancelReason FROM workOrders w JOIN maintenanceDefects d ON d.id = w.defectId WHERE w.id = ?", [wo]))[0];
    expect(row).toMatchObject({ defectStatus: "open", cancelledByUserId: shopLead, cancelReason: "Unit going to the dealer under warranty" });

    await expect(caller(shopLead).maintenance.workOrderCancel({ workOrderId: wo, reason: "again" })).rejects.toThrow(/already cancelled/);
    await expect(caller(mechanic).shop.workOrderAdvance({ workOrderId: wo, to: "ready_for_service" })).rejects.toThrow(/cancelled work order is not reopened/);
    await expect(caller(mechanic).shop.workOrderRelease({ workOrderId: wo, releaseType: "full", repairSummary: "Replaced diaphragm", testProcedure: "Leak test", testResult: "pass", roadTestPerformed: true, resolvedDefectIds: [defectId] })).rejects.toThrow(/cancelled/);
    await expect(caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo, toUserId: mechanic })).rejects.toThrow(/cancelled/);
  });

  it("a work order whose release stands was done — it is closed, not cancelled", async () => {
    const unitId = await unit();
    const wo = await workOrder(unitId, "ready_for_service");
    await caller(mechanic).shop.workOrderRelease({ workOrderId: wo, releaseType: "full", repairSummary: "Adjusted slack adjusters", resolvedDefectIds: [] });
    await expect(caller(shopLead).maintenance.workOrderCancel({ workOrderId: wo, reason: "tidying up" })).rejects.toThrow(/standing release/);
  });

  it("the legacy create records who opened it; the legacy update refuses a status; the forward-only advance stamps when work started and finished and keeps its note", async () => {
    const unitId = await unit();
    const created = Number(await caller(office).fieldRoute.workOrders.create({ workOrderNumber: key("WO").slice(0, 60), unitId, openedAt: new Date("2026-09-01T08:00:00Z") }));
    const [opened] = (await pool.execute<mysql.RowDataPacket[]>("SELECT openedByUserId FROM workOrders WHERE id = ?", [created]))[0];
    expect(opened.openedByUserId).toBe(office);
    const wo = await workOrder(unitId, "open");
    await expect(caller(office).fieldRoute.workOrders.update({ id: wo, status: "open" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: wo, to: "in_progress", note: "Pulled the wheel" });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: wo, to: "ready_for_service" });
    const [w] = (await pool.execute<mysql.RowDataPacket[]>("SELECT status, startedAt, completedAt, findings FROM workOrders WHERE id = ?", [wo]))[0];
    expect(w.status).toBe("ready_for_service");
    expect(w.startedAt).toBeTruthy();
    expect(w.completedAt).toBeTruthy();
    expect(w.findings).toMatch(new RegExp(`open → in_progress, user ${mechanic}\\] Pulled the wheel`));
  });
});

d("the organization that owns the unit owns its maintenance", () => {
  it("answers not-found across the boundary, never forbidden; the work-order list and telematics no longer span organizations", async () => {
    const A = key("ORG").slice(0, 38), B = key("ORG").slice(0, 38);
    for (const o of [A, B]) await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?, ?, 'active')", [o, `org ${o}`]);
    const member = async (orgRef: string, role: DomainRole) => {
      const id = await withRole(role);
      await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [key("MEM").slice(0, 60), orgRef, id]);
      return id;
    };
    const leadA = await member(A, "shop_lead"), leadB = await member(B, "shop_lead"), leadB2 = await member(B, "shop_lead");
    const unitA = await unit();
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [A, unitA]);
    const woA = await workOrder(unitA, "open");
    const [fault] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO faultCodes (unitId, protocol, code, description, firstSeenAt, lastSeenAt, sourceClientId) VALUES (?, 'j1939', ?, 'coolant temp', NOW(), NOW(), 1)", [unitA, key("SPN").slice(0, 30)]);

    const nf = { code: "NOT_FOUND" };
    await expect(caller(leadB).maintenance.workOrderAssignment({ workOrderId: woA })).rejects.toMatchObject(nf);
    await expect(caller(leadB).maintenance.workOrderAssign({ workOrderId: woA, toUserId: leadB2 })).rejects.toMatchObject(nf);
    await expect(caller(leadB).shop.workOrderAdvance({ workOrderId: woA, to: "in_progress" })).rejects.toMatchObject(nf);
    await expect(caller(leadB).maintenance.workOrderCancel({ workOrderId: woA, reason: "not ours at all" })).rejects.toMatchObject(nf);
    // Telematics had no tenant scope at all: another organization's faults, units and review queue.
    await expect(caller(leadB).telematics.unit({ unitId: unitA })).rejects.toMatchObject(nf);
    await expect(caller(leadB).telematics.faultAcknowledge({ faultId: Number(fault.insertId), severity: "critical", title: "not ours to judge" })).rejects.toMatchObject(nf);
    await expect(caller(leadB).telematics.faultClear({ faultId: Number(fault.insertId), reason: "not ours to clear" })).rejects.toMatchObject(nf);
    expect((await caller(leadB).telematics.faults({})).faults.some(f => f.id === Number(fault.insertId))).toBe(false);
    expect((await caller(leadA).telematics.faults({})).faults.some(f => f.id === Number(fault.insertId))).toBe(true);
    // An organization's list shows its own work orders and nobody else's.
    const listB = await caller(leadB).fieldRoute.workOrders.list();
    expect(listB.some(w => w.id === woA)).toBe(false);
    expect((await caller(leadA).fieldRoute.workOrders.list()).some(w => w.id === woA)).toBe(true);
    // And an assignee must belong to the same organization.
    await expect(caller(leadA).maintenance.workOrderAssign({ workOrderId: woA, toUserId: leadB })).rejects.toMatchObject(nf);
  });
});
