/**
 * `portals.mine` carries the organization state, and the preference that goes
 * with it, without deciding anything about authority.
 *
 * Two facts have to reach the client and neither existed in the contract:
 *
 *   **Which organization the session is acting for**, including the case
 *   `resolveActingScope` refuses. That resolver throws `AmbiguousOrganization`
 *   for a user with two live memberships rather than picking one, and its
 *   header says why: "picking one would silently decide which company a request
 *   writes into." A refusal is the right answer and a thrown query is the wrong
 *   way to deliver it — the screen cannot tell it apart from a server fault, so
 *   it renders an error where it should render a decision.
 *
 *   **`organizationMemberships.defaultWorkspace`**, which has never been read.
 *   It is a `varchar(60)` nobody validates on write, so it travels as an
 *   unvalidated string and is checked against the held set at the point of use
 *   (`entryModel.resolvePortalEntry`). Calling it a preference is the whole
 *   design: a stale or hostile value must never open a portal.
 */
import { describe, expect, it } from "vitest";
import {
  organizationStateFrom,
  type OrganizationState,
} from "./_core/portalComposition";
import { AmbiguousOrganization } from "./_core/actingScope";

describe("organization state", () => {
  it("reports a resolved membership with its preference", () => {
    const state = organizationStateFrom({
      scope: {
        tenantId: "ORG-A",
        derivedFrom: "membership",
        membershipRef: "MEM-1",
        branchRefs: [],
        global: true,
      },
      defaultWorkspace: "dispatch_operations",
    });
    expect(state).toEqual({
      state: "resolved",
      orgRef: "ORG-A",
      membershipRef: "MEM-1",
      defaultWorkspace: "dispatch_operations",
    });
  });

  it("reports the single-tenant fallback as itself, not as a resolved org", () => {
    // `derivedFrom` exists precisely so a reader can tell "this deployment has
    // no organizations yet" from "this user belongs to one". Flattening them
    // would make the fallback look like isolation that is not there.
    expect(
      organizationStateFrom({
        scope: {
          tenantId: "default",
          derivedFrom: "single_tenant_fallback",
          membershipRef: null,
          branchRefs: [],
          global: false,
        },
        defaultWorkspace: null,
      })
    ).toEqual({ state: "single_tenant_fallback", defaultWorkspace: null });
  });

  it("carries a preference even under the fallback, since it is not an authority", () => {
    expect(
      organizationStateFrom({
        scope: {
          tenantId: "default",
          derivedFrom: "single_tenant_fallback",
          membershipRef: null,
          branchRefs: [],
          global: false,
        },
        defaultWorkspace: "field_workforce",
      })
    ).toEqual({ state: "single_tenant_fallback", defaultWorkspace: "field_workforce" });
  });

  it("turns the resolver's refusal into a state rather than a fault", () => {
    const state = organizationStateFrom({
      error: new AmbiguousOrganization(
        "This user is an active member of 2 organizations (ORG-A, ORG-B)."
      ),
    });
    expect(state.state).toBe("ambiguous");
    if (state.state !== "ambiguous") throw new Error("unreachable");
    // The detail is the resolver's own sentence. Nothing here re-words a
    // refusal it did not make.
    expect(state.detail).toContain("2 organizations");
  });

  it("does not swallow an error that is not the ambiguity", () => {
    // A dropped connection is not a decision about organizations, and
    // presenting it as one would hide a fault behind a tidy screen.
    expect(() =>
      organizationStateFrom({ error: new Error("connection lost") })
    ).toThrow("connection lost");
  });

  it("never reports a portal or a permission", () => {
    // The organization state answers "which company, and what did they prefer".
    // The moment it carries a portal it has started deciding access.
    const resolved = organizationStateFrom({
      scope: {
        tenantId: "ORG-A",
        derivedFrom: "membership",
        membershipRef: "MEM-1",
        branchRefs: [],
        global: true,
      },
      defaultWorkspace: "executive",
    }) as Extract<OrganizationState, { state: "resolved" }>;
    expect(Object.keys(resolved).sort()).toEqual(
      ["defaultWorkspace", "membershipRef", "orgRef", "state"].sort()
    );
  });
});

describe("a question that could not be asked", () => {
  it("is unresolved, which is not the single-tenant fallback", () => {
    // "No database configured" and "this deployment has no organizations yet"
    // are different facts with different remedies. Collapsing them would report
    // isolation that nothing established.
    expect(organizationStateFrom({ unresolved: "no database configured" })).toEqual({
      state: "unresolved",
      reason: "no database configured",
    });
  });
});

describe("the preference is a preference", () => {
  it("passes an unvalidated string through untouched", () => {
    // Validation belongs at the point of use, against the held set. Sanitising
    // here would invite a reader to believe the value means something.
    for (const junk of ["executive", "../admin", "", "NOT A PORTAL"]) {
      const state = organizationStateFrom({
        scope: {
          tenantId: "ORG-A",
          derivedFrom: "membership",
          membershipRef: "MEM-1",
          branchRefs: [],
          global: true,
        },
        defaultWorkspace: junk,
      });
      expect(state).toMatchObject({ defaultWorkspace: junk });
    }
  });
});
