/**
 * S2-E Phase 1 — the one place a webhook signing secret is resolved.
 *
 * THE RULE, and the reason it is shaped this way:
 *
 *     secretRef present → resolve it under WEBHOOK_SECRET, and FAIL CLOSED if that fails, for any
 *                         reason — missing row, wrong purpose, disabled secret, unconfigured or
 *                         wrong key, tampered envelope.
 *     secretRef absent  → decrypt the legacy `secretEnc` with the shared key.
 *     neither usable    → this subscription signs nothing.
 *
 * **Never "resolve → catch → fall back to legacy."** A present-but-unresolvable reference falling
 * back would let whoever damaged the canonical record choose which secret signs LeaseOS's outbound
 * traffic — and during the backfill window the legacy column is still populated for every migrated
 * row, so the fallback would almost always succeed and the damage would be invisible. Fallback is
 * permitted only where the reference is *absent*, which is a statement about migration progress,
 * not about whether a read happened to work.
 *
 * ONE BOUNDARY, NOT FOUR. The router, the dispatch service, the retry sweep and the reclaim path
 * all sign outbound requests. If each decided for itself how to find the secret, "fail closed"
 * would be true in three of them and false in the fourth, which is exactly the shape of bug that
 * survives review. `ME11` plants precisely that.
 *
 * NO GENERIC PURPOSE. Every call passes `purpose: "WEBHOOK_SECRET"` internally; webhook domain code
 * never names a purpose, so it cannot request an MFA seed or a provider credential even by mistake.
 * The store's own wrong-purpose refusal is then a second line of defence rather than the only one.
 *
 * PLAINTEXT LIFETIME. A signing secret exists as a string for the duration of one signature. No
 * claim is made about zeroing it — JavaScript cannot guarantee that, and pretending otherwise would
 * be worse than saying so.
 */
import { resolveSecret } from "./secretStore";
import type { SecretKeyProvider } from "./_core/secretCrypto";
import { decryptSecret as legacyDecrypt } from "./_core/externalIdentityPolicy";

/** Only the two columns that decide where a subscription's secret lives. */
export type WebhookSecretColumns = { secretEnc: string | null; secretRef: string | null };

export type WebhookSecretKeys = {
  /** The S2 provider. Supplies the active `WEBHOOK_SECRET` key. */
  keys: SecretKeyProvider;
  /** `LEASEOS_PORTAL_MFA_KEY`, decrypt-only. Absent once the migration window has closed. */
  legacyKey: Buffer | null;
  isProduction?: boolean;
};

/** Which storage a subscription is actually using — the question the readiness report aggregates. */
export type WebhookSecretStorage = "none" | "legacy" | "transitional" | "canonical";

export function webhookSecretStorageOf(row: WebhookSecretColumns): WebhookSecretStorage {
  if (row.secretRef && row.secretEnc) return "transitional";
  if (row.secretRef) return "canonical";
  if (row.secretEnc) return "legacy";
  return "none";
}

/**
 * Resolve the signing secret for one subscription. Throws when it cannot be resolved — never
 * returns a secret it is not certain of, and never returns a *different* secret than the one the
 * subscription points at.
 *
 * Takes the columns rather than an id because every caller already holds the subscription row:
 * re-reading it would be a second query inside the dispatch loop for no new information.
 */
export async function resolveWebhookSigningSecret(
  row: WebhookSecretColumns,
  k: WebhookSecretKeys
): Promise<string> {
  if (row.secretRef) {
    /*
     * No try/catch. A failure propagates and this subscription signs nothing. That is the intended
     * behaviour and the reason this function is shaped this way — catching here would reintroduce
     * exactly the fallback the design forbids.
     */
    return resolveSecret({
      purpose: "WEBHOOK_SECRET",
      secretRef: row.secretRef,
      keys: k.keys,
      isProduction: k.isProduction,
    });
  }

  if (row.secretEnc) {
    if (!k.legacyKey) {
      throw new Error(
        "webhook signing refused: this subscription still holds legacy ciphertext and the legacy key is not configured"
      );
    }
    return legacyDecrypt(row.secretEnc, k.legacyKey);
  }

  throw new Error("webhook signing refused: this subscription has no signing secret");
}

/**
 * Read a secret specifically so the backfill can re-encrypt it. Legacy only — a row that already
 * has a reference is not this function's business, and saying so here keeps the migration from
 * having to decide.
 */
export async function readWebhookSecretForMigration(
  row: WebhookSecretColumns,
  legacyKey: Buffer | null
): Promise<string> {
  if (row.secretRef) throw new Error("webhook migration refused: this subscription already has a secret reference");
  if (!row.secretEnc) throw new Error("webhook migration refused: this subscription has no legacy ciphertext");
  if (!legacyKey) throw new Error("webhook migration refused: LEASEOS_PORTAL_MFA_KEY is not configured");
  return legacyDecrypt(row.secretEnc, legacyKey);
}
