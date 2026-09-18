import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import {
  OPERATIONAL_PROCEDURE_PERMISSIONS,
  authorize,
  isSensitivePermission,
  type DomainRole,
} from "./_core/recordsAuthorization";
import { grantUserRole } from "./db";

/**
 * The payroll, contractor and finance surface, met the way a client meets it.
 *
 * The engines are proven in isolation. What matters here is that the router in
 * front of them refuses the same things — and that the own-pay boundary holds
 * when a caller tries to name someone else's profile.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
let nextId = 700000 + Math.floor(Math.random() * 90000);
const newUserId = () => nextId++;

let FIXTURE_ENTITY_ID = 1;   // P4.1: real, unowned financial entities, created below
let FIXTURE_PAYER_ID = 2;
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  FIXTURE_ENTITY_ID = 5_200_000 + Math.floor(Math.random() * 90_000);
  // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
  FIXTURE_PAYER_ID = FIXTURE_ENTITY_ID + 1;
  for (const id of [FIXTURE_ENTITY_ID, FIXTURE_PAYER_ID]) await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [id, `FE-${id}`, `entity ${id}`]);
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

/** Rethrows NOT_FOUND on a router path — a bad path is never a gate result. */
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
      // A domain "no such record" is a legitimate post-gate outcome; a missing
      // procedure path is a harness bug and must fail loudly.
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

