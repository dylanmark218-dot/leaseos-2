/**
 * 0170 — recurrence, as arithmetic on a wall clock.
 *
 * Pure. No network, no database.
 *
 * "Every weekday at 05:30" means 05:30 in Edmonton on every weekday, including the Monday after
 * the clocks change. A rule is therefore anchored to an instant AND a zone, and every occurrence
 * is the anchor's wall clock re-read in that zone on the occurrence's calendar day. The instants
 * move by an hour twice a year; the wall clock does not. That is the whole reason this file
 * exists rather than `anchor + k * 86_400_000`.
 *
 * What it deliberately does not express: mileage, "after every completed job", "at shift start".
 * Those are conditions somebody observes, not dates arithmetic can reach, and they enter the
 * calendar through domain events (server/_core/workProjections.ts), never through a rule that
 * would have to guess.
 *
 * Every generator is bounded. A rule that cannot terminate is refused rather than followed.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;   // 0 = Sunday, as JavaScript counts
export type Frequency = "daily" | "weekdays" | "weekly" | "monthly";

export type RecurrenceRule = {
  frequency: Frequency;
  /** Every N days / weeks / months. Ignored for `weekdays`. */
  intervalCount?: number | null;
  /** Weekly: which weekdays. Empty or absent means the anchor's own weekday. */
  byWeekday?: readonly Weekday[] | null;
  /** Monthly: the Nth of the month. Months without that day are skipped, not clamped. */
  byMonthDay?: number | null;
  /** Monthly: the first (1) … fourth (4) or last (-1) `ordinalWeekday` of the month. */
  ordinalWeek?: number | null;
  ordinalWeekday?: Weekday | null;
  timezone: string;
  /** The first occurrence. Its wall clock in `timezone` is what every later occurrence repeats. */
  anchorAt: Date;
  untilAt?: Date | null;
  occurrenceLimit?: number | null;
};

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The most occurrences one expansion will ever return. A window wider than this is two windows. */
export const MAX_OCCURRENCES = 1000;
/** The most calendar steps one expansion will take before deciding the rule is not reaching anything. */
const MAX_STEPS = 20_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try { formatterFor(tz); return true; } catch { return false; }
}

const WEEKDAY_NAMES: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock an instant shows in a zone. */
export function zonedParts(instant: Date, tz: string): WallClock & { weekday: Weekday } {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  // "24" never appears under h23, but some engines have shipped it; guard anyway.
  const hour = Number(get("hour")) % 24;
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour, minute: Number(get("minute")), second: Number(get("second")),
    weekday: WEEKDAY_NAMES[get("weekday")] ?? 0,
  };
}

const asUtcMillis = (w: WallClock) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/**
 * The instant at which a zone shows this wall clock.
 *
 * A wall clock that does not exist (02:30 on the spring-forward morning) resolves to the instant
 * after the gap; one that exists twice (the autumn hour) resolves to its first occurrence. Both
 * are stated rather than left to whichever library default a reader happens to assume.
 */
export function zonedToUtc(wall: WallClock, tz: string): Date {
  const wanted = asUtcMillis(wall);
  let guess = wanted;
  const tried: number[] = [];
  for (let i = 0; i < 4; i++) {
    const shown = zonedParts(new Date(guess), tz);
    const diff = asUtcMillis(shown) - wanted;
    if (diff === 0) return new Date(guess);
    tried.push(guess);
    guess -= diff;
  }
  // No instant shows this wall clock: the guesses oscillate across the gap. The later of the two
  // is the instant after the gap, which is where a 02:30 alarm rings on that morning.
  return new Date(Math.max(...tried.slice(-2), guess));
}

export function startOfLocalDay(instant: Date, tz: string): Date {
  const p = zonedParts(instant, tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 }, tz);
}

/** Calendar-date arithmetic with no zone in it: (y, m, d) plus some days, months. */
type CalendarDate = { year: number; month: number; day: number };
const dateOf = (millis: number): CalendarDate => { const d = new Date(millis); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };
const millisOf = (c: CalendarDate) => Date.UTC(c.year, c.month - 1, c.day);
const plusDays = (c: CalendarDate, n: number) => dateOf(Date.UTC(c.year, c.month - 1, c.day + n));
const weekdayOf = (c: CalendarDate): Weekday => new Date(millisOf(c)).getUTCDay() as Weekday;
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const compareDates = (a: CalendarDate, b: CalendarDate) => millisOf(a) - millisOf(b);

