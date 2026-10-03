/**
 * Payroll P4 — employee expense claims and payroll reimbursements, met the way a client meets them: through
 * `appRouter.createCaller`, with real role grants, memberships, books, schedules, receipts and pay runs. The race tests
 * hold rows on a second connection (or run two collectors at once), so the "exactly one line" claim is observed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 370_000_000 + Math.floor(Math.random() * 50_000);
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

/** A receipt the user captured, with a content hash for its first version. */
async function receipt(userId: number, hash = rnd().padEnd(64, "0")) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, capturedBy, storageKey, recordType) VALUES ('Receipt', 'receipt', NOW(), ?, ?, 'expense_receipt')", [userId, `r/${rnd()}`]);
  await pool.execute("INSERT INTO evidenceVersions (evidenceRecordId, version, contentHash, manifestHash) VALUES (?, 1, ?, ?)", [e.insertId, hash, "m".repeat(64)]);
  return e.insertId;
}
async function jobIn(orgRef: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "10-22-045-06-W5", orgRef]);
  return j.insertId;
}

/** A book with a weekly schedule whose periods run from Monday 2026-03-02 to 2026-12-28, a pay group, and a driver on it. */
async function company(opts: { payGroup?: boolean } = {}) {
  const orgRef = await org();
  const controller = await member(orgRef, ["controller"]);
  const admin = await member(orgRef, ["payroll_admin"]);
  const hr = await member(orgRef, ["hr"]);
  const worker = await member(orgRef, ["driver"]);
  const entityId = (await callerFor(controller).finance.entityCreate(entityInput())).id as number;
  const profileId = (await callerFor(admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: entityId, userId: worker, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).id as number;
  const scheduleRef = (await callerFor(admin).payrollSchedule.scheduleCreate({ financialEntityId: entityId, name: "Weekly", frequency: "weekly", anchorDate: "2026-03-02", timezone: "America/Edmonton" })).scheduleRef;
  let groupKey: string | null = null;
  if (opts.payGroup !== false) {
    groupKey = (await callerFor(admin).payrollSchedule.payGroupSave({ financialEntityId: entityId, label: "Drivers", scheduleRef })).groupKey;
    await callerFor(admin).payrollSchedule.profileAssignPayGroup({ employeePayrollProfileId: profileId, groupKey });
  }
  return { orgRef, controller, admin, hr, worker, entityId, profileId, scheduleRef, groupKey };
}
type Co = Awaited<ReturnType<typeof company>>;

/** Generate periods up to and including the one containing today, and return the current period's ref and id. */
async function currentPeriod(c: Co) {
  const today = new Date().toISOString().slice(0, 10);
  const g = await callerFor(c.admin).payrollSchedule.periodsGenerate({ scheduleRef: c.scheduleRef, through: today, from: today });
  const periodRef = (g.created[0] ?? g.existing[0])!;
  const [[p]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payPeriods WHERE periodRef = ?", [periodRef]);
  return { periodRef, periodId: Number(p!.id) };
}
async function run(c: Co, periodId: number) {
  const payRunRef = `RUN-${rnd()}`;
  await callerFor(c.admin).payroll.runCreate({ payRunRef, payPeriodId: periodId, financialEntityId: c.entityId });
  return payRunRef;
}

const FACTS = { vendorName: "Esso Grande Prairie", transactionDate: new Date("2026-03-03T18:00:00Z"), currency: "CAD", totalCents: 8_430 };
const claim = (c: Co, over: Record<string, unknown> = {}) => callerFor(c.worker).payrollExpense.myExpenseSubmit({ ...FACTS, ...over } as never);
const expense = async (expenseRef: string) => (await q("SELECT * FROM expenseRecords WHERE expenseRef = ?", [expenseRef]))[0]!;
const openExceptions = (subjectRef: string) => q("SELECT kind, severity, exceptionRef FROM payrollExceptions WHERE subjectRef = ? AND state = 'open'", [subjectRef]);
const resolveAll = async (c: Co, expenseRef: string) => { for (const x of await openExceptions(expenseRef)) await callerFor(c.admin).payrollTime.exceptionResolve({ exceptionRef: x.exceptionRef, outcome: "resolved", note: "Reviewed and accepted" }); };

d("P4 — the employee's own claims", () => {
  it("submits a personally paid expense as a pending claim, with the claimant and book chosen on the server (1, 8, 9)", async () => {
    const c = await company();
    const ev = await receipt(c.worker);
    const r = await claim(c, { evidenceRecordId: ev, clientCaptureRef: `dev:${rnd()}` });
    expect(r).toMatchObject({ reimbursementState: "pending_approval", replayed: false, exceptions: [] });
    expect(await expense(r.expenseRef)).toMatchObject({ employeePayrollProfileId: c.profileId, financialEntityId: c.entityId, status: "submitted", reimbursementState: "pending_approval", paidPersonally: 1, reimbursementRequired: 1, reimbursementCents: 8_430, totalCents: 8_430, submittedByUserId: c.worker, paidByUserId: c.worker, evidenceRecordId: ev });
    const mine = await callerFor(c.worker).payrollExpense.myExpensesList();
    expect(mine.map(e => e.expenseRef)).toEqual([r.expenseRef]);
    expect(mine[0]).toMatchObject({ paid: false });
  }, 60_000);

  it("records a company-paid expense as an expense, never a claim (10)", async () => {
    const c = await company();
    const r = await claim(c, { paidPersonally: false, evidenceRecordId: await receipt(c.worker) });
    expect(r.reimbursementState).toBe("not_applicable");
    expect(await expense(r.expenseRef)).toMatchObject({ reimbursementState: "not_applicable", paidPersonally: 0, reimbursementRequired: 0, reimbursementCents: null });
    expect((await callerFor(c.admin).payrollExpense.pendingList()).some(e => e.expenseRef === r.expenseRef)).toBe(false);
  }, 60_000);

  it("takes no profile, user or state from input, and keeps coworkers out (2, 3)", async () => {
    const c = await company();
    for (const extra of [{ employeePayrollProfileId: c.profileId }, { userId: c.worker }, { reimbursementState: "approved" }, { status: "approved" }]) {
      expect((await refusal(() => claim(c, extra))).code, JSON.stringify(extra)).toBe("BAD_REQUEST");
    }
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker) });
    const co = await member(c.orgRef, ["driver"]);
    await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId: co, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" });
    expect((await refusal(() => callerFor(co).payrollExpense.myExpenseGet({ expenseRef: r.expenseRef }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(co).payrollExpense.myExpenseWithdraw({ expenseRef: r.expenseRef, reason: "not mine at all" }))).code).toBe("NOT_FOUND");
    expect((await callerFor(co).payrollExpense.myExpensesList()).length).toBe(0);
    // A coworker's receipt is not theirs to claim, even inside one organization.
    const theirReceipt = (await expense(r.expenseRef)).evidenceRecordId;
    expect((await refusal(() => callerFor(co).payrollExpense.myExpenseSubmit({ ...FACTS, evidenceRecordId: theirReceipt } as never))).code).toBe("NOT_FOUND");
  }, 60_000);

  it("refuses an owner-operator the employee reimbursement path (29)", async () => {
    const c = await company();
    const owner = await member(c.orgRef, ["driver"]);
    await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'OWNER_DRIVER','active','2026-01-01',1)", [`W-${rnd()}`, c.orgRef, owner]);
    await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId: owner, workerKind: "employee", employmentType: "casual", defaultPayMethod: "load" });
    const r = await refusal(() => callerFor(owner).payrollExpense.myExpenseSubmit({ ...FACTS } as never));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/contractor settlement/);
  }, 60_000);
});

