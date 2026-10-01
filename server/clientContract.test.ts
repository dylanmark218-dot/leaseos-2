/**
 * HS5 — the shared client contract and the gate that enforces it.
 *
 * The contract is what lets the website, a new Windows build and an Android
 * install from last quarter use one API safely. These tests pin each rule the
 * contract states, and read the router so a drain-only procedure that is
 * renamed fails here rather than silently locking old installs out.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_CONTRACT_VERSION,
  CLIENT_HEADER,
  CLIENT_PLATFORMS,
  CONTRACT_HEADER,
  DRAIN_PROCEDURES,
  ENROLMENT_PLATFORMS,
  RETRY_MAX_MS,
  SERVER_SUPPORTED_CONTRACTS,
  SHELL_FOR_PLATFORM,
  checkUploadReceipt,
  classifyVersionedWrite,
  clientCaptureRef,
  clientContractHeaders,
  enrolmentPlatform,
  formatSupportedContracts,
  localNamespace,
  negotiateContract,
  parseClientIdentity,
  parseContractVersion,
  procedureAllowed,
  queueDisposition,
  retryDelayMs,
  scopeTransition,
  type SendFailure,
  type SupportedContracts,
} from "@shared/clientContract";
import { contractGateDecision, trpcPathsFromUrlPath } from "./_core/clientContractGate";
import { appRouter } from "./routers";
import { readFileSync } from "node:fs";

const withDrain: SupportedContracts = { minMajor: 3, maxMajor: 3, maxMinorOfMaxMajor: 2, drainOnlyMajors: [2] };

describe("contract version negotiation", () => {
  it("the server built from this tree accepts the client built from this tree", () => {
    const n = negotiateContract(`${CLIENT_CONTRACT_VERSION.major}.${CLIENT_CONTRACT_VERSION.minor}`);
    expect(n).toMatchObject({ outcome: "compatible", access: "full" });
  });
  it("parses only <major>.<minor>", () => {
    expect(parseContractVersion("1.0")).toEqual({ major: 1, minor: 0 });
    for (const bad of ["1", "1.0.0", "v1.0", "-1.0", "1.x", "", " "]) expect(parseContractVersion(bad), bad).toBeNull();
  });
  it("a garbled header is refused, never read as current", () => {
    expect(negotiateContract("banana")).toMatchObject({ outcome: "malformed", access: "none" });
  });
  it("an absent header is the website's, and passes only where allowed", () => {
    expect(negotiateContract(undefined)).toEqual({ outcome: "unversioned", access: "full" });
    expect(negotiateContract(undefined, SERVER_SUPPORTED_CONTRACTS, { unversionedAllowed: false })).toEqual({ outcome: "unversioned", access: "none" });
  });
  it("a retired major must upgrade; a drain major may first hand over its queue", () => {
    expect(negotiateContract("1.9", withDrain)).toMatchObject({ outcome: "client_upgrade_required", access: "none" });
    expect(negotiateContract("2.4", withDrain)).toMatchObject({ outcome: "drain_then_upgrade", access: "drain_only" });
  });
  it("a future major is the server's problem, not the client's", () => {
    expect(negotiateContract("4.0", withDrain)).toMatchObject({ outcome: "server_upgrade_required", access: "none" });
  });
  it("a newer minor runs, and is told the server's minor", () => {
    expect(negotiateContract("3.5", withDrain)).toEqual({ outcome: "compatible_older_server", access: "full", client: { major: 3, minor: 5 }, serverMinor: 2 });
    expect(negotiateContract("3.0", withDrain)).toMatchObject({ outcome: "compatible" });
  });
  it("advertises what it supports in one parseable string", () => {
    expect(formatSupportedContracts(withDrain)).toBe("3-3.2;drain=2");
    expect(formatSupportedContracts(SERVER_SUPPORTED_CONTRACTS)).toBe(`1-1.${CLIENT_CONTRACT_VERSION.minor}`);
  });
});

describe("drain-only access", () => {
  const serverPaths = new Set(Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures));
  it("every drain procedure exists in the router", () => {
    for (const p of DRAIN_PROCEDURES) expect(serverPaths.has(p), p).toBe(true);
  });
  it("covers the three calls SyncEngine makes to hand over a capture", () => {
    expect(DRAIN_PROCEDURES).toEqual(expect.arrayContaining(["fieldRoute.evidence.upload", "records.evidence.seal", "sync.receivePackage"]));
  });
  it("allows nothing that reads or starts new work", () => {
    expect(procedureAllowed("drain_only", "fieldRoute.jobs.list")).toBe(false);
    expect(procedureAllowed("drain_only", "sync.receivePackage")).toBe(true);
    expect(procedureAllowed("none", "auth.me")).toBe(false);
    expect(procedureAllowed("full", "fieldRoute.jobs.list")).toBe(true);
  });
});

describe("client identity", () => {
  it("every platform ships in exactly one shell", () => {
    expect(Object.keys(SHELL_FOR_PLATFORM).sort()).toEqual([...CLIENT_PLATFORMS].sort());
    expect(SHELL_FOR_PLATFORM).toMatchObject({ web: "browser", windows: "tauri", macos: "tauri", linux: "tauri", android: "capacitor", ios: "capacitor" });
  });
  it("round-trips through the header and refuses a pairing no build ships", () => {
    const h = clientContractHeaders({ platform: "android", shell: "capacitor", appVersion: "1.4.2" });
    expect(h[CONTRACT_HEADER]).toBe(`${CLIENT_CONTRACT_VERSION.major}.${CLIENT_CONTRACT_VERSION.minor}`);
    expect(parseClientIdentity(h[CLIENT_HEADER])).toEqual({ platform: "android", shell: "capacitor", appVersion: "1.4.2" });
    expect(parseClientIdentity("android/tauri/1.0")).toBeNull();
    expect(parseClientIdentity("beos/browser/1.0")).toBeNull();
    expect(parseClientIdentity("ios/capacitor/")).toBeNull();
  });
  it("enrolment says out loud that a Mac is stored as `other`, and nothing else is", () => {
    expect(enrolmentPlatform("macos")).toEqual({ platform: "other", exact: false });
    for (const p of CLIENT_PLATFORMS.filter(p => p !== "macos")) expect(enrolmentPlatform(p)).toEqual({ platform: p, exact: true });
  });
  it("the enrolment list is the one the device router and schema accept", () => {
    const quoted = `[${ENROLMENT_PLATFORMS.map(p => `"${p}"`).join(", ")}]`;
    expect(readFileSync("server/deviceRouter.ts", "utf8")).toContain(`z.enum(${quoted})`);
    expect(readFileSync("drizzle/schema.ts", "utf8")).toContain(`mysqlEnum("platform", ${quoted})`);
  });
});

describe("company scope", () => {
  const a = { userRef: "u1", tenantId: "acme" };
  it("namespaces by company and user, and escapes the separator", () => {
    expect(localNamespace(a)).toBe("leaseos:acme:u1");
    expect(localNamespace({ userRef: "b:c", tenantId: "a" })).not.toBe(localNamespace({ userRef: "c", tenantId: "a:b" }));
  });
  it("keeps, switches, holds or revokes — never merges", () => {
    expect(scopeTransition(a, { state: "confirmed", scope: a })).toBe("keep");
    expect(scopeTransition(a, { state: "confirmed", scope: { ...a, tenantId: "other" } })).toBe("switch");
    expect(scopeTransition(a, { state: "confirmed", scope: { ...a, userRef: "u2" } })).toBe("switch");
    expect(scopeTransition(null, { state: "confirmed", scope: a })).toBe("switch");
    expect(scopeTransition(a, { state: "unreachable" })).toBe("hold");
    expect(scopeTransition(a, { state: "revoked" })).toBe("revoked");
  });
});

describe("record versions", () => {
  it("applies on the current version and bumps it", () => {
    expect(classifyVersionedWrite(4, 4)).toEqual({ verdict: "apply", nextVersion: 5 });
  });
  it("a stale base is a conflict, not an overwrite", () => {
    expect(classifyVersionedWrite(3, 5)).toEqual({ verdict: "conflict", serverVersion: 5, baseVersion: 3 });
  });
  it("a missing record, a future version and a nonsense version are each named", () => {
    expect(classifyVersionedWrite(1, null)).toEqual({ verdict: "missing" });
    expect(classifyVersionedWrite(6, 5).verdict).toBe("invalid");
    expect(classifyVersionedWrite(-1, 5).verdict).toBe("invalid");
    expect(classifyVersionedWrite(1.5, 5).verdict).toBe("invalid");
  });
});

describe("upload receipts", () => {
  const ref = clientCaptureRef("DEV-1", "abc");
  it("uses the reference SyncEngine already sends", () => {
    expect(ref).toBe("DEV-1:abc");
    expect(readFileSync("client/src/runtime/syncEngine.ts", "utf8")).toContain("clientCaptureRef: `${deviceRef}:${c.localId}`");
    expect(() => clientCaptureRef("a:b", "c")).toThrow();
    expect(() => clientCaptureRef("a", "")).toThrow();
  });
  it("counts a receipt only when reference and hash both match", () => {
    const expected = { clientCaptureRef: ref, contentHash: "ABCDEF" };
    expect(checkUploadReceipt(expected, { clientCaptureRef: ref, serverId: 9, alreadyUploaded: true, contentHash: "abcdef" })).toEqual({ ok: true, duplicate: true });
    expect(checkUploadReceipt(expected, { clientCaptureRef: ref, serverId: 9, alreadyUploaded: false, contentHash: "000000" })).toEqual({ ok: false, reason: "hash_mismatch" });
    expect(checkUploadReceipt(expected, { clientCaptureRef: "DEV-1:other", serverId: 9, alreadyUploaded: false, contentHash: "abcdef" })).toEqual({ ok: false, reason: "wrong_reference" });
  });
});

describe("offline queue behaviour", () => {
  it("every failure has a disposition, and none of them deletes work", () => {
    const all: SendFailure[] = ["network", "server_unavailable", "rate_limited", "unauthenticated", "forbidden", "contract_refused", "conflict", "rejected", "not_found", "local"];
    const got = Object.fromEntries(all.map(f => [f, queueDisposition(f)]));
    expect(got).toEqual({
      network: "retry", server_unavailable: "retry", rate_limited: "retry",
      unauthenticated: "reauth", contract_refused: "upgrade", conflict: "needs_person",
      forbidden: "failed", rejected: "failed", not_found: "failed", local: "failed",
    });
  });
  it("backs off exponentially within the upper half of each step, and caps", () => {
    expect(retryDelayMs(0, 0)).toBe(1_000);
    expect(retryDelayMs(0, 0.999999)).toBe(2_000);
    expect(retryDelayMs(3, 0)).toBe(8_000);
    expect(retryDelayMs(40, 0.5)).toBeLessThanOrEqual(RETRY_MAX_MS);
    expect(retryDelayMs(40, 0)).toBe(RETRY_MAX_MS / 2);
    expect(retryDelayMs(-5, 0)).toBe(1_000);
  });
});

describe("the gate in front of /api/trpc", () => {
  const current = `${CLIENT_CONTRACT_VERSION.major}.${CLIENT_CONTRACT_VERSION.minor}`;
  it("reads procedure paths from single and batched URLs", () => {
    expect(trpcPathsFromUrlPath("/auth.me")).toEqual(["auth.me"]);
    expect(trpcPathsFromUrlPath("/auth.me,fieldRoute.jobs.list")).toEqual(["auth.me", "fieldRoute.jobs.list"]);
    expect(trpcPathsFromUrlPath("/")).toEqual([]);
  });
  it("lets the website through without a header", () => {
    expect(contractGateDecision({ contract: undefined, client: undefined }, ["fieldRoute.jobs.list"]).allow).toBe(true);
  });
  it("lets a current installed client through", () => {
    expect(contractGateDecision({ contract: current, client: "windows/tauri/1.0.0" }, ["fieldRoute.jobs.list"]).allow).toBe(true);
  });
  it("refuses an installed client that declares a contract but not who it is", () => {
    expect(contractGateDecision({ contract: current, client: undefined }, ["auth.me"])).toMatchObject({ allow: false, status: 426, outcome: "malformed_client" });
    expect(contractGateDecision({ contract: current, client: "ios/tauri/1.0" }, ["auth.me"])).toMatchObject({ allow: false, outcome: "malformed_client" });
  });
  it("refuses retired, future and garbled contracts with 426", () => {
    expect(contractGateDecision({ contract: "0.9", client: "android/capacitor/0.9" }, ["auth.me"])).toMatchObject({ allow: false, status: 426, outcome: "client_upgrade_required" });
    expect(contractGateDecision({ contract: "99.0", client: "android/capacitor/9" }, ["auth.me"])).toMatchObject({ allow: false, outcome: "server_upgrade_required" });
    expect(contractGateDecision({ contract: "x", client: "android/capacitor/9" }, ["auth.me"])).toMatchObject({ allow: false, outcome: "malformed" });
  });
  it("lets a drain-only install hand over its queue, and nothing else — even inside a batch", () => {
    const old = { contract: "2.1", client: "android/capacitor/0.8.0" };
    expect(contractGateDecision(old, ["fieldRoute.evidence.upload", "sync.receivePackage"], withDrain).allow).toBe(true);
    expect(contractGateDecision(old, ["sync.receivePackage", "fieldRoute.jobs.list"], withDrain)).toMatchObject({ allow: false, outcome: "drain_only" });
    expect(contractGateDecision(old, [], withDrain)).toMatchObject({ allow: false, outcome: "drain_only" });
  });
  it("is mounted in front of the tRPC handler", () => {
    // Registered in the one place the API is mounted, on the same path constant, ahead of the
    // organization selector and the tRPC handler.
    const src = readFileSync("server/_core/api.ts", "utf8");
    const gate = src.indexOf("app.use(TRPC_MOUNT_PATH, clientContractGate())");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("app.use(TRPC_MOUNT_PATH, organizationSelectionMiddleware)"));
    expect(gate).toBeLessThan(src.indexOf("app.use(TRPC_MOUNT_PATH, createExpressMiddleware("));
  });
});
