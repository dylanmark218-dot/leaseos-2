/**
 * What an ended membership actually does, proved rather than assumed.
 *
 * The question this answers: does an inactive or expired
 * `organizationMembership` lose access through the canonical server path?
 *
 * `resolveActingScope` filters memberships two ways, and only one of them is
 * visible to a test that does not talk to a database:
 *
 *   `status = 'active'`            in SQL, in the WHERE clause
 *   the effective-date window      in JavaScript, in a `.filter(...)`
 *
 * A fake database cannot honour a drizzle WHERE without reimplementing it, so
 * this file proves the JavaScript half exactly and says plainly that it does
 * not prove the SQL half. `server/actingScopeMembership.db.test.ts` covers the
 * status filter against real MariaDB. Splitting them is the honest arrangement:
 * a fake that pretended to apply the WHERE would report a filter working when
 * nothing had run it.
 *
 * **The finding, stated up front because it is the point of the file.** The
 * filters are correct — an ended, suspended or not-yet-started membership is
 * excluded. What happens *next* is the part worth knowing: a user with no
 * surviving membership does not get refused, they fall through to
 * `single_tenant_fallback` and act as the deployment's default tenant, carrying
 * every role grant they still hold. Ending a membership therefore removes their
 * former organization's records from view — those rows carry its `orgRef` — and
 * does not, on its own, end their session's authority over unowned rows.
 */
import { describe, expect, it } from "vitest";
import { organizationMemberships, userRoleAssignments } from "../drizzle/schema";
import {
  AmbiguousOrganization,
  resolveActingScope,
  SINGLE_TENANT_ID,
} from "./_core/actingScope";

