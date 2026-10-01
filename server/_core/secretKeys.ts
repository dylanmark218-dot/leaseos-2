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
import {
  ManagedKeyBootstrapError,
  assertNoRawKeyMaterial,
  loadManagedSecretKeyProvider,
  type ManagedKeyBackend,
  type ManagedKeyConfig,
  type ManagedSecretKeyProvider,
} from "./managedSecretKeys";

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

/* ------------------------------------------------------------------ S2-KMS-A: the production source */

/**
 * Where a process gets its keys from. `"environment"` is the S2-A..E provider above — development,
 * test and controlled staging. `"managed"` is the bootstrap in `managedSecretKeys.ts`: wrapped
 * references in configuration, unwrapped once at startup by a managed backend, and the only way a
 * production write can happen (OWNER DECISION S2-1).
 *
 * Unset means `"environment"`, deliberately: every deployment that exists today has environment
 * keys and no managed backend, and this checkpoint ships no adapter. The switch is explicit so
 * that turning it on is a configuration act with a name, and so that once it is on there is no
 * path back to environment keys inside the process — see `secretKeyProvider()`.
 */
export type SecretKeySource = "environment" | "managed";

export function secretKeySource(env: NodeJS.ProcessEnv = process.env): SecretKeySource {
  const v = env.LEASEOS_SECRET_KEYS_SOURCE;
  if (v === undefined || v === "" || v === "environment") return "environment";
  if (v === "managed") return "managed";
  throw new Error(`LEASEOS_SECRET_KEYS_SOURCE must be "environment" or "managed" (was ${JSON.stringify(v)})`);
}

/**
 * The managed configuration, parsed and refused if it carries anything but references.
 * `LEASEOS_MANAGED_KEYS` is JSON of `ManagedKeyConfig`: a backend name, and per purpose an active
 * and zero or more retired `{ keyId, wrapped, backendKeyRef }` entries. Raw 64-hex key material
 * anywhere in it is refused before parsing finishes.
 */
export function managedKeyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ManagedKeyConfig {
  const raw = env.LEASEOS_MANAGED_KEYS;
  if (!raw) throw new ManagedKeyBootstrapError("LEASEOS_MANAGED_KEYS is not set", "config_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManagedKeyBootstrapError("LEASEOS_MANAGED_KEYS is not valid JSON", "config_shape");
  }
  assertNoRawKeyMaterial(parsed, "LEASEOS_MANAGED_KEYS");
  return parsed as ManagedKeyConfig;
}

/**
 * The backends a production build can name. EMPTY, and honestly so: the hosting survey for
 * S2-KMS-A found no evidence of the production platform, so no vendor adapter exists yet. A
 * `"managed"` source therefore fails the bootstrap in production today — which is the correct
 * answer, not a gap to paper over. S2-KMS-B adds the adapter for the platform once it is proven.
 * Tests supply their own backend through `resolveSecretKeyProvider`'s second argument; nothing
 * registers a backend here at runtime.
 */
export function productionManagedKeyBackends(): Record<string, ManagedKeyBackend> {
  return {};
}

export type ResolvedSecretKeys = {
  provider: SecretKeyProvider;
  source: SecretKeySource;
  /** The backend that unwrapped the keys, when managed. */
  backend: string | null;
};

/**
 * Build the provider the configuration asks for. Asynchronous because the managed path is; the
 * environment path simply resolves. Never falls back: a managed source whose bootstrap fails
 * throws, and the caller — startup, the worker, an operational script — is expected to stop.
 */
export async function resolveSecretKeyProvider(
  env: NodeJS.ProcessEnv = process.env,
  backends: Record<string, ManagedKeyBackend> = productionManagedKeyBackends(),
  options: { require?: SecretPurpose[] } = {}
): Promise<ResolvedSecretKeys> {
  const source = secretKeySource(env);
  if (source === "environment") return { provider: environmentSecretKeys(env), source, backend: null };

  const config = managedKeyConfigFromEnv(env);
  const backend = backends[config.backend];
  if (!backend) {
    throw new ManagedKeyBootstrapError(
      `no managed key backend named ${JSON.stringify(config.backend)} exists in this build (available: ${Object.keys(backends).join(", ") || "none"})`,
      "backend_unknown"
    );
  }
  const provider: ManagedSecretKeyProvider = await loadManagedSecretKeyProvider({ config, backend, require: options.require });
  return { provider, source, backend: provider.backend };
}

/* The one provider this process serves crypto from, once bootstrapped. */
let installed: ResolvedSecretKeys | null = null;

/**
 * Bootstrap once per process, before anything can accept work: `startup.ts` (server) and
 * `worker.ts` (standalone worker) both call this first, so the two can never disagree about where
 * keys come from. A second call returns the same provider; it never re-contacts the backend.
 */
export async function bootstrapSecretKeys(
  env: NodeJS.ProcessEnv = process.env,
  backends: Record<string, ManagedKeyBackend> = productionManagedKeyBackends(),
  options: { require?: SecretPurpose[] } = {}
): Promise<ResolvedSecretKeys> {
  if (installed) return installed;
  installed = await resolveSecretKeyProvider(env, backends, options);
  return installed;
}

/**
 * The synchronous accessor every call site uses. Three cases, and the third is the point:
 *
 *   bootstrapped                            → the installed provider, whatever its kind;
 *   not bootstrapped, source "environment"  → the environment provider (tests, scripts, dev);
 *   not bootstrapped, source "managed"      → THROW. A process configured for managed keys that
 *                                             reaches a crypto call without having bootstrapped is
 *                                             misordered or has failed startup; handing it
 *                                             environment keys here would be the silent fallback
 *                                             this checkpoint exists to make impossible.
 */
export function secretKeyProvider(env: NodeJS.ProcessEnv = process.env): SecretKeyProvider {
  if (installed) return installed.provider;
  if (secretKeySource(env) === "managed") {
    throw new ManagedKeyBootstrapError("managed secret keys are configured but have not been bootstrapped in this process", "not_bootstrapped");
  }
  return environmentSecretKeys(env);
}

/** What was installed, for readiness reports. Null until bootstrap. */
export function installedSecretKeys(): ResolvedSecretKeys | null {
  return installed;
}

/** Tests only: forget the installed provider so the next bootstrap runs again. */
export function resetSecretKeysForTests(): void {
  installed = null;
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
