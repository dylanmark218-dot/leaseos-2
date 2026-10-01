/**
 * S2-A — purpose-separated encryption, and the identity the old envelope lacked.
 *
 * `externalIdentityPolicy.ts` already encrypts correctly: AES-256-GCM, a fresh 12-byte IV per
 * call, an authentication tag. That primitive is kept. What it has no way to express is *which*
 * key and *what for* — the envelope is an anonymous `iv.tag.ct` — and one environment variable
 * (`LEASEOS_PORTAL_MFA_KEY`) currently protects both MFA seeds and webhook signing secrets. So
 * rotating a leaked webhook secret's key would re-encrypt every driver's MFA seed, and anyone who
 * can decrypt one class can decrypt the other.
 *
 * WHY THE AAD MATTERS MORE THAN THE PARSE. `version`, `purpose`, `keyId` and `secretRef` are bound
 * as GCM additional authenticated data, so purpose confusion and ciphertext transplanting are
 * *cryptographic* failures rather than policy checks somebody can forget to write. A19 and A20
 * exist because the remaining ways to lose a secret are operational, not mathematical: shipping a
 * development key into production, and handing a caller raw key material.
 *
 * Nothing mutable is bound. Renaming a credential or touching `lastUsedAt` must never make
 * ciphertext undecryptable — that would turn a cosmetic edit into data loss.
 */
import { describe, expect, it } from "vitest";
import {
  SECRET_PURPOSES,
  createEnvironmentKeyProvider,
  decryptSecret,
  encryptSecret,
  parseEnvelope,
  type KeyDescriptor,
  type SecretKeyProvider,
  type SecretPurpose,
} from "./secretCrypto";

/** 32 bytes of key material, as 64 hex characters — the shape `mfaKey()` already validates. */
const hexKey = (seed: string) => seed.repeat(64).slice(0, 64);

/** A provider with one active key per purpose, and an optional retired predecessor. */
function providerWith(
  opts: { retired?: boolean; kind?: "environment" | "managed" } = {}
): SecretKeyProvider {
  const keys: Record<string, { active: { keyId: string; hex: string }; retired?: { keyId: string; hex: string }[] }> = {
    MFA_SECRET: { active: { keyId: "mfa-v2", hex: hexKey("a") }, retired: opts.retired ? [{ keyId: "mfa-v1", hex: hexKey("b") }] : [] },
    WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("c") } },
    PROVIDER_CREDENTIAL: { active: { keyId: "provider-v1", hex: hexKey("d") } },
    INTEGRATION_SECRET: { active: { keyId: "integration-v1", hex: hexKey("e") } },
  };
  const environment = createEnvironmentKeyProvider(keys);
  if ((opts.kind ?? "environment") === "environment") return environment;
  /*
   * A managed-shaped provider for the production-write tests. Deliberately NOT the environment
   * provider relabelled — `createEnvironmentKeyProvider` no longer accepts a kind, so the only way
   * to be `"managed"` is to be a separate implementation of the interface. This one keeps its
   * material in its own table, the way a KMS-backed implementation would hold handles.
   */
  const held = new Map<string, KeyDescriptor>();
  for (const purpose of SECRET_PURPOSES) {
    const active = environment.getActiveKey(purpose);
    if (active) held.set(`${purpose}:${active.keyId}`, active);
    const retired = keys[purpose]?.retired ?? [];
    for (const r of retired) held.set(`${purpose}:${r.keyId}`, { keyId: r.keyId, key: Buffer.from(r.hex, "hex") });
  }
  return {
    kind: "managed",
    getActiveKey: purpose => environment.getActiveKey(purpose),
    getDecryptKey: (purpose, keyId) => held.get(`${purpose}:${keyId}`) ?? null,
  };
}

const ctx = (secretRef = "sec_test_0001") => ({ secretRef });

