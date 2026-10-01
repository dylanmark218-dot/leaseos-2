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
 * THE CONTRACT TIGHTENED ON 2026-10-01. `.nvmrc` pins an EXACT build, not a major: the same
 * commit answered a Pacific date two different ways on two runner images because a major
 * floats across patch builds, and patch builds carry different ICU and tz data. So a
 * workflow literal now has to be that exact build (or, better, `node-version-file: .nvmrc`),
 * `.nvmrc` itself may not be a bare major, and in CI the running build must be the pinned
 * one. VTP15–VTP17 pin those; VTP2's "22.x is fine" became "22.x floats and is refused".
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

/**
 * The build these fixtures pin: whatever is running this test. The checker compares the pin
 * with the running process, and the child is spawned on `process.execPath`, so a fixture that
 * pins anything else is testing the runtime check (VTP17), not the declaration checks.
 */
const PIN = process.versions.node;
const MAJOR = PIN.split(".")[0];

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The valid LeaseOS truth, which every fixture starts from and each case perturbs. */
const BASE_PACKAGE = {
  name: "fixture",
  packageManager: "pnpm@10.4.1+sha512.fixture",
  engines: { node: `>=${MAJOR} <${Number(MAJOR) + 1}`, pnpm: "10.4.1" },
  devDependencies: {} as Record<string, string>,
};

/** The shape `.github/workflows/ci.yml` actually uses today: the file, not a literal. */
const COMPLIANT_CI = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
`;

/** The older shape, still legal when the literal is the exact pin — and the parser trap VTP1 guards. */
const LITERAL_CI = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: ${PIN}, cache: pnpm }
`;

type Fixture = {
  nvmrc?: string;
  packageJson?: Record<string, unknown>;
  workflows?: Record<string, string>;
  /** `ci` runs the child as GitHub Actions would; `local` strips the CI markers. Default: local. */
  mode?: "ci" | "local";
};

function runVersionTruthFixture(fixture: Fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), "leaseos-vt-"));
  created.push(root);

  writeFileSync(join(root, ".nvmrc"), fixture.nvmrc ?? `${PIN}\n`);
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

  // The environment decides whether a runtime mismatch fails (CI) or is reported (local).
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CI" && k !== "GITHUB_ACTIONS") env[k] = v;
  if (fixture.mode === "ci") { env.CI = "true"; env.GITHUB_ACTIONS = "true"; }

  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", env });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("VTP1 — the repository's own CI shape keeps passing", () => {
  it("accepts node-version-file: .nvmrc inside a flow mapping with a trailing key", () => {
    const run = runVersionTruthFixture();
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain(`version truth: Node ${PIN}`);
  });

  /*
   * Not a formality. Teaching the parser to read `[18.x, 20.x]` made it read
   * `{ node-version: 22, cache: pnpm }` as the value `"22, cache: pnpm }"` and the baseline
   * went red. This is the guard against fixing the matrix by breaking ci.yml again.
   */
  it("accepts an exact literal in a flow mapping with a trailing key after the version", () => {
    const run = runVersionTruthFixture({ workflows: { "ci.yml": LITERAL_CI } });
    expect(run.status, run.output).toBe(0);
  });

  it("names how many workflows it scanned, so a silent zero is visible", () => {
    expect(runVersionTruthFixture().stdout).toMatch(/1 workflow\b/);
  });

  it("prints the running Node, ICU and tz data, because they are what a patch build changes", () => {
    const run = runVersionTruthFixture();
    expect(run.stdout).toMatch(new RegExp(`runtime: Node ${PIN.replace(/\./g, "\\.")} · ICU \\S+ · tz \\S+`));
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

  it("refuses the 22.x the matrix also lists: a major floats across patch builds", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "webpack.yml": WEBPACK },
    });
    expect(run.output).toMatch(/node-version "22\.x" is not an exact build/);
  });
});

