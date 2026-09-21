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

export async function dispatchWebhooks(args: { maxEvents?: number; now?: Date; eventIds?: string[]; orgRef?: string } = {}): Promise<DispatchResult> {
  const db = await getDb();
  if (!db) return { attempted: 0, results: [], skipped: "database unavailable" };
  const key = mfaKey();
  if (!key) return { attempted: 0, results: [], skipped: "LEASEOS_PORTAL_MFA_KEY not configured — secrets cannot be read; nothing sent" };
  const now = args.now ?? new Date();
  const subs = args.orgRef
    ? await db.select().from(webhookSubscriptions).where(and(eq(webhookSubscriptions.status, "active"), eq(webhookSubscriptions.orgRef, args.orgRef)))
    : await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.status, "active"));
  if (!subs.length) return { attempted: 0, results: [], skipped: null };
  const events = args.eventIds?.length ? await db.select().from(domainEventOutbox).where(inArray(domainEventOutbox.eventId, args.eventIds)) : await db.select().from(domainEventOutbox).orderBy(desc(domainEventOutbox.id)).limit(args.maxEvents ?? 100);
  const results: DispatchResult["results"] = [];
  for (const s of subs) {
    const types = JSON.parse(s.eventTypesJson) as string[];
    const secret = decryptSecret(s.secretEnc, key);
    for (const ev of events) {
      // A subscription may only receive outbox events from its own tenant.
      if (!s.orgRef || ev.tenantId !== s.orgRef) continue;
      if (!subscribed(types, ev.eventType)) continue;
      const prior = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, s.id), eq(webhookDeliveries.eventId, ev.eventId))).orderBy(desc(webhookDeliveries.attempt));
      const last = prior[0];
      if (last && (last.status === "delivered" || last.status === "dead")) continue;
      if (last && last.status === "failed" && last.nextAttemptAt && now < last.nextAttemptAt) continue;
      const attempt = (last?.attempt ?? 0) + 1;
      const body = JSON.stringify({ eventId: ev.eventId, eventType: ev.eventType, version: ev.eventVersion, aggregate: { type: ev.aggregateType, id: ev.aggregateId }, occurredAt: ev.occurredAt, payload: JSON.parse(ev.payloadJson) });
      const timestamp = Math.floor(now.getTime() / 1000);
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