d("own pay is own pay", () => {
  it("refuses a driver the administrative payroll surface", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    for (const call of [
      () => caller.payroll.profilesList(),
      () => caller.payroll.runsList(),
      () => caller.payroll.earningsList(),
      () => caller.payroll.ratesList(),
      () => caller.payroll.disputesList(),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });

  it("lets a driver reach their own pay, time and disputes", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    for (const call of [
      () => caller.payroll.myPay(),
      () => caller.payroll.myTimeEntries({ from: new Date(0), to: new Date() }),
      () => caller.payroll.myStatements(),
    ]) {
      expect(await attempt(call)).toBe("passed_gate");
    }
  });

  it("takes no profile id on any self-service input schema", () => {
    // The boundary is structural: there is no field to spoof. Asserted against
    // the .input() schemas specifically — the service call downstream does pass
    // the resolved id, and an earlier version of this test matched that and my
    // own comment, which is exactly the kind of false green worth avoiding.
    const src = require("node:fs").readFileSync("server/payrollRouter.ts", "utf8");
    const selfService = src.slice(
      src.indexOf("myPay: roleProcedure"),
      src.indexOf("/* ---------------- Administration")
    );
    const stripComments = (t: string) =>
      t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const inputSchemas = Array.from(
      selfService.matchAll(/\.input\(([\s\S]*?)\)\s*\.(?:query|mutation)\(/g)
    ).map((m: RegExpMatchArray) => stripComments(m[1]));
    expect(inputSchemas.length).toBeGreaterThan(0);
    for (const schema of inputSchemas) {
      expect(schema).not.toContain("employeePayrollProfileId");
      expect(schema).not.toContain("employeeNumber");
      expect(schema).not.toContain("userId");
    }
    expect(selfService).toContain("ownProfileOrThrow(ctx.user.id)");
  });

  it("refuses dispatch every payroll procedure, own pay included", async () => {
    const caller = callerFor(await userWithRoles(["dispatcher"]));
    for (const call of [
      () => caller.payroll.myPay(),
      () => caller.payroll.profilesList(),
      () => caller.payroll.runsList(),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });
});

d("running payroll is not approving it", () => {
  it("lets payroll_admin run and refuses it approval", async () => {
    const caller = callerFor(await userWithRoles(["payroll_admin"]));
    expect(
      await attempt(() =>
        caller.payroll.runCreate({ payRunRef: "PR-1", payPeriodId: 1, financialEntityId: FIXTURE_ENTITY_ID })
      )
    ).toBe("passed_gate");
    expect(
      await attempt(() => caller.payroll.runApprove({ payRunRef: "PR-1", toState: "approved" }))
    ).toBe("forbidden");
  });

  it("lets controller approve and refuses it the run", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    expect(
      await attempt(() =>
        caller.payroll.runCreate({ payRunRef: "PR-2", payPeriodId: 1, financialEntityId: FIXTURE_ENTITY_ID })
      )
    ).toBe("forbidden");
    expect(
      await attempt(() => caller.payroll.runApprove({ payRunRef: "PR-nope", toState: "approved" }))
    ).toBe("passed_gate");
  });

  it("keeps both permissions off every other role", () => {
    for (const p of ["payroll.run", "payroll.approve"] as const) {
      const holders = ALL_ROLES.filter(
        r => authorize({ userId: 1, roles: [r], permission: p }).allowed
      );
      expect(holders, p).toEqual(p === "payroll.run" ? ["payroll_admin"] : ["controller"]);
    }
  });
});

d("management has no implicit access to private payroll", () => {
  it("refuses management the employee payroll surface", async () => {
    const caller = callerFor(await userWithRoles(["management"]));
    for (const call of [
      () => caller.payroll.profilesList(),
      () => caller.payroll.earningsList(),
      () => caller.payroll.runsList(),
      () => caller.payroll.export({ payRunRef: "PR-1" }),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });
});

d("the external accountant reads books and runs nothing", () => {
  it("reaches the finance surface", async () => {
    const caller = callerFor(await userWithRoles(["external_accountant"]));
    for (const call of [
      () => caller.finance.entitiesList(),
      () => caller.finance.expensesList(),
      () => caller.finance.taxRulesList(),
      () => caller.contractors.settlementsList(),
    ]) {
      expect(await attempt(call)).toBe("passed_gate");
    }
  });

  it("cannot run payroll, operate trucks, or touch maintenance and safety", async () => {
    const caller = callerFor(await userWithRoles(["external_accountant"]));
    for (const call of [
      () => caller.payroll.runsList(),
      () => caller.payroll.runCreate({ payRunRef: "PR-x", payPeriodId: 1, financialEntityId: FIXTURE_ENTITY_ID }),
      () => caller.fieldRoute.trips.create({ jobId: 1 }),
      () => caller.fieldRoute.workOrders.create({ unitId: 1, workOrderNumber: "WO-x" }),
      () => caller.records.incident.readInvestigation({ incidentNumber: "INC-1" }),
      () => caller.finance.entityCreate({
        entityRef: "E-1", legalName: "X", taxpayerType: "corporation", jurisdiction: "CA",
      }),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });
});

d("the personal tax organizer stays personal", () => {
  it("lets a worker reach their own documents", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(await attempt(() => caller.finance.myTaxDocs())).toBe("passed_gate");
  });

  it("lets every role open their own organizer, and only their own", async () => {
    // B20.9 resolved the arbitrary split. The boundary was never "which role
    // may open the page" — it is whose documents come back, and that is
    // resolved from the session.
    for (const role of [
      "office", "management", "controller", "bookkeeper",
      "payroll_admin", "external_accountant", "tax_preparer", "driver",
    ] as const) {
      const userId = await userWithRoles([role]);
      const docs = await callerFor(userId).finance.myTaxDocs();
      expect(docs.every(dc => dc.ownerUserId === userId), role).toBe(true);
    }
  });

  it("scopes the organizer to the session user, whoever holds the permission", async () => {
    // The boundary that actually matters is whose documents come back.
    const hrUser = await userWithRoles(["hr"]);
    const docs = await callerFor(hrUser).finance.myTaxDocs();
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.every(dc => dc.ownerUserId === hrUser)).toBe(true);
  });

  it("refuses sharing a document the caller does not own", async () => {
    // Ownership is checked in the service against the session user, not input.
    const owner = await userWithRoles(["driver"]);
    const other = await userWithRoles(["driver"]);
    const added = await callerFor(owner).finance.myTaxDocAdd({
      documentKind: "T4", taxYear: 2026,
    });
    expect(added.id).toBeTruthy();
    expect(
      await attempt(() =>
        callerFor(other).finance.myTaxDocShare({ documentId: added.id!, entityId: 1 })
      )
    ).toBe("forbidden");
  });
});

d("tax rules cannot be verified into existence", () => {
  it("reserves rule loading to the controller", async () => {
    const holders = ALL_ROLES.filter(
      r => authorize({ userId: 1, roles: [r], permission: "tax.rules.manage" }).allowed
    );
    expect(holders).toEqual(["controller"]);
  });

  it("refuses a bookkeeper loading a rule", async () => {
    const caller = callerFor(await userWithRoles(["bookkeeper"]));
    expect(
      await attempt(() =>
        caller.finance.taxRuleLoad({
          ruleKey: "x.y", jurisdiction: "CA-AB", ruleType: "registration_threshold",
          parameters: { amount: 30000 }, effectiveFrom: new Date(),
          requestedStatus: "verified",
          source: { sourceKey: "s1", authority: "Someone", verified: true },
        })
      )
    ).toBe("forbidden");
  });

  it("downgrades a rule whose source is not verified, whatever was requested", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const r = await caller.finance.taxRuleLoad({
      ruleKey: `unverified.${Date.now()}`,
      jurisdiction: "CA-AB",
      ruleType: "registration_threshold",
      parameters: { amount: 30000 },
      effectiveFrom: new Date("2026-01-01"),
      requestedStatus: "verified",
      source: { sourceKey: `s-${Date.now()}`, authority: "Unconfirmed", verified: false },
    });
    expect(r.storedStatus).toBe("unverified");
    expect(r.note).toContain("cannot be verified unless its source is verified");
  });

  it("keeps the filing profile empty and incomplete with no verified rules", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const p = await caller.finance.filingProfile({
      taxpayerType: "corporation",
      jurisdiction: "ZZ-NOWHERE",
      taxYear: 2026,
    });
    // Not even the obvious obligations are asserted from code.
    expect(p.obligations).toEqual([]);
    expect(p.incomplete).toBe(true);
  });

  it("reports an unknown threshold rather than 'not required'", async () => {
    const caller = callerFor(await userWithRoles(["controller"]));
    const a = await caller.finance.thresholdCheck({
      jurisdiction: "ZZ-NOWHERE",
      rollingRevenue: 250000,
    });
    expect(a.status).toBe("unknown");
    expect(a.thresholdAmount).toBeUndefined();
  });
});

d("expenses and contractor settlement", () => {
  it("assesses an expense to review and stores the personal half", async () => {
    const caller = callerFor(await userWithRoles(["office"]));
    const a = await caller.finance.expenseAssess({
      total: 135, transactionDate: new Date(), hasReceiptEvidence: true,
      categoryKey: "cellular", businessUsePercent: 70, categorySource: "human",
      paidPersonally: false,
    });
    expect(a.treatment).toBe("unknown_review_required");
    expect(a.personalAmount).toBe(40.5);
  });

  it("refuses a driver setting a tax treatment", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() =>
        caller.finance.expenseSetTreatment({ expenseRef: "EXP-1", treatment: "potentially_deductible" })
      )
    ).toBe("forbidden");
  });

  it("refuses settling an employee as a contractor", async () => {
    const caller = callerFor(await userWithRoles(["office"]));
    await expect(
      caller.contractors.settlementCreate({
        settlementRef: `S-${Date.now()}`,
        contractorEntityId: FIXTURE_ENTITY_ID, payingEntityId: FIXTURE_PAYER_ID,
        periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-15"),
        workerKind: "employee",
        lines: [{ lineType: "freight", description: "Haul", amount: 100 }],
      })
    ).rejects.toThrow(/pay through payroll/);
  });

  it("refuses giving a contractor an employee payroll profile", async () => {
    const caller = callerFor(await userWithRoles(["hr"]));
    await expect(
      caller.payroll.profileUpsert({
        employeeNumber: `EMP-${Date.now()}`,
        financialEntityId: FIXTURE_ENTITY_ID,
        employmentType: "full_time",
        defaultPayMethod: "hourly",
        workerKind: "contractor",
      })
    ).rejects.toThrow(/contractor settlement/);
  });

  it("leaves the information-return question unassessed rather than guessing", async () => {
    const caller = callerFor(await userWithRoles(["office"]));
    const ref = `S-${Date.now()}`;
    await caller.contractors.settlementCreate({
      settlementRef: ref, contractorEntityId: FIXTURE_ENTITY_ID, payingEntityId: FIXTURE_PAYER_ID,
      periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-15"),
      workerKind: "contractor",
      lines: [
        { lineType: "freight", description: "Haul", amount: 14880 },
        { lineType: "fuel_advance", description: "Advance", amount: 3210 },
      ],
    });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT informationReturnAssessment, netAmount FROM contractorSettlements WHERE settlementRef = ?",
      [ref]
    );
    expect(rows[0].informationReturnAssessment).toBe("rule_unverified");
    expect(Number(rows[0].netAmount)).toBe(11670);
  });
});

