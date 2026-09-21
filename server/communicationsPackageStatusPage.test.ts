/**
 * v22.20 — the office view, and the record it must not create.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const page = readFileSync("client/src/pages/CommunicationsPackageStatus.tsx", "utf8");
const app = readFileSync("client/src/App.tsx", "utf8");

describe("looking does not become carrying", () => {
  it("reads status rather than fetching the package", () => {
    // packageFetch records a download — a claim that somebody took this into
    // the field, and the thing staleness is later computed against.
    expect(page).toContain("trpc.comms.packageStatus");
    // The docstring names it to explain why it is not used; what matters is
    // that it is never called.
    expect(page).not.toContain("trpc.comms.packageFetch");
  });

  it("says so on the screen", () => {
    expect(page).toContain("no download is created by reading");
  });
});

describe("what the office can and cannot know", () => {
  it("separates downloaded from acknowledged", () => {
    // Sent and arrived-and-verified are different facts.
    expect(page).toContain("not acknowledged");
    expect(page).toContain("carrier.acknowledged");
  });

  it("does not claim to know what is on a silent device", () => {
    expect(page).toContain("may be carrying something else, and that is not knowable from here");
  });

  it("shows the server's reason even when nothing changed", () => {
    // Silence would read as "not checked".
    expect(page).toContain("reasons.map");
  });

  it("counts the two kinds of gap separately", () => {
    // A zone with no channel and an unverified channel are different problems.
    expect(page).toContain("unverifiedChannels");
    expect(page).toContain("zonesWithoutChannel");
  });

  it("takes carrier colour from the shared view model and shows the server's note", () => {
    expect(page).toContain("TONE_CLASS[carrierTone(carrier.state)]");
    // "reason" does not exist on the response; the field is "note".
    expect(page).toContain("{carrier.note}");
    expect(page).not.toContain("carrier.reason");
  });
});

describe("the screen is reachable", () => {
  it("is mounted on an authoritative route", () => {
    expect(app).toContain('import CommunicationsPackageStatus from "./pages/CommunicationsPackageStatus"');
    expect(app).toContain('path="/comms/status"');
    expect(app).not.toMatch(/ShowcaseFrame[^>]*>\s*<CommunicationsPackageStatus/);
  });
});