/** Refuses the shapes that cannot mean anything. Returns the reasons, empty when the rule is sound. */
export function validateRule(rule: RecurrenceRule): string[] {
  const out: string[] = [];
  if (!isValidTimezone(rule.timezone)) out.push(`Unknown time zone "${rule.timezone}"`);
  const interval = rule.intervalCount ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) out.push(`intervalCount must be a whole number from 1 to 366, not ${interval}`);
  if (rule.byWeekday?.some(w => !Number.isInteger(w) || w < 0 || w > 6)) out.push("byWeekday must name weekdays 0 (Sunday) to 6 (Saturday)");
  if (rule.byWeekday && rule.frequency !== "weekly") out.push("byWeekday applies only to a weekly rule");
  if (rule.byMonthDay != null && (!Number.isInteger(rule.byMonthDay) || rule.byMonthDay < 1 || rule.byMonthDay > 31)) out.push("byMonthDay must be 1 to 31");
  if (rule.byMonthDay != null && rule.frequency !== "monthly") out.push("byMonthDay applies only to a monthly rule");
  if ((rule.ordinalWeek != null) !== (rule.ordinalWeekday != null)) out.push("ordinalWeek and ordinalWeekday come together: 'the first Monday' needs both");
  if (rule.ordinalWeek != null && !([1, 2, 3, 4, -1] as number[]).includes(rule.ordinalWeek)) out.push("ordinalWeek must be 1 to 4 or -1 (last)");
  if (rule.ordinalWeek != null && rule.frequency !== "monthly") out.push("an ordinal weekday applies only to a monthly rule");
  if (rule.byMonthDay != null && rule.ordinalWeek != null) out.push("a monthly rule is by day of month or by ordinal weekday, not both");
  if (rule.occurrenceLimit != null && (!Number.isInteger(rule.occurrenceLimit) || rule.occurrenceLimit < 1)) out.push("occurrenceLimit must be a positive whole number");
  if (rule.untilAt && rule.untilAt.getTime() < rule.anchorAt.getTime()) out.push("untilAt is before the first occurrence");
  if (Number.isNaN(rule.anchorAt.getTime())) out.push("anchorAt is not a date");
  return out;
}

/**
 * The calendar days a rule touches, in order, starting at the anchor's day. Each call returns the
 * next one; the caller stops. (A closure rather than a generator: the production tsconfig
 * targets ES5, where a generator cannot be iterated.)
 */
function candidateDays(rule: RecurrenceRule, anchor: CalendarDate): () => CalendarDate {
  const interval = Math.max(1, rule.intervalCount ?? 1);
  switch (rule.frequency) {
    case "daily": {
      let k = 0;
      return () => plusDays(anchor, (k++) * interval);
    }
    case "weekdays": {
      let k = 0;
      return () => {
        for (;;) { const d = plusDays(anchor, k++); const wd = weekdayOf(d); if (wd !== 0 && wd !== 6) return d; }
      };
    }
    case "weekly": {
      const weekdays = (rule.byWeekday && rule.byWeekday.length ? [...rule.byWeekday] : [weekdayOf(anchor)]).sort((a, b) => a - b);
      const weekStart = plusDays(anchor, -weekdayOf(anchor));
      let w = 0, i = 0;
      return () => {
        for (;;) {
          if (i >= weekdays.length) { i = 0; w += interval; }
          const d = plusDays(weekStart, w * 7 + weekdays[i++]!);
          if (compareDates(d, anchor) < 0) continue;
          return d;
        }
      };
    }
    case "monthly": {
      let k = 0;
      return () => {
        for (;;) {
          const monthIndex = anchor.month - 1 + k;
          k += interval;
          const year = anchor.year + Math.floor(monthIndex / 12);
          const month = (monthIndex % 12) + 1;
          let day: number | null;
          if (rule.ordinalWeek != null && rule.ordinalWeekday != null) {
            day = ordinalDay(year, month, rule.ordinalWeek, rule.ordinalWeekday);
          } else {
            const wanted = rule.byMonthDay ?? anchor.day;
            day = wanted <= daysInMonth(year, month) ? wanted : null;
          }
          if (day == null) continue;
          const d = { year, month, day };
          if (compareDates(d, anchor) < 0) continue;
          return d;
        }
      };
    }
  }
}

