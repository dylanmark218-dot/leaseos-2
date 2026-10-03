/**
 * Fleet & Equipment Portfolio — asset core, against a real database, through the real router, the real
 * readiness composer and the real triggers (docs/fleet/FLEET_ASSET_CORE_CHECKPOINT.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { composeReadiness } from "./readinessComposer";

const URL = process.env.DATABASE_URL;
describe("fleet asset core — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped portfolio suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 201_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?, ?, 'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}
async function person(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?, ?, ?, 'employee', 'active', '2020-01-01', 1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?, ?, 'global', 1, NOW())", [userId, role]);
  return userId;
}
/** A unit as the legacy create left it: no class, no lifecycle change. */
async function legacyUnit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
async function dispatchSubject(orgRef: string) {
  const driverUser = await person(orgRef, ["driver"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, orgRef) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0, ?)", [`JOB-${rnd()}`, orgRef]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, op.insertId]);
  return { operatorId: Number(op.insertId), jobId: Number(j.insertId), driverUser };
}
const codes = async (s: { operatorId: number; jobId: number }, unitId: number, trailerId: number | null = null) => {
  const r = await composeReadiness({ operatorId: s.operatorId, unitId, trailerId, jobId: s.jobId });
  return { r, by: (re: RegExp) => r.eligibility.blockers.filter(b => re.test(b.code)) as (typeof r.eligibility.blockers[number] & { overrideClass?: string })[] };
};

let A = "", B = "";
let shopLead = 0, management = 0, mechanic = 0, dispatcher = 0, driver = 0, office = 0, safety = 0, leadB = 0;
beforeAll(async () => {
  if (!URL) return;
  A = await org(); B = await org();
  shopLead = await person(A, ["shop_lead"]); management = await person(A, ["management"]); mechanic = await person(A, ["mechanic"]);
  dispatcher = await person(A, ["dispatcher"]); driver = await person(A, ["driver"]); office = await person(A, ["office"]); safety = await person(A, ["safety"]);
  leadB = await person(B, ["shop_lead", "management"]);
});

