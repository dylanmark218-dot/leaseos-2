/**
 * S2-FLEET-A — the structural facts that keep the fleet mechanism honest. Permanent.
 *
 * Each block pins one thing a future change could quietly undo: the entrypoints registering (both
 * of them, in the right place), the registry never rewriting an identity, no request path reaching
 * a write, the `converged` state having exactly one source, and Gate 7a continuing to demand an
 * embedded identity from both artifacts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runtimeInstances } from "../drizzle/schema";
import { RUNTIME_CAPABILITIES, RUNTIME_CAPABILITY, WEBHOOK_CUTOVER_REQUIRED_CAPABILITIES, isRuntimeCapability, parseCapabilities } from "./_core/runtimeCapabilities";

const strip = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (p: string) => strip(readFileSync(p, "utf8"));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.fake\.ts$/.test(p) ? [p] : [];
  });
const productionFiles = () => [...walk("server"), ...walk("scripts")];
const indexOf = (body: string, needle: string) => {
  const i = body.indexOf(needle);
  expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return i;
};

describe("FLEET-M2. both entrypoints register, through one module, in the documented order", () => {
  it("the server: production checks → key bootstrap → registration → worker → API → frontend → ready; stopped last on shutdown", () => {
    const s = code("server/_core/startup.ts");
    expect(s).toMatch(/^import \{ registerThisRuntime \} from "\.\/runtimeRegistry";/m);
    const secrets = indexOf(s, "assertProductionSecrets(ENV, !isDevelopment)");
    const keys = indexOf(s, "await bootstrapSecretKeys()");
    const register = indexOf(s, 'await registerThisRuntime("server", { production: !isDevelopment })');
    const worker = indexOf(s, "await startProductionWorker()");
    const api = indexOf(s, "registerApi(app)");
    const frontend = indexOf(s, "await frontend(app, server)");
    const ready = indexOf(s, "readiness.markReady()");
    expect([secrets, keys, register, worker, api, frontend, ready]).toEqual([secrets, keys, register, worker, api, frontend, ready].slice().sort((a, b) => a - b));

    const shutdown = s.slice(indexOf(s, "const shutdown = async () =>"));
    const notReady = indexOf(shutdown, "readiness.markNotReady()");
    const serverClose = indexOf(shutdown, "server.close(");
    const runtimeClose = indexOf(shutdown, "if (runtime) await runtime.close()");
    expect(notReady).toBeLessThan(serverClose);
    expect(serverClose).toBeLessThan(runtimeClose);
  });

  it("the worker: key bootstrap → registration → work; stopped on close", () => {
    const w = code("server/_core/worker.ts");
    expect(w).toMatch(/^import \{ registerThisRuntime \} from "\.\/runtimeRegistry";/m);
    const keys = indexOf(w, "await bootstrapSecretKeys()");
    const register = indexOf(w, 'await registerThisRuntime("worker", { production: process.env.NODE_ENV !== "development" })');
    const work = indexOf(w, "await startProductionWorker()");
    expect(keys).toBeLessThan(register);
    expect(register).toBeLessThan(work);
    expect(w).toMatch(/await worker\.close\(\);\s*await runtime\?\.close\(\);/);
  });

  it("FLEET-M3. in production a registration failure is thrown, never swallowed, so readiness is never reached", () => {
    const r = code("server/_core/runtimeRegistry.ts");
    expect(r).toMatch(/if \(options\.production\) throw new RuntimeRegistrationError\(`runtime registration failed/);
    expect(r).toMatch(/if \(options\.production\) \{\s*throw new RuntimeRegistrationError\(\s*"runtime registration requires a database in production/);
    expect(r).toMatch(/requireBuildIdentity\(runtimeBuild\(\), options\.production\)/);
    // The server does not catch around the call: a throw propagates to startServer().catch.
    const s = code("server/_core/startup.ts");
    expect(s).not.toMatch(/try\s*\{[^}]*registerThisRuntime/);
  });
});

describe("FLEET-M4/M16. the registry writes identity once and never rewrites it", () => {
  const r = code("server/_core/runtimeRegistry.ts");

  it("one insert, no upsert, no delete", () => {
    expect(r.match(/\.insert\(runtimeInstances\)/g)).toHaveLength(1);
    expect(r).not.toMatch(/onDuplicateKeyUpdate|onConflict|INSERT IGNORE|REPLACE INTO/i);
    expect(r).not.toMatch(/\.delete\(/);
  });

  it("the heartbeat sets lastHeartbeatAt alone; the stop sets stoppedAt alone; both only while not stopped", () => {
    const sets = [...r.matchAll(/\.set\(\{([^}]*)\}\)/g)].map(m => m[1]!.trim());
    expect(sets).toEqual(["lastHeartbeatAt: sql`CURRENT_TIMESTAMP`", "stoppedAt: sql`CURRENT_TIMESTAMP`"]);
    expect(r.match(/isNull\(runtimeInstances\.stoppedAt\)/g)).toHaveLength(2);
    for (const col of ["buildSha", "buildRelease", "buildSource", "capabilitiesJson", "runtimeKind", "instanceRef"]) {
      expect(sets.join("\n"), `${col} is never updated`).not.toContain(col);
    }
  });

  it("the instance reference is random, not the pid or the hostname", () => {
    expect(r).toMatch(/instanceRef: `rt_\$\{randomUUID\(\)\}`/);
    expect(r).not.toMatch(/hostname|process\.pid/);
  });
});

describe("FLEET-M10. authority: no request path can register, heartbeat, stop, set a build or assert convergence", () => {
  const writers = /registerRuntimeInstance|heartbeatRuntimeInstance|stopRuntimeInstance|startRuntimeRegistration|registerThisRuntime/;
  const WRITER_FILES = new Set(["server/_core/runtimeRegistry.ts", "server/_core/startup.ts", "server/_core/worker.ts"]);

  it("the registry's writers are the two entrypoints and nothing else", () => {
    const offenders = productionFiles().filter(p => !WRITER_FILES.has(p) && writers.test(code(p)));
    expect(offenders).toEqual([]);
  });

  it("no router, procedure builder or script imports the registry or the observation service", () => {
    const routers = productionFiles().filter(p => /Router\.ts$|routers\.ts$|_core\/trpc\.ts$|portalComposition\.ts$|scripts\//.test(p));
    expect(routers.length).toBeGreaterThan(20);
    const offenders = routers.filter(p => /runtimeRegistry|fleetObservationService/.test(code(p)) && p !== "scripts/webhook-cutover-preflight.ts");
    expect(offenders).toEqual([]);
    // The preflight script reads the preflight, which reads the observation. It never writes.
    expect(code("scripts/webhook-cutover-preflight.ts")).not.toMatch(/runtimeRegistry|runtimeInstances|fleetObservationService/);
  });

  it("the registry table carries no tenant and no secret", () => {
    const columns = Object.keys(getTableColumns(runtimeInstances)).sort();
    expect(columns).toEqual(["buildRelease", "buildSha", "buildSource", "capabilitiesJson", "id", "instanceRef", "lastHeartbeatAt", "runtimeKind", "startedAt", "stoppedAt"]);
    expect(columns).not.toContain("orgRef");
    expect(columns.join(",")).not.toMatch(/host|secret|token|address/i);
  });
});

describe("FLEET-M7/M8. converged has exactly one source, and it is not a caller", () => {
  const f = code("server/fleetObservationService.ts");

  it("deploymentEvidence takes no parameters and today returns none", () => {
    expect(f).toMatch(/^function deploymentEvidence\(\): DeploymentEvidence \{\s*return \{\s*kind: "none",/m);
    expect(f.match(/deploymentEvidence\(/g)).toHaveLength(2); // the definition, and the one call inside summarizeFleet
  });

  it("no production source constructs confirmed evidence or the converged state outside that branch", () => {
    for (const p of productionFiles()) {
      const body = code(p);
      expect(body, p).not.toMatch(/kind:\s*"confirmed"\s*[,}]/);
      // Comparing against the state (`!== "converged"`) is reading it; constructing or assigning it is not allowed.
      if (p !== "server/fleetObservationService.ts") expect(body, p).not.toMatch(/state\s*[:=]\s*"converged"/);
    }
    const branch = f.indexOf('externalConfirmation.kind === "confirmed"');
    const assignment = f.indexOf('state = "converged"');
    expect(branch).toBeGreaterThan(-1);
    expect(assignment).toBeGreaterThan(branch);
    expect(f.match(/state = "converged"/g)).toHaveLength(1);
    expect(f.slice(branch, assignment)).toMatch(/\{\s*$/m);
  });

  it("the reducer and the reader take no evidence and no required-capability override", () => {
    expect(f).toMatch(/^export function summarizeFleet\(rows: readonly RuntimeInstanceRecord\[\], liveTtlSeconds = RUNTIME_LIVE_TTL_SECONDS\): FleetObservation \{/m);
    expect(f).toMatch(/^export async function observeFleet\(db\?: DbOrTx \| null\): Promise<FleetObservation> \{/m);
    expect(f).toMatch(/const required = WEBHOOK_CUTOVER_REQUIRED_CAPABILITIES;/);
    expect(f).toMatch(/\.where\(isNull\(runtimeInstances\.stoppedAt\)\)/);
    expect(f).not.toMatch(/process\.env/);
  });

  it("compatibility is judged on capabilities and a known build, never on a particular sha", () => {
    expect(f).not.toMatch(/buildSha\s*===\s*"|buildSha\s*!==\s*"|EXPECTED_SHA|expectedSha/);
    expect(f).toMatch(/BUILD_SHA_PATTERN\.test\(row\.buildSha\)/);
    expect(f).toMatch(/missing required capability \$\{cap\}/);
  });
});

describe("the capability vocabulary is small, closed and central", () => {
  it("names exactly the capabilities this build implements, and the cutover requires a subset", () => {
    expect(RUNTIME_CAPABILITY).toEqual({ webhookSecretRefRead: "webhook-secret-ref-read" });
    expect(RUNTIME_CAPABILITIES).toEqual(["webhook-secret-ref-read"]);
    expect(WEBHOOK_CUTOVER_REQUIRED_CAPABILITIES.every(c => RUNTIME_CAPABILITIES.includes(c))).toBe(true);
    expect(isRuntimeCapability("webhook-secret-ref-read")).toBe(true);
    expect(isRuntimeCapability("webhook.secretRef")).toBe(false);
    expect(parseCapabilities('["webhook-secret-ref-read","x"]')).toEqual({ capabilities: ["webhook-secret-ref-read"], unknown: ["x"] });
    expect(parseCapabilities("{}")).toBeNull();
    expect(parseCapabilities("[1]")).toBeNull();
  });

  it("is not a feature-flag system: no environment read, no toggle, no free text", () => {
    const c = code("server/_core/runtimeCapabilities.ts");
    expect(c).not.toMatch(/process\.env|flag|toggle|enabled/i);
    expect(c).toMatch(/as const;/);
  });

  it("the declared capability is the behaviour webhookSecretService already enforces", () => {
    // The capability names Phase 1's rule: a present reference wins and a broken one fails closed.
    const svc = code("server/webhookSecretService.ts");
    expect(svc).toMatch(/if \(row\.secretRef\)/);
    expect(svc).not.toMatch(/catch[\s\S]{0,120}legacyDecrypt/);
    const grep = readFileSync("server/_core/runtimeCapabilities.ts", "utf8");
    expect(grep).toMatch(/resolveWebhookSigningSecret/);
  });
});

describe("FLEET-M11/M12. Gate 7a demands one embedded identity from both artifacts, without git", () => {
  const smoke = readFileSync("scripts/prod-runtime-smoke.sh", "utf8");

  it("boots both bundles on a node-only PATH, in a directory without .git, with a decoy LEASEOS_BUILD_SHA", () => {
    expect(smoke).toMatch(/NODE_ONLY_PATH="\$RT\/bin"/);
    expect(smoke).toMatch(/command -v git >\/dev\/null 2>&1 \) && fail/);
    expect(smoke).toMatch(/for f in vite\.config\.ts tsconfig\.json client server shared drizzle \.git; do/);
    expect(smoke.match(/env -i PATH="\$NODE_ONLY_PATH" HOME="\$RT" NODE_ENV=production/g)).toHaveLength(2);
    expect(smoke.match(/LEASEOS_BUILD_SHA="\$FAKE_SHA"/g)).toHaveLength(2);
    expect(smoke).toMatch(/\[ "\$SERVER_SHA" != "\$FAKE_SHA" \] \|\| fail/);
  });

  it("requires the identity in both bundles, reported by both processes, equal, and registered rows marked stopped after SIGTERM", () => {
    expect(smoke).toMatch(/carries no embedded build identity/);
    expect(smoke).toMatch(/\[ -n "\$SERVER_SHA" \] \|\| \{/);
    expect(smoke).toMatch(/\[ -n "\$WORKER_SHA" \] \|\| \{/);
    expect(smoke).toMatch(/\[ "\$WORKER_SHA" = "\$SERVER_SHA" \] \|\| fail/);
    expect(smoke).toMatch(/\[ "\$SERVER_SHA" = "\$EXPECTED_SHA" \] \|\| fail/);
    expect(smoke).toMatch(/expected 'server \$SERVER_SHA 1'/);
    expect(smoke).toMatch(/expected 'worker \$WORKER_SHA 1'/);
    expect(smoke).toMatch(/"server \$SERVER_SHA 0" \] \|\| fail/);
    expect(smoke).toMatch(/"worker \$WORKER_SHA 0" \] \|\| fail/);
    expect(smoke).toMatch(/grep -q 'rev-parse' "\$f" && fail/);
    expect(smoke).toMatch(/grep -q 'LEASEOS_BUILD_SHA' "\$f" && fail/);
  });

  it("the build identity is a build-time input: only the build script reads LEASEOS_BUILD_SHA or calls git", () => {
    const readers = productionFiles().filter(p => /LEASEOS_BUILD_SHA|rev-parse/.test(code(p)));
    expect(readers).toEqual([]);
    const mjs = readFileSync("scripts/build-identity.mjs", "utf8");
    expect(mjs).toMatch(/env\.LEASEOS_BUILD_SHA/);
    expect(mjs).toMatch(/\["rev-parse", "HEAD"\]/);
    expect(readFileSync("scripts/build-server.mjs", "utf8")).not.toMatch(/process\.env|rev-parse/);
  });
});
