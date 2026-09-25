import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXTERNAL_PROCEDURE_PERMISSIONS, OPERATIONAL_PROCEDURE_PERMISSIONS, RECORDS_PROCEDURE_PERMISSIONS, type ProcedureName } from "./_core/recordsAuthorization";
import {
  UNVERIFIED_DATA_SOURCES,
  VERIFIED_DATA_SOURCES,
} from "./_core/externalSourceSeeds";

/**
 * Drift guard.
 *
 * B20.3 gated the records surface and left 85 pre-existing procedures on
 * authenticated-only. That debt is acceptable only while it is visible and
 * shrinking. This test makes both true: the counts are asserted, so adding a
 * bare `protectedProcedure` fails the build and forces a deliberate
 * classification in PROCEDURE_AUTHORIZATION_INVENTORY.md.
 *
 * The number is expected to go DOWN. If it goes up, someone added an ungated
 * operational procedure and this is the thing that noticed.
 */

const routers = readFileSync("server/routers.ts", "utf8");
const recordsRouter = readFileSync("server/recordsRouter.ts", "utf8");
const payrollRouter = readFileSync("server/payrollRouter.ts", "utf8");
const portalFundingRouter = readFileSync("server/portalFundingRouter.ts", "utf8");
const purchasingRouter = readFileSync("server/purchasingRouter.ts", "utf8");
const deviceRouter = readFileSync("server/deviceRouter.ts", "utf8");
const complianceRouter = readFileSync("server/complianceRouter.ts", "utf8");
const requirementRouter = readFileSync("server/requirementRouter.ts", "utf8");
const surfacesRouter = readFileSync("server/surfacesRouter.ts", "utf8");
const widgetsRouter = readFileSync("server/widgetsRouter.ts", "utf8");
const manifestCustodyRouter = readFileSync("server/manifestCustodyRouter.ts", "utf8");
const securityIncidentsRouter = readFileSync("server/securityIncidentsRouter.ts", "utf8");
const commercialOfficeRouter = readFileSync("server/commercialOfficeRouter.ts", "utf8");
const facilityDirectoryRouter = readFileSync("server/facilityDirectoryRouter.ts", "utf8");
const dispatchRouter = readFileSync("server/dispatchRouter.ts", "utf8");
const iftaRouter = readFileSync("server/iftaRouter.ts", "utf8");
const fuelOpsRouter = readFileSync("server/fuelOpsRouter.ts", "utf8");
const periodRouter = readFileSync("server/periodRouter.ts", "utf8");
const gstRouter = readFileSync("server/gstRouter.ts", "utf8");
const cashRouter = readFileSync("server/cashRouter.ts", "utf8");
const commercialRouter = readFileSync("server/commercialRouter.ts", "utf8");
const portalRouter = readFileSync("server/portalRouter.ts", "utf8");
const shopRouter = readFileSync("server/shopRouter.ts", "utf8");
const maintenanceRouter = readFileSync("server/maintenanceRouter.ts", "utf8");
const fleetPortfolioRouter = readFileSync("server/fleetPortfolioRouter.ts", "utf8");
const assetRouter = readFileSync("server/assetRouter.ts", "utf8");
const projectRouter = readFileSync("server/projectRouter.ts", "utf8");
const integrationRouter = readFileSync("server/integrationRouter.ts", "utf8");
const telematicsRouter = readFileSync("server/telematicsRouter.ts", "utf8");
const workforceRouter = readFileSync("server/workforceRouter.ts", "utf8");
const auditRouter = readFileSync("server/auditRouter.ts", "utf8");
const spatialRouter = readFileSync("server/spatialRouter.ts", "utf8");
const commercialSetupRouter = readFileSync("server/commercialSetupRouter.ts", "utf8");
const invoicingRouter = readFileSync("server/invoicingRouter.ts", "utf8");
const geoRouter = readFileSync("server/geoRouter.ts", "utf8");
const commsRouter = readFileSync("server/commsRouter.ts", "utf8");
const enforcementRouter = readFileSync("server/enforcementRouter.ts", "utf8");
const timeOffRouter = readFileSync("server/timeOffRouter.ts", "utf8");
const openShiftsRouter = readFileSync("server/openShiftsRouter.ts", "utf8");
const crewRouter = readFileSync("server/crewRouter.ts", "utf8");
const automationPolicyRouter = readFileSync("server/automationPolicyRouter.ts", "utf8");   // P8.2
const restrictedVaultRouter = readFileSync("server/restrictedVaultRouter.ts", "utf8");   // P8.5
const calendarRouter = readFileSync("server/calendarRouter.ts", "utf8");
const readinessRouter = readFileSync("server/readinessRouter.ts", "utf8");
const messageBoardRouter = readFileSync("server/messageBoardRouter.ts", "utf8");
const agentRouter = readFileSync("server/agentRouter.ts", "utf8");
const hosRouter = readFileSync("server/hosRouter.ts", "utf8");
const closeoutRouter = readFileSync("server/closeoutRouter.ts", "utf8");
const insuranceRouter = readFileSync("server/insuranceRouter.ts", "utf8");
const assistantAskRouter = readFileSync("server/assistantAskRouter.ts", "utf8");
// v22.21: post-recovery routers the census did not scan. Both carry declared
// procedures; a router the tripwire cannot see is a router it cannot defend.
const contractorOperationsRouter = readFileSync("server/contractorOperationsRouter.ts", "utf8");
const trainingAcademyRouter = readFileSync("server/trainingAcademyRouter.ts", "utf8");
const inventory = readFileSync("PROCEDURE_AUTHORIZATION_INVENTORY.md", "utf8");
const dataSources = readFileSync("DATA_SOURCES.md", "utf8");

