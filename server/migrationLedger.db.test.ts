/**
 * Work-order item 26 — advancing a live database, not rebuilding it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { baseline, migrateUp, migrationStatus, splitStatements } from "./_core/migrationLedger";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let admin: mysql.Connection, conn: mysql.Connection;
const dbName = `leaseos_ledger_${Math.random().toString(36).slice(2, 8)}`;
beforeAll(async () => {
  if (!URL) return;
  admin = await mysql.createConnection({ uri: URL, multipleStatements: false });
  await admin.query(`CREATE DATABASE \`${dbName}\``);
  conn = await mysql.createConnection({ uri: URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`), multipleStatements: false });
});
afterAll(async () => { if (!URL) return; await conn.end(); await admin.query(`DROP DATABASE \`${dbName}\``); await admin.end(); });

describe("statement splitting matches the gate runner", () => {
  it("splits on the breakpoint marker, sends a compound trigger body whole, and drops comment-only chunks", () => {
    const sql = `-- header\nCREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE TABLE b (id int);\n--> statement-breakpoint\nCREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW\nBEGIN\n  IF NEW.id < 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'; END IF;\nEND;\n`;
    const st = splitStatements(sql);
    expect(st.length).toBe(3);
    expect(st[2]).toContain("BEGIN");
    expect(st[2]).toContain("END IF;");
    expect(st[2].endsWith("END")).toBe(true);
  });
});

d("the ledger advances a database", () => {
  it("applies pending files in order and records checksums; a rerun is a no-op; an edited applied file is DRIFT and refuses; a new file applies alone; a failing file stops the run and is not recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY, v int);\n--> statement-breakpoint\nINSERT INTO a (v) VALUES (1);\n");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id int AUTO_INCREMENT PRIMARY KEY);\n--> statement-breakpoint\nCREATE TRIGGER a_guard BEFORE UPDATE ON a FOR EACH ROW\nBEGIN\n  IF NEW.v < 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no negatives'; END IF;\nEND;\n");
    const first = await migrateUp(conn, dir, { appliedBy: "test" });
    expect(first).toMatchObject({ refused: null, stoppedAt: null });
    expect(first.applied.map(a => a.fileName)).toEqual(["0001_a.sql", "0002_b.sql"]);
    await expect(conn.query("UPDATE a SET v = -1")).rejects.toThrow(/no negatives/);   // the compound trigger really applied
    expect((await migrationStatus(conn, dir)).state).toBe("CURRENT");
    expect((await migrateUp(conn, dir, { appliedBy: "test" })).applied).toEqual([]);
    // Drift: someone edits an applied file.
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY, v int, w int);\n");
    const s = await migrationStatus(conn, dir);
    expect(s.state).toBe("DRIFT");
    expect(s.drift[0]!.fileName).toBe("0001_a.sql");
    const refused = await migrateUp(conn, dir, { appliedBy: "test" });
    expect(refused.refused).toContain("DRIFT");
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY, v int);\n--> statement-breakpoint\nINSERT INTO a (v) VALUES (1);\n");   // restore
    // A new file applies alone; a failing file after it stops the run and is not recorded.
    writeFileSync(join(dir, "0003_c.sql"), "CREATE TABLE c (id int PRIMARY KEY);\n");
    writeFileSync(join(dir, "0004_bad.sql"), "CREATE TABLE d (id int PRIMARY KEY);\n--> statement-breakpoint\nALTER TABLE nope ADD COLUMN x int;\n");
    const dry = await migrateUp(conn, dir, { appliedBy: "test", dryRun: true });
    expect(dry.applied.map(a => a.fileName)).toEqual(["0003_c.sql", "0004_bad.sql"]);
    const run = await migrateUp(conn, dir, { appliedBy: "test" });
    expect(run.applied.map(a => a.fileName)).toEqual(["0003_c.sql"]);
    expect(run.stoppedAt).toMatchObject({ fileName: "0004_bad.sql" });
    const after = await migrationStatus(conn, dir);
    expect(after.applied.map(a => a.fileName)).toEqual(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
    expect(after.pending.map(p => p.fileName)).toEqual(["0004_bad.sql"]);
    // Baseline refuses once the ledger has rows.
    expect((await baseline(conn, dir, { appliedBy: "test" })).refused).toContain("not empty");
  }, 30_000);

  it("baseline records every file without running it on a database whose ledger is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0001_x.sql"), "CREATE TABLE never_created (id int);\n");
    const db2 = `${dbName}_b`;
    await admin.query(`CREATE DATABASE \`${db2}\``);
    const c2 = await mysql.createConnection({ uri: URL!.replace(/\/[^/?]+(\?|$)/, `/${db2}$1`) });
    try {
      expect(await baseline(c2, dir, { appliedBy: "test" })).toEqual({ recorded: 1, refused: null });
      expect((await migrationStatus(c2, dir)).state).toBe("CURRENT");
      const [t] = await c2.query("SHOW TABLES LIKE 'never_created'") as unknown as [unknown[]];
      expect(t.length).toBe(0);
    } finally { await c2.end(); await admin.query(`DROP DATABASE \`${db2}\``); }
  }, 30_000);
});

d("the ledger applies the real corpus", () => {
  it("advances a fresh database through every real migration and lands the same shape the gate does: all files recorded, triggers present, non-ASCII stored intact", async () => {
    const db3 = `${dbName}_real`;
    await admin.query(`CREATE DATABASE \`${db3}\``);
    const c3 = await mysql.createConnection({ uri: URL!.replace(/\/[^/?]+(\?|$)/, `/${db3}$1`), charset: "utf8mb4" });
    try {
      const r = await migrateUp(c3, "drizzle", { appliedBy: "test" });
      expect(r.refused).toBeNull();
      expect(r.stoppedAt).toBeNull();
      const files = (await import("node:fs")).readdirSync("drizzle").filter(f => /^\d{4}_.*\.sql$/.test(f)).length;
      expect(r.applied.length).toBe(files);
      expect((await migrationStatus(c3, "drizzle")).state).toBe("CURRENT");
      const [trig] = await c3.query("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema = ?", [db3]) as unknown as [{ n: number }[]];
      expect(Number(trig[0]!.n)).toBeGreaterThanOrEqual(40);
      const [lic] = await c3.query("SELECT attributionText FROM facilitySourceLicences WHERE licenceKey = 'ogl_alberta'") as unknown as [{ attributionText: string }[]];
      expect(lic[0]!.attributionText).toBe("Contains information licensed under the Open Government Licence – Alberta");
    } finally { await c3.end(); await admin.query(`DROP DATABASE \`${db3}\``); }
  }, 120_000);
});
