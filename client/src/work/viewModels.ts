/**
 * 0170 — what the work screens show, as pure functions of the server's answers.
 *
 * Same shape as the portal view-models: every decision about layout — which day a thing sits on,
 * which lane a task is in, which words a state gets — is here, so it can be proved in Node and
 * the components stay thin.
 */

export type EntryState = "confirmed" | "projected" | "recommended" | "required" | "cancelled";
export type Severity = "informational" | "due" | "overdue" | "blocking" | "unknown";

export type CalendarEntryView = {
  eventKey: string;
  title: string;
  detail: string | null;
  at: string | Date;
  endsAt: string | Date | null;
  allDay: boolean;
  layer: string;
  severity: Severity;
  state: EntryState;
  basis: "record" | "projection";
  deepLink: string;
  redacted?: boolean;
  source: { sourceType: string; sourceRef: string };
};

export type TaskView = {
  taskRef: string;
  kind: "personal" | "company";
  status: string;
  assignmentState: string;
  title: string;
  priority: "low" | "normal" | "high" | "critical";
  dueAt: string | Date | null;
  overdue: boolean;
  deepLink: string;
};

export type ReminderView = {
  reminderRef: string;
  title: string;
  level: "normal" | "important" | "alarm" | "compliance";
  state: string;
  fireAt: string | Date;
  requiresAcknowledgement: boolean;
  snoozeCount: number;
};

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

/** The local calendar date of an instant in a zone, as YYYY-MM-DD, and a label. */
export function localDay(at: string | Date, tz: string): { key: string; label: string } {
  const d = toDate(at);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const key = `${get("year")}-${get("month")}-${get("day")}`;
  const label = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  return { key, label };
}

export function localTime(at: string | Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(toDate(at));
}

/** The words a state gets. PROJECTED and RECOMMENDED say so; nobody mistakes an estimate for a fact. */
export const STATE_LABELS: Record<EntryState, string> = { confirmed: "Confirmed", projected: "Projected", recommended: "Recommended", required: "Required", cancelled: "Cancelled" };
export const SEVERITY_TONE: Record<Severity, "ok" | "review" | "blocked" | "unknown" | "pending"> = { informational: "ok", due: "review", overdue: "blocked", blocking: "blocked", unknown: "unknown" };

export type AgendaDay = { key: string; label: string; entries: (CalendarEntryView & { time: string })[] };

/** Day view and agenda view are the same grouping: by local day, in time order, all-day first. */
export function groupAgenda(entries: readonly CalendarEntryView[], tz: string): AgendaDay[] {
  const days = new Map<string, AgendaDay>();
  for (const e of [...entries].sort((a, b) => toDate(a.at).getTime() - toDate(b.at).getTime())) {
    const { key, label } = localDay(e.at, tz);
    if (!days.has(key)) days.set(key, { key, label, entries: [] });
    days.get(key)!.entries.push({ ...e, time: e.allDay ? "All day" : localTime(e.at, tz) });
  }
  const out = Array.from(days.values());
  for (const d of out) d.entries.sort((a, b) => (a.allDay === b.allDay ? toDate(a.at).getTime() - toDate(b.at).getTime() : a.allDay ? -1 : 1));
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export type WeekColumn = { key: string; label: string; count: number; worst: Severity; entries: (CalendarEntryView & { time: string })[] };

const RANK: Record<Severity, number> = { blocking: 0, overdue: 1, due: 2, unknown: 3, informational: 4 };

/** Seven columns from `from`, every day present even when empty: a blank day is information. */
export function weekColumns(entries: readonly CalendarEntryView[], from: Date, tz: string): WeekColumn[] {
  const grouped = new Map(groupAgenda(entries, tz).map(d => [d.key, d]));
  const out: WeekColumn[] = [];
  for (let i = 0; i < 7; i++) {
    const at = new Date(from.getTime() + i * 86_400_000);
    const { key, label } = localDay(at, tz);
    const day = grouped.get(key);
    const worst = (day?.entries ?? []).reduce<Severity>((acc, e) => (RANK[e.severity] < RANK[acc] ? e.severity : acc), "informational");
    out.push({ key, label, count: day?.entries.length ?? 0, worst, entries: day?.entries ?? [] });
  }
  return out;
}

export const TASK_LANES = ["inbox", "todo", "in_progress", "waiting", "blocked", "submitted", "verified", "completed", "cancelled"] as const;
export const LANE_LABELS: Record<(typeof TASK_LANES)[number], string> = { inbox: "Inbox", todo: "To do", in_progress: "In progress", waiting: "Waiting", blocked: "Blocked", submitted: "Submitted", verified: "Verified", completed: "Completed", cancelled: "Cancelled" };

export type TaskLane = { key: (typeof TASK_LANES)[number]; label: string; tasks: TaskView[] };

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 } as const;

