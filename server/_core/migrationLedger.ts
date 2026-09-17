/**
 * Production migration ledger (work-order item 26).
 *
 * The CI gate proves the schema builds from nothing. A live customer's database is
 * a different problem: it must be *advanced* — only the files it has not seen,
 * in order, each recorded with the checksum of what actually ran, and refused
 * outright if a file it already applied has since been edited (drift). This
 * module is the one door for that. It never drops anything.
 *
 * Statement splitting matches scripts/apply-migrations.sh: files split on the
 * drizzle `--> statement-breakpoint` marker; a chunk holding a compound body
 * (`^BEGIN$`) is sent whole, so the server parses the trigger itself; other
 * chunks are split on `;`. Each file runs as a unit; on failure the runner stops
 * at that file and reports it — nothing after it is attempted.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type mysql from "mysql2/promise";

export const LEDGER_TABLE = "schemaMigrations";
export type MigrationFile = { fileName: string; checksum: string; sql: string };
export type LedgerRow = { fileName: string; checksum: string; appliedAt: Date; appliedBy: string; durationMs: number };
export type MigrationStatus = { applied: LedgerRow[]; pending: MigrationFile[]; drift: { fileName: string; appliedChecksum: string; fileChecksum: string }[]; missingFiles: string[]; state: "CURRENT" | "PENDING" | "DRIFT" };

export function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort().map(fileName => {
    const sql = readFileSync(join(dir, fileName), "utf8");
    return { fileName, checksum: createHash("sha256").update(sql).digest("hex"), sql };
  });
}

/**
 * The statements of one file. Files split on the drizzle `--> statement-breakpoint`
 * marker; inside a chunk, statements end at a `;` that is not inside a `BEGIN … END`
 * body, so a compound trigger is sent whole while a `DROP TRIGGER IF EXISTS …;` that
 * precedes it in the same chunk is sent on its own. Comment-only text is dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  for (const chunk of sql.split(/-->\s*statement-breakpoint/)) {
    let depth = 0, current: string[] = [];
    const flush = () => { const text = current.join("\n").trim().replace(/;\s*$/, ""); current = []; if (text && !/^(\s*--[^\n]*\n?)+$/.test(text)) out.push(text); };
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      const t = line.trim();
      if (t === "" || t.startsWith("--")) { if (current.length) current.push(line); continue; }
      current.push(line);
      if (/^BEGIN$/.test(t)) { depth++; continue; }
      if (/^END;?$/.test(t)) { depth = Math.max(0, depth - 1); if (depth === 0) flush(); continue; }
      if (depth === 0 && /;\s*$/.test(t)) flush();
    }
    flush();
  }
  return out;
}

export async function ensureLedger(conn: mysql.Connection | mysql.Pool): Promise<void> {
  await conn.query(`CREATE TABLE IF NOT EXISTS \`${LEDGER_TABLE}\` (
    \`id\` int AUTO_INCREMENT NOT NULL,
    \`fileName\` varchar(200) NOT NULL,
    \`checksum\` char(64) NOT NULL,
    \`appliedAt\` timestamp NOT NULL DEFAULT (now()),
    \`appliedBy\` varchar(160) NOT NULL,
    \`durationMs\` int NOT NULL,
    \`runner\` varchar(60) NOT NULL,
    CONSTRAINT \`${LEDGER_TABLE}_id\` PRIMARY KEY(\`id\`),
    CONSTRAINT \`${LEDGER_TABLE}_file\` UNIQUE(\`fileName\`)
  )`);
}

export async function migrationStatus(conn: mysql.Connection | mysql.Pool, dir: string): Promise<MigrationStatus> {
  await ensureLedger(conn);
  const files = readMigrationFiles(dir);
  const [rows] = await conn.query(`SELECT fileName, checksum, appliedAt, appliedBy, durationMs FROM \`${LEDGER_TABLE}\` ORDER BY fileName`) as unknown as [LedgerRow[]];
  const appliedBy = new Map(rows.map(r => [r.fileName, r]));
  const drift = files.filter(f => appliedBy.has(f.fileName) && appliedBy.get(f.fileName)!.checksum !== f.checksum).map(f => ({ fileName: f.fileName, appliedChecksum: appliedBy.get(f.fileName)!.checksum, fileChecksum: f.checksum }));
  const fileNames = new Set(files.map(f => f.fileName));
  const missingFiles = rows.filter(r => !fileNames.has(r.fileName)).map(r => r.fileName);
  const pending = files.filter(f => !appliedBy.has(f.fileName));
  return { applied: rows, pending, drift, missingFiles, state: drift.length || missingFiles.length ? "DRIFT" : pending.length ? "PENDING" : "CURRENT" };
}

export type MigrateResult = { applied: { fileName: string; durationMs: number }[]; stoppedAt: { fileName: string; error: string } | null; refused: string | null };

/** Apply every pending file in order. Refuses to start on drift. Stops at the first failure and says so. */
export async function migrateUp(conn: mysql.Connection, dir: string, opts: { appliedBy: string; dryRun?: boolean; runner?: string }): Promise<MigrateResult> {
  const status = await migrationStatus(conn, dir);
  if (status.state === "DRIFT") return { applied: [], stoppedAt: null, refused: `DRIFT — refusing to migrate: ${status.drift.map(d => `${d.fileName} was applied with checksum ${d.appliedChecksum.slice(0, 12)} but the file now hashes ${d.fileChecksum.slice(0, 12)}`).concat(status.missingFiles.map(f => `${f} is in the ledger but no longer in the migrations directory`)).join("; ")}` };
  const applied: MigrateResult["applied"] = [];
  for (const f of status.pending) {
    if (opts.dryRun) { applied.push({ fileName: f.fileName, durationMs: 0 }); continue; }
    const t0 = Date.now();
    try {
      for (const st of splitStatements(f.sql)) await conn.query(st);
    } catch (e) {
      return { applied, stoppedAt: { fileName: f.fileName, error: (e as Error).message }, refused: null };
    }
    const durationMs = Date.now() - t0;
    await conn.query(`INSERT INTO \`${LEDGER_TABLE}\` (fileName, checksum, appliedBy, durationMs, runner) VALUES (?,?,?,?,?)`, [f.fileName, f.checksum, opts.appliedBy, durationMs, opts.runner ?? "migrationLedger/1"]);
    applied.push({ fileName: f.fileName, durationMs });
  }
  return { applied, stoppedAt: null, refused: null };
}

/**
 * Baseline: a database that already carries the schema (built by the CI runner, or by
 * hand before the ledger existed) records every file as applied WITHOUT running it.
 * Explicit, and only when the ledger is empty — it is a statement about history, not a
 * migration.
 */
export async function baseline(conn: mysql.Connection, dir: string, opts: { appliedBy: string }): Promise<{ recorded: number; refused: string | null }> {
  await ensureLedger(conn);
  const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${LEDGER_TABLE}\``) as unknown as [{ n: number }[]];
  if (Number(rows[0]!.n) > 0) return { recorded: 0, refused: "the ledger is not empty; baseline is only for a database with no ledger" };
  const files = readMigrationFiles(dir);
  for (const f of files) await conn.query(`INSERT INTO \`${LEDGER_TABLE}\` (fileName, checksum, appliedBy, durationMs, runner) VALUES (?,?,?,0,'baseline')`, [f.fileName, f.checksum, opts.appliedBy]);
  return { recorded: files.length, refused: null };
}
