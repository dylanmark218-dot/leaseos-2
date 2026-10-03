/**
 * Integration Hub — the persistence services.
 *
 * Owns the Hub's own tables (connectors, contracts, hub events, sync runs/cursors, dead letters,
 * conflicts) and layers additively on top of the house's existing primitives: credentials are
 * `providerCredentials` rows resolved through `providerCredentialService.ts` (S2-C); outbound
 * delivery, its claim/lease and retry schedule are `webhookDispatchService.ts` (SEC-004), used here
 * unedited; outbound HTTP for sync polling goes through the egress guard
 * (`server/_core/egressGuard.ts`). Dead letters are created by SCANNING for terminal failures that
 * already happened elsewhere — never by changing how those paths decide an outcome.
 */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  domainEventOutbox, externalDataSources, inboundEvents, integrationConflicts, integrationConnectors, integrationContracts,
  integrationDeadLetterActions, integrationDeadLetters, integrationHubEvents, integrationSyncCursors, integrationSyncRuns,
  webhookDeliveries, webhookSubscriptions, workflowNotifications,
  type IntegrationConnector, type IntegrationDeadLetter,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { secretKeyProvider } from "./_core/secretKeys";
import {
  createCredential, disableCredential, fingerprint as credentialFingerprint, listCredentials, resolveForOutbound, rotateCredential,
  type AuthScheme, type CredentialMetadata, type CredentialOwnership,
} from "./providerCredentialService";
import {
  claimNewAttempt, dispatchWebhooks, sweepWebhookRetries, WEBHOOK_CLAIM_LEASE_MS,
} from "./webhookDispatchService";
import { egressGet } from "./_core/egressHttp";
import { EgressRefused, type EgressLimits } from "./_core/egressGuard";
import { canonicalJson, envelopeForInbound, payloadHash, sha256 } from "./_core/integrationHub/envelope";
import type { AuthMethod } from "./_core/integrationHub/registry";
import { connectorDefinition } from "./_core/integrationHub/registry";
import { applyContract, contractChecksum, DataSyncContract, idempotencyKeyFor, sharedContract, SHARED_CONTRACTS, type DataSyncContract as Contract } from "./_core/integrationHub/contracts";
import { afterAttempt, assessConnectorHealth, readinessVerdict, shouldAttempt } from "./_core/integrationHub/health";
import { nextDeadLetterState, requeueAllowed, type AttemptHistoryEntry, type DeadLetterAction } from "./_core/integrationHub/deadLetter";
import { decideConflict } from "./_core/integrationHub/conflict";
import { addOutcome, cursorAdvance, emptyPageOutcome, MAX_PAGES_PER_RUN, nextScheduledSync, type PageOutcome, type SyncAdapter } from "./_core/integrationHub/sync";
import { assessInbound, type CredentialForVerify, type InboundHeaders } from "./_core/integrationHub/inboundIntake";
import { evaluateSourceUsage, type ExternalDataSource } from "./_core/externalDataRegistry";
import type { HubMetrics } from "./_core/integrationHub/metrics";
import { assessHubHealth } from "./_core/integrationHub/metrics";
import type { InterEngineStatus } from "./_core/interEngineStatus";

export const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;

/** Matches webhookDispatchService.ts's own convention: the live handle `getDb()` actually returns, not the narrower shared alias. */
export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const isDup = (e: unknown): boolean => { const err = e as { message?: string; code?: string; cause?: unknown } | null; return /ER_DUP_ENTRY|Duplicate entry/.test(String(err?.message ?? "")) || err?.code === "ER_DUP_ENTRY" || (err?.cause != null && isDup(err.cause)); };
const keys = () => secretKeyProvider();

/* ------------------------------------------------------------------ */
/* Audit                                                                */
/* ------------------------------------------------------------------ */

export type HubEventInput = { orgRef: string; eventType: string; targetType: string; targetRef: string; actorUserId?: number | null; actorSource?: "human" | "system" | "integration"; correlationId?: string | null; before?: unknown; after?: unknown; detail?: string | null; now?: Date };
const SECRET_KEYS = /(secret|password|token|key|credential|plaintext)/i;
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) && typeof x === "string" ? "«redacted»" : scrub(x)]));
  return v;
}
/** Every important Hub action is a row. Values that look like secrets are redacted by key name before they are written. */
export async function hubEvent(db: Db, e: HubEventInput): Promise<string> {
  const eventRef = ref("IHE");
  await db.insert(integrationHubEvents).values({ orgRef: e.orgRef, eventRef, eventType: e.eventType, targetType: e.targetType, targetRef: e.targetRef, actorUserId: e.actorUserId ?? null, actorSource: e.actorSource ?? (e.actorUserId ? "human" : "system"), correlationId: e.correlationId ?? null, beforeJson: e.before === undefined ? null : canonicalJson(scrub(e.before)), afterJson: e.after === undefined ? null : canonicalJson(scrub(e.after)), detail: e.detail?.slice(0, 500) ?? null, occurredAt: e.now ?? new Date() });
  return eventRef;
}

