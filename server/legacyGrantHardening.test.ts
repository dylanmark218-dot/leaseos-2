/**
 * B23.1A — legacy authority authorizes nothing. Permanently.
 *
 * Migration 0170 had to decide what to do with grants written before
 * organization scope existed. Two of its answers are load-bearing and neither
 * is obvious from reading the enum:
 *
 *   `unscoped_legacy` — the holder already belonged to more than one company,
 *   so no organization could be inferred without guessing whose authority to
 *   hand over. The row is preserved in full and authorizes NOWHERE.
 *
 *   `orgRef = 'default'` — the holder belonged to no organization at all, so
 *   the grant speaks for the historical single tenant this deployment already
 *   acts as for such people. It authorizes there and nowhere else; the moment
 *   that person joins a real company it stops matching.
 *
 * Both are quiet properties. Nothing about `scopeType='unscoped_legacy'` shouts
 * that it must never authorize, and a future edit to `grantsInOrganization`
 * that added it to the permitted set would look like tidying up. This file is
 * what fails when somebody does that.
 *
 * Pure throughout — no database — so it runs everywhere. The same properties
 * are asserted through the real routers in `organizationScopedRoles.db.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorize,
  grantsInOrganization,
  isPlatformGlobal,
  permissionsFor,
  type Permission,
  type RoleGrant,
} from "./_core/recordsAuthorization";
import { resolveSessionContext, type MembershipFact } from "./_core/workspaceAccess";
import { SINGLE_TENANT_ID } from "./_core/actingScope";

const NOW = new Date("2026-09-23T12:00:00Z");
const USER = { id: 7788, name: "Legacy Holder", email: null };
const A = "ORG-A";
const B = "ORG-B";

const membership = (orgRef: string, over: Partial<MembershipFact> = {}): MembershipFact => ({
  membershipRef: `MEM-${orgRef}`,
  orgRef,
  organizationName: orgRef,
  organizationStatus: "active",
  membershipType: "employee",
  membershipStatus: "active",
  effectiveFrom: new Date("2020-01-01"),
  effectiveTo: null,
  branchId: null,
  defaultWorkspace: null,
  ...over,
});

/** The most dangerous possible quarantined row: management, held by a multi-org user. */
const QUARANTINED: RoleGrant[] = [
  { role: "management", scopeType: "unscoped_legacy", orgRef: null, scopeRef: null },
];

/** A grant attributed to the historical single tenant. */
const HISTORICAL: RoleGrant[] = [
  { role: "management", scopeType: "organization", orgRef: SINGLE_TENANT_ID, scopeRef: null },
];

/* ================================================================== */
/* 1. unscoped_legacy never authorizes                                 */
/* ================================================================== */

