/**
 * Choose Organization / Choose Workspace — the view.
 *
 * Pure. It renders exactly the choices the server offered and has no opinion
 * about which ones exist: there is no client-side list of workspaces to filter,
 * because a list the client holds is a list the client can edit. An entry that
 * is not in `workspaces` was never composed for this session, and pressing it
 * is not possible because it is not drawn.
 *
 * That is presentation, not security. `session.selectWorkspace` re-derives the
 * same decision from the grant tables, and every procedure behind every
 * workspace refuses on its own. This screen exists so a person is not offered
 * a door that will not open, not so the door is locked.
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type ChooserOrganization = {
  orgRef: string;
  name: string;
  /** Employee, contractor, client — shown because it changes what the day looks like. */
  membershipType: string;
};

export type ChooserWorkspace = {
  key: string;
  label: string;
  description: string;
};

export type WorkspaceChooserViewProps = {
  /** The person, so a shared tablet shows whose session this is. */
  displayName?: string | null;
  organizations?: readonly ChooserOrganization[];
  activeOrgRef?: string | null;
  onSelectOrganization?: (orgRef: string) => void;
  workspaces: readonly ChooserWorkspace[];
  activeWorkspace?: string | null;
  onSelectWorkspace: (key: string) => void;
  busyKey?: string | null;
  error?: string | null;
  onSignOut?: () => void;
};

export function WorkspaceChooserView(p: WorkspaceChooserViewProps) {
  const organizations = p.organizations ?? [];
  const choosingOrganization = organizations.length > 1 && !p.activeOrgRef;

  return (
    <main
      className="mx-auto min-h-screen w-full max-w-3xl space-y-6 bg-background p-4 text-foreground sm:p-8"
      data-testid="workspace-chooser"
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">LeaseOS</h1>
        <p className="text-sm text-muted-foreground">
          {p.displayName ? `Signed in as ${p.displayName}` : "Signed in"}
        </p>
      </header>

      {p.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="chooser-error"
        >
          {p.error}
        </p>
      )}

      {organizations.length > 1 && (
        <section aria-labelledby="choose-organization" className="space-y-3">
          <div className="space-y-1">
            <h2 id="choose-organization" className="text-lg font-medium">
              Choose organization
            </h2>
            <p className="text-sm text-muted-foreground">
              You work in more than one company. LeaseOS will not guess which one.
            </p>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="organization-list">
            {organizations.map(o => {
              const current = o.orgRef === p.activeOrgRef;
              return (
                <li key={o.orgRef}>
                  <Button
                    variant={current ? "default" : "outline"}
                    // `aria-current` rather than colour alone: a screen reader
                    // and a monochrome screen both need to know which is active.
                    aria-current={current ? "true" : undefined}
                    className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-4 py-3 text-left"
                    disabled={p.busyKey === o.orgRef}
                    onClick={() => p.onSelectOrganization?.(o.orgRef)}
                    data-testid={`organization-${o.orgRef}`}
                  >
                    <span className="text-base font-medium">{o.name}</span>
                    <span className="text-xs opacity-80">
                      {o.membershipType}
                      {current ? " · current" : ""}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!choosingOrganization && (
        <section aria-labelledby="choose-workspace" className="space-y-3">
          <div className="space-y-1">
            <h2 id="choose-workspace" className="text-lg font-medium">
              Choose workspace
            </h2>
            <p className="text-sm text-muted-foreground">
              One account, the jobs you actually do. You can switch at any time without signing out.
            </p>
          </div>

          {p.workspaces.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">No workspace is open here</CardTitle>
                <CardDescription>
                  Ask an administrator at your company for the access your work needs.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="workspace-list">
              {p.workspaces.map(w => {
                const current = w.key === p.activeWorkspace;
                return (
                  <li key={w.key}>
                    <Button
                      variant={current ? "default" : "outline"}
                      aria-current={current ? "page" : undefined}
                      className="h-auto min-h-[4.5rem] w-full flex-col items-start gap-1 whitespace-normal px-4 py-3 text-left"
                      disabled={p.busyKey === w.key}
                      onClick={() => p.onSelectWorkspace(w.key)}
                      data-testid={`workspace-${w.key}`}
                    >
                      <span className="text-base font-medium">
                        {w.label}
                        {current ? " · current" : ""}
                      </span>
                      <span className="text-xs font-normal opacity-80">{w.description}</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {p.onSignOut && (
        <CardContent className="px-0">
          <Button variant="ghost" className="h-11 px-3" onClick={p.onSignOut}>
            Sign out
          </Button>
        </CardContent>
      )}
    </main>
  );
}
