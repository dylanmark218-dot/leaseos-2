/**
 * Fleet/Unit Security CP1.5 — who may release a hold, and what another organization can do to a unit's
 * dispatch readiness. Through the real router, the real readiness composer and the real triggers.
 *
 * Part E: whoever placed a hold may not release it; a role that does not release its type may not; a
 * member of another organization may not even see it; an independent person in the right role may;
 * releasing one hold releases only that one; an agent run cannot release any; a release, once
 * recorded, cannot be rewritten; and cancelling a work order repairs, closes, releases and returns to
 * service nothing.
 *
 * Part F: a refused cross-organization roadside, enforcement or incident mutation leaves the other
 * organization's readiness verdict AND fingerprint exactly as they were; the same mutations inside the
 * organization still ground the truck the way the canonical classification says; and an incident's
 * hold is a `unitHolds` row, placed with the incident and lifted only by an independent safety review.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { composeReadiness } from "./readinessComposer";

const URL = process.env.DATABASE_URL;

describe("hold authority and readiness — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped tenant-boundary suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 216_000_000 + Math.floor(Math.random() * 50_000);
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
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
async function dispatchSubject(orgRef: string) {
  const driverUser = await person(orgRef, ["driver"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, orgRef) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0, ?)", [`JOB-${rnd()}`, orgRef]);
  return { operatorId: Number(op.insertId), jobId: Number(j.insertId) };
}
type Subject = { operatorId: number; jobId: number };
type Blocker = { code: string; severity: string; overridable?: boolean; overrideClass?: string; subject?: string };
async function readiness(unitId: number, s: Subject, trailerId: number | null = null) {
  const r = await composeReadiness({ operatorId: s.operatorId, unitId, trailerId, jobId: s.jobId });
  const blockers = r.eligibility.blockers as unknown as Blocker[];
  return { verdict: r.eligibility.verdict, fingerprint: r.fingerprint, blockers, codes: blockers.map(b => b.code).sort() };
}
const count = async (sql: string, params: unknown[]) => Number((await pool.execute<mysql.RowDataPacket[]>(sql, params as never))[0][0].n);
/** Everything a mutation on this unit could leave behind. */
const footprint = async (unitId: number) => ({
  holds: await count("SELECT COUNT(*) AS n FROM unitHolds WHERE unitId = ?", [unitId]),
  events: await count("SELECT COUNT(*) AS n FROM fleetPortfolioEvents WHERE unitId = ?", [unitId]),
  defects: await count("SELECT COUNT(*) AS n FROM maintenanceDefects WHERE unitId = ?", [unitId]),
  workOrders: await count("SELECT COUNT(*) AS n FROM workOrders WHERE unitId = ?", [unitId]),
  roadside: await count("SELECT COUNT(*) AS n FROM roadsideServiceEvents WHERE unitId = ?", [unitId]),
  enforcement: await count("SELECT COUNT(*) AS n FROM enforcementEvents WHERE unitId = ? OR trailerId = ?", [unitId, unitId]),
  incidents: await count("SELECT COUNT(*) AS n FROM incidentReports WHERE unitId = ?", [unitId]),
  outbox: await count("SELECT COUNT(*) AS n FROM domainEventOutbox WHERE unitId = ?", [unitId]),
});
const holdRow = async (holdRef: string) => (await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM unitHolds WHERE holdRef = ?", [holdRef]))[0][0]!;
const AT = () => new Date(Date.now() - 3_600_000);
const oosInspection = (unitId: number) => ({ eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: "CVSE", occurredAt: AT(), inspectionResult: "out_of_service" as const, unitId, subjectRefs: { vehicle: `V-${rnd()}` },
  violations: [{ system: "brakes", ownCode: "BRK-ADJ", outOfService: true, oosScope: "vehicle" as const, defectRequired: true, repairRequired: true }] });
const collision = (unitId: number) => ({ incidentNumber: `INC-${rnd()}${rnd()}`, incidentType: "collision" as const, originalStatement: "Backed into the separator skid at the lease.", occurredAt: AT(), unitId, vehicleDamage: true });

let A = "", B = "";
let s: Subject;
let mechanic = 0, shopLead = 0, safety = 0, safety2 = 0, dispatcher = 0, driver = 0, management = 0;
let driverB = 0, safetyB = 0, leadB = 0;
beforeAll(async () => {
  if (!URL) return;
  A = await org(); B = await org();
  s = await dispatchSubject(A);
  mechanic = await person(A, ["mechanic"]); shopLead = await person(A, ["shop_lead"]);
  safety = await person(A, ["safety"]); safety2 = await person(A, ["safety"]);
  dispatcher = await person(A, ["dispatcher"]); driver = await person(A, ["driver"]); management = await person(A, ["management"]);
  driverB = await person(B, ["driver"]); safetyB = await person(B, ["safety"]); leadB = await person(B, ["shop_lead", "management", "safety"]);
});

d("Part E — a hold is released by an independent person with the authority for its type", () => {
  it("the placer cannot release it; a role that does not release its type cannot; another organization cannot see it; an independent safety person can", async () => {
    const u = await unit(A);
    const { holdRef } = await caller(safety).fleet.holdPlace({ unitId: u, holdType: "safety", reason: "Steering play found at the yard walk-around" });

    await expect(caller(safety).fleet.holdRelease({ holdRef, reason: "Adjusted it myself" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/placed a hold may not release it/) });
    await expect(caller(mechanic).fleet.holdRelease({ holdRef, reason: "Looks fine to me" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/may release a safety hold/) });
    // No permission at all: the role check refuses before the handler runs.
    await expect(caller(dispatcher).fleet.holdRelease({ holdRef, reason: "Truck is needed" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Another organization — every role that could release it at home — sees a hold that does not exist.
    const across = await caller(leadB).fleet.holdRelease({ holdRef, reason: "Not ours to release" }).catch((e: { code: string; message: string }) => e);
    const ghostRef = `HOLD-${rnd()}-${rnd()}`;
    const nowhere = await caller(leadB).fleet.holdRelease({ holdRef: ghostRef, reason: "Not ours to release" }).catch((e: { code: string; message: string }) => e);
    expect(across).toMatchObject({ code: "NOT_FOUND", message: `Hold ${holdRef} not found` });
    expect(nowhere).toMatchObject({ code: "NOT_FOUND", message: `Hold ${ghostRef} not found` });
    expect((await holdRow(holdRef)).status).toBe("active");

    const r = await caller(safety2).fleet.holdRelease({ holdRef, reason: "Steering box replaced and road-tested" });
    expect(r.status).toBe("available");
    expect(await holdRow(holdRef)).toMatchObject({ status: "released", releasedByUserId: safety2, releasedByRole: "safety" });
  });

  it("releasing one hold releases only that one; the other still grounds the truck, and readiness says so", async () => {
    const u = await unit(A);
    const maint = (await caller(mechanic).fleet.holdPlace({ unitId: u, holdType: "maintenance", reason: "PM overdue by 4,000 km" })).holdRef;
    const safe = (await caller(safety).fleet.holdPlace({ unitId: u, holdType: "safety", reason: "Cracked frame rail reported" })).holdRef;
    const both = await readiness(u, s);
    expect(both.codes).toEqual(expect.arrayContaining(["unit_hold_maintenance", "unit_hold_safety"]));

    await caller(shopLead).fleet.holdRelease({ holdRef: maint, reason: "PM completed and signed" });
    const after = await readiness(u, s);
    expect((await holdRow(maint)).status).toBe("released");
    expect((await holdRow(safe)).status).toBe("active");
    expect(after.codes).not.toContain("unit_hold_maintenance");
    expect(after.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unit_hold_safety", overrideClass: "NEVER_OVERRIDABLE" })]));
    expect(after.verdict).toBe("blocked");
    expect(after.fingerprint).not.toBe(both.fingerprint);
  });

  it("an agent run cannot release a hold: the gateway refuses and the hold stands", async () => {
    const u = await unit(A);
    const { holdRef } = await caller(safety).fleet.holdPlace({ unitId: u, holdType: "safety", reason: "Brake chamber leaking at idle" });
    const { runRef } = await caller(management).agent.start({ goal: "Get unit back on the board", plan: [] });
    const ask = await caller(management).agent.requestAction({ runRef, capability: "fleet.holdRelease", target: { entityType: "unitHold", entityId: holdRef, revision: null }, payload: { holdRef, reason: "Agent thinks it is fine" } });
    expect(ask.decision).toBe("deny");
    expect((await holdRow(holdRef)).status).toBe("active");
    expect(await count("SELECT COUNT(*) AS n FROM fleetPortfolioEvents WHERE subjectRef = ? AND eventType = 'hold_released'", [holdRef])).toBe(0);
  });

  it("a release, once recorded, is history: the row and its event cannot be rewritten or removed", async () => {
    const u = await unit(A);
    const { holdRef } = await caller(mechanic).fleet.holdPlace({ unitId: u, holdType: "maintenance", reason: "Coolant leak at the water pump" });
    await caller(shopLead).fleet.holdRelease({ holdRef, reason: "Water pump replaced" });
    await expect(pool.execute("UPDATE unitHolds SET status = 'active', releasedAt = NULL, releasedByUserId = NULL WHERE holdRef = ?", [holdRef])).rejects.toThrow(/released hold is history/);
    await expect(pool.execute("UPDATE unitHolds SET releaseReason = 'something kinder' WHERE holdRef = ?", [holdRef])).rejects.toThrow(/released hold is history/);
    await expect(pool.execute("DELETE FROM unitHolds WHERE holdRef = ?", [holdRef])).rejects.toThrow(/never deleted/);
    await expect(pool.execute("UPDATE fleetPortfolioEvents SET actorUserId = 1 WHERE subjectRef = ? AND eventType = 'hold_released'", [holdRef])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM fleetPortfolioEvents WHERE subjectRef = ?", [holdRef])).rejects.toThrow(/append-only/);
    expect(await holdRow(holdRef)).toMatchObject({ status: "released", releasedByUserId: shopLead, releaseReason: "Water pump replaced" });
  });

  it("cancelling a work order repairs nothing: the defect stays open, the hold stands, no release exists, the truck stays grounded", async () => {
    const u = await unit(A);
    const [df] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, 'Air leak at brake chamber', 'critical', 'open', NOW(), 1)", [u]);
    const [w] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO workOrders (workOrderNumber, unitId, defectId, status, priority, openedAt) VALUES (?, ?, ?, 'open', 'routine', DATE_SUB(NOW(), INTERVAL 2 HOUR))", [`WO-${rnd()}${rnd()}`, u, df.insertId]);
    const { holdRef } = await caller(mechanic).fleet.holdPlace({ unitId: u, holdType: "maintenance", reason: "Held for the brake chamber repair" });
    const before = await readiness(u, s);

    const c = await caller(shopLead).maintenance.workOrderCancel({ workOrderId: Number(w.insertId), reason: "Going to the dealer under warranty" });
    expect(c.unitStatus).not.toBe("available");
    expect((await pool.execute<mysql.RowDataPacket[]>("SELECT status, resolvedByReleaseId FROM maintenanceDefects WHERE id = ?", [df.insertId]))[0][0]).toMatchObject({ status: "open", resolvedByReleaseId: null });
    expect((await holdRow(holdRef)).status).toBe("active");
    expect(await count("SELECT COUNT(*) AS n FROM workOrderReleases WHERE unitId = ?", [u])).toBe(0);
    const after = await readiness(u, s);
    expect(after.verdict).toBe("blocked");
    expect(after.codes).toEqual(expect.arrayContaining(["unit_hold_maintenance"]));
    expect(after.codes.filter(c => c !== "unit_hold_maintenance")).toEqual(before.codes.filter(c => c !== "unit_hold_maintenance"));
  });
});

d("Part F — another organization cannot move this organization's readiness, and this organization's own events still do", () => {
  it("a refused roadside, enforcement, incident or hold placement from another organization leaves the verdict, the fingerprint and every table exactly as they were", async () => {
    const u = await unit(A);
    const before = await readiness(u, s);
    const printBefore = await footprint(u);

    const attempts: [string, () => Promise<unknown>][] = [
      ["roadside.open", () => caller(driverB).roadside.open({ eventType: "brake_issue", unitId: u, occurredAt: AT(), vehicleMovable: "no" })],
      ["enforcement.eventConfirm", () => caller(safetyB).enforcement.eventConfirm(oosInspection(u))],
      ["enforcement.eventConfirm (trailer)", () => caller(safetyB).enforcement.eventConfirm({ ...oosInspection(u), unitId: undefined, trailerId: u, subjectRefs: { trailer: `T-${rnd()}` }, violations: [{ system: "lights", ownCode: "LGT", outOfService: true, oosScope: "trailer" as const }] })],
      ["records.incident.capture", () => caller(driverB).records.incident.capture(collision(u))],
      ["fleet.holdPlace", () => caller(leadB).fleet.holdPlace({ unitId: u, holdType: "safety", reason: "We say this truck is unsafe" })],
    ];
    for (const [name, attempt] of attempts) {
      const e = await attempt().then(() => null, (x: { code: string; message: string }) => x);
      expect(e, `${name} was not refused`).toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(new RegExp(`^(Unit|Trailer) ${u} not found$`)) });
    }

    const after = await readiness(u, s);
    expect(after.verdict).toBe(before.verdict);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.codes).toEqual(before.codes);
    expect(await footprint(u)).toEqual(printBefore);
  });

  it("inside the organization, a roadside breakdown grounds the truck and an out-of-service inspection grounds it with no override", async () => {
    const u1 = await unit(A);
    const clean = await readiness(u1, s);
    await caller(driver).roadside.open({ eventType: "brake_issue", unitId: u1, occurredAt: AT(), vehicleMovable: "no" });
    const afterRoadside = await readiness(u1, s);
    expect(afterRoadside.verdict).toBe("blocked");
    expect(afterRoadside.fingerprint).not.toBe(clean.fingerprint);

    const u2 = await unit(A);
    await caller(safety).enforcement.eventConfirm(oosInspection(u2));
    const afterOos = await readiness(u2, s);
    expect(afterOos.verdict).toBe("blocked");
    expect(afterOos.blockers.some(b => b.severity === "blocking" && b.overrideClass === "NEVER_OVERRIDABLE")).toBe(true);
  });

  it("an incident that holds its unit places one unitHolds safety hold with it: out of service, never overridable, lifted only by an independent safety review", async () => {
    const u = await unit(A);
    const clean = await readiness(u, s);
    const captured = await caller(driver).records.incident.capture(collision(u));
    expect(captured.holdUnit).toBe(true);
    expect(captured.holdRef).toMatch(/^HOLD-/);
    const hold = await holdRow(captured.holdRef!);
    expect(hold).toMatchObject({ unitId: u, orgRef: A, holdType: "safety", dispatchEffect: "out_of_service", sourceKind: "incident", sourceRef: captured.incidentNumber, placedByUserId: driver, placedByRole: "incident_escalation", status: "active" });
    // The one hold table: nothing else represents the incident's hold.
    expect(await count("SELECT COUNT(*) AS n FROM unitHolds WHERE unitId = ?", [u])).toBe(1);

    const held = await readiness(u, s);
    expect(held.verdict).toBe("blocked");
    expect(held.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unit_hold_safety", severity: "blocking", overridable: false, overrideClass: "NEVER_OVERRIDABLE" })]));
    expect(held.fingerprint).not.toBe(clean.fingerprint);
    const state = await caller(dispatcher).fleet.unitState({ unitId: u });
    expect(state.status).toBe("out_of_service");
    expect(state.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "hold_safety", liftedBy: "records.incident.review" })]));
    expect(state.notEvaluated.map((n: { domain: string }) => n.domain)).not.toContain("incident_unit_held");

    // Not by hand: the hold is the incident's, and the portfolio release refuses it.
    await expect(caller(safety2).fleet.holdRelease({ holdRef: captured.holdRef!, reason: "Looks fine" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // Not by the capturer, even one who holds the review role.
    const safetyCapturer = await person(A, ["safety"]);
    const u2 = await unit(A);
    const own = await caller(safetyCapturer).records.incident.capture(collision(u2));
    await expect(caller(safetyCapturer).records.incident.review({ incidentNumber: own.incidentNumber })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/placed a hold may not release it/) });
    expect((await holdRow(own.holdRef!)).status).toBe("active");
    expect((await pool.execute<mysql.RowDataPacket[]>("SELECT safetyReviewedAt FROM incidentReports WHERE incidentNumber = ?", [own.incidentNumber]))[0][0]!.safetyReviewedAt).toBeNull();
    // Not by another organization.
    await expect(caller(leadB).records.incident.review({ incidentNumber: captured.incidentNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // An independent safety reviewer: the review and the release are one act.
    const reviewed = await caller(safety2).records.incident.review({ incidentNumber: captured.incidentNumber });
    expect(reviewed.releasedHoldRefs).toEqual([captured.holdRef]);
    expect(await holdRow(captured.holdRef!)).toMatchObject({ status: "released", releasedByUserId: safety2, releasedByRole: "safety" });
    const released = await readiness(u, s);
    expect(released.codes).not.toContain("unit_hold_safety");
    expect(released.fingerprint).toBe(clean.fingerprint);
  });

  it("a hold's classification is the canonical one: safety fails closed, maintenance needs an approved policy, a warning never blocks", async () => {
    const u = await unit(A);
    const clean = await readiness(u, s);
    await caller(mechanic).fleet.holdPlace({ unitId: u, holdType: "maintenance", reason: "Tire tread at 3/32 on steer axle", effect: "warn" });
    const warned = await readiness(u, s);
    const warning = warned.blockers.find(b => b.code === "unit_hold_maintenance_warning");
    expect(warning).toMatchObject({ severity: "review", overrideClass: "WARNING_ONLY" });
    expect(warned.blockers.filter(b => b.severity === "blocking" && /_hold_/.test(b.code))).toEqual([]);
    // A warning adds a review item and no blocking finding of any kind: what blocked before still does,
    // and nothing else does. (The fixture's driver carries no documents, so the verdict itself is not
    // the measure here — the blocking set is.)
    const blocking = (r: { blockers: Blocker[] }) => r.blockers.filter(b => b.severity === "blocking").map(b => b.code).sort();
    expect(blocking(warned)).toEqual(blocking(clean));

    await caller(mechanic).fleet.holdPlace({ unitId: u, holdType: "maintenance", reason: "Brake stroke out of adjustment" });
    const blocked = await readiness(u, s);
    expect(blocked.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unit_hold_maintenance", severity: "blocking", overrideClass: "APPROVED_POLICY_ONLY" })]));
    expect(blocked.verdict).toBe("blocked");
  });

  it("the truck's and the trailer's holds are both read", async () => {
    const truck = await unit(A), trailer = await unit(A);
    await caller(safety).fleet.holdPlace({ unitId: truck, holdType: "safety", reason: "Fifth wheel jaw not locking" });
    await caller(mechanic).fleet.holdPlace({ unitId: trailer, holdType: "maintenance", reason: "Trailer ABS lamp on" });
    const r = await readiness(truck, s, trailer);
    expect(r.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unit_hold_safety", overrideClass: "NEVER_OVERRIDABLE" }),
      expect.objectContaining({ code: "trailer_hold_maintenance", overrideClass: "APPROVED_POLICY_ONLY" }),
    ]));
  });
});
