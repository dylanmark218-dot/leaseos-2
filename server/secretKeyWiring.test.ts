/**
 * S2-KMS-A — the wiring that makes one production key source, read from the repository.
 *
 * Behaviour tests prove the bootstrap; these prove that the processes actually run it, in the
 * right order, from the same place, and that nothing quietly keeps a second source alive. Each is
 * a fact about the shape of the tree: the server starts keys before the worker and before the API,
 * the worker starts them first, every runtime call site asks the one accessor, the only places
 * that still build an environment provider directly are the accessor's own fallback and the
 * readiness report that describes environment variables, and no production source knows the test
 * backend exists.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const strip = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (p: string) => strip(readFileSync(p, "utf8"));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
const serverSources = () => walk("server");

describe("KMS-T12 — server and worker bootstrap the same provider source, first", () => {
  it("startup.ts bootstraps keys after the secret check and before the worker, the API and readiness", () => {
    const startup = code("server/_core/startup.ts");
    const at = (needle: RegExp) => {
      const m = startup.search(needle);
      expect(m, `${needle} present in startup.ts`).toBeGreaterThan(-1);
      return m;
    };
    const bootstrap = at(/await bootstrapSecretKeys\(\)/);
    expect(bootstrap).toBeGreaterThan(at(/assertProductionSecrets\(/));
    expect(bootstrap).toBeLessThan(at(/await startProductionWorker\(\)/));
    expect(bootstrap).toBeLessThan(at(/registerApi\(app\)/));
    expect(bootstrap).toBeLessThan(at(/readiness\.markReady\(\)/));
    expect(startup, "no try/catch around the bootstrap: a failure propagates to reportStartupFailure").not.toMatch(/try\s*\{[^}]*bootstrapSecretKeys/);
  });

  it("worker.ts bootstraps keys before starting the worker, with the same function", () => {
    const worker = code("server/_core/worker.ts");
    const bootstrap = worker.search(/await bootstrapSecretKeys\(\)/);
    const start = worker.search(/await startProductionWorker\(\)/);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(start);
    expect(worker).toMatch(/from "\.\/secretKeys"/);
    expect(worker).not.toMatch(/try\s*\{[^}]*bootstrapSecretKeys/);
  });

  it("every runtime call site asks the one accessor; direct environment providers exist only where classified", () => {
    /*
     * Classification of `environmentSecretKeys(` in production sources:
     *   server/_core/secretKeys.ts — the definition, the accessor's non-managed path, the resolver's
     *                                environment branch, and `mfaKeyReadiness` (an environment-
     *                                variable readiness report by design).
     * Anything else is a second key source and a finding.
     */
    const direct = serverSources().filter(p => /\benvironmentSecretKeys\(/.test(code(p)));
    expect(direct.sort()).toEqual(["server/_core/secretKeys.ts"]);

    for (const file of ["server/portalRouter.ts", "server/_core/trpc.ts", "server/webhookDispatchService.ts"]) {
      expect(code(file), `${file} uses the accessor`).toMatch(/secretKeyProvider\(\)/);
    }
    // The preflight resolves from configuration through the same resolver the bootstrap uses.
    expect(code("server/webhookCutoverPreflight.ts")).toMatch(/resolveSecretKeyProvider\(env, backends\)/);
  });
});

describe("no environment fallback after a managed-provider failure", () => {
  it("the resolver has no catch that could substitute environment keys, and the accessor throws when managed is not bootstrapped", () => {
    const keys = code("server/_core/secretKeys.ts");
    const resolver = keys.match(/export async function resolveSecretKeyProvider[\s\S]*?\n\}/)![0];
    expect(resolver).not.toMatch(/catch/);
    const bootstrap = keys.match(/export async function bootstrapSecretKeys[\s\S]*?\n\}/)![0];
    expect(bootstrap).not.toMatch(/catch/);
    const accessor = keys.match(/export function secretKeyProvider[\s\S]*?\n\}/)![0];
    expect(accessor).toMatch(/=== "managed"\)\s*\{\s*throw/);
    // The environment branch is reachable only when the source is not managed.
    expect(accessor.indexOf("throw")).toBeLessThan(accessor.indexOf("return environmentSecretKeys"));
  });

  it("the production backend registry is empty and the test backend is unknown to production sources", () => {
    const keys = code("server/_core/secretKeys.ts");
    expect(keys).toMatch(/export function productionManagedKeyBackends\(\): Record<string, ManagedKeyBackend> \{\s*return \{\};\s*\}/);
    const importers = serverSources().filter(p => /managedKeyBackend\.fake/.test(code(p)));
    expect(importers, "the fake backend is imported by tests only").toEqual([]);
    const claimants = serverSources().filter(p => p !== "server/_core/managedSecretKeys.ts" && /kind:\s*["']managed["']/.test(code(p)));
    expect(claimants, "only the bootstrap constructs a managed provider").toEqual([]);
  });
});

describe("configuration and leakage", () => {
  it("the managed variables are inventoried by name, read only by the key module, and never hold material", () => {
    const env = code("server/_core/env.ts");
    expect(env).toMatch(/managedSource: "LEASEOS_SECRET_KEYS_SOURCE"/);
    expect(env).toMatch(/managedKeys: "LEASEOS_MANAGED_KEYS"/);
    const readers = serverSources().filter(p => /env\.LEASEOS_(?:SECRET_KEYS_SOURCE|MANAGED_KEYS)\b/.test(code(p)));
    expect(readers).toEqual(["server/_core/secretKeys.ts"]);
    const keys = code("server/_core/secretKeys.ts");
    expect(keys, "managed configuration is passed through the raw-material guard").toMatch(/assertNoRawKeyMaterial\(parsed, "LEASEOS_MANAGED_KEYS"\)/);
  });

  it("the bootstrap module logs nothing and exposes no key bytes through its public surface", () => {
    const managed = code("server/_core/managedSecretKeys.ts");
    expect(managed).not.toMatch(/console\./);
    expect(managed).not.toMatch(/JSON\.stringify\(\s*(?:bytes|dek|key|material)/);
    // `${bytes.length}` is the one permitted reference: the length, never the bytes.
    expect(managed, "errors never interpolate unwrapped bytes").not.toMatch(/\$\{bytes(?!\.length)|\$\{dek|toString\("hex"\)|toString\("base64/);
    expect(managed, "serialization answers with the description only").toMatch(/toJSON: describe/);
    expect(managed).toMatch(/\[inspect\.custom\]: describe/);
    // Startup logs the source and backend name; never a key id list from the provider, never material.
    for (const file of ["server/_core/startup.ts", "server/_core/worker.ts"]) {
      const body = code(file);
      const line = body.match(/console\.log\(`\[secrets\].*\);/)?.[0] ?? "";
      expect(line).toMatch(/keys\.source/);
      // Everything interpolated is the source or the backend name — never the provider object
      // (whose inspection is metadata anyway) and never a key descriptor.
      const interpolations = [...line.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]!.trim());
      expect(interpolations.length).toBeGreaterThan(0);
      for (const expr of interpolations) expect(expr).toMatch(/^keys\.(?:source|backend)\b/);
    }
  });

  it("the existing environment variables remain, for development and test compatibility", () => {
    const keys = code("server/_core/secretKeys.ts");
    for (const name of ["LEASEOS_KEY_MFA_V1", "LEASEOS_KEY_WEBHOOK_V1", "LEASEOS_KEY_PROVIDER_V1", "LEASEOS_KEY_INTEGRATION_V1", "LEASEOS_PORTAL_MFA_KEY"]) {
      expect(keys).toContain(name);
    }
  });
});
