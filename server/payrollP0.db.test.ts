/**
 * Payroll P0 — repair and hardening, met the way a client meets it.
 *
 * Every call goes through `appRouter.createCaller` with real role grants, real organization
 * memberships and real financial entities. The defects these tests pin were live on `main`
 * (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §10, G1 / G4 / G5 / G7):
 *
 *   G1  `payroll.myStatements` listed every book's paid runs under the caller's employee number.
 *   G4  `payroll.rateCreate` superseded any organization's rate key.
 *   G5  run approval was separated by role only, never by person.
 *   G7  a run could not leave `draft`, nothing wrote `payRunLines`, nothing approved an earning.
 *
 * Skipped without DATABASE_URL — and the gate (scripts/ci-gate.sh) fails a skipped .db suite,
 * so this cannot silently stop running in CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 310_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  return userId;
}
const entityInput = () => ({ entityRef: `FE-${rnd()}`, legalName: `Entity ${rnd()} Ltd`, taxpayerType: "corporation" as const, jurisdiction: "AB" });
const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code: string }).code : undefined);
async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try { await fn(); } catch (e) { return { code: code(e), message: (e as Error).message }; }
  throw new Error("expected a refusal");
}

/**
 * One organization with the people payroll needs: a controller (approves runs, writes rates),
 * a payroll administrator (creates runs, proposes earnings), a reviewer in HR (approves earnings),
 * a book, an open period, and a worker with a profile and an hourly rate.
 */
