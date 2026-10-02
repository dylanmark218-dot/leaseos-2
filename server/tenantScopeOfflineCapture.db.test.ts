/**
 * S4 — an offline capture reference is not a shared namespace.
 *
 * `clientCaptureRef` is an 8-to-80 character string the DEVICE picks, and the
 * upload path uses it to decide "you already sent me this, here it is". It was
 * globally unique and the lookup had no scope at all, so on a collision the
 * server answered another organization's row:
 *
 *     const existing = await findEvidenceByClientCaptureRef(input.clientCaptureRef);
 *     if (existing) return { id: existing.id, key: existing.storageKey, alreadyUploaded: true };
 *
 * — handing the caller another company's evidence id and storage key, while the
 * evidence they were uploading was discarded unstored. One request, a disclosure
 * and a data loss.
 *
 * Scoped to the capturing USER rather than the organization, which is both
 * tighter and truer: idempotency here means "this handset is retrying", and two
 * people in one company carry two handsets whose capture counters are unrelated.
 * It also needs no ownership inference — `capturedBy` is written from the
 * authenticated caller, so the scope is a fact about the row rather than a chain
 * to resolve. The runtime contract already intended this: a capture reference is
 * documented as `${deviceRef}:${localId}`, device-scoped by construction. The
 * server simply never enforced it, and a server must not depend on clients being
 * well behaved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

// The upload path writes through the storage layer; kept in memory here, as
// auditPackage.test and commercialOffice.db.test do. Declared before the router
// import so the mock is in place when the module graph loads.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 932_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

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
type Uploaded = { id: number; key: string; alreadyUploaded?: boolean };
const upload = (userId: number, title: string, clientCaptureRef: string) =>
  callerFor(userId).fieldRoute.evidence.upload({
    title, category: "field_ticket", fileName: "photo.jpg", mimeType: "image/jpeg",
    dataBase64: Buffer.from(`bytes for ${title}`).toString("base64"), clientCaptureRef,
  } as never) as Promise<Uploaded>;

d("S4 — an offline capture reference is not a shared namespace", () => {
  it("does not hand one organization another's stored evidence because the refs match", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]), driverB = await member(B, ["driver"]);
    const SAME = `capture-${rnd()}-${rnd()}`;

    const a = await upload(driverA, "A's ticket", SAME);
    const b = await upload(driverB, "B's ticket", SAME);

    expect(b.id).not.toBe(a.id);
    expect(b.alreadyUploaded).toBeFalsy();
    expect(b.key).not.toBe(a.key);

    // B's upload was actually stored, not silently discarded.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT title, capturedBy FROM evidenceRecords WHERE id = ?", [b.id],
    );
    expect(rows[0].title).toBe("B's ticket");
    expect(Number(rows[0].capturedBy)).toBe(driverB);
  }, 30_000);

  it("still deduplicates a device retrying its own capture", async () => {
    // The counter-test: idempotency is the point of the column and must survive.
    const A = await org();
    const driverA = await member(A, ["driver"]);
    const SAME = `capture-${rnd()}-${rnd()}`;

    const first = await upload(driverA, "Retried ticket", SAME);
    const again = await upload(driverA, "Retried ticket", SAME);
    expect(again.id).toBe(first.id);
    expect(again.alreadyUploaded).toBe(true);
  }, 30_000);

  it("keeps two people in one organization from deduplicating onto each other", async () => {
    // Scoped per capturing user, not per organization: two handsets in one
    // company have unrelated capture counters, and merging them would lose one
    // person's evidence just as surely as merging across companies would.
    const A = await org();
    const one = await member(A, ["driver"]), two = await member(A, ["driver"]);
    const SAME = `capture-${rnd()}-${rnd()}`;

    const first = await upload(one, "One's ticket", SAME);
    const second = await upload(two, "Two's ticket", SAME);
    expect(second.id).not.toBe(first.id);
    expect(second.alreadyUploaded).toBeFalsy();
  }, 30_000);
});