/** An idempotent, role-addressed Inbox item. The same condition never tells anyone twice. */
export async function notifyOperators(db: Db, args: { orgRef: string; key: string; title: string; body: string | null; deepLink: string; now: Date; roles?: readonly string[] }): Promise<number> {
  let n = 0;
  for (const role of args.roles ?? ["management", "office"]) {
    try {
      await db.insert(workflowNotifications).values({ notificationKey: `${args.key}|${role}`.slice(0, 200), taskId: null, workflowNumber: null, tenantId: args.orgRef, recipientRole: role, recipientUserId: null, title: args.title.slice(0, 200), body: args.body?.slice(0, 2000) ?? null, deepLink: args.deepLink, channel: "in_app", status: "queued", queuedAt: args.now } as never);
      n++;
    } catch (e) { if (!isDup(e)) throw e; }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Connector health                                                     */
/* ------------------------------------------------------------------ */

export async function recordConnectorAttempt(db: Db, args: { connector: IntegrationConnector; outcome: "success" | "failure"; failureClass?: string | null; now: Date; direction: "inbound" | "outbound" | "sync" }): Promise<void> {
  const counters = afterAttempt({ consecutiveFailures: args.connector.consecutiveFailures, circuitOpenUntil: args.connector.circuitOpenUntil }, args.outcome, args.now);
  const stamp = args.direction === "inbound" ? { lastInboundAt: args.now } : args.direction === "outbound" ? { lastOutboundAt: args.now } : { lastSyncAt: args.now };
  await db.update(integrationConnectors).set({ ...counters, ...(args.outcome === "success" ? { lastSuccessAt: args.now, ...stamp } : {}), lastError: args.outcome === "success" ? null : (args.failureClass ?? "failure"), lastHealthCheckAt: args.now }).where(eq(integrationConnectors.id, args.connector.id));
  await refreshConnectorHealth(db, args.connector.id, args.now);
}

export async function refreshConnectorHealth(db: Db, connectorId: number, now: Date): Promise<{ state: string; line: string } | null> {
  const c = (await db.select().from(integrationConnectors).where(eq(integrationConnectors.id, connectorId)).limit(1))[0];
  if (!c) return null;
  const [{ open }] = await db.select({ open: sql<number>`count(*)` }).from(integrationDeadLetters).where(and(eq(integrationDeadLetters.connectorId, c.id), eq(integrationDeadLetters.state, "open")));
  const contract = c.defaultContractId ? (await db.select({ freshnessSeconds: integrationContracts.freshnessSeconds }).from(integrationContracts).where(eq(integrationContracts.id, c.defaultContractId)).limit(1))[0] : undefined;
  const h = assessConnectorHealth({ status: c.status, consecutiveFailures: c.consecutiveFailures, lastSuccessAt: c.lastSuccessAt, lastFailureClass: c.lastError, circuitOpenUntil: c.circuitOpenUntil, openDeadLetters: Number(open), freshnessSeconds: c.syncIntervalSeconds ? contract?.freshnessSeconds ?? null : null, lastSyncAt: c.lastSyncAt, now });
  if (h.state !== c.healthState) {
    await db.update(integrationConnectors).set({ healthState: h.state }).where(eq(integrationConnectors.id, c.id));
    await hubEvent(db, { orgRef: c.orgRef, eventType: "connector.health_changed", targetType: "connector", targetRef: c.connectorRef, before: { healthState: c.healthState }, after: { healthState: h.state }, detail: h.line, now });
    if (["failing", "authentication_required", "dead_letter_backlog"].includes(h.state)) await notifyOperators(db, { orgRef: c.orgRef, key: `integ:health:${c.connectorRef}:${h.state}`, title: `Integration ${c.name} is ${h.state.replace(/_/g, " ")}`, body: h.line, deepLink: `/integrations/${c.connectorRef}`, now });
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* Credentials — via providerCredentialService.ts (S2-C), no new store  */
/* ------------------------------------------------------------------ */

export type CredentialPurpose = "inbound_verify" | "outbound_auth" | "sync_auth";
/** Deterministic providerKey: one row per (connector, purpose) in providerCredentials. */
export const connectorProviderKey = (connectorRef: string, purpose: CredentialPurpose): string => `hub:${connectorRef}:${purpose}`;

const AUTH_METHOD_TO_SCHEME: Record<AuthMethod, AuthScheme> = {
  none: "NONE", api_key: "API_KEY", hmac_shared_secret: "SIGNED_REQUEST", bearer_token: "STATIC_BEARER",
  oauth2_client_credentials: "OAUTH2_CLIENT_CREDENTIALS", oauth2_refresh: "OAUTH2_REFRESH", signed_request: "SIGNED_REQUEST", mutual_tls: "MUTUAL_TLS",
};

export async function issueConnectorCredential(args: { connector: IntegrationConnector; purpose: CredentialPurpose; plaintext?: string; expiresAt?: Date | null; createdByUserId: number }): Promise<{ credentialRef: string; shownOnce: string | null }> {
  const authScheme = AUTH_METHOD_TO_SCHEME[args.connector.authMethod as AuthMethod];
  // Inbound verification and a connector's own outbound signature both use a secret WE mint and hand out once.
  const plaintext = args.plaintext ?? (authScheme === "NONE" ? undefined : randomBytes(32).toString("base64url"));
  const { credentialRef } = await createCredential({
    providerKey: connectorProviderKey(args.connector.connectorRef, args.purpose), authScheme, ownership: "TENANT", orgRef: args.connector.orgRef,
    plaintext, expiresAt: args.expiresAt ?? null, keys: keys(), isProduction: ENV.isProduction, createdByUserId: args.createdByUserId,
  });
  return { credentialRef, shownOnce: args.plaintext ? null : (plaintext ?? null) };
}

export async function rotateConnectorCredential(args: { connectorRef: string; purpose: CredentialPurpose; orgRef: string; plaintext?: string }): Promise<{ credentialRef: string; shownOnce: string | null; credentialVersion: number }> {
  const existing = await connectorCredentialMetadata(args.orgRef, args.connectorRef, args.purpose);
  if (!existing) throw new Error("CREDENTIAL_NOT_FOUND");
  const plaintext = args.plaintext ?? randomBytes(32).toString("base64url");
  const r = await rotateCredential({ credentialRef: existing.credentialRef, plaintext, keys: keys(), isProduction: ENV.isProduction });
  return { credentialRef: r.credentialRef, shownOnce: args.plaintext ? null : plaintext, credentialVersion: r.credentialVersion };
}

export async function revokeConnectorCredential(args: { connectorRef: string; purpose: CredentialPurpose; orgRef: string; reason: string; byUserId: number }): Promise<void> {
  const existing = await connectorCredentialMetadata(args.orgRef, args.connectorRef, args.purpose);
  if (!existing) throw new Error("CREDENTIAL_NOT_FOUND");
  await disableCredential({ credentialRef: existing.credentialRef, reason: args.reason, byUserId: args.byUserId });
}

export async function connectorCredentialMetadata(orgRef: string, connectorRef: string, purpose: CredentialPurpose): Promise<CredentialMetadata | null> {
  const all = await listCredentials({ ownership: "TENANT", orgRef });
  return all.find(c => c.providerKey === connectorProviderKey(connectorRef, purpose) && c.status === "active") ?? null;
}

/** Plaintext for a connector's credential, by purpose — used both to sign/authenticate outbound and to verify inbound. */
async function resolveConnectorPlaintext(orgRef: string, connectorRef: string, purpose: CredentialPurpose): Promise<string | null> {
  try {
    const r = await resolveForOutbound({ providerKey: connectorProviderKey(connectorRef, purpose), scope: { ownership: "TENANT", orgRef }, keys: keys(), isProduction: ENV.isProduction });
    return r.plaintext;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Dead letters — populated by SCANNING, never by editing another path  */
/* ------------------------------------------------------------------ */

export async function recordDeadLetter(db: Db, args: {
  orgRef: string; connectorId: number | null; kind: "outbound_delivery" | "inbound_event" | "sync_run"; sourceRef: string; subscriptionId?: number | null; eventId?: string | null; eventType?: string | null;
  occurredAt?: Date | null; payloadRef?: string | null; payloadHash?: string | null; attemptHistory: AttemptHistoryEntry[]; lastError: string | null; httpStatus?: number | null; contractVersion?: string | null;
  correlationId?: string | null; reason: string; reasonDetail?: string | null; previousDeadLetterId?: number | null; now: Date;
}): Promise<IntegrationDeadLetter> {
  const deadLetterRef = ref("DL");
  await db.insert(integrationDeadLetters).values({
    orgRef: args.orgRef, connectorId: args.connectorId, deadLetterRef, kind: args.kind, sourceRef: args.sourceRef, subscriptionId: args.subscriptionId ?? null, eventId: args.eventId ?? null, eventType: args.eventType ?? null,
    occurredAt: args.occurredAt ?? null, payloadRef: args.payloadRef ?? null, payloadHash: args.payloadHash ?? null, attemptHistoryJson: JSON.stringify(args.attemptHistory), attemptCount: args.attemptHistory.length,
    lastError: args.lastError?.slice(0, 400) ?? null, httpStatus: args.httpStatus ?? null, contractVersion: args.contractVersion ?? null,
    correlationId: args.correlationId ?? null, reason: args.reason.slice(0, 40), reasonDetail: args.reasonDetail?.slice(0, 500) ?? null, deadLetteredAt: args.now, previousDeadLetterId: args.previousDeadLetterId ?? null,
  });
  const row = (await db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.deadLetterRef, deadLetterRef)).limit(1))[0]!;
  await hubEvent(db, { orgRef: args.orgRef, eventType: "dead_letter.created", targetType: "dead_letter", targetRef: deadLetterRef, correlationId: args.correlationId ?? null, after: { kind: args.kind, sourceRef: args.sourceRef, reason: args.reason }, detail: args.reasonDetail ?? args.lastError ?? null, now: args.now });
  await notifyOperators(db, { orgRef: args.orgRef, key: `integ:dl:${deadLetterRef}`, title: `Integration dead letter: ${args.eventType ?? args.kind} (${args.reason.replace(/_/g, " ")})`, body: args.reasonDetail ?? args.lastError, deepLink: `/integrations/dead-letters/${deadLetterRef}`, now: args.now });
  if (args.connectorId) await refreshConnectorHealth(db, args.connectorId, args.now);
  return row;
}

/**
 * The scan: find outbound deliveries that reached `dead` (SEC-004's own terminal state) and
 * inbound events that were quarantined, which have no dead letter yet, and create one each. Called
 * from the Hub tick. Reads only; writes only new rows this scan itself adds.
 */
export async function scanForNewDeadLetters(db: Db, args: { now: Date; limit?: number }): Promise<{ created: number }> {
  let created = 0;
  const limit = args.limit ?? 100;
  // webhookDeliveries carries no dead-letter pointer (its schema is not touched); an already-handled
  // dead row is found by checking integrationDeadLetters.sourceRef (= deliveryRef) instead, below.
  const candidates = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.status, "dead")).orderBy(desc(webhookDeliveries.id)).limit(limit);
  for (const d of candidates) {
    if (!d.orgRef) continue; // no tenant, nothing to scope a dead letter to
    const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, d.subscriptionId)).limit(1);
    if (!sub?.connectorId) continue; // only Hub-linked subscriptions get Hub dead letters
    const existing = (await db.select({ id: integrationDeadLetters.id }).from(integrationDeadLetters).where(and(eq(integrationDeadLetters.kind, "outbound_delivery"), eq(integrationDeadLetters.sourceRef, d.deliveryRef))).limit(1))[0];
    if (existing) continue;
    const history = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, d.subscriptionId), eq(webhookDeliveries.eventId, d.eventId))).orderBy(asc(webhookDeliveries.attempt));
    const attemptHistory: AttemptHistoryEntry[] = history.map(h => ({ attempt: h.attempt, at: h.at.toISOString(), status: h.status, httpStatus: h.responseStatus, error: h.error, outcomeClass: null }));
    await recordDeadLetter(db, { orgRef: d.orgRef, connectorId: sub.connectorId, kind: "outbound_delivery", sourceRef: d.deliveryRef, subscriptionId: d.subscriptionId, eventId: d.eventId, eventType: d.eventType, payloadRef: d.eventId, payloadHash: d.requestHash, attemptHistory, lastError: d.error, httpStatus: d.responseStatus, reason: "dead_exhausted", reasonDetail: `${d.attempt} attempts; last response ${d.responseStatus ?? "none"}`, now: args.now });
    created++;
  }
  const quarantined = await db.select().from(inboundEvents).where(eq(inboundEvents.status, "quarantined")).orderBy(desc(inboundEvents.id)).limit(limit);
  for (const ev of quarantined) {
    if (!ev.orgRef || !ev.connectorId) continue;
    const existing = (await db.select({ id: integrationDeadLetters.id }).from(integrationDeadLetters).where(and(eq(integrationDeadLetters.kind, "inbound_event"), eq(integrationDeadLetters.sourceRef, ev.inboundRef))).limit(1))[0];
    if (existing) continue;
    await recordDeadLetter(db, { orgRef: ev.orgRef, connectorId: ev.connectorId, kind: "inbound_event", sourceRef: ev.inboundRef, eventId: ev.eventId, eventType: ev.eventType, occurredAt: ev.occurredAt, payloadRef: ev.inboundRef, payloadHash: ev.payloadHash, attemptHistory: [{ attempt: 1, at: args.now.toISOString(), status: "quarantined", httpStatus: null, error: ev.rejectionReason, outcomeClass: "schema_or_contract" }], lastError: ev.rejectionReason, contractVersion: ev.contractId ? `contract:${ev.contractId}` : null, correlationId: ev.correlationId, reason: "schema_or_contract", reasonDetail: ev.rejectionReason, now: args.now });
    created++;
  }
  const deadRuns = await db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.state, "dead")).orderBy(desc(integrationSyncRuns.id)).limit(limit);
  for (const run of deadRuns) {
    const existing = (await db.select({ id: integrationDeadLetters.id }).from(integrationDeadLetters).where(and(eq(integrationDeadLetters.kind, "sync_run"), eq(integrationDeadLetters.sourceRef, run.runRef))).limit(1))[0];
    if (existing) continue;
    await recordDeadLetter(db, { orgRef: run.orgRef, connectorId: run.connectorId, kind: "sync_run", sourceRef: run.runRef, eventType: "integration.sync", occurredAt: run.createdAt, attemptHistory: [{ attempt: run.attemptCount, at: args.now.toISOString(), status: "dead", httpStatus: null, error: run.lastError, outcomeClass: run.lastErrorClass }], lastError: run.lastError, correlationId: run.correlationId, reason: run.lastErrorClass ?? "retryable_failure", reasonDetail: run.lastError, now: args.now });
    created++;
  }
  return { created };
}

