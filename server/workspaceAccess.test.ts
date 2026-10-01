/**
 * v23.26 — one identity, several jobs.
 *
 * The contract tests for the login → organization → workspace chain, written
 * against the pure resolver so every one of them runs with no database, in CI
 * and on a laptop alike. The database-backed half — that the SERVER refuses
 * what this module declines to offer, even when the client lies about both —
 * is `sessionWorkspace.db.test.ts`, and it is the half that matters: this file
 * says what the screen should show, that file proves the screen is not the
 * security.
 *
 * Requirement numbers below are the ones in the checkpoint brief.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capabilitiesInWorkspace,
  decideWorkspaceSelection,
  EXTERNAL_ONLY_WORKSPACES,
  isWorkspaceKey,
  jobWorkspaces,
  membershipIsLive,
  requiresWorkspaceChoice,
  resolveSessionContext,
  workspaceLanding,
  workspacesFor,
  WORKSPACE_ORDER,
  type MembershipFact,
  type SessionContextInput,
} from "./_core/workspaceAccess";
import { PORTALS } from "./_core/portalComposition";
import { permissionsFor, type DomainRole, type RoleGrant } from "./_core/recordsAuthorization";
import { isSafeRedirectPath, safeRedirectPath } from "@shared/_core/redirect";

const NOW = new Date("2026-09-21T12:00:00Z");
const USER = { id: 77, name: "Dana Reyes", email: "dana@example.ca" };

const membership = (over: Partial<MembershipFact> = {}): MembershipFact => ({
  membershipRef: "MEM-A",
  orgRef: "ORG-A",
  organizationName: "ABC Transport",
  organizationStatus: "active",
  membershipType: "employee",
  membershipStatus: "active",
  effectiveFrom: new Date("2020-01-01"),
  effectiveTo: null,
  branchId: null,
  defaultWorkspace: null,
  ...over,
});

const grants = (...roles: string[]): RoleGrant[] => roles.map(role => ({ role, scopeRef: null }));

const ctx = (over: Partial<SessionContextInput> = {}) =>
  resolveSessionContext({
    user: USER,
    memberships: [membership()],
    grants: grants("driver"),
    now: NOW,
    singleTenantId: "default",
    ...over,
  });

/* ================================================================== */
/* The registry projection                                             */
/* ================================================================== */

describe("the workspace registry is the portal registry", () => {
  it("names every portal exactly once, so a new one cannot arrive without an order", () => {
    expect([...WORKSPACE_ORDER].sort()).toEqual(PORTALS.map(p => p.portal).sort());
    expect(new Set(WORKSPACE_ORDER).size).toBe(WORKSPACE_ORDER.length);
  });

  it("keeps the shell's switcher order and the server's identical", () => {
    // Two orderings would be two answers about which workspace opens first.
    const vm = readFileSync("client/src/portal/viewModels.ts", "utf8");
    const declared = vm.match(/const OPEN_FIRST: PortalKey\[\] = \[([^\]]*)\]/)?.[1] ?? "";
    const inShell = Array.from(declared.matchAll(/"([a-z_]+)"/g)).map(m => m[1]!);
    expect(inShell).toEqual([...WORKSPACE_ORDER]);
  });

  it("offers no external-identity portal to a user session, at any role", () => {
    // Requirement: a client must never reach another party's portal. The
    // external portals are served only by `externalProcedure`, which a user
    // session cannot pass; this keeps them out of the chooser too.
    const everyRole = PORTALS.flatMap(p => p.composedFrom);
    const open = workspacesFor({
      roles: everyRole,
      permissions: permissionsFor(everyRole),
    }).map(w => w.key);
    for (const external of EXTERNAL_ONLY_WORKSPACES) expect(open).not.toContain(external);
  });

  it("lands every workspace on the shell's existing route shape", () => {
    for (const key of WORKSPACE_ORDER) expect(workspaceLanding(key)).toBe(`/portal/${key}`);
  });
});

/* ================================================================== */
/* Roles → capabilities → workspaces                                   */
/* ================================================================== */

