/**
 * S1-A — the arithmetic a session family is made of, before any of it is wired.
 *
 * The one-year bearer session this replaces had three properties worth naming, because each is a
 * separate defect and each needs its own rule here:
 *
 *   it never expired in any useful sense, so a token copied out of a browser stayed good for a year;
 *   it was verified statelessly, so nothing could revoke it;
 *   and it was the *only* credential, so shortening it would have logged everyone out constantly.
 *
 * A family fixes the second and third: a short access credential nobody bothers to steal, and a
 * long-lived refresh that is server-tracked, rotates on every use, and can be killed. This file is
 * the pure half — no database, no request, no cookie. It exists first so the rules that decide
 * whether a stolen refresh token still works are settled before there is any I/O to hide them in.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_ABSOLUTE_TTL_MS,
  absoluteExpiryFrom,
  assessRefresh,
  hashVerifier,
  newVerifier,
  rotated,
  type FamilyState,
} from "./sessionFamily";

const T0 = new Date("2026-09-24T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const family = (o: Partial<FamilyState> = {}): FamilyState => ({
  refreshVerifierHash: hashVerifier("verifier-one"),
  rotationCounter: 0,
  createdAt: T0,
  absoluteExpiresAt: absoluteExpiryFrom(T0),
  revokedAt: null,
  ...o,
});

/* ── A1. the stored material is not the credential ──────────────────────────── */

describe("A1 — a database leak alone yields nothing usable", () => {
  it("stores a hash that is not the verifier", () => {
    const v = newVerifier();
    const h = hashVerifier(v);
    expect(h).not.toBe(v);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // The verifier must not be recoverable from, or even present in, what is stored.
    expect(h.includes(v)).toBe(false);
  });

  it("issues a different verifier every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newVerifier()));
    expect(seen.size).toBe(50);
  });

  it("issues a verifier with enough entropy to be worth hashing", () => {
    // 32 random bytes, base64url — the same shape the portal's bearer tokens already use.
    expect(newVerifier().length).toBeGreaterThanOrEqual(42);
  });
});

/* ── A2. verification ───────────────────────────────────────────────────────── */

describe("A2 — the presented verifier is checked against the hash", () => {
  it("accepts the verifier it was derived from", () => {
    const v = newVerifier();
    expect(assessRefresh(family({ refreshVerifierHash: hashVerifier(v) }), v, T0).kind).toBe("ok");
  });

  it("refuses a verifier that does not match", () => {
    expect(assessRefresh(family(), "not-the-verifier", T0).kind).toBe("reuse_detected");
  });

  it("refuses an empty presented verifier rather than treating it as a match", () => {
    expect(assessRefresh(family(), "", T0).kind).toBe("reuse_detected");
  });
});

/* ── A3. absolute expiry ────────────────────────────────────────────────────── */

describe("A3 — the absolute lifetime is measured from creation", () => {
  it("is exactly the configured window after createdAt", () => {
    expect(absoluteExpiryFrom(T0).getTime()).toBe(T0.getTime() + REFRESH_ABSOLUTE_TTL_MS);
  });

  it("is 30 days, and the access credential is 15 minutes", () => {
    expect(REFRESH_ABSOLUTE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("refuses a refresh past the absolute expiry even with the right verifier", () => {
    const v = newVerifier();
    const f = family({ refreshVerifierHash: hashVerifier(v) });
    expect(assessRefresh(f, v, at(REFRESH_ABSOLUTE_TTL_MS + 1)).kind).toBe("expired");
  });

  it("still accepts one moment before the absolute expiry", () => {
    const v = newVerifier();
    const f = family({ refreshVerifierHash: hashVerifier(v) });
    expect(assessRefresh(f, v, at(REFRESH_ABSOLUTE_TTL_MS - 1)).kind).toBe("ok");
  });
});

/* ── A4. rotation ───────────────────────────────────────────────────────────── */

describe("A4 — every refresh rotates the credential", () => {
  it("produces a new verifier and a new hash", () => {
    const f = family();
    const next = rotated(f, T0);
    expect(next.verifier).not.toBe("verifier-one");
    expect(next.refreshVerifierHash).not.toBe(f.refreshVerifierHash);
    expect(next.refreshVerifierHash).toBe(hashVerifier(next.verifier));
  });

  it("increments the rotation counter", () => {
    expect(rotated(family({ rotationCounter: 4 }), T0).rotationCounter).toBe(5);
  });
});

/* ── A5. revocation ─────────────────────────────────────────────────────────── */

describe("A5 — a revoked family is finished", () => {
  it("refuses a refresh even with the correct current verifier", () => {
    const v = newVerifier();
    const f = family({ refreshVerifierHash: hashVerifier(v), revokedAt: T0 });
    expect(assessRefresh(f, v, at(60_000)).kind).toBe("revoked");
  });

  /*
   * Revocation is checked before the verifier, so a revoked family cannot be probed for whether a
   * guessed verifier was the right one.
   */
  it("reports revoked, not reuse, when a wrong verifier meets a revoked family", () => {
    const f = family({ revokedAt: T0 });
    expect(assessRefresh(f, "wrong", at(60_000)).kind).toBe("revoked");
  });
});

/* ── A6. the window cannot be widened ───────────────────────────────────────── */

describe("A6 — rotation renews the credential, never the lifetime", () => {
  /*
   * The whole point of an absolute lifetime is that a stolen family cannot be kept alive by using
   * it. If rotation moved the expiry, thirty days would mean "thirty days after you stop".
   */
  it("carries the original absolute expiry through a rotation", () => {
    const f = family();
    const next = rotated(f, at(10 * 86_400_000));
    expect(next.absoluteExpiresAt.getTime()).toBe(f.absoluteExpiresAt.getTime());
  });

  it("still expires on schedule after many rotations", () => {
    let f = family();
    for (let i = 0; i < 20; i++) {
      const n = rotated(f, at(i * 3_600_000));
      f = { ...f, refreshVerifierHash: n.refreshVerifierHash, rotationCounter: n.rotationCounter, absoluteExpiresAt: n.absoluteExpiresAt };
    }
    expect(assessRefresh(f, "anything", at(REFRESH_ABSOLUTE_TTL_MS + 1)).kind).toBe("expired");
  });
});
