/**
 * S2-KMS-A — the managed key bootstrap, proved without any vendor.
 *
 * The backend here is the test fake: a KEK it never exports, AES-GCM wrapping, the failure modes a
 * real managed system has (unreachable, access denied, wrong material). What the tests pin is the
 * bootstrap's behaviour around it — that `"managed"` is only ever reported after every unwrap has
 * succeeded and been validated, that a retired key decrypts but is never written under, that a
 * failure stops the process rather than being caught, and that nothing on any path carries key
 * bytes: not the provider's serialization, not an error, not the configuration.
 */
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ManagedKeyBootstrapError,
  assertNoRawKeyMaterial,
  loadManagedSecretKeyProvider,
  validateManagedKeyConfig,
  type ManagedKeyConfig,
} from "./managedSecretKeys";
import { fakeManagedKeyBackend, type FakeBackendBehaviour } from "./managedKeyBackend.fake";
import {
  bootstrapSecretKeys,
  environmentSecretKeys,
  managedKeyConfigFromEnv,
  productionManagedKeyBackends,
  resetSecretKeysForTests,
  resolveSecretKeyProvider,
  secretKeyProvider,
  secretKeySource,
} from "./secretKeys";
import { createEnvironmentKeyProvider, decryptSecret, encryptSecret, parseEnvelope } from "./secretCrypto";

const hexKey = (seed: string) => seed.repeat(64).slice(0, 64);
const ctx = { secretRef: "sec_kms_test_0001" };

/** A backend, two webhook DEKs (active v2, retired v1) and the configuration that references them. */
function fixture(behaviour: FakeBackendBehaviour = {}) {
  const fake = fakeManagedKeyBackend({ behaviour });
  const dekV2 = randomBytes(32);
  const dekV1 = randomBytes(32);
  const mfa = randomBytes(32);
  const config: ManagedKeyConfig = {
    backend: fake.backend.name,
    keys: {
      WEBHOOK_SECRET: {
        active: { keyId: "webhook-v2", wrapped: fake.wrap(dekV2), backendKeyRef: fake.kekRef },
        retired: [{ keyId: "webhook-v1", wrapped: fake.wrap(dekV1), backendKeyRef: fake.kekRef }],
      },
      MFA_SECRET: { active: { keyId: "mfa-v1", wrapped: fake.wrap(mfa), backendKeyRef: fake.kekRef } },
    },
  };
  return { fake, config, dekV2, dekV1, mfa };
}

afterEach(() => resetSecretKeysForTests());

describe("KMS-T1/T2 — the environment provider is unchanged", () => {
  it("KMS-T1. remains kind=environment, from the variables and from the source selector", async () => {
    const env = { LEASEOS_KEY_WEBHOOK_V1: hexKey("7") };
    expect(environmentSecretKeys(env).kind).toBe("environment");
    expect(secretKeySource(env)).toBe("environment");
    expect(secretKeySource({ ...env, LEASEOS_SECRET_KEYS_SOURCE: "environment" })).toBe("environment");
    const resolved = await resolveSecretKeyProvider(env);
    expect(resolved).toMatchObject({ source: "environment", backend: null });
    expect(resolved.provider.kind).toBe("environment");
  });

  it("KMS-T2. a production write under the environment provider is still refused", () => {
    const keys = environmentSecretKeys({ LEASEOS_KEY_WEBHOOK_V1: hexKey("7") });
    expect(() => encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "x", context: ctx, keys, isProduction: true })).toThrow(/managed key provider/);
  });

  it("an unknown source value is refused rather than defaulted", () => {
    expect(() => secretKeySource({ LEASEOS_SECRET_KEYS_SOURCE: "kms" })).toThrow(/must be "environment" or "managed"/);
  });
});

