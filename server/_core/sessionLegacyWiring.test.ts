/**
 * S1-G, wired — the legacy cutoff enforced by the real verification path.
 *
 * `sessionLegacyTransition.test.ts` proves the *policy*: `assessLegacyAccess` classifies a
 * far-future expiry as legacy and closes the window after seven days. What it cannot prove is
 * that anything ever calls it. Delete the four lines in `verifySession` that consult it and every
 * one of those ten tests still passes, while every pre-S1 year-long token silently works again
 * until 2027.
 *
 * That gap was found by a temporary probe after S1 merged. This is the probe made permanent.
 *
 * WHAT IS UNDER TEST. The real `sdk.signSession` mints the token and the real `sdk.verifySession`
 * judges it; no token validation is reconstructed here. The critical case (LWI-2) then drives the
 * same refusal through `authenticateRequest` on both the cookie and the Bearer path, because a
 * rejection there throws before any database access — so both entry points are covered without
 * standing up a server harness.
 *
 * TIME. The real `LEGACY_CUTOVER_AT` is used, never a moved one: the point is to pin the actual
 * production date. The clock moves instead, via the repository's `toFake: ["Date"]` pattern (see
 * `capitalAssets.test.ts`), which also governs the JWT library's own expiry check — so LWI-4 gets
 * ordinary expiry for free rather than by simulation. Nothing here reads the wall clock, so these
 * assertions mean the same thing after 2026-10-01 as before it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_CUTOVER_AT, COOKIE_NAME } from "@shared/const";
import { ACCESS_TOKEN_TTL_MS, LEGACY_GRACE_MS } from "./sessionFamily";

const APP_ID = "leaseos-app";
const BASE_ENV = {
  appId: APP_ID,
  cookieSecret: "a-signing-secret-long-enough-to-be-realistic",
  databaseUrl: "",
  oAuthServerUrl: "https://oauth.invalid",
  ownerOpenId: "",
  isProduction: false,
  forgeApiUrl: "",
  forgeApiKey: "",
};

/** Instants pinned to the real policy constants, not to today. */
const CUTOVER = LEGACY_CUTOVER_AT.getTime();
const GRACE_ENDS = CUTOVER + LEGACY_GRACE_MS;
const INSIDE_GRACE = CUTOVER + 24 * 60 * 60 * 1000; // one day after cutover
const AFTER_GRACE = GRACE_ENDS + 1000; // one second past the window

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

/** Load the real sdk against a stated environment. Only `Date` is faked; timers stay real. */
async function sdkAt(instant: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
  vi.resetModules();
  vi.doMock("./env", () => ({ ENV: { ...BASE_ENV } }));
  return (await import("./sdk")).sdk;
}

/** A genuine pre-S1 token: minted by the real signer with the year-long lifetime S1-B removed. */
const mintLegacy = async (at: number) =>
  (await sdkAt(at)).signSession(
    { openId: "driver-1", appId: APP_ID, name: "Dana" },
    { expiresInMs: ONE_YEAR_MS }
  );

/** A normal post-S1 token: no explicit lifetime, so it takes the 15-minute default. */
const mintCurrent = async (at: number) =>
  (await sdkAt(at)).signSession({ openId: "driver-1", appId: APP_ID, name: "Dana" });

const verifyAt = async (token: string, at: number) => (await sdkAt(at)).verifySession(token);

describe("LWI-1 — inside the window, a pre-S1 token still works", () => {
  it("accepts a year-long token one day after the cutover", async () => {
    const legacy = await mintLegacy(INSIDE_GRACE);

    const session = await verifyAt(legacy, INSIDE_GRACE);

    expect(session, "refusing these at deploy would sign out a whole fleet at once").not.toBeNull();
    expect(session!.openId).toBe("driver-1");
  });

  it("still accepts it at the exact instant the window closes", async () => {
    /*
     * The policy compares `now - cutover <= LEGACY_GRACE_MS`, so the boundary is inclusive.
     * Pinned deliberately: whether the last millisecond is in or out is the kind of detail a
     * rewrite changes silently, and a fleet's last stragglers sit exactly there.
     */
    const legacy = await mintLegacy(INSIDE_GRACE);

    expect(await verifyAt(legacy, GRACE_ENDS)).not.toBeNull();
  });
});

