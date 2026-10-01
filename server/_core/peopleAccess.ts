/**
 * B23.2 — People & Access, as decisions rather than queries.
 *
 * Everything here is pure, so each rule can be tested against the exact
 * situation it exists to refuse rather than only against a database that
 * happens to be in that state. The router stores; this decides.
 *
 * Three rules carry real weight, and none of them is obvious from the schema:
 *
 *   An invitation is claimed by a TOKEN and an authenticated identity, never by
 *   an email address. `GetUserInfoResponse` returns `email` with no verification
 *   flag, so LeaseOS cannot tell an address somebody proved from one they typed.
 *
 *   A default workspace is a preference, never a grant. It is accepted only if
 *   the roles actually compose it, and `workspaceAccess` ignores it anyway if
 *   they later stop doing so — so a stale one can never become authority.
 *
 *   An organization must keep one administrator. Removing the last one strands
 *   the company: `records.roles.grant` needs `roles.grant`, and
 *   `bootstrapManagementRole` is keyed to a target's membership rather than
 *   being a general recovery path.
 */

import { INVITATION_TTL_MS, invitationCheck, newToken, sha256 } from "./externalIdentityPolicy";
import { isDomainRole, permissionsFor, type DomainRole } from "./recordsAuthorization";
import { workspacesFor, type WorkspaceKey, type WorkspaceOption } from "./workspaceAccess";

export { INVITATION_TTL_MS, newToken, sha256 };

/**
 * The roles a tenant administrator may confer, and what each one means.
 *
 * Derived from `GRANTABLE_ROLES` in the router rather than restated: a second
 * list is a second thing to forget to update. The finance roles (bookkeeper,
 * payroll_admin, tax_preparer, controller, external_accountant) are absent
 * because they are granted by whatever process owns the books.
 *
 * The descriptions are for an administrator choosing access, and each is
 * deliberately about the WORK rather than the permission count — but none of
 * them promises a capability the role does not actually carry. The workspace
 * preview beside them is computed, not written here.
 */
export const ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  driver: "Field jobs, trips, loads, inspections, hours of service and field paperwork.",
  dispatcher: "Dispatch and assignment: who goes where, and what they are carrying.",
  mechanic: "Maintenance work: defects, work orders and the shop floor.",
  shop_lead: "Everything a mechanic does, plus releasing a unit back to service.",
  safety: "Safety and compliance: incidents, investigations and out-of-service orders.",
  office: "Office administration, billing support and document workflows.",
  management: "Organization administration, including managing people and their access.",
  hr: "Hiring, onboarding, training records and offboarding.",
  legal: "Legal holds, retention decisions and disclosure packages.",
  auditor: "Read-only access for audit and regulatory review.",
};

/** A role this surface may confer. Anything else is refused by name. */
export function isGrantableRole(role: string, grantable: readonly string[]): role is DomainRole {
  return isDomainRole(role) && grantable.includes(role);
}

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

export type InvitationStatus = "pending" | "accepted" | "cancelled";

export type InvitationRow = {
  orgRef: string;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
};

/**
 * What an administrator sees, which is not what the table stores.
 *
 * `expired` is computed here rather than stored, because a stored "expired" is
 * only as true as the last sweeper run and wrong in the window before it.
 */
export type InvitationView = InvitationStatus | "expired";

export function invitationView(row: InvitationRow, now: Date): InvitationView {
  if (row.status === "pending" && now >= row.expiresAt) return "expired";
  return row.status;
}

/**
 * May this invitation be accepted, by this caller, right now?
 *
 * Delegates the pending/expired question to `invitationCheck`, the same
 * function the external portal uses, and adds the two this surface owns:
 * the organization must match the row, and an existing live membership makes
 * acceptance pointless rather than dangerous.
 *
 * Every refusal is a sentence an operator can act on, and none of them names
 * another company.
 */
export function acceptanceCheck(args: {
  invitation: InvitationRow | null;
  /** Organization the row says; passed separately so a caller cannot skip the comparison. */
  organizationOfRow: string | null;
  alreadyLiveMember: boolean;
  now: Date;
}): { allowed: boolean; reason: string | null; outcome: "ok" | "not_found" | "refused" | "already_member" } {
  if (!args.invitation || !args.organizationOfRow) {
    // A token that matches nothing and a token for a row somebody cancelled
    // long ago are the same answer on purpose.
    return { allowed: false, reason: "That invitation is not valid", outcome: "not_found" };
  }
  const base = invitationCheck(
    {
      status: args.invitation.status === "pending" ? "invited" : "revoked",
      invitationExpiresAt: args.invitation.expiresAt,
      acceptedAt: args.invitation.acceptedAt,
    },
    args.now
  );
  if (!base.allowed) {
    const reason =
      args.invitation.status === "accepted"
        ? "That invitation has already been accepted"
        : args.invitation.status === "cancelled"
          ? "That invitation was cancelled"
          : "That invitation has expired — ask for a new one";
    return { allowed: false, reason, outcome: "refused" };
  }
  if (args.alreadyLiveMember) {
    // Idempotent rather than an error: the person is where the invitation
    // wanted them. Re-granting roles on top would be a silent privilege change.
    return { allowed: false, reason: "You are already a member of this organization", outcome: "already_member" };
  }
  return { allowed: true, reason: null, outcome: "ok" };
}

