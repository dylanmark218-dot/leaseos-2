/**
 * 0170 — the work screens' view-models, proved in Node.
 */
import { describe, expect, it } from "vitest";
import { dueLine, groupAgenda, reminderRows, taskLanes, weekColumns, type CalendarEntryView, type TaskView } from "../client/src/work/viewModels";

const TZ = "America/Edmonton";
const NOW = new Date("2027-04-10T15:00:00Z");
const e = (over: Partial<CalendarEntryView> = {}): CalendarEntryView => ({
  eventKey: "k", title: "Tailgate", detail: null, at: "2027-04-12T13:30:00.000Z", endsAt: null, allDay: false, layer: "compliance", severity: "informational", state: "confirmed", basis: "record", deepLink: "/x", source: { sourceType: "calendarEvent", sourceRef: "CAL-1" }, ...over,
});

describe("the agenda groups by the person's day, not by UTC", () => {
  it("puts a 23:30 Edmonton entry on the Edmonton date, all-day entries first", () => {
    const late = e({ eventKey: "late", at: "2027-04-13T05:30:00.000Z", title: "Late" });          // 23:30 on the 12th in Edmonton
    const allDay = e({ eventKey: "ad", at: "2027-04-12T06:00:00.000Z", allDay: true, title: "Off" });
    const days = groupAgenda([late, e(), allDay], TZ);
    expect(days.map(d => d.key)).toEqual(["2027-04-12"]);
    expect(days[0]!.entries.map(x => [x.title, x.time])).toEqual([["Off", "All day"], ["Tailgate", "07:30"], ["Late", "23:30"]]);
  });

  it("the week has seven columns however empty, with the worst severity on each", () => {
    const cols = weekColumns([e(), e({ eventKey: "b", at: "2027-04-14T13:30:00.000Z", severity: "blocking" })], new Date("2027-04-11T06:00:00Z"), TZ);
    expect(cols).toHaveLength(7);
    expect(cols.map(c => c.count)).toEqual([0, 1, 0, 1, 0, 0, 0]);
    expect(cols[3]!.worst).toBe("blocking");
    expect(cols[0]!.label).toMatch(/Apr 11/);
  });
});

describe("the board", () => {
  const t = (over: Partial<TaskView> = {}): TaskView => ({ taskRef: "T", kind: "company", status: "todo", assignmentState: "accepted", title: "x", priority: "normal", dueAt: null, overdue: false, deepLink: "/x", ...over });

  it("lanes in the order work moves, closed lanes hidden unless asked, overdue then priority then date", () => {
    const lanes = taskLanes([
      t({ taskRef: "late", status: "todo", overdue: true, priority: "low", dueAt: "2027-04-09T00:00:00Z" }),
      t({ taskRef: "crit", status: "todo", priority: "critical" }),
      t({ taskRef: "soon", status: "todo", dueAt: "2027-04-11T00:00:00Z" }),
      t({ taskRef: "later", status: "todo", dueAt: "2027-04-12T00:00:00Z" }),
      t({ taskRef: "done", status: "completed" }),
    ]);
    expect(lanes.map(l => l.key)).toEqual(["inbox", "todo", "in_progress", "waiting", "blocked", "submitted"]);
    expect(lanes.find(l => l.key === "todo")!.tasks.map(x => x.taskRef)).toEqual(["late", "crit", "soon", "later"]);
    expect(taskLanes([t({ status: "completed" })], { includeClosed: true }).find(l => l.key === "completed")!.tasks).toHaveLength(1);
  });

  it("says when something is due in words a person reads at a glance", () => {
    expect(dueLine({ dueAt: null, overdue: false, status: "todo" }, NOW, TZ)).toBe("No due date");
    expect(dueLine({ dueAt: "2027-04-10T15:30:00Z", overdue: false, status: "todo" }, NOW, TZ)).toBe("Due within the hour");
    expect(dueLine({ dueAt: "2027-04-10T20:00:00Z", overdue: false, status: "todo" }, NOW, TZ)).toBe("Due in 5 h (14:00)");
    expect(dueLine({ dueAt: "2027-04-09T20:00:00Z", overdue: true, status: "todo" }, NOW, TZ)).toMatch(/^Overdue — was due .*Apr 9.* 14:00$/);
  });
});

describe("reminders", () => {
  it("ringing and missed first, and only the actions the engine would accept", () => {
    const rows = reminderRows([
      { reminderRef: "a", title: "a", level: "normal", state: "scheduled", fireAt: "2027-04-11T06:00:00Z", requiresAcknowledgement: false, snoozeCount: 0 },
      { reminderRef: "b", title: "b", level: "compliance", state: "missed", fireAt: "2027-04-10T18:00:00Z", requiresAcknowledgement: true, snoozeCount: 1 },
      { reminderRef: "c", title: "c", level: "alarm", state: "fired", fireAt: "2027-04-10T19:00:00Z", requiresAcknowledgement: false, snoozeCount: 0 },
      { reminderRef: "d", title: "d", level: "normal", state: "acknowledged", fireAt: "2027-04-10T12:00:00Z", requiresAcknowledgement: false, snoozeCount: 0 },
    ], TZ);
    expect(rows.map(r => r.reminderRef)).toEqual(["c", "b", "a", "d"]);
    expect(rows[0]!.actions).toEqual(["acknowledge", "snooze", "cancel"]);
    expect(rows[2]!.actions).toEqual(["snooze", "cancel"]);
    expect(rows[3]!.actions).toEqual([]);
    expect(rows[2]!.when).toMatch(/Apr 11.* 00:00/);
  });
});
