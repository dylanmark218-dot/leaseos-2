import { describe, expect, it } from "vitest";
import { comparable, meterProgress, meterSequence, METER_REGRESSION, UNTRUSTED_METER_SEQUENCE, type MeterObservation } from "./fleetMeters";

let n = 0;
const at = (d: string) => new Date(`2026-09-${d}T08:00:00Z`);
const o = (over: Partial<MeterObservation> & Pick<MeterObservation, "value" | "recordedAt">): MeterObservation => {
  const id = ++n;
  const source = over.source ?? "telematics";
  return { ref: `${source}#${id}.odometerKm`, meterType: "odometer_km", source, standing: "accepted", sourceTable: source, sourceId: id, sourceField: "odometerKm", ...over };
};

describe("a meter's sequence", () => {
  it("evaluates valid increasing readings normally, from wherever they came", () => {
    const base = o({ value: 100_000, recordedAt: at("01"), source: "work_order" });
    const obs = [base, o({ value: 100_400, recordedAt: at("03"), source: "fuel_receipt" }), o({ value: 101_250, recordedAt: at("05"), source: "telematics" })];
    const s = meterSequence(obs, "odometer_km");
    expect(s.trust).toBe("trusted");
    expect(s.current?.value).toBe(101_250);
    expect(meterProgress(obs, "odometer_km", base.ref)).toMatchObject({ status: "evaluable", progress: 1_250 });
  });

  it("treats identical readings as no progress and no regression, deterministically", () => {
    const a = o({ value: 50_000, recordedAt: at("01") });
    const b = o({ value: 50_000, recordedAt: at("02"), source: "trip" });
    const c = o({ value: 50_000, recordedAt: at("02"), source: "work_order" });   // same instant as b
    expect(meterProgress([a, b, c], "odometer_km", a.ref)).toMatchObject({ status: "evaluable", progress: 0 });
    // Ties in time break by source precedence: the work order sorts before the trip, in any input order.
    expect(meterSequence([c, b, a], "odometer_km").observations.map(x => x.ref)).toEqual([a.ref, c.ref, b.ref]);
    expect(meterSequence([b, a, c], "odometer_km").current?.ref).toBe(b.ref);
  });

  it("does not manufacture a regression from two sources storing one figure at different precision", () => {
    expect(comparable(120_000.04)).toBe(comparable(120_000));
    const obs = [o({ value: 120_000.04, recordedAt: at("01") }), o({ value: 120_000, recordedAt: at("02"), source: "trip" })];
    expect(meterSequence(obs, "odometer_km").regressions).toEqual([]);
  });
});

describe("a regression below an accepted reading (owner rule, 2026-09-25)", () => {
  const base = o({ value: 200_000, recordedAt: at("01"), source: "work_order" });
  const high = o({ value: 205_000, recordedAt: at("04"), source: "telematics" });
  const drop = o({ value: 150_000, recordedAt: at("06"), source: "ledger", standing: "provisional" });
  const later = o({ value: 205_600, recordedAt: at("08"), source: "telematics" });

  it("makes distance-based evaluation indeterminate with METER_REGRESSION — never 'not due'", () => {
    const p = meterProgress([base, high, drop, later], "odometer_km", base.ref);
    expect(p).toMatchObject({ status: "indeterminate", reason: METER_REGRESSION });
    if (p.status === "indeterminate") {
      expect(p.regressions[0]).toMatchObject({ earlier: high, later: drop, drop: 55_000 });
      expect(p.detail).toMatch(/a decrease is not service progress/);
    }
    expect(meterSequence([base, high, drop, later], "odometer_km").trust).toBe(UNTRUSTED_METER_SEQUENCE);
  });

  it("keeps the reading that went down, and never lets a provisional reading be the current value", () => {
    const s = meterSequence([base, high, drop, later], "odometer_km");
    expect(s.observations).toContain(drop);
    expect(s.observations.find(x => x.ref === drop.ref)?.value).toBe(150_000);   // not repaired
    expect(s.current?.ref).toBe(later.ref);
  });

  it("a rejected reading takes no part; a regression of an accepted source is not cured by a later high reading", () => {
    const rejected = { ...drop, standing: "rejected" as const };
    expect(meterProgress([base, high, rejected, later], "odometer_km", base.ref)).toMatchObject({ status: "evaluable", progress: 5_600 });
    const accDrop = o({ value: 150_000, recordedAt: at("06"), source: "trip" });
    expect(meterProgress([base, high, accDrop, later], "odometer_km", base.ref)).toMatchObject({ status: "indeterminate", reason: METER_REGRESSION });
  });

  it("a baseline taken after the drop evaluates normally again, and the drop stays on record", () => {
    const accDrop = o({ value: 150_000, recordedAt: at("06"), source: "trip" });
    const newBase = o({ value: 150_100, recordedAt: at("07"), source: "ledger", standing: "accepted" });
    const next = o({ value: 151_000, recordedAt: at("09"), source: "telematics" });
    const all = [base, high, accDrop, newBase, next];
    expect(meterProgress(all, "odometer_km", newBase.ref)).toMatchObject({ status: "evaluable", progress: 900 });
    expect(meterSequence(all, "odometer_km").trust).toBe(UNTRUSTED_METER_SEQUENCE);
  });

  it("says why it cannot count: no baseline, a baseline that is not accepted, no reading since", () => {
    const prov = o({ value: 1, recordedAt: at("01"), source: "ledger", standing: "provisional" });
    expect(meterProgress([base], "odometer_km", null)).toMatchObject({ status: "indeterminate", reason: "NO_BASELINE" });
    expect(meterProgress([base], "odometer_km", "nope#1.x")).toMatchObject({ status: "indeterminate", reason: "NO_BASELINE" });
    expect(meterProgress([prov], "odometer_km", prov.ref)).toMatchObject({ status: "indeterminate", reason: "BASELINE_NOT_ACCEPTED" });
    expect(meterProgress([base], "engine_hours", base.ref)).toMatchObject({ status: "indeterminate", reason: "NO_BASELINE" });
  });
});
