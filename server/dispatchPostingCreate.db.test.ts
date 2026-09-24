/**
 * The creation door, against a real database.
 *
 * Until this checkpoint there was no production path that could create a `dispatchPosting` or a
 * `dispatchRole` — zero INSERTs anywhere in the tree. The slot model was complete in schema and in
 * pure logic and could only ever be filled by rows a test fixture had conjured. An assignment
 * system that can assign only slots nobody can create is not an assignment system.
 *
 * The second thing pinned here is what creating a posting must *not* do. Planning a dispatch is not
 * awarding one, and the award's durable evidence — bookings, `usedForAward`, `assignment_approved`
 * — must be untouched by an act of planning.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("dispatch posting creation — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped creation suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 770_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
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
/**
 * Binds a slot by direct SQL. Deliberate: this suite tests the READ of staffing, and the assignment
 * mutation does not exist until checkpoint D. D's own suite drives the production path.
 */
const bind = (roleId: number, operatorId: number, unitId: number) =>
  pool.execute("UPDATE dispatchRoles SET assignedOperatorId = ?, assignedUnitId = ?, status = 'assigned' WHERE id = ?", [operatorId, unitId, roleId]);

/* ================================================================== */
/* createPosting                                                       */
/* ================================================================== */

d("dispatch.createPosting", () => {
  it("R1. creates a posting for an in-scope job, in a legal state for a direct assignment", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({ jobId: j });
    expect(out.postingId).toBeGreaterThan(0);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT jobId, distribution, planningState FROM dispatchPostings WHERE id = ?", [out.postingId]);
    expect(Number(rows[0]!.jobId)).toBe(j);
    expect(rows[0]!.distribution).toBe("direct_assignment");
    expect(rows[0]!.planningState).toBe("direct");
  });

  it("R2. refuses a job belonging to another organization", async () => {
    const a = await org(), b = await org();
    const dispB = await member(b, "dispatcher");
    const j = await job(a);
    await expect(caller(dispB).dispatch.createPosting({ jobId: j })).rejects.toThrow(/not found/i);
  });

  it("R3. refuses a caller who may read dispatch but not assign", async () => {
    const a = await org();
    const auditor = await member(a, "auditor");   // holds dispatch.read, not dispatch.assign
    const j = await job(a);
    await expect(caller(auditor).dispatch.createPosting({ jobId: j })).rejects.toThrow();
  });

  /* Planning is not awarding. */
  it("R4. writes no booking, no award audit event and no eligibility check", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({ jobId: j, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    const one = async (sql: string, p: unknown[]) => Number((await pool.query<mysql.RowDataPacket[]>(sql, p))[0][0]!.n);
    expect(await one("SELECT COUNT(*) n FROM resourceBookings WHERE postingId = ?", [out.postingId])).toBe(0);
    expect(await one("SELECT COUNT(*) n FROM dispatchAuditEvents WHERE postingId = ?", [out.postingId])).toBe(0);
    expect(await one("SELECT COUNT(*) n FROM dispatchEligibilityChecks WHERE jobId = ?", [j])).toBe(0);
  });

  it("R5. creates the roles it was given, all open and unbound", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({
      jobId: j, roles: [{ roleCode: "PRIMARY_UNIT" }, { roleCode: "SUPPORT_UNIT" }, { roleCode: "STANDBY", required: false }],
    });
    expect(out.roleIds).toHaveLength(3);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT roleCode, status, assignedOperatorId, assignedUnitId, required FROM dispatchRoles WHERE postingId = ? ORDER BY id", [out.postingId]);
    expect(rows.map(r => r.roleCode)).toEqual(["PRIMARY_UNIT", "SUPPORT_UNIT", "STANDBY"]);
    for (const r of rows) {
      expect(r.status).toBe("open");
      expect(r.assignedOperatorId).toBeNull();
      expect(r.assignedUnitId).toBeNull();
    }
    expect(Boolean(rows[2]!.required), "STANDBY was asked for as optional").toBe(false);
    expect(Boolean(rows[0]!.required), "roles are required unless said otherwise").toBe(true);
  });
});

/* ================================================================== */
/* addRole                                                             */
/* ================================================================== */

