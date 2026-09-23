/**
 * 0170 — the contract a voice or AI layer calls to create a reminder.
 *
 * Pure. No network, no database, and — deliberately — no language in it.
 *
 * "LeaseOS, remind me tomorrow at 6 AM to bring my respirator" is two jobs. Turning the sentence
 * into a structure is the parser's job and it is not written here; turning the structure into a
 * reminder is this file's job, and it is deterministic: the same command in the same context
 * plans the same reminder, and a command the context cannot resolve says what it needs instead
 * of guessing. That is the boundary the Secretary already keeps (server/_core/secretaryCoordination.ts):
 * a reminder is the one thing a machine may create without asking, and even then it proposes a
 * plan a person can read back before it exists.
 */

import { describeRule, validateRule, zonedParts, zonedToUtc, type RecurrenceRule } from "./recurrence";
import type { ReminderLevel, ReminderRelativeTo } from "./reminders";

export type ReminderWhen =
  /** "tomorrow at 6 AM" — the parser resolved the instant; this checks it is ahead. */
  | { kind: "absolute"; at: Date }
  /** "30 minutes before my shift" — needs the next shift start from the roster. */
  | { kind: "relative_to_shift"; offsetMinutes: number }
  /** "every Friday" — a rule, anchored to its first occurrence. */
  | { kind: "recurring"; rule: RecurrenceRule }
  /** "two weeks before my H2S expires" — needs the expiry the credential record holds. */
  | { kind: "before_source"; sourceType: string; sourceRef: string; offsetDays: number }
  /** "after this job" — needs the job's estimated end; otherwise it is deferred, not guessed. */
  | { kind: "after_job"; jobRef: string }
  /** "when I get back to the yard" — a geofence trigger this slice does not resolve. */
  | { kind: "on_return_to_yard" };

export type ReminderCommand = {
  what: string;
  when: ReminderWhen;
  level?: ReminderLevel;
};

export type CommandContext = {
  now: Date;
  timezone: string;
  /** The owner's next rostered shift start, when the roster knows one. */
  nextShiftStartAt?: Date | null;
  /** Dates the referenced records hold, keyed `${sourceType}:${sourceRef}`. Null means the record has no date. */
  sourceDates?: Readonly<Record<string, Date | null>>;
  /** Estimated end per job, when dispatch has one. */
  jobEstimatedEndAt?: Readonly<Record<string, Date | null>>;
};

export type PlannedReminder = {
  title: string;
  level: ReminderLevel;
  fireAt: Date;
  relativeTo: ReminderRelativeTo;
  offsetMinutes: number | null;
  sourceType: string | null;
  sourceRef: string | null;
  recurrence: RecurrenceRule | null;
  timezone: string;
  /** What the assistant reads back before the reminder exists. */
  readBack: string;
};

export type PlanOutcome =
  | { ok: true; plan: PlannedReminder }
  | { ok: false; reason: string; needs: string | null };

const TITLE_MAX = 220;

