import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME, REFRESH_COOKIE_NAME } from "../shared/const";
import { LEGACY_REFRESH_COOKIE_PATHS, REFRESH_COOKIE_PATH } from "./_core/cookies";
import type { TrpcContext } from "./_core/context";

type CookieCall = {
  name: string;
  options: Record<string, unknown>;
};

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): {
  ctx: TrpcContext;
  clearedCookies: CookieCall[];
} {
  const clearedCookies: CookieCall[] = [];

  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };

  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    /*
     * S1-D — logout clears both credentials, not just the access cookie. The refresh cookie lives
     * at its own narrow path, so clearing the access cookie alone would leave the browser holding
     * a credential that could mint a fresh one.
     *
     * P0-B — and it clears the refresh cookie at the path it is issued under AND at every path it
     * was ever issued under. A browser deletes a cookie only when name, domain and path all match,
     * so a logout that named the wrong path would leave the credential resident. The attributes
     * are the issuing attributes (httpOnly, secure, sameSite none), not a looser copy.
     */
    const secureAttrs = { secure: true, sameSite: "none", httpOnly: true };
    expect(clearedCookies.map(c => [c.name, c.options.path])).toEqual([
      [COOKIE_NAME, "/"],
      [REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH],
      ...LEGACY_REFRESH_COOKIE_PATHS.map(p => [REFRESH_COOKIE_NAME, p]),
    ]);
    for (const c of clearedCookies) expect(c.options).toMatchObject(secureAttrs);
    expect(REFRESH_COOKIE_PATH).not.toBe("/");
  });
});