describe("capabilities decide the workspace, not the role name", () => {
  it("opens no workspace this checkpoint did not already open — the change can only narrow", () => {
    // The guarantee that makes this safe to ship: for every single role, the
    // capability condition is satisfied wherever the role composition already
    // was. Nobody gains a screen; the capability is there so that losing the
    // grants loses the screen.
    for (const surface of PORTALS) {
      for (const role of surface.composedFrom) {
        const open = workspacesFor({ roles: [role], permissions: permissionsFor([role]) });
        expect(
          open.map(w => w.key),
          `${role} composes ${surface.portal} and must still reach it`
        ).toContain(surface.portal);
      }
    }
  });

  it("closes a workspace when its capabilities are revoked, though the role name survives (14)", () => {
    const withGrants = workspacesFor({
      roles: ["mechanic"],
      permissions: permissionsFor(["mechanic"]),
    });
    expect(withGrants.map(w => w.key)).toContain("fleet_maintenance");

    // Same role, every capability the shop workspace is built around removed.
    const shop = PORTALS.find(p => p.portal === "fleet_maintenance")!;
    const stripped = permissionsFor(["mechanic"]).filter(p => !shop.builtAround.includes(p));
    expect(
      workspacesFor({ roles: ["mechanic"], permissions: stripped }).map(w => w.key)
    ).not.toContain("fleet_maintenance");
  });

  it("gives a role no workspace its role does not compose, however many capabilities it holds", () => {
    // Capabilities are necessary, not sufficient: a driver holding `job.read`
    // does not thereby reach Dispatch, which is also built around it.
    const open = workspacesFor({
      roles: ["driver"],
      permissions: permissionsFor(["driver", "dispatcher", "management"]),
    }).map(w => w.key);
    expect(open).not.toContain("dispatch_operations");
    expect(open).not.toContain("management");
  });

  it("reports the capabilities of the ACTIVE workspace only, never the whole account (18)", () => {
    const both = permissionsFor(["driver", "mechanic"]);
    const field = capabilitiesInWorkspace({ workspace: "field_workforce", permissions: both });
    const shop = capabilitiesInWorkspace({ workspace: "fleet_maintenance", permissions: both });
    // The driver board handed to a roadside officer does not carry the shop's.
    expect(field).toContain("evidence.seal");
    expect(field).not.toContain("maintenance.record_release");
    expect(shop).toContain("maintenance.record_release");
    // Self-scoped permissions belong to the person, not the screen.
    expect(field).toContain("tax.read_personal_own");
    expect(shop).toContain("tax.read_personal_own");
  });

  it("grants nothing by switching: the union of every workspace's capabilities is still only what is held", () => {
    const held = new Set(permissionsFor(["driver"]));
    for (const w of workspacesFor({ roles: ["driver"], permissions: [...held] })) {
      for (const c of capabilitiesInWorkspace({ workspace: w.key, permissions: [...held] })) {
        expect(held.has(c), `${w.key} offered ${c}, which the account does not hold`).toBe(true);
      }
    }
  });
});

/* ================================================================== */
/* Routing after sign-in                                               */
/* ================================================================== */

describe("where a person lands", () => {
  it("routes a Field-only user straight into Field without asking (2, 4)", () => {
    const s = ctx({ grants: grants("driver") });
    expect(s.state).toBe("ready");
    expect(s.activeWorkspace).toBe("field_workforce");
    expect(s.workspaceChoiceRequired).toBe(false);
    // "My LeaseOS" rides along for everyone and is not a second job.
    expect(s.availableWorkspaces.map(w => w.key)).toContain("worker_self_service");
    expect(jobWorkspaces(s.availableWorkspaces).map(w => w.key)).toEqual(["field_workforce"]);
  });

  it("routes a Mechanic-only user straight into the shop (3)", () => {
    const s = ctx({ grants: grants("mechanic") });
    expect(s.activeWorkspace).toBe("fleet_maintenance");
    expect(s.workspaceChoiceRequired).toBe(false);
  });

  it("asks a Driver + Mechanic which one, on ONE identity (5, 21)", () => {
    const s = ctx({ grants: grants("driver", "mechanic") });
    expect(s.workspaceChoiceRequired).toBe(true);
    expect(jobWorkspaces(s.availableWorkspaces).map(w => w.key)).toEqual([
      "field_workforce",
      "fleet_maintenance",
    ]);
    // One user id, one membership, two jobs. No second account anywhere.
    expect(s.user?.id).toBe(USER.id);
    expect(s.availableOrganizations).toHaveLength(1);
  });

  it("honours a remembered workspace, and drops it the moment the access behind it goes (20)", () => {
    const remembered = [membership({ defaultWorkspace: "fleet_maintenance" })];
    expect(ctx({ memberships: remembered, grants: grants("driver", "mechanic") }).activeWorkspace)
      .toBe("fleet_maintenance");
    // Mechanic revoked. The stored preference names a workspace that is no
    // longer open, so it is ignored rather than honoured.
    expect(ctx({ memberships: remembered, grants: grants("driver") }).activeWorkspace)
      .toBe("field_workforce");
  });

  it("ignores a requested workspace the account cannot open, rather than obeying it (7)", () => {
    const s = ctx({ grants: grants("driver"), requestedWorkspace: "management" });
    expect(s.activeWorkspace).toBe("field_workforce");
    expect(s.availableWorkspaces.map(w => w.key)).not.toContain("management");
  });

  it("ignores a requested workspace that is not a workspace at all (15)", () => {
    for (const junk of ["", "ADMIN", "../admin", "field_workforce ", "customer", null, 7, {}]) {
      const s = ctx({ grants: grants("driver"), requestedWorkspace: junk as never });
      expect(s.activeWorkspace).toBe("field_workforce");
    }
  });
});

