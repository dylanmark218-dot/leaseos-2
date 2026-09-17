// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B28D — a correct procedure does not make a truthful widget.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  fingerprintChanged, hasFabricatedProcedure, historicalReadiness, normalizeAll,
  normalizeWidgetDefinition, notStored, recorded, truthfulTitle,
  type NormalizedWidget,
} from "./_core/widgetSemantics";
import { definitionFor, WIDGET_KEYS } from "./_core/widgetRegistry";

const all = () => normalizeAll(WIDGET_KEYS);
const of = (k: string) => normalizeWidgetDefinition(k as never);

describe("the semantic contract, which B23 never had", () => {
  it("refuses Hours Remaining on semantics while every mechanical axis is fine", () => {
    const w = of("hosRemaining");
    // Procedure, permission, source and engine are all confirmed…
    expect(w.authorization).toMatchObject({ kind: "procedure", procedure: "hos.status" });
    expect(w.source).toMatchObject({ kind: "server", procedure: "hos.status" });
    expect(w.engine.confidence).toBe("CONFIRMED");
    // …and the name is still wrong.
    expect(w.semantic.status).toBe("UNSUPPORTED_NAME_OR_MEANING");
  });

  it("names what the tile should be called instead", () => {
    const w = of("hosRemaining");
    expect(truthfulTitle(w)).toBe("Hours Worked");
    if (w.semantic.status !== "UNSUPPORTED_NAME_OR_MEANING") throw new Error("expected mismatch");
    expect(w.semantic.legacyTitle).toBe("Hours Remaining");
    expect(w.semantic.reason).toContain("no single hours-remaining");
  });

  it("keeps the persisted key untouched", () => {
    // Layouts, caches and archived boards hold this string. The title changes;
    // the key does not.
    expect(definitionFor("hosRemaining").key).toBe("hosRemaining");
    expect(of("hosRemaining").key).toBe("hosRemaining");
  });

  it("never lets a legacy definition inherit a confirmed semantic contract", () => {
    for (const w of all()) {
      if (!w.legacyContract) continue;
      expect(w.semantic.status, w.key).not.toBe("CONFIRMED");
    }
  });
});

describe("syncStatus, migrated", () => {
  const w = () => of("syncStatus");

  it("has a device-local source with no server procedure", () => {
    expect(w().source).toMatchObject({ kind: "device_local", resolver: "sync_queue" });
    expect(JSON.stringify(w().source)).not.toContain("procedure");
  });

  it("drops the fabricated sync.status from the normalized contract", () => {
    expect(JSON.stringify(w())).not.toContain("sync.receivePackage");
    // The registry still carries it; normalization is the adapter, not a migration.
    expect(definitionFor("syncStatus").procedure).toBe("sync.receivePackage");
  });

  it("keeps authorization unresolved, with the question recorded", () => {
    expect(w().authorization.kind).toBe("unresolved");
    if (w().authorization.kind !== "unresolved") return;
    expect((w().authorization as { question: string }).question).toContain("own-scoped");
  });

  it("does not let device-local imply authorized", () => {
    // The device can compute the value; that is not permission to show it.
    expect(w().valueAuthority).toBe("authoritative");
    expect(w().authorization.kind).toBe("unresolved");
  });

  it("reports no fabricated procedure once normalized", () => {
    expect(hasFabricatedProcedure(w())).toBe(false);
  });

  it("refuses to copy a server procedure onto a device-local widget by the legacy path", () => {
    // Narrower than it first looked. An offline policy of `device_local` and a
    // data source of `device_local` are different axes: `hosRemaining` reads
    // the real `hos.status` when online *and* the device computes its clocks
    // when offline, so its server source is correct and overlay-supplied.
    // What must not happen is the *legacy* path inventing one.
    for (const w2 of all()) {
      if (w2.offline.kind !== "device_local") continue;
      if (!w2.legacyContract) continue; // evidence-backed overlay, not a guess
      expect(w2.source.kind, w2.key).not.toBe("server");
    }
  });

  it("keeps an evidence-backed server source on a widget that also resolves offline", () => {
    const hos = of("hosRemaining");
    expect(hos.offline.kind).toBe("device_local");
    expect(hos.source).toMatchObject({ kind: "server", procedure: "hos.status" });
    expect(hos.legacyContract).toBe(false);
  });
});

