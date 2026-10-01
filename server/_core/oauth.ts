import {
  OAUTH_STATE_COOKIE,
  decodeOAuthState,
} from "@shared/const";
import { safeRedirectPath } from "@shared/_core/redirect";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { issueBrowserSession } from "./browserSession";
import { sdk } from "./sdk";

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
       * S1-B / S1-F / P0-B — the short access credential and the session family it refreshes
       * against, issued by the one function every browser session comes from (./browserSession).
       */
      await issueBrowserSession(req, res, { openId: userInfo.openId, name: userInfo.name || "" });

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
