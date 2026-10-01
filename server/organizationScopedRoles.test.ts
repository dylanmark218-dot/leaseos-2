/**
 * B23.1 — a role granted by one company does not follow you into another.
 *
 * ## The bug this file was written to prove
 *
 * `userRoleAssignments.scopeType` is `global | branch` and carries no
 * organization. Every business role `records.roles.grant` has ever issued was
 * written as `global`, because organization scope did not exist to write. So
 * an account that drives for ABC Transport and wrenches for XYZ Oilfield held
 * `driver` and `mechanic` as *account-wide* facts, and `authorize()` had no
 * organization axis to reject either one with.
 *
 * Concretely, before this checkpoint: ABC grants `driver`, XYZ grants
 * `mechanic`, and while acting for ABC the same account could record a
 * mechanic's release — because the decision function was never told which
 * company the request was for.
 *
 * Membership and the tenant-scoped queries already isolated the DATA. What was
 * not isolated was the AUTHORITY. This file is the regression guard for that,
 * and it is deliberately pure: every case runs with no database, so it runs in
 * CI and on a laptop alike. The database-backed half —that the SERVER refuses
 * it through the real routers — is `organizationScopedRoles.db.test.ts`.
 *
 * Requirement numbers in the test names are the ones in the B23.1 brief.
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  grantsInOrganization,
  isPlatformGlobal,
  permissionsFor,
  type RoleGrant,
} from "./_core/recordsAuthorization";
import { resolveSessionContext, type MembershipFact } from "./_core/workspaceAccess";

const NOW = new Date("2026-09-21T12:00:00Z");
const USER = { id: 4242, name: "Dylan", email: "dylan@example.ca" };

const A = "ORG-ABC";
const B = "ORG-XYZ";

/** A grant as the table holds it after B23.1: a role, an issuing organization, a scope. */
const grant = (over: Partial<RoleGrant> & { role: string }): RoleGrant => ({
  scopeType: "organization",
  orgRef: A,
  scopeRef: null,
  ...over,
});

const membership = (orgRef: string, over: Partial<MembershipFact> = {}): MembershipFact => ({
  membershipRef: `MEM-${orgRef}`,
  orgRef,
  organizationName: orgRef === A ? "ABC Transport" : "XYZ Oilfield Services",
  organizationStatus: "active",
  membershipType: "employee",
  membershipStatus: "active",
  effectiveFrom: new Date("2020-01-01"),
  effectiveTo: null,
  branchId: null,
  defaultWorkspace: null,
  ...over,
});

/** Dylan: driver at ABC, mechanic at XYZ. One account, two companies. */
const DYLAN_GRANTS: RoleGrant[] = [
  grant({ role: "driver", orgRef: A }),
  grant({ role: "mechanic", orgRef: B }),
];

const session = (orgRef: string, grants: readonly RoleGrant[] = DYLAN_GRANTS) =>
  resolveSessionContext({
    user: USER,
    memberships: [membership(A), membership(B)],
    grants,
    requestedOrgRef: orgRef,
    now: NOW,
    singleTenantId: "default",
  });

/* ================================================================== */
/* The invariant, at the decision function                             */
/* ================================================================== */

