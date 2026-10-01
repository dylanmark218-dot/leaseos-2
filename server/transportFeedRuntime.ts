/**
 * The Canadian provider feeds, persisted — and NOT started.
 *
 * Everything a production feed loop needs, and nothing that starts one. The decision of WHEN is
 * `feedScheduler.tick`; WHETHER is `feedCollector.shouldPoll`; WHAT HAPPENED is `feedIngest`;
 * WHERE is `advisoryImpact` over `resolveRouteCommunicationGeography`; WHAT IT INVALIDATES is
 * `routeDependencies.recheckRouteApproval`. This file joins them to the database tables that have
 * existed since 0081 (`externalFeedRuns`, `roadAdvisories`) and adds no schema:
 *
 *   - `dbAdvisoryStore`       the `AdvisoryStore` port over `roadAdvisories` and `externalFeedRuns`;
 *   - `feedStateFromRuns`     the collector's rolling state, rebuilt from recorded runs, so a restart
 *                             does not forget the publisher's quota or a failure streak;
 *   - `runTransportFeedTick`  one pass: readiness → schedule → collect → persist → invalidate;
 *   - `transportFeedStatus`   health and attribution, safe to return to an administrator.
 *
 * No `setInterval`, no worker registration, no boot hook. Production activation is the owner's
 * decision and is documented in docs/transport/CANADIAN_PROVIDER_RUNTIME.md; nothing in this file
 * runs unless something calls `runTransportFeedTick`, and nothing in production does.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { externalDataSources, externalFeedRuns, roadAdvisories } from "../drizzle/schema";
import type { getDb } from "./db";
import type { RoadAdvisory } from "./_core/advisoryImpact";
import { emptyFeedState, shouldPoll, credentialFromEnv, type FeedState } from "./_core/feedCollector";
import { egressFeedClient, type HttpClient } from "./_core/feedHttp";
import { egressGet } from "./_core/egressHttp";
import { FEED_FAILURE_CATEGORIES, type AdvisoryStore, type FeedFailureCategory, type FeedRun, type StoredAdvisory } from "./_core/feedIngest";
import { tick, type ScheduledFeed, type TickResult } from "./_core/feedScheduler";
import type { ExternalDataSource } from "./_core/externalDataRegistry";
import { CANADIAN_TRANSPORT_PROVIDERS, feedSourceFor, ingestProvider, providerRuntimeReadiness, type ProviderRuntimeReadiness, type TransportProvider } from "./_core/transport/providerRegistry";
import { advisoryFromRow, invalidateApprovalsForAdvisoryChanges, type AdvisoryInvalidation } from "./routeDependencies";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

/**
 * The failure category and any Retry-After travel in the recorded text, in a fixed prefix, because
 * `externalFeedRuns` predates them and this checkpoint adds no migration. The prefix is ours; the
 * rest of the text is the already-redacted message. `parseRunNote` is its only reader.
 */
export function runNote(run: FeedRun): string | null {
  if (!run.failureCategory) return run.errorText;
  const retry = run.retryAfterSeconds ? ` retry-after=${run.retryAfterSeconds}s` : "";
  return `[${run.failureCategory}${retry}] ${run.errorText ?? ""}`.trim().slice(0, 1000);
}
export function parseRunNote(text: string | null): { category: FeedFailureCategory | null; retryAfterSeconds: number | null; message: string | null } {
  const m = text ? /^\[([a-z_]+)(?: retry-after=(\d+)s)?\]\s?([\s\S]*)$/.exec(text) : null;
  if (!m || !FEED_FAILURE_CATEGORIES.includes(m[1] as FeedFailureCategory)) return { category: null, retryAfterSeconds: null, message: text };
  return { category: m[1] as FeedFailureCategory, retryAfterSeconds: m[2] ? Number(m[2]) : null, message: m[3] || null };
}

