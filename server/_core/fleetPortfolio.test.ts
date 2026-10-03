import { describe, expect, it } from "vitest";
import { driverNotice, holdEffectFor, mayPlaceHold, mayReleaseHold, operationalState, type PortfolioFacts } from "./fleetPortfolio";
import { METER_REGRESSION, UNTRUSTED_METER_SEQUENCE, type MeterObservation } from "./fleetMeters";

const T = (d: string) => new Date(`2026-09-${d}T08:00:00Z`);
const empty: PortfolioFacts = { holds: [], defects: [], releases: [], activeOrders: [], unestablishedInspections: [], openRoadside: [], faults: [], meters: [], unreadable: [] };
const f = (over: Partial<PortfolioFacts>): PortfolioFacts => ({ ...empty, ...over });
const hold = (holdType: PortfolioFacts["holds"][number]["holdType"], dispatchEffect: PortfolioFacts["holds"][number]["dispatchEffect"], ref = "H-1") => ({ holdRef: ref, holdType, dispatchEffect, reason: `${holdType} hold for testing`, placedAt: T("10") });

describe("holds: three effects, and who may do what", () => {
  it("a safety hold is out of service and cannot be a warning; other types block or warn as the rules say", () => {
    expect(holdEffectFor({ holdType: "safety", requested: null, roles: ["safety"] })).toEqual({ effect: "out_of_service" });
    expect(holdEffectFor({ holdType: "safety", requested: "warn", roles: ["management"] })).toHaveProperty("refused");
    expect(holdEffectFor({ holdType: "maintenance", requested: null, roles: ["mechanic"] })).toEqual({ effect: "block" });
    expect(holdEffectFor({ holdType: "maintenance", requested: "warn", roles: ["mechanic"] })).toEqual({ effect: "warn" });
    expect(holdEffectFor({ holdType: "damage", requested: null, roles: ["shop_lead"] })).toEqual({ effect: "warn" });
    expect(holdEffectFor({ holdType: "damage", requested: "block", roles: ["shop_lead"] })).toHaveProperty("refused");
    expect(holdEffectFor({ holdType: "administrative", requested: "block", roles: ["management"] })).toEqual({ effect: "block" });
  });

  it("a mechanic places maintenance holds only; nobody without a listed role places anything", () => {
    expect(mayPlaceHold(["mechanic"], "maintenance").allowed).toBe(true);
    expect(mayPlaceHold(["mechanic"], "safety").allowed).toBe(false);
    expect(mayPlaceHold(["safety"], "safety").allowed).toBe(true);
    expect(mayPlaceHold(["dispatcher", "driver"], "maintenance").allowed).toBe(false);
  });

  it("releasing is a second person's act, by a role that releases that type — a mechanic never releases a safety hold", () => {
    const base = { holdType: "safety" as const, placedByUserId: 1, userId: 2, status: "active" as const };
    expect(mayReleaseHold({ ...base, roles: ["mechanic", "shop_lead"] }).allowed).toBe(false);
    expect(mayReleaseHold({ ...base, roles: ["safety"] }).allowed).toBe(true);
    expect(mayReleaseHold({ ...base, roles: ["safety"], userId: 1 })).toMatchObject({ allowed: false, reason: expect.stringMatching(/placed a hold may not release it/) });
    expect(mayReleaseHold({ ...base, roles: ["safety"], status: "released" }).allowed).toBe(false);
    expect(mayReleaseHold({ ...base, holdType: "maintenance", roles: ["mechanic"] }).allowed).toBe(true);
  });
});

