/**
 * RED. The resolver these tests describe does not exist yet.
 *
 * SPINE ordering item 1: "Per-boundary confirmation on `tripStops`. `0169` gave
 * the row an actor; it did not say which of the five timestamps a person stands
 * behind. `siteBaseline` filters on exactly that and cannot be wired to real
 * data without it. One resolver, read by both engines."
 * (`docs/register/SPINE_WIRING_PLAN.md:47-49`, which lives in the sibling
 * repository; this one carries no copy of the plan. The finding does not
 * depend on it: `server/_core/siteBaseline.ts` is byte-identical across both
 * trees, `UnloadStopPatch` lacks `setupStartedAt` in both, and both schemas
 * carry `fieldManifest` and `fieldManifestHash` on `assistantCommitReceipts`.)
 *
 * ## What the survey established
 *
 * The chain already exists end to end and nothing joins its last two links:
 *
 *     tripStops.id
 *       → assistantCommitReceipts (targetType 'trip_stop', targetRecordId)
 *       → fieldManifest           (sha256-sealed, on the receipt row)
 *       → per-field source + status
 *       → BoundaryConfirmation
 *
 * **The manifest is the evidence, not `proposalFields`.** `siteBaseline.ts:88`
 * names `proposalFields`' own `source` and `status` columns, and the manifest
 * carries exactly those values — it is built from the same `ProposedField`. It
 * is the better read for three reasons, each checked rather than assumed:
 * `commitProposal` filters rejected and null fields out, so the manifest is
 * what actually reached the row; it is hashed, so it is tamper-evident; and it
 * hangs off the receipt that already names the stop, so no second lookup can
 * attribute one proposal's field to another stop.
 *
 * **Only four of the five boundaries are reachable.** `UnloadStopPatch` writes
 * `arrivedAt`, `operationStartedAt`, `operationCompletedAt` and `departedAt`.
 * There is no `setupStartedAt` field on any form and no column for it in the
 * patch, so no assistant commit can ever speak for it. Since `combineBoundaries`
 * lets `unknown` dominate, the `setup` and `wait` phases — both bounded by
 * `setupStartedAt` — stay `unknown` however much else is confirmed. That is a
 * finding about the system, not a gap in the resolver, and the tests below
 * assert it so it cannot be papered over later.
 *
 * **A committed field is always exact.** `exactField` refuses an approximate
 * value outright, because `tripStops` has no precision channel. So precision is
 * not an input here; `PhasePrecision` remains siteBaseline's own question.
 *
 * ## The rule that must not be collapsed
 *
 * `unconfirmed` and `unknown` are different facts with different remedies, and
 * `siteBaseline.ts:38-44` says why: `unconfirmed` means a proposal is sitting
 * there waiting for a person, and somebody can confirm it this afternoon.
 * `unknown` means provenance was never recorded, and no amount of confirming
 * fixes it. Several cases below exist only to pin that apart.
 */
import { describe, expect, it } from "vitest";
import type { BoundaryConfirmation, BoundaryKey } from "./_core/siteBaseline";
import {
  boundaryConfirmations,
  parseFieldManifest,
  UNREACHABLE_BOUNDARIES,
  type BoundaryEvidence,
} from "./_core/boundaryConfirmation";

const at = (iso: string) => new Date(iso);

const evidence = (over: Partial<BoundaryEvidence> & { fieldKey: string }): BoundaryEvidence => ({
  source: "driver_voice",
  status: "proposed",
  committedAt: at("2026-09-20T10:00:00Z"),
  ...over,
});

const ALL_UNKNOWN: Record<BoundaryKey, BoundaryConfirmation> = {
  arrivedAt: "unknown",
  setupStartedAt: "unknown",
  operationStartedAt: "unknown",
  operationCompletedAt: "unknown",
  departedAt: "unknown",
};

describe("no evidence at all", () => {
  it("is unknown everywhere, never unconfirmed", () => {
    // The distinction the whole file exists to hold. A stop nobody has written
    // provenance for has not got a pending proposal waiting on somebody.
    expect(boundaryConfirmations([])).toEqual(ALL_UNKNOWN);
  });

  it("reports unknown for a boundary no evidence mentions, while others are settled", () => {
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", status: "confirmed" }),
    ]);
    expect(out.arrivedAt).toBe("confirmed");
    expect(out.operationStartedAt).toBe("unknown");
    expect(out.departedAt).toBe("unknown");
  });
});

