/**
 * 0171 — what the backfill decided, checked against rows that existed before it.
 *
 * A backfill cannot be tested by the ordinary suites: the gate drops and
 * recreates the database, so by the time a test runs every migration has
 * already applied and there are no legacy rows left to classify. This suite
 * builds the situation the migration was written for — a database at 0170,
 * seeded with rows whose ownership varies from provable to unknowable — and
 * then applies 0171 and reads back what it did.
 *
 * The classification it must produce:
 *
 *   ATTRIBUTED      the authoritative chain proves one organization
 *   UNATTRIBUTED    it does not, and the row is left NULL
 *
 * The second is the one worth testing. Anybody can backfill the easy rows; the
 * failure this guards against is a migration that reaches for `"default"`, or
 * for the nearest organization-shaped column, when the chain runs out.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { execFileSync } from "node:child_process";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

/** Its own database: this suite migrates in stages and must not disturb the gate's. */
const DB = `mig0171_${Math.random().toString(36).slice(2, 8)}`;
let admin: mysql.Connection;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

function parse(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

function migrate(until?: string, from?: string) {
  const c = parse(DB_URL!);
  execFileSync("bash", ["scripts/apply-migrations.sh"], {
    env: {
      ...process.env,
      DATABASE_URL: `mysql://${c.user}:${c.password}@${c.host}:${c.port}/${DB}`,
      ...(until ? { LEASEOS_MIGRATE_UNTIL: until } : {}),
      ...(from ? { LEASEOS_MIGRATE_FROM: from } : {}),
    },
    stdio: "pipe",
  });
}

beforeAll(async () => {
  if (!DB_URL) return;
  const c = parse(DB_URL);
  admin = await mysql.createConnection({ ...c, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\`; CREATE DATABASE \`${DB}\`;`);
  migrate("0170");                       // the ledger as it stood before this migration
  pool = mysql.createPool({ ...c, database: DB, connectionLimit: 4 });
}, 240_000);

afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``); await admin.end(); }
});

d("0171 backfills only what the chain proves", () => {
  let ownedJobId = 0, orphanJobId = 0, orgA = "";
  let attributedTicket = 0, unattributedTicket = 0;
  let attributedRef = 0, unattributedRef = 0, danglingRef = 0;
  let sweepId = 0, authorityId = 0;

  it("applies 0171 over rows seeded at 0170", async () => {
    orgA = `ORG-${rnd()}`;
    await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgA, `org ${orgA}`]);

    // A job that belongs to an organization, and one that belongs to nobody —
    // the historical single tenant's, which is not the same as A's.
    const [owned] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
      [`JOB-${rnd()}`, "hydrovac", "Cust", "Loc", orgA]);
    ownedJobId = owned.insertId;
    const [orphan] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,NULL)",
      [`JOB-${rnd()}`, "hydrovac", "Cust", "Loc"]);
    orphanJobId = orphan.insertId;

    const [t1] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO fieldTickets (ticketNumber, jobId) VALUES (?,?)", [`FT-${rnd()}`, ownedJobId]);
    attributedTicket = t1.insertId;
    const [t2] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO fieldTickets (ticketNumber, jobId) VALUES (?,?)", [`FT-${rnd()}`, orphanJobId]);
    unattributedTicket = t2.insertId;

    // Three tracking references: one naming an owned job, one naming an
    // unowned job, and one naming an entity type the chain cannot resolve.
    const [r1] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, jobId, issuedAt) VALUES (?,?,?,?,NOW())",
      [`TRK-${rnd()}`, "JOB", ownedJobId, ownedJobId]);
    attributedRef = r1.insertId;
    const [r2] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, jobId, issuedAt) VALUES (?,?,?,?,NOW())",
      [`TRK-${rnd()}`, "JOB", orphanJobId, orphanJobId]);
    unattributedRef = r2.insertId;
    const [r3] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, issuedAt) VALUES (?,?,?,NOW())",
      [`TRK-${rnd()}`, "DSP", 987_654]);
    danglingRef = r3.insertId;

    // Two tables with no ownership chain at all.
    const [sw] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO calibrationSweeps (sweepRef, measurementDeviceId, calibrationEventId, suspectFrom, suspectTo, eventType, explanation, runByUserId)
       VALUES (?,?,?,NOW(),NOW(),?,?,?)`, [`CSW-${rnd()}`, 1, 1, "drift", "fixture", 1]);
    sweepId = sw.insertId;
    const [au] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO signatoryAuthorities (authorityRef, customerAccountId, signatoryName, recordedByUserId) VALUES (?,?,?,?)",
      [`SIG-${rnd()}`, 1, "A. Signatory", 1]);
    authorityId = au.insertId;

    migrate(undefined, "0171");   // the migration under test, and only it
    expect(true).toBe(true);
  }, 240_000);

  const orgOf = async (table: string, id: number) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(`SELECT orgRef FROM \`${table}\` WHERE id = ?`, [id]);
    return rows[0]?.orgRef ?? null;
  };

  it("ATTRIBUTED: a field ticket on an owned job inherits that organization", async () => {
    expect(await orgOf("fieldTickets", attributedTicket)).toBe(orgA);
  });

  it("UNATTRIBUTED: a field ticket on an unowned job is left NULL, not given 'default'", async () => {
    // The chain ends at a job nobody owns. Inventing an owner here — or reaching
    // for the single-tenant sentinel to satisfy a constraint — is the mistake.
    expect(await orgOf("fieldTickets", unattributedTicket)).toBeNull();
  });

  it("ATTRIBUTED: a tracking reference naming an owned job inherits it", async () => {
    expect(await orgOf("trackingReferences", attributedRef)).toBe(orgA);
  });

  it("UNATTRIBUTED: a tracking reference naming an unowned job stays NULL", async () => {
    expect(await orgOf("trackingReferences", unattributedRef)).toBeNull();
  });

  it("UNATTRIBUTED: a reference whose entity type the chain cannot resolve stays NULL", async () => {
    // A disposal reference is not one of the resolvable subjects. It is not
    // attributed by proximity to anything.
    expect(await orgOf("trackingReferences", danglingRef)).toBeNull();
  });

  it("UNATTRIBUTED: tables with no ownership chain are untouched", async () => {
    expect(await orgOf("calibrationSweeps", sweepId)).toBeNull();
    // customerAccountId names the counterparty, not the owner — attributing a
    // record to the company it is ABOUT is the inference this forbids.
    expect(await orgOf("signatoryAuthorities", authorityId)).toBeNull();
  });

  it("writes no literal 'default' anywhere it touched", async () => {
    for (const t of ["trackingReferences", "trackingSequences", "fieldTickets", "disposalTickets",
      "billingBooks", "delayEvents", "invoices", "customerCredits", "writeOffRequests",
      "manifestReconciliationOverrides", "calibrationSweeps", "signatoryAuthorities"]) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM \`${t}\` WHERE orgRef = 'default'`);
      expect(rows[0].n, `${t} was backfilled with the single-tenant sentinel`).toBe(0);
    }
  });

  it("leaves the column nullable, so nothing was forced to choose an owner", async () => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT table_name AS t, is_nullable AS n FROM information_schema.columns
        WHERE table_schema = ? AND column_name = 'orgRef'
          AND table_name IN ('trackingReferences','trackingSequences','fieldTickets','invoices')`, [DB]);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.n, `${r.t}.orgRef`).toBe("YES");
  });
});