/* ================================================================== */
/* Organizations                                                       */
/* ================================================================== */

describe("which company a person is working in", () => {
  it("enters directly when there is exactly one", () => {
    const s = ctx();
    expect(s.state).toBe("ready");
    expect(s.activeOrganization).toMatchObject({ orgRef: "ORG-A", derivedFrom: "membership" });
  });

  it("asks rather than guesses when there are two, and offers no workspace until it is answered", () => {
    const s = ctx({
      memberships: [membership(), membership({ membershipRef: "MEM-B", orgRef: "ORG-B", organizationName: "Northern Hauling" })],
    });
    expect(s.state).toBe("organization_required");
    expect(s.activeOrganization).toBeNull();
    expect(s.availableWorkspaces).toEqual([]);
    expect(s.capabilities).toEqual([]);
    expect(s.availableOrganizations.map(o => o.orgRef)).toEqual(["ORG-A", "ORG-B"]);
  });

  it("honours a selection that is one of theirs, and treats one that is not as no selection (11)", () => {
    const two = [membership(), membership({ membershipRef: "MEM-B", orgRef: "ORG-B", organizationName: "Northern Hauling" })];
    expect(ctx({ memberships: two, requestedOrgRef: "ORG-B" }).activeOrganization?.orgRef).toBe("ORG-B");
    // A forged value names a company this person is not in. It decides nothing.
    const forged = ctx({ memberships: two, requestedOrgRef: "ORG-SOMEONE-ELSE" });
    expect(forged.state).toBe("organization_required");
    expect(forged.activeOrganization).toBeNull();
  });

  it("does not let a request override the one organization a person actually belongs to", () => {
    const s = ctx({ requestedOrgRef: "ORG-ELSEWHERE" });
    expect(s.activeOrganization?.orgRef).toBe("ORG-A");
  });

  it("falls back to the historical single tenant only when there is no membership at all", () => {
    const s = ctx({ memberships: [] });
    expect(s.activeOrganization).toMatchObject({
      orgRef: "default",
      derivedFrom: "single_tenant_fallback",
    });
  });
});

/* ================================================================== */
/* Refusals                                                            */
/* ================================================================== */

describe("deny by default", () => {
  it("tells an anonymous request nothing but that it is anonymous (1)", () => {
    const s = ctx({ user: null, grants: grants("management") });
    expect(s).toMatchObject({
      state: "unauthenticated",
      user: null,
      activeOrganization: null,
      availableOrganizations: [],
      availableWorkspaces: [],
      capabilities: [],
      roles: [],
      reason: null,
    });
  });

  it("refuses a person whose membership has ended, and says which problem it is (13)", () => {
    const s = ctx({ memberships: [membership({ membershipStatus: "ended" })] });
    expect(s.state).toBe("no_membership");
    expect(s.reason).toMatch(/membership is not active/i);
    expect(s.availableWorkspaces).toEqual([]);
    expect(s.activeOrganization).toBeNull();
  });

  it("refuses a suspended membership and a suspended or closed company alike (12)", () => {
    for (const over of [
      { membershipStatus: "suspended" as const },
      { organizationStatus: "suspended" as const },
      { organizationStatus: "closed" as const },
      { effectiveTo: new Date("2025-01-01") },
      { effectiveFrom: new Date("2027-01-01") },
    ]) {
      expect(ctx({ memberships: [membership(over)] }).state, JSON.stringify(over)).toBe("no_membership");
    }
  });

  it("says 'no workspace assigned' rather than guessing, for a member who holds nothing (26)", () => {
    const s = ctx({ grants: [] });
    expect(s.state).toBe("no_workspace");
    expect(s.reason).toMatch(/No LeaseOS workspace is assigned/i);
    expect(s.activeWorkspace).toBeNull();
    expect(s.capabilities).toEqual([]);
    // The organization is still resolved: they are in the company, they just
    // have no job in it yet, and telling them the wrong thing sends them to
    // their administrator asking for the wrong fix.
    expect(s.activeOrganization?.orgRef).toBe("ORG-A");
  });

  it("grants nothing for an unrecognized role string (15)", () => {
    const s = ctx({ grants: grants("SUPER_ADMIN", "root", "admin") });
    expect(s.state).toBe("no_workspace");
    expect(s.roles).toEqual([]);
  });

  it("refuses a workspace selection the account cannot open, by outcome (7, 18)", () => {
    const s = ctx({ grants: grants("driver") });
    expect(decideWorkspaceSelection({ requested: "management", available: s.availableWorkspaces }))
      .toMatchObject({ allowed: false, outcome: "not_open" });
    expect(decideWorkspaceSelection({ requested: "not_a_workspace", available: s.availableWorkspaces }))
      .toMatchObject({ allowed: false, outcome: "unknown_workspace" });
    expect(decideWorkspaceSelection({ requested: "customer", available: s.availableWorkspaces }))
      .toMatchObject({ allowed: false, outcome: "unknown_workspace" });
    expect(decideWorkspaceSelection({ requested: "field_workforce", available: s.availableWorkspaces }))
      .toEqual({ allowed: true, workspace: "field_workforce", landing: "/portal/field_workforce" });
  });

  it("discloses no organization name in a refusal", () => {
    const s = ctx({ memberships: [membership({ membershipStatus: "ended" })] });
    expect(s.reason).not.toContain("ABC Transport");
    expect(s.reason).not.toContain("ORG-A");
  });

  it("recognizes a workspace key and nothing that merely looks like one", () => {
    expect(isWorkspaceKey("field_workforce")).toBe(true);
    for (const junk of ["customer", "vendor_facility", "FIELD_WORKFORCE", "field", "", null, 0, []]) {
      expect(isWorkspaceKey(junk), String(junk)).toBe(false);
    }
  });

  it("reads a membership's liveness from all four conditions, not one", () => {
    expect(membershipIsLive(membership(), NOW)).toBe(true);
    expect(membershipIsLive(membership({ effectiveTo: NOW }), NOW)).toBe(false); // the instant it ends
    expect(membershipIsLive(membership({ effectiveFrom: NOW }), NOW)).toBe(true); // the instant it starts
  });
});

