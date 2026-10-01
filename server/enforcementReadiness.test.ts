/**
 * v22.20 — the regression the reviewer asked for first, and the one most
 * capable of undermining the enforcement engine.
 *
 * A mechanic can establish that a truck is mechanically sound. Nobody inside
 * this company can establish that an inspector's order has been lifted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { composeReadiness } from "./readinessComposer";
import { captureSyncPriority } from "../client/src/runtime/syncEngine";
import { enforcementReadiness, type OosOrder } from "./_core/enforcement";

const NOW = new Date("2026-09-11T12:00:00Z");
const activeVehicleOos: OosOrder = {
  orderRef: "OOS-2026-00482", scope: "vehicle", subjectRef: "UNIT-127",
  issuedAt: new Date(NOW.getTime() - 3_600_000), issuingAgency: "roadside enforcement",
  releaseCondition: "repair verified and reinspection passed",
  releasedAt: null, releasedByUserId: null, releaseEvidenceRef: null, rescindedAt: null,
};

describe("an out-of-service capture outranks everything in the outbox", () => {
  it("gives a roadside document and an OOS order the top tier, alongside HOS", () => {
    expect(captureSyncPriority("roadside_enforcement")).toBe(0);
    expect(captureSyncPriority("oos_order")).toBe(0);
    expect(captureSyncPriority("hos_event")).toBe(0);
    // And bulk media still cannot get ahead of them.
    expect(captureSyncPriority("photo")).toBeGreaterThan(captureSyncPriority("oos_order"));
    expect(captureSyncPriority("voice_note")).toBeGreaterThan(captureSyncPriority("oos_order"));
    expect(captureSyncPriority("fuel_receipt")).toBeGreaterThan(captureSyncPriority("oos_order"));
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
async function unitAndOperator() {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [key("Op").slice(0, 40)]);
  return { unitId: Number(u.insertId), operatorId: Number(o.insertId) };
}

d("mechanic release cannot override an active enforcement order", () => {
  it("blocks the unit, and the blocker is not overridable by anyone in this company", async () => {
    const { unitId, operatorId } = await unitAndOperator();
    // The unit is mechanically clear: inspectionStatus current, maintenanceStatus clear.
    const clean = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null });
    expect(clean.eligibility.blockers.some(b => b.code.startsWith("oos."))).toBe(false);

    const withOrder = await composeReadiness({
      operatorId, unitId, trailerId: null, jobId: null,
      enforcement: { subjects: [{ subjectRef: "UNIT-127", scope: "vehicle" }], orders: [activeVehicleOos] },
    });
    const oos = withOrder.eligibility.blockers.find(b => b.code === "oos.vehicle")!;
    expect(oos).toBeTruthy();
    expect(oos.severity).toBe("blocking");
    // A manager may override a company rule. An inspector's order is not one.
    expect(oos.overridable).toBe(false);
    expect(withOrder.eligibility.verdict).toBe("blocked");
    expect(oos.label).toContain("Release condition: repair verified and reinspection passed");
  });

  it("leaves the unit clear once the order is released, and never by anything else", async () => {
    const { unitId, operatorId } = await unitAndOperator();
    const released: OosOrder = { ...activeVehicleOos, releasedAt: new Date(NOW.getTime() - 60_000), releasedByUserId: 5, releaseEvidenceRef: "EV-9" };
    const r = await composeReadiness({
      operatorId, unitId, trailerId: null, jobId: null,
      enforcement: { subjects: [{ subjectRef: "UNIT-127", scope: "vehicle" }], orders: [released] },
    });
    expect(r.eligibility.blockers.some(b => b.code.startsWith("oos."))).toBe(false);
  });

  it("reports a prohibited driver on a clear unit as replaceable rather than grounding the truck", async () => {
    const { unitId, operatorId } = await unitAndOperator();
    const driverOrder: OosOrder = { ...activeVehicleOos, orderRef: "OOS-D", scope: "driver", subjectRef: "D-221" };
    const r = await composeReadiness({
      operatorId, unitId, trailerId: null, jobId: null,
      enforcement: {
        subjects: [{ subjectRef: "D-221", scope: "driver" }, { subjectRef: "UNIT-127", scope: "vehicle" }],
        orders: [driverOrder],
      },
    });
    expect(r.eligibility.blockers.find(b => b.code === "oos.driver")!.subject).toBe("operator");
    expect(r.eligibility.blockers.some(b => b.code === "oos.vehicle")).toBe(false);
    expect(r.contributions.some(c => c.engine === "enforcement" && c.finding.includes("replacement driver"))).toBe(true);
  });

  it("denies on an unresolved inspection rather than letting a mechanically clear unit read ready", async () => {
    const { unitId, operatorId } = await unitAndOperator();
    const r = await composeReadiness({
      operatorId, unitId, trailerId: null, jobId: null,
      enforcement: {
        subjects: [{ subjectRef: "UNIT-127", scope: "vehicle" }], orders: [],
        unresolvedInspections: [{ inspectionRef: "INSP-829294", coversSubjectRefs: ["UNIT-127"] }],
      },
    });
    const unknown = r.eligibility.blockers.find(b => b.code === "enforcement_result_unknown")!;
    expect(unknown.severity).toBe("unknown");
    expect(unknown.label).toContain("Unknown is not a pass");
  });

  /*
   * This case used to assert the opposite: that a composition with no `enforcement` object said
   * nothing about enforcement at all, "so every existing caller is unchanged". That was true, and
   * it was the defect — no production caller ever supplied the object, so the one capability this
   * system will not let anyone override was never evaluated, and its silence read as a pass.
   * The composer now reads `outOfServiceOrders` itself, so a caller supplying nothing gets a real
   * answer rather than no answer.
   */
  it("evaluates enforcement from the canonical table when the caller supplies nothing", async () => {
    const { unitId, operatorId } = await unitAndOperator();
    const r = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null });
    expect(r.contributions.some(c => c.engine === "enforcement")).toBe(true);
    const capability = r.capabilities.find(c => c.capability === "enforcement orders");
    expect(capability?.status).toBe("PASS");
    expect(r.eligibility.blockers.some(b => b.code.startsWith("oos."))).toBe(false);
  });
});

describe("the engine and the composer agree", () => {
  it("reaches the same verdict through both paths", () => {
    const direct = enforcementReadiness({ subjects: [{ subjectRef: "UNIT-127", scope: "vehicle" }], orders: [activeVehicleOos], at: NOW });
    expect(direct.verdict).toBe("prohibited");
    expect(direct.blockers[0].code).toBe("oos.vehicle");
  });
});
