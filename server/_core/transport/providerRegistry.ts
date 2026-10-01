/**
 * The Canadian road-information providers, and how each one is read.
 *
 * This is a router over what already exists, not a new engine. The collector (`feedCollector`)
 * decides whether a source may be polled; the fetcher (`feedHttp`) is the one place a key is read;
 * the ingester (`feedIngest`) turns a response into superseding, withdrawable advisory rows; and
 * `advisoryImpact` places them on a route. What was missing was the per-province part — where the
 * endpoint is, where its key lives, how its body parses — and that is all this file adds.
 *
 * What a provider entry does NOT carry is permission. Licence, commercial use, redistribution and
 * verification live on the `externalDataSources` row, and `feedSourceFor` reads them from there.
 * So a province with a working adapter and a held key is still refused until somebody records the
 * right to use its answers, and the refusal is recorded as a run.
 *
 * Every provincial feed is advisory. A 511 closure can put a trip in front of a person; it cannot
 * clear or block a route. That rule is structural in `RoadAdvisory` and is set again here.
 */

import { TRANSPORT_FEED_ENV_VARS } from "../env";
import type { ExternalDataSource } from "../externalDataRegistry";
import { credentialFromEnv, emptyFeedState, shouldPoll, type FeedCredential, type FeedSource, type FeedState } from "../feedCollector";
import { httpFeedFetcher, type FeedEndpoint, type HttpClient } from "../feedHttp";
import { ingestFeed, type AdvisoryStore, type IngestOutcome, type Normalizer, type SnapshotSemantics } from "../feedIngest";
import { DRIVEBC_EVENTS_ENDPOINT, DRIVEBC_SNAPSHOT, drivebcNormalizer, parseDriveBcEvents } from "./drivebcOpen511";
import { IBI511_SNAPSHOT, ibi511EventEndpoint, ibi511Normalizer, parseIbi511Events } from "./ibi511";
import { parseQuebecRoadworks, QUEBEC_ROADWORKS_ENDPOINT, QUEBEC_SNAPSHOT, quebecRoadworksNormalizer } from "./quebecRoadworks";

/** How the publisher admits a caller. Says nothing about what may be done with the answer. */
export type ProviderAccess = "open" | "api_key" | "no_published_api";

export type TransportProvider = {
  sourceKey: string;
  jurisdiction: string;
  access: ProviderAccess;
  /** The environment variable holding the key. Never the key. Null when none is needed. */
  credentialEnvVar: string | null;
  /** Null when the publisher offers nothing machine-readable to call. */
  endpoint: FeedEndpoint | null;
  /** The publisher's public page for this data — what an attribution links to. Never the API URL. */
  publicUrl: string;
  snapshotSemantics: SnapshotSemantics;
  /**
   * Why this provider's listing can or cannot be trusted whole, in one sentence. Completeness is
   * per publisher, not global: DriveBC caps a page without saying so, Québec's WFS reports
   * `numberMatched`, the 511 platform documents no paging at all.
   */
  completeness: string;
  parse: ((body: string) => unknown[]) | null;
  normalizer: ((retrievedAt: Date) => Normalizer) | null;
  /**
   * What else the publisher's developer page lists that no adapter reads yet — recorded so the
   * gap is visible, especially the truck-relevant ones (bridge and weight restrictions, inspection
   * stations, seasonal loads).
   */
  alsoPublishes: readonly string[];
};

const IBI_COMPLETENESS =
  "The 511 platform documents one unpaged GET returning every event, so the answer is treated as the whole listing; an empty answer while events are held, or one with a rejected record, withdraws nothing.";

const ibi = (sourceKey: keyof typeof TRANSPORT_FEED_ENV_VARS.keys, jurisdiction: string, host: string, alsoPublishes: string[]): TransportProvider => ({
  sourceKey,
  jurisdiction,
  access: "api_key",
  credentialEnvVar: TRANSPORT_FEED_ENV_VARS.keys[sourceKey],
  endpoint: ibi511EventEndpoint(sourceKey, host),
  publicUrl: `https://${host}/`,
  snapshotSemantics: IBI511_SNAPSHOT,
  completeness: IBI_COMPLETENESS,
  parse: parseIbi511Events,
  normalizer: at => ibi511Normalizer(sourceKey, at),
  alsoPublishes,
});

