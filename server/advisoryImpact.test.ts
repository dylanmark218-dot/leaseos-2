/**
 * v22.20 (0081) — an advisory is placed by geometry, and stays an advisory.
 */
import { describe, expect, it } from "vitest";
import { advisoriesOnRoute, advisoryLines, DEFAULT_ADVISORY_RADIUS_METRES, type RoadAdvisory, type RouteLeg } from "./_core/advisoryImpact";

const at = new Date("2026-09-11T12:00:00Z");
const ago = (min: number) => new Date(at.getTime() - min * 60_000);

// A route running north up one line of longitude, 10 km per leg.
const leg = (id: string, lat0: number, lat1: number): RouteLeg => ({
  segmentId: id, lengthKm: 10,
  geography: { segmentId: id, province: "AB", path: [[-114.0, lat0], [-114.0, lat1]] },
});
const route: RouteLeg[] = [leg("S-1", 53.00, 53.09), leg("S-2", 53.09, 53.18), leg("S-3", 53.18, 53.27)];

const advisory = (o: Partial<RoadAdvisory> = {}): RoadAdvisory => ({
  sourceKey: "ab511", externalRef: "EVT-1", advisoryType: "road_condition", severity: "major",
  headline: "Poor winter driving conditions", roadName: "Highway 40",
  point: [-114.0, 53.12], radiusMetres: 3_000,
  effectiveFrom: null, effectiveTo: null, sourceUpdatedAt: ago(20), retrievedAt: ago(5),
  advisoryOnly: true, ...o,
});

describe("placed by geometry, not by the road's name", () => {
  it("attaches an advisory to the kilometres it actually reaches", () => {
    const r = advisoriesOnRoute({ route, advisories: [advisory()], at, publisherIntervalHours: 1 });
    expect(r.placed).toHaveLength(1);
    expect(r.placed[0]).toMatchObject({ fromKm: 10, toKm: 20, segmentIds: ["S-2"], staleness: "current" });
    expect(r.placed[0].line).toContain("km 10–20");
    expect(r.placed[0].line).toContain("ADVISORY — review before departure");
  });

  it("does not attach an event on the same highway 200 km away", () => {
    // Same roadName, nowhere near this route. String matching would have hit.
    const far = advisory({ point: [-114.0, 55.0], roadName: "Highway 40" });
    const r = advisoriesOnRoute({ route, advisories: [far], at, publisherIntervalHours: 1 });
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced[0]).toMatchObject({ reason: "too_far" });
    expect(r.unplaced[0].detail).toContain("outside its");
  });

  it("spans every segment its radius reaches", () => {
    const wide = advisory({ point: [-114.0, 53.135], radiusMetres: 12_000 });
    const r = advisoriesOnRoute({ route, advisories: [wide], at, publisherIntervalHours: 1 });
    expect(r.placed[0].segmentIds.length).toBeGreaterThan(1);
    expect(r.placed[0].fromKm).toBe(0);
  });

  it("uses a conservative default area when the publisher states no radius", () => {
    const noRadius = advisory({ radiusMetres: null, point: [-114.01, 53.12] });
    expect(DEFAULT_ADVISORY_RADIUS_METRES).toBe(2_000);
    expect(advisoriesOnRoute({ route, advisories: [noRadius], at, publisherIntervalHours: 1 }).placed).toHaveLength(1);
  });
});

describe("what cannot be placed is said, not dropped", () => {
  it("reports an advisory the publisher gave no position for", () => {
    const r = advisoriesOnRoute({ route, advisories: [advisory({ point: null })], at, publisherIntervalHours: 1 });
    expect(r.unplaced[0]).toMatchObject({ reason: "no_position" });
    expect(r.unplaced[0].detail).toContain("Highway 40");
    expect(advisoryLines(r).some(l => l.startsWith("UNPLACED"))).toBe(true);
  });

  it("names an advisory outside its effective window instead of silently ignoring it", () => {
    const ended = advisory({ effectiveTo: ago(600) });
    const notYet = advisory({ externalRef: "EVT-2", effectiveFrom: new Date(at.getTime() + 3_600_000) });
    const r = advisoriesOnRoute({ route, advisories: [ended, notYet], at, publisherIntervalHours: 1 });
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced.map(u => u.reason)).toEqual(["out_of_window", "out_of_window"]);
    expect(r.unplaced[0].detail).toContain("Ended");
    expect(r.unplaced[1].detail).toContain("does not start until".replace("d", "D").slice(0, 4));
  });

  it("says a route with no geometry is unsearchable rather than clear", () => {
    const blind: RouteLeg[] = [{ segmentId: "S-X", lengthKm: 15, geography: null }];
    const r = advisoriesOnRoute({ route: blind, advisories: [advisory()], at, publisherIntervalHours: 1 });
    expect(r.outcome).toBe("unsearchable");
    expect(r.unsearchableKm).toBe(15);
    expect(r.summary).toContain("not the same as no advisories");
  });

  it("says nothing found is not nothing happening", () => {
    const r = advisoriesOnRoute({ route, advisories: [], at, publisherIntervalHours: 1 });
    expect(r.outcome).toBe("no_advisories");
    expect(r.summary).toContain("Nothing found is not nothing happening");
  });
});

describe("a stale feed says stale", () => {
  it("grades against the publisher's own refresh interval, not an invented number", () => {
    const current = advisoriesOnRoute({ route, advisories: [advisory({ sourceUpdatedAt: ago(30) })], at, publisherIntervalHours: 1 });
    expect(current.placed[0].staleness).toBe("current");

    const aging = advisoriesOnRoute({ route, advisories: [advisory({ sourceUpdatedAt: ago(120) })], at, publisherIntervalHours: 1 });
    expect(aging.placed[0].staleness).toBe("aging");

    const stale = advisoriesOnRoute({ route, advisories: [advisory({ sourceUpdatedAt: ago(600) })], at, publisherIntervalHours: 1 });
    expect(stale.placed[0].staleness).toBe("stale");
    expect(stale.placed[0].line).toContain("STALE, older than this feed's own refresh interval");
    expect(stale.outcome).toBe("advisories_and_stale");
  });

  it("is unknown, not current, when the publisher states no interval", () => {
    const r = advisoriesOnRoute({ route, advisories: [advisory()], at, publisherIntervalHours: null });
    expect(r.placed[0].staleness).toBe("unknown");
    expect(r.placed[0].line).toContain("staleness unknown");
  });
});

describe("an advisory never becomes a permission", () => {
  it("returns an impact whose determination is advisory_only whatever the severity", () => {
    const closure = advisory({ advisoryType: "closure", severity: "closure", headline: "Road closed" });
    const r = advisoriesOnRoute({ route, advisories: [closure], at, publisherIntervalHours: 1 });
    expect(r.determination).toBe("advisory_only");
    expect(r.summary).toContain("None of them changes whether this route is legal");
    // The placed advisory carries the publisher's own flag, structurally true.
    expect(r.placed[0].advisory.advisoryOnly).toBe(true);
  });

  it("offers no field a caller could read as clear, legal, or authorized", () => {
    const r = advisoriesOnRoute({ route, advisories: [advisory()], at, publisherIntervalHours: 1 });
    const keys = Object.keys(r).join(" ");
    for (const forbidden of ["legal", "authorized", "clear", "verdict", "dispatchStatus"]) {
      expect(keys.includes(forbidden)).toBe(false);
    }
  });
});
