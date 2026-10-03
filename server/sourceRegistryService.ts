/**
 * The approved external source registry — data access, change control, and the one gateway through
 * which a registry-governed request reaches the network.
 *
 * The rules are pure (`_core/sourceRegistry.ts`); this module applies them to rows. Every change to
 * a source or its endpoints:
 *   - locks the source row and checks the writer's `expectedRowVersion` (CONFLICT when someone else
 *     changed it first), then bumps `rowVersion`;
 *   - writes an `externalSourceEvents` row in the same transaction, with who, why and the revision;
 *   - bumps `revision` when it changes what may be contacted, which leaves the current approval
 *     covering an older revision — an approved source goes back to pending approval.
 *
 * `registryGet` is the gateway: business authorization has already happened in the procedure; this
 * resolves the URL to its endpoint, checks the source's approval against the database on every
 * call (so a revocation stops the next request), and hands the request to the egress guard with the
 * endpoint's rule as a destination policy. There is no path from an approval to a raw `fetch`.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  externalDataSources, externalDatasetImports, externalFeedFetches, externalSourceApprovals, externalSourceEndpoints,
  externalSourceEvents, providerCredentials, type ExternalSourceEndpointRow,
} from "../drizzle/schema";
import { getDb, seedExternalDataSources } from "./db";
import { EgressRefused, guardedGet, type EgressEdges, type EgressLimits, type EgressResponse } from "./_core/egressGuard";
import { httpsTransport, systemResolver } from "./_core/egressHttp";
import {
  approverRefusal, effectiveLimits, lifecycleAfterNetworkEdit, networkChange, REGISTRY_PURPOSES, reviewByRefusal, runtimeDecision,
  sameAuthority, selectEndpoint, transition, validateEndpoint,
  type EndpointInput, type EndpointMethod, type RegistryAction, type RegistryDecision, type RegistryPurpose, type RegistryRefusalCode,
  type SourceLifecycle,
} from "./_core/sourceRegistry";
import { ENDPOINT_SEEDS, REVIEW_SEEDS } from "./_core/sourceRegistrySeeds";

export type SourceRegistryErrorCode = RegistryRefusalCode | "not_found" | "conflict" | "invalid" | "separation_of_duties";

export class SourceRegistryError extends Error {
  constructor(readonly code: SourceRegistryErrorCode, message: string) {
    super(message);
    this.name = "SourceRegistryError";
  }
}

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}
type Db = Awaited<ReturnType<typeof dbOrThrow>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SourceRow = typeof externalDataSources.$inferSelect;
type Actor = { userId: number };

/* ---------------- views: what leaves this module, and nothing more ---------------- */

/** A source as a reader sees it. Every field is named; nothing is spread from the row. */
function sourceView(s: SourceRow) {
  return {
    sourceKey: s.sourceKey, displayName: s.displayName, authority: s.authority, category: s.category, jurisdiction: s.jurisdiction,
    sourceUrl: s.sourceUrl, termsUrl: s.termsUrl, sourceClass: s.sourceClass, riskClass: s.riskClass, sensitivity: s.sensitivity,
    lifecycle: s.lifecycle, revision: s.revision, rowVersion: s.rowVersion, lifecycleChangedAt: s.lifecycleChangedAt, updatedAt: s.updatedAt,
    licence: {
      status: s.status, name: s.licenceName, url: s.licenceUrl, attributionRequired: s.attributionRequired, attributionText: s.attributionText,
      commercialUsePermitted: s.commercialUsePermitted, redistributionPermitted: s.redistributionPermitted,
      reviewedByUserId: s.reviewedByUserId, reviewedAt: s.reviewedAt,
    },
  };
}

/** An endpoint as a reader sees it. A credential is reported as bound or not — never its reference's target. */
function endpointView(e: ExternalSourceEndpointRow) {
  return {
    endpointRef: e.endpointRef, endpointKey: e.endpointKey, displayName: e.displayName, serviceType: e.serviceType, httpMethod: e.httpMethod,
    canonicalUrl: e.canonicalUrl, hostname: e.hostname, port: e.port, pathPrefix: e.pathPrefix, pathMatch: e.pathMatch,
    authScheme: e.authScheme, credentialBound: e.credentialRef !== null, contentTypes: e.contentTypesJson,
    timeoutMs: e.timeoutMs, maxBytes: e.maxBytes, enabled: e.enabled,
    health: {
      lastAttemptAt: e.lastAttemptAt, lastSuccessAt: e.lastSuccessAt, lastFailureAt: e.lastFailureAt, consecutiveFailures: e.consecutiveFailures,
      lastOutcome: e.lastOutcome, lastHttpStatus: e.lastHttpStatus, schemaChangedAt: e.schemaChangedAt,
    },
  };
}

function approvalView(a: typeof externalSourceApprovals.$inferSelect) {
  return {
    approvalRef: a.approvalRef, state: a.state, sourceRevision: a.sourceRevision, scope: a.scopeJson,
    requestedByUserId: a.requestedByUserId, requestedAt: a.requestedAt, requestReason: a.requestReason,
    reviewedByUserId: a.reviewedByUserId, reviewedAt: a.reviewedAt, reviewNote: a.reviewNote,
    approvedByUserId: a.approvedByUserId, approvedAt: a.approvedAt, expiresAt: a.expiresAt,
    revokedByUserId: a.revokedByUserId, revokedAt: a.revokedAt, revokeReason: a.revokeReason,
  };
}

/* ---------------- reads ---------------- */

export async function listSources() {
  const db = await dbOrThrow();
  const sources = await db.select().from(externalDataSources).orderBy(externalDataSources.sourceKey);
  const endpoints = await db.select({ sourceId: externalSourceEndpoints.externalDataSourceId, enabled: externalSourceEndpoints.enabled }).from(externalSourceEndpoints);
  return sources.map(s => ({
    ...sourceView(s),
    endpoints: endpoints.filter(e => e.sourceId === s.id).length,
    enabledEndpoints: endpoints.filter(e => e.sourceId === s.id && e.enabled).length,
  }));
}

