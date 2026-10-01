/**
 * B23.1B — the gate's own check, tested against the failures it exists to catch.
 *
 * The check this replaces was a grep over the human reporter's output. It had
 * never been exercised against a run where a suite was actually missing, and
 * when CI coloured that output the pattern stopped matching and the gate went
 * red on a run where all 312 files passed. Both halves of that are the same
 * mistake: gate logic that can only be exercised by breaking the repository is
 * gate logic nobody has tested.
 *
 * So `checkGateRun` is pure and gets handed synthetic reports here, and the
 * pinned list is checked against the filesystem so a rename cannot leave it
 * naming files that no longer exist — which would make it match nothing and
 * therefore never fail again.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkGateRun,
  describeGateFinding,
  relativeSuite,
  REQUIRED_SUITES,
  splitCounts,
  type GateReport,
  type SuiteResult,
} from "./_core/requiredSuites";

/** A file vitest reports as fully passed, with `n` executed cases. */
const passed = (path: string, n = 3): SuiteResult => ({
  name: `/runner/work/leaseos-2/leaseos-2/${path}`,
  status: "passed",
  assertionResults: Array.from({ length: n }, () => ({ status: "passed" })),
});

/** A whole run in which everything pinned is fine. */
const healthy = (): GateReport => ({
  testResults: Object.keys(REQUIRED_SUITES).map(p => passed(p)),
});

describe("the pinned list names real files", () => {
  it("points at a suite that exists, for every entry", () => {
    // The failure this prevents: renaming a suite, leaving the pin behind, and
    // ending up with a check that looks for a file nobody has and reports
    // nothing wrong because it is looking in the wrong place.
    const gone = Object.keys(REQUIRED_SUITES).filter(p => !existsSync(p));
    expect(gone).toEqual([]);
  });

  it("gives every pinned suite a reason worth reading", () => {
    for (const [suite, reason] of Object.entries(REQUIRED_SUITES)) {
      expect(reason.length, suite).toBeGreaterThan(40);
    }
  });

  it("covers both halves of the boundary — pure decision and real database", () => {
    const paths = Object.keys(REQUIRED_SUITES);
    expect(paths.filter(p => p.endsWith(".db.test.ts")).length).toBeGreaterThanOrEqual(3);
    expect(paths.filter(p => !p.endsWith(".db.test.ts")).length).toBeGreaterThanOrEqual(5);
  });
});

describe("a healthy run passes, and each failure mode is caught", () => {
  it("finds nothing wrong with a run where every pinned suite executed", () => {
    expect(checkGateRun(healthy())).toEqual([]);
  });

  it("catches a deleted or renamed suite", () => {
    const report = healthy();
    report.testResults = report.testResults.filter(
      r => !r.name.endsWith("organizationScopedRoles.db.test.ts")
    );
    const findings = checkGateRun(report);
    expect(findings).toEqual([
      {
        kind: "missing",
        suite: "server/organizationScopedRoles.db.test.ts",
        reason: REQUIRED_SUITES["server/organizationScopedRoles.db.test.ts"],
      },
    ]);
    expect(describeGateFinding(findings[0]!)).toContain("not in this run at all");
  });

  it("catches a pinned suite that stood down instead of running", () => {
    // `describe.skip` when DATABASE_URL is unset looks exactly like this, and
    // is the shape of the original false green.
    const report = healthy();
    const target = report.testResults.find(r => r.name.endsWith("sessionWorkspace.db.test.ts"))!;
    target.status = "pending";
    expect(checkGateRun(report).map(f => f.kind)).toEqual(["required_skipped", "db_suite_skipped"]);
  });

  it("catches a suite that reports passed while every case inside it was skipped", () => {
    // The subtler version: the file is present and green, and tested nothing.
    const report = healthy();
    const target = report.testResults.find(r => r.name.endsWith("legacyGrantHardening.test.ts"))!;
    target.assertionResults = [{ status: "skipped" }, { status: "skipped" }];
    expect(checkGateRun(report)).toEqual([
      {
        kind: "no_assertions",
        suite: "server/legacyGrantHardening.test.ts",
        reason: REQUIRED_SUITES["server/legacyGrantHardening.test.ts"],
      },
    ]);
  });

  it("catches a pinned suite that failed", () => {
    const report = healthy();
    report.testResults.find(r => r.name.endsWith("actingScope.test.ts"))!.status = "failed";
    expect(checkGateRun(report)).toEqual([
      { kind: "required_failed", suite: "server/actingScope.test.ts" },
    ]);
  });

  it("catches ANY skipped .db.test.ts, not only a pinned one", () => {
    const report = healthy();
    report.testResults.push({
      name: "/runner/work/leaseos-2/leaseos-2/server/somethingElse.db.test.ts",
      status: "skipped",
      assertionResults: [],
    });
    expect(checkGateRun(report)).toEqual([
      { kind: "db_suite_skipped", suite: "server/somethingElse.db.test.ts" },
    ]);
  });

  it("reports every problem at once rather than one per run", () => {
    // Being told about one, fixing it, and being told about the next is how a
    // gate becomes something people route around.
    const report = healthy();
    report.testResults = report.testResults.filter(
      r => !r.name.endsWith("migrationSlots.test.ts") && !r.name.endsWith("actingScope.test.ts")
    );
    expect(checkGateRun(report)).toHaveLength(2);
  });
});

describe("paths survive the shape vitest actually writes", () => {
  it("reduces an absolute runner path to the repository-relative one", () => {
    expect(relativeSuite("/runner/work/leaseos-2/leaseos-2/server/x.db.test.ts")).toBe("server/x.db.test.ts");
    expect(relativeSuite("/home/user/leaseos-2/server/_core/branchGrantLaundering.test.ts"))
      .toBe("server/_core/branchGrantLaundering.test.ts");
    expect(relativeSuite("C:\\a\\b\\client\\src\\x.dom.test.tsx")).toBe("client/src/x.dom.test.tsx");
  });

  it("does not depend on the reporter's colour, which is what broke the last one", () => {
    // The previous check matched `(✓|❯) *server/<name>` against reporter text.
    // In CI vitest emits ` \e[32m✓\e[39m server/x.db.test.ts`, the escape lands
    // between the tick and the space, and the match fails on a run where the
    // suite ran. Nothing here reads that output at all.
    const coloured = "\u001b[32m✓\u001b[39m server/organizationScopedRoles.db.test.ts";
    expect(coloured).toContain("server/organizationScopedRoles.db.test.ts");
    expect(checkGateRun(healthy())).toEqual([]);
  });
});

describe("the counts keep database execution visible", () => {
  it("splits pure from database-backed rather than reporting one total", () => {
    const report: GateReport = {
      testResults: [
        passed("server/pureThing.test.ts", 5),
        { ...passed("server/dbThing.db.test.ts", 2), assertionResults: [{ status: "passed" }, { status: "failed" }] },
        { ...passed("server/other.db.test.ts", 1), assertionResults: [{ status: "skipped" }] },
      ],
    };
    const { pure, db } = splitCounts(report);
    expect(pure).toEqual({ files: 1, passed: 5, failed: 0, skipped: 0 });
    expect(db).toEqual({ files: 2, passed: 1, failed: 1, skipped: 1 });
  });
});
