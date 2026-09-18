import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import {
  OPERATIONAL_PROCEDURE_PERMISSIONS,
  authorize,
  isSensitivePermission,
  type DomainRole,
} from "./_core/recordsAuthorization";
import { grantUserRole, listActiveUserRoleNames } from "./db";

/**
 * The migrated operational surface, exercised the way a client meets it.
 *
 * B20.4 moved 28 procedures off `protectedProcedure`. What matters is not that
 * they now call a different builder — it is that the wrong caller is actually
 * refused. Every request below goes through the real `appRouter` with a forged
 * context and no UI in the way.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
let nextId = 300000 + Math.floor(Math.random() * 90000);
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
      userId,
      role,
      scopeType: "global",
      grantedByUserId: 1,
      grantedAt: new Date(),
    });
  }
  return userId;
}

const isForbidden = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e &&
  ["FORBIDDEN", "UNAUTHORIZED"].includes((e as { code: string }).code);

/**
 * Runs the call and reports whether the gate refused it.
 *
 * Anything that is not a tRPC error is rethrown. An earlier version swallowed
 * everything, which meant a mistyped router path surfaced as "passed the gate"
 * — a helper that turns a structural mistake into a green authorization test is
 * worse than no helper.
 */
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
    // A mistyped router path comes back as NOT_FOUND, which is not a gate
    // result. The previous hardening caught non-tRPC errors and missed this
    // one, so ten path mistakes read as passes. Fail loudly instead.
    if (code === "NOT_FOUND") {
      throw new Error(
        `Harness error: procedure path not found (tRPC NOT_FOUND). Fix the path, do not treat this as authorization.`
      );
    }
    // A domain-level error means authorization let it through.
    return "passed_gate";
  }
}

/** All 15 roles. Stale at B20.7 with only the original 10 — permissions held
 *  solely by a finance role looked orphaned when they were not. */
const ALL_ROLES: DomainRole[] = [
  "driver", "dispatcher", "mechanic", "shop_lead", "safety",
  "office", "management", "hr", "legal", "auditor",
  "bookkeeper", "payroll_admin", "tax_preparer", "controller",
  "external_accountant",
];

d("billing is closed to the field and the shop", () => {
  it("refuses a driver reading rate cards", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(await attempt(() => caller.fieldRoute.billing.rateCards.list())).toBe("forbidden");
  });

  it("refuses a mechanic opening job charge lines", async () => {
    const caller = callerFor(await userWithRoles(["mechanic"]));
    expect(
      await attempt(() => caller.fieldRoute.billing.lines.list({ jobId: 1 }))
    ).toBe("forbidden");
  });

  it("refuses a dispatcher updating a rate card", async () => {
    const caller = callerFor(await userWithRoles(["dispatcher"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.billing.rateCards.update({ id: 1, active: false })
      )
    ).toBe("forbidden");
  });

  it("lets office through to billing reads and writes", async () => {
    const caller = callerFor(await userWithRoles(["office"]));
    expect(await attempt(() => caller.fieldRoute.billing.rateCards.list())).toBe("passed_gate");
  });

  it("keeps billing writes off every operational role", async () => {
    for (const role of ["driver", "dispatcher", "mechanic", "shop_lead", "auditor"] as const) {
      expect(
        authorize({ userId: 1, roles: [role], permission: "billing.write" }).allowed,
        role
      ).toBe(false);
    }
  });
});

d("personnel is closed to the field", () => {
  it("refuses a driver listing operators", async () => {
    // A driver has no business enumerating the workforce.
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(await attempt(() => caller.fieldRoute.identity.operators.list())).toBe("forbidden");
  });

  it("lets a dispatcher read operators but not create them", async () => {
    const caller = callerFor(await userWithRoles(["dispatcher"]));
    expect(await attempt(() => caller.fieldRoute.identity.operators.list())).toBe("passed_gate");
    expect(
      await attempt(() => caller.fieldRoute.identity.operators.create({ name: "X" }))
    ).toBe("forbidden");
  });

  it("lets HR create an operator record", async () => {
    const caller = callerFor(await userWithRoles(["hr"]));
    expect(
      await attempt(() => caller.fieldRoute.identity.operators.create({ name: "New Hire" }))
    ).toBe("passed_gate");
  });
});