describe("VTP3/VTP4 — matrix forms", () => {
  it("VTP3. a flow sequence of the exact pin passes, quoted or not", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "m.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: [${PIN}, "${PIN}", '${PIN}']\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("VTP3b. a flow sequence that names the major, or major.x, fails", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "m.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: [${MAJOR}.x, "${MAJOR}"]\n`,
      },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("not an exact build");
  });

  it("VTP4. a block sequence naming 18 fails", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "m.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version:\n          - ${PIN}\n          - 18\n`,
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

describe("VTP8/VTP9 — text that looks like a declaration, and the file that is one", () => {
  it("VTP8. commented-out declarations are ignored, scalar and matrix alike", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "c.yml": `name: C\njobs:\n  a:\n    steps:\n      # node-version: 18\n      # node-version: [18.x, 20.x]\n      - run: echo ok\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("VTP9. node-version-file: .nvmrc is the declaration — on its own it satisfies non-vacuity", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "f.yml": `name: F\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n`,
      },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("VTP9b. node-version-file pointing anywhere but .nvmrc fails: a second file is a second answer", () => {
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "f.yml": `name: F\njobs:\n  a:\n    steps:\n      - with:\n          node-version-file: .node-version\n`,
      },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain(".node-version");
    expect(run.output).toContain("f.yml");
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
      packageJson: { ...BASE_PACKAGE, engines: { node: BASE_PACKAGE.engines.node, pnpm: "10.15.1" } },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("10.4.1");
  });

  it("VTP12. engines.node drifting from .nvmrc's major fails", () => {
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
        "multi.yml": `name: M\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: [\n          ${PIN},\n          23\n        ]\n`,
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

describe("VTP15/VTP16 — the pin is an exact build, and every literal is that build", () => {
  it("VTP15. a major-only .nvmrc fails, naming the drift it allows", () => {
    const run = runVersionTruthFixture({ nvmrc: `${MAJOR}\n` });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("expected an exact Node build");
    expect(run.output).toContain("patch builds");
  });

  it("VTP16. a literal naming a different build of the same major fails, naming both", () => {
    const other = `${MAJOR}.0.0`;
    const run = runVersionTruthFixture({
      workflows: {
        "ci.yml": COMPLIANT_CI,
        "o.yml": `name: O\njobs:\n  a:\n    steps:\n      - with: { node-version: ${other} }\n`,
      },
    });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain(other);
    expect(run.output).toContain(PIN);
  });

  it("VTP16b. the exact literal passes — the pin is the contract, not the file name", () => {
    const run = runVersionTruthFixture({
      workflows: { "o.yml": `name: O\njobs:\n  a:\n    steps:\n      - with: { node-version: ${PIN} }\n` },
    });
    expect(run.status, run.output).toBe(0);
  });
});

describe("VTP17 — the running build is compared with the pin, and a mismatch fails everywhere", () => {
  const foreign = `${MAJOR}.0.1`;

  it("in CI, a running build other than the pin fails", () => {
    const run = runVersionTruthFixture({ nvmrc: `${foreign}\n`, mode: "ci" });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain(`the running Node is ${PIN}, but .nvmrc pins ${foreign}`);
  });

  it("locally — CI unset — the same mismatch fails the same way: no warn-only mode exists", () => {
    const run = runVersionTruthFixture({ nvmrc: `${foreign}\n`, mode: "local" });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain(`the running Node is ${PIN}, but .nvmrc pins ${foreign}`);
    expect(run.output).toContain("The gate runs only on the pinned build");
  });

  it("the pinned build passes, in CI and locally, with nothing on stderr", () => {
    for (const mode of ["ci", "local"] as const) {
      const run = runVersionTruthFixture({ mode });
      expect(run.status, run.output).toBe(0);
      expect(run.stderr).toBe("");
    }
  });
});

describe("an expression never erases the matrix that supplies its values", () => {
  const withMatrix = (list: string) =>
    `name: X\njobs:\n  a:\n    strategy:\n      matrix:\n        node-version: ${list}\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node-version }}\n`;

  it("passes when every entry in the matrix is the exact pin", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "x.yml": withMatrix(`[${PIN}]`) },
    });
    expect(run.status, run.output).toBe(0);
  });

  it("fails when the matrix contains an unsupported major", () => {
    const run = runVersionTruthFixture({
      workflows: { "ci.yml": COMPLIANT_CI, "x.yml": withMatrix(`[18, ${PIN}]`) },
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