describe("a quarantined legacy grant authorizes nothing, anywhere (§9)", () => {
  const EVERY_WAY_OF_ASKING: (string | null | undefined)[] = [
    A,
    B,
    SINGLE_TENANT_ID,
    "",
    null,
    undefined,
  ];

  it("is filtered out of the grant set for every organization, named or not", () => {
    for (const org of EVERY_WAY_OF_ASKING) {
      expect(grantsInOrganization(QUARANTINED, org), String(org)).toEqual([]);
    }
  });

  it("refuses every permission, including the administrative ones", () => {
    const permissions: Permission[] = [
      "roles.grant",
      "legal_hold.place",
      "retention.dispose",
      "billing.read",
      "job.read",
      // A universal, self-scoped permission: even this does not ride along,
      // because holding a quarantined grant does not make you anybody here.
      "inbox.read_own",
    ];
    for (const org of EVERY_WAY_OF_ASKING) {
      for (const permission of permissions) {
        const decision = authorize({
          userId: USER.id,
          grants: QUARANTINED,
          permission,
          organization: org as string | null,
        });
        expect(decision.allowed, `${permission} @ ${String(org)}`).toBe(false);
        expect(decision.effectiveRoles, `${permission} @ ${String(org)}`).toEqual([]);
      }
    }
  });

  it("is not laundered into authority by a branch that happens to match", () => {
    // A quarantined row cannot carry a branch (the CHECK constraint forbids
    // `unscoped_legacy` with an orgRef, and the backfill writes scopeRef NULL),
    // but a hand-built one must still reach nothing.
    const withBranch: RoleGrant[] = [
      { role: "management", scopeType: "unscoped_legacy", orgRef: null, scopeRef: "BR-1" },
    ];
    expect(
      authorize({ userId: USER.id, grants: withBranch, permission: "roles.grant", organization: A, resourceBranch: "BR-1" })
    ).toMatchObject({ allowed: false });
  });

  it("is not platform authority, however much it looks unscoped", () => {
    expect(isPlatformGlobal(QUARANTINED[0]!)).toBe(false);
  });

  it("contributes no role, capability or workspace to a session", () => {
    const s = resolveSessionContext({
      user: USER,
      memberships: [membership(A), membership(B)],
      grants: QUARANTINED,
      requestedOrgRef: A,
      now: NOW,
      singleTenantId: SINGLE_TENANT_ID,
    });
    expect(s.state).toBe("no_workspace");
    expect(s.roles).toEqual([]);
    expect(s.capabilities).toEqual([]);
    expect(s.availableWorkspaces).toEqual([]);
    expect(s.activeWorkspace).toBeNull();
    // And nothing anywhere in the response mentions it.
    expect(JSON.stringify(s)).not.toContain("management");
  });

  it("stays inert when the client selects each of the holder's organizations in turn", () => {
    for (const chosen of [A, B]) {
      const s = resolveSessionContext({
        user: USER,
        memberships: [membership(A), membership(B)],
        grants: QUARANTINED,
        requestedOrgRef: chosen,
        now: NOW,
        singleTenantId: SINGLE_TENANT_ID,
      });
      expect(s.roles, chosen).toEqual([]);
      expect(s.availableWorkspaces, chosen).toEqual([]);
    }
  });

  it("does not become authority by sitting beside a real grant", () => {
    const mixed: RoleGrant[] = [
      ...QUARANTINED,
      { role: "driver", scopeType: "organization", orgRef: A, scopeRef: null },
    ];
    const s = resolveSessionContext({
      user: USER,
      memberships: [membership(A)],
      grants: mixed,
      now: NOW,
      singleTenantId: SINGLE_TENANT_ID,
    });
    expect(s.roles).toEqual(["driver"]);
    expect(
      authorize({ userId: USER.id, grants: mixed, permission: "roles.grant", organization: A })
    ).toMatchObject({ allowed: false, effectiveRoles: ["driver"] });
  });
});

/* ================================================================== */
/* 2. The historical single tenant is contained                        */
/* ================================================================== */

describe("a grant attributed to the historical single tenant is contained (§5)", () => {
  it("authorizes only where there is no organization at all", () => {
    // Exactly the deployment 0170's category C describes: no membership rows,
    // so `resolveActingScope` resolves this caller to the historical tenant and
    // the grant speaks there. This is the mode LeaseOS has always run in, and
    // quarantining it instead would lock every such deployment out of itself.
    const s = resolveSessionContext({
      user: USER,
      memberships: [],
      grants: HISTORICAL,
      now: NOW,
      singleTenantId: SINGLE_TENANT_ID,
    });
    expect(s.activeOrganization).toMatchObject({
      orgRef: SINGLE_TENANT_ID,
      derivedFrom: "single_tenant_fallback",
    });
    expect(s.roles).toEqual(["management"]);
  });

  it("STOPS authorizing the moment its holder joins a real organization", () => {
    // The containment that matters. The row is untouched; it simply no longer
    // matches the organization the caller now acts for, so it reaches nothing.
    const s = resolveSessionContext({
      user: USER,
      memberships: [membership(A)],
      grants: HISTORICAL,
      now: NOW,
      singleTenantId: SINGLE_TENANT_ID,
    });
    expect(s.activeOrganization?.orgRef).toBe(A);
    expect(s.state).toBe("no_workspace");
    expect(s.roles).toEqual([]);
    expect(
      authorize({ userId: USER.id, grants: HISTORICAL, permission: "roles.grant", organization: A })
    ).toMatchObject({ allowed: false });
  });

  it("never reaches a named organization, whichever one is asked for", () => {
    for (const org of [A, B, "default-ish", "DEFAULT"]) {
      expect(grantsInOrganization(HISTORICAL, org), org).toEqual([]);
    }
    expect(grantsInOrganization(HISTORICAL, SINGLE_TENANT_ID)).toHaveLength(1);
  });

  it("is an ordinary organization-scoped grant, not platform authority", () => {
    expect(isPlatformGlobal(HISTORICAL[0]!)).toBe(false);
    expect(HISTORICAL[0]!.scopeType).toBe("organization");
  });

  it("names the historical tenant with the constant, so the literal lives in one place", () => {
    // `SINGLE_TENANT_ID` is what `resolveActingScope` resolves a
    // membership-less caller to, what `orgScopeWhere` compares against, and
    // what 0170's category-C backfill writes. If those three ever disagree, a
    // whole deployment silently loses its own access.
    expect(SINGLE_TENANT_ID).toBe("default");
  });
});

