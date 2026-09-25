/**
 * An ended membership, through the whole canonical path, against a real database.
 *
 * `server/actingScopeMembership.test.ts` proves the effective-date window with a
 * fake database. It cannot prove the `status = 'active'` filter, because that
 * one is a drizzle WHERE clause and a fake that returned rows regardless would
 * be reporting a filter it never ran. This file runs it.
 *
 * It also asks the question the way the system does, rather than the way the
 * resolver does: through `appRouter.createCaller` into `portals.mine`, which is
 *
 *   authenticated user → membership lookup → resolveActingScope
 *     → roleProcedure authorization → portal composition → the response
 *
 * Testing the resolver alone would leave the interesting part — what the
 * composed session tells the client about an ended membership — unproven.
 *
 * **What this establishes.** Every invalid membership state is excluded:
 * suspended, ended, not yet started and expired all fail to resolve an
 * organization. On main before the auth-workspace checkpoint (#64) the caller
 * then fell through to the single-tenant fallback, still holding every role
 * grant — the finding this file first recorded. #64 closes it: a person whose
 * memberships are all excluded is refused ("membership is not active"), and two
 * live memberships are refused until one is chosen, rather than reported and
 * left for the client. A user who never had a membership still gets the
 * single-tenant fallback, which exists for deployments that predate
 * organizations.
 */
const INACTIVE = /membership is not active/;
const CHOOSE = /Choose which organization/;
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
let seq = 26_000_000 + Math.floor(Math.random() * 60_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 });
});
afterAll(async () => {
  await pool?.end();
});

const callerFor = (userId: number) =>
  appRouter.createCaller({
    req: {} as never,
    res: {} as never,
    user: { id: userId, role: "user" } as never,
  });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute(
    "INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')",
    [orgRef, `o ${orgRef}`]
  );
  return orgRef;
}

/**
 * A user holding one domain role, optionally with a membership in whatever
 * state the case is about. The role matters: `portal.compose_own` is universal,
 * but `authorize` still refuses a caller holding no domain role at all, so a
 * roleless user would be refused for the wrong reason.
 */
async function member(args: {
  orgRef?: string | null;
  status?: "active" | "suspended" | "ended";
  effectiveFrom?: string;
  effectiveTo?: string | null;
  defaultWorkspace?: string | null;
  role?: string;
}) {
  const userId = seq++;
  if (args.orgRef) {
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, defaultWorkspace, effectiveFrom, effectiveTo, createdByUserId) VALUES (?,?,?,'employee',?,?,?,?,1)",
      [
        `MEM-${rnd()}`,
        args.orgRef,
        userId,
        args.status ?? "active",
        args.defaultWorkspace ?? null,
        args.effectiveFrom ?? "2020-01-01 00:00:00",
        args.effectiveTo ?? null,
      ]
    );
  }
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
    [userId, args.role ?? "driver"]
  );
  return userId;
}

/**
 * Not 2099. `organizationMemberships.effectiveFrom` and `effectiveTo` are
 * MariaDB `TIMESTAMP` columns, whose range ends at 2038-01-19 03:14:07 UTC, and
 * the server runs in strict mode — so a membership dated beyond that is not a
 * far-future membership, it is a rejected INSERT. The suite below pins that as
 * a fact rather than working around it quietly.
 */
const future = "2037-01-01 00:00:00";
const past = "2021-01-01 00:00:00";
const beyondTimestampRange = "2099-01-01 00:00:00";

