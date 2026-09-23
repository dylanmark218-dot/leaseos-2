/**
 * 0170 — the events the calendar itself owns, and the availability read that shows none of them.
 *
 * Pure. No network, no database.
 *
 * The projection rule of v22.20 still governs: every entry names the record it came from. For a
 * meeting, a training session or a driver's own appointment, that record IS the calendar row —
 * nothing else owns those dates — so its source is `calendarEvent:<eventRef>` and `project()`
 * accepts it on the same terms as a leave request. A row that LINKS to a job or a unit carries
 * that link alongside; the job keeps its own dates and the projection still reads the job.
 *
 * Two more rules this file adds.
 *
 * **State is not severity.** CONFIRMED is a fact, PROJECTED and RECOMMENDED are advice, REQUIRED
 * wants an acknowledgement, CANCELLED is kept and shown as such. An HOS cycle end projected onto
 * Thursday reads PROJECTED so that nobody mistakes an estimate for the legal answer, which the
 * HOS engine alone gives.
 *
 * **Availability has no field for a title.** `AvailabilityWindow` carries a status, a window and
 * the TYPE of record behind it, and is computed from layers and visibility rather than from
 * words, so a private appointment reaches dispatch as UNAVAILABLE 13:00–15:00 and never as
 * anything else. Structural, like the leave engine's scheduling view: there is nowhere for a
 * reason to leak to.
 */

import { project, severityOf, type CalendarLayer, type ProjectedEvent, type Severity, type VisibleEvent, type Visibility } from "./calendarProjection";
import { occurrencesBetween, type RecurrenceRule } from "./recurrence";

export type EventState = "confirmed" | "projected" | "recommended" | "required" | "cancelled";
export type EventKind = "personal" | "company";
export type EventCategory = "shift" | "meeting" | "training" | "safety" | "maintenance" | "dispatch" | "payroll" | "compliance" | "task_block" | "personal" | "other";

export const EVENT_STATES: readonly EventState[] = ["confirmed", "projected", "recommended", "required", "cancelled"];
export const EVENT_CATEGORIES: readonly EventCategory[] = ["shift", "meeting", "training", "safety", "maintenance", "dispatch", "payroll", "compliance", "task_block", "personal", "other"];

/** A stored event, as the engine sees it. */
export type PersistedEvent = {
  eventRef: string;
  kind: EventKind;
  category: EventCategory;
  state: EventState;
  visibility: Visibility;
  ownerUserId: number;
  title: string;
  detail: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  timezone: string;
  requiresAcknowledgement: boolean;
  acknowledged: boolean;
  taskRef: string | null;
  sourceType: string | null;
  sourceRef: string | null;
  recurrence: RecurrenceRule | null;
};

/** What every calendar surface renders: a projected event plus the state and where it came from. */
export type CalendarEntry = ProjectedEvent & {
  state: EventState;
  category: EventCategory | null;
  /** `record` — a row the calendar owns; `projection` — derived from a record another context owns. */
  basis: "record" | "projection";
  /** The linked record, when a stored event points at one. */
  link: { sourceType: string; sourceRef: string } | null;
  taskRef: string | null;
  timezone: string | null;
};

export function layerFor(category: EventCategory): CalendarLayer {
  switch (category) {
    case "shift": return "shift";
    case "meeting": return "company";
    case "training": return "training";
    case "safety": return "compliance";
    case "maintenance": return "equipment";
    case "dispatch": return "dispatch";
    case "payroll": return "payroll";
    case "compliance": return "compliance";
    case "task_block": return "job";
    case "personal": return "personal";
    case "other": return "company";
  }
}

/** Severity, from the state and whether it has been dealt with. A required event nobody acknowledged is due. */
export function severityForState(state: EventState, acknowledged: boolean, startsAt: Date, now: Date): Severity {
  if (state === "cancelled") return "informational";
  if (state === "required" && !acknowledged) return startsAt.getTime() < now.getTime() ? "overdue" : "due";
  return "informational";
}

/**
 * Expand one stored event into the entries a window shows: one per occurrence, each carrying the
 * same reference and its own key. A cancelled event is present and marked, never silently absent.
 */