/* ================================================================== */
/* 3. No legacy category produces cross-company authority (§13)        */
/* ================================================================== */

describe("no legacy category grants access it did not already have (§13)", () => {
  /** Every shape 0170 can leave behind, and the company it may speak for. */
  const CATEGORIES: { label: string; grant: RoleGrant; authorizesIn: string[] }[] = [
    {
      label: "A — attributed to the one live membership",
      grant: { role: "management", scopeType: "organization", orgRef: A, scopeRef: null },
      authorizesIn: [A],
    },
    {
      label: "B — quarantined",
      grant: QUARANTINED[0]!,
      authorizesIn: [],
    },
    {
      label: "C — historical single tenant",
      grant: HISTORICAL[0]!,
      authorizesIn: [SINGLE_TENANT_ID],
    },
    {
      label: "F — malformed branch, quarantined",
      grant: { role: "management", scopeType: "unscoped_legacy", orgRef: null, scopeRef: null },
      authorizesIn: [],
    },
  ];

  it("lets each category speak for exactly the companies it should, and no others", () => {
    const everywhere = [A, B, SINGLE_TENANT_ID];
    for (const c of CATEGORIES) {
      for (const org of everywhere) {
        const reaches = grantsInOrganization([c.grant], org).length > 0;
        expect(reaches, `${c.label} in ${org}`).toBe(c.authorizesIn.includes(org));
      }
    }
  });

  it("creates no category that reaches every organization", () => {
    // Only `global` does that, and the backfill writes none — asserted against
    // the real migration SQL in `migrationSlots.test.ts` and against a real
    // database in `scripts/verify-migration-0170.sh`.
    for (const c of CATEGORIES) {
      expect(isPlatformGlobal(c.grant), c.label).toBe(false);
      expect(c.authorizesIn.length, c.label).toBeLessThanOrEqual(1);
    }
  });
});

/* ================================================================== */
/* 4. Revoked rows (§10)                                               */
/* ================================================================== */

describe("a revoked grant is history, not authority (§10)", () => {
  it("is excluded by the reader, so it never reaches the decision function", () => {
    // Revocation is filtered in SQL (`revokedAt IS NULL`) by every reader, so
    // the pure layer never sees one. What this pins is the consequence: the
    // decision made from an empty grant set is a refusal, not a fallback.
    expect(
      authorize({ userId: USER.id, grants: [], permission: "job.read", organization: A })
    ).toMatchObject({ allowed: false, outcome: "denied_no_role" });
  });

  it("leaves a person with nothing when every grant they had was revoked", () => {
    const s = resolveSessionContext({
      user: USER,
      memberships: [membership(A)],
      grants: [],
      now: NOW,
      singleTenantId: SINGLE_TENANT_ID,
    });
    expect(s.state).toBe("no_workspace");
    expect(s.capabilities).toEqual([]);
  });
});

/* ================================================================== */
/* 5. The projection agrees with the gate                              */
/* ================================================================== */

describe("capability projection and the gate cannot disagree about legacy grants", () => {
  it("projects no permission from a quarantined or foreign grant", () => {
    const foreign: RoleGrant[] = [
      { role: "management", scopeType: "organization", orgRef: B, scopeRef: null },
    ];
    for (const grants of [QUARANTINED, HISTORICAL, foreign]) {
      const scoped = grantsInOrganization(grants, A).map(g => g.role);
      expect(permissionsFor(scoped)).toEqual([]);
      expect(
        authorize({ userId: USER.id, grants, permission: "roles.grant", organization: A }).allowed
      ).toBe(false);
    }
  });
});

/* ================================================================== */
/* 6. Every caller of the decision function supplies the organization  */
/* ================================================================== */