/** The invitation's expiry, from one policy rather than a number repeated per call site. */
export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

/* ------------------------------------------------------------------ */
/* Default workspace                                                   */
/* ------------------------------------------------------------------ */

/**
 * The workspaces a set of roles actually opens, through the canonical resolver.
 *
 * Used for the administrator's preview and for validating a default workspace.
 * Both must be the same computation or the preview is a promise the server does
 * not keep.
 */
export function workspaceOptionsForRoles(roles: readonly string[]): WorkspaceOption[] {
  const held = roles.filter(isDomainRole);
  // Both axes, exactly as the session resolver computes them: a role composes a
  // workspace only when the caller ALSO holds at least one capability that
  // workspace is built around. Passing roles alone would preview a screen the
  // real resolver would not open.
  return workspacesFor({ roles: held, permissions: permissionsFor(held) });
}

export function workspacesForRoles(roles: readonly string[]): WorkspaceKey[] {
  return workspaceOptionsForRoles(roles).map(w => w.key);
}

/**
 * A default workspace is accepted only if the roles compose it.
 *
 * `null` clears it and is always allowed. Anything else must be a workspace the
 * member holds — otherwise an administrator could type `management` for a driver
 * and, if `workspaceAccess` ever stopped filtering, hand over a portal.
 * It filters today; this refuses to rely on that alone.
 */
export function defaultWorkspaceCheck(args: {
  requested: string | null;
  roles: readonly string[];
}): { allowed: boolean; reason: string | null } {
  if (args.requested == null) return { allowed: true, reason: null };
  const open = workspacesForRoles(args.roles);
  if (!(open as readonly string[]).includes(args.requested)) {
    return {
      allowed: false,
      reason: `Not a workspace these roles open — choose one of: ${open.join(", ") || "(none)"}`,
    };
  }
  return { allowed: true, reason: null };
}

/* ------------------------------------------------------------------ */
/* Last administrator                                                  */
/* ------------------------------------------------------------------ */

/**
 * Would this change leave the organization with no administrator?
 *
 * `remaining` is counted inside the same transaction as the write, over rows
 * locked FOR UPDATE — two administrators removing each other concurrently must
 * not both read "one other exists" and both proceed. This function is the rule;
 * the locking is the router's job and the reason it cannot be a client warning.
 *
 * Deliberately phrased as "would this leave zero" rather than "is the target an
 * administrator", because the safe answer depends on what is left, not on who
 * is going.
 */
export function lastAdministratorCheck(args: {
  /** Live `management` grants in this organization, excluding the one being removed. */
  remainingAfterChange: number;
  organizationName: string;
}): { allowed: boolean; reason: string | null } {
  if (args.remainingAfterChange > 0) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason:
      `This is the last management access in ${args.organizationName}. ` +
      "Appoint another administrator first — removing this one would leave nobody able to grant access, " +
      "and there is no self-service way back.",
  };
}

/* ------------------------------------------------------------------ */
/* Person view                                                         */
/* ------------------------------------------------------------------ */

export type PersonAccess = {
  userId: number;
  displayName: string;
  membershipRef: string;
  membershipStatus: "active" | "suspended" | "ended";
  membershipType: string;
  roles: DomainRole[];
  workspaces: WorkspaceKey[];
  defaultWorkspace: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** True when status, organization status and term all say live right now. */
  live: boolean;
};

/**
 * One person's access, as the administrator of ONE organization sees it.
 *
 * Takes only rows the caller's organization owns. There is no parameter here
 * through which another company's roles or memberships could arrive, which is
 * the point: the isolation is in the shape of the input, not in a filter
 * somebody has to remember to apply.
 */
export function personAccess(args: {
  userId: number;
  displayName: string;
  membership: {
    membershipRef: string;
    status: "active" | "suspended" | "ended";
    membershipType: string;
    defaultWorkspace: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  };
  organizationActive: boolean;
  rolesInThisOrganization: readonly string[];
  now: Date;
}): PersonAccess {
  const roles = args.rolesInThisOrganization.filter(isDomainRole);
  const m = args.membership;
  const live =
    args.organizationActive &&
    m.status === "active" &&
    m.effectiveFrom.getTime() <= args.now.getTime() &&
    (!m.effectiveTo || m.effectiveTo.getTime() > args.now.getTime());
  return {
    userId: args.userId,
    displayName: args.displayName,
    membershipRef: m.membershipRef,
    membershipStatus: m.status,
    membershipType: m.membershipType,
    roles,
    // Revoking the last role removes the workspace, because the workspace was
    // never stored — it is recomputed from the roles every time.
    workspaces: workspacesForRoles(roles),
    defaultWorkspace: m.defaultWorkspace,
    effectiveFrom: m.effectiveFrom,
    effectiveTo: m.effectiveTo,
    live,
  };
}

/** Digest a raw token the same way the invitation was stored. */
export function digestToken(raw: string): string {
  return sha256(raw);
}