/** The ingester's port over the tables 0081 created. Supersede and withdraw mark rows; nothing is deleted. */
export function dbAdvisoryStore(db: Db): AdvisoryStore {
  return {
    async activeByExternalRef(sourceKey): Promise<StoredAdvisory[]> {
      return db.select({ advisoryRef: roadAdvisories.advisoryRef, externalRef: roadAdvisories.externalRef, contentHash: roadAdvisories.contentHash })
        .from(roadAdvisories).where(and(eq(roadAdvisories.sourceKey, sourceKey), eq(roadAdvisories.status, "active")));
    },
    async insert(a) {
      await db.insert(roadAdvisories).values({
        advisoryRef: a.advisoryRef, sourceKey: a.sourceKey, externalRef: a.externalRef, runRef: a.runRef,
        advisoryType: a.advisoryType, severity: a.severity, headline: a.headline, roadName: a.roadName,
        latitude: a.point ? a.point[1] : null, longitude: a.point ? a.point[0] : null, radiusMetres: a.radiusMetres,
        effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo, sourceUpdatedAt: a.sourceUpdatedAt, retrievedAt: a.retrievedAt,
        contentHash: a.contentHash, advisoryOnly: true, status: "active",
      });
    },
    async supersede(advisoryRef, byAdvisoryRef) {
      await db.update(roadAdvisories).set({ status: "superseded", supersededByAdvisoryRef: byAdvisoryRef }).where(eq(roadAdvisories.advisoryRef, advisoryRef));
    },
    async withdraw(advisoryRef) {
      await db.update(roadAdvisories).set({ status: "withdrawn" }).where(eq(roadAdvisories.advisoryRef, advisoryRef));
    },
    async recordRun(run) {
      await db.insert(externalFeedRuns).values({
        runRef: run.runRef, sourceKey: run.sourceKey, startedAt: run.startedAt, finishedAt: run.finishedAt,
        outcome: run.outcome, refusedBecause: run.refusedBecause, httpStatus: run.httpStatus,
        recordsSeen: run.recordsSeen, recordsAccepted: run.recordsAccepted, recordsRejected: run.recordsRejected,
        rejectionsJson: run.rejections.length ? JSON.stringify(run.rejections.slice(0, 50)) : null,
        quotaUsedInWindow: run.quotaUsedInWindow, quotaLimit: run.quotaLimit, responseHash: run.responseHash,
        sourceVersion: run.sourceVersion?.slice(0, 120) ?? null, entityTag: run.entityTag?.slice(0, 200) ?? null,
        errorText: runNote(run),
      });
    },
  };
}

type RunRow = typeof externalFeedRuns.$inferSelect;

/**
 * The collector's state from what was recorded. Every run that was not a refusal made a call, so
 * it counts against the publisher's window; a refusal made none. A run that held its snapshot
 * reads as a success when it carried records, as the ingester counted it.
 */
export function feedStateFromRuns(rowsNewestFirst: readonly RunRow[]): { state: FeedState; lastEntityTag: string | null } {
  const calls = rowsNewestFirst.filter(r => r.outcome !== "refused");
  const isSuccess = (r: RunRow) => r.outcome === "succeeded" || r.outcome === "not_modified";
  const lastSuccess = calls.find(isSuccess) ?? null;
  const lastFailure = calls.find(r => r.outcome === "failed") ?? null;
  let consecutiveFailures = 0;
  for (const r of calls) { if (isSuccess(r)) break; consecutiveFailures++; }
  const note = lastFailure ? parseRunNote(lastFailure.errorText) : null;
  const notBefore = lastFailure && note?.retryAfterSeconds && (!lastSuccess || lastFailure.startedAt > lastSuccess.startedAt)
    ? new Date(lastFailure.startedAt.getTime() + note.retryAfterSeconds * 1000) : null;
  return {
    state: {
      ...emptyFeedState(),
      recentCallsAt: calls.map(r => r.startedAt).sort((a, b) => a.getTime() - b.getTime()),
      lastSuccessAt: lastSuccess?.startedAt ?? null,
      lastFailureAt: lastFailure?.startedAt ?? null,
      lastFailureReason: note?.message ?? null,
      consecutiveFailures,
      notBefore,
    },
    lastEntityTag: lastSuccess?.entityTag ?? null,
  };
}

async function recentRuns(db: Db, sourceKey: string, limit = 50): Promise<RunRow[]> {
  return db.select().from(externalFeedRuns).where(eq(externalFeedRuns.sourceKey, sourceKey)).orderBy(desc(externalFeedRuns.startedAt), desc(externalFeedRuns.id)).limit(limit);
}

/** The live registry rows for the providers — the database is the authority, as `geo.sourceReview` writes it. */
export async function providerRegistryRows(db: Db): Promise<Map<string, ExternalDataSource>> {
  const rows = await db.select().from(externalDataSources).where(inArray(externalDataSources.sourceKey, CANADIAN_TRANSPORT_PROVIDERS.map(p => p.sourceKey)));
  return new Map(rows.map(r => [r.sourceKey, r as ExternalDataSource]));
}

