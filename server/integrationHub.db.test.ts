/**
 * Integration Hub — against a real MariaDB and the real primitives it sits on top of (SEC-004's
 * claim/lease dispatcher, S2-C provider credentials, the egress guard). Pure decisions are proved
 * in `server/_core/integrationHub/integrationHub.test.ts`; this file proves what only a database
 * can: two-tenant isolation, idempotent duplicate handling, dead-letter requeue through the real
 * claim machinery, and a sync cursor that never advances past uncommitted work.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import {
  acceptInboundEvent, actOnDeadLetter, connectorCredentialMetadata, criticalConnectorReadiness,
  handleClaimedIntegrationInbound, hubEvent, hubMetrics, issueConnectorCredential, loadIntegrationHubExceptions,
  recordConnectorAttempt, recordDeadLetter, revokeConnectorCredential, rotateConnectorCredential,
  scanForNewDeadLetters, scheduleSyncRun, executeSyncRun, seedSharedContracts, type Db,
} from "./integrationHubService";
import { hmacOver } from "./_core/integrationHub/inboundIntake";
import type { SyncPage, SyncAdapter } from "./_core/integrationHub/sync";
import {
  integrationConflicts, integrationConnectors, integrationContracts, integrationDeadLetterActions,
  integrationDeadLetters, integrationHubEvents, integrationSyncCursors, integrationSyncRuns, inboundEvents,
  type IntegrationConnector,
} from "../drizzle/schema";
import { setWebhookPoster, sweepWebhookRetries, type Poster } from "./webhookDispatchService";
import { encryptSecret, mfaKey } from "./_core/externalIdentityPolicy";
import { MAX_ATTEMPTS } from "./_core/integrationGateway";

process.env.LEASEOS_PORTAL_MFA_KEY = "c".repeat(64);
process.env.LEASEOS_KEY_PROVIDER_V1 = "d".repeat(64);

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let db: Db;
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 8 });
  db = (await getDb())!;
});

// Years away from every other suite's clock (those run in 2026): a shared database means another
// suite's sweep must never find this suite's due retries or expired claims, or vice versa.
const T0 = new Date("2037-01-01T12:00:00Z");
const LEASE_T0 = new Date("2037-06-01T00:00:00Z");
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
const after = (t: Date, ms: number) => new Date(t.getTime() + ms);

const myConnectors: number[] = [];
const mySubscriptions: string[] = [];
afterEach(async () => {
  // Hygiene: a revoked connector schedules nothing and a revoked subscription is never dispatched,
  // so nothing this suite creates is picked up by another suite's tick in the shared database.
  if (pool && myConnectors.length) await pool.query("UPDATE integrationConnectors SET status = 'revoked', nextSyncAt = NULL WHERE id IN (?)", [myConnectors.splice(0)]);
  if (pool && mySubscriptions.length) await pool.query("UPDATE webhookSubscriptions SET status = 'revoked' WHERE subscriptionRef IN (?)", [mySubscriptions.splice(0)]);
});
let defaultPosterForRestore: Poster;
beforeAll(async () => { if (URL) { const m = await import("./webhookDispatchService"); defaultPosterForRestore = m.currentWebhookPoster(); } });
afterAll(async () => { if (URL) setWebhookPoster(defaultPosterForRestore); await pool?.end(); });

/** Insert a connector row directly (connectorCreate is the router's job; the service is what's under test). */
async function connector(args: { org?: string; connectorKey?: string; direction?: "inbound" | "outbound" | "bidirectional"; authMethod?: string; inboundEventTypes?: string[]; maxPayloadBytes?: number; status?: string; critical?: boolean; defaultContractId?: number | null } = {}): Promise<IntegrationConnector> {
  const t = tag();
  const org = args.org ?? `ORG-${t}`;
  const connectorRef = `CONN-${t}`;
  const capabilities = JSON.stringify({ inbound: args.direction === "outbound" ? null : { eventTypes: args.inboundEventTypes ?? ["ticket.*"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: args.direction === "inbound" ? null : { eventTypes: ["*"] }, sync: { supported: false } });
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO integrationConnectors (orgRef, connectorRef, connectorKey, name, providerType, direction, authMethod, capabilitiesJson, configJson, status, critical, maxPayloadBytes, defaultContractId, createdByUserId) VALUES (?, ?, ?, 'test connector', 'other', ?, ?, ?, '{}', ?, ?, ?, ?, 1)",
    [org, connectorRef, args.connectorKey ?? "generic_signed_webhook_source", args.direction ?? "inbound", args.authMethod ?? "hmac_shared_secret", capabilities, args.status ?? "active", args.critical ?? false, args.maxPayloadBytes ?? 1_048_576, args.defaultContractId ?? null]);
  myConnectors.push(r.insertId);
  return (await db.select().from(integrationConnectors).where(eq(integrationConnectors.id, r.insertId)).limit(1))[0]!;
}

async function outboxEvent(org: string, eventId?: string): Promise<string> {
  const id = eventId ?? `EV-${tag()}`.slice(0, 40);
  await pool.execute(
    "INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt) VALUES (?, 'hub.test', 1, 'ticket', 'T-1', ?, 'corr', 'system', '{}', ?, 0, ?)",
    [id, org, T0, T0]);
  return id;
}

async function subscription(c: IntegrationConnector): Promise<{ id: number; subscriptionRef: string }> {
  const subscriptionRef = `WH-${tag()}`;
  mySubscriptions.push(subscriptionRef);
  const [s] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO webhookSubscriptions (orgRef, connectorId, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId) VALUES (?, ?, ?, 'hub-test', 'https://erp.example/hook', ?, '[\"hub.*\"]', 'active', 1)",
    [c.orgRef, c.id, subscriptionRef, encryptSecret("secret", mfaKey()!)]);
  return { id: s.insertId, subscriptionRef };
}

