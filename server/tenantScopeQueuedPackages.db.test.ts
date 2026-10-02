/**
 * S3 — a queued package reference is not a shared namespace.
 *
 * `records.evidence.queueSend` takes `packageRef` as a string the CLIENT picks
 * (`z.string().min(4).max(64)`) and `createSyncPackage` used it, alone, to decide
 * whether the package already existed:
 *
 *     const existing = await db.select({ id, itemCount }).from(syncPackages)
 *       .where(eq(syncPackages.packageRef, args.packageRef)).limit(1);
 *     if (existing[0]) return { created: false, itemCount: existing[0].itemCount };
 *
 * Backed by a GLOBAL unique index, two companies whose clients agreed on a
 * string were one namespace. The caller was handed another organization's item
 * count and told their send had already been queued, while their own package was
 * never written — the same one-request disclosure-and-data-loss as the offline
 * capture reference (0224), reached through a different door.
 *
 * The evidence ids in the same call are already scoped (P4.1). The package
 * reference was the one client-chosen identifier in the procedure that nothing
 * checked, which is exactly how this class of defect survives: the obvious field
 * gets a boundary and the envelope around it does not.
 *
 * Scoped to the OPERATOR, because that is what the row records as its owner and
 * it is resolved from the authenticated caller rather than supplied — the same
 * reasoning as `capturedBy` in 0224. `deviceId` sits in the same request as
 * `packageRef` and is just as unvalidated, so it is no boundary at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 934_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
/** A driver with an operator identity of their own: `evidence.send` plus the row the package is attributed to. */
async function driverIn(orgRef: string) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,'driver','global',1,NOW())", [userId]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId) VALUES (?,?)", [`Driver ${rnd()}`, userId]);
  return { userId, operatorId: op.insertId };
}
/** Evidence owned by `orgRef` through the authoritative chain: its job. */
async function evidenceIn(orgRef: string, userId: number) {
  const [job] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
    [`JOB-${rnd()}`, "hydrovac", "Northgate Energy Ltd.", "16-22-079-11 W6M", orgRef],
  );
  const [ev] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO evidenceRecords (jobId, title, category, storageKey, capturedAt, capturedBy, status) VALUES (?,?,?,?,NOW(),?, 'needs_review')",
    [job.insertId, `Ticket ${rnd()}`, "field_ticket", `evidence/${rnd()}/photo.jpg`, userId],
  );
  return ev.insertId;
}

type Queued = { packageRef: string; created: boolean; queued: number };
const queueSend = (userId: number, packageRef: string, evidenceIds: number[], deviceId = `DEV-${rnd()}`) =>
  callerFor(userId).records.evidence.queueSend({ packageRef, deviceId, evidenceIds } as never) as Promise<Queued>;

/** The answer with the caller's own choice of reference blanked out by key. */
const say = (value: unknown) => JSON.stringify(value, (k, v) => (k === "packageRef" ? "<pkg>" : v));

d("S3 — a queued package reference is not a shared namespace", () => {
  it("does not answer another organization's queued package, nor drop the caller's own", async () => {
    const A = await org(), B = await org();
    const a = await driverIn(A), b = await driverIn(B);
    const SAME = `PKG-${rnd()}-${rnd()}`;

    // A's package, already queued, carrying a count B must not learn.
    await pool.execute(
      "INSERT INTO syncPackages (packageRef, deviceId, operatorId, state, itemCount, queuedAt) VALUES (?,?,?,'queued',7,NOW())",
      [SAME, `DEV-${rnd()}`, a.operatorId],
    );

    const bEvidence = await evidenceIn(B, b.userId);
    const collided = await queueSend(b.userId, SAME, [bEvidence]);
    const fresh = await queueSend(b.userId, `PKG-${rnd()}-${rnd()}`, [bEvidence]);

    // Colliding with a stranger's reference must be indistinguishable from not
    // colliding at all: that covers the disclosure and the silent drop at once.
    expect(say(collided)).toBe(say(fresh));

    // A's row is untouched — not re-counted, not re-attributed.
    const [aRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT itemCount, operatorId FROM syncPackages WHERE packageRef = ? AND operatorId = ?", [SAME, a.operatorId],
    );
    expect(Number(aRows[0].itemCount)).toBe(7);

    // And B's own package was actually written, under B's operator.
    const [bRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM syncPackages WHERE packageRef = ? AND operatorId = ?", [SAME, b.operatorId],
    );
    expect(Number(bRows[0].n)).toBe(1);
  }, 30_000);

  it("still treats a client retrying its own reference as the same package", async () => {
    // The counter-test: idempotency is the whole point of the procedure and must
    // survive. An offline client retries, and the retry must not queue twice.
    const A = await org();
    const a = await driverIn(A);
    const evidence = await evidenceIn(A, a.userId);
    const MINE = `PKG-${rnd()}-${rnd()}`;

    const first = await queueSend(a.userId, MINE, [evidence]);
    const again = await queueSend(a.userId, MINE, [evidence]);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM syncPackages WHERE packageRef = ?", [MINE],
    );
    expect(Number(rows[0].n)).toBe(1);
  }, 30_000);
});
