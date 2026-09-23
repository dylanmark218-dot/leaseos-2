/**
 * Choose a workspace.
 *
 * Presentational and prop-driven. Every option comes from `portals.mine` — the
 * server's composed session, carrying each portal's own `displayName` and
 * `purpose` — so this file maintains no list of its own. A hand-written array
 * here would be a second definition of what a portal is, and the first time
 * somebody added one to `portalComposition.ts` the two would disagree.
 *
 * "Workspace" is the word on the screen because it is the word people use for
 * this. `portal` stays the word in the code, because that is what the
 * repository calls it and a second vocabulary is a second thing to keep in
 * step.
 *
 * **Showing an option is not granting it.** The list is what the server said
 * this session composes; `portals.panelsFor` refuses anything else
 * independently. Hiding a card is a courtesy, not a boundary.
 */

import { Button } from "@/components/ui/button";

export type ChooserOption = {
  portal: string;
  displayName: string;
  purpose: string;
};

export type PortalChooserProps = {
  options: readonly ChooserOption[];
  /** Portals that exist but this session does not reach, with their names. */
  notReached?: readonly ChooserOption[];
  /** A stored preference that was declined, so the screen can say why. */
  rejectedDefault?: string | null;
  /** A portal named in the URL that this session does not hold. */
  rejectedRequest?: string | null;
  onChoose: (portal: string) => void;
};

export function PortalChooser({
  options,
  notReached = [],
  rejectedDefault = null,
  rejectedRequest = null,
  onChoose,
}: PortalChooserProps) {
  return (
    <main className="min-h-screen bg-[#f6f8fb] p-6 text-[#172033] dark:bg-[#0d1522] dark:text-[#e8eef7]">
      <div className="mx-auto max-w-3xl py-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-[#6e7f96]">
          LeaseOS
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
          Choose a workspace
        </h1>
        <p className="mt-2 text-sm text-[#6e7f96]">
          You have access to more than one. You can switch at any time without
          signing out.
        </p>

        {rejectedRequest ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-[#f0c2bb] bg-[#fdf3f1] px-4 py-3 text-sm text-[#8a2f22] dark:border-[#5c2b24] dark:bg-[#2a1613] dark:text-[#f2b8ae]"
          >
            You do not have access to the workspace that link pointed to.
          </p>
        ) : null}

        {rejectedDefault ? (
          <p
            role="status"
            className="mt-4 rounded-xl border border-[#e5d5ae] bg-[#fdf8ec] px-4 py-3 text-sm text-[#7a5a16] dark:border-[#4d4020] dark:bg-[#231d10] dark:text-[#e3cc90]"
          >
            Your saved workspace is no longer available to you. Choose one below.
          </p>
        ) : null}

        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {options.map(o => (
            <li key={o.portal}>
              <button
                type="button"
                onClick={() => onChoose(o.portal)}
                className="h-full w-full rounded-2xl border border-[#dfe5ee] bg-white p-5 text-left shadow-sm transition hover:border-[#132a4a] hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#132a4a] dark:border-[#25344a] dark:bg-[#131d2e]"
              >
                <span className="block text-base font-semibold">{o.displayName}</span>
                <span className="mt-1 block text-sm leading-5 text-[#6e7f96]">
                  {o.purpose}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {notReached.length > 0 ? (
          <details className="mt-8 text-sm text-[#6e7f96]">
            <summary className="cursor-pointer">
              Workspaces you do not have access to
            </summary>
            {/* Named rather than hidden: "you don't hold a role that opens
                Safety" is a better answer than a gap somebody has to ask about.
                It reveals nothing — these are LeaseOS's own product surfaces. */}
            <ul className="mt-2 list-disc pl-5">
              {notReached.map(o => (
                <li key={o.portal}>{o.displayName}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </main>
  );
}

/**
 * What a session with no portal at all sees.
 *
 * Deliberately not solved by granting one. A person whose roles compose nothing
 * has an administration problem, and the screen that says so is more useful
 * than a screen that quietly lets them in somewhere harmless-looking.
 */
export function NoPortalAvailable({
  notReached = [],
  onSignOut,
}: {
  notReached?: readonly ChooserOption[];
  onSignOut?: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-6 text-[#172033] dark:bg-[#0d1522] dark:text-[#e8eef7]">
      <div className="w-full max-w-md rounded-[28px] border border-[#dfe5ee] bg-white p-8 text-center shadow-sm dark:border-[#25344a] dark:bg-[#131d2e]">
        <h1 className="text-xl font-semibold">No workspace available</h1>
        <p className="mt-3 text-sm leading-6 text-[#6e7f96]">
          Your account is signed in, but no LeaseOS workspace is open to it yet.
          Ask your administrator for the role you need.
        </p>
        {notReached.length > 0 ? (
          <p className="mt-4 text-xs text-[#8c9bb0]">
            {notReached.length} workspace{notReached.length === 1 ? "" : "s"} exist
            that your roles do not compose.
          </p>
        ) : null}
        {onSignOut ? (
          <Button onClick={onSignOut} variant="outline" className="mt-6 w-full">
            Sign out
          </Button>
        ) : null}
      </div>
    </main>
  );
}

/**
 * Two live organization memberships and no way to choose between them.
 *
 * `resolveActingScope` refuses this rather than picking one, and the refusal is
 * correct: choosing would silently decide which company a request writes into.
 * The screen says so plainly instead of pretending organization switching
 * exists — it does not, and `userRoleAssignments` has no organization scope for
 * it to switch. See `docs/register/PORTAL_ORG_SCOPE_DEFERRED.md`.
 */
export function OrganizationSelectionRequired({ detail }: { detail?: string | null }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-6 text-[#172033] dark:bg-[#0d1522] dark:text-[#e8eef7]">
      <div className="w-full max-w-md rounded-[28px] border border-[#dfe5ee] bg-white p-8 text-center shadow-sm dark:border-[#25344a] dark:bg-[#131d2e]">
        <h1 className="text-xl font-semibold">Organization selection required</h1>
        <p className="mt-3 text-sm leading-6 text-[#6e7f96]">
          This account is an active member of more than one organization. LeaseOS
          does not yet support choosing between them, so no workspace can be
          opened. Ask your administrator to end the membership you are not using.
        </p>
        {detail ? <p className="mt-4 text-xs text-[#8c9bb0]">{detail}</p> : null}
      </div>
    </main>
  );
}
