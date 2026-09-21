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
 * **What this establishes, and it is two different answers.** Every invalid
 * membership state is correctly excluded: suspended, ended, not yet started and
 * expired all fail to resolve an organization. What follows is that the caller
 * lands on the single-tenant fallback rather than being refused, still holding
 * every role grant. Their former organization's records are gone — those rows
 * carry its `orgRef` — and their session is not.
 */
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

  it("excludes a suspended membership — the filter is SQL, and it runs", async () => {
    const a = await org();
    const u = await member({ orgRef: a, status: "suspended", defaultWorkspace: "field_workforce" });
    const session = await callerFor(u).portals.mine();
    expect(session.organization.state).toBe("single_tenant_fallback");
  }, 20_000);

  it("excludes an ended membership", async () => {
    const a = await org();
    const u = await member({ orgRef: a, status: "ended" });
    const session = await callerFor(u).portals.mine();
    expect(session.organization.state).toBe("single_tenant_fallback");
  }, 20_000);

  it("excludes a membership that has not started", async () => {
    const a = await org();
    const u = await member({ orgRef: a, effectiveFrom: future });
    const session = await callerFor(u).portals.mine();
    expect(session.organization.state).toBe("single_tenant_fallback");
  }, 20_000);

  it("excludes a membership whose end date has passed", async () => {
    const a = await org();
    const u = await member({ orgRef: a, effectiveTo: past });
    const session = await callerFor(u).portals.mine();
    expect(session.organization.state).toBe("single_tenant_fallback");
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

  it("reports two live memberships as ambiguous rather than picking one", async () => {
    const a = await org();
    const b = await org();
    const u = await member({ orgRef: a });
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01 00:00:00',1)",
      [`MEM-${rnd()}`, b, u]
    );
    const session = await callerFor(u).portals.mine();
    expect(session.organization.state).toBe("ambiguous");
  }, 20_000);
});

d("a preference cannot outlive the membership that holds it", () => {
  it("does not carry defaultWorkspace from a membership that no longer resolves", async () => {
    // The preference lives on the membership row, and the row is only read when
    // a membership resolved. So an ended membership's saved workspace never
    // reaches the client at all — it cannot be stale, because it is absent.
    const a = await org();
    const u = await member({
      orgRef: a,
      status: "ended",
      defaultWorkspace: "executive",
    });
    const session = await callerFor(u).portals.mine();
    expect(session.organization.state).toBe("single_tenant_fallback");
    if (session.organization.state !== "single_tenant_fallback") throw new Error("unreachable");
    expect(session.organization.defaultWorkspace).toBeNull();
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

d("what an ended membership does not take away", () => {
  it("leaves the session composing portals from role grants that were never revoked", async () => {
    // The finding, at the layer it matters. Ending a membership writes nothing
    // to userRoleAssignments, so the grants survive and portals still compose.
    // Offboarding has to revoke the grants; ending the membership is not enough.
    const a = await org();
    const u = await member({ orgRef: a, status: "ended", role: "driver" });
    const session = await callerFor(u).portals.mine();

    expect(session.organization.state).toBe("single_tenant_fallback");
    expect(session.portals.length).toBeGreaterThan(0);
    expect(session.roles).toContain("driver");
  }, 20_000);

  it("is indistinguishable from a user who never had a membership", async () => {
    const a = await org();
    const ended = await member({ orgRef: a, status: "ended", role: "driver" });
    const never = await member({ orgRef: null, role: "driver" });

    const a1 = await callerFor(ended).portals.mine();
    const a2 = await callerFor(never).portals.mine();
    expect(a1.organization).toEqual(a2.organization);
  }, 20_000);
});