/**
 * The HTTP client production must use: `feedHttp`'s adapter over the egress guard's `egressGet`,
 * so a provider's request gets https-only, public-address-only, pinned resolution, a byte ceiling
 * and an allowed content type — the same rules as every other server-initiated fetch. Exported so
 * the enablement step constructs this and not a bare `fetch`.
 */
export function productionFeedClient(): HttpClient {
  return egressFeedClient(egressGet);
}

/* ------------------------------------------------------------------ */
/* One tick                                                             */
/* ------------------------------------------------------------------ */

export type TransportTickReport = {
  readiness: ProviderRuntimeReadiness[];
  /** Only `ready` providers are handed to the scheduler. */
  scheduled: string[];
  tick: TickResult | null;
  /** Per source: what the run changed, and which approvals that rechecked and made stale. */
  invalidation: Record<string, AdvisoryInvalidation>;
};

/**
 * One pass over every provider. A provider that is not `ready` — rights unrecorded, key missing,
 * not enabled, no published API — is reported and never reaches the scheduler, so no request is
 * built for it and no key is read. A ready provider that is not yet due is skipped without writing
 * a run, so an idle loop does not fill `externalFeedRuns` with "not due" rows; every other refusal
 * the collector makes is still recorded.
 */
export async function runTransportFeedTick(input: {
  db: Db;
  env: Record<string, string | undefined>;
  client: HttpClient;
  now: Date;
  providers?: readonly TransportProvider[];
}): Promise<TransportTickReport> {
  const { db, env, now } = input;
  const providers = input.providers ?? CANADIAN_TRANSPORT_PROVIDERS;
  const rows = await providerRegistryRows(db);
  const readiness = providers.map(provider => providerRuntimeReadiness({ provider, row: rows.get(provider.sourceKey) ?? null, env, databaseReady: true, now }));
  const ready = providers.filter((_, i) => readiness[i]!.schedulable);

  const feeds: (ScheduledFeed & { provider: TransportProvider; row: ExternalDataSource; lastEntityTag: string | null })[] = [];
  for (const provider of ready) {
    const row = rows.get(provider.sourceKey)!;
    const { state, lastEntityTag } = feedStateFromRuns(await recentRuns(db, provider.sourceKey));
    feeds.push({
      provider, row, lastEntityTag, state,
      source: feedSourceFor(provider, row),
      credential: provider.credentialEnvVar ? credentialFromEnv(provider.credentialEnvVar, env) : null,
    });
  }

  const invalidation: TransportTickReport["invalidation"] = {};
  const byKey = new Map(feeds.map(f => [f.source.sourceKey, f]));
  const result = feeds.length ? await tick({
    feeds, now,
    ingest: async feed => {
      const f = byKey.get(feed.source.sourceKey)!;
      const decision = shouldPoll(feed.source, feed.state, now, feed.credential);
      if (!decision.poll && decision.blockedBy === "not_due") {
        return { run: notDueRun(feed.source.sourceKey, now, decision.reason), state: feed.state };
      }
      const recording = recordingStore(dbAdvisoryStore(db));
      const outcome = await ingestProvider({ provider: f.provider, row: f.row, state: feed.state, env, client: input.client, store: recording.store, lastEntityTag: f.lastEntityTag, at: now });
      if (recording.changed.length) {
        invalidation[feed.source.sourceKey] = await invalidateApprovalsForAdvisoryChanges(db, await recording.changedAdvisories(db), now);
      }
      return { run: outcome.run, state: outcome.state };
    },
  }) : null;

  return { readiness, scheduled: ready.map(p => p.sourceKey), tick: result?.result ?? null, invalidation };
}

function notDueRun(sourceKey: string, at: Date, reason: string): FeedRun {
  return {
    runRef: "not-recorded", sourceKey, startedAt: at, finishedAt: at, outcome: "refused", refusedBecause: "not_due",
    httpStatus: null, recordsSeen: 0, recordsAccepted: 0, recordsRejected: 0, rejections: [], quotaUsedInWindow: null,
    quotaLimit: null, responseHash: null, sourceVersion: null, entityTag: null, errorText: reason, failureCategory: null, snapshotComplete: null,
  };
}