d("membership state decides the acting organization", () => {
  it("resolves an active membership inside its window", async () => {
    const a = await org();
    const u = await member({ orgRef: a, defaultWorkspace: "field_workforce" });
    const session = await callerFor(u).portals.mine();

    expect(session.organization.state).toBe("resolved");
    if (session.organization.state !== "resolved") throw new Error("unreachable");
    expect(session.organization.orgRef).toBe(a);
    expect(session.organization.defaultWorkspace).toBe("field_workforce");
  }, 20_000);

  it("excludes a suspended membership — the status filter runs, and refuses the caller", async () => {
    const a = await org();
    const u = await member({ orgRef: a, status: "suspended", defaultWorkspace: "field_workforce" });
    await expect(callerFor(u).portals.mine()).rejects.toThrow(INACTIVE);
  }, 20_000);

  it("excludes an ended membership, and refuses the caller", async () => {
    const a = await org();
    const u = await member({ orgRef: a, status: "ended" });
    await expect(callerFor(u).portals.mine()).rejects.toThrow(INACTIVE);
  }, 20_000);

  it("excludes a membership that has not started, and refuses the caller", async () => {
    const a = await org();
    const u = await member({ orgRef: a, effectiveFrom: future });
    await expect(callerFor(u).portals.mine()).rejects.toThrow(INACTIVE);
  }, 20_000);

  it("excludes a membership whose end date has passed, and refuses the caller", async () => {
    const a = await org();
    const u = await member({ orgRef: a, effectiveTo: past });
    await expect(callerFor(u).portals.mine()).rejects.toThrow(INACTIVE);
  }, 20_000);

  it("cannot store a membership dated past the TIMESTAMP ceiling", async () => {
    // Recorded because this suite tripped over it. A membership that is meant
    // to run indefinitely has to leave `effectiveTo` NULL; writing a sentinel
    // far-future date does not express "no end", it fails. Anything that later
    // wants an explicit far end date needs a column change, not a larger
    // literal.
    const a = await org();
    await expect(
      pool.execute(
        "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active',?,1)",
        [`MEM-${rnd()}`, a, seq++, beyondTimestampRange]
      )
    ).rejects.toThrow(/Incorrect datetime value/);
  }, 20_000);

  it("refuses two live memberships until one is chosen, rather than picking one", async () => {
    const a = await org();
    const b = await org();
    const u = await member({ orgRef: a });
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01 00:00:00',1)",
      [`MEM-${rnd()}`, b, u]
    );
    await expect(callerFor(u).portals.mine()).rejects.toThrow(CHOOSE);
  }, 20_000);
});

d("a preference cannot outlive the membership that holds it", () => {
  it("does not carry defaultWorkspace from a membership that no longer resolves", async () => {
    // The preference lives on the membership row. An ended membership now ends
    // the session outright, so its saved workspace cannot reach the client.
    const a = await org();
    const u = await member({
      orgRef: a,
      status: "ended",
      defaultWorkspace: "executive",
    });
    await expect(callerFor(u).portals.mine()).rejects.toThrow(INACTIVE);
  }, 20_000);

  it("does not let a saved preference name a portal the roles do not compose", async () => {
    // A driver composes field_workforce and worker_self_service, never
    // executive. The preference is carried verbatim and the client checks it
    // against the composed set; the server never promotes it.
    const a = await org();
    const u = await member({ orgRef: a, defaultWorkspace: "executive", role: "driver" });
    const session = await callerFor(u).portals.mine();

    expect(session.organization.state).toBe("resolved");
    if (session.organization.state !== "resolved") throw new Error("unreachable");
    expect(session.organization.defaultWorkspace).toBe("executive");
    // And it is not in the composed set, which is what makes the client-side
    // check meaningful rather than decorative.
    expect(session.portals.map(p => p.portal)).not.toContain("executive");
  }, 20_000);
});

d("what an ended membership takes away (the finding, closed by #64)", () => {
  it("ends the session even though role grants were never revoked", async () => {
    // Ending a membership still writes nothing to userRoleAssignments; the refusal
    // no longer depends on offboarding revoking the grants as well.
    const a = await org();
    const u = await member({ orgRef: a, status: "ended", role: "driver" });
    await expect(callerFor(u).portals.mine()).rejects.toThrow(INACTIVE);
  }, 20_000);

  it("is told apart from a user who never had a membership", async () => {
    const a = await org();
    const ended = await member({ orgRef: a, status: "ended", role: "driver" });
    const never = await member({ orgRef: null, role: "driver" });

    await expect(callerFor(ended).portals.mine()).rejects.toThrow(INACTIVE);
    const session = await callerFor(never).portals.mine();
    expect(session.organization.state).toBe("single_tenant_fallback");
    expect(session.portals.length).toBeGreaterThan(0);
  }, 20_000);
});
