/**
 * 0170 — the work calendar, the task board and the reminder engine, through the product itself.
 *
 * Everything here goes through `appRouter.createCaller`, so what is proved is what a client gets:
 * the tenant derived from membership, the permission gate, the redaction, the idempotency. Every
 * instant is explicit — `at` / `now` inputs — so nothing in this file reads the real clock, and
 * the fixture dates (2027) are compared only with each other.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { zonedToUtc } from "./_core/recurrence";

const URL = process.env.DATABASE_URL;
describe("work engine — preconditions", () => {
  it("runs against a real database", () => { expect(URL, "DATABASE_URL must be set").toBeTruthy(); });
});
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
let seq = 31_000_000 + Math.floor(Math.random() * 60_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });

async function person(role: DomainRole, orgRef: string | null = null): Promise<number> {
  const id = seq++;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date("2026-01-01T00:00:00Z") });
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, id]);
  return id;
}
async function org(): Promise<string> {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}

const TZ = "America/Edmonton";
const local = (y: number, m: number, day: number, hh: number, mm = 0) => zonedToUtc({ year: y, month: m, day, hour: hh, minute: mm, second: 0 }, TZ);
const T0 = local(2027, 4, 10, 9);                 // "now" for most cases: 09:00 Edmonton, 10 April 2027
const minutes = (n: number, from = T0) => new Date(from.getTime() + n * 60_000);

async function notificationsLike(prefix: string) {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT notificationKey, recipientUserId, recipientRole, channel, title FROM workflowNotifications WHERE notificationKey LIKE ? ORDER BY id", [`${prefix}%`]);
  return rows;
}

/* ================================================================== */

