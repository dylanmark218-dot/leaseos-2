/**
 * 0170 — reminders: the lifecycle, the snooze, the ladder that never climbs for a personal one,
 * the device replay, and the command contract a voice layer calls.
 */
import { describe, expect, it } from "vitest";
import {
  acknowledge, advanceIfRecurring, cancel, channelsFor, computeFireAt, escalationFor, fire, isDue, isMissed, markMissed, notificationKeyFor,
  parseEscalationPolicy, planDeviceActions, reschedule, snooze, snoozeUntil, toDeviceEntry, validateReminderInput, MAX_COMPLIANCE_SNOOZES,
  type ReminderInput, type ReminderShape,
} from "./reminders";
import { nextWeekdayAt, planReminder, tomorrowAt } from "./reminderCommands";
import { zonedParts, zonedToUtc } from "./recurrence";
import type { NotificationState } from "./escalation";

const TZ = "America/Edmonton";
const NOW = new Date("2027-04-10T15:00:00Z");   // 09:00 in Edmonton (MDT)
const local = (y: number, m: number, d: number, hh: number, mm = 0) => zonedToUtc({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0 }, TZ);
const shown = (at: Date) => { const p = zonedParts(at, TZ); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };

const reminder = (over: Partial<ReminderShape> = {}): ReminderShape => ({
  reminderRef: "RMD-1", kind: "personal", level: "normal", state: "scheduled", ownerUserId: 7, fireAt: new Date("2027-04-10T14:00:00Z"),
  lastFiredAt: null, requiresAcknowledgement: false, missedAfterMinutes: 60, snoozeCount: 0, timezone: TZ, recurrence: null, escalationPolicy: null, ...over,
});
const input = (over: Partial<ReminderInput> = {}): ReminderInput => ({
  kind: "personal", level: "normal", ownerUserId: 7, createdByUserId: 7, relativeTo: "none", offsetMinutes: null, at: new Date("2027-04-11T12:00:00Z"),
  subjectAt: null, recurrence: null, escalationPolicy: null, requiresAcknowledgement: false, ...over,
});

describe("what a reminder may be", () => {
  it("a personal reminder never carries an escalation policy, and says so", () => {
    const problems = validateReminderInput(input({ escalationPolicy: { policyRef: "x", levels: [{ afterMinutes: 0, roles: ["dispatcher"] }], mandatoryRoles: [] }, requiresAcknowledgement: true }));
    expect(problems).toContain("A personal reminder never escalates; it may not carry an escalation policy");
  });

  it("compliance is a company level and requires acknowledgement", () => {
    expect(validateReminderInput(input({ level: "compliance", requiresAcknowledgement: true })).join(" ")).toMatch(/Compliance is a company level/);
    expect(validateReminderInput(input({ kind: "company", createdByUserId: 1, level: "compliance", requiresAcknowledgement: false })).join(" ")).toMatch(/requires acknowledgement by definition/);
    expect(validateReminderInput(input({ kind: "company", createdByUserId: 1, level: "compliance", requiresAcknowledgement: true }))).toEqual([]);
  });

  it("a relative reminder needs the time it is relative to", () => {
    expect(computeFireAt({ relativeTo: "task_due", offsetMinutes: -30, at: null, subjectAt: null, recurrence: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/needs that time to exist first/) });
    const r = computeFireAt({ relativeTo: "task_due", offsetMinutes: -30, at: null, subjectAt: new Date("2027-04-11T12:00:00Z"), recurrence: null });
    expect(r.ok && r.fireAt.toISOString()).toBe("2027-04-11T11:30:00.000Z");
  });
});

