/**
 * 0170 — the work screens, rendered.
 *
 * What matters most is what the view does NOT invent: a redacted entry stays "Unavailable", a
 * projected entry is labelled as one, and the only actions offered on a task are the ones the
 * server listed.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkCalendarView, type WorkCalendarViewProps } from "./WorkCalendarView";

afterEach(cleanup);

const NOW = new Date("2027-04-10T15:00:00Z");
const props = (over: Partial<WorkCalendarViewProps> = {}): WorkCalendarViewProps => ({
  tab: "calendar", onTab: vi.fn(), timezone: "America/Edmonton", now: NOW, online: true, offlineStatus: null,
  mode: "agenda", onMode: vi.fn(), from: NOW, onShift: vi.fn(), view: "my", onView: vi.fn(), calendarLoading: false,
  agenda: [{ key: "2027-04-12", label: "Mon, Apr 12", entries: [
    { eventKey: "a", title: "Unavailable", detail: null, at: "2027-04-12T19:00:00Z", endsAt: "2027-04-12T21:00:00Z", allDay: false, layer: "personal", severity: "informational", state: "confirmed", basis: "record", deepLink: "/calendarEvent/CAL-2", source: { sourceType: "calendarEvent", sourceRef: "CAL-2" }, redacted: true, time: "13:00" },
    { eventKey: "b", title: "Shift elapsed: about 45 min remaining", detail: "Projected from the clock", at: "2027-04-12T23:00:00Z", endsAt: null, allDay: false, layer: "compliance", severity: "due", state: "projected", basis: "projection", deepLink: "/hosDetermination/H-1", source: { sourceType: "hosDetermination", sourceRef: "H-1" }, time: "17:00" },
  ] }],
  week: [], actionable: [], selectedEntry: null, onSelectEntry: vi.fn(), onCreateEvent: vi.fn(), creatingEvent: false,
  lanes: [{ key: "todo", label: "To do", tasks: [{ taskRef: "TSK-1", kind: "company", status: "todo", assignmentState: "assigned", title: "Post-trip inspection", priority: "high", dueAt: "2027-04-10T19:30:00Z", overdue: false, deepLink: "/work/tasks/TSK-1" }] }],
  taskDetail: null, onOpenTask: vi.fn(), onCloseTask: vi.fn(), onTaskAction: vi.fn(), actingTask: false, onCreateTask: vi.fn(), creatingTask: false, onTickChecklist: vi.fn(),
  reminders: [{ reminderRef: "RMD-1", title: "Bring respirator", level: "alarm", state: "fired", fireAt: "2027-04-11T12:00:00Z", requiresAcknowledgement: false, snoozeCount: 0, when: "Sun, Apr 11 06:00", actions: ["acknowledge", "snooze", "cancel"] }],
  onReminderAction: vi.fn(), actingReminder: false, onCreateReminder: vi.fn(), creatingReminder: false,
  ...over,
});

describe("the calendar shows what it was sent, labelled", () => {
  it("keeps a redacted entry as Unavailable and marks a projected one", () => {
    render(<WorkCalendarView {...props()} />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Private — window only")).toBeInTheDocument();
    expect(screen.getByText("Projected")).toBeInTheDocument();
    expect(screen.queryByText(/Dentist/)).toBeNull();
  });

  it("opening an entry shows its source and, for a projection, says it is not a determination", () => {
    const onSelectEntry = vi.fn();
    const p = props({ onSelectEntry });
    render(<WorkCalendarView {...p} />);
    fireEvent.click(screen.getByText("Shift elapsed: about 45 min remaining"));
    expect(onSelectEntry).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "b" }));
    cleanup();
    render(<WorkCalendarView {...props({ selectedEntry: p.agenda[0]!.entries[1]! })} />);
    expect(screen.getByRole("region", { name: "Event details" })).toHaveTextContent("hosDetermination H-1");
    expect(screen.getByText(/An estimate, not a determination/)).toBeInTheDocument();
  });

  it("the private-event form submits what was typed and says what a scheduler will see", () => {
    const onCreateEvent = vi.fn();
    render(<WorkCalendarView {...props({ onCreateEvent })} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Dentist" } });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2027-04-12T13:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add private event" }));
    expect(onCreateEvent).toHaveBeenCalledWith({ title: "Dentist", startsAt: "2027-04-12T13:00", endsAt: "", allDay: false });
    expect(screen.getByText(/a scheduler sees the window as Unavailable/)).toBeInTheDocument();
  });
});

describe("the board offers only the actions the server listed", () => {
  it("shows the lanes and opens a task", () => {
    const onOpenTask = vi.fn();
    render(<WorkCalendarView {...props({ tab: "tasks", onOpenTask })} />);
    expect(screen.getByRole("region", { name: "To do" })).toHaveTextContent("Post-trip inspection");
    expect(screen.getByText(/awaiting your acceptance/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Post-trip inspection"));
    expect(onOpenTask).toHaveBeenCalledWith("TSK-1");
  });

  it("renders the detail's actions as buttons and nothing more", () => {
    const onTaskAction = vi.fn();
    render(<WorkCalendarView {...props({ tab: "tasks", onTaskAction, taskDetail: { taskRef: "TSK-1", title: "Post-trip inspection", description: null, status: "todo", kind: "company", priority: "high", dueLine: "Due in 4 h (13:30)", checklist: [{ itemRef: "TCI-1", label: "Brakes", done: false }], actions: ["accept", "decline"], dependencies: [{ dependsOnTaskRef: "TSK-0", open: true }], reminders: [] } })} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(screen.getByText(/Waits on: TSK-0 \(open\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onTaskAction).toHaveBeenCalledWith("TSK-1", "accept");
  });
});

describe("reminders", () => {
  it("a ringing reminder offers Got it, a snooze menu and cancel; the snooze menu sends the chosen preset", () => {
    const onReminderAction = vi.fn();
    render(<WorkCalendarView {...props({ tab: "reminders", onReminderAction })} />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onReminderAction).toHaveBeenCalledWith("RMD-1", "acknowledge");
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    fireEvent.click(screen.getByRole("button", { name: "15 min" }));
    expect(onReminderAction).toHaveBeenCalledWith("RMD-1", "snooze", { kind: "preset", preset: "15m" });
    expect(screen.getByText(/never reaches dispatch/)).toBeInTheDocument();
  });

  it("says plainly when the device has no service", () => {
    render(<WorkCalendarView {...props({ online: false, offlineStatus: { dueNow: 2, pendingReplay: 1 } })} />);
    expect(screen.getByRole("status")).toHaveTextContent("No service");
    expect(screen.getByRole("status")).toHaveTextContent("2 due now · 1 waiting to send");
  });
});
