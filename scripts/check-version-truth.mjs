#!/usr/bin/env node
/**
 * Runtime version truth: the declarations must agree, and none of them is the authority.
 *
 * LeaseOS states its Node version in three places and its pnpm version in two:
 *
 *   .nvmrc                              what a developer's shell picks up
 *   package.json  engines.node          what the metadata claims
 *   .github/workflows/ci.yml            what CI actually runs
 *
 *   package.json  packageManager        what Corepack enforces, integrity hash and all
 *   package.json  engines.pnpm          what the metadata claims
 *
 * They disagreed before RH-2: `@types/node` sat on 24 while CI ran 22, which let a
 * Node-24-only API type-check here and fail in production. That mismatch was latent for
 * some time because nothing compared the declarations to each other.
 *
 * WHY THIS SCRIPT DERIVES RATHER THAN ASSERTS. Writing `expect(major).toBe(22)` here would
 * add a *fourth* place that has to be edited when the runtime moves, and the first three
 * could then drift from each other while this one stayed green. So nothing below names a
 * version. `.nvmrc` is read and everything else is compared against it; `packageManager`
 * is read and `engines.pnpm` is compared against that. A deliberate Node upgrade edits the
 * declarations and this script keeps passing, which is the point — it checks agreement,
 * not a value.
 *
 * Run by `scripts/ci-gate.sh` as gate 0a, before anything expensive.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (msg) => problems.push(msg);

const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch (error) {
    fail(`${rel}: cannot be read (${error.code ?? error.message}). Version truth cannot be established without it.`);
    return null;
  }
};

/* ------------------------------------------------------------------ Node */

const nvmrcRaw = read(".nvmrc");
let nodeMajor = null;

if (nvmrcRaw !== null) {
  const trimmed = nvmrcRaw.trim();
  const match = /^v?(\d+)(?:\.\d+)*$/.exec(trimmed);
  if (!match) {
    fail(`.nvmrc: expected a Node version such as "22", found ${JSON.stringify(trimmed)}.`);
  } else {
    nodeMajor = Number(match[1]);
  }
}

const pkgRaw = read("package.json");
let pkg = null;

if (pkgRaw !== null) {
  try {
    pkg = JSON.parse(pkgRaw);
  } catch (error) {
    fail(`package.json: is not valid JSON (${error.message}).`);
  }
}

if (pkg && nodeMajor !== null) {
  const declared = pkg.engines?.node;
  if (typeof declared !== "string") {
    fail(`package.json engines.node: missing. It must pin the single major that .nvmrc names (${nodeMajor}).`);
  } else {
    /*
     * Deliberately strict about the shape. A looser range like ">=22" would satisfy a
     * "matches .nvmrc" test while silently permitting the next two majors, which is the
     * drift this gate exists to stop — so only an explicit one-major window is accepted.
     */
    const lower = /(?:^|\s)>=\s*(\d+)/.exec(declared);
    const upper = /(?:^|\s)<\s*(\d+)/.exec(declared);

    if (!lower || !upper) {
      fail(
        `package.json engines.node: ${JSON.stringify(declared)} is not a single-major range. ` +
          `Expected the form ">=${nodeMajor} <${nodeMajor + 1}".`
      );
    } else {
      const from = Number(lower[1]);
      const to = Number(upper[1]);
      if (from !== nodeMajor) {
        fail(
          `package.json engines.node: lower bound is ${from}, but .nvmrc says ${nodeMajor}. ` +
            `One of the two drifted.`
        );
      }
      if (to !== nodeMajor + 1) {
        fail(
          `package.json engines.node: upper bound is ${to}, which does not close the window on ` +
            `major ${nodeMajor}. Expected "<${nodeMajor + 1}".`
        );
      }
    }
  }
}

const workflowPath = ".github/workflows/ci.yml";
const workflowRaw = read(workflowPath);

if (workflowRaw !== null && nodeMajor !== null) {
  const found = [...workflowRaw.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => ({
    major: Number(m[1]),
    line: workflowRaw.slice(0, m.index).split("\n").length,
  }));

  /*
   * Zero declarations is a failure, not a pass. A check that only compares what it finds
   * goes quietly green the moment the thing it was watching is deleted.
   */
  if (found.length === 0) {
    fail(`${workflowPath}: no node-version declaration found. CI's Node version must be stated so it can be compared.`);
  }

  for (const { major, line } of found) {
    if (major !== nodeMajor) {
      fail(`${workflowPath}:${line}: node-version is ${major}, but .nvmrc says ${nodeMajor}. CI would run a different runtime than developers.`);
    }
  }
}

/* ------------------------------------------------------------------ pnpm */

let pnpmVersion = null;

if (pkg) {
  const declared = pkg.packageManager;
  if (typeof declared !== "string") {
    fail(`package.json packageManager: missing. It is the authoritative pnpm declaration — CI passes no version to pnpm/action-setup precisely so this pin decides.`);
  } else {
    const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+|$)/.exec(declared);
    if (!match) {
      fail(`package.json packageManager: ${JSON.stringify(declared.slice(0, 40))}… does not name a pnpm version in the form "pnpm@X.Y.Z".`);
    } else {
      pnpmVersion = match[1];
    }
  }
}

if (pkg && pnpmVersion !== null) {
  const declared = pkg.engines?.pnpm;
  if (typeof declared !== "string") {
    fail(`package.json engines.pnpm: missing. It must equal the version packageManager pins (${pnpmVersion}).`);
  } else if (declared !== pnpmVersion) {
    fail(`package.json engines.pnpm: is ${JSON.stringify(declared)}, but packageManager pins ${pnpmVersion}. packageManager wins — it carries the integrity hash Corepack enforces.`);
  }
}

if (pkg) {
  /*
   * RH-2 removed this. It mattered: the devDependency said ^10.15.1 (resolving to 10.18.0)
   * while packageManager pinned 10.4.1, so the repository carried two answers and nothing
   * consulted the second. `pnpm` as a *config* block is a different key and is untouched.
   */
  const duplicate = pkg.devDependencies?.pnpm ?? pkg.dependencies?.pnpm;
  if (duplicate) {
    fail(`package.json: a pnpm dependency (${JSON.stringify(duplicate)}) has returned. packageManager is the single pnpm authority; a second declaration can only disagree with it.`);
  }
}

/* ---------------------------------------------------------------- verdict */

if (problems.length > 0) {
  console.error("FAIL: runtime version declarations disagree.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`version truth: Node ${nodeMajor} (.nvmrc, engines.node, ${workflowPath}) · pnpm ${pnpmVersion} (packageManager, engines.pnpm)`);