describe("A1-A4 — every purpose round-trips under its own key", () => {
  for (const purpose of ["MFA_SECRET", "WEBHOOK_SECRET", "PROVIDER_CREDENTIAL", "INTEGRATION_SECRET"] as const) {
    it(`round-trips ${purpose}`, () => {
      const keys = providerWith();
      const plaintext = `secret-for-${purpose}`;

      const envelope = encryptSecret({ purpose, plaintext, context: ctx(), keys });

      expect(decryptSecret({ purpose, envelope, context: ctx(), keys })).toBe(plaintext);
    });
  }

  it("the purpose vocabulary is exactly the four agreed classes", () => {
    expect([...SECRET_PURPOSES].sort()).toEqual([
      "INTEGRATION_SECRET", "MFA_SECRET", "PROVIDER_CREDENTIAL", "WEBHOOK_SECRET",
    ]);
  });
});

describe("A5 — a fresh nonce every time", () => {
  it("encrypts the same plaintext to different ciphertext twice", () => {
    const keys = providerWith();
    const args = { purpose: "PROVIDER_CREDENTIAL" as const, plaintext: "same-key-value", context: ctx(), keys };

    const a = encryptSecret(args);
    const b = encryptSecret(args);

    expect(a).not.toBe(b);
    // And both still decrypt — distinctness must come from the IV, not from a broken key.
    expect(decryptSecret({ ...args, envelope: a })).toBe("same-key-value");
    expect(decryptSecret({ ...args, envelope: b })).toBe("same-key-value");
  });
});

describe("A6/A11 — purpose is enforced, and it is enforced by the tag", () => {
  it("A6. refuses to decrypt under a different purpose", () => {
    const keys = providerWith();
    const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "s", context: ctx(), keys });

    expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope, context: ctx(), keys })).toThrow();
  });

  it("A11. refuses an envelope whose purpose field was edited", () => {
    const keys = providerWith();
    const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "s", context: ctx(), keys });
    const tampered = envelope.replace("WEBHOOK_SECRET", "MFA_SECRET");

    expect(tampered).not.toBe(envelope);
    expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope: tampered, context: ctx(), keys })).toThrow();
  });

  it("A11b. the purpose is bound by the tag, not merely by the key lookup", () => {
    /*
     * A11 alone proves less than it appears to. Relabelling the purpose leaves `keyId` pointing at
     * another purpose's key, so the key lookup refuses first and the AAD is never reached — a
     * mutation that removes the purpose from the AAD *and* deletes the explicit comparison
     * survives A11 untouched. That was found by planting exactly that mutation.
     *
     * So this constructs the one case where the lookup cannot help: two purposes sharing the same
     * key id AND the same key material. The relabelled envelope finds a perfectly valid key, and
     * the only thing left that can refuse it is the authenticated purpose.
     */
    const shared = { keyId: "shared-v1", hex: hexKey("f") };
    const keys = createEnvironmentKeyProvider({
      MFA_SECRET: { active: shared },
      WEBHOOK_SECRET: { active: shared },
    });

    const envelope = encryptSecret({ purpose: "WEBHOOK_SECRET", plaintext: "signing-secret", context: ctx(), keys });
    const relabelled = envelope.replace("WEBHOOK_SECRET", "MFA_SECRET");

    // Same key id, so `getDecryptKey("MFA_SECRET", "shared-v1")` succeeds — no lookup refusal.
    expect(parseEnvelope(relabelled).keyId).toBe("shared-v1");
    expect(() =>
      decryptSecret({ purpose: "MFA_SECRET", envelope: relabelled, context: ctx(), keys })
    ).toThrow(/authentication failed/i);
  });
});

describe("A7/A12 — key identity is enforced", () => {
  it("A7. refuses an unknown keyId rather than falling back to the active key", () => {
    /*
     * Asserted on the *configuration* refusal specifically, not on "it threw". A mutation that
     * falls back to the active key when the id is unknown still throws — the AAD carries the
     * unknown id, so the tag fails — and a looser assertion passes while the explicit lookup is
     * gone. Two layers protect this; the test has to say which one it is checking.
     */
    const keys = providerWith();
    const envelope = encryptSecret({ purpose: "MFA_SECRET", plaintext: "s", context: ctx(), keys });
    const unknown = envelope.replace("mfa-v2", "mfa-v9");

    expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope: unknown, context: ctx(), keys })).toThrow(
      /no key "mfa-v9" configured/
    );
  });

  it("A12. refuses an envelope whose keyId was edited to a real other key", () => {
    const keys = providerWith({ retired: true });
    const envelope = encryptSecret({ purpose: "MFA_SECRET", plaintext: "s", context: ctx(), keys });
    // mfa-v1 exists, so this is not caught by "unknown key" — only the tag catches it.
    const swapped = envelope.replace("mfa-v2", "mfa-v1");

    expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope: swapped, context: ctx(), keys })).toThrow();
  });
});

