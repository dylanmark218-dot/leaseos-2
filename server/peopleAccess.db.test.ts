/**
 * B23.2 — People & Access, attacked through the real server.
 *
 * Every call here goes through `appRouter.createCaller` with a context that
 * carries nothing but a user id. No client, no cookie the test did not set, no
 * helper that skips the gate: the routers, `roleProcedure`,
 * `resolveActingScope`, the transactions and the database constraints are all
 * the real ones. A test that passed only because the UI would not offer the
 * button would be worthless here, because there is no UI.
 *
 * The scenario is the one the checkpoint is for. One LeaseOS identity, two
 * employers, and an administrator at each:
 *
 *   ABC Transport   admin_A   invites, grants, revokes, offboards
 *   XYZ Oilfield    admin_B   the same, and never reaches into ABC
 *
 * Fixtures follow the B23.1B rule: every record is created by the test that
 * uses it and referred to by the id the database returned. Nothing here names
 * a literal record id, so the file is order-independent and survives running
 * after any other suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { runWithOrganizationSelection } from "./_core/organizationSelection";
import { sha256 } from "./_core/externalIdentityPolicy";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 });
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

/** A real organization row. */
async function org(name = `Fixture ${rnd()}`) {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, name]);
  return orgRef;
}

/**
 * A real user row, because People & Access is about real identities.
 *
 * `openId` is what OAuth would have written; no test creates a session, so the
 * caller context supplies the id directly — which is also what makes these
 * tests a direct-API attack rather than a UI walkthrough.
 */
async function user(name = `Person ${rnd()}`) {
  const openId = `oid-${rnd()}-${rnd()}`;
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO users (openId, name, email, loginMethod) VALUES (?,?,?,'test')",
    [openId, name, `${openId}@example.test`]
  );
  return r.insertId;
}

async function membership(userId: number, orgRef: string, status: "active" | "ended" = "active") {
  const membershipRef = `MEM-${rnd()}`;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee',?, '2020-01-01', 1)",
    [membershipRef, orgRef, userId, status]
  );
  return membershipRef;
}

/** An organization-scoped grant, in the shape 0170 leaves behind. */
async function grant(userId: number, orgRef: string, role: string) {
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, grantedByUserId, grantedAt) VALUES (?,?,'organization',?,1,NOW())",
    [userId, role, orgRef]
  );
}

/** An administrator of exactly one organization. */
async function admin(orgRef: string) {
  const id = await user(`Admin ${rnd()}`);
  await membership(id, orgRef);
  await grant(id, orgRef, "management");
  return id;
}

async function liveRoles(userId: number, orgRef: string): Promise<string[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT role FROM userRoleAssignments WHERE userId = ? AND orgRef = ? AND revokedAt IS NULL ORDER BY role",
    [userId, orgRef]
  );
  return rows.map(r => String(r.role));
}

/** Resolve the acting organization explicitly for a dual-employed caller. */
const inOrg = <T>(orgRef: string, fn: () => Promise<T>) => runWithOrganizationSelection(orgRef, fn);

