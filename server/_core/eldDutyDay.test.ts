/**
 * ELD checkpoint 2c — the designated duty day, as arithmetic, and what the engine does with it.
 *
 * Every instant below is worked out by hand from the zone's published rules and written as a
 * literal. The DST cases depend on the IANA database the runtime carries, so the first test pins the
 * version the gate's Node build ships (2026c): a different database could move a transition, and
 * then these expectations must be re-derived rather than "fixed".
 *
 *   America/Winnipeg 2026: CST −06:00 until Sun 8 Mar 02:00 → CDT −05:00 until Sun 1 Nov 02:00 → CST.
 *   America/Regina: CST −06:00 all year.
 *   America/Edmonton, tzdata 2026c: −06:00 from 8 Mar 2026 with no return in November.
 */
import { describe, expect, it } from "vitest";
import { canonicalTimezone, dutyDayClocks, dutyDayWindow, isKnownTimezone, offsetMinutesAt, zonedLocalToInstant, type DutyDayEntry } from "./eld/dutyDay";
import { evaluateHos, HOS_ENGINE_VERSION, type HosEngineInput } from "./eld/hosEngine";
import { HOS_REASON_CODES } from "./eld/reasonCodes";
import type { LedgerEventLike } from "./eld/hosProjection";
import type { HosLimit, HosRuleProfile, LimitKey } from "./hos";

const Z = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("the runtime's timezone database", () => {
  it("is the version these expectations were derived from", () => {
    expect(process.versions.tz).toBe("2026c");
  });

  it("knows zones by their canonical name or an alias, and refuses what is not a place", () => {
    expect(canonicalTimezone("America/Edmonton")).toBe("America/Edmonton");
    expect(canonicalTimezone("america/edmonton")).toBe("America/Edmonton");
    expect(canonicalTimezone("US/Pacific")).toBe("America/Los_Angeles");
    expect(canonicalTimezone("+05:00")).toBeNull();          // ICU would accept it; a fixed offset keeps no DST rules
    expect(canonicalTimezone("-0600")).toBeNull();
    expect(canonicalTimezone("Mars/Olympus_Mons")).toBeNull();
    expect(canonicalTimezone("")).toBeNull();
    expect(isKnownTimezone("America/Winnipeg")).toBe(true);
    expect(isKnownTimezone("Not/AZone")).toBe(false);
  });

  it("reads the offsets either side of a transition", () => {
    expect(offsetMinutesAt(Z("2026-03-08T07:59:00Z").getTime(), "America/Winnipeg")).toBe(-360);
    expect(offsetMinutesAt(Z("2026-03-08T08:00:00Z").getTime(), "America/Winnipeg")).toBe(-300);
    expect(offsetMinutesAt(Z("2026-11-01T06:59:00Z").getTime(), "America/Winnipeg")).toBe(-300);
    expect(offsetMinutesAt(Z("2026-11-01T07:00:00Z").getTime(), "America/Winnipeg")).toBe(-360);
  });
});

