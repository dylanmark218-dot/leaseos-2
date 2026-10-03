/**
 * CI-STATE-1 — the test totals are measured, published and NOT committed.
 *
 * `LEASEOS_CURRENT_STATE.md` used to carry `Test files / cases` as numbers. Of the 105 commits that had
 * ever changed the document, all 105 changed that row and 69 changed nothing else, so every open
 * branch rewrote one committed line and every merge into main conflicted the rest — PR #105 was
 * re-synced three times in a morning for it. The totals now come from `current-state.sh --metrics`,
 * which gate 8 runs and prints; the document keeps every architecture count and the gate still fails
 * when one of those is stale.
 *
 *   A  adding a test changes the metrics and leaves the committed document byte-identical
 *   B  the metrics are exactly the runner's file list and its `it(` lines
 *   C  a changed architecture count still makes the regenerated document differ (gate 8 fails)
 *   D  the metrics are deterministic for one tree
 *
 * No test is added to the repository to prove A: the runner's list is substituted through the
 * generator's existing LEASEOS_VITEST_LIST_CMD seam, and the extra test file lives in a temp dir.
 * C runs the generator in a temp tree that symlinks the real sources and swaps in one edited schema.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const COMMITTED = readFileSync("LEASEOS_CURRENT_STATE.md", "utf8");
const sh = (args: string[], env: Record<string, string> = {}, cwd = ROOT) =>
  execFileSync("bash", args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
type Metrics = { release: string; testFiles: number; testCases: number };
const itLines = (file: string) => readFileSync(file, "utf8").split("\n").filter(l => /^\s*it\(/.test(l)).length;

let dir: string;
let baseList: string[];
let baseListFile: string;
let plusOneListFile: string;
const EXTRA_CASES = 3;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cs-metrics-"));
  // The runner's real list, asked once.
  baseList = sh(["scripts/current-state.sh", "--list-tests"]).split("\n").map(s => s.trim()).filter(Boolean);
  baseListFile = path.join(dir, "list-base.txt");
  writeFileSync(baseListFile, baseList.join("\n") + "\n");
  // "Branch adds a test": one more file, outside the repository, with three cases.
  const extra = path.join(dir, "added.test.ts");
  writeFileSync(extra, Array.from({ length: EXTRA_CASES }, (_, i) => `  it("added ${i}", () => {});`).join("\n") + "\n");
  plusOneListFile = path.join(dir, "list-plus-one.txt");
  writeFileSync(plusOneListFile, [...baseList, extra].join("\n") + "\n");
}, 120_000);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const metricsWith = (listFile: string | null, name: string): Metrics => {
  const out = path.join(dir, name);
  sh(["scripts/current-state.sh", "--metrics", out], listFile ? { LEASEOS_VITEST_LIST_CMD: `cat ${listFile}` } : {});
  return JSON.parse(readFileSync(out, "utf8")) as Metrics;
};
const documentWith = (listFile: string, name: string) => {
  const out = path.join(dir, name);
  sh(["scripts/current-state.sh", "", out], { LEASEOS_VITEST_LIST_CMD: `cat ${listFile}` });
  return readFileSync(out, "utf8");
};

describe("A — adding a test moves the metrics, not the committed document", () => {
  it("the metrics count the added file and its cases", () => {
    const before = metricsWith(baseListFile, "a-before.json");
    const after = metricsWith(plusOneListFile, "a-after.json");
    expect(after.testFiles).toBe(before.testFiles + 1);
    expect(after.testCases).toBe(before.testCases + EXTRA_CASES);
  }, 60_000);

  it("the document generated with and without the added test is byte-identical, and is the committed one", () => {
    const without = documentWith(baseListFile, "a-without.md");
    const withAdded = documentWith(plusOneListFile, "a-with.md");
    expect(withAdded).toBe(without);
    expect(without).toBe(COMMITTED);
  }, 60_000);

  it("the document carries no test total at all, and the template has no placeholder for one", () => {
    const row = COMMITTED.split("\n").find(l => l.startsWith("| Test files / cases"));
    expect(row, "the row stays, saying where the numbers are").toBeDefined();
    expect(row!.split("|")[2]).not.toMatch(/\d/);
    expect(row).toContain("--metrics");
    const script = readFileSync("scripts/current-state.sh", "utf8");
    expect(script).not.toMatch(/@@TEST_(FILES|CASES)@@/);
  });
});

describe("B — the metrics are the runner's test universe", () => {
  it("testFiles is the runner's list and testCases its `it(` lines", () => {
    const m = metricsWith(null, "b.json");
    expect(m.testFiles).toBe(baseList.length);
    expect(m.testCases).toBe(baseList.reduce((n, f) => n + itLines(f), 0));
    expect(m.release).toBe(readFileSync("LEASEOS_RELEASE", "utf8").trim());
  }, 120_000);

  it("fails closed, writing nothing, when the runner lists no tests", () => {
    const out = path.join(dir, "b-empty.json");
    const run = spawnSync("bash", ["scripts/current-state.sh", "--metrics", out], { cwd: ROOT, encoding: "utf8", env: { ...process.env, LEASEOS_VITEST_LIST_CMD: "true" } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/no test files/);
    expect(existsSync(out)).toBe(false);
  });
});

describe("C — a stale architecture count still fails the truth gate", () => {
  it("one more table in the schema makes the regenerated document differ from the committed one, in the Tables row only", () => {
    // A tree that is the repository except for one edited file: the generator reads the tree it sits in.
    const tree = path.join(dir, "tree");
    mkdirSync(path.join(tree, "scripts"), { recursive: true });
    mkdirSync(path.join(tree, "drizzle"));
    copyFileSync("scripts/current-state.sh", path.join(tree, "scripts/current-state.sh"));
    copyFileSync("LEASEOS_RELEASE", path.join(tree, "LEASEOS_RELEASE"));
    for (const d of ["server", "client", "node_modules"]) symlinkSync(path.join(ROOT, d), path.join(tree, d));
    for (const f of readdirSync("drizzle")) if (f.endsWith(".sql")) symlinkSync(path.join(ROOT, "drizzle", f), path.join(tree, "drizzle", f));
    writeFileSync(path.join(tree, "drizzle/schema.ts"), readFileSync("drizzle/schema.ts", "utf8") + '\nexport const ciStateProbe = mysqlTable("ciStateProbe", {});\n');

    const out = path.join(dir, "c.md");
    sh(["scripts/current-state.sh", "", out], { LEASEOS_VITEST_LIST_CMD: `cat ${baseListFile}` }, tree);
    const regenerated = readFileSync(out, "utf8");

    expect(regenerated).not.toBe(COMMITTED); // gate 8's `diff -q` fails on exactly this
    const changed = regenerated.split("\n").filter((l, i) => l !== COMMITTED.split("\n")[i]);
    expect(changed).toHaveLength(1);
    const committedTables = Number(/\| Tables \| \*\*(\d+)\*\*/.exec(COMMITTED)![1]);
    expect(changed[0]).toContain(`| Tables | **${committedTables + 1}**`);
  }, 60_000);

  it("gate 8 still compares the whole regenerated document, and runs the metrics after it", () => {
    const gate = readFileSync("scripts/ci-gate.sh", "utf8");
    const g8 = gate.slice(gate.indexOf("== 8. Current-state document"));
    expect(g8).toMatch(/diff -q "\$CURRENT_STATE_BEFORE" LEASEOS_CURRENT_STATE\.md/);
    expect(g8.indexOf("--metrics")).toBeGreaterThan(g8.indexOf("diff -q"));
  });
});

describe("D — deterministic for one tree", () => {
  it("two metrics runs over the same tree are byte-identical", () => {
    const a = path.join(dir, "d1.json"), b = path.join(dir, "d2.json");
    sh(["scripts/current-state.sh", "--metrics", a]);
    sh(["scripts/current-state.sh", "--metrics", b]);
    expect(readFileSync(b, "utf8")).toBe(readFileSync(a, "utf8"));
    // Nothing in it that varies by run: three keys, in this order, no clock, no host.
    expect(Object.keys(JSON.parse(readFileSync(a, "utf8")))).toEqual(["release", "testFiles", "testCases"]);
  }, 120_000);

  it("the artifact location is ignored by git, so the totals cannot drift back into a commit", () => {
    const run = spawnSync("git", ["check-ignore", "-q", "artifacts/current-state-metrics.json"], { cwd: ROOT });
    expect(run.status).toBe(0);
  });
});
