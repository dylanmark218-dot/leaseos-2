/**
 * v22.20 (0081) — one process, every feed, on the publisher's own cadence.
 *
 * Pure orchestration. The scheduler decides *when*; `feedCollector` decides
 * *whether*; `feedIngest` decides *what happened*. Keeping those apart is what
 * lets the quota rule be tested without a clock and the backoff be tested
 * without a network.
 *
 * Backoff sits here rather than in the collector because it is about this
 * process being polite after a failure, not about the publisher's published
 * limit. A feed that has failed four times running should not be hammered every
 * minute; it should be left alone for a while and said to be failing.
 */

import { feedHealth, type FeedCredential, type FeedSource, type FeedState } from "./feedCollector";
import { runLine, type FeedRun } from "./feedIngest";

export type BackoffPolicy = { baseSeconds: number; factor: number; maxSeconds: number };
export const DEFAULT_BACKOFF: BackoffPolicy = { baseSeconds: 60, factor: 2, maxSeconds: 3600 };

/** How long this process should hold off after consecutive failures. */
export function backoffSeconds(consecutiveFailures: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(policy.maxSeconds, Math.round(policy.baseSeconds * policy.factor ** (consecutiveFailures - 1)));
}

export function inBackoff(state: FeedState, now: Date, policy: BackoffPolicy = DEFAULT_BACKOFF): { held: boolean; secondsRemaining: number } {
  const seconds = backoffSeconds(state.consecutiveFailures, policy);
  if (!seconds || !state.lastFailureAt) return { held: false, secondsRemaining: 0 };
  const until = state.lastFailureAt.getTime() + seconds * 1000;
  const remaining = Math.ceil((until - now.getTime()) / 1000);
  return remaining > 0 ? { held: true, secondsRemaining: remaining } : { held: false, secondsRemaining: 0 };
}

export type ScheduledFeed = { source: FeedSource; state: FeedState; credential: FeedCredential | null };

export type TickResult = {
  at: Date;
  polled: string[];
  heldInBackoff: { sourceKey: string; secondsRemaining: number }[];
  /** One line per feed, every tick. The constant signal. */
  lines: string[];
};

/**
 * One pass over every registered feed. `ingest` is injected so the scheduler is
 * testable and so a tick can be driven by a cron, a worker heartbeat or a test.
 */
export async function tick(args: {
  feeds: readonly ScheduledFeed[];
  now: Date;
  policy?: BackoffPolicy;
  ingest: (feed: ScheduledFeed) => Promise<{ run: FeedRun; state: FeedState }>;
}): Promise<{ result: TickResult; feeds: ScheduledFeed[] }> {
  const policy = args.policy ?? DEFAULT_BACKOFF;
  const polled: string[] = [];
  const heldInBackoff: TickResult["heldInBackoff"] = [];
  const next: ScheduledFeed[] = [];
  const lines: string[] = [];

  for (const feed of args.feeds) {
    const hold = inBackoff(feed.state, args.now, policy);
    if (hold.held) {
      heldInBackoff.push({ sourceKey: feed.source.sourceKey, secondsRemaining: hold.secondsRemaining });
      next.push(feed);
      lines.push(`${feed.source.sourceKey}: BACKOFF — ${feed.state.consecutiveFailures} consecutive failures, holding ${hold.secondsRemaining}s`);
      continue;
    }
    const { run, state } = await args.ingest(feed);
    polled.push(feed.source.sourceKey);
    next.push({ ...feed, state });
    lines.push(runLine(run));
  }

  // The health line comes after the run line, so a tick shows both what just
  // happened and where the feed now stands.
  for (const feed of next) lines.push(feedHealth(feed.source, feed.state, args.now, feed.credential).line);
  return { result: { at: args.now, polled, heldInBackoff, lines }, feeds: next };
}
