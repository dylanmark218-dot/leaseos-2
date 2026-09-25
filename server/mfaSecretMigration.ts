/**
 * S2-D — the backfill that moves MFA seeds into the canonical store, and the report that says
 * whether it is safe to stop carrying the legacy key.
 *
 * WHY THIS IS APPLICATION CODE AND NOT SQL. Moving a seed means decrypting under one key and
 * re-encrypting under another. A migration file cannot do that without a master key in it, and a
 * master key must never be in a migration or a row. So `0193` adds an inert column and this does
 * the work, holding both keys for the length of one batch and writing neither anywhere.
 *
 * THE SEED IS NOT REGENERATED. The value written to `encryptedSecrets` is byte-identical to the one
 * decrypted from `mfaSecretEnc`. That is the entire user-visible promise of this checkpoint: nobody
 * re-enrols, every authenticator app keeps working, and the codes a phone is already generating
 * keep verifying. A migration that minted a fresh seed would be silently locking every portal user
 * out of their own account, and it would pass any test that only checked "a secret exists after".
 *
 * IDEMPOTENT AND RESUMABLE BY CONSTRUCTION, not by bookkeeping. Every batch re-asks the database
 * for rows matching "legacy present, no ref". A row that has been migrated no longer matches, so a
 * rerun skips it without needing a checkpoint file, a cursor, or a state table to get out of sync.
 * Interrupt it anywhere and running it again continues from wherever the data actually is.
 *
 * FAIL CLOSED, ROW BY ROW. A row is only ever *repointed* after its new secret has been written and
 * read back successfully. If anything fails — key missing, decrypt fails, envelope creation fails,
 * the write fails, the read-back disagrees — that row is left exactly as it was, still legacy,
 * still working, and reported as a failure. Nothing is nulled, no seed is replaced, and MFA is
 * never quietly switched off for anyone.
 */
import { and, isNotNull, isNull, sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { externalIdentities } from "../drizzle/schema";
import { createSecret, disableSecret, resolveSecret } from "./secretStore";
import { readSeedForMigration } from "./mfaSecretService";
import type { SecretKeyProvider } from "./_core/secretCrypto";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("mfa migration unavailable: no database connection");
  return db;
}

export type MfaMigrationResult = {
  scanned: number;
  migrated: number;
  failed: number;
  /** Identity ids only — never a seed, never an envelope. */
  failures: { identityId: number; reason: string }[];
  /** True when a full pass found nothing left to do. */
  complete: boolean;
};

/**
 * Migrate one bounded batch, or keep going until nothing is left.
 *
 * `batchSize` bounds the query, and `maxBatches` bounds the run — an operator can take a few
 * hundred rows during a quiet window and stop, rather than being committed to the whole table.
 */
export async function migrateMfaSecrets(args: {
  keys: SecretKeyProvider;
  legacyKey: Buffer | null;
  isProduction?: boolean;
  batchSize?: number;
  maxBatches?: number;
}): Promise<MfaMigrationResult> {
  const batchSize = args.batchSize ?? 100;
  const maxBatches = args.maxBatches ?? Number.MAX_SAFE_INTEGER;

  /*
   * Checked once, before any row is touched. Starting a run without the legacy key would let every
   * row fail individually and the report would read like a data problem rather than a missing
   * variable — and a careless operator seeing "0 migrated, 500 failed" might well try to "fix" it
   * by clearing the column.
   */
  if (!args.legacyKey) {
    throw new Error("mfa migration refused: LEASEOS_PORTAL_MFA_KEY is not configured, so legacy ciphertext cannot be read");
  }
  if (!args.keys.getActiveKey("MFA_SECRET")) {
    throw new Error("mfa migration refused: no active MFA_SECRET key is configured, so migrated seeds could not be stored");
  }

  const db = await database();
  const result: MfaMigrationResult = { scanned: 0, migrated: 0, failed: 0, failures: [], complete: false };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await db
      .select({
        id: externalIdentities.id,
        mfaSecretEnc: externalIdentities.mfaSecretEnc,
        mfaSecretRef: externalIdentities.mfaSecretRef,
      })
      .from(externalIdentities)
      .where(and(isNotNull(externalIdentities.mfaSecretEnc), isNull(externalIdentities.mfaSecretRef)))
      .limit(batchSize);

    if (rows.length === 0) {
      // A pass that found nothing is the only honest definition of complete.
      result.complete = result.failed === 0;
      break;
    }

    const migratedBeforeBatch = result.migrated;

    for (const row of rows) {
      result.scanned += 1;
      try {
        await migrateOne(row, args);
        result.migrated += 1;
      } catch (error) {
        /*
         * The message, not the cause chain, and never the row's contents. A failure reason that
         * echoed the envelope or the seed would put in a log exactly what this whole checkpoint
         * exists to keep out of one.
         */
        result.failed += 1;
        result.failures.push({ identityId: row.id, reason: (error as Error).message });
      }
    }

    /*
     * Rows that failed still match the batch predicate, so without this the next iteration fetches
     * the same rows and retries them forever. Stopping after a batch that made no progress turns an
     * infinite loop into a report.
     *
     * PER BATCH, not cumulative — and the difference is not academic. The first version of this
     * compared the *running* migrated total against zero, so a batch holding one healthy row and
     * one permanently-broken one would record progress, come back for the broken row alone, and
     * spin on it forever while hammering the database. A test with exactly that mixture found it.
     */
    if (result.migrated === migratedBeforeBatch) break;
  }

  return result;
}

