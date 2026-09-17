// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B28E — the V2 contract, and the mistakes it makes unrepresentable.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ADAPTER_REMOVAL_CRITERIA, authorityFor, canRenderHistorically, isV2, liveOnlyFields,
  migrationReport, V2_DESCRIPTORS, V2_KEYS, type WidgetDescriptorV2,
} from "./_core/widgetRegistryV2";
import {
  labelAssertsCompliance, presentClock, SHIFT_DERIVED, type HosClockKey,
} from "./_core/hosClockPresentation";
import { WIDGET_KEYS } from "./_core/widgetRegistry";

const d = (k: string) => V2_DESCRIPTORS[k as keyof typeof V2_DESCRIPTORS] as WidgetDescriptorV2;

/**
 * Source with comments removed.
 *
 * The first version of these guards grepped raw text and fired on the very
 * comments explaining why a symbol is forbidden — so the guard's own
 * documentation broke it. Stripping comments makes the assertion mean what it
 * was always meant to mean: the *code* does not reference this.
 */
const codeOnly = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("narrow migration", () => {
  it("migrates exactly the four widgets the evidence supports", () => {
    expect([...V2_KEYS].sort()).toEqual(["activeTrip", "dispatchReadiness", "hosRemaining", "syncStatus"]);
  });

  it("leaves the other eight on the adapter, each with a reason", () => {
    const r = migrationReport(WIDGET_KEYS);
    expect(r.v2Native).toHaveLength(4);
    expect(r.legacyAdapter).toHaveLength(8);
    expect(r.production).toBe(0);
    for (const k of r.legacyAdapter) {
      // Half-migrated forever is the risk; every legacy entry names why.
      expect(r.legacyReasons[k], k).toBeTruthy();
      expect(r.legacyReasons[k], k).not.toBe("unclassified");
    }
  });

  it("sets evidence criteria for removing the adapter, not a date", () => {
    expect(ADAPTER_REMOVAL_CRITERIA.length).toBeGreaterThan(3);
    expect(ADAPTER_REMOVAL_CRITERIA.join(" ")).not.toMatch(/\b20\d\d\b|Q[1-4]/);
  });

  it("keeps every persisted key unchanged", () => {
    for (const k of V2_KEYS) expect(WIDGET_KEYS).toContain(k);
  });
});

describe("invalid combinations cannot be written down", () => {
  it("gives a device-local source no procedure field", () => {
    const src = d("syncStatus").source;
    expect(src.kind).toBe("device_local");
    expect(JSON.stringify(src)).not.toContain("procedure");
    expect(JSON.stringify(d("syncStatus"))).not.toContain("sync.receivePackage");
  });

  it("requires a procedure on every server source", () => {
    for (const k of V2_KEYS) {
      const s = d(k).source;
      if (s.kind !== "server") continue;
      expect(s.procedure, k).toBeTruthy();
    }
  });

  it("fixes action authority at none for every descriptor", () => {
    for (const k of V2_KEYS) expect(d(k).actionAuthority, k).toBe("none");
  });

  it("offers no type by which a descriptor could raise action authority", () => {
    const src = readFileSync(new URL("./_core/widgetRegistryV2.ts", import.meta.url), "utf8");
    expect(src).toMatch(/readonly actionAuthority: "none"/);
    expect(src).not.toMatch(/actionAuthority:\s*"(authoritative|display_only|allowed)"/);
  });
});

describe("value authority depends on connectivity", () => {
  it("keeps a trip authoritative online and display-only offline", () => {
    expect(d("activeTrip").valueAuthority).toEqual({ online: "authoritative", offline: "display_only" });
    expect(authorityFor(d("activeTrip"), true)).toBe("authoritative");
    expect(authorityFor(d("activeTrip"), false)).toBe("display_only");
  });

  it("keeps the device's own queue authoritative in both", () => {
    expect(authorityFor(d("syncStatus"), false)).toBe("authoritative");
  });

  it("gives a server aggregate no authority offline", () => {
    expect(authorityFor(d("dispatchReadiness"), false)).toBe("none");
  });
});

