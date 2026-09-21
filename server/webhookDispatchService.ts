/**
 * Webhook dispatch as a service: called by the office (integration.webhookDispatch),
 * by the drain worker for the event it just processed, and by the worker's
 * heartbeat as the retry sweep. One delivery per subscription per event per
 * attempt; the transport is injectable.
 */
import { createHash, } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { domainEventOutbox, webhookDeliveries, webhookSubscriptions } from "../drizzle/schema";
import { deliveryOutcome, signPayload, subscribed } from "./_core/integrationGateway";
import { decryptSecret, mfaKey } from "./_core/externalIdentityPolicy";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number } | { error: string }>;
let poster: Poster = async (url, body, headers) => { try { const r = await fetch(url, { method: "POST", body, headers }); return { status: r.status }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } };
export function setWebhookPoster(p: Poster) { poster = p; }

export type DispatchResult = { attempted: number; results: { subscriptionRef: string; eventId: string; attempt: number; status: string; reason: string }[]; skipped: string | null };

/**
 * The reason recorded when a subscription's own secret cannot be read.
 *
 * Deliberately says nothing about the subscription beyond the fact — no url, no name, no
 * organization — because this string is written to a delivery row and read back by people.
 */
export const SECRET_UNREADABLE = "subscription secret could not be decrypted with the configured server key";

/**
 * Dispatch, tenant first.
 *
 * **The invariant: filter by tenant, THEN decrypt.** LeaseOS must never need to decrypt tenant
 * B's subscription secret in order to dispatch tenant A's event. Until now it did: every active
 * subscription in the table was loaded and `decryptSecret` was called on all of them at the top
 * of the loop, and only afterwards did `ev.tenantId !== s.orgRef` decide which ones were even
 * relevant. One foreign row — or one row left from a key rotation — threw, and the throw took the
 * whole dispatch with it, including every valid subscription belonging to the tenant whose event
 * this was.
 *
 * Two changes close that:
 *
 *   scoping moved into the QUERY  the events are loaded first, their `tenantId` values are the
 *                                 only organizations whose subscriptions are selected at all, and
 *                                 an explicit `orgRef` narrows that further. A subscription
 *                                 belonging to anybody else is never read, so it can never be
 *                                 decrypted. A subscription with a NULL `orgRef` is inert and is
 *                                 excluded by the same `inArray`, which is what the old
 *                                 `!s.orgRef` guard did one step too late.
 *
 *   decryption made lazy          a secret is read at most once per subscription, and only when
 *                                 an event of that subscription's OWN tenant is actually due for
 *                                 it. A failure is isolated to that subscription and recorded as
 *                                 a failed delivery, so it is auditable and the tenant's other
 *                                 subscriptions still go out.
 */
