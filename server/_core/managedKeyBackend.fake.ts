/**
 * A managed key backend for tests: the contract, with the custody model made literal.
 *
 * It owns a KEK that never leaves it, wraps DEKs under that KEK with AES-256-GCM, and unwraps on
 * request — the way a KMS `Decrypt` or a Key Vault `unwrapKey` does. Configuration produced from it
 * therefore carries ciphertext and references, which is the property the bootstrap guards. It
 * fails the way the contract says a backend fails: with a `ManagedKeyBackendError` code, never a
 * message the bootstrap would have to sanitize.
 *
 * NOT PRODUCTION WIRING. It is registered by tests only; `productionManagedKeyBackends()` in
 * `secretKeys.ts` does not know it exists, and a structural test keeps it that way. Its failure
 * modes (`unavailable`, `denyKeyIds`, `truncateKeyIds`, `hang`, `leakyErrors`) are how the
 * fail-closed paths are driven.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ManagedKeyBackendError, type ManagedKeyBackend } from "./managedSecretKeys";
import type { SecretPurpose } from "./secretCrypto";

export type FakeBackendBehaviour = {
  /** `probe()` and `unwrap()` fail as an unreachable or unauthenticated backend would. */
  unavailable?: boolean;
  /** `unwrap()` refuses these key ids — a KEK policy denial. */
  denyKeyIds?: string[];
  /** `unwrap()` returns this many bytes for these key ids instead of the real DEK. */
  truncateKeyIds?: string[];
  /** `probe()` never settles — a backend SDK that hangs. */
  hang?: boolean;
  /** Fail with a plain `Error` whose message carries this text: a careless adapter. */
  leakyErrors?: string;
};

export function fakeManagedKeyBackend(options: { name?: string; kekRef?: string; behaviour?: FakeBackendBehaviour } = {}) {
  const name = options.name ?? "test-fake";
  const kekRef = options.kekRef ?? "kek-test-1";
  const kek = randomBytes(32);
  const behaviour = options.behaviour ?? {};
  const calls: { probe: number; unwrap: { purpose: SecretPurpose; keyId: string }[] } = { probe: 0, unwrap: [] };

  /** Wrap a DEK under the KEK. Returns the config-shaped ciphertext (`fake1.<iv>.<tag>.<ct>`). */
  const wrap = (dek: Buffer, ref = kekRef): string => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", kek, iv);
    c.setAAD(Buffer.from(ref));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return ["fake1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  };

  const fail = (code: ConstructorParameters<typeof ManagedKeyBackendError>[0]): never => {
    if (behaviour.leakyErrors) throw new Error(`${code}: ${behaviour.leakyErrors}`);
    throw new ManagedKeyBackendError(code);
  };

  const backend: ManagedKeyBackend = {
    name,
    async probe() {
      calls.probe += 1;
      if (behaviour.hang) return new Promise<void>(() => undefined);
      if (behaviour.unavailable) fail("unavailable");
    },
    async unwrap(ref) {
      calls.unwrap.push({ purpose: ref.purpose, keyId: ref.keyId });
      if (behaviour.hang) return new Promise<Buffer>(() => undefined);
      if (behaviour.unavailable) fail("unavailable");
      if (behaviour.denyKeyIds?.includes(ref.keyId)) fail("denied");
      if (ref.backendKeyRef !== kekRef) fail("unknown_key");
      const [v, iv, tag, ct] = ref.wrapped.split(".");
      if (v !== "fake1" || !iv || !tag || !ct) fail("invalid_ciphertext");
      try {
        const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(iv!, "base64url"));
        d.setAAD(Buffer.from(ref.backendKeyRef));
        d.setAuthTag(Buffer.from(tag!, "base64url"));
        const dek = Buffer.concat([d.update(Buffer.from(ct!, "base64url")), d.final()]);
        return behaviour.truncateKeyIds?.includes(ref.keyId) ? dek.subarray(0, 16) : dek;
      } catch {
        return fail("invalid_ciphertext");
      }
    },
  };

  return { backend, wrap, kekRef, calls };
}