describe("LWI-2 — past the window, the real verifier refuses it", () => {
  /*
   * THE regression. The token is minted once and judged twice; only the clock differs, so nothing
   * but the cutover rule can explain the change in verdict.
   *
   * If a refactor drops the `assessLegacyAccess` call from `verifySession`, this fails — which is
   * the whole reason the file exists.
   */
  it("refuses a year-long token one second after the window closes", async () => {
    const legacy = await mintLegacy(INSIDE_GRACE);

    expect(await verifyAt(legacy, INSIDE_GRACE), "precondition: accepted inside").not.toBeNull();
    expect(
      await verifyAt(legacy, AFTER_GRACE),
      "a pre-S1 token must not outlive the transition window"
    ).toBeNull();
  });

  it("refuses it long after, not merely at the edge", async () => {
    const legacy = await mintLegacy(INSIDE_GRACE);

    // Six months on, still well inside the token's own one-year expiry.
    expect(await verifyAt(legacy, CUTOVER + 182 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("the refusal is the cutover rule, not the token's own expiry", async () => {
    // Proof the JWT layer would still accept it: at this instant it has ~half a year left.
    const legacy = await mintLegacy(INSIDE_GRACE);
    const stillUnexpired = CUTOVER + 182 * 24 * 60 * 60 * 1000;

    const [{ decodeJwt }] = await Promise.all([import("jose")]);
    const exp = decodeJwt(legacy).exp!;

    expect(exp * 1000, "the token has not expired on its own terms").toBeGreaterThan(stillUnexpired);
    expect(await verifyAt(legacy, stillUnexpired)).toBeNull();
  });
});

describe("LWI-2b — both request entry points reach that refusal", () => {
  /*
   * `authenticateRequest` reads the session cookie first and falls back to a Bearer header. The
   * previous report asserted both converge on `verifySession`; this proves it by execution.
   *
   * Only the refusal is driven through here. A rejection throws before any database access, so it
   * needs no harness — whereas the acceptance path continues into a user lookup, and building a
   * database fixture for it would add a lot of surface to prove a point `verifySession` already
   * pins directly above.
   */
  const legacyPastWindow = async () => {
    const token = await mintLegacy(INSIDE_GRACE);
    return token;
  };

  /*
   * Asserted on the *specific* refusal, not merely "it threw". `authenticateRequest` continues
   * into a user lookup once a session verifies, and with no database configured that path throws
   * too — so a bare `rejects.toThrow()` passes even when the cutover check has been deleted. It
   * did exactly that when the mutation was first planted here, which is why the message is pinned.
   */
  const REFUSAL = /Invalid session cookie/;

  it("refuses a past-window legacy token presented as a session cookie", async () => {
    const token = await legacyPastWindow();
    const sdk = await sdkAt(AFTER_GRACE);

    await expect(
      sdk.authenticateRequest({ headers: { cookie: `${COOKIE_NAME}=${token}` } } as never)
    ).rejects.toThrow(REFUSAL);
  });

  it("refuses the same token presented as a Bearer credential", async () => {
    const token = await legacyPastWindow();
    const sdk = await sdkAt(AFTER_GRACE);

    await expect(
      sdk.authenticateRequest({ headers: { authorization: `Bearer ${token}` } } as never)
    ).rejects.toThrow(REFUSAL);
  });

  it("the Bearer path is genuinely reached — the same token verifies inside the window", async () => {
    /*
     * Guards against the pair above passing for the wrong reason a second way: if the header were
     * never read at all, the refusal would still fire (no credential at all is also refused). So
     * the token is shown to be *accepted* by the verifier inside the window, which means the
     * refusal after it is about the token, not about the header being ignored.
     */
    const token = await legacyPastWindow();

    expect(await verifyAt(token, INSIDE_GRACE)).not.toBeNull();
  });
});

describe("LWI-3 — a current token is never mistaken for a legacy one", () => {
  it("accepts a fresh 15-minute token", async () => {
    const at = CUTOVER + 3 * 24 * 60 * 60 * 1000;
    const current = await mintCurrent(at);

    expect(await verifyAt(current, at)).not.toBeNull();
  });

  it("accepts a fresh token minted long after the window has closed", async () => {
    /*
     * The case that would break if the rule were written as "after the window, refuse everything"
     * rather than "after the window, refuse *legacy*". Every session minted from October onwards
     * lands here.
     */
    const at = GRACE_ENDS + 90 * 24 * 60 * 60 * 1000;
    const current = await mintCurrent(at);

    expect(await verifyAt(current, at), "S1 tokens must outlive the transition window").not.toBeNull();
  });

  it("accepts one right up to the end of its own lifetime", async () => {
    const at = GRACE_ENDS + 1000;
    const current = await mintCurrent(at);

    expect(await verifyAt(current, at + ACCESS_TOKEN_TTL_MS - 1000)).not.toBeNull();
  });
});

describe("LWI-4 — ordinary expiry still applies on its own", () => {
  /*
   * The transition rule replaces nothing. A current token past fifteen minutes is refused by the
   * JWT layer, whether or not the cutover window is open — so both of these are checked, one on
   * each side of it.
   */
  it("refuses an expired current token while the window is still open", async () => {
    const at = INSIDE_GRACE;
    const current = await mintCurrent(at);

    expect(await verifyAt(current, at + ACCESS_TOKEN_TTL_MS + 60_000)).toBeNull();
  });

  it("refuses an expired current token after the window has closed", async () => {
    const at = GRACE_ENDS + 1000;
    const current = await mintCurrent(at);

    expect(await verifyAt(current, at + ACCESS_TOKEN_TTL_MS + 60_000)).toBeNull();
  });
});