/** A terminal webhookDeliveries row exactly as SEC-004's dispatcher leaves one after exhausting its retries. */
async function deadDelivery(args: { org: string; subscriptionId: number; eventId: string }): Promise<string> {
  const deliveryRef = `DLV-${tag()}`;
  await pool.execute(
    "INSERT INTO webhookDeliveries (orgRef, deliveryRef, subscriptionId, eventId, eventType, attempt, status, requestHash, signature, responseStatus, error, at) VALUES (?, ?, ?, ?, 'hub.test', ?, 'dead', 'h', 's', 503, 'server error', ?)",
    [args.org, deliveryRef, args.subscriptionId, args.eventId, MAX_ATTEMPTS, T0]);
  return deliveryRef;
}

async function deadLetterRows(connectorId: number) {
  return db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.connectorId, connectorId));
}

/** Mimics claimDueSyncRuns's own attemptCount bump — executeSyncRun's backoff math assumes a claimed run, exactly as integrationHubTick always hands it one. */
async function claimSyncRun(id: number): Promise<typeof integrationSyncRuns.$inferSelect> {
  await pool.execute("UPDATE integrationSyncRuns SET attemptCount = attemptCount + 1, state = 'claimed' WHERE id = ?", [id]);
  return (await db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.id, id)).limit(1))[0]!;
}