export async function getSource(sourceKey: string) {
  const db = await dbOrThrow();
  const s = (await db.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, sourceKey)).limit(1))[0];
  if (!s) throw new SourceRegistryError("not_found", `No source ${sourceKey} in the registry`);
  const endpoints = await db.select().from(externalSourceEndpoints).where(eq(externalSourceEndpoints.externalDataSourceId, s.id)).orderBy(externalSourceEndpoints.endpointKey);
  const approvals = await db.select().from(externalSourceApprovals).where(eq(externalSourceApprovals.externalDataSourceId, s.id)).orderBy(desc(externalSourceApprovals.id)).limit(20);
  const events = await db.select().from(externalSourceEvents).where(eq(externalSourceEvents.externalDataSourceId, s.id)).orderBy(desc(externalSourceEvents.id)).limit(50);
  return {
    source: sourceView(s),
    endpoints: endpoints.map(endpointView),
    approvals: approvals.map(approvalView),
    events: events.map(e => ({
      eventType: e.eventType, endpointId: e.endpointId, fromLifecycle: e.fromLifecycle, toLifecycle: e.toLifecycle, sourceRevision: e.sourceRevision,
      actorUserId: e.actorUserId, reason: e.reason, detail: e.detailJson, createdAt: e.createdAt,
    })),
  };
}

/** Endpoint health and the recent fetch log. The log names a path, never a query string. */
export async function health(sourceKey?: string) {
  const db = await dbOrThrow();
  const sources = sourceKey
    ? await db.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, sourceKey))
    : await db.select().from(externalDataSources);
  if (sourceKey && !sources.length) throw new SourceRegistryError("not_found", `No source ${sourceKey} in the registry`);
  const ids = sources.map(s => s.id);
  if (!ids.length) return { endpoints: [], recentFetches: [] };
  const endpoints = await db.select().from(externalSourceEndpoints).where(inArray(externalSourceEndpoints.externalDataSourceId, ids));
  const fetches = await db.select().from(externalFeedFetches).where(inArray(externalFeedFetches.externalDataSourceId, ids)).orderBy(desc(externalFeedFetches.id)).limit(50);
  const keyOf = new Map(sources.map(s => [s.id, s.sourceKey] as const));
  return {
    endpoints: endpoints.map(e => ({ sourceKey: keyOf.get(e.externalDataSourceId) ?? null, lifecycle: sources.find(s => s.id === e.externalDataSourceId)?.lifecycle ?? null, ...endpointView(e) })),
    recentFetches: fetches.map(f => ({
      endpointRef: f.feedKey, requestedAt: f.requestedAt, respondedAt: f.respondedAt, httpStatus: f.httpStatus, outcome: f.outcome, detail: f.detail, payloadChecksum: f.payloadChecksum,
    })),
  };
}

/* ---------------- change control ---------------- */

async function lockSource(tx: Tx, sourceKey: string, expectedRowVersion: number): Promise<SourceRow> {
  const s = (await tx.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, sourceKey)).for("update").limit(1))[0];
  if (!s) throw new SourceRegistryError("not_found", `No source ${sourceKey} in the registry`);
  if (s.rowVersion !== expectedRowVersion) {
    throw new SourceRegistryError("conflict", `${sourceKey} changed since it was read (version ${expectedRowVersion}, now ${s.rowVersion}); reload it and try again`);
  }
  return s;
}

async function bump(tx: Tx, s: SourceRow, set: Partial<typeof externalDataSources.$inferInsert> = {}) {
  await tx.update(externalDataSources).set({ ...set, rowVersion: s.rowVersion + 1, updatedAt: new Date() }).where(eq(externalDataSources.id, s.id));
}

async function openProposal(tx: Tx, sourceId: number) {
  return (await tx.select().from(externalSourceApprovals)
    .where(and(eq(externalSourceApprovals.externalDataSourceId, sourceId), eq(externalSourceApprovals.state, "proposed")))
    .orderBy(desc(externalSourceApprovals.id)).limit(1))[0] ?? null;
}

async function standingApproval(db: Db | Tx, sourceId: number) {
  return (await db.select().from(externalSourceApprovals)
    .where(and(eq(externalSourceApprovals.externalDataSourceId, sourceId), eq(externalSourceApprovals.state, "approved")))
    .orderBy(desc(externalSourceApprovals.id)).limit(1))[0] ?? null;
}

const scopeOf = (scope: readonly string[]): RegistryPurpose[] => {
  const unknown = scope.filter(p => (REGISTRY_PURPOSES as readonly string[]).indexOf(p) < 0);
  if (!scope.length || unknown.length) throw new SourceRegistryError("invalid", unknown.length ? `not a purpose any runtime path checks: ${unknown.join(", ")}` : "an approval names at least one purpose");
  return scope as RegistryPurpose[];
};

/**
 * A change to what may be contacted. The source moves to its next revision; any approval or open
 * request covers the old one and is superseded. An approved or suspended source goes back to
 * pending approval with a request raised by the editor, carrying the scope it had.
 */
async function networkEdit(tx: Tx, s: SourceRow, actor: Actor, reason: string): Promise<{ revision: number; lifecycle: SourceLifecycle }> {
  const next = lifecycleAfterNetworkEdit(s.lifecycle);
  if (!next.ok) throw new SourceRegistryError("invalid", next.reason);
  const revision = s.revision + 1;
  const prior = (await openProposal(tx, s.id)) ?? (await standingApproval(tx, s.id));
  await tx.update(externalSourceApprovals).set({ state: "superseded", supersededAt: new Date() })
    .where(and(eq(externalSourceApprovals.externalDataSourceId, s.id), inArray(externalSourceApprovals.state, ["proposed", "approved"])));
  let approvalId: number | null = null;
  if (next.reReview && prior) {
    const ins = await tx.insert(externalSourceApprovals).values({
      approvalRef: ref("SRA"), externalDataSourceId: s.id, sourceRevision: revision, state: "proposed",
      scopeJson: prior.scopeJson, requestedByUserId: actor.userId, requestReason: reason,
    });
    approvalId = ins[0].insertId;
  }
  await tx.update(externalDataSources).set({
    revision, revisionByUserId: actor.userId,
    ...(next.to !== s.lifecycle ? { lifecycle: next.to, lifecycleChangedAt: new Date() } : {}),
  }).where(eq(externalDataSources.id, s.id));
  if (next.reReview) {
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, approvalId, eventType: "review_requested", fromLifecycle: s.lifecycle, toLifecycle: next.to,
      sourceRevision: revision, actorUserId: actor.userId, reason: `A change to what may be contacted needs a fresh approval: ${reason}`,
    });
  }
  return { revision, lifecycle: next.to };
}

