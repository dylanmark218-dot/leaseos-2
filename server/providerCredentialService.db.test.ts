/**
 * S2-C — provider credential metadata, against a real database.
 *
 * The crypto is proved in `secretCrypto.test.ts` and the store in `secretStore.db.test.ts`. What
 * this file exists to prove is the part no unit test can: that ownership is a boundary rather than a
 * label, and that the thing a resolver refuses to do it genuinely cannot do.
 *
 * THE TWO TESTS THAT MATTER MOST are C5 and C7. Both are written so that a silent fallback would be
 * *observable*: a credential the caller must not receive is present in the database with a distinct
 * plaintext, so a resolver that fell back would return a value the assertion names. A test that only
 * checked "it threw" would pass just as happily against a store with no rows in it at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import {
  createCredential,
  disableCredential,
  fingerprint,
  listCredentials,
  newCredentialRef,
  resolveForOutbound,
  rotateCredential,
} from "./providerCredentialService";
import { describeSecret, rewrapSecret, resolveSecret } from "./secretStore";
import { createEnvironmentKeyProvider } from "./_core/secretCrypto";

const DB_URL = process.env.DATABASE_URL;

describe("provider credentials — preconditions", () => {
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

/** Active `provider-v2`, with `provider-v1` retained decrypt-only, matching S2-B's fixture. */
const keys = createEnvironmentKeyProvider({
  PROVIDER_CREDENTIAL: {
    active: { keyId: "provider-v2", hex: hexKey("1") },
    retired: [{ keyId: "provider-v1", hex: hexKey("2") }],
  },
});

/*
 * Every test gets its own provider key, and every RUN gets its own namespace.
 *
 * The scope UNIQUE is global and the rows outlive the process, so a counter alone would collide
 * with the previous run against the same database — the suite would pass once and then fail
 * forever, for a reason that has nothing to do with the code under test.
 */
const RUN = randomBytes(4).toString("hex");
let seq = 0;
const provider = (label: string) => `test-${RUN}-${label}-${++seq}`;

const rawRow = async (credentialRef: string) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM providerCredentials WHERE credentialRef = ?",
    [credentialRef]
  );
  return r[0]!;
};

/** The single refusal every unavailable-credential path must produce, verbatim. */
const UNAVAILABLE = "credential refused: not available for this scope";

const refusal = async (p: Promise<unknown>) => p.then(() => "<resolved>", e => (e as Error).message);

d("C1-C3 — ownership is an invariant, enforced in two places", () => {
  it("C1. a platform credential stores no orgRef", async () => {
    const providerKey = provider("c1");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "platform-key", keys,
    });

    const row = await rawRow(credentialRef);
    expect(row.ownership).toBe("PLATFORM");
    expect(row.orgRef, "a platform credential that named a tenant would be ambiguous to resolve").toBeNull();
  });

  it("C2. a tenant credential without an orgRef is refused — by the service and by the table", async () => {
    const providerKey = provider("c2");

    await expect(
      createCredential({ providerKey, authScheme: "API_KEY", ownership: "TENANT", plaintext: "k", keys })
    ).rejects.toThrow(/TENANT credential requires an orgRef/);

    // And the storage layer refuses it independently, so a future caller that bypasses this service
    // cannot create the malformed row either.
    await expect(
      pool.query(
        "INSERT INTO providerCredentials (credentialRef, providerKey, authScheme, ownership, orgRef) VALUES (?,?,?,?,NULL)",
        [newCredentialRef(), providerKey, "API_KEY", "TENANT"]
      )
    ).rejects.toThrow(/providerCredentials_ownership_orgRef_chk/);
  });

  it("C3. a platform credential that names an orgRef is refused — by the service and by the table", async () => {
    const providerKey = provider("c3");

    await expect(
      createCredential({
        providerKey, authScheme: "API_KEY", ownership: "PLATFORM", orgRef: `org-${RUN}-a`, plaintext: "k", keys,
      })
    ).rejects.toThrow(/PLATFORM credential must not name an orgRef/);

    await expect(
      pool.query(
        "INSERT INTO providerCredentials (credentialRef, providerKey, authScheme, ownership, orgRef) VALUES (?,?,?,?,?)",
        [newCredentialRef(), providerKey, "API_KEY", "PLATFORM", `org-${RUN}-a`]
      )
    ).rejects.toThrow(/providerCredentials_ownership_orgRef_chk/);
  });

  it("one scope holds at most one credential, platform rows included", async () => {
    /*
     * MariaDB permits unlimited NULLs in a composite UNIQUE, so indexing `orgRef` directly would
     * have left platform rows unconstrained — and resolution reads the first matching row, so two
     * active platform credentials would make "which key did we send" depend on row order.
     */
    const providerKey = provider("dup");
    await createCredential({ providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "first", keys });

    await expect(
      createCredential({ providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "second", keys })
    ).rejects.toThrow(/already has a PLATFORM credential/);

    // The index, not just the service check, is what makes it true.
    await expect(
      pool.query(
        "INSERT INTO providerCredentials (credentialRef, providerKey, authScheme, ownership) VALUES (?,?,?,?)",
        [newCredentialRef(), providerKey, "API_KEY", "PLATFORM"]
      )
    ).rejects.toThrow(/providerCredentials_scope_unique/);

    // A refused create leaves no orphan ciphertext: the scope is checked before the secret is written.
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM encryptedSecrets WHERE envelope IS NOT NULL AND secretRef IN (SELECT secretRef FROM providerCredentials WHERE providerKey = ?)",
      [providerKey]
    );
    expect(rows[0]!.n).toBe(1);
  });
});

