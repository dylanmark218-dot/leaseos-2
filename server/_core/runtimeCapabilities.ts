/**
 * S2-FLEET-A — the capabilities a running instance declares, as a closed vocabulary.
 *
 * A fleet gate compares what is running against what a change needs. It must compare NAMES OF
 * BEHAVIOUR, not commit ids: two different builds can both understand the canonical webhook secret
 * reference, and gating on one specific sha would block the second for no reason (and would make a
 * hotfix look like an incompatible fleet). So each instance registers the capabilities its build
 * implements, and the preflight asks whether every live instance declares the ones the cutover needs.
 *
 * The vocabulary is small and central on purpose. There is no free-text capability, no feature-flag
 * framework and no runtime toggle: a capability is a fact about the code in the build, declared by
 * the build, and a string this file does not name is not a capability (`parseCapabilities` reports
 * it as unknown rather than counting it).
 */

export const RUNTIME_CAPABILITY = {
  /**
   * The webhook signing path understands the canonical secret reference (`webhookSubscriptions.secretRef`):
   * a reference, when present, is the authority and wins over legacy ciphertext, and a reference that
   * is present but does not resolve fails closed instead of falling back. This is the behaviour
   * `webhookSecretService.resolveWebhookSigningSecret` has had since S2-E Phase 1, and it is what the
   * Phase 2B cutover (canonical-only writes) requires of every instance that may sign a delivery.
   */
  webhookSecretRefRead: "webhook-secret-ref-read",
} as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITY)[keyof typeof RUNTIME_CAPABILITY];

/** Every capability this build implements. The build declares all it names; there is no partial build. */
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = Object.freeze(Object.values(RUNTIME_CAPABILITY));

/** What the S2-E Phase 2B cutover requires of EVERY live instance. */
export const WEBHOOK_CUTOVER_REQUIRED_CAPABILITIES: readonly RuntimeCapability[] = Object.freeze([
  RUNTIME_CAPABILITY.webhookSecretRefRead,
]);

export function isRuntimeCapability(value: unknown): value is RuntimeCapability {
  return typeof value === "string" && (RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

/** The capabilities this process registers. A function, so the declaration is read at registration, not at import. */
export function declaredCapabilities(): readonly RuntimeCapability[] {
  return RUNTIME_CAPABILITIES;
}

export type ParsedCapabilities = {
  /** Strings in the vocabulary, deduplicated, in vocabulary order. */
  capabilities: RuntimeCapability[];
  /** Strings an instance declared that this build does not know. Reported, never counted. */
  unknown: string[];
};

/**
 * A stored declaration, read defensively. Returns null when the stored value is not a JSON array of
 * strings — an instance whose declaration cannot be read declares nothing.
 */
export function parseCapabilities(json: string): ParsedCapabilities | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) return null;
  const declared = new Set(parsed);
  return {
    capabilities: RUNTIME_CAPABILITIES.filter(c => declared.has(c)),
    // `Array.from`, not spread: this tsconfig has no ES2015 target, so a Set cannot be spread.
    unknown: Array.from(declared).filter(v => !isRuntimeCapability(v)).sort(),
  };
}
