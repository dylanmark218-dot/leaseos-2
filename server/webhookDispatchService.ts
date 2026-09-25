/**
 * Webhook dispatch as a service: called by the office (integration.webhookDispatch),
 * by the drain worker for the event it just processed, and by the worker's
 * heartbeat as the retry sweep. One delivery per subscription per event per
 * attempt; the transport is injectable.
 *
 * SEC-004 — claim first, send second, record third.
 *
 * Those callers can run at the same moment, in one process or several. Before this, each
 * read the latest attempt, POSTed attempt n+1, and only then inserted its row, so two of
 * them could both send attempt n+1 and the second INSERT failed on
 * UNIQUE(subscriptionId, eventId, attempt) — after the consumer had received it twice,
 * leaving one row as if it had been sent once.
 *
 * Identity: (subscriptionId, eventId) is the logical delivery; `attempt` numbers its tries,
 * one row each. The unique key is unchanged; it is now used as the claim.
 *
 * The lifecycle of an attempt row (statuses as stored):
 *
 *   (none) ──claim: INSERT status='queued' + claimedAt/claimedBy──▶ queued      in flight, owned
 *   queued ──finish (guarded by claimedBy)──▶ delivered | failed | dead
 *   queued, lease expired ──reclaim (guarded UPDATE)──▶ queued, new owner, SAME attempt
 *   failed, nextAttemptAt due ──claim attempt+1──▶ queued                     a legitimate retry
 *
 * `queued` was in the enum from 0054 and never written for webhooks until now; it means
 * "claimed and in flight", always with claimedAt set. A queued row with no claimedAt
 * (none should exist; the preflight reports any) is treated as an expired claim.
 *
 *   - CLAIM: the INSERT of the attempt row. The unique key lets exactly one worker's
 *     INSERT succeed; the others get ER_DUP_ENTRY and send nothing. It autocommits, so
 *     the claim is durable before the request leaves. No transaction spans the POST.
 *   - RECLAIM: `UPDATE … WHERE id = ? AND status = 'queued' AND (claimedAt IS NULL OR
 *     claimedAt <= leaseNow − lease)`. InnoDB re-evaluates the predicate on the locked row,
 *     so of two recoverers exactly one changes a row; the other changes none and sends
 *     nothing. The same attempt is re-sent, so the consumer sees the same
 *     x-leaseos-delivery id both times.
 *   - FINISH: `UPDATE … WHERE id = ? AND status = 'queued' AND claimedBy = <this claim>`.
 *     A worker that overran its lease and was reclaimed changes no row; its result is
 *     reported as `claim_lost` and the recovering worker's outcome stands.
 *
 * What this guarantees: at most one worker holds an attempt at a time, and a live claim is
 * never taken. What no lease can guarantee: exactly-once receipt across the network. If the
 * consumer accepts the POST and the worker dies before FINISH, the attempt is re-sent after
 * the lease with the same x-leaseos-delivery id and the same eventId in the body; consumers
 * deduplicate on either. Delivery is at-least-once, with no concurrent duplicates.
 */
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb } from "./db";
import { domainEventOutbox, webhookDeliveries, webhookSubscriptions } from "../drizzle/schema";
import { deliveryOutcome, signPayload, subscribed } from "./_core/integrationGateway";
import { decryptSecret, mfaKey } from "./_core/externalIdentityPolicy";
import { affectedRows } from "./_core/enforcementCommit";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/**
 * No single POST may take longer than this. It is what makes the lease below safe: a live
 * worker always reaches FINISH (or gives up) long before its claim can expire.
 */
export const WEBHOOK_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * How long a claim protects an in-flight attempt: 5 minutes, 30× the attempt timeout. The
 * margin covers the two DB writes around the POST, event-loop stalls in a busy worker, and
 * clock skew between worker hosts — the lease is compared across processes, each on its own
 * clock. It bounds recovery after a crash to five minutes, which sits inside the retry
 * schedule (1, 5, 30, 120, 720 min) rather than adding a new delay class to it.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number } | { error: string }>;
const defaultPoster: Poster = async (url, body, headers) => { try { const r = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(WEBHOOK_ATTEMPT_TIMEOUT_MS) }); return { status: r.status }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } };
let poster: Poster = defaultPoster;
export function setWebhookPoster(p: Poster) { poster = p; }
export function currentWebhookPoster(): Poster { return poster; }

export type DispatchResult = { attempted: number; results: { subscriptionRef: string; eventId: string; attempt: number; status: string; reason: string }[]; skipped: string | null };

/** Where a claim came from. Opaque; for audit and debugging only, never a credential. */
const DEFAULT_WORKER_ID = `${os.hostname()}:${process.pid}`.slice(0, 48);

