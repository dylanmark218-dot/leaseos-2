/**
 * v22.20 — a road connection is not a permission to drive it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const page = readFileSync("client/src/pages/RoutePreview.tsx", "utf8");
const app = readFileSync("client/src/App.tsx", "utf8");
const geo = readFileSync("server/geoRouter.ts", "utf8");

describe("looking does not build a plan", () => {
  it("computes with a query rather than persisting one", () => {
    expect(page).toContain("trpc.geo.routeCompute.useQuery");
    // planForPath persists a communication plan against a trip; a preview must
    // not create a record saying a plan was made.
    expect(page).not.toContain("planForPath");
    expect(page).not.toContain("packageBuild");
  });

  it("routeCompute really is a query on the server", () => {
    const proc = geo.slice(geo.indexOf("routeCompute: roleProcedure"), geo.indexOf("routeCompute: roleProcedure") + 2000);
    expect(proc).toContain(".query(");
  });

  it("says on the screen that nothing was saved", () => {
    expect(page).toContain("No communication plan has been built");
  });
});

describe("the outcomes stay apart", () => {
  it("does not reach for path or communications on outcomes that lack them", () => {
    // no_graph, origin_unreachable and destination_unreachable carry neither.
    expect(page).toContain('"path" in data');
    expect(page).toContain('"communications" in data');
  });

  it("shows the procedure's own reasons rather than a summary", () => {
    expect(page).toContain("data.reasons.map");
  });

  it("marks anything that is not an evaluated route", () => {
    expect(page).toContain('data.outcome === "evaluated"');
  });
});

describe("a route that appears must not look approved", () => {
  it("says plainly that a path with no verdict is not a permission", () => {
    expect(page).toContain('data.outcome === "path_only"');
    expect(page).toContain("It is not a permission to drive it");
  });

  it("takes its transmit colour from the shared view model", () => {
    // No local copy of the engine's vocabulary — the mistake all three earlier
    // screens shipped with.
    expect(page).toContain("TONE_CLASS[transmitTone(zone.transmit)]");
    expect(page).not.toMatch(/^type (Zone|Path|Segment) = /m);
    expect(page).not.toMatch(/as \{[^}]*zones/);
  });
});

describe("the screen is reachable", () => {
  it("is mounted outside the showcase namespace", () => {
    expect(app).toContain('import RoutePreview from "./pages/RoutePreview"');
    expect(app).toContain('path="/route/preview"');
    expect(app).not.toMatch(/ShowcaseFrame[^>]*>\s*<RoutePreview/);
  });
});