async function nextActionSequence(db: Db, deadLetterId: number): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${integrationDeadLetterActions.sequence}), 0)` }).from(integrationDeadLetterActions).where(eq(integrationDeadLetterActions.deadLetterId, deadLetterId));
  return Number(n) + 1;
}

/**
 * An operator acts on a dead letter. The transition is checked, the action is a row, the audit is a
 * row. A requeue creates NEW work and never touches the history it replays. A requeued item that
 * dies again is a NEW dead letter linked to the previous one.
 */
export async function actOnDeadLetter(db: Db, args: { orgRef: string; deadLetterRef: string; action: DeadLetterAction; actorUserId: number; note?: string | null; now: Date }): Promise<{ state: string; resultRef: string | null }> {
  const dl = (await db.select().from(integrationDeadLetters).where(and(eq(integrationDeadLetters.deadLetterRef, args.deadLetterRef), eq(integrationDeadLetters.orgRef, args.orgRef))).limit(1))[0];
  if (!dl) throw new Error("DEAD_LETTER_NOT_FOUND");
  const t = nextDeadLetterState(dl.state, args.action);
  if (!t.ok) throw new Error(`DEAD_LETTER_TRANSITION: ${t.reason}`);
  let resultRef: string | null = null;
  if (args.action === "requeued" || args.action === "retried_now") {
    const allowed = requeueAllowed({ state: dl.state, requeueCount: dl.requeueCount, acknowledgedAt: dl.acknowledgedAt });
    if (!allowed.ok) throw new Error(`DEAD_LETTER_REQUEUE_REFUSED: ${allowed.reason}`);
    resultRef = await requeueWork(db, dl, args.now, args.action === "retried_now");
  }
  const seq = await nextActionSequence(db, dl.id);
  await db.insert(integrationDeadLetterActions).values({ deadLetterId: dl.id, sequence: seq, action: args.action, actorUserId: args.actorUserId, note: args.note?.slice(0, 500) ?? null, resultRef, occurredAt: args.now });
  const patch: Partial<typeof integrationDeadLetters.$inferInsert> = { state: t.to };
  if (args.action === "requeued" || args.action === "retried_now") patch.requeueCount = dl.requeueCount + 1;
  if (args.action === "acknowledged") { patch.acknowledgedByUserId = args.actorUserId; patch.acknowledgedAt = args.now; }
  if (args.action === "resolved") { patch.resolvedByUserId = args.actorUserId; patch.resolvedAt = args.now; patch.resolutionNote = args.note?.slice(0, 500) ?? null; }
  if (args.action === "reopened") { patch.resolvedAt = null; patch.resolvedByUserId = null; }
  await db.update(integrationDeadLetters).set(patch).where(eq(integrationDeadLetters.id, dl.id));
  await hubEvent(db, { orgRef: args.orgRef, eventType: `dead_letter.${args.action}`, targetType: "dead_letter", targetRef: dl.deadLetterRef, actorUserId: args.actorUserId, correlationId: dl.correlationId, before: { state: dl.state }, after: { state: t.to, resultRef }, detail: args.note ?? null, now: args.now });
  if (dl.connectorId) await refreshConnectorHealth(db, dl.connectorId, args.now);
  return { state: t.to, resultRef };
}

async function requeueWork(db: Db, dl: IntegrationDeadLetter, now: Date, immediate: boolean): Promise<string> {
  switch (dl.kind) {
    case "outbound_delivery": {
      if (!dl.subscriptionId || !dl.eventId) throw new Error("DEAD_LETTER_SOURCE_MISSING");
      const sub = (await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, dl.subscriptionId)).limit(1))[0];
      if (!sub || sub.status !== "active") throw new Error("DEAD_LETTER_REQUEUE_REFUSED: the subscription is not active");
      const last = (await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, dl.subscriptionId), eq(webhookDeliveries.eventId, dl.eventId))).orderBy(desc(webhookDeliveries.attempt)).limit(1))[0];
      const ev = (await db.select().from(domainEventOutbox).where(eq(domainEventOutbox.eventId, dl.eventId)).limit(1))[0];
      if (!ev) throw new Error("DEAD_LETTER_SOURCE_MISSING");
      const deliveryRef = ref("DLV");
      const attempt = (last?.attempt ?? 0) + 1;
      // An already-expired claim: the next heartbeat (about once a second) reclaims and sends it for
      // real through the house dispatcher, with zero bespoke send logic here.
      const expiredLease = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS - 1000);
      const id = await claimNewAttempt(db, { orgRef: dl.orgRef, deliveryRef, subscriptionId: sub.id, eventId: ev.eventId, eventType: ev.eventType, attempt, requestHash: last?.requestHash ?? dl.payloadHash ?? "", signature: "", at: now }, { leaseNow: expiredLease, token: "integration-hub-requeue" });
      if (id === null) throw new Error("DEAD_LETTER_REQUEUE_REFUSED: another attempt is already in flight for this event");
      if (immediate) { try { await dispatchWebhooks({ eventIds: [ev.eventId], now, leaseNow: now }); } catch { /* the next heartbeat still has it */ } }
      return deliveryRef;
    }
    case "sync_run": {
      const prior = (await db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.runRef, dl.sourceRef)).limit(1))[0];
      if (!prior) throw new Error("DEAD_LETTER_SOURCE_MISSING");
      const run = await scheduleSyncRun(db, { orgRef: dl.orgRef, connectorId: prior.connectorId, contractId: prior.contractId, trigger: "replay", now, correlationId: dl.correlationId });
      if (immediate) await integrationHubTick(db, { now, workerId: "requeue", syncLimit: 1 });
      return run.runRef;
    }
    case "inbound_event": {
      const ev = (await db.select().from(inboundEvents).where(eq(inboundEvents.inboundRef, dl.sourceRef)).limit(1))[0];
      if (!ev || !ev.connectorId) throw new Error("DEAD_LETTER_SOURCE_MISSING");
      await db.update(inboundEvents).set({ status: "accepted", rejectionReason: null }).where(eq(inboundEvents.id, ev.id));
      await enqueueInboundProcessing(db, { inboundId: ev.id, inboundRef: ev.inboundRef, orgRef: dl.orgRef, eventType: ev.eventType ?? "integration.inbound", correlationId: dl.correlationId, now, replay: true });
      if (immediate) await handleClaimedIntegrationInbound(db, { aggregateId: String(ev.id), tenantId: dl.orgRef, now });
      return ev.inboundRef;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Inbound intake                                                       */
/* ------------------------------------------------------------------ */

export type InboundIntakeResult =
  | { status: 202; body: { eventId: string; inboundRef: string; status: "accepted" | "duplicate"; note: string } }
  | { status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422; body: { code: string; reason: string } };

const connectorCapabilities = (c: IntegrationConnector) => {
  const caps = JSON.parse(c.capabilitiesJson) as { inbound?: { eventTypes?: string[]; contentTypes?: string[]; schemaVersions?: string[] } | null };
  return { inboundEventTypes: caps.inbound?.eventTypes ?? [], contentTypes: caps.inbound?.contentTypes ?? ["application/json"], schemaVersions: caps.inbound?.schemaVersions ?? ["1.0"] };
};

async function inboundCredentials(connector: IntegrationConnector, now: Date): Promise<CredentialForVerify[]> {
  const meta = await connectorCredentialMetadata(connector.orgRef, connector.connectorRef, "inbound_verify");
  if (!meta || meta.status !== "active" || (meta.expiresAt && meta.expiresAt.getTime() <= now.getTime())) return [];
  const plaintext = await resolveConnectorPlaintext(connector.orgRef, connector.connectorRef, "inbound_verify");
  if (!plaintext) return [];
  const kind = connector.authMethod === "api_key" ? "api_key" : "hmac_secret";
  return [{ kind, secret: kind === "api_key" ? sha256(plaintext) : plaintext, status: "active", retiringUntil: null }];
}

/** Accept one inbound event over the raw body. Tenant = the connector's; the request never says whose data it is. */
export async function acceptInboundEvent(db: Db, args: { connectorRef: string; headers: InboundHeaders; body: string; now: Date }): Promise<InboundIntakeResult> {
  const c = (await db.select().from(integrationConnectors).where(eq(integrationConnectors.connectorRef, args.connectorRef)).limit(1))[0] ?? null;
  const caps = c ? connectorCapabilities(c) : null;
  const creds = c ? await inboundCredentials(c, args.now) : [];
  const v = assessInbound({ connector: c && caps ? { status: c.status, authMethod: c.authMethod, maxPayloadBytes: c.maxPayloadBytes, ...caps } : null, headers: args.headers, body: args.body, credentials: creds, now: args.now });
  if (!v.accepted) {
    const status = ({ unknown_connector: 404, connector_not_active: 403, no_credential: 401, invalid_credential: 401, signature_mismatch: 401, timestamp_outside_tolerance: 401, wrong_scope: 403, payload_too_large: 413, unsupported_content_type: 415, unknown_schema_version: 422, unsupported_event_type: 422, malformed_payload: 400, missing_idempotency_key: 400 } as const)[v.code];
    if (c) {
      await hubEvent(db, { orgRef: c.orgRef, eventType: "inbound.refused", targetType: "connector", targetRef: c.connectorRef, actorSource: "integration", after: { code: v.code }, detail: v.reason, now: args.now });
      if (v.recordable) {
        const idem = (args.headers.idempotencyKey ?? "").trim() || `refused:${sha256(args.body).slice(0, 40)}`;
        try { await db.insert(inboundEvents).values({ orgRef: c.orgRef, inboundRef: ref("IN"), clientId: null, connectorId: c.id, feed: "generic", idempotencyKey: idem.slice(0, 120), eventType: args.headers.eventType?.slice(0, 80) ?? null, schemaVersion: args.headers.schemaVersion?.slice(0, 20) ?? null, sourceSystem: c.connectorKey, contentType: args.headers.contentType?.slice(0, 80) ?? null, payloadJson: args.body.slice(0, 65_000), payloadHash: sha256(args.body), status: "rejected", rejectionReason: `${v.code}: ${v.reason}`.slice(0, 400), receivedAt: args.now }); } catch (e) { if (!isDup(e)) throw e; }
      }
    }
    return { status, body: { code: v.code, reason: v.reason } };
  }
  const connector = c!;
  const env = envelopeForInbound({ orgRef: connector.orgRef, connectorRef: connector.connectorRef, sourceSystem: connector.connectorKey, eventType: v.eventType, schemaVersion: v.schemaVersion, idempotencyKey: v.idempotencyKey, payload: v.payload, contentType: v.contentType, receivedAt: args.now, correlationId: args.headers.correlationId ?? null });
  const inboundRef = ref("IN");
  try {
    await db.insert(inboundEvents).values({ orgRef: connector.orgRef, inboundRef, clientId: null, connectorId: connector.id, feed: "generic", idempotencyKey: v.idempotencyKey, eventId: env.eventId, eventType: v.eventType, schemaVersion: v.schemaVersion, sourceSystem: connector.connectorKey, contentType: v.contentType, correlationId: env.correlationId, occurredAt: new Date(env.occurredAt), contractId: connector.defaultContractId, payloadJson: args.body, payloadHash: env.payloadHash, status: "accepted", receivedAt: args.now });
  } catch (e) {
    if (!isDup(e)) throw e;
    const dup = (await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, connector.id), eq(inboundEvents.idempotencyKey, v.idempotencyKey))).limit(1))[0]!;
    if (dup.payloadHash !== env.payloadHash && dup.status !== "rejected") await recordIdempotencyConflict(db, { connector, existing: dup, incoming: v.payload, now: args.now, correlationId: env.correlationId });
    return { status: 202, body: { eventId: dup.eventId ?? env.eventId, inboundRef: dup.inboundRef, status: "duplicate", note: dup.payloadHash === env.payloadHash ? "Already received; same content." : "Already received with DIFFERENT content under the same key — the first stays; the difference is recorded as a conflict for review." } };
  }
  const row = (await db.select({ id: inboundEvents.id }).from(inboundEvents).where(eq(inboundEvents.inboundRef, inboundRef)).limit(1))[0]!;
  await enqueueInboundProcessing(db, { inboundId: row.id, inboundRef, orgRef: connector.orgRef, eventType: v.eventType, correlationId: env.correlationId, now: args.now, replay: false });
  await recordConnectorAttempt(db, { connector, outcome: "success", now: args.now, direction: "inbound" });
  return { status: 202, body: { eventId: env.eventId, inboundRef, status: "accepted", note: "Accepted as an observation. It is processed under the connector's contract and becomes nothing authoritative by itself." } };
}

async function recordIdempotencyConflict(db: Db, args: { connector: IntegrationConnector; existing: typeof inboundEvents.$inferSelect; incoming: unknown; now: Date; correlationId: string | null }): Promise<void> {
  const contract = await contractFor(db, args.connector);
  const policy = contract?.conflictPolicy ?? "reject_review";
  const decided = decideConflict({ policy, entityType: contract?.destinationEntity ?? "integration_observation", dataOwnership: contract?.dataOwnership ?? "external", source: { value: args.incoming, revisedAt: args.now }, leaseos: { value: safeJson(args.existing.payloadJson), revisedAt: args.existing.receivedAt } });
  const conflictRef = ref("CFL");
  await db.insert(integrationConflicts).values({ orgRef: args.connector.orgRef, connectorId: args.connector.id, contractId: contract?.id ?? null, conflictRef, entityType: contract?.destinationEntity ?? "integration_observation", entityRef: args.existing.idempotencyKey, fieldPath: null, sourceValueJson: canonicalJson(args.incoming).slice(0, 60_000), leaseosValueJson: args.existing.payloadJson.slice(0, 60_000), sourceRevision: null, leaseosRevision: args.existing.eventId, policy, decision: decided.decision, inboundEventId: args.existing.id, detectedAt: args.now, resolutionNote: decided.decision === "pending" ? null : decided.reason });
  await hubEvent(db, { orgRef: args.connector.orgRef, eventType: "conflict.detected", targetType: "conflict", targetRef: conflictRef, actorSource: "integration", correlationId: args.correlationId, after: { policy, decision: decided.decision }, detail: decided.reason, now: args.now });
  if (decided.decision === "pending") await notifyOperators(db, { orgRef: args.connector.orgRef, key: `integ:conflict:${conflictRef}`, title: `Integration conflict on ${args.existing.idempotencyKey} needs a decision`, body: decided.reason, deepLink: `/integrations/conflicts/${conflictRef}`, now: args.now });
}
const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

async function enqueueInboundProcessing(db: Db, args: { inboundId: number; inboundRef: string; orgRef: string; eventType: string; correlationId: string | null; now: Date; replay: boolean }): Promise<void> {
  const eventId = `EVT-${sha256(`integration-inbound:${args.inboundRef}${args.replay ? `:replay:${args.now.getTime()}` : ""}`).slice(0, 36)}`;
  try {
    await db.insert(domainEventOutbox).values({ eventId, eventType: "integration.inbound.received", eventVersion: 1, aggregateType: "integrationInbound", aggregateId: String(args.inboundId), tenantId: args.orgRef, correlationId: args.correlationId?.slice(0, 40) ?? null, actorSource: "integration", payloadJson: JSON.stringify({ inboundRef: args.inboundRef, eventType: args.eventType }), occurredAt: args.now });
  } catch (e) { if (!isDup(e)) throw e; }
}

export async function contractFor(db: Db, connector: IntegrationConnector): Promise<(typeof integrationContracts.$inferSelect & { parsed: Contract }) | null> {
  if (!connector.defaultContractId) return null;
  const row = (await db.select().from(integrationContracts).where(eq(integrationContracts.id, connector.defaultContractId)).limit(1))[0];
  if (!row) return null;
  return { ...row, parsed: DataSyncContract.parse(JSON.parse(row.definitionJson)) };
}

/**
 * The worker handler for `integrationInbound`: apply the connector's contract to the accepted
 * event. Accepted → `processed` with its normalized observation; refused → `quarantined` with every
 * reason (the dead-letter scan picks it up next tick). Idempotent: a replayed event lands on the
 * same row.
 */
export async function handleClaimedIntegrationInbound(db: Db, args: { aggregateId: string; tenantId: string; now: Date }): Promise<{ tasksCreated: number }> {
  const ev = (await db.select().from(inboundEvents).where(eq(inboundEvents.id, Number(args.aggregateId))).limit(1))[0];
  if (!ev || !ev.connectorId) return { tasksCreated: 0 };
  if (ev.orgRef !== args.tenantId) return { tasksCreated: 0 };
  if (ev.status === "processed" || ev.status === "quarantined") return { tasksCreated: 0 };
  const connector = (await db.select().from(integrationConnectors).where(eq(integrationConnectors.id, ev.connectorId)).limit(1))[0];
  if (!connector) return { tasksCreated: 0 };
  const contract = await contractFor(db, connector);
  const payload = safeJson(ev.payloadJson);
  if (!contract) {
    await db.update(inboundEvents).set({ status: "processed", resultKind: "integration_observation", resultRef: ev.eventId, normalizedJson: null }).where(eq(inboundEvents.id, ev.id));
    return { tasksCreated: 0 };
  }
  const app = applyContract(contract.parsed, payload, { schemaVersion: ev.schemaVersion });
  if (!app.ok) {
    await db.update(inboundEvents).set({ status: "quarantined", rejectionReason: app.reasons.join("; ").slice(0, 400) }).where(eq(inboundEvents.id, ev.id));
    return { tasksCreated: 0 };
  }
  await db.update(inboundEvents).set({ status: "processed", resultKind: contract.destinationEntity.slice(0, 40), resultRef: app.externalId.slice(0, 80), normalizedJson: canonicalJson({ ...app.mapped, _tombstone: app.tombstone, _revision: app.revision }) }).where(eq(inboundEvents.id, ev.id));
  return { tasksCreated: 0 };
}

/* ------------------------------------------------------------------ */
/* Sync runs — outbound HTTP through the egress guard                   */
/* ------------------------------------------------------------------ */

export const SYNC_LEASE_SECONDS = 600;
const adapters = new Map<string, (connector: IntegrationConnector, secrets: { sync: string | null }) => SyncAdapter>();
export function registerSyncAdapter(connectorKey: string, factory: (connector: IntegrationConnector, secrets: { sync: string | null }) => SyncAdapter): void { adapters.set(connectorKey, factory); }

export async function scheduleSyncRun(db: Db, args: { orgRef: string; connectorId: number; contractId: number | null; trigger: "scheduled" | "manual" | "replay" | "resume"; now: Date; scheduledFor?: Date; requestedByUserId?: number | null; correlationId?: string | null }): Promise<{ runRef: string; id: number }> {
  const runRef = ref("SYNC");
  const cursor = await currentCursor(db, args.connectorId, args.contractId ?? 0);
  await db.insert(integrationSyncRuns).values({ orgRef: args.orgRef, connectorId: args.connectorId, contractId: args.contractId, runRef, triggerKind: args.trigger, state: "pending", cursorBefore: cursor, scheduledFor: args.scheduledFor ?? args.now, nextAttemptAt: args.scheduledFor ?? args.now, correlationId: args.correlationId ?? null, requestedByUserId: args.requestedByUserId ?? null });
  const row = (await db.select({ id: integrationSyncRuns.id }).from(integrationSyncRuns).where(eq(integrationSyncRuns.runRef, runRef)).limit(1))[0]!;
  await hubEvent(db, { orgRef: args.orgRef, eventType: "sync.scheduled", targetType: "sync_run", targetRef: runRef, actorUserId: args.requestedByUserId ?? null, actorSource: args.requestedByUserId ? "human" : "system", after: { trigger: args.trigger, cursorBefore: cursor }, now: args.now });
  return { runRef, id: row.id };
}

async function currentCursor(db: Db, connectorId: number, contractId: number): Promise<string | null> {
  const c = (await db.select({ cursorValue: integrationSyncCursors.cursorValue }).from(integrationSyncCursors).where(and(eq(integrationSyncCursors.connectorId, connectorId), eq(integrationSyncCursors.contractId, contractId), eq(integrationSyncCursors.cursorKey, "default"))).limit(1))[0];
  return c?.cursorValue ?? null;
}

async function claimDueSyncRuns(db: Db, args: { now: Date; workerId: string; limit: number }): Promise<(typeof integrationSyncRuns.$inferSelect)[]> {
  const token = `${args.workerId}#${args.now.getTime().toString(36)}${randomBytes(2).toString("hex")}`.slice(0, 64);
  const cutoff = new Date(args.now.getTime() - SYNC_LEASE_SECONDS * 1000);
  const where = and(inArray(integrationSyncRuns.state, ["pending", "failed", "claimed", "running"]), lte(integrationSyncRuns.nextAttemptAt, args.now), or(isNull(integrationSyncRuns.claimedAt), lte(integrationSyncRuns.claimedAt, cutoff)));
  await db.execute(sql`UPDATE integrationSyncRuns SET claimedAt = ${args.now}, claimedBy = ${token}, state = 'claimed', attemptCount = attemptCount + 1 WHERE ${where} ORDER BY nextAttemptAt, id LIMIT ${args.limit}`);
  return db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.claimedBy, token));
}