d("dispatch.addRole", () => {
  const posting = async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({ jobId: j });
    return { a, disp, jobId: j, postingId: out.postingId };
  };

  it("R6. adds an open slot from a catalog type", async () => {
    const p = await posting();
    const out = await caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: "WINCH_TRACTOR" });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT roleCode, roleLabel, status FROM dispatchRoles WHERE id = ?", [out.roleId]);
    expect(rows[0]!.roleCode).toBe("WINCH_TRACTOR");
    expect(rows[0]!.roleLabel, "the label comes from the catalog's display name").toBe("Winch tractor");
    expect(rows[0]!.status).toBe("open");
  });

  it("R7. refuses a role code nobody defined", async () => {
    const p = await posting();
    await expect(caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: `NOPE_${rnd()}` }))
      .rejects.toThrow(/role type|not defined|unknown/i);
  });

  it("R8. refuses a deactivated role type, and leaves roles already carrying it alone", async () => {
    const p = await posting();
    const code = `T_${rnd()}`;
    await pool.execute("INSERT INTO dispatchRoleTypes (orgRef, roleCode, displayName, active, createdByUserId) VALUES (NULL,?,?,1,1)", [code, "Temp"]);
    const made = await caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: code });
    await pool.execute("UPDATE dispatchRoleTypes SET active = 0 WHERE roleCode = ? AND orgRef IS NULL", [code]);
    await expect(caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: code })).rejects.toThrow();
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT status FROM dispatchRoles WHERE id = ?", [made.roleId]);
    expect(rows, "the existing slot survives its type being retired").toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
  });

  it("R9. snapshots the type's requirement defaults onto the slot", async () => {
    const p = await posting();
    const code = `T_${rnd()}`;
    await pool.execute("INSERT INTO dispatchRoleTypes (orgRef, roleCode, displayName, defaultEquipmentClass, defaultTrailerClass, createdByUserId) VALUES (NULL,?,?,?,?,1)", [code, "Tandem", "tandem", "none"]);
    const out = await caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: code });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT requiredEquipmentClass, requiredTrailerClass FROM dispatchRoles WHERE id = ?", [out.roleId]);
    expect(rows[0]!.requiredEquipmentClass).toBe("tandem");
    expect(rows[0]!.requiredTrailerClass).toBe("none");
  });

  /*
   * The defaults are a snapshot, not a pointer. Editing the catalog must never silently restate
   * what an existing posting requires — a dispatcher who read "tandem" yesterday must not find the
   * slot quietly demanding something else today.
   */
  it("R10. editing the catalog afterwards does not change an existing slot's requirements", async () => {
    const p = await posting();
    const code = `T_${rnd()}`;
    await pool.execute("INSERT INTO dispatchRoleTypes (orgRef, roleCode, displayName, defaultEquipmentClass, createdByUserId) VALUES (NULL,?,?,?,1)", [code, "Tandem", "tandem"]);
    const out = await caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: code });
    await pool.execute("UPDATE dispatchRoleTypes SET defaultEquipmentClass = 'tridem' WHERE roleCode = ? AND orgRef IS NULL", [code]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT requiredEquipmentClass FROM dispatchRoles WHERE id = ?", [out.roleId]);
    expect(rows[0]!.requiredEquipmentClass, "the slot keeps what it was created with").toBe("tandem");
  });

  it("R11. an explicit requirement beats the catalog default", async () => {
    const p = await posting();
    const code = `T_${rnd()}`;
    await pool.execute("INSERT INTO dispatchRoleTypes (orgRef, roleCode, displayName, defaultEquipmentClass, createdByUserId) VALUES (NULL,?,?,?,1)", [code, "Tandem", "tandem"]);
    const out = await caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: code, requiredEquipmentClass: "tridem" });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT requiredEquipmentClass FROM dispatchRoles WHERE id = ?", [out.roleId]);
    expect(rows[0]!.requiredEquipmentClass).toBe("tridem");
  });

  it("R12. refuses a posting in another organization", async () => {
    const p = await posting();
    const b = await org();
    const dispB = await member(b, "dispatcher");
    await expect(caller(dispB).dispatch.addRole({ postingId: p.postingId, roleCode: "PICKER" })).rejects.toThrow(/not found/i);
  });

  it("R13. never binds a resource implicitly", async () => {
    const p = await posting();
    const out = await caller(p.disp).dispatch.addRole({ postingId: p.postingId, roleCode: "PICKER" });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT assignedOperatorId, assignedUnitId, assignedTrailerId FROM dispatchRoles WHERE id = ?", [out.roleId]);
    expect(rows[0]!.assignedOperatorId).toBeNull();
    expect(rows[0]!.assignedUnitId).toBeNull();
    expect(rows[0]!.assignedTrailerId).toBeNull();
  });
});