/** Every shipped `.ts` under `server/`. Tests excluded: they are the callers this checks. */
function productionSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
      out[p] = readFileSync(p, "utf8");
    }
  };
  walk("server");
  return out;
}

/**
 * B23.1A — the bug this section exists to prevent, because it already shipped.
 *
 * B23.1 gave `authorize()` an organization axis and threaded it through the
 * procedure gate. Four handlers call `authorize` a SECOND time, after the gate,
 * to judge a record they have now loaded — and none of them passed it. To
 * `grantsInOrganization` an absent organization means "unresolved", which is
 * fail-closed and correct in general: it cannot judge a confined grant, so the
 * grant does not apply. After 0170 every grant a real user holds is confined,
 * so those four handlers refused everyone. Work-order release, evidence
 * sealing, queued sends and device-copy deletion were all dead.
 *
 * It passed every gate for one reason: the fixtures still wrote
 * `scopeType='global'`, which reaches every organization, so the tests were
 * the only callers in the system holding authority the product no longer
 * issues. It surfaced when one fixture was corrected to write what 0170
 * actually leaves behind.
 *
 * So the rule is checked against the source rather than trusted to review: a
 * call to the decision function, or to a wrapper that forwards to it, names the
 * organization it is deciding in.
 */
describe("no call site decides authorization without naming the organization", () => {
  /**
   * The real calls, and not their lookalikes.
   *
   * `(?<![.\w$])` rules out `args.authorize(...)` in `attachmentAuthorization.ts`,
   * which is an unrelated callback taking positional arguments. Comments are
   * stripped first, because this module is documented with examples of its own
   * calls and a doc comment is not a call site. The `{` requirement is the
   * third guard: the decision function takes one object, always.
   */
  const CALLS = /(?<![.\w$])(authorize|authorizeRecordScope|authorizeMechanicRelease)\s*\(\s*(?=[{.])/g;

  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

  /**
   * Call sites that legitimately pass no organization, each with the reason.
   *
   * An allowlist, not an amnesty: a new one has to be added here deliberately,
   * and each entry has to survive being read out loud.
   */
  const EXEMPT: Readonly<Record<string, string>> = {
    "server/_core/recordsAuthorization.ts":
      "defines the function. Its internal calls spread `...args`, so the organization rides through with everything else; adding it explicitly would shadow the caller's.",
    "server/surfacesRouter.ts":
      "feeds `authorize` names from `listActiveUserRoleNames`, which has already resolved the acting organization and dropped every grant issued elsewhere. See the note on `grantsFor`.",
    "server/_core/exceptionCentre.ts":
      "`visibleTo` is handed those same pre-scoped grants by its only caller, and takes no organization of its own to pass.",
  };

  /** The call's argument text, by counting brackets rather than guessing. */
  function argsOf(src: string, openParen: number): string {
    let depth = 0;
    for (let i = openParen; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return src.slice(openParen + 1, i);
      }
    }
    return src.slice(openParen + 1);
  }

  const sources = Object.fromEntries(
    Object.entries(productionSources()).map(([p, body]) => [p, stripComments(body)])
  );

  it("finds the call sites at all, so an empty pass is not a pass", () => {
    // A scan that matches nothing reports success forever. This is the tripwire
    // for a rename that quietly empties the check.
    const total = Object.values(sources).reduce(
      (n, body) => n + Array.from(body.matchAll(CALLS)).length,
      0
    );
    expect(total).toBeGreaterThan(6);
  });

  it("passes an organization at every call site outside the allowlist", () => {
    const offenders: string[] = [];
    for (const [path, body] of Object.entries(sources)) {
      if (path in EXEMPT) continue;
      for (const m of Array.from(body.matchAll(CALLS))) {
        const args = argsOf(body, m.index! + m[0].length - 1);
        // `...args` forwards whatever the caller supplied, organization included.
        if (/\borganization\b/.test(args) || /\.\.\.\s*args\b/.test(args)) continue;
        offenders.push(`${path}: ${m[1]}(${args.trim().slice(0, 80)}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every allowlisted file a reason, and does not list one that has no call", () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, path).toBeGreaterThan(40);
      // An exemption for a file that no longer calls the function is an
      // exemption nobody will notice has stopped meaning anything.
      expect(Array.from((sources[path] ?? "").matchAll(CALLS)).length, path).toBeGreaterThan(0);
    }
  });
});