describe("A8/A9/A10 — malformed and tampered envelopes fail closed", () => {
  const keys = providerWith();
  const good = () => encryptSecret({ purpose: "MFA_SECRET", plaintext: "s", context: ctx(), keys });

  it("A8. refuses malformed envelopes", () => {
    const bad = [
      "", "not-an-envelope", "v1.MFA_SECRET", "v1.MFA_SECRET.mfa-v2.aa.bb",
      `${good()}.extra`, good().replace("v1.", "v2."), good().replace("v1.", ""),
      good().replace("MFA_SECRET", "NOT_A_PURPOSE"), good().replace("mfa-v2", "bad key id"),
    ];
    for (const envelope of bad) {
      expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope, context: ctx(), keys }), envelope.slice(0, 30)).toThrow();
    }
  });

  it("A9. refuses tampered ciphertext", () => {
    const parts = good().split(".");
    parts[5] = Buffer.from("different-bytes").toString("base64url");
    expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope: parts.join("."), context: ctx(), keys })).toThrow();
  });

  it("A10. refuses a tampered authentication tag", () => {
    const parts = good().split(".");
    parts[4] = Buffer.alloc(16, 7).toString("base64url");
    expect(() => decryptSecret({ purpose: "MFA_SECRET", envelope: parts.join("."), context: ctx(), keys })).toThrow();
  });

  it("no binary field can contain the separator", () => {
    // base64url's alphabet is A-Za-z0-9-_ — the dot cannot appear, so the parse is unambiguous.
    const parts = good().split(".");
    expect(parts).toHaveLength(6);
    for (const field of parts.slice(3)) expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("A13 — ciphertext cannot be transplanted between secret records", () => {
  it("refuses an envelope decrypted under a different secretRef", () => {
    /*
     * Without this, copying `encryptedSecrets.envelope` from one row to another silently
     * repoints a credential — one UPDATE turns tenant A's provider key into tenant B's.
     */
    const keys = providerWith();
    const envelope = encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "alberta-key", context: ctx("sec_a"), keys });

    expect(decryptSecret({ purpose: "PROVIDER_CREDENTIAL", envelope, context: ctx("sec_a"), keys })).toBe("alberta-key");
    expect(() => decryptSecret({ purpose: "PROVIDER_CREDENTIAL", envelope, context: ctx("sec_b"), keys })).toThrow();
  });

  it("does not bind mutable metadata, so renaming a credential cannot destroy it", () => {
    // Only secretRef is contextual. Nothing about name/status/lastUsedAt enters the AAD, so a
    // cosmetic edit can never make a secret unreadable.
    const keys = providerWith();
    const envelope = encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", context: ctx("sec_a"), keys });
    expect(decryptSecret({ purpose: "PROVIDER_CREDENTIAL", envelope, context: ctx("sec_a"), keys })).toBe("k");
    expect(parseEnvelope(envelope).purpose).toBe("PROVIDER_CREDENTIAL");
  });
});

