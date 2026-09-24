/**
 * HS5 — the shared client contract.
 *
 * One backend, six clients: the website, the Tauri desktop shell on Windows,
 * macOS and Linux, and the Capacitor shell on Android and iOS. They do not
 * ship together. An Android install from three months ago, this week's Windows
 * build and the website served by the current server all talk to the same API,
 * and this file is what lets the server tell them apart and treat each safely.
 *
 * It fixes five things and deliberately nothing else:
 *
 *   1. which contract a client speaks, and what the server does about it
 *      (`negotiateContract`) — including letting an outdated install finish
 *      uploading work it captured offline before it is made to upgrade;
 *   2. which company a client is acting for — always the server's answer,
 *      never the client's, and what a device does with cached and queued work
 *      when that answer changes (`scopeTransition`);
 *   3. record versions — a write carries the version it was based on, and a
 *      stale one is a conflict, never a silent overwrite (`classifyVersionedWrite`);
 *   4. upload receipts — the server acknowledges a capture by its device
 *      reference, and a receipt only counts when its hash matches (`checkUploadReceipt`);
 *   5. offline queue behaviour — which failures are retried, which stop, and
 *      which need a person (`queueDisposition`, `retryDelayMs`).
 *
 * What already exists and is NOT restated here (see docs/hybrid-seam/HS_CONTRACTS.md):
 *   - the sync-state vocabulary `SyncState` and the capture envelope
 *     `LocalCapture` — `client/src/runtime/contracts.ts`. "Saved on this
 *     device" (`saved_locally`/`queued`) and "synced to the office"
 *     (`synchronized`) stay separate states there;
 *   - the package, seal and receipt protocol — `Transport` in the same file;
 *   - how the server decides the organization — `server/_core/actingScope.ts`.
 *
 * Everything here is pure: no I/O, no clock, no imports. Both the server and
 * every client shell import it, so the two sides cannot drift.
 */

// ---------------------------------------------------------------------------
// 1. Contract version
// ---------------------------------------------------------------------------

/**
 * `major` changes when an older client would misread a response or send a
 * request the server can no longer apply. `minor` changes for additions only:
 * new optional fields, new procedures. A client ignores fields it does not
 * know; the server never requires a field a same-major client may not send.
 */
export type ContractVersion = { major: number; minor: number };

/** The contract this source tree speaks — the server and the clients built from it. */
export const CLIENT_CONTRACT_VERSION: ContractVersion = { major: 1, minor: 0 };

/**
 * What the server accepts.
 *
 * `drainOnlyMajors` are retired majors whose installs may still push queued
 * work (evidence uploads, seals, packages) but may not read or start anything
 * new. That is how an old install upgrades without losing what it captured
 * offline: it drains, then it is told to update.
 */
export type SupportedContracts = {
  minMajor: number;
  maxMajor: number;
  /** The highest minor the server implements within `maxMajor`. */
  maxMinorOfMaxMajor: number;
  drainOnlyMajors: readonly number[];
};

export const SERVER_SUPPORTED_CONTRACTS: SupportedContracts = {
  minMajor: 1,
  maxMajor: 1,
  maxMinorOfMaxMajor: CLIENT_CONTRACT_VERSION.minor,
  drainOnlyMajors: [],
};

/** Request header: the contract the client speaks, `"<major>.<minor>"`. */
export const CONTRACT_HEADER = "x-leaseos-contract";
/** Request header: who the client is, `"<platform>/<shell>/<appVersion>"`. */
export const CLIENT_HEADER = "x-leaseos-client";
/** Response header: what the server accepts, so a refused client can say why. */
export const SUPPORTED_CONTRACT_HEADER = "x-leaseos-contract-supported";

export function formatContractVersion(v: ContractVersion): string {
  return `${v.major}.${v.minor}`;
}

export function parseContractVersion(raw: string | null | undefined): ContractVersion | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,4})\.(\d{1,4})$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function formatSupportedContracts(s: SupportedContracts): string {
  const drain = s.drainOnlyMajors.length ? `;drain=${s.drainOnlyMajors.join(",")}` : "";
  return `${s.minMajor}-${s.maxMajor}.${s.maxMinorOfMaxMajor}${drain}`;
}

/**
 * What a request may do under the negotiated contract.
 *
 *   full           any procedure the caller's permissions allow
 *   drain_only     only the queue-drain procedures (`DRAIN_PROCEDURES`)
 *   none           nothing — the client must update (or the server must)
 */
