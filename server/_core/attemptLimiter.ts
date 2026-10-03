/**
 * A bounded, in-process fixed-window attempt counter, for the one unauthenticated procedure
 * (`driverPortfolio.shareRedeem`). The repository has no shared rate-limit infrastructure; this is
 * the smallest thing that bounds guessing and replay without writing anything durable.
 *
 * Limitations, stated rather than hidden:
 *  - per process: N replicas allow N times the budget. A 256-bit token is not guessable at any of
 *    these rates; the limit is there to cap noise and replay, not to make the token strong.
 *  - keyed on `req.ip`. Behind a reverse proxy Express must be told to trust it (`trust proxy`),
 *    or every caller shares the proxy's address and the per-address budget becomes one shared budget
 *    — which fails closed (callers are slowed), never open.
 *  - memory is bounded: at most `maxKeys` keys; the oldest window is dropped first.
 */
export type WindowLimit = { limit: number; windowMs: number };

export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly rule: WindowLimit, private readonly maxKeys = 10_000) {}

  /** Count one attempt against `key`; false when it is over the limit for the current window. */
  take(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      if (!cur && this.hits.size >= this.maxKeys) {
        // Map preserves insertion order: the first key is the oldest window.
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
      this.hits.delete(key);
      this.hits.set(key, { count: 1, resetAt: now + this.rule.windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.rule.limit;
  }

  /** Whether `key` is already over the limit, without counting an attempt. */
  blocked(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    return !!cur && cur.resetAt > now && cur.count >= this.rule.limit;
  }

  reset(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }
}