/**
 * The operational permission map spans more than one file now — routers.ts and
 * payrollRouter.ts both draw from it. Checking only one would let a declared
 * permission go unwired without anyone noticing.
 */
const OPERATIONAL_SOURCES = [routers, automationPolicyRouter, restrictedVaultRouter, payrollRouter, portalFundingRouter, purchasingRouter, deviceRouter, complianceRouter, requirementRouter, insuranceRouter, surfacesRouter, widgetsRouter, manifestCustodyRouter, securityIncidentsRouter, commercialOfficeRouter, facilityDirectoryRouter, dispatchRouter, iftaRouter, fuelOpsRouter, periodRouter, gstRouter, cashRouter, commercialRouter, closeoutRouter, shopRouter, maintenanceRouter, fleetPortfolioRouter, assetRouter, projectRouter, integrationRouter, telematicsRouter, workforceRouter, auditRouter, spatialRouter, commercialSetupRouter + invoicingRouter + geoRouter + commsRouter + hosRouter + enforcementRouter + timeOffRouter + openShiftsRouter + crewRouter + calendarRouter + readinessRouter + messageBoardRouter + agentRouter + assistantAskRouter + contractorOperationsRouter + trainingAcademyRouter].join("\n");

const countBuilders = (src: string, builder: string) =>
  (src.match(new RegExp(`\\w+:\\s*${builder}\\b`, "g")) ?? []).length;

/** Baseline recorded at B20.3. Lowering it is the goal; raising it is a bug. */
/**
 * Zero. B20.6 finished the migration — every operational procedure in
 * routers.ts now goes through roleProcedure with a declared permission.
 *
 * This baseline must never rise. A bare `protectedProcedure` added tomorrow is
 * an ungated operational endpoint, and this is the thing that notices.
 */
const UNREVIEWED_BASELINE = 0;
/*
 * S1: 2 → 4. `auth.refresh` and `auth.revokeAll` are public **necessarily**, not by oversight —
 * a refresh exists precisely because the access credential has expired, so requiring an
 * authenticated session to obtain one would be circular. They are not ungated: both demand
 * possession of a single-use refresh verifier whose hash is stored server-side, and both refuse
 * identically whatever the reason, so neither reveals which families exist. The other two remain
 * `auth.me` and `auth.logout`.
 */
const PUBLIC_BASELINE = 4;

