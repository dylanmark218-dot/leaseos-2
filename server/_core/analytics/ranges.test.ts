/**
 * What "today" means is a function of the zone, and the answer says which zone it used.
 */
import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_DAYS, RangeRefused, resolveRange, startOfLocalDay } from "./ranges";

const iso = (d: Date) => d.toISOString();

describe("calendar ranges in a stated zone", () => {
  it("defaults to UTC and says so", () => {
    const r = resolveRange({ label: "today" }, new Date("2026-09-24T15:00:00Z"));
    expect(r.zone).toBe("UTC");
    expect([iso(r.from), iso(r.to)]).toEqual(["2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z"]);
    expect(r.calendar).toBe("calendar");
  });

  it("puts 9 p.m. in Alberta on the Alberta day, not on tomorrow's UTC day", () => {
    const now = new Date("2026-09-24T03:00:00Z"); // 21:00 on the 23rd, Mountain Daylight Time
    const local = resolveRange({ label: "today", zone: "America/Edmonton" }, now);
    expect([iso(local.from), iso(local.to)]).toEqual(["2026-09-23T06:00:00.000Z", "2026-09-24T06:00:00.000Z"]);
    const utc = resolveRange({ label: "today" }, now);
    expect(iso(utc.from)).toBe("2026-09-24T00:00:00.000Z");
  });

  it("handles a half-hour zone ahead of UTC", () => {
    const r = resolveRange({ label: "today", zone: "Asia/Kolkata" }, new Date("2026-09-24T20:00:00Z")); // 01:30 on the 25th
    expect([iso(r.from), iso(r.to)]).toEqual(["2026-09-24T18:30:00.000Z", "2026-09-25T18:30:00.000Z"]);
  });

  it("accepts a fixed offset", () => {
    const r = resolveRange({ label: "today", zone: "-07:00" }, new Date("2026-09-24T03:00:00Z"));
    expect([iso(r.from), iso(r.to)]).toEqual(["2026-09-23T07:00:00.000Z", "2026-09-24T07:00:00.000Z"]);
  });

  it("gives a daylight-saving day its real length, from the runtime's zone data rather than a rule written here", () => {
    // 2025, deliberately: a past transition is history and cannot be legislated away. The 2026 autumn
    // change in Edmonton was — the pinned tz data (2026c) has Alberta staying on daylight time from
    // November 2026, and this test asserted the old rule until the runtime corrected it.
    const fall = resolveRange({ label: "today", zone: "America/Edmonton" }, new Date("2025-11-02T18:00:00Z"));
    expect([iso(fall.from), iso(fall.to)]).toEqual(["2025-11-02T06:00:00.000Z", "2025-11-03T07:00:00.000Z"]);
    const spring = resolveRange({ label: "today", zone: "America/Edmonton" }, new Date("2025-03-09T18:00:00Z"));
    expect([iso(spring.from), iso(spring.to)]).toEqual(["2025-03-09T07:00:00.000Z", "2025-03-10T06:00:00.000Z"]);
    expect(iso(startOfLocalDay({ y: 2025, m: 3, d: 9 }, "America/Edmonton"))).toBe("2025-03-09T07:00:00.000Z");
  });

  it("makes yesterday end exactly where today begins, so a record at the boundary belongs to one day", () => {
    const now = new Date("2026-09-24T15:00:00Z");
    const y = resolveRange({ label: "yesterday", zone: "America/Edmonton" }, now);
    const t = resolveRange({ label: "today", zone: "America/Edmonton" }, now);
    expect(y.to.getTime()).toBe(t.from.getTime());
  });

  it("ends every to-date range at the start of tomorrow, so the same question in one day names one interval", () => {
    const morning = resolveRange({ label: "month_to_date", zone: "America/Edmonton" }, new Date("2026-09-24T14:00:00Z"));
    const evening = resolveRange({ label: "month_to_date", zone: "America/Edmonton" }, new Date("2026-09-25T04:00:00Z"));
    expect([iso(morning.from), iso(morning.to)]).toEqual([iso(evening.from), iso(evening.to)]);
    expect(iso(morning.from)).toBe("2026-09-01T06:00:00.000Z");
  });

  it("counts the 7- and 30-day ranges including today", () => {
    const now = new Date("2026-09-24T15:00:00Z");
    expect(iso(resolveRange({ label: "last_7_days" }, now).from)).toBe("2026-09-18T00:00:00.000Z");
    expect(iso(resolveRange({ label: "last_30_days" }, now).from)).toBe("2026-08-26T00:00:00.000Z");
  });

  it("starts the quarter and the year on the calendar", () => {
    const now = new Date("2026-09-24T15:00:00Z");
    expect(iso(resolveRange({ label: "quarter_to_date" }, now).from)).toBe("2026-07-01T00:00:00.000Z");
    expect(iso(resolveRange({ label: "year_to_date" }, now).from)).toBe("2026-01-01T00:00:00.000Z");
    expect(iso(resolveRange({ label: "quarter_to_date" }, new Date("2026-01-02T12:00:00Z")).from)).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("refusals rather than guesses", () => {
  const now = new Date("2026-09-24T15:00:00Z");
  it("refuses a zone the runtime cannot resolve, naming it", () => {
    expect(() => resolveRange({ label: "today", zone: "Mountain" }, now)).toThrow(RangeRefused);
    expect(() => resolveRange({ label: "today", zone: "Mountain" }, now)).toThrow(/Mountain/);
  });
  it("needs both ends of a custom range, in order, within the limit", () => {
    expect(() => resolveRange({ label: "custom", from: now }, now)).toThrow(/both from and to/);
    expect(() => resolveRange({ label: "custom", from: now, to: now }, now)).toThrow(/end after it starts/);
    const far = new Date(now.getTime() + (MAX_CUSTOM_DAYS + 1) * 86_400_000);
    expect(() => resolveRange({ label: "custom", from: now, to: far }, now)).toThrow(/at most/);
  });
  it("does not let from/to quietly override a named range", () => {
    expect(() => resolveRange({ label: "today", from: now }, now)).toThrow(/custom range/);
  });
  it("returns a custom range exactly as asked", () => {
    const from = new Date("2026-01-10T00:00:00Z"), to = new Date("2026-01-11T00:00:00Z");
    expect(resolveRange({ label: "custom", from, to, zone: "America/Edmonton" }, now)).toEqual({ label: "custom", from, to, zone: "America/Edmonton", calendar: "calendar" });
  });
});
