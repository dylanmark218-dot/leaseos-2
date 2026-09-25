/**
 * S2-B — the store, against a real database.
 *
 * The crypto is proved in `secretCrypto.test.ts`. What this adds is what happens once a secret is
 * *persisted*: that the plaintext is genuinely absent from the row, that the reference cannot be
 * reversed into the value, that a rewrap changes the key without changing the reference, and that
 * a disabled secret stops resolving.
 *
 * B1 is the one that would be embarrassing to get wrong, so it does not trust the schema — it
 * reads every column of the stored row back as text and searches all of them for the plaintext.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  createSecret,
  describeSecret,
  disableSecret,
  newSecretRef,
  resolveSecret,
  rewrapSecret,
  secretsUsingKey,
} from "./secretStore";
import { createEnvironmentKeyProvider, parseEnvelope } from "./_core/secretCrypto";

const DB_URL = process.env.DATABASE_URL;

describe("secret store — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
});
afterAll(async () => {
  await pool?.end();
});

const hexKey = (seed: string) => seed.repeat(64).slice(0, 64);

/** Active `provider-v2`, with `provider-v1` retained decrypt-only. */
const keys = createEnvironmentKeyProvider({
  PROVIDER_CREDENTIAL: {
    active: { keyId: "provider-v2", hex: hexKey("1") },
    retired: [{ keyId: "provider-v1", hex: hexKey("2") }],
  },
  MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("3") } },
});

const rawRow = async (secretRef: string) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM encryptedSecrets WHERE secretRef = ?",
    [secretRef]
  );
  return r[0]!;
};

d("B1/B2 — the plaintext is not there, and the reference does not encode it", () => {
  const PLAINTEXT = "alberta-511-key-9f3b2c7d1e";

  it("B1. no column of the stored row contains the plaintext", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: PLAINTEXT, keys });

    const row = await rawRow(secretRef);
    const everyValue = Object.values(row).map(v => (v instanceof Date ? v.toISOString() : String(v))).join(" ");

    expect(everyValue, "the plaintext must appear in no column, not merely not in `envelope`").not.toContain(PLAINTEXT);
    // And not a fragment of it either — a truncated copy is still a disclosure.
    expect(everyValue).not.toContain(PLAINTEXT.slice(0, 12));
  });

  it("B2. the same plaintext stored twice yields different refs and different ciphertext", async () => {
    /*
     * If `secretRef` were derived from the plaintext, these would collide — and a ref would become
     * an offline oracle for guessing the value.
     */
    const a = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: PLAINTEXT, keys });
    const b = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: PLAINTEXT, keys });

    expect(a.secretRef).not.toBe(b.secretRef);
    expect((await rawRow(a.secretRef)).envelope).not.toBe((await rawRow(b.secretRef)).envelope);
  });

  it("refs are opaque and do not leak the purpose or the value", async () => {
    const { secretRef } = await createSecret({ purpose: "MFA_SECRET", plaintext: "JBSWY3DPEHPK3PXP", keys });
    expect(secretRef).toMatch(/^sec_[A-Za-z0-9_-]{32}$/);
    expect(secretRef.toLowerCase()).not.toContain("mfa");
  });
});

d("B3/B4 — the envelope carries identity, and resolution works", () => {
  it("B3. the stored envelope records purpose and key", async () => {
    const { secretRef, keyId } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys });

    const parsed = parseEnvelope((await rawRow(secretRef)).envelope);
    expect(parsed.purpose).toBe("PROVIDER_CREDENTIAL");
    expect(parsed.keyId).toBe("provider-v2");
    expect(keyId).toBe("provider-v2");
    // And the row's own keyId column agrees, so a rewrap scan can trust the index.
    expect((await rawRow(secretRef)).keyId).toBe("provider-v2");
  });

  it("B4. resolve returns the exact plaintext", async () => {
    const plaintext = "bearer-token-with-symbols-/+=.:";
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext, keys });

    expect(await resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys })).toBe(plaintext);
  });
});

