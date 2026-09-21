/**
 * v23.26 — one identity, several jobs: the workspace resolver.
 *
 * Pure. No network, no database, no clock of its own. Everything it decides is
 * decided from values a caller loaded server-side, which is what makes it
 * testable and what makes it safe to call from the gate.
 *
 * ## The chain, and why each link is separate
 *
 *     Identity  →  Authentication  →  Membership  →  Tenant scope
 *               →  Capability      →  Workspaces  →  Selection
 *               →  the server's own per-operation refusal
 *
 * `authenticate` answers *who are you*. `resolveActingScope` answers *which
 * company are you acting for*. `authorize()` in `recordsAuthorization.ts`
 * answers *may you perform this operation*. This module answers the one
 * question none of them answered: *which LeaseOS interface should you be
 * looking at*, given everything the other three already established.
 *
 * It answers that and nothing more. A workspace is a window. It never grants a
 * permission, it never widens a scope, and switching it changes no authority —
 * `session.selectWorkspace` refuses a workspace the caller cannot open, and
 * every procedure behind every workspace still goes through `roleProcedure`
 * exactly as it did before this file existed. A person who edits their client
 * state to say `activeWorkspace: "management"` gets a differently-shaped
 * screen whose every call is refused, which is the point.
 *
 * ## Why there is no second registry
 *
 * `portalComposition.ts` already holds the registry: which portals exist, which
 * roles compose them, which permissions each is built around. A workspace IS a
 * portal — the word the login flow uses for the thing the shell already calls a
 * portal — so this module projects that registry rather than restating it. Two
 * lists of "what screens exist" is two answers the day someone edits one.
 *
 * ## Two conditions, both necessary
 *
 * A workspace is offered when BOTH hold:
 *
 *   1. the caller holds a role that composes it (`composedFrom`), and
 *   2. the caller holds at least one of the capabilities it is built around
 *      (`builtAround`).
 *
 * Condition 1 alone is what the shell did before, and it is a role model
 * wearing a capability label: narrowing what a role may do left the screen
 * exactly where it was. Condition 2 makes the capability load-bearing — revoke
 * every capability a workspace is built around and the workspace goes with
 * them, whether or not the role name survives.
 *
 * Condition 2 is `any-of` rather than `all-of` on purpose. A workspace is a
 * window onto a set of capabilities; holding none of them means there is
 * nothing behind the window, while holding some of them is the ordinary case —
 * a bookkeeper and a payroll administrator both belong in Finance and hold
 * different halves of it.
 *
 * Adding both conditions can only ever remove a workspace relative to the old
 * role-only composition, never add one. That direction is deliberate: this
 * change must not hand anybody a screen they did not have yesterday.
 */

import {
  PORTALS,
  type PortalKey,
  type PortalSurface,
} from "./portalComposition";
import {
  isDomainRole,
  permissionsFor,
  UNIVERSAL_PERMISSIONS,
  type DomainRole,
  type Permission,
  type RoleGrant,
} from "./recordsAuthorization";

/** A workspace is a portal. The alias exists so the login flow can say what it means. */
export type WorkspaceKey = PortalKey;

/**
 * Which workspace opens first for someone who holds several.
 *
 * Most operational first: a person who both drives and dispatches is, at the
 * moment they sign in on a phone at 5am, far more likely to be driving. The
 * order is server-owned because the default workspace is part of the answer
 * the server gives, not a preference the client invents.
 *
 * `client/src/portal/viewModels.ts` holds the same order for the in-shell
 * switcher, and `workspaceAccess.test.ts` fails if the two drift apart.
 */
export const WORKSPACE_ORDER: readonly WorkspaceKey[] = [
  "incident_emergency",
  "field_workforce",
  "dispatch_operations",
  "fleet_maintenance",
  "office_administration",
  "finance_billing",
  "safety_compliance",
  "hr_workforce",
  "management",
  "executive",
  "field_leadership",
  "sales_customer",
  "worker_self_service",
  "auditor_regulator",
  "customer",
  "vendor_facility",
] as const;

/**
 * Portals reachable by an EXTERNAL identity only.
 *
 * They compose from no domain role and are built around no internal
 * permission, so both conditions already exclude them. Naming them as well is
 * defence in depth: a future edit that gives the customer portal a role or a
 * permission by accident would otherwise hand an employee session an
 * external-facing screen, and `portalRouter` — the one surface that serves
 * these — is gated by `externalProcedure`, never by a user session.
 */
