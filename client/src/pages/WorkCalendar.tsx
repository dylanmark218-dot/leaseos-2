/**
 * 0170 — the work calendar, the board and the reminders, live.
 *
 * The container: reads the server, composes the view-models, renders the view. Every decision
 * about what a person sees is in `client/src/work/viewModels.ts` and every screen state is in
 * `WorkCalendarView`; this file only wires the two to tRPC and to the browser's clock and zone.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { WorkCalendarView, type CalendarMode, type CalendarViewKey, type TaskDetailView, type WorkTab } from "./WorkCalendarView";
import { dueLine, groupAgenda, reminderRows, taskLanes, weekColumns, type CalendarEntryView, type ReminderView, type TaskView } from "../work/viewModels";

const DAY = 86_400_000;
const localInput = (s: string) => (s ? new Date(s) : undefined);

export default function WorkCalendar() {
  const [location] = useLocation();
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [tab, setTab] = useState<WorkTab>(location.includes("/tasks") ? "tasks" : location.includes("/reminders") ? "reminders" : "calendar");
  const [mode, setMode] = useState<CalendarMode>("agenda");
  const [view, setView] = useState<CalendarViewKey>("my");
  const [from, setFrom] = useState<Date>(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [now, setNow] = useState<Date>(() => new Date());
  const [selectedEntry, setSelectedEntry] = useState<CalendarEntryView | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(() => location.match(/\/work\/tasks\/([^/]+)/)?.[1] ?? null);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); window.clearInterval(tick); };
  }, []);

  const utils = trpc.useUtils();
  const days = mode === "day" ? 1 : mode === "week" ? 7 : 14;
  const calendar = trpc.work.calendar.useQuery({ from, days, view, now }, { refetchInterval: 60_000 });
  const tasks = trpc.work.taskList.useQuery({ scope: "mine", now }, { refetchInterval: 60_000 });
  const taskDetail = trpc.work.taskGet.useQuery({ taskRef: openTask ?? "", now }, { enabled: !!openTask });
  const reminders = trpc.work.reminderList.useQuery(undefined, { refetchInterval: 30_000 });

  const refresh = async () => { await Promise.all([utils.work.calendar.invalidate(), utils.work.taskList.invalidate(), utils.work.taskGet.invalidate(), utils.work.reminderList.invalidate()]); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const createEvent = trpc.work.eventCreate.useMutation({ onSuccess: async () => { toast.success("Added to your calendar."); await refresh(); }, onError });
  const createTask = trpc.work.taskCreate.useMutation({ onSuccess: async r => { toast.success(r.reminderRef ? "Task added, reminder set." : "Task added."); await refresh(); }, onError });
  const transition = trpc.work.taskTransition.useMutation({ onSuccess: async r => { toast.success(`Now ${r.status.replace(/_/g, " ")}.`); await refresh(); }, onError });
  const verify = trpc.work.taskVerify.useMutation({ onSuccess: async () => { toast.success("Recorded."); await refresh(); }, onError });
  const tick = trpc.work.taskChecklistTick.useMutation({ onSuccess: () => utils.work.taskGet.invalidate(), onError });
  const createReminder = trpc.work.reminderCreate.useMutation({ onSuccess: async () => { toast.success("Reminder set."); await refresh(); }, onError });
  const snooze = trpc.work.reminderSnooze.useMutation({ onSuccess: async () => { toast.success("Snoozed."); await refresh(); }, onError });
  const acknowledge = trpc.work.reminderAcknowledge.useMutation({ onSuccess: async r => { toast.success(r.nextFireAt ? "Got it — next one is scheduled." : "Got it."); await refresh(); }, onError });
  const cancel = trpc.work.reminderCancel.useMutation({ onSuccess: async () => { toast.success("Cancelled."); await refresh(); }, onError });

  const entries = (calendar.data?.entries ?? []) as unknown as CalendarEntryView[];
  const agenda = useMemo(() => groupAgenda(entries, timezone), [entries, timezone]);
  const week = useMemo(() => weekColumns(entries, from, timezone), [entries, from, timezone]);
  const lanes = useMemo(() => taskLanes((tasks.data?.tasks ?? []) as unknown as TaskView[]), [tasks.data]);
  const rows = useMemo(() => reminderRows((reminders.data?.reminders ?? []) as unknown as ReminderView[], timezone), [reminders.data, timezone]);
  const detail: TaskDetailView | null = useMemo(() => {
    const d = taskDetail.data;
    if (!openTask || !d) return null;
    return {
      taskRef: d.task.taskRef, title: d.task.title, description: d.task.description, status: d.task.status, kind: d.task.kind, priority: d.task.priority,
      dueLine: dueLine({ dueAt: d.task.dueAt, overdue: d.task.overdue, status: d.task.status }, now, timezone),
      checklist: d.checklist.map(i => ({ itemRef: i.itemRef, label: i.label, done: i.done })),
      actions: [...d.actions, ...(d.task.status === "submitted" && (tasks.data?.toVerify ?? []).includes(d.task.taskRef) ? ["verify", "return"] : [])],
      dependencies: d.dependencies, reminders: d.reminders.map(r => ({ reminderRef: r.reminderRef, fireAt: r.fireAt, state: r.state })),
    };
  }, [taskDetail.data, openTask, now, timezone, tasks.data]);

  return (
    <WorkCalendarView
      tab={tab} onTab={setTab} timezone={timezone} now={now} online={online} offlineStatus={null}
      mode={mode} onMode={setMode} from={from} onShift={n => setFrom(new Date(from.getTime() + n * DAY))} view={view} onView={setView}
      calendarLoading={calendar.isLoading} agenda={agenda} week={week} actionable={(calendar.data?.actionable ?? []) as unknown as CalendarEntryView[]}
      selectedEntry={selectedEntry} onSelectEntry={setSelectedEntry}
      onCreateEvent={e => createEvent.mutate({ title: e.title, startsAt: new Date(e.startsAt), endsAt: localInput(e.endsAt), allDay: e.allDay, timezone })} creatingEvent={createEvent.isPending}
      lanes={lanes} taskDetail={detail} onOpenTask={setOpenTask} onCloseTask={() => setOpenTask(null)}
      onTaskAction={(taskRef, action) => action === "verify" || action === "return"
        ? verify.mutate({ taskRef, decision: action, reason: action === "return" ? window.prompt("What was wrong with it?") ?? undefined : undefined })
        : transition.mutate({ taskRef, action, reason: action === "block" ? window.prompt("What blocks it?") ?? undefined : undefined })}
      actingTask={transition.isPending || verify.isPending}
      onCreateTask={t => createTask.mutate({ title: t.title, dueAt: localInput(t.dueAt), timezone, reminder: t.remindMinutesBefore != null && t.dueAt ? { offsetMinutes: -t.remindMinutesBefore, level: "important" } : undefined })} creatingTask={createTask.isPending}
      onTickChecklist={(itemRef, done) => tick.mutate({ itemRef, done })}
      reminders={rows}
      onReminderAction={(reminderRef, action, choice) => action === "acknowledge" ? acknowledge.mutate({ reminderRef }) : action === "cancel" ? cancel.mutate({ reminderRef }) : choice && snooze.mutate({ reminderRef, choice })}
      actingReminder={snooze.isPending || acknowledge.isPending || cancel.isPending}
      onCreateReminder={r => createReminder.mutate({ title: r.title, at: new Date(r.at), level: r.level, timezone })} creatingReminder={createReminder.isPending}
    />
  );
}
