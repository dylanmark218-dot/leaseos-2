/**
 * B23.1 — the cross-organization boundary, through the real server.
 *
 * `organizationScopedRoles.test.ts` proves what the decision function decides.
 * This proves what the SERVER does when there is no client to have hidden
 * anything: every call goes through `appRouter.createCaller` with a context
 * carrying nothing but a user id, so the routers, `roleProcedure`,
 * `resolveActingScope` and the database constraints are all the real ones.
 *
 * The scenario throughout is the one the checkpoint brief names: one account,
 * two companies, a different job in each.
 *
 *   ABC Transport  grants  driver
 *   XYZ Oilfield   grants  mechanic
 *
 * Acting for ABC, this account is a driver and nothing else. Acting for XYZ it
 * is a mechanic and nothing else. Neither company's authority follows it into
 * the other, and no amount of cookie, input or route manipulation changes that.
 *
 * If a future change removes the organization axis, this file is what fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { runWithOrganizationSelection } from "./_core/organizationSelection";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
let seq = 884_000_000 + Math.floor(Math.random() * 40_000);
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
    orgRef,
    `Fixture ${orgRef}`,
    status,
  ]);
  return orgRef;
}

async function user() {
  return seq++;
}

async function membership(
  userId: number,
  orgRef: string,
  over: { status?: string; effectiveTo?: string | null } = {}
) {
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, effectiveTo, createdByUserId) VALUES (?,?,?,'employee',?,'2020-01-01',?,1)",
    [`MEM-${rnd()}`, orgRef, userId, over.status ?? "active", over.effectiveTo ?? null]
  );
}

/** A grant as B23.1 stores it: a role, the organization that issued it, a scope. */
async function grantIn(
  userId: number,
  orgRef: string | null,
  role: string,
  over: { scopeType?: string; scopeRef?: string | null } = {}
) {
  const scopeType = over.scopeType ?? (over.scopeRef ? "branch" : "organization");
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,?,?,?,?,1,NOW())",
    [userId, role, scopeType, orgRef, over.scopeRef ?? null]
  );
}

async function jobOwnedBy(orgRef: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)",
    [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]
  );
  return { id: j.insertId };
}

/** The brief's scenario: driver at ABC, mechanic at XYZ, one account. */
async function dualEmployed() {
  const A = await org();
  const B = await org();
  const u = await user();
  await membership(u, A);
  await membership(u, B);
  await grantIn(u, A, "driver");
  await grantIn(u, B, "mechanic");
  return { A, B, userId: u };
}

/* ================================================================== */

d("TEST 1 — one account, two organizations, a different job in each", () => {
  it("resolves driver at ABC and mechanic at XYZ, and never both at once", async () => {
    const { A, B, userId } = await dualEmployed();

    await runWithOrganizationSelection(A, async () => {
      const atA = await callerFor(userId).session.context({ organization: A });
      expect(atA.state).toBe("ready");
      expect(atA.roles).toEqual(["driver"]);
      expect(atA.availableWorkspaces.map(w => w.key)).toContain("field_workforce");
      expect(atA.availableWorkspaces.map(w => w.key)).not.toContain("fleet_maintenance");
    });

    await runWithOrganizationSelection(B, async () => {
      const atB = await callerFor(userId).session.context({ organization: B });
      expect(atB.roles).toEqual(["mechanic"]);
      expect(atB.availableWorkspaces.map(w => w.key)).toContain("fleet_maintenance");
      expect(atB.availableWorkspaces.map(w => w.key)).not.toContain("field_workforce");
    });

    // One identity throughout. Two companies, not two accounts.
    expect(userId).toBeGreaterThan(0);
  }, 60_000);

  it("refuses the other company's capability at the API, not just in the menu", async () => {
    const { A, B, userId } = await dualEmployed();
    const unit = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)",
      [`U-${rnd()}`, "hydrovac"]
    );
    const unitId = (unit[0] as mysql.ResultSetHeader).insertId;
    await pool.execute(
      "INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)",
      [A, unitId]
    );
    const [wo] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO workOrders (workOrderNumber, unitId, status, priority, openedAt, technician, createdAt, updatedAt) VALUES (?,?, 'in_progress','routine','2026-09-01 00:00:00','J. Reyes', NOW(), NOW())",
      [`WO-${rnd()}`, unitId]
    );

    // The mechanic grant belongs to XYZ. Acting for ABC it does not exist, so
    // the release is refused even though the unit is ABC's own.
    await runWithOrganizationSelection(A, async () => {
      await expect(
        callerFor(userId).records.maintenance.recordRelease({
          workOrderId: wo.insertId,
          releaseType: "full",
          repairSummary: "brake line replaced and bled",
          roadTestPerformed: true,
          technicianIdentifier: "TECH-1",
        } as never)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }, 60_000);
});

