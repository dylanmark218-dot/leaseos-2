/**
 * Analytics Checkpoint B — what "today" means, said out loud.
 *
 * Pure. No database.
 *
 * LeaseOS stores every instant as a UTC timestamp and has no organization timezone. Every existing
 * "day" in the tree is a UTC day (`portal.dailyReport`, time-off, crew coverage) and every period a
 * UTC calendar month. For a crew in Alberta that makes "today" end at 6 p.m. Mountain.
 *
 * So the zone is an input, never a guess — the same rule the assistant's commit adapters follow with
 * `utcOffsetMinutes`. A request names an IANA zone (or a fixed offset such as `-07:00`); without one
 * the answer is in UTC and says so. Every answer echoes the zone and the exact instants it used, so a
 * drill-down or a report can repeat the question precisely instead of re-deriving "today" a second
 * later on the far side of midnight.
 *
 * Ranges are half-open, [from, to). A record at exactly `to` belongs to the next range, never both.
 * "To date" ranges end at the start of tomorrow rather than at this instant, so the same question
 * asked twice in one day names the same interval.
 *
 * Not offered: "current shift". Shift start is an explicit timestamp in `shiftReadiness` and there is
 * no shift calendar to derive one from. Fiscal quarters and years: the calendar is used, and the
 * answer says `calendar`; a fiscal calendar is per financial entity and belongs to the finance metrics.
 */

export const RANGE_LABELS = [
  "today", "yesterday", "last_7_days", "last_30_days",
  "month_to_date", "quarter_to_date", "year_to_date", "custom",
] as const;
export type RangeLabel = (typeof RANGE_LABELS)[number];

export type RangeRequest = { label: RangeLabel; from?: Date; to?: Date; zone?: string };

export type ResolvedRange = {
  label: RangeLabel;
  from: Date;
  to: Date;
  zone: string;
  /** Always "calendar" here; a fiscal calendar is not derived from a zone. */
  calendar: "calendar";
};

/** The longest custom range answered, so a mistyped year cannot ask for a century. */
export const MAX_CUSTOM_DAYS = 1100;

export class RangeRefused extends Error {}

/** A zone the runtime can resolve, or a refusal naming it. Never a silent fallback. */
export function assertZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    throw new RangeRefused(`Unknown time zone "${zone}" — name an IANA zone such as America/Edmonton, or an offset such as -07:00`);
  }
}

type LocalDate = { y: number; m: number; d: number };

function localParts(at: Date, zone: string): LocalDate & { hh: number; mm: number; ss: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find(p => p.type === t)!.value);
  return { y: n("year"), m: n("month"), d: n("day"), hh: n("hour"), mm: n("minute"), ss: n("second") };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(at: Date, zone: string): number {
  const p = localParts(at, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant local midnight begins on a calendar date in the zone. Two passes, because the offset
 * at the first guess can differ from the offset at the answer across a daylight-saving change.
 */
export function startOfLocalDay(date: LocalDate, zone: string): Date {
  const wall = Date.UTC(date.y, date.m - 1, date.d);
  let t = wall - offsetMs(new Date(wall), zone);
  t = wall - offsetMs(new Date(t), zone);
  return new Date(t);
}

/** The calendar date `days` after `date`. Plain date arithmetic; no zone involved. */
function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function resolveRange(req: RangeRequest, now: Date): ResolvedRange {
  const zone = assertZone(req.zone ?? "UTC");
  if (req.label === "custom") {
    if (!req.from || !req.to) throw new RangeRefused("A custom range needs both from and to");
    if (!(req.from.getTime() < req.to.getTime())) throw new RangeRefused("A custom range must end after it starts");
    if (req.to.getTime() - req.from.getTime() > MAX_CUSTOM_DAYS * 86_400_000) throw new RangeRefused(`A custom range may span at most ${MAX_CUSTOM_DAYS} days`);
    return { label: "custom", from: req.from, to: req.to, zone, calendar: "calendar" };
  }
  if (req.from || req.to) throw new RangeRefused(`from and to belong to a custom range, not to "${req.label}"`);

  const p = localParts(now, zone);
  const today: LocalDate = { y: p.y, m: p.m, d: p.d };
  const tomorrow = startOfLocalDay(addDays(today, 1), zone);
  const span = (first: LocalDate, end: Date): ResolvedRange =>
    ({ label: req.label, from: startOfLocalDay(first, zone), to: end, zone, calendar: "calendar" });

  switch (req.label) {
    case "today": return span(today, tomorrow);
    case "yesterday": return span(addDays(today, -1), startOfLocalDay(today, zone));
    case "last_7_days": return span(addDays(today, -6), tomorrow);
    case "last_30_days": return span(addDays(today, -29), tomorrow);
    case "month_to_date": return span({ y: today.y, m: today.m, d: 1 }, tomorrow);
    case "quarter_to_date": return span({ y: today.y, m: Math.floor((today.m - 1) / 3) * 3 + 1, d: 1 }, tomorrow);
    case "year_to_date": return span({ y: today.y, m: 1, d: 1 }, tomorrow);
  }
  throw new RangeRefused(`Unknown range "${String(req.label)}"`);
}