describe("records surface is fully role-authorized", () => {
  it("uses roleProcedure for every records procedure", () => {
    const roleCount = (recordsRouter.match(/roleProcedure\(/g) ?? []).length;
    expect(roleCount).toBe(Object.keys(RECORDS_PROCEDURE_PERMISSIONS).length);
    expect(roleCount).toBe(18);
  });

  it("has no protectedProcedure fallback in the records router", () => {
    // The only occurrence permitted is the doc comment explaining its absence.
    const uses = countBuilders(recordsRouter, "protectedProcedure");
    expect(uses).toBe(0);
  });

  it("maps every roleProcedure name to a declared permission", () => {
    const names = Array.from(
      recordsRouter.matchAll(/roleProcedure\("([^"]+)"\)/g)
    ).map(m => m[1]);
    expect(names.length).toBe(18);
    for (const n of names) {
      expect(
        Object.prototype.hasOwnProperty.call(RECORDS_PROCEDURE_PERMISSIONS, n),
        `${n} is not in RECORDS_PROCEDURE_PERMISSIONS`
      ).toBe(true);
    }
  });

  it("has no orphan mapping — every declared permission is actually wired", () => {
    const names = new Set(
      Array.from(recordsRouter.matchAll(/roleProcedure\("([^"]+)"\)/g)).map(m => m[1])
    );
    for (const declared of Object.keys(RECORDS_PROCEDURE_PERMISSIONS)) {
      expect(names.has(declared), `${declared} is declared but not wired`).toBe(true);
    }
  });
});

describe("migrated operational procedures", () => {
  it("gates every declared operational procedure in routers.ts", () => {
    const wired = new Set(
      Array.from(OPERATIONAL_SOURCES.matchAll(/roleProcedure\("([^"]+)"\)/g)).map(m => m[1])
    );
    for (const declared of Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS)) {
      expect(wired.has(declared), `${declared} declared but not wired`).toBe(true);
    }
    expect(wired.size).toBe(Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS).length);
  });

  it("has no roleProcedure in routers.ts without a declared permission", () => {
    const wired = Array.from(
      OPERATIONAL_SOURCES.matchAll(/roleProcedure\("([^"]+)"\)/g)
    ).map(m => m[1]);
    for (const name of wired) {
      expect(
        Object.prototype.hasOwnProperty.call(OPERATIONAL_PROCEDURE_PERMISSIONS, name),
        `${name} is wired but undeclared`
      ).toBe(true);
    }
  });

  it("has migrated the entire operational surface", () => {
    // 85 unreviewed at B20.3, 57 after B20.4, 0 after B20.6. B20.7 added the
    // 40-procedure payroll/finance surface, all gated from the start.
    // 85 operational + 40 payroll/finance + 10 portals/funding + 9 roadside/purchasing/AP + 6 devices/sync + 9 compliance + 6 requirement/calibration + 12 insurance.
    expect(Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS).length).toBe(646)   // 0199: +9 fleet.{unitState,holdList,holdPlace,holdRelease,meterReadings,meterProgress,meterRecord,meterDecide,history} (portfolio foundation);   // 0198: +3 maintenance.{workOrderAssignment,workOrderAssign,workOrderCancel} (fleet maintenance CP1);   // canonical assignment: +3 dispatch.{createPosting,addRole,listRoles};   // v22.40: +3 commercialOffice.{organizationCreate,organizationsList,facilityStatementsList} (P7.9);   // v22.38: +9 commercialOffice.document* (P7.7, 0144);   // v22.36: +2 facilityDirectory.{hydrovacImport,duplicates};   // v22.35: +6 facilityDirectory.{arcgisPresets,arcgisInspect,arcgisImportFeatures,arcgisImportFromLayer,arcgisRuns,lsdFind} (0142);   // v22.34: +1 facilityDirectory.seedBrief (0141);   // v22.33: +5 facilityDirectory.{hoursSet,callAheadRecord,waitReport,nearby,driverView} (0140);   // v22.32: +14 facilityDirectory.* (0139, re-based from feature/facility-map-v7);   // v22.31: +5 commercialOffice.{glAccountSet,glMappingSet,glList,glExportReadiness,profitabilityByDimension} (P7.6, 0138);   // v22.30: +1 commercialOffice.apAgingByOrganization (P7.5, 0137);   // v22.29: +2 commercialOffice.{arAgingByOrganization,approvalLedger} (P7.4, 0136);   // v22.28: +4 commercialOffice.facilityStatement* (P7.3, 0135);   // v22.27: +4 commercialOffice.link* (P7.2, 0134);   // v22.26: +15 commercialOffice.* (P7.1, 0133: role types, roles, settings, numbering, approvals, categories);   // v22.23: +2 academy.{sheetPrintRun,sheetScanFile} (0125); +3 widgets.{offerable,boardResolve,layoutSave} (B28);   // v22.22: +6 academy (tdgCoverageSet/Approve/Status, inspectorRequestCreate/Assemble/List)   // v22.21: +4 integration.{ownershipAssign,ownershipList,loadSenseBindGateway,loadSenseCalibrate} (were wired under clientRegister/inboundList names)   // v22.21: census re-baselined to the real map (ChatGPT recovery commits added entries without bumping it); +14 contractorOperations.* (wired by procedure name)   // v22.21: +1 hos.limitPromote (recovered 0093)   // v22.20: +5 agent runtime   // v22.20: +1 (source licence review)   // v22.7: +13 commercial setup; v22.8: +2 (ticket pricing, vendor rate variances); v22.9: +3 invoicing; v22.10: +2 (render, send); v22.11: +2 (void, disputeResolve); v22.13: +5 geo; v22.14: +6 (legal land, entrances, corridor); v22.15: +4 (structures, route approvals); v22.16: +2 (graph build, route compute); v22.17: +16 communications; v22.18: +4 (policy propose/approve/current, channel retire); v22.20: +1 (source licence review); v22.19: +4 (package build/fetch/acknowledge/status); v22.20: +7 hours of service   // v22.67: +6 automationPolicy.{resolve,set,setEntitlement,operationalOverride,history,snapshotFor} (P8.2) +1 hos.attestHours (P8.3), +1 hos.recordScannedLog, +8 restrictedVault.* (P8.5), +1 restrictedVault.restrictedIndex, +1 device.verifySeal (P1.2)
    expect(UNREVIEWED_BASELINE).toBe(0);
  });

  it("wires exactly as many roleProcedures as it declares permissions for", () => {
    const wired = (OPERATIONAL_SOURCES.match(/roleProcedure\(/g) ?? []).length;
    expect(wired).toBe(Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS).length);
  });

  it("has no bare protectedProcedure in the payroll or finance surface", () => {
    expect(countBuilders(payrollRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the portal or funding surface", () => {
    expect(countBuilders(portalFundingRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the purchasing or AP surface", () => {
    expect(countBuilders(purchasingRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the device or sync surface", () => {
    expect(countBuilders(deviceRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the compliance surface", () => {
    expect(countBuilders(complianceRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the requirement or calibration surface", () => {
    expect(countBuilders(requirementRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the universal surfaces", () => {
    expect(countBuilders(surfacesRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the dispatch gate", () => {
    expect(countBuilders(dispatchRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in IFTA", () => {
    expect(countBuilders(iftaRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in fuel operations", () => {
    expect(countBuilders(fuelOpsRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in period close", () => {
    expect(countBuilders(periodRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in GST/HST", () => {
    expect(countBuilders(gstRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in bank and receivables", () => {
    expect(countBuilders(cashRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the shop or the asset register", () => {
    expect(countBuilders(shopRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(maintenanceRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(fleetPortfolioRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(assetRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(projectRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(integrationRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(telematicsRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(workforceRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(auditRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(spatialRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(commercialSetupRouter + invoicingRouter + geoRouter, "protectedProcedure")).toBe(0);
    // the inbound router mounts only the machine gate
    const inbound = integrationRouter.slice(integrationRouter.indexOf("export const inboundRouter"));
    expect(countBuilders(inbound, "roleProcedure")).toBe(0);
    expect(countBuilders(inbound, "externalProcedure")).toBe(0);
    expect(countBuilders(inbound, "integrationProcedure")).toBe(2);
  });

  it("has no bare protectedProcedure in the commercial core or the portal", () => {
    expect(countBuilders(commercialRouter, "protectedProcedure")).toBe(0);
    expect(countBuilders(portalRouter, "protectedProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the site sign-off chain", () => {
    expect(countBuilders(closeoutRouter, "protectedProcedure")).toBe(0);
  });

  it("v21.10 — the portal uses only externalProcedure, every call site is mapped, and nothing internal is reachable from outside", () => {
    // The portal router must never mount a role procedure: an external identity is not a domain-role user.
    expect(countBuilders(portalRouter, "roleProcedure")).toBe(0);
    const external = [...portalRouter.matchAll(/externalProcedure\("([^"]+)"\)/g)].map(m => m[1]);
    expect(external.length).toBe(36);   // v22.10: + invoices, invoiceView, invoiceAccept // v21.17: + quotes, quote acceptance, change-order authorization, RFI answers
    for (const name of external) expect(EXTERNAL_PROCEDURE_PERMISSIONS, name).toHaveProperty(name);
    expect(Object.keys(EXTERNAL_PROCEDURE_PERMISSIONS).sort()).toEqual([...external].sort());
    // And no internal router mounts an external procedure.
    expect(countBuilders(OPERATIONAL_SOURCES, "externalProcedure")).toBe(0);
  });

  it("has no bare protectedProcedure in the insurance surface", () => {
    expect(countBuilders(insuranceRouter, "protectedProcedure")).toBe(0);
  });
});

describe("the data source document matches the seeded registry", () => {
  it("states the corrected count of ten verified and eighteen not", () => {
    // The research summary said nine of eleven were clean; three were unresolved,
    // so it was eight. v22.17 added six spectrum and coverage sources, none of
    // them licence-cleared, so nine are now blocked. The document and the seed
    // must agree or a future reader trusts the wrong number. The Canadian 511 tranche cleared two
    // (Ontario, Québec) and blocked five (MB, NB, YT, NL, SK).
    expect(dataSources).toContain("Ten verified, eighteen not");
    expect(VERIFIED_DATA_SOURCES).toHaveLength(10);
    expect(UNVERIFIED_DATA_SOURCES).toHaveLength(18);
  });

  it("lists exactly the blocked sources as blocked", () => {
    for (const key of UNVERIFIED_DATA_SOURCES.map(s => s.sourceKey)) {
      expect(dataSources, key).toContain(`\`${key}\``);
    }
    expect(dataSources).toContain("blocked for everything but inspection");
  });

  it("still says plainly that no dataset has been imported", () => {
    expect(dataSources).toContain("No dataset has been imported");
  });
});

describe("the untouched API is counted, not forgotten", () => {
  it("holds the authenticated-only count at or below the recorded baseline", () => {
    const unreviewed = countBuilders(routers, "protectedProcedure");
    expect(
      unreviewed,
      unreviewed > UNREVIEWED_BASELINE
        ? "A new bare protectedProcedure was added. Gate it with roleProcedure, or classify it in PROCEDURE_AUTHORIZATION_INVENTORY.md and lower this baseline deliberately."
        : "Baseline is stale — lower UNREVIEWED_BASELINE to lock in the progress."
    ).toBe(UNREVIEWED_BASELINE);
  });

  it("holds the public procedure count exactly", () => {
    expect(countBuilders(routers, "publicProcedure")).toBe(PUBLIC_BASELINE);
  });

  it("has no stale narrative claiming completed work is still pending", () => {
    // The directive flagged this: an earlier revision described the 57-procedure
    // tranche as "next" beside a table showing it done. A future agent could
    // have repeated it.
    expect(inventory).not.toMatch(/AUTHENTICATED_ONLY_UNREVIEWED\s*\|\s*\*\*[1-9]/);
    expect(inventory).not.toContain("still to move");
    expect(inventory).not.toContain("— next");
  });

  it("keeps the inventory document in step with the code", () => {
    expect(inventory).toContain("ROLE_AUTHORIZED");
    expect(inventory).toContain("368");   // 0199: +9 server/fleetPortfolioRouter.ts; 0198: +3 server/maintenanceRouter.ts
  });
});

describe("a permission is not a procedure name, and the compiler says so", () => {
  it("accepts a declared procedure name and rejects a permission in its place", () => {
    // These assertions run at compile time, not at runtime. If `roleProcedure`
    // ever went back to taking a bare string, the @ts-expect-error lines below
    // would themselves become errors ("unused expect-error"), so this test fails
    // by refusing to build — which is the only way to pin a type.
    const good: ProcedureName = "comms.channelList";
    expect(good).toBe("comms.channelList");

    // @ts-expect-error — "comms.read" is a Permission, not a ProcedureName.
    const asPermission: ProcedureName = "comms.read";
    expect(typeof asPermission).toBe("string");

    // @ts-expect-error — a procedure nobody declared is not a ProcedureName.
    const undeclared: ProcedureName = "comms.notAProcedure";
    expect(typeof undeclared).toBe("string");
  });

  it("covers every procedure both maps declare", () => {
    const declared = [
      ...Object.keys(RECORDS_PROCEDURE_PERMISSIONS),
      ...Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS),
    ];
    // Every declared key is assignable to ProcedureName by construction; this
    // pins that both maps are still in the union rather than only one.
    expect(declared).toContain("comms.channelList");
    expect(declared.length).toBeGreaterThan(400);
  });
});
