import { describe, expect, it } from "vitest";
import {
  assessFreshness,
  collectAttributions,
  evaluateSourceUsage,
  planFeedFetch,
  type ExternalDataSource,
} from "./externalDataRegistry";
import {
  assessRoutingResult,
  buildTruckRoutingRequest,
  guardRoutingPreferences,
  mayDisplayResource,
} from "./truckRoutingAdapter";
import type { ConstraintProfile } from "./routingCompiler";

const source = (over: Partial<ExternalDataSource> = {}): ExternalDataSource => ({
  sourceKey: "test.source",
  displayName: "Test Source",
  authority: "Test Authority",
  category: "road_network",
  attributionRequired: true,
  attributionText: "© Test Authority",
  shareAlikeObligation: false,
  commercialUsePermitted: "yes",
  redistributionPermitted: "yes",
  status: "verified",
  ...over,
});

describe("open data is not unencumbered data", () => {
  it("allows inspecting an unverified source and nothing else", () => {
    const s = source({ status: "unverified" });
    expect(evaluateSourceUsage({ source: s, intent: "inspect" }).permitted).toBe(true);
    for (const intent of ["operational_decision", "redistribute", "offline_package"] as const) {
      const r = evaluateSourceUsage({ source: s, intent });
      expect(r.permitted, intent).toBe(false);
      expect(r.reason).toContain("have not been checked");
    }
  });

  it("refuses a withdrawn source outright", () => {
    const r = evaluateSourceUsage({
      source: source({ status: "withdrawn" }),
      intent: "operational_decision",
    });
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("withdrawn");
  });

  it("treats an offline package as a redistribution", () => {
    // Pre-downloading a work area onto a tablet is redistribution, and a source
    // that permits use does not necessarily permit that.
    const r = evaluateSourceUsage({
      source: source({ redistributionPermitted: "no" }),
      intent: "offline_package",
    });
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("offline package is a redistribution");
  });

  it("refuses when redistribution terms are merely unknown", () => {
    const r = evaluateSourceUsage({
      source: source({ redistributionPermitted: "unknown" }),
      intent: "redistribute",
    });
    expect(r.permitted).toBe(false);
  });

  it("refuses commercial operation when commercial terms are unknown", () => {
    const r = evaluateSourceUsage({
      source: source({ commercialUsePermitted: "unknown" }),
      intent: "operational_decision",
    });
    expect(r.permitted).toBe(false);
  });

  it("refuses a source that requires attribution but records none", () => {
    // An attribution you forgot to render is a breach you cannot see.
    const r = evaluateSourceUsage({
      source: source({ attributionText: null }),
      intent: "operational_decision",
    });
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("no attribution text is recorded");
  });

  it("surfaces a share-alike obligation on a derived database", () => {
    const r = evaluateSourceUsage({
      source: source({ shareAlikeObligation: true }),
      intent: "redistribute",
    });
    expect(r.permitted).toBe(true);
    expect(r.derivedDatabaseObligation).toBe(true);
    expect(r.caveats.join(" ")).toContain("derived database");
  });

  it("collects attributions and names the ones missing", () => {
    const r = collectAttributions([
      source({ sourceKey: "a", attributionText: "© A" }),
      source({ sourceKey: "b", attributionText: "© A" }),
      source({ sourceKey: "c", attributionText: null }),
      source({ sourceKey: "d", attributionRequired: false, attributionText: null }),
    ]);
    expect(r.lines).toEqual(["© A"]);
    expect(r.missing).toEqual(["c"]);
  });
});

describe("stale data cannot satisfy a constraint", () => {
  const now = new Date("2026-09-09T12:00:00Z");

  it("is unknown when never retrieved", () => {
    const r = assessFreshness({ retrievedAt: null, updateIntervalHours: 24, now });
    expect(r.freshness).toBe("unknown");
    expect(r.usableForConstraintSatisfaction).toBe(false);
  });

  it("is unknown when no update interval is recorded", () => {
    const r = assessFreshness({
      retrievedAt: new Date("2026-09-09T11:00:00Z"),
      updateIntervalHours: null,
      now,
    });
    expect(r.freshness).toBe("unknown");
    expect(r.usableForConstraintSatisfaction).toBe(false);
    expect(r.reason).toContain("cannot tell whether this layer is current");
  });

  it("refuses a layer past its own interval", () => {
    // A road-ban layer that has not refreshed since the ban was posted answers
    // "no restriction" exactly like one that never had a restriction.
    const r = assessFreshness({
      retrievedAt: new Date("2026-09-07T12:00:00Z"),
      updateIntervalHours: 24,
      now,
    });
    expect(r.freshness).toBe("stale");
    expect(r.usableForConstraintSatisfaction).toBe(false);
  });

  it("flags aging while still allowing use", () => {
    const r = assessFreshness({
      retrievedAt: new Date("2026-09-08T291:00:00Z".replace("291", "13")),
      updateIntervalHours: 24,
      now,
    });
    expect(r.freshness).toBe("aging");
    expect(r.usableForConstraintSatisfaction).toBe(true);
  });

  it("accepts a fresh layer", () => {
    const r = assessFreshness({
      retrievedAt: new Date("2026-09-09T10:00:00Z"),
      updateIntervalHours: 24,
      now,
    });
    expect(r.freshness).toBe("fresh");
    expect(r.usableForConstraintSatisfaction).toBe(true);
  });
});

