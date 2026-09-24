/**
 * S1-I — the browser rotates its own session instead of bouncing to OAuth.
 *
 * S1-B cut the access credential from a year to fifteen minutes, which is the point of the whole
 * checkpoint. What it also did, until this file, was make every signed-in browser drop into the
 * OAuth portal a quarter of an hour after logging in: the server grew a refresh endpoint and
 * nothing ever called it.
 *
 * WHAT IS BEING TESTED, AND WHY IT IS TESTED HERE. The refresh credential never enters JavaScript
 * — `auth.refresh` writes the new access token to a cookie (`routers.ts:457`) and returns
 * `{ok:true}`. So there is no token for the client to hold, and the only thing the browser has to
 * get right is *control flow*: refresh once, retry once, never recurse, and never let five
 * simultaneous failures spend five verifiers. Control flow is exactly what survives a refactor
 * unnoticed, so it is pinned here rather than left to integration.
 *
 * The link is driven with a fake `next`, not a live server, because the assertions are about how
 * many times refresh is called and in what order — facts a real socket would only obscure.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import {
  CREDENTIAL_PATHS,
  createRefreshGate,
  isAuthExpiry,
  sessionRefreshLink,
  shouldAttemptRefresh,
} from "./sessionRefresh";

/** An error shaped the way the server's `protectedProcedure` refusal actually arrives. */
const expiredError = () => {
  const e = new TRPCClientError(UNAUTHED_ERR_MSG);
  // `data` is what the httpLink attaches from the server's error shape.
  (e as { data?: unknown }).data = { code: "UNAUTHORIZED" };
  return e;
};

const errorWithCode = (code: string, message = "nope") => {
  const e = new TRPCClientError(message);
  (e as { data?: unknown }).data = { code };
  return e;
};

/**
 * Drive the link the way tRPC does.
 *
 * `responses` is consumed one per attempt, so a test says "fail, then succeed" and the retry is
 * observable rather than inferred.
 */
function drive(opts: {
  path: string;
  responses: Array<{ ok: true } | { error: TRPCClientError<never> }>;
  refresh: () => Promise<boolean>;
  onSignedOut?: () => void;
}) {
  const attempts: string[] = [];
  const link = sessionRefreshLink({
    refresh: opts.refresh,
    onSignedOut: opts.onSignedOut ?? (() => {}),
  });

  const next = (op: { path: string }) =>
    observable<unknown, TRPCClientError<never>>(observer => {
      attempts.push(op.path);
      const r = opts.responses.shift() ?? { ok: true as const };
      if ("error" in r) observer.error(r.error);
      else {
        observer.next({ result: { data: "payload" } });
        observer.complete();
      }
      return () => {};
    });

  const op = { path: opts.path, type: "query", id: 1, input: undefined, context: {} };
  const result = new Promise<{ ok: boolean; error?: unknown }>(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (link as any)({})({ op, next }).subscribe({
      next: () => resolve({ ok: true }),
      error: (error: unknown) => resolve({ ok: false, error }),
    });
  });

  return { attempts, result };
}

