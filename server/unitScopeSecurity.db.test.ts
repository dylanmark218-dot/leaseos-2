/**
 * Fleet/Unit Security CP1.5 — every mutation that names a unit refuses another organization's unit
 * exactly as it refuses a unit that does not exist, and writes nothing when it does.
 *
 * The unit-scope sweep (docs/register/UNIT_SCOPE_SWEEP_2026-09-25.md) found router mutations that
 * wrote the request's unit id unchecked. `roleProcedure` checks a role, never a tenant, so a caller in
 * organization B holding the right role could name organization A's truck: open a roadside event and
 * a defect on it, confirm an out-of-service inspection that files a defect and a work order into A's
 * shop, capture an incident that moves to A, assign it to B's job, reset its radio fit.
 *
 * Each case below calls the real procedure, through the real router, as a member of B who holds the
 * procedure's permission, three ways:
 *
 *   - with A's unit            → NOT_FOUND "Unit <id> not found", nothing written that names the unit;
 *   - with an id that exists nowhere → the identical refusal (code and message, id aside);
 *   - the authorization decision row the two calls leave is identical too: it records the role check,
 *     never the unit, so the log cannot tell B which of the two ids was real.
 *
 * Written RED against the unfixed routers (see docs/register/UNIT_SCOPE_SECURITY_CP1_5.md for the
 * red run), then fixed through the one seam, `server/unitScope.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const URL = process.env.DATABASE_URL;

describe("unit scope security — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped tenant-boundary suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 215_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
type Caller = ReturnType<typeof appRouter.createCaller>;
const caller = (userId: number): Caller => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?, ?, 'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}
async function person(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?, ?, ?, 'employee', 'active', '2020-01-01', 1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?, ?, 'global', 1, NOW())", [userId, role]);
  return userId;
}
async function unit(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
async function job(orgRef: string | null) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, orgRef) VALUES (?, 'water_haul', 'transport', 'Cust', 'LSD', 'dispatched', 0, ?)", [`J-${rnd()}${rnd()}`.slice(0, 40), orgRef]);
  return Number(j.insertId);
}
/** An id no unit, job or anything else has: far above anything a test database reaches. */
const missing = () => 1_900_000_000 + Math.floor(Math.random() * 90_000_000);
const count = async (sql: string, params: unknown[]) => Number((await pool.execute<mysql.RowDataPacket[]>(sql, params as never))[0][0].n);
const rowsNaming = (table: string, column: string) => (id: number) => count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [id]);

/** What the caller learns from a refusal, with the id taken out. */
async function refusal(p: Promise<unknown>, id: number) {
  const e = await p.then(() => null, (x: unknown) => x as { code?: string; message?: string });
  expect(e, "expected the call to be refused").not.toBeNull();
  return { code: e!.code, message: String(e!.message).split(String(id)).join("<id>") };
}
/** The access-log row a call left: everything but its id and time. */
async function lastDecision(userId: number, procedureName: string) {
  const [r] = await pool.execute<mysql.RowDataPacket[]>("SELECT procedureName, permission, rolesHeld, outcome, subjectType, subjectId, detail FROM authorizationDecisions WHERE actorUserId = ? AND procedureName = ? ORDER BY id DESC LIMIT 1", [userId, procedureName]);
  return r[0] ?? null;
}

type Fixture = { A: string; B: string; unitA: number; jobB: number };
type Case = {
  name: string;
  procedure: string;
  role: string;
  label?: "Unit" | "Trailer";
  call: (c: Caller, unitId: number, f: Fixture) => Promise<unknown>;
  /** Rows, anywhere the procedure writes, that name this unit. */
  writes: (unitId: number) => Promise<number>;
};
const sum = (...fs: ((id: number) => Promise<number>)[]) => async (id: number) => (await Promise.all(fs.map(f => f(id)))).reduce((a, b) => a + b, 0);
const AT = new Date(Date.now() - 3_600_000);

