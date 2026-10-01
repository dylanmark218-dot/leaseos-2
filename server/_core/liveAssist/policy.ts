/**
 * LA-1a — Live Assist policy: LeaseOS's hard limits, and an organization's narrower choice inside them.
 *
 * Pure. The environment and the stored policy row are passed in.
 *
 * **Organization policy can only reduce.** Every numeric limit is capped by `LEASEOS_HARD_LIMITS`, and a
 * policy that asks for more is refused, not clamped: a silent clamp would let an administrator believe
 * they had set something they had not. The one-way rule is the same one `automationPolicy` applies to
 * overrides.
 *
 * **Off unless three things say on.** The deployment switch `LIVE_ASSIST_ENABLED` must be `"true"`, the
 * organization must have a policy row with `enabled`, and that row must carry a daily spend ceiling. An
 * organization that has never configured Live Assist has it off. LA-1a spends nothing, but the ceiling is
 * required now so that no organization is on at the moment the first model-calling checkpoint lands.
 *
 * **LA-1a admits only the `photo` source.** Camera, screen and video need capture code and permissions
 * that do not exist yet; a session opened for them would be a session for something unbuilt.
 */
import type { SessionLimits, SessionSource } from "./session";

export type HardLimits = SessionLimits & {
  sourcesAllowed: readonly SessionSource[];
  maxSessionsPerUserPerDay: number;
  minIdleSeconds: number;
  minRetentionHours: number;
};

export const LEASEOS_HARD_LIMITS: HardLimits = {
  sourcesAllowed: ["photo"],
  idleSeconds: 120,
  minIdleSeconds: 30,
  maxSessionMinutes: 20,
  retentionHours: 24,
  minRetentionHours: 1,
  maxSessionsPerUserPerDay: 30,
  maxFramesPerSession: 60,
  maxInferenceCallsPerSession: 40,
};

/** What an administrator may set. Every field is required: a policy is a whole statement, not a patch. */
export type PolicyInput = {
  enabled: boolean;
  sourcesAllowed: SessionSource[];
  idleSeconds: number;
  maxSessionMinutes: number;
  retentionHours: number;
  maxSessionsPerUserPerDay: number;
  dailySpendCeilingCents: number | null;
};

export type StoredPolicy = PolicyInput;

export type EffectivePolicy = {
  enabled: boolean;
  /** Why it is off, in order of what to fix first. Empty when enabled. */
  disabledBecause: ("deployment_switch_off" | "no_organization_policy" | "organization_disabled" | "no_spend_ceiling")[];
  sourcesAllowed: SessionSource[];
  limits: SessionLimits;
  maxSessionsPerUserPerDay: number;
  dailySpendCeilingCents: number | null;
};

/** The deployment kill switch. Only the exact string "true" turns it on; anything else is off. */
export function deploymentSwitchOn(env: Record<string, string | undefined>): boolean {
  return env.LIVE_ASSIST_ENABLED === "true";
}

export type PolicyViolation = { field: keyof PolicyInput; message: string };

/** Refuse, field by field, anything outside LeaseOS's hard limits. */
export function validatePolicyInput(input: PolicyInput, hard: HardLimits = LEASEOS_HARD_LIMITS): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const intIn = (field: keyof PolicyInput, v: number, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) out.push({ field, message: `must be a whole number from ${min} to ${max}` });
  };
  const extra = input.sourcesAllowed.filter(s => !hard.sourcesAllowed.includes(s));
  if (extra.length) out.push({ field: "sourcesAllowed", message: `not available in this release: ${extra.join(", ")}` });
  if (new Set(input.sourcesAllowed).size !== input.sourcesAllowed.length) out.push({ field: "sourcesAllowed", message: "must not repeat a source" });
  intIn("idleSeconds", input.idleSeconds, hard.minIdleSeconds, hard.idleSeconds);
  intIn("maxSessionMinutes", input.maxSessionMinutes, 1, hard.maxSessionMinutes);
  intIn("retentionHours", input.retentionHours, hard.minRetentionHours, hard.retentionHours);
  intIn("maxSessionsPerUserPerDay", input.maxSessionsPerUserPerDay, 1, hard.maxSessionsPerUserPerDay);
  if (input.dailySpendCeilingCents !== null) intIn("dailySpendCeilingCents", input.dailySpendCeilingCents, 1, 100_000_000);
  if (input.enabled && input.sourcesAllowed.length === 0) out.push({ field: "sourcesAllowed", message: "an enabled policy must allow at least one source" });
  return out;
}

/**
 * The policy that governs a caller now. A stored row that somehow exceeds the hard limits (written by
 * an older release, or by hand) is read through the limits, never above them.
 */
export function resolvePolicy(
  stored: StoredPolicy | null,
  env: Record<string, string | undefined>,
  hard: HardLimits = LEASEOS_HARD_LIMITS,
): EffectivePolicy {
  const disabledBecause: EffectivePolicy["disabledBecause"] = [];
  if (!deploymentSwitchOn(env)) disabledBecause.push("deployment_switch_off");
  if (!stored) disabledBecause.push("no_organization_policy");
  else {
    if (!stored.enabled) disabledBecause.push("organization_disabled");
    if (stored.dailySpendCeilingCents === null || stored.dailySpendCeilingCents <= 0) disabledBecause.push("no_spend_ceiling");
  }
  const cap = (v: number | undefined, max: number, min = 1) => Math.max(min, Math.min(max, v ?? max));
  return {
    enabled: disabledBecause.length === 0,
    disabledBecause,
    sourcesAllowed: (stored?.sourcesAllowed ?? []).filter(s => hard.sourcesAllowed.includes(s)),
    limits: {
      idleSeconds: cap(stored?.idleSeconds, hard.idleSeconds, hard.minIdleSeconds),
      maxSessionMinutes: cap(stored?.maxSessionMinutes, hard.maxSessionMinutes),
      retentionHours: cap(stored?.retentionHours, hard.retentionHours, hard.minRetentionHours),
      maxFramesPerSession: hard.maxFramesPerSession,
      maxInferenceCallsPerSession: hard.maxInferenceCallsPerSession,
    },
    maxSessionsPerUserPerDay: cap(stored?.maxSessionsPerUserPerDay, hard.maxSessionsPerUserPerDay),
    dailySpendCeilingCents: stored?.dailySpendCeilingCents ?? null,
  };
}
