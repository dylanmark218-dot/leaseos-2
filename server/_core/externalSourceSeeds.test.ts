import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  ALL_DATA_SOURCES,
  ADVISORY_ONLY_SOURCES,
  isAdvisoryOnly,
  SOFTWARE_COMPONENTS,
  SOURCES_REQUIRING_API_KEY,
  SOURCE_CAVEATS,
  UNVERIFIED_DATA_SOURCES,
  VERIFIED_DATA_SOURCES,
} from "./externalSourceSeeds";
import {
  assessFreshness,
  collectAttributions,
  evaluateSourceUsage,
  planFeedFetch,
} from "./externalDataRegistry";
import { seedExternalDataSources, listExternalDataSources } from "../db";

/**
 * The research, enforced.
 *
 * These tests exist *before* any downloader does, deliberately. The point of
 * paying for the verification work is that the runtime consumes it — a registry
 * that lives only in a markdown file is a document the code never reads, and
 * the first import would proceed on whatever someone remembered.
 */

const byKey = (k: string) =>
  ALL_DATA_SOURCES.find(s => s.sourceKey === k)!;

describe("the count is eight, not nine", () => {
  it("has eleven sources, eight verified and three not", () => {
    // The research summary said "nine of eleven are clean" while separately
    // flagging three as unresolved. Eleven minus three is eight. Seeding nine
    // would have marked a blocked source usable.
    expect(ALL_DATA_SOURCES).toHaveLength(11);
    expect(VERIFIED_DATA_SOURCES).toHaveLength(8);
    expect(UNVERIFIED_DATA_SOURCES).toHaveLength(3);
  });

  it("names exactly the three that could not be verified", () => {
    expect(UNVERIFIED_DATA_SOURCES.map(s => s.sourceKey).sort()).toEqual([
      "ab511",
      "aer_st102",
      "aer_st37",
    ]);
  });

  it("marks every verified source verified and every other one not", () => {
    for (const s of VERIFIED_DATA_SOURCES) {
      expect(s.status, s.sourceKey).toBe("verified");
      expect(s.verifiedAt, s.sourceKey).not.toBeNull();
    }
    for (const s of UNVERIFIED_DATA_SOURCES) {
      expect(s.status, s.sourceKey).toBe("unverified");
      expect(s.verifiedAt, s.sourceKey).toBeNull();
    }
  });
});

describe("the three unresolved sources are inert", () => {
  it("refuses AER and 511 for operational use, redistribution and offline bundling", () => {
    for (const s of UNVERIFIED_DATA_SOURCES) {
      for (const intent of ["operational_decision", "redistribute", "offline_package"] as const) {
        const r = evaluateSourceUsage({ source: s, intent });
        expect(r.permitted, `${s.sourceKey}/${intent}`).toBe(false);
      }
      // Inspection stays open — you have to be able to look at a candidate.
      expect(evaluateSourceUsage({ source: s, intent: "inspect" }).permitted).toBe(true);
    }
  });

  it("cannot become an offline-bundle source while redistribution is unknown", () => {
    const r = evaluateSourceUsage({
      source: byKey("aer_st37"),
      intent: "offline_package",
    });
    expect(r.permitted).toBe(false);
    expect(r.reason).toMatch(/have not been checked|Redistribution/);
  });

  it("still refuses if someone flips status to verified without doing the legal work", () => {
    // First barrier: commercial-use terms are still unknown.
    for (const s of UNVERIFIED_DATA_SOURCES) {
      const forged = { ...s, status: "verified" as const, verifiedAt: new Date() };
      const r = evaluateSourceUsage({ source: forged, intent: "operational_decision" });
      expect(r.permitted, s.sourceKey).toBe(false);
      expect(r.reason, s.sourceKey).toContain("Commercial use");
    }
  });

  it("still refuses when status AND commercial terms are both forged", () => {
    // Second barrier: attributionText is null on all three, so a source cannot
    // reach operational use by editing status and permissions alone — somebody
    // has to have actually recorded what the publisher requires to be shown.
    for (const s of UNVERIFIED_DATA_SOURCES) {
      const forged = {
        ...s,
        status: "verified" as const,
        verifiedAt: new Date(),
        commercialUsePermitted: "yes" as const,
        redistributionPermitted: "yes" as const,
      };
      const r = evaluateSourceUsage({ source: forged, intent: "operational_decision" });
      expect(r.permitted, s.sourceKey).toBe(false);
      expect(r.reason, s.sourceKey).toContain("attribution");
    }
  });

  it("records the commercial and redistribution terms as unknown, not as no", () => {
    // "Unknown" is the honest state — nobody said no, nobody confirmed yes.
    for (const s of UNVERIFIED_DATA_SOURCES) {
      expect(s.commercialUsePermitted, s.sourceKey).toBe("unknown");
      expect(s.redistributionPermitted, s.sourceKey).toBe("unknown");
    }
  });
});

