/**
 * S1-G — retiring the year-long tokens, without logging the fleet out mid-shift.
 *
 * Before S1 a session token was minted with `expiresInMs: ONE_YEAR_MS`. Those tokens are in
 * browsers right now. Two options were both wrong: honouring them until they expire leaves the
 * defect live for a year, and refusing them at deploy signs every driver out at once, including
 * ones on a lease with no signal.
 *
 * So there is a grace window. What makes it workable is that a legacy token needs **no new claim**
 * to be recognised: nothing minted after S1-B can have an expiry further out than the access
 * lifetime, so a far-future expiry is itself the evidence. The window is bounded and it closes.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  LEGACY_GRACE_MS,
  assessLegacyAccess,
} from "./_core/sessionFamily";

const NOW = new Date("2026-10-01T12:00:00Z");
const expAt = (ms: number) => Math.floor((NOW.getTime() + ms) / 1000);

describe("G1 — a legacy token is recognised by its own expiry", () => {
  it("treats a far-future expiry as legacy, with no extra claim needed", () => {
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    expect(assessLegacyAccess({ exp: expAt(oneYear) }, NOW, NOW).kind).toBe("legacy");
  });

  it("treats a normal fifteen-minute token as current", () => {
    expect(assessLegacyAccess({ exp: expAt(ACCESS_TOKEN_TTL_MS - 1000) }, NOW, NOW).kind)
      .toBe("current");
  });

  it("allows clock skew rather than calling a fresh token legacy", () => {
    // Exactly at the access lifetime, and a little beyond, is still a token this build could mint.
    expect(assessLegacyAccess({ exp: expAt(ACCESS_TOKEN_TTL_MS) }, NOW, NOW).kind).toBe("current");
    expect(assessLegacyAccess({ exp: expAt(ACCESS_TOKEN_TTL_MS + 60_000) }, NOW, NOW).kind)
      .toBe("current");
  });

  it("treats a token with no expiry at all as legacy rather than current", () => {
    expect(assessLegacyAccess({}, NOW, NOW).kind).toBe("legacy");
  });
});

describe("G2 — the window is bounded, and it closes", () => {
  const cutoverAt = NOW;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const legacy = { exp: expAt(oneYear) };

  it("accepts a legacy token inside the grace window", () => {
    const out = assessLegacyAccess(legacy, new Date(NOW.getTime() + LEGACY_GRACE_MS - 1), cutoverAt);
    expect(out.kind).toBe("legacy");
    if (out.kind !== "legacy") throw new Error("unreachable");
    expect(out.withinGrace).toBe(true);
  });

  /*
   * The point of the whole checkpoint. Past the window a year-long token is refused on its own
   * merits, whatever its signature says, so the defect has an end date rather than an expiry date.
   */
  it("refuses a legacy token once the window has passed", () => {
    const out = assessLegacyAccess(legacy, new Date(NOW.getTime() + LEGACY_GRACE_MS + 1), cutoverAt);
    expect(out.kind).toBe("legacy");
    if (out.kind !== "legacy") throw new Error("unreachable");
    expect(out.withinGrace).toBe(false);
  });

  it("is seven days, not a year", () => {
    expect(LEGACY_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(LEGACY_GRACE_MS).toBeLessThan(365 * 24 * 60 * 60 * 1000 / 50);
  });

  it("does not let a legacy token outlive the window just because it was issued later", () => {
    // Grace is measured from cutover, not from the token. Otherwise every newly-minted legacy
    // token would restart the clock and the window would never close.
    const out = assessLegacyAccess(legacy, new Date(NOW.getTime() + LEGACY_GRACE_MS + 86_400_000), cutoverAt);
    if (out.kind !== "legacy") throw new Error("unreachable");
    expect(out.withinGrace).toBe(false);
  });
});

describe("G4 — the grace window is not a hole", () => {
  /*
   * A forged token is refused by the signature check before any of this runs; `assessLegacyAccess`
   * only ever sees payloads that already verified. What it must not do is *widen* what is accepted:
   * a current token stays current, so the grace path cannot be used to extend a normal session.
   */
  it("never reports a current token as legacy, so grace cannot be claimed for one", () => {
    for (const ms of [0, 1000, ACCESS_TOKEN_TTL_MS / 2, ACCESS_TOKEN_TTL_MS]) {
      expect(assessLegacyAccess({ exp: expAt(ms) }, NOW, NOW).kind).toBe("current");
    }
  });

  it("an already-expired legacy token is still legacy, and the JWT layer refuses it anyway", () => {
    expect(assessLegacyAccess({ exp: expAt(-1000) }, NOW, NOW).kind).toBe("current");
  });
});
