/**
 * ELD checkpoint 2c — a designated duty day, as arithmetic.
 *
 * Pure. No database, and no regulation. This module answers one mechanical question: given an
 * operator's home-terminal timezone (an IANA name) and the local time their duty day starts, which
 * UTC instants bound the duty day that contains a given moment? It does NOT say that any regime
 * counts any limit over that day — that is a rule, and rules are verified rows, not code. The engine
 * shows these clocks and still withholds a daily verdict until such a rule is verified.
 *
 * Timezone facts come from the runtime's IANA database (ICU), never from constants here. The gate
 * pins the Node build, so the tz version is fixed per release, and every answer reports the version
 * it used: when Alberta's offsets changed in the database, the answers changed with it, and a reader
 * can see which data produced which day.
 *
 * Two local times are hard, and both are resolved the way the ECMAScript Temporal proposal's
 * "compatible" disambiguation resolves them:
 *   a local time that does not exist (the hour skipped when clocks go forward) is moved forward by
 *     the length of the gap — 02:30 on a spring-forward night becomes 03:30;
 *   a local time that happens twice (the hour repeated when clocks go back) takes the EARLIER of the
 *     two instants.
 * So a duty day is 24 hours long on an ordinary day, 23 on a spring-forward day and 25 on a
 * fall-back day, and the arithmetic says so rather than assuming 24.
 */

export type DutyDayDesignation = {
  /** IANA zone name, e.g. "America/Edmonton". Validated against the runtime's database. */
  timezone: string;
  /** Minutes after local midnight at which the duty day begins, 0–1439. */
  dayStartMinutes: number;
};

export type DutyDayWindow = {
  from: Date;
  to: Date;
  lengthMinutes: number;
  /** The local calendar date on which this duty day begins, YYYY-MM-DD in the designated zone. */
  localDate: string;
  timezone: string;
  dayStartMinutes: number;
  /** The IANA database version that produced these instants (`process.versions.tz`), or null if unknown. */
  tzVersion: string | null;
};

const MIN = 60_000;

/** The IANA database version this runtime carries (`process.versions.tz`), or null when it does not say. */
export function runtimeTzVersion(): string | null {
  return (typeof process !== "undefined" && (process.versions as Record<string, string | undefined>).tz) || null;
}

/**
 * The runtime database's own name for a zone — `america/edmonton` and `America/Edmonton` are one
 * zone, and `US/Pacific` is a link to `America/Los_Angeles` — or null when the name is not a zone
 * it knows. A fixed offset (`+05:00`, which ICU also accepts) is refused: it is not a place, keeps
 * no daylight-saving rules, and would silently stop being the terminal's time twice a year.
 * Never throws.
 */
export function canonicalTimezone(tz: string): string | null {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}

/** True when the runtime's database knows this zone by this name or an alias of it. Never throws. */
export function isKnownTimezone(tz: string): boolean {
  return canonicalTimezone(tz) != null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}

/** The local wall-clock fields of an instant in a zone. */
function localFields(instantMs: number, tz: string) {
  const parts = formatterFor(tz).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute"), ss: get("second") };
}

/** The zone's offset from UTC at an instant, in minutes (local − UTC). */
export function offsetMinutesAt(instantMs: number, tz: string): number {
  const f = localFields(instantMs, tz);
  const asUtc = Date.UTC(f.y, f.m - 1, f.d, f.hh, f.mm, f.ss);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MIN);
}

/**
 * The UTC instant at which the given local wall time occurs in the zone, with Temporal's
 * "compatible" disambiguation: a skipped time moves forward by the gap, a repeated time takes the
 * earlier instant.
 */