describe("I1 — refresh happens only when the access credential has expired", () => {
  it("1. a valid access credential never calls refresh", async () => {
    const refresh = vi.fn(async () => true);
    const { attempts, result } = drive({ path: "dispatch.listRoles", responses: [{ ok: true }], refresh });

    await expect(result).resolves.toMatchObject({ ok: true });
    expect(refresh).not.toHaveBeenCalled();
    expect(attempts).toEqual(["dispatch.listRoles"]);
  });

  it("2. an expired access credential triggers refresh", async () => {
    const refresh = vi.fn(async () => true);
    const { result } = drive({
      path: "dispatch.listRoles",
      responses: [{ error: expiredError() }, { ok: true }],
      refresh,
    });

    await result;
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("3. a successful refresh retries the original request exactly once", async () => {
    const { attempts, result } = drive({
      path: "dispatch.listRoles",
      responses: [{ error: expiredError() }, { ok: true }],
      refresh: async () => true,
    });

    await expect(result).resolves.toMatchObject({ ok: true });
    expect(attempts).toEqual(["dispatch.listRoles", "dispatch.listRoles"]);
  });

  it("4. the refreshed request succeeds without reaching the signed-out path", async () => {
    const onSignedOut = vi.fn();
    const { result } = drive({
      path: "dispatch.listRoles",
      responses: [{ error: expiredError() }, { ok: true }],
      refresh: async () => true,
      onSignedOut,
    });

    await expect(result).resolves.toMatchObject({ ok: true });
    expect(onSignedOut, "a recovered session must not bounce the user to OAuth").not.toHaveBeenCalled();
  });

  it("13. a non-authentication failure does not trigger refresh", async () => {
    const refresh = vi.fn(async () => true);
    const { attempts, result } = drive({
      path: "dispatch.listRoles",
      responses: [{ error: errorWithCode("INTERNAL_SERVER_ERROR") }],
      refresh,
    });

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
  });
});

describe("I2 — a refusal that refresh cannot cure ends the session", () => {
  const cases: Array<[string, string]> = [
    ["5. a rejected refresh", "Session expired. Sign in again."],
    ["6. a revoked family", "Session expired. Sign in again."],
    ["7. an expired family", "Session expired. Sign in again."],
    ["8. a reuse-detected family", "Session expired. Sign in again."],
  ];

  /*
   * The server answers all four identically on purpose — a caller cannot tell a revoked family
   * from an expired one from a verifier that never matched. So the client cannot either, and must
   * not invent a distinction: every one of them ends the session rather than silently recovering.
   */
  for (const [label] of cases) {
    it(`${label} cannot silently recover`, async () => {
      const onSignedOut = vi.fn();
      const { attempts, result } = drive({
        path: "dispatch.listRoles",
        responses: [{ error: expiredError() }],
        refresh: async () => false,
        onSignedOut,
      });

      await expect(result).resolves.toMatchObject({ ok: false });
      expect(onSignedOut).toHaveBeenCalledTimes(1);
      expect(attempts, "a failed refresh must not retry the request").toHaveLength(1);
    });
  }

  it("11. a refresh that throws releases the caller cleanly rather than hanging", async () => {
    const onSignedOut = vi.fn();
    const { result } = drive({
      path: "dispatch.listRoles",
      responses: [{ error: expiredError() }],
      refresh: async () => {
        throw new Error("network down");
      },
      onSignedOut,
    });

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("15. a repeatedly-unauthorized request stops instead of looping", async () => {
    const refresh = vi.fn(async () => true);
    const { attempts, result } = drive({
      path: "dispatch.listRoles",
      // Refresh succeeds, but the retry is refused again — an appId mismatch behaves like this.
      responses: [{ error: expiredError() }, { error: expiredError() }],
      refresh,
    });

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(refresh, "one refresh, not one per attempt").toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(2);
  });

  it("12. the retried request cannot itself start another refresh", async () => {
    const refresh = vi.fn(async () => true);
    const { attempts } = drive({
      path: "dispatch.listRoles",
      responses: [{ error: expiredError() }, { error: expiredError() }, { ok: true }],
      refresh,
    });

    await new Promise(r => setTimeout(r, 20));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(attempts, "request → refresh → retry → stop").toHaveLength(2);
  });
});

describe("I3 — the credential endpoints are excluded structurally", () => {
  it("14. logout does not invoke refresh", async () => {
    const refresh = vi.fn(async () => true);
    const { attempts, result } = drive({
      path: "auth.logout",
      responses: [{ error: expiredError() }],
      refresh,
    });

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
  });

  it("auth.refresh failing cannot refresh itself", async () => {
    const refresh = vi.fn(async () => true);
    const { result } = drive({
      path: "auth.refresh",
      responses: [{ error: expiredError() }],
      refresh,
    });

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(refresh, "refreshing the refresh is the infinite loop").not.toHaveBeenCalled();
  });

  it("names every credential endpoint, so adding one is a deliberate act", () => {
    expect([...CREDENTIAL_PATHS].sort()).toEqual([
      "auth.logout",
      "auth.refresh",
      "auth.revokeAll",
    ]);
  });
});

describe("I4 — one refresh, however many requests fail at once", () => {
  it("9. five concurrent expired requests produce exactly one refresh", async () => {
    let calls = 0;
    let release: (v: boolean) => void = () => {};
    const gate = createRefreshGate(() => {
      calls += 1;
      return new Promise<boolean>(r => {
        release = r;
      });
    });

    const waiters = [gate.refresh(), gate.refresh(), gate.refresh(), gate.refresh(), gate.refresh()];
    expect(calls, "the verifier rotates on every redemption — five would spend five").toBe(1);

    release(true);
    expect(await Promise.all(waiters)).toEqual([true, true, true, true, true]);
  });

  it("10. all waiting callers resume from the single successful refresh", async () => {
    let release: (v: boolean) => void = () => {};
    const gate = createRefreshGate(() => new Promise<boolean>(r => { release = r; }));

    const results: boolean[] = [];
    const waiters = Array.from({ length: 5 }, () => gate.refresh().then(v => { results.push(v); return v; }));
    release(true);
    await Promise.all(waiters);

    expect(results).toHaveLength(5);
    expect(results.every(Boolean)).toBe(true);
  });

  it("11b. a rejected refresh releases every waiter instead of stranding them", async () => {
    let reject: (e: Error) => void = () => {};
    const gate = createRefreshGate(() => new Promise<boolean>((_, rj) => { reject = rj; }));

    const waiters = Array.from({ length: 5 }, () => gate.refresh());
    reject(new Error("network down"));

    // Resolved false, not left pending and not an unhandled rejection.
    expect(await Promise.all(waiters)).toEqual([false, false, false, false, false]);
  });

  it("clears the in-flight promise so a later expiry can refresh again", async () => {
    let calls = 0;
    const gate = createRefreshGate(async () => {
      calls += 1;
      return true;
    });

    await gate.refresh();
    await gate.refresh();
    expect(calls, "single-flight must not become refresh-once-ever").toBe(2);
  });

  it("a failed refresh also clears the gate, so signing in again works", async () => {
    let calls = 0;
    const gate = createRefreshGate(async () => {
      calls += 1;
      return calls > 1;
    });

    expect(await gate.refresh()).toBe(false);
    expect(await gate.refresh()).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("I5 — the refresh verifier never reaches JavaScript", () => {
  /*
   * The whole reason this integration needs no token handling: `auth.refresh` writes the new access
   * token to a cookie and returns `{ok:true}`. If a future change started returning the credential
   * so the client could "hold" it, that is a security regression, and this is where it surfaces.
   */
  it("16. the client's refresh contract carries no credential material", async () => {
    const gate = createRefreshGate(async () => true);
    const outcome = await gate.refresh();

    expect(typeof outcome, "refresh answers yes or no, never with a token").toBe("boolean");
  });

  it("the module holds no verifier, cookie parsing, or storage of credentials", () => {
    const src = readFileSync("client/src/lib/sessionRefresh.ts", "utf8");

    for (const forbidden of ["verifier", "app_refresh_id", "REFRESH_COOKIE_NAME", "document.cookie"]) {
      expect(src, `the browser must never handle ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("I6 — the policy decisions, stated directly", () => {
  it("recognises the server's expiry refusal", () => {
    expect(isAuthExpiry(expiredError())).toBe(true);
  });

  it("does not mistake other refusals for expiry", () => {
    expect(isAuthExpiry(errorWithCode("FORBIDDEN"))).toBe(false);
    expect(isAuthExpiry(errorWithCode("BAD_REQUEST"))).toBe(false);
    expect(isAuthExpiry(new Error("plain"))).toBe(false);
    expect(isAuthExpiry(null)).toBe(false);
  });

  it("refuses a second attempt, whatever the error says", () => {
    expect(shouldAttemptRefresh("dispatch.listRoles", expiredError(), false)).toBe(true);
    expect(shouldAttemptRefresh("dispatch.listRoles", expiredError(), true)).toBe(false);
  });

  it("refuses the credential endpoints even on a first attempt", () => {
    for (const path of CREDENTIAL_PATHS) {
      expect(shouldAttemptRefresh(path, expiredError(), false)).toBe(false);
    }
  });
});
