/**
 * B23.2 — Scheduling Intelligence composes; it does not decide again. Every date fixed.
 */
import { describe, expect, it } from "vitest";
import { assessSchedule, earliestFree, rankAssessments, type ScheduleInput } from "./schedulingIntelligence";
import { determine, type Clocks, type HosRuleProfile } from "./hos";
import type { AvailabilityResult } from "./calendarEvents";

const T = (h: number, m = 0) => new Date(Date.UTC(2027, 3, 12, h, m));
const WINDOW = { from: T(6), to: T(18) };
const availability = (status: AvailabilityResult["status"], windows: AvailabilityResult["windows"] = []): AvailabilityResult =>
  ({ userId: 7, from: WINDOW.from, to: WINDOW.to, status, windows, note: "" });
const clocks = (shiftElapsed: number, drive = 300): Clocks => ({ shiftElapsedMinutes: shiftElapsed, dailyDriveMinutes: drive, dailyOnDutyMinutes: shiftElapsed, shiftDriveMinutes: drive, shiftOnDutyMinutes: shiftElapsed, cycle1OnDutyMinutes: 1000, cycle2OnDutyMinutes: 1000, continuousDriveMinutes: 60 } as unknown as Clocks);
const profile = (verified: boolean): HosRuleProfile => ({
  profileKey: "CA_FEDERAL_SOUTH60", verificationStatus: verified ? "verified" : "unverified", sourceCitation: "SOR/2005-313",
  limits: [
    { limitKey: "shift_elapsed_minutes", value: 840, verificationStatus: verified ? "verified" : "unverified", sourceSection: "s. 13" },
    { limitKey: "daily_drive_minutes", value: 780, verificationStatus: verified ? "verified" : "unverified", sourceSection: "s. 12" },
  ],
} as unknown as HosRuleProfile);
const base = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  candidate: { userId: 7, label: "Dylan" }, unit: { unitId: 147, label: "Unit 147" }, window: WINDOW,
  estimatedDurationMinutes: 8 * 60, estimatedDriveMinutes: 240,
  availability: availability("AVAILABLE"),
  hos: { determination: determine(clocks(120), profile(true)), asOf: T(6), ref: "HOS-7" },
  readiness: { verdict: "eligible", blockers: [], ref: "RDY-147" },
  now: T(5), ...over,
});

