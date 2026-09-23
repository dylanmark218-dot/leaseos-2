# LeaseOS B23.1 — Work Calendar + Task & Reminder Engine

Status: **first vertical slice, gate-verified locally** · migration `0170` · 2026-09-23

## Purpose

A shared scheduling, task, reminder and notification subsystem that Dispatch, HOS, Payroll, the
Driver Portfolio, Training/Safety, Fleet, Documents and company communications can publish into,
and that a driver can use from a phone with no service.

## What the survey found, and what was decided

The repository already held most of what the brief asked for, and two of its decisions contradict
the brief as written. Both contradictions are resolved here in the repository's favour, with the
brief's intent kept.

| The brief said | The tree already had | Decision |
|---|---|---|
| `calendar_events` as the calendar's table | `server/calendarRouter.ts` (v22.20): a calendar **projected at read time** from leave, qualification expiries, shift interest and rotations, with `LEASEOS_CURRENT_STATE.md` stating "the calendar adds no table of its own" | **Both, by ownership.** Every date another context owns stays projected and is never copied. `calendarEvents` (0170) holds only what nothing else owns — a meeting, a training session, a stand-down, a personal appointment, a block of time for a task. A stored row may *link* to a record (`sourceType`/`sourceRef`) and moving it here is refused: "change the date there and the calendar follows". |
| A task board with checklists, comments, dependencies, reminders, personal and company workflows | `operationalTasks` (0015): tasks the **workflow engine derives from domain events**, one condition one task, role-assigned, with `requiresEvidence` | **Not the same thing, so not the same table.** `workTasks` holds work a person or the company created for a person. Workflow consequences stay where they are; a future step may project them onto the board read-only. The evidence rule is carried over: regulated work is submitted with evidence and verified by a second person. |
| A `notification_deliveries` table | `workflowNotifications` (0015): channel, status, `sentAt` / `viewedAt` / `acknowledgedAt`, read by the inbox and by the escalation ladder | **Reused.** A reminder that fires writes one `workflowNotifications` row per channel under a derived, unique key. The inbox and every existing reader see it; no second delivery system exists. |
| Escalation policies | `server/_core/escalation.ts`: the ladder engine, "viewed is not acknowledged" | **Reused** for company reminders; the policy is stored on the reminder. A personal reminder returns no ladder whatever it carries, and the validator refuses to store one. |
| Two task state machines | Roadside panel, time off and readiness each keep one vocabulary with per-kind legality | **One vocabulary, one table of legal moves per kind** (`server/_core/workTasks.ts`). |
| A tenant on every row | `orgRef` NULL = historical single tenant (0132), derived from membership by `resolveActingScope`, never from input | Followed. `orgRef` on every new table; no procedure accepts an organization. |
| `calendar_preferences`, `notification_preferences` | — | **Deferred.** The zone travels on each record; channel preference is a later slice. |

## Architectural rule, kept

The calendar is not the source of truth for HOS, dispatch, payroll, credentials or fleet. The
adapters in `server/_core/workProjections.ts` take a result those engines already produced and
say what the calendar shows: an HOS determination that reads UNKNOWN projects UNKNOWN; a
within-limit clock projects an end of window labelled **PROJECTED** with the sentence "The HOS
engine, not this arithmetic, decides compliance"; an exceeded limit is **REQUIRED** rest in the
engine's own words. No adapter reads a duty log, a certificate image or an invoice.

## What was built

**Schema (0170), ten tables:** `recurrenceRules`, `calendarEvents`, `calendarEventParticipants`,
`workTasks`, `workTaskChecklistItems`, `workTaskDependencies`, `workTaskComments`,
`workTaskAttachments` (pointers to vault evidence, no bytes), `reminders`, `reminderActions`
(append-only, `actionRef` unique), `workAuditEvents` (append-only; a private subject's row carries
the action and the reference and no content).

**Pure engines (`server/_core/`):**
- `recurrence.ts` — daily, weekdays, weekly by weekday, monthly by day or ordinal weekday, every N,
  until / count; wall clock kept across DST by anchoring to a zone; bounded; refuses unsound rules.
- `workTasks.ts` — the state machine; verifier ≠ assignee; evidence before submission; a blocked
  predecessor is a refusal that names it.
- `reminders.ts` — scheduled / fired / snoozed / acknowledged / missed / completed / cancelled;
  snooze presets, tonight, tomorrow, custom, and two semantic choices reserved as *deferred*;
  compliance snooze bounded at three and recorded; derived notification keys; the device schedule
  entry and the idempotent replay plan.
- `reminderCommands.ts` — the deterministic contract a voice/AI layer calls: a typed `when`
  (absolute, relative to shift, recurring, before a source date, after a job, on return to yard),
  a plan with a read-back, or a refusal that names what it needs. No language in it.