describe("OpenStreetMap surfaces the derivative-database obligation", () => {
  const osm = byKey("osm");

  it("flags share-alike when bundled into an offline package", () => {
    const r = evaluateSourceUsage({ source: osm, intent: "offline_package" });
    expect(r.permitted).toBe(true);
    expect(r.derivedDatabaseObligation).toBe(true);
    expect(r.caveats.join(" ")).toContain("derived database");
  });

  it("is the only share-alike source in the set", () => {
    const copyleft = ALL_DATA_SOURCES.filter(s => s.shareAlikeObligation);
    expect(copyleft.map(s => s.sourceKey)).toEqual(["osm"]);
  });

  it("carries the accepted attribution wording", () => {
    expect(osm.attributionText).toBe("© OpenStreetMap contributors");
  });

  it("records the Produced Work versus Derivative Database distinction", () => {
    expect(SOURCE_CAVEATS.osm).toContain("Derivative Database");
    expect(SOURCE_CAVEATS.osm).toContain("Produced Work");
  });
});

describe("Alberta 511 is throttled centrally", () => {
  const ab511 = byKey("ab511");
  const now = new Date("2026-09-09T12:00:00Z");

  it("records ten calls per sixty seconds", () => {
    expect(ab511.rateLimitCalls).toBe(10);
    expect(ab511.rateLimitWindowSeconds).toBe(60);
  });

  it("requires an API key", () => {
    expect(SOURCES_REQUIRING_API_KEY).toContain("ab511");
  });

  it("refuses an eleventh call inside the window and serves cache instead", () => {
    const recent = Array.from({ length: 10 }, () => new Date(now.getTime() - 20_000));
    const r = planFeedFetch({
      rateLimitCalls: ab511.rateLimitCalls,
      rateLimitWindowSeconds: ab511.rateLimitWindowSeconds,
      recentFetchTimes: recent,
      cacheAgeSeconds: 600,
      maxCacheAgeSeconds: 120,
      now,
    });
    expect(r.allowed).toBe(false);
    expect(r.serveFromCache).toBe(true);
    expect(r.waitSeconds).toBeGreaterThan(0);
  });

  it("says plainly that the raw API must not be proxied to devices", () => {
    expect(SOURCE_CAVEATS.ab511).toContain("never proxy the raw API");
  });
});

