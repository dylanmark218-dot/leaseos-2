/**
 * v22.20 — one collector, not five hundred tablets.
 *
 * Pure. No network, no database, and no credentials.
 *
 * Alberta 511 documents ten calls per sixty seconds. That number is already in
 * the source registry, read off the developer page rather than remembered, and
 * it is the reason this exists: if every truck polled 511 directly the fleet
 * would exhaust the quota before breakfast and the company would lose the feed
 * for everyone. One server-side collector polls; devices read what it collected,
 * out of their offline package.
 *
 * Three gates, in this order, because the cheapest refusal should come first:
 *
 *   CLEARED    A source whose licence nobody has reviewed is not polled at all.
 *              Holding an API key is permission to call the API; it is not a
 *              record of what the terms permit us to do with the answer. Those
 *              are different facts and `geo.sourceReview` is where the second
 *              one is written down.
 *   DUE        Polling faster than the publisher updates is just spending quota.
 *   QUOTA      The published limit, enforced locally, so the publisher never has
 *              to enforce it against us.
 *
 * And one standing rule: what comes back is advisory. A road condition from a
 * traffic feed is real information and it is not a verified restriction — it
 * can raise a review, and it can never clear a route or become the rule that
 * blocks one. That distinction already exists in the registry as
 * `isAdvisoryOnly`; this module refuses to let a feed record cross it.
 */

/** Never a literal. The key lives in the environment and is read at the edge. */
export type FeedCredential = { present: boolean; envVar: string };

export function credentialFromEnv(envVar: string, env: Record<string, string | undefined>): FeedCredential {
  const v = env[envVar];
  return { present: typeof v === "string" && v.trim().length > 0, envVar };
}

/** What the registry says about a feed. Read from the row, never hard-coded here. */
export type FeedSource = {
  sourceKey: string;
  displayName: string;
  status: "unverified" | "verified" | "superseded" | "withdrawn";
  /**
   * The registry's commercial-use answer, carried so CLEARED can read it. `geo.sourceReview` can
   * mark a row verified while leaving this `unknown`, and `geoRouter`'s import gate already refuses
   * that combination; the collector refused only on `status`, so the same row was importable
   * nowhere and pollable here. Required, so a caller cannot forget it and get a pass.
   */
  commercialUsePermitted: "yes" | "no" | "unknown";
  rateLimitCalls: number | null;
  rateLimitWindowSeconds: number | null;
  updateIntervalHours: number | null;
  advisoryOnly: boolean;
  credentialEnvVar: string | null;
};

/** Rolling state the collector keeps per feed. */
export type FeedState = {
  /** Timestamps of calls made, newest last. Trimmed to the window on every check. */
  recentCallsAt: readonly Date[];
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
  /**
   * When the publisher said to come back, from a `Retry-After` on a refusal. None of the Canadian
   * publishers sends one today (checked 2026-10-01); a publisher that starts to is obeyed, not
   * second-guessed by our own backoff arithmetic. Optional so older state shapes still read.
   */
  notBefore?: Date | null;
};

export const emptyFeedState = (): FeedState => ({ recentCallsAt: [], lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, consecutiveFailures: 0, notBefore: null });

export type PollDecision =
  | { poll: true; reason: string; quotaRemaining: number | null }
  | { poll: false; reason: string; blockedBy: "not_cleared" | "no_credential" | "not_due" | "quota_exhausted" | "withdrawn"; retryAfterSeconds: number | null };

const windowStart = (now: Date, seconds: number) => new Date(now.getTime() - seconds * 1000);

/** Calls still inside the rate-limit window, and how many remain. */
export function quota(source: FeedSource, state: FeedState, now: Date): { used: number; limit: number | null; remaining: number | null; resetsInSeconds: number | null } {
  if (source.rateLimitCalls == null || source.rateLimitWindowSeconds == null) return { used: state.recentCallsAt.length, limit: null, remaining: null, resetsInSeconds: null };
  const from = windowStart(now, source.rateLimitWindowSeconds);
  const inWindow = state.recentCallsAt.filter(t => t.getTime() > from.getTime());
  const oldest = inWindow[0] ?? null;
  return {
    used: inWindow.length,
    limit: source.rateLimitCalls,
    remaining: Math.max(0, source.rateLimitCalls - inWindow.length),
    resetsInSeconds: oldest ? Math.max(0, Math.ceil((oldest.getTime() + source.rateLimitWindowSeconds * 1000 - now.getTime()) / 1000)) : 0,
  };
}