/**
 * What the registry writes about a source: identity, classification and where its terms are. The licence
 * determinations — attribution, commercial use, redistribution, cleared or not — belong to the licence
 * review (`geo.sourceReview`, a sensitive permission) and are never written here.
 */
export type SourceIdentity = {
  displayName: string; authority: string; category: typeof externalDataSources.$inferInsert.category;
  jurisdiction?: string | null; sourceUrl?: string | null; termsUrl?: string | null;
  sourceClass?: typeof externalDataSources.$inferInsert.sourceClass; riskClass?: typeof externalDataSources.$inferInsert.riskClass;
  sensitivity?: typeof externalDataSources.$inferInsert.sensitivity; notes?: string | null;
};
const IDENTITY_FIELDS = ["displayName", "authority", "category", "jurisdiction", "sourceUrl", "termsUrl", "sourceClass", "riskClass", "sensitivity", "notes"] as const;
/** A new source may also say which licence a reviewer should read. */
export type SourceInput = SourceIdentity & { sourceKey: string; licenceName?: string | null; licenceUrl?: string | null };

/** A new source starts as a draft whose licence is unreviewed and whose permissions are unknown. It authorises nothing. */
export async function createSource(actor: Actor, input: SourceInput, reason: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const exists = (await tx.select({ id: externalDataSources.id }).from(externalDataSources).where(eq(externalDataSources.sourceKey, input.sourceKey)).limit(1))[0];
    if (exists) throw new SourceRegistryError("conflict", `${input.sourceKey} is already in the registry`);
    const ins = await tx.insert(externalDataSources).values({
      sourceKey: input.sourceKey, displayName: input.displayName, authority: input.authority, category: input.category,
      jurisdiction: input.jurisdiction ?? null, sourceUrl: input.sourceUrl ?? null, termsUrl: input.termsUrl ?? null,
      sourceClass: input.sourceClass ?? null, riskClass: input.riskClass ?? null, sensitivity: input.sensitivity ?? null,
      licenceName: input.licenceName ?? null, licenceUrl: input.licenceUrl ?? null, attributionText: null,
      commercialUsePermitted: "unknown", redistributionPermitted: "unknown",
      notes: input.notes ?? null, status: "unverified", lifecycle: "draft", createdByUserId: actor.userId,
    });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: ins[0].insertId, eventType: "created", toLifecycle: "draft", sourceRevision: 1, actorUserId: actor.userId, reason,
    });
    return { sourceKey: input.sourceKey, lifecycle: "draft" as const, rowVersion: 1 };
  });
}

/** Identity, classification and terms. None of it changes what may be contacted, so no revision is made. */
export async function updateSource(actor: Actor, sourceKey: string, expectedRowVersion: number, patch: Partial<SourceIdentity>, reason: string) {
  const given = patch as Record<string, unknown>;
  const outside = Object.keys(given).filter(k => (IDENTITY_FIELDS as readonly string[]).indexOf(k) < 0);
  if (outside.length) throw new SourceRegistryError("invalid", `not a registry field (licence determinations are the licence review's): ${outside.join(", ")}`);
  const fields = IDENTITY_FIELDS.filter(k => given[k] !== undefined);
  if (!fields.length) throw new SourceRegistryError("invalid", "nothing to change");
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    if (s.lifecycle === "retired") throw new SourceRegistryError("invalid", `${sourceKey} is retired`);
    const set: Partial<typeof externalDataSources.$inferInsert> = {};
    for (const k of fields) (set as Record<string, unknown>)[k] = given[k];
    await bump(tx, s, set);
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, eventType: "updated", fromLifecycle: s.lifecycle, toLifecycle: s.lifecycle, sourceRevision: s.revision,
      actorUserId: actor.userId, reason, detailJson: { fields },
    });
    return { sourceKey, rowVersion: s.rowVersion + 1 };
  });
}

export type EndpointEdit = Omit<EndpointInput, "credentialRef"> & { enabled: boolean };

/**
 * An enabled endpoint that would govern the same requests — same host, port, method and path
 * prefix — wherever it is registered. Two enabled endpoints that tie are refused at runtime as
 * ambiguous, so enabling a second one would stop the first; it is refused here instead.
 */
async function enabledTwin(tx: Tx, ep: { hostname: string; port: number; pathPrefix: string; httpMethod: EndpointMethod }, exceptId: number | null) {
  const rows = await tx.select({ id: externalSourceEndpoints.id, endpointRef: externalSourceEndpoints.endpointRef }).from(externalSourceEndpoints)
    .innerJoin(externalDataSources, eq(externalDataSources.id, externalSourceEndpoints.externalDataSourceId))
    .where(and(eq(externalSourceEndpoints.hostname, ep.hostname), eq(externalSourceEndpoints.port, ep.port), eq(externalSourceEndpoints.pathPrefix, ep.pathPrefix),
      eq(externalSourceEndpoints.httpMethod, ep.httpMethod), eq(externalSourceEndpoints.enabled, true)));
  return rows.find(r => r.id !== exceptId) ?? null;
}

