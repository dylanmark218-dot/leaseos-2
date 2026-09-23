/**
 * What the Dispatch Detail screen is served, against a real database.
 *
 * The screen reads one job through procedures that were never designed for it: there is no
 * job-by-id read, `jobs.list` returns the hundred most recently updated jobs in scope, and
 * `jobUnits.list` returns the tenant's hundred most recent assignments with no job filter. Those
 * are not incidental — they decide what the screen is allowed to claim, so they are pinned here
 * rather than discovered in production.
 *
 * Job tenant isolation at the `jobs.list` / `jobs.byCode` level is already proved by
 * `tenantScopeJobsTrips.db.test.ts` and is deliberately not repeated. What is new here is the
 * assignment path the detail screen actually walks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("dispatch job detail — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped detail suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 640_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
/** A real organization member, so scoping is the production two-org path rather than the default tenant. */
async function member(orgRef: string, role: string) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function job(orgRef: string) {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute(
    "INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'water_haul','transport','Northgate Energy','04-12-052-09W5','dispatched',0)",
    [orgRef, jobCode]);
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return { id: Number(r[0]!.id), jobCode };
}
async function unit(orgRef: string) {
  const unitNumber = `U-${rnd()}`;
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [unitNumber]);
  const id = Number(u.insertId);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, id]);
  return { id, unitNumber };
}
async function operator(orgRef: string) {
  const name = `Op ${rnd()}`;
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 400 DAY))", [seq++, name]);
  const id = Number(o.insertId);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, id]);
  return { id, name };
}
const assign = (userId: number, jobId: number, unitId: number, operatorId: number | null, role = "operator") =>
  caller(userId).fieldRoute.identity.jobUnits.create({ jobId, unitId, operatorId: operatorId ?? undefined, role, joinedAt: new Date() });

/* ================================================================== */
/* What the screen can read                                            */
/* ================================================================== */

d("the job header the detail screen assembles", () => {
  it("J1. a dispatcher finds their own job in jobs.list by numeric id, with every field the header shows", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    const found = (await caller(disp).fieldRoute.jobs.list()).find(x => x.id === j.id);
    expect(found, "the only way to reach a job by numeric id is to find it in the list").toBeTruthy();
    // Every field the header renders must actually exist on the row.
    for (const k of ["id", "jobCode", "type", "mode", "customer", "location", "status", "progress"]) {
      expect(found, `header field ${k}`).toHaveProperty(k);
    }
  });

  it("J2. `vehicle` and `driver` on the job are free text, not references — the header must not treat them as the assignment", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const jobCode = `JOB-${rnd()}`;
    await pool.execute(
      "INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress, vehicle, driver) VALUES (?,?,'water_haul','transport','Acme','LSD','dispatched',0,'the blue vac','Dana')",
      [a, jobCode]);
    const found = (await caller(disp).fieldRoute.jobs.list()).find(x => x.jobCode === jobCode)!;
    expect(found.vehicle).toBe("the blue vac");
    expect(found.driver).toBe("Dana");
    // Nothing joins them to a record: they are strings a person typed.
    expect(typeof found.vehicle).toBe("string");
    expect(typeof found.driver).toBe("string");
  });

  it("J3. another organization's job is simply absent from the list — indistinguishable from an old one", async () => {
    const a = await org(), b = await org();
    const dispB = await member(b, "dispatcher");
    await member(a, "dispatcher");
    const j = await job(a);
    const list = await caller(dispB).fieldRoute.jobs.list();
    expect(list.some(x => x.id === j.id)).toBe(false);
    // This is the fact that forces the screen's wording: absence has more than one cause, so it
    // may say "not among the jobs you can read" and may not say "does not exist".
  });
});