describe("KMS-T3..T7 — a managed provider, and what it is allowed to do", () => {
  it("KMS-T3. kind=managed only after the backend has unwrapped every key", async () => {
    const { fake, config } = fixture();
    const provider = await loadManagedSecretKeyProvider({ config, backend: fake.backend });
    expect(provider.kind).toBe("managed");
    expect(provider.backend).toBe("test-fake");
    expect(fake.calls.probe).toBe(1);
    expect(fake.calls.unwrap.map(u => `${u.purpose}:${u.keyId}`).sort()).toEqual(["MFA_SECRET:mfa-v1", "WEBHOOK_SECRET:webhook-v1", "WEBHOOK_SECRET:webhook-v2"]);
    expect(provider.describe()).toEqual({ kind: "managed", backend: "test-fake", purposes: { WEBHOOK_SECRET: { active: "webhook-v2", retired: ["webhook-v1"] }, MFA_SECRET: { active: "mfa-v1", retired: [] } } });
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it("KMS-T4. the active WEBHOOK_SECRET encrypts and decrypts in production, under the unwrapped DEK", async () => {
    const { fake, config, dekV2 } = fixture();
    const provider = await loadManagedSecretKeyProvider({ config, backend: fake.backend });
    const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "signing-secret", context: ctx, keys: provider, isProduction: true });
    expect(parseEnvelope(envelope).keyId).toBe("webhook-v2");
    expect(decryptSecret({ purpose: "WEBHOOK_SECRET", envelope, context: ctx, keys: provider, isProduction: true })).toBe("signing-secret");
    // The same bytes the backend unwrapped: an environment provider built from them reads it too.
    const same = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v2", hex: dekV2.toString("hex") } } });
    expect(decryptSecret({ purpose: "WEBHOOK_SECRET", envelope, context: ctx, keys: same })).toBe("signing-secret");
  });

  it("KMS-T5. a retired key decrypts an old envelope", async () => {
    const { fake, config, dekV1 } = fixture();
    const old = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: dekV1.toString("hex") } } });
    const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "from-before-rotation", context: ctx, keys: old });
    const provider = await loadManagedSecretKeyProvider({ config, backend: fake.backend });
    expect(decryptSecret({ purpose: "WEBHOOK_SECRET", envelope, context: ctx, keys: provider, isProduction: true })).toBe("from-before-rotation");
  });

  it("KMS-T6. a retired key is never selected for a new write", async () => {
    const { fake, config } = fixture();
    const provider = await loadManagedSecretKeyProvider({ config, backend: fake.backend });
    for (let i = 0; i < 5; i += 1) {
      const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: `w${i}`, context: ctx, keys: provider, isProduction: true });
      expect(parseEnvelope(envelope).keyId).toBe("webhook-v2");
    }
    expect(provider.getActiveKey("WEBHOOK_SECRET")?.keyId).toBe("webhook-v2");
    expect(provider.getDecryptKey("WEBHOOK_SECRET", "webhook-v1")?.keyId).toBe("webhook-v1");
  });

  it("KMS-T7. a missing active WEBHOOK_SECRET fails closed — required at bootstrap, and refused at write", async () => {
    const { fake, config } = fixture();
    const withoutWebhook: ManagedKeyConfig = { backend: config.backend, keys: { MFA_SECRET: config.keys.MFA_SECRET } };
    await expect(loadManagedSecretKeyProvider({ config: withoutWebhook, backend: fake.backend, require: ["WEBHOOK_SECRET"] }))
      .rejects.toThrow(/required purpose WEBHOOK_SECRET is not configured/);
    const provider = await loadManagedSecretKeyProvider({ config: withoutWebhook, backend: fake.backend });
    expect(provider.getActiveKey("WEBHOOK_SECRET")).toBeNull();
    expect(() => encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "x", context: ctx, keys: provider, isProduction: true })).toThrow(/no active key configured for WEBHOOK_SECRET/);
    // Retired-only is not a configuration: a purpose present must have an active key.
    const retiredOnly = { backend: config.backend, keys: { WEBHOOK_SECRET: { retired: config.keys.WEBHOOK_SECRET!.retired } } } as unknown as ManagedKeyConfig;
    await expect(loadManagedSecretKeyProvider({ config: retiredOnly, backend: fake.backend })).rejects.toThrow(/no active key/);
  });
});

