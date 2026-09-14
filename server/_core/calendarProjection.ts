/**
 * v22.20 — the calendar, projected rather than entered.
 *
 * Pure. No network, no database.
 *
 * A calendar that people type into is a second copy of the truth. Everything
 * here is derived from a record LeaseOS already owns, and every event says
 * which record it came from — so "TDG expires soon" is never a floating string
 * a reader has to go and verify by hand. Click it and the certificate is there,
 * because the event carries its reference.
 *
 * Three rules carry the module.
 *
 * **Provenance or it does not exist.** An event without a source is not
 * projected. The alternative is a calendar that slowly fills with entries
 * nobody can trace, which is how a compliance calendar becomes decoration.
 *
 * **Severity is not urgency.** Due, overdue, blocking and informational are
 * four different things. A missing meal receipt is overdue and stops nothing;
 * an expired qualification the job requires blocks. Collapsing them makes
 * people ignore the calendar, which is worse than not having one.
 *
 * **Unknown is not current.** An expiry nobody has verified projects as
 * unknown, never as fine. The same rule the rest of this system runs on.
 */

/** Who may see an event, independent of who it belongs to. */
export type Visibility = "private" | "operational" | "administrative";

export type CalendarLayer =
  | "shift" | "rotation" | "job" | "payroll" | "paperwork"
  | "compliance" | "equipment" | "training" | "dispatch" | "company" | "personal";

export type Severity = "informational" | "due" | "overdue" | "blocking" | "unknown";

/** Where an event came from. Not optional — see the module note. */
export type EventSource = {
  sourceType: string;
  sourceRef: string;
  /** The engine that derived it, so a wrong event can be traced to its rule. */
  generatedBy: string;
};

export type ProjectedEvent = {
  eventKey: string;
  layer: CalendarLayer;
  title: string;
  /** What the owner sees. Redacted for other audiences where visibility says so. */
  detail: string | null;
  at: Date;
  endsAt: Date | null;
  allDay: boolean;
  severity: Severity;
  visibility: Visibility;
  ownerUserId: number;
  source: EventSource;
  /** Where tapping it goes. Derived from the source, never typed by hand. */
  deepLink: string;
};

export class MissingProvenance extends Error {}

/**
 * Build one event. Refuses without a source rather than accepting a bare
 * string, which is the whole difference between this and a notes field.
 */
export function project(input: Omit<ProjectedEvent, "eventKey" | "deepLink"> & { eventKey?: string }): ProjectedEvent {
  const { source } = input;
  if (!source?.sourceType || !source?.sourceRef || !source?.generatedBy) {
    throw new MissingProvenance(`A calendar event needs the record it came from: "${input.title}" has none`);
  }
  return {
    ...input,
    eventKey: input.eventKey ?? `${source.sourceType}:${source.sourceRef}:${input.layer}:${input.at.toISOString().slice(0, 10)}`,
    deepLink: `/${source.sourceType}/${encodeURIComponent(source.sourceRef)}`,
  };
}

/* ------------------------------------------------------------------ */
/* What an audience is allowed to see                                   */
/* ------------------------------------------------------------------ */

export type Audience =
  | { kind: "self"; userId: number }
  | { kind: "operational"; userId: number }      // dispatch, supervisor
  | { kind: "administrative"; userId: number }   // payroll, HR
  | { kind: "client" };

export type VisibleEvent = ProjectedEvent & { redacted: boolean };

/**
 * Project one event for one audience.
 *
 * A private event is not hidden from dispatch — hiding it would show the person
 * as available when they are not. It is shown with its detail removed: dispatch
 * learns the time is taken and not what it is taken for. That distinction is
 * the point of having three classes rather than a boolean.
 */
