/**
 * S2-KMS-A — the managed key bootstrap: how a `kind: "managed"` provider comes to exist.
 *
 * WHAT "MANAGED" MEANS HERE, PRECISELY. The application's data-encryption keys (DEKs — one 32-byte
 * key per purpose, plus retired predecessors) are held AT REST only as ciphertext wrapped by a key
 * the managed backend owns and never exports. At process start, the backend is asked to unwrap
 * each configured DEK; the plaintext DEK then lives in this process's memory, inside the closure
 * below, for the life of the process. It is never in an environment variable, a file, a database
 * row, a log line or source. That is MODEL A: managed KEK, application DEKs, unchanged `v1`
 * envelopes. It is NOT a claim that key material never exists in process memory, and it is not
 * HSM-only execution — LeaseOS receives a plaintext DEK and encrypts with it locally, exactly as it
 * does today. The difference is custody at rest and at provisioning time.
 *
 * WHY NOT REMOTE CRYPTO (MODEL B). Encrypting and decrypting through the backend on every call
 * would make `encryptSecret`/`decryptSecret` asynchronous, change every store and service
 * signature, put network latency inside request handling and the retry sweep, and require a new
 * envelope version for the backend-wrapped ciphertext — a migration of every canonical row that
 * exists. Model A changes nothing about the envelope, the store, the refs or the services.
 *
 * THE BOUNDARY IS ASYNCHRONOUS ONCE, THEN SYNCHRONOUS FOREVER. `loadManagedSecretKeyProvider` is
 * the only place a backend is contacted. It unwraps every key, validates all of it, and returns an
 * immutable provider whose `getActiveKey`/`getDecryptKey` are plain map lookups. A provider never
 * reports `"managed"` before every unwrap has succeeded; a backend that is unavailable, denies
 * authentication, returns the wrong number of bytes, is asked for a key it does not have, or does
 * not answer within the deadline, fails the bootstrap and the process never becomes ready. There
 * is no fallback to environment-held keys — see `secretKeys.ts`.
 *
 * WHAT A BACKEND MAY SAY. Nothing free-form. A backend reports failure with a
 * `ManagedKeyBackendError` carrying one of a closed set of codes, and that code — never the
 * backend's message, never a class name it chose — is what reaches the bootstrap error and the
 * startup log. A backend-controlled string is the one channel through which key bytes could reach
 * a log, in any encoding a regex did not anticipate, so no such string is propagated at all.
 *
 * VENDOR-NEUTRAL BY NECESSITY. The hosting survey for this checkpoint found no evidence of the
 * production platform, so no vendor adapter exists. `ManagedKeyBackend` is the seam one will plug
 * into: a name, a probe, and an unwrap under a backend key reference — the operations every real
 * managed key system shares (KMS Decrypt, Key Vault unwrapKey, Vault transit datakey). It is not
 * a protocol, has no endpoints, and nothing in this file knows how any vendor authenticates.
 */
import { inspect } from "node:util";
import { SECRET_PURPOSES, isValidKeyId, type KeyDescriptor, type SecretKeyProvider, type SecretPurpose } from "./secretCrypto";

const DEK_BYTES = 32;

/** How long one backend operation (the probe, or one unwrap) may take before the bootstrap fails. */
export const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;

/** A wrapped DEK as configuration carries it: references and ciphertext, never material. */
export type WrappedKeyRef = {
  /** The application key id written into envelopes, e.g. `webhook-v1`. */
  keyId: string;
  /** The backend's wrapped ciphertext of the 32-byte DEK, in the backend's own encoding. */
  wrapped: string;
  /** Which backend key (KEK) wraps it — a name or ARN or path the backend understands. */
  backendKeyRef: string;
};

export type ManagedPurposeConfig = {
  active: WrappedKeyRef;
  /** Decrypt-only predecessors. Readable for old envelopes, never selected for a new write. */
  retired?: WrappedKeyRef[];
};