const CASES: Case[] = [
  { name: "#16 roadside.open", procedure: "roadside.open", role: "driver",
    call: (c, u) => c.roadside.open({ eventType: "flat_tire", unitId: u, occurredAt: AT }),
    writes: sum(rowsNaming("roadsideServiceEvents", "unitId"), rowsNaming("maintenanceDefects", "unitId")) },
  { name: "#8 enforcement.eventConfirm (unit)", procedure: "enforcement.eventConfirm", role: "safety",
    call: (c, u) => c.enforcement.eventConfirm({ eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: "CVSE", occurredAt: AT, inspectionResult: "out_of_service", unitId: u, subjectRefs: { vehicle: `V-${rnd()}` },
      violations: [{ system: "brakes", ownCode: "BRK-ADJ", outOfService: true, oosScope: "vehicle", defectRequired: true, repairRequired: true }] }),
    writes: sum(rowsNaming("enforcementEvents", "unitId"), rowsNaming("maintenanceDefects", "unitId"), rowsNaming("workOrders", "unitId"), rowsNaming("domainEventOutbox", "unitId")) },
  { name: "#8 enforcement.eventConfirm (trailer)", procedure: "enforcement.eventConfirm", role: "safety", label: "Trailer",
    call: (c, u) => c.enforcement.eventConfirm({ eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: "CVSE", occurredAt: AT, inspectionResult: "out_of_service", trailerId: u, subjectRefs: { trailer: `T-${rnd()}` },
      violations: [{ system: "lights", ownCode: "LGT", outOfService: true, oosScope: "trailer" }] }),
    writes: rowsNaming("enforcementEvents", "trailerId") },
  { name: "#19 records.incident.capture", procedure: "records.incident.capture", role: "driver",
    call: (c, u) => c.records.incident.capture({ incidentNumber: `INC-${rnd()}${rnd()}`, incidentType: "collision", originalStatement: "Backed into a post at the lease.", occurredAt: AT, unitId: u, vehicleDamage: true }),
    writes: sum(rowsNaming("incidentReports", "unitId"), rowsNaming("unitHolds", "unitId")) },
  { name: "#1 asset.register (unit)", procedure: "asset.register", role: "bookkeeper",
    call: (c, u) => c.asset.register({ financialEntityId: 1, kind: "unit", unitId: u, description: "Truck", acquiredAt: AT, acquisitionCostCents: 100_00 }),
    writes: rowsNaming("capitalAssets", "unitId") },
  { name: "#1 asset.register (trailer)", procedure: "asset.register", role: "bookkeeper", label: "Trailer",
    call: (c, u) => c.asset.register({ financialEntityId: 1, kind: "trailer", trailerId: u, description: "Trailer", acquiredAt: AT, acquisitionCostCents: 100_00 }),
    writes: rowsNaming("capitalAssets", "trailerId") },
  { name: "#2 closeout.delayRecord", procedure: "closeout.delayRecord", role: "dispatcher",
    call: (c, u) => c.closeout.delayRecord({ unitId: u, kind: "weather", observedAt: AT, observation: "Whiteout on the lease road" }),
    writes: rowsNaming("delayEvents", "unitId") },
  { name: "#3 commercialSetup.definitionPropose", procedure: "commercialSetup.definitionPropose", role: "dispatcher",
    call: (c, u) => c.commercialSetup.definitionPropose({ financialEntityId: 1, rateKind: "sell", serviceCode: "HAUL", unitId: u, pricingMethod: "flat", unit: "load", flatCents: 100, scopeLevel: "company", effectiveFrom: AT, sourceKind: "human" }),
    writes: rowsNaming("chargeDefinitions", "unitId") },
  { name: "#4 comms.unitCapabilitySet", procedure: "comms.unitCapabilitySet", role: "shop_lead",
    call: (c, u) => c.comms.unitCapabilitySet({ unitId: u, vhf: true }),
    writes: rowsNaming("unitRadioCapabilities", "unitId") },
  { name: "#5 comms.planForPath", procedure: "comms.planForPath", role: "dispatcher",
    call: (c, u) => c.comms.planForPath({ segments: [{ segmentId: `S-${rnd()}`, lengthKm: 1 }], unitId: u }),
    writes: rowsNaming("communicationPlans", "unitId") },
  { name: "#6 comms.packageBuild", procedure: "comms.packageBuild", role: "dispatcher",
    call: (c, u) => c.comms.packageBuild({ label: "Package", segments: [{ segmentId: `S-${rnd()}`, lengthKm: 1 }], unitId: u }),
    writes: rowsNaming("communicationPackages", "unitId") },
  { name: "(new) comms.authorizationRecord", procedure: "comms.authorizationRecord", role: "management",
    call: (c, u) => c.comms.authorizationRecord({ channelKey: `CH-${rnd()}`, authorized: true, approvedUnitIds: [u] }),
    writes: (u: number) => count("SELECT COUNT(*) AS n FROM companyRadioAuthorizations WHERE JSON_CONTAINS(approvedUnitIdsJson, ?)", [String(u)]) },
  { name: "#9 enforcement.panelGrantIssue", procedure: "enforcement.panelGrantIssue", role: "dispatcher",
    call: (c, u) => c.enforcement.panelGrantIssue({ unitRef: `U-${rnd()}`, unitId: u, issuedFor: "CVSE officer" }),
    writes: rowsNaming("roadsidePanelGrants", "unitId") },
  { name: "#10 fuel.dispenseRecord", procedure: "fuel.dispenseRecord", role: "mechanic",
    call: (c, u) => c.fuel.dispenseRecord({ tankRef: `TANK-${rnd()}`, unitId: u, litres: 10, quantitySource: "stated", occurredAt: AT }),
    writes: sum(rowsNaming("fuelTransactions", "unitId"), rowsNaming("bulkFuelDispenses", "unitId")) },
  { name: "#11 geo.accessConfirmPassage", procedure: "geo.accessConfirmPassage", role: "dispatcher",
    call: (c, u) => c.geo.accessConfirmPassage({ accessRef: `ACC-${rnd()}`, outcome: "reached", unitId: u }),
    writes: rowsNaming("siteAccessConfirmations", "unitId") },
  { name: "#12 ifta.distanceRecord", procedure: "ifta.distanceRecord", role: "dispatcher",
    call: (c, u) => c.ifta.distanceRecord({ financialEntityId: 1, unitId: u, jurisdiction: "CA-AB", distanceKm: 10, periodStart: new Date(AT.getTime() - 86_400_000), periodEnd: AT, source: "operator_stated" }),
    writes: rowsNaming("jurisdictionDistanceRecords", "unitId") },
  { name: "#13 insurance.claimOpen", procedure: "insurance.claimOpen", role: "safety",
    call: (c, u) => c.insurance.claimOpen({ policyRef: `POL-${rnd()}`, unitId: u, lossOccurredAt: AT, claimType: "collision" }),
    writes: rowsNaming("insuranceClaims", "unitId") },
  { name: "#14 payroll.submitTime", procedure: "payroll.submitTime", role: "driver",
    call: (c, u) => c.payroll.submitTime({ activity: "driving", startedAt: AT, unitId: u }),
    writes: rowsNaming("payrollTimeEntries", "unitId") },
  { name: "#15 finance.expenseCreate", procedure: "finance.expenseCreate", role: "driver",
    call: (c, u) => c.finance.expenseCreate({ expenseRef: `EXP-${rnd()}`, financialEntityId: 1, total: 10, transactionDate: AT, unitId: u }),
    writes: sum(rowsNaming("expenseRecords", "unitId"), rowsNaming("expenseAllocations", "unitId")) },
  { name: "#17 purchasing.request", procedure: "purchasing.request", role: "driver",
    call: (c, u) => c.purchasing.request({ financialEntityId: 1, unitId: u, category: "parts", reason: "Air line", estimatedAmount: 10 }),
    writes: rowsNaming("purchaseAuthorizations", "unitId") },
  { name: "#18 vendor.billRecord", procedure: "vendor.billRecord", role: "office",
    call: (c, u) => c.vendor.billRecord({ financialEntityId: 1, vendorId: 1, vendorInvoiceNumber: `INV-${rnd()}`, invoiceDate: AT, subtotal: 1, total: 1, unitId: u,
      lines: [{ lineNo: 1, lineType: "part", description: "Glad hand", quantity: 1, unitPrice: 1, amount: 1 }] }),
    writes: rowsNaming("vendorBills", "unitId") },
  { name: "#21 assistant.draft", procedure: "assistant.draft", role: "driver",
    call: (c, u) => c.fieldRoute.assistant.draft({ formKey: "pre_trip", targetRef: "Unit", transcript: "Walk-around done", unitId: u }),
    writes: rowsNaming("assistantProposals", "unitId") },
  { name: "#22 jobUnits.create", procedure: "jobUnits.create", role: "dispatcher",
    call: (c, u, f) => c.fieldRoute.identity.jobUnits.create({ jobId: f.jobB, unitId: u, role: "vac truck", joinedAt: AT }),
    writes: rowsNaming("jobUnits", "unitId") },
  { name: "(new) contractorOperations.crewAssign", procedure: "contractorOperations.crewAssign", role: "dispatcher",
    call: (c, u) => c.contractorOperations.crewAssign({ chainRef: `CHAIN-${rnd()}`, unitId: u, primaryDriverWorkerRef: `W-${rnd()}`, startsAt: AT }),
    writes: rowsNaming("jobCrewAssignments", "unitId") },
  { name: "(new) integration.loadSenseBindGateway", procedure: "integration.loadSenseBindGateway", role: "management",
    call: (c, u) => c.integration.loadSenseBindGateway({ gatewayDeviceRef: `GW-${rnd()}`, measurementDeviceId: 1, unitId: u, tareKg: 0 }),
    writes: rowsNaming("loadSenseGatewayBindings", "unitId") },
];

