import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import {
  UNIVERSAL_PERMISSIONS,
  authorize,
  type DomainRole,
} from "./_core/recordsAuthorization";
import { grantUserRole } from "./db";

/**
 * Portals and funding, as a client meets them.
 *
 * The composition and matching engines are proven in their own suite. What is
 * proven here is the boundary: a portal set is composed from the session, not
 * requested; the funding surface is closed to the field; and an unverified
 * program cannot reach "strong" through the API any more than it can in the
 * engine.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
let nextId = 406_000_000 + Math.floor(Math.random() * 80000);
const newUserId = () => nextId++;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

const callerFor = (userId: number) =>
  appRouter.createCaller({
    req: {} as never,
    res: {} as never,
    user: { id: userId, role: "user" } as never,
  });

async function userWithRoles(roles: DomainRole[]) {
  const userId = newUserId();
  for (const role of roles) {
    await grantUserRole({
      userId, role, scopeType: "global",
      grantedByUserId: 1, grantedAt: new Date(),
    });
  }
  return userId;
}

const isForbidden = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e &&
  ["FORBIDDEN", "UNAUTHORIZED"].includes((e as { code: string }).code);

async function attempt(fn: () => Promise<unknown>): Promise<"forbidden" | "passed_gate"> {
  try {
    await fn();
    return "passed_gate";
  } catch (e) {
    if (isForbidden(e)) return "forbidden";
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? (e as { code: unknown }).code
        : undefined;
    if (typeof code !== "string") throw e;
    if (code === "NOT_FOUND") {
      const msg = (e as { message?: string }).message ?? "";
      if (!msg || /procedure|No "query"|No "mutation"/i.test(msg)) {
        throw new Error(`Harness error: procedure path not found — ${msg}`);
      }
    }
    return "passed_gate";
  }
}

const ALL_ROLES: DomainRole[] = [
  "driver", "dispatcher", "mechanic", "shop_lead", "safety", "office",
  "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin",
  "tax_preparer", "controller", "external_accountant",
];

d("portals compose from the session, not the request", () => {
  it("gives a driver the field portal and self-service, and nothing else", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    const s = await caller.portals.mine();
    const keys = s.portals.map(p => p.portal);
    expect(keys).toContain("field_workforce");
    expect(keys).toContain("worker_self_service");
    expect(keys).not.toContain("finance_billing");
    expect(keys).not.toContain("management");
  });

  it("is additive — a driver who is also safety gains a portal and loses none", async () => {
    const driverOnly = await callerFor(await userWithRoles(["driver"])).portals.mine();
    const both = await callerFor(await userWithRoles(["driver", "safety"])).portals.mine();
    const before = driverOnly.portals.map(p => p.portal);
    const after = both.portals.map(p => p.portal);
    for (const k of before) expect(after).toContain(k);
    expect(after).toContain("safety_compliance");
  });

  it("takes no user id — there is nothing to compose someone else's session with", () => {
    const src = require("node:fs").readFileSync("server/portalFundingRouter.ts", "utf8");
    const mine = src.slice(src.indexOf("mine: roleProcedure"), src.indexOf("panelsFor:"));
    expect(mine).not.toContain(".input(");
    expect(mine).toContain("ctx.user.id");
  });

  it("refuses panels for a portal the caller does not hold", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() => caller.portals.panelsFor({ portal: "finance_billing" }))
    ).toBe("forbidden");
    expect(
      await attempt(() => caller.portals.panelsFor({ portal: "field_workforce" }))
    ).toBe("passed_gate");
  });

  it("refuses a role-less caller — a person with no role has no portal", async () => {
    const caller = callerFor(newUserId());
    expect(await attempt(() => caller.portals.mine())).toBe("forbidden");
  });

  it("gives every internal role at least the self-service portal", async () => {
    for (const role of ALL_ROLES.filter(r => r !== "external_accountant")) {
      const s = await callerFor(await userWithRoles([role])).portals.mine();
      expect(s.portals.map(p => p.portal), role).toContain("worker_self_service");
    }
  });

  it("registers portal composition as the second universal permission", () => {
    // Self-scoped in code, like the tax organizer. The list is still short.
    expect(UNIVERSAL_PERMISSIONS.slice(0, 2)).toEqual(["tax.read_personal_own", "portal.compose_own"]);
  });
});

d("the funding surface is closed to the field", () => {
  it("refuses a driver the program list, matching and advisory", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    for (const call of [
      () => caller.funding.programsList(),
      () => caller.funding.match({ trigger: "training.created" }),
      () => caller.funding.purchaseAdvisory({ trigger: "capital_purchase.planned", eligibleCost: 475000 }),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });

  it("lets HR see training matches and refuses HR a claim", async () => {
    const caller = callerFor(await userWithRoles(["hr"]));
    expect(await attempt(() => caller.funding.match({ trigger: "training.created" }))).toBe("passed_gate");
    expect(
      await attempt(() =>
        caller.funding.claimRecord({
          claimRef: "C-1", programKey: "ab.capg", expenseRef: "INV-1",
          eligibleCost: 1000, claimedAmount: 500,
        })
      )
    ).toBe("forbidden");
  });

  it("reserves program loading to the controller, like tax rules", () => {
    const holders = ALL_ROLES.filter(
      r => authorize({ userId: 1, roles: [r], permission: "funding.programs.manage" }).allowed
    );
    expect(holders).toEqual(["controller"]);
  });

  it("refuses an external accountant loading a program or recording a claim", async () => {
    const caller = callerFor(await userWithRoles(["external_accountant"]));
    expect(
      await attempt(() =>
        caller.funding.programLoad({ programKey: "x", sourceAuthority: "Someone", sourceVerified: true, requestedStatus: "verified" })
      )
    ).toBe("forbidden");
    expect(await attempt(() => caller.funding.programsList())).toBe("passed_gate");
  });
});

d("nothing is guaranteed through the API", () => {
  it("never returns a strong match while every program is unverified", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    for (const trigger of ["training.created", "capital_purchase.planned", "employee.hired"] as const) {
      const m = await caller.funding.match({ trigger });
      expect(m.every(x => x.strength !== "strong"), trigger).toBe(true);
    }
  });

  it("labels every program as unverified in the list", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const list = await caller.funding.programsList();
    expect(list.length).toBeGreaterThan(3);
    expect(list.every(p => p.verificationStatus === "unverified")).toBe(true);
  });

  it("downgrades a program load whose source is unverified", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const r = await caller.funding.programLoad({
      programKey: "ab.capg", requestedStatus: "verified",
      sourceAuthority: "Unconfirmed", sourceVerified: false,
    });
    expect(r.storedStatus).toBe("unverified");
    expect(r.note).toContain("cannot be verified unless its source is verified");
  });

  it("refuses to walk an estimate straight to received, reading the rung from the row", async () => {
    // v20.15: `from` is no longer an input. v20.14 accepted it, which let a
    // client assert "from: approved" to skip every rung between an estimate
    // and cash. The current status now comes from the stored row.
    const actor = await userWithRoles(["management"]);
    const ref = `O-${actor}`;
    await pool.execute(
      `INSERT INTO fundingOpportunities
       (opportunityRef, financialEntityId, fundingProgramId, triggerEvent, matchStrength, status)
       VALUES (?, ?, 1, 'training.created', 'possible', 'estimated')`,
      [ref, await book()]   // F1.1 — a real book the single-tenant caller owns
    );
    const caller = callerFor(actor);
    await expect(
      caller.funding.opportunityAdvance({ opportunityRef: ref, to: "received" })
    ).rejects.toThrow(/Illegal opportunity transition estimated/);

    // One rung at a time is fine, and the response reports where it came from.
    const r = await caller.funding.opportunityAdvance({ opportunityRef: ref, to: "potential" });
    expect(r.from).toBe("estimated");
    expect(r.status).toBe("potential");
  });

  it("takes no 'from' on an advance — the row is the truth", () => {
    const src = require("node:fs").readFileSync("server/portalFundingRouter.ts", "utf8");
    const adv = src.slice(src.indexOf("opportunityAdvance: roleProcedure"), src.indexOf("claimRecord:"));
    expect(adv).not.toMatch(/from: z\./);
    expect(adv).toContain("loadOpportunity(");
  });

  it("warns before a purchase when a matched program requires pre-approval", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const r = await caller.funding.purchaseAdvisory({
      trigger: "capital_purchase.planned", eligibleCost: 475000,
    });
    // Whether it warns depends on what matched; what must hold is that the
    // advisory and the matches agree with each other.
    const needsPre = r.matches.some(m => m.preApprovalWarning && m.strength !== "excluded");
    expect(r.advisory.warn).toBe(needsPre);
    if (needsPre) expect(r.advisory.programsRequiringPreApproval.length).toBeGreaterThan(0);
  });

  it("returns an explicit estimate object, never a bare number", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const r = await caller.funding.purchaseAdvisory({
      trigger: "capital_purchase.planned", eligibleCost: 100000,
    });
    for (const e of r.estimates) {
      expect(e.estimate).toHaveProperty("amount");
      expect(e.estimate).toHaveProperty("basis");
    }
  });

  it("checks stacking server-side rather than trusting the client's claim list", () => {
    const src = require("node:fs").readFileSync("server/portalFundingRouter.ts", "utf8");
    const stack = src.slice(src.indexOf("stackingCheck: roleProcedure"), src.indexOf("opportunitiesList:"));
    expect(stack).not.toContain("existingClaims: z");
    expect(stack).toContain("loadExistingClaims(");
  });
});

/** F1.1 — a real book, and a real expense in it: a claim is against the caller's own expense. */
async function book(): Promise<number> {
  return Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);
}
async function expense(expenseRef: string): Promise<string> {
  await pool.execute("INSERT INTO expenseRecords (expenseRef, financialEntityId, transactionDate, total, totalCents) VALUES (?, ?, NOW(), 10000, 1000000)", [expenseRef, await book()]);
  return expenseRef;
}

