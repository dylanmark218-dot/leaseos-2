/**
 * SEC-1 — a document delivery is updated only in the book that owns the document.
 *
 * `commercialDocumentDeliveries` has no organization of its own; a delivery belongs to its
 * document's book. `deliveryRecord` checked that book; `deliveryUpdate` found the delivery by
 * reference and wrote to it — so another company could mark this company's invoice delivered,
 * failed or acknowledged, and set its evidence. Across the boundary: not found. Baseline V8.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 945_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function office(orgRef: string) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,'office','global',1,NOW())", [userId]);
  return userId;
}
async function delivery(bookOrgRef: string, by: number) {
  const [doc] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO commercialDocuments (documentRef, documentType, title, contentHash, registeredByUserId, bookOrgRef, status) VALUES (?, 'invoice', ?, ?, ?, ?, 'current')",
    [`DOC-${rnd()}`, `Invoice ${rnd()}`, "a".repeat(64), by, bookOrgRef],
  );
  const deliveryRef = `DLV-${rnd()}`;
  await pool.execute("INSERT INTO commercialDocumentDeliveries (deliveryRef, documentId, channel, status) VALUES (?, ?, 'email', 'sent')", [deliveryRef, doc.insertId]);
  return deliveryRef;
}

d("a document delivery is updated only in the book that owns the document", () => {
  it("another organization's update is not found and writes nothing; the owner's lands", async () => {
    const A = await org(), B = await org();
    const officeA = await office(A), officeB = await office(B);
    const ref = await delivery(B, officeB);

    await expect(callerFor(officeA).commercialOffice.documents.deliveryUpdate({ deliveryRef: ref, status: "acknowledged", deliveryEvidence: "spoofed receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [[row]] = (await pool.query("SELECT status, deliveryEvidence FROM commercialDocumentDeliveries WHERE deliveryRef = ?", [ref])) as unknown as [[{ status: string; deliveryEvidence: string | null }]];
    expect(row).toMatchObject({ status: "sent", deliveryEvidence: null });

    await expect(callerFor(officeB).commercialOffice.documents.deliveryUpdate({ deliveryRef: ref, status: "delivered" })).resolves.toMatchObject({ status: "delivered" });
  }, 60_000);
});
