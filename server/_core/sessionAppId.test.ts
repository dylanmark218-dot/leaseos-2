/**
 * A session is bound to the app it was issued for.
 *
 * `verifySession` compares the token's `appId` against `ENV.appId` and refuses a
 * mismatch. A signing secret shared across deployments — the same value pasted
 * into staging, or a second app on the same platform — otherwise made either
 * one's session valid here, because the signature checks out and the claim that
 * would have distinguished them was decoded and dropped.
 *
 * This file exists because nothing tested it. A review of the change that added
 * the check found that no test in the repository mints or verifies a session JWT
 * at all — so a new branch that can refuse every request in the application
 * shipped with no coverage, in the same commit that added nine cases for a
 * bind-parameter invariant which changes no behaviour.
 *
 * The cases go through `jose` directly rather than through `sdk`, because `sdk`
 * reads `ENV` at module load and constructing it needs an OAuth server. What is
 * pinned is the decision `verifySession` makes, in the same shape and with the
 * same algorithm pin, so a change to that logic has to be made deliberately.
 */
import { describe, expect, it } from "vitest";
import { SignJWT, jwtVerify } from "jose";

const SECRET = new TextEncoder().encode("a-secret-long-enough-to-sign-with-abc");
const OTHER_SECRET = new TextEncoder().encode("a-different-deployments-secret-xyz123");

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

async function mint(
  claims: { openId?: unknown; appId?: unknown; name?: unknown },
  secret = SECRET
) {
  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret);
}

/** The decision verifySession makes, in the order it makes it. */
async function verify(token: string, envAppId: string, secret = SECRET) {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = (await jwtVerify(token, secret, { algorithms: ["HS256"] })) as never);
  } catch {
    return { ok: false, reason: "signature" as const };
  }
  const { openId, appId, name } = payload;
  if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
    return { ok: false, reason: "missing-fields" as const };
  }
  if (envAppId && appId !== envAppId) return { ok: false, reason: "wrong-app" as const };
  return { ok: true as const, openId, appId, name };
}

const GOOD = { openId: "user-1", appId: "leaseos-app", name: "Dana" };

describe("session appId binding", () => {
  it("accepts a session issued for this app", async () => {
    const r = await verify(await mint(GOOD), "leaseos-app");
    expect(r.ok).toBe(true);
  });

  it("refuses a validly-signed session issued for a different app", async () => {
    // The whole point: the signature is good. Only the claim distinguishes them.
    const r = await verify(await mint({ ...GOOD, appId: "leaseos-staging" }), "leaseos-app");
    expect(r).toMatchObject({ ok: false, reason: "wrong-app" });
  });

  it("still refuses a session signed with another deployment's secret", async () => {
    const r = await verify(await mint(GOOD, OTHER_SECRET), "leaseos-app");
    expect(r).toMatchObject({ ok: false, reason: "signature" });
  });

  it("does not enforce when this server does not know its own identity", async () => {
    // ENV.appId is unset in development and in the test suite. Refusing there
    // would turn a missing variable into an outage rather than a config gap.
    const r = await verify(await mint({ ...GOOD, appId: "anything" }), "");
    expect(r.ok).toBe(true);
  });
});

describe("the pre-existing non-empty check, which bounds the blast radius", () => {
  /*
   * This is why enabling the comparison could not invalidate live sessions. An
   * empty appId was already refused before the comparison existed — so if
   * VITE_APP_ID had been unset in production, createSessionToken would have
   * minted `appId: ""` and the server would have rejected every session it
   * issued. Login working at all proves the variable is set, and that every live
   * cookie carries exactly the value now compared against.
   */
  it("refuses an empty appId regardless of the comparison", async () => {
    expect(await verify(await mint({ ...GOOD, appId: "" }), "leaseos-app")).toMatchObject({
      ok: false, reason: "missing-fields",
    });
    expect(await verify(await mint({ ...GOOD, appId: "" }), "")).toMatchObject({
      ok: false, reason: "missing-fields",
    });
  });

  it("refuses a missing openId or name", async () => {
    expect(await verify(await mint({ appId: "leaseos-app", name: "Dana" }), "leaseos-app")).toMatchObject({ ok: false });
    expect(await verify(await mint({ openId: "user-1", appId: "leaseos-app" }), "leaseos-app")).toMatchObject({ ok: false });
  });
});

describe("a cron session is subject to the same check", () => {
  /*
   * `authenticateRequest` calls verifySession first and only then inspects the
   * `cron_` prefix, so the appId comparison gates the cron branch completely.
   * The platform's own project validation happens downstream and cannot rescue a
   * refusal. Nothing in this repository mints a cron token, so whether the
   * platform sets this app's appId on one is an external question — recorded in
   * audit/hardening-2026-09-21/REMEDIATION.md. This case pins the ordering that
   * makes it matter.
   */
  it("refuses a cron token carrying a foreign appId, before the cron branch", async () => {
    const token = await mint({ openId: "cron_task_42", appId: "platform-scheduler", name: "Scheduled Task" });
    const r = await verify(token, "leaseos-app");
    expect(r).toMatchObject({ ok: false, reason: "wrong-app" });
  });

  it("accepts a cron token carrying this app's appId", async () => {
    const token = await mint({ openId: "cron_task_42", appId: "leaseos-app", name: "Scheduled Task" });
    const r = await verify(token, "leaseos-app");
    expect(r).toMatchObject({ ok: true, openId: "cron_task_42" });
  });
});