export type ContractAccess = "full" | "drain_only" | "none";

export type ContractNegotiation =
  | { outcome: "compatible"; access: "full"; client: ContractVersion }
  /** The client is newer within the same major than this server. It may run, and must not rely on anything above the server's minor. */
  | { outcome: "compatible_older_server"; access: "full"; client: ContractVersion; serverMinor: number }
  | { outcome: "drain_then_upgrade"; access: "drain_only"; client: ContractVersion }
  | { outcome: "client_upgrade_required"; access: "none"; client: ContractVersion }
  | { outcome: "server_upgrade_required"; access: "none"; client: ContractVersion }
  /** No header. Only the website bundle — served by this same server — may omit it. */
  | { outcome: "unversioned"; access: "full" | "none" }
  | { outcome: "malformed"; access: "none"; raw: string };

/**
 * Decides what the server does with a client's declared contract.
 *
 * `unversionedAllowed` is true for the same-origin website: it cannot be out
 * of date with the server that served it. An installed shell always sends the
 * header, and a header that fails to parse is refused rather than treated as
 * absent — a garbled version must never read as "current".
 */
export function negotiateContract(
  raw: string | null | undefined,
  supported: SupportedContracts = SERVER_SUPPORTED_CONTRACTS,
  opts: { unversionedAllowed: boolean } = { unversionedAllowed: true },
): ContractNegotiation {
  if (raw == null || raw === "") return { outcome: "unversioned", access: opts.unversionedAllowed ? "full" : "none" };
  const client = parseContractVersion(raw);
  if (!client) return { outcome: "malformed", access: "none", raw: String(raw).slice(0, 32) };
  if (client.major > supported.maxMajor) return { outcome: "server_upgrade_required", access: "none", client };
  if (client.major < supported.minMajor) {
    return supported.drainOnlyMajors.includes(client.major)
      ? { outcome: "drain_then_upgrade", access: "drain_only", client }
      : { outcome: "client_upgrade_required", access: "none", client };
  }
  if (client.major === supported.maxMajor && client.minor > supported.maxMinorOfMaxMajor) {
    return { outcome: "compatible_older_server", access: "full", client, serverMinor: supported.maxMinorOfMaxMajor };
  }
  return { outcome: "compatible", access: "full", client };
}

/**
 * The procedures a drain-only client may still call: enough to hand over what
 * it holds, nothing that reads new work or starts any. Named by tRPC path.
 */
export const DRAIN_PROCEDURES: readonly string[] = [
  "fieldRoute.evidence.upload",
  "records.evidence.seal",
  "sync.receivePackage",
  "auth.me",
  "auth.logout",
];

/** Whether a tRPC path may run under the negotiated access. */
export function procedureAllowed(access: ContractAccess, procedurePath: string): boolean {
  if (access === "full") return true;
  if (access === "none") return false;
  return DRAIN_PROCEDURES.includes(procedurePath);
}

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

