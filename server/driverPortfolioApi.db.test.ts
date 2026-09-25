/**
 * 0204 — the Driver Portfolio API as a security boundary.
 *
 * Every call goes through `appRouter.createCaller`, so the role gate, the permission map, the acting
 * scope and the router are the production ones. Each test builds its own organizations, which is
 * also what makes company-wide (`*`) bindings safe here: they belong to an organization no other
 * suite's work can be in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { walletStatusAt } from "../shared/driverWallet";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 312_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4, timezone: "Z" }); });
afterAll(async () => { await pool?.end(); });

const as = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function operator(orgRef: string, userId: number | null, name = `Op ${rnd()}`) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId, licenseClass, createdAt) VALUES (?, ?, '1', NOW())", [name, userId]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, o.insertId]);
  return Number(o.insertId);
}
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
async function credential(operatorId: number, docType: string, o: { expiresAt?: Date | null; status?: "verified" | "needs_review" | "rejected"; capturedAt?: Date; identifier?: string; privateDetail?: boolean } = {}) {
  const status = o.status ?? "verified";
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, identifier, capturedAt, expiresAt, verificationStatus, verifiedByUserId, verifiedAt, privateDetail, createdAt) VALUES ('operator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())",
    [operatorId, docType, docType, o.identifier ?? `ID-${rnd()}`, o.capturedAt ?? days(-30), o.expiresAt === undefined ? days(400) : o.expiresAt, status, status === "verified" ? 1 : null, status === "verified" ? days(-29) : null, o.privateDetail ?? false],
  );
  return Number(r.insertId);
}
const events = async (operatorId: number) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT eventType, actorUserId, orgRef, credentialId FROM driverPortfolioEvents WHERE operatorId = ? ORDER BY id", [operatorId]))[0];

/** An organization with a Safety lead, a dispatcher, and a driver with an operator record. */
async function company() {
  const orgRef = await org();
  const safety = await member(orgRef, ["safety"]);
  const dispatcher = await member(orgRef, ["dispatcher"]);
  const driver = await member(orgRef, ["driver"]);
  const operatorId = await operator(orgRef, driver);
  return { orgRef, safety, dispatcher, driver, operatorId };
}

