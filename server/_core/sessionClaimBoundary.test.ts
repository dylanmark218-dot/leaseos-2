/**
 * S1-H — the credential boundary, asserted rather than assumed.
 *
 * Two of the required S1 tests had no coverage anywhere in the repository: that a provider API
 * credential can never reach a human session's claims, and that a session cannot assert tenancy.
 * Both were *true* — `signSession` names its three fields explicitly and `SessionPayload` has no
 * tenant member — but both were true only by the shape of a type, and a type is erased before any
 * of this runs. Nothing would have failed if someone widened either.
 *
 * WHY THIS IS THE RIGHT PLACE TO CATCH IT. The architecture's whole premise is that four kinds of
 * credential never mix: a provider key authenticates LeaseOS to Alberta 511 and carries *zero*
 * LeaseOS authority; a human session identifies a person and carries no permissions of its own. The
 * failure mode is not exotic. It is somebody adding `secretRef` or `orgRef` to the payload for
 * convenience — to save a lookup, to let a worker reuse a token — and every downstream check then
 * trusting a value the holder of a stolen token controls.
 *
 * These call the real `sdk.signSession` and `sdk.verifySession`, mint real JWTs, and decode them
 * without the library's help, so what is asserted is what actually crosses the wire.
 */
import { describe, expect, it, vi } from "vitest";

const APP_ID = "leaseos-app";
const SECRET = "a-signing-secret-long-enough-to-be-realistic";

const BASE_ENV = {
  appId: APP_ID,
  cookieSecret: SECRET,
  databaseUrl: "",
  oAuthServerUrl: "https://oauth.invalid",
  ownerOpenId: "",
  isProduction: false,
  forgeApiUrl: "",
  forgeApiKey: "",
};

async function loadSdk() {
  vi.resetModules();
  vi.doMock("./env", () => ({ ENV: { ...BASE_ENV } }));
  return (await import("./sdk")).sdk;
}

/**
 * Read a JWT's payload the way an attacker would: base64url, no signature check.
 *
 * Deliberately not `jwtVerify`. The question here is what the token *contains* — anyone holding it
 * can read that without the key, which is the entire reason a secret must never be in there.
 */
const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

/** Names a provider credential would plausibly be smuggled under. */
const PROVIDER_CREDENTIAL_KEYS = [
  "apiKey",
  "secretRef",
  "providerKey",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "webhookSecret",
  "mfaSecret",
];

describe("B1 — a human session carries no provider credential", () => {
  it("mints only the three identity claims, and nothing else", async () => {
    const sdk = await loadSdk();
    const token = await sdk.signSession({
      openId: "user-1",
      appId: APP_ID,
      name: "Dana",
    });

    const claims = claimsOf(token);
    // `exp` is the JWT layer's, not the payload's. Everything else must be one of the three.
    const carried = Object.keys(claims).filter(k => k !== "exp" && k !== "iat");
    expect(carried.sort()).toEqual(["appId", "name", "openId"]);
  });

  it("drops a provider credential smuggled into the payload instead of signing it", async () => {
    const sdk = await loadSdk();
    const smuggled = Object.fromEntries(
      PROVIDER_CREDENTIAL_KEYS.map(k => [k, `stolen-${k}-value`])
    );

    const token = await sdk.signSession({
      openId: "user-1",
      appId: APP_ID,
      name: "Dana",
      ...smuggled,
    } as never);

    const claims = claimsOf(token);
    for (const key of PROVIDER_CREDENTIAL_KEYS) {
      expect(claims[key], `${key} must never reach a session token`).toBeUndefined();
    }
    // And not merely absent under that name — the value itself must not appear anywhere.
    expect(JSON.stringify(claims)).not.toContain("stolen-");
  });

  it("does not hand a smuggled credential back out of verifySession either", async () => {
    const sdk = await loadSdk();
    const token = await sdk.signSession({
      openId: "user-1",
      appId: APP_ID,
      name: "Dana",
      apiKey: "alberta-511-developer-key",
    } as never);

    const verified = await sdk.verifySession(token);
    expect(verified).not.toBeNull();
    expect(Object.keys(verified!).sort()).toEqual(["appId", "name", "openId"]);
  });
});

describe("B2 — a session cannot assert tenancy", () => {
  /*
   * Tenant scope is resolved server-side from the authenticated user (`orgScopeWhere`,
   * `ownershipScopeWhere`). If the session claimed it instead, a stolen or self-minted token would
   * name its own tenant and cross-tenant reads would follow — the one boundary the survey called
   * the strongest part of the system.
   */
  it("carries no tenant or organization claim at all", async () => {
    const sdk = await loadSdk();
    const token = await sdk.signSession({
      openId: "user-1",
      appId: APP_ID,
      name: "Dana",
    });

    const claims = claimsOf(token);
    for (const key of ["orgRef", "orgId", "tenantId", "tenantRef", "companyId"]) {
      expect(claims[key], `tenancy must be looked up, never claimed`).toBeUndefined();
    }
  });

  it("ignores a tenant claim pushed into the payload", async () => {
    const sdk = await loadSdk();
    const token = await sdk.signSession({
      openId: "user-1",
      appId: APP_ID,
      name: "Dana",
      orgRef: "company-b",
      tenantId: "company-b",
    } as never);

    expect(claimsOf(token).orgRef).toBeUndefined();
    expect(claimsOf(token).tenantId).toBeUndefined();

    const verified = await sdk.verifySession(token);
    expect(verified).not.toHaveProperty("orgRef");
    expect(verified).not.toHaveProperty("tenantId");
  });

  it("carries no role or permission claim, so authority is never self-asserted", async () => {
    const sdk = await loadSdk();
    const token = await sdk.signSession({
      openId: "user-1",
      appId: APP_ID,
      name: "Dana",
      role: "platform_security_admin",
      permissions: ["admin:everything"],
    } as never);

    const claims = claimsOf(token);
    expect(claims.role).toBeUndefined();
    expect(claims.permissions).toBeUndefined();
    expect(JSON.stringify(claims)).not.toContain("admin:everything");
  });
});
