/**
 * S1-E (CSRF) — the defence the cookie cannot provide.
 *
 * `sameSite: "none"` is kept deliberately (embedded surfaces would otherwise be logged out), which
 * means the browser will attach the session cookie to a cross-site request. So a page on any origin
 * could, unaided, POST to the refresh endpoint and have the browser supply the credential.
 *
 * The endpoints that matter most are the ones that *mint* credentials. A successful cross-site
 * refresh would rotate the victim's family and hand the attacker's page nothing — the cookies are
 * `httpOnly`, so it cannot read the result — but it would still invalidate the verifier the real
 * browser holds, which is a logout-everyone primitive, and on a reused verifier it would trip reuse
 * detection and kill the family outright. That is a denial-of-service anyone can fire.
 *
 * Origin is checked rather than a token round-trip because these endpoints are few and the check
 * needs no client change. `isTrustedOrigin` is the whole contract, and it fails closed.
 */
import { describe, expect, it } from "vitest";
import { isTrustedOrigin } from "./_core/csrf";

const req = (headers: Record<string, string | undefined>) => ({ headers }) as never;

describe("E3 — a cross-site call to a credential endpoint is refused", () => {
  it("refuses a foreign Origin", () => {
    expect(isTrustedOrigin(req({ origin: "https://evil.example", host: "app.leaseos.test" })))
      .toBe(false);
  });

  it("accepts the application's own Origin", () => {
    expect(isTrustedOrigin(req({ origin: "https://app.leaseos.test", host: "app.leaseos.test" })))
      .toBe(true);
  });

  it("accepts a same-host Origin on a different scheme rather than guessing", () => {
    // The proxy terminates TLS; the Host header is what identifies us.
    expect(isTrustedOrigin(req({ origin: "http://app.leaseos.test", host: "app.leaseos.test" })))
      .toBe(true);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(isTrustedOrigin(req({ referer: "https://app.leaseos.test/dispatch/4", host: "app.leaseos.test" })))
      .toBe(true);
    expect(isTrustedOrigin(req({ referer: "https://evil.example/x", host: "app.leaseos.test" })))
      .toBe(false);
  });
});

describe("E3b — it fails closed", () => {
  /*
   * A request with neither header is refused. Browsers send Origin on cross-site POSTs, so the
   * absence of both is either a non-browser client — which should use the Bearer path — or someone
   * stripping headers. Neither is a reason to trust it.
   */
  it("refuses when neither Origin nor Referer is present", () => {
    expect(isTrustedOrigin(req({ host: "app.leaseos.test" }))).toBe(false);
  });

  it("refuses when the Host header is missing, rather than matching anything", () => {
    expect(isTrustedOrigin(req({ origin: "https://app.leaseos.test" }))).toBe(false);
  });

  it("refuses a malformed Origin instead of throwing", () => {
    expect(isTrustedOrigin(req({ origin: "not a url", host: "app.leaseos.test" }))).toBe(false);
  });

  it("is not fooled by a foreign host that merely ends with ours", () => {
    expect(isTrustedOrigin(req({ origin: "https://notapp.leaseos.test", host: "app.leaseos.test" })))
      .toBe(false);
    expect(isTrustedOrigin(req({ origin: "https://app.leaseos.test.evil.example", host: "app.leaseos.test" })))
      .toBe(false);
  });
});