export type ManagedKeyConfig = {
  /** Which registered backend performs the unwrap. */
  backend: string;
  keys: Partial<Record<SecretPurpose, ManagedPurposeConfig>>;
};

/**
 * The closed set of things a backend may report. An adapter maps its vendor's failures onto these;
 * anything it cannot classify is `internal`. Codes are the only backend-originated text the
 * bootstrap ever repeats.
 */
export const MANAGED_KEY_BACKEND_ERROR_CODES = [
  "unavailable", //        unreachable, or the workload could not authenticate
  "denied", //             authenticated, but not permitted to use this key
  "unknown_key", //        the backend key reference names nothing
  "invalid_ciphertext", // the wrapped value is not something this backend produced
  "internal", //           anything else
] as const;
export type ManagedKeyBackendErrorCode = (typeof MANAGED_KEY_BACKEND_ERROR_CODES)[number];

export class ManagedKeyBackendError extends Error {
  readonly code: ManagedKeyBackendErrorCode;
  constructor(code: ManagedKeyBackendErrorCode) {
    super(`managed key backend: ${code}`);
    this.name = "ManagedKeyBackendError";
    this.code = code;
  }
}

/**
 * What a managed backend must do. Deliberately two operations and a name:
 *
 *   probe   — can the backend be reached and is this workload allowed to use it? Rejects with a
 *             `ManagedKeyBackendError` when not.
 *   unwrap  — return the plaintext bytes of one wrapped DEK under the named backend key. Rejects
 *             with a `ManagedKeyBackendError` when the backend refuses, the reference is unknown,
 *             or the ciphertext is invalid.
 *
 * Both are bounded by the bootstrap's deadline; an adapter that never settles is treated as
 * unavailable. Authentication is the adapter's business and is expected to use the platform's
 * workload identity; nothing here accepts a credential.
 */
export interface ManagedKeyBackend {
  readonly name: string;
  probe(): Promise<void>;
  unwrap(ref: { purpose: SecretPurpose; keyId: string; wrapped: string; backendKeyRef: string }): Promise<Buffer>;
}

/** Metadata a managed provider will admit to. Nothing here is material. */
export type ManagedProviderDescription = {
  kind: "managed";
  backend: string;
  purposes: Partial<Record<SecretPurpose, { active: string; retired: string[] }>>;
};

export interface ManagedSecretKeyProvider extends SecretKeyProvider {
  readonly kind: "managed";
  readonly backend: string;
  describe(): ManagedProviderDescription;
}

export class ManagedKeyBootstrapError extends Error {
  constructor(message: string, readonly code: string) {
    super(`managed key bootstrap failed: ${message}`);
    this.name = "ManagedKeyBootstrapError";
  }
}

const RAW_KEY_SHAPE = /^[0-9a-f]{64}$/i;

/**
 * Nothing that looks like key material may appear in managed configuration. A 64-hex string is
 * exactly a raw 32-byte key — the one thing the managed path exists to keep out of configuration
 * — so its presence anywhere in the config is refused before any backend is contacted.
 */