export const EXTERNAL_ONLY_WORKSPACES: readonly WorkspaceKey[] = [
  "customer",
  "vendor_facility",
] as const;

/**
 * Workspaces that are a person rather than a job.
 *
 * "My LeaseOS" composes from every domain role, because every person with a
 * role is a person: their own pay, their own expenses, their own training,
 * their own record of what LeaseOS holds about them. It is therefore present
 * for everybody and must not be what makes a chooser appear — a driver with
 * Field and My LeaseOS holds ONE job and should land in it, not be asked to
 * pick between doing their job and reading their payslip.
 *
 * It stays in the switcher, where it belongs. It is only excluded from the
 * count that decides whether the question is worth asking.
 */
export const PERSONAL_WORKSPACES: readonly WorkspaceKey[] = ["worker_self_service"] as const;

/** Workspaces that represent a job this person does. */
export function jobWorkspaces(
  available: readonly WorkspaceOption[]
): WorkspaceOption[] {
  return available.filter(w => !(PERSONAL_WORKSPACES as readonly string[]).includes(w.key));
}

/**
 * Is the chooser worth showing?
 *
 * Only when this person does more than one job here. One job — however many
 * personal surfaces ride along — goes straight in.
 */
export function requiresWorkspaceChoice(
  available: readonly WorkspaceOption[]
): boolean {
  return jobWorkspaces(available).length > 1;
}

/* ------------------------------------------------------------------ */
/* Inputs — what a caller must load server-side                        */
/* ------------------------------------------------------------------ */

/** One organization the caller could act for, as the membership tables hold it. */
export type MembershipFact = {
  membershipRef: string;
  orgRef: string;
  organizationName: string;
  /** The organization's own status. A suspended company opens for nobody. */
  organizationStatus: "active" | "suspended" | "closed";
  membershipType: "employee" | "contractor" | "client" | "system";
  membershipStatus: "active" | "suspended" | "ended";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  branchId: string | null;
  /** The workspace this person last chose here. A preference, never an authority. */
  defaultWorkspace: string | null;
};

export type SessionIdentity = {
  id: number;
  name: string | null;
  email: string | null;
};

export type SessionContextInput = {
  /** Null when the request carried no valid session. */
  user: SessionIdentity | null;
  /** Every membership row for this user, whatever its status. */
  memberships: readonly MembershipFact[];
  /** Every un-revoked role grant for this user. */
  grants: readonly RoleGrant[];
  /** What the client asked for. Verified here; never believed. */
  requestedOrgRef?: string | null;
  requestedWorkspace?: string | null;
  now: Date;
  /** The tenant a deployment with no organizations acts as. */
  singleTenantId: string;
};

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export type SessionState =
  /** No valid session. Show the sign-in screen; disclose nothing else. */
  | "unauthenticated"
  /** Authenticated, but every membership this person had is over or suspended. */
  | "no_membership"
  /** Several organizations and no verified selection. Ask; never guess. */
  | "organization_required"
  /** In an organization, but no workspace is open to them. */
  | "no_workspace"
  /** One organization resolved, at least one workspace open. */
  | "ready";

export type OrganizationOption = {
  orgRef: string;
  name: string;
  membershipRef: string;
  membershipType: MembershipFact["membershipType"];
  branchId: string | null;
};

export type WorkspaceOption = {
  key: WorkspaceKey;
  /** The chooser's button text. */
  label: string;
  /** The line under it, in the words a holder of that workspace would use. */
  description: string;
  /** Where entering it lands, on the shell's own route shape. */
  landing: string;
  /**
   * The capabilities this workspace is built around that the caller actually
   * holds. Informational for the screen; the API enforces each one itself.
   */
  capabilities: Permission[];
};

export type SessionContext = {
  state: SessionState;
  user: SessionIdentity | null;
  /**
   * The organization every server read and write for this session is scoped
   * to. Null whenever the state is not one where a single organization was
   * established.
   */
  activeOrganization: (OrganizationOption & { derivedFrom: "membership" | "single_tenant_fallback" }) | null;
  availableOrganizations: OrganizationOption[];
  availableWorkspaces: WorkspaceOption[];
  activeWorkspace: WorkspaceKey | null;
  /**
   * Whether the shell should ask before entering. True only when this person
   * does more than one JOB here; a personal surface never makes the question
   * worth asking.
   */
  workspaceChoiceRequired: boolean;
  /** Capabilities effective in the ACTIVE workspace only. Least privilege, as `roleActor` does it. */
  capabilities: Permission[];
  /** Recognized domain roles, in scope. Shown so a person can be told what they hold. */
  roles: DomainRole[];
  /**
   * Why the state is what it is, in a sentence a person can act on. Never names
   * a record they may not see, and never says which organization they failed to
   * match — an error message is not a directory.
   */
  reason: string | null;
};