d("another organization's unit is indistinguishable from a unit that does not exist, and nothing is written", () => {
  let f: Fixture;
  beforeAll(async () => {
    const A = await org(), B = await org();
    f = { A, B, unitA: await unit(A), jobB: await job(B) };
  });

  it.each(CASES.map(c => [c.name, c] as const))("%s", async (_name, c) => {
    const userB = await person(f.B, [c.role]);
    const label = c.label ?? "Unit";
    const ghost = missing();

    const before = await c.writes(f.unitA);
    const foreign = await refusal(c.call(caller(userB), f.unitA, f), f.unitA);
    const foreignDecision = await lastDecision(userB, c.procedure);
    const absent = await refusal(c.call(caller(userB), ghost, f), ghost);
    const absentDecision = await lastDecision(userB, c.procedure);

    expect(foreign, `${c.procedure} must refuse another organization's unit as not found`).toEqual({ code: "NOT_FOUND", message: `${label} <id> not found` });
    expect(absent, `${c.procedure} must refuse a missing unit in the same words`).toEqual(foreign);
    expect(await c.writes(f.unitA), `${c.procedure} wrote a row naming another organization's unit`).toBe(before);
    expect(await c.writes(ghost)).toBe(0);
    // The access log records the role decision, and it is the same for both calls.
    expect(foreignDecision).not.toBeNull();
    expect(absentDecision).toEqual(foreignDecision);
  });

  it("a caller holding every role that reaches these procedures is refused the same way: permissions never grant another organization's unit", async () => {
    const everything = await person(f.B, ["management", "safety", "shop_lead", "dispatcher", "office", "driver", "mechanic", "bookkeeper", "controller"]);
    for (const c of CASES) {
      const r = await refusal(c.call(caller(everything), f.unitA, f), f.unitA);
      expect(r, c.procedure).toEqual({ code: "NOT_FOUND", message: `${c.label ?? "Unit"} <id> not found` });
    }
  });
});

