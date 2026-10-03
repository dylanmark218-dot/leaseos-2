/**
 * Payroll P1 — compensation agreements, versions, rules and earning codes, met the way a client meets them.
 *
 * Every call goes through `appRouter.createCaller` with real role grants, organization memberships and
 * financial entities. The P0 suites (payrollP0.db.test.ts, tenantScopeMoney.db.test.ts) cover the legacy
 * paths this checkpoint must leave green; this file covers what P1 adds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 340_000_000 + Math.floor(Math.random() * 50_000);
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

async function company() {
  const orgRef = await org();
  const controller = await member(orgRef, ["controller"]);
  const admin = await member(orgRef, ["payroll_admin"]);
  const hr = await member(orgRef, ["hr"]);
  const worker = await member(orgRef, ["driver"]);
  const dispatcher = await member(orgRef, ["dispatcher"]);
  const entityId = (await callerFor(controller).finance.entityCreate(entityInput())).id as number;
  const profileId = (await callerFor(admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: entityId, userId: worker, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).id as number;
  return { orgRef, controller, admin, hr, worker, dispatcher, entityId, profileId };
}
type Co = Awaited<ReturnType<typeof company>>;

const REG = (rateMillis: number) => ({ earningCode: "REG", calculation: "hourly" as const, unit: "hour" as const, rateMillis });
async function agreement(c: Co, startsOn = "2026-01-01") {
  return (await callerFor(c.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: c.profileId, financialEntityId: c.entityId, title: "Driver agreement", startsOn })).agreementRef!;
}
async function propose(c: Co, agreementRef: string, effectiveFrom: string, rateMillis: number, effectiveUntil?: string) {
  return callerFor(c.admin).payrollCompensation.versionPropose({ agreementRef, effectiveFrom, effectiveUntil, basis: "hourly", rules: [REG(rateMillis)] });
}
async function approved(c: Co, agreementRef: string, effectiveFrom: string, rateMillis: number, effectiveUntil?: string) {
  const v = await propose(c, agreementRef, effectiveFrom, rateMillis, effectiveUntil);
  const a = await callerFor(c.controller).payrollCompensation.versionApprove({ versionRef: v.versionRef });
  expect(a.status).toBe("approved");
  return v;
}
const inForce = (c: Co, agreementRef: string, workDate: string) => callerFor(c.admin).payrollCompensation.versionInForce({ agreementRef, workDate });

d("P1 — tenant boundary", () => {
  it("refuses another organization creating, reading, resolving or approving an agreement (1, 2)", async () => {
    const a = await company(), b = await company();
    expect((await refusal(() => callerFor(b.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: a.profileId, financialEntityId: b.entityId, title: "x", startsOn: "2026-01-01" }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: a.profileId, financialEntityId: a.entityId, title: "x", startsOn: "2026-01-01" }))).code).toBe("NOT_FOUND");
    const ref = await agreement(a);
    const v = await propose(a, ref, "2026-01-01", 30_000);
    expect((await refusal(() => callerFor(b.admin).payrollCompensation.agreementGet({ agreementRef: ref }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollCompensation.versionInForce({ agreementRef: ref, workDate: "2026-02-01" }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.controller).payrollCompensation.versionApprove({ versionRef: v.versionRef }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-02-01", basis: "hourly", rules: [REG(1)] }))).code).toBe("NOT_FOUND");
    expect((await callerFor(b.admin).payrollCompensation.agreementsList()).some(x => x.agreementRef === ref)).toBe(false);
    expect((await callerFor(a.admin).payrollCompensation.agreementsList()).some(x => x.agreementRef === ref)).toBe(true);
  }, 60_000);

  it("refuses an agreement whose book is not the profile's book, even inside one organization (3)", async () => {
    const a = await company();
    const second = (await callerFor(a.controller).finance.entityCreate(entityInput())).id as number;
    const r = await refusal(() => callerFor(a.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: a.profileId, financialEntityId: second, title: "x", startsOn: "2026-01-01" }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/different financial entity/);
  }, 60_000);
});

d("P1 — the employee/contractor boundary and D9 classification", () => {
  it("refuses an owner-driver an employee agreement, and refuses an unclassifiable profile visibly (4)", async () => {
    const a = await company();
    // An owner-driver linked through organizationWorkers, with a payroll profile created before anyone noticed.
    const owner = await member(a.orgRef, ["driver"]);
    await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'OWNER_DRIVER','active','2026-01-01',1)", [`W-${rnd()}`, a.orgRef, owner]);
    const ownerProfile = (await callerFor(a.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: a.entityId, userId: owner, workerKind: "employee", employmentType: "casual", defaultPayMethod: "load" })).id as number;
    const r = await refusal(() => callerFor(a.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: ownerProfile, financialEntityId: a.entityId, title: "x", startsOn: "2026-01-01" }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/contractor settlement/);
    // No worker row, no operator, and only a role that says nothing about employment: refused, not defaulted.
    const hrOnly = await member(a.orgRef, ["hr"]);
    const p2 = (await callerFor(a.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: a.entityId, userId: hrOnly, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "salary" })).id as number;
    const r2 = await refusal(() => callerFor(a.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: p2, financialEntityId: a.entityId, title: "x", startsOn: "2026-01-01" }));
    expect(r2.code).toBe("PRECONDITION_FAILED");
    expect(r2.message).toMatch(/organizationWorkers/);
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT workerClassification FROM employeePayrollProfiles WHERE id = ?", [p2]);
    expect(row!.workerClassification).toBeNull();
    // The legacy path still refuses a contractor a profile at all (P0).
    expect((await refusal(() => callerFor(a.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: a.entityId, workerKind: "contractor", employmentType: "casual", defaultPayMethod: "load" }))).message).toMatch(/contractor settlement/);
  }, 60_000);

  it("snapshots the organizationWorkers type when linked, and the legacy mapping otherwise", async () => {
    const a = await company();
    const ref = await agreement(a);
    const got = await callerFor(a.hr).payrollCompensation.agreementGet({ agreementRef: ref });
    expect(got.agreement).toMatchObject({ workerClassification: "EMPLOYEE_DRIVER", classificationSource: "legacy_mapped" });
    const mech = await member(a.orgRef, ["mechanic"]);
    const workerRef = `W-${rnd()}`;
    await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'SHOP_HAND','active','2026-01-01',1)", [workerRef, a.orgRef, mech]);
    const mp = (await callerFor(a.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: a.entityId, userId: mech, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).id as number;
    expect(await callerFor(a.admin).payrollCompensation.profileClassification({ employeePayrollProfileId: mp })).toMatchObject({ classified: true, classification: "SHOP_HAND", source: "organization_worker", workerRef, agreementEligible: true });
    const r2 = (await callerFor(a.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: mp, financialEntityId: a.entityId, title: "Shop", startsOn: "2026-01-01" }));
    expect(r2).toMatchObject({ workerClassification: "SHOP_HAND", classificationSource: "organization_worker" });
    const [[p]] = await pool.query<mysql.RowDataPacket[]>("SELECT workerClassification, classificationSource, organizationWorkerRef FROM employeePayrollProfiles WHERE id = ?", [mp]);
    expect(p).toMatchObject({ workerClassification: "SHOP_HAND", classificationSource: "organization_worker", organizationWorkerRef: workerRef });
    // A second, overlapping agreement for the same person is refused: a change of pay is a version.
    expect((await refusal(() => agreement(a, "2026-06-01"))).code).toBe("CONFLICT");
  }, 60_000);
});

d("P1 — approval goes through the ladder, by someone else (D4)", () => {
  it("refuses the proposer, refuses a revoked controller, and records the approval on the commercial ledger (5, 6)", async () => {
    const a = await company();
    const ref = await agreement(a);
    // One person who can both propose (hr) and approve (controller): refused as the proposer.
    const both = await member(a.orgRef, ["hr", "controller"]);
    const v = await callerFor(both).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "hourly", rules: [REG(30_000)] });
    const r = await refusal(() => callerFor(both).payrollCompensation.versionApprove({ versionRef: v.versionRef }));
    expect(r.code).toBe("FORBIDDEN");
    expect(r.message).toMatch(/proposed this version/);
    // A controller whose grant was revoked is refused at the gate.
    const revoked = await member(a.orgRef, ["controller"]);
    await pool.execute("UPDATE userRoleAssignments SET revokedAt = NOW() WHERE userId = ? AND role = 'controller'", [revoked]);
    expect((await refusal(() => callerFor(revoked).payrollCompensation.versionApprove({ versionRef: v.versionRef }))).code).toBe("FORBIDDEN");
    // The payroll administrator proposes but never approves.
    expect((await refusal(() => callerFor(a.admin).payrollCompensation.versionApprove({ versionRef: v.versionRef }))).code).toBe("FORBIDDEN");
    const ok = await callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: v.versionRef });
    expect(ok).toMatchObject({ status: "approved", superseded: [] });
    const [[ledger]] = await pool.query<mysql.RowDataPacket[]>("SELECT a.status, a.category, a.subjectType, a.preparedByUserId, s.userId AS signer, s.decision FROM commercialApprovals a JOIN commercialApprovalSignatures s ON s.commercialApprovalId = a.id WHERE a.approvalRef = ?", [ok.approvalRef]);
    expect(ledger).toMatchObject({ status: "satisfied", category: "compensation_agreement", subjectType: "compensationVersion", preparedByUserId: both, signer: a.controller, decision: "approved" });
    const [[vr]] = await pool.query<mysql.RowDataPacket[]>("SELECT status, approvedByUserId, approvalRef FROM compensationAgreementVersions WHERE versionRef = ?", [v.versionRef]);
    expect(vr).toMatchObject({ status: "approved", approvedByUserId: a.controller, approvalRef: ok.approvalRef });
    const got = await callerFor(a.admin).payrollCompensation.agreementGet({ agreementRef: ref });
    expect(got.agreement.status).toBe("active");
  }, 60_000);

  it("refuses a controller approving their own compensation, and lets another controller approve it", async () => {
    const a = await company();
    await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'OFFICE_ADMIN','active','2026-01-01',1)", [`W-${rnd()}`, a.orgRef, a.controller]);
    const own = (await callerFor(a.admin).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: a.entityId, userId: a.controller, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "salary" })).id as number;
    const ref = (await callerFor(a.admin).payrollCompensation.agreementCreate({ employeePayrollProfileId: own, financialEntityId: a.entityId, title: "Controller", startsOn: "2026-01-01" })).agreementRef!;
    const v = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "salary", rules: [{ earningCode: "REG", calculation: "hourly", unit: "hour", rateMillis: 1 }, { earningCode: "SALARY_MONTHLY", calculation: "per_period_salary", unit: "period", rateMillis: 900_000_000 }] }).catch(e => e);
    // The seed has no salary code; a book adds its own, then proposes.
    expect(code(v)).toBe("BAD_REQUEST");
    await callerFor(a.admin).payrollCompensation.earningCodeCreate({ financialEntityId: a.entityId, code: "SALARY_MONTHLY", name: "Monthly salary", calculationType: "per_period_salary", activeFrom: "2026-01-01" });
    const v2 = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "salary", rules: [{ earningCode: "SALARY_MONTHLY", calculation: "per_period_salary", unit: "period", rateMillis: 900_000_000 }] });
    const r = await refusal(() => callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: v2.versionRef }));
    expect(r.code).toBe("FORBIDDEN");
    expect(r.message).toMatch(/your own compensation/);
    const other = await member(a.orgRef, ["controller"]);
    await expect(callerFor(other).payrollCompensation.versionApprove({ versionRef: v2.versionRef })).resolves.toMatchObject({ status: "approved" });
  }, 60_000);
});

d("P1 — effective dating and reproducibility", () => {
  it("never resolves a proposed or rejected version; resolves an approved one from its exact start (7, 8, 9)", async () => {
    const a = await company();
    const ref = await agreement(a);
    const p = await propose(a, ref, "2026-01-01", 30_000);
    expect((await inForce(a, ref, "2026-02-01")).kind).toBe("none");
    await callerFor(a.controller).payrollCompensation.versionReject({ versionRef: p.versionRef, reason: "Wrong rate" });
    expect((await inForce(a, ref, "2026-02-01")).kind).toBe("none");
    expect((await refusal(() => callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: p.versionRef }))).code).toBe("PRECONDITION_FAILED");
    const v = await approved(a, ref, "2026-01-01", 31_000);
    expect(await inForce(a, ref, "2026-01-01")).toMatchObject({ kind: "version", versionRef: v.versionRef });
    expect((await inForce(a, ref, "2025-12-31")).kind).toBe("none");
    const [[rej]] = await pool.query<mysql.RowDataPacket[]>("SELECT status, rejectionReason, rejectedByUserId FROM compensationAgreementVersions WHERE versionRef = ?", [p.versionRef]);
    expect(rej).toMatchObject({ status: "rejected", rejectionReason: "Wrong rate", rejectedByUserId: a.controller });
  }, 60_000);

  it("makes a raise a new version: the old one is closed and superseded, its rules and hash untouched, and history still resolves to it (10, 11, 14, 15)", async () => {
    const a = await company();
    const ref = await agreement(a);
    const v1 = await approved(a, ref, "2026-01-01", 30_000);
    const [[before]] = await pool.query<mysql.RowDataPacket[]>("SELECT v.rulesHash, CAST(v.rulesJson AS CHAR) AS rulesJson, r.rateMillis, r.ruleRef FROM compensationAgreementVersions v JOIN compensationEarningRules r ON r.versionId = v.id WHERE v.versionRef = ?", [v1.versionRef]);
    const v2 = await propose(a, ref, "2026-07-01", 32_000);
    expect(v2.version).toBe(2);
    expect(v2.rulesHash).not.toBe(v1.rulesHash);
    const ok = await callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: v2.versionRef });
    expect(ok.superseded).toEqual([v1.versionRef]);
    const [[after]] = await pool.query<mysql.RowDataPacket[]>("SELECT v.status, DATE_FORMAT(v.effectiveUntil, '%Y-%m-%d') AS effectiveUntil, v.supersededByVersionId, v.rulesHash, CAST(v.rulesJson AS CHAR) AS rulesJson, r.rateMillis, r.ruleRef FROM compensationAgreementVersions v JOIN compensationEarningRules r ON r.versionId = v.id WHERE v.versionRef = ?", [v1.versionRef]);
    expect(after).toMatchObject({ status: "superseded", effectiveUntil: "2026-07-01", rulesHash: before!.rulesHash, rulesJson: before!.rulesJson, rateMillis: before!.rateMillis, ruleRef: before!.ruleRef });
    expect(after!.supersededByVersionId).not.toBeNull();
    const hist = await inForce(a, ref, "2026-06-30");
    expect(hist).toMatchObject({ kind: "version", versionRef: v1.versionRef, rulesHash: v1.rulesHash });
    expect(hist.kind === "version" && hist.rules[0]!.rateMillis).toBe(30_000);
    const now = await inForce(a, ref, "2026-07-01");
    expect(now).toMatchObject({ kind: "version", versionRef: v2.versionRef });
    expect(now.kind === "version" && now.rules[0]!.rateMillis).toBe(32_000);
  }, 60_000);

  it("does not apply a future version early, returns nothing in a gap, and refuses an overlapping approval (11, 12, 13)", async () => {
    const a = await company();
    const ref = await agreement(a);
    const v1 = await approved(a, ref, "2026-01-01", 30_000, "2026-03-01");
    const v2 = await approved(a, ref, "2026-05-01", 31_000);
    expect((await inForce(a, ref, "2026-04-15")).kind).toBe("none");                                // gap
    expect(await inForce(a, ref, "2026-02-28")).toMatchObject({ versionRef: v1.versionRef });
    const v3 = await approved(a, ref, "2027-01-01", 33_000);
    expect(await inForce(a, ref, "2026-12-31")).toMatchObject({ versionRef: v2.versionRef });      // future not early
    expect(await inForce(a, ref, "2027-01-01")).toMatchObject({ versionRef: v3.versionRef });
    // A version starting on or before an approved start is refused at proposal, and again at approval.
    expect((await refusal(() => propose(a, ref, "2026-05-01", 1))).code).toBe("BAD_REQUEST");
    expect((await refusal(() => propose(a, ref, "2026-04-01", 1))).code).toBe("BAD_REQUEST");
    const early = await propose(a, ref, "2027-06-01", 34_000);
    const sameStart = await propose(a, ref, "2027-06-01", 35_000);
    await callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: early.versionRef });
    expect((await refusal(() => callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: sameStart.versionRef }))).code).toBe("BAD_REQUEST");
    // Rows written around the application that overlap are reported, never resolved by picking one.
    const [[ag]] = await pool.query<mysql.RowDataPacket[]>("SELECT id, financialEntityId FROM compensationAgreements WHERE agreementRef = ?", [ref]);
    await pool.execute("INSERT INTO compensationAgreementVersions (versionRef, agreementId, financialEntityId, version, effectiveFrom, effectiveUntil, basis, currency, rulesHash, rulesJson, status, proposedByUserId, proposedAt) VALUES (?,?,?,99,'2026-01-15','2026-02-15','hourly','CAD',?,'{}','approved',1,NOW())", [`CAV-RAW-${rnd()}`, ag!.id, ag!.financialEntityId, "0".repeat(64)]);
    expect((await inForce(a, ref, "2026-02-01")).kind).toBe("integrity_error");
  }, 60_000);

  it("hashes the same rules the same way whatever order they are proposed in (16, 17)", async () => {
    const a = await company();
    const ref = await agreement(a);
    const rules = [REG(30_000), { earningCode: "LOAD_PAY", calculation: "quantity_times_rate" as const, unit: "load" as const, rateMillis: 35_000 }, { earningCode: "STANDBY", calculation: "hourly" as const, unit: "hour" as const, rateMillis: 20_000 }];
    const x = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "mixed", rules });
    const y = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "mixed", rules: [...rules].reverse() });
    const z = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "mixed", rules: [REG(30_001), rules[1]!, rules[2]!] });
    expect(x.rulesHash).toBe(y.rulesHash);
    expect(z.rulesHash).not.toBe(x.rulesHash);
    expect([x.version, y.version, z.version]).toEqual([1, 2, 3]);
  }, 60_000);
});

d("P1 — the earning-code catalogue is book-safe", () => {
  it("lets a book override a seed for itself only, and refuses editing the seed or another book's codes (18)", async () => {
    const a = await company(), b = await company();
    const [[seedBefore]] = await pool.query<mysql.RowDataPacket[]>("SELECT id, name FROM earningCodes WHERE codeKey = '*:REG'");
    const ov = await callerFor(a.admin).payrollCompensation.earningCodeCreate({ financialEntityId: a.entityId, code: "REG", name: "Regular (A's union scale)", calculationType: "hourly", countsTowardOvertime: true, activeFrom: "2026-01-01" });
    expect((await refusal(() => callerFor(a.admin).payrollCompensation.earningCodeCreate({ financialEntityId: a.entityId, code: "REG", name: "again", calculationType: "hourly", activeFrom: "2026-01-01" }))).code).toBe("CONFLICT");
    expect((await refusal(() => callerFor(a.admin).payrollCompensation.earningCodeCreate({ financialEntityId: b.entityId, code: "REG", name: "into B", calculationType: "hourly", activeFrom: "2026-01-01" }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(b.admin).payrollCompensation.earningCodeRetire({ codeRef: ov.codeRef!, activeUntil: "2026-06-01" }))).code).toBe("NOT_FOUND");
    expect((await refusal(() => callerFor(a.admin).payrollCompensation.earningCodeRetire({ codeRef: "EC-SEED-REG", activeUntil: "2026-06-01" }))).code).toBe("FORBIDDEN");
    const [[seedAfter]] = await pool.query<mysql.RowDataPacket[]>("SELECT id, name, retiredAt FROM earningCodes WHERE codeKey = '*:REG'");
    expect(seedAfter).toMatchObject({ id: seedBefore!.id, name: seedBefore!.name, retiredAt: null });
    expect((await callerFor(b.admin).payrollCompensation.earningCodesList()).filter(r => r.code === "REG").map(r => r.scope)).toEqual(["shared"]);
    expect((await callerFor(a.admin).payrollCompensation.earningCodesList()).filter(r => r.code === "REG").map(r => r.scope).sort()).toEqual(["book", "shared"]);
    // A's version uses A's override; B's uses the seed.
    const ra = await agreement(a), rb = await agreement(b);
    await propose(a, ra, "2026-01-01", 30_000); await propose(b, rb, "2026-01-01", 30_000);
    const [[[ruleA]], [[ruleB]]] = await Promise.all([ra, rb].map(r => pool.query<mysql.RowDataPacket[]>("SELECT r.earningCodeId FROM compensationEarningRules r JOIN compensationAgreementVersions v ON v.id = r.versionId JOIN compensationAgreements g ON g.id = v.agreementId WHERE g.agreementRef = ?", [r])));
    const [[ovRow]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM earningCodes WHERE codeRef = ?", [ov.codeRef]);
    expect(ruleA!.earningCodeId).toBe(ovRow!.id);
    expect(ruleB!.earningCodeId).toBe(seedBefore!.id);
  }, 60_000);

  it("retiring a code stops new proposals and leaves approved versions exactly as they were (19)", async () => {
    const a = await company();
    const haul = await callerFor(a.controller).payrollCompensation.earningCodeCreate({ financialEntityId: a.entityId, code: "HAUL_BONUS", name: "Haul bonus", calculationType: "flat", activeFrom: "2026-01-01" });
    const ref = await agreement(a);
    const v = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "mixed", rules: [REG(30_000), { earningCode: "HAUL_BONUS", calculation: "flat", unit: "each", rateMillis: 50_000 }] });
    await callerFor(a.controller).payrollCompensation.versionApprove({ versionRef: v.versionRef });
    await callerFor(a.admin).payrollCompensation.earningCodeRetire({ codeRef: haul.codeRef!, activeUntil: "2026-06-01" });
    const got = await callerFor(a.admin).payrollCompensation.agreementGet({ agreementRef: ref });
    const kept = got.versions.find(x => x.versionRef === v.versionRef)!;
    expect(kept.rulesHash).toBe(v.rulesHash);
    expect(kept.rules.map(r => r.earningCode).sort()).toEqual(["HAUL_BONUS", "REG"]);
    const r = await refusal(() => callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-07-01", basis: "mixed", rules: [REG(31_000), { earningCode: "HAUL_BONUS", calculation: "flat", unit: "each", rateMillis: 50_000 }] }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/not active for this book on 2026-07-01/);
    // Retirement is from a date: a version effective before it may still use the code.
    const early = await callerFor(a.admin).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-03-01", effectiveUntil: "2026-05-01", basis: "mixed", rules: [REG(30_500), { earningCode: "HAUL_BONUS", calculation: "flat", unit: "each", rateMillis: 50_000 }] });
    expect(early.status).toBe("proposed");
    expect((await inForce(a, ref, "2026-08-01"))).toMatchObject({ kind: "version", versionRef: v.versionRef, rulesHash: v.rulesHash });
  }, 60_000);
});

d("P1 — who may see and set compensation", () => {
  it("refuses dispatch, a driver, a mechanic, management and the bookkeeper every compensation procedure (20, 21)", async () => {
    const a = await company();
    const ref = await agreement(a);
    for (const role of ["dispatcher", "driver", "mechanic", "management", "bookkeeper", "auditor"]) {
      const c = callerFor(await member(a.orgRef, [role]));
      for (const call of [
        () => c.payrollCompensation.agreementsList(),
        () => c.payrollCompensation.agreementGet({ agreementRef: ref }),
        () => c.payrollCompensation.versionInForce({ agreementRef: ref, workDate: "2026-02-01" }),
        () => c.payrollCompensation.earningCodesList(),
        () => c.payrollCompensation.profileClassification({ employeePayrollProfileId: a.profileId }),
        () => c.payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-02-01", basis: "hourly", rules: [REG(1)] }),
      ]) expect((await refusal(call)).code, role).toBe("FORBIDDEN");
    }
    // The worker on the same job as a coworker reads neither their own nor anyone's agreement through this surface.
    expect((await refusal(() => callerFor(a.worker).payrollCompensation.agreementGet({ agreementRef: ref }))).code).toBe("FORBIDDEN");
    // HR reads and proposes; HR does not approve.
    expect((await callerFor(a.hr).payrollCompensation.agreementGet({ agreementRef: ref })).agreement.agreementRef).toBe(ref);
    const v = await callerFor(a.hr).payrollCompensation.versionPropose({ agreementRef: ref, effectiveFrom: "2026-01-01", basis: "hourly", rules: [REG(30_000)] });
    expect((await refusal(() => callerFor(a.hr).payrollCompensation.versionApprove({ versionRef: v.versionRef }))).code).toBe("FORBIDDEN");
  }, 90_000);
});

d("P1 — the legacy payRates path is untouched (D3)", () => {
  it("keeps legacy rates readable and calculable, and creates or supersedes none of them (22)", async () => {
    const a = await company();
    const rateKey = `REG-${rnd()}`;
    await callerFor(a.controller).payroll.rateCreate({ rateKey, earningType: "REG", calculation: "hourly", rate: 30, unit: "hour", effectiveFrom: new Date("2026-01-01"), employeePayrollProfileId: a.profileId });
    const [[n0]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM payRates");
    const ref = await agreement(a);
    await approved(a, ref, "2026-01-01", 45_000);
    const [[n1]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM payRates");
    expect(Number(n1!.n)).toBe(Number(n0!.n));
    const [[legacy]] = await pool.query<mysql.RowDataPacket[]>("SELECT version, effectiveUntil, rateMillis FROM payRates WHERE rateKey = ?", [rateKey]);
    expect(legacy).toMatchObject({ version: 1, effectiveUntil: null, rateMillis: 30_000 });
    expect((await callerFor(a.admin).payroll.ratesList()).some(r => r.rateKey === rateKey)).toBe(true);
    // The legacy earning path still prices from payRates, not from the agreement.
    const periodId = (await callerFor(a.admin).payroll.periodOpen({ periodRef: `PP-${rnd()}`, financialEntityId: a.entityId, startsOn: new Date("2026-09-01"), endsOn: new Date("2026-09-15") })).id as number;
    const e = await callerFor(a.admin).payroll.earningPropose({ earningRef: `ERN-${rnd()}`, employeePayrollProfileId: a.profileId, payPeriodId: periodId, earningType: "REG", source: "approved_timesheet", quantity: 2, unit: "hour", workedOn: new Date("2026-09-03"), evidenceRefs: ["TS-1"] });
    expect(e).toMatchObject({ status: "calculated", calculatedAmount: 60, rateKeyVersion: `${rateKey}-v1` });
  }, 60_000);
});