describe("a published rate limit belongs to the company", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  const times = (n: number, secondsAgo: number) =>
    Array.from({ length: n }, () => new Date(now.getTime() - secondsAgo * 1000));

  it("serves cache while it is inside the window", () => {
    const r = planFeedFetch({
      rateLimitCalls: 10, rateLimitWindowSeconds: 60,
      recentFetchTimes: [], cacheAgeSeconds: 30, maxCacheAgeSeconds: 120, now,
    });
    expect(r.allowed).toBe(false);
    expect(r.serveFromCache).toBe(true);
  });

  it("refuses to exceed the limit and says how long to wait", () => {
    const r = planFeedFetch({
      rateLimitCalls: 10, rateLimitWindowSeconds: 60,
      recentFetchTimes: times(10, 30), cacheAgeSeconds: 600,
      maxCacheAgeSeconds: 120, now,
    });
    expect(r.allowed).toBe(false);
    // Serving stale is better than breaching the authority's terms.
    expect(r.serveFromCache).toBe(true);
    expect(r.waitSeconds).toBeGreaterThan(0);
    expect(r.reason).toContain("Rate limit reached");
  });

  it("fetches when inside the limit and the cache is old", () => {
    const r = planFeedFetch({
      rateLimitCalls: 10, rateLimitWindowSeconds: 60,
      recentFetchTimes: times(3, 30), cacheAgeSeconds: 600,
      maxCacheAgeSeconds: 120, now,
    });
    expect(r.allowed).toBe(true);
    expect(r.serveFromCache).toBe(false);
  });

  it("ignores fetches that fell out of the window", () => {
    const r = planFeedFetch({
      rateLimitCalls: 10, rateLimitWindowSeconds: 60,
      recentFetchTimes: times(20, 3600), cacheAgeSeconds: 600,
      maxCacheAgeSeconds: 120, now,
    });
    expect(r.allowed).toBe(true);
  });
});

/* ================================================================== */

const profile = (over: Partial<ConstraintProfile> = {}): ConstraintProfile =>
  ({
    routeProfileId: "rp-1",
    jurisdiction: "CA-AB",
    vehicle: {
      grossWeightKg: 62500,
      axleCount: 8,
      axleGroups: [
        { position: "steer", axles: 1, loadedKg: 7300, ratingKg: 7300 },
        { position: "drive", axles: 3, loadedKg: 27300, ratingKg: 28000 },
        { position: "trailer", axles: 4, loadedKg: 27900, ratingKg: 28000 },
      ],
      dimensions: { lengthM: 25, widthM: 2.6, heightM: 4.15 },
      configuration: "tridem_quad",
    },
    cargo: { classification: "produced_water", dangerousGoods: true, unNumber: "UN1993" },
    environment: [],
    restrictionLayers: [],
    requiredChecks: [],
    regulatoryConfidence: "authority_confirmed",
    dispatchStatus: "clear",
    unknowns: [],
    warnings: [],
    ...over,
  }) as ConstraintProfile;

