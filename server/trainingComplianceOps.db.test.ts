/**
 * 0174 — Training Compliance Hardening + Automatic Renewal Operations, through
 * the real routers and services on a migrated database. The numbers are the
 * checkpoint's required-test list (CHECKPOINT_0174_TRAINING_COMPLIANCE_HARDENING.md).
 * Pure rules are in _core/complianceOperations.test.ts and integrityHash.test.ts.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { loadExceptionSources } from "./surfacesService";
import { createRenewalSweepTicker, renewalQueueFor, runRenewalSweepForTenant, runScheduledRenewalSweep, slotKeyFor, RENEWAL_SWEEP_JOB } from "./renewalOperations";
import { tutorAnswer } from "./_core/studyTutor";
import { isSha256HexV1 } from "./_core/integrityHash";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 271_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const as = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
const future = (days: number, from = Date.now()) => new Date(from + days * 86_400_000);
async function db() { const x = await getDb(); if (!x) throw new Error("no db"); return x; }
async function verified(worker: number, verifier: number, code: string, expiresAt: Date | null, issuedAt = future(-900)) {
  const up = await as(worker).trainingWallet.recordOwn({ code, boundary: "external_provider", documentRef: `DOC-${rnd()}`, certificateNumber: `N-${rnd()}`, issuedAt, expiresAt });
  await as(verifier).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "Card sighted against issuer record", issuedAt, expiresAt });
  return up.holdingRef;
}
/** A distinct, isolated scheduler slot: an old minute nobody else uses, restricted to the test's organizations. */
const slotAt = () => new Date(Date.UTC(2019, 0, 1) + Math.floor(Math.random() * 500_000) * 60_000);
async function notices(like: string) {
  const [r] = await pool.execute<mysql.RowDataPacket[]>("SELECT notificationKey k FROM workflowNotifications WHERE notificationKey LIKE ?", [like]);
  return r.map(x => String(x.k));
}