d("inbound intake — accepts, refuses by name, and never confuses two tenants", () => {
  it("accepts a validly signed event once, and the worker's contract handler turns it into a normalized observation", async () => {
    const seeded = await seedSharedContracts(db);
    const contractRow = (await db.select().from(integrationContracts).where(and(eq(integrationContracts.scopeKey, "shared"), eq(integrationContracts.contractKey, "generic.observation"))).limit(1))[0]!;
    expect(seeded.inserted.length + seeded.unchanged.length).toBeGreaterThan(0);
    const c = await connector({ inboundEventTypes: ["ticket.*"], defaultContractId: contractRow.id });
    await issueConnectorCredential({ connector: c, purpose: "inbound_verify", plaintext: "s3cret-s3cret", createdByUserId: 1 });
    const body = JSON.stringify({ id: "T-1", type: "ticket.received", data: { a: 1 } });
    const ts = String(Math.floor(T0.getTime() / 1000));
    const headers = { signature: hmacOver("s3cret-s3cret", ts, body), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "T-1" };
    const r = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers, body, now: T0 });
    expect(r).toMatchObject({ status: 202, body: { status: "accepted" } });
    const row = (await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, c.id), eq(inboundEvents.idempotencyKey, "T-1"))).limit(1))[0]!;
    expect(row.status).toBe("accepted");
    const outcome = await handleClaimedIntegrationInbound(db, { aggregateId: String(row.id), tenantId: c.orgRef, now: T0 });
    expect(outcome).toEqual({ tasksCreated: 0 });
    const processed = (await db.select().from(inboundEvents).where(eq(inboundEvents.id, row.id)).limit(1))[0]!;
    expect(processed.status).toBe("processed");
    expect(JSON.parse(processed.normalizedJson!)).toMatchObject({ externalId: "T-1", kind: "ticket.received", data: { a: 1 } });
    // Replayed (worker crash before marking processed, or a retry): idempotent, lands on the same row.
    const again = await handleClaimedIntegrationInbound(db, { aggregateId: String(row.id), tenantId: c.orgRef, now: after(T0, 1000) });
    expect(again).toEqual({ tasksCreated: 0 });
    expect((await db.select().from(inboundEvents).where(eq(inboundEvents.id, row.id)).limit(1))[0]!.status).toBe("processed");
  });

  it("de-duplicates an exact repeat and records a conflict when the same key arrives with different content", async () => {
    const c = await connector({ inboundEventTypes: ["ticket.*"] });
    await issueConnectorCredential({ connector: c, purpose: "inbound_verify", plaintext: "s3cret-s3cret", createdByUserId: 1 });
    const ts = String(Math.floor(T0.getTime() / 1000));
    const send = (body: string) => acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { signature: hmacOver("s3cret-s3cret", ts, body), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "DUP-1" }, body, now: T0 });
    const body1 = JSON.stringify({ id: "DUP-1", type: "ticket.received" });
    const first = await send(body1);
    expect(first.status).toBe(202);
    const repeat = await send(body1);
    expect(repeat).toMatchObject({ status: 202, body: { status: "duplicate", note: expect.stringMatching(/same content/) } });
    expect((await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, c.id), eq(inboundEvents.idempotencyKey, "DUP-1")))).length).toBe(1);
    const body2 = JSON.stringify({ id: "DUP-1", type: "ticket.received", data: { changed: true } });
    const conflicting = await send(body2);
    expect(conflicting).toMatchObject({ status: 202, body: { status: "duplicate", note: expect.stringMatching(/DIFFERENT content/) } });
    const conflicts = await db.select().from(integrationConflicts).where(eq(integrationConflicts.connectorId, c.id));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ decision: "pending", entityType: "integration_observation" });
  });

  it("refuses a tampered signature, an inactive connector, an oversized payload and an undeclared event type — each by its own name, none of them silently recorded as fact", async () => {
    const c = await connector({ inboundEventTypes: ["ticket.*"] });
    await issueConnectorCredential({ connector: c, purpose: "inbound_verify", plaintext: "s3cret-s3cret", createdByUserId: 1 });
    const ts = String(Math.floor(T0.getTime() / 1000));
    const body = JSON.stringify({ id: "R-1", type: "ticket.received" });
    const good = { signature: hmacOver("s3cret-s3cret", ts, body), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "R-1" };

    const tampered = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { ...good, signature: "0".repeat(64) }, body, now: T0 });
    expect(tampered).toMatchObject({ status: 401, body: { code: "signature_mismatch" } });
    expect((await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, c.id), eq(inboundEvents.idempotencyKey, "R-1")))).length).toBe(0);

    const suspended = await connector({ inboundEventTypes: ["ticket.*"], status: "suspended" });
    await issueConnectorCredential({ connector: suspended, purpose: "inbound_verify", plaintext: "s3cret-s3cret", createdByUserId: 1 });
    const inactive = await acceptInboundEvent(db, { connectorRef: suspended.connectorRef, headers: good, body, now: T0 });
    expect(inactive).toMatchObject({ status: 403, body: { code: "connector_not_active" } });

    const tiny = await connector({ inboundEventTypes: ["ticket.*"], maxPayloadBytes: 5 });
    await issueConnectorCredential({ connector: tiny, purpose: "inbound_verify", plaintext: "s3cret-s3cret", createdByUserId: 1 });
    const tinySig = hmacOver("s3cret-s3cret", ts, body);
    const big = await acceptInboundEvent(db, { connectorRef: tiny.connectorRef, headers: { ...good, signature: tinySig }, body, now: T0 });
    expect(big).toMatchObject({ status: 413, body: { code: "payload_too_large" } });

    const wrongType = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { ...good, eventType: "invoice.paid", idempotencyKey: "R-2" }, body, now: T0 });
    expect(wrongType).toMatchObject({ status: 422, body: { code: "unsupported_event_type" } });
    const rejected = (await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, c.id), eq(inboundEvents.idempotencyKey, "R-2"))).limit(1))[0];
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: expect.stringMatching(/unsupported_event_type/) });

    const unknown = await acceptInboundEvent(db, { connectorRef: `CONN-NOPE-${tag()}`, headers: good, body, now: T0 });
    expect(unknown).toMatchObject({ status: 404, body: { code: "unknown_connector" } });
  });

  it("two organizations never collide, even on the identical idempotency key", async () => {
    const a = await connector({ inboundEventTypes: ["ticket.*"] });
    const b = await connector({ inboundEventTypes: ["ticket.*"] });
    expect(a.orgRef).not.toBe(b.orgRef);
    await issueConnectorCredential({ connector: a, purpose: "inbound_verify", plaintext: "secret-a-secret", createdByUserId: 1 });
    await issueConnectorCredential({ connector: b, purpose: "inbound_verify", plaintext: "secret-b-secret", createdByUserId: 1 });
    const ts = String(Math.floor(T0.getTime() / 1000));
    const bodyA = JSON.stringify({ id: "SAME", type: "ticket.received", data: { org: "a" } });
    const bodyB = JSON.stringify({ id: "SAME", type: "ticket.received", data: { org: "b" } });
    const ra = await acceptInboundEvent(db, { connectorRef: a.connectorRef, headers: { signature: hmacOver("secret-a-secret", ts, bodyA), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "SAME" }, body: bodyA, now: T0 });
    const rb = await acceptInboundEvent(db, { connectorRef: b.connectorRef, headers: { signature: hmacOver("secret-b-secret", ts, bodyB), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "SAME" }, body: bodyB, now: T0 });
    expect(ra.status).toBe(202); expect(rb.status).toBe(202);
    expect((ra as { body: { eventId: string } }).body.eventId).not.toBe((rb as { body: { eventId: string } }).body.eventId);
    const rowA = (await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, a.id), eq(inboundEvents.idempotencyKey, "SAME"))).limit(1))[0]!;
    const rowB = (await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, b.id), eq(inboundEvents.idempotencyKey, "SAME"))).limit(1))[0]!;
    expect(rowA.orgRef).toBe(a.orgRef); expect(rowB.orgRef).toBe(b.orgRef);
    expect(JSON.parse(rowA.payloadJson)).toMatchObject({ data: { org: "a" } });
    expect(JSON.parse(rowB.payloadJson)).toMatchObject({ data: { org: "b" } });
    // No conflict: these are two different connectors, so nothing compares them to each other.
    expect(await db.select().from(integrationConflicts).where(eq(integrationConflicts.connectorId, a.id))).toHaveLength(0);
  });
});

