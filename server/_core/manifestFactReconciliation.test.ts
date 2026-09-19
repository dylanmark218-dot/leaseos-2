/**
 * P3.1 — the manifest prints a word and holds a reference for the same fact.
 *
 * Found by auditing the row against its original definition, which ends "by reference". Both were
 * live, both fed the custody state, and nothing said which was true.
 */
import { describe, expect, it } from "vitest";
import { reconcileManifestFacts, type FactPair } from "./manifestFactReconciliation";

const pair = (o: Partial<FactPair> = {}): FactPair =>
  ({ key: "driver", printed: "J. Cardinal", resolved: "J. Cardinal", referenceId: 7, ...o });

describe("before sealing, the reference is authoritative", () => {
  it("passes when the printed word matches the record", () => {
    const v = reconcileManifestFacts([pair()], { sealed: false });
    expect(v.blocking).toEqual([]);
    expect(v.explanation).toMatch(/every printed fact agrees with the record behind it/);
  });

  it("tolerates spacing and case, which are not a different person", () => {
    expect(reconcileManifestFacts([pair({ printed: "j.  CARDINAL " })], { sealed: false }).blocking).toEqual([]);
  });

  it("blocks when the manifest prints someone else, naming both", () => {
    // A manifest whose printed driver is not the operator on the record is a document that will be
    // questioned the first time anybody compares them.
    const v = reconcileManifestFacts([pair({ resolved: "M. Whitford" })], { sealed: false });
    expect(v.blocking.map(f => f.kind)).toEqual(["differs"]);
    expect(v.blocking[0]!.detail).toMatch(/prints "J\. Cardinal" but reference #7 resolves to "M\. Whitford"/);
    expect(v.explanation).toMatch(/the cheapest moment is now/);
  });

  it("blocks a printed name with nothing behind it", () => {
    const v = reconcileManifestFacts([pair({ resolved: null, referenceId: null })], { sealed: false });
    expect(v.blocking[0]!.kind).toBe("printed_without_reference");
    expect(v.blocking[0]!.detail).toMatch(/nothing can confirm who or what that was/);
  });

  it("notes a record with nothing printed without blocking on it", () => {
    // The document is short a field, which is worth saying; it is not a contradiction.
    const v = reconcileManifestFacts([pair({ printed: null })], { sealed: false });
    expect(v.blocking).toEqual([]);
    expect(v.findings[0]!.detail).toMatch(/the manifest prints nothing, so the document is short a field/);
  });

  it("checks every fact, not just the first that fails", () => {
    const v = reconcileManifestFacts([
      pair({ key: "driver", resolved: "M. Whitford" }),
      pair({ key: "trailer", printed: "T-4412", resolved: "T-4412", referenceId: 22 }),
      pair({ key: "facility", printed: "West Ridge", resolved: "Westridge Disposal", referenceId: 9 }),
    ], { sealed: false });
    expect(v.blocking.map(f => f.key)).toEqual(["driver", "facility"]);
  });
});

describe("after sealing, the printed text is what was presented", () => {
  it("does not block on a divergence, and says why", () => {
    // A name corrected or a trailer renumbered afterwards does not retroactively make the sealed
    // page wrong. It is the document being a document.
    const v = reconcileManifestFacts([pair({ resolved: "J. Cardinale" })], { sealed: true });
    expect(v.blocking).toEqual([]);
    expect(v.findings[0]!.kind).toBe("differs");
    expect(v.explanation).toMatch(/stands as what was presented; the records have since moved/);
    expect(v.explanation).toMatch(/This is history, not an error to repair/);
  });

  it("still says plainly when nothing has moved", () => {
    expect(reconcileManifestFacts([pair()], { sealed: true }).explanation)
      .toMatch(/Sealed, and the printed text still matches the records it was drawn from/);
  });

  it("keeps the finding visible even though it is not blocking", () => {
    // Not blocking is not the same as not worth knowing: somebody comparing the sealed page to the
    // live record needs to be told the difference is expected.
    const v = reconcileManifestFacts([pair({ resolved: "J. Cardinale" })], { sealed: true });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.detail).toMatch(/reference #7 resolves to "J\. Cardinale"/);
  });
});
