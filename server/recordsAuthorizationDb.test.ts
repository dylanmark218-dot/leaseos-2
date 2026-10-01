import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  grantUserRole,
  listActiveUserRoleNames,
  listActiveUserRoles,
  recordAuthorizationDecision,
  revokeUserRole,
} from "./db";
import { authorize } from "./_core/recordsAuthorization";

/**
 * The gate against a real database.
 *
 * The permission engine is pure and heavily tested on its own; what this proves
 * is the part that cannot be proven in memory — that a revoked grant actually
 * stops resolving, and that denials reach the audit table. A permission model
 * that is correct in a unit test and reads stale roles at runtime is not a
 * permission model.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
let nextUserId = 408_000_000 + Math.floor(Math.random() * 90000);
const newUserId = () => nextUserId++;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

d("role resolution", () => {
  it("resolves a granted role and drops it again on revocation", async () => {
    const userId = newUserId();

    expect(await listActiveUserRoleNames(userId)).toEqual([]);

    await grantUserRole({
      userId,
      role: "mechanic",
      grantedByUserId: 1,
      grantedAt: new Date(),
    });
    expect(await listActiveUserRoleNames(userId)).toEqual(["mechanic"]);

    // Authorization follows the live grant, not a cached snapshot.
    expect(
      authorize({
        userId,
        roles: await listActiveUserRoleNames(userId),
        permission: "maintenance.record_release",
      }).allowed
    ).toBe(true);

    await revokeUserRole({
      organization: null,
      userId,
      role: "mechanic",
      revokedByUserId: 1,
      reason: "Left the shop",
    });

    expect(await listActiveUserRoleNames(userId)).toEqual([]);
    const after = authorize({
      userId,
      roles: await listActiveUserRoleNames(userId),
      permission: "maintenance.record_release",
    });
    expect(after.allowed).toBe(false);
    expect(after.outcome).toBe("denied_no_role");
  });

  it("keeps the revoked grant on record rather than deleting it", async () => {
    const userId = newUserId();
    await grantUserRole({
      userId,
      role: "office",
      grantedByUserId: 1,
      grantedAt: new Date(),
    });
    await revokeUserRole({
      organization: null,
      userId,
      role: "office",
      revokedByUserId: 2,
      reason: "Moved to dispatch",
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT role, revokedAt, revokeReason, revokedByUserId FROM userRoleAssignments WHERE userId = ?",
      [userId]
    );
    // "What could this person do in March" stays answerable.
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].revokeReason).toBe("Moved to dispatch");
    expect(rows[0].revokedByUserId).toBe(2);
  });

  it("resolves several concurrent roles for one user", async () => {
    const userId = newUserId();
    const now = new Date();
    await grantUserRole({ userId, role: "safety", grantedByUserId: 1, grantedAt: now });
    await grantUserRole({ userId, role: "office", grantedByUserId: 1, grantedAt: now });

    const roles = (await listActiveUserRoleNames(userId)).sort();
    expect(roles).toEqual(["office", "safety"]);
    expect(
      authorize({ userId, roles, permission: "incident.read_investigation" }).allowed
    ).toBe(true);
    expect(authorize({ userId, roles, permission: "billing.read" }).allowed).toBe(true);
  });

  it("revokes one role without disturbing another", async () => {
    const userId = newUserId();
    const now = new Date();
    await grantUserRole({ userId, role: "mechanic", grantedByUserId: 1, grantedAt: now });
    await grantUserRole({ userId, role: "safety", grantedByUserId: 1, grantedAt: now });

    await revokeUserRole({ userId, role: "mechanic", organization: null, revokedByUserId: 1, reason: "Reassigned" });
    expect(await listActiveUserRoleNames(userId)).toEqual(["safety"]);
  });
});

d("authorization auditing", () => {
  it("records a denial, not only the successes", async () => {
    const userId = newUserId();
    const decision = authorize({
      userId,
      roles: ["mechanic"],
      permission: "billing.read",
    });
    expect(decision.allowed).toBe(false);

    await recordAuthorizationDecision({
      actorUserId: userId,
      procedureName: "records.evidence.export",
      permission: "billing.read",
      rolesHeld: "mechanic",
      outcome: decision.outcome,
      detail: decision.detail ?? null,
      occurredAt: new Date(),
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT outcome, permission, rolesHeld, detail FROM authorizationDecisions WHERE actorUserId = ?",
      [userId]
    );
    // A refused attempt is exactly what an audit wants and what a permissive
    // system never captures.
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("denied_permission");
    expect(rows[0].rolesHeld).toBe("mechanic");
    expect(String(rows[0].detail)).toContain("explicitly denied");
  });

  it("records an allowed decision with the roles that carried it", async () => {
    const userId = newUserId();
    await recordAuthorizationDecision({
      actorUserId: userId,
      procedureName: "records.incident.review",
      permission: "incident.review",
      rolesHeld: "safety",
      outcome: "allowed",
      detail: null,
      occurredAt: new Date(),
    });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT outcome, procedureName FROM authorizationDecisions WHERE actorUserId = ?",
      [userId]
    );
    expect(rows[0].outcome).toBe("allowed");
    expect(rows[0].procedureName).toBe("records.incident.review");
  });

  it("does not let an audit write failure change the gate", async () => {
    // Deliberately oversized field. The write is swallowed; the caller is
    // unaffected — audit failure must not become a way to flip the decision.
    const result = await recordAuthorizationDecision({
      actorUserId: newUserId(),
      procedureName: "x".repeat(500),
      permission: "billing.read",
      rolesHeld: null,
      outcome: "denied_permission",
      detail: null,
      occurredAt: new Date(),
    });
    expect(result).toBeUndefined();
  });
});
