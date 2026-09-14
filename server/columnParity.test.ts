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

type LiveColumn = { table: string; column: string; nullable: boolean; hasDefault: boolean };

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
    });
  }
  return out;
}

function drizzleTables(): MySqlTable[] {
  return Object.values(schema).filter((v): v is MySqlTable => is(v, MySqlTable));
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
    const orphans = Array.from(live.keys()).filter(k => !known.has(k));
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
