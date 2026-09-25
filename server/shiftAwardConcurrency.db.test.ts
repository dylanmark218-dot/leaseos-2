/**
 * 0206 — Checkpoint 3: two awards, one slot, one survivor — against a real database.
 *
 * `decideAward` being right is necessary and not sufficient; the guarantee lives in the
 * transaction. The marketplace award enters the binding's own lock (posting first, then role) and
 * the post's lock after, so two dispatchers awarding two people to one slot in the same moment
 * serialise: the second sees a filled post, or a changed head token, and is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { STARTS, ENDS } from "./boardFixtures";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 17_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 8 }); });
afterAll(async () => { await pool?.end(); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const key = (p: string) => `${p}-${Date.now().toString(36)}-${rnd()}`;
const rows = async (sql: string, p: unknown[] = []) => (await pool.query<mysql.RowDataPacket[]>(sql, p))[0];
type Finding = { code: string; overrideClass: string; overrideAuthority?: string };

async function establishedOperator(manager: number) {
  const driverUser = await withRole("driver");
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser, `Op ${rnd()}`]);
  const operatorId = Number(op.insertId);
  await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'medical_fitness', 'Medical', NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [operatorId]);
  await pool.execute("INSERT INTO hosAttestations (operatorId, dutyDate, method, statement, hoursAvailableMinutesStated, attestedByUserId) VALUES (?, UTC_DATE(), 'paper_log_reviewed', 'Reviewed the paper log for today', 600, ?)", [operatorId, manager]);
  return { driverUser, operatorId };
}

async function scene() {
  const dispatcher = await withRole("dispatcher");
  const manager = await withRole("management");
  const one = await establishedOperator(manager);
  const two = await establishedOperator(manager);
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key("U").slice(0, 30)]);
  const unitId = Number(u.insertId);
  for (const t of ["cvip_certificate", "vehicle_registration", "insurance_proof"]) {
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('unit', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [unitId, t, t]);
  }
  const [insr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role, status) VALUES (?, ?, 'insurer', 'active')", [key("PRV").slice(0, 40), key("Ins").slice(0, 60)]);
  const [pol] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insurancePolicies (policyRef, financialEntityId, insurerId, policyType, policyNumber, effectiveAt, expiresAt, status, coverageVerificationStatus) VALUES (?, 1, ?, 'commercial_auto', ?, DATE_SUB(NOW(), INTERVAL 60 DAY), DATE_ADD(NOW(), INTERVAL 300 DAY), 'active', 'coverage_verified')", [key("POL").slice(0, 40), Number(insr.insertId), key("PN").slice(0, 40)]);
  const policyId = Number(pol.insertId);
  await pool.execute("INSERT INTO insurancePolicyCoverages (insurancePolicyId, coverageType, limitAmount, additionalInsuredEndorsement) VALUES (?, 'commercial_auto', 5000000, 1)", [policyId]);
  await pool.execute("INSERT INTO insuranceCoveredEntities (insurancePolicyId, entityType, entityId, coveredFrom) VALUES (?, 'unit', ?, DATE_SUB(NOW(), INTERVAL 60 DAY))", [policyId, unitId]);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', ?, 'LSD 04-12-052-09W5', 'dispatched', 0)", [key("JOB").slice(0, 40), key("Cust").slice(0, 40)]);
  const jobId = Number(j.insertId);
  const posting = await caller(dispatcher).dispatch.createPosting({ jobId, roles: [{ roleCode: "PRIMARY_UNIT" }] });
  const roleId = posting.roleIds[0]!;
  const approvalRef = key("RA").slice(0, 60);
  await pool.execute("INSERT INTO routeApprovals (approvalRef, jobId, unitId, originRef, destinationRef, dispatchStatus, segmentIdsJson, fingerprintJson, fingerprintHash, explanation, status, approvedByUserId) VALUES (?, ?, ?, 'yard', 'lease', 'clear', '[]', '{}', ?, 'Approved local route', 'approved', ?)", [approvalRef, jobId, unitId, "c".repeat(64), manager]);
  const post = await caller(dispatcher).shifts.post({ title: `Water haul ${rnd()}`, startsAt: STARTS, endsAt: ENDS, requiredRole: "driver", unitId });
  await caller(dispatcher).shifts.link({ postRef: post.postRef, roleId });
  const subject = (operatorId: number) => ({ operatorId, unitId, trailerId: null, jobId, routeApprovalRef: approvalRef, postingId: posting.postingId, roleId });
  return { dispatcher, manager, one, two, unitId, roleId, postRef: post.postRef, subject };
}

async function acknowledgedCheck(s: Awaited<ReturnType<typeof scene>>, operatorId: number) {
  const c = await caller(s.dispatcher).dispatch.evaluate(s.subject(operatorId));
  for (const b of (c.blockers as unknown as Finding[]).filter(x => x.overrideClass === "WARNING_ONLY")) {
    await caller(s.dispatcher).dispatch.overrideRequest({ checkId: c.checkId, blockerCode: b.code, reason: `Reviewed and accepted — ${b.code}` });
    const granter = b.overrideAuthority === "administrator" ? await withRole("controller") : s.manager;
    await caller(granter).dispatch.overrideGrant({ checkId: c.checkId, blockerCode: b.code, reason: `Acknowledged on record — ${b.code}` });
  }
  return c.checkId;
}

d("award race", () => {
  it("two awards for one slot in the same moment: exactly one binds, the other is refused, and the loser's offer is not selected", async () => {
    const s = await scene();
    const c1 = await acknowledgedCheck(s, s.one.operatorId);
    const c2 = await acknowledgedCheck(s, s.two.operatorId);
    const o1 = await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.one.driverUser });
    const o2 = await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.two.driverUser });
    await caller(s.one.driverUser).shifts.offerRespond({ offerRef: o1.offerRef, decision: "accepted" });
    await caller(s.two.driverUser).shifts.offerRespond({ offerRef: o2.offerRef, decision: "accepted" });

    const attempts = await Promise.allSettled([
      caller(s.dispatcher).shifts.award({ postRef: s.postRef, userId: s.one.driverUser, unitId: s.unitId, trailerId: null, checkId: c1, expectedLastEventId: null, reason: null }),
      caller(s.dispatcher).shifts.award({ postRef: s.postRef, userId: s.two.driverUser, unitId: s.unitId, trailerId: null, checkId: c2, expectedLastEventId: null, reason: null }),
    ]);
    const won = attempts.filter(r => r.status === "fulfilled" && (r.value as { ok: boolean }).ok);
    const lost = attempts.filter(r => !(r.status === "fulfilled" && (r.value as { ok: boolean }).ok));
    expect(won, JSON.stringify(attempts)).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser was refused by the post (filled) or by the binding's head token — never bound.
    const l = lost[0]!;
    if (l.status === "fulfilled") expect((l.value as { code: string }).code).toBe("post_not_awardable");
    else expect((l.reason as { code: string }).code).toBe("CONFLICT");

    const role = (await rows("SELECT assignedOperatorId FROM dispatchRoles WHERE id = ?", [s.roleId]))[0]!;
    expect([s.one.operatorId, s.two.operatorId]).toContain(Number(role.assignedOperatorId));
    expect(await rows("SELECT id FROM dispatchRoleAssignmentEvents WHERE roleId = ?", [s.roleId])).toHaveLength(1);
    const offers = await rows("SELECT userId, status FROM shiftOffers WHERE postRef = ? ORDER BY id", [s.postRef]);
    expect(offers.map(o => o.status).sort()).toEqual(["awarded", "not_selected"]);
    expect((await rows("SELECT status FROM shiftPosts WHERE postRef = ?", [s.postRef]))[0]!.status).toBe("filled");
    expect(await rows("SELECT id FROM shiftPostEvents WHERE postRef = ? AND eventType = 'awarded'", [s.postRef])).toHaveLength(1);
  }, 30_000);
});
