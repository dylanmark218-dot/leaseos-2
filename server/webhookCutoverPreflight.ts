/**
 * S2-E Phase 2A — the cutover preflight: five independent answers, and no single boolean that
 * could be green while one of them is not.
 *
 * Release 2 of the webhook secret migration (E-C, canonical-only writes from `webhookSubscribe`)
 * changes what a new subscription row looks like. Whether that change is safe is not one question
 * but five, each answered by a different part of the system, and each able to be the one that is
 * not ready:
 *
 *   fleet                    every running server and worker understands `secretRef`
 *   webhookData              the rows that exist can all be signed for, and none still needs the
 *                            legacy key while enabled
 *   managedKeyProvider       the provider production would write under reports `"managed"` and
 *                            holds an active WEBHOOK_SECRET key
 *   existingCanonicalSecrets every reference already in the table resolves
 *   productionCanonicalWrite the write production will perform is not refused by OWNER DECISION S2-1
 *
 * `cutoverAllowed` is the conjunction and nothing more — it is derived, never stored, and every
 * blocker that made it false is listed beside it. A report that said only "not ready" would send an
 * operator looking in five places; one that said only "ready" would be trusted in exactly the case
 * where it was wrong.
 *
 * THE FLEET ANSWER IS "NOT PROVABLE", AND THIS MODULE CANNOT SAY OTHERWISE. LeaseOS exposes no
 * per-instance build identity: `/healthz` and `/readyz` answer one `status` field by contract, the
 * worker's heartbeat carries no version, and `LEASEOS_RELEASE` is a file in the repository, not an
 * observation of what is running. Until a mechanism exists that observes the fleet, there is no
 * input to this function that can mark the fleet compatible — deliberately. A parameter for "the
 * operator says it is converged" would be the fake boolean the design forbids. The convergence
 * confirmation in `WEBHOOK_SECRET_PHASE1_DEPLOYMENT_EVIDENCE.md` is where a human records what they
 * established and how; it is evidence for a person, not an input to code.
 *
 * NOTHING HERE RETURNS A SECRET. Resolution runs through `probeWebhookSigningSecret`, which
 * discards the value; the write probe persists nothing; counts and reference *categories* are the
 * only per-row output, never a `secretRef`.
 */
import { and, asc, gt, inArray, isNotNull, or, eq } from "drizzle-orm";
import { getDb } from "./db";
import { webhookSubscriptions } from "../drizzle/schema";
import {
  probeWebhookCanonicalWrite,
  probeWebhookSigningSecret,
  webhookSecretStorageOf,
  type WebhookSecretRefusal,
} from "./webhookSecretService";
import { webhookSecretReadiness, type WebhookReadinessScope, type WebhookSecretReadiness } from "./webhookSecretMigration";
import { environmentSecretKeys, legacyMfaKey } from "./_core/secretKeys";
import type { SecretKeyProvider } from "./_core/secretCrypto";

export type FleetConvergence =
  /** Produced today: no runtime mechanism observes which build each instance runs. */
  | { state: "not_provable"; reason: string }
  /** Reserved for the mechanism that will observe the fleet. Nothing produces these yet. */
  | { state: "compatible"; observedBy: string }
  | { state: "incompatible"; observedBy: string; reason: string };

/** One unsignable subscription, by reference category. Never a secret, never a `secretRef`. */
export type UnresolvableSubscription = {
  subscriptionRef: string;
  status: "active" | "paused" | "revoked";
  storage: "none" | "legacy" | "transitional" | "canonical";
  refusal: WebhookSecretRefusal;
};

export type WebhookDataReadiness = {
  ready: boolean;
  counts: WebhookSecretReadiness;
  /** Enabled subscriptions the compatibility reader cannot sign for, whatever their storage. */
  enabledUnresolvable: UnresolvableSubscription[];
  blockers: string[];
};

export type ManagedKeyProviderReadiness = {
  ready: boolean;
  kind: SecretKeyProvider["kind"];
  /** Metadata only: the id the next envelope would carry, or null when no key is active. */
  activeWebhookKeyId: string | null;
  blockers: string[];
};

