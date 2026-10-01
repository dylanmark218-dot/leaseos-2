/**
 * B23.2 — the People & Access decisions, each against the case it refuses.
 *
 * Pure, so every rule can be handed exactly the situation it exists for rather
 * than only the situation a database happens to be in. The adversarial suite
 * (`peopleAccess.db.test.ts`) asks the same questions through the real server;
 * this one explains what the answers mean.
 */
import { describe, expect, it } from "vitest";
import {
  acceptanceCheck,
  defaultWorkspaceCheck,
  digestToken,
  INVITATION_TTL_MS,
  invitationExpiry,
  invitationView,
  isGrantableRole,
  lastAdministratorCheck,
  newToken,
  ROLE_DESCRIPTIONS,
  workspaceOptionsForRoles,
  workspacesForRoles,
} from "./_core/peopleAccess";
import { GRANTABLE_ROLES } from "./recordsRouter";

const NOW = new Date("2026-09-24T12:00:00Z");
const A = "ORG-A";

const pending = (over: Partial<{ status: "pending" | "accepted" | "cancelled"; expiresAt: Date; acceptedAt: Date | null }> = {}) => ({
  orgRef: A,
  status: "pending" as const,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  acceptedAt: null,
  ...over,
});

describe("an invitation's state is what it is, not what a column last said", () => {
  it("calls a pending invitation past its expiry expired, without a sweeper having run", () => {
    // A stored "expired" is only as true as the last sweep and wrong in the
    // window before it. This is computed from the timestamp every time.
    expect(invitationView(pending(), NOW)).toBe("pending");
    expect(invitationView(pending({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe("expired");
  });

  it("leaves accepted and cancelled alone, expired or not", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    expect(invitationView(pending({ status: "accepted", expiresAt: past }), NOW)).toBe("accepted");
    expect(invitationView(pending({ status: "cancelled", expiresAt: past }), NOW)).toBe("cancelled");
  });

  it("takes its expiry from one policy rather than a number repeated per call site", () => {
    expect(invitationExpiry(NOW).getTime() - NOW.getTime()).toBe(INVITATION_TTL_MS);
    // The same seven days the external portal already uses, not a second number.
    expect(INVITATION_TTL_MS).toBe(7 * 86_400_000);
  });
});

describe("acceptance refuses for a stated reason, and never names another company", () => {
  const cases: Array<[string, Parameters<typeof acceptanceCheck>[0], string, RegExp]> = [
    [
      "a token matching nothing",
      { invitation: null, organizationOfRow: null, alreadyLiveMember: false, now: NOW },
      "not_found",
      /not valid/i,
    ],
    [
      "an expired invitation",
      { invitation: pending({ expiresAt: new Date(NOW.getTime() - 1) }), organizationOfRow: A, alreadyLiveMember: false, now: NOW },
      "refused",
      /expired/i,
    ],
    [
      "a cancelled invitation",
      { invitation: pending({ status: "cancelled" }), organizationOfRow: A, alreadyLiveMember: false, now: NOW },
      "refused",
      /cancelled/i,
    ],
    [
      "one already accepted",
      { invitation: pending({ status: "accepted", acceptedAt: NOW }), organizationOfRow: A, alreadyLiveMember: false, now: NOW },
      "refused",
      /already been accepted/i,
    ],
    [
      "somebody who is already a member",
      { invitation: pending(), organizationOfRow: A, alreadyLiveMember: true, now: NOW },
      "already_member",
      /already a member/i,
    ],
  ];

  for (const [label, args, outcome, message] of cases) {
    it(`refuses ${label}`, () => {
      const result = acceptanceCheck(args);
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe(outcome);
      expect(result.reason).toMatch(message);
    });
  }

  it("allows a pending, unexpired invitation for somebody who is not yet a member", () => {
    expect(acceptanceCheck({ invitation: pending(), organizationOfRow: A, alreadyLiveMember: false, now: NOW }))
      .toEqual({ allowed: true, reason: null, outcome: "ok" });
  });

  it("says nothing about any organization in any refusal", () => {
    // A refusal is not a directory. None of these sentences may carry an
    // organization reference, because the person reading it may have no
    // business knowing the company exists.
    for (const [, args] of cases) {
      const reason = acceptanceCheck(args).reason ?? "";
      expect(reason).not.toContain(A);
      expect(reason).not.toMatch(/ORG-/);
    }
  });
});

describe("a default workspace is a preference and can never become authority", () => {
  it("refuses one the roles do not open, and names what is available", () => {
    const refused = defaultWorkspaceCheck({ requested: "management", roles: ["driver"] });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/field_workforce/);
  });

  it("accepts one the roles do open", () => {
    expect(defaultWorkspaceCheck({ requested: "field_workforce", roles: ["driver"] }).allowed).toBe(true);
  });

  it("always allows clearing it", () => {
    expect(defaultWorkspaceCheck({ requested: null, roles: [] }).allowed).toBe(true);
  });

  it("refuses everything once the roles are gone", () => {
    // The case that matters after a revocation: there is nothing left to land in.
    for (const w of ["field_workforce", "management", "fleet_maintenance"]) {
      expect(defaultWorkspaceCheck({ requested: w, roles: [] }).allowed, w).toBe(false);
    }
  });
});

describe("workspaces are derived, so the preview cannot promise what the gate refuses", () => {
  it("needs a capability as well as a role, exactly as the session resolver does", () => {
    // `workspacesFor` takes both axes. Passing roles alone would preview a
    // screen the real resolver would not open, which is a promise rather than a
    // preview.
    const driver = workspacesForRoles(["driver"]);
    expect(driver).toContain("field_workforce");
    expect(driver).not.toContain("management");
  });

  it("loses a workspace when its last composing role goes", () => {
    expect(workspacesForRoles(["driver", "mechanic"])).toContain("fleet_maintenance");
    expect(workspacesForRoles(["driver"])).not.toContain("fleet_maintenance");
    expect(workspacesForRoles([])).toEqual([]);
  });

  it("ignores a role name that is not a domain role at all", () => {
    expect(workspacesForRoles(["not_a_role", "driver"])).toEqual(workspacesForRoles(["driver"]));
  });

  it("gives every option a label, so the client needs no second registry", () => {
    for (const option of workspaceOptionsForRoles(["driver", "management"])) {
      expect(option.key.length).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

describe("an organization cannot be left with nobody who can grant access", () => {
  it("refuses when the change would leave zero administrators", () => {
    const refusal = lastAdministratorCheck({ remainingAfterChange: 0, organizationName: "Solo Transport" });
    expect(refusal.allowed).toBe(false);
    expect(refusal.reason).toMatch(/Solo Transport/);
    // It says what to do instead, because a refusal nobody can act on is a
    // dead end rather than a control.
    expect(refusal.reason).toMatch(/appoint another administrator/i);
  });

  it("allows it when somebody else still holds management", () => {
    expect(lastAdministratorCheck({ remainingAfterChange: 1, organizationName: "ABC" }).allowed).toBe(true);
  });
});

describe("the grantable set is the router's, not a second list", () => {
  it("accepts every role the router will grant and nothing else", () => {
    for (const role of GRANTABLE_ROLES) expect(isGrantableRole(role, GRANTABLE_ROLES), role).toBe(true);
    // Real domain roles the finance side owns, deliberately absent.
    for (const role of ["bookkeeper", "payroll_admin", "controller", "external_accountant"]) {
      expect(isGrantableRole(role, GRANTABLE_ROLES), role).toBe(false);
    }
    expect(isGrantableRole("platform_admin", GRANTABLE_ROLES)).toBe(false);
  });

  it("describes every grantable role, so no administrator picks one blind", () => {
    for (const role of GRANTABLE_ROLES) {
      expect(ROLE_DESCRIPTIONS[role], role).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]!.length, role).toBeGreaterThan(20);
    }
  });

  it("describes nothing it cannot grant", () => {
    expect(Object.keys(ROLE_DESCRIPTIONS).sort()).toEqual([...GRANTABLE_ROLES].sort());
  });
});

describe("tokens", () => {
  it("mints a long random token and stores only its digest", () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(digestToken(a)).toHaveLength(64);
    expect(digestToken(a)).toMatch(/^[0-9a-f]{64}$/);
    // The digest is not reversible to the token, which is the whole point of
    // storing it instead.
    expect(digestToken(a)).not.toContain(a);
    expect(digestToken(a)).toBe(digestToken(a));
    expect(digestToken(a)).not.toBe(digestToken(b));
  });
});
