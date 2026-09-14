/**
 * v22.20 — the transmit screen, and what it must not decide.
 *
 * Source-level: the client has no test renderer, and the facts worth pinning
 * are about where the answer comes from rather than how it looks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const page = readFileSync("client/src/pages/TransmitCheck.tsx", "utf8");

describe("the decision is the server's", () => {
  it("carries none of the prototype's browser-side engine", () => {
    for (const forbidden of ["authorityRank", "transmitAuthorization(", "evaluateCondition", "haversineKm", "ALL_CHANNELS"]) {
      expect(page).not.toContain(forbidden);
    }
    // The prototype directory, not our own view model beside it.
    expect(page).not.toMatch(/from "@\/lib\/comms\//);
  });

  it("asks the mounted procedure", () => {
    expect(page).toContain("trpc.comms.transmitCheck");
  });
});

describe("every gate, not only the failing one", () => {
  it("renders the whole gate list", () => {
    // "Blocked" alone sends a driver to the office; the list tells them who to call.
    expect(page).toContain("gates.map");
    expect(page).toContain("No gates were evaluated");
  });

  it("gives an unestablished gate its own mark rather than a quiet pass", () => {
    // The tones themselves are exercised against real engine values in
    // commsView.test.ts; here only that the page defers to them.
    expect(page).toContain("toneIcon(view.tone)");
    expect(page).toContain("not established");
  });

  it("shows the engine's reasons verbatim rather than a paraphrase", () => {
    expect(page).toContain("reasons.map");
    expect(page).toContain("{view.reason}");
    expect(page).toContain("condition.reason");
  });

  it("reads conditions in the engine's own shape", () => {
    // "met"/"unmet" were invented; the engine says permitted/excluded/crosses.
    expect(page).toContain("conditionTone(condition.result)");
    expect(page).not.toContain('"met"');
    expect(page).not.toContain("companyAuthorization");
  });
});

describe("what it says about its own question", () => {
  it("marks a check made without a unit as not answering for a truck", () => {
    expect(page).toContain("does not answer for any particular truck");
  });

  it("takes its status colour from the shared view model", () => {
    expect(page).toContain("TONE_CLASS[transmitTone(check.data.status)]");
  });
});

describe("the screen is reachable", () => {
  const app = readFileSync("client/src/App.tsx", "utf8");

  it("is mounted on a route", () => {
    // Compiled into the repository is not the same as navigable.
    expect(app).toContain('import TransmitCheck from "./pages/TransmitCheck"');
    expect(app).toContain('path="/comms/transmit"');
  });

  it("is not a showcase route, because it reads real records", () => {
    // Demonstration data on this path would be indistinguishable from an
    // operational answer.
    expect(app).not.toContain('/showcase/comms/transmit');
    expect(app).not.toMatch(/ShowcaseFrame[^>]*>\s*<TransmitCheck/);
  });
});
