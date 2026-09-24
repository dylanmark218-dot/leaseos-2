/**
 * The boot guard, tested — which it was not when it shipped.
 *
 * `assertProductionSecrets` was given an injectable `env` parameter precisely so
 * it could be exercised without touching `process.env`, and then nothing
 * exercised it. A guard with no test is a guard whose next edit is unreviewed,
 * and this one decides whether a production server starts at all.
 *
 * The cases below pin the two things that went wrong in the original version:
 * the length is measured in BYTES, not characters, and `VITE_APP_ID` is
 * required rather than optional.
 */
import { describe, expect, it } from "vitest";
import { assertProductionSecrets, MIN_COOKIE_SECRET_LENGTH } from "./env";

/** A configuration that should be allowed to start. */
const OK = {
  appId: "leaseos-app",
  cookieSecret: "x".repeat(MIN_COOKIE_SECRET_LENGTH),
  databaseUrl: "mysql://u@h:3306/d",
  oAuthServerUrl: "https://oauth.example",
  ownerOpenId: "owner-1",
  isProduction: true,
  forgeApiUrl: "https://forge.example",
  forgeApiKey: "forge-key",
  publicBaseUrl: "",
};

const envWith = (over: Partial<typeof OK>) => ({ ...OK, ...over });

describe("assertProductionSecrets", () => {
  it("allows a fully configured production server to start", () => {
    expect(() => assertProductionSecrets(envWith({}))).not.toThrow();
  });

  it("does not enforce outside production", () => {
    // The empty fallbacks exist so development and the test suite can import
    // this module without configuring anything; that must keep working.
    expect(() =>
      assertProductionSecrets(envWith({ isProduction: false, cookieSecret: "", appId: "" }))
    ).not.toThrow();
  });

  it("refuses an unset JWT_SECRET, naming the consequence", () => {
    expect(() => assertProductionSecrets(envWith({ cookieSecret: "" }))).toThrow(
      /JWT_SECRET is not set/
    );
  });

  it("refuses a short JWT_SECRET", () => {
    expect(() =>
      assertProductionSecrets(envWith({ cookieSecret: "x".repeat(MIN_COOKIE_SECRET_LENGTH - 1) }))
    ).toThrow(/at least 32/);
  });

  it("measures the secret in bytes, not characters", () => {
    // 32 characters, but each is 2 bytes in UTF-8 — 64 bytes, so this passes.
    expect(() => assertProductionSecrets(envWith({ cookieSecret: "é".repeat(32) }))).not.toThrow();
    // 20 characters at 3 bytes each is 60 bytes: over the floor despite being
    // well under 32 characters. A character count would reject it.
    expect(() => assertProductionSecrets(envWith({ cookieSecret: "気".repeat(20) }))).not.toThrow();
    // 16 characters at 2 bytes each is 32 bytes exactly — the boundary holds.
    expect(() => assertProductionSecrets(envWith({ cookieSecret: "é".repeat(16) }))).not.toThrow();
    // 15 of them is 30 bytes, which is under it.
    expect(() => assertProductionSecrets(envWith({ cookieSecret: "é".repeat(15) }))).toThrow(
      /30 bytes/
    );
  });

  it("refuses an unset VITE_APP_ID", () => {
    // Without it the server mints tokens carrying an empty appId, which
    // verifySession then refuses — it rejects every session it issues.
    expect(() => assertProductionSecrets(envWith({ appId: "" }))).toThrow(/VITE_APP_ID is not set/);
  });

  it("reports every problem at once rather than one per restart", () => {
    const err = (() => {
      try { assertProductionSecrets(envWith({ cookieSecret: "", appId: "" })); }
      catch (e) { return e as Error; }
    })();
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/JWT_SECRET/);
    expect(err!.message).toMatch(/VITE_APP_ID/);
  });

  it("never puts the secret in the error", () => {
    const secret = "correct-horse-battery-staple-which-is-long-enough-to-pass";
    const err = (() => {
      try { assertProductionSecrets(envWith({ cookieSecret: secret, appId: "" })); }
      catch (e) { return e as Error; }
    })();
    expect(err!.message).not.toContain(secret);
  });

  it("enforces when told to, regardless of NODE_ENV", () => {
    // How index.ts calls it: the production bundle is served for anything that
    // is not "development", so the guard is driven by that same decision rather
    // than by NODE_ENV === "production".
    expect(() =>
      assertProductionSecrets(envWith({ isProduction: false, cookieSecret: "" }), true)
    ).toThrow(/JWT_SECRET is not set/);
  });
});