export function zonedLocalToInstant(y: number, m: number, d: number, minutesOfDay: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesOfDay * MIN;   // the wall time read as if it were UTC
  // An instant is a solution when its local wall time equals `wall`, i.e. instant = wall − offset(instant).
  // Offsets either side of any transition are found by sampling a day before and a day after.
  const before = offsetMinutesAt(wall - 24 * 60 * MIN, tz);
  const after = offsetMinutesAt(wall + 24 * 60 * MIN, tz);
  const candidates = Array.from(new Set([before, after]))
    .map(off => wall - off * MIN)
    .filter(inst => offsetMinutesAt(inst, tz) * MIN === wall - inst)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0]!;                       // ordinary time, or the earlier of a repeated one
  // No solution: the time was skipped. Read it with the offset in force BEFORE the gap, which lands
  // the same distance past the transition as the wall time was past its start — forward by the gap.
  return wall - before * MIN;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d) + n * 24 * 60 * MIN);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * The duty day that contains `at`: it begins at the latest instant ≤ `at` whose local time is the
 * designated start, and ends where the next one begins. Refuses an unknown zone or an out-of-range
 * start rather than falling back to UTC or midnight.
 */
export function dutyDayWindow(at: Date, designation: DutyDayDesignation): DutyDayWindow {
  const { timezone: tz, dayStartMinutes: start } = designation;
  if (!isKnownTimezone(tz)) throw new RangeError(`unknown IANA timezone: ${String(tz)}`);
  if (!Number.isInteger(start) || start < 0 || start > 1439) throw new RangeError(`dayStartMinutes must be an integer 0–1439, got ${String(start)}`);
  const t = at.getTime();
  const local = localFields(t, tz);
  let day = { y: local.y, m: local.m, d: local.d };
  let from = zonedLocalToInstant(day.y, day.m, day.d, start, tz);
  if (from > t) { day = addDays(day.y, day.m, day.d, -1); from = zonedLocalToInstant(day.y, day.m, day.d, start, tz); }
  const next = addDays(day.y, day.m, day.d, 1);
  const to = zonedLocalToInstant(next.y, next.m, next.d, start, tz);
  return {
    from: new Date(from), to: new Date(to), lengthMinutes: Math.round((to - from) / MIN),
    localDate: isoDate(day.y, day.m, day.d), timezone: tz, dayStartMinutes: start,
    tzVersion: runtimeTzVersion(),
  };
}

/** What a duty-status record counts as, for the duty-day clocks. The four legal statuses, nothing else. */
export type DutyDayEntry = { dutyStatus: "driving" | "on_duty" | "sleeper_berth" | "off_duty"; startedAt: Date; endedAt: Date | null };

export type DutyDayClocks = {
  window: DutyDayWindow;
  /** Counted up to `at`, never past it: the rest of the day has not happened. */
  countedUntil: Date;
  drivingMinutes: number;
  onDutyMinutes: number;          // driving + on duty, the same rollup hos.ts uses
  offDutyMinutes: number;
  sleeperMinutes: number;
  /** Minutes of the elapsed part of the day with no duty status on record. Reported, never filled. */
  unrecordedMinutes: number;
};

/** The four clocks over the designated duty day containing `at`, counted only up to `at`. */
export function dutyDayClocks(entries: readonly DutyDayEntry[], at: Date, designation: DutyDayDesignation): DutyDayClocks {
  const window = dutyDayWindow(at, designation);
  const lo = window.from.getTime();
  const hi = Math.min(window.to.getTime(), at.getTime());
  const overlap = (e: DutyDayEntry) => Math.max(0, Math.min((e.endedAt ?? at).getTime(), hi) - Math.max(e.startedAt.getTime(), lo)) / MIN;
  const sum = (pred: (e: DutyDayEntry) => boolean) => Math.round(entries.filter(pred).reduce((a, e) => a + overlap(e), 0));
  const driving = sum(e => e.dutyStatus === "driving");
  const onDutyOnly = sum(e => e.dutyStatus === "on_duty");
  const off = sum(e => e.dutyStatus === "off_duty");
  const sleeper = sum(e => e.dutyStatus === "sleeper_berth");
  const elapsed = Math.round((hi - lo) / MIN);
  return {
    window, countedUntil: new Date(hi),
    drivingMinutes: driving, onDutyMinutes: driving + onDutyOnly, offDutyMinutes: off, sleeperMinutes: sleeper,
    unrecordedMinutes: Math.max(0, elapsed - (driving + onDutyOnly + off + sleeper)),
  };
}
