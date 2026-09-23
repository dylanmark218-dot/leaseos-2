/**
 * P4.1 router 4 — the shop: a unit, and the work orders on it, belong to the organization that
 * owns the unit (coreRecordOwnership). Twelve shop procedures key to a unit or a work order and
 * now answer "not found" across that boundary — never "forbidden", which would confirm a row
 * exists. The historical single tenant still sees its unowned units. Parts, tools and the tire
 * registry are shop-level stock with no unit and stay unscoped, on purpose, until they carry one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 240_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function unitOwnedBy(orgRef: string | null) {
  const unitNumber = `U-${rnd()}`;
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [unitNumber, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  const woNo = `WO-${rnd()}`;
  const [w] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO workOrders (workOrderNumber, unitId, status, priority, openedAt, technician, createdAt, updatedAt) VALUES (?, ?, 'in_progress', 'routine', '2026-09-01 00:00:00', 'J. Reyes', NOW(), NOW())", [woNo, u.insertId]);
  return { unitId: u.insertId, unitNumber, workOrderNumber: woNo, workOrderId: w.insertId };
}

d("the shop belongs to the organization that owns the unit", () => {
  it("answers not-found across the boundary for unit and work-order procedures, serves the owner, and still serves the historical single tenant's unowned units", async () => {
    const A = await org(), B = await org();
    const mechA = await member(A, ["shop_lead"]), mechB = await member(B, ["shop_lead"]), legacy = await member(null, ["shop_lead"]);
    const a = await unitOwnedBy(A), unowned = await unitOwnedBy(null);
    // The owner sees its unit's cost and work-order cost.
    await expect(callerFor(mechA).shop.unitCost({ unitId: a.unitId })).resolves.toBeTruthy();
    await expect(callerFor(mechA).shop.workOrderCost({ workOrderNumber: a.workOrderNumber })).resolves.toBeTruthy();
    // Another organization's mechanic: not found, never forbidden — the row's existence is not confirmed.
    await expect(callerFor(mechB).shop.unitCost({ unitId: a.unitId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mechB).shop.workOrderCost({ workOrderNumber: a.workOrderNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mechB).shop.workOrderAdvance({ workOrderId: a.workOrderId, to: "waiting_parts" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // F1.1 — warranty records carry no organization, so with organizations present they are refused outright
    // (OWNERSHIP_UNRESOLVED) before any unit is looked up. Still a refusal; it confirms nothing about A's unit.
    await expect(callerFor(mechB).shop.warrantyPolicyRecord({ subjectType: "unit_component", subjectId: 1, unitId: a.unitId, coverageUntil: new Date("2027-01-01") } as never)).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);
    await expect(callerFor(mechB).shop.recallRecord({ source: "OEM", sourceRef: `RC-${rnd()}`, summary: "brake line fitting may crack under load", unitIds: [a.unitId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A member of an organization does not see the historical single tenant's unowned unit either; the legacy caller does.
    await expect(callerFor(mechA).shop.unitCost({ unitId: unowned.unitId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(legacy).shop.unitCost({ unitId: unowned.unitId })).resolves.toBeTruthy();
    await expect(callerFor(legacy).shop.workOrderCost({ workOrderNumber: unowned.workOrderNumber })).resolves.toBeTruthy();
    // And the legacy caller does not see an organization's unit.
    await expect(callerFor(legacy).shop.unitCost({ unitId: a.unitId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});