/** Endpoint lists are from each publisher's developer page, read 2026-09-24. */
export const CANADIAN_TRANSPORT_PROVIDERS: readonly TransportProvider[] = [
  ibi("ab511", "CA-AB", "511.alberta.ca",
    ["road conditions", "alerts", "bridge restrictions", "inspection stations", "rest areas and turnouts", "weather stations", "ferries", "cameras"]),
  {
    sourceKey: "drivebc_open511",
    jurisdiction: "CA-BC",
    access: "open",
    credentialEnvVar: null,
    endpoint: DRIVEBC_EVENTS_ENDPOINT,
    publicUrl: "https://www.drivebc.ca/",
    snapshotSemantics: DRIVEBC_SNAPSHOT,
    completeness: "DriveBC caps a page at 500 and its pagination block never says a listing was cut short, so a response that fills the page is refused as possibly incomplete and withdraws nothing.",
    parse: body => parseDriveBcEvents(body),
    normalizer: drivebcNormalizer,
    alsoPublishes: ["areas", "jurisdiction geography"],
  },
  {
    // No developer API is published; the website is not scraped. Registered so the gap is visible.
    sourceKey: "sk_highway_hotline",
    jurisdiction: "CA-SK",
    access: "no_published_api",
    credentialEnvVar: null,
    endpoint: null,
    publicUrl: "https://hotline.gov.sk.ca/",
    snapshotSemantics: "full",
    completeness: "Nothing is collected: there is no published feed, and the website is never scraped in its place.",
    parse: null,
    normalizer: null,
    alsoPublishes: [],
  },
  ibi("mb511", "CA-MB", "www.manitoba511.ca",
    ["road conditions", "advisories", "winter roads", "cameras"]),
  ibi("on511", "CA-ON", "511on.ca",
    ["construction", "road conditions", "alerts", "truck rest areas", "inspection stations", "seasonal loads", "ferry services", "cameras"]),
  {
    sourceKey: "qc_mtmd_roadworks",
    jurisdiction: "CA-QC",
    access: "open",
    credentialEnvVar: null,
    endpoint: QUEBEC_ROADWORKS_ENDPOINT,
    publicUrl: "https://www.donneesquebec.ca/recherche/dataset/travaux-routiers",
    snapshotSemantics: QUEBEC_SNAPSHOT,
    completeness: "The WFS reports numberMatched; a response returning fewer features than it matched is refused as incomplete and withdraws nothing.",
    parse: parseQuebecRoadworks,
    normalizer: quebecRoadworksNormalizer,
    alsoPublishes: ["winter road conditions (condition-routiere-hivernale-du-reseau-routier-mtq, CC BY 4.0)", "traffic cameras"],
  },
  ibi("nb511", "CA-NB", "511.gnb.ca",
    ["road conditions", "advisories", "ferries", "cameras"]),
  ibi("nl511", "CA-NL", "511nl.ca",
    ["road conditions", "advisories", "ferries", "Wreckhouse wind warnings", "cameras"]),
  ibi("yt511", "CA-YT", "511yukon.ca",
    ["road conditions", "alerts", "weight restrictions", "bridge restrictions", "rest areas and pullouts", "message signs", "cameras"]),
];

export const providerFor = (sourceKey: string): TransportProvider | undefined =>
  CANADIAN_TRANSPORT_PROVIDERS.find(p => p.sourceKey === sourceKey);

/**
 * The collector's view of a provider: permission and limits from the registry row, the key's
 * location from the provider. `advisoryOnly` is always true — no provincial feed may become a
 * verified restriction by this path.
 */
export function feedSourceFor(provider: TransportProvider, row: ExternalDataSource): FeedSource {
  if (row.sourceKey !== provider.sourceKey) {
    throw new Error(`registry row ${row.sourceKey} does not belong to provider ${provider.sourceKey}`);
  }
  return {
    sourceKey: row.sourceKey,
    displayName: row.displayName,
    status: row.status,
    commercialUsePermitted: row.commercialUsePermitted,
    rateLimitCalls: row.rateLimitCalls ?? null,
    rateLimitWindowSeconds: row.rateLimitWindowSeconds ?? null,
    updateIntervalHours: row.updateIntervalHours ?? null,
    advisoryOnly: true,
    credentialEnvVar: provider.credentialEnvVar,
  };
}

/** The owner's switch, read from the environment by name. Unset or empty means nothing is enabled. */
export function enabledFeedKeys(env: Record<string, string | undefined>): ReadonlySet<string> {
  const raw = env[TRANSPORT_FEED_ENV_VARS.enabled] ?? "";
  return new Set(raw.split(",").map(k => k.trim()).filter(Boolean));
}

export type ProviderRuntimeStatus =
  | "ready"
  | "rights_review"
  | "credential_missing"
  | "disabled"
  | "runtime_unavailable"
  | "no_published_api"
  | "withdrawn";

/**
 * Where a provider stands, every condition separately, and the one status that follows. The
 * conditions are evaluated in the order an operator has to fix them, and rights come first: a key
 * in the environment is never looked at for a source whose licence is not recorded, so a credential
 * cannot be what moves a source forward.
 */
