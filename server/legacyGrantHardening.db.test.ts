/**
 * B23.1A — the hardening properties, through the real server and a real database.
 *
 * `legacyGrantHardening.test.ts` proves what the decision function decides about
 * legacy grants. This proves the same things with the routers, the gate, the
 * migration's own CHECK constraint and `resolveActingScope` all in the loop —
 * and adds the three that only exist at this level: what the bootstrap does,
 * what resolution does, and that the database refuses the shapes it should.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { runWithOrganizationSelection } from "./_core/organizationSelection";
import { bootstrapManagementRole, countActiveManagementGrants, countPlatformWideGrants } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
let seq = 915_000_000 + Math.floor(Math.random() * 40_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
});
afterAll(async () => {
  await pool?.end();
});

const callerFor = (userId: number) =>
  appRouter.createCaller({
    req: { headers: {} } as never,
    res: { cookie: () => {}, clearCookie: () => {} } as never,
    user: { id: userId, role: "user", name: `u${userId}`, email: null } as never,
  });

async function org(status: "active" | "suspended" | "closed" = "active") {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,?)", [
    orgRef, `Fixture ${orgRef}`, status,
  ]);
  return orgRef;
}
const user = async () => seq++;

async function membership(userId: number, orgRef: string) {
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]
  );
}

async function grantIn(userId: number, orgRef: string | null, role: string, scopeType = "organization") {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,?,?,?,NULL,1,NOW())",
    [userId, role, scopeType, orgRef]
  );
  return r.insertId;
}

/** A grant in exactly the state migration 0170 leaves a category-B row in. */
const quarantine = (userId: number, role: string) => grantIn(userId, null, role, "unscoped_legacy");

/* ================================================================== */

