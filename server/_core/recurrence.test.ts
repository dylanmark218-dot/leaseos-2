/**
 * 0170 — recurrence keeps the wall clock, not the instant.
 *
 * Every date here is fixed and compared with other fixed dates; nothing reads the real clock.
 */
import { describe, expect, it } from "vitest";
import { describeRule, nextOccurrenceAfter, occurrencesBetween, validateRule, zonedParts, zonedToUtc, type RecurrenceRule } from "./recurrence";

const TZ = "America/Edmonton";
const local = (y: number, m: number, d: number, hh: number, mm = 0) => zonedToUtc({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0 }, TZ);
const shown = (at: Date) => { const p = zonedParts(at, TZ); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };

describe("wall clock in a zone", () => {
  it("round-trips a wall clock through an instant", () => {
    const at = local(2027, 1, 15, 5, 30);
    expect(shown(at)).toBe("2027-01-15 05:30");
    // Edmonton is UTC-7 in January.
    expect(at.toISOString()).toBe("2027-01-15T12:30:00.000Z");
  });

  it("resolves a wall clock inside the spring-forward gap to the instant after it", () => {
    // 2027-03-14 02:30 does not exist in Edmonton (clocks go 01:59 → 03:00).
    const at = zonedToUtc({ year: 2027, month: 3, day: 14, hour: 2, minute: 30, second: 0 }, TZ);
    expect(shown(at)).toBe("2027-03-14 03:30");
  });
});

describe("daily and weekday rules across a DST change", () => {
  it("keeps 05:30 on both sides of the change, so the instants move by an hour", () => {
    const rule: RecurrenceRule = { frequency: "daily", timezone: TZ, anchorAt: local(2027, 3, 12, 5, 30) };
    const got = occurrencesBetween(rule, local(2027, 3, 12, 0), local(2027, 3, 16, 0));
    expect(got.map(shown)).toEqual(["2027-03-12 05:30", "2027-03-13 05:30", "2027-03-14 05:30", "2027-03-15 05:30"]);
    // Before the change 05:30 MST is 12:30Z; after it 05:30 MDT is 11:30Z.
    expect(got[1]!.toISOString()).toBe("2027-03-13T12:30:00.000Z");
    expect(got[2]!.toISOString()).toBe("2027-03-14T11:30:00.000Z");
  });

  it("every weekday skips the weekend", () => {
    // 2027-06-04 is a Friday.
    const rule: RecurrenceRule = { frequency: "weekdays", timezone: TZ, anchorAt: local(2027, 6, 4, 5, 30) };
    const got = occurrencesBetween(rule, local(2027, 6, 4, 0), local(2027, 6, 9, 0));
    expect(got.map(shown)).toEqual(["2027-06-04 05:30", "2027-06-07 05:30", "2027-06-08 05:30"]);
  });

  it("every N days honours the interval", () => {
    const rule: RecurrenceRule = { frequency: "daily", intervalCount: 3, timezone: TZ, anchorAt: local(2027, 6, 1, 8) };
    expect(occurrencesBetween(rule, local(2027, 6, 1, 0), local(2027, 6, 11, 0)).map(shown)).toEqual(["2027-06-01 08:00", "2027-06-04 08:00", "2027-06-07 08:00", "2027-06-10 08:00"]);
  });
});

describe("weekly rules", () => {
  it("every Friday, from a Friday anchor", () => {
    const rule: RecurrenceRule = { frequency: "weekly", byWeekday: [5], timezone: TZ, anchorAt: local(2027, 6, 4, 17) };
    expect(occurrencesBetween(rule, local(2027, 6, 1, 0), local(2027, 6, 30, 0)).map(shown)).toEqual(["2027-06-04 17:00", "2027-06-11 17:00", "2027-06-18 17:00", "2027-06-25 17:00"]);
  });

  it("Monday and Wednesday every second week, never a day before the anchor", () => {
    // Anchor Wednesday 2027-06-02; the Monday of that week (05-31) is before the anchor and must not appear.
    const rule: RecurrenceRule = { frequency: "weekly", intervalCount: 2, byWeekday: [1, 3], timezone: TZ, anchorAt: local(2027, 6, 2, 9) };
    expect(occurrencesBetween(rule, local(2027, 5, 30, 0), local(2027, 6, 20, 0)).map(shown)).toEqual(["2027-06-02 09:00", "2027-06-14 09:00", "2027-06-16 09:00"]);
  });

  it("a window that starts after the anchor still counts occurrenceLimit from the anchor", () => {
    const rule: RecurrenceRule = { frequency: "weekly", timezone: TZ, anchorAt: local(2027, 6, 4, 17), occurrenceLimit: 3 };
    expect(occurrencesBetween(rule, local(2027, 6, 10, 0), local(2027, 8, 1, 0)).map(shown)).toEqual(["2027-06-11 17:00", "2027-06-18 17:00"]);
  });
});

