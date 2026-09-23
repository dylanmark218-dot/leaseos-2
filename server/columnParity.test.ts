import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "../drizzle/schema";

/**
 * Column-level parity.
 *
 * `verify-parity.sh` counts tables, and that check has caught real drift. But
 * it is blind below the table: in v20.15 migration 0026 declared
 * `fundingClaims.fundingOpportunityId int NOT NULL` while `schema.ts` declared
 * it nullable, and nothing noticed. The TypeScript types said null was fine;
 * the database would have rejected the insert at runtime — the worst kind of
 * disagreement, because every static check passes.
 *
 * It only got reconciled because a later migration happened to ALTER the
 * column. That is luck, not a guard. This is the guard.
 *
 * For every table drizzle knows about, every column's nullability must match
 * what the live database — the migrations, applied — actually enforces.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

type LiveColumn = { table: string; column: string; nullable: boolean; hasDefault: boolean; generated: boolean };

async function liveColumns(): Promise<Map<string, LiveColumn>> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT table_name AS t, column_name AS c, is_nullable AS n, column_default AS dflt, extra
     FROM information_schema.columns
     WHERE table_schema = DATABASE()`
  );
  const out = new Map<string, LiveColumn>();
  for (const r of rows) {
    out.set(`${r.t}.${r.c}`, {
      table: String(r.t),
      column: String(r.c),
      nullable: String(r.n) === "YES",
      hasDefault: r.dflt !== null || /auto_increment|DEFAULT_GENERATED/i.test(String(r.extra ?? "")),
      // STORED GENERATED / VIRTUAL GENERATED. The database computes it; no
      // INSERT may name it.
      generated: /GENERATED/i.test(String(r.extra ?? "")) && !/DEFAULT_GENERATED/i.test(String(r.extra ?? "")),
    });
  }
  return out;
}

function drizzleTables(): MySqlTable[] {
  // `Object.values(schema)` is a union of every export — tables, enums, relations, types — and
  // narrowing straight to MySqlTable is unsound because that union does not contain it as a
  // subtype. The runtime filter was always right; the predicate just could not be checked, which
  // is the whole reason test files were worth type-checking.
  return (Object.values(schema) as unknown[]).filter((v): v is MySqlTable => is(v, MySqlTable));
}

d("column-level parity between schema.ts and the applied migrations", () => {
  it("declares the same nullability for every column", async () => {
    const live = await liveColumns();
    const mismatches: string[] = [];

    for (const table of drizzleTables()) {
      const name = getTableName(table);
      for (const [, col] of Object.entries(getTableColumns(table))) {
        const key = `${name}.${col.name}`;
        const actual = live.get(key);
        if (!actual) {
          mismatches.push(`${key}: in schema.ts, not in database`);
          continue;
        }
        const schemaNullable = !col.notNull;
        if (schemaNullable !== actual.nullable) {
          mismatches.push(
            `${key}: schema.ts says ${schemaNullable ? "NULL" : "NOT NULL"}, database says ${actual.nullable ? "NULL" : "NOT NULL"}`
          );
        }
      }
    }

    expect(
      mismatches,
      "A column's nullability differs between schema.ts and the applied migrations. " +
        "TypeScript will accept what the database rejects (or the reverse). Fix the " +
        "migration with a forward ALTER, or fix schema.ts — never both silently."
    ).toEqual([]);
  });

  it("has no database column that schema.ts does not know about", async () => {
    const live = await liveColumns();
    const known = new Set<string>();
    for (const table of drizzleTables()) {
      const name = getTableName(table);
      for (const col of Object.values(getTableColumns(table))) known.add(`${name}.${col.name}`);
    }
    /*
     * A GENERATED column is deliberately absent from schema.ts.
     *
     * MySQL accepts a generated column in an INSERT column list only when the
     * value is DEFAULT; an explicit value is error 1906. Declaring one is
     * therefore safe right up until somebody sets it, which is a trap rather
     * than a contract — and nothing in the application has a reason to read or
     * write these: they exist to carry a unique index the database enforces.
     * `userRoleAssignments.activeGrantKey` predates this and IS declared, which
     * is why the exclusion is by the database's own GENERATED flag rather than
     * by a name list.
     *
     * They are listed rather than merely skipped, so a new one is a decision
     * somebody makes in a diff.
     */
    const generated = Array.from(live.values()).filter(c => c.generated).map(c => `${c.table}.${c.column}`).sort();
    expect(generated, "a new generated column appeared").toEqual([
      // 0172 — COALESCE(orgRef, '~unattributed'), the column the tenant-relative
      // unique indexes are built on. NULLs are distinct inside a unique index,
      // so keying on the nullable owner directly would drop the constraint
      // exactly where there is one tenant to protect.
      "billingBooks.orgKey", "calibrationSweeps.orgKey", "commercialApprovals.orgKey",
      "commercialDocuments.orgKey", "customerCredits.orgKey", "delayEvents.orgKey",
      "disposalTickets.orgKey",
      // 0173 — the same device, for the two identifiers the DEVICE chooses
      // rather than the server minting them: COALESCE(capturedBy, -1) and
      // COALESCE(fieldDeviceId, -1). Sentinels no real id can take, for the
      // reason above — a composite over the nullable owner would constrain
      // nothing on exactly the rows that need it. Listed in sort order, which
      // is why they are not together.
      "evidenceRecords.captureOwnerKey",
      "fieldTickets.orgKey", "invoices.orgKey",
      "manifestReconciliationOverrides.orgKey", "signatoryAuthorities.orgKey",
      "syncPackages.deviceKey",
      "trackingReferences.orgKey", "trackingSequences.orgKey",
      // Predates this work: the partial-uniqueness key for a live role grant.
      "userRoleAssignments.activeGrantKey",
      "writeOffRequests.orgKey",
    ]);

    const orphans = Array.from(live.values()).filter(c => !c.generated).map(c => `${c.table}.${c.column}`).filter(k => !known.has(k));
    expect(
      orphans,
      "The database has a column schema.ts does not declare. It exists but nothing can read or write it typed."
    ).toEqual([]);
  });

  it("covers every table the table-count check covers", async () => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()`
    );
    expect(drizzleTables().length).toBe(Number(rows[0].n));
  });

  it("audits a meaningful number of columns", async () => {
    const live = await liveColumns();
    expect(live.size).toBeGreaterThan(1800);
  });
});