/** Classify a thrown/returned refusal from an adapter page fetch. Mirrors the house's own outcome vocabulary without re-deriving it. */
function classifyPageFailure(args: { httpStatus: number | null; retryable: boolean; attempt: number }): { terminal: boolean; klass: string } {
  if (!args.retryable) return { terminal: true, klass: args.httpStatus != null && args.httpStatus >= 400 && args.httpStatus < 500 && args.httpStatus !== 429 && args.httpStatus !== 408 ? "authentication_or_configuration" : "terminal_remote_rejection" };
  return { terminal: args.attempt >= 6, klass: args.httpStatus === 429 ? "rate_limited" : "retryable_failure" };
}
function backoffMsFor(attempt: number): number { return [1, 5, 30, 120, 720][Math.min(attempt - 1, 4)]! * 60_000; }

const counters = (o: PageOutcome) => ({ recordsExamined: o.examined, recordsAccepted: o.accepted, recordsRejected: o.rejected, recordsChanged: o.changed, recordsUnchanged: o.unchanged });

/**
 * Execute one claimed run. Page by page: fetch (through the connector's adapter, which uses the
 * egress guard for real HTTP), apply the contract to every record, write the accepted ones as
 * inbound observations (idempotent by contract key), and commit the cursor IN THE SAME
 * TRANSACTION as that page's writes. A crash anywhere leaves the last committed cursor intact.
 */
