/**
 * Gate 0a's own correctness, made permanent.
 *
 * RH-3 added `scripts/check-version-truth.mjs` and proved it with mutations that were
 * planted by hand and then deleted. That evidence expired the moment it was collected, and
 * the gap it left was not hypothetical: a starter workflow declaring
 * `node-version: [18.x, 20.x, 22.x]` entered `main` past a gate built to prevent exactly
 * that, and the first attempt at widening the checker *still* missed it — because every
 * synthetic case written at the time used `node-version: 18`, the form already in mind,
 * rather than the matrix form that actually escaped.
 *
 * So the centrepiece here (VTP2) replays the real `webpack.yml` structure verbatim. The
 * rest exist because the fix for that one nearly broke the repository's own CI file: making
 * `[...]` parse caused the scalar branch to read `with: { node-version: 22, cache: pnpm }`
 * as the value `"22, cache: pnpm }"`. VTP1 pins that shape so the next parser change cannot
 * repeat it.
 *
 * TESTED AT THE CLI BOUNDARY, ON PURPOSE. Each case writes a throwaway repository — an
 * `.nvmrc`, a `package.json`, some workflows — and runs the real script as a child process
 * with `cwd` set to that fixture, exactly as `ci-gate.sh` invokes it. Nothing here
 * re-implements the policy; a test that reimplements the thing it checks agrees with itself
 * no matter what production does. What is asserted is the process exit status and the
 * operator-facing output.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** The real production script. Read from disk at run time, so it can never go stale. */
const CHECKER = resolve(process.cwd(), "scripts/check-version-truth.mjs");

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The valid LeaseOS truth, which every fixture starts from and each case perturbs. */
const BASE_PACKAGE = {
  name: "fixture",
  packageManager: "pnpm@10.4.1+sha512.fixture",
  engines: { node: ">=22 <23", pnpm: "10.4.1" },
  devDependencies: {} as Record<string, string>,
};

/** The shape `.github/workflows/ci.yml` actually uses today. */
const COMPLIANT_CI = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
`;

type Fixture = {
  nvmrc?: string;
  packageJson?: Record<string, unknown>;
  workflows?: Record<string, string>;
};

function runVersionTruthFixture(fixture: Fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), "leaseos-vt-"));
  created.push(root);

  writeFileSync(join(root, ".nvmrc"), fixture.nvmrc ?? "22\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(fixture.packageJson ?? BASE_PACKAGE, null, 2)
  );

  const workflows = fixture.workflows ?? { "ci.yml": COMPLIANT_CI };
  for (const [rel, body] of Object.entries(workflows)) {
    const full = join(root, ".github/workflows", rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }

  /*
   * The script resolves its repository root from its own location (`import.meta.url`), not
   * from `cwd` — deliberately, so it behaves the same wherever the gate invokes it from.
   * That means pointing `cwd` at a fixture achieves nothing: the first draft of this file
   * did exactly that and every case silently ran against the real repository, which is why
   * invariants known to work appeared to fail.
   *
   * So the fixture gets its own `scripts/` directory and the real file is copied into it
   * verbatim, at run time. It is still production code under test — byte-identical, never a
   * reimplementation of the policy — and copying at run time means it cannot drift from the
   * script the gate actually runs.
   */
  mkdirSync(join(root, "scripts"), { recursive: true });
  const checker = join(root, "scripts/check-version-truth.mjs");
  copyFileSync(CHECKER, checker);

  const result = spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("VTP1 — the repository's own CI shape keeps passing", () => {
  /*
   * Not a formality. Teaching the parser to read `[18.x, 20.x]` made it read
   * `{ node-version: 22, cache: pnpm }` as the value `"22, cache: pnpm }"` and the baseline
   * went red. This is the guard against fixing the matrix by breaking ci.yml again.
   */
  it("accepts a flow mapping with a trailing key after the version", () => {
    const run = runVersionTruthFixture();
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("version truth: Node 22");
  });

  it("names how many workflows it scanned, so a silent zero is visible", () => {
    expect(runVersionTruthFixture().stdout).toMatch(/1 workflow\b/);
  });
});

describe("VTP2 — the real escaped webpack.yml, replayed verbatim", () => {
  /*
   * The regression that matters. This is the structure that entered `main`: the majors live
   * in a matrix and the step refers to them through an expression. A checker that reads only
   * the step sees `${{ matrix.node-version }}` and learns nothing.
   */
  const WEBPACK = `name: NodeJS with Webpack

on:
  push:
    branches: [ "main" ]

jobs:
  build:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [18.x, 20.x, 22.x]

    steps:
    - uses: actions/checkout@v4
    - name: Use Node.js \${{ matrix.node-version }}
      uses: actions/setup-node@v4
      with:
        node-version: \${{ matrix.node-version }}
    - run: npm install