/** The board: one lane per status, in the order work moves; overdue first, then priority, then due date. */
export function taskLanes(tasks: readonly TaskView[], opts: { includeClosed?: boolean } = {}): TaskLane[] {
  const lanes = TASK_LANES.filter(l => opts.includeClosed || !["verified", "completed", "cancelled"].includes(l));
  return lanes.map(key => ({
    key, label: LANE_LABELS[key],
    tasks: tasks.filter(t => t.status === key).sort((a, b) =>
      Number(b.overdue) - Number(a.overdue)
      || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || (a.dueAt ? toDate(a.dueAt).getTime() : Infinity) - (b.dueAt ? toDate(b.dueAt).getTime() : Infinity)),
  }));
}

/** A one-line description of a task's due date a person reads at a glance. */
export function dueLine(task: Pick<TaskView, "dueAt" | "overdue" | "status">, now: Date, tz: string): string {
  if (!task.dueAt) return "No due date";
  const due = toDate(task.dueAt);
  const minutesAhead = (due.getTime() - now.getTime()) / 60_000;
  const hours = Math.round(minutesAhead / 60);
  if (task.overdue) return `Overdue — was due ${localDay(due, tz).label} ${localTime(due, tz)}`;
  if (minutesAhead < 60) return "Due within the hour";
  if (hours < 24) return `Due in ${hours} h (${localTime(due, tz)})`;
  return `Due ${localDay(due, tz).label} ${localTime(due, tz)}`;
}

export const REMINDER_STATE_LABELS: Record<string, string> = { scheduled: "Scheduled", fired: "Ringing", snoozed: "Snoozed", acknowledged: "Acknowledged", missed: "Missed", completed: "Completed", cancelled: "Cancelled" };

export type ReminderRow = ReminderView & { when: string; actions: ("acknowledge" | "snooze" | "cancel")[] };

/** Ringing and missed first; then by time. The actions offered are the ones the engine would accept. */
export function reminderRows(reminders: readonly ReminderView[], tz: string): ReminderRow[] {
  const order: Record<string, number> = { fired: 0, missed: 1, snoozed: 2, scheduled: 3 };
  return [...reminders]
    .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || toDate(a.fireAt).getTime() - toDate(b.fireAt).getTime())
    .map(r => ({
      ...r,
      when: `${localDay(r.fireAt, tz).label} ${localTime(r.fireAt, tz)}`,
      actions: [
        ...(r.state === "fired" || r.state === "snoozed" || r.state === "missed" ? ["acknowledge" as const] : []),
        ...(r.state !== "acknowledged" && r.state !== "completed" && r.state !== "cancelled" ? ["snooze" as const, "cancel" as const] : []),
      ],
    }));
}

export const SNOOZE_OPTIONS = [
  { label: "5 min", choice: { kind: "preset", preset: "5m" } },
  { label: "15 min", choice: { kind: "preset", preset: "15m" } },
  { label: "30 min", choice: { kind: "preset", preset: "30m" } },
  { label: "1 hour", choice: { kind: "preset", preset: "1h" } },
  { label: "Tonight", choice: { kind: "tonight" } },
  { label: "Tomorrow", choice: { kind: "tomorrow" } },
] as const;
