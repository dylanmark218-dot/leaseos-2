/**
 * F1 — legacy invoices assigned to no book (see server/financeLegacyOwnership.ts).
 *   pnpm tsx scripts/finance-legacy-ownership.ts report
 *       — read-only: every no-book invoice classified PROVEN / AMBIGUOUS / UNPROVEN, with its evidence
 *   pnpm tsx scripts/finance-legacy-ownership.ts assign <invoiceNumber> --reason "<why>" [--user <id>]
 *       — assign ONE proven invoice to the book its evidence names; anything else is refused
 * DATABASE_URL names the database. ASSIGNED_BY names the administrator in the event.
 * There is deliberately no "assign everything" mode: each backfill is a decision someone names.
 */
import mysql from "mysql2/promise";
import { assignProvenBook, legacyFinanceOwnershipAudit } from "../server/financeLegacyOwnership";

async function main() {
  const [cmd = "report", ...args] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
  const pool = mysql.createPool({ uri: url, charset: "utf8mb4" });
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (cmd === "report") {
      const r = await legacyFinanceOwnershipAudit(pool);
      console.log(JSON.stringify({ table: r.table, unassigned: r.unassigned, proven: r.proven.length, ambiguous: r.ambiguous.length, unproven: r.unproven.length }, null, 2));
      for (const row of [...r.proven, ...r.ambiguous, ...r.unproven]) console.log(JSON.stringify(row));
    } else if (cmd === "assign") {
      const invoiceNumber = args[0];
      const reason = flag("--reason");
      if (!invoiceNumber || !reason || reason.length < 10) { console.error("assign <invoiceNumber> --reason \"<at least 10 characters>\""); process.exit(2); }
      const userId = flag("--user") ? Number(flag("--user")) : null;
      const label = process.env.ASSIGNED_BY ?? `${process.env.USER ?? "unknown"}@${process.env.HOSTNAME ?? "unknown"}`;
      const r = await assignProvenBook(pool, invoiceNumber, { userId, label, reason });
      if (!r.assigned) { console.error(r.refusal); process.exit(3); }
      console.log(`assigned ${invoiceNumber} to financial entity ${r.financialEntityId}`);
    } else { console.error(`unknown command ${cmd}`); process.exit(2); }
  } finally { await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
