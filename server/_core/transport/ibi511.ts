/**
 * The 511 developer API shared by Alberta, Ontario, Manitoba, New Brunswick, Yukon and
 * Newfoundland and Labrador.
 *
 * Pure. Six provinces run the same platform: each documents `GET /api/v2/get/event` with a `key`
 * query parameter, `format=json`, "Ten calls every 60 seconds", and the same response fields
 * (`ID`, `RoadwayName`, `Description`, `EventType`, `IsFullClosure`, `Severity`, `Latitude`,
 * `Longitude`, Unix-second dates). So this is one parser and one normalizer, parameterized by
 * host and source key — six copies would drift, and the first to drift would be the one nobody
 * was looking at.
 *
 * Whether any of the six may be polled is not decided here. That is the registry row and the
 * collector's CLEARED gate; this module only knows how to read an answer if one is allowed.
 */

import type { AdvisorySeverity, AdvisoryType, RoadAdvisory } from "../advisoryImpact";
import type { Normalizer } from "../feedIngest";
import type { FeedEndpoint } from "../feedHttp";
import type { LngLat } from "../geoImport";
import { clip, EXTERNAL_REF_MAX, fromUnixSeconds, HEADLINE_MAX, ROAD_NAME_MAX } from "./fields";
import { coveringCircle } from "./placement";

/** The event endpoint on one province's host. The key is added at the edge by `buildRequest`. */
export function ibi511EventEndpoint(sourceKey: string, host: string): FeedEndpoint {
  return {
    sourceKey,
    url: `https://${host}/api/v2/get/event?format=json&lang=en`,
    credentialStyle: { kind: "query", parameter: "key" },
    timeoutMs: 20_000,
    acceptHeader: "application/json",
  };
}

/** The whole listing comes back in one response, so absence from it means the event is over. */
export const IBI511_SNAPSHOT = "full" as const;

export function parseIbi511Events(body: string): unknown[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    // An error envelope or a changed shape. Refusing to parse fails the run, which withdraws
    // nothing — treating it as an empty listing would clear every live advisory in the province.
    throw new Error(`expected a JSON array of events, got ${parsed === null ? "null" : typeof parsed}`);
  }
  return parsed;
}

type IbiEvent = {
  ID?: number | string;
  RoadwayName?: string;
  DirectionOfTravel?: string;
  Description?: string;
  LastUpdated?: number;
  StartDate?: number;
  PlannedEndDate?: number;
  Latitude?: number;
  Longitude?: number;
  LatitudeSecondary?: number;
  LongitudeSecondary?: number;
  EventType?: string;
  EventSubType?: string;
  IsFullClosure?: boolean;
  Severity?: string;
  Restrictions?: unknown;
};

const TYPE: Record<string, AdvisoryType> = {
  roadwork: "construction",
  closures: "closure",
  accidentsandincidents: "incident",
};

/**
 * The platform's free-text severity, rounded up when it falls between our buckets. "Moderate" reads
 * as major: an advisory that overstates costs a dispatcher a glance; one that understates is how a
 * lane closure on a narrow highway reads as nothing.
 */
export function ibiSeverity(e: Pick<IbiEvent, "IsFullClosure" | "Severity">): AdvisorySeverity {
  if (e.IsFullClosure === true) return "closure";
  const s = (e.Severity ?? "").trim().toLowerCase();
  if (s === "major" || s === "moderate" || s === "high") return "major";
  if (s === "minor" || s === "low") return "minor";
  if (s === "none" || s === "info" || s === "informational") return "info";
  return "unknown";
}

function hasRestrictions(r: unknown): boolean {
  if (Array.isArray(r)) return r.length > 0;
  if (r && typeof r === "object") return Object.values(r).some(v => v !== null && v !== undefined && v !== "");
  return false;
}

export function ibi511Normalizer(sourceKey: string, retrievedAt: Date): Normalizer {
  return (raw, index) => {
    const e = (raw ?? {}) as IbiEvent;
    const externalRef = clip(e.ID === undefined || e.ID === null ? null : String(e.ID), EXTERNAL_REF_MAX);
    if (!externalRef) return { ok: false, reason: `event ${index} has no ID` };

    const coords: LngLat[] = [];
    if (typeof e.Longitude === "number" && typeof e.Latitude === "number") coords.push([e.Longitude, e.Latitude]);
    if (typeof e.LongitudeSecondary === "number" && typeof e.LatitudeSecondary === "number") coords.push([e.LongitudeSecondary, e.LatitudeSecondary]);
    const circle = coveringCircle(coords);

    const headline = clip(e.Description, HEADLINE_MAX) ?? clip([e.EventSubType, e.RoadwayName].filter(Boolean).join(" — "), HEADLINE_MAX);
    if (!headline) return { ok: false, reason: `event ${externalRef} has neither a description nor a type to show` };

    const severity = ibiSeverity(e);
    const mapped = TYPE[(e.EventType ?? "").trim().toLowerCase()] ?? "other";
    const advisoryType: AdvisoryType =
      severity === "closure" ? "closure"
      : mapped === "other" && hasRestrictions(e.Restrictions) ? "restriction"
      : mapped;

    const advisory: RoadAdvisory = {
      sourceKey,
      externalRef,
      advisoryType,
      severity,
      headline,
      roadName: clip(e.RoadwayName, ROAD_NAME_MAX),
      // A record without a position is still accepted: it is real information, and
      // `advisoryImpact` reports it as unplaced rather than guessing where it belongs.
      point: circle?.point ?? null,
      radiusMetres: circle?.radiusMetres ?? null,
      effectiveFrom: fromUnixSeconds(e.StartDate),
      effectiveTo: fromUnixSeconds(e.PlannedEndDate),
      sourceUpdatedAt: fromUnixSeconds(e.LastUpdated),
      retrievedAt,
      advisoryOnly: true,
    };
    return { ok: true, advisory };
  };
}