describe("enforcement evasion is refused at the outbound boundary", () => {
  it("rejects the named avoidance preferences", () => {
    for (const key of [
      "avoidWeighStations", "avoidInspectionStations",
      "avoidEnforcementCheckpoints", "avoidScales", "bypassWeighScales",
      "avoid_port_of_entry", "avoidCVSA", "avoidDOT",
    ]) {
      const g = guardRoutingPreferences({ [key]: true });
      expect(g.ok, key).toBe(false);
    }
  });

  it("matches on normalized substrings, not exact keys", () => {
    // The realistic risk is a later "avoid delays" heuristic acquiring a
    // scale-avoidance term, not someone typing the obvious name.
    for (const key of [
      "avoid_weigh_stations", "AvoidWeighStation",
      "preferences.avoidInspectionStation", "minimizeDelays_avoidScale",
    ]) {
      expect(guardRoutingPreferences({ [key]: true }).ok, key).toBe(false);
    }
  });

  it("refuses the whole request rather than filtering the key out", () => {
    // Silently dropping it would let a caller believe evasion was applied.
    const r = buildTruckRoutingRequest({
      profile: profile(),
      preferences: { avoidWeighStations: true, avoidTolls: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejected).toEqual(["avoidWeighStations"]);
      expect(r.reason).toContain("not an avoidance optimization target");
      expect(r.reason).toContain("Lawful alternatives");
    }
  });

  it("allows lawful preferences", () => {
    const g = guardRoutingPreferences({
      avoidTolls: true,
      avoidFerries: true,
      avoidUnpaved: true,
      preferTruckRoutes: true,
      avoidLowClearance: true,
      avoidSeasonalBans: true,
    });
    expect(g.ok).toBe(true);
  });

  it("still permits displaying enforcement facilities", () => {
    // Knowing a scale is ahead is operational awareness. Routing around it is not.
    for (const r of ["weigh_station", "inspection_station", "public_scale", "port_of_entry"] as const) {
      expect(mayDisplayResource(r)).toBe(true);
    }
  });
});

describe("translating a constraint profile", () => {
  it("carries the physical facts through in the router's units", () => {
    const r = buildTruckRoutingRequest({ profile: profile() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.request.costingOptions;
    expect(o.height).toBe(4.15);
    expect(o.width).toBe(2.6);
    expect(o.length).toBe(25);
    expect(o.weight).toBe(62.5); // kg → tonnes
    expect(o.hazmat).toBe(true);
    expect(o.axleCount).toBe(8);
  });

  it("uses the heaviest per-axle load, not the heaviest group", () => {
    // Drives carry 27,300 over 3 axles = 9.1 t; trailer 27,900 over 4 = 6.975 t.
    const r = buildTruckRoutingRequest({ profile: profile() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.costingOptions.axleLoad).toBe(9.1);
  });

  it("refuses a profile with a missing dimension", () => {
    const r = buildTruckRoutingRequest({
      profile: profile({
        vehicle: {
          ...profile().vehicle,
          dimensions: { lengthM: 25, widthM: 2.6, heightM: 0 },
        },
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("route under a bridge it cannot clear");
  });

  it("attaches unknowns to the request so a result cannot outrun its caveats", () => {
    const r = buildTruckRoutingRequest({
      profile: profile({ unknowns: ["seasonal ban status for TWP-540"] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.provenance.unknowns).toHaveLength(1);
    expect(r.caveats.join(" ")).toContain("cannot be treated as clear");
  });
});

describe("a router finding a path is not the road being clear", () => {
  const clean = {
    unknowns: [] as string[],
    warnings: [] as string[],
    dispatchStatus: "clear" as const,
    regulatoryConfidence: "authority_confirmed" as const,
  };

  it("blocks when no route exists", () => {
    const r = assessRoutingResult({ engineFoundRoute: false, profile: clean });
    expect(r.verdict).toBe("blocked");
  });

  it("returns unknown when a restriction layer is stale, despite a clean route", () => {
    const r = assessRoutingResult({
      engineFoundRoute: true,
      profile: clean,
      staleLayers: ["alberta_road_bans"],
    });
    expect(r.verdict).toBe("unknown");
    expect(r.reasons.join(" ")).toContain("alberta_road_bans");
  });

  it("returns unknown when the profile carries unresolved constraints", () => {
    const r = assessRoutingResult({
      engineFoundRoute: true,
      profile: { ...clean, unknowns: ["bridge posting on segment 41"] },
    });
    expect(r.verdict).toBe("unknown");
  });

  it("returns review on anything short of authority-confirmed", () => {
    // operator_supplied is the middle tier: a driver reporting a bridge posting
    // can block a corridor, and cannot certify one as clear.
    for (const c of ["unverified", "operator_supplied"] as const) {
      const r = assessRoutingResult({
        engineFoundRoute: true,
        profile: { ...clean, regulatoryConfidence: c },
      });
      expect(r.verdict, c).toBe("review");
    }
  });

  it("never returns approved — only ready_to_approve", () => {
    const r = assessRoutingResult({ engineFoundRoute: true, profile: clean });
    expect(r.verdict).toBe("ready_to_approve");
    // An authenticated human acknowledgement is still required.
    expect(r.requiresHumanAcknowledgement).toBe(true);
    expect(String(r.verdict)).not.toBe("approved");
  });

  it("lets a blocked profile override a clean engine answer", () => {
    const r = assessRoutingResult({
      engineFoundRoute: true,
      profile: { ...clean, dispatchStatus: "blocked" },
    });
    expect(r.verdict).toBe("blocked");
  });
});