/** The day of "the first Monday" or "the last Friday" of a month, or null when the month has no such day. */
function ordinalDay(year: number, month: number, ordinal: number, weekday: Weekday): number | null {
  const dim = daysInMonth(year, month);
  if (ordinal === -1) {
    for (let d = dim; d >= 1; d--) if (weekdayOf({ year, month, day: d }) === weekday) return d;
    return null;
  }
  let seen = 0;
  for (let d = 1; d <= dim; d++) {
    if (weekdayOf({ year, month, day: d }) === weekday && ++seen === ordinal) return d;
  }
  return null;
}

/**
 * Every occurrence with `from <= at < to`, in order.
 *
 * `occurrenceLimit` counts from the anchor, not from `from`: "the next 10 Fridays" is ten Fridays
 * however late somebody asks. Refuses an unsound rule outright.
 */
export function occurrencesBetween(rule: RecurrenceRule, from: Date, to: Date): Date[] {
  const problems = validateRule(rule);
  if (problems.length) throw new InvalidRecurrence(problems.join("; "));
  const tz = rule.timezone;
  const anchorWall = zonedParts(rule.anchorAt, tz);
  const anchorDay: CalendarDate = { year: anchorWall.year, month: anchorWall.month, day: anchorWall.day };
  const out: Date[] = [];
  let produced = 0;
  let steps = 0;
  const next = candidateDays(rule, anchorDay);
  for (;;) {
    if (++steps > MAX_STEPS) break;
    const day = next();
    const at = zonedToUtc({ ...day, hour: anchorWall.hour, minute: anchorWall.minute, second: anchorWall.second }, tz);
    if (rule.untilAt && at.getTime() > rule.untilAt.getTime()) break;
    if (at.getTime() >= to.getTime()) break;
    produced++;
    if (rule.occurrenceLimit != null && produced > rule.occurrenceLimit) break;
    if (at.getTime() >= from.getTime()) {
      out.push(at);
      if (out.length >= MAX_OCCURRENCES) break;
    }
  }
  return out;
}

/** The first occurrence strictly after `after`, looking no further than `horizonDays` ahead. */
export function nextOccurrenceAfter(rule: RecurrenceRule, after: Date, horizonDays = 400): Date | null {
  const to = new Date(after.getTime() + horizonDays * 86_400_000);
  const found = occurrencesBetween(rule, new Date(after.getTime() + 1), to);
  return found[0] ?? null;
}

export class InvalidRecurrence extends Error {}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

/** The rule in the words a person would use, with the wall clock and the zone. */
export function describeRule(rule: RecurrenceRule): string {
  const w = zonedParts(rule.anchorAt, rule.timezone);
  const hhmm = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  const interval = rule.intervalCount ?? 1;
  const every = (unit: string) => interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  let head: string;
  switch (rule.frequency) {
    case "daily": head = every("day"); break;
    case "weekdays": head = "every weekday"; break;
    case "weekly": {
      const days = (rule.byWeekday && rule.byWeekday.length ? rule.byWeekday : [w.weekday]).map(d => DAY_NAMES[d]).join(", ");
      head = interval === 1 ? `every ${days}` : `${days} every ${interval} weeks`;
      break;
    }
    case "monthly":
      head = rule.ordinalWeek != null && rule.ordinalWeekday != null
        ? `the ${ORDINALS[rule.ordinalWeek]} ${DAY_NAMES[rule.ordinalWeekday]} of ${every("month")}`
        : `the ${rule.byMonthDay ?? w.day}${suffix(rule.byMonthDay ?? w.day)} of ${every("month")}`;
      break;
  }
  const tail = rule.untilAt ? ` until ${zonedParts(rule.untilAt, rule.timezone).year}-${String(zonedParts(rule.untilAt, rule.timezone).month).padStart(2, "0")}-${String(zonedParts(rule.untilAt, rule.timezone).day).padStart(2, "0")}`
    : rule.occurrenceLimit ? ` (${rule.occurrenceLimit} times)` : "";
  return `${head} at ${hhmm} ${rule.timezone}${tail}`;
}

const suffix = (n: number) => (n % 10 === 1 && n !== 11) ? "st" : (n % 10 === 2 && n !== 12) ? "nd" : (n % 10 === 3 && n !== 13) ? "rd" : "th";
