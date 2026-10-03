#!/usr/bin/env node
/**
 * CP1.5 — the counts in PROCEDURE_AUTHORIZATION_INVENTORY.md, read from the routers rather than typed.
 *
 * Each `ROLE_AUTHORIZED` row's count is the number of `roleProcedure("…")` call sites in that file, and
 * the bold total is the sum of the rows. Both were hand-maintained and had drifted: at `main` 3d05d32,
 * nine rows under-counted their router (complianceRouter listed 9, has 18) and the total said 356 where
 * the rows' routers held 384. The prose of the document is still written by people; only the numbers
 * are this script's.
 *
 *   node scripts/procedure-inventory.mjs           rewrite the counts in place
 *   node scripts/procedure-inventory.mjs --check   exit 1 and name every row that disagrees
 *
 * `server/procedureAuthorization.test.ts` makes the same comparison, so drift fails the build.
 * The system-wide total (every router) is generated into LEASEOS_CURRENT_STATE.md by current-state.sh.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "PROCEDURE_AUTHORIZATION_INVENTORY.md";
const ROW = /^(\| `(server\/[^`]+)` \| `ROLE_AUTHORIZED`[^|]*\| \*\*)(\d+)(\*\*[^|]*\|)$/;
const TOTAL = /^\*\*(\d+) role-authorized procedures across the surfaces listed above\./;
const callSites = file => (readFileSync(file, "utf8").match(/roleProcedure\(\s*"/g) ?? []).length;

const check = process.argv.includes("--check");
const lines = readFileSync(FILE, "utf8").split("\n");
const drift = [];
let sum = 0;
const out = lines.map(line => {
  const m = ROW.exec(line);
  if (!m) return line;
  const actual = callSites(m[2]);
  sum += actual;
  if (Number(m[3]) !== actual) drift.push(`${m[2]}: listed ${m[3]}, router has ${actual}`);
  return `${m[1]}${actual}${m[4]}`;
}).map(line => {
  const t = TOTAL.exec(line);
  if (!t) return line;
  if (Number(t[1]) !== sum) drift.push(`total: listed ${t[1]}, rows sum to ${sum}`);
  return line.replace(TOTAL, `**${sum} role-authorized procedures across the surfaces listed above.`);
});
if (!out.some(l => TOTAL.test(l))) drift.push("no total line of the form '**N role-authorized procedures across the surfaces listed above.'");

if (check) {
  if (drift.length) { console.error(`${FILE} disagrees with the routers:\n  ${drift.join("\n  ")}\nRun: node scripts/procedure-inventory.mjs`); process.exit(1); }
  console.log(`${FILE}: every row matches its router; total ${sum}`);
} else {
  writeFileSync(FILE, out.join("\n"));
  console.log(drift.length ? `corrected:\n  ${drift.join("\n  ")}` : "already current");
}
