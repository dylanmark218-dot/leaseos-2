/**
 * S2-E Phase 1 — the backfill that moves webhook signing secrets into the canonical store, and the
 * report that says whether Release 2 may begin.
 *
 * THE SECRET VALUE NEVER CHANGES. What is written to `encryptedSecrets` is byte-identical to what
 * was decrypted from `secretEnc`. That is the entire customer-visible promise of this checkpoint:
 * every webhook receiver keeps verifying signatures with the secret it already has, and nobody
 * reconfigures anything because LeaseOS changed how it encrypts at rest. A backfill that minted a
 * fresh secret would silently break every consumer, and would pass any test that only checked "a
 * canonical secret exists afterwards".
 *
 * WHY THIS IS APPLICATION CODE AND NOT SQL. Moving a secret means decrypting under one key and
 * re-encrypting under another. A migration file cannot do that without a master key in it, and a
 * master key never belongs in a migration or a row. `0194` adds an inert column; this does the work,
 * holding both keys for the length of one batch and writing neither anywhere.
 *
 * IDEMPOTENT AND RESUMABLE BY CONSTRUCTION, not by bookkeeping. Every batch re-asks the database for
 * "legacy present, no reference". A migrated row no longer matches, so a rerun skips it without a
 * cursor, a checkpoint file or a state table to fall out of sync. Interrupt it anywhere and running
 * it again continues from wherever the data actually is.
 *
 * FAIL CLOSED, ROW BY ROW. A row is only ever repointed after its canonical secret has been written
 * and read back byte-identically. If anything fails, that row is left exactly as it was — still
 * legacy, still signing, still delivering — and reported as a failure. `secretEnc` is never cleared
 * in Phase 1: it is the rollback path.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { webhookSubscriptions } from "../drizzle/schema";
import { createSecret, disableSecret, resolveSecret } from "./secretStore";
import { readWebhookSecretForMigration } from "./webhookSecretService";
import type { SecretKeyProvider } from "./_core/secretCrypto";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("webhook secret migration unavailable: no database connection");
  return db;
}

export type WebhookMigrationResult = {
  scanned: number;
  migrated: number;
  failed: number;
  /** Subscription refs only — never a secret, never an envelope. */
  failures: { subscriptionRef: string; reason: string }[];
  /** True only when a full pass found nothing left to do AND nothing failed. */
  complete: boolean;
};

export async function migrateWebhookSecrets(args: {
  keys: SecretKeyProvider;
  legacyKey: Buffer | null;
  isProduction?: boolean;
  batchSize?: number;
  maxBatches?: number;
}): Promise<WebhookMigrationResult> {
  const batchSize = args.batchSize ?? 100;
  const maxBatches = args.maxBatches ?? Number.MAX_SAFE_INTEGER;

  /*
   * Both keys checked once, before any row is touched. Starting without one would let every row
   * fail individually, and the report would read like a data problem rather than a missing variable
   * — the kind of output that invites an operator to "fix" it by clearing a column.
   */
  if (!args.legacyKey) {
    throw new Error("webhook secret migration refused: LEASEOS_PORTAL_MFA_KEY is not configured, so legacy ciphertext cannot be read");
  }
  if (!args.keys.getActiveKey("WEBHOOK_SECRET")) {
    throw new Error("webhook secret migration refused: no active WEBHOOK_SECRET key is configured, so migrated secrets could not be stored");
  }

  const db = await database();
  const result: WebhookMigrationResult = { scanned: 0, migrated: 0, failed: 0, failures: [], complete: false };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await db
      .select({
        id: webhookSubscriptions.id,
        subscriptionRef: webhookSubscriptions.subscriptionRef,
        secretEnc: webhookSubscriptions.secretEnc,
        secretRef: webhookSubscriptions.secretRef,
      })
      .from(webhookSubscriptions)
      .where(and(isNotNull(webhookSubscriptions.secretEnc), isNull(webhookSubscriptions.secretRef)))
      .limit(batchSize);

    if (rows.length === 0) {
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
        result.failed += 1;
        result.failures.push({ subscriptionRef: row.subscriptionRef, reason: (error as Error).message });
      }
    }

    /*
     * PER BATCH, not cumulative — and the difference is not academic. S2-D's first version compared
     * the *running* migrated total against zero, so a batch holding one healthy row and one
     * permanently-broken one recorded progress, came back for the broken row alone, and spun on it
     * forever while hammering the database. A test with exactly that mixture found it. Failed rows
     * still match the batch predicate, so without this the next iteration refetches them.
     */
    if (result.migrated === migratedBeforeBatch) break;
  }

  return result;
}

/**
 * One row, in the only safe order: write the canonical secret, prove it reads back identically, and
 * only then repoint the subscription.
 *
 * The read-back is not ceremony. It is the difference between "we wrote something" and "the thing we
 * wrote is the secret this customer's receiver is verifying signatures with", and it is the last
 * moment at which discovering otherwise costs nothing — `secretEnc` is still intact.
 */