describe("temporal capability affects runtime", () => {
  it("refuses historical rendering for a live-only widget", () => {
    expect(canRenderHistorically(d("syncStatus"))).toBe(false);
    expect(canRenderHistorically(d("hosRemaining"))).toBe(false);
  });

  it("allows it for dispatch readiness, and names what history loses", () => {
    expect(canRenderHistorically(d("dispatchReadiness"))).toBe(true);
    expect(liveOnlyFields(d("dispatchReadiness"))).toEqual(["explanation", "contributions"]);
  });

  it("names the persisted fields so a historical view cannot promise more", () => {
    const t = d("dispatchReadiness").temporal;
    expect(t.capability).toBe("live_and_historical");
    if (t.capability !== "live_and_historical") return;
    expect(t.persistedFields).toEqual(["verdict", "blockers", "fingerprint", "evaluatedAt"]);
    expect(t.persistedFields).not.toContain("contributions");
  });

  it("returns no live-only fields for a live-only widget", () => {
    expect(liveOnlyFields(d("syncStatus"))).toEqual([]);
  });
});

describe("HOS clock presentation", () => {
  const NOW = new Date("2026-09-12T14:35:00Z");
  const clock = (k: HosClockKey, o: Record<string, unknown> = {}) =>
    presentClock({ clockKey: k, elapsedMinutes: 442, asOf: NOW, shiftBasisIsDefault: false, ...o });

  it("has no remaining field at all", () => {
    expect(codeOnly("./_core/hosClockPresentation.ts")).not.toMatch(/remainingMinutes/);
    expect(JSON.stringify(clock("dailyDriveMinutes"))).not.toContain("remaining");
  });

  it("confirms a measured clock", () => {
    expect(clock("dailyDriveMinutes")).toMatchObject({
      confidence: "CONFIRMED_ELAPSED", label: "Driving today", basis: "measured from duty records",
    });
  });

  it("never confirms a shift clock built on a default boundary", () => {
    for (const k of SHIFT_DERIVED) {
      const p = clock(k, { shiftBasisIsDefault: true, shiftBasis: "work shift taken to begin after 8 h of rest — a default, because no verified core-rest figure applies" });
      expect(p.confidence, k).toBe("UNVERIFIED_ELAPSED");
      expect(p.explanation, k).toContain("default");
      // The value is still shown; it is the badge that changes.
      expect(p.elapsedMinutes, k).toBe(442);
    }
  });

  it("confirms a shift clock when the boundary is verified", () => {
    expect(clock("shiftElapsedMinutes", { shiftBasisIsDefault: false }).confidence).toBe("CONFIRMED_ELAPSED");
  });

  it("treats a null clock as unknown, never as zero", () => {
    const p = clock("sinceMandatoryRestHours", { elapsedMinutes: null });
    expect(p.confidence).toBe("UNKNOWN");
    expect(p.elapsedMinutes).toBeNull();
    // "Since mandatory rest: 0m" would claim a rest just happened.
    expect(p.elapsedMinutes).not.toBe(0);
  });

  it("rejects every label that asserts a legal conclusion", () => {
    for (const bad of ["Hours Remaining", "Legal Hours Left", "Safe to Drive", "Reset Available", "Compliant for 3 more hours"]) {
      expect(labelAssertsCompliance(bad), bad).toBe(true);
    }
  });

  it("accepts the evidence-backed labels", () => {
    for (const good of ["Shift elapsed", "Driving today", "On duty today", "On duty, cycle 1"]) {
      expect(labelAssertsCompliance(good), good).toBe(false);
    }
  });

  it("uses no forbidden label in any V2 descriptor", () => {
    for (const k of V2_KEYS) {
      expect(labelAssertsCompliance(d(k).title), `${k}: ${d(k).title}`).toBe(false);
    }
    // The legacy title is deliberately kept and is deliberately forbidden —
    // that mismatch is what the semantic contract records.
    expect(labelAssertsCompliance(d("hosRemaining").legacyTitle ?? "")).toBe(true);
  });
});

describe("source guards", () => {
  it("keeps compliance arithmetic out of presentation", () => {
    for (const f of ["./_core/hosClockPresentation.ts", "./_core/widgetProjection.ts"]) {
      const src = codeOnly(f);
      for (const forbidden of ["hosRuleLimits", "hosRuleProfiles", "selectProfile", "checkRuleProfile"]) {
        expect(src, `${f} must not reach for ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the fabricated sync procedure out of V2 source", () => {
    const src = codeOnly("./_core/widgetRegistryV2.ts");
    expect(src).not.toContain('"sync.receivePackage"');
    expect(src).not.toContain("sync.push_own");
  });

  it("never defaults historical contributions to an empty array", () => {
    expect(codeOnly("./_core/widgetSemantics.ts")).not.toMatch(/contributions:\s*\[\]/);
    expect(readFileSync(new URL("./_core/widgetSemantics.ts", import.meta.url), "utf8")).toContain("unavailable_historically");
  });
});
