/**
 * 0183 — Checkpoint 3: the marketplace award, against a real database.
 *
 * The award binds the slot through the canonical binding behind the dispatcher's stored check.
 * These prove: a blocked or unknown readiness refuses; a check the recompute disagrees with
 * refuses; a check for another subject refuses; a cancelled or unlinked post refuses; the winner's
 * offer is awarded and the others not selected; the event and the outbox row commit with the
 * binding; the job room exists with the dispatcher and the operator in it; and another
 * organization's dispatcher finds nothing to award.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { callerFor as orgCaller, member, org, postWork as postWorkIn, STARTS, ENDS } from "./boardFixtures";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 16_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const key = (p: string) => `${p}-${Date.now().toString(36)}-${rnd()}`;
const rows = async (sql: string, p: unknown[] = []) => (await pool.query<mysql.RowDataPacket[]>(sql, p))[0];

type Finding = { code: string; overrideClass: string; overrideAuthority?: string; dispatchEffect: string };

/** An operator whose own prerequisites are established: licence, medical, today's HOS attestation. */
async function establishedOperator(manager: number) {
  const driverUser = await withRole("driver");
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'C. One', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const operatorId = Number(op.insertId);
  await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'medical_fitness', 'Medical', NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [operatorId]);
  await pool.execute("INSERT INTO hosAttestations (operatorId, dutyDate, method, statement, hoursAvailableMinutesStated, attestedByUserId) VALUES (?, UTC_DATE(), 'paper_log_reviewed', 'Reviewed the paper log for today', 600, ?)", [operatorId, manager]);
  return { driverUser, operatorId };
}

/**
 * A subject whose every safety prerequisite is ESTABLISHED (the C1a baseline): an operator, a
 * unit with inspection, registration and verified insurance, a job with an approved route, and a
 * posting with one slot, linked to an open post. What remains is warning-grade only.
 */
async function establishedScene() {
  const dispatcher = await withRole("dispatcher");
  const manager = await withRole("management");
  const { driverUser, operatorId } = await establishedOperator(manager);
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
  const subject = { operatorId, unitId, trailerId: null, jobId, routeApprovalRef: approvalRef, postingId: posting.postingId, roleId };
  return { dispatcher, manager, driverUser, operatorId, unitId, jobId, postingId: posting.postingId, roleId, postRef: post.postRef, subject };
}
type Scene = Awaited<ReturnType<typeof establishedScene>>;

/** Acknowledge every WARNING_ONLY finding on a check: requested by the dispatcher, granted by the manager. */
async function acknowledgeWarnings(s: { dispatcher: number; manager: number }, checkId: number, blockers: Finding[]) {
  for (const b of blockers.filter(x => x.overrideClass === "WARNING_ONLY")) {
    await caller(s.dispatcher).dispatch.overrideRequest({ checkId, blockerCode: b.code, reason: `Reviewed and accepted — ${b.code}` });
    const granter = b.overrideAuthority === "administrator" ? await withRole("controller") : s.manager;
    const g = await caller(granter).dispatch.overrideGrant({ checkId, blockerCode: b.code, reason: `Acknowledged on record — ${b.code}` });
    expect(g.granted, b.code).toBe(true);
  }
}

/** A recorded, acknowledged check for the scene's subject and slot. */
async function acknowledgedCheck(s: Scene, over: Partial<Scene["subject"]> = {}) {
  const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, ...over });
  await acknowledgeWarnings(s, c.checkId, c.blockers as unknown as Finding[]);
  return c;
}

const award = (s: Scene, over: Record<string, unknown> = {}) =>
  caller(s.dispatcher).shifts.award({ postRef: s.postRef, userId: s.driverUser, unitId: s.unitId, trailerId: null, checkId: 0, expectedLastEventId: null, reason: null, ...over } as never);

