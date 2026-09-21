/**
 * The gate the whole authenticated client sits behind.
 *
 * One tRPC call — `session.context` — and one pure decision — `gateScreen()` —
 * decide whether a person sees the sign-in screen, a chooser, a refusal, or the
 * application. Everything it renders it renders from the server's answer; it
 * holds no list of workspaces, no map of roles and no rule about who may see
 * what, because a rule held here is a rule that can be edited here.
 *
 * It is not security. Deleting this component would make the product unusable
 * and would not make a single unauthorized call succeed: every procedure behind
 * it goes through `roleProcedure`, which re-derives the decision from the grant
 * tables on every request. `server/sessionWorkspace.db.test.ts` proves that by
 * making the calls with no client at all.
 */

import { useCallback, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { AccessDeniedView } from "./AccessDeniedView";
import { SignInView } from "./SignInView";
import { WorkspaceChooserView } from "./WorkspaceChooserView";
import { gateScreen, intendedLabel, workspaceFromPath, type ClientSessionContext } from "./sessionModel";

export type SessionGateProps = {
  /** Rendered once the session resolves to a workspace this person holds. */
  children?: (session: { context: ClientSessionContext; workspace: string }) => React.ReactNode;
  /** Force the chooser, for the `/workspaces` route. */
  alwaysChoose?: boolean;
  /** Force the sign-in screen, for the `/login` route. */
  alwaysSignIn?: boolean;
};

export function SessionGate(p: SessionGateProps) {
  const [location, navigate] = useLocation();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { logout } = useAuth();
  const utils = trpc.useUtils();

  // What the URL names, and where the person was heading. Both are claims; the
  // server checks both and this component uses only what comes back.
  const requestedWorkspace = useMemo(() => workspaceFromPath(location), [location]);
  const intendedPath = useMemo(() => {
    if (typeof window === "undefined") return null;
    const next = new URLSearchParams(window.location.search).get("next");
    return next ?? (p.alwaysSignIn || p.alwaysChoose ? null : location);
  }, [location, p.alwaysSignIn, p.alwaysChoose]);

  const context = trpc.session.context.useQuery(
    {
      ...(requestedWorkspace ? { workspace: requestedWorkspace } : {}),
      ...(intendedPath ? { intendedPath } : {}),
    },
    { retry: false, refetchOnWindowFocus: true }
  );

  const selectWorkspace = trpc.session.selectWorkspace.useMutation();
  const selectOrganization = trpc.session.selectOrganization.useMutation();

  const onSelectWorkspace = useCallback(
    async (key: string) => {
      setBusyKey(key);
      setActionError(null);
      try {
        // The server decides. `landing` comes back from it rather than being
        // assembled here, so the client never navigates somewhere the server
        // did not name.
        const chosen = await selectWorkspace.mutateAsync({ workspace: key });
        await context.refetch();
        navigate(chosen.landing);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "That workspace could not be opened."
        );
      } finally {
        setBusyKey(null);
      }
    },
    [selectWorkspace, context, navigate]
  );

  const onSelectOrganization = useCallback(
    async (orgRef: string) => {
      setBusyKey(orgRef);
      setActionError(null);
      try {
        await selectOrganization.mutateAsync({ organization: orgRef });
        // B23.1 — the organization changed, so EVERY cached answer is now an
        // answer about the wrong company.
        //
        // Not just the session: My Day, the exception queue, the inbox, a
        // widget board, a job list. The server would refuse any action taken
        // from a stale screen — the boundary does not depend on this — but a
        // dispatcher looking at the previous employer's exception queue after
        // switching has been shown another company's operational data, and
        // that is a disclosure whether or not a button works.
        //
        // The whole cache, deliberately, rather than a list of keys somebody
        // has to remember to extend when a query is added.
        await utils.invalidate();
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "That organization could not be opened."
        );
      } finally {
        setBusyKey(null);
      }
    },
    [selectOrganization, utils]
  );

  const onSignOut = useCallback(async () => {
    await logout();
    navigate("/login");
  }, [logout, navigate]);

  const data = context.data as ClientSessionContext | undefined;
  const screen = p.alwaysSignIn
    ? ({ kind: "signin", notice: null } as const)
    : gateScreen({
        context: data,
        error: context.error?.data as { code?: string } | null,
        loading: context.isLoading,
        requestedWorkspace: p.alwaysChoose ? null : requestedWorkspace,
      });

  const signIn = useCallback(() => {
    // `startLogin` has side effects and must be called at the moment of
    // navigation, never during render — it mints the one-time nonce and writes
    // the state cookie, and a second call desyncs an in-flight login.
    startLogin(data?.intendedPath ?? intendedPath ?? undefined);
  }, [data?.intendedPath, intendedPath]);

  if (screen.kind === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-8 text-sm text-muted-foreground">
        <p role="status">Checking your LeaseOS access…</p>
      </div>
    );
  }

  if (screen.kind === "signin") {
    return (
      <SignInView
        methods={[
          {
            key: "leaseos",
            label: "Sign in to LeaseOS",
            detail:
              "LeaseOS uses your organization's single sign-on. You will be returned here once it confirms who you are.",
            onSelect: signIn,
          },
        ]}
        notice={screen.notice}
        error={actionError}
        intendedLabel={intendedLabel(data?.intendedPath ?? intendedPath)}
      />
    );
  }

  if (screen.kind === "denied") {
    const fallback = data?.availableWorkspaces?.[0];
    return (
      <AccessDeniedView
        kind={screen.denial}
        reason={screen.reason ?? actionError ?? null}
        {...(fallback
          ? { onGoToWorkspace: () => navigate(fallback.landing), workspaceLabel: fallback.label }
          : {})}
        onSignOut={onSignOut}
      />
    );
  }

  if (screen.kind === "chooser") {
    return (
      <WorkspaceChooserView
        displayName={data?.user?.name ?? data?.user?.email ?? null}
        organizations={(data?.availableOrganizations ?? []).map(o => ({
          orgRef: o.orgRef,
          name: o.name,
          membershipType: o.membershipType,
        }))}
        activeOrgRef={data?.activeOrganization?.orgRef ?? null}
        onSelectOrganization={onSelectOrganization}
        workspaces={(data?.availableWorkspaces ?? []).map(w => ({
          key: w.key,
          label: w.label,
          description: w.description,
        }))}
        activeWorkspace={data?.activeWorkspace ?? null}
        onSelectWorkspace={onSelectWorkspace}
        busyKey={busyKey}
        error={actionError}
        onSignOut={onSignOut}
      />
    );
  }

  return <>{p.children?.({ context: data!, workspace: screen.workspace })}</>;
}
