/**
 * DriveBC's Open511 events feed.
 *
 * Pure. `api.open511.gov.bc.ca/events` takes no key and answers `{ events, pagination, meta }`.
 * Each event has a string `id`, an `event_type` (CONSTRUCTION, INCIDENT, ROAD_CONDITION,
 * WEATHER_CONDITION, SPECIAL_EVENT), a `severity` (MINOR, MODERATE, MAJOR, UNKNOWN), a GeoJSON
 * `geography`, `roads[]`, and ISO-8601 `created`/`updated` with offsets.
 *
 * One hazard this module exists to refuse: pagination. The ingester treats this feed as a full
 * snapshot, so an event missing from the response is withdrawn. A response carrying a
 * `pagination.next_url` is only a page of the listing, and ingesting it as the whole would
 * withdraw every live event on the pages not fetched. So a paged response does not parse, the run
 * fails, and nothing is withdrawn.
 */

import type { AdvisorySeverity, AdvisoryType, RoadAdvisory } from "../advisoryImpact";
import type { FeedEndpoint } from "../feedHttp";
import type { Normalizer } from "../feedIngest";
import { clip, EXTERNAL_REF_MAX, fromDateText, HEADLINE_MAX, IncompleteSnapshotError, ROAD_NAME_MAX } from "./fields";
import { coveringCircle, geometryCoordinates } from "./placement";

/**
 * The publisher's ceiling: "'limit' cannot exceed 500" (error 1005). On 2026-09-24 the whole
 * active listing was 272 events.
 */
export const DRIVEBC_PAGE_LIMIT = 500;

/** Wall-clock times without an offset are in this zone, per the feed's own `/jurisdiction`. */
export const DRIVEBC_TIMEZONE = "America/Vancouver";

export const DRIVEBC_EVENTS_ENDPOINT: FeedEndpoint = {
  sourceKey: "drivebc_open511",
  url: `https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=${DRIVEBC_PAGE_LIMIT}`,
  credentialStyle: { kind: "none" },
  timeoutMs: 30_000,
  acceptHeader: "application/json",
};

export const DRIVEBC_SNAPSHOT = "full" as const;

/**
 * The feed's `pagination` block does not say when a listing was cut short — it answered
 * `{ offset: "0" }` to a `limit=5` request that plainly had more. So a response that fills the
 * page is treated as possibly incomplete, on the only evidence available: its length.
 */
export function parseDriveBcEvents(body: string, pageLimit: number = DRIVEBC_PAGE_LIMIT): unknown[] {
  const parsed = JSON.parse(body) as { events?: unknown; pagination?: { next_url?: unknown } } | null;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) {
    throw new Error("expected an Open511 envelope with an `events` array");
  }
  const next = parsed.pagination?.next_url;
  if (typeof next === "string" && next.trim()) {
    throw new IncompleteSnapshotError(
      `the response is one page of a longer listing (next: ${next}); ingesting it as the whole would withdraw live events`,
    );
  }
  if (parsed.events.length >= pageLimit) {
    throw new IncompleteSnapshotError(
      `the response filled the ${pageLimit}-event page, so it may be cut short; ingesting it as the whole could withdraw live events`,
    );
  }
  return parsed.events;
}

const TYPE: Record<string, AdvisoryType> = {
  CONSTRUCTION: "construction",
  INCIDENT: "incident",
  ROAD_CONDITION: "road_condition",
  WEATHER_CONDITION: "weather",
};

/** MODERATE rounds up, for the same reason it does on the 511 platform. */
export function drivebcSeverity(severity: unknown, subtypes: unknown): AdvisorySeverity {
  const subs = Array.isArray(subtypes) ? subtypes.map(s => String(s).toUpperCase()) : [];
  if (subs.includes("ROAD_CLOSED")) return "closure";
  switch (String(severity ?? "").toUpperCase()) {
    case "MAJOR":
    case "MODERATE": return "major";
    case "MINOR": return "minor";
    default: return "unknown";
  }
}

type Open511Event = {
  id?: string;
  headline?: string;
  description?: string;
  status?: string;
  updated?: string;
  event_type?: string;
  event_subtypes?: unknown;
  severity?: string;
  geography?: unknown;
  roads?: { name?: string }[];
  schedule?: { intervals?: string[]; recurring_schedules?: { start_date?: string; end_date?: string }[] };
};

/** The earliest start and latest end the schedule states, or null where it states none. */
function scheduleWindow(s: Open511Event["schedule"]): { from: Date | null; to: Date | null } {
  const starts: Date[] = [];
  const ends: Date[] = [];
  for (const r of s?.recurring_schedules ?? []) {
    const a = fromDateText(r.start_date, DRIVEBC_TIMEZONE);
    const b = fromDateText(r.end_date, DRIVEBC_TIMEZONE);
    if (a) starts.push(a);
    if (b) ends.push(b);
  }
  for (const iv of s?.intervals ?? []) {
    const [a, b] = String(iv).split("/");
    const da = fromDateText(a, DRIVEBC_TIMEZONE);
    const db = fromDateText(b, DRIVEBC_TIMEZONE);
    if (da) starts.push(da);
    if (db) ends.push(db);
  }
  const min = (d: Date[]) => (d.length ? new Date(Math.min(...d.map(x => x.getTime()))) : null);
  const max = (d: Date[]) => (d.length ? new Date(Math.max(...d.map(x => x.getTime()))) : null);
  // An open-ended interval ("2026-01-01T00:00/") has no end; one missing end means no stated end.
  const openEnded = (s?.intervals ?? []).some(iv => !String(iv).split("/")[1]);
  return { from: min(starts), to: openEnded ? null : max(ends) };
}

export function drivebcNormalizer(retrievedAt: Date): Normalizer {
  return (raw, index) => {
    const e = (raw ?? {}) as Open511Event;
    const externalRef = clip(e.id, EXTERNAL_REF_MAX);
    if (!externalRef) return { ok: false, reason: `event ${index} has no id` };
    if (e.status && e.status.toUpperCase() !== "ACTIVE") return { ok: false, reason: `event ${externalRef} is ${e.status}, not ACTIVE` };

    // The feed's `headline` is the event type in capitals; the description is what a person reads.
    const headline = clip(e.description, HEADLINE_MAX) ?? clip(e.headline, HEADLINE_MAX);
    if (!headline) return { ok: false, reason: `event ${externalRef} has no description` };

    const circle = coveringCircle(geometryCoordinates(e.geography));
    const severity = drivebcSeverity(e.severity, e.event_subtypes);
    const window = scheduleWindow(e.schedule);

    const advisory: RoadAdvisory = {
      sourceKey: "drivebc_open511",
      externalRef,
      advisoryType: severity === "closure" ? "closure" : TYPE[String(e.event_type ?? "").toUpperCase()] ?? "other",
      severity,
      headline,
      roadName: clip(e.roads?.[0]?.name, ROAD_NAME_MAX),
      point: circle?.point ?? null,
      radiusMetres: circle?.radiusMetres ?? null,
      effectiveFrom: window.from,
      effectiveTo: window.to,
      sourceUpdatedAt: fromDateText(e.updated, DRIVEBC_TIMEZONE),
      retrievedAt,
      advisoryOnly: true,
    };
    return { ok: true, advisory };
  };
}