export function assertNoRawKeyMaterial(value: unknown, path = "config"): void {
  if (typeof value === "string") {
    if (RAW_KEY_SHAPE.test(value)) {
      throw new ManagedKeyBootstrapError(`${path} carries raw key material; managed configuration must hold wrapped references only`, "raw_key_in_config");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoRawKeyMaterial(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertNoRawKeyMaterial(v, `${path}.${k}`);
  }
}

/** Only a code is ever repeated. A backend's message, and even its error class name, are not. */
const backendFailure = (e: unknown): string => {
  if (e instanceof ManagedKeyBackendError && (MANAGED_KEY_BACKEND_ERROR_CODES as readonly string[]).includes(e.code)) {
    return `backend reported ${e.code}`;
  }
  return "backend failed without a recognised code";
};

const shape = (message: string) => new ManagedKeyBootstrapError(message, "config_shape");
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (obj: Record<string, unknown>, allowed: readonly string[], path: string) => {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw shape(`${path} carries an unexpected field ${JSON.stringify(k)}; managed configuration holds references only`);
  }
};
const nonEmptyString = (v: unknown, path: string): string => {
  if (typeof v !== "string" || v.length === 0) throw shape(`${path} must be a non-empty string`);
  return v;
};

/**
 * A strict runtime schema for what `LEASEOS_MANAGED_KEYS` may contain. Every field is named, every
 * extra field is refused, every value is typed, before anything is cast and long before a backend
 * is named. `null`, an array, a stray `credential` field or a missing reference each produce a
 * coded `config_shape` refusal rather than a `TypeError` somewhere later.
 */
export function validateManagedKeyConfig(value: unknown): ManagedKeyConfig {
  if (!isPlainObject(value)) throw shape("configuration is not an object");
  exactKeys(value, ["backend", "keys"], "config");
  const backend = nonEmptyString(value.backend, "config.backend");
  if (!isPlainObject(value.keys)) throw shape("config.keys must be an object of purposes");
  assertNoRawKeyMaterial(value);

  const keys: Partial<Record<SecretPurpose, ManagedPurposeConfig>> = {};
  for (const [purpose, entry] of Object.entries(value.keys)) {
    if (!(SECRET_PURPOSES as readonly string[]).includes(purpose)) throw shape(`unknown purpose ${JSON.stringify(purpose)}`);
    if (!isPlainObject(entry)) throw shape(`config.keys.${purpose} must be an object`);
    exactKeys(entry, ["active", "retired"], `config.keys.${purpose}`);
    if (!("active" in entry)) throw new ManagedKeyBootstrapError(`${purpose} has retired keys but no active key`, "no_active_key");
    const refs: WrappedKeyRef[] = [];
    const retiredRaw = entry.retired === undefined ? [] : entry.retired;
    if (!Array.isArray(retiredRaw)) throw shape(`config.keys.${purpose}.retired must be an array`);
    for (const [label, raw] of [["active", entry.active], ...retiredRaw.map((r, i) => [`retired[${i}]`, r] as const)] as const) {
      const path = `config.keys.${purpose}.${label}`;
      if (!isPlainObject(raw)) throw shape(`${path} must be an object`);
      exactKeys(raw, ["keyId", "wrapped", "backendKeyRef"], path);
      const keyId = nonEmptyString(raw.keyId, `${path}.keyId`);
      if (!isValidKeyId(keyId)) throw new ManagedKeyBootstrapError(`${purpose}: ${JSON.stringify(keyId)} is not a valid key id`, "key_id");
      refs.push({ keyId, wrapped: nonEmptyString(raw.wrapped, `${path}.wrapped`), backendKeyRef: nonEmptyString(raw.backendKeyRef, `${path}.backendKeyRef`) });
    }
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.keyId)) throw new ManagedKeyBootstrapError(`${purpose}: duplicate key id ${ref.keyId}`, "duplicate_key_id");
      seen.add(ref.keyId);
    }
    const [active, ...retired] = refs as [WrappedKeyRef, ...WrappedKeyRef[]];
    keys[purpose as SecretPurpose] = retired.length ? { active, retired } : { active };
  }
  return { backend, keys };
}

