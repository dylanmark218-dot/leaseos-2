/**
 * v22.20 (0086) — which organization a request acts for.
 *
 * The root fix for the hole found two checkpoints ago, where a caller could
 * name its own tenant because the server had no way to know one.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { grantUserRole } from "./db";
import { AmbiguousOrganization, mayScopePolicyTo, resolveActingScope, SINGLE_TENANT_ID, type ActingScope } from "./_core/actingScope";
import { organizationMemberships, organizations } from "../drizzle/schema";

describe("scoping a policy", () => {
  const acting = (o: Partial<ActingScope> = {}): ActingScope => ({ tenantId: "ORG-1", derivedFrom: "membership", membershipRef: "M-1", branchRefs: [], global: true, ...o });

  it("lets a global grant write company-wide and a branch grant only its own branch", () => {
    expect(mayScopePolicyTo(acting(), "company", null).allowed).toBe(true);
    const confined = acting({ global: false, branchRefs: ["B-MINE"] });
    expect(mayScopePolicyTo(confined, "company", null).allowed).toBe(false);
    expect(mayScopePolicyTo(confined, "branch", "B-MINE").allowed).toBe(true);
    expect(mayScopePolicyTo(confined, "branch", "B-THEIRS").allowed).toBe(false);
  });

  it("refuses a scoped policy that names no scope", () => {
    expect(mayScopePolicyTo(acting(), "branch", null)).toMatchObject({ allowed: false });
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let seq = 9_400_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; db = await getDb(); });
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await db.insert(organizations).values({ orgRef, name: `org ${orgRef}`, status: "active" });
  return orgRef;
}
async function member(userId: number, orgRef: string, over: Record<string, unknown> = {}) {
  await db.insert(organizationMemberships).values({
    membershipRef: `MEM-${rnd()}`, orgRef, userId, membershipType: "employee", status: "active",
    effectiveFrom: new Date("2020-01-01"), createdByUserId: 1, ...over,
  });
}

d("the organization comes from membership", () => {
  it("resolves the organization a member belongs to, and says where it came from", async () => {
    const userId = seq++;
    const o = await org();
    await member(userId, o, { branchId: "B-NORTH" });
    const scope = await resolveActingScope(db, userId);
    expect(scope).toMatchObject({ tenantId: o, derivedFrom: "membership" });
    expect(scope.membershipRef).toBeTruthy();
    expect(scope.branchRefs).toContain("B-NORTH");
  });

  it("REFUSES a user who is an active member of two organizations rather than picking one", async () => {
    const userId = seq++;
    const a = await org();
    const b = await org();
    await member(userId, a);
    await member(userId, b);
    await expect(resolveActingScope(db, userId)).rejects.toThrow(AmbiguousOrganization);
    await expect(resolveActingScope(db, userId)).rejects.toThrow(/has to be established, not guessed/i);
  });

  it("ignores a membership that has ended, so yesterday's employer is not today's tenant", async () => {
    const userId = seq++;
    const past = await org();
    const present = await org();
    await member(userId, past, { effectiveFrom: new Date("2020-01-01"), effectiveTo: new Date("2024-01-01") });
    await member(userId, present);
    const scope = await resolveActingScope(db, userId);
    expect(scope.tenantId).toBe(present);
  });

  it("ignores a suspended membership and a not-yet-effective one", async () => {
    const userId = seq++;
    const live = await org();
    const suspended = await org();
    const future = await org();
    await member(userId, live);
    await member(userId, suspended, { status: "suspended" });
    await member(userId, future, { effectiveFrom: new Date("2030-01-01") });
    expect((await resolveActingScope(db, userId)).tenantId).toBe(live);
  });

  it("falls back to the single tenant for a user with no membership, and marks it as a fallback", async () => {
    const userId = seq++;
    const scope = await resolveActingScope(db, userId);
    expect(scope).toMatchObject({ tenantId: SINGLE_TENANT_ID, derivedFrom: "single_tenant_fallback", membershipRef: null });
  });

  it("carries the caller's role-grant branches alongside the membership branch", async () => {
    const userId = seq++;
    const o = await org();
    await member(userId, o, { branchId: "B-FROM-MEMBERSHIP" });
    await grantUserRole({ userId, role: "safety", scopeType: "branch", scopeRef: "B-FROM-GRANT", grantedByUserId: 1, grantedAt: new Date() });
    const scope = await resolveActingScope(db, userId);
    expect(scope.branchRefs).toEqual(expect.arrayContaining(["B-FROM-GRANT", "B-FROM-MEMBERSHIP"]));
  });

  it("writes policy into the caller's own organization, not one they named", async () => {
    const userId = seq++;
    const o = await org();
    await member(userId, o);
    await grantUserRole({ userId, role: "management", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
    const scope = await resolveActingScope(db, userId);
    // The value that reaches oosReleasePolicies.tenantId.
    expect(scope.tenantId).toBe(o);
    expect(scope.tenantId).not.toBe(SINGLE_TENANT_ID);
    const [row] = await db.select().from(organizations).where(eq(organizations.orgRef, o));
    expect(row.status).toBe("active");
  });
});
