/**
 * External data sources.
 *
 * LeaseOS can save an enormous amount of work by consuming open government and
 * open-source geospatial data rather than building road graphs, land grids and
 * well registries itself. What it must not do is consume them *quietly*.
 *
 * Two gates live here, and both fail closed:
 *
 *   Licence. A layer whose licence, attribution obligation and redistribution
 *   terms nobody has verified may be inspected but may not back an operational
 *   decision or be redistributed. Open data is not the same as unencumbered
 *   data — several of the obvious candidates carry attribution and share-alike
 *   obligations that attach to derived databases.
 *
 *   Freshness. A road-ban or closure layer that is older than its own stated
 *   update interval is stale, and a stale restriction layer answering "clear"
 *   is the exact failure the routing invariants exist to prevent. Stale
 *   produces UNKNOWN, never PASS.
 *
 * Nothing in this file asserts what any real source's licence or rate limit
 * actually is. Those arrive as registry rows, from a person who checked.
 */

export type SourceCategory =
  | "base_map"
  | "road_network"
  | "land_grid"
  | "oilfield_assets"
  | "road_conditions"
  | "weather"
  | "wildfire"
  | "routing_engine"
  | "geocoder"
  | "tiles"
  | "other";

export type SourceStatus = "unverified" | "verified" | "superseded" | "withdrawn";
export type Permitted = "yes" | "no" | "unknown";

export type ExternalDataSource = {
  sourceKey: string;
  displayName: string;
  authority: string;
  category: SourceCategory;
  jurisdiction?: string | null;
  licenceName?: string | null;
  licenceUrl?: string | null;
  attributionRequired: boolean;
  attributionText?: string | null;
  shareAlikeObligation: boolean;
  commercialUsePermitted: Permitted;
  redistributionPermitted: Permitted;
  rateLimitCalls?: number | null;
  rateLimitWindowSeconds?: number | null;
  updateIntervalHours?: number | null;
  retrievedAt?: Date | null;
  verifiedAt?: Date | null;
  status: SourceStatus;
};

export type UsageIntent =
  | "inspect"
  | "operational_decision"
  | "redistribute"
  | "offline_package";

export type UsageDecision = {
  permitted: boolean;
  /** Present whenever `permitted` is false. Named, never "not allowed". */
  reason?: string;
  /** Attribution that must be displayed wherever this data appears. */
  attributionRequired: boolean;
  attributionText?: string | null;
  /** True when a derived database inherits an obligation from this source. */
  derivedDatabaseObligation: boolean;
  caveats: string[];
};

/**
 * Whether a source may be used for a given purpose.
 *
 * `inspect` is always allowed — you have to be able to look at a candidate
 * before deciding anything about it. Everything else requires a verified
 * source, because operating on a layer is where the licence and the currency
 * start to matter.
 */
export function evaluateSourceUsage(args: {
  source: ExternalDataSource;
  intent: UsageIntent;
}): UsageDecision {
  const { source, intent } = args;
  const caveats: string[] = [];

  const base = {
    attributionRequired: source.attributionRequired,
    attributionText: source.attributionText ?? null,
    derivedDatabaseObligation: source.shareAlikeObligation,
  };

  if (intent === "inspect") {
    if (source.status !== "verified") {
      caveats.push("Source is unverified — inspection only");
    }
    return { permitted: true, ...base, caveats };
  }

  if (source.status === "withdrawn") {
    return {
      permitted: false,
      reason: `${source.sourceKey} has been withdrawn`,
      ...base,
      caveats,
    };
  }
  if (source.status !== "verified") {
    return {
      permitted: false,
      reason: `${source.sourceKey} is ${source.status} — licence and terms have not been checked by anyone`,
      ...base,
      caveats,
    };
  }

  if (intent === "redistribute" || intent === "offline_package") {
    if (source.redistributionPermitted !== "yes") {
      return {
        permitted: false,
        reason: `Redistribution of ${source.sourceKey} is ${source.redistributionPermitted} — an offline package is a redistribution`,
        ...base,
        caveats,
      };
    }
    if (source.shareAlikeObligation) {
      caveats.push(
        "Share-alike obligation: a derived database built on this source may inherit its licence"
      );
    }
  }

  if (intent === "operational_decision" && source.commercialUsePermitted !== "yes") {
    return {
      permitted: false,
      reason: `Commercial use of ${source.sourceKey} is ${source.commercialUsePermitted}`,
      ...base,
      caveats,
    };
  }

  if (source.attributionRequired && !source.attributionText?.trim()) {
    return {
      permitted: false,
      reason: `${source.sourceKey} requires attribution but no attribution text is recorded`,
      ...base,
      caveats,
    };
  }

  return { permitted: true, ...base, caveats };
}

/* ------------------------------------------------------------------ */
/* Freshness                                                            */
/* ------------------------------------------------------------------ */

export type Freshness = "fresh" | "aging" | "stale" | "unknown";