d("the award binds the slot through the canonical binding", () => {
  it("awards an accepted offer: the slot is bound, the history has one event, the offer carries it, the post is filled, the outbox row and the job room exist", async () => {
    const s = await establishedScene();
    const c = await acknowledgedCheck(s);
    expect((c.blockers as unknown as Finding[]).filter(b => b.dispatchEffect === "BLOCK")).toEqual([]);
    const offer = await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    await caller(s.driverUser).shifts.offerRespond({ offerRef: offer.offerRef, decision: "accepted" });

    const a = await award(s, { checkId: c.checkId });
    expect(a.ok, (a as { refusals?: string[] }).refusals?.join(" | ")).toBe(true);
    if (!a.ok) return;
    expect(a.roleId).toBe(s.roleId);
    expect(a.staffing.state).toBe("staffed");

    const role = (await rows("SELECT assignedOperatorId, assignedUnitId, status FROM dispatchRoles WHERE id = ?", [s.roleId]))[0]!;
    expect(Number(role.assignedOperatorId)).toBe(s.operatorId);
    expect(Number(role.assignedUnitId)).toBe(s.unitId);
    expect(role.status).toBe("assigned");
    const events = await rows("SELECT id, eventType FROM dispatchRoleAssignmentEvents WHERE roleId = ?", [s.roleId]);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("assignment_created");
    expect(Number(events[0]!.id)).toBe(a.eventId);
    const o = (await rows("SELECT status, awardEventId FROM shiftOffers WHERE offerRef = ?", [offer.offerRef]))[0]!;
    expect(o.status).toBe("awarded");
    expect(Number(o.awardEventId)).toBe(a.eventId);
    const post = (await rows("SELECT status, filledByUserId FROM shiftPosts WHERE postRef = ?", [s.postRef]))[0]!;
    expect(post.status).toBe("filled");
    expect(Number(post.filledByUserId)).toBe(s.dispatcher);
    expect((await rows("SELECT eventType FROM shiftPostEvents WHERE postRef = ? AND eventType = 'awarded'", [s.postRef]))).toHaveLength(1);
    const out = await rows("SELECT eventType, payloadJson FROM domainEventOutbox WHERE aggregateType = 'shiftPost' AND aggregateId = ? AND eventType = 'work.awarded'", [s.postRef]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(String(out[0]!.payloadJson)).recipientUserIds).toEqual([s.driverUser]);

    // The job room: the dispatcher and the operator are in it; the operator can read it.
    expect(a.jobRoomChannelRef).toBeTruthy();
    const members = await caller(s.driverUser).board.members({ channelRef: a.jobRoomChannelRef! });
    expect(members.members.map(m => m.userId).sort()).toEqual([s.dispatcher, s.driverUser].sort());
    await expect(caller(s.driverUser).board.read({ channelRef: a.jobRoomChannelRef! })).resolves.toBeTruthy();

    // Nothing the dispatcher's own award writes: no booking, no assignment_approved, usedForAward untouched.
    expect((await rows("SELECT id FROM resourceBookings WHERE postingId = ?", [s.postingId]))).toHaveLength(0);
    expect(Number((await rows("SELECT usedForAward FROM dispatchEligibilityChecks WHERE id = ?", [c.checkId]))[0]!.usedForAward)).toBe(0);

    // A second award of a filled post is refused and recorded.
    const again = await award(s, { checkId: c.checkId, expectedLastEventId: a.lastEventId, reason: "retry" });
    expect(again).toMatchObject({ ok: false, code: "post_not_awardable" });
  });

  it("marks every other live offer not selected, and tells them", async () => {
    const s = await establishedScene();
    const other = await withRole("driver");
    const c = await acknowledgedCheck(s);
    await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    const loser = await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: other });
    const a = await award(s, { checkId: c.checkId, reason: "first to accept in the yard" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.notSelected).toEqual([other]);
    expect((await rows("SELECT status FROM shiftOffers WHERE offerRef = ?", [loser.offerRef]))[0]!.status).toBe("not_selected");
    const out = await rows("SELECT payloadJson FROM domainEventOutbox WHERE aggregateType = 'shiftPost' AND aggregateId = ? AND eventType = 'work.awarded'", [s.postRef]);
    expect(JSON.parse(String(out[0]!.payloadJson)).recipientUserIds.sort()).toEqual([s.driverUser, other].sort());
  });
});

