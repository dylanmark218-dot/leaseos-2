/**
 * A board tile about "me as an operator" reads the caller's operator record, found through
 * `operators.userId` in the acting organization — never a user id standing in for an operator id.
 *
 * The two are different identities drawn from different sequences. When they differ, a tile
 * that passes the user id where an operator id is expected answers about whichever operator
 * happens to carry that number. So most cases here build the collision on purpose: the caller
 * is user A, their own operator record is B, and a bystander operator exists whose id is A,
 * with data that is visibly not the caller's.
 *
 * documentExpiry and unitReadiness are read through the real board (`widgets.boardResolve`).
 * hosRemaining is device-local on every board the planner builds today, so the server path is
 * driven through the reader directly with a server-side task — the path exists, and the day the
 * planner sends it there it must already be right.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { operatorForUserInScope } from "./db";
import { composeReadiness } from "./readinessComposer";
import { widgetReaderFor } from "./widgetSources";
import type { OperatorResolution } from "./_core/operatorIdentity";
import type { ResolveTask } from "./_core/widgetDashboard";
import type { WidgetPayload } from "./_core/widgetPayload";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const DAY = 86_400_000;

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function grant(userId: number, orgRef: string | null) {
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, "dispatcher"]);
}
async function operator(o: { name: string; userId: number | null; orgRef: string | null; licenceInDays: number }) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?,?,?)", [o.userId, o.name, new Date(Date.now() + o.licenceInDays * DAY)]);
  if (o.orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [o.orgRef, "operator", r.insertId]);
  return r.insertId;
}
async function document(operatorId: number, docType: string) {
  await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator',?,?,?,NOW(),?,'verified')", [operatorId, docType, docType, new Date(Date.now() + 10 * DAY)]);
}
async function unit(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, "unit", u.insertId]);
  return u.insertId;
}
/** No account has ever been given this id — so it can be handed to the caller without borrowing anyone's grants. */
async function unusedUserId(id: number) {
  const [m] = await pool.execute<mysql.RowDataPacket[]>("SELECT 1 FROM organizationMemberships WHERE userId = ? UNION ALL SELECT 1 FROM userRoleAssignments WHERE userId = ? UNION ALL SELECT 1 FROM operators WHERE userId = ?", [id, id, id]);
  return m.length === 0;
}
/** An operator whose id is not yet anyone's user id; the caller will be given that id. */
async function bystanderWithFreeId(orgRef: string | null) {
  for (;;) {
    const id = await operator({ name: "Bystander", userId: null, orgRef, licenceInDays: -10 });
    if (await unusedUserId(id)) { await document(id, "bystander_only"); return id; }
  }
}

/**
 * The collision, built on purpose: the bystander operator is inserted first, and the caller is
 * given a user id equal to the bystander's operator id. The caller's own operator record (if
 * any) is inserted after, so its id is different.
 */
async function collision(opts: { bystanderOrg: "same" | "other"; callerOperator: "same_org" | "other_org" | "none" }) {
  const actingOrg = await org();
  const elsewhere = await org();
  const bystander = await bystanderWithFreeId(opts.bystanderOrg === "same" ? actingOrg : elsewhere);
  const userId = bystander;
  await grant(userId, actingOrg);
  let own: number | null = null;
  if (opts.callerOperator !== "none") {
    own = await operator({ name: "Caller", userId, orgRef: opts.callerOperator === "same_org" ? actingOrg : elsewhere, licenceInDays: 400 });
    await document(own, "caller_only");
    expect(own).not.toBe(userId);
  }
  return { userId, bystander, own, unitId: await unit(actingOrg), actingOrg };
}

async function board(userId: number, unitId: number) {
  const saved = await callerFor(userId).widgets.layoutSave({
    layoutRef: null, deviceClass: "desktop", name: "Mine", isDefault: true,
    items: [
      { instanceRef: "docs", widgetKey: "documentExpiry", variant: "list", position: 0, options: { warnDays: 30 } },
      { instanceRef: "ready", widgetKey: "unitReadiness", variant: "status", position: 1, subjectRef: String(unitId) },
    ],
  });
  expect("ok" in saved && saved.ok).toBe(true);
  const b = await callerFor(userId).widgets.boardResolve({ deviceClass: "desktop", connected: true, subjects: {} });
  const tile = (ref: string) => b.tiles.find(t => t.instanceRef === ref)!.payload;
  return { docs: tile("docs"), ready: tile("ready") };
}