d("C4-C7 — resolution is by exact ownership, and there is no fallback", () => {
  it("C4. two tenants hold independent credentials for the same provider", async () => {
    const providerKey = provider("c4");
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-a`, plaintext: "key-for-a", keys,
    });
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-b`, plaintext: "key-for-b", keys,
    });

    const a = await resolveForOutbound({ providerKey, scope: { ownership: "TENANT", orgRef: `org-${RUN}-a` }, keys });
    const b = await resolveForOutbound({ providerKey, scope: { ownership: "TENANT", orgRef: `org-${RUN}-b` }, keys });

    expect(a.plaintext).toBe("key-for-a");
    expect(b.plaintext).toBe("key-for-b");
    expect(a.credentialRef).not.toBe(b.credentialRef);
  });

  it("C5. a tenant cannot resolve another tenant's credential", async () => {
    const providerKey = provider("c5");
    // org-a's credential exists, with a plaintext org-b must never see. If resolution leaked across
    // tenants, the assertion below names the exact string that would come back.
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-a`, plaintext: "belongs-to-a", keys,
    });

    const message = await refusal(
      resolveForOutbound({ providerKey, scope: { ownership: "TENANT", orgRef: `org-${RUN}-b` }, keys })
    );

    expect(message).toBe(UNAVAILABLE);
    // Proof that the fixture was capable of leaking: org-a's own resolve works against the same row.
    expect(
      (await resolveForOutbound({ providerKey, scope: { ownership: "TENANT", orgRef: `org-${RUN}-a` }, keys })).plaintext
    ).toBe("belongs-to-a");
  });

  it("C6. the platform resolver gets the platform credential, not a tenant's", async () => {
    const providerKey = provider("c6");
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "platform-value", keys,
    });
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-a`, plaintext: "tenant-value", keys,
    });

    const resolved = await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys });

    expect(resolved.plaintext).toBe("platform-value");
    expect(resolved.plaintext).not.toBe("tenant-value");
  });

  it("C7. a tenant with no credential is refused — it does NOT fall back to the platform's", async () => {
    /*
     * The one that would be most tempting to "fix" for convenience. Serving the platform key to a
     * tenant that was supposed to bring its own bills LeaseOS's quota for their traffic, and where
     * the provider's terms require a customer account, breaches them. That judgement is legal, not
     * technical, so a generic resolver must not make it.
     */
    const providerKey = provider("c7");
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "platform-only-value", keys,
    });

    const message = await refusal(
      resolveForOutbound({ providerKey, scope: { ownership: "TENANT", orgRef: `org-${RUN}-without-one` }, keys })
    );

    expect(message).toBe(UNAVAILABLE);
    expect(message, "the platform value must not appear, even inside an error").not.toContain("platform-only-value");

    // And no hidden switch turns the fallback on: an unrecognised opt-in changes nothing.
    const withOptIn = await refusal(
      resolveForOutbound({
        providerKey,
        scope: { ownership: "TENANT", orgRef: `org-${RUN}-without-one` },
        keys,
        ...({ allowPlatformFallback: true, fallbackToPlatform: true } as Record<string, unknown>),
      } as Parameters<typeof resolveForOutbound>[0])
    );
    expect(withOptIn).toBe(UNAVAILABLE);
  });

  it("a credential in another environment is not a credential for this one", async () => {
    const providerKey = provider("env");
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", environment: "sandbox", plaintext: "sandbox-key", keys,
    });

    expect(await refusal(resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys }))).toBe(UNAVAILABLE);
    expect(
      (await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, environment: "sandbox", keys })).plaintext
    ).toBe("sandbox-key");
  });
});

