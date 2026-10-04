/**
 * A value comes from rows, a missing field is not a zero, and an average over nothing is not 0.
 */
import { describe, expect, it } from "vitest";
import { ROW_CAP, aggregate, overlapMinutes, type DrillRow, type MetricDefinition } from "./metricContract";

const def = (over: Partial<MetricDefinition> = {}): MetricDefinition => ({
  id: "test.metric", name: "Test", family: "fleet", description: "d", formula: "f", sources: ["units"],
  unit: "count", aggregation: { kind: "count" }, temporal: "range", filters: [], requiredPermission: "fleet.read",
  selfScoped: false, freshnessSeconds: 60, incompleteness: "i", ...over,
});
const row = (id: number, fields: DrillRow["fields"] = {}): DrillRow => ({ key: `r:${id}`, record: { table: "units", id, ref: null }, label: `r${id}`, at: null, fields });

describe("counting", () => {
  it("states a counted zero as a computed zero", () => {
    expect(aggregate(def(), { rows: [], unknowns: [], truncated: false })).toMatchObject({ value: 0, determination: "computed", basis: 0 });
  });
  it("counts rows and says partial when records could not be placed", () => {
    const a = aggregate(def(), { rows: [row(1), row(2)], unknowns: [{ reason: "no completion time", count: 3 }], truncated: false });
    expect(a).toMatchObject({ value: 2, determination: "partial", unknowns: [{ reason: "no completion time", count: 3 }] });
  });
  it("drops an unknown that counted nothing, so partial means something was actually missing", () => {
    expect(aggregate(def(), { rows: [row(1)], unknowns: [{ reason: "none of these", count: 0 }], truncated: false }))
      .toMatchObject({ value: 1, determination: "computed", unknowns: [] });
  });
  it("says partial when it stopped reading at the cap", () => {
    const a = aggregate(def(), { rows: [row(1)], unknowns: [], truncated: true });
    expect(a.determination).toBe("partial");
    expect(a.unknowns[0]!.reason).toContain(String(ROW_CAP));
  });
  it("breaks down by a field, naming the empty value rather than folding it in", () => {
    const a = aggregate(def({ breakdownBy: "severity" }), { rows: [row(1, { severity: "critical" }), row(2, { severity: "critical" }), row(3, { severity: null })], unknowns: [], truncated: false });
    expect(a.breakdown).toEqual({ critical: 2, "(not recorded)": 1 });
  });
});

describe("averages and sums", () => {
  const mean = def({ unit: "hours", aggregation: { kind: "mean", field: "h" } });
  it("is not applicable over no records, never zero", () => {
    expect(aggregate(mean, { rows: [], unknowns: [], truncated: false })).toMatchObject({ value: null, determination: "not_applicable", basis: 0 });
  });
  it("is unknown over no placed records when some could not be placed", () => {
    expect(aggregate(mean, { rows: [], unknowns: [{ reason: "x", count: 2 }], truncated: false })).toMatchObject({ value: null, determination: "unknown" });
  });
  it("averages what it has and says what it lacks", () => {
    expect(aggregate(mean, { rows: [row(1, { h: 10 }), row(2, { h: 5 })], unknowns: [{ reason: "x", count: 1 }], truncated: false }))
      .toMatchObject({ value: 7.5, determination: "partial", basis: 2 });
  });
  it("sums a field", () => {
    const sum = def({ unit: "minutes", aggregation: { kind: "sum", field: "minutes" } });
    expect(aggregate(sum, { rows: [row(1, { minutes: 90 }), row(2, { minutes: 30.5 })], unknowns: [], truncated: false })).toMatchObject({ value: 120.5, determination: "computed" });
    expect(aggregate(sum, { rows: [], unknowns: [], truncated: false })).toMatchObject({ value: 0, determination: "computed" });
  });
  it("refuses a row missing the field it aggregates, rather than leaving it out of the arithmetic", () => {
    expect(() => aggregate(mean, { rows: [row(1, { h: 1 }), row(2, {})], unknowns: [], truncated: false })).toThrow(/lack a numeric "h"/);
  });
});

describe("a metric the records cannot support", () => {
  it("answers with its reason and no value", () => {
    const d = def({ unavailable: { determination: "not_derivable", reason: "no due date exists" } });
    expect(aggregate(d, { rows: [row(1)], unknowns: [], truncated: false })).toEqual({
      value: null, determination: "not_derivable", unknowns: [{ reason: "no due date exists", count: 0 }], basis: 0, breakdown: null,
    });
  });
});

describe("overlap", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 0, 10, h));
  it("counts only the minutes inside the range", () => {
    expect(overlapMinutes(t(2), t(6), t(4), t(10))).toBe(120);
    expect(overlapMinutes(t(2), t(6), t(0), t(3))).toBe(60);
    expect(overlapMinutes(t(2), t(6), t(6), t(10))).toBe(0);
    expect(overlapMinutes(t(6), t(2), t(0), t(10))).toBe(0);
  });
});
