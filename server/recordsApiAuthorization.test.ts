import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { recordsRouter } from "./recordsRouter";
import {
  RECORDS_PROCEDURE_PERMISSIONS,
  authorize,
  type DomainRole,
} from "./_core/recordsAuthorization";
import {
  bootstrapManagementRole,
  countActiveManagementGrants,
  grantUserRole,
  listActiveUserRoleNames,
  listActiveUserRoles,
  revokeUserRole,
} from "./db";

/**
 * The gate as callers actually meet it.
 *
 * The permission engine is proven in isolation elsewhere. What matters here is
 * that the router in front of it refuses the same things — a correct engine
 * behind a procedure that forgot to use it protects nothing. Every request goes
 * through the real `appRouter`, with a forged context, exactly as a client with
 * a session cookie and no UI would.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
// A 400k-wide window starting at 500,000 overlapped bulkFuel.test.ts, which
// begins at 880,000 — so this file could allocate a user another file had
// already granted a role to, and the role assertions here would see one extra.
// Every other file in this suite uses a narrow window at a widely spaced base;
// this now follows that convention instead of spanning half of them.
let nextId = 12_000_000 + Math.floor(Math.random() * 60_000);
const newUserId = () => nextId++;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

/** A caller with a session and whatever roles we granted them — no UI involved. */
const callerFor = (userId: number) =>
  appRouter.createCaller({
    req: {} as never,
    res: {} as never,
    user: { id: userId, role: "user" } as never,
  });

async function userWithRoles(roles: DomainRole[], scopeRef?: string) {
  const userId = newUserId();
  for (const role of roles) {
    await grantUserRole({
      userId,
      role,
      scopeType: scopeRef ? "branch" : "global",
      scopeRef: scopeRef ?? null,
      grantedByUserId: 1,
      grantedAt: new Date(),
    });
  }
  return userId;
}

const isForbidden = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e &&
  ((e as { code: string }).code === "FORBIDDEN" ||
    (e as { code: string }).code === "UNAUTHORIZED");

/** Ran the call; returns "forbidden" or whatever else happened. */
async function attempt(fn: () => Promise<unknown>): Promise<"forbidden" | "passed_gate"> {
  try {
    await fn();
    return "passed_gate";
  } catch (e) {
    if (isForbidden(e)) return "forbidden";
    // Any other error means the gate let it through and the domain complained.
    return "passed_gate";
  }
}

d("the gate is on every records procedure", () => {
  it("declares a permission for all 21 procedures", () => {
    expect(Object.keys(RECORDS_PROCEDURE_PERMISSIONS).length).toBe(21);
  });

  it("mounts records on the app router", () => {
    expect(appRouter._def.record.records).toBeDefined();
    expect(recordsRouter).toBeDefined();
  });

  it("refuses at wiring time to build a procedure with no declared permission", async () => {
    // The second permanently-pinned security test. A developer adding
    // `newSensitiveThing: protectedProcedure` cannot silently bypass the
    // system — an unmapped name throws when the module is constructed, so it
    // is an application failure rather than a runtime denial nobody notices.
    const { roleProcedure } = await import("./_core/trpc");
    // Deliberately not a real procedure name. TypeScript now rejects it at compile time as well,
    // which is the better layer; the cast keeps this runtime check meaningful for anything that
    // reaches roleProcedure without going through the types.
    expect(() => roleProcedure("records.evidence.deleteEverything" as never)).toThrow(
      /No permission mapped/
    );
    expect(() => roleProcedure("records.evidence.seal")).not.toThrow();
  });
});

d("unauthenticated and role-less callers", () => {
  it("refuses a caller with no session", async () => {
    const anon = appRouter.createCaller({
      req: {} as never,
      res: {} as never,
      user: null,
    });
    expect(await attempt(() => anon.records.evidence.listForOperator())).toBe("forbidden");
  });

  it("refuses an authenticated user holding no domain role", async () => {
    // Fail-closed: logging in grants nothing on its own.
    const caller = callerFor(newUserId());
    expect(await attempt(() => caller.records.evidence.listForOperator())).toBe("forbidden");
    expect(await attempt(() => caller.records.roadside.open())).toBe("forbidden");
  });
});

