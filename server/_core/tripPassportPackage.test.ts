import { describe, expect, it } from "vitest";
import {
  buildTripPassportPackage,
  detectStaleness,
  hashInputs,
  mayReleaseWithoutAcknowledgement,
  type PackageItemInput,
} from "./tripPassportPackage";

const COMPLETED = new Date("2026-03-10T18:00:00Z");
const BUILT_AT = new Date("2026-03-10T19:00:00Z");
const UPDATED = new Date("2026-03-10T17:00:00Z");

const item = (
  kind: PackageItemInput["kind"],
  o: Partial<PackageItemInput> = {},
): PackageItemInput => ({
  kind,
  itemRef: `${kind}:1`,
  applicability: "required",
  applicabilityBasis: "carried on this trip",
  reference: `${kind.toUpperCase()}-1`,
  verified: true,
  updatedAt: UPDATED,
  ...o,
});

const COMPLETE: PackageItemInput[] = [
  item("manifest"),
  item("load_ticket"),
  item("disposal_ticket"),
  item("duty_record"),
  item("pre_trip_inspection"),
];

const build = (items: PackageItemInput[], completedAt: Date | null = COMPLETED) =>
  buildTripPassportPackage({ tripId: 7, tripNumber: "T-2026-0007", completedAt, items, builtAt: BUILT_AT });

describe("buildTripPassportPackage", () => {
  it("seals a package whose every required item is present and verified", () => {
    const p = build(COMPLETE);
    expect(p.verdict).toBe("sealable");
    expect(p.gaps).toHaveLength(0);
    expect(p.items).toHaveLength(5);
    expect(p.items.every(i => i.state === "present_verified")).toBe(true);
    expect(p.status).toBe("current");
    expect(mayReleaseWithoutAcknowledgement(p)).toBe(true);
  });

  it("assembles nothing from an open trip and says that is why", () => {
    const p = build(COMPLETE, null);
    expect(p.verdict).toBe("unresolved");
    expect(p.items).toHaveLength(0);
    expect(p.gaps[0]).toContain("has not completed");
    expect(mayReleaseWithoutAcknowledgement(p)).toBe(false);
  });

  it("blocks on a missing required item and names the action", () => {
    const p = build(COMPLETE.map(i => (i.kind === "manifest" ? { ...i, reference: null } : i)));
    expect(p.verdict).toBe("incomplete");
    const manifest = p.items.find(i => i.kind === "manifest");
    expect(manifest?.state).toBe("missing");
    expect(manifest?.blocks).toContain("obtain the manifest");
    expect(mayReleaseWithoutAcknowledgement(p)).toBe(false);
  });

  it("blocks on a present-but-unverified item exactly as on a missing one", () => {
    const p = build(COMPLETE.map(i => (i.kind === "disposal_ticket" ? { ...i, verified: false } : i)));
    expect(p.verdict).toBe("incomplete");
    const ticket = p.items.find(i => i.kind === "disposal_ticket");
    expect(ticket?.state).toBe("present_unverified");
    expect(ticket?.blocks).toContain("verify disposal ticket");
  });

  it("excludes a genuinely inapplicable item without blocking", () => {
    const p = build([...COMPLETE, item("weight_record", { applicability: "not_applicable", reference: null })]);
    expect(p.verdict).toBe("sealable");
    expect(p.items.find(i => i.kind === "weight_record")?.state).toBe("not_applicable");
    expect(p.gaps).toHaveLength(0);
  });

  it("ranks an unanswered applicability question above a missing document", () => {
    // Both wrong at once: the verdict must be the one that says nobody decided,
    // not the one that says something is merely absent.
    const p = build([
      ...COMPLETE.map(i => (i.kind === "manifest" ? { ...i, reference: null } : i)),
      item("weight_record", { applicability: "unknown", reference: null }),
    ]);
    expect(p.verdict).toBe("unresolved");
    const weight = p.items.find(i => i.kind === "weight_record");
    expect(weight?.state).toBe("applicability_unresolved");
    expect(weight?.blocks).toContain("decide whether weight record is required");
  });

  it("carries the applicability basis through so a reader can check the call", () => {
    const p = build([item("route_approval", { applicabilityBasis: "oversize load on a restricted route" })]);
    expect(p.items[0].applicabilityBasis).toBe("oversize load on a restricted route");
  });

  it("hashes inputs independently of the order they arrive in", () => {
    expect(hashInputs(COMPLETE)).toBe(hashInputs([...COMPLETE].reverse()));
  });

  it("changes the hash when any input field moves", () => {
    const base = hashInputs(COMPLETE);
    expect(hashInputs(COMPLETE.map(i => (i.kind === "manifest" ? { ...i, verified: false } : i)))).not.toBe(base);
    expect(hashInputs(COMPLETE.map(i => (i.kind === "manifest" ? { ...i, reference: "M-9" } : i)))).not.toBe(base);
    expect(hashInputs(COMPLETE.map(i => (i.kind === "manifest" ? { ...i, updatedAt: COMPLETED } : i)))).not.toBe(base);
  });
});