d("tenant isolation", () => {
  it("1. the Exception Centre reads each organization's wallet items at the query; B never sees A's", async () => {
    const A = await org(), B = await org();
    const workerA = await member(A, ["driver"]);
    const up = await as(workerA).trainingWallet.recordOwn({ code: "FIRST_AID", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-10), expiresAt: future(900) });
    const srcA = await loadExceptionSources({ tenantId: A });
    const srcB = await loadExceptionSources({ tenantId: B });
    expect(srcA.walletUnverified?.some(w => w.holdingRef === up.holdingRef)).toBe(true);
    expect(srcB.walletUnverified?.some(w => w.holdingRef === up.holdingRef)).toBe(false);
    // Through the router too: a safety user in B does not see A's item.
    const safetyB = await member(B, ["safety"]);
    const exB = await as(safetyB).surfaces.exceptions({ category: "workforce", limit: 500 });
    expect(exB.items.some(x => x.key.includes(up.holdingRef))).toBe(false);
  }, 60_000);

  it("2. readiness.forTime / forShift and shifts.eligibility answer 'not found' for a guessed user id from another organization", async () => {
    const A = await org(), B = await org();
    const dispatcherA = await member(A, ["dispatcher"]), workerB = await member(B, ["driver"]), workerA = await member(A, ["driver"]);
    await expect(as(dispatcherA).readiness.forTime({ startsAt: future(1), userId: workerB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const postRef = `POST-${rnd()}`;
    await pool.execute("INSERT INTO shiftPosts (postRef, tenantId, title, startsAt, endsAt, requiredRole, requiredQualificationsJson, postedByUserId, postedAt) VALUES (?,?,?,?,?,'driver','[]',?,NOW())", [postRef, A, "Night haul", future(2), future(2.4), dispatcherA]);
    await expect(as(dispatcherA).readiness.forShift({ postRef, userId: workerB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(dispatcherA).shifts.eligibility({ postRef, userId: workerB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The same calls for a person in the caller's organization still answer.
    await expect(as(dispatcherA).readiness.forTime({ startsAt: future(1), userId: workerA })).resolves.toBeTruthy();
    await expect(as(dispatcherA).shifts.eligibility({ postRef, userId: workerA })).resolves.toBeTruthy();
  }, 60_000);

  it("3. every Exception Centre source is classified for tenancy", async () => {
    const { EXCEPTION_SOURCE_TENANCY } = await import("./_core/exceptionCentre");
    const kinds = new Set(Object.values(EXCEPTION_SOURCE_TENANCY).map(t => t.kind));
    for (const k of Array.from(kinds)) expect(["user_scoped", "org_scoped", "single_tenant_by_contract", "global_reference", "global_admin"]).toContain(k);
  });
});

d("automatic renewal sweep", () => {
  it("4. the scheduled sweep runs from the worker's heartbeat (one ticker, no second scheduler) and records the run", async () => {
    const worker = readFileSync(new URL("./_core/productionWorker.ts", import.meta.url), "utf8");
    expect(worker).toMatch(/createRenewalSweepTicker\(/);
    expect(worker).toMatch(/ports\.heartbeat = async/);
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]);
    const at = slotAt();
    await verified(w, s, "H2S_ALIVE", future(20, at.getTime()), future(-900, at.getTime()));
    const tick = createRenewalSweepTicker({ db: await db(), ownerId: `test-${rnd()}`, slotMinutes: 1, tenants: [A] });
    await tick(at);
    await tick(at); // same slot: nothing more
    const [runs] = await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM scheduledJobRuns WHERE slotKey = ?", [slotKeyFor(RENEWAL_SWEEP_JOB, at, 1)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", failureCount: 0 });
    expect(Number(runs[0]!.inspected)).toBeGreaterThanOrEqual(1);
    expect(Number(runs[0]!.actionable)).toBeGreaterThanOrEqual(1);
    expect(Number(runs[0]!.notificationsCreated)).toBeGreaterThanOrEqual(1);
    expect(runs[0]!.completedAt).toBeTruthy();
  }, 60_000);

  it("5. two instances racing for one slot: exactly one runs, and no notice is written twice", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]);
    const at = slotAt();
    const ref = await verified(w, s, "FIRST_AID", future(25, at.getTime()), future(-900, at.getTime()));
    const d1 = await db();
    const [r1, r2] = await Promise.all([
      runScheduledRenewalSweep(d1, { ownerId: "instance-1", now: at, slotMinutes: 1, tenants: [A] }),
      runScheduledRenewalSweep(d1, { ownerId: "instance-2", now: at, slotMinutes: 1, tenants: [A] }),
    ]);
    expect([r1.ran, r2.ran].filter(Boolean)).toHaveLength(1);
    const loser = r1.ran ? r2 : r1;
    expect(loser).toMatchObject({ ran: false });
    const keys = await notices(`cred-renew:${ref}:%`);
    expect(keys.length).toBe(new Set(keys).size);
    expect(keys.length).toBeGreaterThan(0);
    // 6. idempotent: a later slot at the same moment's thresholds sends nothing new.
    const again = await runScheduledRenewalSweep(d1, { ownerId: "instance-1", now: new Date(at.getTime() + 61_000), slotMinutes: 1, tenants: [A] });
    expect(again).toMatchObject({ ran: true, status: "completed" });
    if (again.ran) expect(again.counts.notificationsCreated).toBe(0);
    expect(await notices(`cred-renew:${ref}:%`)).toHaveLength(keys.length);
  }, 60_000);

  it("7. a dead owner's expired lease is taken over by one instance; a live lease is not", async () => {
    const A = await org();
    const at = slotAt();
    const slotKey = slotKeyFor(RENEWAL_SWEEP_JOB, at, 1);
    await pool.execute("INSERT INTO scheduledJobRuns (runRef, jobKey, slotKey, ownerId, status, startedAt, leaseUntil) VALUES (?,?,?,?, 'running', ?, ?)", [`RUN-${rnd()}`, RENEWAL_SWEEP_JOB, slotKey, "dead-instance", new Date(at.getTime() - 60_000), new Date(at.getTime() + 600_000)]);
    const live = await runScheduledRenewalSweep(await db(), { ownerId: "i2", now: at, slotMinutes: 1, tenants: [A] });
    expect(live).toMatchObject({ ran: false, reason: "slot_owned_elsewhere" });
    await pool.execute("UPDATE scheduledJobRuns SET leaseUntil = ? WHERE slotKey = ?", [new Date(at.getTime() - 1000), slotKey]);
    const taken = await runScheduledRenewalSweep(await db(), { ownerId: "i2", now: at, slotMinutes: 1, tenants: [A] });
    expect(taken).toMatchObject({ ran: true, status: "completed" });
    const done = await runScheduledRenewalSweep(await db(), { ownerId: "i3", now: at, slotMinutes: 1, tenants: [A] });
    expect(done).toMatchObject({ ran: false, reason: "slot_already_completed" });
  }, 60_000);

  it("8/9. the sweep covers Academy TDG certificates and wallet credentials; a company review is never called expired; Q gets nothing", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]);
    const now = new Date();
    const qualRef = `ACAD-QUAL-${rnd()}`;
    await pool.execute("INSERT INTO academyQualifications (qualificationRef, userId, qualificationCode, sourceKind, status, validFrom, expiresAt) VALUES (?,?,'TDG_ROAD','academy_certificate','current',?,?)", [qualRef, w, future(-1080), future(5)]);
    const wallet = await verified(w, s, "H2S_ALIVE", future(20));
    const q = await as(w).trainingWallet.recordOwn({ code: "AIR_BRAKE_Q", boundary: "regulator_issued", documentRef: `DOC-${rnd()}`, issuedAt: future(-2000) });
    await as(s).trainingWallet.verify({ holdingRef: q.holdingRef, method: "original_sighted", verificationSource: "Licence sighted with Q endorsement", issuedAt: future(-2000), expiresAt: null });
    const whmis = await as(s).trainingWallet.recordFor({ userId: w, code: "WHMIS_EMPLOYER", boundary: "employer_issued", evidenceKind: "issuer_record", documentRef: `DOC-${rnd()}`, issuedAt: future(-370) });
    const s2 = await member(A, ["safety"]);
    await as(s2).trainingWallet.verify({ holdingRef: whmis.holdingRef, method: "issuer_confirmation", verificationSource: "Company training record", issuedAt: future(-370), expiresAt: null });
    await as(s).trainingWallet.settingsSet({ thresholds: [30, 14, 7], perCode: { WHMIS_EMPLOYER: { employerReviewMonths: 12 } } });
    const r = await runRenewalSweepForTenant(await db(), A, now, null);
    expect(r.failures).toEqual([]);
    expect(r.sentKeys.filter(k => k.startsWith(`cred-renew:${qualRef}:`))).not.toEqual([]);
    expect(r.sentKeys.some(k => k.startsWith(`cred-renew:${wallet}:`))).toBe(true);
    expect(r.sentKeys.some(k => k.startsWith(`cred-renew:${q.holdingRef}:`))).toBe(false);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT title, body FROM workflowNotifications WHERE notificationKey LIKE ?", [`cred-renew:${whmis.holdingRef}:%`]);
    expect(rows.length).toBeGreaterThan(0);
    for (const n of rows) expect(`${n.title} ${n.body}`).not.toMatch(/\bexpired\b|\bexpires\b/i);
    const queue = await renewalQueueFor(await db(), A, now);
    expect(queue.find(x => x.holdingRef === qualRef)).toMatchObject({ source: "academy", targetKind: "legal_expiry" });
    expect(queue.find(x => x.code === "WHMIS_EMPLOYER")).toMatchObject({ targetKind: "company_review" });
    expect(queue.find(x => x.holdingRef === wallet)!.lastReminder).toBeTruthy();
    expect(queue.find(x => x.holdingRef === wallet)!.nextEscalation).toBeTruthy();
    expect(queue.some(x => x.code === "AIR_BRAKE_Q")).toBe(false);
  }, 90_000);

  it("10. an injected failure is a visible SYSTEM FAILURE exception and changes no credential", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]);
    const ref = await verified(w, s, "H2S_ALIVE", future(10));
    const [before] = await pool.execute<mysql.RowDataPacket[]>("SELECT verificationState, expiresAt FROM workerQualifications WHERE holdingRef = ?", [ref]);
    const now = new Date();
    const r = await runScheduledRenewalSweep(await db(), { ownerId: "fault-test", now: new Date(Math.floor(now.getTime() / 60_000) * 60_000 - Math.floor(Math.random() * 1000) * 60_000), slotMinutes: 1, tenants: [A], faults: { failNotificationWrite: true } });
    expect(r).toMatchObject({ ran: true, status: "partial" });
    const [after] = await pool.execute<mysql.RowDataPacket[]>("SELECT verificationState, expiresAt FROM workerQualifications WHERE holdingRef = ?", [ref]);
    expect(after).toEqual(before);
    expect(await notices(`cred-renew:${ref}:%`)).toEqual([]);
    const src = await loadExceptionSources({ tenantId: A });
    const failure = src.trainingSweepFailures?.find(f => f.tenantId === A && f.failureKind === "NOTIFICATION_WRITE_FAILED");
    expect(failure).toBeTruthy();
    const ex = await as(s).surfaces.exceptions({ category: "workforce", limit: 500 });
    const item = ex.items.find(x => x.key.startsWith(`sweep-failure:${failure!.runRef}`));
    expect(item?.title).toMatch(/^SYSTEM FAILURE/);
    expect(item?.reason).toMatch(/says nothing about whether the credential is valid/);
    // The dispatch answer is still the canonical rule's: held, not "failed".
    const dispatcher = await member(A, ["dispatcher"]);
    expect((await as(dispatcher).trainingWallet.operationalView({ userId: w, codes: ["H2S_ALIVE"] })).results[0]!.state).toBe("held");
    // Another organization does not see A's failure.
    const B = await org(); const sB = await member(B, ["safety"]);
    expect((await as(sB).surfaces.exceptions({ category: "workforce", limit: 500 })).items.some(x => x.key.startsWith(`sweep-failure:${failure!.runRef}`))).toBe(false);
  }, 60_000);

  it("11. a company escalation ladder is validated, stored per category and used by the sweep", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]);
    await expect(as(s).trainingWallet.settingsSet({ thresholds: [30], escalation: { safety_ticket: { steps: [{ threshold: 45, recipients: ["safety"], urgency: "notice" }] } } })).rejects.toThrow(/employee is told/);
    await as(s).trainingWallet.settingsSet({ thresholds: [30], escalation: { safety_ticket: { steps: [{ threshold: 45, recipients: ["employee", "safety"], urgency: "notice" }, { threshold: "expired", recipients: ["employee", "safety"], urgency: "exception" }] } } });
    const got = await as(s).trainingWallet.settingsGet();
    expect(got.escalation.safety_ticket?.steps[0]).toMatchObject({ threshold: 45 });
    expect(got.notice).toMatch(/company policy/);
    const ref = await verified(w, s, "H2S_ALIVE", future(40));
    const r = await runRenewalSweepForTenant(await db(), A, new Date(), null);
    expect(r.sentKeys).toEqual(expect.arrayContaining([`cred-renew:${ref}:legal_expiry:45:u${w}`, `cred-renew:${ref}:legal_expiry:45:r:safety`]));
    const again = await runRenewalSweepForTenant(await db(), A, new Date(), null);
    expect(again.sentKeys.filter(k => k.includes(ref))).toEqual([]);
  }, 60_000);
});