d("compliance verification is narrower than compliance reading", () => {
  it("lets a mechanic read documents but not verify one", async () => {
    // The shop needs to see whether an inspection is current. Deciding that it
    // is verified is a different act.
    const caller = callerFor(await userWithRoles(["mechanic"]));
    expect(await attempt(() => caller.fieldRoute.identity.documents.list())).toBe("passed_gate");
    expect(
      await attempt(() =>
        caller.fieldRoute.identity.documents.review({ id: 1, status: "verified" })
      )
    ).toBe("forbidden");
  });

  it("refuses a driver verifying a compliance document", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.identity.documents.review({ id: 1, status: "verified" })
      )
    ).toBe("forbidden");
  });

  it("lets safety verify a document", async () => {
    const caller = callerFor(await userWithRoles(["safety"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.identity.documents.review({ id: 1, status: "rejected" })
      )
    ).toBe("passed_gate");
  });

  it("reserves document verification to office, safety and management", async () => {
    const holders = ALL_ROLES.filter(
      r => authorize({ userId: 1, roles: [r], permission: "compliance.review" }).allowed
    );
    expect(holders.sort()).toEqual(["management", "office", "safety"]);
  });
});

d("safety and maintenance writes stay with the people who do them", () => {
  it("lets a driver file a tailgate meeting and report a defect", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.complianceEngine.tailgates.create({ jobId: 1, topic: "Ground conditions" })
      )
    ).toBe("passed_gate");
    expect(
      await attempt(() =>
        caller.fieldRoute.compliance.maintenance.create({
          unitId: 1,
          description: "Pump grinding on PTO",
          severity: "critical",
        })
      )
    ).toBe("passed_gate");
  });

  it("refuses a driver opening a work order", async () => {
    // Reporting a defect is an observation. Raising the work order is not.
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.workOrders.create({ unitId: 1, workOrderNumber: "WO-1" })
      )
    ).toBe("forbidden");
  });

  it("lets a mechanic open and update a work order", async () => {
    const caller = callerFor(await userWithRoles(["mechanic"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.workOrders.create({ unitId: 1, workOrderNumber: "WO-2" })
      )
    ).toBe("passed_gate");
  });

  it("refuses an auditor writing a safety record", async () => {
    const caller = callerFor(await userWithRoles(["auditor"]));
    expect(
      await attempt(() =>
        caller.fieldRoute.safety.create({ jobId: 1, type: "hazard", description: "x" })
      )
    ).toBe("forbidden");
  });
});

