/**
 * The chain rule: do a stop's receipts still describe it?
 *
 * `evidenceFromReceipts` decides that without a database, so every way the chain breaks is proven
 * here: an edit after the newest commit, a row that recorded no write, a write that predates a
 * commit, a broken seal, an unreadable manifest. The cases are the sibling repository's, unchanged.
 *
 * What the sibling proves against a database — that the reader finds the receipts of the stop it
 * was asked about, of that stop only, inside the caller's organization only — cannot be proven
 * here: this repository has no reader, because `tripStops` carries no `updatedAt` or
 * `updatedByUserId` (see the module header). The last block below pins what that means: with the
 * only row provenance this repository can supply, every stop is `no_write_recorded` and every
 * phase `unknown`, so nothing here can be mistaken for a working reader.
 *
 * Each breaking case is written so that failing OPEN would be visible: the receipts it refuses
 * would otherwise have produced `confirmed`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundaryConfirmations } from "./_core/boundaryConfirmation";
import { evidenceFromReceipts, type StopReceipt } from "./_core/boundaryEvidence";
import { phaseConfirmation } from "./_core/siteBaseline";

const at = (iso: string) => new Date(iso);
const T1 = at("2026-09-20T10:00:00Z");
const T2 = at("2026-09-20T11:00:00Z");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

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

/** The user whose commit wrote a receipt, and so the row's last writer when nothing else wrote it. */
const ACTOR = 7;
const OTHER = 8;

const receipt = (json: string, committedAt: Date, hash = sha(json), actorUserId = ACTOR): StopReceipt => ({
  fieldManifest: json,
  fieldManifestHash: hash,
  committedAt,
  actorUserId,
});

/** A stop whose last recorded write was at `at`, by `by`. */
const written = (at: Date | null, by: number | null = at ? ACTOR : null) => ({ updatedAt: at, updatedByUserId: by });

const ALL_REACHABLE_CONFIRMED = manifest([
  { key: "arrivedAt", status: "confirmed" },
  { key: "operationStartedAt", status: "confirmed" },
  { key: "operationCompletedAt", status: "corrected", source: "human_corrected" },
  { key: "departedAt", status: "confirmed" },
]);