export type ProviderRuntimeReadiness = {
  sourceKey: string;
  jurisdiction: string;
  /** In the provider list and in the registry. */
  registered: boolean;
  /** The registry row is verified and records commercial use as permitted. */
  rightsVerified: boolean;
  credential: "not_required" | "present" | "missing";
  /** The owner has turned it on. */
  enabled: boolean;
  databaseReady: boolean;
  /** True only for `ready`. The scheduler takes nothing else. */
  schedulable: boolean;
  status: ProviderRuntimeStatus;
  /** One line for the status surface. Never contains a key or a key's variable name. */
  line: string;
};

export function providerRuntimeReadiness(input: {
  provider: TransportProvider;
  /** The live registry row (from the database when there is one). Null when it is absent. */
  row: ExternalDataSource | null;
  env: Record<string, string | undefined>;
  databaseReady: boolean;
  now: Date;
}): ProviderRuntimeReadiness {
  const { provider, row, env } = input;
  const name = row?.displayName ?? provider.sourceKey;
  const enabled = enabledFeedKeys(env).has(provider.sourceKey);
  const credentialPresent = provider.credentialEnvVar ? credentialFromEnv(provider.credentialEnvVar, env).present : null;
  const credential: ProviderRuntimeReadiness["credential"] = credentialPresent === null ? "not_required" : credentialPresent ? "present" : "missing";
  const rightsVerified = !!row && row.status === "verified" && row.commercialUsePermitted === "yes";
  const base = {
    sourceKey: provider.sourceKey, jurisdiction: provider.jurisdiction, registered: !!row,
    rightsVerified, credential, enabled, databaseReady: input.databaseReady,
  };
  const out = (status: ProviderRuntimeStatus, line: string): ProviderRuntimeReadiness =>
    ({ ...base, schedulable: status === "ready", status, line: `${name}: ${line}` });

  if (!provider.endpoint) return out("no_published_api", "NO API — the publisher offers nothing machine-readable; it is never scraped instead");
  if (!row) return out("rights_review", "RIGHTS REVIEW — not in the source registry, so no licence is recorded");

  // The collector's own gate decides rights and credential, so this matrix and the poller agree.
  const decision = shouldPoll(feedSourceFor(provider, row), emptyFeedState(), input.now,
    provider.credentialEnvVar ? credentialFromEnv(provider.credentialEnvVar, env) : null);
  if (!decision.poll) {
    if (decision.blockedBy === "withdrawn") return out("withdrawn", `WITHDRAWN — the registry records this source as ${row.status}`);
    if (decision.blockedBy === "not_cleared") return out("rights_review", `RIGHTS REVIEW — ${row.status !== "verified" ? "no licence review has cleared it" : `verified, but commercial use is recorded as ${row.commercialUsePermitted}`}; a key does not change that`);
    if (decision.blockedBy === "no_credential") return out("credential_missing", "KEY REQUIRED — licence recorded, but no developer key is configured on the server");
  }
  if (!enabled) return out("disabled", "DISABLED — cleared and configured, and not turned on; enabling it is the owner's decision");
  if (!input.databaseReady) return out("runtime_unavailable", "RUNTIME UNAVAILABLE — no database to record runs and advisories in, so nothing is collected");
  return out("ready", `READY — licence recorded${credential === "present" ? ", key configured" : ", no key needed"}, enabled`);
}

/**
 * One collection for one province: the registry's permission, the provider's endpoint and parser,
 * the existing fetcher and ingester. A provider with no endpoint is refused before anything runs.
 */
export async function ingestProvider(input: {
  provider: TransportProvider;
  row: ExternalDataSource;
  state: FeedState;
  env: Record<string, string | undefined>;
  client: HttpClient;
  store: AdvisoryStore;
  lastEntityTag?: string | null;
  at: Date;
}): Promise<IngestOutcome> {
  const { provider } = input;
  if (!provider.endpoint || !provider.parse || !provider.normalizer) {
    throw new Error(`${provider.sourceKey} has no published API to collect from`);
  }
  const credential: FeedCredential | null = provider.credentialEnvVar ? credentialFromEnv(provider.credentialEnvVar, input.env) : null;
  return ingestFeed({
    source: feedSourceFor(provider, input.row),
    state: input.state,
    credential,
    fetcher: httpFeedFetcher({ endpoint: provider.endpoint, client: input.client, env: input.env }),
    store: input.store,
    normalize: provider.normalizer(input.at),
    parse: provider.parse,
    snapshotSemantics: provider.snapshotSemantics,
    lastEntityTag: input.lastEntityTag ?? null,
    at: input.at,
  });
}
