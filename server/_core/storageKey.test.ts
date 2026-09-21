/**
 * A storage key is a path of ordinary names.
 *
 * `normalizeKey` used to strip leading slashes and nothing else, while
 * `server/storage.ts`'s own header asserted the invariant it did not enforce —
 * "The key is what gets persisted" — and six procedures accepted a key from the
 * client as a bare `z.string().max(512)`. The sibling `storageUrl` field on three
 * of those same objects already refused a retired path prefix, so the omission was
 * inconsistent within one input object.
 *
 * The second group of cases is the one that matters most and is easiest to get
 * wrong: `.` is a legal character, because real keys carry file extensions, so a
 * character allowlist ALONE admits `..` happily. A first draft of this predicate
 * did exactly that and passed its own review; the traversal case below is what
 * caught it.
 *
 * The last group pins the other direction. A validator that rejects the keys the
 * server itself mints is worse than none, because it fails at upload time on
 * legitimate work.
 */
import { describe, expect, it } from "vitest";
import { isValidStorageKey, MAX_STORAGE_KEY_LENGTH } from "./storageKey";

describe("ordinary keys are accepted", () => {
  it("accepts a nested path of ordinary names", () => {
    expect(isValidStorageKey("7/evidence/1712000000000-scan.pdf")).toBe(true);
  });

  it("accepts a leading slash, which is stripped rather than refused", () => {
    expect(isValidStorageKey("/tickets/FT-1/R1-abcdef012345.pdf")).toBe(true);
  });
});

describe("traversal is refused", () => {
  it("refuses a parent segment", () => {
    expect(isValidStorageKey("../../audit/PKG-0001/cover.pdf")).toBe(false);
    expect(isValidStorageKey("a/../b")).toBe(false);
    expect(isValidStorageKey("..")).toBe(false);
  });

  it("refuses a current-directory segment", () => {
    expect(isValidStorageKey("a/./b")).toBe(false);
  });

  it("refuses an encoded parent segment, via the character allowlist", () => {
    // %2e%2e never reaches the name comparison — it fails on '%'.
    expect(isValidStorageKey("a/%2e%2e/c")).toBe(false);
  });

  it("refuses an empty segment, which some resolvers collapse", () => {
    expect(isValidStorageKey("a//b")).toBe(false);
  });

  it("refuses the empty key", () => {
    expect(isValidStorageKey("")).toBe(false);
    expect(isValidStorageKey("///")).toBe(false);
  });

  it("refuses characters outside the allowlist", () => {
    for (const key of ["a b/c.pdf", "a/c:d.pdf", "a/\\\\b", "a/?q=1", "a/#frag", "a/~root"]) {
      expect(isValidStorageKey(key), `${key} should be refused`).toBe(false);
    }
  });

  it("refuses a key past the length limit", () => {
    expect(isValidStorageKey("a".repeat(MAX_STORAGE_KEY_LENGTH + 1))).toBe(false);
  });
});

describe("every key shape the server itself mints is accepted", () => {
  // Taken from the storagePut call sites, so a tightening here cannot break a
  // legitimate upload without failing this first.
  const minted = [
    "audit/PKG-0001/cover.pdf",
    "invoices/INV-2026-0001/a1b2c3d4e5f6.pdf",
    "tickets/FT-0001/R2-a1b2c3d4e5f6.pdf",
    "tickets/FT-0001/package-a1b2c3d4e5f6.pdf",
    "generated/1712000000000.png",
    "7/evidence/1712000000000-Scale_ticket-1.pdf",
  ];
  for (const key of minted) {
    it(`accepts ${key}`, () => {
      expect(isValidStorageKey(key)).toBe(true);
    });
  }

  it("accepts the hash suffix storagePut appends", () => {
    // appendHashSuffix inserts _<8 hex> before the extension.
    expect(isValidStorageKey("audit/PKG-0001/cover_a1b2c3d4.pdf")).toBe(true);
  });
});
