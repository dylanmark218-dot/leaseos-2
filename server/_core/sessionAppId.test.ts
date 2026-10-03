/**
 * A session is bound to the app it was issued for — tested against the real
 * `sdk`, not against a copy of its logic.
 *
 * `verifySession` compares the token's `appId` against `ENV.appId` and refuses a
 * mismatch. A signing secret shared across deployments — the same value pasted
 * into staging, or a second app on the same platform — otherwise made either
 * one's session valid here: the signature checks out, and the claim that would
 * have distinguished them was decoded and dropped.
 *
 * This file exists because nothing tested it. A review of the change that added
 * the check found that no test in the repository mints or verifies a session JWT
 * at all — so a branch that can refuse every request in the application shipped
 * with no coverage, in the same commit that added three cases for a
 * bind-parameter invariant which changes no behaviour.
 *
 * The first draft of this file reimplemented `verifySession`'s decision inline
 * and asserted against that, which would have kept passing no matter what the
 * production function did. It now calls `sdk.createSessionToken`,
 * `sdk.signSession` and `sdk.verifySession` themselves. `ENV` is mocked because
 * the module reads it at load and builds an OAuth client from it; the functions
 * under test are the real ones.
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

/**
 * Load the real `sdk` against an explicitly stated environment.
 *
 * Every test names its own ENV rather than inheriting one. The first version of
 * this file used a top-level `vi.mock` plus `vi.doMock` inside two tests, and
 * `doMock` registrations outlive `resetModules` — so once one test remapped
 * `appId` to "leaseos-renamed", later tests loaded the sdk with THAT identity and
 * their tokens were refused for the wrong reason. Three assertions passed
 * vacuously. Found by disabling the required-claims check in `sdk.ts` and
 * watching the suite stay green when it should have gone red.
 */
async function sdkWith(env: Partial<typeof BASE_ENV> = {}) {
  vi.resetModules();
  vi.doMock("./env", () => ({ ENV: { ...BASE_ENV, ...env } }));
  return (await import("./sdk")).sdk;
}

describe("a session minted here verifies here", () => {
  it("round-trips a token created for the configured appId", async () => {
    const sdk = await sdkWith();
    const token = await sdk.createSessionToken("user-1", { name: "Dana" });
    await expect(sdk.verifySession(token)).resolves.toMatchObject({
      openId: "user-1",
      appId: APP_ID,
    });
  });
});

describe("a session issued for another app is refused", () => {
  it("refuses a validly-signed token carrying a different appId", async () => {
    // The whole point: the signature is good and the secret is shared. Only the
    // claim distinguishes this deployment from the other one.
    const sdk = await sdkWith();
    const foreign = await sdk.signSession({
      openId: "user-1", appId: "leaseos-staging", name: "Dana",
    });
    await expect(sdk.verifySession(foreign)).resolves.toBeNull();
  });

  it("invalidates a token minted for the appId this server used to carry", async () => {
    // Reconfiguring the app's identity must retire sessions issued under the old
    // one, rather than leaving them indistinguishable from current sessions.
    const sdk = await sdkWith();
    const token = await sdk.createSessionToken("user-1", { name: "Dana" });
    await expect(sdk.verifySession(token)).resolves.not.toBeNull();

    const renamed = await sdkWith({ appId: "leaseos-renamed" });
    await expect(renamed.verifySession(token)).resolves.toBeNull();
  });

  it("does not enforce when this server does not know its own identity", async () => {
    /*
     * `verifySession` guards the comparison with `ENV.appId &&`, so a server that
     * has no identity of its own accepts any app's token. That is deliberate:
     * `appId` is unset in development and in this suite, and refusing there would
     * turn a missing environment variable into an outage rather than the
     * configuration gap it is.
     *
     * Deliberate and untested is still untested. Dropping that guard would refuse
     * every session in every developer's checkout, and until this case nothing in
     * the repository would have said so — the suite above only ever loads the sdk
     * with an identity set, which is the one configuration where the guard makes
     * no difference.
     */
    const sdk = await sdkWith({ appId: "" });
    const foreign = await sdk.signSession({ openId: "user-1", appId: "some-other-app", name: "Dana" });
    await expect(sdk.verifySession(foreign)).resolves.toMatchObject({ openId: "user-1" });
  });
});

describe("the required claims are still enforced", () => {
  /*
   * These predate the appId comparison and bound its blast radius. `verifySession`
   * already refused a token whose `appId` was not a non-empty string — so if
   * `VITE_APP_ID` had been unset in production, `createSessionToken` would have
   * minted `appId: ""` and the server would have rejected every session it
   * issued. Login working at all proves the variable is set, and that every live
   * cookie carries exactly the value now compared against.
   */
  it("refuses an empty appId", async () => {
    const sdk = await sdkWith();
    const token = await sdk.signSession({ openId: "user-1", appId: "", name: "Dana" });
    await expect(sdk.verifySession(token)).resolves.toBeNull();
  });

  it("refuses a missing openId or name", async () => {
    const sdk = await sdkWith();
    await expect(
      sdk.verifySession(await sdk.signSession({ openId: "", appId: APP_ID, name: "Dana" }))
    ).resolves.toBeNull();
    await expect(
      sdk.verifySession(await sdk.signSession({ openId: "user-1", appId: APP_ID, name: "" }))
    ).resolves.toBeNull();
  });

  it("refuses a missing or malformed token", async () => {
    const sdk = await sdkWith();
    await expect(sdk.verifySession(undefined)).resolves.toBeNull();
    await expect(sdk.verifySession("")).resolves.toBeNull();
    await expect(sdk.verifySession("not-a-jwt")).resolves.toBeNull();
    await expect(sdk.verifySession("a.b.c")).resolves.toBeNull();
  });

  it("refuses a token signed with another deployment's secret", async () => {
    const sdk = await sdkWith();
    const token = await sdk.createSessionToken("user-1", { name: "Dana" });

    const other = await sdkWith({ cookieSecret: "an-entirely-different-deployment-secret" });
    await expect(other.verifySession(token)).resolves.toBeNull();
  });
});

describe("a cron session goes through the same gate", () => {
  /*
   * `authenticateRequest` calls `verifySession` first and only then inspects the
   * `cron_` prefix, so the appId comparison gates the cron branch completely, and
   * the platform's own project validation happens downstream where it cannot
   * rescue a refusal. Nothing in this repository mints a cron token, so whether
   * the platform sets this app's appId on one is an external question — recorded
   * in audit/hardening-2026-09-21/REMEDIATION.md. These pin the ordering that
   * makes it matter, so a change to it is deliberate rather than incidental.
   */
  it("refuses a cron token carrying a foreign appId", async () => {
    const sdk = await sdkWith();
    const token = await sdk.signSession({
      openId: "cron_task_42", appId: "platform-scheduler", name: "Scheduled Task",
    });
    await expect(sdk.verifySession(token)).resolves.toBeNull();
  });

  it("accepts a cron token carrying this app's appId", async () => {
    const sdk = await sdkWith();
    const token = await sdk.signSession({
      openId: "cron_task_42", appId: APP_ID, name: "Scheduled Task",
    });
    await expect(sdk.verifySession(token)).resolves.toMatchObject({
      openId: "cron_task_42",
    });
  });
});