export function shouldPoll(source: FeedSource, state: FeedState, now: Date, credential: FeedCredential | null): PollDecision {
  if (source.status === "withdrawn" || source.status === "superseded") {
    return { poll: false, reason: `${source.displayName} is ${source.status} — it is not polled`, blockedBy: "withdrawn", retryAfterSeconds: null };
  }
  if (source.status !== "verified") {
    return {
      poll: false,
      reason: `${source.displayName} has not been cleared — holding an API key is permission to call it, not a record of what its terms permit. Clear it with a recorded licence review first.`,
      blockedBy: "not_cleared",
      retryAfterSeconds: null,
    };
  }
  if (source.commercialUsePermitted !== "yes") {
    return {
      poll: false,
      reason: `${source.displayName} is verified but its commercial use is recorded as ${source.commercialUsePermitted} — a licence review that did not answer that question has not cleared a commercial poll`,
      blockedBy: "not_cleared",
      retryAfterSeconds: null,
    };
  }
  if (source.credentialEnvVar && !credential?.present) {
    return { poll: false, reason: `No credential in ${source.credentialEnvVar} — the key belongs in the environment, never in the source tree`, blockedBy: "no_credential", retryAfterSeconds: null };
  }
  if (state.notBefore && now.getTime() < state.notBefore.getTime()) {
    const wait = Math.ceil((state.notBefore.getTime() - now.getTime()) / 1000);
    return { poll: false, reason: `The publisher asked us to wait (Retry-After) — ${wait}s remaining`, blockedBy: "quota_exhausted", retryAfterSeconds: wait };
  }
  if (source.updateIntervalHours != null && state.lastSuccessAt) {
    const dueAt = state.lastSuccessAt.getTime() + source.updateIntervalHours * 3_600_000;
    if (now.getTime() < dueAt) {
      return { poll: false, reason: `Polled ${Math.round((now.getTime() - state.lastSuccessAt.getTime()) / 60_000)} min ago; the publisher updates every ${source.updateIntervalHours} h`, blockedBy: "not_due", retryAfterSeconds: Math.ceil((dueAt - now.getTime()) / 1000) };
    }
  }
  const q = quota(source, state, now);
  if (q.remaining !== null && q.remaining <= 0) {
    return { poll: false, reason: `Published limit of ${q.limit} calls per ${source.rateLimitWindowSeconds}s reached — waiting rather than letting the publisher enforce it against us`, blockedBy: "quota_exhausted", retryAfterSeconds: q.resetsInSeconds };
  }
  return { poll: true, reason: `Due, cleared, and ${q.remaining ?? "unmetered"} call(s) left in the window`, quotaRemaining: q.remaining };
}

export function recordCall(state: FeedState, at: Date, outcome: { ok: true } | { ok: false; reason: string; retryAfterSeconds?: number | null }, source: FeedSource): FeedState {
  const keepFrom = source.rateLimitWindowSeconds ? windowStart(at, source.rateLimitWindowSeconds * 2).getTime() : 0;
  const recentCallsAt = [...state.recentCallsAt.filter(t => t.getTime() > keepFrom), at];
  return outcome.ok
    ? { recentCallsAt, lastSuccessAt: at, lastFailureAt: state.lastFailureAt, lastFailureReason: state.lastFailureReason, consecutiveFailures: 0, notBefore: null }
    : {
        recentCallsAt, lastSuccessAt: state.lastSuccessAt, lastFailureAt: at, lastFailureReason: outcome.reason, consecutiveFailures: state.consecutiveFailures + 1,
        notBefore: outcome.retryAfterSeconds && outcome.retryAfterSeconds > 0 ? new Date(at.getTime() + outcome.retryAfterSeconds * 1000) : state.notBefore ?? null,
      };
}

/* ------------------------------------------------------------------ */
/* What a feed gives us, and what it is not allowed to become           */
/* ------------------------------------------------------------------ */

