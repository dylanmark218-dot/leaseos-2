/**
 * S2-D — the only module in LeaseOS permitted to read a master-key environment variable.
 *
 * The design states the invariant plainly: "No master-key environment variable referenced outside
 * the key-provider module." That is what makes the `SecretKeyProvider` abstraction worth having —
 * if domain code read `process.env` itself, swapping in a KMS later would mean editing every
 * caller, and the production fail-closed rule would have as many holes as there are readers.
 *
 * KEY NAMES come from the approved design: `LEASEOS_KEY_MFA_V1`, `LEASEOS_KEY_WEBHOOK_V1`,
 * `LEASEOS_KEY_PROVIDER_V1`, `LEASEOS_KEY_INTEGRATION_V1` — 64 hex characters each.
 *
 * WHY THE NEW MFA KEY IS NOT THE LEGACY ONE. It would have been less work to point `MFA_SECRET` at
 * the material already in `LEASEOS_PORTAL_MFA_KEY`, and migration would then need no new secret
 * provisioned. It is deliberately a different key, for two reasons. The stated goal of S2-D is that
 * `LEASEOS_PORTAL_MFA_KEY` can eventually stop being used for MFA at all; if the new store held the
 * same material, retiring that variable would break the new path too and the goal would be
 * unreachable by migration alone. And the fail-closed requirement that a missing MFA key stops the
 * migration would be untestable in production terms, because the key could never be absent while
 * the legacy one was present.
 *
 * `LEASEOS_PORTAL_MFA_KEY` is still read here, and only here, as the legacy decrypt-only key. It is
 * not part of the `SecretKeyProvider` — the new store must never write under it — which is why it
 * has its own accessor.
 */
import { createEnvironmentKeyProvider, type PurposeKeyConfig, type SecretKeyProvider, type SecretPurpose } from "./secretCrypto";

/** The environment variable carrying each purpose's active key, per the approved design. */
const ACTIVE_KEY_ENV: Record<SecretPurpose, string> = {
  MFA_SECRET: "LEASEOS_KEY_MFA_V1",
  WEBHOOK_SECRET: "LEASEOS_KEY_WEBHOOK_V1",
  PROVIDER_CREDENTIAL: "LEASEOS_KEY_PROVIDER_V1",
  INTEGRATION_SECRET: "LEASEOS_KEY_INTEGRATION_V1",
};

/** The key id written into every envelope for that purpose. `_V1` in the name, `-v1` in the id. */
const ACTIVE_KEY_ID: Record<SecretPurpose, string> = {
  MFA_SECRET: "mfa-v1",
  WEBHOOK_SECRET: "webhook-v1",
  PROVIDER_CREDENTIAL: "provider-v1",
  INTEGRATION_SECRET: "integration-v1",
};

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Build a provider from whatever purpose keys the environment actually carries.
 *
 * A purpose whose variable is absent is simply not configured — the provider answers `null` for it
 * and `encryptSecret` refuses. That is the "absent-but-unused is not a failure, absent-but-needed
 * is" rule from the design: this module does not know which purposes have stored rows, so it does
 * not decide which absences matter. `mfaKeyReadiness` below answers that question for MFA, and the
 * startup gate consumes it.
 */
export function environmentSecretKeys(env: NodeJS.ProcessEnv = process.env): SecretKeyProvider {
  const config: Partial<Record<SecretPurpose, PurposeKeyConfig>> = {};

  for (const purpose of Object.keys(ACTIVE_KEY_ENV) as SecretPurpose[]) {
    const hex = env[ACTIVE_KEY_ENV[purpose]];
    // A malformed value is left unconfigured rather than thrown here, so one bad variable cannot
    // stop the process from starting and reporting *which* one. `createEnvironmentKeyProvider`
    // validates length and key-id shape for everything that does get through.
    if (hex && HEX_64.test(hex)) {
      config[purpose] = { active: { keyId: ACTIVE_KEY_ID[purpose], hex } };
    }
  }

  return createEnvironmentKeyProvider(config);
}

/**
 * The legacy MFA key, decrypt-only.
 *
 * Deliberately not exposed as a `SecretKeyProvider`: the new store must never be able to select it
 * for a write. It exists so the transition read path can open ciphertext produced before S2-D, and
 * it is retired once no identity carries legacy ciphertext.
 *
 * This duplicates `externalIdentityPolicy.mfaKey()` on purpose — that one stays where it is for the
 * legacy code path, and this one exists so the migration service does not have to import the legacy
 * policy module to get at a key.
 */
export function legacyMfaKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const hex = env.LEASEOS_PORTAL_MFA_KEY;
  return hex && HEX_64.test(hex) ? Buffer.from(hex, "hex") : null;
}

/**
 * What an operator needs to know before running or trusting the MFA migration, with no key material
 * in the answer. The names, never the values — the same discipline as `keyId` being metadata.
 */
export function mfaKeyReadiness(env: NodeJS.ProcessEnv = process.env): {
  activeConfigured: boolean;
  legacyConfigured: boolean;
  canMigrate: boolean;
  canReadLegacy: boolean;
  missing: string[];
} {
  const activeConfigured = Boolean(environmentSecretKeys(env).getActiveKey("MFA_SECRET"));
  const legacyConfigured = legacyMfaKey(env) !== null;
  const missing: string[] = [];
  if (!activeConfigured) missing.push(ACTIVE_KEY_ENV.MFA_SECRET);
  if (!legacyConfigured) missing.push("LEASEOS_PORTAL_MFA_KEY");

  return {
    activeConfigured,
    legacyConfigured,
    // Migration reads legacy and writes new, so it needs both. Either one absent means it must not
    // start — not that it should skip rows, which is how MFA silently disappears for a tenant.
    canMigrate: activeConfigured && legacyConfigured,
    canReadLegacy: legacyConfigured,
    missing,
  };
}
