/**
 * S2-D — where an MFA seed is read from, and the one rule that makes the transition safe.
 *
 * THE RULE. An identity may carry a new `mfaSecretRef`, a legacy `mfaSecretEnc`, both, or neither.
 * The read order is not "try the new one, and if anything goes wrong use the old one". It is:
 *
 *     ref present  → resolve it, and FAIL CLOSED if that resolution fails, for any reason.
 *     ref absent   → read the legacy ciphertext, if there is one.
 *
 * The difference is the whole point. "Try new, catch, fall back" looks more robust and is strictly
 * worse: a corrupted or tampered new envelope would silently hand verification back to a stale
 * seed the user may have already replaced, and an attacker who could damage the new record would
 * thereby *choose* which secret MFA is checked against. Fallback is permitted only where there is
 * genuinely nothing to fall back from — where the reference is absent, not where it is broken.
 *
 * WHY THE DOMAIN CANNOT MAKE A GENERIC DECRYPT CALL. Every function here passes
 * `purpose: "MFA_SECRET"` itself. MFA code cannot ask for a webhook secret or a provider
 * credential even by mistake, because it never names a purpose — the wrong-purpose refusal in
 * `secretStore` is then a second line, not the only one.
 *
 * PLAINTEXT LIFETIME. A seed exists as a string for the duration of one verification and is never
 * returned to a caller outside this module except by `readSeedForMigration`, which exists solely so
 * the backfill can re-encrypt it. No claim is made about zeroing memory — JavaScript cannot
 * guarantee that, and pretending otherwise would be worse than saying so.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { externalIdentities } from "../drizzle/schema";
import { createSecret, disableSecret, resolveSecret } from "./secretStore";
import type { SecretKeyProvider } from "./_core/secretCrypto";
import { decryptSecret as legacyDecrypt, encryptSecret as legacyEncrypt, newTotpSecret } from "./_core/externalIdentityPolicy";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("mfa secret unavailable: no database connection");
  return db;
}

/** Only the two columns that decide where a seed lives. */
export type MfaSecretColumns = { mfaSecretEnc: string | null; mfaSecretRef: string | null };

export type MfaKeys = {
  /** The S2 provider. Supplies the active `MFA_SECRET` key for new writes. */
  keys: SecretKeyProvider;
  /** `LEASEOS_PORTAL_MFA_KEY`, decrypt-only. Absent once the migration window has closed. */
  legacyKey: Buffer | null;
  isProduction?: boolean;
};

/** Which storage an identity is actually using — the question the readiness report aggregates. */
export type MfaStorage = "none" | "legacy" | "migrated" | "new";

export function mfaStorageOf(row: MfaSecretColumns): MfaStorage {
  if (row.mfaSecretRef && row.mfaSecretEnc) return "migrated";
  if (row.mfaSecretRef) return "new";
  if (row.mfaSecretEnc) return "legacy";
  return "none";
}

/**
 * Read the seed for verification. Throws when MFA cannot be verified — never returns a seed it is
 * not certain of.
 *
 * Takes the columns rather than an id because the caller in `trpc.ts` already holds the identity
 * row: re-reading it would be a second query on the hot authorization path for no new information.
 */
export async function resolveMfaSeed(row: MfaSecretColumns, k: MfaKeys): Promise<string> {
  if (row.mfaSecretRef) {
    /*
     * No try/catch. A failure here — missing row, wrong purpose, disabled secret, unconfigured or
     * wrong key, tampered envelope — propagates and MFA verification fails. That is the intended
     * behaviour and the reason this function is shaped this way; catching here would reintroduce
     * exactly the fallback the design forbids.
     */
    return resolveSecret({
      purpose: "MFA_SECRET",
      secretRef: row.mfaSecretRef,
      keys: k.keys,
      isProduction: k.isProduction,
    });
  }

  if (row.mfaSecretEnc) {
    if (!k.legacyKey) {
      throw new Error("mfa verification refused: this identity still holds legacy ciphertext and the legacy key is not configured");
    }
    return legacyDecrypt(row.mfaSecretEnc, k.legacyKey);
  }

  throw new Error("mfa verification refused: this identity has no enrolled secret");
}

/**
 * Begin (or restart) enrolment: mint a seed, store it in the canonical store, and point the
 * identity at it.
 *
 * CLEARING `mfaSecretEnc` IS NOT TIDYING UP. This codebase has no "disable MFA" procedure — the
 * only way to change an enrolled secret is to enrol again, which overwrote the legacy column in
 * place. Under the new model, writing a ref while leaving old ciphertext behind would leave the
 * replaced seed sitting in the row, and the read path's "ref absent → legacy" rule would resurrect
 * it the moment the ref were cleared or a row half-migrated. So the same write that sets the ref
 * clears the legacy column: a new write never produces both formats, and there is no stale seed
 * left to reactivate.
 *
 * The previous secret is disabled rather than deleted, after the row has been repointed, so an
 * interrupted enrolment leaves the old secret still resolvable rather than leaving the identity
 * unable to authenticate.
 */
export async function enrollMfaSecret(identityId: number, k: MfaKeys): Promise<{ secret: string }> {
  const db = await database();
  const current = (
    await db
      .select({ mfaSecretEnc: externalIdentities.mfaSecretEnc, mfaSecretRef: externalIdentities.mfaSecretRef })
      .from(externalIdentities)
      .where(eq(externalIdentities.id, identityId))
  )[0];

  const secret = newTotpSecret();
  const { secretRef } = await createSecret({
    purpose: "MFA_SECRET",
    plaintext: secret,
    keys: k.keys,
    isProduction: k.isProduction,
    provenance: { sourceTable: "externalIdentities", sourceColumn: "mfaSecretRef" },
  });

  await db
    .update(externalIdentities)
    .set({ mfaSecretRef: secretRef, mfaSecretEnc: null, mfaEnabled: false } as never)
    .where(eq(externalIdentities.id, identityId));

  if (current?.mfaSecretRef) await disableSecret(current.mfaSecretRef);

  return { secret };
}

/**
 * Read a seed specifically so the backfill can re-encrypt it. Legacy only — a row that already has
 * a ref is not this function's business, and saying so here keeps the migration from having to
 * decide.
 */
export async function readSeedForMigration(row: MfaSecretColumns, legacyKey: Buffer | null): Promise<string> {
  if (row.mfaSecretRef) throw new Error("mfa migration refused: this identity already has a secret reference");
  if (!row.mfaSecretEnc) throw new Error("mfa migration refused: this identity has no legacy ciphertext");
  if (!legacyKey) throw new Error("mfa migration refused: LEASEOS_PORTAL_MFA_KEY is not configured");
  return legacyDecrypt(row.mfaSecretEnc, legacyKey);
}

/**
 * Write a legacy-format secret. Test and fixture support only — nothing in production may call it,
 * and a structural guard pins that. It exists because a migration test must be able to create the
 * pre-migration state it is migrating from, and doing that by reaching into
 * `externalIdentityPolicy` from a dozen places would spread the legacy format further, not less.
 */
export function legacyCiphertextForTests(secret: string, legacyKey: Buffer): string {
  return legacyEncrypt(secret, legacyKey);
}