d("the driver's own wallet", () => {
  it("answers for the caller's operator only, and says READY FOR WORK only while it holds", async () => {
    const c = await company();
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "H2S Alive" });
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "confined_space", enforcement: "informational" });

    const empty = await as(c.driver).driverPortfolio.myWallet();
    expect(empty.operator.operatorId).toBe(c.operatorId);
    expect(empty.status).toBe("NOT READY");
    expect(empty.cards[0]).toMatchObject({ kind: "credential", code: "h2s_alive", required: "mandatory", state: "missing", satisfied: false });
    expect(empty.cards[0]!.reason).toMatch(/not on file/);

    await credential(c.operatorId, "h2s_alive", { expiresAt: days(5) });
    const w = await as(c.driver).driverPortfolio.myWallet();
    // The informational requirement is missing and still does not stop the driver.
    expect(w.status).toBe("READY FOR WORK");
    expect(w.cards.find(x => x.code === "confined_space")).toMatchObject({ required: "informational", satisfied: false });
    expect(w.cards.find(x => x.code === "h2s_alive")).toMatchObject({ warningTier: 7, verification: "verified" });
    // The offline contract: a required ticket lapsing in five days shortens the 24-hour allowance only when sooner.
    expect(w.cache.limitedBy).toBe("offline_allowance");
    expect(w.cache.validUntil.getTime() - w.cache.generatedAt.getTime()).toBe(24 * 3_600_000);
    expect(walletStatusAt({ headline: w.headline, validUntil: w.cache.validUntil }, new Date(w.cache.validUntil.getTime() + 1))).toBe("STALE");
    expect(w.upcomingExpirations.map(a => a.code)).toEqual(["h2s_alive"]);
  });

  it("is shortened by a required ticket lapsing inside the allowance, and a cached READY then goes STALE", async () => {
    const c = await company();
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "first_aid_cpr" });
    // Whole seconds: the column stores no fraction, so neither does the expectation.
    const lapse = new Date(Math.floor((Date.now() + 3 * 3_600_000) / 1000) * 1000);
    await credential(c.operatorId, "first_aid_cpr", { expiresAt: lapse });
    const w = await as(c.driver).driverPortfolio.myWallet();
    expect(w.status).toBe("READY FOR WORK");
    expect(w.cache).toMatchObject({ limitedBy: "credential_expiry", limitingCredential: { code: "first_aid_cpr" } });
    expect(w.cache.validUntil.getTime()).toBe(lapse.getTime());
    expect(walletStatusAt({ headline: w.headline, validUntil: w.cache.validUntil }, new Date(lapse.getTime() + 60_000))).toBe("STALE");
  });

  it("an unverified required ticket stays ACTION REQUIRED, never READY", async () => {
    const c = await company();
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "whmis" });
    await credential(c.operatorId, "whmis", { status: "needs_review" });
    const w = await as(c.driver).driverPortfolio.myWallet();
    expect(w.status).toBe("ACTION REQUIRED");
    expect(w.cards[0]).toMatchObject({ code: "whmis", state: "unverified", verification: "awaiting_verification" });
  });

  it("refuses a user with no operator record, and offers no way to name another driver", async () => {
    const c = await company();
    const stranger = await member(c.orgRef, ["driver"]);
    await expect(as(stranger).driverPortfolio.myWallet()).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The full portfolio of another driver needs portfolio.read, which a driver does not hold.
    await expect(as(c.driver).driverPortfolio.portfolio({ operatorId: c.operatorId + 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(c.driver).driverPortfolio.expiryDashboard({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(c.driver).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "whmis" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

d("dispatch sees the canonical verdict and nothing more", () => {
  it("agrees with dispatch.readiness, and carries no certificate number, document or HR detail", async () => {
    const c = await company();
    const unitId = await unit(c.orgRef);
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "h2s_alive" });
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "first_aid_cpr" });
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "defensive_driving", enforcement: "informational" });
    await credential(c.operatorId, "h2s_alive", { identifier: "H2S-SECRET-7781" });
    await credential(c.operatorId, "first_aid_cpr", { expiresAt: days(-2), identifier: "FA-SECRET-1" });
    await credential(c.operatorId, "medical_fitness", { privateDetail: true, identifier: "MED-SECRET" });

    const view = await as(c.dispatcher).driverPortfolio.operatorReadiness({ operatorId: c.operatorId, unitId });
    const canonical = await as(c.dispatcher).dispatch.readiness({ operatorId: c.operatorId, unitId });
    expect(view.verdict).toBe(canonical.verdict);
    expect(view.explanation).toBe(canonical.explanation);
    expect(view.verdict).toBe("blocked");
    const lines = Object.fromEntries(view.requirements.map(l => [l.label, l]));
    expect(lines["H2S Alive"]).toMatchObject({ ok: true, mandatory: true });
    // Expired mandatory blocks, with no override.
    expect(lines["First Aid / CPR"]).toMatchObject({ ok: false, state: "expired" });
    expect(view.operatorFindings.find(f => f.code === "driver_credential_first_aid_cpr_expired")).toMatchObject({ severity: "blocking", overridable: false });
    // Informational never blocks.
    expect(lines["Defensive driving"]).toMatchObject({ ok: false, mandatory: false });
    expect(view.operatorFindings.some(f => f.code.includes("defensive_driving"))).toBe(false);
    const wire = JSON.stringify(view);
    for (const secret of ["H2S-SECRET-7781", "FA-SECRET-1", "MED-SECRET", "storageKey", "storageUrl"]) expect(wire).not.toContain(secret);
    // Dispatch cannot browse the portfolio.
    await expect(as(c.dispatcher).driverPortfolio.portfolio({ operatorId: c.operatorId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("missing blocks and unknown stays unknown", async () => {
    const c = await company();
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "ground_disturbance" });
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "confined_space" });
    await credential(c.operatorId, "confined_space", { status: "needs_review" });
    const v = await as(c.dispatcher).driverPortfolio.operatorReadiness({ operatorId: c.operatorId });
    expect(v.operatorFindings.find(f => f.code === "driver_credential_ground_disturbance_missing")).toMatchObject({ severity: "blocking", overridable: false });
    expect(v.operatorFindings.find(f => f.code === "driver_credential_confined_space_unverified")).toMatchObject({ severity: "unknown" });
  });

  it("another organization's operator is not found", async () => {
    const a = await company(), b = await company();
    await expect(as(b.dispatcher).driverPortfolio.operatorReadiness({ operatorId: a.operatorId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

d("Safety/Admin, within its own organization", () => {
  it("reads the portfolio with history, and org B reads and changes nothing of org A's", async () => {
    const a = await company(), b = await company();
    await credential(a.operatorId, "h2s_alive", { expiresAt: days(-400), capturedAt: days(-1500) });
    await credential(a.operatorId, "h2s_alive", { expiresAt: days(600), capturedAt: days(-100) });
    await credential(a.operatorId, "medical_fitness", { privateDetail: true });
    const p = await as(a.safety).driverPortfolio.portfolio({ operatorId: a.operatorId });
    const h2s = p.credentials.find(x => x.code === "h2s_alive")!;
    expect(h2s.current).not.toBeNull();
    expect(h2s.history.map(x => x.reason)).toEqual(["expired"]);
    expect(p.privateCredentialsWithheld).toBe(1);
    expect(JSON.stringify(p)).not.toContain("medical_fitness");
    expect((await events(a.operatorId)).some(e => e.eventType === "portfolio_viewed" && e.orgRef === a.orgRef)).toBe(true);

    await expect(as(b.safety).driverPortfolio.portfolio({ operatorId: a.operatorId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(b.safety).driverPortfolio.auditHistory({ operatorId: a.operatorId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { bindingRef } = await as(a.safety).driverPortfolio.requirementCreate({ subjectType: "customer", subjectCode: "Cenovus", requirementKind: "credential", requirementCode: "h2s_alive" });
    await expect(as(b.safety).driverPortfolio.requirementGet({ bindingRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(b.safety).driverPortfolio.requirementUpdate({ bindingRef, changes: { enforcement: "informational" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(b.safety).driverPortfolio.requirementRetire({ bindingRef, reason: "not ours to retire" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await as(b.safety).driverPortfolio.requirementList({})).some(x => x.bindingRef === bindingRef)).toBe(false);
    expect((await as(a.safety).driverPortfolio.requirementGet({ bindingRef })).active).toBe(true);
  });

  it("requirements are retired and superseded, never deleted, and every change is audited", async () => {
    const c = await company();
    const safety = as(c.safety).driverPortfolio;
    await expect(safety.requirementCreate({ subjectType: "company", subjectCode: "Cenovus", requirementKind: "credential", requirementCode: "h2s_alive" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(safety.requirementCreate({ subjectType: "customer", subjectCode: "Cenovus", requirementKind: "credential", requirementCode: "mystery_ticket" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { bindingRef } = await safety.requirementCreate({ subjectType: "customer", subjectCode: "Cenovus", requirementKind: "credential", requirementCode: "h2s_alive" });
    const upd = await safety.requirementUpdate({ bindingRef, changes: { enforcement: "informational" } });
    expect(upd.supersedesBindingRef).toBe(bindingRef);
    const old = await safety.requirementGet({ bindingRef });
    expect(old).toMatchObject({ active: false, supersededByBindingRef: upd.bindingRef });
    expect(await safety.requirementGet({ bindingRef: upd.bindingRef })).toMatchObject({ active: true, enforcement: "informational", supersedesBindingRef: bindingRef });
    await expect(safety.requirementUpdate({ bindingRef, changes: { enforcement: "mandatory" } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await safety.requirementRetire({ bindingRef: upd.bindingRef, reason: "client contract ended" });
    const all = await safety.requirementList({ includeRetired: true });
    expect(all.filter(x => [bindingRef, upd.bindingRef].includes(x.bindingRef)).map(x => x.active)).toEqual([false, false]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, actorUserId FROM driverPortfolioEvents WHERE orgRef = ? AND operatorId IS NULL ORDER BY id", [c.orgRef]);
    expect(rows.map(r => r.eventType)).toEqual(["requirement_bound", "requirement_modified", "requirement_retired"]);
    expect(rows.every(r => r.actorUserId === c.safety)).toBe(true);
  });
});

d("the credential verification workflow", () => {
  it("submit → verify by another person → readiness changes → audited; nobody verifies their own", async () => {
    const c = await company();
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "tdg_certificate" });
    await expect(as(c.driver).driverPortfolio.submitCredential({ code: "medical_fitness" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "tdg_certificate", identifier: "TDG-1", expiresAt: days(900) });
    expect((await as(c.driver).driverPortfolio.myWallet()).status).toBe("ACTION REQUIRED");
    // The driver cannot verify it: no permission, and in any case not their own.
    await expect(as(c.driver).driverPortfolio.credentialVerify({ credentialId, outcome: "verified" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Another organization's Safety cannot even see it.
    const other = await company();
    await expect(as(other.safety).driverPortfolio.credentialVerify({ credentialId, outcome: "verified" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await as(c.safety).driverPortfolio.verificationQueue({})).map(q => q.credentialId)).toContain(credentialId);
    await as(c.safety).driverPortfolio.credentialVerify({ credentialId, outcome: "verified" });
    expect((await as(c.driver).driverPortfolio.myWallet()).status).toBe("READY FOR WORK");
    await expect(as(c.safety).driverPortfolio.credentialVerify({ credentialId, outcome: "rejected" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const ev = await events(c.operatorId);
    expect(ev.map(e => e.eventType)).toEqual(expect.arrayContaining(["credential_uploaded", "credential_verified"]));
    expect(ev.find(e => e.eventType === "credential_uploaded")).toMatchObject({ actorUserId: c.driver, orgRef: c.orgRef });
    expect(ev.find(e => e.eventType === "credential_verified")).toMatchObject({ actorUserId: c.safety, orgRef: c.orgRef });
  });

  it("a Safety lead who is also a driver cannot verify their own submission", async () => {
    const orgRef = await org();
    const safetyDriver = await member(orgRef, ["safety", "driver"]);
    const opId = await operator(orgRef, safetyDriver);
    const { credentialId } = await as(safetyDriver).driverPortfolio.submitCredential({ code: "whmis", expiresAt: days(300) });
    await expect(as(safetyDriver).driverPortfolio.credentialVerify({ credentialId, outcome: "verified" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "You may not verify your own credential" });
    const [row] = (await pool.query<mysql.RowDataPacket[]>("SELECT verificationStatus FROM complianceDocuments WHERE id = ?", [credentialId]))[0];
    expect(row!.verificationStatus).toBe("needs_review");
    expect((await events(opId)).map(e => e.eventType)).toEqual(["credential_uploaded"]);
  });

  it("a rejection reads as rejected, and blocks", async () => {
    const c = await company();
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "whmis" });
    const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "whmis", expiresAt: days(300) });
    await as(c.safety).driverPortfolio.credentialVerify({ credentialId, outcome: "rejected", note: "illegible" });
    const w = await as(c.driver).driverPortfolio.myWallet();
    expect(w.status).toBe("NOT READY");
    expect(w.cards[0]).toMatchObject({ code: "whmis", state: "rejected" });
    expect((await events(c.operatorId)).map(e => e.eventType)).toContain("credential_rejected");
  });

  it("a verified renewal supersedes the old ticket: its history stays, and its expiry warning goes", async () => {
    const c = await company();
    const oldId = await credential(c.operatorId, "h2s_alive", { expiresAt: days(10), capturedAt: days(-1000) });
    const before = await as(c.safety).driverPortfolio.expiryDashboard({ operatorId: c.operatorId });
    expect(before.alerts.map(a => [a.code, a.credentialId])).toEqual([["h2s_alive", oldId]]);
    const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "h2s_alive", expiresAt: days(1100) });
    // Unverified, the renewal does not clear the warning; the alert says a renewal is waiting.
    expect((await as(c.safety).driverPortfolio.expiryDashboard({ operatorId: c.operatorId })).alerts[0]).toMatchObject({ credentialId: oldId, pendingRenewal: true });
    await as(c.safety).driverPortfolio.credentialVerify({ credentialId, outcome: "verified" });
    expect((await as(c.safety).driverPortfolio.expiryDashboard({ operatorId: c.operatorId })).alerts).toEqual([]);
    const h = await as(c.driver).driverPortfolio.myCredentialHistory({ code: "h2s_alive" });
    expect(h.current?.credentialId).toBe(credentialId);
    expect(h.history.map(x => [x.credentialId, x.reason])).toEqual([[oldId, "superseded"]]);
    expect((await events(c.operatorId)).find(e => e.eventType === "credential_superseded")).toMatchObject({ credentialId: oldId, actorUserId: c.safety });
  });
});

d("the company-wide expiry dashboard", () => {
  it("filters by window, verification and readiness impact, and pages with a cursor", async () => {
    const orgRef = await org();
    const safety = await member(orgRef, ["safety"]);
    const ops = [await operator(orgRef, null, "Alpha"), await operator(orgRef, null, "Bravo"), await operator(orgRef, null, "Charlie")];
    await credential(ops[0]!, "h2s_alive", { expiresAt: days(-3) });
    await credential(ops[1]!, "first_aid_cpr", { expiresAt: days(5) });
    await credential(ops[2]!, "whmis", { expiresAt: days(40) });
    await credential(ops[2]!, "csts", { status: "needs_review", expiresAt: days(12) });
    await as(safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "first_aid_cpr" });
    await as(safety).driverPortfolio.requirementCreate({ subjectType: "site", subjectCode: "Christina Lake", requirementKind: "credential", requirementCode: "whmis", enforcement: "informational" });
    const dash = as(safety).driverPortfolio;

    const all = await dash.expiryDashboard({});
    expect(all.alerts.map(a => a.code)).toEqual(["first_aid_cpr", "csts", "whmis"]);
    expect(all.summary).toMatchObject({ expired: 1, within7: 1, within14: 2, within30: 2, within60: 3, within90: 3 });
    expect((await dash.expiryDashboard({ within: "expired" })).alerts.map(a => a.name)).toEqual(["Alpha"]);
    expect((await dash.expiryDashboard({ within: 7 })).alerts.map(a => a.code)).toEqual(["first_aid_cpr"]);
    expect((await dash.expiryDashboard({ verification: "unverified" })).alerts.map(a => a.code)).toEqual(["csts"]);
    expect((await dash.expiryDashboard({ readinessImpact: "mandatory" })).alerts.map(a => a.code)).toEqual(["first_aid_cpr"]);
    expect((await dash.expiryDashboard({ readinessImpact: "informational" })).alerts.map(a => a.code)).toEqual(["whmis"]);
    expect((await dash.expiryDashboard({ code: "WHMIS" })).alerts.map(a => a.code)).toEqual(["whmis"]);

    const p1 = await dash.expiryDashboard({ limit: 2 });
    expect(p1.alerts).toHaveLength(2);
    const p2 = await dash.expiryDashboard({ limit: 2, cursor: p1.nextCursor });
    expect([...p1.alerts, ...p2.alerts].map(a => a.code)).toEqual(all.alerts.map(a => a.code));
    expect(p2.nextCursor).toBeNull();
    await expect(dash.expiryDashboard({ cursor: "garbage" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Another organization sees none of it, and cannot name one of these operators.
    const otherSafety = await member(await org(), ["safety"]);
    expect((await as(otherSafety).driverPortfolio.expiryDashboard({})).alerts).toEqual([]);
    await expect(as(otherSafety).driverPortfolio.expiryDashboard({ operatorId: ops[0]! })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

d("sharing one credential", () => {
  it("redeems one credential with minimum detail, and stops when revoked, expired, rejected or replaced", async () => {
    const c = await company();
    const h2s = await credential(c.operatorId, "h2s_alive", { identifier: "H2S-99124411" });
    await credential(c.operatorId, "whmis", { identifier: "WHMIS-SECRET" });
    const me = as(c.driver).driverPortfolio;
    const share = await me.shareIssue({ credentialId: h2s, audience: "Christina Lake gate", hours: 2 });
    expect(share.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * 3_600_000);
    const pub = as(0 as never).driverPortfolio;
    const ok = await pub.shareRedeem({ token: share.token });
    expect(ok).toMatchObject({ valid: true, credential: { label: "H2S Alive", identifierEnding: "••••4411" } });
    const wire = JSON.stringify(ok);
    for (const leak of ["H2S-99124411", "WHMIS", c.orgRef, "storage"]) expect(wire).not.toContain(leak);
    // Only the hash is stored.
    const [[stored]] = await pool.query<mysql.RowDataPacket[]>("SELECT tokenHash FROM driverCredentialShares WHERE shareRef = ?", [share.shareRef]) as unknown as [[{ tokenHash: string }]];
    expect(stored.tokenHash).not.toBe(share.token);
    expect(stored.tokenHash).toHaveLength(64);

    await me.shareRevoke({ shareRef: share.shareRef });
    expect(await pub.shareRedeem({ token: share.token })).toEqual({ valid: false, reason: "revoked" });
    expect(await pub.shareRedeem({ token: "x".repeat(43) })).toEqual({ valid: false, reason: "not_found" });

    const s2 = await me.shareIssue({ credentialId: h2s, audience: "Site office" });
    await pool.execute("UPDATE driverCredentialShares SET expiresAt = ? WHERE shareRef = ?", [new Date(Date.now() - 1000), s2.shareRef]);
    expect(await pub.shareRedeem({ token: s2.token })).toEqual({ valid: false, reason: "expired" });

    const s3 = await me.shareIssue({ credentialId: h2s, audience: "Site office" });
    await credential(c.operatorId, "h2s_alive", { capturedAt: days(-1), expiresAt: days(1000) });
    expect(await pub.shareRedeem({ token: s3.token })).toMatchObject({ valid: false, reason: "superseded" });

    const w = await credential(c.operatorId, "fall_protection");
    const s4 = await me.shareIssue({ credentialId: w, audience: "Gate" });
    await pool.execute("UPDATE complianceDocuments SET verificationStatus = 'rejected' WHERE id = ?", [w]);
    expect(await pub.shareRedeem({ token: s4.token })).toMatchObject({ valid: false, reason: "rejected" });

    const ev = (await events(c.operatorId)).map(e => e.eventType);
    expect(ev).toEqual(expect.arrayContaining(["credential_shared", "share_revoked", "share_verified"]));
  });

  it("cannot share another driver's credential, a private one, or for longer than seven days", async () => {
    const c = await company();
    const otherOp = await operator(c.orgRef, await member(c.orgRef, ["driver"]));
    const theirs = await credential(otherOp, "h2s_alive");
    const medical = await credential(c.operatorId, "medical_fitness", { privateDetail: true });
    const mine = await credential(c.operatorId, "h2s_alive");
    const unverified = await credential(c.operatorId, "whmis", { status: "needs_review" });
    const me = as(c.driver).driverPortfolio;
    await expect(me.shareIssue({ credentialId: theirs, audience: "Gate" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(me.shareIssue({ credentialId: medical, audience: "Gate" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(me.shareIssue({ credentialId: unverified, audience: "Gate" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(me.shareIssue({ credentialId: mine, audience: "Gate", hours: 169 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Revoking someone else's share is "not found".
    const theirShare = await as((await pool.query<mysql.RowDataPacket[]>("SELECT userId FROM operators WHERE id = ?", [otherOp]))[0][0]!.userId).driverPortfolio.shareIssue({ credentialId: theirs, audience: "Gate" });
    await expect(me.shareRevoke({ shareRef: theirShare.shareRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

d("the portfolio audit trail", () => {
  it("cannot be updated or deleted, including the columns 0204 added", async () => {
    const c = await company();
    await as(c.driver).driverPortfolio.submitCredential({ code: "whmis", expiresAt: days(100) });
    await expect(pool.execute("UPDATE driverPortfolioEvents SET orgRef = 'ORG-FORGED' WHERE operatorId = ?", [c.operatorId])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM driverPortfolioEvents WHERE operatorId = ?", [c.operatorId])).rejects.toThrow(/append-only/);
    expect((await events(c.operatorId)).map(e => e.orgRef)).toEqual([c.orgRef]);
  });
});