export function toEntries(ev: PersistedEvent, from: Date, to: Date, now: Date = from): CalendarEntry[] {
  const source = { sourceType: "calendarEvent", sourceRef: ev.eventRef, generatedBy: ev.kind === "company" ? "company_event" : "personal_event" };
  const duration = ev.endsAt ? ev.endsAt.getTime() - ev.startsAt.getTime() : null;
  const starts: Date[] = ev.recurrence
    ? occurrencesBetween(ev.recurrence, from, to)
    : (ev.startsAt.getTime() < to.getTime() && (ev.endsAt ?? ev.startsAt).getTime() >= from.getTime() ? [ev.startsAt] : []);
  return starts.map(at => ({
    ...project({
      eventKey: `${ev.eventRef}:${at.toISOString()}`,
      layer: layerFor(ev.category),
      title: ev.state === "cancelled" ? `Cancelled — ${ev.title}` : ev.title,
      detail: ev.detail,
      at, endsAt: duration != null ? new Date(at.getTime() + duration) : null,
      allDay: ev.allDay,
      severity: severityForState(ev.state, ev.acknowledged, at, now),
      visibility: ev.visibility,
      ownerUserId: ev.ownerUserId,
      source,
    }),
    state: ev.state, category: ev.category, basis: "record", link: ev.sourceType && ev.sourceRef ? { sourceType: ev.sourceType, sourceRef: ev.sourceRef } : null,
    taskRef: ev.taskRef, timezone: ev.timezone,
  }));
}

/** Lift a v22.20 projection (leave, ticket expiry, rotation…) into the shared entry shape. Its state is what its severity implies. */
export function fromProjection(e: ProjectedEvent, state: EventState = "confirmed"): CalendarEntry {
  return { ...e, state, category: null, basis: "projection", link: null, taskRef: null, timezone: null };
}

/* ------------------------------------------------------------------ */
/* Views                                                                */
/* ------------------------------------------------------------------ */