describe("KMS-T8..T11 — every failure stops the bootstrap", () => {
  it("KMS-T8. an unavailable backend fails the bootstrap, with a code and no provider", async () => {
    const { fake, config } = fixture({ unavailable: true });
    const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend }).catch(e => e);
    expect(err).toBeInstanceOf(ManagedKeyBootstrapError);
    expect(err.code).toBe("backend_unavailable");
    expect(err.message).toMatch(/backend test-fake unavailable — backend reported unavailable/);
  });

  it("a backend that never settles fails the bootstrap at the deadline instead of holding startup forever", async () => {
    const { fake, config } = fixture({ hang: true });
    const started = Date.now();
    const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend, timeoutMs: 60 }).catch(e => e);
    expect(err).toBeInstanceOf(ManagedKeyBootstrapError);
    expect(err.code).toBe("backend_timeout");
    expect(err.message).toMatch(/probe did not complete within 60 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("access denied on one key fails the whole bootstrap", async () => {
    const { fake, config } = fixture({ denyKeyIds: ["webhook-v1"] });
    const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend }).catch(e => e);
    expect(err.code).toBe("unwrap_failed");
    expect(err.message).toMatch(/WEBHOOK_SECRET\/webhook-v1 could not be unwrapped — backend reported denied/);
  });

  it("a backend that fails without a recognised code is reported as exactly that, and its text is not repeated", async () => {
    const { fake, config } = fixture({ unavailable: true, leakyErrors: `token ${hexKey("c")} and <Buffer aa bb cc dd ee ff 00 11>` });
    const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend }).catch(e => e);
    expect(err.code).toBe("backend_unavailable");
    expect(err.message).toMatch(/backend failed without a recognised code/);
    expect(err.message).not.toContain(hexKey("c"));
    expect(err.message).not.toContain("Buffer");
    expect(err.message).not.toContain("token");
  });

  it("KMS-T9. material of the wrong length fails the bootstrap — for the active and for a retired key", async () => {
    for (const keyId of ["webhook-v2", "webhook-v1"]) {
      const { fake, config } = fixture({ truncateKeyIds: [keyId] });
      const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend }).catch(e => e);
      expect(err.code, keyId).toBe("wrong_key_length");
      expect(err.message).toMatch(/is 16 bytes, expected 32/);
    }
  });

  it("KMS-T10. a duplicate application key id fails the bootstrap before any unwrap", async () => {
    const { fake, config } = fixture();
    config.keys.WEBHOOK_SECRET!.retired = [{ ...config.keys.WEBHOOK_SECRET!.active }];
    const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend }).catch(e => e);
    expect(err.code).toBe("duplicate_key_id");
    expect(fake.calls.unwrap).toEqual([]);
  });

  it("a wrapped reference the backend cannot open, a malformed key id, an unknown purpose and a backend mismatch all fail", async () => {
    const base = fixture();
    const broken = structuredClone(base.config);
    broken.keys.WEBHOOK_SECRET!.active.wrapped = "fake1.not.real.ciphertext";
    expect((await loadManagedSecretKeyProvider({ config: broken, backend: base.fake.backend }).catch(e => e)).code).toBe("unwrap_failed");

    const badId = structuredClone(base.config);
    badId.keys.WEBHOOK_SECRET!.active.keyId = "Webhook V2";
    expect((await loadManagedSecretKeyProvider({ config: badId, backend: base.fake.backend }).catch(e => e)).code).toBe("key_id");

    const badPurpose = { ...base.config, keys: { ...base.config.keys, SESSION_SECRET: base.config.keys.MFA_SECRET } } as unknown as ManagedKeyConfig;
    expect((await loadManagedSecretKeyProvider({ config: badPurpose, backend: base.fake.backend }).catch(e => e)).code).toBe("config_shape");

    const other = fakeManagedKeyBackend({ name: "other-backend" });
    expect((await loadManagedSecretKeyProvider({ config: base.config, backend: other.backend }).catch(e => e)).code).toBe("backend_mismatch");
  });

  it("KMS-T11. an envelope under an unknown key id fails resolution", async () => {
    const { fake, config } = fixture();
    const provider = await loadManagedSecretKeyProvider({ config, backend: fake.backend });
    const stranger = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v9", hex: hexKey("9") } } });
    const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "x", context: ctx, keys: stranger });
    expect(() => decryptSecret({ purpose: "WEBHOOK_SECRET", envelope, context: ctx, keys: provider, isProduction: true })).toThrow(/no key "webhook-v9" configured/);
  });
});