describe("detectStaleness", () => {
  const sealed = build(COMPLETE);

  it("leaves an unchanged package alone", () => {
    const checked = detectStaleness(sealed, COMPLETE);
    expect(checked.status).toBe("current");
    expect(checked.staleReasons).toHaveLength(0);
    expect(checked).toBe(sealed);
  });

  it("marks the package stale without rebuilding it", () => {
    const checked = detectStaleness(sealed, COMPLETE.map(i => (i.kind === "manifest" ? { ...i, verified: false } : i)));
    expect(checked.status).toBe("stale");
    // The verdict and the hash are the ones it was built with. A rebuilt package
    // would be a new artifact, and producing one is a person's decision.
    expect(checked.verdict).toBe("sealable");
    expect(checked.inputsHash).toBe(sealed.inputsHash);
    expect(checked.builtAt).toEqual(BUILT_AT);
  });

  it("a stale package may not be released without acknowledgement", () => {
    const checked = detectStaleness(sealed, COMPLETE.map(i => (i.kind === "manifest" ? { ...i, verified: false } : i)));
    expect(mayReleaseWithoutAcknowledgement(checked)).toBe(false);
  });

  it("names a withdrawn verification, a changed reference and a changed applicability", () => {
    const checked = detectStaleness(sealed, [
      { ...item("manifest"), verified: false },
      { ...item("load_ticket"), reference: "LOAD_TICKET-2" },
      { ...item("disposal_ticket"), applicability: "unknown" },
      item("duty_record"),
      item("pre_trip_inspection"),
    ]);
    expect(checked.staleReasons).toContain("Manifest manifest:1 verification changed (verified → unverified)");
    expect(checked.staleReasons).toContain("Load ticket load_ticket:1 reference changed (LOAD_TICKET-1 → LOAD_TICKET-2)");
    expect(checked.staleReasons).toContain("Disposal ticket disposal_ticket:1 applicability changed (required → unknown)");
  });

  it("names an item that appeared after the package was built", () => {
    const checked = detectStaleness(sealed, [...COMPLETE, item("weight_record")]);
    expect(checked.staleReasons).toContain("Weight record weight_record:1 was added after this package was built");
  });

  it("names an item that has gone from the inputs", () => {
    const checked = detectStaleness(sealed, COMPLETE.filter(i => i.kind !== "duty_record"));
    expect(checked.staleReasons).toContain("Duty record duty_record:1 is no longer present among the inputs");
  });

  it("still reports staleness when only a timestamp moved", () => {
    const checked = detectStaleness(sealed, COMPLETE.map(i => ({ ...i, updatedAt: COMPLETED })));
    expect(checked.status).toBe("stale");
    expect(checked.staleReasons).toEqual(["the package inputs changed after it was built"]);
  });

  /*
   * The case the previous `detectStaleness` got wrong: two items of one kind.
   * Keyed on `itemRef`, each ticket is compared against its own prior row, so
   * the only reported change is the one that happened and it names which ticket.
   */
  it("tracks two items of one kind separately and names which one moved", () => {
    const two = [
      item("disposal_ticket", { itemRef: "disposal_ticket:stop-2", reference: "D-1" }),
      item("disposal_ticket", { itemRef: "disposal_ticket:stop-4", reference: "D-2" }),
      item("manifest"),
    ];
    const pkg = build(two);
    expect(pkg.verdict).toBe("sealable");
    expect(pkg.items).toHaveLength(3);

    // Only the first ticket's verification is withdrawn. Nothing else moves.
    const checked = detectStaleness(pkg, [
      item("disposal_ticket", { itemRef: "disposal_ticket:stop-2", reference: "D-1", verified: false }),
      item("disposal_ticket", { itemRef: "disposal_ticket:stop-4", reference: "D-2" }),
      item("manifest"),
    ]);

    expect(checked.staleReasons).toEqual([
      "Disposal ticket disposal_ticket:stop-2 verification changed (verified → unverified)",
    ]);
  });

  it("hashes the same two same-kind items alike whatever order they arrive in", () => {
    // `canonical` sorted by kind, which is not a total order when kinds repeat:
    // a stable sort then left the input order in the hash, and the package
    // reported staleness on a set that had not changed.
    const a = [item("disposal_ticket", { itemRef: "d:1", reference: "D-1" }), item("disposal_ticket", { itemRef: "d:2", reference: "D-2" })];
    expect(hashInputs(a)).toBe(hashInputs([...a].reverse()));

    const pkg = build(a);
    expect(detectStaleness(pkg, [...a].reverse()).status).toBe("current");
  });
});

describe("duplicate slot identities", () => {
  it("refuses to assemble rather than collapsing them", () => {
    const clash = [
      item("disposal_ticket", { itemRef: "disposal_ticket:stop-2", reference: "D-1" }),
      item("disposal_ticket", { itemRef: "disposal_ticket:stop-2", reference: "D-2" }),
      item("manifest"),
    ];
    const p = build(clash);
    expect(p.verdict).toBe("unresolved");
    expect(p.items).toHaveLength(0);
    expect(p.gaps).toEqual([
      "two or more inputs share the slot identity disposal_ticket:stop-2 — give each artifact its own itemRef before assembling",
    ]);
    expect(mayReleaseWithoutAcknowledgement(p)).toBe(false);
  });

  it("names every clashing identity, not just the first", () => {
    const p = build([
      item("load_ticket", { itemRef: "a" }), item("load_ticket", { itemRef: "a" }),
      item("disposal_ticket", { itemRef: "b" }), item("disposal_ticket", { itemRef: "b" }),
    ]);
    expect(p.gaps).toHaveLength(2);
    expect(p.gaps[0]).toContain("identity a");
    expect(p.gaps[1]).toContain("identity b");
  });

  // An open trip is a legitimate recurring state; a duplicate itemRef is a fault
  // in the caller. The transient condition must not mask the permanent one —
  // least of all here, where the trip is open for its whole duration and the
  // clash would surface only at closeout.
  it("is refused before the open-trip check, so a clash is never hidden by one", () => {
    const p = build([item("manifest", { itemRef: "x" }), item("load_ticket", { itemRef: "x" })], null);
    expect(p.gaps[0]).toContain("slot identity x");
  });
});
