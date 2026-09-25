/**
 * S2-A — purpose-separated authenticated encryption for secrets LeaseOS must present again.
 *
 * WHAT THIS REPLACES. `externalIdentityPolicy.ts` encrypts correctly — AES-256-GCM, a fresh
 * 12-byte IV per call, an authentication tag — and that primitive is kept unchanged here. Two
 * things it cannot express are the whole reason this module exists:
 *
 *   1. One key, two purposes. `LEASEOS_PORTAL_MFA_KEY` protects MFA seeds *and* webhook signing
 *      secrets, so rotating it because a webhook secret leaked would re-encrypt every driver's
 *      MFA seed, and whoever can read one class can read the other.
 *   2. Anonymous ciphertext. The old envelope is `iv.tag.ct`, which records neither the key that
 *      produced it nor what it is for — so rotation has nothing to key off and purpose confusion
 *      has nothing to catch it.
 *
 * WHAT IS AUTHENTICATED, AND WHY THAT IS THE DESIGN. `version`, `purpose`, `keyId` and the
 * record's `secretRef` are bound as GCM additional authenticated data. Editing any of them makes
 * the tag fail, so two attacks become arithmetic rather than policy: relabelling an envelope to
 * decrypt under another purpose's key, and copying ciphertext from one secret row into another to
 * repoint a credential. A check written in an `if` can be deleted by a refactor; AAD cannot.
 *
 * WHAT IS DELIBERATELY NOT BOUND. Nothing mutable — no display name, status or `lastUsedAt`.
 * Binding those would make renaming a credential destroy it, turning a cosmetic edit into data
 * loss.
 *
 * KEY MATERIAL NEVER LEAVES THIS BOUNDARY. Domain code passes a purpose and a provider and gets a
 * string back. No export returns a key, and `parseEnvelope` returns identity fields only.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_PURPOSES = [
  "MFA_SECRET",
  "WEBHOOK_SECRET",
  "PROVIDER_CREDENTIAL",
  "INTEGRATION_SECRET",
] as const;

export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * `<purpose>-v<n>`: lowercase, no separator character, and a version that sorts.
 * Validated when the provider is built so a typo fails at deploy, not at first write.
 */
const KEY_ID = /^[a-z][a-z0-9]*-v[1-9][0-9]*$/;

const isPurpose = (v: unknown): v is SecretPurpose =>
  typeof v === "string" && (SECRET_PURPOSES as readonly string[]).includes(v);

/* ------------------------------------------------------------------ key provider */

export type KeyDescriptor = { keyId: string; key: Buffer };

/**
 * The one boundary that knows about key material.
 *
 * `kind` is what makes OWNER DECISION S2-1 enforceable: an `"environment"` provider is fine for
 * development, test and controlled staging, and is refused for *new writes* in production. A
 * managed provider (KMS, Key Vault, Vault) implements the same two methods and reports
 * `"managed"`; no caller changes, because no caller ever sees a key.
 */
export interface SecretKeyProvider {
  readonly kind: "environment" | "managed";
  getActiveKey(purpose: SecretPurpose): KeyDescriptor | null;
  getDecryptKey(purpose: SecretPurpose, keyId: string): KeyDescriptor | null;
}

export type PurposeKeyConfig = {
  active: { keyId: string; hex: string };
  /** Decrypt-only predecessors. Readable, never selected for new writes. */
  retired?: { keyId: string; hex: string }[];
};

function material(keyId: string, hex: string): KeyDescriptor {
  if (!KEY_ID.test(keyId)) {
    throw new Error(`secret key configuration: ${JSON.stringify(keyId)} is not a valid key id (expected e.g. "provider-v1")`);
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    // Length AND alphabet: a 32-character hex string is 16 bytes, half the entropy the number
    // suggests, which is exactly the mistake `MIN_COOKIE_SECRET_LENGTH` exists to prevent.
    throw new Error(`secret key configuration: key ${keyId} must be ${KEY_BYTES} bytes as 64 hex characters`);
  }
  return { keyId, key: Buffer.from(hex, "hex") };
}

/**
 * Environment-backed provider. Reads nothing itself — the caller assembles the configuration, so
 * this module never touches `process.env` and the structural guard on master-key variables has a
 * single place to point at.
 */
export function createEnvironmentKeyProvider(
  config: Partial<Record<SecretPurpose, PurposeKeyConfig>>,
  options: { kind?: "environment" | "managed" } = {}
): SecretKeyProvider {
  const resolved = new Map<SecretPurpose, { active: KeyDescriptor; all: Map<string, KeyDescriptor> }>();

  for (const purpose of SECRET_PURPOSES) {
    const entry = config[purpose];
    if (!entry) continue;
    const active = material(entry.active.keyId, entry.active.hex);
    const all = new Map<string, KeyDescriptor>([[active.keyId, active]]);
    for (const r of entry.retired ?? []) {
      const d = material(r.keyId, r.hex);
      if (all.has(d.keyId)) throw new Error(`secret key configuration: duplicate key id ${d.keyId} for ${purpose}`);
      all.set(d.keyId, d);
    }
    resolved.set(purpose, { active, all });
  }

  return {
    kind: options.kind ?? "environment",
    getActiveKey: purpose => resolved.get(purpose)?.active ?? null,
    getDecryptKey: (purpose, keyId) => resolved.get(purpose)?.all.get(keyId) ?? null,
  };
}

/* ------------------------------------------------------------------ envelope */

