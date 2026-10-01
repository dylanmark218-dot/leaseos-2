/**
 * Gate 6's skipped-suite check, read from vitest's JSON report instead of its coloured text.
 *
 * The old check was `grep -E '^ *↓ .*\.db\.test\.ts'` over the basic reporter's output. Under
 * `CI=true` — which GitHub Actions sets — vitest colours that glyph even through a pipe, the line
 * becomes `\e[2m\e[90m↓\e[39m\e[22m server/…`, and `^ *↓` matches nothing. Reproduced on 2026-09-30:
 * the same skipping suite matched 1 line locally and 0 lines under CI. The check that exists to
 * notice a database suite that quietly stopped running had itself quietly stopped running in the
 * one place it mattered.
 *
 * The JSON reporter has no colour, no glyph and no terminal mode. A suite that skipped is a file
 * whose every assertion has status `skipped` or `pending`; that is the whole test. The policy is
 * unchanged — a `*.db.test.ts` may not skip while a database is configured — only the reading is.
 *
 * FAIL CLOSED: a report that is missing, unparsable, or lists no files is not "nothing skipped".
 * It is the reporter or the run having broken, and the check refuses rather than passes.
 */
import { readFileSync } from "node:fs";

export type VitestJson = {
  numTotalTestSuites?: number;
  testResults?: { name: string; status: string; assertionResults: { status: string }[] }[];
};

/** The unchanged policy: which files must not skip when a database is configured. */
export const DB_SUITE = /\.db\.test\.ts$/;

export type SkipVerdict =
  | { ok: true; filesSeen: number }
  | { ok: false; reason: string; skipped: string[] };

export function judgeSkips(report: unknown): SkipVerdict {
  const r = report as VitestJson | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.testResults)) {
    return { ok: false, reason: "vitest JSON report is missing or has no testResults — refusing to pass on an unreadable report", skipped: [] };
  }
  if (r.testResults.length === 0) {
    return { ok: false, reason: "vitest JSON report lists zero test files — the run or the reporter broke, refusing to pass", skipped: [] };
  }
  const skipped = r.testResults
    .filter(t => DB_SUITE.test(t.name))
    .filter(t => t.assertionResults.length === 0 || t.assertionResults.every(a => a.status === "skipped" || a.status === "pending" || a.status === "todo"))
    .map(t => t.name.replace(/^.*?(server\/)/, "$1"));
  if (skipped.length) {
    return { ok: false, reason: "a .db.test.ts suite skipped while a database is configured", skipped };
  }
  return { ok: true, filesSeen: r.testResults.length };
}

export function judgeSkipsFile(file: string): SkipVerdict {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { return { ok: false, reason: `cannot read vitest JSON report at ${file}: ${(e as Error).message}`, skipped: [] }; }
  return judgeSkips(parsed);
}

if (process.argv[1] && /skipped-db-suites\.ts$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error("usage: skipped-db-suites.ts <vitest-json-report>"); process.exit(2); }
  const v = judgeSkipsFile(file);
  if (!v.ok) {
    console.error(`FAIL: ${v.reason}`);
    for (const s of v.skipped) console.error(`  ${s}`);
    if (v.skipped.length) console.error("Either its guard reads an environment variable this gate does not set, or the gate stopped setting one.");
    process.exit(1);
  }
  console.log(`no database-backed suite skipped (${v.filesSeen} files in the report)`);
}