export type ExistingCanonicalSecretsReadiness = {
  resolvable: boolean;
  /** Rows carrying a `secretRef`, any status. */
  checked: number;
  unresolvable: UnresolvableSubscription[];
};

export type ProductionCanonicalWrite =
  | { possible: true; keyId: string }
  | { possible: false; reason: string };

export type WebhookCutoverPreflight = {
  fleet: FleetConvergence;
  webhookData: WebhookDataReadiness;
  managedKeyProvider: ManagedKeyProviderReadiness;
  existingCanonicalSecrets: ExistingCanonicalSecretsReadiness;
  productionCanonicalWrite: ProductionCanonicalWrite;
  /** Derived: every component ready. Never true while `blockers` is non-empty. */
  cutoverAllowed: boolean;
  blockers: string[];
};

export type PreflightArgs = {
  /** The provider production would write under. */
  keys: SecretKeyProvider;
  /** `LEASEOS_PORTAL_MFA_KEY`, decrypt-only; needed while any enabled row is still legacy. */
  legacyKey: Buffer | null;
  scope?: WebhookReadinessScope;
  /** Rows per scan page. */
  pageSize?: number;
};

const FLEET_NOT_PROVABLE: FleetConvergence = {
  state: "not_provable",
  reason:
    "no runtime mechanism reports which build each server or worker instance is running: " +
    "/healthz and /readyz carry a single status field, the worker heartbeat carries no build identity, " +
    "and LEASEOS_RELEASE is a repository file rather than an observation of the fleet",
};

async function database() {
  const db = await getDb();
  if (!db) throw new Error("webhook cutover preflight unavailable: no database connection");
  return db;
}

/**
 * Walk every row that is enabled or carries a reference, in id order, a page at a time. Keyset
 * pagination rather than OFFSET: the table is live, and an offset over rows that are being
 * repointed underneath the scan would skip some and visit others twice.
 */
async function scanSubscriptions(args: PreflightArgs) {
  const db = await database();
  const pageSize = args.pageSize ?? 200;
  const within = args.scope?.orgRefs ? inArray(webhookSubscriptions.orgRef, args.scope.orgRefs) : undefined;
  const k = { keys: args.keys, legacyKey: args.legacyKey, isProduction: true };

  const enabledUnresolvable: UnresolvableSubscription[] = [];
  const canonicalUnresolvable: UnresolvableSubscription[] = [];
  let canonicalChecked = 0;
  let lastId = 0;

  for (;;) {
    const rows = await db
      .select({
        id: webhookSubscriptions.id,
        subscriptionRef: webhookSubscriptions.subscriptionRef,
        status: webhookSubscriptions.status,
        secretEnc: webhookSubscriptions.secretEnc,
        secretRef: webhookSubscriptions.secretRef,
      })
      .from(webhookSubscriptions)
      .where(
        and(
          gt(webhookSubscriptions.id, lastId),
          or(eq(webhookSubscriptions.status, "active"), isNotNull(webhookSubscriptions.secretRef)),
          within
        )
      )
      .orderBy(asc(webhookSubscriptions.id))
      .limit(pageSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      const probe = await probeWebhookSigningSecret(row, k);
      if (row.secretRef) canonicalChecked += 1;
      if (probe.resolvable) continue;
      const entry: UnresolvableSubscription = {
        subscriptionRef: row.subscriptionRef,
        status: row.status,
        storage: webhookSecretStorageOf(row),
        refusal: probe.refusal,
      };
      if (row.status === "active") enabledUnresolvable.push(entry);
      if (row.secretRef) canonicalUnresolvable.push(entry);
    }
    if (rows.length < pageSize) break;
  }

  return { enabledUnresolvable, canonicalUnresolvable, canonicalChecked };
}

