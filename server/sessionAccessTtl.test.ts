/**
 * S1-B — the access credential stops being a year long.
 *
 * The defect was not only that `oauth.ts` passed `ONE_YEAR_MS`. It was that `signSession` *defaults*
 * to it (`options.expiresInMs ?? ONE_YEAR_MS`), so fixing the call site would have left every other
 * caller — present and future — minting year-long sessions and nothing would have failed.
 *
 * These tests therefore check the default, not the call site.
 */
import { describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { ACCESS_TOKEN_TTL_MS } from "./_core/sessionFamily";
import { readFileSync } from "node:fs";

const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/*
 * `ENV` is mocked because the module reads it at load and signing needs a real key — the same
 * harness `_core/sessionAppId.test.ts` uses, and for the same reason. The function under test is
 * the real one.
 */
const BASE_ENV = {
  appId: "leaseos-app",
  cookieSecret: "a-signing-secret-long-enough-to-be-realistic",
  databaseUrl: "",
  oAuthServerUrl: "https://oauth.invalid",
  ownerOpenId: "",
  isProduction: false,
  forgeApiUrl: "",
  forgeApiKey: "",
};

async function loadSdk() {
  vi.resetModules();
  vi.doMock("./_core/env", () => ({ ENV: BASE_ENV }));
  return (await import("./_core/sdk")).sdk;
}

const lifetimeOf = (token: string) => {
  const { exp } = decodeJwt(token);
  return (exp as number) * 1000 - Date.now();
};

describe("B1 — an access token lives fifteen minutes", () => {
  it("expires one access lifetime from issue, not one year", async () => {
    const token = await (await loadSdk()).createSessionToken("user-b1", { name: "Dana" });
    const life = lifetimeOf(token);
    // Allow a couple of seconds for clock and rounding to the JWT's whole second.
    expect(life).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS + 2_000);
    expect(life).toBeGreaterThan(ACCESS_TOKEN_TTL_MS - 10_000);
  });

  it("is nowhere near a year", async () => {
    const life = lifetimeOf(await (await loadSdk()).createSessionToken("user-b1b", { name: "Dana" }));
    expect(life).toBeLessThan(ONE_YEAR_MS / 100);
  });

  it("is fifteen minutes exactly, as the approved contract states", () => {
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("B2 — the login path issues the short credential", () => {
  /*
   * Structural rather than behavioural: driving the real OAuth callback needs a live provider. What
   * must be true is that the callback no longer names the year — checked on comment-stripped source,
   * the same device `legacyAssignmentGuard` uses, so prose explaining the change cannot satisfy it.
   */
  const codeOf = (f: string) =>
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

  it("no longer mints a year-long session at the OAuth callback", () => {
    const src = codeOf("server/_core/oauth.ts");
    expect(
      /expiresInMs:\s*ONE_YEAR_MS/.test(src),
      "the callback must not ask for a year-long session",
    ).toBe(false);
  });

  it("no longer sets a year-long session cookie", () => {
    expect(/maxAge:\s*ONE_YEAR_MS/.test(codeOf("server/_core/oauth.ts"))).toBe(false);
  });
});

describe("B3 — no caller can mint a year-long user session by omission", () => {
  /*
   * The load-bearing one. A caller that passes nothing must get the short lifetime, because that is
   * what every existing and future caller of `signSession` does.
   */
  it("defaults to the access lifetime when no expiry is given", async () => {
    const life = lifetimeOf(await (await loadSdk()).signSession({ openId: "u", appId: "a", name: "n" }));
    expect(life).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS + 2_000);
  });

  it("does not fall back to ONE_YEAR_MS anywhere in the signing path", () => {
    const src = readFileSync("server/_core/sdk.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
    expect(
      /\?\?\s*ONE_YEAR_MS/.test(src),
      "the signing default is the access lifetime; a year must not be reachable by omission",
    ).toBe(false);
  });
});