d("B5-B9 — every wrong request is refused", () => {
  it("B5. the wrong purpose is refused", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys });

    await expect(resolveSecret({ purpose: "MFA_SECRET", secretRef, keys })).rejects.toThrow();
  });

  it("a wrong purpose is indistinguishable from a missing ref", async () => {
    /*
     * Deliberate: if the two answered differently, a caller could enumerate which refs exist and
     * what each is for by comparing refusals.
     */
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys });

    const wrongPurpose = await resolveSecret({ purpose: "MFA_SECRET", secretRef, keys }).catch(e => (e as Error).message);
    const missing = await resolveSecret({ purpose: "MFA_SECRET", secretRef: newSecretRef(), keys }).catch(e => (e as Error).message);

    expect(wrongPurpose).toBe(missing);
  });

  it("B6. a disabled secret is refused", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys });
    await disableSecret(secretRef);

    await expect(resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys })).rejects.toThrow(/disabled/);
    // Disabled, not deleted — the row survives for audit.
    expect(await rawRow(secretRef)).toBeTruthy();
  });

  it("B8. a malformed envelope in the row fails closed", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys });
    await pool.query("UPDATE encryptedSecrets SET envelope = ? WHERE secretRef = ?", ["garbage", secretRef]);

    await expect(resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys })).rejects.toThrow();
  });

  it("B9. an envelope referencing an unconfigured key fails closed", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys });
    const bare = createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("3") } } });

    await expect(resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys: bare })).rejects.toThrow();
  });

  it("B17. a production write under an environment key provider is refused", async () => {
    await expect(
      createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "k", keys, isProduction: true })
    ).rejects.toThrow(/production/i);
  });
});

d("B10-B13 — rewrap rotates the key and nothing else", () => {
  it("B10/B11. plaintext and secretRef survive; keyId changes", async () => {
    const plaintext = "rotate-me";
    // Written under the retired key, as a pre-rotation row would have been.
    const created = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext, keys });
    await pool.query("UPDATE encryptedSecrets SET keyId = 'provider-v1' WHERE secretRef = ?", [created.secretRef]);
    const reEncrypted = await pool.query("SELECT envelope FROM encryptedSecrets WHERE secretRef = ?", [created.secretRef]);
    void reEncrypted;

    // Re-create properly under v1 so the envelope and column agree.
    const old = await createSecretUnderKey(created.secretRef, plaintext, "provider-v1");
    void old;

    const result = await rewrapSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef: created.secretRef, keys });

    expect(result.secretRef, "a rewrap that moved the ref would force every caller to be rewritten").toBe(created.secretRef);
    expect(result.keyId).toBe("provider-v2");
    expect(await resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef: created.secretRef, keys })).toBe(plaintext);
    expect((await rawRow(created.secretRef)).rewrappedAt).not.toBeNull();
  });

  /** Replace a row's envelope with one encrypted under a named key, keeping the same ref. */
  async function createSecretUnderKey(secretRef: string, plaintext: string, keyId: string) {
    const { encryptSecret } = await import("./_core/secretCrypto");
    const envelope = encryptSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext, context: { secretRef }, keys, keyId });
    await pool.query("UPDATE encryptedSecrets SET envelope = ?, keyId = ? WHERE secretRef = ?", [envelope, keyId, secretRef]);
    return envelope;
  }

  it("B12. a row written under the retired key resolves before any rewrap", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "old-value", keys });
    await createSecretUnderKey(secretRef, "old-value", "provider-v1");

    expect((await rawRow(secretRef)).keyId).toBe("provider-v1");
    expect(await resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys })).toBe("old-value");
  });

  it("B13. after rewrap the row no longer references the retired key", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: "v", keys });
    await createSecretUnderKey(secretRef, "v", "provider-v1");

    expect(await secretsUsingKey("PROVIDER_CREDENTIAL", "provider-v1")).toContain(secretRef);

    await rewrapSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys });

    expect(
      await secretsUsingKey("PROVIDER_CREDENTIAL", "provider-v1"),
      "retiring a key is only safe when nothing references it"
    ).not.toContain(secretRef);
  });
});

d("B14-B16 — nothing on the way out carries a secret", () => {
  const PLAINTEXT = "leaky-candidate-8a7b6c";

  it("B14. the metadata description has no envelope or plaintext field", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: PLAINTEXT, keys });

    const described = (await describeSecret(secretRef))!;
    expect(Object.keys(described).sort()).toEqual([
      "createdAt", "keyId", "purpose", "rewrappedAt", "secretRef", "status",
    ]);
    expect(JSON.stringify(described)).not.toContain(PLAINTEXT);
  });

  it("B15/B16. refusal messages carry neither the plaintext nor the envelope", async () => {
    const { secretRef } = await createSecret({ purpose: "PROVIDER_CREDENTIAL", plaintext: PLAINTEXT, keys });
    const envelope = (await rawRow(secretRef)).envelope as string;

    const messages: string[] = [];
    await resolveSecret({ purpose: "MFA_SECRET", secretRef, keys }).catch(e => messages.push((e as Error).message));
    await disableSecret(secretRef);
    await resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys }).catch(e => messages.push((e as Error).message));

    const all = messages.join(" ");
    expect(messages.length).toBe(2);
    expect(all).not.toContain(PLAINTEXT);
    expect(all).not.toContain(envelope);
    expect(all).not.toContain(secretRef);
  });
});
