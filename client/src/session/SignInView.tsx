/**
 * The LeaseOS sign-in screen — the view.
 *
 * Pure: every fact arrives through props, every action leaves through a
 * callback. It is the one screen in the product that a person sees before the
 * server knows who they are, so it is also the one screen that must say the
 * least: it never names an organization, never hints whether an address is
 * known, and never distinguishes "wrong password" from "no such account".
 *
 * ## Why there is no password field here
 *
 * LeaseOS authenticates through the platform's OAuth provider —
 * `startLogin()` in `client/src/const.ts` mints a one-time nonce, writes the
 * `__Host-` state cookie and navigates. There is no local credential store, no
 * password column and no password hash anywhere in this schema, and inventing
 * a form that posts an email and a password to an endpoint that cannot check
 * them would be theatre with a login shape. The button below starts the real
 * authentication this deployment has.
 *
 * The props are shaped so a second method can be added without touching the
 * layout: `methods` is a list, and a future password or SSO method renders as
 * another entry rather than as a rewrite.
 *
 * It is built for a phone held in a cold truck cab as much as for a desk:
 * one large target, a visible focus ring, no hover-only affordance, and an
 * error that is associated with the control rather than floating beside it.
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export type SignInMethod = {
  key: string;
  label: string;
  /** What this method is, in a line. Read out with the button. */
  detail: string;
  onSelect: () => void;
};

export type SignInViewProps = {
  methods: readonly SignInMethod[];
  /** Why the person is here, when it was not simply "they opened the app". */
  notice?: string | null;
  /** A failure, stated without telling an attacker which half was wrong. */
  error?: string | null;
  busy?: boolean;
  /** Where they were going. Shown so the return is not a surprise. */
  intendedLabel?: string | null;
};

export function SignInView(p: SignInViewProps) {
  const errorId = "signin-error";
  const noticeId = "signin-notice";

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground"
      data-testid="sign-in"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">LeaseOS</h1>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {p.notice && (
            <p id={noticeId} className="text-sm text-muted-foreground" data-testid="sign-in-notice">
              {p.notice}
            </p>
          )}

          {p.error && (
            // `role="alert"` so a screen reader announces it when it appears,
            // and the text carries the meaning on its own — the colour is a
            // second signal, never the only one.
            <p
              id={errorId}
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="sign-in-error"
            >
              {p.error}
            </p>
          )}

          <div className="space-y-2">
            {p.methods.map(m => (
              <Button
                key={m.key}
                onClick={m.onSelect}
                disabled={p.busy}
                // A 44px target: gloved hands, a moving truck, a cracked screen.
                className="h-11 w-full text-base"
                aria-describedby={[p.error ? errorId : null, p.notice ? noticeId : null]
                  .filter(Boolean)
                  .join(" ") || undefined}
              >
                {p.busy ? "Opening sign-in…" : m.label}
              </Button>
            ))}
          </div>

          {p.methods.map(m => (
            <p key={`${m.key}-detail`} className="text-xs text-muted-foreground">
              {m.detail}
            </p>
          ))}

          {p.intendedLabel && (
            <p className="text-xs text-muted-foreground" data-testid="sign-in-intended">
              After signing in you will return to {p.intendedLabel}.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