/** Add an endpoint. Binding a credential is a separate act with its own permission (`bindCredential`). */
export async function addEndpoint(actor: Actor, sourceKey: string, expectedRowVersion: number, edit: EndpointEdit, reason: string) {
  const v = validateEndpoint({ ...edit, credentialRef: null });
  if (!v.ok) throw new SourceRegistryError("invalid", v.reasons.join("; "));
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    if (s.lifecycle === "retired") throw new SourceRegistryError("invalid", `${sourceKey} is retired`);
    const dup = (await tx.select({ id: externalSourceEndpoints.id }).from(externalSourceEndpoints)
      .where(and(eq(externalSourceEndpoints.externalDataSourceId, s.id), eq(externalSourceEndpoints.endpointKey, edit.endpointKey))).limit(1))[0];
    if (dup) throw new SourceRegistryError("conflict", `${sourceKey} already has an endpoint ${edit.endpointKey}`);
    const ep = v.endpoint;
    const twin = edit.enabled ? await enabledTwin(tx, ep, null) : null;
    if (twin) throw new SourceRegistryError("conflict", `${twin.endpointRef} already governs ${ep.canonicalUrl}; disable it before enabling another`);
    const ins = await tx.insert(externalSourceEndpoints).values({
      endpointRef: `${sourceKey}/${ep.endpointKey}`, externalDataSourceId: s.id, endpointKey: ep.endpointKey, displayName: ep.displayName,
      serviceType: ep.serviceType, httpMethod: ep.httpMethod, hostname: ep.hostname, port: ep.port, pathPrefix: ep.pathPrefix,
      pathMatch: ep.pathMatch, canonicalUrl: ep.canonicalUrl, authScheme: ep.authScheme, credentialRef: null,
      contentTypesJson: ep.contentTypes, timeoutMs: ep.timeoutMs, maxBytes: ep.maxBytes, enabled: edit.enabled, createdByUserId: actor.userId,
    });
    const endpointId = ins[0].insertId;
    const after = edit.enabled ? await networkEdit(tx, s, actor, reason) : { revision: s.revision, lifecycle: s.lifecycle };
    await bump(tx, s);
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, endpointId, eventType: "endpoint_added", fromLifecycle: s.lifecycle, toLifecycle: after.lifecycle,
      sourceRevision: after.revision, actorUserId: actor.userId, reason, detailJson: { canonicalUrl: ep.canonicalUrl, enabled: edit.enabled },
    });
    return { endpointRef: `${sourceKey}/${ep.endpointKey}`, revision: after.revision, lifecycle: after.lifecycle, rowVersion: s.rowVersion + 1 };
  });
}

/**
 * Replace an endpoint's definition. A change that widens what may be contacted — a new host, port,
 * path, method, limit or content type, or enabling it — makes a new revision that needs approval.
 * Disabling an endpoint only narrows, and takes effect at once.
 */
export async function updateEndpoint(actor: Actor, sourceKey: string, endpointKey: string, expectedRowVersion: number, edit: Omit<EndpointEdit, "endpointKey">, reason: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const row = (await tx.select().from(externalSourceEndpoints)
      .where(and(eq(externalSourceEndpoints.externalDataSourceId, s.id), eq(externalSourceEndpoints.endpointKey, endpointKey))).limit(1))[0];
    if (!row) throw new SourceRegistryError("not_found", `${sourceKey} has no endpoint ${endpointKey}`);
    const v = validateEndpoint({ ...edit, endpointKey, credentialRef: row.credentialRef });
    if (!v.ok) throw new SourceRegistryError("invalid", v.reasons.join("; "));
    const ep = v.endpoint;
    const before = { ...row, contentTypes: row.contentTypesJson };
    const afterRow = { ...ep, enabled: edit.enabled };
    const widens = networkChange(before, afterRow);
    const narrowsOnly = !widens && row.enabled && !edit.enabled;
    if (!widens && !narrowsOnly && row.displayName === ep.displayName) throw new SourceRegistryError("invalid", "nothing to change");
    if (s.lifecycle === "retired") throw new SourceRegistryError("invalid", `${sourceKey} is retired`);
    const twin = edit.enabled ? await enabledTwin(tx, ep, row.id) : null;
    if (twin) throw new SourceRegistryError("conflict", `${twin.endpointRef} already governs ${ep.canonicalUrl}; disable it before enabling another`);
    await tx.update(externalSourceEndpoints).set({
      displayName: ep.displayName, serviceType: ep.serviceType, httpMethod: ep.httpMethod, hostname: ep.hostname, port: ep.port,
      pathPrefix: ep.pathPrefix, pathMatch: ep.pathMatch, canonicalUrl: ep.canonicalUrl, authScheme: ep.authScheme,
      contentTypesJson: ep.contentTypes, timeoutMs: ep.timeoutMs, maxBytes: ep.maxBytes, enabled: edit.enabled,
      updatedByUserId: actor.userId, updatedAt: new Date(),
    }).where(eq(externalSourceEndpoints.id, row.id));
    const after = widens ? await networkEdit(tx, s, actor, reason) : { revision: s.revision, lifecycle: s.lifecycle };
    await bump(tx, s);
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, endpointId: row.id, eventType: narrowsOnly ? "endpoint_disabled" : "endpoint_updated",
      fromLifecycle: s.lifecycle, toLifecycle: after.lifecycle, sourceRevision: after.revision, actorUserId: actor.userId, reason,
      detailJson: { before: row.canonicalUrl, after: ep.canonicalUrl, enabled: edit.enabled, newRevision: widens },
    });
    return { endpointRef: row.endpointRef, revision: after.revision, lifecycle: after.lifecycle, rowVersion: s.rowVersion + 1 };
  });
}

/**
 * Bind (or unbind) the credential an endpoint presents. The reference must name an active
 * `providerCredentials` row for this very source with the same scheme. Only the reference is
 * stored and logged; the credential store alone can resolve it to a value.
 */