/* ================================================================== */
/* listRoles, and the staffing picture                                 */
/* ================================================================== */

d("dispatch.listRoles", () => {
  async function threeRequired() {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({
      jobId: j, roles: [{ roleCode: "PRIMARY_UNIT" }, { roleCode: "SUPPORT_UNIT" }, { roleCode: "WINCH_TRACTOR" }],
    });
    return { a, disp, jobId: j, ...out };
  }

  it("R14. is filtered to one job, unlike the tenant-wide window jobUnits.list offers", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j1 = await job(a), j2 = await job(a);
    await caller(disp).dispatch.createPosting({ jobId: j1, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    await caller(disp).dispatch.createPosting({ jobId: j2, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    const r = await caller(disp).dispatch.listRoles({ jobId: j1 });
    expect(r.roles).toHaveLength(1);
    expect(r.roles.every(x => x.jobId === j1)).toBe(true);
  });

  it("R15. refuses another organization's job", async () => {
    const s = await threeRequired();
    const b = await org();
    const dispB = await member(b, "dispatcher");
    await expect(caller(dispB).dispatch.listRoles({ jobId: s.jobId })).rejects.toThrow(/not found/i);
  });

  it("R16. staffing reads 0 of 3 when nothing is filled — a truth planningState cannot express", async () => {
    const s = await threeRequired();
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state).toBe("unstaffed");
    expect(r.staffing.filled).toBe(0);
    expect(r.staffing.requiredTotal).toBe(3);
    expect(r.staffing.unfilledRoles).toHaveLength(3);
  });

  it("R17. staffing reads 1 of 3", async () => {
    const s = await threeRequired();
    await bind(s.roleIds[0]!, await operator(s.a), await unit(s.a));
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state).toBe("partially_staffed");
    expect(r.staffing.filled).toBe(1);
    expect(r.staffing.requiredTotal).toBe(3);
  });

  it("R18. staffing reads 3 of 3", async () => {
    const s = await threeRequired();
    for (const id of s.roleIds) await bind(id, await operator(s.a), await unit(s.a));
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state).toBe("staffed");
    expect(r.staffing.filled).toBe(3);
    expect(r.staffing.unfilledRoles).toEqual([]);
  });

  it("R19. an unfilled OPTIONAL slot does not hold the posting back from staffed", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const out = await caller(disp).dispatch.createPosting({
      jobId: j, roles: [{ roleCode: "PRIMARY_UNIT" }, { roleCode: "STANDBY", required: false }],
    });
    await bind(out.roleIds[0]!, await operator(a), await unit(a));
    const r = await caller(disp).dispatch.listRoles({ jobId: j });
    expect(r.staffing.state).toBe("staffed");
    expect(r.staffing.requiredTotal, "the optional slot is not counted as required").toBe(1);
    expect(r.roles).toHaveLength(2);
    expect(r.roles.find(x => x.roleCode === "STANDBY")?.required).toBe(false);
  });

  it("R20. carries the catalog display name and the concurrency head for each slot", async () => {
    const s = await threeRequired();
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.roles.find(x => x.roleCode === "WINCH_TRACTOR")?.displayName).toBe("Winch tractor");
    // Nothing has happened to these slots yet, so each client sees "no history".
    expect(r.roles.every(x => x.lastEventId === null)).toBe(true);
  });

  it("R21. reports the persisted planningState beside the derived staffing, without conflating them", async () => {
    const s = await threeRequired();
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.planningState, "the coarse lifecycle value, as persisted").toBe("direct");
    expect(r.staffing.state, "the precise truth, derived").toBe("unstaffed");
  });
});
