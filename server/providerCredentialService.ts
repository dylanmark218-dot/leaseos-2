/**
 * S2-C — provider credential metadata, ownership, and the fallback this module refuses to perform.
 *
 * THE RULE THAT MATTERS MOST. Resolution is by **exact ownership**. A tenant asking for a
 * credential it does not have gets a refusal — never the platform credential, never another
 * tenant's. That is not a performance or ergonomics decision: serving the platform key to a tenant
 * that was supposed to bring its own silently bills LeaseOS's quota for their traffic and, where
 * the provider's terms require a customer account, breaches them. A connector whose provider terms
 * genuinely permit the fallback must declare it in its own policy; a generic resolver cannot know
 * that, so it does not decide it.
 *
 * WHY credentialVersion AND keyId ARE DIFFERENT NUMBERS. Replacing the value a provider issued is
 * credential rotation and increments `credentialVersion`. Re-encrypting our own storage is master-key
 * rotation and changes `encryptedSecrets.keyId`. Conflating them would make the audit trail claim a
 * provider reissued a key when all that happened was housekeeping.
 *
 * NO REVEAL. There is no function here that returns a stored secret to a caller. `resolveForOutbound`
 * exists for server-side connectors and returns plaintext; everything shaped for a UI returns
 * metadata. That asymmetry is the whole design — see the DTO test.
 */
import { and, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { providerCredentials } from "../drizzle/schema";
import { createSecret, disableSecret, resolveSecret } from "./secretStore";
import type { SecretKeyProvider } from "./_core/secretCrypto";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("provider credentials unavailable: no database connection");
  return db;
}

export type CredentialOwnership = "PLATFORM" | "TENANT";
export type AuthScheme =
  | "NONE" | "API_KEY" | "STATIC_BEARER"
  | "OAUTH2_CLIENT_CREDENTIALS" | "OAUTH2_REFRESH"
  | "SIGNED_REQUEST" | "MUTUAL_TLS";

export const newCredentialRef = (): string => `cred_${randomBytes(18).toString("base64url")}`;

/**
 * A short hash of the plaintext, so an operator can confirm which key is installed without the
 * system disclosing any character of it. Truncated deliberately: enough to distinguish two keys,
 * far too little to attack.
 */
export const fingerprint = (plaintext: string): string =>
  createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 16);

