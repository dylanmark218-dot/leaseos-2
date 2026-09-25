/**
 * S1-I — the browser rotates its own session instead of bouncing to OAuth.
 *
 * S1-B cut the access credential from a year to fifteen minutes. The server grew `auth.refresh` to
 * rotate it; nothing in the browser ever called it. The visible consequence was that a signed-in
 * user dropped into the OAuth portal a quarter of an hour after signing in — a regression this
 * checkpoint introduced and this file closes.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It handles no credential. `auth.refresh` writes the
 * new access token to an httpOnly cookie and returns `{ok:true}` — there is nothing for JavaScript
 * to hold, and the cookie the server sets takes priority over the sessionStorage Bearer fallback
 * (`sdk.authenticateRequest` reads the cookie first), so the retry simply works. Everything here is
 * control flow: refresh once, retry once, never recurse, and never let a burst of failures spend
 * more than one rotation.
 *
 * WHY EACH GUARD EXISTS.
 *  - Single-flight, because the server rotates the refresh credential on every redemption. Five
 *    simultaneous expiries without it are five rotations, four of which land on a credential the
 *    previous one already replaced — which is precisely the pattern reuse detection kills the
 *    family for. The stampede would not merely be wasteful; it would log the user out.
 *  - Retry-once, because the alternative is a loop. A request that is still refused after a
 *    successful rotation is refused for a reason refreshing cannot cure — a mismatched appId, a
 *    permission the user does not have — and trying again forever turns that into a hang.
 *  - The credential endpoints are excluded by name, because `auth.refresh` is itself a tRPC call.
 *    Refreshing a failed refresh is the infinite loop in its purest form, and excluding it
 *    structurally is stronger than relying on the error code to differ.
 *
 * OD-S5 REMAINS OPEN. The sessionStorage Bearer mirror is untouched here. Where cookies are blocked
 * entirely (Safari ITP, private browsing, WebViews) the refresh cookie is not sent either, so
 * refresh fails and the surface falls back to the OAuth path exactly as it did before S1. That is
 * the pre-existing behaviour preserved, not an endorsement of the mirror: whether that path should
 * survive at all is still an owner decision.
 */
import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { UNAUTHED_ERR_MSG } from "@shared/const";

/**
 * The procedures that mint or destroy credentials, which must never trigger a refresh.
 *
 * Named rather than pattern-matched on `auth.*`: `auth.me` is an ordinary read and *should*
 * recover from an expired token. Adding a path here is a deliberate act, and the test pins the
 * list so it cannot drift silently.
 */
export const CREDENTIAL_PATHS = ["auth.refresh", "auth.logout", "auth.revokeAll"] as const;

const isCredentialPath = (path: string): boolean =>
  (CREDENTIAL_PATHS as readonly string[]).includes(path);

/**
 * Is this the server saying the access credential has expired?
 *
 * Checks the error *code* first and falls back to the message. `protectedProcedure` throws
 * `UNAUTHORIZED` with `UNAUTHED_ERR_MSG`, but the message is user-facing copy and copy gets
 * rewritten; the code is the contract.
 */
export function isAuthExpiry(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  const code = (error.data as { code?: unknown } | null | undefined)?.code;
  if (code === "UNAUTHORIZED") return true;
  return error.message === UNAUTHED_ERR_MSG;
}

/** The whole decision, in one place, so the link cannot disagree with the tests. */
export function shouldAttemptRefresh(
  path: string,
  error: unknown,
  alreadyRetried: boolean
): boolean {
  if (alreadyRetried) return false;
  if (isCredentialPath(path)) return false;
  return isAuthExpiry(error);
}

export type RefreshGate = {
  /** Resolves true when the session was rotated, false when it could not be. Never rejects. */
  refresh: () => Promise<boolean>;
  inFlight: () => boolean;
};

/**
 * One rotation at a time, however many callers ask.
 *
 * Concurrent callers await the same promise. It is cleared once settled — on failure as well as on
 * success — so a later expiry can try again; a gate that latched would turn single-flight into
 * refresh-once-ever, and the user would be signed out at the second expiry rather than the first.
 *
 * Never rejects. A caller that is deciding whether to retry a request should not also have to
 * handle an exception from the thing it asked.
 */
export function createRefreshGate(runRefresh: () => Promise<boolean>): RefreshGate {
  let pending: Promise<boolean> | null = null;

  return {
    refresh() {
      if (pending) return pending;

      /*
       * `runRefresh` is invoked synchronously, not deferred through `Promise.resolve().then(...)`.
       * Deferring would leave `pending` set but the request unsent for a microtask, so a burst of
       * callers arriving in the same tick would all see the gate closed while nothing was actually
       * in flight — single-flight in appearance only.
       */
      let started: Promise<boolean>;
      try {
        started = runRefresh();
      } catch {
        started = Promise.resolve(false);
      }

      pending = started
        .catch(() => false)
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    inFlight: () => pending !== null,
  };
}

/**
 * Ask the server to rotate the session.
 *
 * A plain `fetch`, not a tRPC call through the client this link is installed in — going back
 * through the client would route the refresh through this very link, and structural impossibility
 * beats a guard that a later refactor can drop. `credentials: "include"` is what carries the
 * httpOnly cookies; nothing is read from the response but its status.
 */
export async function refreshViaHttp(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/trpc/auth.refresh", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    return response.ok;
  } catch {
    // Offline, DNS failure, the tab closing mid-flight. Not a session decision.
    return false;
  }
}

/**
 * The link. Sits above `httpBatchLink` so it observes a finished request and can run it again.
 */
export function sessionRefreshLink<TRouter extends AnyRouter>(deps: {
  refresh: () => Promise<boolean>;
  onSignedOut: () => void;
}): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) =>
      observable(observer => {
        let retried = false;
        let cancelled = false;
        let inner: { unsubscribe: () => void } = { unsubscribe: () => {} };

        const attempt = () => {
          inner = next(op).subscribe({
            next: value => observer.next(value),
            complete: () => observer.complete(),
            error: error => {
              if (!shouldAttemptRefresh(op.path, error, retried)) {
                observer.error(error);
                return;
              }
              // Set before awaiting: the flag is what makes this a retry rather than a loop, and
              // it must hold even if the rotation resolves immediately.
              retried = true;

              deps
                .refresh()
                .catch(() => false)
                .then(rotated => {
                  if (cancelled) return;
                  if (!rotated) {
                    // The original error is surfaced, not a synthesised one: the caller's error
                    // handling already knows what an expired session looks like.
                    deps.onSignedOut();
                    observer.error(error);
                    return;
                  }
                  attempt();
                });
            },
          });
        };

        attempt();
        return () => {
          cancelled = true;
          inner.unsubscribe();
        };
      });
}