export async function dispatchWebhooks(args: { maxEvents?: number; now?: Date; eventIds?: string[]; orgRef?: string } = {}): Promise<DispatchResult> {
  const db = await getDb();
  if (!db) return { attempted: 0, results: [], skipped: "database unavailable" };
  const key = mfaKey();
  if (!key) return { attempted: 0, results: [], skipped: "LEASEOS_PORTAL_MFA_KEY not configured — secrets cannot be read; nothing sent" };
  const now = args.now ?? new Date();

  // Events first: they carry the tenancy that decides which subscriptions may even be looked at.
  const events = args.eventIds?.length ? await db.select().from(domainEventOutbox).where(inArray(domainEventOutbox.eventId, args.eventIds)) : await db.select().from(domainEventOutbox).orderBy(desc(domainEventOutbox.id)).limit(args.maxEvents ?? 100);
  if (!events.length) return { attempted: 0, results: [], skipped: null };

  /*
   * A batch may legitimately span organizations — the retry sweep collects every due delivery
   * regardless of whose it is — so the scope is the SET of tenants these events belong to, not an
   * assumption that they share one. Each event is still matched only against its own tenant's
   * subscriptions below; the set merely bounds what is read from the table.
   */
  const eventTenants = Array.from(new Set(events.map(e => e.tenantId)));
  const scopedTenants = args.orgRef ? eventTenants.filter(t => t === args.orgRef) : eventTenants;
  if (!scopedTenants.length) return { attempted: 0, results: [], skipped: null };

  const subs = await db.select().from(webhookSubscriptions).where(
    and(eq(webhookSubscriptions.status, "active"), inArray(webhookSubscriptions.orgRef, scopedTenants)),
  );
  if (!subs.length) return { attempted: 0, results: [], skipped: null };

  const results: DispatchResult["results"] = [];

  /*
   * Read at most once per subscription, and only when something is actually due for it. `null`
   * records that this subscription's secret is unreadable, so the next event for the same
   * subscription does not try again and does not throw again.
   */
  const secrets = new Map<number, string | null>();
  const secretFor = (sub: typeof subs[number]): string | null => {
    if (!secrets.has(sub.id)) {
      try { secrets.set(sub.id, decryptSecret(sub.secretEnc, key)); }
      catch { secrets.set(sub.id, null); }
    }
    return secrets.get(sub.id) ?? null;
  };

  for (const s of subs) {
    const types = JSON.parse(s.eventTypesJson) as string[];
    for (const ev of events) {
      // A subscription may only receive outbox events from its own tenant. The query above has
      // already excluded every other organization; this is the per-event half of the same rule.
      if (!s.orgRef || ev.tenantId !== s.orgRef) continue;
      if (!subscribed(types, ev.eventType)) continue;
      const prior = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, s.id), eq(webhookDeliveries.eventId, ev.eventId))).orderBy(desc(webhookDeliveries.attempt));
      const last = prior[0];
      if (last && (last.status === "delivered" || last.status === "dead")) continue;
      if (last && last.status === "failed" && last.nextAttemptAt && now < last.nextAttemptAt) continue;
      const attempt = (last?.attempt ?? 0) + 1;
      const body = JSON.stringify({ eventId: ev.eventId, eventType: ev.eventType, version: ev.eventVersion, aggregate: { type: ev.aggregateType, id: ev.aggregateId }, occurredAt: ev.occurredAt, payload: JSON.parse(ev.payloadJson) });
      const timestamp = Math.floor(now.getTime() / 1000);

      /*
       * Now, and only now, is this subscription's secret needed — the body above did not require
       * it, only the signature does. An unreadable secret is that subscription's problem and
       * nobody else's: it is written down as a delivery failure, in the same place and the same
       * vocabulary as every other delivery failure, and the loop carries on with the tenant's
       * remaining subscriptions rather than abandoning the dispatch.
       *
       * The row stays accurate about what happened: the request that WOULD have been sent is
       * hashed, and `signature` is empty because nothing was signed and nothing was sent.
       */
      const secret = secretFor(s);
      if (secret === null) {
        const outcome = deliveryOutcome({ attempt, responseStatus: null, error: SECRET_UNREADABLE, at: now });
        await db.insert(webhookDeliveries).values({ orgRef: s.orgRef, deliveryRef: ref("DLV"), subscriptionId: s.id, eventId: ev.eventId, eventType: ev.eventType, attempt, status: outcome.status, requestHash: sha(body), signature: "", responseStatus: null, error: SECRET_UNREADABLE, nextAttemptAt: outcome.nextAttemptAt, at: now });
        results.push({ subscriptionRef: s.subscriptionRef, eventId: ev.eventId, attempt, status: outcome.status, reason: outcome.reason });
        continue;
      }

      const signature = signPayload(secret, timestamp, body);
      const r = await poster(s.url, body, { "content-type": "application/json", "x-leaseos-timestamp": String(timestamp), "x-leaseos-signature": signature, "x-leaseos-event": ev.eventType, "x-leaseos-delivery": `${s.subscriptionRef}:${ev.eventId}:${attempt}` });
      const outcome = deliveryOutcome({ attempt, responseStatus: "status" in r ? r.status : null, error: "error" in r ? r.error : null, at: now });
      await db.insert(webhookDeliveries).values({ orgRef: s.orgRef, deliveryRef: ref("DLV"), subscriptionId: s.id, eventId: ev.eventId, eventType: ev.eventType, attempt, status: outcome.status, requestHash: sha(body), signature, responseStatus: "status" in r ? r.status : null, error: "error" in r ? r.error.slice(0, 400) : null, nextAttemptAt: outcome.nextAttemptAt, at: now });
      results.push({ subscriptionRef: s.subscriptionRef, eventId: ev.eventId, attempt, status: outcome.status, reason: outcome.reason });
    }
  }
  return { attempted: results.length, results, skipped: null };
}

/** The retry sweep: every failed delivery whose next attempt is due. */
export async function sweepWebhookRetries(now: Date = new Date()): Promise<DispatchResult> {
  const db = await getDb();
  if (!db) return { attempted: 0, results: [], skipped: "database unavailable" };
  const due = await db.select({ eventId: webhookDeliveries.eventId }).from(webhookDeliveries).where(eq(webhookDeliveries.status, "failed"));
  const ids = Array.from(new Set(due.map(d => d.eventId)));
  if (!ids.length) return { attempted: 0, results: [], skipped: null };
  return dispatchWebhooks({ eventIds: ids, now });
}
