import type {
  InsertTripBreadcrumb,
  InsertZoneEvent,
} from "../../drizzle/schema";
import {
  createTripBreadcrumb,
  createZoneEvent,
  getRecentZoneStateForTrip,
} from "../db";
// P0-A2.1 — the zones a position is evaluated against are the TRIP's organization's, read from
// trips.orgRef by the boundary. No "all active zones" helper exists any more.
import { activeOperatingZonesForTrip } from "../operatingZoneScope";
import {
  detectTransitions,
  evaluateZoneMembership,
  type ZoneCandidate,
  type FixSource,
} from "./geofence";

export type IngestBreadcrumbResult = {
  breadcrumbId: number | undefined;
  /** Newly created pending zoneEvents proposed by this breadcrumb, if any. */
  proposedEvents: Array<{
    id: number | undefined;
    zoneId: number;
    eventType: "enter" | "exit";
  }>;
};

/**
 * Record a raw GPS position and propose any zone enter/exit events it
 * implies. Nothing here writes to tripStops directly — every proposal lands
 * as a "pending" zoneEvent that a driver or dispatcher must confirm before it
 * can populate the trip timeline. See confirmZoneEvent in routers.ts.
 */
export async function ingestBreadcrumb(
  input: InsertTripBreadcrumb
): Promise<IngestBreadcrumbResult> {
  const breadcrumbId = await createTripBreadcrumb(input);

  const zones = await activeOperatingZonesForTrip(input.tripId);
  if (zones.length === 0) {
    return { breadcrumbId, proposedEvents: [] };
  }

  const candidates: ZoneCandidate[] = zones.map(z => ({
    id: z.id,
    latitude: z.latitude,
    longitude: z.longitude,
    radiusMetres: z.radiusMetres,
  }));

  const currentMemberships = candidates.map(zone =>
    evaluateZoneMembership(
      {
        latitude: input.latitude,
        longitude: input.longitude,
        accuracyMetres: input.accuracyMetres ?? null,
      },
      zone,
      // The breadcrumb's own source, which the column has always carried and the confidence
      // arithmetic never read. A typed position must not be read as a satellite fix.
      (input.source ?? "gps") as FixSource
    )
  );

  const previousState = await getRecentZoneStateForTrip(input.tripId);
  const previousMemberships = candidates.map(zone => ({
    zoneId: zone.id,
    inside: previousState.get(zone.id) ?? false,
  }));

  const transitions = detectTransitions(
    previousMemberships,
    currentMemberships
  );

  const proposedEvents: IngestBreadcrumbResult["proposedEvents"] = [];
  for (const transition of transitions) {
    const zoneEventInput: InsertZoneEvent = {
      tripId: input.tripId,
      zoneId: transition.zoneId,
      eventType: transition.eventType,
      detectedAt: input.recordedAt,
      distanceMetres: transition.distanceMetres,
      accuracyMetres: input.accuracyMetres,
      confidence: transition.confidence,
      status: "pending",
    };
    const id = await createZoneEvent(zoneEventInput);
    proposedEvents.push({
      id,
      zoneId: transition.zoneId,
      eventType: transition.eventType,
    });
  }

  return { breadcrumbId, proposedEvents };
}