d("readiness is the gate", () => {
  it("refuses a blocked check — a person with no documents — and records the refusal", async () => {
    const s = await establishedScene();
    const bare = await withRole("driver");
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name) VALUES (?, 'B. Bare')", [bare]);
    const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, operatorId: Number(op.insertId) });
    expect(c.verdict).toBe("blocked");
    await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: bare });
    const a = await award(s, { userId: bare, checkId: c.checkId });
    expect(a).toMatchObject({ ok: false, code: "readiness_refused" });
    expect((a as { refusals: string[] }).refusals.join(" ")).toMatch(/BLOCKED/);
    expect((await rows("SELECT status FROM dispatchRoles WHERE id = ?", [s.roleId]))[0]!.status).toBe("open");
    expect((await rows("SELECT detail FROM shiftPostEvents WHERE postRef = ? AND eventType = 'award_refused'", [s.postRef]))[0]!.detail).toContain("readiness_refused");
  });

  it("refuses an unknown finding nobody acknowledged — unknown never passes — and awards once it is acknowledged", async () => {
    const s = await establishedScene();
    const c = await caller(s.dispatcher).dispatch.evaluate(s.subject);
    // The established subject carries warning-grade findings only; unacknowledged, they are uncovered.
    expect((c.blockers as unknown as Finding[]).length).toBeGreaterThan(0);
    await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    const refused = await award(s, { checkId: c.checkId });
    expect(refused).toMatchObject({ ok: false, code: "readiness_refused" });
    await acknowledgeWarnings(s, c.checkId, c.blockers as unknown as Finding[]);
    const a = await award(s, { checkId: c.checkId });
    expect(a.ok, (a as { refusals?: string[] }).refusals?.join(" | ")).toBe(true);
  });

  it("refuses a check the recompute no longer agrees with", async () => {
    const s = await establishedScene();
    const c = await acknowledgedCheck(s);
    await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    // The world moved: a document governing the operator changed after the check.
    await pool.execute("UPDATE complianceDocuments SET expiresAt = DATE_ADD(NOW(), INTERVAL 10 DAY) WHERE ownerType = 'operator' AND ownerId = ? AND docType = 'medical_fitness'", [s.operatorId]);
    const a = await award(s, { checkId: c.checkId });
    expect(a).toMatchObject({ ok: false, code: "readiness_stale" });
  });

  it("refuses a check made for another subject or another slot", async () => {
    const s = await establishedScene();
    const otherScene = await establishedScene();
    const c = await acknowledgedCheck(otherScene);
    await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    const a = await award(s, { checkId: c.checkId });
    expect(a).toMatchObject({ ok: false, code: "check_subject_mismatch" });
    // A check for the right person on the wrong slot is a mismatch too.
    const wrongSlot = await caller(s.dispatcher).dispatch.evaluate({ ...otherScene.subject, operatorId: s.operatorId, unitId: s.unitId });
    expect(await award(s, { checkId: wrongSlot.checkId })).toMatchObject({ ok: false, code: "check_subject_mismatch" });
  });
});

d("the post and the offer are the gate too", () => {
  it("refuses an unlinked post and a cancelled post", async () => {
    const s = await establishedScene();
    const c = await acknowledgedCheck(s);
    const unlinked = await caller(s.dispatcher).shifts.post({ title: "no slot", startsAt: STARTS, endsAt: ENDS, requiredRole: "driver" });
    expect(await award(s, { postRef: unlinked.postRef, checkId: c.checkId })).toMatchObject({ ok: false, code: "post_unlinked" });
    await caller(s.dispatcher).shifts.cancel({ postRef: s.postRef, reason: "job cancelled" });
    expect(await award(s, { checkId: c.checkId })).toMatchObject({ ok: false, code: "post_not_awardable" });
  });

  it("refuses awarding over a declined offer, or with no offer, unless the dispatcher says why", async () => {
    const s = await establishedScene();
    const c = await acknowledgedCheck(s);
    expect(await award(s, { checkId: c.checkId })).toMatchObject({ ok: false, code: "no_offer" });
    const o = await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    await caller(s.driverUser).shifts.offerRespond({ offerRef: o.offerRef, decision: "declined" });
    expect(await award(s, { checkId: c.checkId })).toMatchObject({ ok: false, code: "offer_not_live" });
    const a = await award(s, { checkId: c.checkId, reason: "phoned and confirmed after declining by mistake" });
    expect(a.ok, (a as { refusals?: string[] }).refusals?.join(" | ")).toBe(true);
  });

  it("refuses a stale head token from the binding's own check, and records it", async () => {
    const s = await establishedScene();
    const c = await acknowledgedCheck(s);
    await caller(s.dispatcher).shifts.offer({ postRef: s.postRef, userId: s.driverUser });
    await expect(award(s, { checkId: c.checkId, expectedLastEventId: 999_999_999 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await rows("SELECT detail FROM shiftPostEvents WHERE postRef = ? AND eventType = 'award_refused'", [s.postRef]))[0]!.detail).toContain("CONFLICT");
    expect((await rows("SELECT status FROM shiftPosts WHERE postRef = ?", [s.postRef]))[0]!.status).toBe("open");
  });
});

d("the organization boundary", () => {
  it("finds nothing to award in another organization, and a foreign check is not found", async () => {
    const a = await org(pool), b = await org(pool);
    const dispA = await member(pool, a, ["dispatcher"]);
    const dispB = await member(pool, b, ["dispatcher"]);
    const drvA = await member(pool, a, ["driver"]);
    const p = await postWorkIn(dispA);
    await expect(orgCaller(dispB).shifts.award({ postRef: p.postRef, userId: drvA, unitId: null, trailerId: null, checkId: 1, expectedLastEventId: null, reason: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The single tenant's established check is not org A's to award with.
    const s = await establishedScene();
    const c = await acknowledgedCheck(s);
    expect(await orgCaller(dispA).shifts.award({ postRef: p.postRef, userId: drvA, unitId: null, trailerId: null, checkId: c.checkId, expectedLastEventId: null, reason: null })).toMatchObject({ ok: false, code: "post_unlinked" });
  });
});
