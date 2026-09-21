/**
 * Unassignment, against a real database.
 *
 * Clearing a slot is the one operation that can move a staffed posting backwards, and the one that
 * removes somebody from work they were expected to do — so it always takes a reason, and it
 * destroys nothing. The history keeps the binding it displaced, the siblings are untouched, and the
 * award's own records are not this operation's to edit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("role unassignment — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped unassignment suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 880_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 8 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, role: string) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function job(orgRef: string) {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'water_haul','transport','Acme','LSD','dispatched',0)", [orgRef, jobCode]);
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return Number(r[0]!.id);
}
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [`U-${rnd()}`]);
  const id = Number(u.insertId);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, id]);
  return id;
}
async function operator(orgRef: string) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 400 DAY))", [seq++, `Op ${rnd()}`]);
  const id = Number(o.insertId);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, id]);
  return id;
}

/** A posting with `n` required slots, and the resources to fill them. */
async function scene(n = 3) {
  const a = await org();
  const disp = await member(a, "dispatcher");
  const j = await job(a);
  const codes = ["PRIMARY_UNIT", "SUPPORT_UNIT", "WINCH_TRACTOR", "PICKER", "STANDBY"];
  const out = await caller(disp).dispatch.createPosting({ jobId: j, roles: codes.slice(0, n).map(roleCode => ({ roleCode })) });
  return { a, disp, jobId: j, ...out };
}
const roleRow = async (roleId: number) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT * FROM dispatchRoles WHERE id = ?", [roleId]))[0][0]!;
const events = async (roleId: number) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT * FROM dispatchRoleAssignmentEvents WHERE roleId = ? ORDER BY id", [roleId]))[0];
const count = async (sql: string, p: unknown[] = []) =>
  Number((await pool.query<mysql.RowDataPacket[]>(sql, p))[0][0]!.n);

d("clearing a slot", () => {
  it("E1. returns the slot to open, unbinds it, and records who and why", async () => {
    const s = await scene(1);
    const op = await operator(s.a), u = await unit(s.a);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op, unitId: u, expectedLastEventId: null });
    await caller(s.disp).dispatch.clearRoleAssignment({ roleId: s.roleIds[0]!, expectedLastEventId: first.lastEventId, reason: "Crew stood down" });

    const row = await roleRow(s.roleIds[0]!);
    expect(row.status).toBe("open");
    expect(row.assignedOperatorId).toBeNull();
    expect(row.assignedUnitId).toBeNull();
    expect(row.assignedTrailerId).toBeNull();

    const ev = await events(s.roleIds[0]!);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.eventType).toBe("assignment_unassigned");
    expect(Number(ev[1]!.fromOperatorId), "history keeps the binding it displaced").toBe(op);
    expect(ev[1]!.toOperatorId).toBeNull();
    expect(ev[1]!.reason).toBe("Crew stood down");
  });

  /*
   * Two layers, and the second is the one that matters. The input schema refuses an empty string,
   * but `min(1)` happily accepts "   " — so without the service's own trim check a dispatcher could
   * stand a crew down with a reason that says nothing. Both are asserted because the first mutation
   * of this pair survived when only the empty string was tested: the router was doing all the work
   * and the service check was unreachable from the API.
   */
  it("E2a. refuses an empty reason at the contract boundary", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null });
    await expect(caller(s.disp).dispatch.clearRoleAssignment({
      roleId: s.roleIds[0]!, expectedLastEventId: first.lastEventId, reason: "",
    } as never)).rejects.toThrow();
  });

  it("E2b. refuses a reason that is only whitespace, which the schema alone would let through", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null });
    await expect(caller(s.disp).dispatch.clearRoleAssignment({
      roleId: s.roleIds[0]!, expectedLastEventId: first.lastEventId, reason: "   ",
    })).rejects.toThrow(/reason/i);
    expect((await roleRow(s.roleIds[0]!)).status, "the slot is still bound").toBe("assigned");
  });

  it("E3. refuses a stale token, leaving the binding alone", async () => {
    const s = await scene(1);
    const op = await operator(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null });
    await expect(caller(s.disp).dispatch.clearRoleAssignment({
      roleId: s.roleIds[0]!, expectedLastEventId: null, reason: "stale",
    })).rejects.toThrow(/changed since|conflict|stale/i);
    expect(Number((await roleRow(s.roleIds[0]!)).assignedOperatorId)).toBe(op);
  });

  it("E4. leaves every sibling slot exactly as it was", async () => {
    const s = await scene(3);
    const heads: (number | null)[] = [];
    const ops: number[] = [];
    for (const roleId of s.roleIds) {
      const op = await operator(s.a);
      ops.push(op);
      heads.push((await caller(s.disp).dispatch.setRoleAssignment({ roleId, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null })).lastEventId);
    }
    await caller(s.disp).dispatch.clearRoleAssignment({ roleId: s.roleIds[1]!, expectedLastEventId: heads[1]!, reason: "Driver sick" });
    expect(Number((await roleRow(s.roleIds[0]!)).assignedOperatorId)).toBe(ops[0]);
    expect(Number((await roleRow(s.roleIds[2]!)).assignedOperatorId)).toBe(ops[2]);
    expect(await events(s.roleIds[0]!)).toHaveLength(1);
  });

  it("E5. destroys no history — every earlier event survives", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null });
    const second = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: first.lastEventId, reason: "swap" });
    await caller(s.disp).dispatch.clearRoleAssignment({ roleId: s.roleIds[0]!, expectedLastEventId: second.lastEventId, reason: "stood down" });
    const ev = await events(s.roleIds[0]!);
    expect(ev.map(e => e.eventType)).toEqual(["assignment_created", "assignment_reassigned", "assignment_unassigned"]);
  });

  it("E6. touches no award record", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null });
    await caller(s.disp).dispatch.clearRoleAssignment({ roleId: s.roleIds[0]!, expectedLastEventId: first.lastEventId, reason: "stood down" });
    expect(await count("SELECT COUNT(*) n FROM dispatchAuditEvents WHERE postingId = ?", [s.postingId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM resourceBookings WHERE postingId = ?", [s.postingId])).toBe(0);
  });

  it("E7. a caller who may read but not assign cannot clear", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null });
    const auditor = await member(s.a, "auditor");
    await expect(caller(auditor).dispatch.clearRoleAssignment({ roleId: s.roleIds[0]!, expectedLastEventId: first.lastEventId, reason: "no" })).rejects.toThrow();
  });
});

d("OD-1 is about simultaneous use, not sequential use", () => {
  it("D9. sequential use is not simultaneous use — unassign then reassign elsewhere is allowed", async () => {
    const s = await scene(2);
    const op = await operator(s.a);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null });
    await caller(s.disp).dispatch.clearRoleAssignment({ roleId: s.roleIds[0]!, expectedLastEventId: first.lastEventId, reason: "Moved to the other truck" });
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[1]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null,
    })).resolves.toBeTruthy();
  });

});