async function migrateOne(
  row: { id: number; subscriptionRef: string; secretEnc: string | null; secretRef: string | null },
  args: { keys: SecretKeyProvider; legacyKey: Buffer | null; isProduction?: boolean }
): Promise<void> {
  const secret = await readWebhookSecretForMigration(row, args.legacyKey);

  const { secretRef } = await createSecret({
    purpose: "WEBHOOK_SECRET",
    plaintext: secret,
    keys: args.keys,
    isProduction: args.isProduction,
    provenance: { sourceTable: "webhookSubscriptions", sourceColumn: "secretEnc" },
  });

  const readBack = await resolveSecret({
    purpose: "WEBHOOK_SECRET",
    secretRef,
    keys: args.keys,
    isProduction: args.isProduction,
  });
  if (readBack !== secret) {
    // Disable the doubtful secret so nothing can later resolve it, and leave the row untouched: the
    // subscription keeps signing from legacy ciphertext and is reported as a failure.
    await disableSecret(secretRef);
    throw new Error("webhook secret migration refused: the stored secret did not read back identically");
  }

  const db = await database();
  /*
   * `secretEnc` is deliberately NOT cleared. It is the rollback path for the whole of Release 1, and
   * clearing it is a separate checkpoint gated on the readiness report. The resolver prefers the
   * reference, so carrying both is inert.
   *
   * The `isNull` predicate makes the write itself the race guard: two concurrent runs cannot both
   * repoint the same row, because the second matches nothing.
   */
  const updated = await db
    .update(webhookSubscriptions)
    .set({ secretRef } as never)
    .where(and(eq(webhookSubscriptions.id, row.id), isNull(webhookSubscriptions.secretRef)));

  const affected = (updated as unknown as { rowsAffected?: number })?.rowsAffected;
  if (affected === 0) {
    /*
     * Another run won the race and this one's secret is an orphan. Disabling it rather than leaving
     * it resolvable is the orphan-prevention rule: an unreferenced but live secret in the store is
     * something no audit can explain later.
     */
    await disableSecret(secretRef);
  }
}

/**
 * What an operator needs before Release 2, with no secret material in the answer.
 *
 * `canonicalOnly` is reported but must be **zero throughout Release 1** — normal creation does not
 * produce it and the backfill does not produce it, so a non-zero count means either Release 2 has
 * begun or something wrote a row it should not have.
 */
export type WebhookSecretReadiness = {
  total: number;
  enabled: number;
  legacyOnly: number;
  transitional: number;
  canonicalOnly: number;
  invalidBothNull: number;
  /** Enabled subscriptions that would fail to sign right now: the both-null ones. */
  enabledUnsignable: number;
  /**
   * True when no enabled subscription still depends on the legacy key to sign.
   *
   * **This does NOT authorise Release 2.** It is a statement about database state only. Release 2
   * additionally requires that every deployed instance understands canonical references, which no
   * query can answer — see the design's Release-2 gate.
   */
  noEnabledLegacyDependence: boolean;
};

export async function webhookSecretReadiness(): Promise<WebhookSecretReadiness> {
  const db = await database();
  const enc = webhookSubscriptions.secretEnc;
  const ref = webhookSubscriptions.secretRef;
  const enabled = sql`${webhookSubscriptions.status} = 'active'`;

  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      enabled: sql<number>`SUM(CASE WHEN ${enabled} THEN 1 ELSE 0 END)`,
      legacyOnly: sql<number>`SUM(CASE WHEN ${enc} IS NOT NULL AND ${ref} IS NULL THEN 1 ELSE 0 END)`,
      transitional: sql<number>`SUM(CASE WHEN ${enc} IS NOT NULL AND ${ref} IS NOT NULL THEN 1 ELSE 0 END)`,
      canonicalOnly: sql<number>`SUM(CASE WHEN ${enc} IS NULL AND ${ref} IS NOT NULL THEN 1 ELSE 0 END)`,
      invalidBothNull: sql<number>`SUM(CASE WHEN ${enc} IS NULL AND ${ref} IS NULL THEN 1 ELSE 0 END)`,
      enabledUnsignable: sql<number>`SUM(CASE WHEN ${enabled} AND ${enc} IS NULL AND ${ref} IS NULL THEN 1 ELSE 0 END)`,
      enabledLegacyOnly: sql<number>`SUM(CASE WHEN ${enabled} AND ${enc} IS NOT NULL AND ${ref} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(webhookSubscriptions);

  const n = (v: unknown) => Number(v ?? 0);

  return {
    total: n(counts?.total),
    enabled: n(counts?.enabled),
    legacyOnly: n(counts?.legacyOnly),
    transitional: n(counts?.transitional),
    canonicalOnly: n(counts?.canonicalOnly),
    invalidBothNull: n(counts?.invalidBothNull),
    enabledUnsignable: n(counts?.enabledUnsignable),
    noEnabledLegacyDependence: n(counts?.enabledLegacyOnly) === 0,
  };
}