export async function bindCredential(actor: Actor, sourceKey: string, endpointKey: string, expectedRowVersion: number,
  bind: { authScheme: EndpointInput["authScheme"]; credentialRef: string | null }, reason: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    if (s.lifecycle === "retired") throw new SourceRegistryError("invalid", `${sourceKey} is retired`);
    const row = (await tx.select().from(externalSourceEndpoints)
      .where(and(eq(externalSourceEndpoints.externalDataSourceId, s.id), eq(externalSourceEndpoints.endpointKey, endpointKey))).limit(1))[0];
    if (!row) throw new SourceRegistryError("not_found", `${sourceKey} has no endpoint ${endpointKey}`);
    if (bind.credentialRef !== null) {
      const cred = (await tx.select({ providerKey: providerCredentials.providerKey, status: providerCredentials.status, authScheme: providerCredentials.authScheme })
        .from(providerCredentials).where(eq(providerCredentials.credentialRef, bind.credentialRef)).limit(1))[0];
      if (!cred) throw new SourceRegistryError("invalid", `no credential ${bind.credentialRef} in the credential store`);
      if (cred.providerKey !== sourceKey) throw new SourceRegistryError("invalid", `credential ${bind.credentialRef} belongs to another provider`);
      if (cred.status !== "active") throw new SourceRegistryError("invalid", `credential ${bind.credentialRef} is ${cred.status}`);
      if (cred.authScheme !== bind.authScheme) throw new SourceRegistryError("invalid", `credential ${bind.credentialRef} is ${cred.authScheme}, not ${bind.authScheme}`);
    }
    const v = validateEndpoint({
      endpointKey: row.endpointKey, displayName: row.displayName, serviceType: row.serviceType, httpMethod: row.httpMethod, baseUrl: row.canonicalUrl,
      pathMatch: row.pathMatch, authScheme: bind.authScheme, credentialRef: bind.credentialRef, contentTypes: row.contentTypesJson,
      timeoutMs: row.timeoutMs, maxBytes: row.maxBytes,
    });
    if (!v.ok) throw new SourceRegistryError("invalid", v.reasons.join("; "));
    if (row.authScheme === bind.authScheme && row.credentialRef === bind.credentialRef) throw new SourceRegistryError("invalid", "nothing to change");
    await tx.update(externalSourceEndpoints).set({ authScheme: bind.authScheme, credentialRef: bind.credentialRef, updatedByUserId: actor.userId, updatedAt: new Date() })
      .where(eq(externalSourceEndpoints.id, row.id));
    const after = row.enabled ? await networkEdit(tx, s, actor, reason) : { revision: s.revision, lifecycle: s.lifecycle };
    await bump(tx, s);
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, endpointId: row.id, eventType: "credential_bound", fromLifecycle: s.lifecycle, toLifecycle: after.lifecycle,
      sourceRevision: after.revision, actorUserId: actor.userId, reason,
      // The reference is a pointer into providerCredentials, not a secret; the value is never read here.
      detailJson: { authScheme: bind.authScheme, credentialRef: bind.credentialRef },
    });
    return { endpointRef: row.endpointRef, revision: after.revision, lifecycle: after.lifecycle, rowVersion: s.rowVersion + 1 };
  });
}

async function move(tx: Tx, s: SourceRow, action: RegistryAction): Promise<SourceLifecycle> {
  const t = transition(s.lifecycle, action);
  if (!t.ok) throw new SourceRegistryError("invalid", t.reason);
  return t.to;
}

/** Put the source's current revision up for approval, for the purposes named. */
export async function requestReview(actor: Actor, sourceKey: string, expectedRowVersion: number, scope: readonly string[], reason: string) {
  const purposes = scopeOf(scope);
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "request_review");
    await tx.update(externalSourceApprovals).set({ state: "superseded", supersededAt: new Date() })
      .where(and(eq(externalSourceApprovals.externalDataSourceId, s.id), inArray(externalSourceApprovals.state, ["proposed", "approved"])));
    const ins = await tx.insert(externalSourceApprovals).values({
      approvalRef: ref("SRA"), externalDataSourceId: s.id, sourceRevision: s.revision, state: "proposed", scopeJson: purposes,
      requestedByUserId: actor.userId, requestReason: reason,
    });
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: new Date() });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, approvalId: ins[0].insertId, eventType: "review_requested", fromLifecycle: s.lifecycle, toLifecycle: to,
      sourceRevision: s.revision, actorUserId: actor.userId, reason, detailJson: { scope: purposes },
    });
    return { sourceKey, lifecycle: to, rowVersion: s.rowVersion + 1 };
  });
}

export async function reject(actor: Actor, sourceKey: string, expectedRowVersion: number, note: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "reject");
    const p = await openProposal(tx, s.id);
    if (!p) throw new SourceRegistryError("invalid", `${sourceKey} has no open request to reject`);
    await tx.update(externalSourceApprovals).set({ state: "rejected", reviewedByUserId: actor.userId, reviewedAt: new Date(), reviewNote: note }).where(eq(externalSourceApprovals.id, p.id));
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: new Date() });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, approvalId: p.id, eventType: "rejected", fromLifecycle: s.lifecycle, toLifecycle: to,
      sourceRevision: s.revision, actorUserId: actor.userId, reason: note,
    });
    return { sourceKey, lifecycle: to, rowVersion: s.rowVersion + 1 };
  });
}

/**
 * Approve the open request. The approver is not whoever requested it nor whoever made the revision
 * it covers; the request must be for the revision as it stands; at least one endpoint must be
 * enabled; and the approval carries a review-by date within a year.
 */