async function company() {
  const orgRef = await org();
  const controller = await member(orgRef, ["controller"]);
  const admin = await member(orgRef, ["payroll_admin"]);
  const reviewer = await member(orgRef, ["hr"]);
  const worker = await member(orgRef, ["driver"]);
  const entityId = (await callerFor(controller).finance.entityCreate(entityInput())).id as number;
  const periodId = (await callerFor(admin).payroll.periodOpen({ periodRef: `PP-${rnd()}`, financialEntityId: entityId, startsOn: new Date("2026-09-01"), endsOn: new Date("2026-09-15") })).id as number;
  const employeeNumber = `EMP-${rnd()}`;
  const profileId = (await callerFor(admin).payroll.profileUpsert({ employeeNumber, financialEntityId: entityId, userId: worker, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).id as number;
  const rateKey = `REG-${rnd()}`;
  await callerFor(controller).payroll.rateCreate({ rateKey, earningType: "REG", calculation: "hourly", rate: 30, unit: "hour", effectiveFrom: new Date("2026-01-01"), employeePayrollProfileId: profileId });
  return { orgRef, controller, admin, reviewer, worker, entityId, periodId, profileId, employeeNumber, rateKey };
}

/** Propose an hourly earning as the administrator and approve it as the reviewer. */
async function approvedEarning(c: Awaited<ReturnType<typeof company>>, hours: number, profileId = c.profileId) {
  const earningRef = `ERN-${rnd()}`;
  const p = await callerFor(c.admin).payroll.earningPropose({ earningRef, employeePayrollProfileId: profileId, payPeriodId: c.periodId, earningType: "REG", source: "approved_timesheet", quantity: hours, unit: "hour", workedOn: new Date("2026-09-03"), evidenceRefs: [`TS-${rnd()}`] });
  expect(p.status).toBe("calculated");
  await callerFor(c.reviewer).payroll.earningApprove({ earningRef });
  return { earningRef, amountCents: Math.round(hours * 30 * 100) };
}

/** A run carried all the way to `paid`: create, collect, submit, then the controller approves each step. */
async function paidRun(c: Awaited<ReturnType<typeof company>>) {
  const payRunRef = `PR-${rnd()}`;
  await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
  const collected = await callerFor(c.admin).payroll.runCollect({ payRunRef });
  await callerFor(c.admin).payroll.runSubmit({ payRunRef });
  for (const toState of ["approved", "processing", "paid"] as const) await callerFor(c.controller).payroll.runApprove({ payRunRef, toState });
  return { payRunRef, collected };
}

d("P0.1 — my statements are mine", () => {
  it("shows a worker only the runs that carry a line for their own profile, not a colleague's in the same book", async () => {
    const c = await company();
    // A second employee in the SAME book, on the SAME job, with time submitted — and no earnings.
    const colleague = await member(c.orgRef, ["driver"]);
    const colleagueNumber = `EMP-${rnd()}`;
    await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: colleagueNumber, financialEntityId: c.entityId, userId: colleague, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" });
    await callerFor(c.worker).payroll.submitTime({ activity: "driving", startedAt: new Date("2026-09-03T08:00:00Z"), endedAt: new Date("2026-09-03T16:00:00Z"), jobId: 1 });
    await callerFor(colleague).payroll.submitTime({ activity: "driving", startedAt: new Date("2026-09-03T08:00:00Z"), endedAt: new Date("2026-09-03T16:00:00Z"), jobId: 1 });

    const e = await approvedEarning(c, 8);
    const run = await paidRun(c);
    expect(run.collected.collected).toBe(1);

    const mine = await callerFor(c.worker).payroll.myStatements();
    expect(mine.map(s => s.payRunRef)).toEqual([run.payRunRef]);
    expect(mine[0]!.amountCents).toBe(e.amountCents);
    expect(mine[0]!.lineCount).toBe(1);
    expect(mine[0]!.employeeNumber).toBe(c.employeeNumber);

    // The colleague shares the book, the period, the job and the run — and has no statement in it.
    const theirs = await callerFor(colleague).payroll.myStatements();
    expect(theirs).toEqual([]);
  }, 60_000);

  it("shows nothing across tenants, and refuses a profile paid by another organization's book", async () => {
    const a = await company(), b = await company();
    await approvedEarning(a, 4);
    const run = await paidRun(a);
    // B's worker, with B's own profile and a paid run in B, sees only B's.
    await approvedEarning(b, 2);
    const runB = await paidRun(b);
    expect((await callerFor(b.worker).payroll.myStatements()).map(s => s.payRunRef)).toEqual([runB.payRunRef]);
    expect((await callerFor(a.worker).payroll.myStatements()).map(s => s.payRunRef)).toEqual([run.payRunRef]);
    // B's administrator cannot see A's run at all.
    expect((await callerFor(b.admin).payroll.runsList()).some(r => r.payRunRef === run.payRunRef)).toBe(false);
    // The same person, now a member of B but still paid by A's book: no profile "in this organization".
    const workerInB = await member(b.orgRef, ["driver"]);
    await pool.execute("UPDATE employeePayrollProfiles SET userId = ? WHERE employeeNumber = ?", [workerInB, a.employeeNumber]);
    const r = await refusal(() => callerFor(workerInB).payroll.myStatements());
    expect(r.code).toBe("NOT_FOUND");
    expect(r.message).toMatch(/in this organization/);
  }, 90_000);
});

d("P0.2 — the legacy rate path is scoped", () => {
  it("refuses another organization's controller superseding a rate key, and leaves the rate's window open", async () => {
    const a = await company(), b = await company();
    const r = await refusal(() => callerFor(b.controller).payroll.rateCreate({ rateKey: a.rateKey, earningType: "REG", calculation: "hourly", rate: 1, unit: "hour", effectiveFrom: new Date("2026-02-01"), employeePayrollProfileId: b.profileId }));
    expect(r.code).toBe("NOT_FOUND");
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT version, effectiveUntil FROM payRates WHERE rateKey = ? ORDER BY version", [a.rateKey]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.effectiveUntil).toBeNull();
    // A's own controller may supersede it: a new version, the old window closed.
    const v2 = await callerFor(a.controller).payroll.rateCreate({ rateKey: a.rateKey, earningType: "REG", calculation: "hourly", rate: 32, unit: "hour", effectiveFrom: new Date("2026-10-01"), employeePayrollProfileId: a.profileId });
    expect(v2).toEqual({ version: 2, supersededPriorVersion: true });
  }, 60_000);

  it("refuses a rate attached to nobody, to another organization's profile, or to another organization's pay group", async () => {
    const a = await company(), b = await company();
    expect((await refusal(() => callerFor(a.controller).payroll.rateCreate({ rateKey: `R-${rnd()}`, earningType: "REG", calculation: "hourly", rate: 1, unit: "hour", effectiveFrom: new Date() }))).code).toBe("BAD_REQUEST");
    expect((await refusal(() => callerFor(a.controller).payroll.rateCreate({ rateKey: `R-${rnd()}`, earningType: "REG", calculation: "hourly", rate: 1, unit: "hour", effectiveFrom: new Date(), employeePayrollProfileId: b.profileId }))).code).toBe("NOT_FOUND");
    const [g] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO payGroups (groupKey, label, financialEntityId) VALUES (?,?,?)", [`PG-${rnd()}`, "B drivers", b.entityId]);
    expect((await refusal(() => callerFor(a.controller).payroll.rateCreate({ rateKey: `R-${rnd()}`, earningType: "REG", calculation: "hourly", rate: 1, unit: "hour", effectiveFrom: new Date(), payGroupId: g.insertId }))).code).toBe("NOT_FOUND");
    // B's own controller may use B's group.
    const ok = await callerFor(b.controller).payroll.rateCreate({ rateKey: `R-${rnd()}`, earningType: "REG", calculation: "hourly", rate: 1, unit: "hour", effectiveFrom: new Date(), payGroupId: g.insertId });
    expect(ok.version).toBe(1);
  }, 60_000);
});

d("P0.3 — creator is not approver", () => {
  it("refuses the person who created the run even after their roles change, and lets a different controller approve", async () => {
    const c = await company();
    const payRunRef = `PR-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
    await callerFor(c.admin).payroll.runCollect({ payRunRef });
    await callerFor(c.admin).payroll.runSubmit({ payRunRef });
    // Holding both roles at once is already refused by the role gate (payroll_admin is denied payroll.approve).
    const both = await member(c.orgRef, ["payroll_admin", "controller"]);
    expect((await refusal(() => callerFor(both).payroll.runApprove({ payRunRef, toState: "approved" }))).code).toBe("FORBIDDEN");
    // The case role separation cannot see: the creator is later moved from payroll_admin to controller.
    await pool.execute("UPDATE userRoleAssignments SET revokedAt = NOW() WHERE userId = ? AND role = 'payroll_admin'", [c.admin]);
    await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [c.admin, "controller"]);
    const r = await refusal(() => callerFor(c.admin).payroll.runApprove({ payRunRef, toState: "approved" }));
    expect(r.code).toBe("FORBIDDEN");
    expect(r.message).toMatch(/you originated this record/);
    const [[before]] = await pool.query<mysql.RowDataPacket[]>("SELECT state FROM payRuns WHERE payRunRef = ?", [payRunRef]);
    expect(before!.state).toBe("review");
    await expect(callerFor(c.controller).payroll.runApprove({ payRunRef, toState: "approved" })).resolves.toEqual({ state: "approved" });
  }, 60_000);

  it("refuses approving a run whose creator is not on the trail (a legacy row), rather than treating unknown as someone else", async () => {
    const c = await company();
    const payRunRef = `PR-${rnd()}`;
    await pool.execute("INSERT INTO payRuns (payRunRef, payPeriodId, financialEntityId, state) VALUES (?,?,?,'review')", [payRunRef, c.periodId, c.entityId]);
    const r = await refusal(() => callerFor(c.controller).payroll.runApprove({ payRunRef, toState: "approved" }));
    expect(r.code).toBe("FORBIDDEN");
    expect(r.message).toMatch(/not on the trail/);
  }, 60_000);

  it("refuses the proposer approving their own earning, and lets a reviewer approve it", async () => {
    const c = await company();
    const earningRef = `ERN-${rnd()}`;
    await callerFor(c.admin).payroll.earningPropose({ earningRef, employeePayrollProfileId: c.profileId, payPeriodId: c.periodId, earningType: "REG", source: "approved_timesheet", quantity: 2, unit: "hour", workedOn: new Date("2026-09-03"), evidenceRefs: ["TS-1"] });
    // payroll_admin holds payroll.review too; the person, not the role, is what is refused.
    expect((await refusal(() => callerFor(c.admin).payroll.earningApprove({ earningRef }))).code).toBe("FORBIDDEN");
    await expect(callerFor(c.reviewer).payroll.earningApprove({ earningRef })).resolves.toEqual({ earningRef, status: "approved" });
    // Not twice.
    expect((await refusal(() => callerFor(c.reviewer).payroll.earningApprove({ earningRef }))).code).toBe("PRECONDITION_FAILED");
  }, 60_000);
});

d("P0.4 — the run lifecycle is executable", () => {
  it("moves draft → collecting on first collect, collecting → review on submit, and refuses the shortcuts", async () => {
    const c = await company();
    const payRunRef = `PR-${rnd()}`;
    const made = await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
    expect(made.state).toBe("draft");
    // draft → review is not an edge.
    expect((await refusal(() => callerFor(c.admin).payroll.runSubmit({ payRunRef }))).code).toBe("PRECONDITION_FAILED");
    const first = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(first.state).toBe("collecting");
    await expect(callerFor(c.admin).payroll.runSubmit({ payRunRef })).resolves.toEqual({ state: "review" });
    // review → paid is not an edge; review → approved is.
    expect((await refusal(() => callerFor(c.controller).payroll.runApprove({ payRunRef, toState: "paid" }))).code).toBe("PRECONDITION_FAILED");
    // Collection is closed once the run is in review.
    expect((await refusal(() => callerFor(c.admin).payroll.runCollect({ payRunRef }))).code).toBe("PRECONDITION_FAILED");
    await expect(callerFor(c.controller).payroll.runApprove({ payRunRef, toState: "approved" })).resolves.toEqual({ state: "approved" });
  }, 60_000);

  it("refuses a run whose period belongs to a different book", async () => {
    const a = await company(), b = await company();
    // b's administrator cannot even see a's period; a's administrator cannot pair a's period with b's book (not theirs).
    expect((await refusal(() => callerFor(b.admin).payroll.runCreate({ payRunRef: `PR-${rnd()}`, payPeriodId: a.periodId, financialEntityId: b.entityId }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(a.admin).payroll.runCreate({ payRunRef: `PR-${rnd()}`, payPeriodId: a.periodId, financialEntityId: b.entityId }))).code).toBe("NOT_FOUND");
  }, 60_000);
});

d("P0.5 — approved earnings become lines; nothing else does", () => {
  it("collects approved earnings into payRunLines with the integer shadows as the amounts", async () => {
    const c = await company();
    const e1 = await approvedEarning(c, 8);
    const e2 = await approvedEarning(c, 2.5);
    const payRunRef = `PR-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
    const r = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(r.collected).toBe(2);
    expect(r.amountCents).toBe(e1.amountCents + e2.amountCents);
    const [lines] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT l.lineType, l.amountCents, l.amount, l.rateAppliedMillis, l.ruleStatus, e.earningRef, e.calculatedAmountCents FROM payRunLines l JOIN payRuns r ON r.id = l.payRunId JOIN payrollEarningEvents e ON e.id = l.payrollEarningEventId WHERE r.payRunRef = ? ORDER BY l.id", [payRunRef]);
    expect(lines.map(l => l.earningRef).sort()).toEqual([e1.earningRef, e2.earningRef].sort());
    for (const l of lines) {
      expect(l.lineType).toBe("earning");
      expect(Number(l.amountCents)).toBe(Number(l.calculatedAmountCents));
      expect(Number(l.amount)).toBeCloseTo(Number(l.amountCents) / 100, 2);
      expect(Number(l.rateAppliedMillis)).toBe(30000);
      expect(l.ruleStatus).toBe("not_applicable");
    }
  }, 60_000);

  it("leaves pending, held and merely-submitted time out of the run", async () => {
    const c = await company();
    const approved = await approvedEarning(c, 1);
    // Pending: proposed, never approved.
    const pendingRef = `ERN-${rnd()}`;
    await callerFor(c.admin).payroll.earningPropose({ earningRef: pendingRef, employeePayrollProfileId: c.profileId, payPeriodId: c.periodId, earningType: "REG", source: "trip", quantity: 3, unit: "hour", workedOn: new Date("2026-09-04"), evidenceRefs: ["TRIP-1"] });
    // Held: no evidence, blocked by the engine.
    const heldRef = `ERN-${rnd()}`;
    const held = await callerFor(c.admin).payroll.earningPropose({ earningRef: heldRef, employeePayrollProfileId: c.profileId, payPeriodId: c.periodId, earningType: "REG", source: "load", quantity: 3, unit: "hour", workedOn: new Date("2026-09-04"), evidenceRefs: [] });
    expect(held.status).toBe("blocked");
    expect((await refusal(() => callerFor(c.reviewer).payroll.earningApprove({ earningRef: heldRef }))).message).toMatch(/held/);
    // A dispatch-shaped time entry is time, not pay: it is never an earning event.
    await pool.execute("INSERT INTO payrollTimeEntries (employeePayrollProfileId, payPeriodId, activity, startedAt, endedAt, minutes, source, status) VALUES (?,?, 'driving', '2026-09-04 08:00:00', '2026-09-04 18:00:00', 600, 'dispatch_schedule', 'submitted')", [c.profileId, c.periodId]);

    const payRunRef = `PR-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
    const r = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(r.collected).toBe(1);
    expect(r.amountCents).toBe(approved.amountCents);
    expect(r.skipped.map(s => s.reason).sort()).toEqual(["status is held, not approved", "status is pending, not approved"]);
    const [[count]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM payRunLines l JOIN payRuns r ON r.id = l.payRunId WHERE r.payRunRef = ?", [payRunRef]);
    expect(Number(count!.n)).toBe(1);
  }, 60_000);

  it("collects each earning once: a second collect, and a second run on the same period, add nothing", async () => {
    const c = await company();
    await approvedEarning(c, 5);
    const payRunRef = `PR-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
    expect((await callerFor(c.admin).payroll.runCollect({ payRunRef })).collected).toBe(1);
    const again = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(again.collected).toBe(0);
    expect(again.skipped).toEqual([{ id: expect.any(Number), reason: "already collected by a pay run" }]);
    const second = `PR-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef: second, payPeriodId: c.periodId, financialEntityId: c.entityId });
    expect((await callerFor(c.admin).payroll.runCollect({ payRunRef: second })).collected).toBe(0);
    const [[count]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM payRunLines l JOIN payRuns r ON r.id = l.payRunId WHERE r.payRunRef IN (?, ?)", [payRunRef, second]);
    expect(Number(count!.n)).toBe(1);
  }, 60_000);

  it("keeps contractor settlement out of employee payroll", async () => {
    const c = await company();
    const office = await member(c.orgRef, ["office"]);
    const payee = (await callerFor(c.controller).finance.entityCreate({ ...entityInput(), taxpayerType: "independent_contractor" })).id as number;
    const settlementRef = `S-${rnd()}`;
    await callerFor(office).contractors.settlementCreate({ settlementRef, contractorEntityId: payee, payingEntityId: c.entityId, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-15"), workerKind: "contractor", lines: [{ lineType: "freight", description: "Haul", amount: 1000 }] });
    // A contractor never gets the profile that earnings and lines hang off.
    expect((await refusal(() => callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, workerKind: "contractor", employmentType: "casual", defaultPayMethod: "load" }))).message).toMatch(/contractor settlement/);
    const payRunRef = `PR-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: c.periodId, financialEntityId: c.entityId });
    const r = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(r.collected).toBe(0);
    expect(r.amountCents).toBe(0);
    const [[s]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM contractorSettlementLines l JOIN contractorSettlements s ON s.id = l.contractorSettlementId WHERE s.settlementRef = ?", [settlementRef]);
    expect(Number(s!.n)).toBe(1);
  }, 60_000);
});

d("P0.6 — the payroll namespace carries the money boundary", () => {
  it("refuses a caller whose membership has ended rather than falling back to the single tenant", async () => {
    const c = await company();
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = '2026-01-01' WHERE userId = ?", [c.admin]);
    const r = await refusal(() => callerFor(c.admin).payroll.runsList());
    expect(["FORBIDDEN", "PRECONDITION_FAILED"]).toContain(r.code);
  }, 60_000);
});