export async function webhookCutoverPreflight(args: PreflightArgs): Promise<WebhookCutoverPreflight> {
  const counts = await webhookSecretReadiness(args.scope);
  const scan = await scanSubscriptions(args);

  /* ---------------------------------------------------------------- webhook data */
  const dataBlockers: string[] = [];
  if (counts.enabledLegacyOnly > 0) {
    dataBlockers.push(`${counts.enabledLegacyOnly} enabled subscription(s) still sign from legacy ciphertext; run the backfill`);
  }
  if (counts.enabledUnsignable > 0) {
    dataBlockers.push(`${counts.enabledUnsignable} enabled subscription(s) hold neither representation and cannot sign`);
  }
  if (counts.canonicalOnly > 0) {
    // Nothing in Release 1 produces this state. Its presence means Release 2 already began
    // somewhere, or a row was written by hand — either way, not a database to cut over on top of.
    dataBlockers.push(`${counts.canonicalOnly} canonical-only row(s) exist before cutover; Release 1 never writes that state`);
  }
  if (scan.enabledUnresolvable.length > 0) {
    dataBlockers.push(`${scan.enabledUnresolvable.length} enabled subscription(s) cannot be signed for under the compatibility reader`);
  }
  const webhookData: WebhookDataReadiness = {
    ready: dataBlockers.length === 0,
    counts,
    enabledUnresolvable: scan.enabledUnresolvable,
    blockers: dataBlockers,
  };

  /* ---------------------------------------------------------------- key provider */
  const providerBlockers: string[] = [];
  let activeWebhookKeyId: string | null = null;
  try {
    activeWebhookKeyId = args.keys.getActiveKey("WEBHOOK_SECRET")?.keyId ?? null;
  } catch (error) {
    providerBlockers.push(`key provider unavailable: ${error instanceof Error ? error.message : "provider failed"}`);
  }
  if (args.keys.kind !== "managed") {
    providerBlockers.push(
      `key provider kind is "${args.keys.kind}"; production canonical writes require a managed key provider (OWNER DECISION S2-1)`
    );
  }
  if (activeWebhookKeyId === null && providerBlockers.every(b => !b.startsWith("key provider unavailable"))) {
    providerBlockers.push("no active WEBHOOK_SECRET key is configured");
  }
  const managedKeyProvider: ManagedKeyProviderReadiness = {
    ready: providerBlockers.length === 0,
    kind: args.keys.kind,
    activeWebhookKeyId,
    blockers: providerBlockers,
  };

  /* ---------------------------------------------------------------- existing references */
  const existingCanonicalSecrets: ExistingCanonicalSecretsReadiness = {
    resolvable: scan.canonicalUnresolvable.length === 0,
    checked: scan.canonicalChecked,
    unresolvable: scan.canonicalUnresolvable,
  };

  /* ---------------------------------------------------------------- the production write */
  const productionCanonicalWrite: ProductionCanonicalWrite = probeWebhookCanonicalWrite(args.keys);

  /* ---------------------------------------------------------------- the verdict */
  const fleet = FLEET_NOT_PROVABLE;
  const blockers: string[] = [];
  if (fleet.state !== "compatible") blockers.push(`fleet convergence ${fleet.state.replace("_", " ")}: ${fleet.reason}`);
  blockers.push(...webhookData.blockers.map(b => `webhook data: ${b}`));
  blockers.push(...managedKeyProvider.blockers.map(b => `key provider: ${b}`));
  if (!existingCanonicalSecrets.resolvable) {
    blockers.push(`existing canonical secrets: ${existingCanonicalSecrets.unresolvable.length} reference(s) do not resolve`);
  }
  if (!productionCanonicalWrite.possible) blockers.push(`production canonical write refused: ${productionCanonicalWrite.reason}`);

  return {
    fleet,
    webhookData,
    managedKeyProvider,
    existingCanonicalSecrets,
    productionCanonicalWrite,
    cutoverAllowed: blockers.length === 0,
    blockers,
  };
}

/** The preflight as production would run it: the environment's provider and legacy key. */
export function webhookCutoverPreflightFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  scope?: WebhookReadinessScope
): Promise<WebhookCutoverPreflight> {
  return webhookCutoverPreflight({ keys: environmentSecretKeys(env), legacyKey: legacyMfaKey(env), scope });
}