export async function approve(actor: Actor, sourceKey: string, expectedRowVersion: number, a: { expiresAt: Date; note: string }) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "approve");
    const p = await openProposal(tx, s.id);
    if (!p) throw new SourceRegistryError("invalid", `${sourceKey} has no open request to approve`);
    if (p.sourceRevision !== s.revision) throw new SourceRegistryError("invalid", `the open request covers revision ${p.sourceRevision}; the source is at revision ${s.revision}`);
    const sod = approverRefusal({ approverUserId: actor.userId, requestedByUserId: p.requestedByUserId, revisionByUserId: s.revisionByUserId });
    if (sod) throw new SourceRegistryError("separation_of_duties", sod);
    const late = reviewByRefusal(a.expiresAt, new Date());
    if (late) throw new SourceRegistryError("invalid", late);
    const enabled = (await tx.select({ id: externalSourceEndpoints.id }).from(externalSourceEndpoints)
      .where(and(eq(externalSourceEndpoints.externalDataSourceId, s.id), eq(externalSourceEndpoints.enabled, true))).limit(1))[0];
    if (!enabled) throw new SourceRegistryError("invalid", `${sourceKey} has no enabled endpoint; an approval would authorise nothing`);
    const now = new Date();
    await tx.update(externalSourceApprovals).set({
      state: "approved", reviewedByUserId: actor.userId, reviewedAt: now, reviewNote: a.note,
      approvedByUserId: actor.userId, approvedAt: now, expiresAt: a.expiresAt,
    }).where(eq(externalSourceApprovals.id, p.id));
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: now });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, approvalId: p.id, eventType: "approved", fromLifecycle: s.lifecycle, toLifecycle: to,
      sourceRevision: s.revision, actorUserId: actor.userId, reason: a.note, detailJson: { expiresAt: a.expiresAt.toISOString(), scope: p.scopeJson },
    });
    return { sourceKey, lifecycle: to, revision: s.revision, expiresAt: a.expiresAt, rowVersion: s.rowVersion + 1 };
  });
}

/** Stop every request at once. The approval stands, so resuming needs no fresh review while it is current. */
export async function suspend(actor: Actor, sourceKey: string, expectedRowVersion: number, reason: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "suspend");
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: new Date() });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, eventType: "suspended", fromLifecycle: s.lifecycle, toLifecycle: to, sourceRevision: s.revision, actorUserId: actor.userId, reason,
    });
    return { sourceKey, lifecycle: to, rowVersion: s.rowVersion + 1 };
  });
}

export async function resume(actor: Actor, sourceKey: string, expectedRowVersion: number, note: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "resume");
    const a = await standingApproval(tx, s.id);
    if (!a || a.sourceRevision !== s.revision || !a.expiresAt || a.expiresAt.getTime() <= Date.now()) {
      throw new SourceRegistryError("invalid", `${sourceKey}'s approval no longer covers it as it stands; request a fresh review`);
    }
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: new Date() });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, approvalId: a.id, eventType: "resumed", fromLifecycle: s.lifecycle, toLifecycle: to, sourceRevision: s.revision, actorUserId: actor.userId, reason: note,
    });
    return { sourceKey, lifecycle: to, rowVersion: s.rowVersion + 1 };
  });
}

async function endApprovals(tx: Tx, sourceId: number, actor: Actor, reason: string) {
  await tx.update(externalSourceApprovals).set({ state: "revoked", revokedByUserId: actor.userId, revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(externalSourceApprovals.externalDataSourceId, sourceId), inArray(externalSourceApprovals.state, ["proposed", "approved"])));
}

/** Withdraw authority. Takes effect on the next request: the runtime reads the lifecycle every time. */
export async function revoke(actor: Actor, sourceKey: string, expectedRowVersion: number, reason: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "revoke");
    await endApprovals(tx, s.id, actor, reason);
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: new Date() });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, eventType: "revoked", fromLifecycle: s.lifecycle, toLifecycle: to, sourceRevision: s.revision, actorUserId: actor.userId, reason,
    });
    return { sourceKey, lifecycle: to, rowVersion: s.rowVersion + 1 };
  });
}

/** End of life: approvals are revoked and every endpoint disabled. A retired source is not edited again. */
export async function retire(actor: Actor, sourceKey: string, expectedRowVersion: number, reason: string) {
  const db = await dbOrThrow();
  return db.transaction(async tx => {
    const s = await lockSource(tx, sourceKey, expectedRowVersion);
    const to = await move(tx, s, "retire");
    await endApprovals(tx, s.id, actor, reason);
    await tx.update(externalSourceEndpoints).set({ enabled: false, updatedByUserId: actor.userId, updatedAt: new Date() }).where(eq(externalSourceEndpoints.externalDataSourceId, s.id));
    await bump(tx, s, { lifecycle: to, lifecycleChangedAt: new Date() });
    await tx.insert(externalSourceEvents).values({
      externalDataSourceId: s.id, eventType: "retired", fromLifecycle: s.lifecycle, toLifecycle: to, sourceRevision: s.revision, actorUserId: actor.userId, reason,
    });
    return { sourceKey, lifecycle: to, rowVersion: s.rowVersion + 1 };
  });
}

/* ---------------- seeding ---------------- */

/**
 * Insert what the seeds name and the database lacks. Never changes an existing row. An endpoint is
 * seeded enabled only into a source still in draft — into a source past draft it lands disabled,
 * because enabling it is a change that needs review. A review seed opens a request only for a draft
 * source that has never had one.
 */