/**
 * One row, in the only safe order: write the new secret, prove it reads back identically, and only
 * then repoint the identity.
 *
 * The read-back is not ceremony. It is the difference between "we wrote something" and "the thing
 * we wrote is the seed this user's authenticator is generating codes from", and it is the last
 * moment at which discovering otherwise costs nothing — the legacy column is still intact.
 */
async function migrateOne(
  row: { id: number; mfaSecretEnc: string | null; mfaSecretRef: string | null },
  args: { keys: SecretKeyProvider; legacyKey: Buffer | null; isProduction?: boolean }
): Promise<void> {
  const seed = await readSeedForMigration(row, args.legacyKey);

  const { secretRef } = await createSecret({
    purpose: "MFA_SECRET",
    plaintext: seed,
    keys: args.keys,
    isProduction: args.isProduction,
    provenance: { sourceTable: "externalIdentities", sourceColumn: "mfaSecretEnc" },
  });

  const readBack = await resolveSecret({
    purpose: "MFA_SECRET",
    secretRef,
    keys: args.keys,
    isProduction: args.isProduction,
  });
  if (readBack !== seed) {
    // Disable the doubtful secret so it cannot later be resolved by anything, and leave the row
    // untouched: the identity keeps working on legacy ciphertext and is reported as a failure.
    await disableSecret(secretRef);
    throw new Error("mfa migration refused: the stored secret did not read back identically");
  }

  const db = await database();
  /*
   * `mfaSecretEnc` is deliberately NOT cleared. It is the rollback path: until the deployed
   * migration is verified, the legacy value is what lets a release be rolled back without every
   * portal user re-enrolling. Clearing it is a separate checkpoint, gated on `legacyOnly` reaching
   * zero. The read path prefers the ref, so keeping both is inert.
   *
   * The `isNull` predicate makes the write itself the race guard: two concurrent runs cannot both
   * repoint the same row, because the second one matches nothing.
   */
  const updated = await db
    .update(externalIdentities)
    .set({ mfaSecretRef: secretRef } as never)
    .where(and(eq(externalIdentities.id, row.id), isNull(externalIdentities.mfaSecretRef)));

  const affected = (updated as unknown as { rowsAffected?: number })?.rowsAffected;
  if (affected === 0) {
    // Another run won. Ours is an orphan; disable it rather than leave a resolvable duplicate.
    await disableSecret(secretRef);
  }
}

/**
 * What an operator needs before deciding the legacy key can go. Counts only — no seed, no envelope,
 * no reference.
 */
export type MfaReadiness = {
  legacyOnly: number;
  migratedBoth: number;
  newOnly: number;
  none: number;
  total: number;
  /** The only condition under which the legacy MFA key is no longer needed to verify anyone. */
  legacyKeyRetirable: boolean;
};

export async function mfaMigrationReadiness(): Promise<MfaReadiness> {
  const db = await database();
  const [counts] = await db
    .select({
      legacyOnly: sql<number>`SUM(CASE WHEN ${externalIdentities.mfaSecretEnc} IS NOT NULL AND ${externalIdentities.mfaSecretRef} IS NULL THEN 1 ELSE 0 END)`,
      migratedBoth: sql<number>`SUM(CASE WHEN ${externalIdentities.mfaSecretEnc} IS NOT NULL AND ${externalIdentities.mfaSecretRef} IS NOT NULL THEN 1 ELSE 0 END)`,
      newOnly: sql<number>`SUM(CASE WHEN ${externalIdentities.mfaSecretEnc} IS NULL AND ${externalIdentities.mfaSecretRef} IS NOT NULL THEN 1 ELSE 0 END)`,
      none: sql<number>`SUM(CASE WHEN ${externalIdentities.mfaSecretEnc} IS NULL AND ${externalIdentities.mfaSecretRef} IS NULL THEN 1 ELSE 0 END)`,
      total: sql<number>`COUNT(*)`,
    })
    .from(externalIdentities);

  const n = (v: unknown) => Number(v ?? 0);
  const legacyOnly = n(counts?.legacyOnly);

  return {
    legacyOnly,
    migratedBoth: n(counts?.migratedBoth),
    newOnly: n(counts?.newOnly),
    none: n(counts?.none),
    total: n(counts?.total),
    /*
     * Retirable means "no identity would lose the ability to verify". A row with BOTH formats reads
     * through the ref, so it does not need the legacy key — but its legacy ciphertext is still the
     * rollback path, which is a separate decision from whether the key is required. Only
     * legacy-only rows actually depend on the key.
     */
    legacyKeyRetirable: legacyOnly === 0,
  };
}