const NOW = new Date("2026-09-21T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

type MembershipRow = {
  orgRef: string;
  membershipRef: string;
  branchId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

const membership = (over: Partial<MembershipRow> = {}): MembershipRow => ({
  orgRef: "ORG-A",
  membershipRef: "MEM-1",
  branchId: null,
  effectiveFrom: day(-30),
  effectiveTo: null,
  ...over,
});

/**
 * A database that answers the two queries `resolveActingScope` makes.
 *
 * It returns the rows it is given and does NOT interpret the WHERE, which is
 * why the status cases live in the database suite. Rows handed to `memberships`
 * here stand for rows that already satisfied `status = 'active'`.
 */
const fakeDb = (rows: { grants?: { scopeType: string; scopeRef: string | null }[]; memberships?: MembershipRow[] }) =>
  ({
    select: (_columns?: unknown) => ({
      from: (table: unknown) => ({
        where: (_predicate: unknown) =>
          Promise.resolve(
            table === organizationMemberships ? rows.memberships ?? [] : rows.grants ?? []
          ),
      }),
    }),
  }) as never;

const scopeFor = (rows: Parameters<typeof fakeDb>[0]) =>
  resolveActingScope(fakeDb(rows), 4242, NOW);

describe("a membership that is live right now", () => {
  it("resolves to its organization", async () => {
    const scope = await scopeFor({ memberships: [membership()] });
    expect(scope).toMatchObject({
      tenantId: "ORG-A",
      derivedFrom: "membership",
      membershipRef: "MEM-1",
    });
  });

  it("carries the membership's branch into the acting scope", async () => {
    const scope = await scopeFor({ memberships: [membership({ branchId: "BR-2" })] });
    expect(scope.branchRefs).toContain("BR-2");
  });
});

describe("the effective-date window is enforced", () => {
  it("excludes a membership that has not started", async () => {
    const scope = await scopeFor({ memberships: [membership({ effectiveFrom: day(1) })] });
    expect(scope.derivedFrom).toBe("single_tenant_fallback");
    expect(scope.tenantId).toBe(SINGLE_TENANT_ID);
    expect(scope.membershipRef).toBeNull();
  });

  it("excludes a membership that has ended", async () => {
    const scope = await scopeFor({ memberships: [membership({ effectiveTo: day(-1) })] });
    expect(scope.derivedFrom).toBe("single_tenant_fallback");
  });

  it("excludes one that ends exactly now, because the window is half-open", async () => {
    // `effectiveTo > now` is false at the boundary. Worth pinning: an
    // off-by-one here is a day of access after the end date.
    const scope = await scopeFor({ memberships: [membership({ effectiveTo: NOW })] });
    expect(scope.derivedFrom).toBe("single_tenant_fallback");
  });

  it("includes one that starts exactly now", async () => {
    const scope = await scopeFor({ memberships: [membership({ effectiveFrom: NOW })] });
    expect(scope.derivedFrom).toBe("membership");
  });

  it("keeps a live membership when a second one has expired", async () => {
    // The expired row must not make the live one ambiguous.
    const scope = await scopeFor({
      memberships: [
        membership({ orgRef: "ORG-OLD", membershipRef: "MEM-OLD", effectiveTo: day(-10) }),
        membership({ orgRef: "ORG-A", membershipRef: "MEM-NEW" }),
      ],
    });
    expect(scope).toMatchObject({ tenantId: "ORG-A", membershipRef: "MEM-NEW" });
  });
});

describe("two live memberships", () => {
  it("are refused rather than resolved", async () => {
    await expect(
      scopeFor({
        memberships: [
          membership({ orgRef: "ORG-A", membershipRef: "MEM-A" }),
          membership({ orgRef: "ORG-B", membershipRef: "MEM-B" }),
        ],
      })
    ).rejects.toBeInstanceOf(AmbiguousOrganization);
  });

  it("are not refused when one of them has expired", async () => {
    const scope = await scopeFor({
      memberships: [
        membership({ orgRef: "ORG-A", membershipRef: "MEM-A" }),
        membership({ orgRef: "ORG-B", membershipRef: "MEM-B", effectiveTo: day(-1) }),
      ],
    });
    expect(scope.tenantId).toBe("ORG-A");
  });
});

describe("what happens to somebody whose membership ended", () => {
  /**
   * The finding. Recorded as a test so it is a fact about the system rather
   * than a paragraph in a document, and so the day somebody changes it, this
   * file says what changed.
   */
  it("does not refuse them — they fall through to the single tenant", async () => {
    const scope = await scopeFor({
      grants: [{ scopeType: "global", scopeRef: null }],
      memberships: [membership({ effectiveTo: day(-1) })],
    });
    expect(scope.derivedFrom).toBe("single_tenant_fallback");
    expect(scope.tenantId).toBe(SINGLE_TENANT_ID);
  });

  it("keeps their role grants, because membership does not revoke a grant", async () => {
    // `userRoleAssignments` is queried on `revokedAt IS NULL` only. Ending a
    // membership writes nothing to it, so every grant survives and
    // `roleProcedure` still passes. Offboarding has to revoke the grants too;
    // ending the membership alone does not.
    const scope = await scopeFor({
      grants: [{ scopeType: "global", scopeRef: null }, { scopeType: "branch", scopeRef: "BR-9" }],
      memberships: [membership({ effectiveTo: day(-1) })],
    });
    expect(scope.global).toBe(true);
    expect(scope.branchRefs).toEqual(["BR-9"]);
  });

  it("is indistinguishable from somebody who never had a membership", async () => {
    // This is the heart of it. The fallback exists for deployments that predate
    // organizations; it is not a statement that the caller's access was ended.
    // Both produce the identical scope, so nothing downstream can tell an
    // ex-employee from a pre-organization user.
    const ended = await scopeFor({ memberships: [membership({ effectiveTo: day(-1) })] });
    const never = await scopeFor({ memberships: [] });
    expect(ended).toEqual(never);
  });

  it("loses their former organization's records, which is the isolation that does hold", async () => {
    // Their old organization's rows carry its orgRef and the default scope does
    // not match it, so the cross-tenant boundary is intact. What survives is
    // reach over rows that belong to nobody.
    const scope = await scopeFor({ memberships: [membership({ orgRef: "ORG-A", effectiveTo: day(-1) })] });
    expect(scope.tenantId).not.toBe("ORG-A");
  });
});
