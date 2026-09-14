/**
 * v22.20 — the first screen over the communications engine.
 *
 * Source-level, because the client has no test renderer configured and adding
 * one to assert three facts would be a larger change than the page. What these
 * pin is the thing that actually matters about this file: that it renders the
 * server's verdict rather than reaching its own.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const page = readFileSync("client/src/pages/CommunicationsPackage.tsx", "utf8");

describe("the screen computes nothing", () => {
  it("carries no communications engine of its own", () => {
    // The prototype this layout came from shipped authority tiers, transmit
    // authorization and coverage windows in the browser. LeaseOS has all of
    // those on the server, and two of them would diverge.
    for (const forbidden of ["authorityRank", "transmitAuthorization", "planCommunications", "resolveAssignment", "haversineKm"]) {
      expect(page).not.toContain(forbidden);
    }
  });

  it("reads its data from the mounted procedure rather than a bundled world", () => {
    expect(page).toContain("trpc.comms.packageFetch");
    // The prototype drove four views from a hardcoded trip.
    // The prototype directory, not our own view model beside it.
    expect(page).not.toMatch(/from "@\/lib\/comms\//);
    expect(page).not.toContain("TRIP");
  });

  it("uses a mutation, because fetching a sealed package is a recorded access", () => {
    expect(page).toContain("useMutation");
    expect(page).not.toContain("packageFetch.useQuery");
  });
});

describe("what it refuses to show", () => {
  it("does not invent a package when none is on file", () => {
    expect(page).toContain("No package on file");
    expect(page).toContain("will not make one up");
  });

  it("shows the server's staleness warning rather than hiding it", () => {
    // A radio plan quietly out of date is worse than a blank screen.
    expect(page).toContain("pkg.data.warning");
  });

  it("renders the sealed zone's own fields, not invented ones", () => {
    // `segmentId`, `label`, `status` and `reason` were never on the zone.
    expect(page).toContain("zone.roadName");
    expect(page).toContain("zone.unknownReason");
    expect(page).toContain("transmitTone(zone.transmit)");
  });

  it("takes its colour from the shared view model", () => {
    expect(page).toContain("TONE_CLASS[transmitTone(zone.transmit)]");
  });
});

describe("the screen is reachable", () => {
  const app = readFileSync("client/src/App.tsx", "utf8");

  it("is mounted on a route", () => {
    // Compiled into the repository is not the same as navigable.
    expect(app).toContain('import CommunicationsPackage from "./pages/CommunicationsPackage"');
    expect(app).toContain('path="/comms/package"');
  });

  it("is not a showcase route, because it reads real records", () => {
    // Demonstration data on this path would be indistinguishable from an
    // operational answer.
    expect(app).not.toContain('/showcase/comms/package');
    expect(app).not.toMatch(/ShowcaseFrame[^>]*>\s*<CommunicationsPackage/);
  });
});