/** Metadata safe to return to any authorized reader. Has no secret-bearing field, by construction. */
export type CredentialMetadata = {
  credentialRef: string;
  providerKey: string;
  environment: "production" | "staging" | "sandbox";
  authScheme: AuthScheme;
  ownership: CredentialOwnership;
  orgRef: string | null;
  externalAccountId: string | null;
  status: "active" | "disabled" | "rotating" | "revoked" | "expired";
  credentialVersion: number;
  fingerprint: string | null;
  configured: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

/**
 * Ownership coherence, checked before the database sees it.
 *
 * The CHECK constraint in 0192 is the real guarantee; this exists so a caller gets a sentence it
 * can act on instead of a constraint violation. Neither one repairs a malformed request — a
 * resolver that guessed which ownership was meant is how a tenant ends up with a platform key.
 */
/**
 * The one predicate that defines a credential's scope, shared by create and resolve.
 *
 * Shared deliberately. If resolution built its own clause, a later edit could widen it — drop the
 * ownership term, say — and the create-time uniqueness check would keep passing while resolution
 * started matching rows from another scope. One predicate means a mutation to it breaks both, which
 * is what the tests can see.
 */
function scopeWhere(
  providerKey: string,
  environment: "production" | "staging" | "sandbox",
  ownership: CredentialOwnership,
  orgRef: string | null
) {
  return and(
    eq(providerCredentials.providerKey, providerKey),
    eq(providerCredentials.environment, environment),
    eq(providerCredentials.ownership, ownership),
    orgRef === null ? isNull(providerCredentials.orgRef) : eq(providerCredentials.orgRef, orgRef)
  );
}

function assertOwnership(ownership: CredentialOwnership, orgRef: string | null | undefined) {
  if (ownership === "PLATFORM" && orgRef) {
    throw new Error("credential refused: a PLATFORM credential must not name an orgRef");
  }
  if (ownership === "TENANT" && !orgRef) {
    throw new Error("credential refused: a TENANT credential requires an orgRef");
  }
}

export async function createCredential(args: {
  providerKey: string;
  authScheme: AuthScheme;
  ownership: CredentialOwnership;
  orgRef?: string | null;
  environment?: "production" | "staging" | "sandbox";
  externalAccountId?: string | null;
  /** Omitted only for authScheme NONE — an open feed still goes through a connector. */
  plaintext?: string;
  /** When the provider says the value stops working. Enforced at resolve, not by a background job. */
  expiresAt?: Date | null;
  keys: SecretKeyProvider;
  isProduction?: boolean;
  createdByUserId?: number | null;
}): Promise<{ credentialRef: string }> {
  assertOwnership(args.ownership, args.orgRef);

  if (args.authScheme !== "NONE" && !args.plaintext) {
    throw new Error(`credential refused: ${args.authScheme} requires secret material`);
  }
  if (args.authScheme === "NONE" && args.plaintext) {
    throw new Error("credential refused: authScheme NONE takes no secret");
  }

  const environment = args.environment ?? "production";
  const db = await database();

  /*
   * Checked BEFORE the secret is written, so a refused create leaves no orphan ciphertext behind.
   *
   * The scope UNIQUE is the real guarantee — it indexes a generated `orgScope` exactly so a platform
   * row's NULL cannot exempt it. This read exists to turn "duplicate key" into a sentence naming the
   * scope, and is deliberately not a substitute for it: two concurrent creates race past any
   * check-then-insert, and the index is what refuses the loser.
   */
  const clash = (
    await db
      .select({ credentialRef: providerCredentials.credentialRef })
      .from(providerCredentials)
      .where(scopeWhere(args.providerKey, environment, args.ownership, args.orgRef ?? null))
  )[0];
  if (clash) {
    throw new Error(
      `credential refused: ${args.providerKey} already has a ${args.ownership} credential for ${environment}; rotate or disable it instead of adding a second`
    );
  }

  let secretRef: string | null = null;
  if (args.plaintext) {
    ({ secretRef } = await createSecret({
      purpose: "PROVIDER_CREDENTIAL",
      plaintext: args.plaintext,
      keys: args.keys,
      isProduction: args.isProduction,
      provenance: { sourceTable: "providerCredentials", sourceColumn: "secretRef" },
    }));
  }

  const credentialRef = newCredentialRef();
  await db.insert(providerCredentials).values({
    credentialRef,
    providerKey: args.providerKey,
    environment,
    authScheme: args.authScheme,
    ownership: args.ownership,
    orgRef: args.orgRef ?? null,
    externalAccountId: args.externalAccountId ?? null,
    secretRef,
    fingerprint: args.plaintext ? fingerprint(args.plaintext) : null,
    expiresAt: args.expiresAt ?? null,
    createdByUserId: args.createdByUserId ?? null,
  } as never);

  return { credentialRef };
}

/**
 * Replace the value a provider issued. Increments `credentialVersion`; leaves storage keys alone.
 *
 * The previous secret is disabled rather than deleted, so an audit can still see that a rotation
 * happened and what it replaced — without anything being able to read the old value.
 */
export async function rotateCredential(args: {
  credentialRef: string;
  plaintext: string;
  /** The replacement's own expiry. Explicit null clears an expiry the old value carried. */
  expiresAt?: Date | null;
  keys: SecretKeyProvider;
  isProduction?: boolean;
}): Promise<{ credentialRef: string; credentialVersion: number }> {
  const db = await database();
  const current = (
    await db.select().from(providerCredentials).where(eq(providerCredentials.credentialRef, args.credentialRef))
  )[0];
  if (!current) throw new Error("credential refused: no such credential");

  const { secretRef } = await createSecret({
    purpose: "PROVIDER_CREDENTIAL",
    plaintext: args.plaintext,
    keys: args.keys,
    isProduction: args.isProduction,
    provenance: { sourceTable: "providerCredentials", sourceColumn: "secretRef" },
  });

  const credentialVersion = current.credentialVersion + 1;
  await db
    .update(providerCredentials)
    .set({
      secretRef,
      credentialVersion,
      fingerprint: fingerprint(args.plaintext),
      expiresAt: args.expiresAt ?? null,
      rotatedAt: new Date(),
      updatedAt: new Date(),
    } as never)
    .where(eq(providerCredentials.credentialRef, args.credentialRef));

  /*
   * Disabled only after the row points at the replacement, so an interrupted rotation leaves the
   * old value still resolvable rather than leaving the credential unusable. Disabled, not deleted:
   * the audit trail keeps the row, and nothing can read the retired value through it.
   */
  if (current.secretRef) await disableSecret(current.secretRef);

  return { credentialRef: args.credentialRef, credentialVersion };
}

export async function disableCredential(args: {
  credentialRef: string;
  reason: string;
  byUserId?: number | null;
}): Promise<void> {
  const db = await database();
  await db
    .update(providerCredentials)
    .set({
      status: "disabled",
      disabledReason: args.reason,
      disabledByUserId: args.byUserId ?? null,
      updatedAt: new Date(),
    } as never)
    .where(eq(providerCredentials.credentialRef, args.credentialRef));
}

const toMetadata = (r: Record<string, unknown>): CredentialMetadata => ({
  credentialRef: r.credentialRef as string,
  providerKey: r.providerKey as string,
  environment: r.environment as CredentialMetadata["environment"],
  authScheme: r.authScheme as AuthScheme,
  ownership: r.ownership as CredentialOwnership,
  orgRef: (r.orgRef as string | null) ?? null,
  externalAccountId: (r.externalAccountId as string | null) ?? null,
  status: r.status as CredentialMetadata["status"],
  credentialVersion: r.credentialVersion as number,
  fingerprint: (r.fingerprint as string | null) ?? null,
  // "configured" is the question a UI actually asks, answered without touching the value.
  configured: Boolean(r.secretRef) || r.authScheme === "NONE",
  createdAt: new Date(r.createdAt as string),
  rotatedAt: r.rotatedAt ? new Date(r.rotatedAt as string) : null,
  expiresAt: r.expiresAt ? new Date(r.expiresAt as string) : null,
  lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt as string) : null,
});

