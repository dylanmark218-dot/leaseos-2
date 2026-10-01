/**
 * S2-D — moving a live secret class, proved against a real database.
 *
 * THE TEST THAT MATTERS MOST IS D6, and it is deliberately not a string comparison. It mints a
 * seed, encrypts it the way production did before this checkpoint, generates a TOTP code from that
 * seed with the same function the enforcement gate uses, migrates the row, and then verifies the
 * code again through `resolveMfaSeed` + `totpVerify` — the actual read path. A test that only
 * asserted `newPlaintext === oldPlaintext` would pass just as happily against a migration that
 * stored the right bytes somewhere nothing reads, and the user-visible promise of this whole
 * checkpoint is "nobody re-enrols", which only the real path can demonstrate.
 *
 * THE SECOND MOST IMPORTANT IS D11/D25: a reference that is present but broken must FAIL, not walk
 * back to the legacy column. The distinction is easy to lose in a refactor — a `try/catch` added
 * for robustness would do it — and the consequence is that damaging the new record lets an attacker
 * choose which secret MFA is checked against.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { enrollMfaSecret, mfaStorageOf, readSeedForMigration, resolveMfaSeed } from "./mfaSecretService";
import { mfaMigrationReadiness, migrateMfaSecrets } from "./mfaSecretMigration";
import { createEnvironmentKeyProvider } from "./_core/secretCrypto";
import { encryptSecret as legacyEncrypt, newTotpSecret, totpCode, totpVerify } from "./_core/externalIdentityPolicy";
import { environmentSecretKeys, legacyMfaKey, mfaKeyReadiness } from "./_core/secretKeys";
import { describeSecret, resolveSecret } from "./secretStore";

const DB_URL = process.env.DATABASE_URL;

describe("mfa migration — preconditions", () => {
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

/** The new MFA key. Distinct material from the legacy one, which is the point of the design. */
const keys = createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("a") } } });
const LEGACY = Buffer.from(hexKey("b"), "hex");
const K = { keys, legacyKey: LEGACY, isProduction: false };

const RUN = randomBytes(4).toString("hex");
let seq = 0;

/**
 * A portal identity in whatever storage state the test needs.
 *
 * `externalIdentities` has NOT NULL columns with no defaults, so this inserts the minimum real row
 * rather than mocking — the point of a DB test is that the column really exists and really holds
 * what we think.
 */
