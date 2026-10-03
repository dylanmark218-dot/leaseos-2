/**
 * Payroll P2 — pay-schedule calendars and the pay-period machine, pure.
 */
import { describe, expect, it } from "vitest";
import {
  PERIOD_STATE_LABEL,
  addDays,
  addMonths,
  approveReadiness,
  canTransitionPeriod,
  finalizeReadiness,
  generatePeriods,
  isDateText,
  periodAcceptsEarnings,
  periodAcceptsRuns,
  periodAt,
  periodIsLocked,
  validateSchedule,
  voidReadiness,
  type PayPeriodState,
  type ScheduleSpec,
} from "./payrollSchedule";

const base = (over: Partial<ScheduleSpec>): ScheduleSpec => ({ frequency: "weekly", anchorDate: "2026-01-05", paymentLagDays: 5, cutoffLagDays: 1, timezone: "America/Edmonton", ...over });
const spans = (s: ScheduleSpec, n: number) => Array.from({ length: n }, (_, k) => { const p = periodAt(s, k); return `${p.start}..${p.end}`; });

describe("P2 — calendar arithmetic stays on calendar dates", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-08", -1)).toBe("2026-03-07");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  });
  it("accepts only real dates", () => {
    expect(isDateText("2026-02-28")).toBe(true);
    expect(isDateText("2026-02-30")).toBe(false);
    expect(isDateText("2026-2-3")).toBe(false);
  });
});

describe("P2 — every frequency generates a gapless, non-overlapping calendar", () => {
  it("weekly, biweekly and custom step from the anchor", () => {
    expect(spans(base({}), 3)).toEqual(["2026-01-05..2026-01-12", "2026-01-12..2026-01-19", "2026-01-19..2026-01-26"]);
    expect(spans(base({ frequency: "biweekly" }), 2)).toEqual(["2026-01-05..2026-01-19", "2026-01-19..2026-02-02"]);
    expect(spans(base({ frequency: "custom", periodLengthDays: 10 }), 2)).toEqual(["2026-01-05..2026-01-15", "2026-01-15..2026-01-25"]);
  });
  it("semi-monthly splits on the 1st and the 16th, from either anchor", () => {
    expect(spans(base({ frequency: "semi_monthly", anchorDate: "2026-01-01" }), 4)).toEqual(["2026-01-01..2026-01-16", "2026-01-16..2026-02-01", "2026-02-01..2026-02-16", "2026-02-16..2026-03-01"]);
    expect(spans(base({ frequency: "semi_monthly", anchorDate: "2026-12-16" }), 3)).toEqual(["2026-12-16..2027-01-01", "2027-01-01..2027-01-16", "2027-01-16..2027-02-01"]);
  });
  it("monthly keeps the anchor's day", () => {
    expect(spans(base({ frequency: "monthly", anchorDate: "2026-01-15" }), 3)).toEqual(["2026-01-15..2026-02-15", "2026-02-15..2026-03-15", "2026-03-15..2026-04-15"]);
  });
  it("leaves no gap and no overlap over a year of every frequency", () => {
    for (const s of [base({}), base({ frequency: "biweekly" }), base({ frequency: "custom", periodLengthDays: 9 }), base({ frequency: "semi_monthly", anchorDate: "2026-01-16" }), base({ frequency: "monthly", anchorDate: "2026-01-28" })]) {
      const ps = generatePeriods(s, { through: "2026-12-31", max: 400 });
      for (let i = 1; i < ps.length; i++) expect(ps[i]!.start, s.frequency).toBe(ps[i - 1]!.end);
      for (const p of ps) expect(p.start < p.end, s.frequency).toBe(true);
    }
  });
});

describe("P2 — generation is bounded and deterministic", () => {
  const s = base({});
  it("generates the periods started by `through`, oldest first, with payment and cutoff dates", () => {
    const ps = generatePeriods(s, { through: "2026-01-19", max: 60 });
    expect(ps.map(p => p.start)).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
    expect(ps[0]).toEqual({ start: "2026-01-05", end: "2026-01-12", lastDay: "2026-01-11", paymentDate: "2026-01-16", cutoffDate: "2026-01-12" });
  });
  it("skips periods ended before `from`, stops at `max`, and repeats exactly", () => {
    expect(generatePeriods(s, { from: "2026-01-12", through: "2026-01-26", max: 60 }).map(p => p.start)).toEqual(["2026-01-12", "2026-01-19", "2026-01-26"]);
    expect(generatePeriods(s, { through: "2027-01-01", max: 2 }).length).toBe(2);
    expect(generatePeriods(s, { through: "2026-06-01", max: 60 })).toEqual(generatePeriods(s, { through: "2026-06-01", max: 60 }));
    expect(generatePeriods(s, { through: "2026-01-04", max: 60 })).toEqual([]);
  });
});

