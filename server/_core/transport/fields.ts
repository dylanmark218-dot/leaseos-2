/**
 * Field coercions every provincial adapter needs, written once so they agree.
 *
 * Pure. Each one returns null for anything it cannot read. A missing end date is "the publisher
 * did not say", which is different from "it has ended" and different again from "it never ends".
 */

/** Defined beside the withdrawal it protects; re-exported so the parsers keep one import. */
export { IncompleteSnapshotError } from "../feedIngest";

/** Column widths in `roadAdvisories`. A record that would overflow one is clipped, not rejected. */
export const HEADLINE_MAX = 400;
export const ROAD_NAME_MAX = 220;
export const EXTERNAL_REF_MAX = 200;

export function clip(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Unix seconds, as the 511 platform sends them. Zero and negatives are "not stated". */
export function fromUnixSeconds(v: unknown): Date | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null;
}

/**
 * A publisher's date text. With an offset or `Z` it is exact. Without one — Open511's schedule
 * intervals, Québec's `YYYY/MM/DD hh:mm:ss`, a bare `YYYY-MM-DD` — it is wall-clock time in the
 * publisher's own zone, which the caller names. Never the server's zone: that would move every
 * closure window by however far the server happens to be from the road.
 */
export function fromDateText(v: unknown, zone: string): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const text = v.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const t = Date.parse(text);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
  // Two passes so an instant near a DST change resolves against its own offset.
  const first = wall - offsetMinutes(new Date(wall), zone) * 60_000;
  return new Date(wall - offsetMinutes(new Date(first), zone) * 60_000);
}

/** UTC offset of a zone at an instant, in minutes (e.g. −300 or −240 for America/Toronto). */
function offsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((local - at.getTime()) / 60_000);
}
