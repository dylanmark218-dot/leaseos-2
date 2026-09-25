/**
 * What an ended membership actually does, proved rather than assumed.
 *
 * The question this answers: does an inactive or expired
 * `organizationMembership` lose access through the canonical server path?
 *
 * `resolveActingScope` filters memberships in JavaScript, over one joined read
 * (`organizationMemberships` LEFT JOIN `organizations`): the membership's status,
 * the organization's own status, and the effective-date window. Since the
 * auth-workspace checkpoint (#64) moved the status filter out of the SQL WHERE,
 * this fake database exercises all three; `actingScopeMembership.db.test.ts`
 * still runs the same questions against real MariaDB.
 *
 * **The finding this file first recorded is closed.** On main before #64, a user
 * with no surviving membership fell through to `single_tenant_fallback` and acted
 * as the deployment's default tenant, carrying every role grant they still held.
 * #64 refuses them instead (`MembershipRevoked`): access ends with the
 * membership, not with the role grant. A user who never had a membership still
 * falls through, because that fallback exists for deployments that predate
 * organizations. The cases below say which is which.
 */
import { describe, expect, it } from "vitest";
import { organizationMemberships, userRoleAssignments } from "../drizzle/schema";
import {
  AmbiguousOrganization,
  MembershipRevoked,
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
  status: string;
};

const membership = (over: Partial<MembershipRow> = {}): MembershipRow => ({
  orgRef: "ORG-A",
  membershipRef: "MEM-1",
  branchId: null,
  effectiveFrom: day(-30),
  effectiveTo: null,
  status: "active",
  ...over,
});

/**
 * A database that answers the two reads `resolveActingScope` makes: the live
 * grants (`userRoleAssignments … WHERE`), and the memberships joined to their
 * organizations (`organizationMemberships LEFT JOIN organizations … WHERE`),
 * each row shaped `{ m, orgStatus }`. It returns the rows it is given; every
 * membership filter the resolver applies runs on them in JavaScript.
 */
const fakeDb = (rows: { grants?: { scopeType: string; scopeRef: string | null }[]; memberships?: MembershipRow[]; orgStatus?: string | null }) => {
  const joined = (rows.memberships ?? []).map(m => ({ m, orgStatus: rows.orgStatus === undefined ? "active" : rows.orgStatus }));
  return {
    select: (_columns?: unknown) => ({
      from: (table: unknown) => ({
        where: (_predicate: unknown) => Promise.resolve(table === userRoleAssignments ? rows.grants ?? [] : []),
        leftJoin: (_t: unknown, _on: unknown) => ({
          where: (_predicate: unknown) => Promise.resolve(table === organizationMemberships ? joined : []),
        }),
      }),
    }),
  } as never;
};

const scopeFor = (rows: Parameters<typeof fakeDb>[0]) =>
  resolveActingScope(fakeDb(rows), 4242, { at: NOW });   // #64 took resolveActingScope's third argument to an options object

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
  // Excluded means refused: a user whose only membership is outside its window has
  // no live membership, and since #64 that ends access rather than falling through.
  it("excludes a membership that has not started", async () => {
    await expect(scopeFor({ memberships: [membership({ effectiveFrom: day(1) })] })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("excludes a membership that has ended", async () => {
    await expect(scopeFor({ memberships: [membership({ effectiveTo: day(-1) })] })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("excludes one that ends exactly now, because the window is half-open", async () => {
    // `effectiveTo > now` is false at the boundary. Worth pinning: an
    // off-by-one here is a day of access after the end date.
    await expect(scopeFor({ memberships: [membership({ effectiveTo: NOW })] })).rejects.toBeInstanceOf(MembershipRevoked);
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

describe("the membership's own status, and its company's", () => {
  it("excludes a suspended membership", async () => {
    await expect(scopeFor({ memberships: [membership({ status: "suspended" })] })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("excludes a membership in a company that is not trading", async () => {
    await expect(scopeFor({ memberships: [membership()], orgStatus: "suspended" })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("excludes a membership whose organization row is missing", async () => {
    await expect(scopeFor({ memberships: [membership()], orgStatus: null })).rejects.toBeInstanceOf(MembershipRevoked);
  });
});

describe("what happens to somebody whose membership ended", () => {
  /**
   * The finding this file first recorded, now closed by #64. Before it, an ended
   * membership fell through to the single tenant with every role grant intact.
   */
  it("refuses them, rather than falling through to the single tenant", async () => {
    await expect(scopeFor({
      grants: [{ scopeType: "global", scopeRef: null }],
      memberships: [membership({ effectiveTo: day(-1) })],
    })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("refuses them even though their role grants still stand", async () => {
    // Ending a membership still writes nothing to `userRoleAssignments`; the
    // refusal no longer depends on offboarding revoking the grants as well.
    await expect(scopeFor({
      grants: [{ scopeType: "global", scopeRef: null }, { scopeType: "branch", scopeRef: "BR-9" }],
      memberships: [membership({ effectiveTo: day(-1) })],
    })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("is told apart from somebody who never had a membership", async () => {
    // The fallback exists for deployments that predate organizations. Somebody
    // who never had a membership still gets it; an ex-member does not.
    const never = await scopeFor({ memberships: [] });
    expect(never).toMatchObject({ derivedFrom: "single_tenant_fallback", tenantId: SINGLE_TENANT_ID });
    await expect(scopeFor({ memberships: [membership({ effectiveTo: day(-1) })] })).rejects.toBeInstanceOf(MembershipRevoked);
  });

  it("keeps a live membership in another company when one has ended", async () => {
    const scope = await scopeFor({ memberships: [
      membership({ orgRef: "ORG-OLD", membershipRef: "MEM-OLD", effectiveTo: day(-1) }),
      membership({ orgRef: "ORG-B", membershipRef: "MEM-B" }),
    ] });
    expect(scope).toMatchObject({ tenantId: "ORG-B", derivedFrom: "membership" });
  });
});
