/**
 * 0170 — the work calendar, the task board and the reminders: the view.
 *
 * Presentational and prop-driven, like the rest of the tested screens: every fact arrives through
 * props, every action leaves through a callback, so all three tabs run under the axe rules and
 * under jsdom without a session.
 *
 * Built for a phone first. One column, one thing at a time, buttons a gloved thumb can hit. A
 * PROJECTED entry says so on its face — the design system's rule that an estimate never dresses
 * as a fact — and a redacted entry says "Unavailable" and nothing else, which is what the server
 * sent and all this view knows.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SNOOZE_OPTIONS, STATE_LABELS, type AgendaDay, type CalendarEntryView, type ReminderRow, type TaskLane, type WeekColumn } from "../work/viewModels";

export type WorkTab = "calendar" | "tasks" | "reminders";
export type CalendarMode = "day" | "week" | "agenda";
export type CalendarViewKey = "my" | "crew" | "dispatch" | "fleet" | "safety" | "payroll" | "company";

export type TaskDetailView = {
  taskRef: string; title: string; description: string | null; status: string; kind: "personal" | "company"; priority: string; dueLine: string;
  checklist: { itemRef: string; label: string; done: boolean }[];
  actions: string[];
  dependencies: { dependsOnTaskRef: string; open: boolean }[];
  reminders: { reminderRef: string; fireAt: string | Date; state: string }[];
};

export type NewEvent = { title: string; startsAt: string; endsAt: string; allDay: boolean };
export type NewTask = { title: string; dueAt: string; remindMinutesBefore: number | null };
export type NewReminder = { title: string; at: string; level: "normal" | "important" | "alarm" };

export type WorkCalendarViewProps = {
  tab: WorkTab; onTab: (t: WorkTab) => void;
  timezone: string; now: Date;
  online: boolean;
  /** From the device's reminder queue, when the runtime is present. */
  offlineStatus: { dueNow: number; pendingReplay: number } | null;
  // calendar
  mode: CalendarMode; onMode: (m: CalendarMode) => void;
  from: Date; onShift: (days: number) => void;
  view: CalendarViewKey; onView: (v: CalendarViewKey) => void;
  calendarLoading: boolean;
  agenda: AgendaDay[]; week: WeekColumn[]; actionable: CalendarEntryView[];
  selectedEntry: CalendarEntryView | null; onSelectEntry: (e: CalendarEntryView | null) => void;
  onCreateEvent: (e: NewEvent) => void; creatingEvent: boolean;
  // tasks
  lanes: TaskLane[]; taskDetail: TaskDetailView | null;
  onOpenTask: (taskRef: string) => void; onCloseTask: () => void;
  onTaskAction: (taskRef: string, action: string) => void; actingTask: boolean;
  onCreateTask: (t: NewTask) => void; creatingTask: boolean;
  onTickChecklist: (itemRef: string, done: boolean) => void;
  // reminders
  reminders: ReminderRow[];
  onReminderAction: (reminderRef: string, action: "acknowledge" | "cancel" | "snooze", choice?: (typeof SNOOZE_OPTIONS)[number]["choice"]) => void; actingReminder: boolean;
  onCreateReminder: (r: NewReminder) => void; creatingReminder: boolean;
};

const TONE: Record<string, string> = { informational: "", due: "text-amber-700", overdue: "text-red-700", blocking: "text-red-700", unknown: "text-slate-500" };
const STATE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = { confirmed: "secondary", projected: "outline", recommended: "outline", required: "default", cancelled: "destructive" };
const humanAction = (a: string) => a.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
const dateLabel = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d);

export function WorkCalendarView(p: WorkCalendarViewProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4" data-testid="work-calendar">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Calendar &amp; tasks</h1>
        <nav aria-label="Work sections" className="ml-auto flex gap-1">
          {(["calendar", "tasks", "reminders"] as WorkTab[]).map(t => (
            <Button key={t} size="sm" variant={p.tab === t ? "default" : "outline"} aria-current={p.tab === t ? "page" : undefined} onClick={() => p.onTab(t)}>
              {t === "calendar" ? "Calendar" : t === "tasks" ? "Tasks" : "Reminders"}
            </Button>
          ))}
        </nav>
      </header>
      <p role="status" className="text-xs text-muted-foreground">
        {p.online ? "Online." : "No service — showing what this device holds; what you do here is sent when service returns."}
        {p.offlineStatus ? ` ${p.offlineStatus.dueNow} due now · ${p.offlineStatus.pendingReplay} waiting to send.` : ""}
        {` Times in ${p.timezone}.`}
      </p>
      {p.tab === "calendar" && <CalendarTab {...p} />}
      {p.tab === "tasks" && <TasksTab {...p} />}
      {p.tab === "reminders" && <RemindersTab {...p} />}
    </div>
  );
}

