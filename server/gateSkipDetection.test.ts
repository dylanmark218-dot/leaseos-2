/**
 * Gate 6's skipped-suite check must give the same verdict whatever the terminal did to the text.
 *
 * On 2026-09-30 the check was a grep for `↓` over the basic reporter's output, and under `CI=true`
 * — GitHub Actions' environment — vitest coloured the glyph so the grep matched nothing. The check
 * had never fired in CI. These cases pin the replacement: the verdict comes from the JSON report,
 * so colour cannot reach it; a real skipping suite under both environments is detected; and a
 * report that is empty or unreadable fails closed instead of reading as "nothing skipped".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_SUITE, judgeSkips, judgeSkipsFile } from "../scripts/skipped-db-suites";

const file = (name: string, statuses: string[]) => ({ name: `/repo/${name}`, status: "passed", assertionResults: statuses.map(status => ({ status })) });

describe("the verdict is read from structure, so colour cannot change it", () => {
  it("detects a database suite whose every case skipped", () => {
    const v = judgeSkips({ testResults: [file("server/a.db.test.ts", ["skipped", "skipped"]), file("server/b.test.ts", ["passed"])] });
    expect(v).toEqual({ ok: false, reason: expect.stringMatching(/skipped while a database is configured/), skipped: ["server/a.db.test.ts"] });
  });

  it("detects a database suite with no cases at all (describe.skip around everything)", () => {
    expect(judgeSkips({ testResults: [file("server/a.db.test.ts", [])] }).ok).toBe(false);
  });

  it("passes a database suite that ran, and ignores a non-database suite that skipped — the policy is unchanged", () => {
    expect(judgeSkips({ testResults: [file("server/a.db.test.ts", ["passed", "skipped"]), file("server/pinned.test.ts", ["skipped"])] })).toEqual({ ok: true, filesSeen: 2 });
    expect(DB_SUITE.test("server/pinned.test.ts")).toBe(false);
  });

  it("fails closed on a missing, unparsable or empty report", () => {
    expect(judgeSkips(null).ok).toBe(false);
    expect(judgeSkips({}).ok).toBe(false);
    expect(judgeSkips({ testResults: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/zero test files/) });
    const dir = mkdtempSync(path.join(tmpdir(), "skipjson-"));
    try {
      writeFileSync(path.join(dir, "bad.json"), "{ not json");
      expect(judgeSkipsFile(path.join(dir, "bad.json")).ok).toBe(false);
      expect(judgeSkipsFile(path.join(dir, "absent.json")).ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * The real reporter, under both environments. This is the reproduction that found the defect,
 * turned permanent: the same skipping suite, once with CI unset and once with CI=true and
 * GITHUB_ACTIONS=true as Actions sets them, and the JSON verdict must be identical.
 */
describe("a real skipping suite under CI and not", () => {
  const SUITE = "server/academyTdgWiring.db.test.ts"; // gates on DATABASE_URL; skips when it is unset
  const run = (extraEnv: Record<string, string | undefined>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "skiprun-"));
    const out = path.join(dir, "report.json");
    const env: Record<string, string | undefined> = { ...process.env, ...extraEnv, DATABASE_URL: undefined, WIDGET_DB_URL: undefined };
    let text = "";
    try {
      text = execFileSync("npx", ["vitest", "run", SUITE, "--reporter=basic", "--reporter=json", `--outputFile.json=${out}`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { text = String((e as { stdout?: string }).stdout ?? ""); }
    const verdict = judgeSkipsFile(out);
    rmSync(dir, { recursive: true, force: true });
    return { verdict, text };
  };

  it("is detected with CI unset", () => {
    const { verdict } = run({ CI: undefined, GITHUB_ACTIONS: undefined, FORCE_COLOR: undefined });
    expect(verdict).toMatchObject({ ok: false, skipped: [SUITE] });
  }, 120_000);

  it("is detected with CI=true, where the old grep matched nothing", () => {
    const { verdict, text } = run({ CI: "true", GITHUB_ACTIONS: "true" });
    expect(verdict).toMatchObject({ ok: false, skipped: [SUITE] });
    // The old check, applied to this same run's text, is the defect made visible: colour is
    // present and the anchored glyph pattern finds nothing.
    const oldGrep = text.split("\n").filter(l => /^ *↓ .*\.db\.test\.ts/.test(l)).length;
    const colouredGlyph = /\x1b\[[0-9;]*m↓/.test(text) || /\x1b\[[0-9;]*m[^\n]*↓/.test(text);
    if (colouredGlyph) expect(oldGrep).toBe(0);
  }, 120_000);
});