d("role-less and unauthenticated callers reach nothing", () => {
  it("refuses every migrated read to a user with no domain role", async () => {
    const caller = callerFor(newUserId());
    for (const call of [
      () => caller.fieldRoute.identity.operators.list(),
      () => caller.fieldRoute.billing.rateCards.list(),
      () => caller.fieldRoute.identity.documents.list(),
      () => caller.fieldRoute.safety.list(),
      () => caller.fieldRoute.workOrders.list(),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });

  it("refuses an anonymous caller", async () => {
    const anon = appRouter.createCaller({
      req: {} as never,
      res: {} as never,
      user: null,
    });
    expect(await attempt(() => anon.fieldRoute.billing.rateCards.list())).toBe("forbidden");
  });
});

d("the migrated tranche is coherent", () => {
  it("declares a permission for every migrated procedure", () => {
    // 85 operational + 40 payroll/finance + 10 portals/funding + 9 roadside/purchasing/AP + 6 devices/sync + 9 compliance + 6 requirement/calibration + 12 insurance.
    expect(Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS).length).toBe(616)   // v22.40: +3 commercialOffice.{organizationCreate,organizationsList,facilityStatementsList} (P7.9);   // v22.38: +9 commercialOffice.document* (P7.7, 0144);   // v22.36: +2 facilityDirectory.{hydrovacImport,duplicates};   // v22.35: +6 facilityDirectory.{arcgisPresets,arcgisInspect,arcgisImportFeatures,arcgisImportFromLayer,arcgisRuns,lsdFind} (0142);   // v22.34: +1 facilityDirectory.seedBrief (0141);   // v22.33: +5 facilityDirectory.{hoursSet,callAheadRecord,waitReport,nearby,driverView} (0140);   // v22.32: +14 facilityDirectory.* (0139, re-based from feature/facility-map-v7);   // v22.31: +5 commercialOffice.{glAccountSet,glMappingSet,glList,glExportReadiness,profitabilityByDimension} (P7.6, 0138);   // v22.30: +1 commercialOffice.apAgingByOrganization (P7.5, 0137);   // v22.29: +2 commercialOffice.{arAgingByOrganization,approvalLedger} (P7.4, 0136);   // v22.28: +4 commercialOffice.facilityStatement* (P7.3, 0135);   // v22.27: +4 commercialOffice.link* (P7.2, 0134);   // v22.26: +15 commercialOffice.* (P7.1, 0133);   // v22.23: +2 academy.{sheetPrintRun,sheetScanFile} (0125); +3 widgets.{offerable,boardResolve,layoutSave} (B28);   // v22.21: census re-baselined to the real map (ChatGPT recovery commits added entries without bumping it); +14 contractorOperations.* (wired by procedure name)   // v22.21: +1 hos.limitPromote (recovered 0093)   // v22.20: +5 agent runtime   // v22.20: +1 (source licence review)   // v22.17: +16 communications; v22.18: +4 (policy propose/approve/current, channel retire); v22.20: +1 (source licence review); v22.19: +4 (package build/fetch/acknowledge/status); v22.20: +7 hours of service   // v22.7: +13 commercial setup   // v22.67: +6 automationPolicy.{resolve,set,setEntitlement,operationalOverride,history,snapshotFor} (P8.2) +1 hos.attestHours (P8.3), +1 hos.recordScannedLog
  });

  it("has a holder for every permission it uses", () => {
    for (const perm of Object.values(OPERATIONAL_PROCEDURE_PERMISSIONS)) {
      const holders = ALL_ROLES.filter(
        r => authorize({ userId: 1, roles: [r], permission: perm }).allowed
      );
      expect(holders.length, `nobody can use ${perm}`).toBeGreaterThan(0);
    }
  });

  it("separates reads from writes rather than granting a whole router", () => {
    // rateCards.list and rateCards.update must not share a permission.
    expect(OPERATIONAL_PROCEDURE_PERMISSIONS["rateCards.list"]).toBe("billing.read");
    expect(OPERATIONAL_PROCEDURE_PERMISSIONS["rateCards.update"]).toBe("billing.write");
    expect(OPERATIONAL_PROCEDURE_PERMISSIONS["documents.list"]).toBe("compliance.read");
    expect(OPERATIONAL_PROCEDURE_PERMISSIONS["documents.review"]).toBe("compliance.review");
    expect(OPERATIONAL_PROCEDURE_PERMISSIONS["maintenance.create"]).toBe("maintenance.write_defect");
    expect(OPERATIONAL_PROCEDURE_PERMISSIONS["workOrders.create"]).toBe("maintenance.write_work_order");
  });

  it("registers the new privileged writes as sensitive", () => {
    for (const p of ["billing.write", "personnel.write", "compliance.review"] as const) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });

  it("audits a refusal on a migrated procedure", async () => {
    const userId = await userWithRoles(["driver"]);
    await attempt(() => callerFor(userId).fieldRoute.billing.rateCards.list());

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT outcome, permission, procedureName FROM authorizationDecisions WHERE actorUserId = ? ORDER BY id DESC LIMIT 1",
      [userId]
    );
    expect(rows[0].outcome).toBe("denied_permission");
    expect(rows[0].permission).toBe("billing.read");
    expect(rows[0].procedureName).toBe("rateCards.list");
    expect(await listActiveUserRoleNames(userId)).toEqual(["driver"]);
  });
});