`;

  it("fails", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "webpack.yml": WEBPACK },
    });
    expect(run.status, run.output).not.toBe(0);
  });

  it("names both unsupported majors, the file and the matrix line", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "webpack.yml": WEBPACK },
    });

    expect(run.output).toContain("18");
    expect(run.output).toContain("20");
    expect(run.output).toContain("webpack.yml");
    // Line 13 is the `node-version: [18.x, 20.x, 22.x]` declaration.
    expect(run.output, "an operator needs the line, not just the file").toContain("webpack.yml:13");
  });

  it("does not complain about the 22.x the matrix also lists", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "webpack.yml": WEBPACK },
    });
    expect(run.output).not.toMatch(/node-version is 22, but/);
  });
});

describe("VTP3/VTP4 — matrix forms", () => {
  it("VTP3. a compliant flow sequence passes, quoted or not", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "m.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: [22.x, "22", '22']\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("VTP4. a block sequence naming 18 fails", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "m.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version:\n          - 22\n          - 18\n`,
      },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("18");
  });
});

describe("VTP5 — discovery reaches .yaml and nested directories", () => {
  it("finds a violation in .github/workflows/nested/version-check.yaml", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "nested/version-check.yaml": `name: N\njobs:\n  a:\n    steps:\n      - with: { node-version: 23 }\n`,
      },
    });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("nested/version-check.yaml");
    expect(run.output).toContain("23");
  });
});

describe("VTP6/VTP7 — a workflow may state no Node; the directory may not", () => {
  it("VTP6. a Node-less workflow passes while a valid declaration exists elsewhere", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "labels.yml": `name: labels\non: pull_request\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("VTP7. zero active declarations anywhere fails as non-vacuous", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "labels.yml": `name: labels\non: pull_request\njobs:\n  label:\n    steps:\n      - run: echo ok\n`,
      },
    });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("no active node-version declaration");
  });
});

describe("VTP8/VTP9 — text that looks like a declaration but is not one", () => {
  it("VTP8. commented-out declarations are ignored, scalar and matrix alike", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "c.yml": `name: C\njobs:\n  a:\n    steps:\n      # node-version: 18\n      # node-version: [18.x, 20.x]\n      - run: echo ok\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("VTP9. node-version-file is a different key and is not read as a version", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "f.yml": `name: F\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });
});

describe("VTP10/VTP11/VTP12 — the pnpm and Node invariants still hold", () => {
  it("VTP10. a duplicate pnpm devDependency fails", () => {
    const run = runVersionTruthFixture({
      packageJson: { ...BASE_PACKAGE, devDependencies: { pnpm: "^10.15.1" } },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("pnpm");
  });

  it("VTP11. engines.pnpm drifting from packageManager fails", () => {
    const run = runVersionTruthFixture({
      packageJson: { ...BASE_PACKAGE, engines: { node: ">=22 <23", pnpm: "10.15.1" } },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("10.4.1");
  });

  it("VTP12. engines.node drifting from .nvmrc fails", () => {
    const run = runVersionTruthFixture({
      packageJson: { ...BASE_PACKAGE, engines: { node: ">=23 <24", pnpm: "10.4.1" } },
    });
    expect(run.status, run.output).not.toBe(0);
  });
});

describe("VTP13/VTP14 — an active declaration it cannot pin must fail, not be skipped", () => {
  /*
   * The security property, stated as a test rather than as an intention: a visible
   * `node-version` the checker cannot confidently normalize has to fail closed. Silently
   * ignoring one is strictly worse than refusing it — the gate reports success while a
   * runtime declaration sits unchecked, which is the precise failure that let webpack.yml in.
   *
   * These forms are not supported today and are not required to be. When a future change
   * swaps this hand-rolled parsing for a real YAML parser, these assertions become
   * "resolves correctly" instead of "refuses" — deliberately, not by accident.
   */
  it("VTP13. a flow sequence spanning several lines is refused, not ignored", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "multi.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: [\n          22,\n          23\n        ]\n`,
      },
    });

    expect(run.status, `a declaration it cannot read must not pass:\n${run.output}`).not.toBe(0);
    expect(run.output).toContain("multi.yml");
  });

  it("VTP14. a YAML alias is refused rather than guessed at", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "alias.yml": `name: A\njobs:\n  a:\n    steps:\n      - with:\n          node-version: *node_version\n`,
      },
    });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("alias.yml");
  });
});

describe("an expression never erases the matrix that supplies its values", () => {
  const withMatrix = (list: string) =>
    `name: X\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: ${list}\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node-version }}\n`;

  it("passes when every major in the matrix is supported", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "x.yml": withMatrix("[22]") },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("fails when the matrix contains an unsupported major", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "x.yml": withMatrix("[18, 22]") },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("18");
  });

  it("an expression alone does not satisfy the non-vacuity requirement", () => {
    // If `${{ }}` counted as a declaration, a repository whose only 'Node version' was an
    // indirection would pass while stating no version at all.
    const run = runVersionTruthFixture({
      workflows: {
        "only.yml": `name: O\njobs:\n  a:\n    steps:\n      - with:\n          node-version: \${{ matrix.node-version }}\n`,
      },
    });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("no active node-version declaration");
  });
});