describe("the lifecycle", () => {
  it("fires when due and not before", () => {
    expect(isDue(reminder(), NOW)).toBe(true);
    expect(isDue(reminder({ fireAt: new Date("2027-04-10T16:00:00Z") }), NOW)).toBe(false);
    expect(fire(reminder({ fireAt: new Date("2027-04-10T16:00:00Z") }), NOW).ok).toBe(false);
    const f = fire(reminder(), NOW);
    expect(f.ok && f.changes).toMatchObject({ state: "fired", lastFiredAt: NOW });
  });

  it("acknowledges a fired one-off; advances a fired recurring one to its next occurrence", () => {
    const a = acknowledge(reminder({ state: "fired", lastFiredAt: NOW }), NOW);
    expect(a.ok && a.changes.state).toBe("acknowledged");
    const weekly = reminder({ state: "fired", lastFiredAt: NOW, fireAt: local(2027, 4, 9, 17), recurrence: { frequency: "weekly", byWeekday: [5], timezone: TZ, anchorAt: local(2027, 4, 9, 17) } });
    const adv = acknowledge(weekly, NOW);
    expect(adv.ok && adv.action).toBe("advanced");
    expect(adv.ok && shown(adv.changes.fireAt!)).toBe("2027-04-16 17:00");
    expect(advanceIfRecurring(reminder(), NOW)).toBeNull();
  });

  it("missed is a fired reminder that required an answer and got none in time", () => {
    const needsAck = reminder({ state: "fired", lastFiredAt: NOW, requiresAcknowledgement: true, missedAfterMinutes: 30 });
    expect(isMissed(needsAck, new Date(NOW.getTime() + 29 * 60_000))).toBe(false);
    expect(isMissed(needsAck, new Date(NOW.getTime() + 30 * 60_000))).toBe(true);
    // No acknowledgement required: it simply stays fired.
    expect(isMissed(reminder({ state: "fired", lastFiredAt: NOW }), new Date(NOW.getTime() + 3_600_000))).toBe(false);
    const m = markMissed(needsAck, new Date(NOW.getTime() + 3_600_000));
    expect(m.ok && m.changes.state).toBe("missed");
  });

  it("reschedules into the future only, cancels once", () => {
    expect(reschedule(reminder(), new Date("2027-04-10T14:59:00Z"), NOW).ok).toBe(false);
    const r = reschedule(reminder({ state: "snoozed", snoozeCount: 2 }), new Date("2027-04-12T12:00:00Z"), NOW);
    expect(r.ok && r.changes).toMatchObject({ state: "scheduled", snoozedUntil: null });
    expect(cancel(reminder(), NOW).ok).toBe(true);
    expect(cancel(reminder({ state: "cancelled" }), NOW).ok).toBe(false);
  });
});

describe("snooze", () => {
  it("offers the presets, tonight, tomorrow and a custom time", () => {
    const at = (o: ReturnType<typeof snoozeUntil>) => o.ok ? o.until : null;
    expect(at(snoozeUntil({ kind: "preset", preset: "5m" }, NOW, TZ))!.toISOString()).toBe("2027-04-10T15:05:00.000Z");
    expect(at(snoozeUntil({ kind: "preset", preset: "1h" }, NOW, TZ))!.toISOString()).toBe("2027-04-10T16:00:00.000Z");
    expect(shown(at(snoozeUntil({ kind: "tonight" }, NOW, TZ))!)).toBe("2027-04-10 20:00");
    expect(shown(at(snoozeUntil({ kind: "tomorrow" }, NOW, TZ))!)).toBe("2027-04-11 08:00");
    expect(snoozeUntil({ kind: "custom", at: new Date("2027-04-10T14:00:00Z") }, NOW, TZ).ok).toBe(false);
  });

  it("'tonight' after eight in the evening is an hour, not tomorrow night", () => {
    const late = local(2027, 4, 10, 21);
    const o = snoozeUntil({ kind: "tonight" }, late, TZ);
    expect(o.ok && o.until.toISOString()).toBe(new Date(late.getTime() + 3_600_000).toISOString());
  });

  it("the semantic choices are reserved, not guessed", () => {
    const o = snoozeUntil({ kind: "after_current_job" }, NOW, TZ);
    expect(o).toMatchObject({ ok: false, deferred: true });
  });

  it("a compliance reminder records each snooze and refuses the fourth", () => {
    const comp = reminder({ kind: "company", level: "compliance", state: "fired", lastFiredAt: NOW, requiresAcknowledgement: true, snoozeCount: MAX_COMPLIANCE_SNOOZES - 1 });
    const third = snooze(comp, { kind: "preset", preset: "15m" }, NOW);
    expect(third.ok && third.changes).toMatchObject({ state: "snoozed", snoozeCount: MAX_COMPLIANCE_SNOOZES });
    expect(snooze({ ...comp, snoozeCount: MAX_COMPLIANCE_SNOOZES }, { kind: "preset", preset: "15m" }, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/may be snoozed 3 times/) });
    // An ordinary reminder snoozes as often as its owner likes.
    expect(snooze(reminder({ state: "fired", snoozeCount: 40 }), { kind: "preset", preset: "5m" }, NOW).ok).toBe(true);
  });
});