describe("P2 — a schedule that cannot generate a calendar is refused by name", () => {
  it("accepts each well-formed frequency", () => {
    for (const s of [base({}), base({ frequency: "biweekly" }), base({ frequency: "custom", periodLengthDays: 14 }), base({ frequency: "semi_monthly", anchorDate: "2026-01-16" }), base({ frequency: "monthly", anchorDate: "2026-01-28" })]) expect(validateSchedule(s), s.frequency).toEqual([]);
  });
  it("refuses bad anchors, zones, lengths and lags", () => {
    expect(validateSchedule(base({ timezone: "Mars/Olympus" })).join()).toMatch(/not a recognised IANA zone/);
    expect(validateSchedule(base({ frequency: "semi_monthly", anchorDate: "2026-01-05" })).join()).toMatch(/1st or a 16th/);
    expect(validateSchedule(base({ frequency: "monthly", anchorDate: "2026-01-29" })).join()).toMatch(/day 1–28/);
    expect(validateSchedule(base({ frequency: "custom" })).join()).toMatch(/periodLengthDays from 1 to 62/);
    expect(validateSchedule(base({ periodLengthDays: 7 })).join()).toMatch(/only to a custom schedule/);
    expect(validateSchedule(base({ cutoffLagDays: 9, paymentLagDays: 3 })).join()).toMatch(/cutoff cannot fall after the payment/);
    expect(validateSchedule(base({ anchorDate: "2026-02-30" })).join()).toMatch(/real calendar date/);
    expect(validateSchedule(base({ paymentLagDays: 61 })).join()).toMatch(/0 to 60/);
  });
});

describe("P2 — the pay-period machine", () => {
  it("allows exactly the forward edges, the two reopen steps and the void", () => {
    const ok: Array<[PayPeriodState, PayPeriodState]> = [["draft", "collecting"], ["draft", "voided"], ["collecting", "review"], ["collecting", "voided"], ["review", "approved"], ["review", "collecting"], ["approved", "processing"], ["approved", "review"], ["processing", "closed"], ["closed", "amended"], ["paid", "amended"]];
    for (const [a, b] of ok) expect(canTransitionPeriod(a, b), `${a}→${b}`).toBe(true);
    const no: Array<[PayPeriodState, PayPeriodState]> = [["collecting", "approved"], ["review", "processing"], ["approved", "voided"], ["approved", "collecting"], ["processing", "approved"], ["closed", "collecting"], ["closed", "voided"], ["voided", "collecting"], ["amended", "closed"], ["paid", "closed"]];
    for (const [a, b] of no) expect(canTransitionPeriod(a, b), `${a}→${b}`).toBe(false);
  });
  it("names the states the way the owner's brief does", () => {
    expect([PERIOD_STATE_LABEL.collecting, PERIOD_STATE_LABEL.review, PERIOD_STATE_LABEL.approved, PERIOD_STATE_LABEL.processing, PERIOD_STATE_LABEL.closed, PERIOD_STATE_LABEL.voided, PERIOD_STATE_LABEL.amended]).toEqual(["OPEN", "REVIEWING", "APPROVED", "PROCESSING", "FINALIZED", "VOIDED", "CORRECTED"]);
    expect(PERIOD_STATE_LABEL.paid).toBe("FINALIZED");
  });
  it("takes earnings only while open, runs while open or reviewing, and locks from approval", () => {
    expect(periodAcceptsEarnings("collecting")).toBe(true);
    expect(periodAcceptsEarnings("review")).toBe(false);
    expect(periodAcceptsRuns("review")).toBe(true);
    expect(periodAcceptsRuns("approved")).toBe(false);
    for (const s of ["approved", "processing", "closed", "paid", "amended", "voided"] as const) expect(periodIsLocked(s), s).toBe(true);
    for (const s of ["draft", "collecting", "review"] as const) expect(periodIsLocked(s), s).toBe(false);
  });
  it("guards approval, finalization and voiding by what references the period", () => {
    expect(approveReadiness(["review", "approved"]).ready).toBe(true);
    expect(approveReadiness(["collecting", "review"]).reasons[0]).toMatch(/still collecting/);
    expect(finalizeReadiness([]).ready).toBe(true);
    expect(finalizeReadiness(["paid", "closed"]).ready).toBe(true);
    expect(finalizeReadiness(["paid", "processing"]).reasons[0]).toMatch(/not paid yet \(processing\)/);
    expect(voidReadiness({ runCount: 0, earningCount: 0 }).ready).toBe(true);
    expect(voidReadiness({ runCount: 1, earningCount: 2 }).reasons).toEqual(["1 pay run(s) reference this period", "2 earning(s) reference this period"]);
    expect(voidReadiness({ runCount: 0, earningCount: 0, timeEntryCount: 1 }).reasons).toEqual(["1 time entry reference this period"]);
  });
});