describe("what a person standing behind a value looks like", () => {
  it("treats a confirmed field as confirmed", () => {
    expect(
      boundaryConfirmations([evidence({ fieldKey: "arrivedAt", status: "confirmed" })]).arrivedAt
    ).toBe("confirmed");
  });

  it("treats a corrected field as confirmed, whatever it was corrected from", () => {
    // siteBaseline.ts:88-93 names this the case that matters. Somebody typed a
    // different value; that is a person standing behind it.
    expect(
      boundaryConfirmations([
        evidence({ fieldKey: "arrivedAt", status: "corrected", source: "human_corrected" }),
      ]).arrivedAt
    ).toBe("confirmed");
  });

  it("treats an untouched proposal as unconfirmed, not confirmed", () => {
    // It reached the record because the proposal was committed, but nobody
    // acted on this particular field.
    expect(
      boundaryConfirmations([evidence({ fieldKey: "arrivedAt", status: "proposed" })]).arrivedAt
    ).toBe("unconfirmed");
  });

  it("treats a pending GPS detection as unconfirmed", () => {
    // The exact case siteBaseline's header describes: "a proposal nobody has
    // acted on yet (a pending detection)".
    expect(
      boundaryConfirmations([
        evidence({ fieldKey: "arrivedAt", source: "gps", status: "proposed" }),
      ]).arrivedAt
    ).toBe("unconfirmed");
  });

  it("treats a confirmed GPS detection as confirmed", () => {
    // A person looked at the detection and agreed. Source does not demote a
    // status; the status is the act.
    expect(
      boundaryConfirmations([
        evidence({ fieldKey: "arrivedAt", source: "gps", status: "confirmed" }),
      ]).arrivedAt
    ).toBe("confirmed");
  });
});

describe("a rejected field must not poison a corrected one", () => {
  /**
   * The conflict rule, stated in `siteBaseline.ts:91-93`: "a `gps` field at
   * `rejected` sitting beside a `human_corrected` field must not poison the
   * corrected value."
   *
   * `commitProposal` already filters rejected fields out of the manifest, so
   * this should not arise through the committed path — which is exactly why it
   * is worth pinning. A resolver that mishandled it would be wrong only in the
   * case nobody exercises.
   */
  it("ignores a rejected field entirely", () => {
    expect(
      boundaryConfirmations([
        evidence({ fieldKey: "arrivedAt", source: "gps", status: "rejected" }),
      ]).arrivedAt
    ).toBe("unknown");
  });

  it("keeps the corrected value when a rejected one sits beside it", () => {
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", source: "gps", status: "rejected", committedAt: at("2026-09-20T12:00:00Z") }),
      evidence({ fieldKey: "arrivedAt", source: "human_corrected", status: "corrected", committedAt: at("2026-09-20T10:00:00Z") }),
    ]);
    // The rejected row is later in time and still must not win.
    expect(out.arrivedAt).toBe("confirmed");
  });
});

describe("several receipts touching one stop", () => {
  it("lets the most recent surviving evidence decide", () => {
    // A stop is created, then corrected. Both receipts name it.
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", status: "proposed", committedAt: at("2026-09-20T08:00:00Z") }),
      evidence({ fieldKey: "arrivedAt", status: "corrected", source: "human_corrected", committedAt: at("2026-09-20T09:00:00Z") }),
    ]);
    expect(out.arrivedAt).toBe("confirmed");
  });

  it("does not let an older confirmation outrank a newer proposal", () => {
    // Somebody confirmed it, then a later capture re-proposed it. The newest
    // surviving evidence is a proposal nobody has acted on.
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", status: "confirmed", committedAt: at("2026-09-20T08:00:00Z") }),
      evidence({ fieldKey: "arrivedAt", status: "proposed", committedAt: at("2026-09-20T09:00:00Z") }),
    ]);
    expect(out.arrivedAt).toBe("unconfirmed");
  });

  it("is order-independent in its input", () => {
    // Evidence arrives from a query; row order is not a contract.
    const a = evidence({ fieldKey: "arrivedAt", status: "proposed", committedAt: at("2026-09-20T08:00:00Z") });
    const b = evidence({ fieldKey: "arrivedAt", status: "confirmed", committedAt: at("2026-09-20T09:00:00Z") });
    expect(boundaryConfirmations([a, b])).toEqual(boundaryConfirmations([b, a]));
  });

  it("breaks an exact timestamp tie toward the weaker verdict", () => {
    // Two rows committed in the same instant and disagreeing is not a state
    // anything can adjudicate. Choosing the stronger one would manufacture a
    // confirmation out of an ambiguity.
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", status: "confirmed", committedAt: at("2026-09-20T08:00:00Z") }),
      evidence({ fieldKey: "arrivedAt", status: "proposed", committedAt: at("2026-09-20T08:00:00Z") }),
    ]);
    expect(out.arrivedAt).toBe("unconfirmed");
  });

  it("keeps boundaries independent of one another", () => {
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", status: "confirmed" }),
      evidence({ fieldKey: "departedAt", status: "proposed" }),
    ]);
    expect(out.arrivedAt).toBe("confirmed");
    expect(out.departedAt).toBe("unconfirmed");
  });
});