d("cross-role denials through the real router", () => {
  it("refuses a driver reaching the export path", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() => caller.records.evidence.export({ evidenceIds: [1] }))
    ).toBe("forbidden");
  });

  it("refuses a mechanic opening an incident investigation", async () => {
    const caller = callerFor(await userWithRoles(["mechanic"]));
    expect(
      await attempt(() =>
        caller.records.incident.readInvestigation({ incidentNumber: "INC-1" })
      )
    ).toBe("forbidden");
  });

  it("refuses a dispatcher opening an incident investigation", async () => {
    const caller = callerFor(await userWithRoles(["dispatcher"]));
    expect(
      await attempt(() =>
        caller.records.incident.readInvestigation({ incidentNumber: "INC-1" })
      )
    ).toBe("forbidden");
  });

  it("refuses an office user recording a mechanic release", async () => {
    const caller = callerFor(await userWithRoles(["office"]));
    expect(
      await attempt(() =>
        caller.records.maintenance.recordRelease({
          workOrderId: 1,
          releaseType: "full",
          repairSummary: "x",
          roadTestPerformed: true,
          technicianIdentifier: "TECH-1",
        })
      )
    ).toBe("forbidden");
  });

  it("refuses management recording a mechanic release", async () => {
    // Signing off is not the same as performing the work.
    const caller = callerFor(await userWithRoles(["management"]));
    expect(
      await attempt(() =>
        caller.records.maintenance.recordRelease({
          workOrderId: 1,
          releaseType: "full",
          repairSummary: "x",
          roadTestPerformed: true,
          technicianIdentifier: "TECH-1",
        })
      )
    ).toBe("forbidden");
  });

  it("refuses management releasing a legal hold", async () => {
    const caller = callerFor(await userWithRoles(["management"]));
    expect(
      await attempt(() =>
        caller.records.legalHold.release({
          holdNumber: "LH-1",
          reason: "concluded",
          authority: "counsel",
        })
      )
    ).toBe("forbidden");
  });

  it("allows legal to release a hold past the gate", async () => {
    const caller = callerFor(await userWithRoles(["legal"]));
    // Passes authorization; the domain then rejects an unknown hold number.
    expect(
      await attempt(() =>
        caller.records.legalHold.release({
          holdNumber: "LH-does-not-exist",
          reason: "concluded",
          authority: "counsel",
        })
      )
    ).toBe("passed_gate");
  });

  it("refuses an auditor amending evidence", async () => {
    const caller = callerFor(await userWithRoles(["auditor"]));
    expect(
      await attempt(() =>
        caller.records.evidence.amend({
          evidenceId: 1,
          newContentHash: "a".repeat(64),
          reason: "tidy up",
        })
      )
    ).toBe("forbidden");
  });

  it("refuses a driver granting themselves a role", async () => {
    const driver = await userWithRoles(["driver"]);
    const caller = callerFor(driver);
    expect(
      await attempt(() =>
        caller.records.roles.grant({ targetUserId: driver, role: "management" })
      )
    ).toBe("forbidden");
    expect(await listActiveUserRoleNames(driver)).toEqual(["driver"]);
  });

  it("refuses a safety user disposing of retained records", async () => {
    const caller = callerFor(await userWithRoles(["safety"]));
    expect(
      await attempt(() => caller.records.retention.disposition({ evidenceId: 1 }))
    ).toBe("forbidden");
  });
});

d("positive paths reach the domain", () => {
  it("lets a driver open roadside inspection mode", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    const view = await caller.records.roadside.open();
    expect(view.scope.length).toBeGreaterThan(0);
    expect(view.hoursOfService.days).toBe(15);
    expect(view).not.toHaveProperty("billing");
  });

  it("lets safety review an incident and read an investigation", async () => {
    const caller = callerFor(await userWithRoles(["safety"]));
    expect(
      await attempt(() => caller.records.incident.review({ incidentNumber: "INC-x" }))
    ).toBe("passed_gate");
    expect(
      await attempt(() =>
        caller.records.incident.readInvestigation({ incidentNumber: "INC-x" })
      )
    ).toBe("passed_gate");
  });

  it("lets management grant a role", async () => {
    const boss = await userWithRoles(["management"]);
    const target = newUserId();
    const caller = callerFor(boss);
    await caller.records.roles.grant({ targetUserId: target, role: "dispatcher" });
    expect(await listActiveUserRoleNames(target)).toEqual(["dispatcher"]);
  });
});

d("revocation takes effect on the next request", () => {
  it("stops access immediately after the grant is revoked", async () => {
    const userId = await userWithRoles(["safety"]);
    const caller = callerFor(userId);

    expect(
      await attempt(() => caller.records.incident.review({ incidentNumber: "INC-y" }))
    ).toBe("passed_gate");

    await revokeUserRole({
      userId,
      role: "safety",
      revokedByUserId: 1,
      reason: "Role change",
    });

    // No cached claims: the very next call resolves roles again and denies.
    expect(
      await attempt(() => caller.records.incident.review({ incidentNumber: "INC-y" }))
    ).toBe("forbidden");
  });
});