d("identity", () => {
  it("creates a unit with its class derived from the type, the legacy vehicle type derived too, an ownership row and a first event; a taken number is a conflict", async () => {
    const n = `HV-${rnd()}`;
    const c = await caller(shopLead).fleet.assetCreate({ unitNumber: n, assetType: "hydrovac", make: "Kenworth", model: "T880", modelYear: 2021, vin: `1XKZD${rnd()}`, ownershipType: "owned", homeTerminal: "Red Deer" });
    const g = await caller(dispatcher).fleet.get({ unitId: c.unitId });
    expect(g.identity).toMatchObject({ unitNumber: n, assetClass: "power_unit", assetType: "hydrovac", vehicleType: "hydrovac", make: "Kenworth", modelYear: 2021 });
    expect(g.lifecycle).toMatchObject({ status: "active", changedAt: null });
    expect(g.state.status).toBe("available");
    const [[own]] = await pool.execute<mysql.RowDataPacket[]>("SELECT orgRef FROM coreRecordOwnership WHERE recordType='unit' AND recordId=?", [c.unitId]) as unknown as [[{ orgRef: string }]];
    expect(own.orgRef).toBe(A);
    const ev = (await caller(dispatcher).fleet.history({ unitId: c.unitId })).events;
    expect(ev.map(e => [e.eventType, e.actorUserId])).toEqual([["asset_created", shopLead]]);
    await expect(caller(shopLead).fleet.assetCreate({ unitNumber: n, assetType: "tanker" })).rejects.toMatchObject({ code: "CONFLICT" });
    // The driver and the dispatcher are refused at the permission.
    await expect(caller(driver).fleet.assetCreate({ unitNumber: `X-${rnd()}`, assetType: "pump" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(dispatcher).fleet.assetCreate({ unitNumber: `X-${rnd()}`, assetType: "pump" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an edit names every field that changed; changing the type re-derives the class; a no-op changes nothing", async () => {
    const c = await caller(office).fleet.assetCreate({ unitNumber: `T-${rnd()}`, assetType: "tanker" });
    const r = await caller(office).fleet.assetUpdate({ unitId: c.unitId, plate: "ABC 123", plateJurisdiction: "AB", assetType: "pup" });
    expect(r.changed.sort()).toEqual(["assetType", "plate", "plateJurisdiction"]);
    expect(r.identity).toMatchObject({ assetClass: "trailer", assetType: "pup", vehicleType: "pup", plate: "ABC 123" });
    expect((await caller(office).fleet.assetUpdate({ unitId: c.unitId, plate: "ABC 123" })).changed).toEqual([]);
    // Lifecycle and holds are not identity: the schema refuses them here.
    await expect(caller(office).fleet.assetUpdate({ unitId: c.unitId, lifecycleStatus: "retired" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ev = (await caller(dispatcher).fleet.history({ unitId: c.unitId })).events.map(e => e.eventType);
    expect(ev).toEqual(["asset_edited", "asset_created"]);
  });

  it("a legacy unit reads unclassified, and is not promoted to a truck", async () => {
    const unitId = await legacyUnit(A);
    const g = await caller(dispatcher).fleet.get({ unitId });
    expect(g.identity).toMatchObject({ assetClass: null, assetType: null, vehicleType: "hydrovac" });
    expect(g.lifecycle.status).toBe("active");
  });
});

d("lifecycle", () => {
  it("storage holds the unit and blocks dispatch under an approved policy; retirement is out of the fleet and overridable by no one; only management returns it", async () => {
    const c = await caller(shopLead).fleet.assetCreate({ unitNumber: `S-${rnd()}`, assetType: "vac_truck" });
    const s = await dispatchSubject(A);
    await expect(caller(driver).fleet.lifecycleSet({ unitId: c.unitId, to: "seasonal_storage", reason: "winter" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(dispatcher).fleet.lifecycleSet({ unitId: c.unitId, to: "seasonal_storage", reason: "winter" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const st = await caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "seasonal_storage", reason: "Parked for the winter at the yard" });
    expect(st).toMatchObject({ lifecycle: { status: "seasonal_storage", changedByUserId: shopLead }, status: "maintenance_hold" });
    expect(st.driverNotice).toMatch(/do not operate/);
    let f = await codes(s, c.unitId);
    expect(f.by(/^unit_in_storage$/)).toEqual([expect.objectContaining({ severity: "blocking", overrideClass: "APPROVED_POLICY_ONLY" })]);
    const before = f.r.fingerprint;

    await expect(caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "active", reason: "Spring", expectedFrom: "active" })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "active", reason: "Spring start-up", expectedFrom: "seasonal_storage" });
    f = await codes(s, c.unitId);
    expect(f.by(/^unit_in_storage$/)).toEqual([]);
    expect(f.r.fingerprint).not.toBe(before);

    await caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "retired", reason: "Frame cracked beyond economic repair" });
    f = await codes(s, c.unitId);
    expect(f.by(/^unit_retired$/)).toEqual([expect.objectContaining({ severity: "blocking", overridable: false, overrideClass: "NEVER_OVERRIDABLE" })]);
    expect((await caller(dispatcher).fleet.get({ unitId: c.unitId })).state.status).toBe("out_of_service");
    await expect(caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "active", reason: "changed my mind" })).rejects.toThrow(/only by management/);
    await expect(caller(management).fleet.lifecycleSet({ unitId: c.unitId, to: "transferred", reason: "sold to our sister company" })).rejects.toThrow(/O-4/);
    await caller(management).fleet.lifecycleSet({ unitId: c.unitId, to: "active", reason: "Frame repaired and certified; returned to the fleet" });
    const ev = (await caller(dispatcher).fleet.history({ unitId: c.unitId })).events.filter(e => e.eventType === "lifecycle_changed").map(e => [e.previousState, e.newState, e.actorUserId]);
    expect(ev).toEqual([["retired", "active", management], ["active", "retired", shopLead], ["seasonal_storage", "active", shopLead], ["active", "seasonal_storage", shopLead]]);
    // The database refuses a lifecycle change with no actor behind it.
    await expect(pool.execute("UPDATE units SET lifecycleStatus = 'sold' WHERE id = ?", [c.unitId])).rejects.toThrow(/records who, when and why/);
    // A retired unit is left out of the fleet list unless asked for.
    await caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "retired", reason: "Retired again for the list test" });
    expect((await caller(dispatcher).fleet.list({})).units.some(u => u.unitId === c.unitId)).toBe(false);
    expect((await caller(dispatcher).fleet.list({ lifecycle: "retired" })).units.some(u => u.unitId === c.unitId)).toBe(true);
  });

  it("two people changing the lifecycle at once: one wins, the other learns the unit moved", async () => {
    const c = await caller(shopLead).fleet.assetCreate({ unitNumber: `R-${rnd()}`, assetType: "picker" });
    const results = await Promise.allSettled([
      caller(shopLead).fleet.lifecycleSet({ unitId: c.unitId, to: "seasonal_storage", reason: "Parked, first writer" }),
      caller(management).fleet.lifecycleSet({ unitId: c.unitId, to: "retired", reason: "Retired, second writer" }),
    ]);
    const ok = results.filter(r => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toMatchObject({ code: "CONFLICT" });
    const ev = (await caller(dispatcher).fleet.history({ unitId: c.unitId })).events.filter(e => e.eventType === "lifecycle_changed");
    expect(ev).toHaveLength(1);
  });
});

d("components", () => {
  it("a mounted system with a critical defect holds the truck until it is detached; the relation stays as history and cannot be rewritten", async () => {
    const truck = await caller(shopLead).fleet.assetCreate({ unitNumber: `C-${rnd()}`, assetType: "vac_truck" });
    const vac = await caller(shopLead).fleet.assetCreate({ unitNumber: `V-${rnd()}`, assetType: "vacuum_system", serialNumber: `SN-${rnd()}` });
    const s = await dispatchSubject(A);
    await expect(caller(driver).fleet.componentAttach({ parentUnitId: truck.unitId, childUnitId: vac.unitId, relationship: "mounted" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const att = await caller(mechanic).fleet.componentAttach({ parentUnitId: truck.unitId, childUnitId: vac.unitId, relationship: "mounted", removable: false });
    expect(att.componentRef).toMatch(/^CMP-/);
    await expect(caller(mechanic).fleet.componentAttach({ parentUnitId: truck.unitId, childUnitId: vac.unitId, relationship: "mounted" })).rejects.toThrow(/attached elsewhere/);
    await expect(caller(mechanic).fleet.componentAttach({ parentUnitId: vac.unitId, childUnitId: truck.unitId, relationship: "attached" })).rejects.toThrow(/dispatched beside|components of its own/);

    const defectId = Number(await caller(mechanic).fieldRoute.compliance.maintenance.create({ unitId: vac.unitId, title: "Blower bearing seized", severity: "critical", reportedAt: new Date() }));
    let f = await codes(s, truck.unitId);
    expect(f.by(/^component_critical_defect:/)).toEqual([expect.objectContaining({ code: `component_critical_defect:${vac.unitId}`, severity: "blocking", overridable: false, overrideClass: "NEVER_OVERRIDABLE" })]);
    const g = await caller(dispatcher).fleet.get({ unitId: truck.unitId });
    expect(g.state.status).toBe("maintenance_hold");
    expect(g.components).toEqual([expect.objectContaining({ componentRef: att.componentRef, direction: "attached", otherUnitId: vac.unitId, criticalDefectOpen: true, removedAt: null })]);
    expect((await caller(dispatcher).fleet.get({ unitId: vac.unitId })).components).toEqual([expect.objectContaining({ componentRef: att.componentRef, direction: "attached_to", otherUnitId: truck.unitId })]);

    await caller(mechanic).fleet.componentDetach({ componentRef: att.componentRef, reason: "Vac system pulled for a bearing rebuild" });
    f = await codes(s, truck.unitId);
    expect(f.by(/^component_/)).toEqual([]);
    expect((await caller(dispatcher).fleet.get({ unitId: truck.unitId })).state.status).toBe("available");
    await expect(caller(mechanic).fleet.componentDetach({ componentRef: att.componentRef, reason: "again" })).rejects.toThrow(/already detached/);
    const hist = (await caller(dispatcher).fleet.components({ unitId: truck.unitId, includeHistory: true })).components;
    expect(hist).toEqual([expect.objectContaining({ componentRef: att.componentRef, removedAt: expect.any(Date), removalReason: "Vac system pulled for a bearing rebuild" })]);
    await expect(pool.execute("UPDATE unitComponents SET parentUnitId = ? WHERE componentRef = ?", [vac.unitId, att.componentRef])).rejects.toThrow(/never edited/);
    await expect(pool.execute("DELETE FROM unitComponents WHERE componentRef = ?", [att.componentRef])).rejects.toThrow(/never deleted/);
    expect(defectId).toBeGreaterThan(0);
  });

  it("two attachments of one component racing: one lands", async () => {
    const t1 = await caller(shopLead).fleet.assetCreate({ unitNumber: `C1-${rnd()}`, assetType: "truck" });
    const t2 = await caller(shopLead).fleet.assetCreate({ unitNumber: `C2-${rnd()}`, assetType: "truck" });
    const pump = await caller(shopLead).fleet.assetCreate({ unitNumber: `P-${rnd()}`, assetType: "hydraulic_pump" });
    const results = await Promise.allSettled([
      caller(mechanic).fleet.componentAttach({ parentUnitId: t1.unitId, childUnitId: pump.unitId, relationship: "installed" }),
      caller(mechanic).fleet.componentAttach({ parentUnitId: t2.unitId, childUnitId: pump.unitId, relationship: "installed" }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const [[{ n }]] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM unitComponents WHERE childUnitId = ? AND removedAt IS NULL", [pump.unitId]) as unknown as [[{ n: number }]];
    expect(Number(n)).toBe(1);
  });
});

d("class on the slot", () => {
  it("a truck bound as the trailer is a class mismatch nobody overrides; an unclassified unit is not guessed", async () => {
    const truck = await caller(shopLead).fleet.assetCreate({ unitNumber: `K-${rnd()}`, assetType: "truck" });
    const truck2 = await caller(shopLead).fleet.assetCreate({ unitNumber: `K2-${rnd()}`, assetType: "tractor" });
    const trailer = await caller(shopLead).fleet.assetCreate({ unitNumber: `TR-${rnd()}`, assetType: "tanker" });
    const legacy = await legacyUnit(A);
    const s = await dispatchSubject(A);
    expect((await codes(s, truck.unitId, truck2.unitId)).by(/_class_mismatch$/)).toEqual([expect.objectContaining({ code: "trailer_class_mismatch", subject: "trailer", overrideClass: "NEVER_OVERRIDABLE" })]);
    expect((await codes(s, trailer.unitId, truck.unitId)).by(/_class_mismatch$/).map(b => b.code).sort()).toEqual(["trailer_class_mismatch", "unit_class_mismatch"]);
    expect((await codes(s, truck.unitId, trailer.unitId)).by(/_class_mismatch$/)).toEqual([]);
    expect((await codes(s, legacy, trailer.unitId)).by(/_class_mismatch$/)).toEqual([]);
  });
});

d("the unit side of readiness, and the list", () => {
  it("answers why a unit cannot leave with no driver named, through the one classification, and says what it did not evaluate", async () => {
    const c = await caller(shopLead).fleet.assetCreate({ unitNumber: `W-${rnd()}`, assetType: "hydrovac" });
    const r0 = await caller(dispatcher).fleet.unitReadiness({ unitId: c.unitId });
    expect(r0.scope).toBe("unit_side");
    expect(r0.notEvaluated.map(n => n.axis)).toEqual(["operator", "job", "route"]);
    // Documents and insurance are read here as the composer reads them: a fresh unit has none.
    expect(r0.findings.map(f => f.code).sort()).toEqual(["insurance_coverage_unknown", "truck_inspection_missing", "truck_registration_missing"]);
    expect(r0.verdict).toBe("blocked");
    await caller(safety).fleet.holdPlace({ unitId: c.unitId, holdType: "safety", reason: "Cracked steering arm found at pre-trip" });
    const r1 = await caller(dispatcher).fleet.unitReadiness({ unitId: c.unitId });
    expect(r1.findings.find(f => f.code === "unit_hold_safety")).toMatchObject({ overrideClass: "NEVER_OVERRIDABLE", severity: "blocking" });
    expect(r1.state.status).toBe("out_of_service");
  });

  it("lists the organization's units with their derived state, filtered, and never another organization's", async () => {
    const mine = await caller(shopLead).fleet.assetCreate({ unitNumber: `L-${rnd()}`, assetType: "generator" });
    const theirs = await caller(leadB).fleet.assetCreate({ unitNumber: `LB-${rnd()}`, assetType: "generator" });
    await caller(safety).fleet.holdPlace({ unitId: mine.unitId, holdType: "safety", reason: "Generator frame cracked, do not run" });
    const all = await caller(dispatcher).fleet.list({ assetClass: "portable_equipment" });
    expect(all.units.find(u => u.unitId === mine.unitId)).toMatchObject({ status: "out_of_service", activeHolds: 1, assetType: "generator" });
    expect(all.units.some(u => u.unitId === theirs.unitId)).toBe(false);
    expect((await caller(dispatcher).fleet.list({ status: "out_of_service", q: mine.unitNumber })).units.map(u => u.unitId)).toEqual([mine.unitId]);
    expect((await caller(dispatcher).fleet.list({ status: "available", q: mine.unitNumber })).units).toEqual([]);
    expect(all.cap).toBe(100);
  });
});

d("the driver's own units", () => {
  it("a driver sees the units bound to their live slot and nothing else; a user with no operator record sees none", async () => {
    const s = await dispatchSubject(A);
    const truck = await caller(shopLead).fleet.assetCreate({ unitNumber: `D-${rnd()}`, assetType: "truck" });
    const other = await caller(shopLead).fleet.assetCreate({ unitNumber: `D2-${rnd()}`, assetType: "truck" });
    const [p] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dispatchPostings (postingNumber, jobId, distribution, planningState, priority, createdByUserId) VALUES (?, ?, 'direct_assignment', 'staffed', 'normal', ?)", [`POST-${rnd()}`, s.jobId, dispatcher]);
    await pool.execute("INSERT INTO dispatchRoles (postingId, roleCode, roleLabel, assignedOperatorId, assignedUnitId, status) VALUES (?, 'PRIMARY_UNIT', 'Primary unit', ?, ?, 'assigned')", [p.insertId, s.operatorId, truck.unitId]);
    const mine = await caller(s.driverUser).fleet.myAssignedUnits();
    expect(mine.units.map(u => [u.unitId, u.role, u.status])).toEqual([[truck.unitId, "unit", "available"]]);
    expect(mine.cache.validUntil.getTime()).toBeGreaterThan(Date.now());
    expect(mine.units.some(u => u.unitId === other.unitId)).toBe(false);
    await expect(caller(driver).fleet.myAssignedUnits()).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A driver holds `fleet.read` today (owner decision O-7, narrowing it to assigned units, is open); a
    // driver never changes a unit's identity, lifecycle or components.
    await expect(caller(s.driverUser).fleet.assetUpdate({ unitId: truck.unitId, make: "Mack" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(s.driverUser).fleet.lifecycleSet({ unitId: truck.unitId, to: "retired", reason: "I retire it" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

d("the organization boundary", () => {
  it("another organization's unit is indistinguishable from one that does not exist, on every asset procedure", async () => {
    const unitA = (await caller(shopLead).fleet.assetCreate({ unitNumber: `B-${rnd()}`, assetType: "truck" })).unitId;
    const compA = (await caller(shopLead).fleet.assetCreate({ unitNumber: `BC-${rnd()}`, assetType: "pto" })).unitId;
    const rel = await caller(mechanic).fleet.componentAttach({ parentUnitId: unitA, childUnitId: compA, relationship: "installed" });
    const [[{ maxId }]] = await pool.execute<mysql.RowDataPacket[]>("SELECT COALESCE(MAX(id), 0) AS maxId FROM units") as unknown as [[{ maxId: number }]];
    const ghost = Number(maxId) + 10_000;
    const same = async (fn: (id: number) => Promise<unknown>) => {
      const e1 = await fn(unitA).then(() => null, (e: { code?: string; message?: string }) => e);
      const e2 = await fn(ghost).then(() => null, (e: { code?: string; message?: string }) => e);
      expect(e1?.code).toBe("NOT_FOUND");
      expect({ code: e1?.code, message: e1?.message?.replace(String(unitA), "<id>") }).toEqual({ code: e2?.code, message: e2?.message?.replace(String(ghost), "<id>") });
    };
    const b = caller(leadB);
    await same(id => b.fleet.get({ unitId: id }));
    await same(id => b.fleet.unitReadiness({ unitId: id }));
    await same(id => b.fleet.components({ unitId: id }));
    await same(id => b.fleet.assetUpdate({ unitId: id, make: "Mack" }));
    await same(id => b.fleet.lifecycleSet({ unitId: id, to: "retired", reason: "retiring someone else's truck" }));
    await same(id => b.fleet.componentAttach({ parentUnitId: id, childUnitId: id + 1, relationship: "installed" }));
    await expect(b.fleet.componentDetach({ componentRef: rel.componentRef, reason: "detaching someone else's" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller(dispatcher).fleet.get({ unitId: unitA })).lifecycle.status).toBe("active");
  });
});