d("coverage and sensitivity", () => {
  it("gates every payroll and finance procedure", () => {
    const src = require("node:fs").readFileSync("server/payrollRouter.ts", "utf8");
    expect(/\w+:\s*protectedProcedure\b/.test(src)).toBe(false);
    const wired = (src.match(/roleProcedure\(/g) ?? []).length;
    expect(wired).toBe(40);
  });

  it("declares a permission for every one of them", () => {
    const src = require("node:fs").readFileSync("server/payrollRouter.ts", "utf8");
    const names = Array.from(src.matchAll(/roleProcedure\("([^"]+)"\)/g)).map(
      (m: RegExpMatchArray) => m[1]
    );
    for (const n of names) {
      expect(
        Object.prototype.hasOwnProperty.call(OPERATIONAL_PROCEDURE_PERMISSIONS, n),
        `${n} undeclared`
      ).toBe(true);
    }
  });

  it("registers the irreversible finance writes as sensitive", () => {
    for (const p of [
      "payroll.profile.write", "contractor.approve", "finance.entity.write",
      "payroll.approve", "payroll.run", "tax.rules.manage",
    ] as const) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });

  it("refuses a role-less caller across all three routers", async () => {
    const caller = callerFor(newUserId());
    for (const call of [
      () => caller.payroll.myPay(),
      () => caller.finance.entitiesList(),
      () => caller.contractors.settlementsList(),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });
});