describe("setupStartedAt cannot be spoken for", () => {
  /**
   * No form has a `setupStartedAt` field and `UnloadStopPatch` has no column
   * for it, so no assistant commit can produce evidence about it. Declared in
   * code rather than left to be rediscovered.
   */
  it("is named as unreachable", () => {
    expect([...UNREACHABLE_BOUNDARIES]).toEqual(["setupStartedAt"]);
  });

  it("stays unknown even when everything else is confirmed", () => {
    const out = boundaryConfirmations([
      evidence({ fieldKey: "arrivedAt", status: "confirmed" }),
      evidence({ fieldKey: "operationStartedAt", status: "confirmed" }),
      evidence({ fieldKey: "operationCompletedAt", status: "confirmed" }),
      evidence({ fieldKey: "departedAt", status: "confirmed" }),
    ]);
    expect(out.setupStartedAt).toBe("unknown");
  });

  it("refuses evidence that claims to speak for it", () => {
    // If a field named setupStartedAt ever appears in a manifest, something
    // upstream has changed and this resolver must not quietly honour it.
    const out = boundaryConfirmations([
      evidence({ fieldKey: "setupStartedAt", status: "confirmed" }),
    ]);
    expect(out.setupStartedAt).toBe("unknown");
  });
});

describe("evidence about things that are not boundaries", () => {
  it("ignores a field that is not one of the five", () => {
    // waitMinutes, quantity and measurementMethod all travel in the same
    // manifest and none of them is a timestamp.
    const out = boundaryConfirmations([
      evidence({ fieldKey: "waitMinutes", status: "confirmed" }),
      evidence({ fieldKey: "quantity", status: "confirmed" }),
    ]);
    expect(out).toEqual(ALL_UNKNOWN);
  });
});

describe("reading the manifest", () => {
  const manifest = JSON.stringify([
    {
      key: "arrivedAt",
      value: "2026-09-20T14:20:00.000Z",
      precision: "exact",
      source: "driver_voice",
      confidence: "high",
      status: "confirmed",
      sourceUtterance: "arrived at twenty past two",
      correctedFrom: null,
    },
    {
      key: "quantity",
      value: 12000,
      precision: "exact",
      source: "driver_voice",
      confidence: "high",
      status: "proposed",
      sourceUtterance: "twelve thousand litres",
      correctedFrom: null,
    },
  ]);

  it("reads the source and status of each committed field", () => {
    const parsed = parseFieldManifest(manifest, at("2026-09-20T15:00:00Z"));
    expect(parsed).toEqual([
      { fieldKey: "arrivedAt", source: "driver_voice", status: "confirmed", committedAt: at("2026-09-20T15:00:00Z") },
      { fieldKey: "quantity", source: "driver_voice", status: "proposed", committedAt: at("2026-09-20T15:00:00Z") },
    ]);
  });

  it("returns nothing for a manifest it cannot read, rather than guessing", () => {
    // A manifest that does not parse is not evidence of anything. Returning an
    // empty list makes every boundary it would have spoken for `unknown`, which
    // is the honest answer.
    for (const bad of ["", "not json", "{}", "null", '["a string"]']) {
      expect(parseFieldManifest(bad, at("2026-09-20T15:00:00Z"))).toEqual([]);
    }
  });

  it("drops an entry with no usable key, source or status", () => {
    const partial = JSON.stringify([
      { key: "arrivedAt", status: "confirmed" },
      { key: "departedAt", source: "gps", status: "proposed" },
    ]);
    expect(parseFieldManifest(partial, at("2026-09-20T15:00:00Z"))).toEqual([
      { fieldKey: "departedAt", source: "gps", status: "proposed", committedAt: at("2026-09-20T15:00:00Z") },
    ]);
  });

  it("composes with the resolver to answer the question siteBaseline asks", () => {
    const out = boundaryConfirmations(parseFieldManifest(manifest, at("2026-09-20T15:00:00Z")));
    expect(out.arrivedAt).toBe("confirmed");
    expect(out.departedAt).toBe("unknown");
  });
});

describe("the resolver is pure", () => {
  it("does not modify the evidence it was given", () => {
    const rows = [evidence({ fieldKey: "arrivedAt", status: "confirmed" })];
    const snapshot = JSON.stringify(rows);
    boundaryConfirmations(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("returns every boundary key on every call, so no caller has to guard", () => {
    const out = boundaryConfirmations([]);
    expect(Object.keys(out).sort()).toEqual(
      ["arrivedAt", "departedAt", "operationCompletedAt", "operationStartedAt", "setupStartedAt"].sort()
    );
  });
});
