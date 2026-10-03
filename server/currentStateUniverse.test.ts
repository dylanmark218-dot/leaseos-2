/**
 * Gate 8's generator must count the same test universe the runner executes.
 *
 * On 2026-09-30 `scripts/current-state.sh` discovered tests with `find server -name '*.test.ts'`
 * (378 files) while `vitest.config.ts` also includes `client/src/**\/*.dom.test.tsx` (16 files) and
 * the gate ran 394. The document said 378. The generator now asks the runner — `vitest list
 * --filesOnly` — so the two cannot drift, and this pins it: the generator's list equals the runner's,
 * a `.dom.test.tsx` is in it, and an empty answer fails closed rather than writing a zero.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });

describe("current-state's test universe", () => {
  const runnerFiles = sh("npx", ["vitest", "list", "--filesOnly"]).split("\n").map(s => s.trim()).filter(Boolean).sort();

  it("the runner lists a jsdom suite under client/src, which the old generator never counted", () => {
    expect(runnerFiles.some(f => /^client\/src\/.*\.dom\.test\.tsx$/.test(f))).toBe(true);
  });

  it("the generator's file list is exactly the runner's", () => {
    const listed = sh("bash", ["scripts/current-state.sh", "--list-tests"]).split("\n").map(s => s.trim()).filter(Boolean).sort();
    expect(listed).toEqual(runnerFiles);
  }, 120_000);

  // CI-STATE-1: the count left the committed document for the generated metrics; the property it
  // pinned — the generator's count is the runner's count — moved with it, unchanged.
  it("the generated metrics' file count is the runner's count", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cs-"));
    try {
      const out = path.join(dir, "metrics.json");
      sh("bash", ["scripts/current-state.sh", "--metrics", out]);
      const metrics = JSON.parse(readFileSync(out, "utf8")) as { testFiles: number };
      expect(metrics.testFiles).toBe(runnerFiles.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it("fails closed when the runner reports no files", () => {
    let code = 0; let out = "";
    try { sh("bash", ["scripts/current-state.sh", "--list-tests"], { LEASEOS_VITEST_LIST_CMD: "true" }); }
    catch (e) { const err = e as { status: number; stderr: string }; code = err.status; out = err.stderr; }
    expect(code).not.toBe(0);
    expect(out).toMatch(/no test files/);
  }, 120_000);
});