export async function seedRegistry() {
  const sources = await seedExternalDataSources();
  const db = await dbOrThrow();
  const inserted: string[] = [];
  const reviewsOpened: string[] = [];
  for (const seed of ENDPOINT_SEEDS) {
    const v = validateEndpoint(seed.endpoint);
    if (!v.ok) throw new Error(`registry seed ${seed.sourceKey}/${seed.endpoint.endpointKey} is invalid: ${v.reasons.join("; ")}`);
    await db.transaction(async tx => {
      const s = (await tx.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, seed.sourceKey)).for("update").limit(1))[0];
      if (!s) return;
      const have = (await tx.select({ id: externalSourceEndpoints.id }).from(externalSourceEndpoints)
        .where(and(eq(externalSourceEndpoints.externalDataSourceId, s.id), eq(externalSourceEndpoints.endpointKey, v.endpoint.endpointKey))).limit(1))[0];
      if (have) return;
      const ep = v.endpoint;
      const enabled = seed.enabled && s.lifecycle === "draft" && !(await enabledTwin(tx, ep, null));
      const ins = await tx.insert(externalSourceEndpoints).values({
        endpointRef: `${s.sourceKey}/${ep.endpointKey}`, externalDataSourceId: s.id, endpointKey: ep.endpointKey, displayName: ep.displayName,
        serviceType: ep.serviceType, httpMethod: ep.httpMethod, hostname: ep.hostname, port: ep.port, pathPrefix: ep.pathPrefix,
        pathMatch: ep.pathMatch, canonicalUrl: ep.canonicalUrl, authScheme: ep.authScheme, credentialRef: null,
        contentTypesJson: ep.contentTypes, timeoutMs: ep.timeoutMs, maxBytes: ep.maxBytes, enabled,
      });
      await tx.insert(externalSourceEvents).values({
        externalDataSourceId: s.id, endpointId: ins[0].insertId, eventType: "seeded", fromLifecycle: s.lifecycle, toLifecycle: s.lifecycle,
        sourceRevision: s.revision, actorUserId: null,
        reason: enabled || !seed.enabled ? "seeded from repository evidence"
          : s.lifecycle !== "draft" ? "seeded disabled: the source is past draft, so enabling this endpoint needs review"
          : "seeded disabled: another enabled endpoint already governs this URL",
        detailJson: { canonicalUrl: ep.canonicalUrl, enabled },
      });
      inserted.push(`${s.sourceKey}/${ep.endpointKey}`);
    });
  }
  for (const r of REVIEW_SEEDS) {
    await db.transaction(async tx => {
      const s = (await tx.select().from(externalDataSources).where(eq(externalDataSources.sourceKey, r.sourceKey)).for("update").limit(1))[0];
      if (!s || s.lifecycle !== "draft") return;
      const any = (await tx.select({ id: externalSourceApprovals.id }).from(externalSourceApprovals).where(eq(externalSourceApprovals.externalDataSourceId, s.id)).limit(1))[0];
      if (any) return;
      const ins = await tx.insert(externalSourceApprovals).values({
        approvalRef: ref("SRA"), externalDataSourceId: s.id, sourceRevision: s.revision, state: "proposed", scopeJson: r.scope,
        requestedByUserId: null, requestReason: r.reason,
      });
      await bump(tx, s, { lifecycle: "pending_approval", lifecycleChangedAt: new Date() });
      await tx.insert(externalSourceEvents).values({
        externalDataSourceId: s.id, approvalId: ins[0].insertId, eventType: "review_requested", fromLifecycle: "draft", toLifecycle: "pending_approval",
        sourceRevision: s.revision, actorUserId: null, reason: r.reason, detailJson: { scope: r.scope, seeded: true },
      });
      reviewsOpened.push(s.sourceKey);
    });
  }
  return { sourcesInserted: sources.inserted, endpointsInserted: inserted, reviewsOpened };
}

/* ---------------- runtime ---------------- */

const REAL_EDGES: EgressEdges = { resolve: systemResolver, transport: httpsTransport };
let edges: EgressEdges = REAL_EDGES;

/**
 * Replace the network edges (resolver and transport) the gateway hands to the egress guard. Tests
 * use it to stand in for a publisher; the guard's rules apply unchanged to whatever is passed.
 * Production never calls it.
 */
export function setSourceRegistryEdges(next: EgressEdges | null) { edges = next ?? REAL_EDGES; }

type Authorized = { ok: true; decision: RegistryDecision; endpoint: ExternalSourceEndpointRow; source: SourceRow };
type Refused = { ok: false; code: RegistryRefusalCode; reason: string; endpoint: ExternalSourceEndpointRow | null; source: SourceRow | null };

/** Resolve a URL to its endpoint and decide, from the database as it stands now, whether it may be requested. */
export async function authorizeUrl(a: { url: URL; purpose: RegistryPurpose; method?: EndpointMethod; now?: Date }): Promise<Authorized | Refused> {
  const db = await dbOrThrow();
  const host = a.url.hostname.replace(/\.$/, "");
  const port = a.url.port === "" ? 443 : Number(a.url.port);
  // An endpoint whose source row is gone governs nothing and blocks nothing: the join leaves it out.
  const candidates = (await db.select({ endpoint: externalSourceEndpoints }).from(externalSourceEndpoints)
    .innerJoin(externalDataSources, eq(externalDataSources.id, externalSourceEndpoints.externalDataSourceId))
    .where(and(eq(externalSourceEndpoints.hostname, host), eq(externalSourceEndpoints.port, port)))).map(r => r.endpoint);
  const pick = selectEndpoint(a.url, candidates, a.method ?? "GET");
  if (!pick.ok) return { ok: false, code: pick.code, reason: pick.reason, endpoint: null, source: null };
  const ep = pick.endpoint;
  const s = (await db.select().from(externalDataSources).where(eq(externalDataSources.id, ep.externalDataSourceId)).limit(1))[0];
  if (!s) return { ok: false, code: "unregistered", reason: `endpoint ${ep.endpointRef} has no source`, endpoint: ep, source: null };
  const approval = await standingApproval(db, s.id);
  const d = runtimeDecision({
    source: { id: s.id, sourceKey: s.sourceKey, lifecycle: s.lifecycle, revision: s.revision },
    endpoint: { ...ep, id: ep.id },
    approval: approval ? { id: approval.id, state: approval.state, sourceRevision: approval.sourceRevision, expiresAt: approval.expiresAt, scope: approval.scopeJson } : null,
    url: a.url, method: a.method ?? "GET", purpose: a.purpose, now: a.now ?? new Date(),
  });
  return d.ok ? { ok: true, decision: d.decision, endpoint: ep, source: s } : { ok: false, code: d.code, reason: d.reason, endpoint: ep, source: s };
}

/** Same as `authorizeUrl`, refusing by throwing — for a path that records a URL without fetching it. */
export async function requireAuthorizedUrl(a: { url: URL; purpose: RegistryPurpose; method?: EndpointMethod }): Promise<RegistryDecision> {
  const r = await authorizeUrl(a);
  if (!r.ok) throw new SourceRegistryError(r.code, r.reason);
  return r.decision;
}

type FetchOutcome = "ok" | "http_error" | "refused_registry" | "refused_network" | "timeout" | "unexpected_response" | "transport";

function outcomeOf(e: EgressRefused): FetchOutcome {
  if (e.code === "unapproved_destination") return "refused_registry";
  if (e.destination) return "refused_network";
  if (e.code === "timeout") return "timeout";
  if (e.code === "content_type" || e.code === "content_encoding" || e.code === "too_large" || e.code === "too_many_redirects") return "unexpected_response";
  return "transport";
}

