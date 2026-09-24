/**
 * 0175 CP2 — one-time tracking links: the data model, the gate, and tenant isolation.
 *
 * Two organizations, A and B, each with a job. A dispatcher in A mints a link on A's job. The suite
 * proves: the token resolves; a forged, expired, revoked, superseded, disabled or exhausted token is
 * refused with a named reason and never with the job's existence; a token cannot be steered to
 * another job (there is no job parameter to steer); B cannot see, revoke or regenerate A's link and
 * cannot mint one on A's job by guessing its id; and every act is on the hash-chained ledger, which
 * re-verifies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { DEFAULT_SCOPE, LIVE_PRESETS, hashTrackingToken, linkCheck, liveWindow, newTrackingToken, parseScope, qrPayload, serializeScope, tokenShapeValid, trackingUrl } from "./_core/trackingLinks";
import { customerAuditHash } from "./_core/customerAudit";

const DB_URL = process.env.DATABASE_URL;

describe("tracking links — pure decisions", () => {
  it("mints 32 random bytes as base64url, stores only the hash, and refuses tokens of the wrong shape before hashing", () => {
    const t = newTrackingToken();
    expect(tokenShapeValid(t)).toBe(true);
    expect(t.length).toBeGreaterThanOrEqual(42);
    expect(hashTrackingToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTrackingToken(t)).not.toContain(t);
    expect(tokenShapeValid("1")).toBe(false);
    expect(tokenShapeValid("' OR 1=1 --")).toBe(false);
    expect(newTrackingToken()).not.toBe(t);
  });
  it("names every reason a link may not be used, and none of them mentions the job", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    const base = { status: "active" as const, expiresAt: null, maxAccessCount: null, accessCount: 0 };
    expect(linkCheck(base, now)).toEqual({ allowed: true, reason: null });
    for (const [row, phrase] of [
      [{ ...base, status: "revoked" as const }, /revoked/],
      [{ ...base, status: "disabled" as const }, /disabled/],
      [{ ...base, status: "superseded" as const }, /replaced/],
      [{ ...base, expiresAt: new Date("2026-09-24T11:59:59Z") }, /expired/],
      [{ ...base, maxAccessCount: 3, accessCount: 3 }, /access limit/],
    ] as const) {
      const r = linkCheck(row, now);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(phrase);
      expect(r.reason).not.toMatch(/job|JOB-|customer/i);
    }
    expect(linkCheck({ ...base, expiresAt: new Date("2026-09-24T12:00:01Z") }, now).allowed).toBe(true);
    expect(linkCheck({ ...base, maxAccessCount: 3, accessCount: 2 }, now).allowed).toBe(true);
  });
  it("ends live tracking under the completion rule while the link itself stays valid", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    const completed = new Date("2026-09-23T10:00:00Z");
    const w = (rule: Parameters<typeof liveWindow>[0]["liveUntilRule"], grace: number | null, jobCompletedAt: Date | null, liveExpiresAt: Date | null = null) => liveWindow({ liveUntilRule: rule, liveGraceHours: grace, liveExpiresAt, jobCompletedAt, linkExpiresAt: null, now });
    expect(w("until_completion", null, null).live).toBe(true);
    expect(w("until_completion", null, completed)).toMatchObject({ live: false, until: completed });
    expect(w("hours_after_completion", 24, completed).live).toBe(false);          // 26 h later
    expect(w("hours_after_completion", 24 * 7, completed).live).toBe(true);
    expect(w("hours_after_completion", 24, null).live).toBe(true);
    expect(w("custom", null, completed, new Date(now.getTime() + 12 * 3_600_000)).live).toBe(true);    // custom end still ahead
    expect(w("custom", null, completed, new Date(now.getTime() - 12 * 3_600_000)).live).toBe(false);   // custom end passed
    expect(w("custom", null, completed, null)).toMatchObject({ live: false });   // no date recorded is not "forever"
    expect(w("manual", null, completed).live).toBe(true);
    expect(liveWindow({ liveUntilRule: "manual", liveGraceHours: null, liveExpiresAt: null, jobCompletedAt: null, linkExpiresAt: new Date(now.getTime() - 3_600_000), now }).live).toBe(false);
    expect(LIVE_PRESETS["7d"]).toEqual({ liveUntilRule: "hours_after_completion", liveGraceHours: 168 });
  });
  it("reads a scope strictly — anything unreadable grants nothing — and the QR payload is the URL and nothing else", () => {
    expect(parseScope(null)).toEqual(DEFAULT_SCOPE);
    expect(parseScope(serializeScope({ status: true, loads: false, documents: true, billing: true, act: false, unit: false, operator: true }))).toEqual({ status: true, loads: false, documents: true, billing: true, act: false, unit: false, operator: true });
    expect(parseScope('{"status":"yes","act":1}')).toEqual({ status: false, loads: false, documents: false, billing: false, act: false, unit: true, operator: true });
    expect(parseScope("not json")).toEqual({ status: false, loads: false, documents: false, billing: false, act: false, unit: false, operator: false });
    const q = qrPayload("https://leaseos.app/", "tok");
    expect(q).toMatchObject({ payload: "https://leaseos.app/t/tok", encoding: "url" });
    expect(trackingUrl("", "tok")).toBe("/t/tok");
  });
  it("hashes an audit event over its content and its predecessor, so a changed row or a moved link breaks the chain", () => {
    const row = { eventRef: "CAE-1", orgRef: "ORG-A", eventType: "tracking_link_created", subjectType: "trackingLink", subjectRef: "TL-1", eventJson: "{}", occurredAt: new Date("2026-09-24T12:00:00Z"), previousHash: null, actorUserId: 7, trackingLinkId: 1, externalIdentityId: null };
    const h = customerAuditHash(row);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(customerAuditHash({ ...row, eventJson: '{"x":1}' })).not.toBe(h);
    expect(customerAuditHash({ ...row, previousHash: "a".repeat(64) })).not.toBe(h);
    expect(customerAuditHash({ ...row, orgRef: "ORG-B" })).not.toBe(h);
  });
});

describe("tracking links — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped isolation suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 655_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const trackingCaller = (token: string | null, extra: Record<string, string> = {}) => appRouter.createCaller({ req: { headers: { ...(token ? { "x-tracking-token": token } : {}), ...extra }, socket: { remoteAddress: "203.0.113.9" } } as never, res: {} as never, user: null as never });

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 }); });
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
async function job(orgRef: string, status = "dispatched") {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'water_haul','transport','Northgate Energy','04-12-052-09W5',?,0)", [orgRef, jobCode, status]);
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return { id: Number(r[0]!.id), jobCode };
}
async function account(orgRef: string) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (orgRef, entityRef, legalName, taxpayerType, jurisdiction) VALUES (?,?,'Fixture Co','corporation','CA-AB')", [orgRef, `ENT-${rnd()}`]);
  const accountRef = `CUST-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?,?,?)", [accountRef, e.insertId, `Client ${accountRef}`]);
  const [a] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM customerAccounts WHERE accountRef = ?", [accountRef]);
  return { id: Number(a[0]!.id), accountRef };
}

d("tracking links — through the gate, across two organizations", () => {
  it("mints a link the office never sees the token of again, resolves it, and refuses forged, expired, revoked, exhausted and cross-tenant use", async () => {
    const A = await org(); const B = await org();
    const dispatcherA = await member(A, "dispatcher"); const dispatcherB = await member(B, "dispatcher");
    const jobA = await job(A); const jobB = await job(B);
    const acctA = await account(A);

    // (1) B cannot mint a link on A's job by guessing its id — "not found", never "forbidden".
    await expect(caller(dispatcherB).clientServices.trackingLinkCreate({ jobId: jobA.id })).rejects.toThrow(/not found/i);
    // Nor by naming A's customer account.
    await expect(caller(dispatcherB).clientServices.trackingLinkCreate({ jobId: jobB.id, customerAccountRef: acctA.accountRef })).rejects.toThrow(/Customer account not found/);

    const made = await caller(dispatcherA).clientServices.trackingLinkCreate({ jobId: jobA.id, customerAccountRef: acctA.accountRef, contactKind: "site_supervisor", contactName: "R. Patel", livePreset: "24h", locationMode: "approximate" });
    expect(made.linkRef).toMatch(/^TL-\d{4}-\d{6}$/);
    expect(made.url).toBe(`/t/${made.token}`);
    expect(made.qr.payload).toBe(made.url);
    expect(made.qr.payload).not.toContain(jobA.jobCode);
    expect(made.scope).toEqual({ status: true, loads: true, documents: true, billing: false, act: false, unit: true, operator: true });
    // Only the hash is stored; the token is nowhere in the row.
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM jobTrackingLinks WHERE linkRef = ?", [made.linkRef]);
    expect(rows[0]!.tokenHash).toBe(hashTrackingToken(made.token));
    expect(JSON.stringify(rows[0])).not.toContain(made.token);
    expect(rows[0]!.orgRef).toBe(A);
    expect(rows[0]!.customerAccountId).toBe(acctA.id);

    // (2) A valid token resolves to exactly that job, and the request carried nothing that could name another.
    const r = await trackingCaller(made.token).tracking.resolve();
    expect(r).toMatchObject({ linkRef: made.linkRef, jobReference: jobA.jobCode, issuedTo: { name: "R. Patel", kind: "site_supervisor" }, locationMode: "approximate", live: { available: true } });
    expect(JSON.stringify(r)).not.toContain(jobB.jobCode);
    expect(JSON.stringify(r)).not.toContain(String(jobA.id));
    // Each allowed use is counted, stamped and logged with a hashed address, never the address.
    const [after] = await pool.query<mysql.RowDataPacket[]>("SELECT accessCount, lastAccessedAt FROM jobTrackingLinks WHERE linkRef = ?", [made.linkRef]);
    expect(after[0]!.accessCount).toBe(1);
    expect(after[0]!.lastAccessedAt).not.toBeNull();
    const [access] = await pool.query<mysql.RowDataPacket[]>("SELECT action, outcome, ipHash FROM jobTrackingLinkAccess WHERE linkId = ?", [rows[0]!.id]);
    expect(access.map(a => [a.action, a.outcome])).toEqual([["tracking.resolve", "allowed"]]);
    expect(access[0]!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(access[0]!.ipHash).not.toContain("203.0.113.9");

    // (3) Invalid tokens: absent, malformed, well-formed but unknown. None says whether any job exists.
    await expect(trackingCaller(null).tracking.resolve()).rejects.toThrow(/No tracking token/);
    await expect(trackingCaller("short").tracking.resolve()).rejects.toThrow(/Unknown tracking link/);
    await expect(trackingCaller(newTrackingToken()).tracking.resolve()).rejects.toThrow(/Unknown tracking link/);
    const [unknownAccess] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM jobTrackingLinkAccess WHERE linkId = ?", [rows[0]!.id]);
    expect(Number(unknownAccess[0]!.n)).toBe(1);   // a refusal of an unknown token logs against no link

    // (4) The scope is the link's, not the request's: this link does not permit billing or actions.
    expect(r.permits.billing).toBe(false);

    // (5) Access limit, then reconfigure: the office may narrow or widen, every change audited before/after.
    const limited = await caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, maxAccessCount: 2 });
    expect(limited.maxAccessCount).toBe(2);
    await trackingCaller(made.token).tracking.resolve();               // second use
    await expect(trackingCaller(made.token).tracking.resolve()).rejects.toThrow(/access limit/);
    await caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, maxAccessCount: null });
    await expect(trackingCaller(made.token).tracking.resolve()).resolves.toBeTruthy();

    // (6) Disabled, then re-enabled.
    await caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, disabled: true });
    await expect(trackingCaller(made.token).tracking.resolve()).rejects.toThrow(/disabled/);
    await caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, disabled: false });

    // (7) Expired.
    await caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, expiresAt: new Date(Date.now() - 60_000) });
    await expect(trackingCaller(made.token).tracking.resolve()).rejects.toThrow(/expired/);
    await caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, expiresAt: null });

    // (8) B cannot see, configure, revoke or regenerate A's link.
    await expect(caller(dispatcherB).clientServices.trackingLinks({ jobId: jobA.id })).rejects.toThrow(/not found/i);
    await expect(caller(dispatcherB).clientServices.trackingLinkConfigure({ linkRef: made.linkRef, disabled: true })).rejects.toThrow(/not found/i);
    await expect(caller(dispatcherB).clientServices.trackingLinkRevoke({ linkRef: made.linkRef, reason: "intrusion" })).rejects.toThrow(/not found/i);
    await expect(caller(dispatcherB).clientServices.trackingLinkRegenerate({ linkRef: made.linkRef })).rejects.toThrow(/not found/i);
    expect((await caller(dispatcherA).clientServices.trackingLinks({ jobId: jobA.id })).links.map(l => l.linkRef)).toEqual([made.linkRef]);
    expect(JSON.stringify(await caller(dispatcherA).clientServices.trackingLinks({ jobId: jobA.id }))).not.toContain(made.token);

    // (9) Regenerate: the old token stops, the new one resolves to the same job with the same configuration.
    const regen = await caller(dispatcherA).clientServices.trackingLinkRegenerate({ linkRef: made.linkRef, reason: "recipient changed phones" });
    expect(regen.supersedes).toBe(made.linkRef);
    await expect(trackingCaller(made.token).tracking.resolve()).rejects.toThrow(/replaced/);
    const r2 = await trackingCaller(regen.token).tracking.resolve();
    expect(r2).toMatchObject({ linkRef: regen.linkRef, jobReference: jobA.jobCode, locationMode: "approximate", issuedTo: { name: "R. Patel" } });

    // (10) Revoke: fails closed from then on, idempotent on repeat.
    expect(await caller(dispatcherA).clientServices.trackingLinkRevoke({ linkRef: regen.linkRef, reason: "job handed to another contact" })).toMatchObject({ status: "revoked", alreadyRevoked: false });
    await expect(trackingCaller(regen.token).tracking.resolve()).rejects.toThrow(/revoked/);
    expect((await caller(dispatcherA).clientServices.trackingLinkRevoke({ linkRef: regen.linkRef, reason: "again" })).alreadyRevoked).toBe(true);
    await expect(caller(dispatcherA).clientServices.trackingLinkConfigure({ linkRef: regen.linkRef, disabled: false })).rejects.toThrow(/revoked/);

    // (11) Every act is on A's ledger, hash-chained, and the chain verifies; B's ledger has none of it.
    const trail = await caller(dispatcherA).clientServices.auditTrail({ jobId: jobA.id });
    expect(trail.events.map(e => e.eventType).reverse()).toEqual([
      "tracking_link_created", "tracking_link_permissions_changed", "tracking_link_permissions_changed", "tracking_link_permissions_changed", "tracking_link_permissions_changed", "tracking_link_permissions_changed", "tracking_link_permissions_changed",
      "tracking_link_regenerated", "tracking_link_created", "tracking_link_revoked",
    ]);
    const chrono = [...trail.events].reverse();
    expect(chrono[0]!.previousHash).toBeNull();
    for (let i = 1; i < chrono.length; i++) expect(chrono[i]!.previousHash).toBe(chrono[i - 1]!.eventHash);
    expect(await caller(dispatcherA).clientServices.auditVerify()).toMatchObject({ ok: true, rows: 10 });
    await expect(caller(dispatcherB).clientServices.auditTrail({ jobId: jobA.id })).rejects.toThrow(/not found/i);
    expect(await caller(dispatcherB).clientServices.auditVerify()).toMatchObject({ ok: true, rows: 0 });
    // The regenerate is recorded once for the old link and once for the new, against the same job.
    expect(trail.events.filter(e => e.eventType === "tracking_link_created").map(e => e.subjectRef).sort()).toEqual([made.linkRef, regen.linkRef].sort());
    // Nothing on the ledger carries a token.
    expect(JSON.stringify(trail)).not.toContain(made.token);
    expect(JSON.stringify(trail)).not.toContain(regen.token);

    // (12) A tampered ledger row is named by the verifier.
    await pool.execute("UPDATE customerAuditEvents SET eventJson = '{\"tampered\":true}' WHERE eventRef = ?", [chrono[3]!.eventRef]);
    const v = await caller(dispatcherA).clientServices.auditVerify();
    expect(v.ok).toBe(false);
    expect(v.firstBreak).toMatchObject({ eventRef: chrono[3]!.eventRef, reason: expect.stringMatching(/content/) });

    // (13) The customer's own alert queue heard about the link, once, on the existing queue — nothing else.
    const [alerts] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM workflowNotifications WHERE notificationKey LIKE ?", [`customer:tracking_link_created:${made.linkRef}:%`]);
    expect(Number(alerts[0]!.n)).toBe(0);   // no external identity on the account yet, so nobody to tell — and nothing invented
  }, 60_000);

  it("fails closed when the job leaves the link's organization, and a link never follows a job", async () => {
    const A = await org();
    const dispatcherA = await member(A, "dispatcher");
    const jobA = await job(A);
    const made = await caller(dispatcherA).clientServices.trackingLinkCreate({ jobId: jobA.id, livePreset: "manual" });
    await expect(trackingCaller(made.token).tracking.resolve()).resolves.toMatchObject({ jobReference: jobA.jobCode });
    // Ownership becomes ambiguous or moves: the link resolves to nothing, rather than to whatever now sits at that id.
    await pool.execute("UPDATE jobs SET orgRef = ? WHERE id = ?", [`ORG-ELSEWHERE-${rnd()}`, jobA.id]);
    await expect(trackingCaller(made.token).tracking.resolve()).rejects.toThrow(/no longer resolves/);
    await pool.execute("UPDATE jobs SET orgRef = ? WHERE id = ?", [A, jobA.id]);
    await expect(trackingCaller(made.token).tracking.resolve()).resolves.toBeTruthy();
    // The refusal was recorded against the link, with its reason.
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT a.outcome, a.detail FROM jobTrackingLinkAccess a JOIN jobTrackingLinks l ON l.id = a.linkId WHERE l.linkRef = ? ORDER BY a.id", [made.linkRef]);
    expect(rows.map(r => r.outcome)).toEqual(["allowed", "denied", "allowed"]);
    expect(rows[1]!.detail).toMatch(/no longer resolves/);
  }, 30_000);

  it("assigns a job to a customer account only within the caller's organization, and audits it", async () => {
    const A = await org(); const B = await org();
    const officeA = await member(A, "office"); const officeB = await member(B, "office");
    const jobA = await job(A); const acctA = await account(A); const acctB = await account(B);
    await expect(caller(officeB).clientServices.jobCustomerAssign({ jobId: jobA.id, customerAccountRef: acctB.accountRef })).rejects.toThrow(/not found/i);
    await expect(caller(officeA).clientServices.jobCustomerAssign({ jobId: jobA.id, customerAccountRef: acctB.accountRef })).rejects.toThrow(/Customer account not found/);
    expect(await caller(officeA).clientServices.jobCustomerAssign({ jobId: jobA.id, customerAccountRef: acctA.accountRef })).toEqual({ jobCode: jobA.jobCode, customerAccountId: acctA.id });
    const [j] = await pool.query<mysql.RowDataPacket[]>("SELECT customerAccountId FROM jobs WHERE id = ?", [jobA.id]);
    expect(j[0]!.customerAccountId).toBe(acctA.id);
    // A link minted afterwards inherits the job's account without naming it.
    const made = await caller(officeA).clientServices.trackingLinkCreate({ jobId: jobA.id });
    const [l] = await pool.query<mysql.RowDataPacket[]>("SELECT customerAccountId FROM jobTrackingLinks WHERE linkRef = ?", [made.linkRef]);
    expect(l[0]!.customerAccountId).toBe(acctA.id);
    expect((await caller(officeA).clientServices.auditTrail({ jobId: jobA.id })).events.map(e => e.eventType)).toEqual(["tracking_link_created", "job_customer_assigned"]);
  }, 30_000);

  it("refuses a driver the office-side procedures and records the denial", async () => {
    const A = await org();
    const driver = await member(A, "driver");
    const jobA = await job(A);
    await expect(caller(driver).clientServices.trackingLinkCreate({ jobId: jobA.id })).rejects.toThrow(/client_services\.link\.manage/);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT outcome FROM authorizationDecisions WHERE actorUserId = ? AND procedureName = 'clientServices.trackingLinkCreate'", [driver]);
    expect(rows.map(r => r.outcome)).toEqual(["denied_permission"]);
  }, 20_000);
});