describe("the unit's operational state, derived", () => {
  it("is available with nothing against it, and says what it did not evaluate", () => {
    const s = operationalState(empty);
    expect(s.status).toBe("available");
    // CP1.5: incident holds are evaluated now — an incident that holds its unit places a unitHolds row.
    // 0242: lifecycle is recorded and evaluated now (retired, sold, storage are reasons), so it left this list.
    expect(s.notEvaluated.map(n => n.domain)).toEqual(["documents_and_insurance", "dispatched"]);
    expect(driverNotice(s)).toBe("Operational");
  });

  it("maps each hold effect to its status: warning, maintenance hold, out of service", () => {
    expect(operationalState(f({ holds: [hold("damage", "warn")] })).status).toBe("warning");
    expect(operationalState(f({ holds: [hold("maintenance", "block")] })).status).toBe("maintenance_hold");
    const oos = operationalState(f({ holds: [hold("safety", "out_of_service")] }));
    expect(oos.status).toBe("out_of_service");
    expect(oos.reasons[0]).toMatchObject({ code: "hold_safety", category: "safety", liftedBy: "fleet.holdRelease" });
    expect(driverNotice(oos)).toMatch(/^Out of service — do not operate/);
  });

  it("a warning hold never outranks or stands in for a safety hold", () => {
    const both = operationalState(f({ holds: [hold("damage", "warn", "W"), hold("safety", "out_of_service", "S")] }));
    expect(both.status).toBe("out_of_service");
    // Releasing the warning (it leaves the facts) leaves the safety hold deciding.
    expect(operationalState(f({ holds: [hold("safety", "out_of_service", "S")] })).status).toBe("out_of_service");
  });

  it("orders by consequence: out of service > maintenance hold > indeterminate > warning > available", () => {
    expect(operationalState(f({ unreadable: ["faultCodes"], holds: [hold("damage", "warn")] })).status).toBe("indeterminate");
    expect(operationalState(f({ unreadable: ["faultCodes"], holds: [hold("maintenance", "block")] })).status).toBe("maintenance_hold");
    expect(operationalState(f({ holds: [hold("maintenance", "block")], activeOrders: [{ orderRef: "OOS-1", scope: "vehicle", issuedAt: T("09"), issuingAgency: "CVSE" }] })).status).toBe("out_of_service");
  });

  it("reads a critical defect and its release as the readiness composer does", () => {
    const d = { id: 7, title: "Brake chamber leaking", severity: "critical" as const, status: "open" as const, resolvedByReleaseId: null, reportedAt: T("10") };
    expect(operationalState(f({ defects: [d] })).reasons.map(r => r.code).sort()).toEqual(["critical_defect", "mechanic_release_missing"]);
    const released = { id: 1, workOrderId: 3, releaseType: "full" as const, testResult: "pass" as const, resolvedDefectIds: "[7]", releasedAt: T("11"), restrictionDetail: null };
    expect(operationalState(f({ defects: [{ ...d, status: "resolved", resolvedByReleaseId: 1 }], releases: [released] })).status).toBe("available");
  });

  it("a meter that went backwards warns — it does not ground the truck — and names the drop", () => {
    const e: MeterObservation = { ref: "workOrders#1.odometerKm", meterType: "odometer_km", value: 120_000, recordedAt: T("01"), source: "work_order", standing: "accepted", sourceTable: "workOrders", sourceId: 1, sourceField: "odometerKm" };
    const l: MeterObservation = { ...e, ref: "trips#2.odometerEndKm", value: 90_000, recordedAt: T("02"), source: "trip", sourceTable: "trips", sourceId: 2, sourceField: "odometerEndKm" };
    const s = operationalState(f({ meters: [{ meterType: "odometer_km", trust: UNTRUSTED_METER_SEQUENCE, regressions: [{ code: METER_REGRESSION, earlier: e, later: l, drop: 30_000 }] }] }));
    expect(s.status).toBe("warning");
    expect(s.reasons[0]).toMatchObject({ code: UNTRUSTED_METER_SEQUENCE, category: "meter", source: { table: "trips", ref: "trips#2.odometerEndKm" } });
  });

  it("a source that cannot be read is indeterminate, never available", () => {
    const s = operationalState(f({ unreadable: ["outOfServiceOrders"] }));
    expect(s.status).toBe("indeterminate");
    expect(driverNotice(s)).toMatch(/cannot be established/);
  });
});
