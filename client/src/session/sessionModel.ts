/**
 * What the shell should be showing right now — decided in one pure function.
 *
 * The gate has five outcomes and they are mutually exclusive, so they are a
 * discriminated union rather than five booleans a component re-derives at four
 * different places. A component that computes "should I show the chooser?"
 * inline is a component where one branch eventually disagrees with another,
 * and the branch that disagrees permissively is the one nobody notices.
 *
 * Nothing here is security. The server has already decided everything this
 * function reads; this only chooses which screen renders the decision. The
 * matching proofs are `server/workspaceAccess.test.ts` (what the server
 * decides) and `server/sessionWorkspace.db.test.ts` (that the decision holds
 * with no client at all).
 */

import type { AccessDeniedKind } from "./AccessDeniedView";
import type { SessionContext } from "../../../server/_core/workspaceAccess";

/** The context as it crosses the wire: the resolver's answer plus the checked destination. */
export type ClientSessionContext = SessionContext & { intendedPath?: string | null };

export type GateScreen =
  | { kind: "loading" }
  | { kind: "signin"; notice: string | null }
  | { kind: "denied"; denial: AccessDeniedKind; reason: string | null }
  | { kind: "chooser" }
  | { kind: "ready"; workspace: string };

/** A tRPC error as far as this decision is concerned. */
export type GateError = { code?: string | null } | null | undefined;

const codeOf = (error: GateError): string | null =>
  (error && typeof error === "object" && typeof error.code === "string" ? error.code : null);

/**
 * Which screen, from what the server said.
 *
 * `requestedWorkspace` is what the URL names. It never widens anything: the
 * server has already reduced it to `activeWorkspace` if it was open and
 * ignored it if it was not, so the only thing this function does with it is
 * notice the disagreement and say "not open to you" instead of silently
 * swapping the person into a different screen than the one they asked for.
 * A silent swap is how a person comes to believe they are in Dispatch while
 * looking at Field.
 */
export function gateScreen(args: {
  context: ClientSessionContext | undefined;
  error?: GateError;
  loading?: boolean;
  /** The workspace named by the route, if any. */
  requestedWorkspace?: string | null;
}): GateScreen {
  const code = codeOf(args.error);

  if (code === "UNAUTHORIZED") {
    return { kind: "signin", notice: "Your session has ended. Sign in to continue." };
  }
  // Any other failure is an access question that could not be answered, and an
  // unanswered access question is not answered in the caller's favour.
  if (code) {
    return {
      kind: "denied",
      denial: "authorization_unavailable",
      reason: null,
    };
  }
  if (args.loading || !args.context) return { kind: "loading" };

  const c = args.context;
  switch (c.state) {
    case "unauthenticated":
      return { kind: "signin", notice: null };
    case "no_membership":
      return { kind: "denied", denial: "no_membership", reason: c.reason };
    case "no_workspace":
      return { kind: "denied", denial: "no_workspace", reason: c.reason };
    case "organization_required":
      return { kind: "chooser" };
    case "ready":
      break;
    default:
      // An unrecognized state is not a state to render optimistically.
      return { kind: "denied", denial: "authorization_unavailable", reason: null };
  }

  if (!c.activeWorkspace) {
    return { kind: "denied", denial: "no_workspace", reason: c.reason };
  }

  const open = new Set<string>(c.availableWorkspaces.map(w => w.key));
  if (args.requestedWorkspace && !open.has(args.requestedWorkspace)) {
    return { kind: "denied", denial: "workspace_not_open", reason: null };
  }

  // Several jobs and nothing chosen yet: ask. One job — however many personal
  // surfaces ride along — goes straight in.
  if (!args.requestedWorkspace && c.workspaceChoiceRequired) {
    return { kind: "chooser" };
  }

  return { kind: "ready", workspace: args.requestedWorkspace ?? c.activeWorkspace };
}

/**
 * The workspace named by a LeaseOS route, or null.
 *
 * Reads only the shape the shell actually uses (`/portal/<key>/...`). It does
 * not validate the key — the server does that, and a client-side allowlist
 * here would be a second vocabulary to keep in step.
 */
export function workspaceFromPath(pathname: string): string | null {
  const m = /^\/portal\/([a-z_]+)(?:\/|$)/.exec(pathname);
  return m ? m[1]! : null;
}

/**
 * The line that tells a person where they will be returned to.
 *
 * Purely cosmetic, and deliberately not a URL: showing an attacker-supplied
 * string back to the person is how a redirect notice becomes a phishing lure.
 * The path has already been checked server-side; this shows only its shape.
 */
export function intendedLabel(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/")) return null;
  const clean = path.split(/[?#]/, 1)[0] ?? "";
  return clean === "/" ? null : `the page you were opening (${clean.slice(0, 60)})`;
}
