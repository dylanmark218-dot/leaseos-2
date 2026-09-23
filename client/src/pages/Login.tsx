/**
 * The `/login` route: the existing OAuth flow, behind a LeaseOS screen.
 *
 * This container decides only two things — why somebody is here, and where they
 * should land afterwards. Authentication itself is untouched:
 * `startLogin()` mints the state nonce and navigates, `/api/oauth/callback`
 * verifies it, and `createContext` reads the session cookie. Nothing in this
 * file authenticates anybody.
 *
 * **The return path is sanitised before it is stored, not after it is read.**
 * `safeReturnPath` allows one shape — a rooted, same-document path — so a link
 * like `/login?next=https://evil.example` cannot turn a genuine LeaseOS sign-in
 * into a step in somebody else's flow. That is the open-redirect hole, and it
 * is worth closing here rather than at the point of navigation, where a second
 * caller would have to remember.
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { safeReturnPath } from "@/portal/entryModel";
import { LoginView, type LoginReason } from "./LoginView";

/** Where the callback sends people back to. Kept out of the URL's control. */
const RETURN_KEY = "leaseos.returnTo";

function readReason(search: string): { reason: LoginReason; detail: string | null } {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error) return { reason: "auth_error", detail: error.slice(0, 200) };
  if (params.get("expired") !== null) return { reason: "expired", detail: null };
  if (params.get("signedOut") !== null) return { reason: "signed_out", detail: null };
  return { reason: "unauthenticated", detail: null };
}

export default function Login() {
  const [, navigate] = useLocation();
  const { loading, user } = useAuth();
  const [busy, setBusy] = useState(false);

  const search = typeof window === "undefined" ? "" : window.location.search;
  const { reason, detail } = readReason(search);

  // Stash the intended destination, sanitised. Session storage rather than the
  // URL, so the value that survives the round trip is one this app wrote.
  useEffect(() => {
    const next = new URLSearchParams(search).get("next");
    if (next === null) return;
    const safe = safeReturnPath(next);
    try {
      if (safe !== "/") window.sessionStorage.setItem(RETURN_KEY, safe);
      else window.sessionStorage.removeItem(RETURN_KEY);
    } catch {
      // Private browsing, or storage disabled. The person lands on "/", which
      // is the correct fallback rather than a reason to fail the sign-in.
    }
  }, [search]);

  // Already authenticated: leave. Re-sanitised on the way out, because what
  // comes back out of storage is not automatically what went in.
  useEffect(() => {
    if (loading || !user) return;
    let next = "/";
    try {
      next = safeReturnPath(window.sessionStorage.getItem(RETURN_KEY));
      window.sessionStorage.removeItem(RETURN_KEY);
    } catch {
      next = "/";
    }
    navigate(next, { replace: true });
  }, [loading, user, navigate]);

  return (
    <LoginView
      reason={reason}
      detail={detail}
      busy={busy || loading}
      onSignIn={() => {
        setBusy(true);
        // Called from the handler, never during render: startLogin writes the
        // one-time state cookie, and a render-phase call would desync it.
        startLogin();
      }}
    />
  );
}
