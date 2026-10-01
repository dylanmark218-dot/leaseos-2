/**
 * Canonical role assignment, against a real database.
 *
 * Two families of test live here and they matter for different reasons.
 *
 * The first is behaviour: a slot binds, rebinds and keeps its history, and OD-1's rule — one
 * operator and one unit per posting at a time — holds on the *first* assignment as much as on a
 * reassignment. Filling role 2 with the driver already on role 1 is the same error whichever slot
 * was open first.
 *
 * The second is the boundary this whole subsystem exists to draw. `jobUnits.create` became an award
 * path by accident: it sets `usedForAward` when handed an eligibility check, and its gate is
 * documented as "the award's rule, without a posting or a bid". Assignment here must be provably
 * incapable of that, so the award-separation tests assert against the award's own durable
 * evidence — bookings, `usedForAward`, `assignment_approved`, bid and invitation status — rather
 * than against an intention stated in a comment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("role assignment — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped assignment suite proves nothing").toBeTruthy();
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
let assetId = 1_440_000_000 + Math.floor(Math.random() * 40_000_000);
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

/* ================================================================== */
/* Binding a slot                                                      */
/* ================================================================== */

d("assigning a slot", () => {
  it("D1. binds an open slot and writes one creation event", async () => {
    const s = await scene(1);
    const op = await operator(s.a), u = await unit(s.a);
    const out = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: op, unitId: u, expectedLastEventId: null,
    });
    const row = await roleRow(s.roleIds[0]!);
    expect(Number(row.assignedOperatorId)).toBe(op);
    expect(Number(row.assignedUnitId)).toBe(u);
    expect(row.status).toBe("assigned");

    const ev = await events(s.roleIds[0]!);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.eventType).toBe("assignment_created");
    expect(ev[0]!.fromOperatorId).toBeNull();
    expect(Number(ev[0]!.toOperatorId)).toBe(op);
    expect(out.lastEventId).toBe(Number(ev[0]!.id));
  });

  it("D2. three slots on one job take three different crews — the whole point of the model", async () => {
    const s = await scene(3);
    for (const roleId of s.roleIds) {
      await caller(s.disp).dispatch.setRoleAssignment({
        roleId, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
      });
    }
    const r = await caller(s.disp).dispatch.listRoles({ jobId: s.jobId });
    expect(r.staffing.state).toBe("staffed");
    expect(r.staffing.filled).toBe(3);
  });

  it("D3. rebinding a filled slot is a reassignment, and the displaced crew is named in history", async () => {
    const s = await scene(1);
    const op1 = await operator(s.a), u1 = await unit(s.a);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op1, unitId: u1, expectedLastEventId: null });
    const op2 = await operator(s.a), u2 = await unit(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: op2, unitId: u2, expectedLastEventId: first.lastEventId, reason: "Driver called off",
    });
    const ev = await events(s.roleIds[0]!);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.eventType).toBe("assignment_reassigned");
    expect(Number(ev[1]!.fromOperatorId)).toBe(op1);
    expect(Number(ev[1]!.toOperatorId)).toBe(op2);
    expect(ev[1]!.reason).toBe("Driver called off");
  });

  it("D4. changing one slot disturbs no sibling", async () => {
    const s = await scene(3);
    const bound: { roleId: number; op: number; unit: number; head: number | null }[] = [];
    for (const roleId of s.roleIds) {
      const op = await operator(s.a), u = await unit(s.a);
      const r = await caller(s.disp).dispatch.setRoleAssignment({ roleId, operatorId: op, unitId: u, expectedLastEventId: null });
      bound.push({ roleId, op, unit: u, head: r.lastEventId });
    }
    const target = bound[1]!;
    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: target.roleId, operatorId: await operator(s.a), unitId: await unit(s.a),
      expectedLastEventId: target.head, reason: "Truck swapped",
    });
    for (const b of [bound[0]!, bound[2]!]) {
      const row = await roleRow(b.roleId);
      expect(Number(row.assignedOperatorId), "a sibling slot must be untouched").toBe(b.op);
      expect(Number(row.assignedUnitId)).toBe(b.unit);
      expect(await events(b.roleId)).toHaveLength(1);
    }
  });

  it("D5. binds a trailer where one is given", async () => {
    const s = await scene(1);
    const t = await unit(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), trailerId: t, expectedLastEventId: null,
    });
    expect(Number((await roleRow(s.roleIds[0]!)).assignedTrailerId)).toBe(t);
  });
});

/* ================================================================== */
/* OD-1 — one resource, one active slot per posting                    */
/* ================================================================== */