/** Wraps the store to remember which advisories a run inserted, superseded or withdrew. */
function recordingStore(inner: AdvisoryStore) {
  const refs = new Set<string>();
  const store: AdvisoryStore = {
    activeByExternalRef: k => inner.activeByExternalRef(k),
    insert: async a => { refs.add(a.advisoryRef); await inner.insert(a); },
    supersede: async (ref, by) => { refs.add(ref); refs.add(by); await inner.supersede(ref, by); },
    withdraw: async ref => { refs.add(ref); await inner.withdraw(ref); },
    recordRun: r => inner.recordRun(r),
  };
  return {
    store,
    get changed() { return Array.from(refs); },
    /** Old and new versions alike: an advisory that moved or ended touches where it was. */
    async changedAdvisories(db: Db): Promise<RoadAdvisory[]> {
      if (!refs.size) return [];
      const rows = await db.select().from(roadAdvisories).where(inArray(roadAdvisories.advisoryRef, Array.from(refs)));
      return rows.map(advisoryFromRow);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Health and attribution                                               */
/* ------------------------------------------------------------------ */

/**
 * What an administrator needs to see about one provider. Deliberately without: the key, the key's
 * variable name, the request URL, the publisher's response body, or the recorded error text. A
 * category and an HTTP status say what is wrong; the text that might echo a request stays in the
 * database behind its redaction.
 */
export type ProviderHealth = {
  sourceKey: string;
  displayName: string;
  jurisdiction: string;
  rights: "verified" | "review";
  credential: ProviderRuntimeReadiness["credential"];
  enabled: boolean;
  runtimeStatus: ProviderRuntimeReadiness["status"];
  /** The one word for the status bar — never a flattened "failed". */
  state:
    | "ok" | "never_collected" | "stale"
    | "rights_blocked" | "credential_missing" | "disabled" | "database_unavailable" | "no_published_api" | "withdrawn"
    | FeedFailureCategory;
  lastAttemptedAt: Date | null;
  lastSucceededAt: Date | null;
  lastCompleteSnapshotAt: Date | null;
  lastErrorCategory: FeedFailureCategory | "rights_blocked" | "credential_missing" | null;
  lastErrorAt: Date | null;
  lastHttpStatus: number | null;
  recordsReceived: number | null;
  recordsRejected: number | null;
  /** Of the last run that received a listing: true complete, false held, null none yet. */
  snapshotComplete: boolean | null;
  activeAdvisories: number;
};

export function providerHealthFrom(input: {
  provider: TransportProvider;
  row: ExternalDataSource | null;
  readiness: ProviderRuntimeReadiness;
  runsNewestFirst: readonly RunRow[];
  activeAdvisories: number;
  now: Date;
}): ProviderHealth {
  const { provider, row, readiness, runsNewestFirst: runs, now } = input;
  const calls = runs.filter(r => r.outcome !== "refused");
  const lastAttempt = runs[0] ?? null;
  const lastSuccess = calls.find(r => r.outcome === "succeeded" || r.outcome === "not_modified") ?? null;
  const listed = calls.find(r => r.outcome === "succeeded" || parseRunNote(r.errorText).category === "snapshot_incomplete") ?? null;
  const lastComplete = calls.find(r => r.outcome === "succeeded" && parseRunNote(r.errorText).category !== "snapshot_incomplete") ?? null;
  const lastError = runs.find(r => r.outcome === "failed" || (r.outcome === "refused" && (r.refusedBecause === "not_cleared" || r.refusedBecause === "no_credential")) || parseRunNote(r.errorText).category !== null) ?? null;
  const errCategory: ProviderHealth["lastErrorCategory"] = !lastError ? null
    : lastError.outcome === "refused" ? (lastError.refusedBecause === "not_cleared" ? "rights_blocked" : "credential_missing")
    : parseRunNote(lastError.errorText).category ?? "unreachable";

  const notReady: Partial<Record<ProviderRuntimeReadiness["status"], ProviderHealth["state"]>> = {
    rights_review: "rights_blocked", credential_missing: "credential_missing", disabled: "disabled",
    runtime_unavailable: "database_unavailable", no_published_api: "no_published_api", withdrawn: "withdrawn",
  };
  let state: ProviderHealth["state"];
  if (notReady[readiness.status]) state = notReady[readiness.status]!;
  else if (!lastAttempt || !calls.length) state = "never_collected";
  else if (calls[0]!.outcome === "failed") state = parseRunNote(calls[0]!.errorText).category ?? "unreachable";
  else if (parseRunNote(calls[0]!.errorText).category === "snapshot_incomplete") state = "snapshot_incomplete";
  else if (lastSuccess && row?.updateIntervalHours && now.getTime() - lastSuccess.startedAt.getTime() > row.updateIntervalHours * 3 * 3_600_000) state = "stale";
  else state = "ok";

  return {
    sourceKey: provider.sourceKey, displayName: row?.displayName ?? provider.sourceKey, jurisdiction: provider.jurisdiction,
    rights: readiness.rightsVerified ? "verified" : "review", credential: readiness.credential, enabled: readiness.enabled,
    runtimeStatus: readiness.status, state,
    lastAttemptedAt: lastAttempt?.startedAt ?? null, lastSucceededAt: lastSuccess?.startedAt ?? null,
    lastCompleteSnapshotAt: lastComplete?.startedAt ?? null,
    lastErrorCategory: errCategory, lastErrorAt: lastError?.startedAt ?? null, lastHttpStatus: calls[0]?.httpStatus ?? null,
    recordsReceived: listed?.recordsSeen ?? null, recordsRejected: listed?.recordsRejected ?? null,
    snapshotComplete: listed ? (listed.outcome === "succeeded" && parseRunNote(listed.errorText).category !== "snapshot_incomplete") : null,
    activeAdvisories: input.activeAdvisories,
  };
}

/**
 * What the Legal → Maps, Routing & Government Data Sources page will render. Built from the live
 * registry row. It carries what the publisher requires shown and where it came from, and never the
 * review note, the reviewer, the internal notes, a credential or a credential's name.
 */
export type SourceAttribution = {
  sourceKey: string;
  providerName: string;
  jurisdiction: string | null;
  datasetName: string;
  licenceName: string | null;
  licenceUrl: string | null;
  attributionRequired: boolean;
  attributionText: string | null;
  sourceUrl: string | null;
  rightsStatus: "verified" | "not_verified";
  rightsVerifiedAt: Date | null;
  /** Whether a logo may be shown. False until permission to show one is recorded — none is today. */
  logoPermitted: false;
};

export function attributionProjection(row: ExternalDataSource & { sourceUrl?: string | null }, provider?: TransportProvider): SourceAttribution {
  return {
    sourceKey: row.sourceKey,
    providerName: row.authority,
    jurisdiction: row.jurisdiction ?? null,
    datasetName: row.displayName,
    licenceName: row.licenceName ?? null,
    licenceUrl: row.licenceUrl ?? null,
    attributionRequired: row.attributionRequired,
    attributionText: row.attributionText ?? null,
    sourceUrl: row.sourceUrl ?? provider?.publicUrl ?? null,
    rightsStatus: row.status === "verified" && row.commercialUsePermitted === "yes" ? "verified" : "not_verified",
    rightsVerifiedAt: row.verifiedAt ?? null,
    logoPermitted: false,
  };
}

/** Health for every provider and the attribution for every registered one. Read-only. */
export async function transportFeedStatus(db: Db | null, env: Record<string, string | undefined>, now: Date): Promise<{ providers: ProviderHealth[]; attributions: SourceAttribution[] }> {
  const rows = db ? await providerRegistryRows(db) : new Map<string, ExternalDataSource>();
  const counts = db
    ? new Map((await db.select({ sourceKey: roadAdvisories.sourceKey, n: sql<number>`count(*)` }).from(roadAdvisories).where(eq(roadAdvisories.status, "active")).groupBy(roadAdvisories.sourceKey)).map(c => [c.sourceKey, Number(c.n)]))
    : new Map<string, number>();
  const providers: ProviderHealth[] = [];
  for (const provider of CANADIAN_TRANSPORT_PROVIDERS) {
    const row = rows.get(provider.sourceKey) ?? null;
    const readiness = providerRuntimeReadiness({ provider, row, env, databaseReady: !!db, now });
    providers.push(providerHealthFrom({ provider, row, readiness, runsNewestFirst: db ? await recentRuns(db, provider.sourceKey) : [], activeAdvisories: counts.get(provider.sourceKey) ?? 0, now }));
  }
  const attributions = CANADIAN_TRANSPORT_PROVIDERS.flatMap(p => { const r = rows.get(p.sourceKey); return r ? [attributionProjection(r, p)] : []; });
  return { providers, attributions };
}