d("the ids that carry a unit indirectly are scoped too", () => {
  it("closeout.delayRecord: another organization's field ticket (which names its unit) is not found, like a missing ticket", async () => {
    const A = await org(), B = await org();
    const unitA = await unit(A);
    const ticketNumber = `FT-${rnd()}${rnd()}`;
    await pool.execute("INSERT INTO fieldTickets (ticketNumber, jobId, unitId) VALUES (?, ?, ?)", [ticketNumber, await job(A), unitA]);
    const userB = await person(B, ["dispatcher"]);
    const before = await rowsNaming("delayEvents", "unitId")(unitA);
    const ghostTicket = `FT-${rnd()}${rnd()}`;
    const across = await caller(userB).closeout.delayRecord({ ticketNumber, kind: "weather", observedAt: AT, observation: "Whiteout on the lease road" }).catch((e: { code: string; message: string }) => e);
    const nowhere = await caller(userB).closeout.delayRecord({ ticketNumber: ghostTicket, kind: "weather", observedAt: AT, observation: "Whiteout on the lease road" }).catch((e: { code: string; message: string }) => e);
    expect(across).toMatchObject({ code: "NOT_FOUND", message: `Ticket ${ticketNumber} not found` });
    expect(nowhere).toMatchObject({ code: "NOT_FOUND", message: `Ticket ${ghostTicket} not found` });
    expect(await rowsNaming("delayEvents", "unitId")(unitA)).toBe(before);
  });

  it("an incident or a near miss on the caller's own unit may not name another organization's job — the incident's organization comes from its job", async () => {
    const A = await org(), B = await org();
    const jobA = await job(A), unitB = await unit(B);
    const userB = await person(B, ["driver"]);
    const incidentNumber = `INC-${rnd()}${rnd()}`;
    const across = await refusal(caller(userB).records.incident.capture({ incidentNumber, incidentType: "collision", originalStatement: "Hit a gate", occurredAt: AT, unitId: unitB, jobId: jobA, vehicleDamage: true }), jobA);
    const ghost = missing();
    const nowhere = await refusal(caller(userB).records.incident.capture({ incidentNumber: `INC-${rnd()}${rnd()}`, incidentType: "collision", originalStatement: "Hit a gate", occurredAt: AT, unitId: unitB, jobId: ghost, vehicleDamage: true }), ghost);
    expect(across).toEqual({ code: "NOT_FOUND", message: "Job <id> not found" });
    expect(nowhere).toEqual(across);
    expect(await count("SELECT COUNT(*) AS n FROM incidentReports WHERE incidentNumber = ?", [incidentNumber])).toBe(0);
    expect(await rowsNaming("unitHolds", "unitId")(unitB)).toBe(0);

    const nearMissNumber = `NM-${rnd()}${rnd()}`;
    const nm = await refusal(caller(userB).records.nearMiss.report({ nearMissNumber, statement: "Nearly backed over a spotter", anyoneInjured: true, workStopped: true, occurredAt: AT, unitId: unitB, jobId: jobA }), jobA);
    expect(nm).toEqual({ code: "NOT_FOUND", message: "Job <id> not found" });
    expect(await count("SELECT COUNT(*) AS n FROM nearMissReports WHERE nearMissNumber = ?", [nearMissNumber])).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM incidentReports WHERE incidentNumber = ?", [`INC-${nearMissNumber}`])).toBe(0);
  });
});

