/**
 * The Canadian road-information providers — adapters proven against the shapes the publishers
 * actually return, and the permission gate proven to hold regardless of which keys are present.
 *
 * DriveBC and Québec fixtures are trimmed from live responses retrieved 2026-09-24. The 511
 * platform fixture follows the field list its developer pages document; no key was used here, and
 * none appears in this file.
 */
import { describe, expect, it } from "vitest";
import type { RoadAdvisory } from "./_core/advisoryImpact";
import { DEFAULT_ADVISORY_RADIUS_METRES } from "./_core/advisoryImpact";
import type { ExternalDataSource } from "./_core/externalDataRegistry";
import { ALL_DATA_SOURCES, SOURCES_REQUIRING_API_KEY, SOURCE_CAVEATS } from "./_core/externalSourceSeeds";
import { emptyFeedState } from "./_core/feedCollector";
import type { HttpClient } from "./_core/feedHttp";
import type { AdvisoryStore, FeedRun } from "./_core/feedIngest";
import { drivebcNormalizer, parseDriveBcEvents } from "./_core/transport/drivebcOpen511";
import { fromDateText, IncompleteSnapshotError } from "./_core/transport/fields";
import { ibi511Normalizer, ibiSeverity, parseIbi511Events } from "./_core/transport/ibi511";
import { coveringCircle } from "./_core/transport/placement";
import { CANADIAN_TRANSPORT_PROVIDERS, ingestProvider, providerFor, providerReadiness } from "./_core/transport/providerRegistry";
import { parseQuebecRoadworks, quebecRoadworksNormalizer } from "./_core/transport/quebecRoadworks";

const at = new Date("2026-09-24T18:00:00Z");
const row = (k: string): ExternalDataSource => {
  const r = ALL_DATA_SOURCES.find(s => s.sourceKey === k);
  if (!r) throw new Error(`no registry row for ${k}`);
  return r;
};
const accept = (n: ReturnType<ReturnType<typeof ibi511Normalizer>>): RoadAdvisory => {
  if (!n.ok) throw new Error(n.reason);
  return n.advisory;
};

function fakeStore() {
  const runs: FeedRun[] = [];
  const inserted: RoadAdvisory[] = [];
  const store: AdvisoryStore = {
    async activeByExternalRef() { return []; },
    async insert(a) { inserted.push(a); },
    async supersede() {},
    async withdraw() {},
    async recordRun(r) { runs.push(r); },
  };
  return { store, runs, inserted };
}

function fakeClient(respond: (url: string) => { status: number; body: string } | Error) {
  const urls: string[] = [];
  const client: HttpClient = {
    async request({ url }) {
      urls.push(url);
      const r = respond(url);
      if (r instanceof Error) throw r;
      return { ...r, headers: {} };
    },
  };
  return { client, urls };
}

/* ------------------------------------------------------------------ */

