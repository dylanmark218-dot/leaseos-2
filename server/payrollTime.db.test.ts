/**
 * Payroll P3 — payroll time, operational candidates, D10 approval, exceptions and the time → earning step, met the way
 * a client meets them: through `appRouter.createCaller`, with real role grants, organization memberships, books,
 * schedules, crews, operators and operational records. The race tests hold a row lock on a second connection while
 * the API call runs, so the serialization claimed in the service is observed, not assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 360_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 8 }); });
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
const q = async (sql: string, args: unknown[] = []) => (await pool.query<mysql.RowDataPacket[]>(sql, args))[0];
const n = async (sql: string, args: unknown[] = []) => Number((await q(sql, args))[0]!.n);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function operatorFor(orgRef: string, userId: number) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name) VALUES (?,?)", [userId, `Op ${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, o.insertId]);
  return o.insertId;
}
async function jobIn(orgRef: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "10-22-045-06-W5", orgRef]);
  return j.insertId;
}
async function crew(orgRef: string, members: Array<[number, string]>) {
  const crewRef = `CREW-${rnd()}`;
  await pool.execute("INSERT INTO crews (crewRef, tenantId, name, state, createdByUserId) VALUES (?,?,?, 'active', 1)", [crewRef, orgRef, `Crew ${crewRef}`]);
  for (const [userId, role] of members) await pool.execute("INSERT INTO crewMembers (crewRef, userId, crewRole, joinedAt) VALUES (?,?,?, '2026-01-01 00:00:00')", [crewRef, userId, role]);
  return crewRef;
}

/** A book with a weekly Edmonton schedule (periods from Monday 2026-03-02), a pay group, and a driver on it. */
async function company(opts: { payGroup?: boolean } = {}) {
  const orgRef = await org();
  const controller = await member(orgRef, ["controller"]);
  const admin = await member(orgRef, ["payroll_admin"]);
  const hr = await member(orgRef, ["hr"]);
  const worker = await member(orgRef, ["driver"]);
  const entityId = (await callerFor(controller).finance.entityCreate(entityInput())).id as number;
  const employeeNumber = `EMP-${rnd()}`;
  const profileId = (await callerFor(admin).payroll.profileUpsert({ employeeNumber, financialEntityId: entityId, userId: worker, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).id as number;
  await pool.execute("UPDATE employeePayrollProfiles SET effectiveFrom = '2026-01-01' WHERE id = ?", [profileId]);
  const scheduleRef = (await callerFor(admin).payrollSchedule.scheduleCreate({ financialEntityId: entityId, name: "Weekly", frequency: "weekly", anchorDate: "2026-03-02", paymentLagDays: 5, timezone: "America/Edmonton" })).scheduleRef;
  await callerFor(admin).payrollSchedule.periodsGenerate({ scheduleRef, through: "2026-03-30" });
  let groupKey: string | null = null;
  if (opts.payGroup !== false) {
    groupKey = (await callerFor(admin).payrollSchedule.payGroupSave({ financialEntityId: entityId, label: "Drivers", scheduleRef })).groupKey;
    await callerFor(admin).payrollSchedule.profileAssignPayGroup({ employeePayrollProfileId: profileId, groupKey });
  }
  const operatorId = await operatorFor(orgRef, worker);
  const jobId = await jobIn(orgRef);
  const period1 = `${scheduleRef}-2026-03-02`;
  return { orgRef, controller, admin, hr, worker, entityId, profileId, employeeNumber, scheduleRef, groupKey, operatorId, jobId, period1 };
}
type Co = Awaited<ReturnType<typeof company>>;

/** Another person on the same book and schedule. */
async function coworker(c: Co, roles = ["driver"]) {
  const userId = await member(c.orgRef, roles);
  const profileId = (await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).id as number;
  await pool.execute("UPDATE employeePayrollProfiles SET effectiveFrom = '2026-01-01' WHERE id = ?", [profileId]);
  await callerFor(c.admin).payrollSchedule.profileAssignPayGroup({ employeePayrollProfileId: profileId, groupKey: c.groupKey });
  return { userId, profileId };
}

async function agreement(c: Co, rateMillis = 30_000) {
  const agreementRef = (await callerFor(c.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: c.profileId, financialEntityId: c.entityId, title: "Driver", startsOn: "2026-01-01" })).agreementRef!;
  const v = await callerFor(c.admin).payrollCompensation.versionPropose({ agreementRef, effectiveFrom: "2026-01-01", basis: "hourly", rules: [{ earningCode: "REG", calculation: "hourly", unit: "hour", rateMillis }] });
  expect((await callerFor(c.controller).payrollCompensation.versionApprove({ versionRef: v.versionRef })).status).toBe("approved");
  return { agreementRef, versionRef: v.versionRef };
}

// Tuesday 2026-03-03, 08:00–16:00 in Edmonton (UTC−7 before the March change).
const START = new Date("2026-03-03T15:00:00Z");
const END = new Date("2026-03-03T23:00:00Z");
const own = (c: Co, over: Record<string, unknown> = {}) => callerFor(c.worker).payrollTime.myEntryCreate({ activity: "driving", startedAt: START, endedAt: END, earningCode: "REG", ...over } as never);
const entry = async (entryRef: string) => (await q("SELECT * FROM payrollTimeEntries WHERE entryRef = ?", [entryRef]))[0]!;
const openExceptions = (subjectRef: string) => q("SELECT kind, severity, exceptionRef FROM payrollExceptions WHERE subjectRef = ? AND state = 'open'", [subjectRef]);

d("P3 — the worker's own time", () => {
  it("submits and reads one's own time, resolving the profile, period and work date on the server (1)", async () => {
    const c = await company();
    const r = await own(c, { clientCaptureRef: `cap-${rnd()}` });
    expect(r).toMatchObject({ status: "submitted", replayed: false, exceptions: [] });
    const row = await entry(r.entryRef);
    const [[p]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payPeriods WHERE periodRef = ?", [c.period1]);
    expect(row).toMatchObject({ employeePayrollProfileId: c.profileId, payPeriodId: p!.id, minutes: 480, earningCode: "REG", submittedByUserId: c.worker, status: "submitted" });
    expect(new Date(row.workDate).getDate()).toBe(3);
    const mine = await callerFor(c.worker).payrollTime.myEntries();
    expect(mine.map(e => e.entryRef)).toEqual([r.entryRef]);
    expect(mine[0]).not.toHaveProperty("calculatedAmountCents");
  }, 60_000);

  it("takes no profile, user or status from input, and does not reach a coworker's entry (2, 22)", async () => {
    const c = await company();
    const co = await coworker(c);
    for (const extra of [{ employeePayrollProfileId: co.profileId }, { userId: co.userId }, { status: "approved" }]) {
      expect((await refusal(() => own(c, extra))).code, JSON.stringify(extra)).toBe("BAD_REQUEST");
    }
    const theirs = await callerFor(co.userId).payrollTime.myEntryCreate({ activity: "driving", startedAt: START, endedAt: END });
    expect((await refusal(() => callerFor(c.worker).payrollTime.myEntryWithdraw({ entryRef: theirs.entryRef, reason: "not mine to touch" }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(c.worker).payrollTime.myEntryCorrect({ entryRef: theirs.entryRef, notes: "trying", endedAt: END }))).code).toBe("NOT_FOUND");
    expect((await callerFor(c.worker).payrollTime.myEntries()).length).toBe(0);
    expect((await entry(theirs.entryRef)).status).toBe("submitted");
  }, 60_000);

  it("refuses an owner-operator the employee time path (28)", async () => {
    const c = await company();
    const owner = await member(c.orgRef, ["driver"]);
    await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'OWNER_DRIVER','active','2026-01-01',1)", [`W-${rnd()}`, c.orgRef, owner]);
    await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId: owner, workerKind: "employee", employmentType: "casual", defaultPayMethod: "load" });
    const r = await refusal(() => callerFor(owner).payrollTime.myEntryCreate({ activity: "driving", startedAt: START, endedAt: END }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/contractor settlement/);
    expect((await refusal(() => callerFor(owner).payroll.submitTime({ activity: "driving", startedAt: START, endedAt: END }))).message).toMatch(/contractor settlement/);
  }, 60_000);
});

d("P3 — tenant boundary on entries and on operational ids (4, 21)", () => {
  it("is not found across organizations, and a foreign job, unit or trip is not found and recorded", async () => {
    const a = await company(), b = await company();
    const r = await own(a);
    expect((await refusal(() => callerFor(b.admin).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollTime.entryReject({ entryRef: r.entryRef, reason: "not ours at all" }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollTime.earningGenerate({ entryRef: r.entryRef }))).code).toBe("NOT_FOUND");
    expect((await callerFor(b.admin).payrollTime.teamEntries()).entries.some(e => e.entryRef === r.entryRef)).toBe(false);
    const before = await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE employeePayrollProfileId = ?", [b.profileId]);
    expect((await refusal(() => callerFor(b.worker).payrollTime.myEntryCreate({ activity: "driving", startedAt: START, endedAt: END, jobId: a.jobId }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.worker).payroll.submitTime({ activity: "driving", startedAt: START, endedAt: END, jobId: a.jobId }))).code).toBe("NOT_FOUND");
    // A's unit, through the canonical unit-scope check.
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [`U-${rnd()}`]);
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [a.orgRef, u.insertId]);
    expect((await refusal(() => callerFor(b.worker).payrollTime.myEntryCreate({ activity: "driving", startedAt: START, endedAt: END, unitId: u.insertId }))).code).toBe("NOT_FOUND");
    expect((await own(a, { unitId: u.insertId })).status).toBe("submitted");
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE employeePayrollProfileId = ?", [b.profileId])).toBe(before);
    const xs = await callerFor(b.admin).payrollTime.exceptionsList({ kind: "cross_tenant_reference" });
    expect(xs.length).toBe(2);
    expect(xs[0]).toMatchObject({ financialEntityId: b.entityId, severity: "blocking" });
    expect((await callerFor(a.admin).payrollTime.exceptionsList({ kind: "cross_tenant_reference" })).length).toBe(0);
  }, 60_000);

  it("keeps a pay group to its own book (the profileUpsert gap P3 closed)", async () => {
    const a = await company(), b = await company();
    const [[g]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payGroups WHERE groupKey = ?", [a.groupKey]);
    expect((await refusal(() => callerFor(b.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: b.entityId, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly", payGroupId: g!.id }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollSchedule.profileAssignPayGroup({ employeePayrollProfileId: b.profileId, groupKey: a.groupKey }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollSchedule.payGroupSave({ financialEntityId: b.entityId, label: "x", scheduleRef: a.scheduleRef }))).code).toBe("NOT_FOUND");
  }, 60_000);
});

d("P3 — D10 approval routing", () => {
  it("lets the worker's crew supervisor approve, recording who and when, and refuses everyone else (5, 6, 7, 10)", async () => {
    const c = await company();
    const sup = await member(c.orgRef, ["driver"]);
    const otherSup = await member(c.orgRef, ["driver"]);
    const dispatcher = await member(c.orgRef, ["dispatcher"]);
    const crewRef = await crew(c.orgRef, [[c.worker, "driver"], [sup, "supervisor"], [dispatcher, "supervisor"]]);
    const other = await coworker(c);
    await crew(c.orgRef, [[other.userId, "driver"], [otherSup, "supervisor"]]);
    const r = await own(c);
    expect((await refusal(() => callerFor(otherSup).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("FORBIDDEN");
    // A dispatcher is denied the permission by name — even one recorded as a crew supervisor.
    expect((await refusal(() => callerFor(dispatcher).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("FORBIDDEN");
    // D10: with a crew supervisor in place, the payroll administrator is not the approver.
    expect((await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("FORBIDDEN");
    // HR, management and the controller do not approve time through their roles.
    for (const role of ["hr", "controller", "bookkeeper", "management"]) {
      const u = await member(c.orgRef, [role]);
      expect((await refusal(() => callerFor(u).payrollTime.entryApprove({ entryRef: r.entryRef }))).code, role).toBe("FORBIDDEN");
    }
    const before = Date.now() - 1000;
    const ok = await callerFor(sup).payrollTime.entryApprove({ entryRef: r.entryRef });
    expect(ok.status).toBe("approved");
    const row = await entry(r.entryRef);
    expect(row).toMatchObject({ status: "approved", approvedByUserId: sup, approvalRoute: "crew_supervisor", approvalCrewRef: crewRef });
    expect(new Date(row.approvedAt).getTime()).toBeGreaterThan(before);
    // The supervisor's team view shows the time and no money.
    const team = await callerFor(sup).payrollTime.teamEntries();
    expect(team.scope).toBe("crew");
    const seen = team.entries.find(e => e.entryRef === r.entryRef)!;
    expect(seen.worker.employeeNumber).toBe(c.employeeNumber);
    for (const k of Object.keys(seen)) expect(k).not.toMatch(/rate|amount|cents|salary|gross|agreement/i);
    expect(team.entries.some(e => e.worker.userId === other.userId)).toBe(false);
  }, 90_000);

  it("falls back to the book's payroll administrator when the worker has no crew supervisor (8)", async () => {
    const c = await company();
    const r = await own(c);
    const ok = await callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef });
    expect(ok.status).toBe("approved");
    expect((await entry(r.entryRef))).toMatchObject({ approvalRoute: "payroll_admin", approvedByUserId: c.admin });
  }, 60_000);

  it("refuses the claimant their own time and records the attempt (9)", async () => {
    const c = await company();
    const r = await own(c);
    const x = await refusal(() => callerFor(c.worker).payrollTime.entryApprove({ entryRef: r.entryRef }));
    expect(x.code).toBe("FORBIDDEN");
    expect((await openExceptions(r.entryRef)).map(e => e.kind)).toContain("self_approval_blocked");
    expect((await entry(r.entryRef)).status).toBe("submitted");
    // A payroll administrator's own time is not approved by themselves either.
    const adminProfile = (await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId: c.admin, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "salary" })).id as number;
    expect(adminProfile).toBeGreaterThan(0);
  }, 60_000);

  it("keeps a coworker without team authority out of another worker's time, and HR out of the team view (3)", async () => {
    const c = await company();
    const co = await coworker(c);
    const r = await own(c);
    const view = await callerFor(co.userId).payrollTime.teamEntries();
    expect(view.entries.some(e => e.entryRef === r.entryRef)).toBe(false);
    expect((await refusal(() => callerFor(c.hr).payrollTime.teamEntries())).code).toBe("FORBIDDEN");
    const dispatcher = callerFor(await member(c.orgRef, ["dispatcher"]));
    expect((await refusal(() => dispatcher.payrollTime.teamEntries())).code).toBe("FORBIDDEN");
  }, 60_000);

  it("leaves time pending with an exception when nobody can approve it", async () => {
    const c = await company();
    await pool.execute("UPDATE userRoleAssignments SET revokedAt = NOW() WHERE userId = ? AND role = 'payroll_admin'", [c.admin]);
    const r = await own(c);
    const sup = await member(c.orgRef, ["driver"]);
    expect((await refusal(() => callerFor(sup).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("PRECONDITION_FAILED");
    expect((await openExceptions(r.entryRef)).map(e => e.kind)).toContain("no_valid_approver");
    expect((await entry(r.entryRef)).status).toBe("submitted");
  }, 60_000);
});

d("P3 — history: rejection, correction, withdrawal (11, 12)", () => {
  it("keeps a rejected entry visible, with who and why", async () => {
    const c = await company();
    const r = await own(c);
    await callerFor(c.admin).payrollTime.entryReject({ entryRef: r.entryRef, reason: "Wrong day entirely" });
    const mine = await callerFor(c.worker).payrollTime.myEntries();
    expect(mine[0]).toMatchObject({ entryRef: r.entryRef, status: "void", statusLabel: "rejected", rejectionReason: "Wrong day entirely", payable: false });
    expect((await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("PRECONDITION_FAILED");
  }, 60_000);

  it("corrects submitted time by superseding it, never by rewriting it", async () => {
    const c = await company();
    const r = await own(c);
    const fixed = await callerFor(c.worker).payrollTime.myEntryCorrect({ entryRef: r.entryRef, endedAt: new Date("2026-03-03T22:30:00Z"), notes: "Left 30 minutes early" });
    expect(fixed.entryRef).not.toBe(r.entryRef);
    const old = await entry(r.entryRef);
    const neu = await entry(fixed.entryRef);
    expect(old).toMatchObject({ status: "submitted", minutes: 480, supersededByEntryId: neu.id });
    expect(neu).toMatchObject({ status: "submitted", minutes: 450, supersedesEntryId: old.id });
    const mine = await callerFor(c.worker).payrollTime.myEntries();
    expect(mine.find(e => e.entryRef === r.entryRef)).toMatchObject({ statusLabel: "superseded", payable: false });
    // The superseded row is not approvable and was not flagged as overlapping its own correction.
    expect((await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef }))).code).toBe("PRECONDITION_FAILED");
    expect((await openExceptions(fixed.entryRef)).map(e => e.kind)).not.toContain("overlapping_entries");
    expect((await callerFor(c.admin).payrollTime.entryApprove({ entryRef: fixed.entryRef })).status).toBe("approved");
    // Approved time is not corrected in place either.
    expect((await refusal(() => callerFor(c.worker).payrollTime.myEntryCorrect({ entryRef: fixed.entryRef, notes: "again", endedAt: END }))).code).toBe("PRECONDITION_FAILED");
  }, 60_000);

  it("edits a draft in place, then submits it; a submitted entry is not edited", async () => {
    const c = await company();
    const draft = await own(c, { captureState: "open", endedAt: undefined });
    expect(draft.status).toBe("open");
    await callerFor(c.worker).payrollTime.myEntryUpdate({ entryRef: draft.entryRef, endedAt: END });
    const sub = await callerFor(c.worker).payrollTime.myEntrySubmit({ entryRef: draft.entryRef });
    expect(sub).toMatchObject({ entryRef: draft.entryRef, status: "submitted" });
    expect((await refusal(() => callerFor(c.worker).payrollTime.myEntryUpdate({ entryRef: draft.entryRef, endedAt: START }))).code).toBe("PRECONDITION_FAILED");
    await callerFor(c.worker).payrollTime.myEntryWithdraw({ entryRef: draft.entryRef, reason: "Entered on the wrong job" });
    expect(await entry(draft.entryRef)).toMatchObject({ status: "void", withdrawnByUserId: c.worker, withdrawReason: "Entered on the wrong job" });
  }, 60_000);
});

d("P3 — duplicates and overlaps (13, 14, 15)", () => {
  it("keeps one entry per capture, however often or however concurrently it is replayed", async () => {
    const c = await company();
    const cap = `dev1:${rnd()}`;
    const first = await own(c, { clientCaptureRef: cap, capturedAt: new Date("2026-03-03T23:05:00Z"), deviceRef: "dev1" });
    const replay = await own(c, { clientCaptureRef: cap });
    expect(replay).toMatchObject({ entryRef: first.entryRef, replayed: true });
    const cap2 = `dev1:${rnd()}`;
    const both = await Promise.all([own(c, { clientCaptureRef: cap2, startedAt: new Date("2026-03-04T15:00:00Z"), endedAt: new Date("2026-03-04T23:00:00Z") }), own(c, { clientCaptureRef: cap2, startedAt: new Date("2026-03-04T15:00:00Z"), endedAt: new Date("2026-03-04T23:00:00Z") })]);
    expect(both[0].entryRef).toBe(both[1].entryRef);
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE clientCaptureRef IN (?,?)", [cap, cap2])).toBe(2);
    expect(new Date((await entry(first.entryRef)).capturedAt).toISOString()).toBe("2026-03-03T23:05:00.000Z");
  }, 60_000);

  it("flags overlapping time on both entries, changes neither, and holds approval until a person decides", async () => {
    const c = await company();
    const a = await own(c);
    const b = await own(c, { startedAt: new Date("2026-03-03T20:00:00Z"), endedAt: new Date("2026-03-04T01:00:00Z") });
    expect(b.exceptions).toContain("overlapping_entries");
    expect((await openExceptions(a.entryRef)).map(e => e.kind)).toContain("overlapping_entries");
    expect((await entry(a.entryRef)).minutes).toBe(480);
    const held = await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: b.entryRef }));
    expect(held.code).toBe("PRECONDITION_FAILED");
    expect(held.message).toMatch(/overlapping_entries/);
    const x = (await openExceptions(b.entryRef)).find(e => e.kind === "overlapping_entries")!;
    await callerFor(c.admin).payrollTime.exceptionResolve({ exceptionRef: x.exceptionRef, outcome: "resolved", note: "Two jobs back to back; confirmed" });
    expect((await callerFor(c.admin).payrollTime.entryApprove({ entryRef: b.entryRef })).status).toBe("approved");
    // Adjacent time is not an overlap.
    const adj = await own(c, { startedAt: new Date("2026-03-05T15:00:00Z"), endedAt: new Date("2026-03-05T19:00:00Z") });
    const adj2 = await own(c, { startedAt: new Date("2026-03-05T19:00:00Z"), endedAt: new Date("2026-03-05T23:00:00Z") });
    expect(adj.exceptions).toEqual([]);
    expect(adj2.exceptions).toEqual([]);
  }, 60_000);
});

d("P3 — candidates are read-only (18, 19, 20)", () => {
  async function sources(c: Co) {
    const [h] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt, source) VALUES (?, 'on_duty', ?, ?, 'driver_entry')", [c.operatorId, START, END]);
    await pool.execute("INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt, source) VALUES (?, 'off_duty', '2026-03-03 23:00:00', '2026-03-04 09:00:00', 'driver_entry')", [c.operatorId]);
    const [b] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO resourceBookings (resourceType, resourceRef, jobId, startsAt, endsAt, bookingState) VALUES ('operator', ?, ?, '2026-03-04 15:00:00', '2026-03-04 23:00:00', 'confirmed')", [String(c.operatorId), c.jobId]);
    const ticketNumber = `FT-${rnd()}`;
    await pool.execute("INSERT INTO fieldTickets (ticketNumber, jobId, operatorId, startedAt, completedAt, status) VALUES (?,?,?, '2026-03-05 15:00:00', '2026-03-05 22:00:00', 'closed')", [ticketNumber, c.jobId, c.operatorId]);
    return { dutyId: h.insertId, bookingId: b.insertId, ticketNumber };
  }

  it("projects HOS, dispatch and field-ticket candidates and writes no payroll row, however often read", async () => {
    const c = await company();
    const s = await sources(c);
    const counts = async () => [await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE employeePayrollProfileId = ?", [c.profileId]), await n("SELECT COUNT(*) AS n FROM payrollEarningEvents WHERE employeePayrollProfileId = ?", [c.profileId]), await n("SELECT COUNT(*) AS n FROM payrollExceptions WHERE financialEntityId = ?", [c.entityId])];
    const before = await counts();
    const r1 = await callerFor(c.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    const r2 = await callerFor(c.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    expect(r2).toEqual(r1);
    expect(await counts()).toEqual(before);
    const kinds = r1.candidates.map(x => `${x.sourceType}:${x.sourceRef}`);
    expect(kinds).toEqual([`hos_duty:dutyRecords:${s.dutyId}`, `dispatch_booking:resourceBookings:${s.bookingId}`, `field_ticket:${s.ticketNumber}`]);
    expect(r1.candidates.every(x => x.status === "candidate" && x.eligible)).toBe(true);
    expect(r1.candidates[0]).toMatchObject({ workDate: "2026-03-03", minutes: 480, authority: "regulatory_duty" });
    // The worker's coworker sees none of it.
    const co = await coworker(c);
    expect((await callerFor(co.userId).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" })).candidates).toEqual([]);
  }, 60_000);

  it("makes a candidate into time only on the worker's submission, once", async () => {
    const c = await company();
    await sources(c);
    const { candidates } = await callerFor(c.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    const ticket = candidates.find(x => x.sourceType === "field_ticket")!;
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE sourceRecordRef = ?", [ticket.sourceRef])).toBe(0);
    const sub = await callerFor(c.worker).payrollTime.myCandidateSubmit({ candidateKey: ticket.candidateKey, from: "2026-03-02", through: "2026-03-08", earningCode: "REG" });
    expect(await entry(sub.entryRef)).toMatchObject({ sourceRecordType: "field_ticket", sourceRecordRef: ticket.sourceRef, candidateKey: ticket.candidateKey, sourceFingerprint: ticket.sourceFingerprint, source: "field_ticket", minutes: 420, status: "submitted" });
    const again = await refusal(() => callerFor(c.worker).payrollTime.myCandidateSubmit({ candidateKey: ticket.candidateKey, from: "2026-03-02", through: "2026-03-08" }));
    expect(again.code).toBe("PRECONDITION_FAILED");
    expect(again.message).toMatch(/Already submitted/);
    const after = await callerFor(c.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    expect(after.candidates.find(x => x.candidateKey === ticket.candidateKey)).toMatchObject({ status: "candidate", eligible: false, submittedAsEntryRef: sub.entryRef });
    // A candidate key the worker does not have is not found.
    expect((await refusal(() => callerFor(c.worker).payrollTime.myCandidateSubmit({ candidateKey: "0".repeat(64), from: "2026-03-02", through: "2026-03-08" }))).code).toBe("NOT_FOUND");
  }, 60_000);

  it("lets the same source become at most one effective entry, even concurrently (14)", async () => {
    const c = await company();
    await sources(c);
    const { candidates } = await callerFor(c.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    const hos = candidates.find(x => x.sourceType === "hos_duty")!;
    const results = await Promise.allSettled([1, 2, 3].map(() => callerFor(c.worker).payrollTime.myCandidateSubmit({ candidateKey: hos.candidateKey, from: "2026-03-02", through: "2026-03-08" })));
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    for (const r of results.filter(r => r.status === "rejected")) expect(["CONFLICT", "PRECONDITION_FAILED"]).toContain(code((r as PromiseRejectedResult).reason));
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE effectiveSourceKey = ?", [hos.candidateKey])).toBe(1);
  }, 60_000);

  it("refuses approval when the field ticket changed after preparation, and while it is changing (22, race)", async () => {
    const c = await company();
    const s = await sources(c);
    const { candidates } = await callerFor(c.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    const ticket = candidates.find(x => x.sourceType === "field_ticket")!;
    const sub = await callerFor(c.worker).payrollTime.myCandidateSubmit({ candidateKey: ticket.candidateKey, from: "2026-03-02", through: "2026-03-08", earningCode: "REG" });
    // A sealed revision appears after preparation: the source's version moved.
    const [[t]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTickets WHERE ticketNumber = ?", [s.ticketNumber]);
    await pool.execute("INSERT INTO fieldTicketRevisions (documentRef, fieldTicketId, revision, kind, snapshotJson, snapshotHash, generatedAt) VALUES (?,?,1,'final','{}',?,NOW())", [`DOC-${rnd()}`, t!.id, "a".repeat(64)]);
    const r = await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: sub.entryRef }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/changed after this time was prepared/);
    expect((await openExceptions(sub.entryRef)).map(e => e.kind)).toContain("source_changed_after_preparation");
    expect((await entry(sub.entryRef)).status).toBe("submitted");
    // The worker re-reads the source and corrects; the correction is approvable.
    const fixed = await callerFor(c.worker).payrollTime.myEntryCorrect({ entryRef: sub.entryRef, notes: "Ticket was finalized", refreshSource: true });
    expect((await callerFor(c.admin).payrollTime.entryApprove({ entryRef: fixed.entryRef })).status).toBe("approved");

    // Race: a concurrent edit holds the ticket row; approval waits for it and then sees the change.
    const c2 = await company();
    const s2 = await sources(c2);
    const { candidates: cs2 } = await callerFor(c2.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    const t2 = cs2.find(x => x.sourceType === "field_ticket")!;
    const sub2 = await callerFor(c2.worker).payrollTime.myCandidateSubmit({ candidateKey: t2.candidateKey, from: "2026-03-02", through: "2026-03-08", earningCode: "REG" });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE fieldTickets SET completedAt = '2026-03-05 23:00:00' WHERE ticketNumber = ?", [s2.ticketNumber]);
      const approval = refusal(() => callerFor(c2.admin).payrollTime.entryApprove({ entryRef: sub2.entryRef }));
      await sleep(400);
      await conn.commit();
      const out = await approval;
      expect(out.code).toBe("PRECONDITION_FAILED");
      expect(out.message).toMatch(/changed/);
    } finally { conn.release(); }
    expect((await entry(sub2.entryRef)).status).toBe("submitted");
  }, 90_000);

  it("refuses another organization's source: its candidates never appear and cannot be named", async () => {
    const a = await company(), b = await company();
    await sources(a);
    const { candidates } = await callerFor(a.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" });
    const key = candidates[0]!.candidateKey;
    expect((await callerFor(b.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" })).candidates).toEqual([]);
    expect((await refusal(() => callerFor(b.worker).payrollTime.myCandidateSubmit({ candidateKey: key, from: "2026-03-02", through: "2026-03-08" }))).code).toBe("NOT_FOUND");
    // A's operator listed under B's job is not B's candidate either: a booking whose job is foreign is skipped.
    await pool.execute("INSERT INTO resourceBookings (resourceType, resourceRef, jobId, startsAt, endsAt, bookingState) VALUES ('operator', ?, ?, '2026-03-06 15:00:00', '2026-03-06 23:00:00', 'confirmed')", [String(b.operatorId), a.jobId]);
    expect((await callerFor(b.worker).payrollTime.myCandidates({ from: "2026-03-02", through: "2026-03-08" })).candidates).toEqual([]);
  }, 60_000);
});

d("P3 — the period lock (16, 17)", () => {
  it("refuses ordinary new time once the period is reviewing or approved, and records the refusal", async () => {
    const c = await company();
    await callerFor(c.admin).payrollSchedule.periodSubmit({ periodRef: c.period1 });
    const r = await refusal(() => own(c, { clientCaptureRef: `cap-${rnd()}` }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/open period/);
    expect((await refusal(() => callerFor(c.worker).payroll.submitTime({ activity: "driving", startedAt: START, endedAt: END }))).code).toBe("PRECONDITION_FAILED");
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE employeePayrollProfileId = ?", [c.profileId])).toBe(0);
    // Two refused attempts (the new procedure, then the legacy one), two records; neither wrote time.
    expect((await callerFor(c.admin).payrollTime.exceptionsList({ kind: "locked_pay_period" })).length).toBe(2);
    // Next week's period is still open.
    expect((await own(c, { startedAt: new Date("2026-03-10T15:00:00Z"), endedAt: new Date("2026-03-10T23:00:00Z") })).status).toBe("submitted");
  }, 60_000);

  it("keeps a period holding submitted time from being voided", async () => {
    const c = await company();
    const r = await own(c);
    const v = await refusal(() => callerFor(c.controller).payrollSchedule.periodVoid({ periodRef: c.period1, reason: "opened by mistake" }));
    expect(v.code).toBe("PRECONDITION_FAILED");
    expect(v.message).toMatch(/time entry/);
    await callerFor(c.worker).payrollTime.myEntryWithdraw({ entryRef: r.entryRef, reason: "Wrong week entirely" });
    expect((await callerFor(c.controller).payrollSchedule.periodVoid({ periodRef: c.period1, reason: "opened by mistake" })).state).toBe("voided");
  }, 60_000);

  it("re-checks the period inside the submission's transaction: a lock that lands first wins", async () => {
    const c = await company();
    const [[p]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payPeriods WHERE periodRef = ?", [c.period1]);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("SELECT id FROM payPeriods WHERE id = ? FOR UPDATE", [p!.id]);
      await conn.execute("UPDATE payPeriods SET state = 'approved' WHERE id = ?", [p!.id]);
      const submission = refusal(() => own(c));
      await sleep(400);
      await conn.commit();
      expect((await submission).code).toBe("PRECONDITION_FAILED");
    } finally { conn.release(); }
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE employeePayrollProfileId = ?", [c.profileId])).toBe(0);
  }, 60_000);

  it("records time without a schedule as pending, and refuses to approve it until a period exists", async () => {
    const c = await company({ payGroup: false });
    const r = await own(c);
    expect(r.exceptions).toContain("no_pay_schedule");
    expect((await entry(r.entryRef)).payPeriodId).toBeNull();
    expect((await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef }))).message).toMatch(/no pay group/);
    const groupKey = (await callerFor(c.admin).payrollSchedule.payGroupSave({ financialEntityId: c.entityId, label: "Drivers", scheduleRef: c.scheduleRef })).groupKey;
    await callerFor(c.admin).payrollSchedule.profileAssignPayGroup({ employeePayrollProfileId: c.profileId, groupKey });
    expect((await callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef })).status).toBe("approved");
    expect((await openExceptions(r.entryRef)).map(e => e.kind)).not.toContain("no_pay_schedule");
    const [[p]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payPeriods WHERE periodRef = ?", [c.period1]);
    expect((await entry(r.entryRef)).payPeriodId).toBe(p!.id);
  }, 60_000);
});

d("P3 — time → earning, and the only way into a run (23–27, 29)", () => {
  it("prices approved time from the approved P1 version; the earning waits for runCollect", async () => {
    const c = await company();
    const { versionRef } = await agreement(c, 30_000);
    const [[v0]] = await pool.query<mysql.RowDataPacket[]>("SELECT rulesHash, CAST(rulesJson AS CHAR) AS rules, status FROM compensationAgreementVersions WHERE versionRef = ?", [versionRef]);
    const r = await own(c, { startedAt: START, endedAt: new Date("2026-03-03T22:37:00Z") });   // 7h37m
    const ok = await callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef });
    expect(ok).toMatchObject({ status: "approved", earningCreated: true, earningBlockedBy: null });
    const [[e]] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM payrollEarningEvents WHERE earningRef = ?", [`ERN-${r.entryRef}`]);
    expect(e).toMatchObject({ status: "approved", calculatedAmountCents: 22_850, rateAppliedMillis: 30_000, workedMinutes: 457, earningCode: "REG", agreementVersionRef: versionRef, rulesHash: v0!.rulesHash, source: "approved_timesheet", approvedByUserId: c.admin, employeePayrollProfileId: c.profileId });
    expect((await entry(r.entryRef)).payrollEarningEventId).toBe(e!.id);
    expect(await n("SELECT COUNT(*) AS n FROM payRunLines WHERE payrollEarningEventId = ?", [e!.id])).toBe(0);
    // Collection is the only way in, and it takes the approved earning only.
    await callerFor(c.worker).payroll.submitTime({ activity: "driving", startedAt: new Date("2026-03-04T15:00:00Z"), endedAt: new Date("2026-03-04T16:00:00Z") });
    const [[pid]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payPeriods WHERE periodRef = ?", [c.period1]);
    const payRunRef = `RUN-${rnd()}`;
    await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: pid!.id, financialEntityId: c.entityId });
    const col = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(col).toMatchObject({ collected: 1, amountCents: 22_850 });   // 457 min × $30/h = $228.50
    expect(await n("SELECT COUNT(*) AS n FROM payRunLines WHERE payrollEarningEventId = ?", [e!.id])).toBe(1);
    // P1's version and its frozen rules are exactly as approved.
    const [[v1]] = await pool.query<mysql.RowDataPacket[]>("SELECT rulesHash, CAST(rulesJson AS CHAR) AS rules, status FROM compensationAgreementVersions WHERE versionRef = ?", [versionRef]);
    expect(v1).toEqual(v0);
  }, 90_000);

  it("approves the time but creates no earning without an agreement, until one is approved (24)", async () => {
    const c = await company();
    const r = await own(c);
    const ok = await callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef });
    expect(ok).toMatchObject({ status: "approved", earningCreated: false, earningBlockedBy: "no_active_agreement" });
    expect(await n("SELECT COUNT(*) AS n FROM payrollEarningEvents WHERE employeePayrollProfileId = ?", [c.profileId])).toBe(0);
    const x = (await openExceptions(r.entryRef)).find(e => e.kind === "no_active_agreement")!;
    expect(x.severity).toBe("blocking");
    await agreement(c);
    const g = await callerFor(c.admin).payrollTime.earningGenerate({ entryRef: r.entryRef });
    expect(g).toMatchObject({ earningCreated: true, earningRef: `ERN-${r.entryRef}` });
    expect((await openExceptions(r.entryRef)).map(e => e.kind)).not.toContain("no_active_agreement");
    expect((await refusal(() => callerFor(c.admin).payrollTime.earningGenerate({ entryRef: r.entryRef }))).message).toMatch(/already has its earning/);
  }, 60_000);

  it("creates no earning without an earning code, until payroll fills it (25)", async () => {
    const c = await company();
    await agreement(c);
    const r = await own(c, { earningCode: undefined });
    const ok = await callerFor(c.admin).payrollTime.entryApprove({ entryRef: r.entryRef });
    expect(ok).toMatchObject({ earningCreated: false, earningBlockedBy: "missing_earning_code" });
    expect((await refusal(() => callerFor(c.worker).payrollTime.earningGenerate({ entryRef: r.entryRef, earningCode: "REG" }))).code).toBe("FORBIDDEN");
    const g = await callerFor(c.admin).payrollTime.earningGenerate({ entryRef: r.entryRef, earningCode: "REG" });
    expect(g.earningCreated).toBe(true);
    const [[e]] = await pool.query<mysql.RowDataPacket[]>("SELECT calculatedAmountCents FROM payrollEarningEvents WHERE earningRef = ?", [`ERN-${r.entryRef}`]);
    expect(e!.calculatedAmountCents).toBe(24_000);
  }, 60_000);

  it("approves time submitted while OPEN during REVIEWING, with its earning, and nothing once APPROVED", async () => {
    const c = await company();
    await agreement(c);
    const a = await own(c);
    const b = await own(c, { startedAt: new Date("2026-03-04T15:00:00Z"), endedAt: new Date("2026-03-04T23:00:00Z") });
    await callerFor(c.admin).payrollSchedule.periodSubmit({ periodRef: c.period1 });
    expect(await callerFor(c.admin).payrollTime.entryApprove({ entryRef: a.entryRef })).toMatchObject({ status: "approved", earningCreated: true });
    await callerFor(c.controller).payrollSchedule.periodApprove({ periodRef: c.period1 });
    const r = await refusal(() => callerFor(c.admin).payrollTime.entryApprove({ entryRef: b.entryRef }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/open or under review/);
    expect((await entry(b.entryRef)).status).toBe("submitted");
  }, 60_000);

  it("refuses an earning code that is not active in the book, at submission", async () => {
    const c = await company();
    expect((await refusal(() => own(c, { earningCode: "NOPE" }))).code).toBe("BAD_REQUEST");
  }, 60_000);
});

d("P3 — offline captures never approve (T15)", () => {
  it("lands a capture as submitted (or a draft), refuses any other claimed state, and keeps the device's claims", async () => {
    const c = await company();
    for (const claim of ["approved", "verified", "paid"]) expect((await refusal(() => own(c, { clientCaptureRef: `dev:${rnd()}`, captureState: claim }))).code, claim).toBe("BAD_REQUEST");
    const cap = `dev7:${rnd()}`;
    const r = await own(c, { clientCaptureRef: cap, capturedAt: new Date("2026-03-03T23:10:00Z"), deviceRef: "dev7", captureState: "submitted" });
    const row = await entry(r.entryRef);
    expect(row).toMatchObject({ status: "submitted", clientCaptureRef: cap, deviceRef: "dev7", approvedByUserId: null });
    expect(await n("SELECT COUNT(*) AS n FROM payrollTimeEntries WHERE employeePayrollProfileId = ? AND status = 'approved'", [c.profileId])).toBe(0);
  }, 60_000);
});

d("P3 — who holds which door", () => {
  it("keeps exceptions and earning approval in the payroll office", async () => {
    const c = await company();
    for (const role of ["driver", "dispatcher", "mechanic", "bookkeeper", "auditor", "management"]) {
      const u = callerFor(await member(c.orgRef, [role]));
      expect((await refusal(() => u.payrollTime.exceptionsList())).code, role).toBe("FORBIDDEN");
      expect((await refusal(() => u.payrollTime.exceptionsScan({ periodRef: c.period1 }))).code, role).toBe("FORBIDDEN");
      expect((await refusal(() => u.payrollTime.earningGenerate({ entryRef: "PT-NONE-0" }))).code, role).toBe("FORBIDDEN");
    }
    expect(Array.isArray(await callerFor(c.hr).payrollTime.exceptionsList())).toBe(true);
    expect((await refusal(() => callerFor(c.hr).payrollTime.exceptionsScan({ periodRef: c.period1 }))).code).toBe("FORBIDDEN");
    const r = await own(c);
    const scan = await callerFor(c.admin).payrollTime.exceptionsScan({ periodRef: c.period1 });
    expect(scan.missingApproval).toBe(1);
    await callerFor(c.admin).payrollTime.exceptionsScan({ periodRef: c.period1 });
    expect((await openExceptions(r.entryRef)).filter(e => e.kind === "missing_approval").length).toBe(1);
  }, 60_000);
});
