/**
 * B24 — the acting role as an authorization boundary.
 *
 * Pure over an injected grant source.
 *
 * B23 built its context from `listActivePermissions(userId)` — every permission
 * the account holds, across every role. An account that is both DRIVER and
 * DISPATCHER therefore saw dispatcher tiles on its driver board, and could save
 * them there, and the Add Widget picker offered them. The board asked which
 * role you were acting as and then ignored the answer, which makes a role
 * selector a label rather than a boundary.
 *
 * That matters beyond tidiness. A supervisor who drives on Saturdays is one
 * account with two jobs, and the reason to separate them is that the driver
 * board is what gets handed to a roadside officer, shown to a customer, or left
 * unlocked on a dash mount. Least privilege is the whole point of having modes.
 *
 * So permissions come from `(userId, role)`, the role must be currently held,
 * and everything downstream takes a `RoleActor` rather than a bag of
 * permissions a caller assembled.
 */

/**
 * Per-role grants. The repo's own grant tables are the implementation; this is
 * the shape the board needs from them.
 *
 * Returning `null` for a role the user does not hold is deliberate, and is not
 * the same as returning `[]`: an empty array is "this role grants nothing",
 * which is a legitimate configuration, while `null` is "you are not this".
 * Collapsing the two would let a revoked role resolve to an empty board rather
 * than a refusal.
 */
export type RoleGrantSource = {
  permissionsForRole(userId: number, roleKey: string): Promise<readonly string[] | null>;
};

export type RoleActor = {
  userId: number;
  /** The tenant from `resolveActingScope`, never from the request. */
  tenantId: string;
  roleKey: string;
  /** Effective for this role alone. */
  permissions: readonly string[];
  /**
   * The acting role, as a one-element list.
   *
   * The registry's `suggestedFor` ordering wants a role list, and handing it
   * the account's full set would leak the other roles back into the picker
   * through the side door — a driver board sorting dispatcher widgets to the
   * top because the account also dispatches.
   */
  roles: readonly [string];
};

export type ActorOutcome =
  | { ok: true; actor: RoleActor }
  | { ok: false; code: "ROLE_NOT_HELD"; detail: string };

/**
 * Build the actor for one role, or refuse.
 *
 * Fails closed: a role that is not held produces no actor, so there is no code
 * path where a board resolves with a partially-trusted identity.
 */
export async function actorForRole(
  src: RoleGrantSource,
  args: { userId: number; tenantId: string; roleKey: string },
): Promise<ActorOutcome> {
  const permissions = await src.permissionsForRole(args.userId, args.roleKey);
  if (permissions === null) {
    return {
      ok: false, code: "ROLE_NOT_HELD",
      // Names the role because the caller supplied it; says nothing about what
      // roles the account does hold.
      detail: `the caller is not currently acting as "${args.roleKey}"`,
    };
  }
  return {
    ok: true,
    actor: {
      userId: args.userId, tenantId: args.tenantId, roleKey: args.roleKey,
      permissions, roles: [args.roleKey],
    },
  };
}

/**
 * The resolve context for a board, derived from the actor.
 *
 * Exists so no call site assembles one by hand. Every field that decides what
 * the caller may see comes off the actor; only the device's own situation —
 * connected or not, which unit it is in — comes from the request, because the
 * server cannot know either.
 */
export function contextFor(
  actor: RoleActor,
  device: {
    connected: boolean;
    subjects: Readonly<Partial<Record<"self" | "unit" | "trailer" | "job" | "trip" | "org" | "branch", string>>>;
  },
) {
  return {
    actingUserId: actor.userId,
    roles: actor.roles,
    permissions: actor.permissions,
    connected: device.connected,
    implicitSubjects: device.subjects,
  } as const;
}