d("B20.6 — the acts that create fact, not just report it", () => {
  it("refuses an auditor confirming a GPS zone event", async () => {
    // A confirmed zone event becomes a billable arrival. Reading position data
    // and turning it into money are not the same permission.
    const caller = callerFor(await userWithRoles(["auditor"]));
    expect(
      await attempt(() => caller.fieldRoute.gps.confirmZoneEvent({ id: 1, confirmed: true }))
    ).toBe("forbidden");
    expect(await attempt(() => caller.fieldRoute.gps.zoneEvents({}))).toBe("passed_gate");
  });

  it("lets a driver submit position but not confirm a zone event", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() => caller.fieldRoute.gps.confirmZoneEvent({ id: 1, confirmed: true }))
    ).toBe("forbidden");
  });

  it("refuses a mechanic acknowledging a custody transfer", async () => {
    // Accepting custody of a load is a driver, dispatch or management act.
    const caller = callerFor(await userWithRoles(["mechanic"]));
    expect(
      await attempt(() => caller.fieldRoute.complianceEngine.transfers.acknowledge({ id: 1 }))
    ).toBe("forbidden");
  });

  it("refuses a driver committing an assistant proposal", async () => {
    // Drafting and answering are capture. Committing writes operational truth.
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(
      await attempt(() => caller.fieldRoute.assistant.commit({ id: 1 }))
    ).toBe("forbidden");
    expect(await attempt(() => caller.fieldRoute.assistant.pending())).toBe("passed_gate");
  });

  it("refuses a driver reviewing or rejecting an assistant proposal", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    for (const call of [
      () => caller.fieldRoute.assistant.reject({ id: 1, reason: "no" }),
      () => caller.fieldRoute.assistant.setStatus({ id: 1, status: "rejected" }),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });

  it("refuses everyone but management a routing decision", async () => {
    for (const role of ["driver", "dispatcher", "office", "safety", "auditor"] as const) {
      const caller = callerFor(await userWithRoles([role]));
      expect(
        await attempt(() => caller.fieldRoute.routeDecisions.create({ tripId: 1, decision: "approved" })),
        role
      ).toBe("forbidden");
    }
  });

  it("refuses a driver creating a job or assigning a unit", async () => {
    const caller = callerFor(await userWithRoles(["driver"]));
    expect(await attempt(() => caller.fieldRoute.jobs.create({ code: "J-1" }))).toBe("forbidden");
    expect(
      await attempt(() => caller.fieldRoute.identity.jobUnits.create({ jobId: 1, unitId: 1 }))
    ).toBe("forbidden");
    // But their own trip and load work goes through.
    expect(await attempt(() => caller.fieldRoute.trips.list({}))).toBe("passed_gate");
  });

  it("refuses an auditor every write on the operational surface", async () => {
    const caller = callerFor(await userWithRoles(["auditor"]));
    for (const call of [
      () => caller.fieldRoute.jobs.create({ code: "J-2" }),
      () => caller.fieldRoute.trips.create({ jobId: 1 }),
      () => caller.fieldRoute.compliance.loads.create({ tripId: 1 }),
      () => caller.fieldRoute.manifests.create({ loadId: 1 }),
      () => caller.fieldRoute.identity.units.create({ unitCode: "U-1" }),
      () => caller.fieldRoute.evidence.verify({ id: 1, status: "verified" }),
      () => caller.fieldRoute.dutyRecords.create({ operatorId: 1, status: "on_duty" }),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });

  it("lets an auditor read the operational surface", async () => {
    const caller = callerFor(await userWithRoles(["auditor"]));
    for (const call of [
      () => caller.fieldRoute.jobs.list({}),
      () => caller.fieldRoute.trips.list({}),
      () => caller.fieldRoute.manifests.list({}),
      () => caller.fieldRoute.dutyRecords.list({}),
    ]) {
      expect(await attempt(call)).toBe("passed_gate");
    }
  });

  it("gives HR duty records for payroll and nothing else operational", async () => {
    const caller = callerFor(await userWithRoles(["hr"]));
    expect(await attempt(() => caller.fieldRoute.dutyRecords.list({}))).toBe("passed_gate");
    expect(await attempt(() => caller.fieldRoute.trips.list({}))).toBe("forbidden");
    expect(await attempt(() => caller.fieldRoute.jobs.list({}))).toBe("forbidden");
  });

  it("lets office correct a duty record the driver recorded", async () => {
    // HOS amendments and office review are an explicit requirement; without
    // this only the driver could ever fix their own duty record.
    const caller = callerFor(await userWithRoles(["office"]));
    expect(
      await attempt(() => caller.fieldRoute.dutyRecords.create({ operatorId: 1, status: "on_duty" }))
    ).toBe("passed_gate");
  });

  it("refuses a role-less caller everywhere on the new surface", async () => {
    const caller = callerFor(newUserId());
    for (const call of [
      () => caller.fieldRoute.jobs.list({}),
      () => caller.fieldRoute.gps.breadcrumbs({}),
      () => caller.fieldRoute.assistant.forms(),
      () => caller.fieldRoute.identity.units.list(),
    ]) {
      expect(await attempt(call)).toBe("forbidden");
    }
  });

  it("registers the fact-creating acts as sensitive", () => {
    for (const p of [
      "transfer.acknowledge", "gps.confirm", "route.decide",
      "evidence.verify", "assistant.commit",
    ] as const) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });
});