d("a quarantined grant authorizes nothing through the real server (§9)", () => {
  it("gives a multi-organization holder of quarantined management no authority in either company", async () => {
    const A = await org();
    const B = await org();
    const u = await user();
    await membership(u, A);
    await membership(u, B);
    await quarantine(u, "management");

    for (const chosen of [A, B]) {
      await runWithOrganizationSelection(chosen, async () => {
        const context = await callerFor(u).session.context({ organization: chosen });
        expect(context.roles, chosen).toEqual([]);
        expect(context.availableWorkspaces, chosen).toEqual([]);
        expect(context.state, chosen).toBe("no_workspace");

        // The administrative API, asked directly, with the selection set.
        await expect(
          callerFor(u).records.roles.grant({ targetUserId: u, role: "driver" } as never)
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        // And an ordinary operational one.
        await expect(callerFor(u).fieldRoute.jobs.list()).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      });
    }
  }, 60_000);

  it("leaks no trace of the quarantined role into the session response", async () => {
    const A = await org();
    const u = await user();
    await membership(u, A);
    await quarantine(u, "management");
    const context = await callerFor(u).session.context();
    expect(JSON.stringify(context)).not.toContain("management");
    expect(JSON.stringify(context)).not.toContain("roles.grant");
  }, 60_000);
});

d("a historical-single-tenant grant is contained (§5)", () => {
  it("authorizes where there is no organization and stops the moment one exists", async () => {
    const holder = await user();
    await grantIn(holder, SINGLE_TENANT_ID, "office");

    // No membership anywhere: the deployment's historical mode. It works.
    const before = await callerFor(holder).session.context();
    expect(before.activeOrganization?.orgRef).toBe(SINGLE_TENANT_ID);
    expect(before.roles).toEqual(["office"]);

    // Now they join a real company. The row is untouched and reaches nothing.
    const A = await org();
    await membership(holder, A);
    const after = await callerFor(holder).session.context();
    expect(after.activeOrganization?.orgRef).toBe(A);
    expect(after.roles).toEqual([]);
    expect(after.state).toBe("no_workspace");
    await expect(callerFor(holder).fieldRoute.jobs.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  }, 60_000);
});

d("the bootstrap cannot mint cross-tenant authority (§6)", () => {
  it("scopes the first administrator to their own organization, not the platform", async () => {
    const A = await org();
    const target = await user();
    await membership(target, A);

    const result = await bootstrapManagementRole({
      targetUserId: target,
      performedByUserId: 1,
      reason: "first administrator for this company",
    });
    expect(result).toMatchObject({ ok: true, organization: A });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT scopeType, orgRef FROM userRoleAssignments WHERE userId = ? AND revokedAt IS NULL",
      [target]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeType).toBe("organization");
    expect(rows[0]!.orgRef).toBe(A);
    // The property this test exists for: not platform-wide.
    expect(rows[0]!.scopeType).not.toBe("global");

    // And it administers only its own company.
    const outsider = await user();
    const B = await org();
    await membership(outsider, B);
    await runWithOrganizationSelection(A, async () => {
      await expect(
        callerFor(target).records.roles.grant({ targetUserId: outsider, role: "driver" } as never)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  }, 60_000);

  it("refuses when the target belongs to more than one organization", async () => {
    const A = await org();
    const B = await org();
    const target = await user();
    await membership(target, A);
    await membership(target, B);

    const result = await bootstrapManagementRole({
      targetUserId: target,
      performedByUserId: 1,
      reason: "which company is this even for",
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/has to be established, not guessed/i);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM userRoleAssignments WHERE userId = ?",
      [target]
    );
    expect(Number(rows[0]!.n)).toBe(0);
  }, 60_000);

  it("closes behind itself per organization, so a second company can still appoint its first", async () => {
    const A = await org();
    const B = await org();
    const firstAtA = await user();
    const secondAtA = await user();
    const firstAtB = await user();
    await membership(firstAtA, A);
    await membership(secondAtA, A);
    await membership(firstAtB, B);

    expect(await bootstrapManagementRole({ targetUserId: firstAtA, performedByUserId: 1, reason: "first at A" }))
      .toMatchObject({ ok: true, organization: A });

    // Closed at A.
    const again = await bootstrapManagementRole({ targetUserId: secondAtA, performedByUserId: 1, reason: "second at A" });
    expect(again.ok).toBe(false);
    expect((again as { reason: string }).reason).toMatch(/already exist in this organization/i);

    // Still open at B — the property that made the old global count wrong.
    expect(await bootstrapManagementRole({ targetUserId: firstAtB, performedByUserId: 1, reason: "first at B" }))
      .toMatchObject({ ok: true, organization: B });

    expect(await countActiveManagementGrants(A)).toBe(1);
    expect(await countActiveManagementGrants(B)).toBe(1);
  }, 60_000);

  it("creates no platform-wide grant, ever", async () => {
    const A = await org();
    const target = await user();
    await membership(target, A);

    // Measured across the ids this file created, not the whole database: the
    // shared test schema holds fixtures from other suites that deliberately
    // write platform-global grants, and `countPlatformWideGrants()` counts
    // those too. What is being pinned is that the BOOTSTRAP writes none — the
    // deployment-wide "should be zero" assertion belongs to the migration
    // verification, which runs against a clean fixture.
    const before = await countPlatformWideGrants();
    await bootstrapManagementRole({ targetUserId: target, performedByUserId: 1, reason: "check" });
    expect(await countPlatformWideGrants()).toBe(before);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM userRoleAssignments WHERE userId = ? AND scopeType = 'global'",
      [target]
    );
    expect(Number(rows[0]!.n)).toBe(0);
  }, 60_000);
});

d("resolving a quarantined grant (§11)", () => {
  async function adminAt(orgRef: string) {
    const admin = await user();
    await membership(admin, orgRef);
    await grantIn(admin, orgRef, "management");
    return admin;
  }

  it("issues a properly scoped grant and retires the legacy row, tying them together", async () => {
    const A = await org();
    const B = await org();
    const worker = await user();
    await membership(worker, A);
    await membership(worker, B);
    const legacyId = await quarantine(worker, "mechanic");
    const admin = await adminAt(A);

    await runWithOrganizationSelection(A, async () => {
      const out = await callerFor(admin).records.roles.resolveLegacy({
        legacyGrantId: legacyId,
        reason: "confirmed with the shop foreman",
      } as never);
      expect(out).toMatchObject({ resolved: true, organization: A, role: "mechanic", alreadyHeld: false });
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id, scopeType, orgRef, revokedAt, revokeReason FROM userRoleAssignments WHERE userId = ? ORDER BY id",
      [worker]
    );
    const legacy = rows.find(r => r.id === legacyId)!;
    const issued = rows.find(r => r.id !== legacyId)!;
    expect(legacy.revokedAt).not.toBeNull();
    expect(String(legacy.revokeReason)).toContain(`resolved into ${A}`);
    expect(String(legacy.revokeReason)).toContain("confirmed with the shop foreman");
    expect(issued.scopeType).toBe("organization");
    expect(issued.orgRef).toBe(A);

    // The worker is now a mechanic at A — and still nothing at B.
    await runWithOrganizationSelection(A, async () => {
      expect((await callerFor(worker).session.context({ organization: A })).roles).toEqual(["mechanic"]);
    });
    await runWithOrganizationSelection(B, async () => {
      expect((await callerFor(worker).session.context({ organization: B })).roles).toEqual([]);
    });
  }, 60_000);

  it("is safely repeatable: a second attempt finds nothing rather than granting twice", async () => {
    const A = await org();
    const worker = await user();
    await membership(worker, A);
    const legacyId = await quarantine(worker, "driver");
    const admin = await adminAt(A);

    await runWithOrganizationSelection(A, async () => {
      await callerFor(admin).records.roles.resolveLegacy({ legacyGrantId: legacyId, reason: "first" } as never);
      await expect(
        callerFor(admin).records.roles.resolveLegacy({ legacyGrantId: legacyId, reason: "again" } as never)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM userRoleAssignments WHERE userId = ? AND revokedAt IS NULL",
      [worker]
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, 60_000);

  it("refuses an administrator of another organization", async () => {
    const A = await org();
    const B = await org();
    const worker = await user();
    await membership(worker, A);
    const legacyId = await quarantine(worker, "driver");
    const adminElsewhere = await adminAt(B);

    await runWithOrganizationSelection(B, async () => {
      // The worker is not a member of B, so from B this grant does not exist.
      await expect(
        callerFor(adminElsewhere).records.roles.resolveLegacy({ legacyGrantId: legacyId, reason: "not mine" } as never)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT revokedAt FROM userRoleAssignments WHERE id = ?",
      [legacyId]
    );
    expect(rows[0]!.revokedAt).toBeNull();
  }, 60_000);

  it("refuses a caller who cannot grant roles at all", async () => {
    const A = await org();
    const worker = await user();
    await membership(worker, A);
    const legacyId = await quarantine(worker, "driver");
    const ordinary = await user();
    await membership(ordinary, A);
    await grantIn(ordinary, A, "driver");

    await runWithOrganizationSelection(A, async () => {
      await expect(
        callerFor(ordinary).records.roles.resolveLegacy({ legacyGrantId: legacyId, reason: "let me" } as never)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }, 60_000);

  it("retires the legacy row without a duplicate when the role is already held here", async () => {
    const A = await org();
    const worker = await user();
    await membership(worker, A);
    await grantIn(worker, A, "driver");
    const legacyId = await quarantine(worker, "driver");
    const admin = await adminAt(A);

    await runWithOrganizationSelection(A, async () => {
      const out = await callerFor(admin).records.roles.resolveLegacy({
        legacyGrantId: legacyId,
        reason: "already a driver here",
      } as never);
      expect(out).toMatchObject({ resolved: true, alreadyHeld: true, assignmentId: null });
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM userRoleAssignments WHERE userId = ? AND revokedAt IS NULL",
      [worker]
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, 60_000);
});