d("TEST 3 — administrative authority does not cross organizations", () => {
  it("refuses a role grant in the company that did not make them an administrator", async () => {
    const A = await org();
    const B = await org();
    const admin = await user();
    await membership(admin, A);
    await membership(admin, B);
    // Management at ABC only.
    await grantIn(admin, A, "management");
    await grantIn(admin, B, "driver");

    const targetAtB = await user();
    await membership(targetAtB, B);

    // Acting for XYZ, this account is a driver. `roles.grant` is refused at
    // the gate: the management grant is not in the set the decision is made
    // from, so it cannot be outvoted or overridden.
    await runWithOrganizationSelection(B, async () => {
      await expect(
        callerFor(admin).records.roles.grant({ targetUserId: targetAtB, role: "mechanic" } as never)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // Acting for ABC, the same account administers normally — proving the
    // refusal above is the boundary and not a broken fixture.
    const targetAtA = await user();
    await membership(targetAtA, A);
    await runWithOrganizationSelection(A, async () => {
      await expect(
        callerFor(admin).records.roles.grant({ targetUserId: targetAtA, role: "mechanic" } as never)
      ).resolves.toMatchObject({ granted: true, organization: A });
    });
  }, 60_000);

  it("writes the grant into the actor's own organization, never one named by the request", async () => {
    const A = await org();
    const B = await org();
    const admin = await user();
    await membership(admin, A);
    await grantIn(admin, A, "management");
    const target = await user();
    await membership(target, A);

    await runWithOrganizationSelection(A, async () => {
      await callerFor(admin).records.roles.grant({ targetUserId: target, role: "driver" } as never);
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT orgRef, scopeType FROM userRoleAssignments WHERE userId = ? AND revokedAt IS NULL",
      [target]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgRef).toBe(A);
    expect(rows[0]!.scopeType).toBe("organization");
    expect(rows[0]!.orgRef).not.toBe(B);
  }, 60_000);

  it("refuses to grant to somebody who is not a member of the actor's organization", async () => {
    const A = await org();
    const B = await org();
    const admin = await user();
    await membership(admin, A);
    await grantIn(admin, A, "management");
    const outsider = await user();
    await membership(outsider, B);

    await runWithOrganizationSelection(A, async () => {
      // "Not found", never "forbidden": whether that person exists elsewhere
      // is not this organization's business.
      await expect(
        callerFor(admin).records.roles.grant({ targetUserId: outsider, role: "driver" } as never)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  }, 60_000);
});

d("TEST 2 — a forged organization selection grants nothing", () => {
  it("ignores a cookie naming an organization the account does not belong to", async () => {
    const { A, userId } = await dualEmployed();
    const stranger = await org();
    const strangerJob = await jobOwnedBy(stranger);

    await runWithOrganizationSelection(stranger, async () => {
      // Not resolved into the forged organization: the caller is a live member
      // of two others and has effectively selected neither.
      await expect(callerFor(userId).fieldRoute.jobs.list()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      await expect(
        callerFor(userId).session.selectOrganization({ organization: stranger })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // And a real selection does not reach the stranger's records either.
    await runWithOrganizationSelection(A, async () => {
      const listed = await callerFor(userId).fieldRoute.jobs.list();
      expect(listed.map((j: { id: number }) => j.id)).not.toContain(strangerJob.id);
    });
  }, 60_000);

  it("ignores an organization named in the tRPC input as well as in the cookie", async () => {
    const { A, B, userId } = await dualEmployed();
    await runWithOrganizationSelection(A, async () => {
      // The input asks for XYZ; the verified selection is ABC. The input is a
      // request, not an assertion, and it is checked against membership — so
      // asking for a real other employer resolves there, while asking for a
      // company they do not belong to resolves nowhere.
      const stranger = await org();
      const forged = await callerFor(userId).session.context({ organization: stranger });
      expect(forged.state).toBe("organization_required");
      expect(forged.availableWorkspaces).toEqual([]);
      // B is genuinely theirs, so naming it is honoured — that is selection,
      // not forgery, and the roles that come back are XYZ's only.
      const real = await callerFor(userId).session.context({ organization: B });
      expect(real.roles).toEqual(["mechanic"]);
    });
  }, 60_000);
});

d("TEST 4 — the workspace menu cannot be talked into another company's portal", () => {
  it("refuses selectWorkspace for a portal only the other organization grants", async () => {
    const { A, B, userId } = await dualEmployed();
    await runWithOrganizationSelection(A, async () => {
      await expect(
        callerFor(userId).session.selectWorkspace({ workspace: "fleet_maintenance", organization: A })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      // The one ABC does grant works.
      await expect(
        callerFor(userId).session.selectWorkspace({ workspace: "field_workforce", organization: A })
      ).resolves.toMatchObject({ workspace: "field_workforce" });
    });
    // Symmetric at XYZ.
    await runWithOrganizationSelection(B, async () => {
      await expect(
        callerFor(userId).session.selectWorkspace({ workspace: "field_workforce", organization: B })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }, 60_000);

  it("carries no capability belonging to the other organization in the session response (§14)", async () => {
    const { A, userId } = await dualEmployed();
    await runWithOrganizationSelection(A, async () => {
      const atA = await callerFor(userId).session.context({ organization: A });
      const everything = JSON.stringify(atA);
      expect(everything).not.toContain("maintenance.record_release");
      expect(everything).not.toContain("fleet_maintenance");
      expect(atA.capabilities).toContain("evidence.seal");
    });
  }, 60_000);
});

d("TEST 5 — a branch grant is confined to its own organization", () => {
  it("does not authorize in another organization, whatever the branch is called", async () => {
    const A = await org();
    const B = await org();
    const u = await user();
    await membership(u, A);
    await membership(u, B);
    // Driver at ABC, confined to one branch. Nothing at XYZ.
    await grantIn(u, A, "driver", { scopeRef: "BRANCH-A1" });

    await runWithOrganizationSelection(B, async () => {
      // No grant at XYZ at all: no workspace, and the generic gate refuses.
      const atB = await callerFor(u).session.context({ organization: B });
      expect(atB.state).toBe("no_workspace");
      await expect(callerFor(u).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    await runWithOrganizationSelection(A, async () => {
      // At ABC the grant exists but is branch-confined, and the generic gate
      // does not resolve a branch — so it still refuses, which is the v21.9.1
      // rule this checkpoint preserves rather than replaces.
      await expect(callerFor(u).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }, 60_000);
});

d("TEST 6, 7, 8 — membership is still the outer gate", () => {
  it("refuses an ex-employee at the company that ended them, and serves the other (TEST 6)", async () => {
    const A = await org();
    const B = await org();
    const u = await user();
    await membership(u, A, { status: "ended" });
    await membership(u, B);
    await grantIn(u, A, "office");
    await grantIn(u, B, "office");

    // Only one live membership remains, so it resolves without a selection.
    const context = await callerFor(u).session.context();
    expect(context.activeOrganization?.orgRef).toBe(B);
    expect(context.roles).toEqual(["office"]);

    // The ABC grant survives as a row and authorizes nothing: acting is XYZ.
    const jobA = await jobOwnedBy(A);
    await expect(
      callerFor(u).fieldRoute.evidence.add({ jobId: jobA.id, title: "T", category: "ticket", capturedAt: new Date() } as never)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);

  it("refuses an expired membership (TEST 7)", async () => {
    const A = await org();
    const u = await user();
    await membership(u, A, { effectiveTo: "2025-01-01 00:00:00" });
    await grantIn(u, A, "office");
    expect((await callerFor(u).session.context()).state).toBe("no_membership");
    await expect(callerFor(u).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("refuses a disabled organization (TEST 8)", async () => {
    const stopped = await org("suspended");
    const u = await user();
    await membership(u, stopped);
    await grantIn(u, stopped, "office");
    expect((await callerFor(u).session.context()).state).toBe("no_membership");
    await expect(callerFor(u).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

d("§16 — revoking in one organization leaves the other untouched", () => {
  it("removes the driver at ABC and keeps the driver at XYZ", async () => {
    const A = await org();
    const B = await org();
    const worker = await user();
    await membership(worker, A);
    await membership(worker, B);
    await grantIn(worker, A, "driver");
    await grantIn(worker, B, "driver");

    const admin = await user();
    await membership(admin, A);
    await grantIn(admin, A, "management");

    await runWithOrganizationSelection(A, async () => {
      await expect(
        callerFor(admin).records.roles.revoke({ targetUserId: worker, role: "driver", reason: "left the yard" } as never)
      ).resolves.toMatchObject({ revoked: 1, organization: A });
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT orgRef, revokedAt FROM userRoleAssignments WHERE userId = ? ORDER BY orgRef",
      [worker]
    );
    const live = rows.filter(r => r.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.orgRef).toBe(B);

    // The worker still drives at XYZ.
    await runWithOrganizationSelection(B, async () => {
      expect((await callerFor(worker).session.context({ organization: B })).roles).toEqual(["driver"]);
    });
  }, 60_000);

  it("refuses to revoke a grant this organization did not issue", async () => {
    const A = await org();
    const B = await org();
    const worker = await user();
    await membership(worker, A);
    await membership(worker, B);
    await grantIn(worker, B, "mechanic");

    const admin = await user();
    await membership(admin, A);
    await grantIn(admin, A, "management");

    await runWithOrganizationSelection(A, async () => {
      // Not found, not "already revoked": confirming it exists elsewhere would
      // tell ABC where this person else works.
      await expect(
        callerFor(admin).records.roles.revoke({ targetUserId: worker, role: "mechanic", reason: "not ours to take" } as never)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  }, 60_000);
});

d("TEST 9 — platform-global authority is explicit", () => {
  it("crosses organizations by design, and nothing the backfill wrote is holding it", async () => {
    const A = await org();
    const B = await org();
    const u = await user();
    await membership(u, A);
    await membership(u, B);
    // Written deliberately, with NULL orgRef, which the CHECK constraint only
    // permits for `global`.
    await grantIn(u, null, "auditor", { scopeType: "global" });

    for (const orgRef of [A, B]) {
      await runWithOrganizationSelection(orgRef, async () => {
        const context = await callerFor(u).session.context({ organization: orgRef });
        expect(context.roles, orgRef).toEqual(["auditor"]);
      });
    }
  }, 60_000);
});

d("TEST 10 — the database refuses to represent an invalid scope", () => {
  it("rejects every shape the invariant forbids", async () => {
    const A = await org();
    const u = await user();
    const forbidden: [string, (number | string)[]][] = [
      // organization scope naming no organization
      ["INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,'driver','organization',NULL,NULL,1,NOW())", [u]],
      // branch scope naming no organization
      ["INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,'driver','branch',NULL,'B1',1,NOW())", [u]],
      // branch scope naming no branch
      ["INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,'driver','branch',?,NULL,1,NOW())", [u, A]],
      // platform-global carrying an organization
      ["INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,'driver','global',?,NULL,1,NOW())", [u, A]],
      // quarantined carrying an organization
      ["INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,'driver','unscoped_legacy',?,NULL,1,NOW())", [u, A]],
    ];
    for (const [sql, params] of forbidden) {
      await expect(pool.execute(sql, params), sql.slice(0, 120)).rejects.toThrow();
    }
  }, 60_000);

  it("grants nothing for a quarantined legacy row", async () => {
    const A = await org();
    const u = await user();
    await membership(u, A);
    await grantIn(u, null, "management", { scopeType: "unscoped_legacy" });

    const context = await callerFor(u).session.context();
    expect(context.state).toBe("no_workspace");
    expect(context.roles).toEqual([]);
    await expect(callerFor(u).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("lets the same role be held in two organizations at once", async () => {
    // 0021's uniqueness key was CONCAT(userId, role, scopeRef), so this pair
    // collided and the second insert failed — the multi-organization case was
    // prevented by a constraint until 0170 widened the key.
    const A = await org();
    const B = await org();
    const u = await user();
    await grantIn(u, A, "driver");
    await expect(grantIn(u, B, "driver")).resolves.not.toThrow();
    // And a true duplicate is still refused.
    await expect(grantIn(u, A, "driver")).rejects.toThrow();
  }, 60_000);
});

d("§21 — the acting organization is request-scoped, not process-scoped", () => {
  it("keeps two concurrent callers in their own organizations", async () => {
    const { A, B, userId } = await dualEmployed();

    // Both run at once, interleaved by the event loop. A shared mutable global
    // would let one leak into the other; an AsyncLocalStorage store does not.
    const [atA, atB] = await Promise.all([
      runWithOrganizationSelection(A, () => callerFor(userId).session.context({ organization: A })),
      runWithOrganizationSelection(B, () => callerFor(userId).session.context({ organization: B })),
    ]);

    expect(atA.roles).toEqual(["driver"]);
    expect(atB.roles).toEqual(["mechanic"]);
    expect(atA.activeOrganization?.orgRef).toBe(A);
    expect(atB.activeOrganization?.orgRef).toBe(B);
  }, 60_000);
});
