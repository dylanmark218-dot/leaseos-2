/**
 * v23.26 — the adversarial half.
 *
 * `workspaceAccess.test.ts` says what a screen should show. This says what the
 * SERVER does when the screen is not there: hand-built calls, forged
 * selections, a workspace the caller was never offered, a record in another
 * company, a membership that ended an hour ago.
 *
 * Every case here goes through `appRouter.createCaller` — the real routers,
 * the real `roleProcedure`, the real `resolveActingScope` — with a context
 * carrying nothing but a user id. There is no client, so nothing a client
 * could have hidden is hiding anything.
 *
 * If a future change removes tenant enforcement, this file is what fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { runWithOrganizationSelection } from "./_core/organizationSelection";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
let seq = 771_000_000 + Math.floor(Math.random() * 40_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 });
});
afterAll(async () => {
  await pool?.end();
});

/** A caller with nothing but an authenticated identity — exactly what the gate receives. */
const callerFor = (userId: number) =>
  appRouter.createCaller({
    req: { headers: {} } as never,
    res: { cookie: () => {}, clearCookie: () => {} } as never,
    user: { id: userId, role: "user", name: `u${userId}`, email: null } as never,
  });

async function org(status: "active" | "suspended" | "closed" = "active") {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute(
    "INSERT INTO organizations (orgRef, name, status) VALUES (?,?,?)",
    [orgRef, `Fixture ${orgRef}`, status]
  );
  return orgRef;
}

async function member(
  orgRef: string | null,
  roles: string[],
  over: { status?: string; effectiveTo?: string | null; defaultWorkspace?: string | null } = {}
) {
  const userId = seq++;
  if (orgRef) {
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, defaultWorkspace, effectiveFrom, effectiveTo, createdByUserId) VALUES (?,?,?,'employee',?,?,'2020-01-01',?,1)",
      [`MEM-${rnd()}`, orgRef, userId, over.status ?? "active", over.defaultWorkspace ?? null, over.effectiveTo ?? null]
    );
  }
  for (const role of roles) {
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
      [userId, role]
    );
  }
  return userId;
}

/** A second membership for a person who works for two companies. */
async function alsoMember(userId: number, orgRef: string) {
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]
  );
}

async function jobOwnedBy(orgRef: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)",
    [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]
  );
  return { id: j.insertId };
}

/* ================================================================== */