describe("a role granted by one organization does not authorize in another (TEST 1)", () => {
  it("authorizes the driver at ABC and refuses the mechanic there", () => {
    // `maintenance.record_release` is a mechanic capability. XYZ granted it.
    // Acting for ABC, it must not be reachable.
    const refused = authorize({
      userId: USER.id, grants: DYLAN_GRANTS, permission: "maintenance.record_release", organization: A,
    });
    expect(refused.allowed).toBe(false);
    // The sharper assertion, and the one that actually pins the boundary: the
    // mechanic role is not merely outvoted, it is not CONSIDERED. Acting for
    // ABC, this account is a driver and nothing else.
    expect(refused.effectiveRoles).toEqual(["driver"]);
    expect(refused.effectiveRoles).not.toContain("mechanic");

    // ABC's own grant works, in ABC.
    expect(
      authorize({ userId: USER.id, grants: DYLAN_GRANTS, permission: "hos.write", organization: A })
    ).toMatchObject({ allowed: true, effectiveRoles: ["driver"] });
  });

  it("authorizes the mechanic at XYZ and refuses the driver there", () => {
    const refused = authorize({
      userId: USER.id, grants: DYLAN_GRANTS, permission: "hos.write", organization: B,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.effectiveRoles).toEqual(["mechanic"]);
    expect(refused.effectiveRoles).not.toContain("driver");

    expect(
      authorize({ userId: USER.id, grants: DYLAN_GRANTS, permission: "maintenance.record_release", organization: B })
    ).toMatchObject({ allowed: true, effectiveRoles: ["mechanic"] });
  });

  it("reports only the roles the acting organization granted", () => {
    expect(grantsInOrganization(DYLAN_GRANTS, A).map(g => g.role)).toEqual(["driver"]);
    expect(grantsInOrganization(DYLAN_GRANTS, B).map(g => g.role)).toEqual(["mechanic"]);
  });

  it("refuses an organization the account holds no grant in at all", () => {
    expect(grantsInOrganization(DYLAN_GRANTS, "ORG-SOMEONE-ELSE")).toEqual([]);
    expect(
      authorize({ userId: USER.id, grants: DYLAN_GRANTS, permission: "hos.write", organization: "ORG-SOMEONE-ELSE" })
    ).toMatchObject({ allowed: false });
  });
});

/* ================================================================== */
/* Cross-organization administration (TEST 3)                          */
/* ================================================================== */

describe("administrative authority does not cross organizations (TEST 3)", () => {
  const dualWithAdminAtA: RoleGrant[] = [
    grant({ role: "management", orgRef: A }),
    grant({ role: "driver", orgRef: B }),
  ];

  it("grants roles.grant at ABC and refuses it at XYZ", () => {
    expect(
      authorize({ userId: USER.id, grants: dualWithAdminAtA, permission: "roles.grant", organization: A })
    ).toMatchObject({ allowed: true });
    // The single most important refusal in B23.1: an administrator of one
    // company is an ordinary driver in the other, and the management role is
    // not in the set the decision was made from.
    const refused = authorize({
      userId: USER.id, grants: dualWithAdminAtA, permission: "roles.grant", organization: B,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.effectiveRoles).toEqual(["driver"]);
    expect(refused.effectiveRoles).not.toContain("management");
  });

  it("refuses every other management capability at XYZ too", () => {
    for (const permission of ["legal_hold.place", "retention.dispose", "route.decide", "restricted.read"] as const) {
      expect(
        authorize({ userId: USER.id, grants: dualWithAdminAtA, permission, organization: B }),
        permission
      ).toMatchObject({ allowed: false });
    }
  });
});

/* ================================================================== */
/* Capabilities and workspaces follow the scoped roles (TEST 4, §13)   */
/* ================================================================== */

describe("workspaces are computed from organization-scoped roles, not filtered afterwards (TEST 4)", () => {
  it("offers Field at ABC and never the shop", () => {
    const s = session(A);
    expect(s.state).toBe("ready");
    expect(s.activeOrganization?.orgRef).toBe(A);
    expect(s.roles).toEqual(["driver"]);
    expect(s.availableWorkspaces.map(w => w.key)).toContain("field_workforce");
    expect(s.availableWorkspaces.map(w => w.key)).not.toContain("fleet_maintenance");
    expect(s.workspaceChoiceRequired).toBe(false);
  });

  it("offers the shop at XYZ and never Field", () => {
    const s = session(B);
    expect(s.activeOrganization?.orgRef).toBe(B);
    expect(s.roles).toEqual(["mechanic"]);
    expect(s.availableWorkspaces.map(w => w.key)).toContain("fleet_maintenance");
    expect(s.availableWorkspaces.map(w => w.key)).not.toContain("field_workforce");
  });

  it("leaks no capability belonging to the other organization (§14)", () => {
    const atA = session(A);
    const atB = session(B);
    // The capability list is per active workspace already; the point here is
    // that the OTHER company's capabilities are not in the response at all.
    expect(atA.capabilities).toContain("evidence.seal");
    expect(atA.capabilities).not.toContain("maintenance.record_release");
    expect(atB.capabilities).toContain("maintenance.record_release");
    expect(atB.capabilities).not.toContain("evidence.seal");

    // Nor in any workspace the response offers.
    for (const w of atA.availableWorkspaces) {
      expect(w.capabilities, `${w.key} at ABC`).not.toContain("maintenance.record_release");
    }
  });

  it("gives the same account a different workspace menu per organization", () => {
    expect(session(A).availableWorkspaces.map(w => w.key)).not.toEqual(
      session(B).availableWorkspaces.map(w => w.key)
    );
    // Same identity throughout. Two companies, not two accounts.
    expect(session(A).user?.id).toBe(session(B).user?.id);
  });
});

/* ================================================================== */
/* Branch scope cannot cross an organization (TEST 5)                  */
/* ================================================================== */

describe("a branch-scoped grant is confined to its own organization (TEST 5)", () => {
  // There is no `branches` table in this schema — `branchId` is a bare
  // varchar on eight tables with no organization ownership. A branch grant
  // therefore has to name its organization EXPLICITLY; deriving one from the
  // branch string would be exactly the ambiguous relationship that lets
  // authority leak.
  const branchGrant: RoleGrant[] = [
    { role: "driver", scopeType: "branch", orgRef: A, scopeRef: "BRANCH-A1" },
  ];

  it("authorizes inside its own branch of its own organization", () => {
    expect(
      authorize({ userId: USER.id, grants: branchGrant, permission: "hos.write", organization: A, resourceBranch: "BRANCH-A1" })
    ).toMatchObject({ allowed: true });
  });

  it("refuses another branch of the same organization", () => {
    expect(
      authorize({ userId: USER.id, grants: branchGrant, permission: "hos.write", organization: A, resourceBranch: "BRANCH-A2" })
    ).toMatchObject({ allowed: false, outcome: "denied_scope" });
  });

  it("refuses the other organization even when the branch identifier matches", () => {
    // A forged or coincidental branch id from another company must not move
    // authority across the tenant boundary. The organization is checked first.
    expect(
      authorize({ userId: USER.id, grants: branchGrant, permission: "hos.write", organization: B, resourceBranch: "BRANCH-A1" })
    ).toMatchObject({ allowed: false, outcome: "denied_scope" });
  });

  it("refuses when the organization is resolved but the branch is not", () => {
    expect(
      authorize({ userId: USER.id, grants: branchGrant, permission: "hos.write", organization: A })
    ).toMatchObject({ allowed: false, outcome: "denied_scope" });
  });
});

/* ================================================================== */
/* Fail-closed states (TEST 10)                                        */
/* ================================================================== */

describe("unknown and legacy scope states grant nothing (TEST 10)", () => {
  it("refuses a grant quarantined by the migration, in every organization", () => {
    // `unscoped_legacy` is what the backfill writes for a grant it could not
    // safely attribute: the holder was already a member of more than one
    // company when organization scope arrived, so no organization can be
    // inferred without guessing which company's authority to hand over.
    const quarantined: RoleGrant[] = [
      { role: "management", scopeType: "unscoped_legacy", orgRef: null, scopeRef: null },
    ];
    for (const org of [A, B, "default", null, undefined]) {
      expect(
        authorize({ userId: USER.id, grants: quarantined, permission: "roles.grant", organization: org as never }),
        String(org)
      ).toMatchObject({ allowed: false });
    }
  });

  it("refuses an unrecognized scope type", () => {
    const malformed: RoleGrant[] = [
      { role: "driver", scopeType: "region" as never, orgRef: A, scopeRef: null },
    ];
    expect(
      authorize({ userId: USER.id, grants: malformed, permission: "hos.write", organization: A })
    ).toMatchObject({ allowed: false });
  });

  it("refuses an organization-scoped grant that names no organization", () => {
    const malformed: RoleGrant[] = [
      { role: "driver", scopeType: "organization", orgRef: null, scopeRef: null },
    ];
    expect(
      authorize({ userId: USER.id, grants: malformed, permission: "hos.write", organization: A })
    ).toMatchObject({ allowed: false });
  });

  it("refuses a branch grant that names no organization", () => {
    const malformed: RoleGrant[] = [
      { role: "driver", scopeType: "branch", orgRef: null, scopeRef: "BRANCH-A1" },
    ];
    expect(
      authorize({ userId: USER.id, grants: malformed, permission: "hos.write", organization: A, resourceBranch: "BRANCH-A1" })
    ).toMatchObject({ allowed: false });
  });

  it("does not apply an organization-confined grant when no organization was resolved", () => {
    // The same rule the branch axis already runs on: a caller that did not
    // resolve the organization cannot judge a confined grant, so it does not
    // apply. Only platform-global authority passes an unresolved gate.
    expect(
      authorize({ userId: USER.id, grants: DYLAN_GRANTS, permission: "hos.write" })
    ).toMatchObject({ allowed: false, outcome: "denied_scope" });
  });
});

/* ================================================================== */
/* Platform-global authority is explicit and rare (TEST 9)             */
/* ================================================================== */

describe("platform-global authority exists, is explicit, and is held by nobody by default (TEST 9)", () => {
  const platform: RoleGrant[] = [{ role: "auditor", scopeType: "global", orgRef: null, scopeRef: null }];

  it("crosses organizations by design, and says so", () => {
    expect(isPlatformGlobal(platform[0]!)).toBe(true);
    for (const org of [A, B]) {
      expect(
        authorize({ userId: USER.id, grants: platform, permission: "evidence.export", organization: org }),
        org
      ).toMatchObject({ allowed: true });
    }
  });

  it("is not what an ordinary organization grant is", () => {
    expect(isPlatformGlobal(grant({ role: "auditor", orgRef: A }))).toBe(false);
    expect(isPlatformGlobal({ role: "driver", scopeType: "branch", orgRef: A, scopeRef: "B1" })).toBe(false);
    expect(isPlatformGlobal({ role: "driver", scopeType: "unscoped_legacy", orgRef: null })).toBe(false);
  });
});

/* ================================================================== */
/* Deny-beats-grant survives organization scoping (§10)                */
/* ================================================================== */

describe("deny still beats grant, per organization (§10)", () => {
  it("keeps a denial attached to the organization that issued the role", () => {
    // `mechanic` is explicitly denied `billing.read` in DENIALS. A second role
    // in ANOTHER organization must neither launder that denial away nor carry
    // it across.
    const grants: RoleGrant[] = [
      grant({ role: "mechanic", orgRef: A }),
      grant({ role: "office", orgRef: B }),
    ];
    // At ABC only the mechanic is in scope: denied.
    expect(
      authorize({ userId: USER.id, grants, permission: "billing.read", organization: A })
    ).toMatchObject({ allowed: false, outcome: "denied_permission" });
    // At XYZ only the office role is in scope: the mechanic's denial does not
    // follow, because the mechanic grant is not in scope there at all.
    expect(
      authorize({ userId: USER.id, grants, permission: "billing.read", organization: B })
    ).toMatchObject({ allowed: true });
  });

  it("still lets a denial beat a grant when both are in the same organization", () => {
    const sameOrg: RoleGrant[] = [
      grant({ role: "mechanic", orgRef: A }),
      grant({ role: "office", orgRef: A }),
    ];
    expect(
      authorize({ userId: USER.id, grants: sameOrg, permission: "billing.read", organization: A })
    ).toMatchObject({ allowed: false, outcome: "denied_permission" });
  });
});

/* ================================================================== */
/* Membership is still the outer gate (TEST 6, 7, 8)                   */
/* ================================================================== */

describe("a grant cannot outlive the membership that justified it (TEST 6, 7, 8)", () => {
  const stale = (over: Partial<MembershipFact>) =>
    resolveSessionContext({
      user: USER,
      memberships: [membership(A, over)],
      grants: [grant({ role: "driver", orgRef: A })],
      now: NOW,
      singleTenantId: "default",
    });

  it("refuses a revoked membership though the role row survives (TEST 6)", () => {
    expect(stale({ membershipStatus: "ended" }).state).toBe("no_membership");
  });

  it("refuses an expired membership (TEST 7)", () => {
    expect(stale({ effectiveTo: new Date("2025-01-01") }).state).toBe("no_membership");
  });

  it("refuses a disabled organization (TEST 8)", () => {
    expect(stale({ organizationStatus: "suspended" }).state).toBe("no_membership");
    expect(stale({ organizationStatus: "closed" }).state).toBe("no_membership");
  });
});

/* ================================================================== */
/* Permission projection is organization-aware                         */
/* ================================================================== */

describe("capability projection uses scoped roles", () => {
  it("projects only the acting organization's roles into permissions", () => {
    const atA = permissionsFor(grantsInOrganization(DYLAN_GRANTS, A).map(g => g.role));
    const atB = permissionsFor(grantsInOrganization(DYLAN_GRANTS, B).map(g => g.role));
    expect(atA).toContain("hos.write");
    expect(atA).not.toContain("maintenance.record_release");
    expect(atB).toContain("maintenance.record_release");
    expect(atB).not.toContain("hos.write");
  });
});