export type FeedAdvisory = {
  sourceKey: string;
  externalId: string;
  kind: "road_condition" | "closure" | "incident" | "construction" | "weather_station" | "bridge_restriction" | "other";
  headline: string;
  /** Where the publisher says it applies. Never converted into a road-network edit. */
  area: { latitude: number; longitude: number } | null;
  startsAt: Date | null;
  endsAt: Date | null;
  retrievedAt: Date;
  sourceVersion: string | null;
  /** Always false for an advisory-only source, and the type does not let it be otherwise. */
  isVerifiedRestriction: false;
  determination: "advisory_only";
};

export class AdvisorySourceViolation extends Error {}

/**
 * Normalize one record. The guard is not decoration: a traffic feed saying a
 * road is closed is excellent reason to put a trip in front of a person, and it
 * is not the verified rule row that a dispatch gate is entitled to block or
 * clear a route with. Those come from a document somebody verified.
 */
export function toAdvisory(source: FeedSource, raw: Omit<FeedAdvisory, "sourceKey" | "isVerifiedRestriction" | "determination">): FeedAdvisory {
  if (!source.advisoryOnly) {
    throw new AdvisorySourceViolation(`${source.sourceKey} is not registered advisory-only; route it through the verified-rule path rather than this collector`);
  }
  return { ...raw, sourceKey: source.sourceKey, isVerifiedRestriction: false, determination: "advisory_only" };
}

/* ------------------------------------------------------------------ */
/* The one line                                                         */
/* ------------------------------------------------------------------ */

export type FeedHealth = {
  sourceKey: string;
  state: "polling" | "blocked" | "stale" | "failing" | "never_polled";
  ageMinutes: number | null;
  quotaUsed: number;
  quotaLimit: number | null;
  consecutiveFailures: number;
  /** One line, for a status bar or a log. Says what is wrong, or that nothing is. */
  line: string;
};

/**
 * One line per feed, constant, cheap, and honest about the difference between
 * "nobody has polled this" and "this is failing".
 */
export function feedHealth(source: FeedSource, state: FeedState, now: Date, credential: FeedCredential | null): FeedHealth {
  const q = quota(source, state, now);
  const ageMinutes = state.lastSuccessAt ? Math.round((now.getTime() - state.lastSuccessAt.getTime()) / 60_000) : null;
  const decision = shouldPoll(source, state, now, credential);
  const staleAfter = (source.updateIntervalHours ?? 1) * 3 * 60;

  let st: FeedHealth["state"];
  if (!decision.poll && (decision.blockedBy === "not_cleared" || decision.blockedBy === "no_credential" || decision.blockedBy === "withdrawn")) st = "blocked";
  else if (state.consecutiveFailures >= 3) st = "failing";
  else if (ageMinutes === null) st = "never_polled";
  else if (ageMinutes > staleAfter) st = "stale";
  else st = "polling";

  const quotaPart = q.limit == null ? "unmetered" : `${q.used}/${q.limit} in ${source.rateLimitWindowSeconds}s`;
  const line =
    st === "blocked" ? `${source.sourceKey}: BLOCKED — ${decision.poll ? "" : decision.reason}`
    : st === "failing" ? `${source.sourceKey}: FAILING — ${state.consecutiveFailures} consecutive failures, last "${state.lastFailureReason ?? "unstated"}" · ${quotaPart}`
    : st === "never_polled" ? `${source.sourceKey}: NEVER POLLED — cleared and due, nothing collected yet · ${quotaPart}`
    : st === "stale" ? `${source.sourceKey}: STALE — last success ${ageMinutes} min ago, expected every ${source.updateIntervalHours ?? "?"} h · ${quotaPart}`
    : `${source.sourceKey}: OK — last success ${ageMinutes} min ago · ${quotaPart}`;

  return { sourceKey: source.sourceKey, state: st, ageMinutes, quotaUsed: q.used, quotaLimit: q.limit, consecutiveFailures: state.consecutiveFailures, line };
}

/** Every feed, one line each. This is the constant signal. */
export const feedHealthLines = (
  feeds: readonly { source: FeedSource; state: FeedState; credential: FeedCredential | null }[],
  now: Date,
): string[] => feeds.map(f => feedHealth(f.source, f.state, now, f.credential).line);