d("P4 — the tenant boundary (4, 5, 6, 7)", () => {
  it("is not found across organizations, for claims, receipts, jobs and units, and records the attempts", async () => {
    const a = await company(), b = await company();
    const r = await claim(a, { evidenceRecordId: await receipt(a.worker) });
    expect((await refusal(() => callerFor(b.admin).payrollExpense.expenseGet({ expenseRef: r.expenseRef }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollExpense.approve({ expenseRef: r.expenseRef }))).code).toBe("NOT_FOUND");
    expect((await callerFor(b.admin).payrollExpense.pendingList()).some(e => e.expenseRef === r.expenseRef)).toBe(false);
    const evA = await receipt(a.worker);
    const jobA = await jobIn(a.orgRef);
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [`U-${rnd()}`]);
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [a.orgRef, u.insertId]);
    const before = await n("SELECT COUNT(*) AS n FROM expenseRecords WHERE employeePayrollProfileId = ?", [b.profileId]);
    expect((await refusal(() => claim(b, { evidenceRecordId: evA }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => claim(b, { jobId: jobA }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => claim(b, { unitId: u.insertId }))).code).toBe("NOT_FOUND");
    expect(await n("SELECT COUNT(*) AS n FROM expenseRecords WHERE employeePayrollProfileId = ?", [b.profileId])).toBe(before);
    expect((await callerFor(b.admin).payrollTime.exceptionsList({ kind: "cross_tenant_reference" })).length).toBe(3);
    // The finance path that used to write any job or receipt id now refuses a foreign one too.
    expect((await refusal(() => callerFor(b.worker).finance.expenseCreate({ expenseRef: `EXP-${rnd()}`, financialEntityId: b.entityId, total: 10, transactionDate: new Date(), evidenceRecordId: evA }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.worker).finance.expenseCreate({ expenseRef: `EXP-${rnd()}`, financialEntityId: b.entityId, total: 10, transactionDate: new Date(), jobId: jobA }))).code).toBe("NOT_FOUND");
  }, 60_000);
});

d("P4 — receipts and duplicates (11, 12, 13, 31, 32)", () => {
  it("flags a claim with no receipt and holds its approval until a person accepts it", async () => {
    const c = await company();
    const r = await claim(c);
    expect(r.exceptions).toEqual(["receipt_required"]);
    const held = await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef }));
    expect(held.code).toBe("PRECONDITION_FAILED");
    expect(held.message).toMatch(/receipt_required/);
    expect((await expense(r.expenseRef)).reimbursementState).toBe("pending_approval");
    await resolveAll(c, r.expenseRef);
    expect((await callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef })).reimbursementState).toBe("approved");
  }, 60_000);

  it("replays a capture to the same claim, refuses a second claim on one receipt, and flags a probable duplicate", async () => {
    const c = await company();
    const ev = await receipt(c.worker);
    const cap = `dev:${rnd()}`;
    const first = await claim(c, { evidenceRecordId: ev, clientCaptureRef: cap });
    expect(await claim(c, { evidenceRecordId: ev, clientCaptureRef: cap })).toMatchObject({ expenseRef: first.expenseRef, replayed: true });
    const cap2 = `dev:${rnd()}`;
    const ev2 = await receipt(c.worker);
    const both = await Promise.all([claim(c, { evidenceRecordId: ev2, clientCaptureRef: cap2, totalCents: 111 }), claim(c, { evidenceRecordId: ev2, clientCaptureRef: cap2, totalCents: 111 })]);
    expect(both[0].expenseRef).toBe(both[1].expenseRef);
    expect((await refusal(() => claim(c, { evidenceRecordId: ev }))).code).toBe("CONFLICT");
    // Same vendor, amount and day on a different receipt: possibly the card slip for the same purchase. Review, not rejection.
    const dup = await claim(c, { evidenceRecordId: await receipt(c.worker), transactionDate: new Date("2026-03-04T10:00:00Z") });
    expect(dup.exceptions).toContain("duplicate_expense");
    expect((await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: dup.expenseRef }))).message).toMatch(/duplicate_expense/);
    expect((await callerFor(c.admin).payrollExpense.duplicates({ expenseRef: dup.expenseRef })).map(x => x.otherRef)).toContain(first.expenseRef);
    // The same image under a new receipt record is flagged too.
    const firstHash = (await q("SELECT contentHash FROM evidenceVersions WHERE evidenceRecordId = ?", [ev]))[0]!.contentHash as string;
    const sameImage = await claim(c, { evidenceRecordId: await receipt(c.worker, firstHash), totalCents: 999, vendorName: "Somewhere else" });
    expect(sameImage.exceptions).toContain("duplicate_expense");
    // A withdrawn claim releases its receipt for a corrected claim.
    await callerFor(c.worker).payrollExpense.myExpenseWithdraw({ expenseRef: first.expenseRef, reason: "Wrong amount entered" });
    const fixed = await claim(c, { evidenceRecordId: ev, totalCents: 8_400, supersedesExpenseRef: first.expenseRef });
    expect((await expense(fixed.expenseRef)).supersedesExpenseId).toBe((await expense(first.expenseRef)).id);
  }, 60_000);

  it("will not reimburse a personal fuel purchase twice (31)", async () => {
    const c = await company();
    const ev = await receipt(c.worker);
    await pool.execute("INSERT INTO fuelTransactions (fuelRef, financialEntityId, occurredAt, fuelType, totalCents, fueledByUserId, payerType, reimbursementStatus, evidenceRecordId) VALUES (?,?, '2026-03-03 17:00:00', 'diesel', 8430, ?, 'worker_personal', 'pending', NULL)", [`FUEL-${rnd()}`, c.entityId, c.worker]);
    const r = await claim(c, { evidenceRecordId: ev });
    expect(r.exceptions).toContain("duplicate_expense");
    expect(r.duplicates.map(x => (x as { kind: string }).kind)).toContain("fuel_receipt");
    expect((await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef }))).code).toBe("PRECONDITION_FAILED");
    // The same receipt on a fuel transaction is flagged even when the amounts differ.
    const ev2 = await receipt(c.worker);
    await pool.execute("INSERT INTO fuelTransactions (fuelRef, financialEntityId, occurredAt, fuelType, totalCents, payerType, evidenceRecordId) VALUES (?,?, '2026-02-01 10:00:00', 'diesel', 100, 'company', ?)", [`FUEL-${rnd()}`, c.entityId, ev2]);
    expect((await claim(c, { evidenceRecordId: ev2, totalCents: 5_000, vendorName: "Shell" })).exceptions).toContain("duplicate_expense");
  }, 60_000);

  it("refuses approval when the receipt changed after submission, and while it is changing (32)", async () => {
    const c = await company();
    const ev = await receipt(c.worker);
    const r = await claim(c, { evidenceRecordId: ev });
    await pool.execute("UPDATE evidenceRecords SET currentVersion = 2, sealState = 'amended' WHERE id = ?", [ev]);
    const x = await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef }));
    expect(x.code).toBe("PRECONDITION_FAILED");
    expect(x.message).toMatch(/receipt changed/);
    expect((await openExceptions(r.expenseRef)).map(e => e.kind)).toContain("evidence_changed_after_submission");
    // Race: an amendment holding the receipt row makes approval wait, then see it.
    const ev2 = await receipt(c.worker);
    const r2 = await claim(c, { evidenceRecordId: ev2, totalCents: 1_234, vendorName: "Co-op" });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE evidenceRecords SET sealState = 'sealed' WHERE id = ?", [ev2]);
      const approval = refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: r2.expenseRef }));
      await sleep(400);
      await conn.commit();
      expect((await approval).message).toMatch(/receipt changed/);
    } finally { conn.release(); }
    expect((await expense(r2.expenseRef)).reimbursementState).toBe("pending_approval");
  }, 60_000);
});