d("the session surface answers from the tables, never from the request", () => {
  it("routes a Field-only driver straight in, and offers a Driver + Mechanic the choice (2, 3, 4, 5, 21)", async () => {
    const o = await org();
    const driver = await member(o, ["driver"]);
    const both = await member(o, ["driver", "mechanic"]);

    const field = await callerFor(driver).session.context();
    expect(field.state).toBe("ready");
    expect(field.activeWorkspace).toBe("field_workforce");
    expect(field.workspaceChoiceRequired).toBe(false);
    expect(field.availableWorkspaces.map(w => w.key)).not.toContain("fleet_maintenance");
    expect(field.activeOrganization?.orgRef).toBe(o);

    // One identity, two jobs. Not two accounts, and not a role dropdown that
    // merely relabels the same screen.
    const multi = await callerFor(both).session.context();
    expect(multi.workspaceChoiceRequired).toBe(true);
    expect(multi.availableWorkspaces.map(w => w.key)).toEqual(
      expect.arrayContaining(["field_workforce", "fleet_maintenance"])
    );
    expect(multi.user?.id).toBe(both);
  }, 60_000);

  it("refuses a workspace the caller was never offered, however it is asked for (7, 18, 19, 20)", async () => {
    const o = await org();
    const driver = await member(o, ["driver"]);
    const caller = callerFor(driver);

    // The switch itself.
    await expect(caller.session.selectWorkspace({ workspace: "management" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.session.selectWorkspace({ workspace: "not_a_workspace" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // The external portals are not user workspaces at all.
    await expect(caller.session.selectWorkspace({ workspace: "customer" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // Claiming it in the context request does not make it so.
    const claimed = await caller.session.context({ workspace: "management" });
    expect(claimed.activeWorkspace).toBe("field_workforce");

    // And the management-only API is refused regardless of what any of that
    // said — which is the property the whole checkpoint exists to keep.
    await expect(
      caller.records.roles.grant({ targetUserId: driver, role: "management" } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("lets an authorized switch through and grants nothing by it (6, 18)", async () => {
    const o = await org();
    const both = await member(o, ["driver", "mechanic"]);
    const caller = callerFor(both);

    const picked = await caller.session.selectWorkspace({ workspace: "fleet_maintenance" });
    expect(picked).toMatchObject({ workspace: "fleet_maintenance", landing: "/portal/fleet_maintenance" });

    // Remembered on the membership, and honoured on the next sign-in.
    expect((await caller.session.context()).activeWorkspace).toBe("fleet_maintenance");

    // Standing in the shop does not make them an administrator.
    await expect(
      caller.records.roles.grant({ targetUserId: both, role: "management" } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Nor does standing in Field make them stop being a mechanic.
    await caller.session.selectWorkspace({ workspace: "field_workforce" });
    expect((await caller.session.context()).availableWorkspaces.map(w => w.key)).toContain(
      "fleet_maintenance"
    );
  }, 60_000);
});

d("the tenant boundary holds against a hand-built request (8, 9, 10, 11, 23)", () => {
  it("refuses Organization A's driver a record belonging to Organization B, by id", async () => {
    const A = await org();
    const B = await org();
    const driverA = await member(A, ["driver", "office"]);
    const driverB = await member(B, ["driver", "office"]);
    const jobA = await jobOwnedBy(A);
    const jobB = await jobOwnedBy(B);

    // The session says A. It is not what enforces A.
    expect((await callerFor(driverA).session.context()).activeOrganization?.orgRef).toBe(A);

    // Across the boundary the answer is "not found" — never "forbidden",
    // which would confirm the record exists.
    await expect(
      callerFor(driverA).fieldRoute.evidence.add({
        jobId: jobB.id,
        title: "Ticket",
        category: "ticket",
        capturedAt: new Date(),
      } as never)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Their own organization's record is reached, so the refusal above is the
    // boundary rather than a broken fixture.
    await expect(
      callerFor(driverA).fieldRoute.evidence.add({
        jobId: jobA.id,
        title: "Ticket",
        category: "ticket",
        capturedAt: new Date(),
      } as never)
    ).resolves.toBeDefined();

    // Symmetric: B is not privileged either.
    await expect(
      callerFor(driverB).fieldRoute.evidence.add({
        jobId: jobA.id,
        title: "Ticket",
        category: "ticket",
        capturedAt: new Date(),
      } as never)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A list is scoped too — not filtered in the browser.
    const listedForA = await callerFor(driverA).fieldRoute.jobs.list();
    expect(listedForA.map((j: { id: number }) => j.id)).toContain(jobA.id);
    expect(listedForA.map((j: { id: number }) => j.id)).not.toContain(jobB.id);
  }, 60_000);

  it("ignores a forged organization selection and honours a real one", async () => {
    const A = await org();
    const B = await org();
    const C = await org();
    const dual = await member(A, ["driver", "office"]);
    await alsoMember(dual, B);
    const jobB = await jobOwnedBy(B);
    const jobC = await jobOwnedBy(C);

    // Two live memberships and no selection: the chooser, not a guess.
    expect((await callerFor(dual).session.context()).state).toBe("organization_required");

    // A cookie naming an organization they are not in selects nothing, so the
    // refusal stands — it does not become an entry to C.
    await runWithOrganizationSelection(C, async () => {
      await expect(callerFor(dual).fieldRoute.jobs.list()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      await expect(
        callerFor(dual).session.selectOrganization({ organization: C })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // A cookie naming one of theirs does select it, and scopes the reads.
    await runWithOrganizationSelection(B, async () => {
      const listed = await callerFor(dual).fieldRoute.jobs.list();
      expect(listed.map((j: { id: number }) => j.id)).toContain(jobB.id);
      expect(listed.map((j: { id: number }) => j.id)).not.toContain(jobC.id);
      expect((await callerFor(dual).session.context({ organization: B })).activeOrganization?.orgRef).toBe(B);
    });
  }, 60_000);
});

d("access ends when the membership does (12, 13, 14)", () => {
  it("refuses an ex-employee who still holds every role grant they ever had", async () => {
    const o = await org();
    const gone = await member(o, ["driver", "office"], { status: "ended" });

    const context = await callerFor(gone).session.context();
    expect(context.state).toBe("no_membership");
    expect(context.availableWorkspaces).toEqual([]);

    // The grants are still there. The access is not.
    await expect(callerFor(gone).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("refuses a member of a suspended company", async () => {
    const stopped = await org("suspended");
    const staff = await member(stopped, ["driver", "office"]);

    expect((await callerFor(staff).session.context()).state).toBe("no_membership");
    await expect(callerFor(staff).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("refuses a membership whose term has run out", async () => {
    const o = await org();
    const expired = await member(o, ["driver"], { effectiveTo: "2025-01-01 00:00:00" });
    expect((await callerFor(expired).session.context()).state).toBe("no_membership");
  }, 60_000);

  it("offers a member with no role grant no workspace, and says so without guessing", async () => {
    const o = await org();
    const hired = await member(o, []);
    const context = await callerFor(hired).session.context();
    expect(context.state).toBe("no_workspace");
    expect(context.activeWorkspace).toBeNull();
    expect(context.capabilities).toEqual([]);
    expect(context.reason).toMatch(/No LeaseOS workspace is assigned/i);
    // Authenticated with no role: the gate that requires a role still refuses.
    await expect(callerFor(hired).fieldRoute.jobs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("loses the workspace when the role is revoked, on one account, with no re-provisioning (20)", async () => {
    const o = await org();
    const both = await member(o, ["driver", "mechanic"]);
    expect((await callerFor(both).session.context()).availableWorkspaces.map(w => w.key)).toContain(
      "fleet_maintenance"
    );

    await pool.execute(
      "UPDATE userRoleAssignments SET revokedAt = NOW(), revokedByUserId = 1, revokeReason = 'left the shop' WHERE userId = ? AND role = 'mechanic'",
      [both]
    );

    const after = await callerFor(both).session.context();
    expect(after.availableWorkspaces.map(w => w.key)).not.toContain("fleet_maintenance");
    expect(after.activeWorkspace).toBe("field_workforce");
    // Same user id throughout. Duties changed; the identity did not.
    expect(after.user?.id).toBe(both);
    await expect(
      callerFor(both).session.selectWorkspace({ workspace: "fleet_maintenance" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

d("the session surface refuses an anonymous caller (1)", () => {
  it("answers UNAUTHORIZED rather than describing anybody", async () => {
    const anonymous = appRouter.createCaller({
      req: { headers: {} } as never,
      res: {} as never,
      user: null,
    });
    await expect(anonymous.session.context()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymous.session.selectWorkspace({ workspace: "field_workforce" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymous.session.selectOrganization({ organization: "ORG-ANY" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }, 60_000);
});

d("the post-login destination is checked server-side (16, 17)", () => {
  it("returns the requested path when it is one of ours, and the landing when it is not", async () => {
    const o = await org();
    const driver = await member(o, ["driver"]);
    const caller = callerFor(driver);

    expect(
      (await caller.session.context({ intendedPath: "/portal/field_workforce/jobs" })).intendedPath
    ).toBe("/portal/field_workforce/jobs");

    for (const hostile of ["https://evil.example/steal", "//evil.example", "/\\evil.example"]) {
      expect((await caller.session.context({ intendedPath: hostile })).intendedPath).toBe(
        "/portal/field_workforce"
      );
    }
  }, 60_000);
});
