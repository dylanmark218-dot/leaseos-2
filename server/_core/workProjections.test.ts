/**
 * 0170 — the adapters consume what the other engines decided and add nothing of their own.
 */
import { describe, expect, it } from "vitest";
import { fromCredentialExpiry, fromDispatchBooking, fromDocumentOutstanding, fromHosDetermination, fromMaintenanceDue, fromPayPeriod, fromSafetyMeeting, mergeProposals } from "./workProjections";
import { determine, type Clocks, type HosRuleProfile } from "./hos";

const NOW = new Date("2027-04-10T15:00:00Z");
const clocks: Clocks = { dailyDriveMinutes: 600, dailyOnDutyMinutes: 700, shiftDriveMinutes: 600, shiftOnDutyMinutes: 700, shiftElapsedMinutes: 780, cycle1OnDutyMinutes: 3800, cycle2OnDutyMinutes: 3800, continuousDriveMinutes: 100, offDutyMinutesInWindow: 120, longestRestMinutes: 480, dailyOffDutyMinutes: 480 } as unknown as Clocks;
const profile = (verified: boolean): HosRuleProfile => ({
  profileKey: "CA_FEDERAL_SOUTH60", verificationStatus: verified ? "verified" : "unverified", sourceCitation: "SOR/2005-313", limits: [
    { limitKey: "shift_elapsed_minutes", value: 840, verificationStatus: verified ? "verified" : "unverified", sourceSection: "s. 13" },
    { limitKey: "cycle_1_on_duty_minutes", value: 4200, verificationStatus: verified ? "verified" : "unverified", sourceSection: "s. 24" },
  ],
} as unknown as HosRuleProfile);

describe("HOS: the calendar consumes the determination and never computes compliance", () => {
  it("an unverified rule projects UNKNOWN, shown rather than skipped", () => {
    const p = fromHosDetermination({ determination: determine(clocks, profile(false)), asOf: NOW, ownerUserId: 7, sourceRef: "HOS-1" });
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ state: "projected", severity: "unknown", title: "Hours of service: not determined" });
    expect(p.tasks).toEqual([]);
  });

  it("a verified within-limit determination projects the end of the window as PROJECTED, with the remaining minutes the engine gave", () => {
    const d = determine(clocks, profile(true));
    expect(d.verdict).toBe("within");
    const p = fromHosDetermination({ determination: d, asOf: NOW, ownerUserId: 7, sourceRef: "HOS-1" });
    const windowEnd = p.entries.find(e => e.title.startsWith("Shift elapsed"))!;
    expect(windowEnd.state).toBe("projected");
    expect(windowEnd.at.toISOString()).toBe(new Date(NOW.getTime() + 60 * 60_000).toISOString());   // 840 − 780
    expect(windowEnd.severity).toBe("due");
    expect(windowEnd.detail).toMatch(/The HOS engine, not this arithmetic, decides compliance/);
    const cycle = p.entries.find(e => e.title.startsWith("Cycle 1"))!;
    expect(cycle.state).toBe("recommended");   // 400 min left, inside the 8 h advisory band
    expect(p.entries.every(e => e.source.sourceType === "hosDetermination")).toBe(true);
  });

  it("an exceeded limit is REQUIRED rest, blocking, in the engine's own words", () => {
    const d = determine({ ...clocks, shiftElapsedMinutes: 900 } as Clocks, profile(true));
    expect(d.verdict).toBe("exceeded");
    const p = fromHosDetermination({ determination: d, asOf: NOW, ownerUserId: 7, sourceRef: "HOS-1" });
    expect(p.entries[0]).toMatchObject({ state: "required", severity: "blocking" });
    expect(p.entries[0]!.detail).toBe(d.explanation);
  });
});

describe("credentials", () => {
  it("a verified expiry inside the notice window projects the event, the renewal task and the reminder; an unverified one projects nothing", () => {
    const p = fromCredentialExpiry({ holdingRef: "WQ-1", code: "H2S", expiresAt: new Date("2027-05-01T00:00:00Z"), verified: true, ownerUserId: 7, blocksWork: true, renewalNoticeDays: 30, now: NOW });
    expect(p.entries[0]).toMatchObject({ state: "required", severity: "due", title: "H2S expires" });
    expect(p.tasks[0]).toMatchObject({ title: "Renew H2S", priority: "high", requiresCompletionEvidence: true, dedupeKey: "workerQualification:WQ-1:renewal", deepLink: "/workerQualification/WQ-1" });
    expect(p.reminders).toEqual([]);   // 30 days before 1 May has already passed on 10 April
    expect(fromCredentialExpiry({ holdingRef: "WQ-2", code: "H2S", expiresAt: new Date("2027-05-01T00:00:00Z"), verified: false, ownerUserId: 7, blocksWork: true, renewalNoticeDays: 30, now: NOW }).entries).toEqual([]);
  });

  it("no expiry is unknown, not fine, and proposes no task on a date nobody established", () => {
    const p = fromCredentialExpiry({ holdingRef: "WQ-3", code: "TDG", expiresAt: null, verified: true, ownerUserId: 7, blocksWork: true, renewalNoticeDays: 30, now: NOW });
    expect(p.entries[0]).toMatchObject({ severity: "unknown", state: "projected", title: "TDG — no expiry recorded" });
    expect(p.tasks).toEqual([]);
  });

  it("a reminder is set when the notice date is still ahead", () => {
    const p = fromCredentialExpiry({ holdingRef: "WQ-4", code: "First Aid", expiresAt: new Date("2027-05-05T00:00:00Z"), verified: true, ownerUserId: 7, blocksWork: false, renewalNoticeDays: 20, now: NOW });
    expect(p.reminders[0]).toMatchObject({ fireAt: new Date("2027-04-15T00:00:00Z"), level: "important" });
  });
});