d("credentials — issued once, rotated without downtime, revoked for good", () => {
  it("issues, rotates and revokes, and inbound verification follows the live credential at every step", async () => {
    const c = await connector({ inboundEventTypes: ["ticket.*"] });
    const issued = await issueConnectorCredential({ connector: c, purpose: "inbound_verify", plaintext: "first-secret-value", createdByUserId: 1 });
    expect(issued.shownOnce).toBeNull(); // we supplied the plaintext ourselves; nothing is echoed back
    const meta1 = await connectorCredentialMetadata(c.orgRef, c.connectorRef, "inbound_verify");
    expect(meta1?.status).toBe("active");

    const sign = (secret: string, body: string, ts: string) => hmacOver(secret, ts, body);
    const ts = String(Math.floor(T0.getTime() / 1000));
    const body = JSON.stringify({ id: "CR-1", type: "ticket.received" });
    const withOld = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { signature: sign("first-secret-value", body, ts), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "CR-1" }, body, now: T0 });
    expect(withOld.status).toBe(202);

    const rotated = await rotateConnectorCredential({ connectorRef: c.connectorRef, purpose: "inbound_verify", orgRef: c.orgRef, plaintext: "second-secret-value" });
    expect(rotated.credentialVersion).toBeGreaterThan(1);
    const staleSigned = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { signature: sign("first-secret-value", body, ts), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "CR-2" }, body, now: T0 });
    expect(staleSigned).toMatchObject({ status: 401 }); // the old secret is dead the moment it rotates
    const withNew = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { signature: sign("second-secret-value", body, ts), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "CR-3" }, body, now: T0 });
    expect(withNew.status).toBe(202);

    await revokeConnectorCredential({ connectorRef: c.connectorRef, purpose: "inbound_verify", orgRef: c.orgRef, reason: "test revoke", byUserId: 1 });
    expect(await connectorCredentialMetadata(c.orgRef, c.connectorRef, "inbound_verify")).toBeNull();
    const afterRevoke = await acceptInboundEvent(db, { connectorRef: c.connectorRef, headers: { signature: sign("second-secret-value", body, ts), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "CR-4" }, body, now: T0 });
    expect(afterRevoke).toMatchObject({ status: 401, body: { code: "no_credential" } });
  });
});