- `calendarEvents.ts` — stored events as entries with state (CONFIRMED / PROJECTED / RECOMMENDED /
  REQUIRED / CANCELLED); the seven views; `availabilityFor`, whose result type has no field for a
  title and reads only layer, visibility and window.
- `workProjections.ts` — the adapters for dispatch bookings, HOS determinations, pay periods,
  credential expiries, maintenance due, outstanding documents and safety meetings; each proposes
  entries, tasks and reminders with dedupe keys.

**Service and API:** `server/workService.ts` (idempotent writes, the sweep, device replay) and
`server/workRouter.ts` mounted as `work.*` — 33 procedures under five permissions:

| Permission | Holds it | Fail-closed |
|---|---|---|
| `work.own` | every domain role | |
| `work.assign` | dispatcher, safety, shop lead, office, management, HR | yes |
| `work.verify` | dispatcher, safety, shop lead, office, management, HR | yes |
| `work.scheduling` | those plus mechanic, payroll admin, controller | |
| `work.sweep` | dispatcher, office, management | |

The worker runs `sweepWork` on every heartbeat (`server/_core/workflowRuntime.ts`): fire due
reminders, mark missed, advance recurring ones, climb company ladders, escalate overdue company
tasks — every step keyed so a second pass changes nothing. Company task and event transitions
also go out on `domainEventOutbox` with ids derived from the subject and the instant.

**Client:** `client/src/work/viewModels.ts` (agenda / week / lanes / reminder rows, proved in Node),
`client/src/runtime/reminderQueue.ts` (the device's cached schedule, what is due with no service,
locally recorded actions with once-only references, replay), `client/src/pages/WorkCalendarView.tsx`
(presentational; in the axe suite at three widths) and `client/src/pages/WorkCalendar.tsx` at
`/work`, linked from the dashboard navigation and the portal shell.

## Tests added

| File | Cases | Proves |
|---|---|---|
| `server/_core/recurrence.test.ts` | 16 | DST wall clock, weekdays, weekly / monthly / ordinal / 31st-skip, until, limit, refusals |
| `server/_core/workTasks.test.ts` | 14 | both kinds, every refusal named, verifier ≠ assignee, dependencies |
| `server/_core/reminders.test.ts` | 23 | lifecycle, snooze, compliance cap, ladder null for personal, device replay plan, command contract |
| `server/_core/calendarEvents.test.ts` | 10 | entries, recurrence expansion, all-day boundary, views, availability leaks nothing |
| `server/_core/workProjections.test.ts` | 12 | HOS consumed not computed, credentials, payroll, dispatch, fleet, documents, safety |
| `server/workEngine.db.test.ts` | 22 | through `appRouter`: cross-tenant refusal, permission refusals, redaction, recurring over DST, all-day boundary, acknowledgement, source-linked event follows its record, task lifecycle with evidence and verification, dependencies, idempotent sweep, snooze/acknowledge/cancel, device replay once, device schedule, company escalation, personal never escalates, task escalation, command contract |
| `server/reminderQueue.test.ts` | 7 | the device queue: due with no service, local snooze re-arms, replay once, transport failure keeps everything |
| `server/workViewModels.test.ts` | 5 | grouping by local day, week columns, lanes, due line, reminder rows |
| `client/src/pages/WorkCalendarView.dom.test.tsx` | 7 | redacted stays Unavailable, projected labelled, actions only as listed, forms, offline line |

Pinned counts moved deliberately: operational procedures 629 → 662, mounted paths 691 → 724,
inventory total 356 → 389; `client/src/pages/WorkCalendar.tsx` added to the a11y no-harness list;
`WorkCalendarView` added to the axe suite.

## Known limitations

- Native local notifications are still device work (P1.1). The server hands the device a
  schedule and applies its replay once; scheduling the notification under iOS/Android rules is
  the Capacitor shell's, and nothing here claims to bypass those rules.
- The device queue is not yet inside the signed evidence package; it replays through its own
  procedure. Folding it into `recordUpdates` is a later step.
- "After the current job" and "when back on duty" snoozes are refused as *deferred*, not guessed.
- Workflow-derived `operationalTasks` are not yet projected onto the board.
- Preference tables (default channels, quiet hours) are deferred; the zone lives on each record.
- Availability reads leave, private events, dispatch bookings and rotation. HOS duty status is
  accepted by the engine but not yet wired from the HOS router.
- Email and SMS channels are declared and not delivered, as elsewhere in the tree.

## Recommended next checkpoint

**Scheduling Intelligence:** compose `availabilityFor`, the HOS determination, dispatch bookings,
leave and equipment readiness into one answer for dispatch — "available from 06:00, but the
remaining duty window means the projected job cannot finish before it ends" — with every line
citing the engine it came from and UNKNOWN wherever one of them says so.
