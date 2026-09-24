/**
 * A board tile about "me as an operator" reads the caller's operator record, found through
 * `operators.userId` in the acting organization — never a user id standing in for an operator id.
 *
 * The two are different identities drawn from different sequences. When they differ, a tile
 * that passes the user id where an operator id is expected answers about whichever operator
 * happens to carry that number. So every case here builds the collision on purpose: the
 * caller is user A, their own operator record is B, and a second operator exists whose id is
 * A, with data that is visibly not the caller's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

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
async function member(userId: number, orgRef: string, role: string) {
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
}
async function operator(o: { name: string; userId: number | null; orgRef: string | null; licenceInDays: number }) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?,?,?)", [o.userId, o.name, new Date(Date.now() + o.licenceInDays * DAY)]);
  if (o.orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [o.orgRef, "operator", r.insertId]);
  return r.insertId;
}
async function document(operatorId: number, docType: string) {
  await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator',?,?,?,NOW(),?,'verified')", [operatorId, docType, docType, new Date(Date.now() + 10 * DAY)]);
}
/** No account has ever been given this id — so it can be handed to the caller without borrowing anyone's grants. */
async function unusedUserId(id: number) {
  const [m] = await pool.execute<mysql.RowDataPacket[]>("SELECT 1 FROM organizationMemberships WHERE userId = ? UNION ALL SELECT 1 FROM userRoleAssignments WHERE userId = ? UNION ALL SELECT 1 FROM operators WHERE userId = ?", [id, id, id]);
  return m.length === 0;
}

/**
 * The collision, built on purpose: an operator (the bystander) is inserted first, and the caller
 * is given a user id equal to the bystander's operator id. The caller's own operator record is
 * then inserted, so its id is different.
 */
async function collision(opts: { bystanderOrg: "same" | "other"; callerOperator: "same_org" | "other_org" | "none" }) {
  const actingOrg = await org();
  const elsewhere = await org();
  let bystander = 0;
  for (;;) {
    bystander = await operator({ name: "Bystander", userId: null, orgRef: opts.bystanderOrg === "same" ? actingOrg : elsewhere, licenceInDays: -10 });
    if (await unusedUserId(bystander)) break;
  }
  const userId = bystander;
  await member(userId, actingOrg, "dispatcher");
  await document(bystander, "bystander_only");
  let own: number | null = null;
  if (opts.callerOperator !== "none") {
    own = await operator({ name: "Caller", userId, orgRef: opts.callerOperator === "same_org" ? actingOrg : elsewhere, licenceInDays: 400 });
    await document(own, "caller_only");
  }
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [actingOrg, "unit", u.insertId]);
  expect(own).not.toBe(userId);
  return { userId, bystander, own, unitId: u.insertId, actingOrg };
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
const docTypes = (p: { state: string }) => p.state === "ok" ? (p as { value: { documents: { docType: string }[] } }).value.documents.map(x => x.docType) : null;
const blockerCodes = (p: { state: string }) => p.state === "ok" ? (p as { value: { eligibility: { blockers: { code: string }[] } } }).value.eligibility.blockers.map(b => b.code) : null;

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
    const codes = blockerCodes(ready)!;
    expect(codes.some(c => c.startsWith("operator_licence"))).toBe(false);
  }, 30_000);
});
