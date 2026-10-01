/**
 * B23.1B — gate 6's verdict, read from the machine-readable report.
 *
 * Run by `scripts/ci-gate.sh` after vitest. Takes the path of the JSON the
 * `json` reporter wrote. Prints the pure/database split, then every finding,
 * then exits 1 if there are any.
 *
 *   pnpm exec tsx scripts/verify-gate-run.ts /tmp/vitest-gate.json
 */
import { readFileSync } from "node:fs";
import {
  checkGateRun,
  describeGateFinding,
  REQUIRED_SUITES,
  splitCounts,
  type GateReport,
} from "../server/_core/requiredSuites";

const path = process.argv[2];
if (!path) {
  console.error("usage: verify-gate-run.ts <vitest-json-report>");
  process.exit(2);
}

let report: GateReport;
try {
  report = JSON.parse(readFileSync(path, "utf8")) as GateReport;
} catch (error) {
  // Named precisely: a missing or truncated report means vitest died before
  // writing it, which is a different problem from a failing test and wants a
  // different first question.
  console.error(`FAIL: could not read the vitest JSON report at ${path}.`);
  console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  console.error("      vitest did not finish, or --outputFile.json points somewhere else.");
  process.exit(1);
}

/**
 * A suite is database-backed if it reads a database URL, not if its name says
 * so. `.db.test.ts` marks the suites that stand down without one, but ~40 more
 * gate their own `describe` on `DATABASE_URL` and carry no suffix.
 */
const readsDatabase = (suite: string): boolean => {
  try {
    const src = readFileSync(suite, "utf8");
    return src.includes("DATABASE_URL") || src.includes("WIDGET_DB_URL");
  } catch {
    // Unreadable (a path outside the repo, say) — counted as pure rather than
    // inflating the number this report exists to keep honest.
    return false;
  }
};

const { pure, db } = splitCounts(report, readsDatabase);
const line = (label: string, t: { files: number; passed: number; failed: number; skipped: number }) =>
  `  ${label.padEnd(18)} files ${String(t.files).padStart(4)}   passed ${String(t.passed).padStart(5)}   failed ${String(t.failed).padStart(4)}   skipped ${String(t.skipped).padStart(4)}`;

console.log("gate 6 counts, database-backed reported separately:");
console.log(line("pure", pure));
console.log(line("database-backed", db));
console.log(line("total", {
  files: pure.files + db.files,
  passed: pure.passed + db.passed,
  failed: pure.failed + db.failed,
  skipped: pure.skipped + db.skipped,
}));

if (db.passed === 0) {
  console.error("");
  console.error("FAIL: no database-backed case executed in this run.");
  console.error("      A green gate here would mean nothing: the suites that carry the tenant");
  console.error("      and cross-organization boundaries all stood down.");
  process.exit(1);
}

const findings = checkGateRun(report);
if (findings.length > 0) {
  console.error("");
  console.error(`FAIL: ${findings.length} problem(s) with which suites ran.`);
  for (const f of findings) console.error(`  - ${describeGateFinding(f)}`);
  process.exit(1);
}

console.log(`all ${Object.keys(REQUIRED_SUITES).length} pinned authorization suites executed with cases that ran`);