describe("the ladder", () => {
  const policy = { policyRef: "p", levels: [{ afterMinutes: 0, roles: ["assignee"] }, { afterMinutes: 30, roles: ["dispatcher"] }], mandatoryRoles: [] };
  const note = (o: Partial<NotificationState> = {}): NotificationState => ({ notificationKey: "n", recipientRole: "assignee", recipientUserId: 7, channel: "in_app", status: "delivered", sentAt: NOW, viewedAt: null, acknowledgedAt: null, ...o });

  it("never climbs for a personal reminder, whatever it carries", () => {
    expect(escalationFor(reminder({ state: "fired", lastFiredAt: NOW, escalationPolicy: policy }), [note()], new Date(NOW.getTime() + 3_600_000))).toBeNull();
  });

  it("climbs for a company reminder with a policy, from the last firing", () => {
    const r = reminder({ kind: "company", state: "fired", lastFiredAt: NOW, requiresAcknowledgement: true, escalationPolicy: policy });
    expect(escalationFor(r, [note()], new Date(NOW.getTime() + 10 * 60_000))!.toNotify).toEqual([]);
    expect(escalationFor(r, [note()], new Date(NOW.getTime() + 31 * 60_000))!.toNotify).toEqual(["dispatcher"]);
    expect(escalationFor(r, [note({ status: "acknowledged", acknowledgedAt: NOW })], new Date(NOW.getTime() + 31 * 60_000))!.acknowledged).toBe(true);
    expect(escalationFor(reminder({ kind: "company", state: "fired", lastFiredAt: NOW }), [], NOW)).toBeNull();
  });

  it("parses a stored policy and refuses a malformed one rather than escalating to nobody", () => {
    expect(parseEscalationPolicy(JSON.stringify(policy))!.levels).toHaveLength(2);
    expect(parseEscalationPolicy("{not json")).toBeNull();
    expect(parseEscalationPolicy(JSON.stringify({ policyRef: "p", levels: [] }))).toBeNull();
  });
});

describe("delivery keys and channels", () => {
  it("derives one key per firing per channel", () => {
    expect(notificationKeyFor("RMD-1", NOW, "in_app")).toBe("reminder:RMD-1:2027-04-10T15:00:00.000Z:in_app");
    expect(channelsFor("normal")).toEqual(["in_app"]);
    expect(channelsFor("compliance")).toEqual(["in_app", "push"]);
  });
});

describe("the device", () => {
  it("hands the phone what it needs to notify locally and nothing that decides", () => {
    const e = toDeviceEntry({ ...reminder({ level: "alarm" }), version: 3, title: "Bring respirator", body: null, deepLink: null, subjectKind: "standalone", subjectRef: null });
    expect(e).toMatchObject({ reminderRef: "RMD-1", version: 3, localNotification: true, fireAt: "2027-04-10T14:00:00.000Z" });
    expect(e.snoozeChoices).toContain("tomorrow");
    expect(toDeviceEntry({ ...reminder(), version: 1, title: "t", body: null, deepLink: null, subjectKind: "standalone", subjectRef: null }).localNotification).toBe(false);
  });

  it("applies a replayed batch once, in device order, and calls repeats duplicates rather than errors", () => {
    const t = (s: number) => new Date(NOW.getTime() + s * 1000);
    const plan = planDeviceActions([
      { actionRef: "a2", reminderRef: "RMD-1", action: "acknowledged", occurredAt: t(20) },
      { actionRef: "a1", reminderRef: "RMD-1", action: "snoozed", occurredAt: t(10), snoozeChoice: { kind: "preset", preset: "5m" } },
      { actionRef: "a1", reminderRef: "RMD-1", action: "snoozed", occurredAt: t(10), snoozeChoice: { kind: "preset", preset: "5m" } },
      { actionRef: "old", reminderRef: "RMD-1", action: "completed", occurredAt: t(5) },
      { actionRef: "bad", reminderRef: "RMD-1", action: "snoozed", occurredAt: t(30) },
    ], new Set(["old"]));
    expect(plan.apply.map(a => a.actionRef)).toEqual(["a1", "a2"]);
    expect(plan.duplicates).toEqual(["old", "a1"]);
    expect(plan.malformed).toEqual([{ actionRef: "bad", reason: "a snooze names its choice" }]);
  });
});

