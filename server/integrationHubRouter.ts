/**
 * Integration Hub — the administrative and operational API.
 *
 * Every procedure is role-gated by name and scoped to the caller's acting organization; a
 * connector, subscription, delivery, dead letter, run, cursor, conflict or contract from another
 * organization answers NOT_FOUND. Credential material is never returned by any procedure after
 * creation — it is held in `providerCredentials`/`encryptedSecrets` (S2-C/S2-B) and resolved only
 * server-side. Every state change is a Hub event row.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import {
  INTEGRATION_AUTH_METHODS, inboundEvents, integrationConflicts, integrationConnectors, integrationContracts,
  integrationDeadLetterActions, integrationDeadLetters, integrationHubEvents, integrationSyncRuns, integrationSyncCursors, webhookDeliveries, webhookSubscriptions,
} from "../drizzle/schema";
import { CONNECTOR_DEFINITIONS, connectorDefinition, validateConnectorInstance } from "./_core/integrationHub/registry";
import { DataSyncContract, contractChecksum, contractPolicyRefusal, contractToJsonSchema, SHARED_CONTRACTS } from "./_core/integrationHub/contracts";
import { checkEgressUrl, EgressRefused } from "./_core/egressGuard";
import { egressGet } from "./_core/egressHttp";
import { encryptSecret, mfaKey } from "./_core/externalIdentityPolicy";
import { randomBytes } from "node:crypto";
import {
  actOnDeadLetter, connectorCredentialMetadata, connectorProviderKey, criticalConnectorReadiness, hubEvent, hubHealthLine,
  issueConnectorCredential, ref, refreshConnectorHealth, revokeConnectorCredential, rotateConnectorCredential, scheduleSyncRun, resetSyncCursor,
  type CredentialPurpose, type Db,
} from "./integrationHubService";
import { listCredentials } from "./providerCredentialService";

async function dbOrThrow(): Promise<Db> { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found in the active organization` });
async function scoped(userId: number) { const db = await dbOrThrow(); const orgRef = (await resolveActingScope(db, userId)).tenantId; return { db, orgRef }; }
async function ownedConnector(db: Db, orgRef: string, connectorRef: string) {
  const c = (await db.select().from(integrationConnectors).where(and(eq(integrationConnectors.connectorRef, connectorRef), eq(integrationConnectors.orgRef, orgRef))).limit(1))[0];
  if (!c) throw notFound("Connector");
  return c;
}
const publicConnector = (c: typeof integrationConnectors.$inferSelect) => ({
  connectorRef: c.connectorRef, connectorKey: c.connectorKey, definitionVersion: c.definitionVersion, name: c.name, providerType: c.providerType, direction: c.direction, authMethod: c.authMethod,
  capabilities: JSON.parse(c.capabilitiesJson) as unknown, config: JSON.parse(c.configJson) as unknown, status: c.status, critical: c.critical, dataClassification: c.dataClassification,
  timeoutMs: c.timeoutMs, maxPayloadBytes: c.maxPayloadBytes, syncIntervalSeconds: c.syncIntervalSeconds, nextSyncAt: c.nextSyncAt,
  externalSourceKey: c.externalSourceKey, health: { state: c.healthState, consecutiveFailures: c.consecutiveFailures, circuitOpenUntil: c.circuitOpenUntil, lastSuccessAt: c.lastSuccessAt, lastInboundAt: c.lastInboundAt, lastOutboundAt: c.lastOutboundAt, lastSyncAt: c.lastSyncAt, lastHealthCheckAt: c.lastHealthCheckAt, lastError: c.lastError },
  createdAt: c.createdAt, updatedAt: c.updatedAt,
});
const publicDeadLetter = (d: typeof integrationDeadLetters.$inferSelect) => ({ deadLetterRef: d.deadLetterRef, kind: d.kind, sourceRef: d.sourceRef, eventId: d.eventId, eventType: d.eventType, occurredAt: d.occurredAt, payloadRef: d.payloadRef, payloadHash: d.payloadHash, attemptHistory: JSON.parse(d.attemptHistoryJson) as unknown, attemptCount: d.attemptCount, lastError: d.lastError, httpStatus: d.httpStatus, contractVersion: d.contractVersion, correlationId: d.correlationId, reason: d.reason, reasonDetail: d.reasonDetail, deadLetteredAt: d.deadLetteredAt, state: d.state, requeueCount: d.requeueCount, previousDeadLetterRef: null as string | null, acknowledgedAt: d.acknowledgedAt, resolvedAt: d.resolvedAt, resolutionNote: d.resolutionNote });
const publicRun = (r: typeof integrationSyncRuns.$inferSelect) => ({ runRef: r.runRef, trigger: r.triggerKind, state: r.state, cursorBefore: r.cursorBefore, cursorAfter: r.cursorAfter, records: { examined: r.recordsExamined, accepted: r.recordsAccepted, rejected: r.recordsRejected, changed: r.recordsChanged, unchanged: r.recordsUnchanged }, pagesFetched: r.pagesFetched, failureCount: r.failureCount, attemptCount: r.attemptCount, lastError: r.lastError, lastErrorClass: r.lastErrorClass, scheduledFor: r.scheduledFor, nextAttemptAt: r.nextAttemptAt, startedAt: r.startedAt, finishedAt: r.finishedAt, correlationId: r.correlationId });

const CredentialPurposeInput = z.enum(["inbound_verify", "outbound_auth", "sync_auth"]);

export const integrationHubRouter = router({
  /** The catalogue: what kinds of connector exist, and which are production-authorized versus adapter boundaries. */
  definitionsList: roleProcedure("integrationHub.definitionsList").query(() => ({ definitions: CONNECTOR_DEFINITIONS.map(d => ({ key: d.key, version: d.version, displayName: d.displayName, providerType: d.providerType, direction: d.direction, authMethods: d.authMethods, inbound: d.inbound, outbound: d.outbound, sync: d.sync, safetyCritical: d.safetyCritical, businessCritical: d.businessCritical, humanApprovalRequired: d.humanApprovalRequired, externalSourceKey: d.externalSourceKey, productionAuthorized: d.productionAuthorized, boundaryNote: d.boundaryNote })) })),

  connectorsList: roleProcedure("integrationHub.connectorsList").input(z.object({ status: z.enum(["draft", "active", "disabled", "suspended", "revoked"]).optional() }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const rows = await db.select().from(integrationConnectors).where(and(eq(integrationConnectors.orgRef, orgRef), input?.status ? eq(integrationConnectors.status, input.status) : undefined)).orderBy(desc(integrationConnectors.id)).limit(500);
    return { connectors: rows.map(publicConnector) };
  }),

  connectorGet: roleProcedure("integrationHub.connectorGet").input(z.object({ connectorRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    const [subs, runs, dls, contract, creds] = await Promise.all([
      db.select().from(webhookSubscriptions).where(and(eq(webhookSubscriptions.connectorId, c.id), eq(webhookSubscriptions.orgRef, orgRef))),
      db.select().from(integrationSyncRuns).where(and(eq(integrationSyncRuns.connectorId, c.id), eq(integrationSyncRuns.orgRef, orgRef))).orderBy(desc(integrationSyncRuns.id)).limit(20),
      db.select().from(integrationDeadLetters).where(and(eq(integrationDeadLetters.connectorId, c.id), eq(integrationDeadLetters.orgRef, orgRef), inArray(integrationDeadLetters.state, ["open", "acknowledged"]))).limit(50),
      c.defaultContractId ? db.select().from(integrationContracts).where(eq(integrationContracts.id, c.defaultContractId)).limit(1) : Promise.resolve([]),
      listCredentials({ ownership: "TENANT", orgRef }),
    ]);
    const definition = connectorDefinition(c.connectorKey);
    const prefix = `hub:${c.connectorRef}:`;
    return {
      connector: publicConnector(c), definition: definition ? { productionAuthorized: definition.productionAuthorized, boundaryNote: definition.boundaryNote } : null,
      credentials: creds.filter(cr => cr.providerKey.startsWith(prefix)).map(cr => ({ purpose: cr.providerKey.slice(prefix.length), credentialRef: cr.credentialRef, status: cr.status, fingerprint: cr.fingerprint, credentialVersion: cr.credentialVersion, expiresAt: cr.expiresAt, rotatedAt: cr.rotatedAt, configured: cr.configured })),
      subscriptions: subs.map(s => ({ subscriptionRef: s.subscriptionRef, name: s.name, url: s.url, eventTypes: JSON.parse(s.eventTypesJson) as string[], status: s.status })),
      recentSyncRuns: runs.map(publicRun), openDeadLetters: dls.map(publicDeadLetter),
      contract: contract[0] ? { contractKey: contract[0].contractKey, version: contract[0].version, schemaVersion: contract[0].schemaVersion, checksum: contract[0].checksum } : null,
    };
  }),

  connectorCreate: roleProcedure("integrationHub.connectorCreate")
    .input(z.object({ connectorKey: z.string().min(1).max(80), name: z.string().min(1).max(160), authMethod: z.enum(INTEGRATION_AUTH_METHODS), config: z.record(z.string(), z.unknown()).optional(), critical: z.boolean().default(false), contractKey: z.string().max(80).optional(), contractVersion: z.number().int().positive().optional(), syncIntervalSeconds: z.number().int().positive().max(7 * 86_400).optional(), timeoutMs: z.number().int().positive().max(60_000).optional(), maxPayloadBytes: z.number().int().positive().max(8 * 1_048_576).optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const { db, orgRef } = await scoped(ctx.user.id);
      const definition = connectorDefinition(input.connectorKey);
      if (!definition) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown connector definition ${input.connectorKey}` });
      const v = validateConnectorInstance({ definition, authMethod: input.authMethod, config: input.config ?? {}, critical: input.critical });
      if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join("; ") });
      if (input.syncIntervalSeconds && !definition.sync.supported) throw new TRPCError({ code: "BAD_REQUEST", message: `${definition.key} does not support scheduled synchronization` });
      let contractId: number | null = null;
      if (input.contractKey) {
        const row = (await db.select().from(integrationContracts).where(and(eq(integrationContracts.contractKey, input.contractKey), input.contractVersion ? eq(integrationContracts.version, input.contractVersion) : undefined, or(eq(integrationContracts.scopeKey, orgRef), eq(integrationContracts.scopeKey, "shared")), eq(integrationContracts.status, "active"))).orderBy(desc(integrationContracts.version)).limit(1))[0];
        if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: `Contract ${input.contractKey}${input.contractVersion ? ` v${input.contractVersion}` : ""} is not available to this organization` });
        contractId = row.id;
      }
      const connRef = ref("CONN");
      const now = new Date();
      await db.insert(integrationConnectors).values({
        orgRef, connectorRef: connRef, connectorKey: definition.key, definitionVersion: definition.version, name: input.name, providerType: definition.providerType, direction: definition.direction, authMethod: input.authMethod,
        capabilitiesJson: JSON.stringify({ inbound: definition.inbound, outbound: definition.outbound, sync: definition.sync, requestedScopes: definition.requestedScopes, humanApprovalRequired: definition.humanApprovalRequired }),
        configJson: JSON.stringify(v.config), status: "draft", critical: input.critical, dataClassification: definition.dataClassification,
        timeoutMs: input.timeoutMs ?? definition.timeoutMs, maxPayloadBytes: input.maxPayloadBytes ?? definition.maxPayloadBytes, syncIntervalSeconds: input.syncIntervalSeconds ?? null,
        nextSyncAt: null, defaultContractId: contractId, externalSourceKey: definition.externalSourceKey, residency: definition.residency, retentionDays: definition.retention.minimumDays,
        requiresApprovalJson: definition.humanApprovalRequired.length ? JSON.stringify(definition.humanApprovalRequired) : null, createdByUserId: ctx.user.id,
      });
      await hubEvent(db, { orgRef, eventType: "connector.created", targetType: "connector", targetRef: connRef, actorUserId: ctx.user.id, after: { connectorKey: definition.key, name: input.name, authMethod: input.authMethod, critical: input.critical, config: v.config }, now });
      return { connectorRef: connRef, status: "draft" as const, productionAuthorized: definition.productionAuthorized, note: definition.productionAuthorized ? "Configured. Issue a credential, then set it active." : `Adapter boundary only: ${definition.boundaryNote}` };
    }),

  connectorUpdate: roleProcedure("integrationHub.connectorUpdate")
    .input(z.object({ connectorRef: z.string().min(1).max(64), name: z.string().min(1).max(160).optional(), config: z.record(z.string(), z.unknown()).optional(), critical: z.boolean().optional(), syncIntervalSeconds: z.number().int().positive().max(7 * 86_400).nullable().optional(), timeoutMs: z.number().int().positive().max(60_000).optional(), maxPayloadBytes: z.number().int().positive().max(8 * 1_048_576).optional(), contractKey: z.string().max(80).nullable().optional(), contractVersion: z.number().int().positive().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const { db, orgRef } = await scoped(ctx.user.id);
      const c = await ownedConnector(db, orgRef, input.connectorRef);
      if (c.status === "revoked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A revoked connector is not edited — create a new one" });
      const definition = connectorDefinition(c.connectorKey)!;
      const patch: Partial<typeof integrationConnectors.$inferInsert> = {};
      if (input.name) patch.name = input.name;
      if (input.config) { const v = validateConnectorInstance({ definition, authMethod: c.authMethod, config: input.config, critical: input.critical ?? c.critical }); if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join("; ") }); patch.configJson = JSON.stringify(v.config); }
      if (input.critical != null) { const v = validateConnectorInstance({ definition, authMethod: c.authMethod, config: JSON.parse(c.configJson), critical: input.critical }); if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reasons.join("; ") }); patch.critical = input.critical; }
      if (input.syncIntervalSeconds !== undefined) { if (input.syncIntervalSeconds && !definition.sync.supported) throw new TRPCError({ code: "BAD_REQUEST", message: `${definition.key} does not support scheduled synchronization` }); patch.syncIntervalSeconds = input.syncIntervalSeconds; patch.nextSyncAt = input.syncIntervalSeconds && c.status === "active" ? new Date() : null; }
      if (input.timeoutMs) patch.timeoutMs = input.timeoutMs;
      if (input.maxPayloadBytes) patch.maxPayloadBytes = input.maxPayloadBytes;
      if (input.contractKey !== undefined) {
        if (input.contractKey === null) patch.defaultContractId = null;
        else { const row = (await db.select().from(integrationContracts).where(and(eq(integrationContracts.contractKey, input.contractKey), input.contractVersion ? eq(integrationContracts.version, input.contractVersion) : undefined, or(eq(integrationContracts.scopeKey, orgRef), eq(integrationContracts.scopeKey, "shared")), eq(integrationContracts.status, "active"))).orderBy(desc(integrationContracts.version)).limit(1))[0]; if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: `Contract ${input.contractKey} is not available to this organization` }); patch.defaultContractId = row.id; }
      }
      await db.update(integrationConnectors).set(patch).where(and(eq(integrationConnectors.id, c.id), eq(integrationConnectors.orgRef, orgRef)));
      await hubEvent(db, { orgRef, eventType: "connector.updated", targetType: "connector", targetRef: c.connectorRef, actorUserId: ctx.user.id, before: { name: c.name, critical: c.critical, syncIntervalSeconds: c.syncIntervalSeconds, timeoutMs: c.timeoutMs, maxPayloadBytes: c.maxPayloadBytes, defaultContractId: c.defaultContractId, config: JSON.parse(c.configJson) }, after: { ...patch, config: patch.configJson ? JSON.parse(patch.configJson) : undefined, configJson: undefined } });
      return { connectorRef: c.connectorRef, updated: Object.keys(patch) };
    }),

  /** enable → active; disable → disabled; suspend → suspended (queued work waits); revoke → terminal. */
  connectorSetStatus: roleProcedure("integrationHub.connectorSetStatus").input(z.object({ connectorRef: z.string().min(1).max(64), action: z.enum(["enable", "disable", "suspend", "revoke"]), reason: z.string().min(3).max(300) }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    if (c.status === "revoked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A revoked connector does not come back" });
    const to = ({ enable: "active", disable: "disabled", suspend: "suspended", revoke: "revoked" } as const)[input.action];
    const now = new Date();
    if (to === "active" && c.authMethod !== "none") {
      const live = (await listCredentials({ ownership: "TENANT", orgRef })).some(cr => cr.providerKey.startsWith(`hub:${c.connectorRef}:`) && cr.status === "active");
      if (!live) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A connector with no live credential is not activated — issue one first" });
    }
    await db.update(integrationConnectors).set({ status: to, nextSyncAt: to === "active" && c.syncIntervalSeconds ? now : null, ...(to === "revoked" ? { lastError: input.reason } : {}) }).where(and(eq(integrationConnectors.id, c.id), eq(integrationConnectors.orgRef, orgRef)));
    // Linked subscriptions follow the connector: a disabled/revoked connector sends nothing further
    // (the house dispatcher already skips any non-active subscription).
    if (to !== "active") await db.update(webhookSubscriptions).set({ status: to === "revoked" ? "revoked" : "paused" }).where(and(eq(webhookSubscriptions.connectorId, c.id), eq(webhookSubscriptions.status, "active")));
    await hubEvent(db, { orgRef, eventType: `connector.${input.action}d`, targetType: "connector", targetRef: c.connectorRef, actorUserId: ctx.user.id, before: { status: c.status }, after: { status: to }, detail: input.reason, now });
    await refreshConnectorHealth(db, c.id, now);
    return { connectorRef: c.connectorRef, status: to };
  }),

  /** A dry run against the configured destination: the egress guard's own destination check, and — for a baseUrl — one bodyless GET through it. Never sends a credential. */
  connectionTest: roleProcedure("integrationHub.connectionTest").input(z.object({ connectorRef: z.string().min(1).max(64), url: z.string().url().max(500).optional() }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    const cfg = JSON.parse(c.configJson) as { baseUrl?: string };
    const url = input.url ?? cfg.baseUrl;
    const now = new Date();
    if (!url) { await hubEvent(db, { orgRef, eventType: "connector.tested", targetType: "connector", targetRef: c.connectorRef, actorUserId: ctx.user.id, detail: "no destination configured", now }); return { destination: null, verdict: "no destination configured", reachable: null as boolean | null, status: null as number | null }; }
    let verdict: string, reachable: boolean | null = null, status: number | null = null;
    try {
      checkEgressUrl(url);
      const r = await egressGet(url, { timeoutMs: Math.min(c.timeoutMs, 10_000), maxBytes: 4096, maxRedirects: 0, accept: "application/json", contentTypes: ["application/json", "text/plain", "text/html"] });
      verdict = `HTTP ${r.status}`; reachable = true; status = r.status;
    } catch (e) { verdict = e instanceof EgressRefused ? `refused: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`; reachable = e instanceof EgressRefused ? false : null; }
    await hubEvent(db, { orgRef, eventType: "connector.tested", targetType: "connector", targetRef: c.connectorRef, actorUserId: ctx.user.id, detail: verdict, now });
    return { destination: url, verdict, reachable, status };
  }),

  /** Issue a credential for one purpose. The material is shown ONCE in this response and never again. */
  credentialIssue: roleProcedure("integrationHub.credentialIssue").input(z.object({ connectorRef: z.string().min(1).max(64), purpose: CredentialPurposeInput, material: z.string().min(8).max(4096).optional(), expiresAt: z.coerce.date().optional() }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    const existing = await connectorCredentialMetadata(orgRef, c.connectorRef, input.purpose as CredentialPurpose);
    if (existing) throw new TRPCError({ code: "CONFLICT", message: `A ${input.purpose} credential already exists for this connector; rotate it instead` });
    const r = await issueConnectorCredential({ connector: c, purpose: input.purpose as CredentialPurpose, plaintext: input.material, expiresAt: input.expiresAt ?? null, createdByUserId: ctx.user.id });
    return { credentialRef: r.credentialRef, purpose: input.purpose, shownOnce: r.shownOnce, note: r.shownOnce ? "Shown once. Stored only encrypted." : "Stored encrypted. Not shown." };
  }),

  credentialRotate: roleProcedure("integrationHub.credentialRotate").input(z.object({ connectorRef: z.string().min(1).max(64), purpose: CredentialPurposeInput, material: z.string().min(8).max(4096).optional() }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    try {
      const r = await rotateConnectorCredential({ connectorRef: c.connectorRef, purpose: input.purpose as CredentialPurpose, orgRef, plaintext: input.material });
      await hubEvent(db, { orgRef, eventType: "credential.rotated", targetType: "connector", targetRef: c.connectorRef, actorUserId: ctx.user.id, after: { purpose: input.purpose, credentialVersion: r.credentialVersion } });
      return { credentialRef: r.credentialRef, shownOnce: r.shownOnce, credentialVersion: r.credentialVersion, note: "The previous value is disabled; a request signed with it fails from now on." };
    } catch (e) { if ((e as Error).message === "CREDENTIAL_NOT_FOUND") throw notFound("Credential"); throw e; }
  }),

  credentialRevoke: roleProcedure("integrationHub.credentialRevoke").input(z.object({ connectorRef: z.string().min(1).max(64), purpose: CredentialPurposeInput, reason: z.string().min(3).max(300) }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    try { await revokeConnectorCredential({ connectorRef: c.connectorRef, purpose: input.purpose as CredentialPurpose, orgRef, reason: input.reason, byUserId: ctx.user.id }); } catch (e) { if ((e as Error).message === "CREDENTIAL_NOT_FOUND") throw notFound("Credential"); throw e; }
    await hubEvent(db, { orgRef, eventType: "credential.revoked", targetType: "connector", targetRef: c.connectorRef, actorUserId: ctx.user.id, detail: input.reason, after: { purpose: input.purpose } });
    return { connectorRef: c.connectorRef, purpose: input.purpose, status: "revoked" as const };
  }),

  /** An outbound webhook destination under a connector. The destination and the signing secret are the house's existing webhookSubscriptions/webhookDispatchService.ts (SEC-004); this only links it to the connector. */
  subscriptionCreate: roleProcedure("integrationHub.subscriptionCreate").input(z.object({ connectorRef: z.string().min(1).max(64), name: z.string().min(1).max(160), url: z.string().url().max(500), eventTypes: z.array(z.string().min(1).max(80)).min(1).max(50) }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    if (c.direction === "inbound") throw new TRPCError({ code: "BAD_REQUEST", message: "An inbound-only connector has no outbound destinations" });
    const caps = JSON.parse(c.capabilitiesJson) as { outbound?: { eventTypes?: string[] } | null };
    const allowed = caps.outbound?.eventTypes ?? [];
    for (const t of input.eventTypes) if (!allowed.some(a => a === "*" || a === t || (a.endsWith(".*") && t.startsWith(a.slice(0, -1))) || (t.endsWith(".*") && a.startsWith(t.slice(0, -1))))) throw new TRPCError({ code: "BAD_REQUEST", message: `${c.connectorKey} does not declare outbound event type ${t}` });
    if (!/^https:\/\//.test(input.url)) throw new TRPCError({ code: "BAD_REQUEST", message: "Webhooks are delivered over https only" });
    const key = mfaKey();
    if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Webhook secrets need LEASEOS_PORTAL_MFA_KEY on the server; it is not configured" });
    const subscriptionRef = ref("WH");
    const secret = randomBytes(32).toString("base64url");
    // Same shape as the house `integration.webhookSubscribe` (webhookDispatchService.ts owns the
    // SSRF-guarded send via egressPost); this adds the connector link that path doesn't have.
    await db.insert(webhookSubscriptions).values({ orgRef, connectorId: c.id, subscriptionRef, name: input.name, url: input.url, secretEnc: encryptSecret(secret, key), eventTypesJson: JSON.stringify(input.eventTypes), createdByUserId: ctx.user.id });
    await hubEvent(db, { orgRef, eventType: "subscription.created", targetType: "subscription", targetRef: subscriptionRef, actorUserId: ctx.user.id, after: { connectorRef: c.connectorRef, name: input.name, url: input.url, eventTypes: input.eventTypes } });
    return { subscriptionRef, secret, note: "Shown once. Verify deliveries with HMAC-SHA256 over `timestamp.body`; reject timestamps older than five minutes; de-duplicate on x-leaseos-delivery." };
  }),

  subscriptionSetStatus: roleProcedure("integrationHub.subscriptionSetStatus").input(z.object({ subscriptionRef: z.string().min(1).max(64), status: z.enum(["active", "paused", "revoked"]), reason: z.string().max(300).optional() }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const s = (await db.select().from(webhookSubscriptions).where(and(eq(webhookSubscriptions.subscriptionRef, input.subscriptionRef), eq(webhookSubscriptions.orgRef, orgRef))).limit(1))[0];
    if (!s) throw notFound("Subscription");
    if (s.status === "revoked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A revoked subscription is not reactivated — subscribe again" });
    await db.update(webhookSubscriptions).set({ status: input.status }).where(and(eq(webhookSubscriptions.id, s.id), eq(webhookSubscriptions.orgRef, orgRef)));
    await hubEvent(db, { orgRef, eventType: "subscription.status_changed", targetType: "subscription", targetRef: s.subscriptionRef, actorUserId: ctx.user.id, before: { status: s.status }, after: { status: input.status }, detail: input.reason ?? null });
    return { subscriptionRef: s.subscriptionRef, status: input.status };
  }),

  subscriptionsList: roleProcedure("integrationHub.subscriptionsList").input(z.object({ connectorRef: z.string().max(64).optional() }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = input?.connectorRef ? await ownedConnector(db, orgRef, input.connectorRef) : null;
    const rows = await db.select().from(webhookSubscriptions).where(and(eq(webhookSubscriptions.orgRef, orgRef), c ? eq(webhookSubscriptions.connectorId, c.id) : undefined)).orderBy(desc(webhookSubscriptions.id)).limit(500);
    return { subscriptions: rows.map(s => ({ subscriptionRef: s.subscriptionRef, connectorId: s.connectorId, name: s.name, url: s.url, eventTypes: JSON.parse(s.eventTypesJson) as string[], status: s.status, createdAt: s.createdAt })) };
  }),

  deliveriesList: roleProcedure("integrationHub.deliveriesList").input(z.object({ subscriptionRef: z.string().max(64).optional(), status: z.enum(["queued", "delivered", "failed", "dead"]).optional(), limit: z.number().int().positive().max(500).default(100) })).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const s = input.subscriptionRef ? (await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(and(eq(webhookSubscriptions.subscriptionRef, input.subscriptionRef), eq(webhookSubscriptions.orgRef, orgRef))).limit(1))[0] : undefined;
    if (input.subscriptionRef && !s) throw notFound("Subscription");
    const rows = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.orgRef, orgRef), s ? eq(webhookDeliveries.subscriptionId, s.id) : undefined, input.status ? eq(webhookDeliveries.status, input.status) : undefined)).orderBy(desc(webhookDeliveries.id)).limit(input.limit);
    return { deliveries: rows.map(d => ({ deliveryRef: d.deliveryRef, subscriptionId: d.subscriptionId, eventId: d.eventId, eventType: d.eventType, attempt: d.attempt, status: d.status, responseStatus: d.responseStatus, error: d.error, nextAttemptAt: d.nextAttemptAt, claimedAt: d.claimedAt, at: d.at })) };
  }),

  deliveryAttempts: roleProcedure("integrationHub.deliveryAttempts").input(z.object({ subscriptionRef: z.string().min(1).max(64), eventId: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const s = (await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(and(eq(webhookSubscriptions.subscriptionRef, input.subscriptionRef), eq(webhookSubscriptions.orgRef, orgRef))).limit(1))[0];
    if (!s) throw notFound("Subscription");
    const rows = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, s.id), eq(webhookDeliveries.eventId, input.eventId), eq(webhookDeliveries.orgRef, orgRef))).orderBy(webhookDeliveries.attempt);
    return { attempts: rows.map(d => ({ deliveryRef: d.deliveryRef, attempt: d.attempt, status: d.status, responseStatus: d.responseStatus, error: d.error, nextAttemptAt: d.nextAttemptAt, at: d.at })) };
  }),

  inboundList: roleProcedure("integrationHub.inboundList").input(z.object({ connectorRef: z.string().min(1).max(64), status: z.enum(["accepted", "rejected", "duplicate", "quarantined", "processed"]).optional(), limit: z.number().int().positive().max(500).default(100) })).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    const rows = await db.select().from(inboundEvents).where(and(eq(inboundEvents.connectorId, c.id), eq(inboundEvents.orgRef, orgRef), input.status ? eq(inboundEvents.status, input.status) : undefined)).orderBy(desc(inboundEvents.id)).limit(input.limit);
    return { events: rows.map(r => ({ inboundRef: r.inboundRef, eventId: r.eventId, eventType: r.eventType, schemaVersion: r.schemaVersion, idempotencyKey: r.idempotencyKey, status: r.status, resultKind: r.resultKind, resultRef: r.resultRef, rejectionReason: r.rejectionReason, payloadHash: r.payloadHash, correlationId: r.correlationId, occurredAt: r.occurredAt, receivedAt: r.receivedAt, normalized: r.normalizedJson ? JSON.parse(r.normalizedJson) as unknown : null })) };
  }),

  deadLettersList: roleProcedure("integrationHub.deadLettersList").input(z.object({ state: z.enum(["open", "requeued", "cancelled", "acknowledged", "resolved"]).optional(), connectorRef: z.string().max(64).optional(), limit: z.number().int().positive().max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = input?.connectorRef ? await ownedConnector(db, orgRef, input.connectorRef) : null;
    const rows = await db.select().from(integrationDeadLetters).where(and(eq(integrationDeadLetters.orgRef, orgRef), input?.state ? eq(integrationDeadLetters.state, input.state) : undefined, c ? eq(integrationDeadLetters.connectorId, c.id) : undefined)).orderBy(desc(integrationDeadLetters.id)).limit(input?.limit ?? 100);
    return { deadLetters: rows.map(publicDeadLetter) };
  }),

  deadLetterGet: roleProcedure("integrationHub.deadLetterGet").input(z.object({ deadLetterRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const d = (await db.select().from(integrationDeadLetters).where(and(eq(integrationDeadLetters.deadLetterRef, input.deadLetterRef), eq(integrationDeadLetters.orgRef, orgRef))).limit(1))[0];
    if (!d) throw notFound("Dead letter");
    const actions = await db.select().from(integrationDeadLetterActions).where(eq(integrationDeadLetterActions.deadLetterId, d.id)).orderBy(integrationDeadLetterActions.sequence);
    const prev = d.previousDeadLetterId ? (await db.select({ deadLetterRef: integrationDeadLetters.deadLetterRef }).from(integrationDeadLetters).where(eq(integrationDeadLetters.id, d.previousDeadLetterId)).limit(1))[0] : undefined;
    return { deadLetter: { ...publicDeadLetter(d), previousDeadLetterRef: prev?.deadLetterRef ?? null }, actions: actions.map(a => ({ sequence: a.sequence, action: a.action, actorUserId: a.actorUserId, note: a.note, resultRef: a.resultRef, occurredAt: a.occurredAt })) };
  }),

  deadLetterAct: roleProcedure("integrationHub.deadLetterAct").input(z.object({ deadLetterRef: z.string().min(1).max(64), action: z.enum(["requeued", "retried_now", "cancelled", "acknowledged", "resolved", "reopened"]), note: z.string().max(500).optional() }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    if ((input.action === "resolved" || input.action === "cancelled") && !input.note?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: `${input.action} needs a note saying why` });
    try { return await actOnDeadLetter(db, { orgRef, deadLetterRef: input.deadLetterRef, action: input.action, actorUserId: ctx.user.id, note: input.note ?? null, now: new Date() }); }
    catch (e) {
      const m = (e as Error).message;
      if (m === "DEAD_LETTER_NOT_FOUND") throw notFound("Dead letter");
      if (m.startsWith("DEAD_LETTER_TRANSITION") || m.startsWith("DEAD_LETTER_REQUEUE_REFUSED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: m.split(": ").slice(1).join(": ") });
      if (m === "DEAD_LETTER_SOURCE_MISSING") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The record this dead letter refers to no longer exists" });
      throw e;
    }
  }),

  syncRunsList: roleProcedure("integrationHub.syncRunsList").input(z.object({ connectorRef: z.string().max(64).optional(), state: z.enum(["pending", "claimed", "running", "succeeded", "failed", "cancelled", "dead"]).optional(), limit: z.number().int().positive().max(500).default(50) }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = input?.connectorRef ? await ownedConnector(db, orgRef, input.connectorRef) : null;
    const rows = await db.select().from(integrationSyncRuns).where(and(eq(integrationSyncRuns.orgRef, orgRef), c ? eq(integrationSyncRuns.connectorId, c.id) : undefined, input?.state ? eq(integrationSyncRuns.state, input.state) : undefined)).orderBy(desc(integrationSyncRuns.id)).limit(input?.limit ?? 50);
    return { runs: rows.map(publicRun) };
  }),

  syncRunGet: roleProcedure("integrationHub.syncRunGet").input(z.object({ runRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const r = (await db.select().from(integrationSyncRuns).where(and(eq(integrationSyncRuns.runRef, input.runRef), eq(integrationSyncRuns.orgRef, orgRef))).limit(1))[0];
    if (!r) throw notFound("Sync run");
    const cursor = (await db.select().from(integrationSyncCursors).where(and(eq(integrationSyncCursors.connectorId, r.connectorId), eq(integrationSyncCursors.contractId, r.contractId ?? 0), eq(integrationSyncCursors.cursorKey, "default"))).limit(1))[0];
    return { run: publicRun(r), cursor: cursor ? { value: cursor.cursorValue, committedRunId: cursor.committedRunId, committedAt: cursor.committedAt, resetAt: cursor.resetAt } : null };
  }),

  /** A manual run. Refused for a connector that is not active, or that has a run in flight. */
  syncTrigger: roleProcedure("integrationHub.syncTrigger").input(z.object({ connectorRef: z.string().min(1).max(64) }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    const definition = connectorDefinition(c.connectorKey);
    if (!definition?.sync.supported) throw new TRPCError({ code: "BAD_REQUEST", message: `${c.connectorKey} does not synchronize` });
    if (c.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Connector is ${c.status}; a manual sync needs an active connector` });
    const open = (await db.select({ runRef: integrationSyncRuns.runRef }).from(integrationSyncRuns).where(and(eq(integrationSyncRuns.connectorId, c.id), inArray(integrationSyncRuns.state, ["pending", "claimed", "running"]))).limit(1))[0];
    if (open) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Run ${open.runRef} is already in flight` });
    const run = await scheduleSyncRun(db, { orgRef, connectorId: c.id, contractId: c.defaultContractId, trigger: "manual", now: new Date(), requestedByUserId: ctx.user.id });
    return { runRef: run.runRef, state: "pending" as const, note: definition.productionAuthorized ? "Queued for the worker's next tick." : `Queued; the adapter boundary will refuse and record why: ${definition.boundaryNote}` };
  }),

  syncCursorReset: roleProcedure("integrationHub.syncCursorReset").input(z.object({ connectorRef: z.string().min(1).max(64), reason: z.string().min(5).max(300) }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = await ownedConnector(db, orgRef, input.connectorRef);
    const open = (await db.select({ runRef: integrationSyncRuns.runRef }).from(integrationSyncRuns).where(and(eq(integrationSyncRuns.connectorId, c.id), inArray(integrationSyncRuns.state, ["claimed", "running"]))).limit(1))[0];
    if (open) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Run ${open.runRef} is in flight; a cursor is not reset under a running sync` });
    await resetSyncCursor(db, { orgRef, connectorId: c.id, contractId: c.defaultContractId, actorUserId: ctx.user.id, now: new Date(), reason: input.reason });
    return { connectorRef: c.connectorRef, cursor: null };
  }),

  conflictsList: roleProcedure("integrationHub.conflictsList").input(z.object({ decision: z.enum(["pending", "source_applied", "leaseos_kept", "newest_applied", "rejected", "manual_source", "manual_leaseos", "manual_custom"]).optional(), limit: z.number().int().positive().max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const rows = await db.select().from(integrationConflicts).where(and(eq(integrationConflicts.orgRef, orgRef), input?.decision ? eq(integrationConflicts.decision, input.decision) : undefined)).orderBy(desc(integrationConflicts.id)).limit(input?.limit ?? 100);
    return { conflicts: rows.map(c => ({ conflictRef: c.conflictRef, entityType: c.entityType, entityRef: c.entityRef, fieldPath: c.fieldPath, sourceValue: c.sourceValueJson ? JSON.parse(c.sourceValueJson) as unknown : null, leaseosValue: c.leaseosValueJson ? JSON.parse(c.leaseosValueJson) as unknown : null, policy: c.policy, decision: c.decision, detectedAt: c.detectedAt, resolvedAt: c.resolvedAt, resolutionNote: c.resolutionNote, resolvedValue: c.resolvedValueJson ? JSON.parse(c.resolvedValueJson) as unknown : null })) };
  }),

  conflictResolve: roleProcedure("integrationHub.conflictResolve").input(z.object({ conflictRef: z.string().min(1).max(64), resolution: z.enum(["source", "leaseos", "reject", "custom"]), customValue: z.unknown().optional(), note: z.string().min(3).max(500) }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const c = (await db.select().from(integrationConflicts).where(and(eq(integrationConflicts.conflictRef, input.conflictRef), eq(integrationConflicts.orgRef, orgRef))).limit(1))[0];
    if (!c) throw notFound("Conflict");
    if (c.decision !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Conflict is already ${c.decision}` });
    if (input.resolution === "custom" && input.customValue === undefined) throw new TRPCError({ code: "BAD_REQUEST", message: "A custom resolution needs a value" });
    const decision = ({ source: "manual_source", leaseos: "manual_leaseos", reject: "rejected", custom: "manual_custom" } as const)[input.resolution];
    const resolved = input.resolution === "source" ? c.sourceValueJson : input.resolution === "leaseos" ? c.leaseosValueJson : input.resolution === "custom" ? JSON.stringify(input.customValue) : null;
    const now = new Date();
    await db.update(integrationConflicts).set({ decision, resolvedByUserId: ctx.user.id, resolvedAt: now, resolutionNote: input.note, resolvedValueJson: resolved }).where(and(eq(integrationConflicts.id, c.id), eq(integrationConflicts.orgRef, orgRef)));
    if (c.inboundEventId && resolved && input.resolution !== "reject") await db.update(inboundEvents).set({ normalizedJson: resolved }).where(and(eq(inboundEvents.id, c.inboundEventId), eq(inboundEvents.orgRef, orgRef)));
    await hubEvent(db, { orgRef, eventType: "conflict.resolved", targetType: "conflict", targetRef: c.conflictRef, actorUserId: ctx.user.id, before: { decision: c.decision }, after: { decision }, detail: input.note, now });
    return { conflictRef: c.conflictRef, decision };
  }),

  contractsList: roleProcedure("integrationHub.contractsList").input(z.object({ includeJsonSchema: z.boolean().default(false) }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const rows = await db.select().from(integrationContracts).where(or(eq(integrationContracts.scopeKey, orgRef), eq(integrationContracts.scopeKey, "shared"))).orderBy(integrationContracts.contractKey, desc(integrationContracts.version));
    return {
      contracts: rows.map(r => { const parsed = DataSyncContract.parse(JSON.parse(r.definitionJson)); return { contractKey: r.contractKey, version: r.version, scope: r.scopeKey === "shared" ? "shared" : "organization", direction: r.direction, sourceEntity: r.sourceEntity, destinationEntity: r.destinationEntity, schemaVersion: r.schemaVersion, conflictPolicy: r.conflictPolicy, idempotencyStrategy: r.idempotencyStrategy, cursorStrategy: r.cursorStrategy, tombstoneBehaviour: r.tombstoneBehaviour, freshnessSeconds: r.freshnessSeconds, retentionClass: r.retentionClass, authorizationRequirement: r.authorizationRequirement, dataOwnership: r.dataOwnership, checksum: r.checksum, status: r.status, fields: parsed.fields, jsonSchema: input?.includeJsonSchema ? contractToJsonSchema(parsed) : undefined }; }),
      sharedInCode: SHARED_CONTRACTS.map(c => ({ contractKey: c.contractKey, version: c.version, checksum: contractChecksum(c) })),
    };
  }),

  /** A new organization-owned contract version. Declarative only; a fail-closed entity with a permissive policy is refused. */
  contractCreate: roleProcedure("integrationHub.contractCreate").input(z.object({ contract: z.unknown() }).strict()).mutation(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const parsed = DataSyncContract.safeParse(input.contract);
    if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const contract = parsed.data;
    const refusal = contractPolicyRefusal(contract);
    if (refusal) throw new TRPCError({ code: "BAD_REQUEST", message: refusal });
    const existing = (await db.select({ id: integrationContracts.id }).from(integrationContracts).where(and(eq(integrationContracts.scopeKey, orgRef), eq(integrationContracts.contractKey, contract.contractKey), eq(integrationContracts.version, contract.version))).limit(1))[0];
    if (existing) throw new TRPCError({ code: "CONFLICT", message: `Contract ${contract.contractKey} v${contract.version} already exists; publish a higher version` });
    const checksum = contractChecksum(contract);
    await db.insert(integrationContracts).values({ orgRef, scopeKey: orgRef, contractKey: contract.contractKey, version: contract.version, direction: contract.direction, sourceEntity: contract.sourceEntity, destinationEntity: contract.destinationEntity, schemaVersion: contract.schemaVersion, definitionJson: JSON.stringify(contract), conflictPolicy: contract.conflictPolicy, idempotencyStrategy: contract.idempotencyStrategy, cursorStrategy: contract.cursorStrategy, tombstoneBehaviour: contract.tombstone?.behaviour ?? "reject", freshnessSeconds: contract.freshnessSeconds, retentionClass: contract.retentionClass, authorizationRequirement: contract.authorizationRequirement, dataOwnership: contract.dataOwnership, checksum, status: "active", createdByUserId: ctx.user.id });
    await hubEvent(db, { orgRef, eventType: "contract.created", targetType: "contract", targetRef: `${contract.contractKey}@${contract.version}`, actorUserId: ctx.user.id, after: { checksum, direction: contract.direction, conflictPolicy: contract.conflictPolicy, fields: contract.fields.length } });
    return { contractKey: contract.contractKey, version: contract.version, checksum };
  }),

  /** The Hub's measurable state for this organization, plus what its critical connectors say to readiness. */
  health: roleProcedure("integrationHub.health").query(async ({ ctx }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const now = new Date();
    const h = await hubHealthLine(db, now, orgRef);
    return { state: h.state, line: h.line, metrics: h.metrics, criticalConnectors: await criticalConnectorReadiness(db, { orgRef, now }) };
  }),

  auditList: roleProcedure("integrationHub.auditList").input(z.object({ targetType: z.string().max(40).optional(), targetRef: z.string().max(80).optional(), limit: z.number().int().positive().max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
    const { db, orgRef } = await scoped(ctx.user.id);
    const rows = await db.select().from(integrationHubEvents).where(and(eq(integrationHubEvents.orgRef, orgRef), input?.targetType ? eq(integrationHubEvents.targetType, input.targetType) : undefined, input?.targetRef ? eq(integrationHubEvents.targetRef, input.targetRef) : undefined)).orderBy(desc(integrationHubEvents.id)).limit(input?.limit ?? 100);
    return { events: rows.map(e => ({ eventRef: e.eventRef, eventType: e.eventType, targetType: e.targetType, targetRef: e.targetRef, actorUserId: e.actorUserId, actorSource: e.actorSource, correlationId: e.correlationId, before: e.beforeJson ? JSON.parse(e.beforeJson) as unknown : null, after: e.afterJson ? JSON.parse(e.afterJson) as unknown : null, detail: e.detail, occurredAt: e.occurredAt })) };
  }),
});