describe("monthly rules", () => {
  it("the first Monday of every month", () => {
    const rule: RecurrenceRule = { frequency: "monthly", ordinalWeek: 1, ordinalWeekday: 1, timezone: TZ, anchorAt: local(2027, 6, 7, 7) };
    expect(occurrencesBetween(rule, local(2027, 6, 1, 0), local(2027, 9, 30, 0)).map(shown)).toEqual(["2027-06-07 07:00", "2027-07-05 07:00", "2027-08-02 07:00", "2027-09-06 07:00"]);
  });

  it("the last Friday of every month", () => {
    const rule: RecurrenceRule = { frequency: "monthly", ordinalWeek: -1, ordinalWeekday: 5, timezone: TZ, anchorAt: local(2027, 6, 25, 16) };
    expect(occurrencesBetween(rule, local(2027, 6, 1, 0), local(2027, 8, 31, 0)).map(shown)).toEqual(["2027-06-25 16:00", "2027-07-30 16:00", "2027-08-27 16:00"]);
  });

  it("the 31st skips months that have no 31st rather than clamping to the 30th", () => {
    const rule: RecurrenceRule = { frequency: "monthly", byMonthDay: 31, timezone: TZ, anchorAt: local(2027, 5, 31, 12) };
    expect(occurrencesBetween(rule, local(2027, 5, 1, 0), local(2027, 9, 1, 0)).map(shown)).toEqual(["2027-05-31 12:00", "2027-07-31 12:00", "2027-08-31 12:00"]);
  });

  it("stops at untilAt", () => {
    const rule: RecurrenceRule = { frequency: "monthly", byMonthDay: 1, timezone: TZ, anchorAt: local(2027, 6, 1, 12), untilAt: local(2027, 8, 1, 12) };
    expect(occurrencesBetween(rule, local(2027, 6, 1, 0), local(2027, 12, 1, 0)).map(shown)).toEqual(["2027-06-01 12:00", "2027-07-01 12:00", "2027-08-01 12:00"]);
  });
});

describe("what is refused", () => {
  it("names each problem with a rule", () => {
    const problems = validateRule({ frequency: "monthly", byMonthDay: 31, ordinalWeek: 1, ordinalWeekday: 1, byWeekday: [1], intervalCount: 0, timezone: "Mars/Olympus", anchorAt: local(2027, 1, 1, 1) });
    expect(problems.join(" | ")).toMatch(/Unknown time zone/);
    expect(problems.join(" | ")).toMatch(/intervalCount/);
    expect(problems.join(" | ")).toMatch(/byWeekday applies only to a weekly/);
    expect(problems.join(" | ")).toMatch(/not both/);
    expect(() => occurrencesBetween({ frequency: "daily", timezone: "Mars/Olympus", anchorAt: local(2027, 1, 1, 1) }, local(2027, 1, 1, 0), local(2027, 1, 2, 0))).toThrow(/Unknown time zone/);
  });

  it("an empty window is empty, not an error", () => {
    expect(occurrencesBetween({ frequency: "daily", timezone: TZ, anchorAt: local(2027, 1, 1, 1) }, local(2027, 1, 5, 0), local(2027, 1, 5, 0))).toEqual([]);
  });
});

describe("the next occurrence, and the words", () => {
  it("finds the next Friday after a Saturday", () => {
    const rule: RecurrenceRule = { frequency: "weekly", byWeekday: [5], timezone: TZ, anchorAt: local(2027, 6, 4, 17) };
    expect(shown(nextOccurrenceAfter(rule, local(2027, 6, 5, 0))!)).toBe("2027-06-11 17:00");
  });

  it("says what a rule means in plain words with the zone", () => {
    expect(describeRule({ frequency: "weekly", byWeekday: [5], timezone: TZ, anchorAt: local(2027, 6, 4, 17) })).toBe("every Friday at 17:00 America/Edmonton");
    expect(describeRule({ frequency: "monthly", ordinalWeek: 1, ordinalWeekday: 1, timezone: TZ, anchorAt: local(2027, 6, 7, 7) })).toBe("the first Monday of every month at 07:00 America/Edmonton");
    expect(describeRule({ frequency: "weekdays", timezone: TZ, anchorAt: local(2027, 6, 7, 5, 30) })).toBe("every weekday at 05:30 America/Edmonton");
  });
});
