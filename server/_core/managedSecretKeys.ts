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
 * authentication, returns the wrong number of bytes, or is asked for a key it does not have, fails
 * the bootstrap and the process never becomes ready. There is no fallback to environment-held keys
 * — see `secretKeys.ts`.
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
 * What a managed backend must do. Deliberately two operations and a name:
 *
 *   probe   — can the backend be reached and is this workload allowed to use it? Throws when not.
 *   unwrap  — return the plaintext bytes of one wrapped DEK under the named backend key. Throws
 *             when the backend refuses, the reference is unknown, or the ciphertext is invalid.
 *
 * Authentication is the adapter's business and is expected to use the platform's workload
 * identity; nothing here accepts a credential.
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

/**
 * Strip anything that could be material from a message before it reaches an error or a log:
 * long base64/hex-looking runs become `[redacted]`. Backends are not trusted to be careful.
 */
export function sanitizeBackendMessage(message: string): string {
  return message.replace(/[A-Za-z0-9+/=_:-]{32,}/g, "[redacted]").slice(0, 300);
}

const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${sanitizeBackendMessage(e.message)}` : "unknown error");

function validateConfig(config: ManagedKeyConfig): void {
  if (!config || typeof config !== "object") throw new ManagedKeyBootstrapError("configuration is not an object", "config_shape");
  if (typeof config.backend !== "string" || !config.backend) throw new ManagedKeyBootstrapError("no backend named", "config_shape");
  if (!config.keys || typeof config.keys !== "object") throw new ManagedKeyBootstrapError("no keys section", "config_shape");
  assertNoRawKeyMaterial(config);

  for (const purpose of Object.keys(config.keys)) {
    if (!(SECRET_PURPOSES as readonly string[]).includes(purpose)) {
      throw new ManagedKeyBootstrapError(`unknown purpose ${JSON.stringify(purpose)}`, "config_shape");
    }
    const entry = config.keys[purpose as SecretPurpose]!;
    if (!entry.active) throw new ManagedKeyBootstrapError(`${purpose} has retired keys but no active key`, "no_active_key");
    const refs = [entry.active, ...(entry.retired ?? [])];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!isValidKeyId(ref.keyId)) throw new ManagedKeyBootstrapError(`${purpose}: ${JSON.stringify(ref.keyId)} is not a valid key id`, "key_id");
      if (typeof ref.wrapped !== "string" || !ref.wrapped) throw new ManagedKeyBootstrapError(`${purpose}/${ref.keyId}: no wrapped material reference`, "config_shape");
      if (typeof ref.backendKeyRef !== "string" || !ref.backendKeyRef) throw new ManagedKeyBootstrapError(`${purpose}/${ref.keyId}: no backend key reference`, "config_shape");
      if (seen.has(ref.keyId)) throw new ManagedKeyBootstrapError(`${purpose}: duplicate key id ${ref.keyId}`, "duplicate_key_id");
      seen.add(ref.keyId);
    }
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
}): Promise<ManagedSecretKeyProvider> {
  const { config, backend } = args;
  validateConfig(config);
  if (backend.name !== config.backend) {
    throw new ManagedKeyBootstrapError(`configuration names backend ${JSON.stringify(config.backend)} but ${JSON.stringify(backend.name)} was supplied`, "backend_mismatch");
  }
  for (const purpose of args.require ?? []) {
    if (!config.keys[purpose]) throw new ManagedKeyBootstrapError(`required purpose ${purpose} is not configured`, "missing_required_purpose");
  }

  try {
    await backend.probe();
  } catch (e) {
    throw new ManagedKeyBootstrapError(`backend ${backend.name} unavailable — ${errorText(e)}`, "backend_unavailable");
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
        bytes = await backend.unwrap({ purpose, keyId: ref.keyId, wrapped: ref.wrapped, backendKeyRef: ref.backendKeyRef });
      } catch (e) {
        throw new ManagedKeyBootstrapError(`${purpose}/${ref.keyId} could not be unwrapped — ${errorText(e)}`, "unwrap_failed");
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
