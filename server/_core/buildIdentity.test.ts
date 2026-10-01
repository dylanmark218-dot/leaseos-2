/**
 * S2-FLEET-A — the build identity: strict when present, honest when absent, never read from the
 * environment, and actually embedded by the bundler.
 *
 * The bundle tests are the ones that matter. They run esbuild over the real module with the real
 * `define`, evaluate the result, and ask it what build it is — under an environment that tries to
 * say otherwise. A test of the parser alone would prove the parser; these prove the artifact.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  BUILD_SHA_PATTERN,
  BuildIdentityError,
  buildShaOf,
  describeBuild,
  parseBuildIdentity,
  requireBuildIdentity,
  runtimeBuild,
  type RuntimeBuild,
} from "./buildIdentity";

const root = path.resolve(__dirname, "../..");
const SHA = "a".repeat(40);
const IDENTITY = { sha: SHA, release: "v23.30", shaSource: "git" as const };

describe("parseBuildIdentity — exactly the three fields, a full commit id, a release name", () => {
  it("accepts a well-formed identity, as JSON text or as an object, and freezes it", () => {
    const fromText = parseBuildIdentity(JSON.stringify(IDENTITY));
    expect(fromText).toEqual(IDENTITY);
    expect(Object.isFrozen(fromText)).toBe(true);
    expect(parseBuildIdentity({ ...IDENTITY, shaSource: "explicit" })).toEqual({ ...IDENTITY, shaSource: "explicit" });
  });

  it.each([
    ["not JSON", "{sha:", /not JSON/],
    ["an array", "[]", /not an object/],
    ["null", "null", /not an object/],
    ["a short sha", JSON.stringify({ ...IDENTITY, sha: SHA.slice(0, 7) }), /40-character/],
    ["an upper-case sha", JSON.stringify({ ...IDENTITY, sha: SHA.toUpperCase() }), /40-character/],
    ["a non-hex sha", JSON.stringify({ ...IDENTITY, sha: "g".repeat(40) }), /40-character/],
    ["a missing release", JSON.stringify({ sha: SHA, shaSource: "git" }), /expected exactly \[release, sha, shaSource\]/],
    ["an extra field", JSON.stringify({ ...IDENTITY, hostname: "box-1" }), /expected exactly \[release, sha, shaSource\]/],
    ["an empty release", JSON.stringify({ ...IDENTITY, release: "" }), /release name/],
    ["an unknown shaSource", JSON.stringify({ ...IDENTITY, shaSource: "env" }), /shaSource/],
  ])("rejects %s", (_label, raw, message) => {
    expect(() => parseBuildIdentity(raw)).toThrow(BuildIdentityError);
    expect(() => parseBuildIdentity(raw)).toThrow(message);
  });
});

describe("runtimeBuild under the test runner — unbuilt, and production refuses it", () => {
  it("reports unbuilt with a reason, and no sha", () => {
    const build = runtimeBuild();
    expect(build.source).toBe("unbuilt");
    if (build.source === "unbuilt") expect(build.reason).toMatch(/runs from sources/);
    expect(buildShaOf(build)).toBeNull();
    expect(describeBuild(build)).toMatch(/^\[build\] unbuilt: /);
  });

  it("requireBuildIdentity: production refuses an unbuilt process; development accepts it", () => {
    const build = runtimeBuild();
    expect(() => requireBuildIdentity(build, true)).toThrow(BuildIdentityError);
    expect(() => requireBuildIdentity(build, true)).toThrow(/production requires a built artifact/);
    expect(requireBuildIdentity(build, false)).toBe(build);
    const artifact: RuntimeBuild = { source: "artifact", identity: IDENTITY };
    expect(requireBuildIdentity(artifact, true)).toBe(artifact);
    expect(buildShaOf(artifact)).toBe(SHA);
    expect(describeBuild(artifact)).toBe(`[build] sha=${SHA} release=v23.30 source=artifact shaSource=git`);
  });
});

/**
 * Bundle the real module the way scripts/build-server.mjs does (same `define`, same identifier),
 * evaluate it, and ask. CommonJS output so the test can evaluate it in-process.
 */