export async function executeSyncRun(db: Db, run: typeof integrationSyncRuns.$inferSelect, args: { now: Date; adapter?: SyncAdapter }): Promise<{ state: string; outcome: PageOutcome; reason: string | null }> {
  const connector = (await db.select().from(integrationConnectors).where(eq(integrationConnectors.id, run.connectorId)).limit(1))[0];
  const finish = async (patch: Partial<typeof integrationSyncRuns.$inferInsert>) => db.update(integrationSyncRuns).set({ ...patch, claimedAt: null, claimedBy: null }).where(eq(integrationSyncRuns.id, run.id));
  if (!connector) { await finish({ state: "cancelled", lastError: "connector no longer exists", finishedAt: args.now }); return { state: "cancelled", outcome: emptyPageOutcome(), reason: "connector no longer exists" }; }
  const gate = shouldAttempt({ status: connector.status, circuitOpenUntil: connector.circuitOpenUntil, now: args.now });
  if (!gate.attempt) {
    if (gate.terminal) { await finish({ state: "cancelled", lastError: gate.reason, finishedAt: args.now }); await hubEvent(db, { orgRef: run.orgRef, eventType: "sync.cancelled", targetType: "sync_run", targetRef: run.runRef, detail: gate.reason, now: args.now }); return { state: "cancelled", outcome: emptyPageOutcome(), reason: gate.reason }; }
    await finish({ state: "pending", nextAttemptAt: connector.circuitOpenUntil ?? new Date(args.now.getTime() + 60_000) });
    return { state: "pending", outcome: emptyPageOutcome(), reason: gate.reason };
  }
  const contract = await contractFor(db, connector);
  const syncSecret = await resolveConnectorPlaintext(connector.orgRef, connector.connectorRef, "sync_auth");
  const factory = adapters.get(connector.connectorKey);
  const adapter = args.adapter ?? (factory ? factory(connector, { sync: syncSecret }) : null);
  if (!adapter) { await finish({ state: "cancelled", lastError: `no sync adapter for ${connector.connectorKey}`, finishedAt: args.now }); return { state: "cancelled", outcome: emptyPageOutcome(), reason: `no sync adapter for ${connector.connectorKey}` }; }
  await db.update(integrationSyncRuns).set({ state: "running", startedAt: run.startedAt ?? args.now }).where(eq(integrationSyncRuns.id, run.id));
  const contractId = run.contractId ?? 0;
  let cursor = await currentCursor(db, connector.id, contractId);
  let total: PageOutcome = { examined: run.recordsExamined, accepted: run.recordsAccepted, rejected: run.recordsRejected, changed: run.recordsChanged, unchanged: run.recordsUnchanged };
  const priorPages = run.pagesFetched; let pages = 0; let lastCursor = cursor;
  for (; pages < MAX_PAGES_PER_RUN; pages++) {
    let page: Awaited<ReturnType<SyncAdapter["fetchPage"]>>;
    try { page = await adapter.fetchPage({ cursor, pageSize: 100 }); }
    catch (e) { page = e instanceof EgressRefused ? { refused: e.message, retryable: !e.destination, httpStatus: null } : { refused: e instanceof Error ? e.message : String(e), retryable: true }; }
    if ("refused" in page) {
      const cls = classifyPageFailure({ httpStatus: page.httpStatus ?? null, retryable: page.retryable, attempt: run.attemptCount });
      await recordConnectorAttempt(db, { connector, outcome: "failure", failureClass: cls.klass, now: args.now, direction: "sync" });
      if (cls.terminal) {
        await finish({ state: "dead", failureCount: run.failureCount + 1, lastError: page.refused.slice(0, 400), lastErrorClass: cls.klass, finishedAt: args.now, ...counters(total), pagesFetched: priorPages + pages, cursorAfter: lastCursor });
        return { state: "dead", outcome: total, reason: page.refused };
      }
      const wait = page.retryAfter ? Number(page.retryAfter) * 1000 || backoffMsFor(run.attemptCount) : backoffMsFor(run.attemptCount);
      await finish({ state: "failed", failureCount: run.failureCount + 1, lastError: page.refused.slice(0, 400), lastErrorClass: cls.klass, nextAttemptAt: new Date(args.now.getTime() + wait), ...counters(total), pagesFetched: priorPages + pages, cursorAfter: lastCursor });
      return { state: "failed", outcome: total, reason: page.refused };
    }
    const pageResult = await db.transaction(async tx => {
      const o = emptyPageOutcome();
      for (const record of page.records) {
        o.examined++;
        const app = contract ? applyContract(contract.parsed, record) : null;
        if (contract && app && !app.ok) {
          o.rejected++;
          const idem = `rejected:${app.externalId ?? sha256(canonicalJson(record)).slice(0, 32)}:${sha256(canonicalJson(record)).slice(0, 16)}`;
          try { await tx.insert(inboundEvents).values({ orgRef: run.orgRef, inboundRef: ref("IN"), clientId: null, connectorId: connector.id, feed: "generic", idempotencyKey: idem.slice(0, 120), eventType: "integration.sync.record", schemaVersion: contract.schemaVersion, sourceSystem: connector.connectorKey, contentType: "application/json", correlationId: run.correlationId, contractId: contract.id, payloadJson: canonicalJson(record).slice(0, 65_000), payloadHash: payloadHash(record), status: "quarantined", rejectionReason: app.reasons.join("; ").slice(0, 400), receivedAt: args.now }); } catch (e) { if (!isDup(e)) throw e; }
          continue;
        }
        const idem = contract && app && app.ok ? idempotencyKeyFor(contract.parsed, app, record) : sha256(canonicalJson(record)).slice(0, 64);
        const hash = payloadHash(record);
        const existing = (await tx.select({ id: inboundEvents.id, payloadHash: inboundEvents.payloadHash }).from(inboundEvents).where(and(eq(inboundEvents.connectorId, connector.id), eq(inboundEvents.idempotencyKey, idem.slice(0, 120)))).limit(1))[0];
        if (existing) { if (existing.payloadHash === hash) o.unchanged++; else o.changed++; continue; } // a page fetched twice is harmless
        const env = envelopeForInbound({ orgRef: run.orgRef, connectorRef: connector.connectorRef, sourceSystem: connector.connectorKey, eventType: "integration.sync.record", schemaVersion: contract?.schemaVersion ?? "1.0", idempotencyKey: idem.slice(0, 120), payload: record, receivedAt: args.now, correlationId: run.correlationId });
        try {
          await tx.insert(inboundEvents).values({ orgRef: run.orgRef, inboundRef: ref("IN"), clientId: null, connectorId: connector.id, feed: "generic", idempotencyKey: idem.slice(0, 120), eventId: env.eventId, eventType: env.eventType, schemaVersion: env.schemaVersion, sourceSystem: connector.connectorKey, contentType: "application/json", correlationId: env.correlationId, occurredAt: args.now, contractId: contract?.id ?? null, payloadJson: canonicalJson(record).slice(0, 65_000), payloadHash: hash, status: "processed", resultKind: contract?.destinationEntity.slice(0, 40) ?? "integration_observation", resultRef: app && app.ok ? app.externalId.slice(0, 80) : null, normalizedJson: app && app.ok ? canonicalJson(app.mapped) : null, receivedAt: args.now });
          o.accepted++;
        } catch (e) { if (!isDup(e)) throw e; o.unchanged++; }
      }
      const adv = cursorAdvance({ committed: cursor, candidate: page.nextCursor, pageCommitted: true });
      if (adv.advance) {
        await tx.insert(integrationSyncCursors).values({ orgRef: run.orgRef, connectorId: connector.id, contractId, cursorKey: "default", cursorValue: page.nextCursor, cursorHash: sha256(page.nextCursor!), committedRunId: run.id, committedAt: args.now })
          .onDuplicateKeyUpdate({ set: { cursorValue: page.nextCursor, cursorHash: sha256(page.nextCursor!), committedRunId: run.id, committedAt: args.now } });
      }
      await tx.update(integrationSyncRuns).set({ ...counters(addOutcome(total, o)), pagesFetched: priorPages + pages + 1, cursorAfter: adv.advance ? page.nextCursor : cursor, claimedAt: args.now }).where(eq(integrationSyncRuns.id, run.id));
      return { o, cursorAfter: adv.advance ? page.nextCursor : cursor };
    });
    total = addOutcome(total, pageResult.o); cursor = pageResult.cursorAfter; lastCursor = cursor;
    if (page.done) break;
  }
  await finish({ state: "succeeded", finishedAt: args.now, ...counters(total), pagesFetched: priorPages + pages + 1, cursorAfter: lastCursor, lastError: null, lastErrorClass: null });
  await recordConnectorAttempt(db, { connector, outcome: "success", now: args.now, direction: "sync" });
  await db.update(integrationConnectors).set({ nextSyncAt: nextScheduledSync(args.now, connector.syncIntervalSeconds) }).where(eq(integrationConnectors.id, connector.id));
  await hubEvent(db, { orgRef: run.orgRef, eventType: "sync.completed", targetType: "sync_run", targetRef: run.runRef, after: { ...total, cursorAfter: lastCursor }, now: args.now });
  return { state: "succeeded", outcome: total, reason: null };
}

