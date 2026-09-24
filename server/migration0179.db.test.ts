/**
 * 0179 — trip-stop provenance, reconciled forward from the sibling repository's 0169.
 *
 * Against the CI database, which `scripts/apply-migrations.sh` builds from 0001 to head in
 * order — so by the time this runs the pre-reconciliation schema (0001 … 0174) has already
 * migrated forward through 0179. What this proves on top of that:
 *
 *   - the five columns exist exactly once, with the nullability and types the migration
 *     and `schema.ts` both declare (column-level parity is `columnParity.test.ts`; this is
 *     the per-column shape the reader depends on);
 *   - the migration is idempotent in fact, not only in intent: its statements run a second
 *     time against a database that already carries the columns, succeed, and create nothing
 *     twice;
 *   - the migration sequence has no duplicate number, so the ledger's file-name ordering is
 *     total.
 *
 * Nothing here touches the `schemaMigrations` ledger table: CI applies files with the mysql
 * client and never creates the ledger, and `columnParity.test.ts` would report a table
 * `schema.ts` does not know.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { splitStatements } from "./_core/migrationLedger";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 });
});
afterAll(async () => {
  await pool?.end();
});

const MIGRATION = "drizzle/0179_trip_stop_provenance.sql";

const EXPECTED: Record<string, { type: RegExp; nullable: "YES" }> = {
  recordedByUserId: { type: /^int/, nullable: "YES" },
  recordedSource: { type: /^enum\('driver_voice','driver_typed','gps','photo_ocr','system_inferred','imported','human_corrected'\)$/, nullable: "YES" },
  updatedByUserId: { type: /^int/, nullable: "YES" },
  updatedSource: { type: /^enum\('driver_voice','driver_typed','gps','photo_ocr','system_inferred','imported','human_corrected'\)$/, nullable: "YES" },
  updatedAt: { type: /^timestamp$/, nullable: "YES" },
};

async function provenanceColumns() {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT column_name AS c, column_type AS t, is_nullable AS n
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'tripStops'
       AND column_name IN ('recordedByUserId','recordedSource','updatedByUserId','updatedSource','updatedAt')`,
  );
  return rows.map(r => ({ column: String(r.c), type: String(r.t), nullable: String(r.n) }));
}

describe("the migration sequence", () => {
  it("has no two files claiming one number, beyond the one historical pair", () => {
    // `0157` is used twice and has been since before this repository was imported
    // (docs/architecture/MIGRATION_COLLISION_REGISTER.md). Applied history is not
    // renamed to make a guard pass; it is named here so a second pair cannot hide behind it.
    const HISTORICAL = ["0157"];
    const numbers = readdirSync("drizzle").filter(f => /^\d{4}_.*\.sql$/.test(f)).map(f => f.slice(0, 4));
    const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    expect(dupes).toEqual(HISTORICAL);
  });

  it("carries 0179 as trip-stop provenance, adding exactly the five columns and nothing else", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE `tripStops`/);
    const added = Array.from(statements[0]!.matchAll(/ADD COLUMN IF NOT EXISTS `(\w+)`/g)).map(m => m[1]);
    expect(added).toEqual(["recordedByUserId", "recordedSource", "updatedByUserId", "updatedSource", "updatedAt"]);
    expect(statements[0]).not.toMatch(/NOT NULL|INDEX|DROP|CREATE TABLE/);
  });
});

d("0179 against the database the gate built", () => {
  it("added the five columns once, nullable, with the declared types", async () => {
    const cols = await provenanceColumns();
    expect(cols.map(c => c.column).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const c of cols) {
      expect(c.nullable, `${c.column} nullability`).toBe(EXPECTED[c.column]!.nullable);
      expect(c.type, `${c.column} type`).toMatch(EXPECTED[c.column]!.type);
    }
  });

  it("is idempotent: running it again against the migrated schema succeeds and creates nothing twice", async () => {
    const before = await provenanceColumns();
    for (const statement of splitStatements(readFileSync(MIGRATION, "utf8"))) {
      await pool.query(statement);
    }
    const after = await provenanceColumns();
    expect(after).toEqual(before);
    expect(after).toHaveLength(5);
  });
});