export const CALENDAR_VIEWS = ["my", "crew", "dispatch", "fleet", "safety", "payroll", "company"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** Which layers each view shows. `my` and `company` show everything the audience may see. */
export function layersForView(view: CalendarView): readonly CalendarLayer[] | null {
  switch (view) {
    case "my": case "company": return null;
    case "crew": return ["shift", "rotation", "dispatch", "job", "personal"];
    case "dispatch": return ["shift", "rotation", "dispatch", "job", "personal", "compliance"];
    case "fleet": return ["equipment", "compliance"];
    case "safety": return ["compliance", "training", "company"];
    case "payroll": return ["payroll", "paperwork", "shift"];
  }
}

export function filterForView<T extends { layer: CalendarLayer }>(entries: readonly T[], view: CalendarView): T[] {
  const layers = layersForView(view);
  return layers ? entries.filter(e => layers.includes(e.layer)) : [...entries];
}

/* ------------------------------------------------------------------ */
/* Availability                                                         */
/* ------------------------------------------------------------------ */

export type AvailabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "ON_DUTY" | "OFF_DUTY" | "ASSIGNED" | "UNKNOWN";

/** A window and a status. No title, no detail, no reason — by type, not by filter. */
export type AvailabilityWindow = {
  from: Date;
  to: Date;
  status: AvailabilityStatus;
  /** The kind of record behind it: "leaveRequest", "calendarEvent", "resourceBooking", "crewMember"… never its content. */
  basis: string;
};

export type AvailabilityResult = {
  userId: number;
  from: Date;
  to: Date;
  /** The worst status in the window, so a scheduler reads one word first. */
  status: AvailabilityStatus;
  windows: AvailabilityWindow[];
  note: string;
};

export type AvailabilityInputs = {
  userId: number;
  from: Date;
  to: Date;
  /** Already passed through `visibleTo` for the asking audience. Titles are not read. */
  entries: readonly (VisibleEvent | CalendarEntry)[];
  /** True on hitch, false off, null when no rotation is recorded. */
  rotationOn?: boolean | null;
  /** From the HOS engine's own record of the duty status, when known. */
  dutyStatus?: "on_duty" | "off_duty" | null;
  /** Dispatch bookings, from the dispatch context. */
  assignments?: readonly { from: Date; to: Date; ref: string }[];
};

const RANK: Record<AvailabilityStatus, number> = { UNAVAILABLE: 0, ASSIGNED: 1, ON_DUTY: 2, OFF_DUTY: 3, AVAILABLE: 4, UNKNOWN: 5 };

/**
 * What a scheduler may know about somebody's time.
 *
 * Reads `layer`, `visibility`, `redacted` and the window of each entry, and nothing else: the
 * function is written so that a title cannot influence the answer, and the result type has no
 * field to carry one. UNAVAILABLE wins over ASSIGNED wins over duty wins over AVAILABLE, and a
 * person with no rotation, no duty record and nothing in the window is UNKNOWN — not free.
 */
export function availabilityFor(input: AvailabilityInputs): AvailabilityResult {
  const windows: AvailabilityWindow[] = [];
  const clamp = (a: Date, b: Date | null) => ({ from: new Date(Math.max(a.getTime(), input.from.getTime())), to: new Date(Math.min((b ?? new Date(a.getTime() + 86_400_000)).getTime(), input.to.getTime())) });
  for (const e of input.entries) {
    if (e.at.getTime() >= input.to.getTime() || (e.endsAt ?? e.at).getTime() < input.from.getTime()) continue;
    const redacted = "redacted" in e && e.redacted;
    const w = clamp(e.at, e.endsAt);
    if (e.layer === "personal" || redacted || e.visibility === "private") { windows.push({ ...w, status: "UNAVAILABLE", basis: e.source.sourceType }); continue; }
    if (e.layer === "shift" && e.source.sourceType === "leaveRequest") { windows.push({ ...w, status: "UNAVAILABLE", basis: e.source.sourceType }); continue; }
    if (e.layer === "dispatch" || e.layer === "job") { windows.push({ ...w, status: "ASSIGNED", basis: e.source.sourceType }); continue; }
    if (e.layer === "rotation") { windows.push({ ...w, status: "ON_DUTY", basis: e.source.sourceType }); continue; }
  }
  for (const a of input.assignments ?? []) {
    if (a.from.getTime() >= input.to.getTime() || a.to.getTime() < input.from.getTime()) continue;
    windows.push({ ...clamp(a.from, a.to), status: "ASSIGNED", basis: "resourceBooking" });
  }
  windows.sort((a, b) => a.from.getTime() - b.from.getTime() || RANK[a.status] - RANK[b.status]);

  let overall: AvailabilityStatus;
  const worst = windows.reduce<AvailabilityStatus | null>((acc, w) => acc == null || RANK[w.status] < RANK[acc] ? w.status : acc, null);
  if (worst && RANK[worst] <= RANK.ASSIGNED) overall = worst;
  else if (input.dutyStatus === "on_duty") overall = "ON_DUTY";
  else if (input.dutyStatus === "off_duty") overall = "OFF_DUTY";
  else if (input.rotationOn === true || worst === "ON_DUTY") overall = "AVAILABLE";
  else if (input.rotationOn === false) overall = "OFF_DUTY";
  else overall = "UNKNOWN";

  const note = overall === "UNKNOWN"
    ? "No rotation, duty record or booking covers this window. Unknown is not available."
    : overall === "UNAVAILABLE"
      ? "A window is taken. What it is taken for is not part of this answer."
      : overall === "ASSIGNED" ? "Dispatch already has this person in the window." : `${overall.replace("_", " ").toLowerCase()} for the window asked about.`;
  return { userId: input.userId, from: input.from, to: input.to, status: overall, windows, note };
}

/** The fields an event may carry when somebody else reads it. Private events lose their words upstream; this is belt and braces. */
export const AVAILABILITY_FIELDS: readonly (keyof AvailabilityWindow)[] = ["from", "to", "status", "basis"];

/** Every entry within a window's bounds, worst first, for the exceptions strip. */
export function actionable(entries: readonly CalendarEntry[]): CalendarEntry[] {
  const order: Record<Severity, number> = { blocking: 0, overdue: 1, due: 2, unknown: 3, informational: 4 };
  return entries.filter(e => e.severity !== "informational").sort((a, b) => order[a.severity] - order[b.severity] || a.at.getTime() - b.at.getTime());
}