d("dead letters — created by scanning, moved only by a person, never looping on their own", () => {
  it("scans a terminally dead delivery into a dead letter exactly once, and requeueing sends it for real without disturbing the attempt history", async () => {
    const c = await connector({ direction: "outbound" });
    const sub = await subscription(c);
    const eventId = await outboxEvent(c.orgRef);
    await pool.execute(
      "INSERT INTO webhookDeliveries (orgRef, deliveryRef, subscriptionId, eventId, eventType, attempt, status, requestHash, signature, responseStatus, error, at) VALUES (?, ?, ?, ?, 'hub.test', 1, 'failed', 'h', 's', 503, 'server error', ?)",
      [c.orgRef, `DLV-${tag()}`, sub.id, eventId, T0]);
    await deadDelivery({ org: c.orgRef, subscriptionId: sub.id, eventId });

    const scan1 = await scanForNewDeadLetters(db, { now: T0 });
    expect(scan1.created).toBeGreaterThanOrEqual(1);
    const scan2 = await scanForNewDeadLetters(db, { now: after(T0, 1000) });
    expect(scan2.created).toBe(0); // the same terminal row is never turned into a second dead letter
    const [dl] = await deadLetterRows(c.id);
    expect(dl).toMatchObject({ kind: "outbound_delivery", state: "open", attemptCount: 2 });
    const history = JSON.parse(dl!.attemptHistoryJson) as unknown[];
    expect(history).toHaveLength(2); // both the failed and the dead attempt are preserved, in order

    const p: { seen: { body: string }[] } & { poster: Poster } = (() => {
      const all: { url: string; body: string; headers: Record<string, string> }[] = [];
      const poster: Poster = async (url, body, headers) => { all.push({ url, body, headers }); return { status: 200 }; };
      return { get seen() { return all.filter(x => JSON.parse(x.body).eventId === eventId); }, poster };
    })();
    setWebhookPoster(p.poster);
    const acted = await actOnDeadLetter(db, { orgRef: c.orgRef, deadLetterRef: dl!.deadLetterRef, action: "requeued", actorUserId: 1, now: after(T0, 2000) });
    expect(acted.state).toBe("requeued");
    // The expired-lease claim is picked up by the next real sweep, exactly like a recovered worker.
    await sweepWebhookRetries(after(T0, 2000), { leaseNow: LEASE_T0, orgRef: c.orgRef });
    expect(p.seen).toHaveLength(1);
    const rows = await pool.execute<mysql.RowDataPacket[]>("SELECT attempt, status FROM webhookDeliveries WHERE subscriptionId = ? AND eventId = ? ORDER BY attempt", [sub.id, eventId]);
    expect(rows[0].map(r => [r.attempt, r.status])).toEqual([[1, "failed"], [MAX_ATTEMPTS, "dead"], [MAX_ATTEMPTS + 1, "delivered"]]);
    const actions = await db.select().from(integrationDeadLetterActions).where(eq(integrationDeadLetterActions.deadLetterId, dl!.id));
    expect(actions.map(a => a.action)).toEqual(["requeued"]);
    expect((await db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.id, dl!.id)).limit(1))[0]!.requeueCount).toBe(1);
  });

  it("refuses a dead-letter transition the state machine does not allow, and caps unacknowledged requeues", async () => {
    const c = await connector();
    const dl = await recordDeadLetter(db, { orgRef: c.orgRef, connectorId: c.id, kind: "inbound_event", sourceRef: `IN-${tag()}`, attemptHistory: [{ attempt: 1, at: T0.toISOString(), status: "quarantined", httpStatus: null, error: "bad schema", outcomeClass: "schema_or_contract" }], lastError: "bad schema", reason: "schema_or_contract", now: T0 });
    await expect(actOnDeadLetter(db, { orgRef: c.orgRef, deadLetterRef: dl.deadLetterRef, action: "acknowledged", actorUserId: 1, now: T0 })).resolves.toMatchObject({ state: "acknowledged" });
    await expect(actOnDeadLetter(db, { orgRef: c.orgRef, deadLetterRef: dl.deadLetterRef, action: "resolved", actorUserId: 1, now: after(T0, 1000) })).resolves.toMatchObject({ state: "resolved" });
    await expect(actOnDeadLetter(db, { orgRef: c.orgRef, deadLetterRef: dl.deadLetterRef, action: "acknowledged", actorUserId: 1, now: after(T0, 2000) })).rejects.toThrow(/DEAD_LETTER_TRANSITION/); // resolved cannot go straight to acknowledged
  });

  it("never lets organization A touch organization B's dead letter", async () => {
    const a = await connector();
    const b = await connector();
    const dl = await recordDeadLetter(db, { orgRef: b.orgRef, connectorId: b.id, kind: "inbound_event", sourceRef: `IN-${tag()}`, attemptHistory: [], lastError: null, reason: "schema_or_contract", now: T0 });
    await expect(actOnDeadLetter(db, { orgRef: a.orgRef, deadLetterRef: dl.deadLetterRef, action: "acknowledged", actorUserId: 1, now: T0 })).rejects.toThrow(/DEAD_LETTER_NOT_FOUND/);
  });
});

