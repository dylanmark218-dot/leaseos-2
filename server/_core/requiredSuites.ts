/**
 * B23.1B — which suites the gate refuses to pass without, and how it checks.
 *
 * This exists because the previous version of the check was a `grep` over the
 * human reporter's output:
 *
 *     grep -qE "(✓|❯) *server/$suite" /tmp/vitest-gate.out
 *
 * Locally, vitest writes ` ✓ server/x.db.test.ts (20 tests)` and that matches.
 * In GitHub Actions vitest detects CI and colours its output, so the same line
 * arrives as ` \e[32m✓\e[39m server/x.db.test.ts` — an escape sequence sits
 * between the tick and the space, and the pattern does not match. The gate
 * therefore failed on a run where all 312 files passed and every pinned suite
 * had in fact executed. A guard that goes red when the thing it guards is fine
 * is worse than no guard: it teaches people that red means nothing.
 *
 * So the gate reads the JSON reporter instead of the one written for humans,
 * and the logic is pure, so it can be tested against a synthetic report
 * containing exactly the failure it exists to catch rather than only against a
 * run where nothing is wrong.
 */

/** One file's outcome, as `--reporter=json` records it. */
export type SuiteResult = {
  /** Absolute path, as vitest writes it. */
  name: string;
  status: string;
  assertionResults?: { status: string }[];
};

export type GateReport = {
  testResults: SuiteResult[];
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
};

/**
 * The suites that carry the authorization boundary, and what each one is for.
 *
 * A reason per entry, because a bare list of filenames tells the next person
 * nothing about what they would be giving up by deleting one. Renaming a file
 * without updating this list fails `requiredSuites.test.ts`, which checks every
 * path here exists on disk — so the list cannot quietly rot into a set of
 * names that match nothing and therefore never fail.
 */
export const REQUIRED_SUITES: Readonly<Record<string, string>> = {
  // --- B23.0: identity resolves to one company and the screens it earns ---
  "server/workspaceAccess.test.ts":
    "pure: which workspaces a set of grants composes, and that a capability is required rather than a role name alone",
  "server/sessionWorkspace.db.test.ts":
    "database, adversarial: a forged organization cookie, a workspace never offered, a cross-organization record by id, an ex-employee holding every grant, a suspended company, an expired membership term",

  // --- B23.1: a grant speaks for the company that issued it ---
  "server/organizationScopedRoles.test.ts":
    "pure: the cross-organization refusal itself — a role granted by A is absent from effectiveRoles while acting for B, rather than merely outvoted",
  "server/organizationScopedRoles.db.test.ts":
    "database: the same boundary asked through appRouter.createCaller, with no client in the path",
  "server/tenantScopeRecords.db.test.ts":
    "database: records answer not-found across the boundary and serve their owner, and a grant lands in the ACTOR's organization",
  "server/recordsApiAuthorization.test.ts":
    "database: the gate is on every records procedure, the active-grant uniqueness key, and the roles held reach the audit row",
  "server/_core/branchGrantLaundering.test.ts":
    "pure: the name projection does not launder a branch-confined grant into a global one",
  "server/actingScope.test.ts":
    "pure: the acting organization comes from membership, never from the request",

  // --- B23.1A: legacy authority, and the guard on the decision function ---
  "server/legacyGrantHardening.test.ts":
    "pure: unscoped_legacy authorizes nowhere, 'default' means the historical single tenant, and §6 scans the source for an authorize() call that does not name its organization",
  "server/legacyGrantHardening.db.test.ts":
    "database: the bootstrap cannot mint cross-tenant authority, and a quarantined grant resolves into the actor's own organization",
  "server/migrationSlots.test.ts":
    "pure: a NEW duplicate migration slot fails, and the inherited 0157 allowance does not mask a collision elsewhere",

  // --- B23.2: who belongs to an organization, and what they may do there ---
  "server/peopleAccess.test.ts":
    "pure: invitation state computed rather than stored, every acceptance refusal named without mentioning another company, a default workspace that can never become authority, and the last-administrator invariant",
  "server/peopleAccess.db.test.ts":
    "database, adversarial: the full People & Access matrix through appRouter.createCaller — invitation into the actor's own organization only, a forged organization ignored rather than obeyed, one identity joining two companies, accept-once, expiry, cancellation, per-employer offboarding, quarantine resolution, and the last administrator who cannot leave",
};

export type GateFinding =
  | { kind: "missing"; suite: string; reason: string }
  | { kind: "required_skipped"; suite: string; reason: string }
  | { kind: "required_failed"; suite: string }
  | { kind: "db_suite_skipped"; suite: string }
  | { kind: "no_assertions"; suite: string; reason: string };