describe("a local wall time becomes one instant", () => {
  it("maps an ordinary time directly", () => {
    expect(iso(new Date(zonedLocalToInstant(2026, 7, 14, 360, "America/Regina")))).toBe("2026-07-14T12:00:00.000Z");
  });
  it("moves a skipped time forward by the gap (02:30 on spring-forward night is 03:30 CDT)", () => {
    expect(iso(new Date(zonedLocalToInstant(2026, 3, 8, 150, "America/Winnipeg")))).toBe("2026-03-08T08:30:00.000Z");
  });
  it("takes the earlier of a repeated time (01:30 on fall-back night is 01:30 CDT)", () => {
    expect(iso(new Date(zonedLocalToInstant(2026, 11, 1, 90, "America/Winnipeg")))).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("the duty day containing an instant", () => {
  it("is 24 hours on an ordinary day, and starts the previous local date when the instant is before the start", () => {
    const w = dutyDayWindow(Z("2026-07-15T03:00:00Z"), { timezone: "America/Regina", dayStartMinutes: 360 });   // 21:00 local on the 14th
    expect([iso(w.from), iso(w.to), w.lengthMinutes, w.localDate]).toEqual(["2026-07-14T12:00:00.000Z", "2026-07-15T12:00:00.000Z", 1440, "2026-07-14"]);
    expect(w.tzVersion).toBe("2026c");
  });

  it("is 23 hours on a spring-forward day", () => {
    const w = dutyDayWindow(Z("2026-03-08T12:00:00Z"), { timezone: "America/Winnipeg", dayStartMinutes: 0 });
    expect([iso(w.from), iso(w.to), w.lengthMinutes, w.localDate]).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z", 1380, "2026-03-08"]);
  });

  it("is 25 hours on a fall-back day", () => {
    const w = dutyDayWindow(Z("2026-11-01T12:00:00Z"), { timezone: "America/Winnipeg", dayStartMinutes: 0 });
    expect([iso(w.from), iso(w.to), w.lengthMinutes, w.localDate]).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z", 1500, "2026-11-01"]);
  });

  it("starts a day whose start time was skipped at the end of the gap, and the day before keeps 24 hours", () => {
    const d = dutyDayWindow(Z("2026-03-08T09:00:00Z"), { timezone: "America/Winnipeg", dayStartMinutes: 150 });
    expect([iso(d.from), iso(d.to), d.lengthMinutes, d.localDate]).toEqual(["2026-03-08T08:30:00.000Z", "2026-03-09T07:30:00.000Z", 1380, "2026-03-08"]);
    const before = dutyDayWindow(Z("2026-03-08T08:29:00Z"), { timezone: "America/Winnipeg", dayStartMinutes: 150 });
    expect([iso(before.from), iso(before.to), before.lengthMinutes, before.localDate]).toEqual(["2026-03-07T08:30:00.000Z", "2026-03-08T08:30:00.000Z", 1440, "2026-03-07"]);
  });

  it("starts a day whose start time happens twice at the first occurrence, so the local clock can read earlier than the start", () => {
    // 07:00Z is 01:00 CST — the clock reads before 01:30, but 01:30 already happened once, at 06:30Z.
    const w = dutyDayWindow(Z("2026-11-01T07:00:00Z"), { timezone: "America/Winnipeg", dayStartMinutes: 90 });
    expect([iso(w.from), iso(w.to), w.lengthMinutes, w.localDate]).toEqual(["2026-11-01T06:30:00.000Z", "2026-11-02T07:30:00.000Z", 1500, "2026-11-01"]);
  });

  it("follows the database: Edmonton keeps −06:00 through November 2026 under 2026c, so its 1 November is 24 hours", () => {
    const w = dutyDayWindow(Z("2026-11-01T12:00:00Z"), { timezone: "America/Edmonton", dayStartMinutes: 0 });
    expect([iso(w.from), iso(w.to), w.lengthMinutes]).toEqual(["2026-11-01T06:00:00.000Z", "2026-11-02T06:00:00.000Z", 1440]);
  });

  it("refuses an unknown zone or an impossible start rather than falling back to UTC or midnight", () => {
    expect(() => dutyDayWindow(Z("2026-07-01T00:00:00Z"), { timezone: "Mars/Olympus_Mons", dayStartMinutes: 0 })).toThrow(RangeError);
    expect(() => dutyDayWindow(Z("2026-07-01T00:00:00Z"), { timezone: "America/Regina", dayStartMinutes: 1440 })).toThrow(RangeError);
    expect(() => dutyDayWindow(Z("2026-07-01T00:00:00Z"), { timezone: "America/Regina", dayStartMinutes: 30.5 })).toThrow(RangeError);
  });
});

describe("the four clocks over the designated day", () => {
  const e = (s: DutyDayEntry["dutyStatus"], from: string, to: string | null): DutyDayEntry => ({ dutyStatus: s, startedAt: Z(from), endedAt: to ? Z(to) : null });

  it("counts each status inside the day and up to the instant, and reports the unrecorded part instead of filling it", () => {
    // Regina, day from 06:00 local = 12:00Z on the 14th; asked at 02:00Z on the 15th, so 840 minutes have elapsed.
    const entries = [
      e("off_duty", "2026-07-14T08:00:00Z", "2026-07-14T13:00:00Z"),       // 60 inside the day
      e("on_duty", "2026-07-14T13:00:00Z", "2026-07-14T13:30:00Z"),        // 30
      e("driving", "2026-07-14T13:30:00Z", "2026-07-14T18:00:00Z"),        // 270
      //                                                                       18:00–18:30 nothing on record: 30
      e("sleeper_berth", "2026-07-14T18:30:00Z", "2026-07-14T20:00:00Z"),  // 90
      e("driving", "2026-07-14T20:00:00Z", null),                           // open: 360 up to 02:00Z
    ];
    const c = dutyDayClocks(entries, Z("2026-07-15T02:00:00Z"), { timezone: "America/Regina", dayStartMinutes: 360 });
    expect(iso(c.countedUntil)).toBe("2026-07-15T02:00:00.000Z");
    expect({ d: c.drivingMinutes, on: c.onDutyMinutes, off: c.offDutyMinutes, sb: c.sleeperMinutes, gap: c.unrecordedMinutes })
      .toEqual({ d: 630, on: 660, off: 60, sb: 90, gap: 30 });
  });

  it("counts more than 24 hours in a 25-hour day", () => {
    const c = dutyDayClocks([e("off_duty", "2026-10-31T20:00:00Z", null)], Z("2026-11-02T05:30:00Z"), { timezone: "America/Winnipeg", dayStartMinutes: 0 });
    expect(c.window.lengthMinutes).toBe(1500);
    expect(c.offDutyMinutes).toBe(1470);
    expect(c.unrecordedMinutes).toBe(0);
  });
});

/* ================================================================== */

const OP = 7;
const t = (hhmm: string) => new Date(`2026-09-11T${hhmm}:00Z`);
const AT = t("18:00");
let seq = 0;
const duty = (ref: string, hhmm: string, s: NonNullable<LedgerEventLike["dutyStatus"]>): LedgerEventLike => ({
  eventRef: ref, deviceSequence: seq++, operatorId: OP, eventType: "duty_status_change", eventCode: null,
  dutyStatus: s, eventAt: t(hhmm), supersedesEventRef: null,
});
/** The same working day as eldHos.test.ts: off 02:00, on 10:00, drive 10:30, on 15:30, drive 16:00–open; asked at 18:00Z. */
const DAY = () => { seq = 0; return [duty("E0", "02:00", "off_duty"), duty("E1", "10:00", "on_duty"), duty("E2", "10:30", "driving"), duty("E3", "15:30", "on_duty"), duty("E4", "16:00", "driving")]; };
const lim = (limitKey: LimitKey, value: number): HosLimit => ({ limitKey, value, sourceSection: "synthetic", verificationStatus: "verified" });
/** A synthetic, VERIFIED profile. Not regulatory data. */
const SYN: HosRuleProfile = {
  profileKey: "SYN", label: "Synthetic test profile — not regulatory data",
  applicability: { authorityLevel: "provincial", jurisdiction: "ZZ", latitudeRule: null, minimumWeightKg: null, operationClass: null },
  limits: [lim("daily_drive_minutes", 300), lim("daily_on_duty_minutes", 840), lim("break_required_after_drive_minutes", 240)],
  sourceAuthority: "test fixture", sourceCitation: "synthetic", verificationStatus: "verified",
};
const input = (o: Partial<HosEngineInput> = {}): HosEngineInput => ({
  operatorId: OP, events: DAY(), dutyDay: null, profiles: [SYN], at: AT,
  context: { carrierAuthority: "provincial", jurisdiction: "ZZ", latitude: 53.5, at: AT }, ...o,
});
const REGINA_MIDNIGHT = { timezone: "America/Regina", dayStartMinutes: 0, designationRef: "ELDDD-TEST", effectiveFrom: Z("2026-09-01T00:00:00Z") };

describe("the engine with a designated duty day", () => {
  it("is version 2c", () => {
    expect(HOS_ENGINE_VERSION).toBe("hos-engine/2c");
    expect(evaluateHos(input()).engineVersion).toBe("hos-engine/2c");
  });

  it("without a designation shows no duty day and says the zone is unknown and the day undefined", () => {
    const r = evaluateHos(input());
    expect(r.dutyDay).toBeNull();
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["HOS_TIMEZONE_UNKNOWN", "HOS_DAY_BOUNDARY_UNKNOWN"]));
    expect(r.reasonCodes).not.toContain("HOS_DAY_RULE_UNVERIFIED");
  });

  it("shows the designated day's clocks, counted by hand from the timeline", () => {
    // Regina midnight = 06:00Z. Up to 18:00Z: off 06:00–10:00 (240), on 10:00–10:30 + 15:30–16:00 (60), drive 10:30–15:30 + 16:00–18:00 (420).
    const r = evaluateHos(input({ dutyDay: REGINA_MIDNIGHT }));
    expect(r.dutyDay).toMatchObject({ drivingMinutes: 420, onDutyMinutes: 480, offDutyMinutes: 240, sleeperMinutes: 0, unrecordedMinutes: 0, designationRef: "ELDDD-TEST", designationChangedDuringDay: false });
    expect([iso(r.dutyDay!.window.from), iso(r.dutyDay!.window.to), r.dutyDay!.window.localDate]).toEqual(["2026-09-11T06:00:00.000Z", "2026-09-12T06:00:00.000Z", "2026-09-11"]);
    expect(r.reasonCodes).not.toContain("HOS_TIMEZONE_UNKNOWN");
  });

  it("counts a different day when the day starts at a different hour", () => {
    // 08:00 Regina = 14:00Z. Drive 14:00–15:30 + 16:00–18:00 (210), on 15:30–16:00 (30).
    const r = evaluateHos(input({ dutyDay: { ...REGINA_MIDNIGHT, dayStartMinutes: 480 } }));
    expect(r.dutyDay).toMatchObject({ drivingMinutes: 210, onDutyMinutes: 240, offDutyMinutes: 0, unrecordedMinutes: 0 });
  });

  it("still gives no verdict on a verified daily figure, even one the designated day's count exceeds, and says why", () => {
    // 420 driven in the designated day against a verified 300: no violation, because no verified rule says the limit is counted over this day.
    const r = evaluateHos(input({ dutyDay: REGINA_MIDNIGHT }));
    expect(r.violations).toEqual([]);
    expect(r.verdict).toBe("unknown");
    expect(r.unknowns.find(u => u.limitKey === "daily_drive_minutes")).toMatchObject({ code: "HOS_DAY_RULE_UNVERIFIED", limitMinutes: null });
    expect(r.unknowns.find(u => u.limitKey === "daily_on_duty_minutes")).toMatchObject({ code: "HOS_DAY_RULE_UNVERIFIED" });
    expect(r.reasonCodes).not.toContain("HOS_DAY_BOUNDARY_UNKNOWN");
    expect(r.remaining.drivingMinutes).toBeNull();
    expect(r.remaining.onDutyMinutes).toBeNull();
    // The rule that depends on no day is decided exactly as before.
    expect(r.determination.determinations.find(d => d.limitKey === "break_required_after_drive_minutes")).toMatchObject({ result: "within", remainingMinutes: 120 });
  });

  it("says when the designation in force took effect after the day began", () => {
    const r = evaluateHos(input({ dutyDay: { ...REGINA_MIDNIGHT, effectiveFrom: t("12:00") } }));
    expect(r.dutyDay!.designationChangedDuringDay).toBe(true);
  });

  it("treats a designation whose zone the runtime no longer knows as no zone, never as UTC", () => {
    const r = evaluateHos(input({ dutyDay: { ...REGINA_MIDNIGHT, timezone: "Gone/Removed_Zone" } }));
    expect(r.dutyDay).toBeNull();
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["HOS_TIMEZONE_UNKNOWN", "HOS_DAY_BOUNDARY_UNKNOWN"]));
  });

  it("emits only registered reason codes", () => {
    const r = evaluateHos(input({ dutyDay: REGINA_MIDNIGHT }));
    for (const c of [...r.reasonCodes, ...r.unknowns.map(u => u.code), ...r.violations.map(v => v.code)]) expect(HOS_REASON_CODES).toContain(c);
  });
});