d("OD-1: a resource may not hold two active slots on one posting", () => {
  it("D6. the same operator on a second slot of the same posting is refused", async () => {
    const s = await scene(2);
    const op = await operator(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null });
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[1]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null,
    })).rejects.toThrow(/already/i);
    // and the first binding is untouched
    expect(Number((await roleRow(s.roleIds[0]!)).assignedOperatorId)).toBe(op);
    expect((await roleRow(s.roleIds[1]!)).status).toBe("open");
  });

  it("D7. the same unit on a second slot of the same posting is refused", async () => {
    const s = await scene(2);
    const u = await unit(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: u, expectedLastEventId: null });
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[1]!, operatorId: await operator(s.a), unitId: u, expectedLastEventId: null,
    })).rejects.toThrow(/already/i);
  });

  /*
   * Cross-posting exclusivity is deliberately NOT enforced here. The repository's conflict checker
   * compares `resourceBookings` windows, assignment creates no booking by design, and a posting
   * carries no time window at all — the award takes startsAt/endsAt as call input. Enforcing it
   * here would mean inventing a window, which is the weaker second conflict engine we must not
   * build. It remains the award's job, at award time, against real bookings.
   */
  it("D8. the same operator on a DIFFERENT posting is allowed — cross-posting conflict is the award's job", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const op = await operator(a);
    const j1 = await job(a), j2 = await job(a);
    const p1 = await caller(disp).dispatch.createPosting({ jobId: j1, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    const p2 = await caller(disp).dispatch.createPosting({ jobId: j2, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    await caller(disp).dispatch.setRoleAssignment({ roleId: p1.roleIds[0]!, operatorId: op, unitId: await unit(a), expectedLastEventId: null });
    await expect(caller(disp).dispatch.setRoleAssignment({
      roleId: p2.roleIds[0]!, operatorId: op, unitId: await unit(a), expectedLastEventId: null,
    })).resolves.toBeTruthy();
  });

  it("D10. a cancelled slot does not reserve its resources", async () => {
    const s = await scene(2);
    const op = await operator(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null });
    await pool.execute("UPDATE dispatchRoles SET status = 'cancelled' WHERE id = ?", [s.roleIds[0]!]);
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[1]!, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null,
    })).resolves.toBeTruthy();
  });
});

/* ================================================================== */
/* Concurrency                                                         */
/* ================================================================== */

d("concurrency", () => {
  it("D11. a stale event head is refused, and the first writer's binding survives", async () => {
    const s = await scene(1);
    const opA = await operator(s.a);
    const first = await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: opA, unitId: await unit(s.a), expectedLastEventId: null });
    const opB = await operator(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: opB, unitId: await unit(s.a), expectedLastEventId: first.lastEventId, reason: "first change" });
    // A third dispatcher submits the token they read before B's change landed.
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a),
      expectedLastEventId: first.lastEventId, reason: "stale",
    })).rejects.toThrow(/changed since|conflict|stale/i);
    expect(Number((await roleRow(s.roleIds[0]!)).assignedOperatorId), "B's change stands").toBe(opB);
  });

  it("D12. claiming no history on a slot that has some is refused", async () => {
    const s = await scene(1);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null });
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    })).rejects.toThrow(/changed since|conflict|stale/i);
  });

  it("D13. four simultaneous first assignments produce exactly one winner and one event", async () => {
    const s = await scene(1);
    const crews = await Promise.all([0, 1, 2, 3].map(async () => ({ op: await operator(s.a), u: await unit(s.a) })));
    const results = await Promise.allSettled(crews.map(c =>
      caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: c.op, unitId: c.u, expectedLastEventId: null })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await events(s.roleIds[0]!), "exactly one event, so exactly one write won").toHaveLength(1);
  });

  /* OD-1 is a property of a SET of rows, so it needs the posting serialised, not just the role. */
  it("D14. two slots of one posting cannot both take the same operator concurrently", async () => {
    const s = await scene(2);
    const op = await operator(s.a);
    const results = await Promise.allSettled(s.roleIds.map(async roleId =>
      caller(s.disp).dispatch.setRoleAssignment({ roleId, operatorId: op, unitId: await unit(s.a), expectedLastEventId: null })));
    expect(results.filter(r => r.status === "fulfilled"),
      "without the posting lock both would pass their read-then-write check").toHaveLength(1);
  });
});

/* ================================================================== */
/* Authorization and tenancy                                           */
/* ================================================================== */