export const CLIENT_PLATFORMS = ["web", "windows", "macos", "linux", "android", "ios"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export const CLIENT_SHELLS = ["browser", "tauri", "capacitor"] as const;
export type ClientShell = (typeof CLIENT_SHELLS)[number];

/** The only shell each platform ships in. A mismatch in the header is refused, not guessed around. */
export const SHELL_FOR_PLATFORM: Record<ClientPlatform, ClientShell> = {
  web: "browser",
  windows: "tauri",
  macos: "tauri",
  linux: "tauri",
  android: "capacitor",
  ios: "capacitor",
};

export type ClientIdentity = { platform: ClientPlatform; shell: ClientShell; appVersion: string };

export function formatClientIdentity(c: ClientIdentity): string {
  return `${c.platform}/${c.shell}/${c.appVersion}`;
}

export function parseClientIdentity(raw: string | null | undefined): ClientIdentity | null {
  if (typeof raw !== "string") return null;
  const m = /^([a-z]+)\/([a-z]+)\/([0-9A-Za-z.+-]{1,40})$/.exec(raw.trim());
  if (!m) return null;
  const [, platform, shell, appVersion] = m;
  if (!(CLIENT_PLATFORMS as readonly string[]).includes(platform)) return null;
  if (SHELL_FOR_PLATFORM[platform as ClientPlatform] !== shell) return null;
  return { platform: platform as ClientPlatform, shell: shell as ClientShell, appVersion };
}

/** The headers every installed shell sends on every API request. The website sends none. */
export function clientContractHeaders(identity: ClientIdentity, version: ContractVersion = CLIENT_CONTRACT_VERSION): Record<string, string> {
  return { [CONTRACT_HEADER]: formatContractVersion(version), [CLIENT_HEADER]: formatClientIdentity(identity) };
}

/**
 * The platform value device enrolment stores today. The `fieldDevices.platform`
 * column (drizzle/schema.ts) predates the desktop plan and has no `macos`; until
 * a migration adds it, a Mac enrols as `other` and this function is the one
 * place that says so. It returns the gap rather than hiding it.
 */
export const ENROLMENT_PLATFORMS = ["android", "ios", "windows", "linux", "web", "other"] as const;
export type EnrolmentPlatform = (typeof ENROLMENT_PLATFORMS)[number];

export function enrolmentPlatform(p: ClientPlatform): { platform: EnrolmentPlatform; exact: boolean } {
  return (ENROLMENT_PLATFORMS as readonly string[]).includes(p)
    ? { platform: p as EnrolmentPlatform, exact: true }
    : { platform: "other", exact: false };
}

// ---------------------------------------------------------------------------
// 2. Company scope
// ---------------------------------------------------------------------------

/**
 * Who a session is and which company it acts for, as the SERVER resolved it
 * (`server/_core/actingScope.ts`). A client never sends a company; it receives
 * this and keys everything it stores by it.
 */
export type SessionScope = {
  userRef: string;
  tenantId: string;
  derivedFrom: "membership" | "single_tenant_fallback";
};

/**
 * The namespace a device stores cached records and queued work under. Two
 * users on one tablet, or one user in two companies, never share a namespace,
 * so nothing queued by one can be uploaded under the other.
 */
export function localNamespace(scope: Pick<SessionScope, "userRef" | "tenantId">): string {
  const safe = (s: string) => encodeURIComponent(s);
  return `leaseos:${safe(scope.tenantId)}:${safe(scope.userRef)}`;
}

/**
 * What a device does with its local data when the server's answer about the
 * session changes.
 *
 *   keep          same user, same company — carry on
 *   switch        a different user or company signed in — open a separate
 *                 namespace; the previous one's queue is held for its owner,
 *                 never uploaded under the new session
 *   hold          the server could not be reached to ask — keep capturing
 *                 locally, upload nothing until the session is confirmed
 *   revoked       access was withdrawn — stop uploading, stop showing cached
 *                 records, keep the unsent queue sealed for an administrator.
 *                 Offline availability is never permission.
 */
export type ScopeTransition = "keep" | "switch" | "hold" | "revoked";

export function scopeTransition(
  cached: Pick<SessionScope, "userRef" | "tenantId"> | null,
  current: { state: "confirmed"; scope: Pick<SessionScope, "userRef" | "tenantId"> } | { state: "unreachable" } | { state: "revoked" },
): ScopeTransition {
  if (current.state === "revoked") return "revoked";
  if (current.state === "unreachable") return "hold";
  if (!cached) return "switch";
  return localNamespace(cached) === localNamespace(current.scope) ? "keep" : "switch";
}

// ---------------------------------------------------------------------------
// 3. Record versions
// ---------------------------------------------------------------------------

/**
 * Every record a client can edit carries a server-assigned version that goes
 * up by one on each accepted write. A client write names the version it was
 * based on — the same `baseVersion` the package protocol already carries in
 * `recordUpdates`.
 */
export type RecordVersion = { recordType: string; recordRef: string; version: number };

export type VersionedWriteVerdict =
  | { verdict: "apply"; nextVersion: number }
  /** Someone else wrote first. Both sides are retained; a person decides. */
  | { verdict: "conflict"; serverVersion: number; baseVersion: number }
  /** The record is gone (deleted or never existed in this scope). */
  | { verdict: "missing" }
  /** A version from the future — the client is wrong, not the server. Refused. */
  | { verdict: "invalid"; reason: string };

export function classifyVersionedWrite(baseVersion: number, serverVersion: number | null): VersionedWriteVerdict {
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return { verdict: "invalid", reason: "baseVersion must be a non-negative integer" };
  if (serverVersion == null) return { verdict: "missing" };
  if (baseVersion > serverVersion) return { verdict: "invalid", reason: `baseVersion ${baseVersion} is ahead of the server's ${serverVersion}` };
  if (baseVersion < serverVersion) return { verdict: "conflict", serverVersion, baseVersion };
  return { verdict: "apply", nextVersion: serverVersion + 1 };
}

// ---------------------------------------------------------------------------
// 4. Upload receipts
// ---------------------------------------------------------------------------

/**
 * The reference the server keys an upload by, so a retry after a dropped
 * connection returns the same record instead of making a second one. Matches
 * what `SyncEngine` already sends as `clientCaptureRef`.
 */
export function clientCaptureRef(deviceRef: string, localId: string): string {
  if (!deviceRef || deviceRef.includes(":")) throw new Error("deviceRef must be non-empty and contain no ':'");
  if (!localId) throw new Error("localId must be non-empty");
  return `${deviceRef}:${localId}`;
}

export type UploadReceipt = {
  clientCaptureRef: string;
  serverId: number;
  /** True when this acknowledged an earlier upload of the same reference. */
  alreadyUploaded: boolean;
  /** SHA-256 of the bytes the server stored, hex. */
  contentHash: string;
};

export type ReceiptCheck =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: "wrong_reference" | "hash_mismatch" };

