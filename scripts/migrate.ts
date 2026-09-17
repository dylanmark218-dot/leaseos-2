/**
 * Production migration runner (work-order item 26).
 *   pnpm tsx scripts/migrate.ts status            — applied / pending / drift
 *   pnpm tsx scripts/migrate.ts up [--dry-run]     — apply pending files in order; refuses on drift; stops at the first failure
 *   pnpm tsx scripts/migrate.ts baseline --yes     — record every file as applied on a database that already carries the schema
 * DATABASE_URL names the database. MIGRATED_BY names the person or pipeline in the ledger.
 */
import mysql from "mysql2/promise";
import { baseline, migrateUp, migrationStatus } from "../server/_core/migrationLedger";

async function main() {
  const [cmd = "status", ...flags] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
  const conn = await mysql.createConnection({ uri: url, charset: "utf8mb4", multipleStatements: false });
  const appliedBy = process.env.MIGRATED_BY ?? `${process.env.USER ?? "unknown"}@${process.env.HOSTNAME ?? "unknown"}`;
  try {
    if (cmd === "status") {
      const s = await migrationStatus(conn, "drizzle");
      console.log(`state: ${s.state}; applied ${s.applied.length}; pending ${s.pending.length}${s.drift.length ? `; DRIFT ${s.drift.map(d => d.fileName).join(", ")}` : ""}${s.missingFiles.length ? `; missing files ${s.missingFiles.join(", ")}` : ""}`);
      for (const p of s.pending) console.log(`  pending  ${p.fileName}`);
      process.exit(s.state === "DRIFT" ? 3 : 0);
    } else if (cmd === "up") {
      const r = await migrateUp(conn, "drizzle", { appliedBy, dryRun: flags.includes("--dry-run") });
      if (r.refused) { console.error(r.refused); process.exit(3); }
      for (const a of r.applied) console.log(`  ${flags.includes("--dry-run") ? "would apply" : "applied"}  ${a.fileName}${a.durationMs ? ` (${a.durationMs} ms)` : ""}`);
      if (r.stoppedAt) { console.error(`STOPPED at ${r.stoppedAt.fileName}: ${r.stoppedAt.error}`); process.exit(1); }
      console.log(`done: ${r.applied.length} file(s)`);
    } else if (cmd === "baseline") {
      if (!flags.includes("--yes")) { console.error("baseline records every file as applied WITHOUT running it; pass --yes on a database that already carries the schema"); process.exit(2); }
      const r = await baseline(conn, "drizzle", { appliedBy });
      if (r.refused) { console.error(r.refused); process.exit(3); }
      console.log(`baseline recorded ${r.recorded} file(s)`);
    } else { console.error(`unknown command ${cmd}`); process.exit(2); }
  } finally { await conn.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