d("credential verification", () => {
  it("12. the queue shows what a verifier needs, scoped to the organization", async () => {
    const A = await org(), B = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]), sB = await member(B, ["safety"]);
    const old = await verified(w, s, "FIRST_AID", future(20));
    const up = await as(w).trainingWallet.recordOwn({ code: "FIRST_AID", boundary: "external_provider", issuer: "Red Cross", certificateNumber: "FA-9", documentRef: `DOC-${rnd()}`, issuedAt: future(-1), expiresAt: future(1000) });
    const q = await as(s).trainingWallet.verificationQueue();
    const item = q.find(x => x.holdingRef === up.holdingRef)!;
    expect(item).toMatchObject({ employee: { userId: w }, code: "FIRST_AID", issuer: "Red Cross", certificateNumber: "FA-9", previousVerified: { holdingRef: old }, callerMayAct: true });
    expect(item.implications.heldIfVerified).toBe(true);
    expect((await as(sB).trainingWallet.verificationQueue()).some(x => x.holdingRef === up.holdingRef)).toBe(false);
  }, 60_000);

  it("13. no self-verification, no dispatcher verification, no cross-tenant verification", async () => {
    const A = await org(), B = await org();
    const w = await member(A, ["driver", "safety"]), dispatcher = await member(A, ["dispatcher"]), sB = await member(B, ["safety"]);
    const up = await as(w).trainingWallet.recordOwn({ code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-1), expiresAt: future(1000) });
    const input = { holdingRef: up.holdingRef, method: "document_inspection" as const, verificationSource: "Card", issuedAt: future(-1), expiresAt: future(1000) };
    await expect(as(w).trainingWallet.verify(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(dispatcher).trainingWallet.verify(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(dispatcher).trainingWallet.verificationQueue()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(sB).trainingWallet.verify(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(sB).trainingWallet.requestCorrection({ holdingRef: up.holdingRef, note: "Expiry date unreadable on the card" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(w).trainingWallet.requestCorrection({ holdingRef: up.holdingRef, note: "Expiry date unreadable on the card" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("14. a verifier cannot edit the evidence into validity; a correction is a new record the employee submits", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]), s2 = await member(A, ["safety"]), dispatcher = await member(A, ["dispatcher"]);
    const up = await as(w).trainingWallet.recordOwn({ code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-1), expiresAt: future(-5) });
    // The document shows a later expiry than was uploaded: that is a correction, not an edit.
    await expect(as(s).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "Card", issuedAt: future(-1), expiresAt: future(1000) })).rejects.toThrow(/request a correction/);
    await as(s).trainingWallet.requestCorrection({ holdingRef: up.holdingRef, note: "The card shows a 2029 expiry; re-enter it as printed" });
    await expect(as(s2).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "Card", issuedAt: future(-1), expiresAt: future(-5) })).rejects.toThrow(/correction was requested/);
    expect(await notices(`wallet-correction:${up.holdingRef}`)).toHaveLength(1);
    const mine = await as(w).trainingWallet.myWallet();
    expect(mine.credentials.find(c => c.holdingRef === up.holdingRef)!.correction).toBeTruthy();
    const fixed = await as(w).trainingWallet.submitCorrection({ correctsHoldingRef: up.holdingRef, code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-1), expiresAt: future(1000) });
    expect(fixed.verificationState).toBe("unverified");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT holdingRef, verificationState, correctsHoldingRef FROM workerQualifications WHERE holdingRef IN (?,?)", [up.holdingRef, fixed.holdingRef]);
    expect(rows.find(r => r.holdingRef === up.holdingRef)!.verificationState).toBe("rejected");
    expect(rows.find(r => r.holdingRef === fixed.holdingRef)!.correctsHoldingRef).toBe(up.holdingRef);
    // Still not held until verified.
    expect((await as(dispatcher).trainingWallet.operationalView({ userId: w, codes: ["H2S_ALIVE"] })).results[0]!.state).not.toBe("held");
    await as(s2).trainingWallet.verify({ holdingRef: fixed.holdingRef, method: "document_inspection", verificationSource: "Card", issuedAt: future(-1), expiresAt: future(1000) });
    expect((await as(dispatcher).trainingWallet.operationalView({ userId: w, codes: ["H2S_ALIVE"] })).results[0]!.state).toBe("held");
    // Nobody else may submit the correction for them.
    await expect(as(s).trainingWallet.submitCorrection({ correctsHoldingRef: up.holdingRef, code: "H2S_ALIVE", boundary: "external_provider", documentRef: "X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});

d("handoff → certificate closure", () => {
  it("15/16/17. BOOKED → TRAINING_COMPLETED → DOCUMENT_UPLOADED_UNVERIFIED → VERIFIED → ACTIVE; the upload links itself; handoff status never satisfies readiness", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]), s2 = await member(A, ["safety"]), dispatcher = await member(A, ["dispatcher"]);
    const old = await verified(w, s, "H2S_ALIVE", future(-3));
    const view = async () => (await as(dispatcher).trainingWallet.operationalView({ userId: w, codes: ["H2S_ALIVE"] })).results[0]!;
    const h = await as(w).trainingWallet.requestTraining({ qualificationCode: "H2S_ALIVE" });
    expect(await view()).toMatchObject({ state: "expired", renewalProgress: "Renewal requested — awaiting booking" });
    const wallet = await as(w).trainingWallet.myWallet();
    const exp = wallet.expiring.find(e => e.code === "H2S_ALIVE")!;
    expect(exp).toMatchObject({ walletStatus: "EXPIRED", renewalStatus: "RENEWAL_REQUESTED" });
    expect(exp.validityNote).toMatch(/does not extend/);
    await as(s).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "contacted" });
    await as(s).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "booked", appointmentAt: future(2) });
    expect((await view()).state).toBe("expired");
    await as(w).trainingWallet.handoffSelfUpdate({ handoffRef: h.handoffRef, to: "TRAINING_COMPLETED" });
    expect((await view()).state).toBe("expired");
    // Completion did not create a credential.
    const [none] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) c FROM workerQualifications WHERE userId = ? AND handoffRef = ?", [w, h.handoffRef]);
    expect(Number(none[0]!.c)).toBe(0);
    // Uploaded without naming the request — it links to the one open request waiting for a certificate.
    const up = await as(w).trainingWallet.recordOwn({ code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-1), expiresAt: future(1094) });
    expect((await as(w).trainingWallet.myHandoffs()).find(x => x.handoffRef === h.handoffRef)!.status).toBe("DOCUMENT_UPLOADED_UNVERIFIED");
    expect(await view()).toMatchObject({ state: "expired", renewalProgress: "Certificate uploaded — Safety verification required" });
    const res = await as(s2).trainingWallet.verify({ holdingRef: up.holdingRef, method: "issuer_registry_check", verificationSource: "ESC registry", issuedAt: future(-1), expiresAt: future(1094) });
    expect(res.handoff).toMatchObject({ handoffRef: h.handoffRef, status: "ACTIVE" });
    expect(res.superseded).toContain(old);
    const [hrow] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, linkedHoldingRef FROM externalTrainingHandoffs WHERE handoffRef = ?", [h.handoffRef]);
    expect(hrow[0]).toMatchObject({ status: "ACTIVE", linkedHoldingRef: up.holdingRef });
    const [cred] = await pool.execute<mysql.RowDataPacket[]>("SELECT handoffRef FROM workerQualifications WHERE holdingRef = ?", [up.holdingRef]);
    expect(cred[0]!.handoffRef).toBe(h.handoffRef);
    const [trail] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType FROM academyAuditEvents WHERE subjectRef = ? ORDER BY id", [h.handoffRef]);
    expect(trail.map(t => t.eventType)).toEqual(expect.arrayContaining(["handoff.document_uploaded_unverified", "handoff.verified", "handoff.active"]));
    expect(await view()).toMatchObject({ state: "held", renewalProgress: null });
  }, 90_000);
});