/** The reader as routers.ts builds it, with the readiness call observed and the operator lookup counted. */
function reader(userId: number, tenantId: string) {
  const readinessAskedFor: number[] = [];
  let lookups = 0;
  const actor = { userId, tenantId, roleKey: "DISPATCHER", permissions: [], roles: ["DISPATCHER"] as [string] };
  const read = widgetReaderFor(
    actor,
    (id) => callerFor(id) as never,
    (): Promise<OperatorResolution> => { lookups++; return operatorForUserInScope(userId, { tenantId }); },
    async (s) => { readinessAskedFor.push(s.operatorId); return composeReadiness(s); },
  );
  const task = (widgetKey: string, subjectRef: string | null = null) => read({
    order: 0, instanceRef: widgetKey, widgetKey, variant: "status", procedure: widgetKey, subjectRef,
    options: null, deviceLocal: false, maxStaleMinutes: null, servedFromCache: false,
  } as ResolveTask);
  return { task, readinessAskedFor, lookups: () => lookups };
}

type Payload = WidgetPayload<unknown>;
const docTypes = (p: Payload) => p.state === "ok" ? (p.value as { documents: { docType: string }[] }).documents.map(x => x.docType) : null;
/*
 * The bystander's mark is an expired licence (its legacy date passed ten days ago). The caller's
 * legacy date runs 400 days — which, since SPINE item 2, is an unverified licence and so an
 * overridable unknown, not a clearance. What tells the two operators apart is the expiry.
 */
const licenceBlockers = (p: Payload) => p.state === "ok"
  ? (p.value as { eligibility: { blockers: { code: string }[] } }).eligibility.blockers.map(b => b.code).filter(c => c === "operator_licence_expired")
  : null;
const hosOperator = (p: Payload) => p.state === "ok" ? (p.value as { operatorId: number }).operatorId : null;
function expectUnknown(p: Payload, reason: RegExp) {
  expect(p.state).toBe("unknown");
  if (p.state !== "unknown") throw new Error("unreachable");
  expect(p.reason).toMatch(reason);
}