d("B23.2 — an administrator administers their own company and no other", () => {
  /* ---------------- TEST 1, 2: invitation is organization-bound ------------- */

  it("invites into the administrator's own organization, and has no way to name another (1, 2)", async () => {
    const A = await org("ABC Transport");
    const B = await org("XYZ Oilfield");
    const adminA = await admin(A);
    await admin(B);

    const created = await callerFor(adminA).people.invitations.create({
      email: `new-${rnd()}@example.test`,
      displayName: "R. Cardinal",
      roles: ["driver"],
    });
    expect(created.organization).toBe(A);
    expect(created.token.length).toBeGreaterThan(20);

    // TEST 2. There is no organization parameter to forge. Naming one is not
    // refused — it is IGNORED, which is stronger: the key never reaches a
    // decision, so there is nothing for a cleverer request to aim at. The
    // invitation lands in A regardless of what the caller said.
    const forged = await (callerFor(adminA).people.invitations.create as unknown as (
      i: Record<string, unknown>
    ) => Promise<{ organization: string }>)({ roles: ["driver"], orgRef: B, organization: B });
    expect(forged.organization).toBe(A);

    // And what landed for the first call is A's too.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT orgRef FROM organizationInvitations WHERE invitationRef = ?",
      [created.invitationRef]
    );
    expect(rows[0]!.orgRef).toBe(A);
    expect(rows).toHaveLength(1);

    // B's administrator does not see A's invitation.
    const adminBList = await callerFor(await admin(B)).people.invitations.list();
    expect(adminBList.invitations.map(i => i.invitationRef)).not.toContain(created.invitationRef);
  }, 60_000);

  it("stores only a digest of the token, and returns the raw value exactly once", async () => {
    const A = await org();
    const adminA = await admin(A);
    const created = await callerFor(adminA).people.invitations.create({
      email: `secret-${rnd()}@example.test`,
      roles: ["mechanic"],
    });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT tokenDigest FROM organizationInvitations WHERE invitationRef = ?",
      [created.invitationRef]
    );
    // The digest matches, and the raw token appears in no column of the row.
    expect(rows[0]!.tokenDigest).toBe(sha256(created.token));
    const [full] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM organizationInvitations WHERE invitationRef = ?",
      [created.invitationRef]
    );
    expect(JSON.stringify(full[0])).not.toContain(created.token);

    // The listing never carries it either.
    const listed = await callerFor(adminA).people.invitations.list();
    expect(JSON.stringify(listed)).not.toContain(created.token);
  }, 60_000);

  /* ---------------- TEST 3, 4, 5, 6: role administration -------------------- */

  it("grants and revokes only within the administrator's organization (3, 4, 5, 6)", async () => {
    const A = await org("ABC Transport");
    const B = await org("XYZ Oilfield");
    const adminA = await admin(A);
    const adminB = await admin(B);

    // Dylan drives for ABC and wrenches for XYZ — one identity, two employers.
    const dylan = await user("Dylan Hutchings");
    await membership(dylan, A);
    await membership(dylan, B);
    await grant(dylan, A, "driver");
    await grant(dylan, B, "mechanic");

    // TEST 3. A's administrator adds a role in A.
    const set = await inOrg(A, () =>
      callerFor(adminA).people.setRoles({ userId: dylan, roles: ["driver", "shop_lead"], reason: "promoted" })
    );
    expect(set.granted).toEqual(["shop_lead"]);
    expect(await liveRoles(dylan, A)).toEqual(["driver", "shop_lead"]);
    // TEST 6 (half). XYZ is untouched by a change made in ABC.
    expect(await liveRoles(dylan, B)).toEqual(["mechanic"]);

    // TEST 5. A's administrator cannot revoke the role XYZ granted. Setting A's
    // roles says nothing about B's, and there is no parameter that could.
    await inOrg(A, () => callerFor(adminA).people.setRoles({ userId: dylan, roles: ["driver"], reason: "reverted" }));
    expect(await liveRoles(dylan, A)).toEqual(["driver"]);
    expect(await liveRoles(dylan, B)).toEqual(["mechanic"]);

    // TEST 4. A's administrator cannot touch somebody who only works for B.
    const onlyB = await user("B Only");
    await membership(onlyB, B);
    await grant(onlyB, B, "driver");
    await expect(
      inOrg(A, () => callerFor(adminA).people.setRoles({ userId: onlyB, roles: ["safety"], reason: "nope" }))
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${onlyB} not found` });
    expect(await liveRoles(onlyB, B)).toEqual(["driver"]);

    // And symmetrically: B's administrator reaches nothing in A.
    const someoneInA = await admin(A);
    await expect(
      inOrg(B, () => callerFor(adminB).people.detail({ userId: someoneInA }))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);

  it("shows an administrator this organization's roles and never another's (48)", async () => {
    const A = await org("ABC Transport");
    const B = await org("XYZ Oilfield");
    const adminA = await admin(A);
    const dylan = await user("Dylan Hutchings");
    await membership(dylan, A);
    await membership(dylan, B);
    await grant(dylan, A, "driver");
    await grant(dylan, B, "safety");

    const detail = await inOrg(A, () => callerFor(adminA).people.detail({ userId: dylan }));
    expect(detail.person.roles).toEqual(["driver"]);
    // Not "driver and safety", and nothing anywhere in the payload names XYZ.
    expect(JSON.stringify(detail)).not.toContain("safety");
    expect(JSON.stringify(detail)).not.toContain(B);

    const list = await inOrg(A, () => callerFor(adminA).people.list());
    const row = list.people.find(p => p.userId === dylan)!;
    expect(row.roles).toEqual(["driver"]);
    expect(JSON.stringify(list)).not.toContain(B);
  }, 60_000);

  /* ---------------- TEST 7: membership removal is per-employer -------------- */

  it("removes access to one employer and leaves the other whole (7, 14)", async () => {
    const A = await org("ABC Transport");
    const B = await org("XYZ Oilfield");
    const adminA = await admin(A);
    const dylan = await user("Dylan Hutchings");
    await membership(dylan, A);
    const memB = await membership(dylan, B);
    await grant(dylan, A, "driver");
    await grant(dylan, A, "mechanic");
    await grant(dylan, B, "safety");

    const removed = await inOrg(A, () =>
      callerFor(adminA).people.removeFromOrganization({ userId: dylan, reason: "resigned from ABC" })
    );
    expect(removed).toMatchObject({ organization: A, rolesRevoked: 2 });

    expect(await liveRoles(dylan, A)).toEqual([]);
    // The other employer is untouched — membership and grant both.
    expect(await liveRoles(dylan, B)).toEqual(["safety"]);
    const [mem] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT status FROM organizationMemberships WHERE membershipRef = ?",
      [memB]
    );
    expect(mem[0]!.status).toBe("active");

    // The identity itself survives. This is the line B23.2 must never cross.
    const [u] = await pool.execute<mysql.RowDataPacket[]>("SELECT id FROM users WHERE id = ?", [dylan]);
    expect(u).toHaveLength(1);
  }, 60_000);

  /* ---------------- TEST 8: platform authority is unreachable --------------- */

  it("gives a tenant administrator no way to mint platform-wide authority (8)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const target = await user();
    await membership(target, A);

    await inOrg(A, () => callerFor(adminA).people.setRoles({ userId: target, roles: ["safety"], reason: "hired" }));
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT scopeType, orgRef FROM userRoleAssignments WHERE userId = ? AND revokedAt IS NULL",
      [target]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeType: "organization", orgRef: A });
    expect(rows[0]!.scopeType).not.toBe("global");

    // The enum refuses a role outside the tenant-grantable set, and there is no
    // scopeType input at all — so this is a validation failure, not a policy
    // check that a cleverer request might pass.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inOrg(A, () => (callerFor(adminA).people.setRoles as any)({ userId: target, roles: ["platform_admin"], reason: "attempted" }))
    ).rejects.toBeTruthy();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inOrg(A, () => (callerFor(adminA).people.setRoles as any)({ userId: target, roles: ["safety"], scopeType: "global", reason: "attempted global" }))
    ).resolves.toBeTruthy();   // the extra key is ignored, not honoured
    const [after] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT scopeType FROM userRoleAssignments WHERE userId = ? AND revokedAt IS NULL",
      [target]
    );
    expect(after.every(r => r.scopeType === "organization")).toBe(true);
  }, 60_000);

  /* ---------------- TEST 9-13: the invitation lifecycle --------------------- */

  it("refuses an expired invitation (9)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const created = await callerFor(adminA).people.invitations.create({ roles: ["driver"], email: `e-${rnd()}@x.test` });
    // Age it past its expiry rather than waiting seven days.
    await pool.execute("UPDATE organizationInvitations SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE invitationRef = ?", [created.invitationRef]);

    const joiner = await user();
    await expect(callerFor(joiner).session.acceptInvitation({ token: created.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: /expired/i,
    });
    expect(await liveRoles(joiner, A)).toEqual([]);
  }, 60_000);

  it("refuses a cancelled invitation (10)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const created = await callerFor(adminA).people.invitations.create({ roles: ["driver"], email: `c-${rnd()}@x.test` });
    await callerFor(adminA).people.invitations.cancel({ invitationRef: created.invitationRef, reason: "wrong person" });

    const joiner = await user();
    await expect(callerFor(joiner).session.acceptInvitation({ token: created.token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await liveRoles(joiner, A)).toEqual([]);
  }, 60_000);

  it("accepts once and refuses the second attempt (11)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const created = await callerFor(adminA).people.invitations.create({ roles: ["driver", "mechanic"], email: `o-${rnd()}@x.test` });

    const joiner = await user();
    const accepted = await callerFor(joiner).session.acceptInvitation({ token: created.token });
    expect(accepted).toMatchObject({ organization: A, roles: ["driver", "mechanic"] });
    expect(await liveRoles(joiner, A)).toEqual(["driver", "mechanic"]);

    // A second use of the same token finds the row already accepted. Not a
    // second membership, not a second set of grants.
    await expect(callerFor(joiner).session.acceptInvitation({ token: created.token })).rejects.toBeTruthy();
    const [mems] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM organizationMemberships WHERE userId = ? AND orgRef = ?",
      [joiner, A]
    );
    expect(Number(mems[0]!.n)).toBe(1);
    expect(await liveRoles(joiner, A)).toEqual(["driver", "mechanic"]);
  }, 60_000);

  it("refuses a token that names nothing, and cannot be steered by a forged organization (12)", async () => {
    const A = await org();
    const B = await org();
    const adminA = await admin(A);
    const created = await callerFor(adminA).people.invitations.create({ roles: ["driver"], email: `f-${rnd()}@x.test` });

    const joiner = await user();
    await expect(callerFor(joiner).session.acceptInvitation({ token: "not-a-real-token-at-all" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Accepting while claiming to act for B lands the membership in A: the
    // organization comes from the invitation row, never from the request or
    // the selection cookie.
    const accepted = await inOrg(B, () => callerFor(joiner).session.acceptInvitation({ token: created.token }));
    expect(accepted.organization).toBe(A);
    expect(await liveRoles(joiner, B)).toEqual([]);
    expect(await liveRoles(joiner, A)).toEqual(["driver"]);
  }, 60_000);

  it("adds a second membership to ONE identity when a second company invites them (13, 25)", async () => {
    const A = await org("ABC Transport");
    const B = await org("XYZ Oilfield");
    const adminA = await admin(A);
    const adminB = await admin(B);

    const dylan = await user("Dylan Hutchings");
    const invA = await callerFor(adminA).people.invitations.create({ roles: ["driver"], email: `d-${rnd()}@x.test` });
    await callerFor(dylan).session.acceptInvitation({ token: invA.token });

    const invB = await callerFor(adminB).people.invitations.create({ roles: ["mechanic"], email: `d2-${rnd()}@x.test` });
    await callerFor(dylan).session.acceptInvitation({ token: invB.token });

    // One account. Two memberships. Each company's role, only in that company.
    const [users_] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE id = ?", [dylan]);
    expect(Number(users_[0]!.n)).toBe(1);
    const [mems] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT orgRef FROM organizationMemberships WHERE userId = ? AND status = 'active' ORDER BY orgRef",
      [dylan]
    );
    expect(mems.map(m => m.orgRef).sort()).toEqual([A, B].sort());
    expect(await liveRoles(dylan, A)).toEqual(["driver"]);
    expect(await liveRoles(dylan, B)).toEqual(["mechanic"]);
  }, 60_000);

  it("refuses a second live invitation for the same person in the same organization (12 duplicates)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const email = `dupe-${rnd()}@example.test`;
    await callerFor(adminA).people.invitations.create({ roles: ["driver"], email });
    // The unique pendingKey is what refuses this, not a read-then-write check.
    await expect(callerFor(adminA).people.invitations.create({ roles: ["driver"], email })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // Cancelling frees the address again — the cancelled row drops out of the
    // unique index because its generated key becomes NULL.
    const listed = await callerFor(adminA).people.invitations.list();
    const pending = listed.invitations.find(i => i.emailHint === email)!;
    await callerFor(adminA).people.invitations.cancel({ invitationRef: pending.invitationRef, reason: "retry" });
    await expect(callerFor(adminA).people.invitations.create({ roles: ["driver"], email })).resolves.toBeTruthy();
  }, 60_000);

  /* ---------------- TEST 14-16: legacy quarantine --------------------------- */

  it("keeps a quarantined grant non-authorizing, and lists it only to an employer (14, 16)", async () => {
    const A = await org();
    const B = await org();
    const adminA = await admin(A);
    const adminB = await admin(B);

    const dual = await user("Dual Employed");
    await membership(dual, A);
    // The shape 0170 leaves for a grant it refused to attribute.
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, grantedByUserId, grantedAt) VALUES (?,'safety','unscoped_legacy',NULL,1,NOW())",
      [dual]
    );

    // TEST 14. It authorizes nothing: a safety procedure is still refused.
    await expect(
      inOrg(A, () => callerFor(dual).people.list())
    ).rejects.toBeTruthy();

    // A's administrator sees it, because this person works for A.
    const listA = await inOrg(A, () => callerFor(adminA).people.accessResolution.list());
    expect(listA.needsResolution.map(r => r.userId)).toContain(dual);
    // It says the role and nothing about where it came from.
    expect(JSON.stringify(listA)).not.toContain(B);

    // TEST 16. B's administrator does not, because this person does not work
    // for B — the row is invisible rather than forbidden.
    const listB = await inOrg(B, () => callerFor(adminB).people.accessResolution.list());
    expect(listB.needsResolution.map(r => r.userId)).not.toContain(dual);
  }, 60_000);

  it("resolves a quarantined grant into the actor's own organization only (15, 17)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const target = await user();
    await membership(target, A);
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, grantedByUserId, grantedAt) VALUES (?,'mechanic','unscoped_legacy',NULL,1,NOW())",
      [target]
    );
    const pending = await inOrg(A, () => callerFor(adminA).people.accessResolution.list());
    const row = pending.needsResolution.find(r => r.userId === target)!;

    const resolved = await inOrg(A, () =>
      callerFor(adminA).records.roles.resolveLegacy({ legacyGrantId: row.legacyGrantId, reason: "confirmed with the shop" })
    );
    expect(resolved).toBeTruthy();

    // TEST 15. Authority now exists in A, organization-scoped, and nowhere else.
    expect(await liveRoles(target, A)).toEqual(["mechanic"]);
    const [scopes] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT scopeType, orgRef, revokedAt FROM userRoleAssignments WHERE userId = ? ORDER BY id",
      [target]
    );
    // The legacy row is retired rather than deleted — the history stays.
    expect(scopes.some(r => r.scopeType === "unscoped_legacy" && r.revokedAt !== null)).toBe(true);
    expect(scopes.some(r => r.scopeType === "organization" && r.orgRef === A && r.revokedAt === null)).toBe(true);

    // TEST 17. A second resolution of the same row finds nothing rather than
    // granting twice.
    await expect(
      inOrg(A, () => callerFor(adminA).records.roles.resolveLegacy({ legacyGrantId: row.legacyGrantId, reason: "again" }))
    ).rejects.toBeTruthy();
    expect(await liveRoles(target, A)).toEqual(["mechanic"]);
  }, 60_000);

  /* ---------------- TEST 18-20: workspaces and the default ------------------ */

  it("moves the available workspaces with the roles, and loses one with the last role (18, 19)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const person = await user();
    await membership(person, A);

    const withDriver = await inOrg(A, () =>
      callerFor(adminA).people.setRoles({ userId: person, roles: ["driver"], reason: "hired" })
    );
    expect(withDriver.workspaces).toContain("field_workforce");

    const withMechanic = await inOrg(A, () =>
      callerFor(adminA).people.setRoles({ userId: person, roles: ["driver", "mechanic"], reason: "cross-trained" })
    );
    expect(withMechanic.workspaces).toContain("fleet_maintenance");

    // TEST 19. Revoking the last role that composed a workspace removes it,
    // with no second write — the workspace was never stored.
    const noMechanic = await inOrg(A, () =>
      callerFor(adminA).people.setRoles({ userId: person, roles: ["driver"], reason: "back to driving" })
    );
    expect(noMechanic.workspaces).not.toContain("fleet_maintenance");

    const none = await inOrg(A, () =>
      callerFor(adminA).people.setRoles({ userId: person, roles: [], reason: "all access removed" })
    );
    expect(none.workspaces).toEqual([]);
  }, 60_000);

  it("refuses a default workspace the person's roles do not open, and clears a stale one (20)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const person = await user();
    await membership(person, A);
    await inOrg(A, () => callerFor(adminA).people.setRoles({ userId: person, roles: ["driver"], reason: "hired" }));

    // TEST 20. `management` is not a workspace a driver opens.
    await expect(
      inOrg(A, () => callerFor(adminA).people.setDefaultWorkspace({ userId: person, workspace: "management" }))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const ok = await inOrg(A, () =>
      callerFor(adminA).people.setDefaultWorkspace({ userId: person, workspace: "field_workforce" })
    );
    expect(ok.defaultWorkspace).toBe("field_workforce");

    // Taking the role away clears the preference rather than leaving one that
    // points at a closed door.
    const after = await inOrg(A, () =>
      callerFor(adminA).people.setRoles({ userId: person, roles: ["office"], reason: "moved to the office" })
    );
    expect(after.defaultWorkspaceCleared).toBe(true);
    const detail = await inOrg(A, () => callerFor(adminA).people.detail({ userId: person }));
    expect(detail.person.defaultWorkspace).toBeNull();
  }, 60_000);

  /* ---------------- TEST 21, 22: the gate, not the screen ------------------- */

  it("denies a person whose membership ended even though the role rows still exist (21)", async () => {
    const A = await org();
    const adminA = await admin(A);
    const person = await user();
    await membership(person, A);
    await grant(person, A, "management");

    // End the membership directly, leaving the grants in place — the state a
    // partial offboarding or a manual database edit would produce.
    await pool.execute(
      "UPDATE organizationMemberships SET status = 'ended', effectiveTo = NOW() WHERE userId = ? AND orgRef = ?",
      [person, A]
    );
    expect(await liveRoles(person, A)).toEqual(["management"]);

    // Access ends with the membership, not with the grant.
    await expect(inOrg(A, () => callerFor(person).people.list())).rejects.toBeTruthy();
    void adminA;
  }, 60_000);

  it("refuses an unauthorized caller at the API, with no UI in the path (22)", async () => {
    const A = await org();
    const driver = await user();
    await membership(driver, A);
    await grant(driver, A, "driver");

    // A driver is a real, live member of A with a real grant. They simply do
    // not hold `roles.grant`, and the refusal happens in the gate.
    // Typed as returning `unknown`: the five calls have five different result
    // shapes, and without this the array infers the first one and the rest fail
    // the test-file typecheck ratchet.
    const calls: Array<() => Promise<unknown>> = [
      () => callerFor(driver).people.list(),
      () => callerFor(driver).people.invitations.list(),
      () => callerFor(driver).people.accessResolution.list(),
      () => callerFor(driver).people.invitations.create({ roles: ["driver"], email: `x-${rnd()}@x.test` }),
      () => callerFor(driver).people.removeFromOrganization({ userId: driver, reason: "self" }),
    ];
    for (const call of calls) {
      await expect(inOrg(A, call)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  }, 60_000);

  /* ---------------- Last administrator -------------------------------------- */

  it("refuses to remove the organization's last administrator, by either route (45, 46)", async () => {
    const A = await org("Solo Transport");
    const only = await admin(A);

    // Through the role set, and the refusal costs them nothing else: revoking
    // `management` is attempted first, so a refusal cannot leave the person
    // stripped of the roles the loop had already reached.
    await inOrg(A, () => callerFor(only).people.setRoles({ userId: only, roles: ["management", "driver"], reason: "also driving" }));
    expect(await liveRoles(only, A)).toEqual(["driver", "management"]);
    await expect(
      inOrg(A, () => callerFor(only).people.setRoles({ userId: only, roles: [], reason: "stepping back" }))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: /last management access/i });
    expect(await liveRoles(only, A)).toEqual(["driver", "management"]);

    // And through membership removal.
    await expect(
      inOrg(A, () => callerFor(only).people.removeFromOrganization({ userId: only, reason: "leaving" }))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: /last management access/i });
    const [mem] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT status FROM organizationMemberships WHERE userId = ? AND orgRef = ?",
      [only, A]
    );
    expect(mem[0]!.status).toBe("active");

    // With a second administrator appointed, the first may leave.
    const second = await user();
    await membership(second, A);
    await inOrg(A, () => callerFor(only).people.setRoles({ userId: second, roles: ["management"], reason: "successor" }));
    await expect(
      inOrg(A, () => callerFor(only).people.removeFromOrganization({ userId: only, reason: "handed over" }))
    ).resolves.toMatchObject({ organization: A });
    expect(await liveRoles(second, A)).toEqual(["management"]);
  }, 60_000);
});
