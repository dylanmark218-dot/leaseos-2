/**
 * HOS phase 2a — from the ELD ledger to a determination, pure.
 *
 * What these assert is the discipline between the pieces, not the pieces: that a correction retracts
 * and never edits, that a cycle of corrections is reported rather than guessed, that nothing is
 * counted for personal conveyance or a yard move without a verified rule, and above all that a
 * verified figure produces no verdict and no remaining figure while the boundary it is counted in is
 * a default. Every expected minute is worked out by hand from the fixture timeline and written as a
 * literal; nothing here recomputes an expectation with the engine.
 */
import { describe, expect, it } from "vitest";
import { projectDutyEntries, activeEvents, type LedgerEventLike } from "./eld/hosProjection";
import { evaluateHos, HOS_ENGINE_VERSION, type HosEngineInput } from "./eld/hosEngine";
import { HOS_REASON_CODES } from "./eld/reasonCodes";
import { ALL_HOS_PROFILE_SEEDS } from "./hosRuleSeeds";
import type { HosLimit, HosRuleProfile, LimitKey } from "./hos";

const OP = 7;
const t = (hhmm: string) => new Date(`2026-09-11T${hhmm}:00Z`);
const AT = t("18:00");

let seq = 0;
const ev = (ref: string, o: Partial<LedgerEventLike>): LedgerEventLike => ({
  eventRef: ref, deviceSequence: seq++, operatorId: OP, eventType: "duty_status_change", eventCode: null,
  dutyStatus: null, eventAt: AT, supersedesEventRef: null, ...o,
});
const duty = (ref: string, hhmm: string, s: NonNullable<LedgerEventLike["dutyStatus"]>) => ev(ref, { dutyStatus: s, eventAt: t(hhmm) });
const correction = (ref: string, hhmm: string, target: string) => ev(ref, { eventType: "correction", eventAt: t(hhmm), supersedesEventRef: target });

/**
 * The working day every engine case uses. Hand-computed at 18:00:
 *   off 02:00–10:00 (480)  on 10:00–10:30 (30)  drive 10:30–15:30 (300)  on 15:30–16:00 (30)  drive 16:00–open (120)
 *   shift begins 10:00 (the 480-minute rest ends it)
 *   shift drive 420 · shift on-duty 480 · shift elapsed 480 · continuous drive 120 · rolling-24h drive 420
 */
const DAY = () => {
  seq = 0;
  return [duty("E0", "02:00", "off_duty"), duty("E1", "10:00", "on_duty"), duty("E2", "10:30", "driving"), duty("E3", "15:30", "on_duty"), duty("E4", "16:00", "driving")];
};

const lim = (limitKey: LimitKey, value: number): HosLimit => ({ limitKey, value, sourceSection: "synthetic", verificationStatus: "verified" });
/** A synthetic, VERIFIED profile. Not regulatory data: the figures exist to exercise the engine. */
const synthetic = (limits: HosLimit[], key = "SYN"): HosRuleProfile => ({
  profileKey: key, label: "Synthetic test profile — not regulatory data",
  applicability: { authorityLevel: "provincial", jurisdiction: "ZZ", latitudeRule: null, minimumWeightKg: null, operationClass: null },
  limits, sourceAuthority: "test fixture", sourceCitation: "synthetic", verificationStatus: "verified",
});
const input = (events: LedgerEventLike[], profiles: HosRuleProfile[], o: Partial<HosEngineInput> = {}): HosEngineInput => ({
  operatorId: OP, events, homeTerminalTimezone: null, profiles, at: AT,
  context: { carrierAuthority: "provincial", jurisdiction: "ZZ", latitude: 53.5, at: AT }, ...o,
});

/* ================================================================== */

describe("the projection turns the ledger into duty entries without inventing any", () => {
  it("makes one entry per active duty status, each running to the next, the last one open", () => {
    const p = projectDutyEntries(OP, DAY());
    expect(p.entries.map(e => [e.dutyStatus, e.startedAt.toISOString().slice(11, 16), e.endedAt?.toISOString().slice(11, 16) ?? null])).toEqual([
      ["off_duty", "02:00", "10:00"], ["on_duty", "10:00", "10:30"], ["driving", "10:30", "15:30"], ["on_duty", "15:30", "16:00"], ["driving", "16:00", null],
    ]);
    expect(p.entryEventRefs).toEqual(["E0", "E1", "E2", "E3", "E4"]);
    expect(p.reasonCodes).toContain("HOS_OPEN_STATUS");
  });

  it("orders by the device's clock, then its sequence, whatever order the rows arrive in", () => {
    const rows = DAY();
    const shuffled = [rows[3]!, rows[0]!, rows[4]!, rows[2]!, rows[1]!];
    expect(projectDutyEntries(OP, shuffled)).toEqual(projectDutyEntries(OP, rows));
  });

  it("answers with nothing, and says so, when the ledger holds no duty status", () => {
    const p = projectDutyEntries(OP, [ev("P", { eventType: "engine_power_up", eventAt: t("09:00") })]);
    expect(p.entries).toEqual([]);
    expect(p.reasonCodes).toContain("HOS_NO_DUTY_RECORD");
  });

  it("ignores another operator's rows and unidentified rows, and counts them rather than dropping them silently", () => {
    seq = 0;
    const p = projectDutyEntries(OP, [duty("A", "08:00", "on_duty"), { ...duty("B", "09:00", "driving"), operatorId: 99 }, { ...duty("U", "09:30", "driving"), operatorId: null }]);
    expect(p.entryEventRefs).toEqual(["A"]);
    expect(p.ignoredForeignEvents).toBe(2);
  });
});