d("authorization and tenancy", () => {
  it("D15. a caller who may read dispatch but not assign is refused", async () => {
    const s = await scene(1);
    const auditor = await member(s.a, "auditor");
    await expect(caller(auditor).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    })).rejects.toThrow();
  });

  it("D16. another organization's slot is not found", async () => {
    const s = await scene(1);
    const b = await org();
    const dispB = await member(b, "dispatcher");
    await expect(caller(dispB).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(b), unitId: await unit(b), expectedLastEventId: null,
    })).rejects.toThrow(/not found/i);
  });

  it("D17. another organization's unit, operator and trailer are each refused", async () => {
    const s = await scene(1);
    const b = await org();
    const base = { roleId: s.roleIds[0]!, expectedLastEventId: null as number | null };
    await expect(caller(s.disp).dispatch.setRoleAssignment({ ...base, operatorId: await operator(s.a), unitId: await unit(b) })).rejects.toThrow(/not found/i);
    await expect(caller(s.disp).dispatch.setRoleAssignment({ ...base, operatorId: await operator(b), unitId: await unit(s.a) })).rejects.toThrow(/not found/i);
    await expect(caller(s.disp).dispatch.setRoleAssignment({ ...base, operatorId: await operator(s.a), unitId: await unit(s.a), trailerId: await unit(b) })).rejects.toThrow(/not found/i);
    expect((await roleRow(s.roleIds[0]!)).status, "nothing was bound by any of those attempts").toBe("open");
  });

  it("D18. a slot, unit or operator that does not exist is refused", async () => {
    const s = await scene(1);
    await expect(caller(s.disp).dispatch.setRoleAssignment({ roleId: 2_000_000_000, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null })).rejects.toThrow(/not found/i);
    await expect(caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: 2_000_000_000, expectedLastEventId: null })).rejects.toThrow(/not found/i);
    await expect(caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: 2_000_000_000, unitId: await unit(s.a), expectedLastEventId: null })).rejects.toThrow(/not found/i);
  });
});

/* ================================================================== */
/* Award separation — the non-negotiable invariants                    */
/* ================================================================== */

d("an assignment is not an award", () => {
  /** Binds a slot and returns everything needed to inspect the award's evidence afterwards. */
  async function assigned() {
    const s = await scene(2);
    const first = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    });
    // ...and a reassignment, because both paths must satisfy every invariant.
    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a),
      expectedLastEventId: first.lastEventId, reason: "swap",
    });
    return s;
  }

  it("D19. never sets dispatchEligibilityChecks.usedForAward", async () => {
    const s = await assigned();
    // Nothing in this flow creates a check; the flag must also not be set on any existing one.
    expect(await count("SELECT COUNT(*) n FROM dispatchEligibilityChecks WHERE jobId = ?", [s.jobId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM dispatchEligibilityChecks WHERE usedForAward = 1 AND jobId = ?", [s.jobId])).toBe(0);
  });

  it("D20. never writes an award audit event", async () => {
    const s = await assigned();
    expect(await count("SELECT COUNT(*) n FROM dispatchAuditEvents WHERE postingId = ?", [s.postingId])).toBe(0);
  });

  it("D21. never creates a resource booking", async () => {
    const s = await assigned();
    expect(await count("SELECT COUNT(*) n FROM resourceBookings WHERE postingId = ?", [s.postingId])).toBe(0);
  });

  it("D22. never consumes a bid or an invitation", async () => {
    const s = await assigned();
    expect(await count("SELECT COUNT(*) n FROM dispatchBids WHERE postingId = ?", [s.postingId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM dispatchInvitations WHERE postingId = ?", [s.postingId])).toBe(0);
  });

  /*
   * The input schema is `.strict()`, so an award credential is not merely ignored — it is refused.
   * Stripping it silently would let a caller believe they had awarded something.
   */
  it("D23. refuses an eligibilityCheckId outright — it is not a key this contract has", async () => {
    const s = await scene(1);
    await expect(caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a),
      expectedLastEventId: null, eligibilityCheckId: 1,
    } as never)).rejects.toThrow();
  });

  it("D24. returns no readiness verdict of any kind", async () => {
    const s = await scene(1);
    const out = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    }) as Record<string, unknown>;
    for (const k of ["verdict", "eligible", "ready", "blockers", "capabilities", "capabilityVerdict"]) {
      expect(out[k], `assignment must not answer the readiness question ("${k}")`).toBeUndefined();
    }
  });

  it("D25. leaves the posting's planning state short of anything that reads as awarded", async () => {
    const s = await assigned();
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT planningState FROM dispatchPostings WHERE id = ?", [s.postingId]);
    expect(["direct", "partially_staffed", "staffed"]).toContain(rows[0]!.planningState);
    expect(rows[0]!.planningState).not.toBe("dispatched");
  });
});