describe("KMS-T13 — no environment fallback, ever", () => {
  it("a managed source whose bootstrap fails leaves the process with no provider: the accessor throws", async () => {
    const { fake, config } = fixture({ unavailable: true });
    const env = { LEASEOS_SECRET_KEYS_SOURCE: "managed", LEASEOS_MANAGED_KEYS: JSON.stringify(config), LEASEOS_KEY_WEBHOOK_V1: hexKey("7") };
    await expect(bootstrapSecretKeys(env, { [fake.backend.name]: fake.backend })).rejects.toThrow(/backend test-fake unavailable/);
    // Environment keys ARE present in that env. They must not be what a crypto call gets.
    expect(() => secretKeyProvider(env)).toThrow(/configured but have not been bootstrapped/);
  });

  it("a managed source with no backend in the build fails — the production registry is empty", async () => {
    const { config } = fixture();
    const env = { LEASEOS_SECRET_KEYS_SOURCE: "managed", LEASEOS_MANAGED_KEYS: JSON.stringify(config) };
    expect(productionManagedKeyBackends()).toEqual({});
    const err = await resolveSecretKeyProvider(env).catch(e => e);
    expect(err.code).toBe("backend_unknown");
    expect(err.message).toMatch(/no managed key backend named "test-fake" exists in this build \(available: none\)/);
  });

  it("a successful managed bootstrap installs once, and the accessor serves it thereafter", async () => {
    const { fake, config } = fixture();
    const env = { LEASEOS_SECRET_KEYS_SOURCE: "managed", LEASEOS_MANAGED_KEYS: JSON.stringify(config) };
    const first = await bootstrapSecretKeys(env, { [fake.backend.name]: fake.backend });
    const second = await bootstrapSecretKeys(env, { [fake.backend.name]: fake.backend });
    expect(second.provider).toBe(first.provider);
    expect(fake.calls.probe, "the backend is contacted once per process").toBe(1);
    expect(secretKeyProvider(env)).toBe(first.provider);
    expect(secretKeyProvider(env).kind).toBe("managed");
  });

  it("missing or malformed managed configuration fails before any backend is named", async () => {
    expect(() => managedKeyConfigFromEnv({ LEASEOS_SECRET_KEYS_SOURCE: "managed" })).toThrow(/LEASEOS_MANAGED_KEYS is not set/);
    expect(() => managedKeyConfigFromEnv({ LEASEOS_MANAGED_KEYS: "{not json" })).toThrow(/not valid JSON/);
  });

  it("the configuration schema is strict: null, arrays, unknown fields and untyped values are coded refusals, before any backend lookup", async () => {
    const code = (raw: string) => {
      try {
        managedKeyConfigFromEnv({ LEASEOS_MANAGED_KEYS: raw });
        return "accepted";
      } catch (e) {
        return `${(e as ManagedKeyBootstrapError).code}: ${(e as Error).message}`;
      }
    };
    expect(code("null")).toMatch(/^config_shape: .*not an object/);
    expect(code("[]")).toMatch(/^config_shape:/);
    expect(code(JSON.stringify({ backend: "b" }))).toMatch(/^config_shape: .*config\.keys must be an object/);
    expect(code(JSON.stringify({ backend: "b", keys: {}, credential: "AKIA..." }))).toMatch(/^config_shape: .*unexpected field "credential"/);
    expect(code(JSON.stringify({ backend: "", keys: {} }))).toMatch(/^config_shape: .*config\.backend must be a non-empty string/);
    const ref = { keyId: "webhook-v1", wrapped: "fake1.a.b.c", backendKeyRef: "kek" };
    expect(code(JSON.stringify({ backend: "b", keys: { WEBHOOK_SECRET: { active: { ...ref, apiKey: "x" } } } }))).toMatch(/unexpected field "apiKey"/);
    expect(code(JSON.stringify({ backend: "b", keys: { WEBHOOK_SECRET: { active: { keyId: "webhook-v1", wrapped: 42, backendKeyRef: "kek" } } } }))).toMatch(/wrapped must be a non-empty string/);
    expect(code(JSON.stringify({ backend: "b", keys: { WEBHOOK_SECRET: { active: ref, retired: "no" } } }))).toMatch(/retired must be an array/);
    expect(code(JSON.stringify({ backend: "b", keys: { WEBHOOK_SECRET: { retired: [ref] } } }))).toMatch(/^no_active_key:/);
    expect(code(JSON.stringify({ backend: "b", keys: { SESSION: { active: ref } } }))).toMatch(/unknown purpose "SESSION"/);
    // The same refusal reaches the resolver as a code, not a TypeError.
    const err = await resolveSecretKeyProvider({ LEASEOS_SECRET_KEYS_SOURCE: "managed", LEASEOS_MANAGED_KEYS: "null" }).catch(e => e);
    expect(err).toBeInstanceOf(ManagedKeyBootstrapError);
    expect(err.code).toBe("config_shape");
    // And a valid document comes back normalised, with nothing added.
    const ok = validateManagedKeyConfig({ backend: "b", keys: { WEBHOOK_SECRET: { active: ref } } });
    expect(ok).toEqual({ backend: "b", keys: { WEBHOOK_SECRET: { active: ref } } });
  });
});