d("the historical single tenant is its own scope, stated rather than inferred", () => {
  it("a user with no membership may use an unowned unit, and is refused an owned one exactly as a missing one; a member is refused an unowned one", async () => {
    const A = await org();
    const legacyUnit = await unit(null), ownedUnit = await unit(A);
    const legacyDriver = await person(null, ["driver"]);
    const memberDriver = await person(A, ["driver"]);

    // The historical tenant's own (unowned) unit: served.
    const own = await caller(legacyDriver).roadside.open({ eventType: "flat_tire", unitId: legacyUnit, occurredAt: AT });
    expect(own.eventRef).toMatch(/^RS/);

    // An organization's unit is another tenant's to the historical one.
    const ghost = missing();
    const owned = await refusal(caller(legacyDriver).roadside.open({ eventType: "flat_tire", unitId: ownedUnit, occurredAt: AT }), ownedUnit);
    const nowhere = await refusal(caller(legacyDriver).roadside.open({ eventType: "flat_tire", unitId: ghost, occurredAt: AT }), ghost);
    expect(owned).toEqual({ code: "NOT_FOUND", message: "Unit <id> not found" });
    expect(nowhere).toEqual(owned);
    expect(await rowsNaming("roadsideServiceEvents", "unitId")(ownedUnit)).toBe(0);

    // And the historical tenant's unit is another tenant's to a member.
    const unowned = await refusal(caller(memberDriver).roadside.open({ eventType: "flat_tire", unitId: legacyUnit, occurredAt: AT }), legacyUnit);
    expect(unowned).toEqual({ code: "NOT_FOUND", message: "Unit <id> not found" });
    expect(await rowsNaming("roadsideServiceEvents", "unitId")(legacyUnit)).toBe(1);
  });
});