d("P4 — approval authority and separation of duties (14, 15, 16, 17, 18, 19, 20)", () => {
  it("lets the payroll office approve, records who and when, and refuses the claimant, a supervisor and dispatch", async () => {
    const c = await company();
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker) });
    // The claimant holds no approval permission at all; a crew supervisor gains none through D10.
    expect((await refusal(() => callerFor(c.worker).payrollExpense.approve({ expenseRef: r.expenseRef }))).code).toBe("FORBIDDEN");
    const sup = await member(c.orgRef, ["driver"]);
    const crewRef = `CREW-${rnd()}`;
    await pool.execute("INSERT INTO crews (crewRef, tenantId, name, state, createdByUserId) VALUES (?,?,?, 'active', 1)", [crewRef, c.orgRef, "Crew"]);
    await pool.execute("INSERT INTO crewMembers (crewRef, userId, crewRole, joinedAt) VALUES (?,?,'driver','2026-01-01'), (?,?,'supervisor','2026-01-01')", [crewRef, c.worker, crewRef, sup]);
    for (const u of [sup, await member(c.orgRef, ["dispatcher"]), await member(c.orgRef, ["bookkeeper"]), await member(c.orgRef, ["management"])]) {
      expect((await refusal(() => callerFor(u).payrollExpense.approve({ expenseRef: r.expenseRef }))).code).toBe("FORBIDDEN");
      expect((await refusal(() => callerFor(u).payrollExpense.pendingList())).code).toBe("FORBIDDEN");
    }
    const before = Date.now() - 1000;
    expect(await callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef })).toMatchObject({ reimbursementState: "approved", paid: false });
    const row = await expense(r.expenseRef);
    expect(row).toMatchObject({ reimbursementState: "approved", status: "approved", reimbursementApprovedByUserId: c.admin });
    expect(new Date(row.reimbursementApprovedAt).getTime()).toBeGreaterThan(before);
  }, 60_000);

  it("refuses a claimant who holds approval authority their own claim, and records the attempt", async () => {
    const c = await company();
    await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId: c.hr, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "salary" });
    const own = await callerFor(c.hr).payrollExpense.myExpenseSubmit({ ...FACTS, evidenceRecordId: await receipt(c.hr) } as never);
    const x = await refusal(() => callerFor(c.hr).payrollExpense.approve({ expenseRef: own.expenseRef }));
    expect(x.code).toBe("FORBIDDEN");
    expect((await openExceptions(own.expenseRef)).map(e => e.kind)).toContain("self_approval_blocked");
    expect((await callerFor(c.admin).payrollExpense.approve({ expenseRef: own.expenseRef })).reimbursementState).toBe("approved");
  }, 60_000);

  it("keeps rejected and withdrawn claims visible, and an approved claim out of the employee's hands", async () => {
    const c = await company();
    const a = await claim(c, { evidenceRecordId: await receipt(c.worker) });
    await callerFor(c.hr).payrollExpense.reject({ expenseRef: a.expenseRef, reason: "Personal purchase, not business" });
    const b = await claim(c, { evidenceRecordId: await receipt(c.worker), totalCents: 2_000, vendorName: "Tim Hortons" });
    await callerFor(c.worker).payrollExpense.myExpenseWithdraw({ expenseRef: b.expenseRef, reason: "Submitted by mistake" });
    const mine = await callerFor(c.worker).payrollExpense.myExpensesList();
    expect(mine.find(e => e.expenseRef === a.expenseRef)).toMatchObject({ reimbursementState: "rejected", status: "rejected", rejectedReason: "Personal purchase, not business" });
    expect(mine.find(e => e.expenseRef === b.expenseRef)).toMatchObject({ reimbursementState: "withdrawn", withdrawReason: "Submitted by mistake" });
    expect((await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: a.expenseRef }))).code).toBe("PRECONDITION_FAILED");
    const cc = await claim(c, { evidenceRecordId: await receipt(c.worker), totalCents: 3_000, vendorName: "Napa" });
    await callerFor(c.admin).payrollExpense.approve({ expenseRef: cc.expenseRef });
    expect((await refusal(() => callerFor(c.worker).payrollExpense.myExpenseWithdraw({ expenseRef: cc.expenseRef, reason: "changed my mind" }))).code).toBe("PRECONDITION_FAILED");
    // The controlled path back: returned for correction before scheduling.
    expect((await callerFor(c.admin).payrollExpense.returnForCorrection({ expenseRef: cc.expenseRef, reason: "Receipt total unclear" })).reimbursementState).toBe("pending_approval");
    expect(await expense(cc.expenseRef)).toMatchObject({ reimbursementApprovedByUserId: null, reimbursementReturnReason: "Receipt total unclear" });
  }, 60_000);
});

