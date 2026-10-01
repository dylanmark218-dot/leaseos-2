/**
 * The refusal screens — the view.
 *
 * One component for every way a signed-in person can be told "not here": no
 * membership, no workspace, a workspace they do not hold, a session that
 * expired, an authorization the server could not evaluate.
 *
 * Two rules it keeps:
 *
 *   It says what to DO. "Insufficient permission" leaves a driver at 5am with
 *   no next step; "ask your dispatcher for the mechanic role" is the same
 *   refusal with an action attached.
 *
 *   It says nothing else. No organization names, no record identifiers, no
 *   "that job belongs to Northern Hauling", no list of which roles would have
 *   worked. A refusal is not a directory, and a person who reached this screen
 *   by editing a URL learns only that the URL did not work.
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export type AccessDeniedKind =
  | "no_membership"
  | "no_workspace"
  | "workspace_not_open"
  | "session_expired"
  | "authorization_unavailable"
  | "offline_authorization_unavailable";

export type AccessDeniedViewProps = {
  kind: AccessDeniedKind;
  /** The server's own sentence, when it sent one. Preferred over the default. */
  reason?: string | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
  /** Back to a workspace they do hold, when there is one. */
  onGoToWorkspace?: () => void;
  workspaceLabel?: string | null;
};

const COPY: Record<AccessDeniedKind, { title: string; body: string }> = {
  no_membership: {
    title: "Your LeaseOS membership is not active",
    body: "Access ends with the membership, not with the account. Ask an administrator at your company to restore it.",
  },
  no_workspace: {
    title: "No LeaseOS workspace is assigned to you yet",
    body: "You are signed in and your company knows you, but no duties have been granted. Ask an administrator for the access your work needs.",
  },
  workspace_not_open: {
    title: "That workspace is not open to your account",
    body: "Workspaces follow the duties you have been granted. If this is work you now do, ask an administrator to grant it.",
  },
  session_expired: {
    title: "Your session has ended",
    body: "Sign in again to continue. Anything captured on this device is still held and will sync once you are back in.",
  },
  authorization_unavailable: {
    title: "LeaseOS could not confirm your access",
    body: "Nothing has been opened, because an access question that cannot be answered is not answered in your favour. Try again in a moment.",
  },
  offline_authorization_unavailable: {
    title: "This needs a connection",
    body: "You can keep recording what you observe; this action is decided by the server and will not be decided on the device. It will be available as soon as you have signal.",
  },
};

export function AccessDeniedView(p: AccessDeniedViewProps) {
  const copy = COPY[p.kind];
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground"
      data-testid="access-denied"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          {/* The heading carries the meaning; nothing here depends on colour. */}
          <h1 className="text-xl font-semibold tracking-tight" data-testid="access-denied-title">
            {copy.title}
          </h1>
          <CardDescription data-testid="access-denied-body">{p.reason ?? copy.body}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {p.onGoToWorkspace && (
            <Button className="h-11" onClick={p.onGoToWorkspace}>
              {p.workspaceLabel ? `Go to ${p.workspaceLabel}` : "Go to my workspace"}
            </Button>
          )}
          {p.onSignIn && (
            <Button className="h-11" onClick={p.onSignIn}>
              Sign in
            </Button>
          )}
          {p.onSignOut && (
            <Button variant="outline" className="h-11" onClick={p.onSignOut}>
              Sign out
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