describe("a correction retracts; it never edits", () => {
  it("leaves the corrected event out, uses the replacement the device recorded, and does not touch the rows", () => {
    seq = 0;
    const rows = [duty("E0", "08:00", "off_duty"), duty("E1", "09:00", "driving"), correction("C", "09:05", "E1"), duty("R", "09:00", "on_duty")];
    const before = JSON.parse(JSON.stringify(rows));
    const p = projectDutyEntries(OP, rows);
    expect(p.entryEventRefs).toEqual(["E0", "R"]);
    expect(p.entries.map(e => e.dutyStatus)).toEqual(["off_duty", "on_duty"]);
    expect(p.supersededEventRefs).toEqual(["E1"]);
    expect(p.correctionsApplied).toEqual([{ correctionEventRef: "C", supersedesEventRef: "E1" }]);
    expect(p.reasonCodes).toContain("HOS_CORRECTION_APPLIED");
    expect(JSON.parse(JSON.stringify(rows))).toEqual(before);          // the ledger rows are exactly as they were
  });

  it("restores the original when the correction is itself retracted", () => {
    seq = 0;
    const rows = [duty("E0", "08:00", "off_duty"), duty("E1", "09:00", "driving"), correction("C", "09:05", "E1"), correction("C2", "09:10", "C")];
    const p = projectDutyEntries(OP, rows);
    expect(p.entryEventRefs).toEqual(["E0", "E1"]);
    expect(p.supersededEventRefs).toEqual(["C"]);
    expect(p.correctionsApplied).toEqual([{ correctionEventRef: "C2", supersedesEventRef: "C" }]);
  });

  it("reports corrections that name each other in a cycle, treats them as active, and gives the same answer in any order", () => {
    seq = 0;
    const rows = [duty("E0", "08:00", "on_duty"), correction("A", "09:00", "B"), correction("B", "09:01", "A")];
    const p = projectDutyEntries(OP, rows);
    expect(p.correctionCycles).toEqual(["A", "B"]);
    expect(p.supersededEventRefs).toEqual([]);
    expect(p.correctionsApplied).toEqual([]);
    expect(p.reasonCodes).toContain("HOS_CORRECTION_CYCLE");
    expect(activeEvents([...rows].reverse()).cyclic).toEqual(["A", "B"]);
    expect(activeEvents([...rows].reverse()).superseded).toEqual([]);
  });

  it("does nothing, and says so, for a correction whose target is outside the window", () => {
    seq = 0;
    const p = projectDutyEntries(OP, [duty("E0", "08:00", "on_duty"), correction("C", "09:00", "OUTSIDE")]);
    expect(p.correctionsWithoutTarget).toEqual(["C"]);
    expect(p.entryEventRefs).toEqual(["E0"]);
  });
});

describe("personal conveyance and yard moves are reported, not counted", () => {
  it("leaves the duty entries alone and names the unmapped segments", () => {
    seq = 0;
    const rows = [
      duty("E0", "08:00", "off_duty"),
      ev("PC", { eventType: "special_category_change", eventCode: "personal_conveyance", eventAt: t("09:00") }),
      ev("PCend", { eventType: "special_category_change", eventCode: "none", eventAt: t("09:40") }),
    ];
    const p = projectDutyEntries(OP, rows);
    expect(p.entries.map(e => e.dutyStatus)).toEqual(["off_duty"]);
    expect(p.specialCategories).toEqual([{ category: "personal_conveyance", startedAt: t("09:00"), endedAt: t("09:40"), eventRef: "PC" }]);
    expect(p.reasonCodes).toContain("HOS_SPECIAL_CATEGORY_UNMAPPED");
  });
});

/* ================================================================== */

