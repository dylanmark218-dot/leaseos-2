/**
 * The role binding is the readiness subject — proved, not assumed.
 *
 * This checkpoint deliberately ships NO production change. `composeReadiness` takes its subject as
 * a parameter and reads no assignment table at all, so there is no competing source to remove and
 * no invalidation marker to add: a binding change moves the facts, the fingerprint moves with them,
 * and `assessEligibilityValidity` reports `dependency_change`. If any of that needed code, the
 * design was wrong somewhere else.
 *
 * What is worth pinning is the wiring, because it is invisible: nothing else asserts that the slot
 * a dispatcher filled is the subject readiness actually evaluates. Replace `operatorId: op.id` in
 * the composer with a constant and every other test in this repository still passes, while
 * "changing the assigned driver invalidates a prior check" quietly stops being true.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { composeReadiness } from "./readinessComposer";
import { assessEligibilityValidity } from "./_core/dispatchAward";

const DB_URL = process.env.DATABASE_URL;

describe("readiness from the role binding — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped readiness-coupling suite proves nothing").toBeTruthy();
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

/** The subject a dispatcher would evaluate, taken from the slot rather than from jobUnits. */
async function subjectOf(dispatcher: number, jobId: number, roleId: number) {
  const r = await caller(dispatcher).dispatch.listRoles({ jobId });
  const slot = r.roles.find(x => x.roleId === roleId)!;
  return { operatorId: slot.operatorId!, unitId: slot.unitId, trailerId: slot.trailerId, jobId };
}

d("the slot binding is what readiness evaluates", () => {
  it("G1. the operator and unit bound to a slot reach the readiness facts", async () => {
    const s = await scene(1);
    const op = await operator(s.a), u = await unit(s.a);
    await caller(s.disp).dispatch.setRoleAssignment({ roleId: s.roleIds[0]!, operatorId: op, unitId: u, expectedLastEventId: null });

    const subject = await subjectOf(s.disp, s.jobId, s.roleIds[0]!);
    expect(subject.operatorId).toBe(op);
    expect(subject.unitId).toBe(u);

    const r = await composeReadiness(subject);
    expect(r.facts.operatorId, "the composer must carry the slot's operator").toBe(op);
    expect(r.facts.unitId, "the composer must carry the slot's unit").toBe(u);
  });

  it("G2. reassigning the slot moves the fingerprint", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    });
    const before = await composeReadiness(await subjectOf(s.disp, s.jobId, s.roleIds[0]!));

    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a),
      expectedLastEventId: first.lastEventId, reason: "Different crew",
    });
    const after = await composeReadiness(await subjectOf(s.disp, s.jobId, s.roleIds[0]!));

    expect(after.fingerprint, "a different crew is a different world").not.toBe(before.fingerprint);
  });

  it("G3. a check taken before the reassignment can no longer authorise it, and says why", async () => {
    const s = await scene(1);
    const first = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    });
    const taken = await composeReadiness(await subjectOf(s.disp, s.jobId, s.roleIds[0]!));
    const now = new Date();
    const stored = {
      checkId: 1, fingerprint: taken.fingerprint, operatorId: taken.facts.operatorId,
      verdict: taken.eligibility.verdict, blockers: taken.eligibility.blockers,
      evaluatedAt: now, explanation: taken.eligibility.explanation,
    };

    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a),
      expectedLastEventId: first.lastEventId, reason: "Swapped",
    });
    const nowFacts = await composeReadiness(await subjectOf(s.disp, s.jobId, s.roleIds[0]!));

    const validity = assessEligibilityValidity(stored as never, nowFacts.facts, now);
    expect(validity.valid).toBe(false);
    expect(validity.invalidatedBy, "not age — the world changed").toBe("dependency_change");
    expect(validity.requiresReEvaluation).toBe(true);
  });

  it("G4. two slots on one job evaluate as two different subjects", async () => {
    const s = await scene(2);
    for (const roleId of s.roleIds) {
      await caller(s.disp).dispatch.setRoleAssignment({
        roleId, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
      });
    }
    const a = await composeReadiness(await subjectOf(s.disp, s.jobId, s.roleIds[0]!));
    const b = await composeReadiness(await subjectOf(s.disp, s.jobId, s.roleIds[1]!));
    expect(a.facts.operatorId).not.toBe(b.facts.operatorId);
    expect(a.fingerprint, "each crew on a multi-unit job has its own readiness").not.toBe(b.fingerprint);
  });

  it("G5. the assignment mutation itself answers no readiness question", async () => {
    const s = await scene(1);
    const out = await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    }) as Record<string, unknown>;
    for (const k of ["verdict", "blockers", "capabilities", "capabilityVerdict", "eligible", "ready", "fingerprint"]) {
      expect(out[k], `assignment must not answer readiness ("${k}")`).toBeUndefined();
    }
  });

  /*
   * There must be ONE current assignment source for the dispatcher path. jobUnits keeps its
   * historical rows and its worklog meaning, but nothing this subsystem writes goes there, so the
   * two can never disagree about who is on a slot.
   */
  it("G6. binding a slot writes nothing to jobUnits", async () => {
    const s = await scene(1);
    await caller(s.disp).dispatch.setRoleAssignment({
      roleId: s.roleIds[0]!, operatorId: await operator(s.a), unitId: await unit(s.a), expectedLastEventId: null,
    });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) n FROM jobUnits WHERE jobId = ?", [s.jobId]);
    expect(Number(rows[0]!.n), "the canonical path must not feed the legacy table").toBe(0);
  });
});