d("P4 — scheduling onto a pay run, exactly once, and not as payment (21–27, 33)", () => {
  it("schedules an approved claim as one reimbursement line beside earnings, and never marks it reimbursed", async () => {
    const c = await company();
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker), reimbursementCents: 8_000 });
    await callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef });
    const { periodId } = await currentPeriod(c);
    // An approved earning in the same period still collects (P0).
    const earningRef = `ERN-${rnd()}`;
    await pool.execute("INSERT INTO payrollEarningEvents (earningRef, employeePayrollProfileId, payPeriodId, earningType, source, quantity, unit, calculatedAmount, calculatedAmountCents, status) VALUES (?,?,?,'REG','manual_hr_adjustment',1,'hour',50,5000,'approved')", [earningRef, c.profileId, periodId]);
    const payRunRef = await run(c, periodId);
    const col = await callerFor(c.admin).payroll.runCollect({ payRunRef });
    expect(col).toMatchObject({ collected: 1, amountCents: 5_000, reimbursements: { collected: 1, amountCents: 8_000 } });
    const [[line]] = await pool.query<mysql.RowDataPacket[]>("SELECT l.* FROM payRunLines l JOIN payRuns r ON r.id = l.payRunId WHERE r.payRunRef = ? AND l.lineType = 'reimbursement'", [payRunRef]);
    const row = await expense(r.expenseRef);
    expect(line).toMatchObject({ lineType: "reimbursement", amountCents: 8_000, expenseRecordId: row.id, employeePayrollProfileId: c.profileId, payrollEarningEventId: null });
    expect(row).toMatchObject({ reimbursementState: "scheduled", reimbursementLineId: line!.id, reimbursementPayRunId: line!.payRunId });
    expect((await callerFor(c.worker).payrollExpense.myExpenseGet({ expenseRef: r.expenseRef }))).toMatchObject({ reimbursementState: "scheduled", paid: false, standing: expect.stringMatching(/Not paid/) });
    // Collecting again, or on a second run, takes nothing more.
    expect((await callerFor(c.admin).payroll.runCollect({ payRunRef })).reimbursements.collected).toBe(0);
    const second = await run(c, periodId);
    expect((await callerFor(c.admin).payroll.runCollect({ payRunRef: second })).reimbursements.collected).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM payRunLines WHERE expenseRecordId = ?", [row.id])).toBe(1);
    // Scheduled is not withdrawable and not returnable: correction is P5's adjustment.
    expect((await refusal(() => callerFor(c.admin).payrollExpense.returnForCorrection({ expenseRef: r.expenseRef, reason: "Too late now" }))).code).toBe("PRECONDITION_FAILED");
    expect(await n("SELECT COUNT(*) AS n FROM expenseRecords WHERE reimbursementState = 'reimbursed' AND financialEntityId = ?", [c.entityId])).toBe(0);
  }, 90_000);

  it("lets two collectors racing for one claim produce exactly one line", async () => {
    const c = await company();
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker) });
    await callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef });
    const { periodId } = await currentPeriod(c);
    const runs = [await run(c, periodId), await run(c, periodId), await run(c, periodId)];
    const results = await Promise.all(runs.map(payRunRef => callerFor(c.admin).payroll.runCollect({ payRunRef })));
    expect(results.reduce((s, x) => s + x.reimbursements.collected, 0)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM payRunLines WHERE expenseRecordId = ?", [(await expense(r.expenseRef)).id])).toBe(1);
  }, 90_000);

  it("never schedules into a locked period, a period that ended before approval, or without a schedule (27)", async () => {
    const c = await company();
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker) });
    await callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef });
    // A past period (ended before today's approval) that is still open takes nothing.
    await callerFor(c.admin).payrollSchedule.periodsGenerate({ scheduleRef: c.scheduleRef, through: "2026-03-02" });
    const [[old]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM payPeriods WHERE periodRef = ?", [`${c.scheduleRef}-2026-03-02`]);
    const oldRun = await run(c, Number(old!.id));
    const col = await callerFor(c.admin).payroll.runCollect({ payRunRef: oldRun });
    expect(col.reimbursements.collected).toBe(0);
    expect(col.reimbursements.skipped[0]!.reason).toMatch(/ended before/);
    // A locked period takes no new run at all.
    const { periodRef, periodId } = await currentPeriod(c);
    await callerFor(c.admin).payrollSchedule.periodSubmit({ periodRef });
    await callerFor(c.controller).payrollSchedule.periodApprove({ periodRef });
    expect((await refusal(() => run(c, periodId))).code).toBe("PRECONDITION_FAILED");
    expect((await expense(r.expenseRef)).reimbursementState).toBe("approved");
    // No schedule: approved and owed, but no run can take it.
    const nc = await company({ payGroup: false });
    const nr = await claim(nc, { evidenceRecordId: await receipt(nc.worker) });
    await callerFor(nc.admin).payrollExpense.approve({ expenseRef: nr.expenseRef });
    expect((await callerFor(nc.admin).payrollExpense.expenseGet({ expenseRef: nr.expenseRef })).standing).toMatch(/no pay schedule/);
  }, 90_000);

  it("never converts a foreign-currency claim (28)", async () => {
    const c = await company();
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker), currency: "USD" });
    expect(r.exceptions).toContain("reimbursement_currency_mismatch");
    const x = await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef: r.expenseRef }));
    expect(x.code).toBe("PRECONDITION_FAILED");
    expect(x.message).toMatch(/no currency conversion/);
    expect(await expense(r.expenseRef)).toMatchObject({ currency: "USD", totalCents: 8_430, reimbursementState: "pending_approval" });
  }, 60_000);
});