describe("CWFIS is advisory and cannot satisfy a safety constraint", () => {
  it("is registered advisory-only", () => {
    expect(isAdvisoryOnly("cwfis")).toBe(true);
    expect(ADVISORY_ONLY_SOURCES).toEqual(["cwfis"]);
  });

  it("carries the publisher's own operational disclaimer", () => {
    expect(SOURCE_CAVEATS.cwfis).toContain("not designed for operational fire management");
    expect(SOURCE_CAVEATS.cwfis).toContain("Advisory only");
  });

  it("is licensed for use — advisory is about fitness, not permission", () => {
    // The licence permits it. What it cannot do is answer a safety question.
    const r = evaluateSourceUsage({ source: byKey("cwfis"), intent: "operational_decision" });
    expect(r.permitted).toBe(true);
    expect(isAdvisoryOnly("cwfis")).toBe(true);
  });

  it("does not mark any road or land source advisory-only", () => {
    for (const k of ["osm", "nrn", "ats", "drivebc_open511"]) {
      expect(isAdvisoryOnly(k), k).toBe(false);
    }
  });
});

describe("attribution is collected, and gaps are named", () => {
  it("produces the distinct attribution lines for the verified set", () => {
    const r = collectAttributions(VERIFIED_DATA_SOURCES);
    expect(r.missing).toEqual([]);
    expect(r.lines).toContain("© OpenStreetMap contributors");
    expect(r.lines).toContain(
      "Contains information licensed under the Open Government Licence – Canada"
    );
    expect(r.lines).toContain(
      "Contains information licensed under the Open Government Licence – Alberta"
    );
    expect(r.lines).toContain(
      "Contains information licensed under the Open Government Licence – British Columbia"
    );
  });

  it("deduplicates a licence line shared by several sources", () => {
    // NRN, CanVec and CWFIS all carry the OGL-Canada line.
    const r = collectAttributions(VERIFIED_DATA_SOURCES);
    const canada = r.lines.filter(l => l.includes("Open Government Licence – Canada"));
    expect(canada).toHaveLength(1);
  });

  it("names the sources missing required attribution", () => {
    const r = collectAttributions(ALL_DATA_SOURCES);
    expect(r.missing.sort()).toEqual(["ab511", "aer_st102", "aer_st37"]);
  });
});

describe("freshness uses the recorded interval", () => {
  it("treats a day-old road-conditions feed as stale", () => {
    const r = assessFreshness({
      retrievedAt: new Date("2026-09-08T12:00:00Z"),
      updateIntervalHours: byKey("drivebc_open511").updateIntervalHours,
      now: new Date("2026-09-09T12:00:00Z"),
    });
    expect(r.freshness).toBe("stale");
    expect(r.usableForConstraintSatisfaction).toBe(false);
  });

  it("leaves the survey grid unknown rather than inventing an interval", () => {
    // ATS is a base survey grid; the publisher states no refresh cadence, so
    // the field is null and freshness is unknown rather than assumed fresh.
    const ats = byKey("ats");
    expect(ats.updateIntervalHours).toBeNull();
    const r = assessFreshness({
      retrievedAt: ats.retrievedAt,
      updateIntervalHours: ats.updateIntervalHours,
      now: new Date("2026-09-09T12:00:00Z"),
    });
    expect(r.freshness).toBe("unknown");
    expect(r.usableForConstraintSatisfaction).toBe(false);
  });
});