/* ------------------------------ calendar ------------------------------ */

function EntryRow({ e, tz, onSelect }: { e: CalendarEntryView & { time?: string }; tz: string; onSelect: (e: CalendarEntryView) => void }) {
  const time = e.time ?? new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(e.at));
  return (
    <li>
      <button type="button" onClick={() => onSelect(e)} className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left ${TONE[e.severity] ?? ""}`}>
        <span className="w-16 shrink-0 tabular-nums text-sm">{e.allDay ? "All day" : time}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{e.title}</span>
          <span className="block text-xs text-muted-foreground">
            {e.redacted ? "Private — window only" : e.layer.replace(/_/g, " ")}{e.severity !== "informational" ? ` · ${e.severity}` : ""}
          </span>
        </span>
        {e.state !== "confirmed" && <Badge variant={STATE_VARIANT[e.state] ?? "outline"}>{STATE_LABELS[e.state]}</Badge>}
      </button>
    </li>
  );
}

function CalendarTab(p: WorkCalendarViewProps) {
  const [draft, setDraft] = useState<NewEvent>({ title: "", startsAt: "", endsAt: "", allDay: false });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Earlier" onClick={() => p.onShift(-(p.mode === "day" ? 1 : 7))}>‹</Button>
        <span className="text-sm font-medium">{dateLabel(p.from, p.timezone)}</span>
        <Button size="sm" variant="outline" aria-label="Later" onClick={() => p.onShift(p.mode === "day" ? 1 : 7)}>›</Button>
        <div role="group" aria-label="Layout" className="ml-auto flex gap-1">
          {(["day", "week", "agenda"] as CalendarMode[]).map(m => <Button key={m} size="sm" variant={p.mode === m ? "default" : "outline"} onClick={() => p.onMode(m)}>{humanAction(m)}</Button>)}
        </div>
        <label className="text-sm">
          <span className="sr-only">Calendar view</span>
          <select aria-label="Calendar view" className="rounded border bg-background px-2 py-1" value={p.view} onChange={e => p.onView(e.target.value as CalendarViewKey)}>
            {(["my", "crew", "dispatch", "fleet", "safety", "payroll", "company"] as CalendarViewKey[]).map(v => <option key={v} value={v}>{v === "my" ? "My calendar" : humanAction(v)}</option>)}
          </select>
        </label>
      </div>

      {p.actionable.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Needs attention</CardTitle></CardHeader>
          <CardContent><ul className="space-y-2">{p.actionable.map(e => <EntryRow key={e.eventKey} e={e} tz={p.timezone} onSelect={p.onSelectEntry} />)}</ul></CardContent>
        </Card>
      )}

      {p.calendarLoading && <p className="text-sm text-muted-foreground">Reading the calendar…</p>}

      {p.mode === "week" ? (
        <ol className="grid gap-2 sm:grid-cols-7" aria-label="Week">
          {p.week.map(col => (
            <li key={col.key} className="rounded-lg border p-2">
              <div className="text-xs font-medium">{col.label}</div>
              <div className={`text-xs ${TONE[col.worst] ?? ""}`}>{col.count === 0 ? "—" : `${col.count} item${col.count === 1 ? "" : "s"}`}</div>
              <ul className="mt-1 space-y-1">{col.entries.map(e => <EntryRow key={e.eventKey} e={e} tz={p.timezone} onSelect={p.onSelectEntry} />)}</ul>
            </li>
          ))}
        </ol>
      ) : (
        <div className="space-y-4">
          {p.agenda.length === 0 && !p.calendarLoading && <p className="text-sm text-muted-foreground">Nothing in this window.</p>}
          {p.agenda.map(day => (
            <section key={day.key} aria-label={day.label}>
              <h2 className="mb-1 text-sm font-semibold">{day.label}</h2>
              <ul className="space-y-2">{day.entries.map(e => <EntryRow key={e.eventKey} e={e} tz={p.timezone} onSelect={p.onSelectEntry} />)}</ul>
            </section>
          ))}
        </div>
      )}

      {p.selectedEntry && (
        <Card role="region" aria-label="Event details">
          <CardHeader><CardTitle className="text-base">{p.selectedEntry.title}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><Badge variant={STATE_VARIANT[p.selectedEntry.state] ?? "outline"}>{STATE_LABELS[p.selectedEntry.state]}</Badge> · {p.selectedEntry.basis === "projection" ? "Projected from a record another engine owns" : "A calendar record"}</p>
            {p.selectedEntry.detail && <p>{p.selectedEntry.detail}</p>}
            <p className="text-muted-foreground">Source: {p.selectedEntry.source.sourceType} {p.selectedEntry.source.sourceRef}</p>
            {p.selectedEntry.state === "projected" && <p className="text-muted-foreground">An estimate, not a determination. The engine that owns the record decides.</p>}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" asChild><a href={p.selectedEntry.deepLink}>Open the record</a></Button>
              <Button size="sm" variant="ghost" onClick={() => p.onSelectEntry(null)}>Close</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Add to my calendar</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-2 sm:grid-cols-4" onSubmit={e => { e.preventDefault(); p.onCreateEvent(draft); setDraft({ title: "", startsAt: "", endsAt: "", allDay: false }); }}>
            <label className="sm:col-span-2 text-sm">Title<Input required value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="text-sm">Starts<Input type="datetime-local" required value={draft.startsAt} onChange={e => setDraft({ ...draft, startsAt: e.target.value })} /></label>
            <label className="text-sm">Ends<Input type="datetime-local" value={draft.endsAt} onChange={e => setDraft({ ...draft, endsAt: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.allDay} onChange={e => setDraft({ ...draft, allDay: e.target.checked })} />All day</label>
            <div className="sm:col-span-3 flex justify-end"><Button type="submit" disabled={p.creatingEvent || !draft.title.trim() || !draft.startsAt}>{p.creatingEvent ? "Saving…" : "Add private event"}</Button></div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">Private: a scheduler sees the window as Unavailable and nothing else.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------- tasks -------------------------------- */

function TasksTab(p: WorkCalendarViewProps) {
  const [draft, setDraft] = useState<NewTask>({ title: "", dueAt: "", remindMinutesBefore: 60 });
  return (
    <div className="space-y-4">
      {p.taskDetail ? (
        <Card role="region" aria-label="Task details">
          <CardHeader><CardTitle className="text-base">{p.taskDetail.title}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p><Badge variant="secondary">{humanAction(p.taskDetail.status)}</Badge> · {p.taskDetail.kind === "company" ? "Company work" : "Personal"} · {humanAction(p.taskDetail.priority)} priority · {p.taskDetail.dueLine}</p>
            {p.taskDetail.description && <p>{p.taskDetail.description}</p>}
            {p.taskDetail.checklist.length > 0 && (
              <fieldset>
                <legend className="font-medium">Checklist</legend>
                <ul className="mt-1 space-y-1">
                  {p.taskDetail.checklist.map(i => (
                    <li key={i.itemRef}><label className="flex items-center gap-2"><input type="checkbox" checked={i.done} onChange={e => p.onTickChecklist(i.itemRef, e.target.checked)} />{i.label}</label></li>
                  ))}
                </ul>
              </fieldset>
            )}
            {p.taskDetail.dependencies.length > 0 && (
              <p>Waits on: {p.taskDetail.dependencies.map(d => `${d.dependsOnTaskRef}${d.open ? " (open)" : " (done)"}`).join(", ")}</p>
            )}
            {p.taskDetail.reminders.length > 0 && <p>Reminders: {p.taskDetail.reminders.map(r => `${humanAction(r.state)} ${new Date(r.fireAt).toISOString().slice(0, 16).replace("T", " ")}`).join(", ")}</p>}
            <div className="flex flex-wrap gap-2">
              {p.taskDetail.actions.map(a => <Button key={a} size="sm" disabled={p.actingTask} onClick={() => p.onTaskAction(p.taskDetail!.taskRef, a)}>{humanAction(a)}</Button>)}
              {p.taskDetail.actions.length === 0 && <span className="text-muted-foreground">Nothing for you to do on this task right now.</span>}
              <Button size="sm" variant="ghost" onClick={p.onCloseTask}>Back to the board</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {p.lanes.map(lane => (
              <section key={lane.key} aria-label={lane.label} className="rounded-lg border p-3">
                <h2 className="mb-2 text-sm font-semibold">{lane.label} <span className="text-muted-foreground">({lane.tasks.length})</span></h2>
                <ul className="space-y-2">
                  {lane.tasks.map(t => (
                    <li key={t.taskRef}>
                      <button type="button" onClick={() => p.onOpenTask(t.taskRef)} className={`w-full rounded-lg border px-3 py-2 text-left ${t.overdue ? "border-red-300" : ""}`}>
                        <span className="block font-medium">{t.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t.kind === "company" ? "Company" : "Personal"} · {humanAction(t.priority)}{t.overdue ? " · overdue" : t.dueAt ? ` · due ${new Intl.DateTimeFormat("en-CA", { timeZone: p.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t.dueAt))}` : ""}
                          {t.assignmentState === "assigned" ? " · awaiting your acceptance" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                  {lane.tasks.length === 0 && <li className="text-xs text-muted-foreground">Empty.</li>}
                </ul>
              </section>
            ))}
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">New personal task</CardTitle></CardHeader>
            <CardContent>
              <form className="grid gap-2 sm:grid-cols-4" onSubmit={e => { e.preventDefault(); p.onCreateTask(draft); setDraft({ title: "", dueAt: "", remindMinutesBefore: 60 }); }}>
                <label className="sm:col-span-2 text-sm">Title<Input required value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
                <label className="text-sm">Due<Input type="datetime-local" value={draft.dueAt} onChange={e => setDraft({ ...draft, dueAt: e.target.value })} /></label>
                <label className="text-sm">Remind me
                  <select aria-label="Reminder before due" className="block w-full rounded border bg-background px-2 py-2" value={draft.remindMinutesBefore ?? ""} onChange={e => setDraft({ ...draft, remindMinutesBefore: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">No reminder</option><option value="30">30 min before</option><option value="60">1 h before</option><option value="1440">The day before</option>
                  </select>
                </label>
                <div className="sm:col-span-4 flex justify-end"><Button type="submit" disabled={p.creatingTask || !draft.title.trim()}>{p.creatingTask ? "Saving…" : "Add task"}</Button></div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/* ----------------------------- reminders ------------------------------ */

function RemindersTab(p: WorkCalendarViewProps) {
  const [draft, setDraft] = useState<NewReminder>({ title: "", at: "", level: "normal" });
  const [snoozing, setSnoozing] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <ul className="space-y-2" aria-label="Reminders">
        {p.reminders.length === 0 && <li className="text-sm text-muted-foreground">No reminders.</li>}
        {p.reminders.map(r => (
          <li key={r.reminderRef} className={`rounded-lg border p-3 ${r.state === "fired" || r.state === "missed" ? "border-amber-400" : ""}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-muted-foreground">{r.when} · {humanAction(r.level)}{r.requiresAcknowledgement ? " · acknowledgement required" : ""}{r.snoozeCount ? ` · snoozed ${r.snoozeCount}×` : ""}</div>
              </div>
              <Badge variant={r.state === "fired" ? "default" : r.state === "missed" ? "destructive" : "secondary"}>{humanAction(r.state)}</Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.actions.includes("acknowledge") && <Button size="sm" disabled={p.actingReminder} onClick={() => p.onReminderAction(r.reminderRef, "acknowledge")}>Got it</Button>}
              {r.actions.includes("snooze") && <Button size="sm" variant="outline" disabled={p.actingReminder} aria-expanded={snoozing === r.reminderRef} onClick={() => setSnoozing(snoozing === r.reminderRef ? null : r.reminderRef)}>Snooze</Button>}
              {r.actions.includes("cancel") && <Button size="sm" variant="ghost" disabled={p.actingReminder} onClick={() => p.onReminderAction(r.reminderRef, "cancel")}>Cancel</Button>}
            </div>
            {snoozing === r.reminderRef && (
              <div role="group" aria-label={`Snooze ${r.title}`} className="mt-2 flex flex-wrap gap-2">
                {SNOOZE_OPTIONS.map(o => <Button key={o.label} size="sm" variant="secondary" onClick={() => { setSnoozing(null); p.onReminderAction(r.reminderRef, "snooze", o.choice); }}>{o.label}</Button>)}
              </div>
            )}
          </li>
        ))}
      </ul>
      <Card>
        <CardHeader><CardTitle className="text-base">Remind me</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-2 sm:grid-cols-4" onSubmit={e => { e.preventDefault(); p.onCreateReminder(draft); setDraft({ title: "", at: "", level: "normal" }); }}>
            <label className="sm:col-span-2 text-sm">What<Input required placeholder="Bring my respirator" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="text-sm">When<Input type="datetime-local" required value={draft.at} onChange={e => setDraft({ ...draft, at: e.target.value })} /></label>
            <label className="text-sm">How loud
              <select aria-label="Reminder level" className="block w-full rounded border bg-background px-2 py-2" value={draft.level} onChange={e => setDraft({ ...draft, level: e.target.value as NewReminder["level"] })}>
                <option value="normal">Normal — a notification</option><option value="important">Important — stays until seen</option><option value="alarm">Alarm — rings on this device</option>
              </select>
            </label>
            <div className="sm:col-span-4 flex justify-end"><Button type="submit" disabled={p.creatingReminder || !draft.title.trim() || !draft.at}>{p.creatingReminder ? "Saving…" : "Set reminder"}</Button></div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">Yours alone. A personal reminder never reaches dispatch, however long it goes unanswered.</p>
        </CardContent>
      </Card>
    </div>
  );
}