describe("payroll, dispatch, fleet, documents, safety", () => {
  it("a collecting period with no time in is REQUIRED with a task and a reminder; once submitted it is a plain date", () => {
    const open = fromPayPeriod({ periodRef: "PP-1", endsOn: new Date("2027-04-15T00:00:00Z"), cutoffAt: null, paydayAt: new Date("2027-04-22T00:00:00Z"), state: "collecting", ownerUserId: 7, timesheetSubmitted: false, now: NOW });
    expect(open.entries.map(e => [e.title, e.state])).toEqual([["Payroll cutoff — time due", "required"], ["Payday", "confirmed"]]);
    expect(open.tasks[0]).toMatchObject({ dedupeKey: "payPeriod:PP-1:timesheet:7", dueAt: new Date("2027-04-15T00:00:00Z") });
    expect(open.reminders[0]!.fireAt).toEqual(new Date("2027-04-14T00:00:00Z"));
    const done = fromPayPeriod({ periodRef: "PP-1", endsOn: new Date("2027-04-15T00:00:00Z"), cutoffAt: null, paydayAt: null, state: "collecting", ownerUserId: 7, timesheetSubmitted: true, now: NOW });
    expect(done.tasks).toEqual([]);
    expect(done.entries[0]!.state).toBe("confirmed");
  });

  it("a tentative booking is PROJECTED, a confirmed one CONFIRMED, a released one CANCELLED", () => {
    const b = (bookingState: "tentative" | "confirmed" | "released") => fromDispatchBooking({ bookingRef: "RB-1", jobRef: "JOB-1", title: "Water haul", startsAt: NOW, endsAt: new Date(NOW.getTime() + 8 * 3_600_000), bookingState, ownerUserId: 7 }).entries[0]!;
    expect(b("tentative")).toMatchObject({ state: "projected", title: "Water haul (tentative)" });
    expect(b("confirmed").state).toBe("confirmed");
    expect(b("released")).toMatchObject({ state: "cancelled", title: "Released — Water haul" });
  });

  it("a CVIP due in a week proposes an evidenced task; one with no date is unknown and proposes nothing", () => {
    const due = fromMaintenanceDue({ unitRef: "147", kind: "cvip", dueAt: new Date("2027-04-17T00:00:00Z"), ownerUserId: 9, blocksWork: true, now: NOW });
    expect(due.tasks[0]).toMatchObject({ title: "CVIP for unit 147", requiresCompletionEvidence: true, dedupeKey: "unit:147:cvip:2027-04-17" });
    const none = fromMaintenanceDue({ unitRef: "147", kind: "service", dueAt: null, ownerUserId: 9, blocksWork: false, now: NOW });
    expect(none.entries[0]!.severity).toBe("unknown");
    expect(none.tasks).toEqual([]);
  });

  it("an outstanding disposal ticket is a task that opens the job", () => {
    const p = fromDocumentOutstanding({ documentKind: "disposal_ticket", jobRef: "25148", dueAt: new Date("2027-04-11T00:00:00Z"), ownerUserId: 7, now: NOW });
    expect(p.tasks[0]).toMatchObject({ title: "Upload disposal ticket for job 25148", deepLink: "/job/25148", requiresCompletionEvidence: true });
    expect(p.entries[0]!.layer).toBe("paperwork");
  });

  it("a mandatory stand-down is due until acknowledged; a toolbox talk is informational", () => {
    expect(fromSafetyMeeting({ meetingRef: "SM-1", title: "Stand-down", startsAt: new Date("2027-04-12T13:00:00Z"), endsAt: null, ownerUserId: 7, mandatory: true, acknowledged: false, now: NOW }).entries[0]).toMatchObject({ state: "required", severity: "due" });
    expect(fromSafetyMeeting({ meetingRef: "SM-2", title: "Toolbox", startsAt: new Date("2027-04-12T13:00:00Z"), endsAt: null, ownerUserId: 7, mandatory: false, acknowledged: false, now: NOW }).entries[0]).toMatchObject({ state: "confirmed", severity: "informational" });
  });

  it("merging keeps one task per dedupe key and sorts entries by time", () => {
    const a = fromDocumentOutstanding({ documentKind: "disposal_ticket", jobRef: "1", dueAt: new Date("2027-04-13T00:00:00Z"), ownerUserId: 7, now: NOW });
    const b = fromDocumentOutstanding({ documentKind: "disposal_ticket", jobRef: "1", dueAt: new Date("2027-04-11T00:00:00Z"), ownerUserId: 7, now: NOW });
    const m = mergeProposals([a, b]);
    expect(m.tasks).toHaveLength(1);
    expect(m.entries.map(e => e.at.toISOString())).toEqual(["2027-04-11T00:00:00.000Z", "2027-04-13T00:00:00.000Z"]);
  });
});