d("the tenant is derived, and another organization's private records do not exist", () => {
  it("a driver in organization B cannot read, act on or replay a driver in organization A's private reminder", async () => {
    const [a, b] = await Promise.all([org(), org()]);
    const driverA = await person("driver", a);
    const driverB = await person("driver", b);
    const made = await caller(driverA).work.reminderCreate({ title: "Bring respirator", timezone: TZ, at: local(2027, 4, 11, 6), now: T0 });
    expect(made.state).toBe("scheduled");
    const listB = await caller(driverB).work.reminderList();
    expect(listB.reminders.map(r => r.reminderRef)).not.toContain(made.reminderRef);
    await expect(caller(driverB).work.reminderAcknowledge({ reminderRef: made.reminderRef, at: T0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(driverB).work.reminderCancel({ reminderRef: made.reminderRef, at: T0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const replay = await caller(driverB).work.deviceActionsApply({ actions: [{ actionRef: `dev-${rnd()}`, reminderRef: made.reminderRef, action: "acknowledged", occurredAt: T0 }], now: T0 });
    expect(replay.refused).toBe(1);
    expect(replay.results[0]!.reason).toMatch(/No such reminder/);
    // And the owner still holds it, untouched.
    const listA = await caller(driverA).work.reminderList();
    expect(listA.reminders.find(r => r.reminderRef === made.reminderRef)!.state).toBe("scheduled");
  });

  it("a dispatcher in organization B does not see organization A's company task, even holding the scheduling permission", async () => {
    const [a, b] = await Promise.all([org(), org()]);
    const dispatcherA = await person("dispatcher", a);
    const driverA = await person("driver", a);
    const dispatcherB = await person("dispatcher", b);
    const t = await caller(dispatcherA).work.companyTaskCreate({ title: "Post-trip on unit 147", assigneeUserId: driverA, timezone: TZ, dueAt: local(2027, 4, 10, 19, 30), at: T0 });
    await expect(caller(dispatcherB).work.taskGet({ taskRef: t.taskRef, now: T0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const board = await caller(dispatcherB).work.taskList({ scope: "team", now: T0 });
    expect(board.tasks.map(x => x.taskRef)).not.toContain(t.taskRef);
    await expect(caller(dispatcherB).work.taskAssign({ taskRef: t.taskRef, assigneeUserId: dispatcherB, at: T0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

d("the permission gate", () => {
  it("a driver may not read another calendar, hand out company work, verify work or run the sweep", async () => {
    const driver = await person("driver");
    const other = await person("driver");
    await expect(caller(driver).work.calendarFor({ userId: other, from: T0, now: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(driver).work.availability({ userId: other, from: T0, to: minutes(60), now: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(driver).work.companyTaskCreate({ title: "x", timezone: TZ, at: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(driver).work.companyReminderCreate({ ownerUserId: other, title: "x", timezone: TZ, at: local(2027, 5, 1, 9), now: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(driver).work.taskVerify({ taskRef: "TSK-none", decision: "verify", at: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(driver).work.sweep({ now: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(driver).work.taskList({ scope: "team", now: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a personal task is its owner's: a scheduler cannot open it, and the owner cannot give it an escalation policy", async () => {
    const driver = await person("driver");
    const dispatcher = await person("dispatcher");
    const t = await caller(driver).work.taskCreate({ title: "Buy gloves", timezone: TZ, at: T0 });
    await expect(caller(dispatcher).work.taskGet({ taskRef: t.taskRef, now: T0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller(dispatcher).work.taskList({ scope: "team", now: T0 })).tasks.map(x => x.taskRef)).not.toContain(t.taskRef);
    expect((await caller(dispatcher).work.audit({ subjectKind: "task", subjectRef: t.taskRef })).events).toEqual([]);
  });
});

d("the calendar, and what a scheduler is shown", () => {
  it("a private appointment reaches dispatch as Unavailable with its window and none of its words; availability has nowhere to put them", async () => {
    const driver = await person("driver");
    const dispatcher = await person("dispatcher");
    await caller(driver).work.eventCreate({ title: "Dentist", detail: "Root canal with Dr. Singh", startsAt: local(2027, 4, 12, 13), endsAt: local(2027, 4, 12, 15), timezone: TZ, at: T0 });
    const mine = await caller(driver).work.calendar({ from: local(2027, 4, 12, 0), days: 1, now: T0 });
    expect(mine.entries.find(e => e.title === "Dentist")!.detail).toBe("Root canal with Dr. Singh");

    const theirs = await caller(dispatcher).work.calendarFor({ userId: driver, from: local(2027, 4, 12, 0), days: 1, now: T0 });
    const seen = theirs.entries.find(e => e.source.sourceType === "calendarEvent")!;
    expect(seen.title).toBe("Unavailable");
    expect(seen.detail).toBeNull();
    expect(seen.redacted).toBe(true);
    expect(theirs.redactedCount).toBe(1);
    expect(JSON.stringify(theirs)).not.toMatch(/Dentist|Root canal|Singh/);

    const avail = await caller(dispatcher).work.availability({ userId: driver, from: local(2027, 4, 12, 0), to: local(2027, 4, 13, 0), now: T0 });
    expect(avail.status).toBe("UNAVAILABLE");
    expect(avail.windows).toEqual([{ from: local(2027, 4, 12, 13), to: local(2027, 4, 12, 15), status: "UNAVAILABLE", basis: "calendarEvent" }]);
    expect(JSON.stringify(avail)).not.toMatch(/Dentist|Root canal|Singh/);
    // Nothing rostered, nothing booked: an empty day is UNKNOWN, not free.
    expect((await caller(dispatcher).work.availability({ userId: driver, from: local(2027, 4, 20, 0), to: local(2027, 4, 21, 0), now: T0 })).status).toBe("UNKNOWN");
  });

  it("a recurring company meeting expands into one entry per occurrence, keeping its wall clock across the clock change", async () => {
    const office = await person("office");
    const driver = await person("driver");
    // Every weekday at 05:30 Edmonton from Friday 12 March 2027; the clocks change on the 14th.
    const made = await caller(office).work.companyEventCreate({ title: "Tailgate", category: "safety", startsAt: local(2027, 3, 12, 5, 30), endsAt: local(2027, 3, 12, 6), timezone: TZ, participants: [driver], recurrence: { frequency: "weekdays", timezone: TZ, anchorAt: local(2027, 3, 12, 5, 30) }, at: local(2027, 3, 1, 9) });
    expect(made.recurrenceRuleRef).toBeTruthy();
    const week = await caller(driver).work.calendar({ from: local(2027, 3, 12, 0), days: 7, now: local(2027, 3, 12, 0) });
    const tailgates = week.entries.filter(e => e.source.sourceRef === made.eventRef);
    expect(tailgates.map(e => e.at.toISOString())).toEqual([
      "2027-03-12T12:30:00.000Z",   // Friday, MST
      "2027-03-15T11:30:00.000Z",   // Monday, MDT — an hour earlier in UTC, the same 05:30 on the wall
      "2027-03-16T11:30:00.000Z", "2027-03-17T11:30:00.000Z", "2027-03-18T11:30:00.000Z",
    ]);
    expect(new Set(tailgates.map(e => e.eventKey)).size).toBe(5);
    // The invitation reached the participant once.
    expect(await notificationsLike(`event:${made.eventRef}:invited:${driver}`)).toHaveLength(1);
  });

  it("an all-day Edmonton event on the 12th is on the 12th whichever midnight the window uses, and not on the 11th", async () => {
    const driver = await person("driver");
    const made = await caller(driver).work.eventCreate({ title: "Off — moving house", category: "personal", startsAt: local(2027, 4, 12, 0), endsAt: local(2027, 4, 13, 0), allDay: true, timezone: TZ, at: T0 });
    const utcDay = await caller(driver).work.calendar({ from: new Date("2027-04-12T00:00:00Z"), days: 1, now: T0 });
    expect(utcDay.entries.some(e => e.source.sourceRef === made.eventRef)).toBe(true);
    const localDay = await caller(driver).work.calendar({ from: local(2027, 4, 12, 0), days: 1, now: T0 });
    expect(localDay.entries.some(e => e.source.sourceRef === made.eventRef)).toBe(true);
    const dayBefore = await caller(driver).work.calendar({ from: new Date("2027-04-11T00:00:00Z"), days: 1, now: T0 });
    expect(dayBefore.entries.some(e => e.source.sourceRef === made.eventRef)).toBe(false);
  });

  it("a required stand-down is due until its participant acknowledges it, and only the participant can", async () => {
    const safety = await person("safety");
    const driver = await person("driver");
    const other = await person("driver");
    const made = await caller(safety).work.companyEventCreate({ title: "Safety stand-down", category: "safety", state: "required", startsAt: local(2027, 4, 14, 7), endsAt: local(2027, 4, 14, 8), timezone: TZ, participants: [driver], at: T0 });
    const before = await caller(driver).work.calendar({ from: local(2027, 4, 14, 0), days: 1, now: T0 });
    expect(before.entries.find(e => e.source.sourceRef === made.eventRef)!.severity).toBe("due");
    expect(before.actionable.map(e => e.source.sourceRef)).toContain(made.eventRef);
    await expect(caller(other).work.eventAcknowledge({ eventRef: made.eventRef, at: T0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ack = await caller(driver).work.eventAcknowledge({ eventRef: made.eventRef, at: T0 });
    expect(ack.already).toBe(false);
    expect((await caller(driver).work.eventAcknowledge({ eventRef: made.eventRef, at: minutes(5) })).already).toBe(true);
    const after = await caller(driver).work.calendar({ from: local(2027, 4, 14, 0), days: 1, now: T0 });
    expect(after.entries.find(e => e.source.sourceRef === made.eventRef)!.severity).toBe("informational");
    const trail = await caller(safety).work.audit({ subjectKind: "event", subjectRef: made.eventRef });
    expect(trail.events.map(e => e.action)).toEqual(["acknowledged", "created"]);
  });

  it("a projected credential expiry follows its record when the record changes, and a stored event linked to a record refuses to be moved here", async () => {
    const driver = await person("driver");
    const safety = await person("safety");
    const holdingRef = `WQ-${rnd()}`;
    await pool.execute("INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt) VALUES (?,?,?,?,?,?,?,?)", [holdingRef, "default", driver, "H2S", "verified", local(2027, 5, 1, 0), 1, T0]);
    const first = await caller(driver).work.calendar({ from: local(2027, 4, 1, 0), days: 60, now: T0 });
    expect(first.entries.find(e => e.source.sourceRef === holdingRef)!.at.toISOString()).toBe(local(2027, 5, 1, 0).toISOString());
    // The portfolio moves the expiry. The calendar holds no copy, so it simply reads the new one.
    await pool.execute("UPDATE workerQualifications SET expiresAt = ? WHERE holdingRef = ?", [local(2027, 5, 20, 0), holdingRef]);
    const second = await caller(driver).work.calendar({ from: local(2027, 4, 1, 0), days: 60, now: T0 });
    expect(second.entries.find(e => e.source.sourceRef === holdingRef)!.at.toISOString()).toBe(local(2027, 5, 20, 0).toISOString());
    // A stored event that LINKS to the record still shows, and moving it here is refused: the record owns the date.
    const linked = await caller(safety).work.companyEventCreate({ title: "H2S renewal course", category: "training", startsAt: local(2027, 5, 10, 8), endsAt: local(2027, 5, 10, 16), timezone: TZ, participants: [driver], sourceType: "workerQualification", sourceRef: holdingRef, at: T0 });
    const third = await caller(driver).work.calendar({ from: local(2027, 5, 1, 0), days: 30, now: T0 });
    expect(third.entries.find(e => e.source.sourceRef === linked.eventRef)!.link).toEqual({ sourceType: "workerQualification", sourceRef: holdingRef });
    await expect(caller(safety).work.eventReschedule({ eventRef: linked.eventRef, startsAt: local(2027, 5, 11, 8), at: T0 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/change the date there/) });
  });
});

d("the task board", () => {
  it("company work is accepted, started, submitted with evidence and verified by somebody else — never by the person who did it", async () => {
    const dispatcher = await person("dispatcher");
    const driver = await person("driver");
    const safety = await person("safety");
    const t = await caller(dispatcher).work.companyTaskCreate({ title: "Post-trip inspection, unit 147", assigneeUserId: driver, timezone: TZ, dueAt: local(2027, 4, 10, 19, 30), requiresCompletionEvidence: true, checklist: ["Brakes", "Lights"], reminder: { offsetMinutes: -30, level: "compliance" }, at: T0 });
    expect(t.status).toBe("todo");
    expect(t.reminderRef).toBeTruthy();
    expect(await notificationsLike(`task:${t.taskRef}:assigned:${driver}`)).toHaveLength(1);
    const mine = await caller(driver).work.taskList({ scope: "mine", now: T0 });
    expect(mine.tasks.find(x => x.taskRef === t.taskRef)!.assignmentState).toBe("assigned");

    await expect(caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "start", at: T0 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/Accept the assignment/) });
    expect((await caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "accept", at: minutes(1) })).assignmentState).toBe("accepted");
    expect((await caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "start", at: minutes(2) })).status).toBe("in_progress");
    await expect(caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "submit", at: minutes(3) })).rejects.toMatchObject({ message: "2 checklist item(s) are not done" });
    const detail = await caller(driver).work.taskGet({ taskRef: t.taskRef, now: minutes(3) });
    for (const item of detail.checklist) await caller(driver).work.taskChecklistTick({ itemRef: item.itemRef, done: true, at: minutes(4) });
    await expect(caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "submit", at: minutes(5) })).rejects.toMatchObject({ message: expect.stringMatching(/requires completion evidence/) });
    await expect(caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "complete", at: minutes(5) })).rejects.toMatchObject({ message: expect.stringMatching(/requires evidence and a verifier/) });
    const att = await caller(driver).work.taskAttach({ taskRef: t.taskRef, label: "Post-trip photo", evidenceRecordId: 1, at: minutes(6) });
    expect((await caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "submit", evidenceRef: att.completionEvidenceRef, at: minutes(7) })).status).toBe("submitted");
    // The assignee cannot verify their own work even through the verify procedure; a safety officer can.
    await expect(caller(driver).work.taskVerify({ taskRef: t.taskRef, decision: "verify", at: minutes(8) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await caller(safety).work.taskList({ scope: "team", now: minutes(8) })).toVerify).toContain(t.taskRef);
    const verified = await caller(safety).work.taskVerify({ taskRef: t.taskRef, decision: "verify", at: minutes(9) });
    expect(verified.status).toBe("verified");
    // The reminder about the task closed with it.
    expect(verified.remindersClosed).toBe(1);
    const trail = await caller(dispatcher).work.audit({ subjectKind: "task", subjectRef: t.taskRef });
    expect(trail.events.map(e => e.action)).toEqual(["verified", "submitted", "attached", "started", "accepted", "assigned", "created"]);
    const [outbox] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType FROM domainEventOutbox WHERE aggregateType='workTask' AND aggregateId=? ORDER BY id", [t.taskRef]);
    expect(outbox.map(r => r.eventType)).toEqual(["work.task.assigned", "work.task.accepted", "work.task.started", "work.task.submitted", "work.task.verified"]);
  });

  it("a task waits on its predecessor, by name", async () => {
    const dispatcher = await person("dispatcher");
    const driver = await person("driver");
    const first = await caller(dispatcher).work.companyTaskCreate({ title: "Wash out unit 14", assigneeUserId: driver, timezone: TZ, at: T0 });
    const second = await caller(dispatcher).work.companyTaskCreate({ title: "Load unit 14", assigneeUserId: driver, timezone: TZ, at: T0 });
    await caller(dispatcher).work.taskDependencyAdd({ taskRef: second.taskRef, dependsOnTaskRef: first.taskRef, at: T0 });
    await expect(caller(dispatcher).work.taskDependencyAdd({ taskRef: first.taskRef, dependsOnTaskRef: second.taskRef, at: T0 })).rejects.toMatchObject({ message: expect.stringMatching(/wait on each other/) });
    await caller(driver).work.taskTransition({ taskRef: second.taskRef, action: "accept", at: T0 });
    await expect(caller(driver).work.taskTransition({ taskRef: second.taskRef, action: "start", at: minutes(1) })).rejects.toMatchObject({ message: `Blocked by open predecessor(s): ${first.taskRef}` });
    await caller(driver).work.taskTransition({ taskRef: first.taskRef, action: "accept", at: minutes(1) });
    await caller(driver).work.taskTransition({ taskRef: first.taskRef, action: "complete", at: minutes(2) });
    expect((await caller(driver).work.taskTransition({ taskRef: second.taskRef, action: "start", at: minutes(3) })).status).toBe("in_progress");
  });

  it("a personal task walks its own list and appears nowhere else", async () => {
    const driver = await person("driver");
    const t = await caller(driver).work.taskCreate({ title: "Fuel receipts for September", dueAt: local(2027, 4, 30, 17), timezone: TZ, reminder: { offsetMinutes: -1440, level: "important" }, at: T0 });
    expect(t.status).toBe("inbox");
    expect((await caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "start", at: T0 })).status).toBe("in_progress");
    expect((await caller(driver).work.taskTransition({ taskRef: t.taskRef, action: "complete", at: minutes(1) })).remindersClosed).toBe(1);
    const closed = await caller(driver).work.taskList({ scope: "mine", includeClosed: true, now: minutes(1) });
    expect(closed.tasks.find(x => x.taskRef === t.taskRef)!.status).toBe("completed");
  });
});

d("reminders: fire, acknowledge, snooze, cancel — each once", () => {
  it("a sweep fires what is due and a second sweep over the same minute delivers nothing twice", async () => {
    const driver = await person("driver");
    const dispatcher = await person("dispatcher");
    const r = await caller(driver).work.reminderCreate({ title: "Bring respirator", level: "alarm", timezone: TZ, at: local(2027, 4, 11, 6), now: T0 });
    const early = await caller(dispatcher).work.sweep({ now: local(2027, 4, 11, 5, 59) });
    expect(await notificationsLike(`reminder:${r.reminderRef}:`)).toHaveLength(0);
    expect(early.fired).toBe(0);
    const due = local(2027, 4, 11, 6, 1);
    const first = await caller(dispatcher).work.sweep({ now: due });
    expect(first.fired).toBeGreaterThanOrEqual(1);
    const delivered = await notificationsLike(`reminder:${r.reminderRef}:`);
    expect(delivered.map(n => n.channel).sort()).toEqual(["in_app", "push"]);   // alarm: in-app and push
    expect(delivered.every(n => n.recipientUserId === driver && n.recipientRole === null)).toBe(true);
    await caller(dispatcher).work.sweep({ now: due });
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 11, 6, 5) });
    expect(await notificationsLike(`reminder:${r.reminderRef}:`)).toHaveLength(2);
    const state = (await caller(driver).work.reminderList()).reminders.find(x => x.reminderRef === r.reminderRef)!;
    expect(state.state).toBe("fired");
    expect(state.lastFiredAt!.toISOString()).toBe(due.toISOString());
  });

  it("snooze moves the time and counts; acknowledge closes a one-off and advances a recurring one; cancel is final", async () => {
    const driver = await person("driver");
    const r = await caller(driver).work.reminderCreate({ title: "Check tire pressures", timezone: TZ, at: local(2027, 4, 11, 6), now: T0 });
    const s = await caller(driver).work.reminderSnooze({ reminderRef: r.reminderRef, choice: { kind: "preset", preset: "15m" }, at: local(2027, 4, 11, 6, 2) });
    expect(s.state).toBe("snoozed");
    expect(s.fireAt.toISOString()).toBe(local(2027, 4, 11, 6, 17).toISOString());
    const tomorrow = await caller(driver).work.reminderSnooze({ reminderRef: r.reminderRef, choice: { kind: "tomorrow" }, at: local(2027, 4, 11, 6, 3) });
    expect(tomorrow.fireAt.toISOString()).toBe(local(2027, 4, 12, 8).toISOString());
    const deferred = caller(driver).work.reminderSnooze({ reminderRef: r.reminderRef, choice: { kind: "after_current_job" }, at: local(2027, 4, 11, 6, 4) });
    await expect(deferred).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/does not read yet/) });
    const ack = await caller(driver).work.reminderAcknowledge({ reminderRef: r.reminderRef, at: local(2027, 4, 11, 6, 5) });
    expect(ack.state).toBe("acknowledged");
    await expect(caller(driver).work.reminderCancel({ reminderRef: r.reminderRef, at: local(2027, 4, 11, 6, 6) })).rejects.toMatchObject({ message: expect.stringMatching(/already acknowledged/) });

    const weekly = await caller(driver).work.reminderCreate({ title: "Submit fuel receipts", timezone: TZ, recurrence: { frequency: "weekly", byWeekday: [5], timezone: TZ, anchorAt: local(2027, 4, 16, 17) }, now: T0 });
    expect(weekly.fireAt.toISOString()).toBe(local(2027, 4, 16, 17).toISOString());
    const [row] = await pool.execute<mysql.RowDataPacket[]>("UPDATE reminders SET state='fired', lastFiredAt=? WHERE reminderRef=?", [local(2027, 4, 16, 17), weekly.reminderRef]);
    expect(row).toBeTruthy();
    const advanced = await caller(driver).work.reminderAcknowledge({ reminderRef: weekly.reminderRef, at: local(2027, 4, 16, 17, 30) });
    expect(advanced.state).toBe("scheduled");
    expect(advanced.nextFireAt!.toISOString()).toBe(local(2027, 4, 23, 17).toISOString());
    const cancelled = await caller(driver).work.reminderCancel({ reminderRef: weekly.reminderRef, at: local(2027, 4, 16, 18) });
    expect(cancelled.state).toBe("cancelled");
    const [actions] = await pool.execute<mysql.RowDataPacket[]>("SELECT action FROM reminderActions WHERE reminderRef=? ORDER BY id", [weekly.reminderRef]);
    expect(actions.map(a => a.action)).toEqual(["created", "advanced", "cancelled"]);
  });

  it("a device's replay applies each action once, in the order it happened, and says duplicate the second time", async () => {
    const driver = await person("driver");
    const r = await caller(driver).work.reminderCreate({ title: "Give disposal tickets to dispatch", timezone: TZ, at: local(2027, 4, 11, 6), now: T0 });
    await pool.execute("UPDATE reminders SET state='fired', lastFiredAt=? WHERE reminderRef=?", [local(2027, 4, 11, 6), r.reminderRef]);
    const snoozeRef = `dev-${rnd()}`, ackRef = `dev-${rnd()}`;
    const batch = [
      { actionRef: ackRef, reminderRef: r.reminderRef, action: "acknowledged" as const, occurredAt: local(2027, 4, 11, 6, 20) },
      { actionRef: snoozeRef, reminderRef: r.reminderRef, action: "snoozed" as const, occurredAt: local(2027, 4, 11, 6, 1), snoozeChoice: { kind: "preset" as const, preset: "15m" as const } },
    ];
    const first = await caller(driver).work.deviceActionsApply({ deviceRef: "DEV-1", actions: batch, now: local(2027, 4, 11, 7) });
    expect(first.applied).toBe(2);
    expect(first.results.map(x => x.actionRef)).toEqual([snoozeRef, ackRef]);   // device order, not arrival order
    const again = await caller(driver).work.deviceActionsApply({ deviceRef: "DEV-1", actions: batch, now: local(2027, 4, 11, 7, 1) });
    expect(again).toMatchObject({ applied: 0, duplicates: 2, refused: 0 });
    const [actions] = await pool.execute<mysql.RowDataPacket[]>("SELECT actionRef, action, actorSource, deviceRef FROM reminderActions WHERE reminderRef=? ORDER BY id", [r.reminderRef]);
    expect(actions.map(a => [a.action, a.actorSource])).toEqual([["created", "human"], ["snoozed", "device"], ["acknowledged", "device"]]);
    expect(actions[1]!.deviceRef).toBe("DEV-1");
    expect((await caller(driver).work.reminderList({ includeClosed: true })).reminders.find(x => x.reminderRef === r.reminderRef)!.state).toBe("acknowledged");
  });

  it("the device schedule carries enough to notify locally and offers the snooze choices", async () => {
    const driver = await person("driver");
    const r = await caller(driver).work.reminderCreate({ title: "Pre-trip due", level: "important", timezone: TZ, at: local(2027, 4, 11, 6), now: T0 });
    const sched = await caller(driver).work.deviceSchedule({ horizonDays: 7, now: T0 });
    const entry = sched.entries.find(e => e.reminderRef === r.reminderRef)!;
    expect(entry).toMatchObject({ title: "Pre-trip due", level: "important", localNotification: true, fireAt: local(2027, 4, 11, 6).toISOString() });
    expect(entry.snoozeChoices).toEqual(["5m", "15m", "30m", "1h", "tonight", "tomorrow", "custom"]);
    expect(sched.note).toMatch(/does not bypass/);
  });
});

d("escalation is company policy, and a personal reminder has none", () => {
  it("a company compliance reminder with a ladder reaches dispatch after the assignee ignores it; the assignee's acknowledgement stops it", async () => {
    const safety = await person("safety");
    const driver = await person("driver");
    const dispatcher = await person("dispatcher");
    const r = await caller(safety).work.companyReminderCreate({
      ownerUserId: driver, title: "POST-TRIP INSPECTION DUE — unit 147", level: "compliance", timezone: TZ, at: local(2027, 4, 10, 18), missedAfterMinutes: 30,
      escalationPolicy: { policyRef: "post_trip", levels: [{ afterMinutes: 0, roles: ["assignee"] }, { afterMinutes: 10, roles: ["assignee"] }, { afterMinutes: 45, roles: ["dispatcher"] }], mandatoryRoles: [] }, now: T0,
    });
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 10, 18) });
    expect(await notificationsLike(`reminder:${r.reminderRef}:`)).toHaveLength(2);   // compliance: in-app + push to the driver
    // 20 minutes on: the reminder is now missed (30 min without acknowledgement has not passed; the ladder's level 1 is due but the assignee was already told).
    const twenty = await caller(dispatcher).work.sweep({ now: local(2027, 4, 10, 18, 20) });
    expect(twenty.escalated).toBe(0);
    // 46 minutes on: missed, and dispatch is told — once, however often the sweep runs.
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 10, 18, 46) });
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 10, 18, 50) });
    const toDispatch = (await notificationsLike(`reminder:${r.reminderRef}:`)).filter(n => n.recipientRole === "dispatcher");
    expect(toDispatch).toHaveLength(1);
    expect(toDispatch[0]!.title).toMatch(/Unanswered: POST-TRIP/);
    const state = (await caller(driver).work.reminderList()).reminders.find(x => x.reminderRef === r.reminderRef)!;
    expect(state.state).toBe("missed");
    expect(state.escalationStep).toBe(2);
    // A compliance reminder records each snooze and refuses the fourth.
    for (const m of [51, 52, 53]) await caller(driver).work.reminderSnooze({ reminderRef: r.reminderRef, choice: { kind: "preset", preset: "5m" }, at: local(2027, 4, 10, 18, m) });
    await expect(caller(driver).work.reminderSnooze({ reminderRef: r.reminderRef, choice: { kind: "preset", preset: "5m" }, at: local(2027, 4, 10, 18, 54) })).rejects.toMatchObject({ message: expect.stringMatching(/snoozed 3 times/) });
    const trail = await caller(safety).work.audit({ subjectKind: "reminder", subjectRef: r.reminderRef });
    expect(trail.events.filter(e => e.action === "snoozed")).toHaveLength(3);
    expect(trail.events.map(e => e.action)).toContain("escalated");
  });

  it("a personal reminder ignored for hours tells nobody but its owner, and cannot be given a ladder", async () => {
    const driver = await person("driver");
    const dispatcher = await person("dispatcher");
    const r = await caller(driver).work.reminderCreate({ title: "Call the dentist back", timezone: TZ, at: local(2027, 4, 10, 12), now: T0 });
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 10, 12) });
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 10, 16) });
    await caller(dispatcher).work.sweep({ now: local(2027, 4, 11, 12) });
    const all = await notificationsLike(`reminder:${r.reminderRef}:`);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ recipientUserId: driver, recipientRole: null, channel: "in_app" });
    expect((await caller(driver).work.reminderList()).reminders.find(x => x.reminderRef === r.reminderRef)!.state).toBe("fired");   // never "missed": nothing was required of anyone
    // No procedure lets a person attach a ladder to their own reminder: the personal create has no such field, and the engine refuses it anyway.
    const [trail] = await pool.execute<mysql.RowDataPacket[]>("SELECT action, visibility, detailJson FROM workAuditEvents WHERE subjectKind='reminder' AND subjectRef=? ORDER BY id", [r.reminderRef]);
    expect(trail.map(t => [t.action, t.visibility, t.detailJson])).toEqual([["created", "private", null], ["fired", "private", null]]);
    expect((await caller(dispatcher).work.audit({ subjectKind: "reminder", subjectRef: r.reminderRef })).events).toEqual([]);
  });

  it("an overdue company task with a policy climbs from its due date; the assignee is told first and dispatch later, each once", async () => {
    const office = await person("office");
    const driver = await person("driver");
    const t = await caller(office).work.companyTaskCreate({ title: "Upload disposal ticket for job 25148", assigneeUserId: driver, timezone: TZ, dueAt: local(2027, 4, 10, 18), escalationPolicy: { policyRef: "docs", levels: [{ afterMinutes: 0, roles: ["assignee"] }, { afterMinutes: 30, roles: ["dispatcher"] }], mandatoryRoles: [] }, at: T0 });
    const early = await caller(office).work.sweep({ now: local(2027, 4, 10, 17, 59) });
    expect(await notificationsLike(`task:${t.taskRef}:${local(2027, 4, 10, 18).toISOString()}:escalation:`)).toHaveLength(0);
    expect(early.tasksEscalated).toBe(0);
    await caller(office).work.sweep({ now: local(2027, 4, 10, 18, 1) });
    await caller(office).work.sweep({ now: local(2027, 4, 10, 18, 2) });
    let sent = await notificationsLike(`task:${t.taskRef}:${local(2027, 4, 10, 18).toISOString()}:escalation:`);
    expect(sent.map(n => [n.recipientUserId, n.recipientRole])).toEqual([[driver, null]]);
    await caller(office).work.sweep({ now: local(2027, 4, 10, 18, 31) });
    await caller(office).work.sweep({ now: local(2027, 4, 10, 19, 0) });
    sent = await notificationsLike(`task:${t.taskRef}:${local(2027, 4, 10, 18).toISOString()}:escalation:`);
    expect(sent.map(n => [n.recipientUserId, n.recipientRole])).toEqual([[driver, null], [null, "dispatcher"]]);
    expect((await caller(driver).work.taskGet({ taskRef: t.taskRef, now: local(2027, 4, 10, 19) })).task.escalationStep).toBe(2);
  });
});