/** The health summary and one fetch-log row. The log names the path; a query string never reaches it. */
async function record(ep: ExternalSourceEndpointRow, url: URL, outcome: FetchOutcome, httpStatus: number | null, detail: string | null, requestedAt: Date, checksum: string | null) {
  const db = await dbOrThrow();
  const now = new Date();
  const good = outcome === "ok";
  const latest = (await db.select({ consecutiveFailures: externalSourceEndpoints.consecutiveFailures }).from(externalSourceEndpoints).where(eq(externalSourceEndpoints.id, ep.id)).limit(1))[0];
  await db.update(externalSourceEndpoints).set({
    lastAttemptAt: requestedAt, lastOutcome: outcome, lastHttpStatus: httpStatus,
    ...(good ? { lastSuccessAt: now, consecutiveFailures: 0 } : { lastFailureAt: now, consecutiveFailures: (latest?.consecutiveFailures ?? 0) + 1 }),
  }).where(eq(externalSourceEndpoints.id, ep.id));
  const feedOutcome = good ? "ok" : outcome === "refused_registry" || outcome === "refused_network" ? "refused" : outcome === "transport" ? "unavailable" : "error";
  await db.insert(externalFeedFetches).values({
    externalDataSourceId: ep.externalDataSourceId, endpointId: ep.id, feedKey: ep.endpointRef, requestedAt, respondedAt: httpStatus === null ? null : now,
    httpStatus, payloadChecksum: checksum, outcome: feedOutcome, detail: `${url.pathname}${detail ? ` — ${detail}` : ""}`.slice(0, 400),
  });
}

/**
 * GET through the registry. Refused unless the URL is covered by an enabled endpoint of an approved
 * source whose approval names `purpose` — checked against the database on every call. With `pinned`,
 * also refused unless the authority is the one the operation started under, so a revocation, a
 * suspension or an edit stops a multi-request operation at its next request. The request itself goes
 * through the egress guard, with the endpoint's rule as its destination policy on every hop.
 */
export async function registryGet(a: { url: string; purpose: RegistryPurpose; defaults: EgressLimits; pinned?: RegistryDecision }):
  Promise<{ response: EgressResponse; decision: RegistryDecision }> {
  let url: URL;
  try { url = new URL(a.url); } catch { throw new SourceRegistryError("unregistered", "not a valid URL"); }
  const requestedAt = new Date();
  const r = await authorizeUrl({ url, purpose: a.purpose });
  if (!r.ok) {
    if (r.endpoint) await record(r.endpoint, url, "refused_registry", null, `${r.code}: ${r.reason}`, requestedAt, null);
    throw new SourceRegistryError(r.code, r.reason);
  }
  if (a.pinned && !sameAuthority(a.pinned, r.decision)) {
    const reason = `the authority this operation started under changed (revision ${a.pinned.sourceRevision} → ${r.decision.sourceRevision}, approval ${a.pinned.approvalId} → ${r.decision.approvalId})`;
    await record(r.endpoint, url, "refused_registry", null, `changed_during_operation: ${reason}`, requestedAt, null);
    throw new SourceRegistryError("changed_during_operation", reason);
  }
  const limits = effectiveLimits({ ...r.endpoint, contentTypes: r.endpoint.contentTypesJson }, a.defaults);
  try {
    const response = await guardedGet(url, edges, limits);
    await record(r.endpoint, url, response.ok ? "ok" : "http_error", response.status, null, requestedAt, response.ok ? sha256(response.bytes) : null);
    return { response, decision: r.decision };
  } catch (e) {
    if (e instanceof EgressRefused) await record(r.endpoint, url, outcomeOf(e), null, `${e.code}: ${e.message}`, requestedAt, null);
    throw e;
  }
}

/** Record a layer's field list fingerprint; a change from the last one read is schema drift. */
export async function noteSchemaFingerprint(endpointId: number, fields: readonly string[]): Promise<{ fingerprint: string; changed: boolean }> {
  const db = await dbOrThrow();
  const fingerprint = sha256(JSON.stringify([...fields].sort()));
  const row = (await db.select({ last: externalSourceEndpoints.lastSchemaFingerprint }).from(externalSourceEndpoints).where(eq(externalSourceEndpoints.id, endpointId)).limit(1))[0];
  const changed = !!row?.last && row.last !== fingerprint;
  if (row?.last !== fingerprint) {
    await db.update(externalSourceEndpoints).set({ lastSchemaFingerprint: fingerprint, ...(changed ? { schemaChangedAt: new Date() } : {}) }).where(eq(externalSourceEndpoints.id, endpointId));
  }
  return { fingerprint, changed };
}

/** The provenance record of one import: which source, endpoint, revision and approval it ran under. */
export async function recordDatasetImport(a: {
  decision: RegistryDecision; datasetKey: string; datasetVersion: string | null; sourceFormat: string; checksumSha256: string;
  importerVersion: string; featureCount: number; coordinateSystem: string | null; retrievedAt: Date; importedByUserId: number;
}): Promise<{ id: number; importRef: string }> {
  const db = await dbOrThrow();
  const importRef = ref("DSI");
  const ins = await db.insert(externalDatasetImports).values({
    importRef, externalDataSourceId: a.decision.sourceId, endpointId: a.decision.endpointId, sourceRevision: a.decision.sourceRevision,
    approvalId: a.decision.approvalId, purpose: a.decision.purpose, datasetKey: a.datasetKey.slice(0, 160), datasetVersion: a.datasetVersion,
    sourceFormat: a.sourceFormat, checksumSha256: a.checksumSha256, importerVersion: a.importerVersion, featureCount: a.featureCount,
    coordinateSystem: a.coordinateSystem, retrievedAt: a.retrievedAt, importedAt: new Date(), importedByUserId: a.importedByUserId, state: "imported",
  });
  return { id: ins[0].insertId, importRef };
}

export const datasetChecksum = (parts: readonly (Uint8Array | string)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};
