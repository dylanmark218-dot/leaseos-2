/**
 * SEC-1 item 3 — `documents.list` never returns a private credential's detail.
 *
 * Before: the list returned whole `complianceDocuments` rows, so a medical certificate's title,
 * identifier and storage key reached every holder of `compliance.read` (dispatchers, mechanics,
 * auditors, bookkeepers among them), and `documents.create` stored medical documents with
 * `privateDetail = false`. After: private rows are projected through
 * `PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED`, the same rule the passport already honoured, and
 * creation classifies by type. Baseline V4.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 941_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function operator(orgRef: string) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name) VALUES (?)", [`Driver ${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, o.insertId]);
  return o.insertId;
}

d("documents.list never returns a private credential's detail", () => {
  it("a medical document created through documents.create is stored private and listed without its detail", async () => {
    const A = await org();
    const office = await member(A, ["office"]), dispatcher = await member(A, ["dispatcher"]);
    const opId = await operator(A);
    const marker = rnd();
    await callerFor(office).fieldRoute.identity.documents.create({
      ownerType: "operator", ownerId: opId, docType: "medical_fitness", title: `Medical ${marker} — corrective lenses`,
      storageKey: `${office}/evidence/medical-${marker}.pdf`, capturedAt: new Date(), expiresAt: new Date("2027-06-01T00:00:00Z"), source: "clinic letter",
    } as never);
    const [stored] = await pool.query<mysql.RowDataPacket[]>("SELECT id, privateDetail FROM complianceDocuments WHERE ownerType='operator' AND ownerId=? AND docType='medical_fitness'", [opId]);
    expect(Number(stored[0]!.privateDetail)).toBe(1);

    for (const reader of [office, dispatcher]) {
      const rows = await callerFor(reader).fieldRoute.identity.documents.list({ ownerType: "operator", ownerId: opId });
      const med = rows.find(r => r.docType === "medical_fitness");
      expect(med).toBeDefined();
      expect(med).toMatchObject({ title: null, identifier: null, storageKey: null, storageUrl: null, source: null });   // complianceDocuments has no notes column
      expect(med!.expiresAt).toEqual(new Date("2027-06-01T00:00:00Z"));     // the renewal date stays: expiry is administrative
      expect(JSON.stringify(rows)).not.toContain(marker);
    }
  }, 60_000);

  it("a legacy medical row stored with privateDetail = false is still projected, and a licence is listed whole", async () => {
    const A = await org();
    const dispatcher = await member(A, ["dispatcher"]);
    const opId = await operator(A);
    const marker = rnd();
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, identifier, capturedAt, verificationStatus, privateDetail) VALUES ('operator', ?, 'medical_fitness', ?, ?, NOW(), 'verified', 0)",
      [opId, `Legacy medical ${marker}`, `MED-${marker}`],
    );
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, identifier, capturedAt, verificationStatus, privateDetail) VALUES ('operator', ?, 'drivers_licence', ?, ?, NOW(), 'verified', 0)",
      [opId, `Class 1 ${marker}`, `DL-${marker}`],
    );
    const rows = await callerFor(dispatcher).fieldRoute.identity.documents.list({ ownerType: "operator", ownerId: opId });
    expect(rows.find(r => r.docType === "medical_fitness")).toMatchObject({ title: null, identifier: null });
    expect(rows.find(r => r.docType === "drivers_licence")).toMatchObject({ title: `Class 1 ${marker}`, identifier: `DL-${marker}` });
  }, 60_000);
});
