/**
 * P0-B — one place issues a browser session.
 *
 * The OAuth callback used to mint the access token, open the family and write both cookies inline,
 * which left the cookie attributes a login issued with and the attributes a refresh or a logout
 * used living in different files. They now share this function and the helpers in ./cookies, and
 * the HTTP regression (`sessionCookieTransport.http.db.test.ts`) drives the same code the
 * callback does, minus the provider exchange.
 *
 * S1-B — a login issues a short access credential, not a year-long bearer token. The expiry is left
 * to `createSessionToken`'s default rather than named here, so this call site cannot drift away
 * from the one place the access lifetime is defined.
 *
 * S1-F — the login also opens a session family. Without it the access token would simply expire
 * after fifteen minutes and the user would be sent back to the provider, which is not hardening but
 * an outage. The family is what the short credential refreshes against, and what logout and
 * revoke-all act on. `appId` is carried so the family belongs to the surface it was minted for:
 * `verifySession` has refused a mismatched `appId` since the shared-secret finding, and
 * `auth.refresh` refuses a family minted for another surface for the same reason.
 *
 * A failure to open the family must not strand the user mid-login. They keep a working access
 * token; the consequence is one re-login in fifteen minutes, not a blank page now.
 */
import type { Request, Response } from "express";
import { ENV } from "./env";
import { sdk } from "./sdk";
import { issueAccessCookie, issueRefreshCookie } from "./cookies";
import { createSessionFamily } from "../sessionFamilyService";

export async function issueBrowserSession(
  req: Request,
  res: Response,
  who: { openId: string; name: string },
): Promise<void> {
  const accessToken = await sdk.createSessionToken(who.openId, { name: who.name });
  issueAccessCookie(req, res, accessToken);
  try {
    const family = await createSessionFamily({ openId: who.openId, appId: ENV.appId || null });
    issueRefreshCookie(req, res, family);
  } catch (error) {
    console.error("[OAuth] Could not open a session family", error);
  }
}