/* ================================================================== */
/* Post-login redirect                                                 */
/* ================================================================== */

describe("where a login may land (16, 17)", () => {
  it("returns to the requested location when it is a path on this origin", () => {
    for (const ok of ["/portal/fleet_maintenance", "/portal/x?tab=2", "/a/b#c", "/x:y"]) {
      expect(safeRedirectPath(ok), ok).toBe(ok);
    }
  });

  it("refuses every external destination rather than repairing it", () => {
    for (const bad of [
      "https://evil.example/steal",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/%2F%2Fevil.example",
      "/portal/../../etc",
      "/\tjavascript:alert(1)",
      "/x\nSet-Cookie: a=b",
      "",
      "portal",
      null,
      undefined,
      `/${"a".repeat(600)}`,
    ]) {
      expect(isSafeRedirectPath(bad as never), String(bad)).toBe(false);
      expect(safeRedirectPath(bad as never), String(bad)).toBe("/");
    }
  });

  it("will not accept an unsafe fallback either", () => {
    expect(safeRedirectPath("https://evil.example", "https://also-evil.example")).toBe("/");
    expect(safeRedirectPath(null, "/portal/field_workforce")).toBe("/portal/field_workforce");
  });
});

/* ================================================================== */
/* The chooser                                                         */
/* ================================================================== */

describe("the chooser asks only when the question is worth asking", () => {
  const options = (...roles: DomainRole[]) =>
    workspacesFor({ roles, permissions: permissionsFor(roles) });

  it("does not ask a single-job person", () => {
    for (const role of ["driver", "mechanic", "hr"] as DomainRole[]) {
      expect(requiresWorkspaceChoice(options(role)), role).toBe(false);
      expect(jobWorkspaces(options(role)), role).toHaveLength(1);
    }
  });

  it("asks a Driver + Mechanic, and a Dispatch + Safety + Management", () => {
    expect(requiresWorkspaceChoice(options("driver", "mechanic"))).toBe(true);
    expect(requiresWorkspaceChoice(options("dispatcher", "safety", "management"))).toBe(true);
  });

  it("asks a one-role person whose role genuinely composes more than one job", () => {
    // Not an accident of this change: `safety` has composed Safety, Field
    // Leadership and Incident/Emergency since the portal registry was written,
    // and `office` has composed Office Administration and Sales. A safety
    // officer really does open three different screens, so the question is
    // worth asking — and it is asked from the registry's own composition, not
    // from a rule invented here.
    expect(jobWorkspaces(options("safety")).map(w => w.key)).toEqual([
      "incident_emergency",
      "safety_compliance",
      "field_leadership",
    ]);
    expect(requiresWorkspaceChoice(options("safety"))).toBe(true);
    expect(jobWorkspaces(options("office")).map(w => w.key)).toEqual([
      "office_administration",
      "sales_customer",
    ]);
  });

  it("gives every offered workspace a label, a sentence and a landing route", () => {
    for (const w of options("driver", "mechanic", "dispatcher", "safety", "management")) {
      expect(w.label.length, w.key).toBeGreaterThan(2);
      expect(w.description.length, w.key).toBeGreaterThan(20);
      expect(w.landing, w.key).toBe(`/portal/${w.key}`);
      expect(w.capabilities.length, w.key).toBeGreaterThan(0);
    }
  });
});