describe("software components are registered separately from data", () => {
  it("keeps MapLibre GL JS and MapLibre Native as distinct entries", () => {
    // They carry different BSD variants; collapsing them would misstate one.
    const gl = SOFTWARE_COMPONENTS.find(c => c.componentKey === "maplibre_gl_js")!;
    const native = SOFTWARE_COMPONENTS.find(c => c.componentKey === "maplibre_native")!;
    expect(gl.licenceSpdx).toBe("BSD-3-Clause");
    expect(native.licenceSpdx).toBe("BSD-2-Clause");
    expect(gl.licenceSpdx).not.toBe(native.licenceSpdx);
  });

  it("registers all eight components as usable in a closed-source product", () => {
    expect(SOFTWARE_COMPONENTS).toHaveLength(8);
    for (const c of SOFTWARE_COMPONENTS) {
      expect(c.safeForClosedSourceCommercial, c.componentKey).toBe(true);
    }
  });

  it("keeps the PostGIS copyleft caveat attached", () => {
    const pg = SOFTWARE_COMPONENTS.find(c => c.componentKey === "postgis")!;
    expect(pg.licenceSpdx).toBe("GPL-2.0-or-later");
    expect(pg.caveat).toContain("Do not fork it into the product");
  });

  it("keeps the GDAL build-dependency caveat attached", () => {
    const gdal = SOFTWARE_COMPONENTS.find(c => c.componentKey === "gdal")!;
    expect(gdal.caveat).toContain("build actually shipped");
  });

  it("records that Valhalla accepts the parameters the profile emits", () => {
    const v = SOFTWARE_COMPONENTS.find(c => c.componentKey === "valhalla")!;
    for (const p of ["height", "width", "length", "weight", "axle_load", "hazmat"]) {
      expect(v.caveat, p).toContain(p);
    }
  });

  it("does not put software into the data source registry", () => {
    // A software licence and a data licence create different obligations, and
    // the usage gate asks data questions. Mixing them returns confident nonsense.
    const dataKeys = ALL_DATA_SOURCES.map(s => s.sourceKey);
    for (const c of SOFTWARE_COMPONENTS) {
      expect(dataKeys, c.componentKey).not.toContain(c.componentKey);
    }
  });
});

/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  // These tests deliberately mutate seeded rows (the no-downgrade case), and
  // the database persists between runs. Without this reset the second run of
  // the file reads the first run's mutations and fails for the wrong reason.
  await pool.execute("DELETE FROM externalDataSources");
});

d("seeding into the database", () => {
  it("inserts all eleven and is idempotent on a second run", async () => {
    const first = await seedExternalDataSources();
    expect(first.inserted.length + first.existing.length).toBe(11);

    const second = await seedExternalDataSources();
    expect(second.inserted).toEqual([]);
    expect(second.existing).toHaveLength(11);
  });

  it("persists status, rate limit and retrieval date", async () => {
    await seedExternalDataSources();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT sourceKey, status, rateLimitCalls, rateLimitWindowSeconds, requiresApiKey, retrievedAt, verifiedAt FROM externalDataSources WHERE sourceKey IN ('ab511','osm','aer_st37')"
    );
    const map = new Map(rows.map(r => [r.sourceKey, r]));

    expect(map.get("ab511")!.status).toBe("unverified");
    expect(map.get("ab511")!.rateLimitCalls).toBe(10);
    expect(map.get("ab511")!.rateLimitWindowSeconds).toBe(60);
    expect(Number(map.get("ab511")!.requiresApiKey)).toBe(1);
    expect(map.get("ab511")!.verifiedAt).toBeNull();

    expect(map.get("osm")!.status).toBe("verified");
    expect(map.get("osm")!.verifiedAt).not.toBeNull();
    expect(map.get("osm")!.retrievedAt).not.toBeNull();

    expect(map.get("aer_st37")!.status).toBe("unverified");
  });

  it("does not downgrade a row somebody has since verified", async () => {
    await seedExternalDataSources();
    // Simulate the legal work being completed for AER.
    await pool.execute(
      "UPDATE externalDataSources SET status='verified', commercialUsePermitted='yes', redistributionPermitted='yes', attributionText='© Alberta Energy Regulator', verifiedAt=NOW() WHERE sourceKey='aer_st37'"
    );

    await seedExternalDataSources();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT status, commercialUsePermitted FROM externalDataSources WHERE sourceKey='aer_st37'"
    );
    // Re-running the seed must not revert somebody's legal confirmation.
    expect(rows[0].status).toBe("verified");
    expect(rows[0].commercialUsePermitted).toBe("yes");
  });

  it("carries the publisher caveats into the stored notes", async () => {
    await seedExternalDataSources();
    const rows = await listExternalDataSources();
    const cwfis = rows.find(r => r.sourceKey === "cwfis")!;
    expect(cwfis.notes).toContain("not designed for operational fire management");
  });
});