d("the organization's own unit is still served", () => {
  let A: string, unitA: number;
  beforeAll(async () => { A = await org(); unitA = await unit(A); });

  it("roadside.open writes the event and the defect on the caller's own unit", async () => {
    const r = await caller(await person(A, ["driver"])).roadside.open({ eventType: "brake_issue", unitId: unitA, occurredAt: AT, vehicleMovable: "no" });
    expect(r.eventRef).toMatch(/^RS/);
    expect(await rowsNaming("roadsideServiceEvents", "unitId")(unitA)).toBeGreaterThan(0);
  });
  it("enforcement.eventConfirm files its defect and work order against the caller's own unit", async () => {
    const before = await rowsNaming("workOrders", "unitId")(unitA);
    await caller(await person(A, ["safety"])).enforcement.eventConfirm({ eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: "CVSE", occurredAt: AT, inspectionResult: "out_of_service", unitId: unitA, subjectRefs: { vehicle: `V-${rnd()}` },
      violations: [{ system: "brakes", ownCode: "BRK-ADJ", outOfService: true, oosScope: "vehicle", defectRequired: true, repairRequired: true }] });
    expect(await rowsNaming("workOrders", "unitId")(unitA)).toBe(before + 1);
  });
  it("comms.unitCapabilitySet, planForPath, packageBuild and panelGrantIssue serve the caller's own unit", async () => {
    await caller(await person(A, ["shop_lead"])).comms.unitCapabilitySet({ unitId: unitA, vhf: true });
    const dispatcher = caller(await person(A, ["dispatcher"]));
    await dispatcher.comms.planForPath({ segments: [{ segmentId: `S-${rnd()}`, lengthKm: 1 }], unitId: unitA });
    await dispatcher.comms.packageBuild({ label: "Package", segments: [{ segmentId: `S-${rnd()}`, lengthKm: 1 }], unitId: unitA });
    await dispatcher.enforcement.panelGrantIssue({ unitRef: `U-${rnd()}`, unitId: unitA, issuedFor: "CVSE officer" });
    expect(await rowsNaming("unitRadioCapabilities", "unitId")(unitA)).toBe(1);
    expect(await rowsNaming("communicationPlans", "unitId")(unitA)).toBe(1);
    expect(await rowsNaming("communicationPackages", "unitId")(unitA)).toBe(1);
    expect(await rowsNaming("roadsidePanelGrants", "unitId")(unitA)).toBe(1);
  });
  it("closeout.delayRecord and jobUnits.create serve the caller's own unit and job", async () => {
    const dispatcher = caller(await person(A, ["dispatcher"]));
    await dispatcher.closeout.delayRecord({ unitId: unitA, kind: "weather", observedAt: AT, observation: "Whiteout on the lease road" });
    expect(await rowsNaming("delayEvents", "unitId")(unitA)).toBe(1);
    const id = await dispatcher.fieldRoute.identity.jobUnits.create({ jobId: await job(A), unitId: unitA, role: "vac truck", joinedAt: AT });
    expect(Number(id)).toBeGreaterThan(0);
  });
  it("incident capture and a near miss that escalates serve the caller's own unit and job", async () => {
    const driver = caller(await person(A, ["driver"]));
    const jobA = await job(A);
    const r = await driver.records.incident.capture({ incidentNumber: `INC-${rnd()}${rnd()}`, incidentType: "near_miss", originalStatement: "Spotter stepped back in time", occurredAt: AT, unitId: unitA, jobId: jobA });
    expect(r.incidentId).toBeGreaterThan(0);
    const nm = await driver.records.nearMiss.report({ nearMissNumber: `NM-${rnd()}${rnd()}`, statement: "Pinched a finger in the hatch", anyoneInjured: true, workStopped: false, occurredAt: AT, unitId: unitA, jobId: jobA });
    expect(nm.escalated).toBe(true);
  });
});