export type FreshnessAssessment = {
  freshness: Freshness;
  ageHours: number | null;
  updateIntervalHours: number | null;
  /**
   * Whether a routing decision may treat this layer as satisfied. A stale
   * restriction layer answering "no restriction" is indistinguishable from a
   * layer that simply has not been refreshed since the ban was posted.
   */
  usableForConstraintSatisfaction: boolean;
  reason: string;
};

export function assessFreshness(args: {
  retrievedAt?: Date | null;
  updateIntervalHours?: number | null;
  now: Date;
  agingRatio?: number;
}): FreshnessAssessment {
  if (!args.retrievedAt) {
    return {
      freshness: "unknown",
      ageHours: null,
      updateIntervalHours: args.updateIntervalHours ?? null,
      usableForConstraintSatisfaction: false,
      reason: "Never retrieved — currency unknown",
    };
  }

  const ageHours =
    (args.now.getTime() - args.retrievedAt.getTime()) / 3_600_000;

  if (!args.updateIntervalHours) {
    return {
      freshness: "unknown",
      ageHours: round1(ageHours),
      updateIntervalHours: null,
      usableForConstraintSatisfaction: false,
      reason:
        "No update interval recorded — cannot tell whether this layer is current",
    };
  }

  const ratio = args.agingRatio ?? 0.8;
  if (ageHours >= args.updateIntervalHours) {
    return {
      freshness: "stale",
      ageHours: round1(ageHours),
      updateIntervalHours: args.updateIntervalHours,
      usableForConstraintSatisfaction: false,
      reason: `Layer is ${round1(ageHours)}h old against a ${args.updateIntervalHours}h interval — refresh before relying on it`,
    };
  }
  if (ageHours >= args.updateIntervalHours * ratio) {
    return {
      freshness: "aging",
      ageHours: round1(ageHours),
      updateIntervalHours: args.updateIntervalHours,
      usableForConstraintSatisfaction: true,
      reason: "Approaching its refresh interval",
    };
  }
  return {
    freshness: "fresh",
    ageHours: round1(ageHours),
    updateIntervalHours: args.updateIntervalHours,
    usableForConstraintSatisfaction: true,
    reason: "Within its refresh interval",
  };
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                        */
/* ------------------------------------------------------------------ */

export type FetchDecision = {
  allowed: boolean;
  serveFromCache: boolean;
  waitSeconds?: number;
  reason: string;
};

/**
 * Whether to hit a live feed or serve the cached copy.
 *
 * A published throttle belongs to the company, not to whichever truck asked
 * first. Fifty trucks each polling an authority's endpoint is both a breach of
 * its terms and a good way to lose access to it.
 */
export function planFeedFetch(args: {
  rateLimitCalls?: number | null;
  rateLimitWindowSeconds?: number | null;
  recentFetchTimes: Date[];
  cacheAgeSeconds: number | null;
  maxCacheAgeSeconds: number;
  now: Date;
}): FetchDecision {
  if (
    args.cacheAgeSeconds !== null &&
    args.cacheAgeSeconds < args.maxCacheAgeSeconds
  ) {
    return {
      allowed: false,
      serveFromCache: true,
      reason: `Cached copy is ${args.cacheAgeSeconds}s old, within the ${args.maxCacheAgeSeconds}s window`,
    };
  }

  if (!args.rateLimitCalls || !args.rateLimitWindowSeconds) {
    return {
      allowed: true,
      serveFromCache: false,
      reason: "No published rate limit recorded — fetching once",
    };
  }

  const windowStart = new Date(
    args.now.getTime() - args.rateLimitWindowSeconds * 1000
  );
  const inWindow = args.recentFetchTimes.filter(t => t >= windowStart);

  if (inWindow.length >= args.rateLimitCalls) {
    const oldest = inWindow.reduce((a, b) => (a < b ? a : b));
    const waitSeconds = Math.max(
      1,
      Math.ceil(
        (oldest.getTime() + args.rateLimitWindowSeconds * 1000 - args.now.getTime()) /
          1000
      )
    );
    return {
      allowed: false,
      // Serving a stale copy is better than breaching the authority's terms,
      // and the staleness travels with the answer.
      serveFromCache: true,
      waitSeconds,
      reason: `Rate limit reached (${inWindow.length}/${args.rateLimitCalls} in ${args.rateLimitWindowSeconds}s) — serving cache for ${waitSeconds}s`,
    };
  }

  return {
    allowed: true,
    serveFromCache: false,
    reason: `Within rate limit (${inWindow.length}/${args.rateLimitCalls})`,
  };
}

/* ------------------------------------------------------------------ */
/* Attribution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every attribution owed by the sources behind a view. Missing attribution
 * text on a source that requires it is reported rather than skipped — an
 * attribution you forgot to render is a licence breach you cannot see.
 */
export function collectAttributions(
  sources: readonly ExternalDataSource[]
): { lines: string[]; missing: string[] } {
  const lines: string[] = [];
  const missing: string[] = [];
  for (const s of sources) {
    if (!s.attributionRequired) continue;
    const text = s.attributionText?.trim();
    if (text) {
      if (!lines.includes(text)) lines.push(text);
    } else {
      missing.push(s.sourceKey);
    }
  }
  return { lines, missing };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