/** Bound one backend operation. A backend that never settles must not hold startup forever. */
async function withDeadline<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ManagedKeyBootstrapError(`${what} did not complete within ${ms} ms`, "backend_timeout")), ms);
  });
  try {
    return await Promise.race([operation, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Contact the backend, unwrap every configured key, validate everything, and only then hand back
 * a provider. `require` names purposes that must be present and loaded — a process that cannot
 * exist without a purpose says so here rather than discovering it on the first write.
 */
export async function loadManagedSecretKeyProvider(args: {
  config: ManagedKeyConfig;
  backend: ManagedKeyBackend;
  require?: SecretPurpose[];
  timeoutMs?: number;
}): Promise<ManagedSecretKeyProvider> {
  const config = validateManagedKeyConfig(args.config);
  const { backend } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
  if (backend.name !== config.backend) {
    throw new ManagedKeyBootstrapError(`configuration names backend ${JSON.stringify(config.backend)} but ${JSON.stringify(backend.name)} was supplied`, "backend_mismatch");
  }
  for (const purpose of args.require ?? []) {
    if (!config.keys[purpose]) throw new ManagedKeyBootstrapError(`required purpose ${purpose} is not configured`, "missing_required_purpose");
  }

  try {
    await withDeadline(backend.probe(), timeoutMs, `backend ${backend.name} probe`);
  } catch (e) {
    if (e instanceof ManagedKeyBootstrapError) throw e;
    throw new ManagedKeyBootstrapError(`backend ${backend.name} unavailable — ${backendFailure(e)}`, "backend_unavailable");
  }

  /*
   * Material is accumulated here and nowhere else. The maps are closed over by the provider and
   * never exposed: `describe()`, `toJSON()` and `inspect` all answer with ids only.
   */
  const active = new Map<SecretPurpose, KeyDescriptor>();
  const all = new Map<string, KeyDescriptor>();
  const description: ManagedProviderDescription["purposes"] = {};

  for (const purpose of SECRET_PURPOSES) {
    const entry = config.keys[purpose];
    if (!entry) continue;
    const loaded: KeyDescriptor[] = [];
    for (const ref of [entry.active, ...(entry.retired ?? [])]) {
      let bytes: Buffer;
      try {
        bytes = await withDeadline(
          backend.unwrap({ purpose, keyId: ref.keyId, wrapped: ref.wrapped, backendKeyRef: ref.backendKeyRef }),
          timeoutMs,
          `${purpose}/${ref.keyId} unwrap`
        );
      } catch (e) {
        if (e instanceof ManagedKeyBootstrapError) throw e;
        throw new ManagedKeyBootstrapError(`${purpose}/${ref.keyId} could not be unwrapped — ${backendFailure(e)}`, "unwrap_failed");
      }
      if (!Buffer.isBuffer(bytes)) throw new ManagedKeyBootstrapError(`${purpose}/${ref.keyId}: backend returned non-binary material`, "malformed_material");
      // The length, never the bytes. This is the one place material is inspected at all.
      if (bytes.length !== DEK_BYTES) throw new ManagedKeyBootstrapError(`${purpose}/${ref.keyId}: unwrapped material is ${bytes.length} bytes, expected ${DEK_BYTES}`, "wrong_key_length");
      loaded.push({ keyId: ref.keyId, key: Buffer.from(bytes) });
    }
    const [first, ...rest] = loaded as [KeyDescriptor, ...KeyDescriptor[]];
    active.set(purpose, first);
    for (const d of loaded) all.set(`${purpose}:${d.keyId}`, d);
    description[purpose] = { active: first.keyId, retired: rest.map(d => d.keyId) };
  }

  const describe = (): ManagedProviderDescription => ({ kind: "managed", backend: backend.name, purposes: structuredClone(description) });

  const provider: ManagedSecretKeyProvider = {
    kind: "managed",
    backend: backend.name,
    getActiveKey: purpose => active.get(purpose) ?? null,
    getDecryptKey: (purpose, keyId) => all.get(`${purpose}:${keyId}`) ?? null,
    describe,
    // Serialization and inspection answer with metadata, so a provider that ends up in a log
    // line or a JSON response carries ids and never bytes.
    toJSON: describe,
    [inspect.custom]: describe,
  } as ManagedSecretKeyProvider & { toJSON(): ManagedProviderDescription; [inspect.custom](): ManagedProviderDescription };

  return Object.freeze(provider);
}
