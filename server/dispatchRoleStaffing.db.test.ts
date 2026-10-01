/**
 * Staffing, derived from current occupancy — and the one thing the persisted field cannot say.
 *
 * `planningState` carries two questions in one column: where a posting is in its commercial life,
 * and whether it is crewed right now. Those disagree the moment a driver is pulled off an awarded
 * dispatch. `assessStaffing` has a third state, `unstaffed`, that `PostingState` has no value for,
 * and from `staffed` the only legal backward transition is `partially_staffed` — which would be a
 * lie about a posting with nobody on it.
 *
 * So the derived result is authoritative for presentation and the persisted field is clamped to
 * what its own state machine permits. Both are returned, neither is dressed up as the other, and
 * the tests below pin exactly that split rather than papering over it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("staffing integration — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped staffing suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 882_000_000 + Math.floor(Math.random() * 50_000);
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
/*
 * Units and operators are created with EXPLICIT high ids, not auto-increment.
 *
 * These fixtures claim `coreRecordOwnership` for every unit they make, because an org member can
 * only see units their organization owns. Auto-increment ids start at 1 in a fresh gate database,
 * and other suites hardcode low ids they expect to be UNOWNED — `productionPath.test.ts:45` uses
 * `unitId = 127`, and the default scope's check is `isNull(owner)`, which a nonexistent unit
 * satisfies. Left on auto-increment these fixtures eventually reach 127, own it, and make that
 * suite's work order invisible to its own mechanic. Explicit ids keep this suite out of the range
 * anyone hardcodes, without changing another suite to accommodate this one.
 */
let assetId = 1_400_000_000 + Math.floor(Math.random() * 40_000_000);
const nextAssetId = () => assetId++;

async function unit(orgRef: string) {
  const id = nextAssetId();
  await pool.execute("INSERT INTO units (id, unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, ?, 'vacuum_truck', 'ABC', 'clear')", [id, `U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, id]);
  return id;
}
async function operator(orgRef: string) {
  const id = nextAssetId();
  await pool.execute("INSERT INTO operators (id, userId, name, licenseExpiresAt) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 400 DAY))", [id, seq++, `Op ${rnd()}`]);
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

const planningState = async (postingId: number) =>
  String((await pool.query<mysql.RowDataPacket[]>("SELECT planningState FROM dispatchPostings WHERE id = ?", [postingId]))[0][0]!.planningState);

/** Fills every slot given, returning each slot's concurrency head. */
async function fill(s: { a: string; disp: number; roleIds: number[] }, roleIds: number[]) {
  const heads = new Map<number, number | null>();
  for (const roleId of roleIds) {
    const r = await caller(s.disp).dispatch.setRoleAssignment({
      roleId, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    });
    heads.set(roleId, r.lastEventId);
  }
  return heads;
}

d("staffing follows occupancy", () => {
  it("F1. every required slot filled reads staffed, in both the derived result and the persisted field", async () => {
    const s = await scene(3);
    await fill(s, s.roleIds);
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state).toBe("staffed");
    expect(r.staffing.filled).toBe(3);
    expect(await planningState(s.postingId)).toBe("staffed");
  });

  /* The regression this checkpoint exists for. */
  it("F2. clearing one required slot stops the posting presenting itself as staffed", async () => {
    const s = await scene(3);
    const heads = await fill(s, s.roleIds);
    expect(await planningState(s.postingId)).toBe("staffed");

    await caller(s.disp).dispatch.clearRoleAssignment({
      roleId: s.roleIds[1]!, expectedLastEventId: heads.get(s.roleIds[1]!)!, reason: "Driver sick",
    });

    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state).toBe("partially_staffed");
    expect(r.staffing.filled).toBe(2);
    expect(r.staffing.requiredTotal).toBe(3);
    expect(await planningState(s.postingId), "the persisted field must not still claim staffed").not.toBe("staffed");
  });

  it("F3. losing every required slot reads unstaffed, and never becomes awarding", async () => {
    const s = await scene(2);
    const heads = await fill(s, s.roleIds);
    for (const roleId of s.roleIds) {
      const cur = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
      const head = cur.roles.find(x => x.roleId === roleId)!.lastEventId;
      await caller(s.disp).dispatch.clearRoleAssignment({ roleId, expectedLastEventId: head, reason: "Crew stood down" });
    }
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state, "the derived truth can say zero-of-N").toBe("unstaffed");
    expect(r.staffing.filled).toBe(0);

    const persisted = await planningState(s.postingId);
    expect(persisted, "awarding is not a substitute for missing resources").not.toBe("awarding");
    expect(persisted).not.toBe("staffed");
    // And what it IS, is the clamp: the only legal backward transition the state machine allows.
    expect(persisted).toBe("partially_staffed");
    expect(heads.size).toBe(2);
  });

  it("F4. an unfilled OPTIONAL slot never holds a posting back", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({
      jobId: j, roles: [{ roleCode: "PRIMARY_UNIT" }, { roleCode: "SUPPORT_UNIT" }, { roleCode: "STANDBY", required: false }],
    });
    await caller(disp).dispatch.setRoleAssignment({ roleId: out.roleIds[0]!, operatorId: await operator(a), unitId: await unit(a), expectedLastEventId: null });
    await caller(disp).dispatch.setRoleAssignment({ roleId: out.roleIds[1]!, operatorId: await operator(a), unitId: await unit(a), expectedLastEventId: null });
    const r = await caller(disp).dispatch.listRoles({ jobId: j });
    expect(r.staffing.state).toBe("staffed");
    expect(r.staffing.requiredTotal).toBe(2);
    expect(r.roles.find(x => x.roleCode === "STANDBY")?.operatorId).toBeNull();
    expect(await planningState(out.postingId)).toBe("staffed");
  });

  it("F5. losing a slot destroys no history", async () => {
    const s = await scene(1);
    const heads = await fill(s, s.roleIds);
    await caller(s.disp).dispatch.clearRoleAssignment({ roleId: s.roleIds[0]!, expectedLastEventId: heads.get(s.roleIds[0]!)!, reason: "stood down" });
    const ev = await events(s.roleIds[0]!);
    expect(ev.map(e => e.eventType)).toEqual(["assignment_created", "assignment_unassigned"]);
  });

  it("F6. the mutation returns the same staffing picture the read does", async () => {
    const s = await scene(2);
    const first = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    });
    const read = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(first.staffing.state).toBe(read.staffing.state);
    expect(first.staffing.filled).toBe(read.staffing.filled);
    expect(first.staffing.requiredTotal).toBe(read.staffing.requiredTotal);
  });
});
