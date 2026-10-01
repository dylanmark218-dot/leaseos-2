/**
 * S2-B — the only module that touches `encryptedSecrets`.
 *
 * Everything else in LeaseOS holds a `secretRef`, which is opaque and carries no information about
 * the value behind it. That is the whole point of the indirection: a credential can be rotated,
 * rewrapped under a new master key, or disabled without any caller changing, and no ordinary read
 * path can stumble into ciphertext.
 *
 * WHY secretRef IS RANDOM AND NOT DERIVED. A ref derived from the plaintext — any hash of it —
 * would be an oracle: the same provider key always produces the same ref, so anyone who can list
 * refs can test guesses offline. It is random, and it stays fixed across rewrap so rotation never
 * has to rewrite foreign references.
 *
 * WHAT THIS MODULE REFUSES TO DO. It does not decide authorization, ownership or tenancy — S2-C
 * owns those, because a store that also judged who may read would be the place every future caller
 * adds an exception. It resolves a ref under a stated purpose, or it refuses.
 */
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "./db";
import { encryptedSecrets } from "../drizzle/schema";
import {
  decryptSecret,
  encryptSecret,
  parseEnvelope,
  type SecretKeyProvider,
  type SecretPurpose,
} from "./_core/secretCrypto";

/**
 * One null check, in one place. `getDb()` can answer null, and scattering the guard would mean the
 * next caller forgets it — the same reasoning that gives this module a single resolver.
 */
async function database() {
  const db = await getDb();
  if (!db) throw new Error("secret store unavailable: no database connection");
  return db;
}

/** Opaque and unguessable: 32 bytes of randomness, never a function of the plaintext. */
export const newSecretRef = (): string => `sec_${randomBytes(24).toString("base64url")}`;

export type SecretProvenance = { sourceTable: string; sourceColumn: string };

/**
 * Store a new secret and return the reference callers will keep.
 *
 * The ref is generated *before* encryption because it is bound into the envelope's authenticated
 * data — that binding is what stops ciphertext being copied from one row to another to repoint a
 * credential.
 */
export async function createSecret(args: {
  purpose: SecretPurpose;
  plaintext: string;
  keys: SecretKeyProvider;
  isProduction?: boolean;
  provenance?: SecretProvenance;
}): Promise<{ secretRef: string; keyId: string }> {
  const db = await database();
  const secretRef = newSecretRef();

  const envelope = encryptSecret({
    purpose: args.purpose,
    plaintext: args.plaintext,
    context: { secretRef },
    keys: args.keys,
    isProduction: args.isProduction,
  });

  await db.insert(encryptedSecrets).values({
    secretRef,
    purpose: args.purpose,
    keyId: parseEnvelope(envelope).keyId,
    envelope,
    sourceTable: args.provenance?.sourceTable ?? null,
    sourceColumn: args.provenance?.sourceColumn ?? null,
  } as never);

  return { secretRef, keyId: parseEnvelope(envelope).keyId };
}

const row = async (secretRef: string) => {
  const db = await database();
  return (await db.select().from(encryptedSecrets).where(eq(encryptedSecrets.secretRef, secretRef)))[0] ?? null;
};

/**
 * Resolve plaintext. **Server-side trusted callers only** — there is no tRPC path to this.
 *
 * A missing ref and a wrong-purpose ref answer with the same refusal shape, so a caller cannot use
 * the difference to learn which refs exist.
 */
export async function resolveSecret(args: {
  purpose: SecretPurpose;
  secretRef: string;
  keys: SecretKeyProvider;
  isProduction?: boolean;
}): Promise<string> {
  const found = await row(args.secretRef);
  if (!found) throw new Error("secret read refused: no such secret");
  if (found.purpose !== args.purpose) throw new Error("secret read refused: no such secret");
  if (found.status !== "active") throw new Error("secret read refused: secret is disabled");

  return decryptSecret({
    purpose: args.purpose,
    envelope: found.envelope,
    context: { secretRef: args.secretRef },
    keys: args.keys,
    isProduction: args.isProduction,
  });
}

/**
 * Re-encrypt under the purpose's active key, keeping the plaintext and the reference identical.
 *
 * This is master-key rotation, not credential rotation: the value a provider issued does not
 * change, so nothing downstream needs to know it happened. `secretRef` is deliberately stable —
 * a rewrap that moved it would force every foreign reference to be rewritten, which is how a
 * rotation becomes a migration nobody wants to run.
 */
