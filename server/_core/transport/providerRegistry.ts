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
  snapshotSemantics: SnapshotSemantics;
  parse: ((body: string) => unknown[]) | null;
  normalizer: ((retrievedAt: Date) => Normalizer) | null;
  /**
   * What else the publisher's developer page lists that no adapter reads yet — recorded so the
   * gap is visible, especially the truck-relevant ones (bridge and weight restrictions, inspection
   * stations, seasonal loads).
   */
  alsoPublishes: readonly string[];
};

const ibi = (sourceKey: string, jurisdiction: string, host: string, credentialEnvVar: string, alsoPublishes: string[]): TransportProvider => ({
  sourceKey,
  jurisdiction,
  access: "api_key",
  credentialEnvVar,
  endpoint: ibi511EventEndpoint(sourceKey, host),
  snapshotSemantics: IBI511_SNAPSHOT,
  parse: parseIbi511Events,
  normalizer: at => ibi511Normalizer(sourceKey, at),
  alsoPublishes,
});

/** Endpoint lists are from each publisher's developer page, read 2026-09-24. */
export const CANADIAN_TRANSPORT_PROVIDERS: readonly TransportProvider[] = [
  ibi("ab511", "CA-AB", "511.alberta.ca", "AB_511_API_KEY",
    ["road conditions", "alerts", "bridge restrictions", "inspection stations", "rest areas and turnouts", "weather stations", "ferries", "cameras"]),
  {
    sourceKey: "drivebc_open511",
    jurisdiction: "CA-BC",
    access: "open",
    credentialEnvVar: null,
    endpoint: DRIVEBC_EVENTS_ENDPOINT,
    snapshotSemantics: DRIVEBC_SNAPSHOT,
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
    snapshotSemantics: "full",
    parse: null,
    normalizer: null,
    alsoPublishes: [],
  },
  ibi("mb511", "CA-MB", "www.manitoba511.ca", "MB_511_API_KEY",
    ["road conditions", "advisories", "winter roads", "cameras"]),
  ibi("on511", "CA-ON", "511on.ca", "ON_511_API_KEY",
    ["construction", "road conditions", "alerts", "truck rest areas", "inspection stations", "seasonal loads", "ferry services", "cameras"]),
  {
    sourceKey: "qc_mtmd_roadworks",
    jurisdiction: "CA-QC",
    access: "open",
    credentialEnvVar: null,
    endpoint: QUEBEC_ROADWORKS_ENDPOINT,
    snapshotSemantics: QUEBEC_SNAPSHOT,
    parse: parseQuebecRoadworks,
    normalizer: quebecRoadworksNormalizer,
    alsoPublishes: ["winter road conditions (condition-routiere-hivernale-du-reseau-routier-mtq, CC BY 4.0)", "traffic cameras"],
  },
  ibi("nb511", "CA-NB", "511.gnb.ca", "NB_511_API_KEY",
    ["road conditions", "advisories", "ferries", "cameras"]),
  ibi("nl511", "CA-NL", "511nl.ca", "NL_511_API_KEY",
    ["road conditions", "advisories", "ferries", "Wreckhouse wind warnings", "cameras"]),
  ibi("yt511", "CA-YT", "511yukon.ca", "YT_511_API_KEY",
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
    rateLimitCalls: row.rateLimitCalls ?? null,
    rateLimitWindowSeconds: row.rateLimitWindowSeconds ?? null,
    updateIntervalHours: row.updateIntervalHours ?? null,
    advisoryOnly: true,
    credentialEnvVar: provider.credentialEnvVar,
  };
}

export type ProviderReadiness = {
  sourceKey: string;
  jurisdiction: string;
  state: "ready" | "rights_review" | "credential_required" | "no_published_api" | "withdrawn";
  /** One line for the Data Sources screen and the status bar. */
  line: string;
};

/**
 * Where each province stands, in the order an operator has to fix things. Delegates to the
 * collector's own gate so this matrix and the poller cannot disagree.
 */
export function providerReadiness(provider: TransportProvider, row: ExternalDataSource, env: Record<string, string | undefined>, now: Date): ProviderReadiness {
  const base = { sourceKey: provider.sourceKey, jurisdiction: provider.jurisdiction };
  if (!provider.endpoint) {
    return { ...base, state: "no_published_api", line: `${row.displayName}: NO API — the publisher offers nothing machine-readable; an access request is the next step` };
  }
  const credential = provider.credentialEnvVar ? credentialFromEnv(provider.credentialEnvVar, env) : null;
  const decision = shouldPoll(feedSourceFor(provider, row), emptyFeedState(), now, credential);
  if (decision.poll) return { ...base, state: "ready", line: `${row.displayName}: READY — licence recorded${provider.credentialEnvVar ? `, key present in ${provider.credentialEnvVar}` : ", no key needed"}` };
  switch (decision.blockedBy) {
    case "withdrawn": return { ...base, state: "withdrawn", line: `${row.displayName}: WITHDRAWN — ${decision.reason}` };
    case "not_cleared": return { ...base, state: "rights_review", line: `${row.displayName}: RIGHTS REVIEW — ${decision.reason}` };
    case "no_credential": return { ...base, state: "credential_required", line: `${row.displayName}: KEY REQUIRED — ${decision.reason}` };
    default: return { ...base, state: "ready", line: `${row.displayName}: READY — ${decision.reason}` };
  }
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
