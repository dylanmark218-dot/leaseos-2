/**
 * Gate 4's ratchet must keep the compiler's exit status.
 *
 * The one-line version counted `.test.ts(` lines in tsc's output and discarded tsc's own status
 * with `|| true`. A tsc that could not run produced no such line, so the count was 0 and the gate
 * printed "clean" — reproduced on 2026-09-30 with a tsconfig path that does not exist (tsc exit 1,
 * gate clean). These cases drive the extracted script with small fixture tsconfigs, so each run
 * compiles a handful of files rather than the tree, and pin the three verdicts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/test-file-ratchet.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A fixture project inside the repo (so `pnpm exec tsc` resolves), with its own tsconfig. */
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(path.resolve("."), ".ratchet-fixture-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [] }, include: ["**/*.ts"] }));
  return dir;
}

type Run = { code: number; out: string };
function run(tsconfig: string, pin = "0"): Run {
  try {
    return { code: 0, out: execFileSync("bash", [SCRIPT, tsconfig, pin], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("gate 4 test-file ratchet", () => {
  it("passes a clean fixture with count 0", () => {
    const dir = fixture({ "a.test.ts": "export const a: number = 1;\n" });
    const r = run(path.join(dir, "tsconfig.json"));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/test-file type errors: 0 .*tsc exit 0/);
    expect(r.out).toMatch(/clean/);
  });

  it("fails when a planted test-file type error exceeds the pin, and names the file", () => {
    const dir = fixture({ "broken.test.ts": "export const n: number = \"not a number\";\n" });
    const r = run(path.join(dir, "tsconfig.json"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/test-file type errors: 1/);
    expect(r.out).toMatch(/broken\.test\.ts\(1,14\)/);
  });

  it("fails when tsc cannot run at all — the case the old line reported as clean", () => {
    const r = run(path.join(path.resolve("."), "tsconfig.does-not-exist.json"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/test-file type errors: 0 .*tsc exit [1-9]/);
    expect(r.out).toMatch(/did not run cleanly/);
  });

  it("fails when a NON-test file under the config is broken — also lost by the old line", () => {
    const dir = fixture({ "ok.test.ts": "export const a = 1;\n", "prod.ts": "export const n: number = \"x\";\n" });
    const r = run(path.join(dir, "tsconfig.json"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/test-file type errors: 0 .*tsc exit [1-9]/);
    expect(r.out).toMatch(/prod\.ts\(1,14\)/);
  });

  it("honours a non-zero pin exactly (the ratchet, not a switch)", () => {
    const dir = fixture({ "one.test.ts": "export const n: number = \"x\";\n" });
    expect(run(path.join(dir, "tsconfig.json"), "1").code).toBe(0);
    expect(run(path.join(dir, "tsconfig.json"), "0").code).not.toBe(0);
  });
});