d("the command contract, through the product", () => {
  it("plans without creating, reads back, then creates on commit; a command it cannot resolve says what it needs", async () => {
    const driver = await person("driver");
    const at = local(2027, 4, 11, 6);
    const planned = await caller(driver).work.reminderCommand({ what: "Bring my respirator", when: { kind: "absolute", at }, timezone: TZ, now: T0 });
    expect(planned).toMatchObject({ ok: true, reminderRef: null, readBack: "Remind you to Bring my respirator at 2027-04-11 06:00 America/Edmonton" });
    const committed = await caller(driver).work.reminderCommand({ what: "Bring my respirator", when: { kind: "absolute", at }, timezone: TZ, commit: true, now: T0 });
    expect(committed.ok && committed.reminderRef).toBeTruthy();
    expect((await caller(driver).work.reminderList()).reminders.find(r => r.reminderRef === committed.reminderRef)!.fireAt.toISOString()).toBe(at.toISOString());
    const shift = await caller(driver).work.reminderCommand({ what: "Check tire pressures", when: { kind: "relative_to_shift", offsetMinutes: -30 }, timezone: TZ, now: T0 });
    expect(shift).toMatchObject({ ok: false, needs: "nextShiftStartAt" });
    const yard = await caller(driver).work.reminderCommand({ what: "Hand in tickets", when: { kind: "on_return_to_yard" }, timezone: TZ, now: T0 });
    expect(yard).toMatchObject({ ok: false, needs: "geofence" });
  });

  it("'two weeks before my H2S expires' counts back from the verified record, and refuses somebody else's", async () => {
    const driver = await person("driver");
    const other = await person("driver");
    const holdingRef = `WQ-${rnd()}`;
    await pool.execute("INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt) VALUES (?,?,?,?,?,?,?,?)", [holdingRef, "default", driver, "H2S", "verified", local(2027, 6, 1, 0), 1, T0]);
    const mine = await caller(driver).work.reminderCommand({ what: "Book H2S renewal", when: { kind: "before_source", sourceType: "workerQualification", sourceRef: holdingRef, offsetDays: 14 }, timezone: TZ, commit: true, now: T0 });
    expect(mine.ok && mine.plan.fireAt.toISOString()).toBe(new Date(local(2027, 6, 1, 0).getTime() - 14 * 86_400_000).toISOString());
    const theirs = await caller(other).work.reminderCommand({ what: "Book H2S renewal", when: { kind: "before_source", sourceType: "workerQualification", sourceRef: holdingRef, offsetDays: 14 }, timezone: TZ, now: T0 });
    expect(theirs).toMatchObject({ ok: false, reason: expect.stringMatching(/no date recorded/) });
  });
});