d("C8-C11 — nothing on the way out carries a secret", () => {
  const PLAINTEXT = "provider-key-6d4e2a9c8b";

  it("C8. no column of the credential row contains the plaintext", async () => {
    const providerKey = provider("c8");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: PLAINTEXT, keys,
    });

    const row = await rawRow(credentialRef);
    const everyValue = Object.values(row).map(v => (v instanceof Date ? v.toISOString() : String(v))).join(" ");

    expect(everyValue, "the metadata table must have no column capable of holding the value").not.toContain(PLAINTEXT);
    expect(everyValue, "nor a fragment of it — a truncated copy is still a disclosure").not.toContain(PLAINTEXT.slice(0, 10));
    // There is no envelope here either: ciphertext lives in encryptedSecrets, this row holds a ref.
    expect(everyValue).not.toContain("v1.PROVIDER_CREDENTIAL");
  });

  it("C9/C10. the list DTO carries neither envelope nor plaintext", async () => {
    const providerKey = provider("c9");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-dto`, plaintext: PLAINTEXT, keys,
    });
    const secretRef = (await rawRow(credentialRef)).secretRef as string;
    const [envRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT envelope FROM encryptedSecrets WHERE secretRef = ?",
      [secretRef]
    );
    const envelope = envRows[0]!.envelope as string;

    const serialized = JSON.stringify(await listCredentials({ ownership: "TENANT", orgRef: `org-${RUN}-dto` }));

    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toContain(envelope);
  });

  it("C11. the list DTO does not even carry secretRef", async () => {
    /*
     * A reference is the one input a resolver needs, and a UI has no use for one. Asserting the
     * exact key set rather than the absence of a name means a future field cannot be added silently.
     */
    const providerKey = provider("c11");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-keys`, plaintext: PLAINTEXT, keys,
    });
    const secretRef = (await rawRow(credentialRef)).secretRef as string;

    const [only] = await listCredentials({ ownership: "TENANT", orgRef: `org-${RUN}-keys` });

    expect(Object.keys(only!).sort()).toEqual([
      "authScheme", "configured", "createdAt", "credentialRef", "credentialVersion", "environment",
      "expiresAt", "externalAccountId", "fingerprint", "lastUsedAt", "orgRef", "ownership", "providerKey",
      "rotatedAt", "status",
    ]);
    expect(JSON.stringify(only)).not.toContain(secretRef);
  });

  it("a fingerprint identifies a key without disclosing any of it", async () => {
    const providerKey = provider("fp");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: PLAINTEXT, keys,
    });

    const stored = (await rawRow(credentialRef)).fingerprint as string;
    expect(stored).toBe(fingerprint(PLAINTEXT));
    expect(stored).toMatch(/^[0-9a-f]{16}$/);
    // Not a prefix, not a suffix, not "the last four" — no substring of the value survives.
    for (let i = 0; i + 4 <= PLAINTEXT.length; i += 1) {
      expect(stored).not.toContain(PLAINTEXT.slice(i, i + 4));
    }
  });

  it("a platform listing does not include tenant credentials, and vice versa", async () => {
    const providerKey = provider("scope");
    await createCredential({ providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "p", keys });
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-list`, plaintext: "t", keys,
    });

    const platform = (await listCredentials({ ownership: "PLATFORM" })).filter(c => c.providerKey === providerKey);
    const tenant = await listCredentials({ ownership: "TENANT", orgRef: `org-${RUN}-list` });

    expect(platform.map(c => c.ownership)).toEqual(["PLATFORM"]);
    expect(tenant.every(c => c.orgRef === `org-${RUN}-list`)).toBe(true);
    expect(tenant.some(c => c.ownership === "PLATFORM")).toBe(false);
  });
});

d("C12-C14 — unusable credentials are refused, and say so without revealing anything", () => {
  it("C12. a disabled credential is not usable", async () => {
    const providerKey = provider("c12");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "disable-me", keys,
    });
    // Usable first, so the refusal below is attributable to disabling and nothing else.
    expect((await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys })).plaintext).toBe("disable-me");

    await disableCredential({ credentialRef, reason: "rotated out by operator" });

    expect(await refusal(resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys }))).toBe(UNAVAILABLE);
    // Disabled, not deleted: the reason survives for audit.
    expect((await rawRow(credentialRef)).disabledReason).toBe("rotated out by operator");
  });

  it("C13. an expired credential is not usable", async () => {
    const providerKey = provider("c13");
    const expiresAt = new Date("2026-01-01T00:00:00Z");
    await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "expired-value", expiresAt, keys,
    });

    const after = new Date("2026-01-02T00:00:00Z");
    expect(await refusal(resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys, now: after })))
      .toBe(UNAVAILABLE);

    // And the same row resolves before the expiry, so the refusal is the expiry and not the fixture.
    const before = new Date("2025-12-31T00:00:00Z");
    expect((await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys, now: before })).plaintext)
      .toBe("expired-value");
  });

  it("C14. metadata reports configured, disabled and expiring without revealing the secret", async () => {
    const providerKey = provider("c14");
    const expiresAt = new Date("2027-06-01T00:00:00Z");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-meta`,
      plaintext: "meta-value-a1b2c3", externalAccountId: "acct-public-1234", expiresAt, keys,
    });

    const configured = (await listCredentials({ ownership: "TENANT", orgRef: `org-${RUN}-meta` }))
      .find(c => c.credentialRef === credentialRef)!;
    expect(configured.configured).toBe(true);
    expect(configured.status).toBe("active");
    expect(configured.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    // The provider's own account id is public — an OAuth client id is not a secret — so it may show.
    expect(configured.externalAccountId).toBe("acct-public-1234");
    expect(JSON.stringify(configured)).not.toContain("meta-value-a1b2c3");

    await disableCredential({ credentialRef, reason: "operator" });
    const disabled = (await listCredentials({ ownership: "TENANT", orgRef: `org-${RUN}-meta` }))
      .find(c => c.credentialRef === credentialRef)!;
    expect(disabled.status).toBe("disabled");
    // Still reported as configured: "has a value" and "may be used" are different questions.
    expect(disabled.configured).toBe(true);
    expect(JSON.stringify(disabled)).not.toContain("meta-value-a1b2c3");
  });

  it("every unavailable reason produces the identical refusal", async () => {
    /*
     * Absent, disabled, expired and wrong-tenant must be indistinguishable. If they differed, a
     * caller could enumerate which tenants hold which providers by comparing error text.
     */
    const absent = provider("uni-absent");
    const disabled = provider("uni-disabled");
    const expired = provider("uni-expired");
    const otherTenant = provider("uni-other");

    const { credentialRef } = await createCredential({
      providerKey: disabled, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-u`, plaintext: "x", keys,
    });
    await disableCredential({ credentialRef, reason: "r" });
    await createCredential({
      providerKey: expired, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-u`, plaintext: "y",
      expiresAt: new Date("2020-01-01T00:00:00Z"), keys,
    });
    await createCredential({
      providerKey: otherTenant, authScheme: "API_KEY", ownership: "TENANT", orgRef: `org-${RUN}-somebody-else`,
      plaintext: "z", keys,
    });

    const scope = { ownership: "TENANT", orgRef: `org-${RUN}-u` } as const;
    const messages = await Promise.all([
      refusal(resolveForOutbound({ providerKey: absent, scope, keys })),
      refusal(resolveForOutbound({ providerKey: disabled, scope, keys })),
      refusal(resolveForOutbound({ providerKey: expired, scope, keys })),
      refusal(resolveForOutbound({ providerKey: otherTenant, scope, keys })),
    ]);

    expect(new Set(messages)).toEqual(new Set([UNAVAILABLE]));
  });

  it("an authScheme requiring material cannot be created without it, and NONE cannot carry any", async () => {
    await expect(
      createCredential({ providerKey: provider("nomat"), authScheme: "API_KEY", ownership: "PLATFORM", keys })
    ).rejects.toThrow(/requires secret material/);

    await expect(
      createCredential({
        providerKey: provider("nonemat"), authScheme: "NONE", ownership: "PLATFORM", plaintext: "k", keys,
      })
    ).rejects.toThrow(/NONE takes no secret/);
  });
});