export function forAudience(event: ProjectedEvent, audience: Audience): VisibleEvent | null {
  if (audience.kind === "client") return null;   // nothing personal reaches a client here
  const isOwner = audience.kind === "self" && audience.userId === event.ownerUserId;
  if (isOwner) return { ...event, redacted: false };
  if (audience.kind === "self") return null;     // somebody else's calendar is not theirs to read

  if (event.visibility === "private") {
    return { ...event, title: "Unavailable", detail: null, redacted: true };
  }
  if (event.visibility === "administrative" && audience.kind !== "administrative") return null;
  return { ...event, redacted: false };
}

export const visibleTo = (events: readonly ProjectedEvent[], audience: Audience): VisibleEvent[] =>
  events.flatMap(e => { const v = forAudience(e, audience); return v ? [v] : []; });

/* ------------------------------------------------------------------ */
/* Severity from a date and a rule                                      */
/* ------------------------------------------------------------------ */

export type DeadlineInput = {
  dueAt: Date | null;
  now: Date;
  /** Whether failing this stops work, rather than merely being late. */
  blocksWork: boolean;
  /** Days before the due date at which it starts being worth saying. */
  noticeDays?: number;
};

/**
 * Grade a deadline.
 *
 * `blocksWork` is supplied by the caller because only the caller knows whether
 * this particular requirement gates the job — an expired qualification the work
 * needs blocks; the same qualification on somebody not scheduled does not.
 */
export function severityOf({ dueAt, now, blocksWork, noticeDays = 30 }: DeadlineInput): Severity {
  if (!dueAt) return "unknown";
  const days = Math.floor((dueAt.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return blocksWork ? "blocking" : "overdue";
  if (days <= noticeDays) return "due";
  return "informational";
}

/* ------------------------------------------------------------------ */
/* Rotations                                                            */
/* ------------------------------------------------------------------ */

export type RotationPattern = { onDays: number; offDays: number; anchor: Date; label: string };

/** 7/7, 14/7, 14/14 and anything else expressible as on-then-off. */
export function isOnShift(pattern: RotationPattern, day: Date): boolean {
  const cycle = pattern.onDays + pattern.offDays;
  if (cycle <= 0) return false;
  const elapsed = Math.floor((day.getTime() - pattern.anchor.getTime()) / 86_400_000);
  const position = ((elapsed % cycle) + cycle) % cycle;   // negative-safe: days before the anchor
  return position < pattern.onDays;
}

export function rotationDays(pattern: RotationPattern, from: Date, days: number): { day: Date; on: boolean }[] {
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(from.getTime() + i * 86_400_000);
    return { day, on: isOnShift(pattern, day) };
  });
}

/* ------------------------------------------------------------------ */
/* What is owed                                                         */
/* ------------------------------------------------------------------ */

export type Outstanding = { label: string; source: EventSource; severity: Severity };

export type CutoffSummary = {
  cutoffAt: Date;
  hoursRemaining: number;
  outstanding: Outstanding[];
  blocking: Outstanding[];
  /** The line a driver reads. Names the count and the cutoff, not a vague nudge. */
  line: string;
};

/**
 * What a person owes before a cutoff.
 *
 * Deliberately not "you have outstanding items". A reminder that does not say
 * which items and by when is a reminder people learn to dismiss.
 */
export function beforeCutoff(args: { cutoffAt: Date; now: Date; items: readonly Outstanding[] }): CutoffSummary {
  const outstanding = args.items.filter(i => i.severity !== "informational");
  const blocking = outstanding.filter(i => i.severity === "blocking");
  const hoursRemaining = Math.round((args.cutoffAt.getTime() - args.now.getTime()) / 3_600_000);
  const when = hoursRemaining < 0 ? "passed" : hoursRemaining < 24 ? `in ${hoursRemaining} h` : `in ${Math.round(hoursRemaining / 24)} days`;
  const line = outstanding.length === 0
    ? `Nothing outstanding before the cutoff ${when}`
    : `${outstanding.length} item(s) required before the cutoff ${when}${blocking.length ? ` — ${blocking.length} of them blocking` : ""}`;
  return { cutoffAt: args.cutoffAt, hoursRemaining, outstanding, blocking, line };
}