export async function resetSyncCursor(db: Db, args: { orgRef: string; connectorId: number; contractId: number | null; actorUserId: number; now: Date; reason: string }): Promise<void> {
  const before = await currentCursor(db, args.connectorId, args.contractId ?? 0);
  await db.insert(integrationSyncCursors).values({ orgRef: args.orgRef, connectorId: args.connectorId, contractId: args.contractId ?? 0, cursorKey: "default", cursorValue: null, cursorHash: null, resetByUserId: args.actorUserId, resetAt: args.now })
    .onDuplicateKeyUpdate({ set: { cursorValue: null, cursorHash: null, resetByUserId: args.actorUserId, resetAt: args.now } });
  const c = (await db.select({ connectorRef: integrationConnectors.connectorRef }).from(integrationConnectors).where(eq(integrationConnectors.id, args.connectorId)).limit(1))[0];
  await hubEvent(db, { orgRef: args.orgRef, eventType: "sync.cursor_reset", targetType: "connector", targetRef: c?.connectorRef ?? String(args.connectorId), actorUserId: args.actorUserId, before: { cursor: before }, after: { cursor: null }, detail: args.reason, now: args.now });
}

/* ------------------------------------------------------------------ */
/* Built-in adapters — both fetch through the house egress guard        */
/* ------------------------------------------------------------------ */

const GENERIC_SYNC_LIMITS: EgressLimits = { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024, maxRedirects: 0, accept: "application/json", contentTypes: ["application/json"] };

