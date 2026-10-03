/**
 * P3.6 — the numbers a person reads aloud come from the sequence, not from a timestamp.
 *
 * `ref()` mints `PREFIX-<time36>-<random>`: unique, and unreadable. Nobody calls in
 * "DLY-M6F2K1-A7QZ" over a radio, and nobody notices that the delay after DLY-000418 should have
 * been DLY-000419. For the artifacts a person handles — a field ticket, a disposal ticket, a daily
 * log, a credit — the number IS part of the record, so it comes from the row-locked counter.
 *
 * The distinction this guard keeps is the one worth keeping: **not every ref is one of those.** A
 * probe ref, a geo ref, an internal message id is machinery, and sweeping all 135 call sites onto a
 * DB round-trip would add a transaction to every one of them to make internal strings prettier.
 * So the canonical set is named, and only it is enforced.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The artifacts of project rule §18 — the ones written on paper, read over a radio, or quoted in a
 * dispute. Adding a prefix here is a decision that it has become one of those.
 */
const CANONICAL_PREFIXES = ["FT", "INV", "DLY", "SIG", "CR", "BB", "DSP", "WO", "ORG", "CN", "CON", "RSHT"] as const;   // v23.31: customer number, contract number, rate sheet number — read aloud, quoted on paper

const serverFiles = readdirSync("server").filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(f => `server/${f}`);

describe("canonical tracking numbers come from the sequence", () => {
  it("has no canonical prefix still minted by the ad-hoc generator", () => {
    const offenders: string[] = [];
    for (const f of serverFiles) {
      const src = readFileSync(f, "utf8");
      for (const p of CANONICAL_PREFIXES) {
        if (new RegExp(`\\bref\\("${p}"\\)`).test(src)) offenders.push(`${f} → ref("${p}")`);
      }
    }
    expect(offenders, "a number a person reads aloud is being minted from a timestamp").toEqual([]);
  });

  it("mints each of them through nextTrackingNumber somewhere", () => {
    const all = serverFiles.map(f => readFileSync(f, "utf8")).join("\n");
    // v23.32 — INV and CR are minted from the ORGANIZATION's series (billingNumbers.mintScopedNumber → numberSeries.mintNumberInTx):
    // the same row-locked counter, scoped per organization and written to the Document Control ledger.
    const missing = CANONICAL_PREFIXES.filter(p => !new RegExp(`sequenceType: "${p}"`).test(all) && !new RegExp(`mintScopedNumber\\([^)]*"${p}"`).test(all));
    expect(missing, "a canonical prefix nothing mints from the sequence").toEqual([]);
  });

  it("leaves the internal refs alone, and says why", () => {
    // If this ever reaches zero, someone has swept the lot. That is not the goal: it would put a
    // row-locked transaction in front of every internal identifier in the server.
    const all = serverFiles.map(f => readFileSync(f, "utf8")).join("\n");
    const internal = Array.from(new Set(Array.from(all.matchAll(/\bref\("([A-Z]{2,5})"\)/g)).map(m => m[1]!)));
    expect(internal.length, "every ref() has been swept, including the machinery").toBeGreaterThan(20);
    for (const p of CANONICAL_PREFIXES) expect(internal, `${p} should no longer be here`).not.toContain(p);
  });
});