/**
 * Metadata for a scope. **Never returns `secretRef`** — even that is withheld from ordinary
 * listings, because a reference is the one input a resolver needs and there is no reason a UI
 * should hold one.
 */
export async function listCredentials(scope:
  | { ownership: "PLATFORM" }
  | { ownership: "TENANT"; orgRef: string }
): Promise<CredentialMetadata[]> {
  const db = await database();
  const rows =
    scope.ownership === "PLATFORM"
      ? await db.select().from(providerCredentials).where(
          and(eq(providerCredentials.ownership, "PLATFORM"), isNull(providerCredentials.orgRef))
        )
      : await db.select().from(providerCredentials).where(
          and(eq(providerCredentials.ownership, "TENANT"), eq(providerCredentials.orgRef, scope.orgRef))
        );
  return rows.map(r => toMetadata(r as Record<string, unknown>));
}

const USABLE = new Set(["active"]);

/**
 * Resolve plaintext for an outbound provider call. **Server-side connectors only.**
 *
 * Exact ownership: a TENANT request matches only that tenant's row, a PLATFORM request only a
 * platform row. There is no parameter that would let a caller ask for "mine, or the platform's".
 */
export async function resolveForOutbound(args: {
  providerKey: string;
  scope: { ownership: "PLATFORM" } | { ownership: "TENANT"; orgRef: string };
  environment?: "production" | "staging" | "sandbox";
  keys: SecretKeyProvider;
  isProduction?: boolean;
  now?: Date;
}): Promise<{ plaintext: string; credentialRef: string; authScheme: AuthScheme }> {
  const db = await database();
  const environment = args.environment ?? "production";
  const now = args.now ?? new Date();

  const found = (
    await db
      .select()
      .from(providerCredentials)
      .where(
        scopeWhere(
          args.providerKey,
          environment,
          args.scope.ownership,
          args.scope.ownership === "TENANT" ? args.scope.orgRef : null
        )
      )
  )[0];

  // One refusal shape for absent, disabled and expired: a caller learns it cannot proceed, not
  // which credentials exist for which tenant.
  if (!found) throw new Error("credential refused: not available for this scope");
  if (!USABLE.has(found.status)) throw new Error("credential refused: not available for this scope");
  if (found.expiresAt && new Date(found.expiresAt) <= now) {
    throw new Error("credential refused: not available for this scope");
  }
  if (!found.secretRef) throw new Error("credential refused: not available for this scope");

  const plaintext = await resolveSecret({
    purpose: "PROVIDER_CREDENTIAL",
    secretRef: found.secretRef,
    keys: args.keys,
    isProduction: args.isProduction,
  });

  /*
   * Recorded after a successful resolve, because "has this credential ever been used, and when" is
   * the question connector health actually asks and nothing else can answer it.
   *
   * Safe to mutate precisely because it is NOT bound into the envelope's authenticated data — only
   * version, purpose, keyId and the stable secretRef are. Binding a timestamp would mean every use
   * invalidated the ciphertext it just read.
   */
  await db
    .update(providerCredentials)
    .set({ lastUsedAt: now } as never)
    .where(eq(providerCredentials.credentialRef, found.credentialRef));

  return { plaintext, credentialRef: found.credentialRef, authScheme: found.authScheme as AuthScheme };
}