d("source review", () => {
  async function source(overrides: Record<string, unknown> = {}) {
    const sourceRef = `SRC-TEST-${rnd()}`;
    const row = { sourceRef, authority: "Transport Canada", title: `TDG Regulations ${sourceRef}`, jurisdiction: "CA", snapshotHash: "legacy-snapshot", sourceTier: "authority", sourceUrl: "https://tc.canada.ca/tdg", edition: "2024", reviewStatus: "unreviewed", ...overrides };
    const cols = Object.keys(row);
    await pool.execute(`INSERT INTO academySourceRecords (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, Object.values(row) as never[]);
    return sourceRef;
  }
  const note = "Checked edition and URL against the authority page";

  it("18/19. two people make a source trusted, audited; a decided source is immutable and cannot be deleted", async () => {
    const A = await org();
    const s1 = await member(A, ["safety"]), s2 = await member(A, ["safety"]), driver = await member(A, ["driver"]);
    const ref = await source();
    await expect(as(driver).academy.sourceAct({ sourceRef: ref, action: "REVIEW", note })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await as(s1).academy.sourceAct({ sourceRef: ref, action: "REVIEW", note })).reviewStatus).toBe("under_review");
    await expect(as(s1).academy.sourceAct({ sourceRef: ref, action: "APPROVE", note })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await as(s2).academy.sourceAct({ sourceRef: ref, action: "APPROVE", note })).reviewStatus).toBe("reviewed");
    const [trail] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType, actorUserId FROM academyAuditEvents WHERE subjectRef = ? ORDER BY id", [ref]);
    expect(trail.map(t => [t.eventType, Number(t.actorUserId)])).toEqual([["source.review", s1], ["source.approve", s2]]);
    await expect(pool.execute("UPDATE academySourceRecords SET edition = '2099' WHERE sourceRef = ?", [ref])).rejects.toThrow();
    await expect(pool.execute("DELETE FROM academySourceRecords WHERE sourceRef = ?", [ref])).rejects.toThrow();
    await expect(as(s2).academy.sourceAct({ sourceRef: ref, action: "REJECT", note })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const queue = await as(s1).academy.sourceReviewQueue();
    expect(queue.find(x => x.sourceRef === ref)).toMatchObject({ reviewStatus: "reviewed", impactStatus: "SOURCE_CURRENT", firstReviewedByUserId: s1, lastReviewedByUserId: s2, fingerprintKind: "legacy-stableHash" });
  }, 60_000);

  it("20/21/22. a new edition is a new source; supersession reports impact and rewrites nothing; unreviewed stays UNKNOWN in the tutor", async () => {
    const A = await org();
    const s1 = await member(A, ["safety"]), s2 = await member(A, ["safety"]), s3 = await member(A, ["management"]);
    const ref = await source();
    await as(s1).academy.sourceAct({ sourceRef: ref, action: "REVIEW", note });
    await as(s2).academy.sourceAct({ sourceRef: ref, action: "APPROVE", note });
    const [before] = await pool.execute<mysql.RowDataPacket[]>("SELECT authority, title, edition, sourceUrl, snapshotHash FROM academySourceRecords WHERE sourceRef = ?", [ref]);
    const next = await as(s1).academy.sourceProposeVersion({ supersedesSourceRef: ref, edition: "2026", sourceUrl: "https://tc.canada.ca/tdg-2026", retrievedAt: new Date(), note: "Transport Canada published the 2026 consolidation" });
    expect(next).toMatchObject({ reviewStatus: "unreviewed" });
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT snapshotHash, supersedesSourceRef, proposedByUserId FROM academySourceRecords WHERE sourceRef = ?", [next.sourceRef]);
    expect(isSha256HexV1(n[0]!.snapshotHash)).toBe(true);
    expect(n[0]).toMatchObject({ supersedesSourceRef: ref, proposedByUserId: s1 });
    // The proposer may not review their own version.
    await expect(as(s1).academy.sourceAct({ sourceRef: next.sourceRef, action: "REVIEW", note })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // Unreviewed: the tutor refers to it, never quotes it as the answer.
    const t = tutorAnswer({ mode: "explain", question: "When must dangerous goods be placarded?", at: new Date(), passages: [{ passageRef: "P1", sourceRef: next.sourceRef, sourceTitle: "TDG 2026", sourceUrl: null, sourceEdition: "2026", sourceReviewStatus: "unreviewed", section: "Placards", jurisdiction: "CA", text: "Dangerous goods must be placarded when the quantity exceeds the threshold." }] });
    expect(t.status).toBe("UNKNOWN_REFER_TO_AUTHORITY");
    await as(s2).academy.sourceAct({ sourceRef: next.sourceRef, action: "REVIEW", note });
    await as(s3).academy.sourceAct({ sourceRef: next.sourceRef, action: "APPROVE", note });
    const sup = await as(s3).academy.sourceAct({ sourceRef: ref, action: "MARK_SUPERSEDED", note, successorRef: next.sourceRef });
    expect(sup.reviewStatus).toBe("superseded");
    expect(sup.impact).toMatchObject({ status: "SOURCE_SUPERSEDED_REVIEW_REQUIRED" });
    expect(sup.impact!.notice).toMatch(/Nothing is rewritten/);
    const [after] = await pool.execute<mysql.RowDataPacket[]>("SELECT authority, title, edition, sourceUrl, snapshotHash, supersededBySourceRef FROM academySourceRecords WHERE sourceRef = ?", [ref]);
    const { supersededBySourceRef, ...facts } = after[0]!;
    expect(facts).toEqual(before[0]);
    expect(supersededBySourceRef).toBe(next.sourceRef);
    const impact = await as(s1).academy.sourceImpact({ sourceRef: ref });
    expect(impact.impactStatus).toBe("SOURCE_SUPERSEDED_REVIEW_REQUIRED");
    // Superseded is final.
    await expect(pool.execute("UPDATE academySourceRecords SET reviewStatus = 'reviewed' WHERE sourceRef = ?", [ref])).rejects.toThrow();
  }, 60_000);

  it("23. the legacy single-step sourceReview is bound by the same two-person rule", async () => {
    const A = await org();
    const s1 = await member(A, ["safety"]), s2 = await member(A, ["safety"]);
    const ref = await source();
    expect((await as(s1).academy.sourceReview({ sourceRef: ref, decision: "reviewed", note: "Checked against authority" })).reviewStatus).toBe("under_review");
    await expect(as(s1).academy.sourceReview({ sourceRef: ref, decision: "reviewed", note: "Checked against authority" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await as(s2).academy.sourceReview({ sourceRef: ref, decision: "reviewed", note: "Checked against authority" })).reviewStatus).toBe("reviewed");
  }, 60_000);
});

d("dispatch", () => {
  it("24/25. practice, requests and bookings never make anyone held; the explanation says what is in motion", async () => {
    const A = await org();
    const w = await member(A, ["driver"]), s = await member(A, ["safety"]), dispatcher = await member(A, ["dispatcher"]);
    const reqCode = `REQ-FA-${rnd()}`;
    await as(s).academy.requirementUpsert({ requirementCode: reqCode, title: "First aid on crew", qualificationCode: "FIRST_AID", enforcement: "block" });
    const h = await as(w).trainingWallet.requestTraining({ qualificationCode: "FIRST_AID" });
    await as(s).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "contacted" });
    await as(s).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "booked", appointmentAt: future(3) });
    const check = await as(dispatcher).academy.dispatchCheck({ userId: w, requirementCodes: [reqCode] });
    expect(check.status).toBe("blocked");
    const v = (await as(dispatcher).trainingWallet.operationalView({ userId: w, codes: ["FIRST_AID"] })).results[0]!;
    expect(v.state).not.toBe("held");
    expect(v.renewalProgress).toMatch(/^Renewal booked/);
  }, 60_000);
});