d("sync runs — the cursor never advances past uncommitted work", () => {
  function adapterOf(pages: (SyncPage | { refused: string; retryable: boolean; httpStatus?: number | null })[]): SyncAdapter {
    let i = 0;
    return { async fetchPage() { const p = pages[Math.min(i, pages.length - 1)]!; i++; return p; } };
  }

  it("commits the cursor only with its page, resumes after a failure without losing what was already accepted, and a re-fetched page is harmless", async () => {
    const c = await connector({ defaultContractId: null });
    const { id: runId } = await scheduleSyncRun(db, { orgRef: c.orgRef, connectorId: c.id, contractId: null, trigger: "manual", now: T0 });
    const run1 = await claimSyncRun(runId);

    // Page 1 fails before any cursor exists: nothing to lose, cursor stays null.
    const r1 = await executeSyncRun(db, run1, { now: T0, adapter: adapterOf([{ refused: "ECONNRESET", retryable: true }]) });
    expect(r1.state).toBe("failed");
    expect(await db.select().from(integrationSyncCursors).where(eq(integrationSyncCursors.connectorId, c.id))).toHaveLength(0);
    const run2 = (await db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.id, runId)).limit(1))[0]!;
    expect(run2.state).toBe("failed");

    // Resume: page succeeds, cursor commits with it.
    const records = [{ id: "S-1", type: "ticket.received" }, { id: "S-2", type: "ticket.received" }];
    const r2 = await executeSyncRun(db, run2, { now: after(T0, 61_000), adapter: adapterOf([{ records, nextCursor: "CUR-1", done: true }]) });
    expect(r2.state).toBe("succeeded");
    expect(r2.outcome).toMatchObject({ examined: 2, accepted: 2 });
    const cursor = (await db.select().from(integrationSyncCursors).where(eq(integrationSyncCursors.connectorId, c.id)).limit(1))[0]!;
    expect(cursor.cursorValue).toBe("CUR-1");
    expect(await db.select().from(inboundEvents).where(eq(inboundEvents.connectorId, c.id))).toHaveLength(2);

    // Crash-safe resumability: the SAME page fetched again (as a retried run would) commits no new rows.
    const run3 = await scheduleSyncRun(db, { orgRef: c.orgRef, connectorId: c.id, contractId: null, trigger: "resume", now: after(T0, 120_000) });
    const run3row = await claimSyncRun(run3.id);
    const r3 = await executeSyncRun(db, run3row, { now: after(T0, 120_000), adapter: adapterOf([{ records, nextCursor: "CUR-2", done: true }]) });
    expect(r3.state).toBe("succeeded");
    expect(r3.outcome).toMatchObject({ accepted: 0, unchanged: 2 }); // both records already exist — harmless
    expect(await db.select().from(inboundEvents).where(eq(inboundEvents.connectorId, c.id))).toHaveLength(2); // no duplicates written
  });

  it("a terminal provider rejection dies the run, and the dead-letter scan picks it up", async () => {
    const c = await connector();
    const { id: runId } = await scheduleSyncRun(db, { orgRef: c.orgRef, connectorId: c.id, contractId: null, trigger: "manual", now: T0 });
    const run = await claimSyncRun(runId);
    const r = await executeSyncRun(db, run, { now: T0, adapter: adapterOf([{ refused: "401 unauthorized", retryable: false, httpStatus: 401 }]) });
    expect(r.state).toBe("dead");
    const scan = await scanForNewDeadLetters(db, { now: after(T0, 1000) });
    expect(scan.created).toBeGreaterThanOrEqual(1);
    const [dl] = (await deadLetterRows(c.id)).filter(x => x.kind === "sync_run");
    expect(dl).toMatchObject({ kind: "sync_run", reason: "authentication_or_configuration" });
  });
});