describe("every province is registered once, with its row", () => {
  it("has a registry row for each provider, in the same jurisdiction", () => {
    for (const p of CANADIAN_TRANSPORT_PROVIDERS) {
      expect(row(p.sourceKey).jurisdiction, p.sourceKey).toBe(p.jurisdiction);
      expect(row(p.sourceKey).category, p.sourceKey).toBe("road_conditions");
    }
    const keys = CANADIAN_TRANSPORT_PROVIDERS.map(p => p.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the provinces and territory with a road-information service found so far", () => {
    expect(CANADIAN_TRANSPORT_PROVIDERS.map(p => p.jurisdiction).sort()).toEqual(
      ["CA-AB", "CA-BC", "CA-MB", "CA-NB", "CA-NL", "CA-ON", "CA-QC", "CA-SK", "CA-YT"],
    );
  });

  it("agrees with the registry about which ones need a key", () => {
    for (const p of CANADIAN_TRANSPORT_PROVIDERS) {
      expect(SOURCES_REQUIRING_API_KEY.includes(p.sourceKey), p.sourceKey).toBe(p.access === "api_key");
      expect(p.credentialEnvVar !== null, p.sourceKey).toBe(p.access === "api_key");
    }
  });

  it("records Ontario as needing a key even though its licence is open", () => {
    // The developer page says "Requires a developer key". An open licence is a different fact.
    expect(providerFor("on511")!.access).toBe("api_key");
    expect(row("on511").status).toBe("verified");
    expect(row("on511").attributionText).toBe("Contains information licensed under the Open Government Licence – Ontario");
    expect(SOURCE_CAVEATS.on511).toMatch(/logo/);
  });

  it("names environment variables, never values", () => {
    for (const p of CANADIAN_TRANSPORT_PROVIDERS) {
      if (p.credentialEnvVar) expect(p.credentialEnvVar).toMatch(/^[A-Z]{2}_511_API_KEY$/);
      expect(p.endpoint?.url ?? "").not.toMatch(/[?&]key=/);
    }
  });
});

describe("the readiness matrix is the collector's gate, not a second opinion", () => {
  const allKeys = { AB_511_API_KEY: "k", ON_511_API_KEY: "k", MB_511_API_KEY: "k", NB_511_API_KEY: "k", YT_511_API_KEY: "k", NL_511_API_KEY: "k" };
  const state = (k: string, env: Record<string, string | undefined>) => providerReadiness(providerFor(k)!, row(k), env, at).state;

  it("holds every licence-silent 511 at rights review even with its key present", () => {
    for (const k of ["ab511", "mb511", "nb511", "yt511", "nl511"]) expect(state(k, allKeys), k).toBe("rights_review");
  });

  it("asks for Ontario's key when it is missing, and is ready when it is present", () => {
    expect(state("on511", {})).toBe("credential_required");
    expect(state("on511", { ON_511_API_KEY: "   " })).toBe("credential_required");
    expect(state("on511", allKeys)).toBe("ready");
  });

  it("has B.C. and Québec ready with no key at all", () => {
    expect(state("drivebc_open511", {})).toBe("ready");
    expect(state("qc_mtmd_roadworks", {})).toBe("ready");
  });

  it("reports Saskatchewan as having no API, not as failing", () => {
    expect(state("sk_highway_hotline", allKeys)).toBe("no_published_api");
  });
});

describe("collection goes through the existing gate and fetcher", () => {
  it("refuses Alberta before any request is made, and records the refusal", async () => {
    const { store, runs } = fakeStore();
    const { client, urls } = fakeClient(() => ({ status: 200, body: "[]" }));
    const out = await ingestProvider({ provider: providerFor("ab511")!, row: row("ab511"), state: emptyFeedState(), env: { AB_511_API_KEY: "held" }, client, store, at });
    expect(urls).toEqual([]);
    expect(out.run.outcome).toBe("refused");
    expect(out.run.refusedBecause).toBe("not_cleared");
    expect(runs).toHaveLength(1);
  });

  it("puts Ontario's key in the query string and keeps it out of the recorded error", async () => {
    const secret = "ON-SECRET-9f2c";
    const { store } = fakeStore();
    const { client, urls } = fakeClient(url => new Error(`connect ETIMEDOUT while fetching ${url}`));
    const out = await ingestProvider({ provider: providerFor("on511")!, row: row("on511"), state: emptyFeedState(), env: { ON_511_API_KEY: secret }, client, store, at });
    expect(urls[0]).toContain(`key=${secret}`);
    expect(urls[0]).toMatch(/^https:\/\/511on\.ca\/api\/v2\/get\/event\?/);
    expect(out.run.outcome).toBe("failed");
    expect(out.run.errorText).not.toContain(secret);
    expect(out.run.errorText).toContain("«redacted»");
  });

  it("ingests Ontario events end to end", async () => {
    const { store, inserted } = fakeStore();
    const { client } = fakeClient(() => ({ status: 200, body: JSON.stringify([IBI_CLOSURE, IBI_ROADWORK]) }));
    const out = await ingestProvider({ provider: providerFor("on511")!, row: row("on511"), state: emptyFeedState(), env: { ON_511_API_KEY: "k" }, client, store, at });
    expect(out.run.outcome).toBe("succeeded");
    expect(out.accepted).toBe(2);
    expect(inserted.every(a => a.sourceKey === "on511" && a.advisoryOnly === true)).toBe(true);
  });

  it("will not collect from Saskatchewan, because there is nothing published to collect", async () => {
    const { store } = fakeStore();
    const { client } = fakeClient(() => ({ status: 200, body: "" }));
    await expect(ingestProvider({ provider: providerFor("sk_highway_hotline")!, row: row("sk_highway_hotline"), state: emptyFeedState(), env: {}, client, store, at })).rejects.toThrow(/no published API/);
  });

  it("fails a truncated DriveBC page rather than withdrawing what it did not see", async () => {
    const { store } = fakeStore();
    const page = { events: Array.from({ length: 500 }, (_, i) => ({ ...DRIVEBC_EVENT, id: `drivebc.ca/DBC-${i}` })), pagination: { offset: "0" } };
    const { client } = fakeClient(() => ({ status: 200, body: JSON.stringify(page) }));
    const out = await ingestProvider({ provider: providerFor("drivebc_open511")!, row: row("drivebc_open511"), state: emptyFeedState(), env: {}, client, store, at });
    expect(out.run.outcome).toBe("failed");
    expect(out.withdrawn).toBe(0);
    expect(out.run.errorText).toMatch(/may be cut short/);
  });
});

/* ------------------------------------------------------------------ */

const IBI_CLOSURE = {
  ID: 118877, SourceId: "MTO-118877", Organization: "ERS", RoadwayName: "Highway 11",
  DirectionOfTravel: "Both Directions", Description: "Highway 11 closed in both directions between Hearst and Longlac due to a collision.",
  Reported: 1790000000, LastUpdated: 1790003600, StartDate: 1790000000, PlannedEndDate: 0,
  LanesAffected: "All lanes", Latitude: 49.6910, Longitude: -83.6690, LatitudeSecondary: 49.7810, LongitudeSecondary: -86.5480,
  EventType: "closures", EventSubType: "Collision", IsFullClosure: true, Severity: "Major", Restrictions: [],
};
const IBI_ROADWORK = {
  ID: "220045", RoadwayName: "Highway 17", Description: "Lane restriction for bridge rehabilitation.",
  LastUpdated: 1790003600, StartDate: 1789900000, PlannedEndDate: 1795000000,
  Latitude: 46.3, Longitude: -79.4, EventType: "roadwork", IsFullClosure: false, Severity: "Moderate",
  Restrictions: { Width: 11, Height: null, Weight: null, Speed: null },
};

describe("the 511 platform's events", () => {
  const n = ibi511Normalizer("on511", at);

  it("reads a full closure as a closure, placed across both of its points", () => {
    const a = accept(n(IBI_CLOSURE, 0));
    expect(a.advisoryType).toBe("closure");
    expect(a.severity).toBe("closure");
    expect(a.roadName).toBe("Highway 11");
    expect(a.externalRef).toBe("118877");
    expect(a.sourceUpdatedAt).toEqual(new Date(1790003600 * 1000));
    // PlannedEndDate of 0 is "not stated", not the epoch.
    expect(a.effectiveTo).toBeNull();
    // Hearst to Longlac is ~210 km; the circle must reach both ends.
    expect(a.radiusMetres!).toBeGreaterThan(100_000);
  });

  it("rounds a moderate severity up", () => {
    expect(ibiSeverity({ Severity: "Moderate" })).toBe("major");
    expect(ibiSeverity({ Severity: "Minor" })).toBe("minor");
    expect(ibiSeverity({ Severity: "whatever" })).toBe("unknown");
    expect(ibiSeverity({ Severity: "Minor", IsFullClosure: true })).toBe("closure");
  });

  it("leaves a single point's radius to the advisory default", () => {
    const a = accept(n(IBI_ROADWORK, 1));
    expect(a.advisoryType).toBe("construction");
    expect(a.radiusMetres).toBeNull();
    expect(a.point).toEqual([-79.4, 46.3]);
  });

  it("accepts an event with no position, so it can be reported as unplaced", () => {
    const a = accept(n({ ID: 9, Description: "Advisory for the region", EventType: "closures" }, 2));
    expect(a.point).toBeNull();
  });

  it("rejects a record with no ID, by name", () => {
    const r = n({ Description: "x" }, 7);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("event 7 has no ID");
  });

  it("refuses to read an error envelope as an empty listing", () => {
    expect(() => parseIbi511Events(JSON.stringify({ Message: "Invalid key" }))).toThrow(/JSON array/);
    expect(parseIbi511Events("[]")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

const DRIVEBC_EVENT = {
  jurisdiction_url: "https://api.open511.gov.bc.ca/jurisdiction",
  id: "drivebc.ca/DBC-82106", headline: "CONSTRUCTION", status: "ACTIVE",
  created: "2025-09-28T21:24:11-07:00", updated: "2026-01-26T10:10:05-08:00",
  description: "Highway 5, southbound. Construction work between Miledge Creek Bridge and Thunder River Rd for 4.9 km (17 to 12 km north of Blue River). Until Sat Nov 7 at 5:00 PM PST.",
  schedule: { recurring_schedules: [{ days: [1, 2, 3, 4, 5], start_date: "2025-09-29", daily_start_time: "08:00", end_date: "2026-11-08", daily_end_time: "17:00" }] },
  event_type: "CONSTRUCTION", event_subtypes: ["ROAD_MAINTENANCE"], severity: "MINOR",
  geography: { type: "LineString", coordinates: [[-119.215331, 52.2266], [-119.208951, 52.236537], [-119.188498, 52.267044]] },
  roads: [{ name: "Highway 5", from: "Miledge Creek Bridge", to: "Thunder River Rd", direction: "S" }],
};

describe("DriveBC Open511", () => {
  const n = drivebcNormalizer(at);

  it("normalizes a real event", () => {
    const a = accept(n(DRIVEBC_EVENT, 0));
    expect(a.sourceKey).toBe("drivebc_open511");
    expect(a.advisoryType).toBe("construction");
    expect(a.severity).toBe("minor");
    expect(a.roadName).toBe("Highway 5");
    expect(a.headline).toMatch(/^Highway 5, southbound/);
    expect(a.sourceUpdatedAt).toEqual(new Date("2026-01-26T18:10:05Z"));
    // Bare dates are Pacific midnight, not UTC midnight and not the server's.
    expect(a.effectiveFrom).toEqual(new Date("2025-09-29T07:00:00Z"));
    expect(a.effectiveTo).toEqual(new Date("2026-11-08T08:00:00Z"));
    expect(a.radiusMetres).toBeGreaterThanOrEqual(DEFAULT_ADVISORY_RADIUS_METRES);
  });

  it("reads offset-less intervals in Pacific time", () => {
    const a = accept(n({ ...DRIVEBC_EVENT, schedule: { intervals: ["2026-09-24T15:00/2026-09-24T23:00"] } }, 0));
    expect(a.effectiveFrom).toEqual(new Date("2026-09-24T22:00:00Z"));
    expect(a.effectiveTo).toEqual(new Date("2026-09-25T06:00:00Z"));
  });

  it("treats an open-ended interval as having no end", () => {
    const a = accept(n({ ...DRIVEBC_EVENT, schedule: { intervals: ["2026-09-24T15:00/"] } }, 0));
    expect(a.effectiveTo).toBeNull();
  });

  it("reads ROAD_CLOSED as a closure whatever the stated severity", () => {
    const a = accept(n({ ...DRIVEBC_EVENT, event_type: "INCIDENT", severity: "MINOR", event_subtypes: ["ROAD_CLOSED"] }, 0));
    expect(a.advisoryType).toBe("closure");
    expect(a.severity).toBe("closure");
  });

  it("refuses a page that could be partial, by either signal", () => {
    expect(() => parseDriveBcEvents(JSON.stringify({ events: [DRIVEBC_EVENT], pagination: { next_url: "/events?offset=1" } }))).toThrow(IncompleteSnapshotError);
    expect(() => parseDriveBcEvents(JSON.stringify({ events: [DRIVEBC_EVENT, DRIVEBC_EVENT] }), 2)).toThrow(IncompleteSnapshotError);
    expect(parseDriveBcEvents(JSON.stringify({ events: [DRIVEBC_EVENT], pagination: { offset: "0" } }), 2)).toHaveLength(1);
  });

  it("rejects an archived event rather than showing it as live", () => {
    expect(n({ ...DRIVEBC_EVENT, status: "ARCHIVED" }, 0).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

const QC_FEATURE = {
  type: "Feature", id: 135768,
  properties: {
    identifiant: "135768", identifiantChantier: "250648", routeAutoroute: "136",
    entraveType: "Majeure (semaine et fin de semaine)", debut: "2022/10/08 05:00:00", fin: "2026/12/31 05:00:00", miseAJour: "2026/09/23 10:59:00",
    identificationDesTravaux: "Réfection du pont d'étagement rue Saint-Urbain",
    entrave: "Fermeture de 2 voies sur 4, en tout temps", entravesLieesAuxChargesEtDimensions: "",
    descriptionAnglais: "Repair of the overpass on Saint-Urbain Street\nIn Montreal, in the Viger Tunnel, between Panet Street and Exit 5 (Robert-Bourassa Boulevard)\nWESTBOUND\nClosure of 2 out of 4 lanes, at all times",
    descriptionFrancais: "Réfection du pont d'étagement rue Saint-Urbain",
    source: "https://www.quebec511.info",
  },
  geometry: { type: "LineString", coordinates: [[-73.550397, 45.517124], [-73.554929, 45.5127], [-73.560671, 45.50461]] },
};

describe("Québec roadworks", () => {
  const n = quebecRoadworksNormalizer(at);

  it("normalizes a real feature, in Eastern time", () => {
    const a = accept(n(QC_FEATURE, 0));
    expect(a.sourceKey).toBe("qc_mtmd_roadworks");
    expect(a.advisoryType).toBe("construction");
    expect(a.severity).toBe("major");
    expect(a.roadName).toBe("Route 136");
    expect(a.headline).toMatch(/^Repair of the overpass/);
    expect(a.sourceUpdatedAt).toEqual(new Date("2026-09-23T14:59:00Z"));
    // Winter date: EST, five hours.
    expect(a.effectiveTo).toEqual(new Date("2026-12-31T10:00:00Z"));
  });

  it("reads a road closed outright as a closure, and a closed ramp as not", () => {
    const closed = accept(n({ ...QC_FEATURE, properties: { ...QC_FEATURE.properties, entrave: "Route fermée en tout temps", entraveType: "Mineure (semaine)" } }, 0));
    expect(closed.severity).toBe("closure");
    expect(closed.advisoryType).toBe("closure");
    const ramp = accept(n({ ...QC_FEATURE, properties: { ...QC_FEATURE.properties, entrave: "Sortie fermée", entraveType: "Mineure (semaine)" } }, 0));
    expect(ramp.severity).toBe("minor");
  });

  it("carries a clearance into the headline and types it a restriction — still advisory", () => {
    const a = accept(n({ ...QC_FEATURE, properties: { ...QC_FEATURE.properties, entravesLieesAuxChargesEtDimensions: "Hauteur libre : 4,3 mètres" } }, 0));
    expect(a.advisoryType).toBe("restriction");
    expect(a.headline).toContain("Hauteur libre : 4,3 mètres");
    expect(a.headline.length).toBeLessThanOrEqual(400);
    expect(a.advisoryOnly).toBe(true);
  });

  it("refuses a listing the service says it truncated", () => {
    const body = (matched: number) => JSON.stringify({ type: "FeatureCollection", numberMatched: matched, features: [QC_FEATURE] });
    expect(() => parseQuebecRoadworks(body(602))).toThrow(IncompleteSnapshotError);
    expect(parseQuebecRoadworks(body(1))).toHaveLength(1);
    expect(() => parseQuebecRoadworks("{}")).toThrow(/FeatureCollection/);
  });
});

/* ------------------------------------------------------------------ */

describe("shared coercions", () => {
  it("never reads a wall-clock time in the server's zone", () => {
    expect(fromDateText("2026-01-15 12:00:00", "America/Toronto")).toEqual(new Date("2026-01-15T17:00:00Z"));
    expect(fromDateText("2026-07-15T12:00", "America/Toronto")).toEqual(new Date("2026-07-15T16:00:00Z"));
    expect(fromDateText("2026-07-15T12:00:00-06:00", "America/Toronto")).toEqual(new Date("2026-07-15T18:00:00Z"));
    expect(fromDateText("soon", "America/Toronto")).toBeNull();
  });

  it("covers every coordinate it was given and ignores null island", () => {
    expect(coveringCircle([])).toBeNull();
    expect(coveringCircle([[0, 0]])).toBeNull();
    const c = coveringCircle([[-114, 53], [-113, 53]])!;
    expect(c.radiusMetres).toBeGreaterThan(33_000); // half of ~67 km, plus margin
  });
});
