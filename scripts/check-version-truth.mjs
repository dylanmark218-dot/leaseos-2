#!/usr/bin/env node
/**
 * Runtime version truth: the declarations must agree, and none of them is the authority.
 *
 * LeaseOS states its Node version in three places and its pnpm version in two:
 *
 *   .nvmrc                              what a developer's shell picks up
 *   package.json  engines.node          what the metadata claims
 *   .github/workflows/**                what CI actually runs — every workflow, discovered
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
import { readFileSync, readdirSync } from "node:fs";
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

/*
 * EVERY workflow, discovered — not one filename.
 *
 * This check originally read `.github/workflows/ci.yml` alone, and a starter workflow
 * (`webpack.yml`, with a Node 18/20/22 matrix) walked straight past it. Three unchecked
 * Node declarations entered the repository through the gate built to prevent exactly that.
 * Naming the file was the bug: a gate that inspects one known place only ever catches
 * drift that arrives in that place.
 */
const WORKFLOW_DIR = ".github/workflows";

function discoverWorkflows() {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, relDir), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      // Recursive: a nested directory is still a place a workflow can define a runtime.
      if (entry.isDirectory()) walk(rel);
      else if (/\.ya?ml$/i.test(entry.name)) out.push(rel);
    }
  };
  walk(WORKFLOW_DIR);
  return out.sort();
}

const workflows = discoverWorkflows();

if (nodeMajor !== null) {
  let activeDeclarations = 0;

  for (const path of workflows) {
    const raw = read(path);
    if (raw === null) continue;

    /*
     * A commented-out declaration is not a declaration. Stripping from the first `#` keeps
     * `# node-version: 18` — a note, a disabled matrix entry, an example — from failing a
     * gate it has no power to break. A `#` inside a quoted scalar is not something a
     * node-version value can contain.
     */
    const lines = raw.split("\n").map((l) => l.split("#")[0]);

    lines.forEach((line, index) => {
      // `node-version-file:` is a different key and is not matched: after `node-version`
      // it has `-file:`, not `:`.
      const match = /(?:^|\s)node-version:\s*(.*)$/.exec(line);
      if (!match) return;

      const where = `${path}:${index + 1}`;
      const rest = match[1].trim();
      const tokens = [];

      if (rest.startsWith("[")) {
        /*
         * A YAML flow sequence — `node-version: [18.x, 20.x, 22.x]`. THIS is the form the
         * webpack starter workflow used, and the form the first version of this check was
         * blind to: after `node-version: ` came `[`, so the scalar pattern never matched
         * and three unchecked majors sailed through. A matrix is the most likely place for
         * a stray runtime to appear, which makes it the most important form to read.
         */
        const close = rest.indexOf("]");
        const inner = close === -1 ? rest.slice(1) : rest.slice(1, close);
        tokens.push(...inner.split(",").map((t) => t.trim()).filter(Boolean));
      } else if (rest === "") {
        // A block sequence on the following lines:  node-version:\n  - 18\n  - 22
        for (let i = index + 1; i < lines.length; i += 1) {
          const item = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
          if (!item) {
            if (lines[i].trim() === "") continue;
            break;
          }
          tokens.push(item[1].trim());
        }
      } else {
        /*
         * A plain scalar — but possibly inside a YAML flow mapping, which `ci.yml` uses:
         * `with: { node-version: 22, cache: pnpm }`. Taking the rest of the line whole
         * would read the value as `22, cache: pnpm }`, so the scalar ends at whichever
         * comes first, the separating comma or the closing brace.
         */
        tokens.push(rest.split(/[,}]/)[0]);
      }

      for (const rawToken of tokens) {
        const token = rawToken.replace(/^['"]|['"]$/g, "").trim();
        if (token === "") continue;

        /*
         * An expression indirects to somewhere else — `${{ matrix.node-version }}` points
         * at the matrix, whose literal values are checked where they are declared. Skipped
         * rather than failed, and deliberately NOT counted as an active declaration: it
         * states no version, so it cannot be the one thing keeping this gate honest.
         */
        if (token.startsWith("${{")) continue;

        activeDeclarations += 1;

        // `22`, `22.x`, `22.11.0`, `v22` all name major 22.
        const parsed = /^v?(\d+)(?:\.[\dx*]+)*$/i.exec(token);
        if (!parsed) {
          /*
           * `lts/*`, `latest`, `node` — a moving target this gate cannot pin. Failing is
           * the fail-closed choice: an unverifiable runtime declaration defeats the whole
           * point of comparing declarations.
           */
          fail(
            `${where}: node-version ${JSON.stringify(token)} does not name a fixed version, ` +
              `so it cannot be compared with .nvmrc (${nodeMajor}).`
          );
          continue;
        }

        const major = Number(parsed[1]);
        if (major !== nodeMajor) {
          fail(
            `${where}: node-version is ${major}, but .nvmrc says ${nodeMajor}. ` +
              `CI would run a different runtime than developers.`
          );
        }
      }
    });
  }

  /*
   * A single workflow may legitimately declare no Node at all. The *directory* may not:
   * LeaseOS CI is Node-based, so zero active declarations anywhere means either the setup
   * step was deleted or this check has stopped finding what it is meant to watch. Either
   * way it must not pass quietly.
   */
  if (activeDeclarations === 0) {
    fail(
      `${WORKFLOW_DIR}: no active node-version declaration found in any workflow ` +
        `(${workflows.length} scanned). CI's Node version must be stated so it can be compared.`
    );
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

const scanned = workflows.length === 1 ? "1 workflow" : `${workflows.length} workflows`;
console.log(`version truth: Node ${nodeMajor} (.nvmrc, engines.node, ${scanned}) · pnpm ${pnpmVersion} (packageManager, engines.pnpm)`);