describe("the sentence dispatch reads", () => {
  it("is FEASIBLE when every engine is fine, and says from when and until when", () => {
    const a = assessSchedule(base());
    expect(a.verdict).toBe("FEASIBLE");
    expect(a.availableFrom).toEqual(T(6));
    expect(a.dutyWindowEndsAt).toEqual(T(18));   // 840 − 120 = 720 min after 06:00
    expect(a.summary).toBe("Dylan and Unit 147 are available for this job from 06:00Z, and the projected duty window ends 18:00Z after the projected finish.");
    expect(a.findings.map(f => [f.engine, f.state])).toEqual([["calendar", "ok"], ["hos", "ok"], ["hos", "ok"], ["readiness", "ok"]]);
  });

  it("is NOT_FEASIBLE when the remaining hours cannot cover the projected job, in the sentence from the brief", () => {
    // 600 min elapsed against 840: 240 min remain from 06:00, so the window ends 10:00 and an 8 h job cannot finish.
    const a = assessSchedule(base({ hos: { determination: determine(clocks(600), profile(true)), asOf: T(6), ref: "HOS-7" } }));
    expect(a.verdict).toBe("NOT_FEASIBLE");
    expect(a.dutyWindowEndsAt).toEqual(T(10));
    expect(a.summary).toMatch(/^Dylan and Unit 147 are available, but the remaining hours of service .* mean the projected job cannot finish before the duty window ends at 10:00Z — short by 240 min/);
    expect(a.summary).toMatch(/Projected from the clock, not a determination/);
    expect(a.findings.find(f => f.engine === "hos" && f.state === "block")!.ref).toBe("HOS-7");
  });

  it("is UNKNOWN, not feasible, when the HOS rule is unverified, and says why", () => {
    const a = assessSchedule(base({ hos: { determination: determine(clocks(120), profile(false)), asOf: T(6), ref: "HOS-7" } }));
    expect(a.verdict).toBe("UNKNOWN");
    expect(a.dutyWindowEndsAt).toBeNull();
    expect(a.summary).toMatch(/cannot say — Hours of service: CA_FEDERAL_SOUTH60 is unverified/);
    expect(assessSchedule(base({ hos: null })).findings.find(f => f.engine === "hos")).toMatchObject({ state: "unknown", line: expect.stringMatching(/No hours-of-service determination/) });
  });

  it("an exceeded limit blocks in the engine's own words", () => {
    const a = assessSchedule(base({ hos: { determination: determine(clocks(900), profile(true)), asOf: T(6), ref: "HOS-7" } }));
    expect(a.verdict).toBe("NOT_FEASIBLE");
    expect(a.findings.find(f => f.engine === "hos")!.line).toMatch(/exceeded by 60 min/);
  });

  it("the driving estimate is compared through the HOS engine's own feasibility, and its absence is unknown", () => {
    const tooFar = assessSchedule(base({ estimatedDriveMinutes: 600, hos: { determination: determine(clocks(120, 300), profile(true)), asOf: T(6), ref: "HOS-7" } }));
    expect(tooFar.verdict).toBe("NOT_FEASIBLE");
    expect(tooFar.findings.find(f => f.line.startsWith("Driving:"))!.line).toMatch(/cannot be completed legally/);
    const none = assessSchedule(base({ estimatedDriveMinutes: null }));
    expect(none.verdict).toBe("UNKNOWN");
    expect(none.findings.find(f => f.line.startsWith("Driving:"))!.state).toBe("unknown");
  });
});

describe("the calendar", () => {
  it("a private appointment narrows the window with its span and its basis; the job starts after it when it fits, and is blocked when it does not", () => {
    const fits = assessSchedule(base({ availability: availability("UNAVAILABLE", [{ from: T(6), to: T(8), status: "UNAVAILABLE", basis: "calendarEvent" }]), estimatedDurationMinutes: 4 * 60 }));
    expect(fits.availableFrom).toEqual(T(8));
    expect(fits.verdict).toBe("FEASIBLE_WITH_REVIEW");
    expect(fits.findings[0]).toMatchObject({ engine: "calendar", state: "review", line: "Unavailable 06:00Z–08:00Z (calendarEvent); what for is not part of this answer." });
    expect(JSON.stringify(fits)).not.toMatch(/Dentist/);
    const tooLong = assessSchedule(base({ availability: availability("UNAVAILABLE", [{ from: T(6), to: T(8), status: "UNAVAILABLE", basis: "calendarEvent" }]), estimatedDurationMinutes: 11 * 60 }));
    expect(tooLong.verdict).toBe("NOT_FEASIBLE");
    expect(tooLong.summary).toMatch(/are free from 08:00Z, but free from 08:00Z, but a 660 min job does not fit before 18:00Z \(the end of the window\)/);
    const between = assessSchedule(base({ availability: availability("UNAVAILABLE", [{ from: T(6), to: T(7), status: "UNAVAILABLE", basis: "calendarEvent" }, { from: T(10), to: T(12), status: "ASSIGNED", basis: "resourceBooking" }]), estimatedDurationMinutes: 4 * 60 }));
    expect(between.verdict).toBe("NOT_FEASIBLE");
    expect(between.findings.find(f => f.state === "block")).toMatchObject({ engine: "dispatch", line: expect.stringMatching(/does not fit before 10:00Z \(resourceBooking\)/) });
  });

  it("a booking is dispatch's, and a whole window taken says so", () => {
    const a = assessSchedule(base({ availability: availability("ASSIGNED", [{ from: T(5), to: T(19), status: "ASSIGNED", basis: "resourceBooking" }]) }));
    expect(a.availableFrom).toBeNull();
    expect(a.findings.map(f => f.engine)).toContain("dispatch");
    expect(a.summary).toBe("Dylan and Unit 147: The whole window is spoken for.");
    expect(a.findings[0]).toMatchObject({ engine: "dispatch", state: "review", line: "Already booked 05:00Z–19:00Z (resourceBooking)." });
  });

  it("nobody established that the person is working: UNKNOWN; rostered off: review", () => {
    expect(assessSchedule(base({ availability: availability("UNKNOWN") })).verdict).toBe("UNKNOWN");
    const off = assessSchedule(base({ availability: availability("OFF_DUTY") }));
    expect(off.verdict).toBe("FEASIBLE_WITH_REVIEW");
    expect(off.summary).toMatch(/could take this job from 06:00Z, with review: Rostered off/);
  });

  it("earliestFree walks the taken spans in order", () => {
    expect(earliestFree(WINDOW, [{ from: T(6), to: T(8), status: "UNAVAILABLE" }, { from: T(8), to: T(9), status: "ASSIGNED" }, { from: T(12), to: T(13), status: "UNAVAILABLE" }])).toEqual(T(9));
    expect(earliestFree(WINDOW, [{ from: T(7), to: T(8), status: "UNAVAILABLE" }])).toEqual(T(6));
    expect(earliestFree(WINDOW, [{ from: T(6), to: T(18), status: "ASSIGNED" }])).toBeNull();
  });
});