describe("the chain rule: do a stop's receipts still describe it?", () => {
  it("reads an untouched stop whose last write is its newest commit", () => {
    const out = evidenceFromReceipts(written(T1), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(out.chain).toBe("intact");
    expect(boundaryConfirmations(out.evidence)).toEqual({
      arrivedAt: "confirmed",
      setupStartedAt: "unknown",
      operationStartedAt: "confirmed",
      operationCompletedAt: "confirmed",
      departedAt: "confirmed",
    });
  });

  it("has nothing to say about a stop with no receipts", () => {
    expect(evidenceFromReceipts(written(T1), [])).toEqual({ evidence: [], chain: "no_receipts" });
  });

  it("refuses every receipt once the row was written after its newest commit", () => {
    // A direct `tripStops.update` records which row it touched, never which field.
    const out = evidenceFromReceipts(written(T2), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(out).toEqual({ evidence: [], chain: "edited_after_commit" });
  });

  it("refuses a row that recorded no write at all — pre-0169, an edit cannot be ruled out", () => {
    const out = evidenceFromReceipts(written(null), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(out).toEqual({ evidence: [], chain: "no_write_recorded" });
  });

  it("refuses a row whose last write predates a commit that wrote it", () => {
    const out = evidenceFromReceipts(written(T1), [receipt(ALL_REACHABLE_CONFIRMED, T2)]);
    expect(out).toEqual({ evidence: [], chain: "write_predates_commit" });
  });

  it("compares against the NEWEST receipt, not the first one it was handed", () => {
    const older = receipt(manifest([{ key: "arrivedAt", status: "proposed" }]), T1);
    const newer = receipt(ALL_REACHABLE_CONFIRMED, T2);
    expect(evidenceFromReceipts(written(T2), [older, newer]).chain).toBe("intact");
    expect(evidenceFromReceipts(written(T2), [newer, older]).chain).toBe("intact");
    expect(evidenceFromReceipts(written(T1), [older, newer]).chain).toBe("write_predates_commit");
  });

  it("refuses the whole chain when any manifest no longer matches its seal", () => {
    // Dropping only the altered receipt is not enough: if it was the newest, the
    // older one would speak for values the altered commit wrote.
    const older = receipt(ALL_REACHABLE_CONFIRMED, T1);
    const tampered = receipt(ALL_REACHABLE_CONFIRMED, T2, sha("something else"));
    expect(evidenceFromReceipts(written(T2), [older, tampered])).toEqual({
      evidence: [],
      chain: "seal_mismatch",
    });
  });

  it("refuses the whole chain when a correctly sealed manifest cannot be read", () => {
    const older = receipt(ALL_REACHABLE_CONFIRMED, T1);
    const garbage = receipt("not json", T2); // sealed over its own garbage
    expect(evidenceFromReceipts(written(T2), [older, garbage]).chain).toBe("unreadable_manifest");
  });

  it("refuses a manifest with one unreadable entry among readable ones", () => {
    const json = JSON.stringify([
      { key: "arrivedAt", source: "driver_voice", status: "confirmed" },
      { key: "departedAt", source: "driver_voice", status: "approved" },
    ]);
    expect(evidenceFromReceipts(written(T1), [receipt(json, T1)]).chain).toBe("unreadable_manifest");
  });

  it("refuses a receipt whose commit instant is not a real date", () => {
    const bad = receipt(ALL_REACHABLE_CONFIRMED, new Date(Number.NaN));
    expect(evidenceFromReceipts(written(T1), [bad]).chain).toBe("unreadable_manifest");
  });

  it("takes each boundary's word from the newest commit", () => {
    const first = receipt(manifest([
      { key: "arrivedAt", status: "confirmed" },
      { key: "operationStartedAt", status: "proposed" },
    ]), T1);
    const later = receipt(manifest([
      { key: "arrivedAt", status: "proposed" },
      { key: "operationStartedAt", status: "corrected", source: "human_corrected" },
    ]), T2);
    const out = boundaryConfirmations(evidenceFromReceipts(written(T2), [later, first]).evidence);
    expect(out.arrivedAt).toBe("unconfirmed");
    expect(out.operationStartedAt).toBe("confirmed");
  });
});

describe("only the newest commit speaks", () => {
  /*
   * The review finding this block exists for. A direct edit BETWEEN two commits is
   * invisible afterwards: the second commit re-stamps updatedAt, erasing the edit's
   * trace. Every boundary the newest commit wrote is exact — it wrote them, and nothing
   * wrote the row after. A boundary it did not write may hold an older commit's value or
   * a hand-typed one, and no older receipt can prove which.
   */
  it("does not let an older receipt vouch for a boundary the newest commit did not write", () => {
    const older = receipt(ALL_REACHABLE_CONFIRMED, T1); // departedAt confirmed
    const newer = receipt(manifest([
      { key: "arrivedAt", status: "confirmed" },
      { key: "operationStartedAt", status: "confirmed" },
      { key: "operationCompletedAt", status: "confirmed" },
    ]), T2); // departedAt left out — it is optional, and an omitted field is not written
    const out = evidenceFromReceipts(written(T2), [older, newer]);
    expect(out.chain).toBe("intact");
    const v = boundaryConfirmations(out.evidence);
    expect(v.departedAt).toBe("unknown");
    expect(v.arrivedAt).toBe("confirmed");
  });

  it("lets every receipt committed at the newest instant speak", () => {
    // Two commits in the same second. Neither can be ordered before the other, and no
    // direct write came after either, so both describe what they wrote.
    const a = receipt(manifest([{ key: "arrivedAt", status: "confirmed" }]), T2, undefined, ACTOR);
    const b = receipt(manifest([{ key: "departedAt", status: "confirmed" }]), T2, undefined, OTHER);
    const out = evidenceFromReceipts(written(T2, OTHER), [a, b]);
    expect(out.chain).toBe("intact");
    const v = boundaryConfirmations(out.evidence);
    expect(v.arrivedAt).toBe("confirmed");
    expect(v.departedAt).toBe("confirmed");
  });
});

describe("the row's last writer must be the newest commit's actor", () => {
  /*
   * updatedAt and committedAt are second-precision. A hand edit landing in the same
   * second as a commit truncates to the same stamp. The commit writes updatedByUserId =
   * its actor, and tripStops.update writes the editor, so a different last writer shows.
   */
  it("refuses the chain when someone else wrote the row in the commit's second", () => {
    const out = evidenceFromReceipts(written(T1, OTHER), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(out).toEqual({ evidence: [], chain: "written_by_another_actor" });
  });

  it("refuses a row that recorded a write but not its writer", () => {
    const out = evidenceFromReceipts(written(T1, null), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(out).toEqual({ evidence: [], chain: "written_by_another_actor" });
  });
});

describe("a damaged receipt anywhere in the history refuses the whole chain", () => {
  /*
   * Only the newest commit speaks, but an altered or unreadable receipt at any depth is
   * still a history nobody can vouch for. Each case keeps the newest receipt intact and
   * confirming, so a check that only looked at the newest would answer "confirmed".
   */
  it("refuses a tampered receipt that is not the newest", () => {
    const tampered = receipt(ALL_REACHABLE_CONFIRMED, T1, sha("what was sealed"));
    const newest = receipt(ALL_REACHABLE_CONFIRMED, T2);
    expect(evidenceFromReceipts(written(T2), [tampered, newest])).toEqual({ evidence: [], chain: "seal_mismatch" });
  });

  it("refuses an unreadable receipt that is not the newest", () => {
    const garbled = receipt("not json", T1);
    const newest = receipt(ALL_REACHABLE_CONFIRMED, T2);
    expect(evidenceFromReceipts(written(T2), [newest, garbled]).chain).toBe("unreadable_manifest");
  });
});

describe("what siteBaseline receives", () => {
  it("gets operation and total confirmed, and setup and wait unknown however much is confirmed", () => {
    const out = evidenceFromReceipts(written(T1), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(phaseConfirmation(boundaryConfirmations(out.evidence))).toEqual({
      setup: "unknown",
      operation: "confirmed",
      wait: "unknown",
      total: "confirmed",
    });
  });

  it("gets every phase unknown from a broken chain, never unconfirmed", () => {
    const out = evidenceFromReceipts(written(T2), [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(phaseConfirmation(boundaryConfirmations(out.evidence))).toEqual({
      setup: "unknown",
      operation: "unknown",
      wait: "unknown",
      total: "unknown",
    });
  });
});

describe("what this repository can actually supply", () => {
  /*
   * `tripStops` here has no `updatedAt` and no `updatedByUserId`. A reader could only ever pass
   * `{ updatedAt: null, updatedByUserId: null }`, and the rule must answer that by refusing —
   * whatever the receipts say, however well sealed, however recently committed.
   */
  const NO_PROVENANCE = { updatedAt: null, updatedByUserId: null };

  it("refuses a perfectly sealed, fully confirmed receipt when the row records no write", () => {
    const out = evidenceFromReceipts(NO_PROVENANCE, [receipt(ALL_REACHABLE_CONFIRMED, T1)]);
    expect(out).toEqual({ evidence: [], chain: "no_write_recorded" });
    expect(phaseConfirmation(boundaryConfirmations(out.evidence))).toEqual({
      setup: "unknown",
      operation: "unknown",
      wait: "unknown",
      total: "unknown",
    });
  });

  it("refuses it in every order and with any number of receipts", () => {
    const a = receipt(manifest([{ key: "arrivedAt", status: "confirmed" }]), T1);
    const b = receipt(ALL_REACHABLE_CONFIRMED, T2);
    expect(evidenceFromReceipts(NO_PROVENANCE, [a, b]).chain).toBe("no_write_recorded");
    expect(evidenceFromReceipts(NO_PROVENANCE, [b, a]).chain).toBe("no_write_recorded");
  });

  it("cannot be made to speak for setupStartedAt even through an intact chain", () => {
    // Manufactured evidence for the unreachable boundary, on a row whose provenance is
    // complete: the resolver still refuses it, so no reader can elevate it later.
    const forged = receipt(manifest([{ key: "setupStartedAt", status: "confirmed" }]), T1);
    const out = evidenceFromReceipts(written(T1), [forged]);
    expect(out.chain).toBe("intact");
    expect(boundaryConfirmations(out.evidence).setupStartedAt).toBe("unknown");
  });
});