d("P4 — receipt drafts from the assistant still need a person (30)", () => {
  it("does not treat an assistant draft as a claim, and makes it one only on the employee's submission and someone's approval", async () => {
    const c = await company();
    const expenseRef = `EXP-AI-${rnd()}`;
    // The shape assistantCommitService writes for an expense_receipt: a draft, paid by the proposer, no evidence, no claimant.
    await pool.execute("INSERT INTO expenseRecords (expenseRef, financialEntityId, vendorName, transactionDate, total, categorySource, paidByUserId, status) VALUES (?,?,?,?,?, 'ai_proposed', ?, 'draft')", [expenseRef, c.entityId, "Canadian Tire", "2026-03-05 12:00:00", 64.2, c.worker]);
    expect((await refusal(() => callerFor(c.admin).payrollExpense.approve({ expenseRef }))).code).toBe("NOT_FOUND");
    expect((await callerFor(c.admin).payrollExpense.pendingList()).some(e => e.expenseRef === expenseRef)).toBe(false);
    const other = await member(c.orgRef, ["driver"]);
    await callerFor(c.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: c.entityId, userId: other, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" });
    expect((await refusal(() => callerFor(other).payrollExpense.myExpenseClaimDraft({ expenseRef }))).code).toBe("NOT_FOUND");
    const r = await callerFor(c.worker).payrollExpense.myExpenseClaimDraft({ expenseRef, evidenceRecordId: await receipt(c.worker) });
    expect(r).toMatchObject({ expenseRef, reimbursementState: "pending_approval" });
    expect(await expense(expenseRef)).toMatchObject({ employeePayrollProfileId: c.profileId, totalCents: 6_420, reimbursementCents: 6_420, status: "submitted", submittedByUserId: c.worker });
    expect((await callerFor(c.admin).payrollExpense.approve({ expenseRef })).reimbursementState).toBe("approved");
  }, 60_000);
});

d("P4 — offline captures never approve", () => {
  it("refuses a capture that claims a decided state, and keeps the device's claims", async () => {
    const c = await company();
    for (const s of ["approved", "scheduled", "reimbursed"]) expect((await refusal(() => claim(c, { captureState: s, clientCaptureRef: `dev:${rnd()}` }))).code, s).toBe("BAD_REQUEST");
    const cap = `dev9:${rnd()}`;
    const r = await claim(c, { evidenceRecordId: await receipt(c.worker), clientCaptureRef: cap, capturedAt: new Date("2026-03-03T19:00:00Z"), deviceRef: "dev9" });
    expect(await expense(r.expenseRef)).toMatchObject({ clientCaptureRef: cap, deviceRef: "dev9", reimbursementState: "pending_approval", reimbursementApprovedByUserId: null });
  }, 60_000);
});