async function bundled(define?: string): Promise<{ runtimeBuild: () => RuntimeBuild }> {
  const result = await esbuild({
    entryPoints: [path.join(root, "server/_core/buildIdentity.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    define: define === undefined ? {} : { __LEASEOS_BUILD_IDENTITY__: define },
  });
  const code = result.outputFiles![0]!.text;
  const module = { exports: {} as { runtimeBuild: () => RuntimeBuild } };
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports;
}

describe("the embedded identity — what the artifact reports", () => {
  it("a bundle built with the identity defined reports it as an artifact", async () => {
    const mod = await bundled(JSON.stringify(JSON.stringify(IDENTITY)));
    expect(mod.runtimeBuild()).toEqual({ source: "artifact", identity: IDENTITY });
  });

  it("FLEET-M1. the runtime environment cannot override the embedded identity", async () => {
    const mod = await bundled(JSON.stringify(JSON.stringify(IDENTITY)));
    const previous = process.env.LEASEOS_BUILD_SHA;
    process.env.LEASEOS_BUILD_SHA = "b".repeat(40);
    try {
      expect(buildShaOf(mod.runtimeBuild())).toBe(SHA);
    } finally {
      if (previous === undefined) delete process.env.LEASEOS_BUILD_SHA;
      else process.env.LEASEOS_BUILD_SHA = previous;
    }
  });

  it("a bundle built without the define is unbuilt — absence is reported, never guessed", async () => {
    const mod = await bundled();
    expect(mod.runtimeBuild().source).toBe("unbuilt");
  });

  it("a bundle built with a malformed identity throws rather than reporting it", async () => {
    const mod = await bundled(JSON.stringify(JSON.stringify({ ...IDENTITY, sha: "deadbeef" })));
    // The bundle carries its own copy of the class, so match by name and message rather than identity.
    expect(() => mod.runtimeBuild()).toThrow(/40-character lower-case hexadecimal commit id/);
    try {
      mod.runtimeBuild();
    } catch (error) {
      expect((error as Error).name).toBe("BuildIdentityError");
    }
  });

  it("the module reads nothing but the define: no environment, no git, no filesystem", () => {
    const source = readFileSync(path.join(root, "server/_core/buildIdentity.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/child_process|execSync|execFileSync|spawn|rev-parse/);
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/require\(/);
    expect(source.match(/__LEASEOS_BUILD_IDENTITY__/g)).toHaveLength(3); // the declaration, the typeof guard, the one read
    expect(source).toMatch(/typeof __LEASEOS_BUILD_IDENTITY__ === "string"/);
  });
});

describe("scripts/build-identity.mjs — the build-time source of the identity", () => {
  const run = (env: Record<string, string | undefined>) =>
    execFileSync(process.execPath, ["scripts/build-identity.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LEASEOS_BUILD_SHA: undefined, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  it("uses an explicit LEASEOS_BUILD_SHA when it is a full commit id", () => {
    const sha = "c".repeat(40);
    expect(JSON.parse(run({ LEASEOS_BUILD_SHA: sha }))).toEqual({ sha, release: expect.any(String), shaSource: "explicit" });
  });

  it("refuses an explicit sha that is not a full commit id", () => {
    expect(() => run({ LEASEOS_BUILD_SHA: "abc123" })).toThrow(/full 40-character/);
  });

  it("otherwise reads the checkout's HEAD, which makes a local build of one commit deterministic", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const once = JSON.parse(run({}));
    const twice = JSON.parse(run({}));
    expect(once).toEqual({ sha: head, release: readFileSync(path.join(root, "LEASEOS_RELEASE"), "utf8").trim(), shaSource: "git" });
    expect(twice).toEqual(once);
    expect(once.sha).toMatch(BUILD_SHA_PATTERN);
  });
});