describe("KMS-T14 and the raw-key guard — nothing carries material", () => {
  it("raw 64-hex material anywhere in managed configuration is refused before the backend is contacted", async () => {
    const fake = fakeManagedKeyBackend();
    // A backend that WOULD treat a hex string as a key, to show the guard is what refuses it.
    const permissive = { ...fake.backend, unwrap: async (ref: { wrapped: string }) => Buffer.from(ref.wrapped, "hex") };
    const config: ManagedKeyConfig = { backend: "test-fake", keys: { WEBHOOK_SECRET: { active: { keyId: "webhook-v1", wrapped: hexKey("7"), backendKeyRef: fake.kekRef } } } };
    const err = await loadManagedSecretKeyProvider({ config, backend: permissive }).catch(e => e);
    expect(err.code).toBe("raw_key_in_config");
    expect(err.message).toMatch(/config\.keys\.WEBHOOK_SECRET\.active\.wrapped carries raw key material/);
    expect(() => managedKeyConfigFromEnv({ LEASEOS_MANAGED_KEYS: JSON.stringify(config) })).toThrow(/raw key material/);
    expect(() => assertNoRawKeyMaterial({ nested: [{ deep: hexKey("a") }] })).toThrow(/config\.nested\[0\]\.deep/);
    expect(() => assertNoRawKeyMaterial(config.keys.WEBHOOK_SECRET!.active.backendKeyRef)).not.toThrow();
  });

  it("KMS-T14. no key bytes in the provider's serialization, inspection, or any bootstrap error", async () => {
    const { fake, config, dekV2, dekV1, mfa } = fixture();
    const provider = await loadManagedSecretKeyProvider({ config, backend: fake.backend });
    const material = [dekV2, dekV1, mfa].flatMap(b => [b.toString("hex"), b.toString("base64"), b.toString("base64url")]);
    for (const text of [JSON.stringify(provider), inspect(provider), String(provider.describe())]) {
      for (const m of material) expect(text).not.toContain(m);
      expect(text).not.toMatch(/Buffer|<Buffer/);
    }
    expect(JSON.parse(JSON.stringify(provider))).toEqual(provider.describe());

    const truncated = fixture({ truncateKeyIds: ["webhook-v2"] });
    const err = await loadManagedSecretKeyProvider({ config: truncated.config, backend: truncated.fake.backend }).catch(e => e);
    const wrapped = truncated.config.keys.WEBHOOK_SECRET!.active.wrapped;
    for (const text of [err.message, inspect(err)]) {
      expect(text).not.toContain(truncated.dekV2.toString("hex"));
      expect(text).not.toContain(truncated.dekV2.subarray(0, 16).toString("hex"));
      expect(text).not.toContain(wrapped.split(".")[3]);
    }
  });

  it("no backend-controlled text reaches an error: only a code from the closed set, whatever the encoding", async () => {
    /*
     * A sanitizer was the first answer and the review was right to reject it: `<Buffer aa bb …>`,
     * spaced hex, and an error class name chosen by the adapter all slipped past a regex for long
     * tokens. So nothing the backend writes is repeated — not its message, not its name — only one
     * of the codes the contract defines.
     */
    const leaks = [`${randomBytes(32).toString("base64")}`, `<Buffer ${randomBytes(8).toString("hex").match(/../g)!.join(" ")}>`, `${hexKey("d").match(/../g)!.join(" ")}`];
    for (const leak of leaks) {
      const { fake, config } = fixture({ denyKeyIds: ["webhook-v2"], leakyErrors: leak });
      const err = await loadManagedSecretKeyProvider({ config, backend: fake.backend }).catch(e => e);
      expect(err.message).toMatch(/could not be unwrapped — backend failed without a recognised code/);
      expect(err.message).not.toContain(leak);
      expect(err.message).not.toContain(leak.slice(0, 12));
      expect(inspect(err)).not.toContain(leak);
    }
  });
});