/* ------------------------------------------------------------------ */
/* Membership                                                          */
/* ------------------------------------------------------------------ */

/** Whether a membership is live right now: active, in its window, in a live company. */
export function membershipIsLive(m: MembershipFact, now: Date): boolean {
  if (m.organizationStatus !== "active") return false;
  if (m.membershipStatus !== "active") return false;
  if (m.effectiveFrom.getTime() > now.getTime()) return false;
  if (m.effectiveTo && m.effectiveTo.getTime() <= now.getTime()) return false;
  return true;
}

const toOption = (m: MembershipFact): OrganizationOption => ({
  orgRef: m.orgRef,
  name: m.organizationName,
  membershipRef: m.membershipRef,
  membershipType: m.membershipType,
  branchId: m.branchId,
});

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

const surfaceFor = (key: string): PortalSurface | undefined =>
  PORTALS.find(p => p.portal === key);

/** Where entering a workspace lands. The shell's existing route shape, not a new one. */
export function workspaceLanding(key: WorkspaceKey): string {
  return `/portal/${key}`;
}

/**
 * The workspaces a set of roles and capabilities opens, in display order.
 *
 * Both conditions apply, and the external-only portals are excluded whatever
 * the registry says about them.
 */
export function workspacesFor(args: {
  roles: readonly DomainRole[];
  permissions: readonly string[];
}): WorkspaceOption[] {
  const held = new Set(args.roles);
  const holds = new Set(args.permissions);

  const out: WorkspaceOption[] = [];
  for (const key of WORKSPACE_ORDER) {
    if (EXTERNAL_ONLY_WORKSPACES.includes(key)) continue;
    const surface = surfaceFor(key);
    if (!surface) continue;
    if (!surface.composedFrom.some(r => held.has(r))) continue;
    const capabilities = surface.builtAround.filter(p => holds.has(p));
    if (capabilities.length === 0) continue;
    out.push({
      key,
      label: surface.displayName,
      description: surface.purpose,
      landing: workspaceLanding(key),
      capabilities: [...capabilities].sort(),
    });
  }
  return out;
}

/**
 * The capabilities effective inside one workspace.
 *
 * Narrower than everything the account holds, for the same reason `roleActor`
 * is: a driver board left on a dash mount, handed to a roadside officer or
 * shown to a customer should carry the driver's capabilities and not the
 * dispatcher's, even when one person holds both. The universals ride along
 * because they are self-scoped in code — your own pay, your own inbox, your
 * own device — and belong to the person rather than to the screen.
 */