const isDuplicateKey = (e: unknown): boolean => {
  for (let x = e as { code?: unknown; cause?: unknown } | null | undefined; x; x = x.cause as typeof x) {
    if (x.code === "ER_DUP_ENTRY") return true;
  }
  return false;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AttemptRow = typeof webhookDeliveries.$inferInsert;

/**
 * The canonical claim, in three steps. Anything that sends a webhook attempt — this
 * dispatcher today, the Integration Hub later — goes through these, so there is one
 * definition of who may send.
 */

/** CLAIM a new attempt: insert it as `queued` with the claim. Returns its id, or null if another worker holds that attempt. */
export async function claimNewAttempt(db: Db, row: Omit<AttemptRow, "status" | "claimedAt" | "claimedBy">, claim: { leaseNow: Date; token: string }): Promise<number | null> {
  try {
    const ins = await db.insert(webhookDeliveries).values({ ...row, status: "queued", claimedAt: claim.leaseNow, claimedBy: claim.token });
    return Number((ins as unknown as [{ insertId: number }])[0].insertId);
  } catch (e) {
    if (isDuplicateKey(e)) return null; // the unique (subscriptionId, eventId, attempt) says someone else has it
    throw e;
  }
}

/** RECLAIM a `queued` attempt whose lease has expired. True for exactly one of any number of concurrent callers. */
export async function reclaimExpiredAttempt(db: Db, id: number, claim: { leaseNow: Date; token: string }, patch: Partial<AttemptRow> = {}): Promise<boolean> {
  const cutoff = new Date(claim.leaseNow.getTime() - WEBHOOK_CLAIM_LEASE_MS);
  const r = await db.update(webhookDeliveries)
    .set({ ...patch, claimedAt: claim.leaseNow, claimedBy: claim.token })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "queued"), or(isNull(webhookDeliveries.claimedAt), lte(webhookDeliveries.claimedAt, cutoff))));
  return affectedRows(r) === 1;
}

/** FINISH an attempt this claim still holds. False when the claim expired and was taken over; the outcome is then not written. */
export async function finishClaimedAttempt(db: Db, id: number, token: string, outcome: Pick<AttemptRow, "status" | "responseStatus" | "error" | "nextAttemptAt"> & Partial<AttemptRow>): Promise<boolean> {
  const r = await db.update(webhookDeliveries)
    .set(outcome)
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "queued"), eq(webhookDeliveries.claimedBy, token)));
  return affectedRows(r) === 1;
}

/** Whether a `queued` attempt is still held by a live claim. */
export const claimIsLive = (row: { claimedAt: Date | null }, leaseNow: Date) => row.claimedAt !== null && row.claimedAt.getTime() > leaseNow.getTime() - WEBHOOK_CLAIM_LEASE_MS;

/** A fresh claim token for this worker: "workerId#random". Opaque; never a credential. */
export const newClaimToken = (workerId: string = DEFAULT_WORKER_ID) => `${workerId.slice(0, 48)}#${randomBytes(6).toString("hex")}`;

type DispatchArgs = {
  maxEvents?: number;
  /** The scheduling clock: backoff and due-ness. Callers (and tests) may supply it. */
  now?: Date;
  /** The lease clock. Real time unless a test supplies it; never taken from a request, so a caller-supplied `now` cannot expire a live claim. */
  leaseNow?: Date;
  workerId?: string;
  eventIds?: string[];
  orgRef?: string;
};