describe("the engine states a number only when everything behind it is verified", () => {
  const FULL = synthetic([
    lim("shift_drive_minutes", 600), lim("shift_on_duty_minutes", 840), lim("shift_elapsed_minutes", 960),
    lim("daily_drive_minutes", 780), lim("core_rest_minutes", 480), lim("break_required_after_drive_minutes", 240),
  ]);

  it("counts the clocks from the ledger exactly as a person would from the timeline", () => {
    const r = evaluateHos(input(DAY(), [FULL]));
    expect(r.engineVersion).toBe(HOS_ENGINE_VERSION);
    expect(r.mechanicsKey).toBe("trailing_window");
    expect(r.clocks).toMatchObject({ shiftDriveMinutes: 420, shiftOnDutyMinutes: 480, shiftElapsedMinutes: 480, continuousDriveMinutes: 120, dailyDriveMinutes: 420, lastRestMinutes: 480, currentStatus: "driving", currentStatusMinutes: 120 });
    expect(r.currentStatus).toBe("driving");
    expect(r.timeInCurrentStatusMinutes).toBe(120);
  });

  it("determines shift limits once the rest that ends a shift is verified, and states remaining from them only", () => {
    const r = evaluateHos(input(DAY(), [FULL]));
    const by = (k: string) => r.determination.determinations.find(d => d.limitKey === k)!;
    expect(by("shift_drive_minutes")).toMatchObject({ result: "within", usedMinutes: 420, limitMinutes: 600, remainingMinutes: 180 });
    expect(by("shift_on_duty_minutes")).toMatchObject({ result: "within", remainingMinutes: 360 });
    expect(by("shift_elapsed_minutes")).toMatchObject({ result: "within", remainingMinutes: 480 });
    expect(by("break_required_after_drive_minutes")).toMatchObject({ result: "within", usedMinutes: 120, remainingMinutes: 120 });
    expect(r.remaining).toEqual({ drivingMinutes: 180, onDutyMinutes: 360, shiftWindowMinutes: 480, cycleMinutes: null, basisRuleIds: ["SYN:shift_drive_minutes", "SYN:shift_on_duty_minutes", "SYN:shift_elapsed_minutes"] });
  });

  it("refuses a verdict on a verified daily figure while the day is a rolling 24 hours, and keeps the clock", () => {
    const r = evaluateHos(input(DAY(), [FULL]));
    const daily = r.determination.determinations.find(d => d.limitKey === "daily_drive_minutes")!;
    expect(daily).toMatchObject({ result: "unknown", usedMinutes: 420, limitMinutes: null, remainingMinutes: null });
    expect(r.unknowns.find(u => u.limitKey === "daily_drive_minutes")).toMatchObject({ code: "HOS_DAY_BOUNDARY_UNKNOWN", ruleId: "SYN:daily_drive_minutes", usedMinutes: 420 });
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["HOS_DAY_BOUNDARY_UNKNOWN", "HOS_MECHANICS_DEFAULTED", "HOS_TIMEZONE_UNKNOWN", "HOS_REQUIRED_REST_UNDETERMINED"]));
    expect(r.verdict).toBe("unknown");
  });

  it("will not turn a verified daily figure into a violation under a rolling day, even when the rolling count is over", () => {
    const tight = synthetic([lim("daily_drive_minutes", 300)]);            // 420 counted against 300: over, by a rolling day
    const r = evaluateHos(input(DAY(), [tight]));
    expect(r.violations).toEqual([]);
    expect(r.verdict).toBe("unknown");
    expect(r.unknowns[0]).toMatchObject({ code: "HOS_DAY_BOUNDARY_UNKNOWN", usedMinutes: 420 });
  });

  it("does not determine shift limits when the rest that ends a shift is not a verified figure", () => {
    const noRest = synthetic([lim("shift_drive_minutes", 600)]);
    const r = evaluateHos(input(DAY(), [noRest]));
    expect(r.determination.determinations[0]).toMatchObject({ result: "unknown", usedMinutes: 420, remainingMinutes: null });
    expect(r.unknowns[0]!.code).toBe("HOS_MECHANICS_DEFAULTED");
    expect(r.remaining.drivingMinutes).toBeNull();
  });

  it("names a rest rule as undetermined rest, not as an unverified figure", () => {
    const r = evaluateHos(input(DAY(), [FULL]));
    expect(r.unknowns.find(u => u.limitKey === "core_rest_minutes")!.code).toBe("HOS_REQUIRED_REST_UNDETERMINED");
  });

  it("consumes a verified cycle-length parameter instead of reporting it as a limit, and still refuses the rolling cycle", () => {
    const cyc = synthetic([lim("cycle_1_days", 7), lim("cycle_1_on_duty_minutes", 4200)]);
    const r = evaluateHos(input(DAY(), [cyc]));
    expect(r.determination.determinations.map(d => d.limitKey)).toEqual(["cycle_1_on_duty_minutes"]);
    expect(r.unknowns[0]).toMatchObject({ limitKey: "cycle_1_on_duty_minutes", code: "HOS_MECHANICS_DEFAULTED" });
    expect(r.remaining.cycleMinutes).toBeNull();
  });
});