d("the assignment the detail screen reads", () => {
  it("A1. an assigned job returns a jobUnits row carrying the unit and operator ids", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a), u = await unit(a), op = await operator(a);
    await assign(disp, j.id, u.id, op.id);
    const rows = (await caller(disp).fieldRoute.identity.jobUnits.list()).filter(r => r.jobId === j.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitId).toBe(u.id);
    expect(rows[0]!.operatorId).toBe(op.id);
    expect(rows[0]!.role).toBe("operator");
  });

  it("A2. a job with no assignment returns no rows — the screen's unassigned state", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a);
    expect((await caller(disp).fieldRoute.identity.jobUnits.list()).filter(r => r.jobId === j.id)).toHaveLength(0);
  });

  it("A3. an assignment with no operator stores NULL — 'nobody assigned', not 'unresolved'", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a), u = await unit(a);
    await assign(disp, j.id, u.id, null);
    const row = (await caller(disp).fieldRoute.identity.jobUnits.list()).find(r => r.jobId === j.id)!;
    expect(row.operatorId).toBeNull();
  });

  /* The gap `tenantScopeFieldRuntime` documents and does not test. */
  it("A4. another organization's assignment never appears in this dispatcher's list", async () => {
    const a = await org(), b = await org();
    const dispA = await member(a, "dispatcher"), dispB = await member(b, "dispatcher");
    const j = await job(a), u = await unit(a), op = await operator(a);
    await assign(dispA, j.id, u.id, op.id);
    expect((await caller(dispA).fieldRoute.identity.jobUnits.list()).some(r => r.jobId === j.id)).toBe(true);
    expect((await caller(dispB).fieldRoute.identity.jobUnits.list()).some(r => r.jobId === j.id),
      "an assignment is scoped through its job").toBe(false);
  });

  it("A5. the unit and operator ids resolve to display names through the scoped lists", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j = await job(a), u = await unit(a), op = await operator(a);
    await assign(disp, j.id, u.id, op.id);
    const units = await caller(disp).fieldRoute.identity.units.list();
    const ops = await caller(disp).fieldRoute.identity.operators.list();
    expect(units.find(x => x.id === u.id)?.unitNumber).toBe(u.unitNumber);
    expect(ops.find(x => x.id === op.id)?.name).toBe(op.name);
  });

  it("A6. another organization's unit and operator do not resolve — the screen's 'name not resolved'", async () => {
    const a = await org(), b = await org();
    const dispB = await member(b, "dispatcher");
    await member(a, "dispatcher");
    const u = await unit(a), op = await operator(a);
    expect((await caller(dispB).fieldRoute.identity.units.list()).some(x => x.id === u.id)).toBe(false);
    expect((await caller(dispB).fieldRoute.identity.operators.list()).some(x => x.id === op.id)).toBe(false);
    // Which is why an unresolved name may not be rendered as "unknown": out-of-scope and
    // beyond-the-list-cap arrive identically.
  });

  it("A7. jobUnits.list is job-blind and capped, so an empty result is not proof of an unassigned job", async () => {
    const a = await org();
    const disp = await member(a, "dispatcher");
    const j1 = await job(a), j2 = await job(a);
    const u1 = await unit(a), u2 = await unit(a);
    await assign(disp, j1.id, u1.id, null);
    await assign(disp, j2.id, u2.id, null);
    const rows = await caller(disp).fieldRoute.identity.jobUnits.list();
    // One call, every job: the caller cannot ask about one job, it filters afterwards.
    expect(rows.some(r => r.jobId === j1.id)).toBe(true);
    expect(rows.some(r => r.jobId === j2.id)).toBe(true);
    // And the window is bounded, so a job outside the hundred most recent assignments reads as
    // unassigned however many rows it really has. That is why the screen states the window.
    expect(rows.length).toBeLessThanOrEqual(100);
  });
});

/* ================================================================== */
/* The subject reaches the facts                                       */
/* ================================================================== */

/*
 * `dispatchEnforcement.test.ts` already drives `it.each(Object.keys(facts))` over the fingerprint,
 * so "a changed fact changes the hash" is covered and is not repeated. What nothing covers is the
 * wiring one layer up: that the composer puts THIS subject into the facts. Replace
 * `operatorId: op.id` with a constant and every existing test still passes, while the claim
 * "changing the assigned driver invalidates a prior readiness check" quietly stops being true.
 */
d("a change of assigned driver or truck is a dependency change", () => {
  it("F1. the subject reaches the facts, and a different driver or truck moves the fingerprint", async () => {
    const { composeReadiness } = await import("./readinessComposer");
    const a = await org();
    await member(a, "dispatcher");
    const j = await job(a);
    const u1 = await unit(a), u2 = await unit(a);
    const op1 = await operator(a), op2 = await operator(a);

    const base = await composeReadiness({ operatorId: op1.id, unitId: u1.id, trailerId: null, jobId: j.id });
    expect(base.facts.operatorId, "the composer must carry the operator it was asked about").toBe(op1.id);
    expect(base.facts.unitId, "the composer must carry the unit it was asked about").toBe(u1.id);

    const otherDriver = await composeReadiness({ operatorId: op2.id, unitId: u1.id, trailerId: null, jobId: j.id });
    const otherTruck = await composeReadiness({ operatorId: op1.id, unitId: u2.id, trailerId: null, jobId: j.id });

    expect(otherDriver.facts.operatorId).toBe(op2.id);
    expect(otherTruck.facts.unitId).toBe(u2.id);
    expect(otherDriver.fingerprint, "a different driver is a different world").not.toBe(base.fingerprint);
    expect(otherTruck.fingerprint, "a different truck is a different world").not.toBe(base.fingerprint);
  });

  it("F2. a check taken for one driver is invalid for another, and says why", async () => {
    const { assessEligibilityValidity } = await import("./_core/dispatchAward");
    const { composeReadiness } = await import("./readinessComposer");
    const a = await org();
    await member(a, "dispatcher");
    const j = await job(a);
    const u = await unit(a);
    const op1 = await operator(a), op2 = await operator(a);

    const taken = await composeReadiness({ operatorId: op1.id, unitId: u.id, trailerId: null, jobId: j.id });
    const now = new Date();
    const stored = {
      checkId: 1, fingerprint: taken.fingerprint, operatorId: op1.id,
      verdict: taken.eligibility.verdict, blockers: taken.eligibility.blockers,
      evaluatedAt: now, explanation: taken.eligibility.explanation,
    };
    const afterSwap = await composeReadiness({ operatorId: op2.id, unitId: u.id, trailerId: null, jobId: j.id });
    const validity = assessEligibilityValidity(stored as never, afterSwap.facts, now);
    expect(validity.valid).toBe(false);
    expect(validity.invalidatedBy).toBe("dependency_change");
    expect(validity.requiresReEvaluation).toBe(true);
  });
});
