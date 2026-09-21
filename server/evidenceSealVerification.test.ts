/**
 * P1.2 — the seal's third leg.
 *
 * A seal used to record what the *device* said and nothing checked it. The device hash is a real
 * control: it catches tampering after capture, because an edit produces different bytes. What it
 * cannot catch is anything between the device computing it and the server storing it — a truncated
 * upload, a swapped key, a restore that put the wrong file back. In every one of those the seal
 * still reads "sealed" and still carries a hash, and the hash is right about a file nobody has.
 *
 * The cases below are that list, plus the one that matters most: a check that could not run must
 * never read as a check that passed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealIsTrustworthy, verifySealAgainstStored } from "./_core/evidenceSeal";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const AT = new Date("2026-09-18T16:30:00Z");
const MANIFEST = '{"capturedAt":"2026-09-18T14:02:00Z","operator":"OP-19","unit":"VAC-27"}';

const verify = (o: Partial<Parameters<typeof verifySealAgainstStored>[0]> = {}) =>
  verifySealAgainstStored({
    deviceContentHash: sha("photo-bytes"),
    storedContentHash: sha("photo-bytes"),
    recordedManifestHash: sha(MANIFEST),
    canonicalManifest: MANIFEST,
    hashOfManifest: sha,
    checkedAt: AT,
    ...o,
  });

describe("all three legs must agree", () => {
  it("passes when the device hash, the stored bytes and the manifest all agree", () => {
    const v = verify();
    expect(v.result).toBe("verified");
    expect(sealIsTrustworthy(v)).toBe(true);
  });

  it("catches bytes that are not the bytes the device sealed", () => {
    // A truncated upload, a swapped storage key, a restore that put the wrong file back.
    const v = verify({ storedContentHash: sha("different-bytes") });
    expect(v.result).toBe("hash_mismatch");
    expect(sealIsTrustworthy(v)).toBe(false);
    if (v.result !== "hash_mismatch") throw new Error("unreachable");
    expect(v.note).toMatch(/the stored object is not the object it describes/);
    expect(v.deviceContentHash).not.toBe(v.storedContentHash);   // both recorded, so it is arguable
  });

  it("catches a manifest edited after sealing even when the bytes are untouched", () => {
    // The quiet one: change the capture time or the operator and the photo still matches.
    const v = verify({ canonicalManifest: MANIFEST.replace("OP-19", "OP-20") });
    expect(v.result).toBe("manifest_mismatch");
    expect(sealIsTrustworthy(v)).toBe(false);
    if (v.result !== "manifest_mismatch") throw new Error("unreachable");
    expect(v.note).toMatch(/circumstances of the capture have changed/);
    expect(v.recomputedManifestHash).not.toBe(v.recordedManifestHash);
  });

  it("checks the manifest before the bytes, so a tampered manifest is named even if the object is gone", () => {
    const v = verify({ canonicalManifest: MANIFEST.replace("VAC-27", "VAC-99"), storedContentHash: null });
    expect(v.result).toBe("manifest_mismatch");   // the finding it can make, rather than the one it cannot
  });

  it("reports an unreadable object as unverifiable, and never as a pass", () => {
    const v = verify({ storedContentHash: null });
    expect(v.result).toBe("content_unavailable");
    expect(sealIsTrustworthy(v)).toBe(false);
    if (v.result !== "content_unavailable") throw new Error("unreachable");
    expect(v.note).toMatch(/it is a verification that did not happen/);
  });

  it("treats only 'verified' as trustworthy, so no caller has to remember the list", () => {
    for (const r of ["hash_mismatch", "manifest_mismatch", "content_unavailable"] as const) {
      expect(sealIsTrustworthy({ result: r, checkedAt: AT, note: "" } as never), r).toBe(false);
    }
  });

  it("records when it checked, so a stale verification can be told from a fresh one", () => {
    // A seal verified once in 2026 and never since is not a seal verified today, and a result with
    // no time on it cannot say which it is.
    expect(verify().checkedAt).toBe(AT);
  });
});