describe("value authority is not action authority", () => {
  it("gives every widget action authority of none, unconditionally", () => {
    for (const w of all()) expect(w.actionAuthority, w.key).toBe("none");
  });

  it("has no way for a definition to raise it", () => {
    const src = readFileSync(new URL("./_core/widgetSemantics.ts", import.meta.url), "utf8");
    expect(src).toMatch(/readonly actionAuthority: "none"/);
    expect(src).not.toMatch(/actionAuthority:\s*"(authoritative|allowed)"/);
  });

  it("lets a display-only cache report a value it cannot authorize on", () => {
    expect(of("activeTrip").valueAuthority).toBe("display_only");
    expect(of("activeTrip").actionAuthority).toBe("none");
  });

  it("keeps a server aggregate non-authoritative on the device", () => {
    expect(of("dispatchReadiness").valueAuthority).toBe("none");
  });
});

describe("temporal capability", () => {
  it("marks dispatch readiness live-only because contributions are not persisted", () => {
    expect(of("dispatchReadiness").temporal).toBe("live");
  });

  it("returns recorded contributions from a live answer", () => {
    const live = recorded([{ engine: "routing", finding: "No route named for this readiness" }]);
    expect(live.state).toBe("recorded");
  });

  it("returns unavailable_historically, never an empty list, from a stored check", () => {
    const h = historicalReadiness({
      verdict: "blocked", blockers: [{ code: "X", detail: "x" }],
      fingerprint: "a".repeat(64), evaluatedAt: new Date(),
    });
    expect(h.contributions.state).toBe("unavailable_historically");
    // An empty list would say "there were no contributors". There were four,
    // and nobody kept them.
    expect(JSON.stringify(h.contributions)).not.toBe("[]");
    expect(h.contributions.state).not.toBe("none");
  });

  it("distinguishes none from unavailable", () => {
    expect(notStored("never persisted").state).toBe("unavailable_historically");
    expect(recorded([]).state).toBe("recorded");
  });

  it("gives historical readiness a different type than live", () => {
    const h = historicalReadiness({ verdict: "ok", blockers: [], fingerprint: "f", evaluatedAt: new Date() });
    expect(h.mode).toBe("historical");
    // No `explanation` field: the persisted row does not carry one.
    expect(Object.keys(h)).not.toContain("explanation");
  });
});

describe("the fingerprint is opaque", () => {
  it("supports equality and change detection only", () => {
    expect(fingerprintChanged("a".repeat(64), "b".repeat(64))).toBe(true);
    expect(fingerprintChanged("a".repeat(64), "a".repeat(64))).toBe(false);
  });

  it("exposes no decoder", () => {
    const src = readFileSync(new URL("./_core/widgetSemantics.ts", import.meta.url), "utf8");
    for (const forbidden of ["decodeFingerprint", "parseFingerprint", "fingerprintComponents", "rootCauseFromFingerprint"]) {
      expect(src).not.toContain(forbidden);
    }
    expect(src).toContain("never \"is this the same problem?\"");
  });
});

describe("the HOS projector boundary", () => {
  it("keeps compliance arithmetic out of the projection layer", () => {
    const src = readFileSync(new URL("./_core/widgetProjection.ts", import.meta.url), "utf8");
    // A projector that imported rule limits or the profile selector would be
    // positioned to compute limit − elapsed, which is a compliance result.
    for (const forbidden of ["hosRuleLimits", "hosRuleProfiles", "selectProfile", "checkRuleProfile"]) {
      expect(src, `projection layer must not reach for ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("has no projector that subtracts an elapsed clock from a limit", () => {
    const src = readFileSync(new URL("./_core/widgetProjection.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/limit\s*-\s*elapsed|drivingLimitMinutes\s*-/);
  });
});