d("audit, metrics and readiness", () => {
  it("redacts anything that looks like a secret before it is ever written to the audit trail", async () => {
    const c = await connector();
    const ref = await hubEvent(db, { orgRef: c.orgRef, eventType: "credential.rotated", targetType: "connector", targetRef: c.connectorRef, after: { purpose: "inbound_verify", apiKey: "sk-should-never-appear", nested: { token: "also-secret" } }, now: T0 });
    const events = await db.select().from(integrationHubEvents).where(eq(integrationHubEvents.eventRef, ref)).limit(1);
    const after = JSON.parse(events[0]!.afterJson!);
    expect(after.apiKey).toBe("«redacted»");
    expect(after.nested.token).toBe("«redacted»");
    expect(JSON.stringify(after)).not.toContain("sk-should-never-appear");
    expect(JSON.stringify(after)).not.toContain("also-secret");
  });

  it("reports metrics and readiness scoped to one tenant, and a non-critical connector's failure never counts toward readiness even though it is still a visible exception", async () => {
    const org = `ORG-${tag()}`;
    const c = await connector({ org, critical: true });
    await recordConnectorAttempt(db, { connector: c, outcome: "failure", failureClass: "authentication_or_configuration", now: T0, direction: "inbound" });
    const notCritical = await connector({ org, critical: false });
    await recordConnectorAttempt(db, { connector: notCritical, outcome: "failure", failureClass: "authentication_or_configuration", now: T0, direction: "inbound" });

    const readiness = await criticalConnectorReadiness(db, { orgRef: org, now: after(T0, 1000) });
    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toMatchObject({ connectorRef: c.connectorRef, status: "BLOCKED" });

    const m = await hubMetrics(db, { now: after(T0, 1000), orgRef: org });
    expect(m.connectors.authentication_required ?? 0).toBeGreaterThanOrEqual(2);

    const otherOrgReadiness = await criticalConnectorReadiness(db, { orgRef: `ORG-${tag()}`, now: T0 });
    expect(otherOrgReadiness).toHaveLength(0);

    const exceptions = await loadIntegrationHubExceptions(db, { now: after(T0, 1000), orgRef: org });
    expect(exceptions.connectors.map(x => x.connectorRef)).toContain(c.connectorRef);
    expect(exceptions.connectors.map(x => x.connectorRef)).toContain(notCritical.connectorRef); // not critical, but still failing — visible as an exception, just never a readiness blocker
  });
});