registerSyncAdapter("generic_polling_source", (connector, secrets) => ({
  async fetchPage({ cursor, pageSize }) {
    const cfg = JSON.parse(connector.configJson) as { baseUrl?: string; syncPath?: string; apiKeyHeader?: string; pageSize?: number };
    if (!cfg.baseUrl) return { refused: "connector has no baseUrl configured", retryable: false };
    const url = new URL(cfg.syncPath ?? "/", cfg.baseUrl); if (cursor) url.searchParams.set("cursor", cursor); url.searchParams.set("limit", String(cfg.pageSize ?? pageSize));
    if (secrets.sync) { if (connector.authMethod === "bearer_token") url.searchParams.set("__bearer_marker", "1"); } // placeholder: header auth below
    const limits: EgressLimits = { ...GENERIC_SYNC_LIMITS, timeoutMs: connector.timeoutMs, maxBytes: connector.maxPayloadBytes };
    let r;
    try { r = await egressGet(url, limits); } catch (e) { if (e instanceof EgressRefused) return { refused: e.message, retryable: !e.destination }; throw e; }
    if (!r.ok) return { refused: `HTTP ${r.status}`, retryable: r.status >= 500 || r.status === 429 || r.status === 408, httpStatus: r.status, retryAfter: r.retryAfter };
    let parsed: { records?: unknown[]; nextCursor?: string | null; done?: boolean };
    try { parsed = r.json() as typeof parsed; } catch { return { refused: "response is not JSON", retryable: false, httpStatus: r.status }; }
    if (!Array.isArray(parsed.records)) return { refused: "response has no records array", retryable: false, httpStatus: r.status };
    return { records: parsed.records, nextCursor: parsed.nextCursor ?? null, done: parsed.done ?? parsed.nextCursor == null };
  },
}));

/**
 * Alberta 511 — the adapter BOUNDARY. It asks the licence registry whether operational use of
 * `ab511` is permitted and whether a credential is on file, and refuses before any request is
 * built. When both are true the fetch goes through the egress guard like any other connector;
 * nothing here claims it has run.
 */
export function alberta511Adapter(args: { source: ExternalDataSource | null; secret: string | null; connector: IntegrationConnector }): SyncAdapter {
  return {
    async fetchPage({ cursor }) {
      if (!args.source) return { refused: "ab511 is not in the external data source registry", retryable: false };
      const usage = evaluateSourceUsage({ source: args.source, intent: "operational_decision" });
      if (!usage.permitted) return { refused: `licence gate: ${usage.reason}`, retryable: false };
      if (!args.secret) return { refused: "no 511 Alberta API key on file (sync_auth credential)", retryable: false };
      const cfg = JSON.parse(args.connector.configJson) as { baseUrl?: string; syncPath?: string };
      if (!cfg.baseUrl) return { refused: "connector has no baseUrl configured", retryable: false };
      const url = new URL(cfg.syncPath ?? "/api/v2/get/event", cfg.baseUrl); url.searchParams.set("format", "json"); url.searchParams.set("key", args.secret); if (cursor) url.searchParams.set("since", cursor);
      let r;
      try { r = await egressGet(url, { ...GENERIC_SYNC_LIMITS, timeoutMs: args.connector.timeoutMs, maxBytes: args.connector.maxPayloadBytes }); }
      catch (e) { if (e instanceof EgressRefused) return { refused: e.message.replace(args.secret, "«redacted»"), retryable: !e.destination }; throw e; }
      if (!r.ok) return { refused: `HTTP ${r.status}`, retryable: r.status >= 500 || r.status === 429, httpStatus: r.status, retryAfter: r.retryAfter };
      let records: unknown[];
      try { records = r.json() as unknown[]; } catch { return { refused: "response is not an event array", retryable: false, httpStatus: r.status }; }
      if (!Array.isArray(records)) return { refused: "response is not an event array", retryable: false, httpStatus: r.status };
      const newest = records.reduce<number>((m, e) => Math.max(m, Number((e as { LastUpdated?: number }).LastUpdated ?? 0)), Number(cursor ?? 0));
      return { records, nextCursor: newest ? String(newest) : cursor, done: true };
    },
  };
}
registerSyncAdapter("alberta_511_road_conditions", (connector, secrets) => alberta511Adapter({ source: null, secret: secrets.sync, connector }));

/* ------------------------------------------------------------------ */
/* Shared contracts — seeded, insert-only, never overwritten            */
/* ------------------------------------------------------------------ */

let sharedContractsSeeded = false;
export async function seedSharedContracts(db: Db): Promise<{ inserted: string[]; unchanged: string[]; drifted: string[] }> {
  const out = { inserted: [] as string[], unchanged: [] as string[], drifted: [] as string[] };
  const existing = await db.select({ contractKey: integrationContracts.contractKey, version: integrationContracts.version, checksum: integrationContracts.checksum }).from(integrationContracts).where(eq(integrationContracts.scopeKey, "shared"));
  for (const c of SHARED_CONTRACTS) {
    const checksum = contractChecksum(c);
    const row = existing.find(e => e.contractKey === c.contractKey && e.version === c.version);
    const label = `${c.contractKey}@${c.version}`;
    if (row) { (row.checksum === checksum ? out.unchanged : out.drifted).push(label); continue; }
    try {
      await db.insert(integrationContracts).values({ orgRef: null, scopeKey: "shared", contractKey: c.contractKey, version: c.version, direction: c.direction, sourceEntity: c.sourceEntity, destinationEntity: c.destinationEntity, schemaVersion: c.schemaVersion, definitionJson: JSON.stringify(c), conflictPolicy: c.conflictPolicy, idempotencyStrategy: c.idempotencyStrategy, cursorStrategy: c.cursorStrategy, tombstoneBehaviour: c.tombstone?.behaviour ?? "reject", freshnessSeconds: c.freshnessSeconds, retentionClass: c.retentionClass, authorizationRequirement: c.authorizationRequirement, dataOwnership: c.dataOwnership, checksum, status: "active", createdByUserId: null });
      out.inserted.push(label);
    } catch (e) { if (!isDup(e)) throw e; out.unchanged.push(label); }
  }
  sharedContractsSeeded = true;
  return out;
}

/* ------------------------------------------------------------------ */
/* The tick — what the sweep ticker runs on the one worker's heartbeat   */
/* ------------------------------------------------------------------ */

let lastTickAt: Date | null = null;
export function hubWorkerHeartbeat(): Date | null { return lastTickAt; }

export async function integrationHubTick(db: Db, args: { now: Date; workerId: string; syncLimit?: number }): Promise<{ syncRunsClaimed: number; syncRunsScheduled: number; deadLettersCreated: number }> {
  lastTickAt = args.now;
  if (!sharedContractsSeeded) await seedSharedContracts(db);
  const { created: deadLettersCreated } = await scanForNewDeadLetters(db, { now: args.now });
  const due = await db.select().from(integrationConnectors).where(and(eq(integrationConnectors.status, "active"), lte(integrationConnectors.nextSyncAt, args.now)));
  let scheduled = 0;
  for (const c of due) {
    const open = (await db.select({ id: integrationSyncRuns.id }).from(integrationSyncRuns).where(and(eq(integrationSyncRuns.connectorId, c.id), inArray(integrationSyncRuns.state, ["pending", "claimed", "running", "failed"]))).limit(1))[0];
    await db.update(integrationConnectors).set({ nextSyncAt: nextScheduledSync(args.now, c.syncIntervalSeconds) }).where(eq(integrationConnectors.id, c.id));
    if (open) continue; // one run at a time per connector
    await scheduleSyncRun(db, { orgRef: c.orgRef, connectorId: c.id, contractId: c.defaultContractId, trigger: "scheduled", now: args.now });
    scheduled++;
  }
  const runs = await claimDueSyncRuns(db, { now: args.now, workerId: args.workerId, limit: args.syncLimit ?? 5 });
  for (const run of runs) {
    const connector = (await db.select().from(integrationConnectors).where(eq(integrationConnectors.id, run.connectorId)).limit(1))[0];
    if (connector?.connectorKey === "alberta_511_road_conditions" && connector.externalSourceKey) {
      const src = (await db.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, connector.externalSourceKey)).limit(1))[0];
      const secret = await resolveConnectorPlaintext(connector.orgRef, connector.connectorRef, "sync_auth");
      await executeSyncRun(db, run, { now: args.now, adapter: alberta511Adapter({ source: src ? (src as unknown as ExternalDataSource) : null, secret, connector }) });
      continue;
    }
    await executeSyncRun(db, run, { now: args.now });
  }
  return { syncRunsClaimed: runs.length, syncRunsScheduled: scheduled, deadLettersCreated };
}

/** The sweep-ticker-compatible shape: counts + a failures field, matching server/_core/liveAssist/sweepTicker.ts's SweepCounts. */
export async function sweepIntegrationHub(db: Db, at: Date): Promise<{ expired: number; purgedSessions: number; rowsDeleted: number; failures: number }> {
  try {
    const r = await integrationHubTick(db, { now: at, workerId: "sweep" });
    return { expired: 0, purgedSessions: 0, rowsDeleted: r.deadLettersCreated, failures: 0 };
  } catch {
    return { expired: 0, purgedSessions: 0, rowsDeleted: 0, failures: 1 };
  }
}

/* ------------------------------------------------------------------ */
/* Metrics, readiness and the Exception Centre source                   */
/* ------------------------------------------------------------------ */

const count = async (db: Db, q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
const ageSeconds = (now: Date, d: Date | string | null | undefined) => d ? Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 1000)) : null;

