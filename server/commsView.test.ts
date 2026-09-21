/**
 * v22.20 — the engine's vocabulary, exercised with the engine's own values.
 *
 * These replace the string-grepping that let three miswired screens pass. Every
 * case below is a value the engine actually produces, fed through the function
 * the screen calls.
 */
import { describe, expect, it } from "vitest";
import {
  carrierNeedsAction, carrierTone, conditionTone, gateTone, GATE_LABEL, gateView,
  TONE_CLASS, transmitTone,
} from "../client/src/lib/commsView";
import type { Gate, TransmitStatus, ConditionResult } from "./_core/commRoute";
import type { CarriedState } from "./_core/commPackage";

describe("transmit status", () => {
  it("covers the engine's four statuses and no invented ones", () => {
    const all: TransmitStatus[] = ["authorized", "not_authorized", "requires_posted_channel", "unknown"];
    expect(all.map(transmitTone)).toEqual(["good", "bad", "warn", "muted"]);
  });

  it("does not show a refusal as unknown", () => {
    // The page previously looked for "prohibited", so a real not_authorized
    // zone rendered in the grey reserved for "we could not tell".
    expect(transmitTone("not_authorized")).not.toBe(transmitTone("unknown"));
    expect(TONE_CLASS[transmitTone("not_authorized")]).toContain("red");
  });

  it("does not show a posted-channel requirement as a refusal", () => {
    expect(transmitTone("requires_posted_channel")).toBe("warn");
  });
});

describe("gates", () => {
  const gate = (o: Partial<Gate> = {}): Gate => ({
    gate: "company_authorization", result: "no",
    reason: "No company authorization is on record for VHF-152.480", ...o,
  });

  it("names every gate the engine can return", () => {
    const names: Gate["gate"][] = ["channel_record", "service_class", "geography", "company_authorization", "unit_capability"];
    for (const n of names) expect(GATE_LABEL[n]).toBeTruthy();
  });

  it("renders the engine's reason unedited", () => {
    const v = gateView(gate());
    expect(v.reason).toBe("No company authorization is on record for VHF-152.480");
    expect(v.label).toBe("Company authorization");
  });

  it("keeps requires_posting apart from a failure", () => {
    // A red cross there sends a driver to the office over a road they may
    // lawfully drive.
    expect(gateTone("requires_posting")).toBe("warn");
    expect(gateTone("no")).toBe("bad");
  });

  it("gives unknown its own mark rather than a quiet pass", () => {
    expect(gateTone("unknown")).toBe("muted");
    expect(gateTone("unknown")).not.toBe(gateTone("yes"));
  });

  it("renders a five-gate response with real labels, not ordinals", () => {
    const gates: Gate[] = [
      gate({ gate: "channel_record", result: "yes", reason: "VHF-152.480 is on record" }),
      gate({ gate: "service_class", result: "yes", reason: "Class is permitted for this use" }),
      gate({ gate: "geography", result: "requires_posting", reason: "Usable where a channel is posted" }),
      gate({ gate: "company_authorization", result: "no", reason: "No authorization on record" }),
      gate({ gate: "unit_capability", result: "unknown", reason: "No capability recorded for this unit" }),
    ];
    const views = gates.map(gateView);
    expect(views.map(v => v.label)).toEqual([
      "Channel on record", "Service class", "Geography", "Company authorization", "Unit capability",
    ]);
    // Previously every one of these rendered as "Gate 1..5" with no reason.
    expect(views.every(v => v.reason.length > 0)).toBe(true);
    expect(views.map(v => v.tone)).toEqual(["good", "good", "warn", "bad", "muted"]);
  });
});

describe("conditions", () => {
  it("covers the engine's five results", () => {
    const all: ConditionResult[] = ["permitted", "excluded", "crosses", "requires_posting", "unknown"];
    expect(all.map(conditionTone)).toEqual(["good", "bad", "warn", "warn", "muted"]);
  });

  it("treats crossing a boundary as something to look at, not a refusal", () => {
    expect(conditionTone("crosses")).toBe("warn");
    expect(conditionTone("crosses")).not.toBe(conditionTone("excluded"));
  });
});

describe("who is carrying what", () => {
  it("covers the engine's four carried states", () => {
    const all: CarriedState[] = ["current", "behind", "stale", "none"];
    expect(all.map(carrierTone)).toEqual(["good", "bad", "bad", "muted"]);
  });

  it("shows a driver on an older package as a problem, not as unknown", () => {
    // The page previously looked for "outdated" and coloured behind/stale grey.
    expect(TONE_CLASS[carrierTone("behind")]).toContain("red");
    expect(TONE_CLASS[carrierTone("stale")]).toContain("red");
  });

  it("keeps behind and stale apart, because the fixes differ", () => {
    // One device re-downloads; everybody needs a rebuild.
    expect(carrierNeedsAction("behind")).toBe(true);
    expect(carrierNeedsAction("stale")).toBe(true);
    expect(carrierNeedsAction("none")).toBe(false);
    expect(carrierNeedsAction("current")).toBe(false);
  });
});

describe("no screen declares its own copy of a comms response", () => {
  it("has no structural casts left in the communications pages", async () => {
    const { readFileSync } = await import("fs");
    for (const page of ["CommunicationsPackage", "TransmitCheck", "CommunicationsPackageStatus"]) {
      const src = readFileSync(`client/src/pages/${page}.tsx`, "utf8");
      // A hand-written type describing somebody else's response is a second
      // copy of a contract, and the copy is what the screen obeys.
      expect(src).not.toMatch(/as Gate\[\]|as Carrier\[\]|as PackageZone\[\]/);
      expect(src).not.toMatch(/^type (Gate|Carrier|Condition|PackageZone) = /m);
    }
  });
});