/**
 * A device marks a capture uploaded only when the receipt names its reference
 * and the server's hash equals the one the device computed. A mismatch is
 * `failed` and the local copy is retained — never deleted on a bad receipt.
 */
export function checkUploadReceipt(expected: { clientCaptureRef: string; contentHash: string }, receipt: UploadReceipt): ReceiptCheck {
  if (receipt.clientCaptureRef !== expected.clientCaptureRef) return { ok: false, reason: "wrong_reference" };
  if (receipt.contentHash.toLowerCase() !== expected.contentHash.toLowerCase()) return { ok: false, reason: "hash_mismatch" };
  return { ok: true, duplicate: receipt.alreadyUploaded };
}

// ---------------------------------------------------------------------------
// 5. Offline queue behaviour
// ---------------------------------------------------------------------------

/**
 * Why a queued send did not complete, as the client can observe it. tRPC error
 * codes map onto these; transport failures (no route, timeout, reset) are
 * `network`.
 */
export type SendFailure =
  | "network"
  | "server_unavailable"   // 502/503/504, or the server said try later
  | "rate_limited"         // 429
  | "unauthenticated"      // 401 — the session expired
  | "forbidden"            // 403 — the session is valid, the action is not permitted
  | "contract_refused"     // 426 — see negotiateContract
  | "conflict"             // a versioned write lost
  | "rejected"             // the server validated and refused the content (400/422, hash mismatch)
  | "not_found";

/**
 * What the queue does next.
 *
 *   retry          leave it `queued`, try again after `retryDelayMs`
 *   reauth         keep it `queued`, send nothing until the user signs in again
 *   upgrade        keep it `queued`, send nothing until the app updates (or drains)
 *   needs_person   mark `conflict` — both versions retained, a person decides
 *   failed         mark `failed` — retained with the reason, never deleted
 *
 * No failure deletes local work. No failure is resolved by resending under a
 * different identity or company.
 */
export type QueueDisposition = "retry" | "reauth" | "upgrade" | "needs_person" | "failed";

export function queueDisposition(f: SendFailure): QueueDisposition {
  switch (f) {
    case "network":
    case "server_unavailable":
    case "rate_limited":
      return "retry";
    case "unauthenticated":
      return "reauth";
    case "contract_refused":
      return "upgrade";
    case "conflict":
      return "needs_person";
    case "forbidden":
    case "rejected":
    case "not_found":
      return "failed";
  }
}

export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 15 * 60_000;

/**
 * Exponential backoff for `retry`. The step doubles from 2s (attempt 0) and
 * caps at 15 minutes; the delay falls in the upper half of the step, placed by
 * `jitter` — a caller-supplied number in [0, 1), so this stays pure — so a
 * fleet of devices coming back online at once does not arrive in lockstep.
 */
export function retryDelayMs(attempts: number, jitter = 0.5): number {
  const n = Math.max(0, Math.floor(attempts));
  const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n, 30));
  const j = Math.min(Math.max(jitter, 0), 0.999999);
  return Math.round(step / 2 + (step / 2) * j);
}