export type ParsedEnvelope = {
  version: string;
  purpose: SecretPurpose;
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

/**
 * Strict parse. Six fields exactly, and the three binary ones are base64url — whose alphabet
 * (`A-Za-z0-9-_`) cannot contain the `.` separator, so the split is unambiguous by construction
 * rather than by hoping a value never contains a dot.
 */
export function parseEnvelope(envelope: string): ParsedEnvelope {
  if (typeof envelope !== "string" || envelope.length === 0) throw new Error("secret envelope: empty");

  const parts = envelope.split(".");
  if (parts.length !== 6) throw new Error(`secret envelope: expected 6 fields, found ${parts.length}`);

  const [version, purpose, keyId, iv, authTag, ciphertext] = parts as [string, string, string, string, string, string];

  if (version !== ENVELOPE_VERSION) throw new Error(`secret envelope: unsupported version ${JSON.stringify(version)}`);
  if (!isPurpose(purpose)) throw new Error(`secret envelope: unknown purpose ${JSON.stringify(purpose)}`);
  if (!KEY_ID.test(keyId)) throw new Error(`secret envelope: malformed key id ${JSON.stringify(keyId)}`);

  const B64URL = /^[A-Za-z0-9_-]+$/;
  for (const [name, value] of [["iv", iv], ["authTag", authTag], ["ciphertext", ciphertext]] as const) {
    if (!B64URL.test(value)) throw new Error(`secret envelope: ${name} is not base64url`);
  }
  if (Buffer.from(iv, "base64url").length !== IV_BYTES) throw new Error("secret envelope: iv is the wrong length");
  if (Buffer.from(authTag, "base64url").length !== TAG_BYTES) throw new Error("secret envelope: authTag is the wrong length");

  return { version, purpose, keyId, iv, authTag, ciphertext };
}

/**
 * The authenticated context. Identity and the owning record, nothing that can be edited casually.
 *
 * Built from the envelope's own fields on decrypt, which is what makes tampering detectable: a
 * rewritten `purpose` or `keyId` produces different AAD and the tag fails.
 */
const aad = (version: string, purpose: SecretPurpose, keyId: string, secretRef: string) =>
  Buffer.from(`${version}|${purpose}|${keyId}|${secretRef}`, "utf8");

export type SecretContext = { secretRef: string };

/* ------------------------------------------------------------------ operations */

function guardProductionWrites(keys: SecretKeyProvider, isProduction: boolean | undefined) {
  /*
   * OWNER DECISION S2-1. A managed key provider is required before real production credentials are
   * stored. Decryption stays permitted everywhere — legacy rows and staging depend on it — but a
   * new write in production under environment-held keys would look protected while its key sat in
   * a shell profile, so it is refused.
   */
  if (isProduction && keys.kind === "environment") {
    throw new Error(
      "secret write refused: production requires a managed key provider; the environment-backed provider is for development, test and controlled staging only"
    );
  }
}

export function encryptSecret(args: {
  purpose: SecretPurpose;
  plaintext: string;
  context: SecretContext;
  keys: SecretKeyProvider;
  /** Only for migration and rewrap: encrypt under a specific key the provider still holds. */
  keyId?: string;
  isProduction?: boolean;
}): string {
  const { purpose, plaintext, context, keys, keyId, isProduction } = args;

  if (!isPurpose(purpose)) throw new Error(`secret write refused: unknown purpose ${JSON.stringify(purpose)}`);
  if (!context?.secretRef) throw new Error("secret write refused: a secretRef is required to bind the ciphertext to its record");
  guardProductionWrites(keys, isProduction);

  const descriptor = keyId ? keys.getDecryptKey(purpose, keyId) : keys.getActiveKey(purpose);
  if (!descriptor) {
    throw new Error(
      keyId
        ? `secret write refused: no key ${JSON.stringify(keyId)} configured for ${purpose}`
        : `secret write refused: no active key configured for ${purpose}`
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, descriptor.key, iv);
  cipher.setAAD(aad(ENVELOPE_VERSION, purpose, descriptor.keyId, context.secretRef));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [
    ENVELOPE_VERSION,
    purpose,
    descriptor.keyId,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(args: {
  purpose: SecretPurpose;
  envelope: string;
  context: SecretContext;
  keys: SecretKeyProvider;
  isProduction?: boolean;
}): string {
  const { purpose, envelope, context, keys } = args;

  if (!context?.secretRef) throw new Error("secret read refused: a secretRef is required");

  const parsed = parseEnvelope(envelope);

  /*
   * The caller's declared purpose must match the envelope's. Checked explicitly for a clear
   * operator message — but note the AAD makes it redundant as a *security* control: a mismatched
   * purpose also fails the tag below, so deleting this line cannot open a hole.
   */
  if (parsed.purpose !== purpose) {
    throw new Error(`secret read refused: envelope is ${parsed.purpose}, caller asked for ${purpose}`);
  }

  const descriptor = keys.getDecryptKey(purpose, parsed.keyId);
  if (!descriptor) throw new Error(`secret read refused: no key ${JSON.stringify(parsed.keyId)} configured for ${purpose}`);

  const decipher = createDecipheriv(ALGORITHM, descriptor.key, Buffer.from(parsed.iv, "base64url"));
  decipher.setAAD(aad(parsed.version, parsed.purpose, parsed.keyId, context.secretRef));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64url"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately opaque: the caller learns the secret could not be read, never how far the
    // attempt got, and never any part of the plaintext or key.
    throw new Error("secret read refused: authentication failed (wrong key, wrong record, or tampered envelope)");
  }
}
