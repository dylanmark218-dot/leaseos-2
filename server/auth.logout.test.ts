import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME, REFRESH_COOKIE_NAME } from "../shared/const";
import { ORG_SELECTION_COOKIE } from "./_core/organizationSelection";
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
  it("clears every cookie the session owns, and reports success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    /*
     * S1-D — logout clears both credentials, not just the access cookie. The refresh cookie lives
     * at its own narrow path, so clearing the access cookie alone would leave the browser holding
     * a credential that could mint a fresh one.
     *
     * v23.26 — and the organization selection, which is part of the session and ends with it:
     * leaving it behind would hand the next person to use a shared shop tablet a pre-selected tenant.
     */
    expect(clearedCookies.map(c => c.name)).toEqual([COOKIE_NAME, REFRESH_COOKIE_NAME, ORG_SELECTION_COOKIE]);
    expect(clearedCookies[1]?.options).toMatchObject({ maxAge: -1, path: "/api/auth" });
    for (const cookie of [clearedCookies[0]!, clearedCookies[2]!]) {
      // Cleared with the attributes they were set with — a mismatched path or domain clears
      // nothing and leaves the cookie in the browser.
      expect(cookie.options, cookie.name).toMatchObject({
        maxAge: -1,
        secure: true,
        sameSite: "none",
        httpOnly: true,
        path: "/",
      });
    }
  });
});
