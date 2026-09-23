/**
 * The resolver rules that sit around its contract.
 *
 * `server/boundaryConfirmation.test.ts` is the contract the resolver was built to — written RED
 * before it existed and left exactly as approved. This file covers what implementing it added:
 *
 *   - that the resolver knows exactly the boundaries `siteBaseline` bounds its phases with;
 *   - its fail-closed handling of evidence it cannot read, which a typed caller never produces
 *     but a corrupted or hostile manifest can;
 *   - `readFieldManifest`'s `intact` flag, which the receipt reader relies on.
 *
 * Everything here is pure. The rules about receipts and rows are in `boundaryEvidence.test.ts`.
 * Each fail-closed case is written so that failing OPEN would be visible: the evidence it breaks
 * would otherwise have produced `confirmed`.
 */
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_KEYS,
  UNREACHABLE_BOUNDARIES,
  boundaryConfirmations,
  readFieldManifest,
  type BoundaryEvidence,
} from "./_core/boundaryConfirmation";
import { PHASE_BOUNDARIES } from "./_core/siteBaseline";

const at = (iso: string) => new Date(iso);
const T1 = at("2026-09-20T10:00:00Z");
const T2 = at("2026-09-20T11:00:00Z");

const ev = (over: Partial<BoundaryEvidence> & { fieldKey: string }): BoundaryEvidence => ({
  source: "driver_voice",
  status: "confirmed",
  committedAt: T1,
  ...over,
});

/** A manifest the way `assistantCommitService.fieldManifest` writes one. */
const manifest = (fields: Array<{ key: string; status: string; source?: string }>) =>
  JSON.stringify(
    fields
      .map(f => ({
        key: f.key,
        value: "10:00",
        precision: "exact",
        source: f.source ?? "driver_voice",
        confidence: "high",
        status: f.status,
        sourceUtterance: null,
        correctedFrom: null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );

const ALL_REACHABLE_CONFIRMED = manifest([
  { key: "arrivedAt", status: "confirmed" },
  { key: "operationStartedAt", status: "confirmed" },
  { key: "operationCompletedAt", status: "corrected", source: "human_corrected" },
  { key: "departedAt", status: "confirmed" },
]);

describe("the resolver's shape", () => {
  it("knows exactly the five boundaries siteBaseline bounds its phases with", () => {
    const fromPhases = new Set(Object.values(PHASE_BOUNDARIES).flat());
    expect(new Set(BOUNDARY_KEYS)).toEqual(fromPhases);
  });

  it("declares only boundaries it knows", () => {
    for (const key of UNREACHABLE_BOUNDARIES) expect(BOUNDARY_KEYS).toContain(key);
  });
});

describe("evidence the resolver cannot read makes that boundary unknown", () => {
  /*
   * A typed caller cannot produce these. They are here because the resolver's input
   * crosses a trust boundary — manifests are text in a database — and the rule for
   * unreadable evidence must fail closed, not be skipped: skipping it would let an
   * older `confirmed` speak for a value the unreadable entry may have replaced.
   */
  const olderConfirmed = ev({ fieldKey: "arrivedAt", status: "confirmed", committedAt: T1 });

  it("refuses an unrecognised status rather than skipping it", () => {
    const bad = { ...ev({ fieldKey: "arrivedAt", committedAt: T2 }), status: "approved" } as unknown as BoundaryEvidence;
    expect(boundaryConfirmations([olderConfirmed, bad]).arrivedAt).toBe("unknown");
  });

  it("refuses an unrecognised source", () => {
    const bad = { ...ev({ fieldKey: "arrivedAt", committedAt: T2 }), source: "telepathy" } as unknown as BoundaryEvidence;
    expect(boundaryConfirmations([olderConfirmed, bad]).arrivedAt).toBe("unknown");
  });

  it("refuses a commit instant that is not a real date — it cannot be ordered", () => {
    const bad = ev({ fieldKey: "arrivedAt", committedAt: new Date(Number.NaN) });
    expect(boundaryConfirmations([olderConfirmed, bad]).arrivedAt).toBe("unknown");
  });

  it("confines the damage to the boundary the bad evidence is about", () => {
    const bad = { ...ev({ fieldKey: "arrivedAt" }), status: "approved" } as unknown as BoundaryEvidence;
    const out = boundaryConfirmations([bad, ev({ fieldKey: "departedAt", status: "confirmed" })]);
    expect(out.arrivedAt).toBe("unknown");
    expect(out.departedAt).toBe("confirmed");
  });

  it("does not treat a rejected field as unreadable — rejection is a recorded act", () => {
    // The distinction that matters: rejected is ignored, garbage poisons.
    const out = boundaryConfirmations([
      olderConfirmed,
      ev({ fieldKey: "arrivedAt", status: "rejected", source: "gps", committedAt: T2 }),
    ]);
    expect(out.arrivedAt).toBe("confirmed");
  });
});

describe("readFieldManifest says whether the whole manifest was readable", () => {
  it("is intact for a manifest written the way the commit service writes one", () => {
    const read = readFieldManifest(ALL_REACHABLE_CONFIRMED, T1);
    expect(read.intact).toBe(true);
    expect(read.evidence.map(e => e.fieldKey).sort()).toEqual(
      ["arrivedAt", "departedAt", "operationCompletedAt", "operationStartedAt"],
    );
  });

  it("is not intact when any entry is unreadable, and still returns the readable ones", () => {
    const json = JSON.stringify([
      { key: "arrivedAt", source: "gps", status: "confirmed" },
      { key: "departedAt", status: "confirmed" },
      "a string",
      null,
    ]);
    const read = readFieldManifest(json, T1);
    expect(read.intact).toBe(false);
    expect(read.evidence.map(e => e.fieldKey)).toEqual(["arrivedAt"]);
  });

  it("is not intact for text that is not a JSON array", () => {
    for (const bad of ["", "not json", "{}", "null", "42"]) {
      expect(readFieldManifest(bad, T1)).toEqual({ evidence: [], intact: false });
    }
  });

  it("is intact for an empty array — nothing to read is not the same as unreadable", () => {
    expect(readFieldManifest("[]", T1)).toEqual({ evidence: [], intact: true });
  });

  it("reads nothing when the commit instant is not a real date", () => {
    expect(readFieldManifest(ALL_REACHABLE_CONFIRMED, new Date(Number.NaN))).toEqual({
      evidence: [],
      intact: false,
    });
  });

  it("does not share the caller's Date object with the evidence it returns", () => {
    const when = new Date(T1.getTime());
    const read = readFieldManifest(ALL_REACHABLE_CONFIRMED, when);
    when.setFullYear(1999);
    expect(read.evidence[0].committedAt.getTime()).toBe(T1.getTime());
  });
});