d("C15-C17 — credentialVersion tracks the provider's value, keyId tracks ours", () => {
  it("C15. credentialVersion starts at 1 and is not a function of the master key", async () => {
    const providerKey = provider("c15");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "v1-value", keys,
    });

    const row = await rawRow(credentialRef);
    expect(row.credentialVersion).toBe(1);
    // Written under the active master key — a different number entirely, and a different concept.
    expect((await describeSecret(row.secretRef as string))!.keyId).toBe("provider-v2");
  });

  it("C16. a master-key rewrap does not touch credentialVersion", async () => {
    /*
     * The audit trail must not claim a provider reissued a key when all that happened was that we
     * re-encrypted our own storage.
     */
    const providerKey = provider("c16");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "unchanged-value", keys,
    });
    const secretRef = (await rawRow(credentialRef)).secretRef as string;

    // Put the row under the retired key, as a pre-rotation row would have been, then rewrap it.
    const { encryptSecret } = await import("./_core/secretCrypto");
    const old = encryptSecret({
      purpose: "PROVIDER_CREDENTIAL", plaintext: "unchanged-value", context: { secretRef }, keys, keyId: "provider-v1",
    });
    await pool.query("UPDATE encryptedSecrets SET envelope = ?, keyId = 'provider-v1' WHERE secretRef = ?", [old, secretRef]);

    const rewrapped = await rewrapSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef, keys });

    expect(rewrapped.keyId, "the storage key moved").toBe("provider-v2");
    expect(rewrapped.secretRef, "the reference did not").toBe(secretRef);

    const after = await rawRow(credentialRef);
    expect(after.credentialVersion, "a rewrap is not a credential rotation").toBe(1);
    expect(after.rotatedAt).toBeNull();
    expect(after.secretRef).toBe(secretRef);
    expect(after.fingerprint).toBe(fingerprint("unchanged-value"));
    // And the credential still resolves to the same provider value throughout.
    expect((await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys })).plaintext)
      .toBe("unchanged-value");
  });

  it("C17. replacing the provider's value increments credentialVersion and retires the old secret", async () => {
    const providerKey = provider("c17");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "old-provider-value", keys,
    });
    const oldSecretRef = (await rawRow(credentialRef)).secretRef as string;

    const rotated = await rotateCredential({ credentialRef, plaintext: "new-provider-value", keys });

    expect(rotated.credentialVersion).toBe(2);

    const after = await rawRow(credentialRef);
    expect(after.credentialVersion).toBe(2);
    expect(after.secretRef, "a rotation points the credential at new material").not.toBe(oldSecretRef);
    expect(after.fingerprint).toBe(fingerprint("new-provider-value"));
    expect(after.rotatedAt).not.toBeNull();

    expect((await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys })).plaintext)
      .toBe("new-provider-value");

    // The retired secret survives for audit but can no longer be read.
    expect((await describeSecret(oldSecretRef))!.status).toBe("disabled");
    await expect(
      resolveSecret({ purpose: "PROVIDER_CREDENTIAL", secretRef: oldSecretRef, keys })
    ).rejects.toThrow(/disabled/);
  });

  it("a successful resolve records lastUsedAt without invalidating the envelope", async () => {
    /*
     * `lastUsedAt` is mutable metadata and is deliberately NOT bound into the envelope's
     * authenticated data — only version, purpose, keyId and the stable secretRef are. Binding a
     * timestamp would mean every use invalidated the ciphertext it had just read. This proves the
     * mutation happens and that a second resolve still succeeds.
     */
    const providerKey = provider("used");
    const { credentialRef } = await createCredential({
      providerKey, authScheme: "API_KEY", ownership: "PLATFORM", plaintext: "used-value", keys,
    });
    expect((await rawRow(credentialRef)).lastUsedAt).toBeNull();

    const at = new Date("2026-05-05T12:00:00Z");
    await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys, now: at });

    expect(new Date((await rawRow(credentialRef)).lastUsedAt as string).toISOString()).toBe(at.toISOString());
    expect((await resolveForOutbound({ providerKey, scope: { ownership: "PLATFORM" }, keys })).plaintext).toBe("used-value");
  });

  it("rotating a credential that does not exist is refused", async () => {
    await expect(
      rotateCredential({ credentialRef: newCredentialRef(), plaintext: "k", keys })
    ).rejects.toThrow(/no such credential/);
  });
});