d("self-scoped tiles resolve the caller's operator record, not an operator that shares their user id", () => {
  it("user id ≠ operator id: documentExpiry lists the caller's own operator's documents only", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "same_org" });
    const { docs } = await board(w.userId, w.unitId);
    expect(docs.state).toBe("ok");
    expect(docTypes(docs)).toEqual(["caller_only"]);
  }, 30_000);

  it("user id ≠ operator id: unitReadiness composes the caller's own operator, not the bystander", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "same_org" });
    const { ready } = await board(w.userId, w.unitId);
    expect(ready.state).toBe("ok");
    // The bystander's licence expired ten days ago; the caller's runs another 400 days.
    expect(licenceBlockers(ready)).toEqual([]);
  }, 30_000);

  it("user id ≠ operator id: all three tiles on the server path name the caller's operator, and the lookup runs once", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "same_org" });
    const r = reader(w.userId, w.actingOrg);
    const [hos, docs, ready] = [await r.task("hosRemaining"), await r.task("documentExpiry"), await r.task("unitReadiness", String(w.unitId))];
    expect(hosOperator(hos)).toBe(w.own);
    expect(docTypes(docs)).toEqual(["caller_only"]);
    expect(r.readinessAskedFor).toEqual([w.own]);
    expect(licenceBlockers(ready)).toEqual([]);
    expect(r.readinessAskedFor).not.toContain(w.bystander);
    expect(r.lookups()).toBe(1);
  }, 30_000);

  it("user id = operator id by coincidence: still the caller's own record, found the same way", async () => {
    const acting = await org();
    let own = 0;
    for (;;) { own = await operator({ name: "Caller", userId: null, orgRef: acting, licenceInDays: 400 }); if (await unusedUserId(own)) break; }
    await pool.execute("UPDATE operators SET userId = ? WHERE id = ?", [own, own]);
    await document(own, "caller_only");
    await grant(own, acting);
    const r = reader(own, acting);
    expect(hosOperator(await r.task("hosRemaining"))).toBe(own);
    expect(docTypes(await r.task("documentExpiry"))).toEqual(["caller_only"]);
    const { docs } = await board(own, await unit(acting));
    expect(docTypes(docs)).toEqual(["caller_only"]);
  }, 30_000);

  it("no operator record: unknown, and nothing of the bystander's", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "none" });
    const r = reader(w.userId, w.actingOrg);
    for (const p of [await r.task("hosRemaining"), await r.task("documentExpiry"), await r.task("unitReadiness", String(w.unitId))]) {
      expectUnknown(p, /no operator record/);
    }
    expect(r.readinessAskedFor).toEqual([]);
    const { docs, ready } = await board(w.userId, w.unitId);
    expectUnknown(docs, /no operator record/);
    expectUnknown(ready, /no operator record/);
  }, 30_000);

  it("the caller's operator record belongs to another organization: not theirs here — unknown, never the bystander", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "other_org" });
    const r = reader(w.userId, w.actingOrg);
    for (const p of [await r.task("hosRemaining"), await r.task("documentExpiry"), await r.task("unitReadiness", String(w.unitId))]) {
      expectUnknown(p, /no operator record/);
    }
    expect(r.readinessAskedFor).toEqual([]);
  }, 30_000);

  it("a bystander in another tenant whose id is the caller's user id is not reachable", async () => {
    const w = await collision({ bystanderOrg: "other", callerOperator: "same_org" });
    const r = reader(w.userId, w.actingOrg);
    expect(hosOperator(await r.task("hosRemaining"))).toBe(w.own);
    expect(docTypes(await r.task("documentExpiry"))).toEqual(["caller_only"]);
    await r.task("unitReadiness", String(w.unitId));
    expect(r.readinessAskedFor).toEqual([w.own]);

    const alone = await collision({ bystanderOrg: "other", callerOperator: "none" });
    const r2 = reader(alone.userId, alone.actingOrg);
    expectUnknown(await r2.task("hosRemaining"), /no operator record/);
    expectUnknown(await r2.task("documentExpiry"), /no operator record/);
    expectUnknown(await r2.task("unitReadiness", String(alone.unitId)), /no operator record/);
    expect(r2.readinessAskedFor).toEqual([]);
  }, 30_000);

  it("two operator records name the caller in the acting organization: ambiguous, unknown — never the first row", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "same_org" });
    const second = await operator({ name: "Caller again", userId: w.userId, orgRef: w.actingOrg, licenceInDays: 400 });
    await document(second, "second_record");
    expect(await operatorForUserInScope(w.userId, { tenantId: w.actingOrg })).toEqual({ kind: "ambiguous" });
    const r = reader(w.userId, w.actingOrg);
    for (const p of [await r.task("hosRemaining"), await r.task("documentExpiry"), await r.task("unitReadiness", String(w.unitId))]) {
      expectUnknown(p, /more than one operator record/);
    }
    expect(r.readinessAskedFor).toEqual([]);
  }, 30_000);

  it("a second record in another organization does not make the acting one ambiguous", async () => {
    const w = await collision({ bystanderOrg: "same", callerOperator: "same_org" });
    await operator({ name: "Caller elsewhere", userId: w.userId, orgRef: await org(), licenceInDays: 400 });
    expect(await operatorForUserInScope(w.userId, { tenantId: w.actingOrg })).toEqual({ kind: "resolved", operatorId: w.own });
  }, 30_000);

  it("the historical single tenant: an unowned operator record is the caller's; an owned one is not", async () => {
    const bystander = await bystanderWithFreeId(null);
    const userId = bystander;
    await grant(userId, null);
    const own = await operator({ name: "Caller", userId, orgRef: null, licenceInDays: 400 });
    await document(own, "caller_only");
    expect(await operatorForUserInScope(userId, { tenantId: "default" })).toEqual({ kind: "resolved", operatorId: own });
    const r = reader(userId, "default");
    expect(hosOperator(await r.task("hosRemaining"))).toBe(own);
    expect(docTypes(await r.task("documentExpiry"))).toEqual(["caller_only"]);

    // Owned by an organization, the same record is not the single tenant's to use.
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [await org(), "operator", own]);
    expect(await operatorForUserInScope(userId, { tenantId: "default" })).toEqual({ kind: "none" });
  }, 30_000);
});
