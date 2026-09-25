import {
  COOKIE_NAME,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE_NAME,
  decodeOAuthState,
} from "@shared/const";
import { safeRedirectPath } from "@shared/_core/redirect";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { ACCESS_TOKEN_TTL_MS, REFRESH_ABSOLUTE_TTL_MS } from "./sessionFamily";
import { createSessionFamily } from "../sessionFamilyService";
import { ENV } from "./env";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    // CSRF guard: the nonce in `state` must match the one-time cookie that
    // startLogin set in the browser that began this login. An attacker can
    // forge `state`, but cannot plant this cookie in the victim's browser.
    const { nonce, next } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader(req.headers.cookie ?? "")[
      OAUTH_STATE_COOKIE
    ];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, {
      path: "/",
      secure: true,
      sameSite: "none",
    });

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      const now = new Date();
      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: now,
      });

      // v23.26 — a successful sign-in, through the same table every other
      // security decision is written to. No token, no secret, no credential:
      // the actor, the method and the moment, which is what an access review
      // asks for and what a system that logs only refusals cannot answer.
      const signedIn = await db.getUserByOpenId(userInfo.openId);
      await db.recordAuthorizationDecision({
        actorUserId: signedIn?.id ?? null,
        procedureName: "auth.login",
        permission: "portal.compose_own",
        rolesHeld: null,
        outcome: "allowed",
        detail: `signed in via ${(userInfo.loginMethod ?? userInfo.platform ?? "oauth").slice(0, 40)}`,
        occurredAt: now,
      });

      /*
       * S1-B — a login issues a short access credential, not a year-long bearer token.
       *
       * The expiry is left to `createSessionToken`'s default rather than named here, so this call
       * site cannot drift away from the one place the access lifetime is defined.
       */
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: ACCESS_TOKEN_TTL_MS,
      });

      /*
       * S1-F — the login also opens a session family.
       *
       * Without this the access token would simply expire after fifteen minutes and the user would
       * be sent back to the provider, which is not hardening but an outage. The family is what the
       * short credential refreshes against, and what logout and revoke-all act on.
       *
       * `appId` is carried so the family belongs to the surface it was minted for: `verifySession`
       * has refused a mismatched `appId` since the shared-secret finding, and a refresh able to
       * cross surfaces would reopen that hole one layer down.
       *
       * A failure here must not strand the user mid-login. They keep a working access token; the
       * consequence is one re-login in fifteen minutes, not a blank page now.
       */
      try {
        const family = await createSessionFamily({
          openId: userInfo.openId,
          appId: ENV.appId || null,
        });
        res.cookie(REFRESH_COOKIE_NAME, `${family.familyRef}.${family.verifier}`, {
          ...getSessionCookieOptions(req, { refresh: true }),
          maxAge: REFRESH_ABSOLUTE_TTL_MS,
        });
      } catch (error) {
        console.error("[OAuth] Could not open a session family", error);
      }

      // v23.26 — back to where they were going, or to the shell.
      //
      // `next` travelled through the OAuth provider inside `state`, so it is
      // attacker-influenceable and is treated as such: `safeRedirectPath`
      // accepts a path on this origin and discards everything else — an
      // absolute URL, a protocol-relative one, a `javascript:` payload — rather
      // than trying to repair it. A "cleaned up" attacker URL is still an
      // attacker URL.
      res.redirect(302, safeRedirectPath(next, "/"));
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