/** A repository-relative path, whatever absolute prefix vitest wrote. */
export function relativeSuite(name: string): string {
  const m = /(?:^|\/)((?:server|client|shared)\/.*)$/.exec(name.replace(/\\/g, "/"));
  return m ? m[1]! : name;
}

const SKIPPED = new Set(["pending", "skipped", "todo"]);

/**
 * Everything wrong with a gate run, as findings rather than a throw.
 *
 * Three distinct failures, deliberately not collapsed into one:
 *
 *   `missing` — the suite is not in the run at all. Deleted, renamed, or
 *   filtered out by a `--project`/`include` change nobody meant to make.
 *
 *   `required_skipped` / `no_assertions` — the file was collected and then
 *   stood down, which is what `describe.skip` does when DATABASE_URL is unset.
 *   Counting this as "ran" is the exact false green this checkpoint exists to
 *   close: zero tests executed also satisfies "nothing failed".
 *
 *   `db_suite_skipped` — any `.db.test.ts`, not only a pinned one. A database
 *   is configured, so standing down means its guard reads an environment
 *   variable the gate does not set.
 */
export function checkGateRun(report: GateReport): GateFinding[] {
  const findings: GateFinding[] = [];
  const byPath = new Map<string, SuiteResult>();
  for (const r of report.testResults ?? []) byPath.set(relativeSuite(r.name), r);

  for (const [suite, reason] of Object.entries(REQUIRED_SUITES)) {
    const result = byPath.get(suite);
    if (!result) {
      findings.push({ kind: "missing", suite, reason });
      continue;
    }
    if (SKIPPED.has(result.status)) {
      findings.push({ kind: "required_skipped", suite, reason });
      continue;
    }
    if (result.status === "failed") findings.push({ kind: "required_failed", suite });

    // A file can report "passed" while every case inside it was skipped.
    const ran = (result.assertionResults ?? []).filter(a => !SKIPPED.has(a.status));
    if (ran.length === 0) findings.push({ kind: "no_assertions", suite, reason });
  }

  for (const [path, result] of Array.from(byPath.entries())) {
    if (!path.endsWith(".db.test.ts")) continue;
    if (SKIPPED.has(result.status)) findings.push({ kind: "db_suite_skipped", suite: path });
  }

  return findings;
}

/** A finding in the words somebody reading a failed CI job needs. */
export function describeGateFinding(f: GateFinding): string {
  switch (f.kind) {
    case "missing":
      return `${f.suite} is not in this run at all — deleted, renamed, or excluded by the test filter. It covers: ${f.reason}`;
    case "required_skipped":
      return `${f.suite} was collected and then skipped, so it tested nothing. It covers: ${f.reason}`;
    case "no_assertions":
      return `${f.suite} reported no executed case — every test inside it was skipped. It covers: ${f.reason}`;
    case "required_failed":
      return `${f.suite} failed. The authorization boundary is broken, not merely untested.`;
    case "db_suite_skipped":
      return `${f.suite} skipped while a database is configured — its guard reads an environment variable this gate does not set.`;
  }
}

/**
 * Executed cases split by whether the file needs a database.
 *
 * Reported separately because merging them is how "the tests pass" came to mean
 * "the tests that ran passed".
 *
 * `isDatabaseBacked` is injected rather than assumed. The obvious rule — the
 * `.db.test.ts` suffix — is the convention for a suite that stands DOWN without
 * a database, and it badly undercounts: `enforcementApi.test.ts`,
 * `workforce.test.ts` and ~40 others read `DATABASE_URL` and gate their own
 * `describe` on it without carrying the suffix. Reporting 271 database-backed
 * cases when 1,800 ran against a real server would be the same kind of
 * comfortable half-truth this whole check exists to stop, so the caller passes
 * a predicate that reads the file.
 */
export function splitCounts(
  report: GateReport,
  isDatabaseBacked: (suite: string) => boolean = s => s.endsWith(".db.test.ts")
) {
  const tally = () => ({ files: 0, passed: 0, failed: 0, skipped: 0 });
  const db = tally();
  const pure = tally();
  for (const r of report.testResults ?? []) {
    const into = isDatabaseBacked(relativeSuite(r.name)) ? db : pure;
    into.files++;
    for (const a of r.assertionResults ?? []) {
      if (a.status === "failed") into.failed++;
      else if (SKIPPED.has(a.status)) into.skipped++;
      else into.passed++;
    }
  }
  return { db, pure };
}
