/**
 * The LeaseOS sign-in landing.
 *
 * Presentational and prop-driven, like `DisposalFinderView` and the rest of the
 * tested screens here, so its states can be asserted without a browser session
 * or a real identity provider.
 *
 * **There is no password field, and that is the architecture rather than an
 * omission.** LeaseOS authenticates through the platform's OAuth flow —
 * `client/src/const.ts` mints the one-time state nonce and navigates;
 * `server/_core/oauth.ts` checks that nonce against the `__Host-` cookie on the
 * way back. A credential form here would be a second authentication system
 * sitting beside the real one, with its own password storage to get wrong, and
 * the session it produced would still have to be honoured by a server that
 * knows nothing about it.
 *
 * `onSignIn` is called from an event handler and never during render. The
 * reason is in `const.ts`: `startLogin()` writes the state cookie as a side
 * effect, so a stray render-phase call would overwrite the nonce of an
 * in-flight login and the callback would reject it as "invalid oauth state".
 */

import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

/** What brought someone to this screen. Each one says something different. */
export type LoginReason =
  | "unauthenticated"
  | "expired"
  | "auth_error"
  | "signed_out";

export type LoginViewProps = {
  reason: LoginReason;
  /** True while the session is still being established. */
  busy: boolean;
  /** Provider or callback detail, when there is any worth showing. */
  detail?: string | null;
  onSignIn: () => void;
};

const HEADLINE: Record<LoginReason, string> = {
  unauthenticated: "Sign in to LeaseOS",
  expired: "Your session has expired",
  auth_error: "Sign-in did not complete",
  signed_out: "You have been signed out",
};

const EXPLANATION: Record<LoginReason, string> = {
  unauthenticated:
    "Field work, dispatch, maintenance, safety and billing on one operational record.",
  expired: "Sessions end after a period of inactivity. Sign in again to continue.",
  auth_error: "Nothing was changed. You can try signing in again.",
  signed_out: "Sign in again when you are ready.",
};

export function LoginView({ reason, busy, detail, onSignIn }: LoginViewProps) {
  const isProblem = reason === "expired" || reason === "auth_error";

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-6 text-[#172033] dark:bg-[#0d1522] dark:text-[#e8eef7]">
      <div className="w-full max-w-md rounded-[28px] border border-[#dfe5ee] bg-white p-8 text-center shadow-[0_24px_80px_rgba(31,52,85,0.12)] sm:p-10 dark:border-[#25344a] dark:bg-[#131d2e]">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#132a4a] text-white shadow-lg shadow-[#132a4a]/20">
          <Activity className="h-7 w-7" aria-hidden="true" />
        </div>

        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-[#6e7f96]">
          LeaseOS
        </p>

        <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
          {HEADLINE[reason]}
        </h1>

        <p className="mt-3 text-sm leading-6 text-[#6e7f96]">{EXPLANATION[reason]}</p>

        {isProblem && detail ? (
          // `role="alert"` rather than colour alone: this screen is read in a
          // cab and in a shop, and a red border is not an error message.
          <p
            role="alert"
            className="mt-4 rounded-xl border border-[#f0c2bb] bg-[#fdf3f1] px-4 py-3 text-left text-sm text-[#8a2f22] dark:border-[#5c2b24] dark:bg-[#2a1613] dark:text-[#f2b8ae]"
          >
            {detail}
          </p>
        ) : null}

        <Button
          onClick={onSignIn}
          disabled={busy}
          aria-busy={busy}
          className="mt-8 h-11 w-full rounded-xl bg-[#ff6b42] font-semibold text-white shadow-lg shadow-[#ff6b42]/20 hover:bg-[#ed5c35]"
        >
          {busy ? "Signing in…" : reason === "unauthenticated" ? "Sign in" : "Try again"}
        </Button>

        <p className="mt-6 text-xs leading-5 text-[#8c9bb0]">
          LeaseOS uses your organization's single sign-on. You will be returned
          here once it completes.
        </p>
      </div>
    </main>
  );
}