d("active grant uniqueness is enforced by the database", () => {
  it("refuses a duplicate active grant", async () => {
    const userId = newUserId();
    await grantUserRole({
      userId, role: "mechanic", scopeType: "global",
      grantedByUserId: 1, grantedAt: new Date(),
    });
    // 0020's UNIQUE(userId, role, scopeRef, revokedAt) did not catch this:
    // MySQL permits unlimited NULLs in a unique index, and an active grant is
    // exactly the row where revokedAt IS NULL.
    await expect(
      grantUserRole({
        userId, role: "mechanic", scopeType: "global",
        grantedByUserId: 1, grantedAt: new Date(),
      })
    ).rejects.toThrow();
    expect(await listActiveUserRoleNames(userId)).toEqual(["mechanic"]);
  });

  it("allows a regrant after revocation and keeps the history", async () => {
    const userId = newUserId();
    await grantUserRole({
      userId, role: "office", scopeType: "global",
      grantedByUserId: 1, grantedAt: new Date(),
    });
    await revokeUserRole({ userId, role: "office", revokedByUserId: 1, reason: "moved" });
    await grantUserRole({
      userId, role: "office", scopeType: "global",
      grantedByUserId: 1, grantedAt: new Date(),
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT revokedAt, activeGrantKey FROM userRoleAssignments WHERE userId = ? ORDER BY id",
      [userId]
    );
    expect(rows.length).toBe(2);
    expect(rows[0].activeGrantKey).toBeNull();
    expect(rows[1].activeGrantKey).toBe(`${userId}:office:*`);
  });

  it("keeps branch scopes independently valid", async () => {
    const userId = newUserId();
    const now = new Date();
    await grantUserRole({ userId, role: "dispatcher", scopeType: "branch", scopeRef: "GP", grantedByUserId: 1, grantedAt: now });
    await grantUserRole({ userId, role: "dispatcher", scopeType: "branch", scopeRef: "EDM", grantedByUserId: 1, grantedAt: now });
    // listActiveUserRoles, not the name projection: this asserts grantUserRole's
    // per-branch uniqueness key, and the name projection now reports global roles
    // only — which for this user is none.
    expect((await listActiveUserRoles(userId)).length).toBe(2);

    // Same branch twice is still a duplicate.
    await expect(
      grantUserRole({ userId, role: "dispatcher", scopeType: "branch", scopeRef: "GP", grantedByUserId: 1, grantedAt: now })
    ).rejects.toThrow();
  });

  it("does not let a branch grant reach another branch", async () => {
    const userId = await userWithRoles(["dispatcher"], "GP");
    const grants = (await import("./db")).listActiveUserRoles;
    const held = await grants(userId);
    expect(
      authorize({ userId, grants: held, permission: "maintenance.read_defect", resourceBranch: "GP" }).allowed
    ).toBe(true);
    expect(
      authorize({ userId, grants: held, permission: "maintenance.read_defect", resourceBranch: "EDM" }).allowed
    ).toBe(false);
  });
});

d("management bootstrap", () => {
  it("refuses once any active management grant exists", async () => {
    // Ordered after the positive tests above, which have already created
    // management holders — the path must be closed by then.
    const before = await countActiveManagementGrants();
    expect(before).toBeGreaterThan(0);

    const result = await bootstrapManagementRole({
      targetUserId: newUserId(),
      performedByUserId: 1,
      reason: "attempted second bootstrap",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("closed");
  });

  it("requires a stated reason", async () => {
    const result = await bootstrapManagementRole({
      targetUserId: newUserId(),
      performedByUserId: 1,
      reason: "   ",
    });
    expect(result.ok).toBe(false);
  });

  it("grants management and nothing else when it does run", async () => {
    // Proven against a clean slate: revoke every management grant, bootstrap,
    // then confirm exactly one role landed and the event was recorded.
    await pool.execute(
      "UPDATE userRoleAssignments SET revokedAt = NOW(), revokedByUserId = 1, revokeReason = 'test reset' WHERE role = 'management' AND revokedAt IS NULL"
    );
    expect(await countActiveManagementGrants()).toBe(0);

    const target = newUserId();
    const result = await bootstrapManagementRole({
      targetUserId: target,
      performedByUserId: 1,
      reason: "initial platform setup",
    });
    expect(result.ok).toBe(true);
    expect(await listActiveUserRoleNames(target)).toEqual(["management"]);

    const [events] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT reason, activeManagementCountBefore FROM roleBootstrapEvents WHERE targetUserId = ?",
      [target]
    );
    expect(events.length).toBe(1);
    expect(events[0].activeManagementCountBefore).toBe(0);

    // And it is closed again immediately.
    const second = await bootstrapManagementRole({
      targetUserId: newUserId(),
      performedByUserId: 1,
      reason: "again",
    });
    expect(second.ok).toBe(false);
  });
});

d("denials reach the audit table", () => {
  it("records the refusal, not only the successes", async () => {
    const userId = await userWithRoles(["driver"]);
    const caller = callerFor(userId);
    await attempt(() => caller.records.evidence.export({ evidenceIds: [1] }));

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT outcome, permission, procedureName FROM authorizationDecisions WHERE actorUserId = ? ORDER BY id DESC LIMIT 1",
      [userId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("denied_permission");
    expect(rows[0].permission).toBe("evidence.export");
    expect(rows[0].procedureName).toBe("records.evidence.export");
  });

  it("records the roles held at the moment of the decision", async () => {
    const userId = await userWithRoles(["dispatcher"], "GP");
    const caller = callerFor(userId);
    await attempt(() => caller.records.evidence.export({ evidenceIds: [1] }));

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT rolesHeld FROM authorizationDecisions WHERE actorUserId = ? ORDER BY id DESC LIMIT 1",
      [userId]
    );
    expect(rows[0].rolesHeld).toBe("dispatcher@GP");
  });
});
