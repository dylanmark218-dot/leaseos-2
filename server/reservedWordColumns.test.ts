import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reserved-word columns.
 *
 * Twice now a column name that MariaDB treats as a reserved word has cost real
 * debugging time. `procedure` was caught before release and renamed. `precision`
 * was not — it shipped in migration 0014, and it surfaced when a DB-backed test
 * wrote raw SQL against `proposalFields` and got a syntax error that pointed at
 * the line after the real problem.
 *
 * The failure mode is nasty because Drizzle quotes identifiers, so the ORM path
 * works perfectly and only hand-written SQL breaks. A column can sit there for
 * months looking fine.
 *
 * So this file does two things:
 *
 *   1. Pins the known set, empirically. Adding a new reserved-word column makes
 *      the DB test fail, at which point you rename it *before* it is released
 *      rather than living with it forever.
 *
 *   2. Scans the codebase for raw SQL that references a known reserved column
 *      without backticks.
 *
 * The list is not hard-coded from memory. It is derived by asking the running
 * server whether each column parses unquoted, because a keyword list transcribed
 * by hand is exactly the sort of thing that is subtly wrong.
 */

/**
 * Columns confirmed reserved against MariaDB 10.11, with the table that carries
 * them. Both predate B20 and both are in released migrations, so they are
 * grandfathered rather than renamed — altering an applied migration to rename a
 * column is a larger, riskier change than quoting the handful of call sites.
 *
 * Nothing may be ADDED to this list. A new entry means someone introduced a new
 * landmine; rename the column instead.
 */
const GRANDFATHERED_RESERVED_COLUMNS: Record<string, string> = {
  precision: "proposalFields",
  separator: "trackingSequences",
};

const SOURCE_ROOTS = ["server", "shared", "scripts"];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) collectSourceFiles(full, out);
    else if (/\.(ts|tsx|sh)$/.test(e)) out.push(full);
  }
  return out;
}

describe("reserved-word columns are known and quoted", () => {
  const files = SOURCE_ROOTS.flatMap(r => collectSourceFiles(r));

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  /**
   * Strip comments, then look only inside string literals that actually contain
   * SQL DML. An earlier version scanned any text near a SQL-ish keyword and
   * flagged two files containing no SQL at all — a doc comment mentioning
   * "precision" and a TypeScript property named `precision`. A guard that cries
   * wolf gets muted, which is worse than not having it.
   */
  function sqlLiteralsIn(src: string): string[] {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const literals =
      noComments.match(/`[^`]*`|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'/g) ?? [];

    return literals.filter(l =>
      /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|SELECT\b[\s\S]*\bFROM\b)/i.test(l)
    );
  }

  it("has no unquoted raw-SQL reference to a reserved column", () => {
    const offenders: string[] = [];
    const cols = Object.keys(GRANDFATHERED_RESERVED_COLUMNS);

    for (const file of files) {
      for (const sql of sqlLiteralsIn(readFileSync(file, "utf8"))) {
        for (const col of cols) {
          const bare = new RegExp(`(^|[^\\\\\`\\w.])${col}(?![\\\`\\w])`, "i");
          if (bare.test(sql)) offenders.push(`${file}: ${col}`);
        }
      }
    }

    expect(
      Array.from(new Set(offenders)),
      "Raw SQL references a MariaDB reserved-word column without backticks. " +
        "Drizzle quotes identifiers so the ORM path works and only hand-written " +
        "SQL breaks — quote it."
    ).toEqual([]);
  });

  it("does not flag a TypeScript identifier or a comment", () => {
    // The two files that tripped the first version of this scanner. Neither
    // contains any SQL; both mention `precision` in prose or as a property.
    for (const f of ["server/_core/geofence.ts", "server/_core/aiProposal.ts"]) {
      const sql = sqlLiteralsIn(readFileSync(f, "utf8"));
      expect(sql, `${f} should contain no SQL literals`).toEqual([]);
    }
  });

  it("does flag a genuinely unquoted reference", () => {
    // Proves the scanner still catches the real thing it was built for.
    const bad = 'const q = `INSERT INTO proposalFields (proposalId, precision) VALUES (?, ?)`;';
    const good = 'const q = `INSERT INTO proposalFields (proposalId, \\`precision\\`) VALUES (?, ?)`;';
    const hit = (src: string) =>
      sqlLiteralsIn(src).some(l => /(^|[^\\`\w.])precision(?![\\`\w])/i.test(l));
    expect(hit(bad)).toBe(true);
    expect(hit(good)).toBe(false);
  });

  it("refuses to let the grandfathered list grow", () => {
    // Two entries, both predating B20. A third means a new landmine was added.
    expect(Object.keys(GRANDFATHERED_RESERVED_COLUMNS).sort()).toEqual([
      "precision",
      "separator",
    ]);
  });
});

/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

d("the reserved set is derived from the server, not from memory", () => {
  it("matches exactly the grandfathered list across every column in the schema", async () => {
    const [cols] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT DISTINCT table_name AS t, column_name AS c
       FROM information_schema.columns
       WHERE table_schema = DATABASE()`
    );

    const found: Record<string, string> = {};
    const tested = new Set<string>();

    for (const row of cols) {
      const col = String(row.c);
      const tbl = String(row.t);
      if (tested.has(col)) continue;
      tested.add(col);
      try {
        // Ask the parser directly. A keyword list transcribed by hand is
        // exactly the sort of thing that is subtly wrong.
        await pool.execute(`SELECT ${col} FROM \`${tbl}\` LIMIT 0`);
      } catch (e) {
        const msg = (e as { message?: string }).message ?? "";
        if (/syntax/i.test(msg)) found[col] = tbl;
      }
    }

    expect(
      found,
      "A column name is a MariaDB reserved word. Rename it before release — " +
        "once it ships in a migration it is grandfathered and every raw query " +
        "against that table has to remember the backticks forever."
    ).toEqual(GRANDFATHERED_RESERVED_COLUMNS);
  });

  it("audits a meaningful number of columns", async () => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE()`
    );
    expect(Number(rows[0].n)).toBeGreaterThan(1500);
  });

  it("confirms the two known columns are usable when quoted", async () => {
    for (const [col, tbl] of Object.entries(GRANDFATHERED_RESERVED_COLUMNS)) {
      await expect(
        pool.execute(`SELECT \`${col}\` FROM \`${tbl}\` LIMIT 0`)
      ).resolves.toBeDefined();
    }
  });
});