export async function rewrapSecret(args: {
  purpose: SecretPurpose;
  secretRef: string;
  keys: SecretKeyProvider;
  isProduction?: boolean;
}): Promise<{ secretRef: string; keyId: string }> {
  const plaintext = await resolveSecret(args);

  const envelope = encryptSecret({
    purpose: args.purpose,
    plaintext,
    context: { secretRef: args.secretRef },
    keys: args.keys,
    isProduction: args.isProduction,
  });
  const keyId = parseEnvelope(envelope).keyId;

  const db = await database();
  await db
    .update(encryptedSecrets)
    .set({ envelope, keyId, rewrappedAt: new Date() } as never)
    .where(and(eq(encryptedSecrets.secretRef, args.secretRef), eq(encryptedSecrets.purpose, args.purpose)));

  return { secretRef: args.secretRef, keyId };
}

/** Disable without deleting: the row stays for audit, and resolution refuses from now on. */
export async function disableSecret(secretRef: string): Promise<void> {
  const db = await database();
  await db
    .update(encryptedSecrets)
    .set({ status: "disabled", disabledAt: new Date() } as never)
    .where(eq(encryptedSecrets.secretRef, secretRef));
}

/**
 * Which rows still reference a key, for one purpose. The question a rotation asks before retiring
 * one — an answer of zero is the only thing that makes retirement safe.
 */
export async function secretsUsingKey(purpose: SecretPurpose, keyId: string): Promise<string[]> {
  const db = await database();
  const rows = await db
    .select({ secretRef: encryptedSecrets.secretRef })
    .from(encryptedSecrets)
    .where(and(eq(encryptedSecrets.purpose, purpose), eq(encryptedSecrets.keyId, keyId)));
  return rows.map((r: { secretRef: string }) => r.secretRef);
}

/**
 * Would a write under this provider succeed, for this purpose, under these production rules?
 *
 * S2-E Phase 2A. The cutover preflight has to answer "can production create a canonical
 * WEBHOOK_SECRET?" without creating one — a probe that left a row behind would be a write the
 * preflight was supposed to be checking permission for. So this encrypts a throwaway value under a
 * throwaway reference, decrypts it again, and persists nothing: no row, no log line, no plaintext
 * in the answer. The same `guardProductionWrites` that protects `createSecret` runs inside
 * `encryptSecret`, so the probe cannot answer "possible" where the real write would be refused.
 *
 * Reasons are the refusal messages the crypto core already guarantees carry neither key material nor
 * plaintext. A provider that throws (a managed key system that is unreachable) is reported, never
 * propagated — the preflight is a report, and a report that crashes says nothing.
 */
export function probeSecretWrite(args: {
  purpose: SecretPurpose;
  keys: SecretKeyProvider;
  isProduction: boolean;
}): { possible: true; keyId: string } | { possible: false; reason: string } {
  const secretRef = newSecretRef();
  const plaintext = randomBytes(24).toString("base64url");
  try {
    const envelope = encryptSecret({
      purpose: args.purpose,
      plaintext,
      context: { secretRef },
      keys: args.keys,
      isProduction: args.isProduction,
    });
    const readBack = decryptSecret({
      purpose: args.purpose,
      envelope,
      context: { secretRef },
      keys: args.keys,
      isProduction: args.isProduction,
    });
    if (readBack !== plaintext) return { possible: false, reason: "secret write probe: the value did not read back identically" };
    return { possible: true, keyId: parseEnvelope(envelope).keyId };
  } catch (error) {
    return { possible: false, reason: error instanceof Error ? error.message : "secret write probe: provider failed" };
  }
}

/** Metadata only. Deliberately has no `envelope` field — see the output-boundary test. */
export async function describeSecret(secretRef: string): Promise<{
  secretRef: string;
  purpose: SecretPurpose;
  keyId: string;
  status: "active" | "disabled";
  createdAt: Date;
  rewrappedAt: Date | null;
} | null> {
  const found = await row(secretRef);
  if (!found) return null;
  return {
    secretRef: found.secretRef,
    purpose: found.purpose as SecretPurpose,
    keyId: found.keyId,
    status: found.status as "active" | "disabled",
    createdAt: new Date(found.createdAt),
    rewrappedAt: found.rewrappedAt ? new Date(found.rewrappedAt) : null,
  };
}