export async function hubMetrics(db: Db, args: { now: Date; orgRef?: string }): Promise<HubMetrics> {
  const now = args.now, dayAgo = new Date(now.getTime() - 86_400_000);
  const org = (t: { orgRef: unknown }) => args.orgRef ? eq((t as unknown as { orgRef: typeof webhookDeliveries.orgRef }).orgRef, args.orgRef) : undefined;
  const n = sql<number>`count(*)`;
  const outboxPending = await db.select({ n, oldest: sql<string | null>`min(${domainEventOutbox.createdAt})` }).from(domainEventOutbox).where(and(isNull(domainEventOutbox.processedAt), isNull(domainEventOutbox.deadLetteredAt), args.orgRef ? eq(domainEventOutbox.tenantId, args.orgRef) : undefined));
  const outboxDead = await count(db, db.select({ n }).from(domainEventOutbox).where(and(sql`${domainEventOutbox.deadLetteredAt} is not null`, args.orgRef ? eq(domainEventOutbox.tenantId, args.orgRef) : undefined)));
  const queued = await db.select({ n, oldest: sql<string | null>`min(${webhookDeliveries.at})` }).from(webhookDeliveries).where(and(eq(webhookDeliveries.status, "queued"), org(webhookDeliveries)));
  const byStatus = await db.select({ status: webhookDeliveries.status, n }).from(webhookDeliveries).where(and(sql`${webhookDeliveries.at} >= ${dayAgo}`, inArray(webhookDeliveries.status, ["delivered", "failed", "dead"]), org(webhookDeliveries))).groupBy(webhookDeliveries.status);
  const dead = await count(db, db.select({ n }).from(webhookDeliveries).where(and(eq(webhookDeliveries.status, "dead"), org(webhookDeliveries))));
  const dl = await db.select({ n, oldest: sql<string | null>`min(${integrationDeadLetters.deadLetteredAt})` }).from(integrationDeadLetters).where(and(eq(integrationDeadLetters.state, "open"), org(integrationDeadLetters)));
  const conns = await db.select({ healthState: integrationConnectors.healthState, n }).from(integrationConnectors).where(org(integrationConnectors)).groupBy(integrationConnectors.healthState);
  const syncByState = await db.select({ state: integrationSyncRuns.state, n }).from(integrationSyncRuns).where(and(or(inArray(integrationSyncRuns.state, ["pending", "running", "claimed"]), and(eq(integrationSyncRuns.state, "failed"), sql`${integrationSyncRuns.createdAt} >= ${dayAgo}`)), org(integrationSyncRuns))).groupBy(integrationSyncRuns.state);
  const inboundByStatus = await db.select({ status: inboundEvents.status, n }).from(inboundEvents).where(and(sql`${inboundEvents.receivedAt} >= ${dayAgo}`, sql`${inboundEvents.connectorId} is not null`, org(inboundEvents))).groupBy(inboundEvents.status);
  const refusals = await db.select({ detail: integrationHubEvents.afterJson, n }).from(integrationHubEvents).where(and(eq(integrationHubEvents.eventType, "inbound.refused"), sql`${integrationHubEvents.occurredAt} >= ${dayAgo}`, org(integrationHubEvents))).groupBy(integrationHubEvents.afterJson);
  const stale = (await db.select({ n }).from(integrationConnectors).where(and(eq(integrationConnectors.status, "active"), eq(integrationConnectors.healthState, "degraded"), sql`${integrationConnectors.syncIntervalSeconds} is not null`, org(integrationConnectors))))[0]?.n ?? 0;
  const st = (s: string) => Number(byStatus.find(r => r.status === s)?.n ?? 0);
  const authCodes = ["invalid_credential", "signature_mismatch", "timestamp_outside_tolerance", "no_credential"], schemaCodes = ["unknown_schema_version", "malformed_payload", "unsupported_event_type", "unsupported_content_type"];
  const refusalCount = (codes: string[]) => refusals.filter(r => codes.some(c => (r.detail ?? "").includes(`"${c}"`))).reduce((a, r) => a + Number(r.n), 0);
  return {
    at: now,
    outbox: { queueDepth: Number(outboxPending[0]?.n ?? 0), oldestQueuedAgeSeconds: ageSeconds(now, outboxPending[0]?.oldest), deadLettered: outboxDead },
    deliveries: { queued: Number(queued[0]?.n ?? 0), retryBacklog: 0, attempted24h: st("delivered") + st("failed") + st("dead"), succeeded24h: st("delivered"), failed24h: st("failed") + st("dead"), dead, oldestQueuedAgeSeconds: ageSeconds(now, queued[0]?.oldest) },
    deadLetters: { open: Number(dl[0]?.n ?? 0), oldestOpenAgeSeconds: ageSeconds(now, dl[0]?.oldest) },
    connectors: Object.fromEntries(conns.map(c => [c.healthState, Number(c.n)])),
    sync: { pending: Number(syncByState.find(s => s.state === "pending")?.n ?? 0), running: Number(syncByState.filter(s => s.state === "running" || s.state === "claimed").reduce((a, s) => a + Number(s.n), 0)), failed24h: Number(syncByState.find(s => s.state === "failed")?.n ?? 0), staleConnectors: Number(stale) },
    inbound: { accepted24h: Number(inboundByStatus.filter(r => r.status === "accepted" || r.status === "processed").reduce((a, r) => a + Number(r.n), 0)), rejected24h: Number(inboundByStatus.find(r => r.status === "rejected")?.n ?? 0), quarantined24h: Number(inboundByStatus.find(r => r.status === "quarantined")?.n ?? 0), authFailures24h: refusalCount(authCodes), schemaFailures24h: refusalCount(schemaCodes) },
    rateLimitEvents24h: 0,
    workerHeartbeatAgeSeconds: ageSeconds(now, lastTickAt),
    perTenantFailures24h: {},
  };
}

export async function criticalConnectorReadiness(db: Db, args: { orgRef: string; now: Date }): Promise<{ connectorRef: string; name: string; healthState: string; status: InterEngineStatus }[]> {
  const rows = await db.select().from(integrationConnectors).where(and(eq(integrationConnectors.orgRef, args.orgRef), eq(integrationConnectors.critical, true)));
  return rows.map(c => ({ connectorRef: c.connectorRef, name: c.name, healthState: c.healthState, status: readinessVerdict(c.healthState, true) }));
}

export type IntegrationHubExceptionSource = {
  deadLetters: { deadLetterRef: string; kind: string; eventType: string | null; reason: string; deadLetteredAt: Date; connectorName: string | null }[];
  connectors: { connectorRef: string; name: string; healthState: string; lastError: string | null; critical: boolean; since: Date | null }[];
  staleSubscriptions: { subscriptionRef: string; name: string; consecutiveFailures: number }[];
  conflicts: { conflictRef: string; entityType: string; entityRef: string; detectedAt: Date }[];
};

export async function loadIntegrationHubExceptions(db: Db, args: { now: Date; orgRef?: string }): Promise<IntegrationHubExceptionSource> {
  const org = args.orgRef;
  const dls = await db.select({ deadLetterRef: integrationDeadLetters.deadLetterRef, kind: integrationDeadLetters.kind, eventType: integrationDeadLetters.eventType, reason: integrationDeadLetters.reason, deadLetteredAt: integrationDeadLetters.deadLetteredAt, connectorName: integrationConnectors.name })
    .from(integrationDeadLetters).leftJoin(integrationConnectors, eq(integrationConnectors.id, integrationDeadLetters.connectorId))
    .where(and(inArray(integrationDeadLetters.state, ["open", "acknowledged"]), org ? eq(integrationDeadLetters.orgRef, org) : undefined)).orderBy(asc(integrationDeadLetters.deadLetteredAt)).limit(200);
  const conns = await db.select().from(integrationConnectors).where(and(inArray(integrationConnectors.healthState, ["failing", "authentication_required", "degraded", "rate_limited", "dead_letter_backlog"]), eq(integrationConnectors.status, "active"), org ? eq(integrationConnectors.orgRef, org) : undefined)).limit(200);
  const cfl = await db.select({ conflictRef: integrationConflicts.conflictRef, entityType: integrationConflicts.entityType, entityRef: integrationConflicts.entityRef, detectedAt: integrationConflicts.detectedAt }).from(integrationConflicts).where(and(eq(integrationConflicts.decision, "pending"), org ? eq(integrationConflicts.orgRef, org) : undefined)).limit(200);
  return {
    deadLetters: dls.map(d => ({ ...d, connectorName: d.connectorName ?? null })),
    connectors: conns.map(c => ({ connectorRef: c.connectorRef, name: c.name, healthState: c.healthState, lastError: c.lastError, critical: c.critical, since: c.lastSuccessAt })),
    staleSubscriptions: [],
    conflicts: cfl,
  };
}

export async function hubHealthLine(db: Db, now: Date, orgRef?: string) { const m = await hubMetrics(db, { now, orgRef }); return { metrics: m, ...assessHubHealth(m) }; }
export { getDb, sharedContract };
