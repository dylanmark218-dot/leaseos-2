/**
 * Integration Hub — sync-run planning.
 *
 * A sync run walks pages under a cursor. The one rule that matters: the
 * checkpoint advances only in the same transaction as the writes it stands
 * for. A crash between pages resumes from the last committed cursor, and the
 * page that gets fetched twice is harmless because every record is idempotent
 * by its contract key.
 */
export type SyncPage<T = unknown> = { records: T[]; nextCursor: string | null; done: boolean };
export type SyncAdapter<T = unknown> = {
  /** Fetch one page after `cursor`. Throws or returns a refusal; never both. */
  fetchPage: (args: { cursor: string | null; pageSize: number; signal?: AbortSignal }) => Promise<SyncPage<T> | { refused: string; retryable: boolean; httpStatus?: number | null; retryAfter?: string | null }>;
};

export type PageOutcome = { examined: number; accepted: number; rejected: number; changed: number; unchanged: number };
export const emptyPageOutcome = (): PageOutcome => ({ examined: 0, accepted: 0, rejected: 0, changed: 0, unchanged: 0 });
export function addOutcome(a: PageOutcome, b: PageOutcome): PageOutcome { return { examined: a.examined + b.examined, accepted: a.accepted + b.accepted, rejected: a.rejected + b.rejected, changed: a.changed + b.changed, unchanged: a.unchanged + b.unchanged }; }

/** May the cursor move from `committed` to `candidate` after this page? Only when the page's work is committed and the cursor actually moved. */
export function cursorAdvance(args: { committed: string | null; candidate: string | null; pageCommitted: boolean }): { advance: boolean; reason: string } {
  if (!args.pageCommitted) return { advance: false, reason: "the page's writes were not committed" };
  if (args.candidate == null) return { advance: false, reason: "the provider gave no next cursor" };
  if (args.candidate === args.committed) return { advance: false, reason: "cursor unchanged" };
  return { advance: true, reason: "page committed" };
}

/** A page limit so a runaway provider cannot keep one run alive forever; the run resumes on its next tick. */
export const MAX_PAGES_PER_RUN = 50;

export function nextScheduledSync(now: Date, intervalSeconds: number | null): Date | null {
  return intervalSeconds && intervalSeconds > 0 ? new Date(now.getTime() + intervalSeconds * 1000) : null;
}