describe("what the engine can decide today, it decides", () => {
  it("reports a verified break rule as exceeded, keeps the observed status, and leaves the ledger rows untouched", () => {
    const rows = DAY();
    const before = JSON.parse(JSON.stringify(rows));
    const r = evaluateHos(input(rows, [synthetic([lim("break_required_after_drive_minutes", 60)])]));
    expect(r.verdict).toBe("exceeded");
    expect(r.violations).toEqual([expect.objectContaining({ code: "HOS_BREAK_REQUIRED", limitKey: "break_required_after_drive_minutes", ruleId: "SYN:break_required_after_drive_minutes", usedMinutes: 120, limitMinutes: 60 })]);
    expect(r.currentStatus).toBe("driving");
    expect(JSON.parse(JSON.stringify(rows))).toEqual(before);
  });

  it("reaches WITHIN only when every limit in the profile can be determined", () => {
    const r = evaluateHos(input(DAY(), [synthetic([lim("break_required_after_drive_minutes", 240)])]));
    expect(r.verdict).toBe("within");
    expect(r.reasonCodes).toContain("HOS_WITHIN_LIMITS");
    expect(r.unknowns).toEqual([]);
  });

  it("does not answer WITHIN for an operator with no duty record, whatever the profile says", () => {
    seq = 0;
    const r = evaluateHos(input([ev("P", { eventType: "engine_power_up", eventAt: t("09:00") })], [synthetic([lim("break_required_after_drive_minutes", 240)])]));
    expect(r.verdict).toBe("unknown");
    expect(r.reasonCodes).toContain("HOS_NO_DUTY_RECORD");
  });
});

describe("the real seeds determine nothing, because nobody has verified them", () => {
  it("shows the clocks and answers UNKNOWN on every limit of the seeded Alberta profile", () => {
    const r = evaluateHos(input(DAY(), [...ALL_HOS_PROFILE_SEEDS], { context: { carrierAuthority: "provincial", jurisdiction: "AB", registeredWeightKg: 14_000, latitude: 53.5, at: AT } }));
    expect(r.selection.outcome).toBe("selected");
    expect(r.clocks.shiftDriveMinutes).toBe(420);
    expect(r.verdict).toBe("unknown");
    expect(r.violations).toEqual([]);
    expect(r.unknowns.length).toBeGreaterThan(0);
    expect(r.unknowns.every(u => u.code === "HOS_LIMIT_UNVERIFIED")).toBe(true);
    expect(r.remaining).toEqual({ drivingMinutes: null, onDutyMinutes: null, shiftWindowMinutes: null, cycleMinutes: null, basisRuleIds: [] });
  });

  it("names the missing rung when the schedule cannot be selected", () => {
    const r = evaluateHos(input(DAY(), [...ALL_HOS_PROFILE_SEEDS], { context: { carrierAuthority: null, jurisdiction: "AB", latitude: 53.5, at: AT } }));
    expect(r.selection.outcome).toBe("unknown");
    expect(r.reasonCodes).toContain("HOS_PROFILE_UNKNOWN");
    expect(r.verdict).toBe("unknown");
    expect(r.explanation).toMatch(/No schedule is selected/);
  });
});

describe("record integrity reaches the answer", () => {
  it("flags a device chain gap that overlaps the duty window", () => {
    const r = evaluateHos(input(DAY(), [synthetic([lim("break_required_after_drive_minutes", 240)])], { chainGaps: [{ fromAt: t("11:00"), toAt: t("12:00") }] }));
    expect(r.reasonCodes).toContain("HOS_DATA_GAP");
    const clean = evaluateHos(input(DAY(), [synthetic([lim("break_required_after_drive_minutes", 240)])], { chainGaps: [{ fromAt: t("00:30"), toAt: t("01:00") }] }));
    expect(clean.reasonCodes).not.toContain("HOS_DATA_GAP");
  });

  it("is deterministic: the same rows in any order give the same result", () => {
    const a = evaluateHos(input(DAY(), [synthetic([lim("break_required_after_drive_minutes", 240)])]));
    const b = evaluateHos(input([...DAY()].reverse(), [synthetic([lim("break_required_after_drive_minutes", 240)])]));
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
  });

  it("emits only registered reason codes", () => {
    const r = evaluateHos(input(DAY(), [synthetic([lim("daily_drive_minutes", 780), lim("core_rest_minutes", 480), lim("shift_drive_minutes", 600)])], { chainGaps: [{ fromAt: null, toAt: null }] }));
    for (const c of [...r.reasonCodes, ...r.unknowns.map(u => u.code), ...r.violations.map(v => v.code)]) expect(HOS_REASON_CODES).toContain(c);
  });
});