describe("equipment", () => {
  it("a blocked unit blocks, review reviews, unknown is unknown, and no unit named is unknown", () => {
    expect(assessSchedule(base({ readiness: { verdict: "blocked", blockers: [{ code: "critical_defect", label: "Open critical defect on this unit", severity: "blocking" }], ref: "RDY" } })).summary).toMatch(/but unit 147 with Dylan: blocked — Open critical defect/);
    expect(assessSchedule(base({ readiness: { verdict: "eligible_review", blockers: [{ code: "x", label: "Medical review due", severity: "review" }], ref: "RDY" } })).verdict).toBe("FEASIBLE_WITH_REVIEW");
    expect(assessSchedule(base({ readiness: { verdict: "unknown", blockers: [], ref: "RDY" } })).verdict).toBe("UNKNOWN");
    expect(assessSchedule(base({ unit: null, readiness: null })).findings.find(f => f.engine === "readiness")!.line).toMatch(/No unit named/);
  });
});

describe("ranking", () => {
  it("feasible first, then review, unknown, not feasible; earlier availability wins inside a rank", () => {
    const ranked = rankAssessments([
      assessSchedule(base({ candidate: { userId: 1, label: "A" }, hos: null })),
      assessSchedule(base({ candidate: { userId: 2, label: "B" }, availability: availability("UNAVAILABLE", [{ from: T(6), to: T(7), status: "UNAVAILABLE", basis: "leaveRequest" }]), estimatedDurationMinutes: 60 })),
      assessSchedule(base({ candidate: { userId: 3, label: "C" } })),
      assessSchedule(base({ candidate: { userId: 4, label: "D" }, hos: { determination: determine(clocks(900), profile(true)), asOf: T(6), ref: "H" } })),
      assessSchedule(base({ candidate: { userId: 5, label: "E" }, availability: availability("OFF_DUTY") })),
    ]);
    // E is rostered off but free from 06:00; B is free only from 07:00 — earlier availability wins inside the review rank.
    expect(ranked.map(r => [r.candidate.label, r.verdict])).toEqual([["C", "FEASIBLE"], ["E", "FEASIBLE_WITH_REVIEW"], ["B", "FEASIBLE_WITH_REVIEW"], ["A", "UNKNOWN"], ["D", "NOT_FEASIBLE"]]);
  });
});