export function capabilitiesInWorkspace(args: {
  workspace: WorkspaceKey;
  permissions: readonly string[];
}): Permission[] {
  const surface = surfaceFor(args.workspace);
  if (!surface) return [];
  const holds = new Set(args.permissions);
  const out = new Set<Permission>();
  for (const p of surface.builtAround) if (holds.has(p)) out.add(p);
  for (const p of UNIVERSAL_PERMISSIONS) if (holds.has(p)) out.add(p);
  return Array.from(out).sort();
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

const EMPTY: Omit<SessionContext, "state" | "user" | "reason"> = {
  activeOrganization: null,
  availableOrganizations: [],
  availableWorkspaces: [],
  activeWorkspace: null,
  workspaceChoiceRequired: false,
  capabilities: [],
  roles: [],
};

/**
 * The whole answer, from server-loaded facts.
 *
 * Fails closed at every branch. An unreadable, contradictory or unrecognized
 * input produces a state with no organization, no workspace and no capability
 * rather than a best guess, because the failure mode of guessing here is
 * somebody landing in a company they do not work for.
 */
export function resolveSessionContext(input: SessionContextInput): SessionContext {
  if (!input.user) {
    return { state: "unauthenticated", user: null, reason: null, ...EMPTY };
  }

  const live = input.memberships.filter(m => membershipIsLive(m, input.now));

  // Had a membership, has none now. Said plainly, because "no workspace" would
  // send the person to their administrator asking for the wrong thing.
  if (live.length === 0 && input.memberships.length > 0) {
    return {
      state: "no_membership",
      user: input.user,
      reason:
        "Your LeaseOS membership is not active. Ask an administrator at your company to restore it.",
      ...EMPTY,
    };
  }

  const options = live.map(toOption);

  // Several live memberships. The client may ASK for one; it may not assert
  // one. A request naming an organization this person is not a live member of
  // is not an error to report back — it is simply not a selection, and the
  // chooser opens.
  let chosen: MembershipFact | undefined;
  let derivedFrom: "membership" | "single_tenant_fallback" = "membership";
  if (live.length === 1) {
    chosen = live[0];
  } else if (live.length > 1) {
    chosen = live.find(m => m.orgRef === input.requestedOrgRef);
    if (!chosen) {
      return {
        state: "organization_required",
        user: input.user,
        reason: "Choose which organization you are working in.",
        ...EMPTY,
        availableOrganizations: options,
      };
    }
  } else {
    derivedFrom = "single_tenant_fallback";
  }

  const activeOrganization: SessionContext["activeOrganization"] = chosen
    ? { ...toOption(chosen), derivedFrom }
    : {
        orgRef: input.singleTenantId,
        name: "LeaseOS",
        membershipRef: "",
        membershipType: "employee",
        branchId: null,
        derivedFrom: "single_tenant_fallback",
      };

  // Roles. Unrecognized names grant nothing — the same rule `authorize()` runs
  // on, applied here so the chooser cannot offer what the gate would refuse.
  const roles = Array.from(
    new Set(input.grants.map(g => g.role).filter(isDomainRole))
  ) as DomainRole[];
  const permissions = permissionsFor(roles);

  const availableWorkspaces = workspacesFor({ roles, permissions });
  if (availableWorkspaces.length === 0) {
    return {
      state: "no_workspace",
      user: input.user,
      reason:
        "No LeaseOS workspace is assigned to you yet. Ask an administrator at your company for the access your work needs.",
      ...EMPTY,
      activeOrganization,
      availableOrganizations: options,
      roles,
    };
  }

  // What the client asked for, then what this person last chose here, then the
  // most operational one they hold. Each candidate is checked against the list
  // that was just computed, so none of them can name a workspace they do not
  // have.
  const open = new Set(availableWorkspaces.map(w => w.key));
  const activeWorkspace =
    (isWorkspaceKey(input.requestedWorkspace) && open.has(input.requestedWorkspace)
      ? input.requestedWorkspace
      : null) ??
    (chosen && isWorkspaceKey(chosen.defaultWorkspace) && open.has(chosen.defaultWorkspace)
      ? chosen.defaultWorkspace
      : null) ??
    availableWorkspaces[0]!.key;

  return {
    state: "ready",
    user: input.user,
    reason: null,
    activeOrganization,
    availableOrganizations: options,
    availableWorkspaces,
    activeWorkspace,
    workspaceChoiceRequired: requiresWorkspaceChoice(availableWorkspaces),
    capabilities: capabilitiesInWorkspace({ workspace: activeWorkspace, permissions }),
    roles,
  };
}

/** Whether a string names a workspace at all. Fails closed on anything else. */
export function isWorkspaceKey(value: unknown): value is WorkspaceKey {
  return (
    typeof value === "string" &&
    (WORKSPACE_ORDER as readonly string[]).includes(value) &&
    !(EXTERNAL_ONLY_WORKSPACES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export type SelectionDecision =
  | { allowed: true; workspace: WorkspaceKey; landing: string }
  | { allowed: false; outcome: "unknown_workspace" | "not_open"; reason: string };

/**
 * May this caller enter this workspace?
 *
 * The question the client's own state is never allowed to answer. Every
 * workspace switch goes through here, and the answer is recomputed from the
 * roles and capabilities the server just loaded — not from what the previous
 * answer was, and not from what the request says the caller is.
 */
export function decideWorkspaceSelection(args: {
  requested: unknown;
  available: readonly WorkspaceOption[];
}): SelectionDecision {
  if (!isWorkspaceKey(args.requested)) {
    return {
      allowed: false,
      outcome: "unknown_workspace",
      // Named, because a person who typed a URL deserves to know it is not a
      // place. It discloses nothing: the workspace vocabulary is not a secret,
      // and which ones THIS caller holds is not said either way.
      reason: `"${String(args.requested).slice(0, 60)}" is not a LeaseOS workspace.`,
    };
  }
  const match = args.available.find(w => w.key === args.requested);
  if (!match) {
    return {
      allowed: false,
      outcome: "not_open",
      reason: "That workspace is not open to your account.",
    };
  }
  return { allowed: true, workspace: match.key, landing: match.landing };
}