function localStamp(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${tz}`;
}

/** Turn a resolved command into the reminder it means, or say what is missing. */
export function planReminder(cmd: ReminderCommand, ctx: CommandContext): PlanOutcome {
  const title = cmd.what.trim().slice(0, TITLE_MAX);
  if (!title) return { ok: false, reason: "A reminder says what to do", needs: "what" };
  const level = cmd.level ?? "normal";
  const base = { title, level, timezone: ctx.timezone, recurrence: null as RecurrenceRule | null, sourceType: null as string | null, sourceRef: null as string | null };
  switch (cmd.when.kind) {
    case "absolute": {
      if (cmd.when.at.getTime() <= ctx.now.getTime()) return { ok: false, reason: `${localStamp(cmd.when.at, ctx.timezone)} has already passed`, needs: null };
      return { ok: true, plan: { ...base, fireAt: cmd.when.at, relativeTo: "none", offsetMinutes: null, readBack: `Remind you to ${title} at ${localStamp(cmd.when.at, ctx.timezone)}` } };
    }
    case "relative_to_shift": {
      if (!ctx.nextShiftStartAt) return { ok: false, reason: "No upcoming shift is on the roster to be relative to", needs: "nextShiftStartAt" };
      const fireAt = new Date(ctx.nextShiftStartAt.getTime() + cmd.when.offsetMinutes * 60_000);
      if (fireAt.getTime() <= ctx.now.getTime()) return { ok: false, reason: `${Math.abs(cmd.when.offsetMinutes)} minutes before that shift has already passed`, needs: null };
      const rel = cmd.when.offsetMinutes < 0 ? `${-cmd.when.offsetMinutes} minutes before` : cmd.when.offsetMinutes === 0 ? "at" : `${cmd.when.offsetMinutes} minutes after`;
      return { ok: true, plan: { ...base, fireAt, relativeTo: "event_start", offsetMinutes: cmd.when.offsetMinutes, sourceType: "shift", sourceRef: null, readBack: `Remind you to ${title} ${rel} your shift starting ${localStamp(ctx.nextShiftStartAt, ctx.timezone)}` } };
    }
    case "recurring": {
      const problems = validateRule(cmd.when.rule);
      if (problems.length) return { ok: false, reason: problems.join("; "), needs: null };
      return { ok: true, plan: { ...base, fireAt: cmd.when.rule.anchorAt, relativeTo: "none", offsetMinutes: null, recurrence: cmd.when.rule, readBack: `Remind you to ${title} ${describeRule(cmd.when.rule)}` } };
    }
    case "before_source": {
      const key = `${cmd.when.sourceType}:${cmd.when.sourceRef}`;
      const at = ctx.sourceDates?.[key];
      if (at === undefined) return { ok: false, reason: `Nothing was looked up for ${key}`, needs: `sourceDates[${key}]` };
      if (at === null) return { ok: false, reason: `${key} has no date recorded, so nothing can be relative to it — a date nobody has established is not one to count back from`, needs: null };
      const fireAt = new Date(at.getTime() - cmd.when.offsetDays * 86_400_000);
      if (fireAt.getTime() <= ctx.now.getTime()) return { ok: false, reason: `${cmd.when.offsetDays} days before ${localStamp(at, ctx.timezone)} has already passed`, needs: null };
      return { ok: true, plan: { ...base, fireAt, relativeTo: "source_date", offsetMinutes: -cmd.when.offsetDays * 1440, sourceType: cmd.when.sourceType, sourceRef: cmd.when.sourceRef, readBack: `Remind you to ${title} ${cmd.when.offsetDays} days before ${key} on ${localStamp(fireAt, ctx.timezone)}` } };
    }
    case "after_job": {
      const at = ctx.jobEstimatedEndAt?.[cmd.when.jobRef];
      if (!at) return { ok: false, reason: `Job ${cmd.when.jobRef} has no estimated end yet; the reminder would be a guess`, needs: `jobEstimatedEndAt[${cmd.when.jobRef}]` };
      return { ok: true, plan: { ...base, fireAt: at, relativeTo: "source_date", offsetMinutes: 0, sourceType: "job", sourceRef: cmd.when.jobRef, readBack: `Remind you to ${title} when job ${cmd.when.jobRef} is expected to finish, ${localStamp(at, ctx.timezone)}` } };
    }
    case "on_return_to_yard":
      return { ok: false, reason: "A reminder on returning to the yard is a location trigger; the device's geofence is not wired in this slice", needs: "geofence" };
  }
}

/** Helper for the parser: "tomorrow at 06:00" in the owner's zone, as an instant. */
export function tomorrowAt(hour: number, minute: number, now: Date, tz: string): Date {
  const p = zonedParts(new Date(now.getTime() + 86_400_000), tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day, hour, minute, second: 0 }, tz);
}

/** Helper for the parser: the next `weekday` at `hh:mm` in the owner's zone, as an anchor for a weekly rule. */
export function nextWeekdayAt(weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6, hour: number, minute: number, now: Date, tz: string): Date {
  const today = zonedParts(now, tz);
  let delta = (weekday - today.weekday + 7) % 7;
  let candidate = zonedToUtc({ year: today.year, month: today.month, day: today.day + delta, hour, minute, second: 0 }, tz);
  if (candidate.getTime() <= now.getTime()) { delta += 7; candidate = zonedToUtc({ year: today.year, month: today.month, day: today.day + delta, hour, minute, second: 0 }, tz); }
  return candidate;
}