describe("the command contract", () => {
  it("'remind me tomorrow at 6 AM to bring my respirator' — the parser resolves the instant; the plan reads it back", () => {
    const at = tomorrowAt(6, 0, NOW, TZ);
    expect(shown(at)).toBe("2027-04-11 06:00");
    const p = planReminder({ what: "Bring my respirator", when: { kind: "absolute", at } }, { now: NOW, timezone: TZ });
    expect(p.ok && p.plan).toMatchObject({ title: "Bring my respirator", relativeTo: "none", fireAt: at, readBack: "Remind you to Bring my respirator at 2027-04-11 06:00 America/Edmonton" });
  });

  it("'remind me 30 minutes before my shift' needs the roster, and says so when it has none", () => {
    const none = planReminder({ what: "Check tire pressures", when: { kind: "relative_to_shift", offsetMinutes: -30 } }, { now: NOW, timezone: TZ });
    expect(none).toMatchObject({ ok: false, needs: "nextShiftStartAt" });
    const shift = local(2027, 4, 11, 5, 30);
    const p = planReminder({ what: "Check tire pressures", when: { kind: "relative_to_shift", offsetMinutes: -30 } }, { now: NOW, timezone: TZ, nextShiftStartAt: shift });
    expect(p.ok && shown(p.plan.fireAt)).toBe("2027-04-11 05:00");
    expect(p.ok && p.plan.readBack).toMatch(/30 minutes before your shift/);
  });

  it("'every Friday remind me to submit my fuel receipts' is a weekly rule anchored to the next Friday", () => {
    const anchor = nextWeekdayAt(5, 17, 0, NOW, TZ);
    expect(shown(anchor)).toBe("2027-04-16 17:00");
    const p = planReminder({ what: "Submit fuel receipts", when: { kind: "recurring", rule: { frequency: "weekly", byWeekday: [5], timezone: TZ, anchorAt: anchor } } }, { now: NOW, timezone: TZ });
    expect(p.ok && p.plan.recurrence?.frequency).toBe("weekly");
    expect(p.ok && p.plan.readBack).toBe("Remind you to Submit fuel receipts every Friday at 17:00 America/Edmonton");
  });

  it("'two weeks before my H2S expires' counts back from the credential's own date, and refuses when there is none", () => {
    const cmd = { what: "Book H2S renewal", when: { kind: "before_source" as const, sourceType: "workerQualification", sourceRef: "WQ-9", offsetDays: 14 } };
    expect(planReminder(cmd, { now: NOW, timezone: TZ })).toMatchObject({ ok: false, needs: "sourceDates[workerQualification:WQ-9]" });
    expect(planReminder(cmd, { now: NOW, timezone: TZ, sourceDates: { "workerQualification:WQ-9": null } })).toMatchObject({ ok: false, reason: expect.stringMatching(/no date recorded/) });
    const p = planReminder(cmd, { now: NOW, timezone: TZ, sourceDates: { "workerQualification:WQ-9": new Date("2027-06-01T00:00:00Z") } });
    expect(p.ok && p.plan).toMatchObject({ relativeTo: "source_date", sourceType: "workerQualification", sourceRef: "WQ-9", fireAt: new Date("2027-05-18T00:00:00Z") });
  });

  it("'after this job' and 'when I get back to the yard' are deferred, not guessed", () => {
    expect(planReminder({ what: "Wash out unit 14", when: { kind: "after_job", jobRef: "JOB-1" } }, { now: NOW, timezone: TZ })).toMatchObject({ ok: false, needs: "jobEstimatedEndAt[JOB-1]" });
    expect(planReminder({ what: "Hand in disposal tickets", when: { kind: "on_return_to_yard" } }, { now: NOW, timezone: TZ })).toMatchObject({ ok: false, needs: "geofence" });
  });

  it("is deterministic: the same command in the same context plans the same reminder", () => {
    const cmd = { what: "Bring my respirator", when: { kind: "absolute" as const, at: tomorrowAt(6, 0, NOW, TZ) } };
    expect(planReminder(cmd, { now: NOW, timezone: TZ })).toEqual(planReminder(cmd, { now: NOW, timezone: TZ }));
  });
});