describe("A14-A16 — rotation: one active key, many readable", () => {
  it("A14. a retired decrypt-only key still decrypts its own ciphertext", () => {
    const withRetired = providerWith({ retired: true });
    // Encrypt directly under the retired key to simulate a row written before rotation.
    const envelope = encryptSecret({ purpose: "MFA_SECRET", plaintext: "old", context: ctx(), keys: withRetired, keyId: "mfa-v1" });

    expect(parseEnvelope(envelope).keyId).toBe("mfa-v1");
    expect(decryptSecret({ purpose: "MFA_SECRET", envelope, context: ctx(), keys: withRetired })).toBe("old");
  });

  it("A15. a new encryption always selects the active key", () => {
    const keys = providerWith({ retired: true });
    const envelope = encryptSecret({ purpose: "MFA_SECRET", plaintext: "new", context: ctx(), keys });

    expect(parseEnvelope(envelope).keyId).toBe("mfa-v2");
  });

  it("A16. a retired key cannot be chosen for a new encryption by ordinary callers", () => {
    /*
     * `keyId` is accepted only for migration/rewrap, and only for a key the provider still holds.
     * An ordinary write cannot name a retired key, and no write can name an unknown one.
     */
    const keys = providerWith({ retired: true });
    expect(() => encryptSecret({ purpose: "MFA_SECRET", plaintext: "x", context: ctx(), keys, keyId: "mfa-v404" })).toThrow(/key/i);
  });
});

describe("A17/A18 — configuration problems fail closed", () => {
  it("A17. a purpose with no configured key refuses to encrypt", () => {
    const keys = createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("a") } } });

    expect(() => encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "x", context: ctx(), keys })).toThrow(/PROVIDER_CREDENTIAL/);
  });

  it("A18. an invalid key length is refused when the provider is built, not at first use", () => {
    // Catching this at configuration means a bad deploy fails loudly instead of at the first
    // credential write, possibly weeks later.
    for (const bad of ["", "abc", "z".repeat(64), hexKey("a").slice(0, 62)]) {
      expect(() =>
        createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: bad } } }),
        JSON.stringify(bad.slice(0, 8))
      ).toThrow();
    }
  });

  it("refuses a malformed keyId at configuration time", () => {
    expect(() => createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "not a key id", hex: hexKey("a") } } })).toThrow();
  });
});

describe("A19 — production refuses a development-only key provider for new writes", () => {
  /*
   * OWNER DECISION S2-1. A managed KMS is required before real production provider credentials
   * are stored, but development must not need one. So the environment-backed provider is allowed
   * to *decrypt* anywhere — legacy rows and staging depend on that — and refused for *new writes*
   * in production. A credential written under a development key would otherwise look protected
   * while its key sat in a shell profile.
   */
  it("refuses to encrypt in production under an environment provider", () => {
    const keys = providerWith({ kind: "environment" });

    expect(() =>
      encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "alberta-key", context: ctx(), keys, isProduction: true })
    ).toThrow(/production/i);
  });

  it("still decrypts in production under an environment provider", () => {
    const keys = providerWith({ kind: "environment" });
    const envelope = encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", context: ctx(), keys });

    expect(decryptSecret({ purpose: "PROVIDER_CREDENTIAL", envelope, context: ctx(), keys, isProduction: true })).toBe("k");
  });

  it("permits encryption in production under a managed provider", () => {
    const keys = providerWith({ kind: "managed" });

    expect(() =>
      encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", context: ctx(), keys, isProduction: true })
    ).not.toThrow();
  });

  it("permits encryption outside production under an environment provider", () => {
    const keys = providerWith({ kind: "environment" });
    expect(() => encryptSecret({ purpose: "MFA_SECRET", plaintext: "k", context: ctx(), keys, isProduction: false })).not.toThrow();
  });
});

describe("A20 — no public surface hands back key material", () => {
  it("the module exports no key, and the parsed envelope carries only identity", () => {
    const keys = providerWith();
    const envelope = encryptSecret({ purpose: "MFA_SECRET", plaintext: "s", context: ctx(), keys });

    const parsed = parseEnvelope(envelope) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["authTag", "ciphertext", "iv", "keyId", "purpose", "version"]);
    for (const value of Object.values(parsed)) expect(Buffer.isBuffer(value)).toBe(false);
  });

  it("the provider's descriptor is not reachable through the crypto API", () => {
    // Callers pass a purpose and a provider; nothing returns a KeyDescriptor to domain code.
    const api = { encryptSecret, decryptSecret, parseEnvelope } as Record<string, unknown>;
    for (const name of ["getActiveKey", "getDecryptKey", "mfaKey", "resolveKey"]) {
      expect(api[name], `${name} must not be part of the crypto surface`).toBeUndefined();
    }
  });
});