async function identity(state: { legacySeed?: string; newSeed?: string; mfaEnabled?: boolean } = {}) {
  const ref = `id-${RUN}-${++seq}`;
  const enc = state.legacySeed ? legacyEncrypt(state.legacySeed, LEGACY) : null;

  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO externalIdentities
       (identityRef, kind, displayName, email, tokenHash, mfaEnabled, mfaSecretEnc, status, invitedByUserId, invitedAt)
     VALUES (?, 'customer', ?, ?, ?, ?, ?, 'active', 1, NOW())`,
    [ref, `Test ${ref}`, `${ref}@example.test`, randomBytes(32).toString("hex"), state.mfaEnabled ? 1 : 0, enc]
  );
  const id = res.insertId;

  if (state.newSeed) await enrollWithSeed(id, state.newSeed);
  return id;
}

/** Put a specific seed into the new store for an identity, so a test can control the value. */
async function enrollWithSeed(identityId: number, seed: string) {
  const { createSecret } = await import("./secretStore");
  const { secretRef } = await createSecret({ purpose: "MFA_SECRET", plaintext: seed, keys });
  await pool.execute("UPDATE externalIdentities SET mfaSecretRef = ? WHERE id = ?", [secretRef, identityId]);
  return secretRef;
}

const columns = async (id: number) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT mfaSecretEnc, mfaSecretRef, mfaEnabled FROM externalIdentities WHERE id = ?",
    [id]
  );
  return r[0]! as { mfaSecretEnc: string | null; mfaSecretRef: string | null; mfaEnabled: number };
};

d("D1-D4 — legacy still works, and new enrolment uses the new store", () => {
  it("D1. a legacy-encrypted seed verifies before any migration", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });

    const row = await columns(id);
    expect(mfaStorageOf(row)).toBe("legacy");
    expect(await resolveMfaSeed(row, K)).toBe(seed);
    // Through the real verifier, not a string compare.
    expect(totpVerify(await resolveMfaSeed(row, K), totpCode(seed, new Date()), new Date())).toBe(true);
  });

  it("D2/D3. enrolment writes a reference and no legacy ciphertext", async () => {
    const id = await identity();

    const { secret } = await enrollMfaSecret(id, K);

    const row = await columns(id);
    expect(row.mfaSecretRef, "D2").toBeTruthy();
    expect(row.mfaSecretEnc, "D3 — a new write must never produce legacy format").toBeNull();
    expect(mfaStorageOf(row)).toBe("new");
    expect(await resolveMfaSeed(row, K)).toBe(secret);
  });

  it("D3b. re-enrolling clears legacy ciphertext rather than leaving it behind", async () => {
    /*
     * This codebase has no "disable MFA" procedure — re-enrolling is the only way to replace a
     * secret, and it used to overwrite `mfaSecretEnc` in place. If the new write left the old
     * ciphertext, the read path's "ref absent → legacy" rule would resurrect the replaced seed the
     * moment the ref were cleared. So the superseded seed must be gone from the row entirely.
     */
    const oldSeed = newTotpSecret();
    const id = await identity({ legacySeed: oldSeed, mfaEnabled: true });

    const { secret: newSeed } = await enrollMfaSecret(id, K);
    expect(newSeed).not.toBe(oldSeed);

    const row = await columns(id);
    expect(row.mfaSecretEnc, "the replaced seed must not remain as a reactivation path").toBeNull();
    expect(await resolveMfaSeed(row, K)).toBe(newSeed);
    // The old code no longer verifies; the new one does.
    expect(totpVerify(await resolveMfaSeed(row, K), totpCode(oldSeed, new Date()), new Date())).toBe(false);
    expect(totpVerify(await resolveMfaSeed(row, K), totpCode(newSeed, new Date()), new Date())).toBe(true);
  });

  it("D4. the stored secret carries purpose MFA_SECRET", async () => {
    const id = await identity();
    await enrollMfaSecret(id, K);

    const ref = (await columns(id)).mfaSecretRef!;
    const described = (await describeSecret(ref))!;
    expect(described.purpose).toBe("MFA_SECRET");
    expect(described.keyId).toBe("mfa-v1");
  });

  it("enrolment disables enforcement until the code is confirmed", async () => {
    const id = await identity({ legacySeed: newTotpSecret(), mfaEnabled: true });
    await enrollMfaSecret(id, K);
    expect((await columns(id)).mfaEnabled).toBe(0);
  });
});

d("D5/D6 — the seed survives, and the user's existing code still works", () => {
  it("D5. the migrated seed is byte-identical to the legacy one", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });

    await migrateMfaSecrets({ ...K, batchSize: 50 });

    const ref = (await columns(id)).mfaSecretRef!;
    expect(await resolveSecret({ purpose: "MFA_SECRET", secretRef: ref, keys })).toBe(seed);
  });

  it("D6. a TOTP code from the original seed still verifies through the real read path", async () => {
    /*
     * The promise of this checkpoint, stated as a test: a phone that was generating valid codes
     * before the migration is still generating valid codes after it, with no re-enrolment.
     */
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });
    const at = new Date("2026-09-25T12:00:00Z");
    const code = totpCode(seed, at);

    expect(totpVerify(await resolveMfaSeed(await columns(id), K), code, at), "before migration").toBe(true);

    await migrateMfaSecrets({ ...K, batchSize: 50 });

    const after = await columns(id);
    expect(mfaStorageOf(after)).toBe("migrated");
    expect(
      totpVerify(await resolveMfaSeed(after, K), code, at),
      "the same code must still verify, or every portal user has to re-enrol"
    ).toBe(true);
  });

  it("the migration does not mint a new seed", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });

    await migrateMfaSecrets({ ...K, batchSize: 50 });

    const ref = (await columns(id)).mfaSecretRef!;
    const stored = await resolveSecret({ purpose: "MFA_SECRET", secretRef: ref, keys });
    expect(stored, "a regenerated seed would lock every user out while passing a naive test").toBe(seed);
    expect(stored).not.toBe(newTotpSecret());
  });
});

d("D7/D8 — idempotent and resumable", () => {
  it("D7. running the migration twice migrates nothing the second time", async () => {
    const id = await identity({ legacySeed: newTotpSecret(), mfaEnabled: true });

    const first = await migrateMfaSecrets({ ...K, batchSize: 50 });
    const refAfterFirst = (await columns(id)).mfaSecretRef;
    const second = await migrateMfaSecrets({ ...K, batchSize: 50 });

    expect(first.migrated).toBeGreaterThan(0);
    expect(second.scanned, "a migrated row no longer matches the batch predicate").toBe(0);
    expect(second.migrated).toBe(0);
    expect((await columns(id)).mfaSecretRef, "D23 — no duplicate secret, same ref").toBe(refAfterFirst);
  });

  it("D8. a bounded run leaves the rest for the next one", async () => {
    const seeds = [newTotpSecret(), newTotpSecret(), newTotpSecret()];
    const ids = [];
    for (const s of seeds) ids.push(await identity({ legacySeed: s, mfaEnabled: true }));

    // One batch of one row, one batch only — the shape of an interrupted run.
    const partial = await migrateMfaSecrets({ ...K, batchSize: 1, maxBatches: 1 });
    expect(partial.migrated).toBe(1);
    expect(partial.complete).toBe(false);

    const rest = await migrateMfaSecrets({ ...K, batchSize: 50 });
    expect(rest.complete).toBe(true);

    for (let i = 0; i < ids.length; i += 1) {
      const ref = (await columns(ids[i]!)).mfaSecretRef!;
      expect(await resolveSecret({ purpose: "MFA_SECRET", secretRef: ref, keys })).toBe(seeds[i]);
    }
  });

  it("D23. an already-migrated identity is not given a second secret", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed });
    await migrateMfaSecrets({ ...K, batchSize: 50 });
    const ref = (await columns(id)).mfaSecretRef!;

    await migrateMfaSecrets({ ...K, batchSize: 50 });

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM encryptedSecrets WHERE purpose = 'MFA_SECRET' AND sourceColumn = 'mfaSecretEnc' AND secretRef = ?",
      [ref]
    );
    expect(rows[0]!.n).toBe(1);
    expect((await columns(id)).mfaSecretRef).toBe(ref);
  });
});

d("D9/D10/D24 — the migration fails closed and destroys nothing", () => {
  it("D9. a missing legacy key refuses to start the run", async () => {
    await expect(migrateMfaSecrets({ keys, legacyKey: null })).rejects.toThrow(/LEASEOS_PORTAL_MFA_KEY is not configured/);
  });

  it("D10. a missing new MFA key refuses to start the run", async () => {
    const noMfa = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("c") } } });
    await expect(migrateMfaSecrets({ keys: noMfa, legacyKey: LEGACY })).rejects.toThrow(/no active MFA_SECRET key/);
  });

  it("D9b. a refused run leaves every legacy row untouched and still usable", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });
    const before = await columns(id);

    await migrateMfaSecrets({ keys, legacyKey: null }).catch(() => undefined);

    const after = await columns(id);
    expect(after.mfaSecretEnc, "a missing key must never null anyone's MFA").toBe(before.mfaSecretEnc);
    expect(after.mfaSecretRef).toBeNull();
    expect(await resolveMfaSeed(after, K)).toBe(seed);
  });

  it("D24. a row whose new-store write fails keeps working on legacy", async () => {
    /*
     * Simulated by corrupting the legacy ciphertext so decryption fails: the row cannot be migrated,
     * and what matters is that the failure is reported rather than papered over, and that nothing
     * about the row is modified on the way out.
     */
    const good = newTotpSecret();
    const goodId = await identity({ legacySeed: good });
    const badId = await identity({ legacySeed: newTotpSecret() });
    await pool.execute("UPDATE externalIdentities SET mfaSecretEnc = ? WHERE id = ?", ["not.valid.ciphertext", badId]);

    const result = await migrateMfaSecrets({ ...K, batchSize: 50 });

    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.some(f => f.identityId === badId)).toBe(true);
    expect(result.complete, "a run with failures is never reported complete").toBe(false);

    const bad = await columns(badId);
    expect(bad.mfaSecretEnc, "the unmigratable row is left exactly as it was").toBe("not.valid.ciphertext");
    expect(bad.mfaSecretRef).toBeNull();
    // And the healthy row in the same batch still migrated.
    expect((await columns(goodId)).mfaSecretRef).toBeTruthy();

    /*
     * Cleaned up deliberately. This row can never migrate, and `mfaMigrationReadiness` counts the
     * whole table — leaving it behind would make the readiness assertions fail for a reason that
     * has nothing to do with readiness. Scaffolding this test created, this test removes.
     */
    await pool.execute("DELETE FROM externalIdentities WHERE id = ?", [badId]);
  });

  it("D22. the report carries counts and identity ids, never secret values", async () => {
    const seed = newTotpSecret();
    await identity({ legacySeed: seed });

    const result = await migrateMfaSecrets({ ...K, batchSize: 50 });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(seed);
    expect(serialized).not.toContain(legacyEncrypt(seed, LEGACY).slice(0, 20));
    expect(serialized).not.toContain("sec_");
    expect(typeof result.migrated).toBe("number");
  });
});

d("D11/D12/D25 — a broken reference fails closed and never falls back", () => {
  it("D12. an absent reference permits the legacy read", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed });
    expect(await resolveMfaSeed(await columns(id), K)).toBe(seed);
  });

  it("D11/D25. a present-but-broken reference fails rather than using the legacy seed", async () => {
    /*
     * The row carries BOTH: a legacy seed that would decrypt perfectly, and a reference that cannot
     * be resolved. If resolution fell back, the assertion below would return `legacySeed` — so this
     * test can tell the difference between "fails closed" and "quietly worked".
     */
    const legacySeed = newTotpSecret();
    const id = await identity({ legacySeed });
    await pool.execute("UPDATE externalIdentities SET mfaSecretRef = ? WHERE id = ?", ["sec_does_not_exist_000000000000", id]);

    const row = await columns(id);
    expect(mfaStorageOf(row)).toBe("migrated");

    const outcome = await resolveMfaSeed(row, K).then(v => `resolved:${v}`, e => `refused:${(e as Error).message}`);
    expect(outcome, "a broken reference must not hand verification back to the superseded seed").not.toBe(`resolved:${legacySeed}`);
    expect(outcome.startsWith("refused:")).toBe(true);
  });

  it("a disabled secret behind a live reference also fails closed", async () => {
    const legacySeed = newTotpSecret();
    const id = await identity({ legacySeed });
    const ref = await enrollWithSeed(id, newTotpSecret());
    const { disableSecret } = await import("./secretStore");
    await disableSecret(ref);

    const row = await columns(id);
    await expect(resolveMfaSeed(row, K)).rejects.toThrow();
  });

  it("D13. a reference to another purpose's secret is refused", async () => {
    const { createSecret } = await import("./secretStore");
    const webhookKeys = createEnvironmentKeyProvider({
      MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("a") } },
      WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("c") } },
    });
    const { secretRef } = await createSecret({ purpose: "WEBHOOK_SECRET", plaintext: "not-an-mfa-seed", keys: webhookKeys });

    const id = await identity({ legacySeed: newTotpSecret() });
    await pool.execute("UPDATE externalIdentities SET mfaSecretRef = ? WHERE id = ?", [secretRef, id]);

    await expect(
      resolveMfaSeed(await columns(id), { keys: webhookKeys, legacyKey: LEGACY })
    ).rejects.toThrow(/no such secret/);
  });

  it("an identity with neither format is refused, not defaulted", async () => {
    const id = await identity();
    await expect(resolveMfaSeed(await columns(id), K)).rejects.toThrow(/no enrolled secret/);
  });

  it("a legacy row with no legacy key configured is refused", async () => {
    const id = await identity({ legacySeed: newTotpSecret() });
    await expect(resolveMfaSeed(await columns(id), { keys, legacyKey: null })).rejects.toThrow(/legacy key is not configured/);
  });
});

d("D14-D17 — replacing a secret, in every storage state", () => {
  /*
   * NOTE ON D14-D17. The owner's plan names these "MFA disable". This codebase has no disable or
   * reset procedure: `mfaEnroll` is the only way to change an enrolled secret, and it sets
   * `mfaEnabled = false` until a new code is confirmed. So these test the real replacement path in
   * each of the three storage states, and the absence of a true disable capability is reported
   * rather than invented here — adding one would broaden who can turn MFA off, which is out of
   * scope for S2-D.
   */
  it("D14. replacing a legacy-only secret leaves nothing legacy behind", async () => {
    const oldSeed = newTotpSecret();
    const id = await identity({ legacySeed: oldSeed, mfaEnabled: true });

    await enrollMfaSecret(id, K);

    const row = await columns(id);
    expect(mfaStorageOf(row)).toBe("new");
    expect(row.mfaSecretEnc).toBeNull();
    expect(row.mfaEnabled).toBe(0);
    expect(totpVerify(await resolveMfaSeed(row, K), totpCode(oldSeed, new Date()), new Date())).toBe(false);
  });

  it("D15. replacing a new-only secret retires the previous one", async () => {
    const id = await identity();
    await enrollMfaSecret(id, K);
    const firstRef = (await columns(id)).mfaSecretRef!;

    await enrollMfaSecret(id, K);

    const secondRef = (await columns(id)).mfaSecretRef!;
    expect(secondRef).not.toBe(firstRef);
    expect((await describeSecret(firstRef))!.status, "the superseded secret must stop resolving").toBe("disabled");
  });

  it("D16. replacing a migrated secret clears both representations", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });
    await migrateMfaSecrets({ ...K, batchSize: 50 });
    const migratedRef = (await columns(id)).mfaSecretRef!;
    expect(mfaStorageOf(await columns(id))).toBe("migrated");

    await enrollMfaSecret(id, K);

    const row = await columns(id);
    expect(row.mfaSecretEnc, "the legacy copy must not survive a replacement").toBeNull();
    expect(row.mfaSecretRef).not.toBe(migratedRef);
    expect((await describeSecret(migratedRef))!.status).toBe("disabled");
    expect(totpVerify(await resolveMfaSeed(row, K), totpCode(seed, new Date()), new Date())).toBe(false);
  });

  it("D17. a replacement produces only new-format storage", async () => {
    for (const state of [{}, { legacySeed: newTotpSecret() }, { newSeed: newTotpSecret() }]) {
      const id = await identity(state);
      await enrollMfaSecret(id, K);
      expect(mfaStorageOf(await columns(id))).toBe("new");
    }
  });
});

d("D18/D19 — session assurance is untouched", () => {
  it("D18/D19. migrating does not enable MFA or alter enforcement state", async () => {
    /*
     * S1 derives `authAssurance`/`mfaCompletedAt` from a successful MFA verification. The migration
     * is a storage change and must be invisible to that: an identity that had not completed MFA
     * must not become MFA-authenticated because its seed moved.
     */
    const enabled = await identity({ legacySeed: newTotpSecret(), mfaEnabled: true });
    const notEnabled = await identity({ legacySeed: newTotpSecret(), mfaEnabled: false });

    await migrateMfaSecrets({ ...K, batchSize: 50 });

    expect((await columns(enabled)).mfaEnabled, "unchanged, not re-derived").toBe(1);
    expect((await columns(notEnabled)).mfaEnabled, "migration must never enable MFA").toBe(0);
  });

  it("the migration writes no column other than mfaSecretRef", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed, mfaEnabled: true });
    const [beforeRows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM externalIdentities WHERE id = ?", [id]);
    const before = beforeRows[0]!;

    await migrateMfaSecrets({ ...K, batchSize: 50 });

    const [afterRows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM externalIdentities WHERE id = ?", [id]);
    const after = afterRows[0]!;

    const changed = Object.keys(before).filter(k => String(before[k]) !== String(after[k]));
    expect(changed, "a storage migration that touched anything else would be doing something else").toEqual(["mfaSecretRef"]);
  });
});

d("D20/D21 — nothing on the way out carries a seed", () => {
  it("D20. the identity row exposes no seed, and the reference is opaque", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed });
    await migrateMfaSecrets({ ...K, batchSize: 50 });

    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM externalIdentities WHERE id = ?", [id]);
    const everyValue = Object.values(rows[0]!).map(v => (v instanceof Date ? v.toISOString() : String(v))).join(" ");

    expect(everyValue, "a profile query must never surface the seed").not.toContain(seed);
    expect(everyValue).not.toContain("v1.MFA_SECRET");
  });

  it("D21. refusal messages carry neither the seed nor the envelope", async () => {
    const seed = newTotpSecret();
    const id = await identity({ legacySeed: seed });
    const enc = (await columns(id)).mfaSecretEnc!;
    await pool.execute("UPDATE externalIdentities SET mfaSecretRef = ? WHERE id = ?", ["sec_missing_0000000000000000", id]);

    const messages: string[] = [];
    await resolveMfaSeed(await columns(id), K).catch(e => messages.push((e as Error).message));
    await readSeedForMigration(await columns(id), LEGACY).catch(e => messages.push((e as Error).message));

    const all = messages.join(" ");
    expect(messages.length).toBe(2);
    expect(all).not.toContain(seed);
    expect(all).not.toContain(enc);
  });
});

d("readiness — what an operator needs before retiring the legacy key", () => {
  it("counts every storage state and refuses retirement while any legacy-only row remains", async () => {
    await identity({ legacySeed: newTotpSecret() });

    const before = await mfaMigrationReadiness();
    expect(before.legacyOnly).toBeGreaterThan(0);
    expect(before.legacyKeyRetirable, "one unmigrated identity is enough to need the key").toBe(false);
    expect(before.total).toBe(before.legacyOnly + before.migratedBoth + before.newOnly + before.none);

    await migrateMfaSecrets({ ...K, batchSize: 500 });

    const after = await mfaMigrationReadiness();
    expect(after.legacyOnly).toBe(0);
    expect(after.legacyKeyRetirable).toBe(true);
    expect(JSON.stringify(after)).not.toContain("sec_");
  });

  it("key readiness reports variable names, never values", () => {
    const withBoth = mfaKeyReadiness({ LEASEOS_KEY_MFA_V1: hexKey("a"), LEASEOS_PORTAL_MFA_KEY: hexKey("b") } as NodeJS.ProcessEnv);
    expect(withBoth.canMigrate).toBe(true);
    expect(withBoth.missing).toEqual([]);

    const withNeither = mfaKeyReadiness({} as NodeJS.ProcessEnv);
    expect(withNeither.canMigrate).toBe(false);
    expect(withNeither.missing).toEqual(["LEASEOS_KEY_MFA_V1", "LEASEOS_PORTAL_MFA_KEY"]);
    expect(JSON.stringify(withNeither)).not.toContain(hexKey("a"));
  });

  it("the environment provider configures only purposes whose key is present and well formed", () => {
    const partial = environmentSecretKeys({ LEASEOS_KEY_MFA_V1: hexKey("a"), LEASEOS_KEY_WEBHOOK_V1: "too-short" } as NodeJS.ProcessEnv);
    expect(partial.getActiveKey("MFA_SECRET")?.keyId).toBe("mfa-v1");
    expect(partial.getActiveKey("WEBHOOK_SECRET"), "a malformed key is not configured, not a default").toBeNull();
    expect(partial.kind).toBe("environment");
  });

  it("the legacy key accessor rejects a malformed value rather than truncating it", () => {
    expect(legacyMfaKey({ LEASEOS_PORTAL_MFA_KEY: hexKey("b") } as NodeJS.ProcessEnv)).not.toBeNull();
    expect(legacyMfaKey({ LEASEOS_PORTAL_MFA_KEY: "abc" } as NodeJS.ProcessEnv)).toBeNull();
    expect(legacyMfaKey({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