export async function dispatchWebhooks(args: DispatchArgs = {}): Promise<DispatchResult> {
  const db = await getDb();
  if (!db) return { attempted: 0, results: [], skipped: "database unavailable" };
  const key = mfaKey();
  if (!key) return { attempted: 0, results: [], skipped: "LEASEOS_PORTAL_MFA_KEY not configured — secrets cannot be read; nothing sent" };
  const now = args.now ?? new Date();
  const leaseNow = args.leaseNow ?? new Date();
  const workerId = args.workerId ?? DEFAULT_WORKER_ID;
  const subs = args.orgRef
    ? await db.select().from(webhookSubscriptions).where(and(eq(webhookSubscriptions.status, "active"), eq(webhookSubscriptions.orgRef, args.orgRef)))
    : await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.status, "active"));
  if (!subs.length) return { attempted: 0, results: [], skipped: null };
  const events = args.eventIds?.length ? await db.select().from(domainEventOutbox).where(inArray(domainEventOutbox.eventId, args.eventIds)) : await db.select().from(domainEventOutbox).orderBy(desc(domainEventOutbox.id)).limit(args.maxEvents ?? 100);
  const results: DispatchResult["results"] = [];
  for (const s of subs) {
    const types = JSON.parse(s.eventTypesJson) as string[];
    // Decrypted on first use, not up front: a subscription whose secret cannot be read is
    // skipped on its own instead of aborting dispatch for every other subscription.
    let secret: string | null | undefined;
    const secretFor = () => {
      if (secret === undefined) {
        try { secret = decryptSecret(s.secretEnc, key); } catch { secret = null; console.warn(`[webhooks] ${s.subscriptionRef}: signing secret cannot be decrypted with the configured key; skipped`); }
      }
      return secret;
    };
    for (const ev of events) {
      // A subscription may only receive outbox events from its own tenant.
      if (!s.orgRef || ev.tenantId !== s.orgRef) continue;
      if (!subscribed(types, ev.eventType)) continue;
      const prior = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, s.id), eq(webhookDeliveries.eventId, ev.eventId))).orderBy(desc(webhookDeliveries.attempt));
      const last = prior[0];
      if (last && (last.status === "delivered" || last.status === "dead")) continue;
      if (last && last.status === "failed" && last.nextAttemptAt && now < last.nextAttemptAt) continue;
      if (last && last.status === "queued" && claimIsLive(last, leaseNow)) continue; // someone holds it

      const signingSecret = secretFor();
      if (signingSecret === null) continue;
      const body = JSON.stringify({ eventId: ev.eventId, eventType: ev.eventType, version: ev.eventVersion, aggregate: { type: ev.aggregateType, id: ev.aggregateId }, occurredAt: ev.occurredAt, payload: JSON.parse(ev.payloadJson) });
      const timestamp = Math.floor(now.getTime() / 1000);
      const signature = signPayload(signingSecret, timestamp, body);
      const claim = { leaseNow, token: newClaimToken(workerId) };

      // CLAIM. Either a new attempt row, or the takeover of an expired one.
      let rowId: number;
      let attempt: number;
      if (last && last.status === "queued") {
        if (!(await reclaimExpiredAttempt(db, last.id, claim, { requestHash: sha(body), signature, at: now }))) continue; // another recoverer took it first
        rowId = last.id;
        attempt = last.attempt;
      } else {
        attempt = (last?.attempt ?? 0) + 1;
        const id = await claimNewAttempt(db, { orgRef: s.orgRef, deliveryRef: ref("DLV"), subscriptionId: s.id, eventId: ev.eventId, eventType: ev.eventType, attempt, requestHash: sha(body), signature, at: now }, claim);
        if (id === null) continue; // another worker claimed this attempt; it sends, we do not
        rowId = id;
      }

      // SEND. Outside any transaction; bounded by WEBHOOK_ATTEMPT_TIMEOUT_MS in the default transport.
      const r = await poster(s.url, body, { "content-type": "application/json", "x-leaseos-timestamp": String(timestamp), "x-leaseos-signature": signature, "x-leaseos-event": ev.eventType, "x-leaseos-delivery": `${s.subscriptionRef}:${ev.eventId}:${attempt}` });
      const outcome = deliveryOutcome({ attempt, responseStatus: "status" in r ? r.status : null, error: "error" in r ? r.error : null, at: now });

      // RECORD, only if the claim is still ours.
      const recorded = await finishClaimedAttempt(db, rowId, claim.token, { status: outcome.status, responseStatus: "status" in r ? r.status : null, error: "error" in r ? r.error.slice(0, 400) : null, nextAttemptAt: outcome.nextAttemptAt });
      if (!recorded) {
        console.warn(`[webhooks] ${s.subscriptionRef}:${ev.eventId}:${attempt} finished after its claim expired and was taken over; outcome (${outcome.status}) not recorded`);
        results.push({ subscriptionRef: s.subscriptionRef, eventId: ev.eventId, attempt, status: "claim_lost", reason: `claim expired before the outcome (${outcome.reason}) was recorded; the worker that took it over records the attempt` });
        continue;
      }
      results.push({ subscriptionRef: s.subscriptionRef, eventId: ev.eventId, attempt, status: outcome.status, reason: outcome.reason });
    }
  }
  return { attempted: results.length, results, skipped: null };
}

/**
 * The retry sweep: every failed delivery whose next attempt is due, and every claim whose
 * lease has expired. The worker sweeps every tenant; `orgRef` narrows it to one.
 */
export async function sweepWebhookRetries(now: Date = new Date(), opts: { leaseNow?: Date; workerId?: string; orgRef?: string } = {}): Promise<DispatchResult> {
  const db = await getDb();
  if (!db) return { attempted: 0, results: [], skipped: "database unavailable" };
  const leaseCutoff = new Date((opts.leaseNow ?? new Date()).getTime() - WEBHOOK_CLAIM_LEASE_MS);
  const due = await db.select({ eventId: webhookDeliveries.eventId }).from(webhookDeliveries).where(and(
    or(
      eq(webhookDeliveries.status, "failed"),
      and(eq(webhookDeliveries.status, "queued"), or(isNull(webhookDeliveries.claimedAt), lte(webhookDeliveries.claimedAt, leaseCutoff))),
    ),
    opts.orgRef ? eq(webhookDeliveries.orgRef, opts.orgRef) : undefined,
  ));
  const ids = Array.from(new Set(due.map(d => d.eventId)));
  if (!ids.length) return { attempted: 0, results: [], skipped: null };
  return dispatchWebhooks({ eventIds: ids, now, leaseNow: opts.leaseNow, workerId: opts.workerId, orgRef: opts.orgRef });
}