d("the claim ledger makes the next duplicate detectable", () => {
  it("records a first claim and flags a second on the same expense", async () => {
    const actor = await userWithRoles(["controller"]);
    const caller = callerFor(actor);
    const expenseRef = await expense(`INV-${actor}`);

    const first = await caller.funding.claimRecord({
      claimRef: `C1-${actor}`, programKey: "ab.capg", expenseRef,
      eligibleCost: 10000, claimedAmount: 5000,
    });
    expect(first.recorded).toBe(true);
    expect(first.stacking.outcome).toBe("clear");

    // Same invoice, second program. The ledger knows.
    const check = await caller.funding.stackingCheck({
      programKey: "ca.csbfp", expenseRef, eligibleCost: 10000, proposedAmount: 5000,
    });
    expect(check.outcome).not.toBe("clear");
    expect(check.conflicts.length).toBe(1);
    expect(check.conflicts[0].claimRef).toBe(`C1-${actor}`);
    expect(check.remainingUnfundedAmount).toBe(5000);
  });

  it("holds a possible duplicate for review rather than recording it silently or refusing on a guess", async () => {
    const actor = await userWithRoles(["controller"]);
    const caller = callerFor(actor);
    const expenseRef = await expense(`INV2-${actor}`);
    await caller.funding.claimRecord({
      claimRef: `D1-${actor}`, programKey: "ab.capg", expenseRef,
      eligibleCost: 10000, claimedAmount: 5000,
    });
    const second = await caller.funding.claimRecord({
      claimRef: `D2-${actor}`, programKey: "ca.csbfp", expenseRef,
      eligibleCost: 10000, claimedAmount: 3000,
    });
    // Recorded so the reviewer sees both — and flagged.
    expect(second.recorded).toBe(true);
    expect(second.heldForReview).toBe(true);
    expect(second.stacking.outcome).not.toBe("clear");
  });

  it("does not create a verified program row just to hang a claim on", async () => {
    const actor = await userWithRoles(["controller"]);
    await callerFor(actor).funding.claimRecord({
      claimRef: `E1-${actor}`, programKey: "ab.capg", expenseRef: await expense(`INV3-${actor}`),
      eligibleCost: 100, claimedAmount: 50,
    });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT verificationStatus FROM fundingPrograms WHERE programKey = 'ab.capg'"
    );
    expect(rows[0].verificationStatus).toBe("unverified");
  });
});

d("coverage", () => {
  it("gates every portal and funding procedure", () => {
    const src = require("node:fs").readFileSync("server/portalFundingRouter.ts", "utf8");
    expect(/\w+:\s*protectedProcedure\b/.test(src)).toBe(false);
    expect((src.match(/roleProcedure\(/g) ?? []).length).toBe(10);
  });

  it("audits a refusal on the funding surface", async () => {
    const userId = await userWithRoles(["driver"]);
    await attempt(() => callerFor(userId).funding.programsList());
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT outcome, permission FROM authorizationDecisions WHERE actorUserId = ? ORDER BY id DESC LIMIT 1",
      [userId]
    );
    expect(rows[0].outcome).toBe("denied_permission");
    expect(rows[0].permission).toBe("funding.read");
  });
});
