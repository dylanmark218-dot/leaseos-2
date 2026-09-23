/**
 * 0170 — the canonical ELD event: what a device records, how it is serialized, and what is hashed.
 *
 * Shared by the server ledger and the device runtime so both sides compute the same bytes. Nothing
 * here touches a database or a network, and nothing here knows a regulation: the event vocabulary
 * is structural (a duty-status change carries a duty status; a correction names what it corrects)
 * and every threshold, interval and rule stays in the verified registry where it belongs.
 *
 * IDENTITY. An event has two identities and the ledger enforces both:
 *   `eventRef`        a UUID the device mints when the event is recorded, stable for ever;
 *   `deviceSequence`  the device's own monotonic counter, so the ledger can tell a gap from a
 *                     delay and order events from one device without trusting its clock.
 * The operator, the unit's ownership and the organization are NOT in the payload as identity: the
 * server resolves them from the enrolled device. A `unitId` may be stated and is checked; no field
 * names a driver.
 *
 * HASHES (`ELD_HASH_VERSION` = "eld-h1").
 *   canonicalJson       JSON.stringify of `canonicalEldEvent(...)`: an explicitly ordered object,
 *                       every participating field present (null when absent), timestamps as UTC
 *                       ISO-8601 with milliseconds. Explicit order, not sorted keys, so a reader can
 *                       see exactly what participates. Both sides are JavaScript; a non-JS device
 *                       must reproduce JSON.stringify's number and string formatting.
 *   payloadHash         SHA-256 hex of canonicalJson.
 *   eventHash           SHA-256 hex of `${hashVersion}\n${previousEventHash ?? ""}\n${payloadHash}`.
 *   previousEventHash   the device's claim: the eventHash of ITS previous event (deviceSequence-1),
 *                       or null for the first event it ever recorded. The chain is per device.
 * No database-assigned value (row id, receivedAt, operatorId, orgRef) participates, so a device can
 * recompute both hashes from its own store and verify what the server holds.
 */

/** The four legal statuses — the same vocabulary `server/_core/hos.ts` uses; nothing new. */
export const ELD_DUTY_STATUSES = ["driving", "on_duty", "sleeper_berth", "off_duty"] as const;
export type EldDutyStatus = (typeof ELD_DUTY_STATUSES)[number];

/**
 * Structural event types. Only their SHAPE is defined here; what any of them means under a
 * technical standard or an HOS regime is a later, verified concern.
 */
export const ELD_EVENT_TYPES = [
  "duty_status_change",        // requires dutyStatus
  "motion_start",              // vehicle motion observed to begin (threshold: not defined here)
  "motion_stop",
  "engine_power_up",
  "engine_power_down",
  "location_observation",
  "intermediate_location",
  "driver_login",
  "driver_logout",
  "jurisdiction_observation",
  "odometer_observation",
  "special_category_change",   // eventCode: personal_conveyance | yard_move | none
  "unidentified_driving",      // motion with no authenticated driver on the device
  "diagnostic",                // eventCode carries the device's own code; meaning undefined here
  "malfunction",
  "annotation",
  "correction",                // requires supersedesEventRef
  "certification",
] as const;
export type EldEventType = (typeof ELD_EVENT_TYPES)[number];

export const ELD_RECORD_ORIGINS_DEVICE = ["automatic", "driver"] as const;
export type EldDeviceRecordOrigin = (typeof ELD_RECORD_ORIGINS_DEVICE)[number];

export const ELD_LOCATION_SOURCES = ["gps", "network", "manual", "ecm", "none"] as const;
export type EldLocationSource = (typeof ELD_LOCATION_SOURCES)[number];

export const ELD_HASH_VERSION = "eld-h1" as const;

/** What a device submits for one event. Strict: an unknown field is a refusal, not an ignore. */
export type EldEventInput = {
  eventRef: string;
  deviceSequence: number;
  eventType: EldEventType;
  eventCode?: string | null;
  dutyStatus?: EldDutyStatus | null;
  recordOrigin: EldDeviceRecordOrigin;
  /** ISO-8601 with offset or Z, the device's clock. */
  eventAt: string;
  eventUtcOffsetMinutes?: number | null;
  unitId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracyM?: number | null;
  locationSource?: EldLocationSource | null;
  jurisdiction?: string | null;
  odometerKm?: number | null;
  engineHours?: number | null;
  vehicleSpeedKph?: number | null;
  annotation?: string | null;
  supersedesEventRef?: string | null;
  /** The device's claim about its previous event's hash; null for its first event. */
  previousEventHash: string | null;
  /** Optional: what the device computed. When present and different, the server refuses the event. */
  declaredEventHash?: string | null;
};

/** The fields that participate in the hash, in the order they are serialized. */
export type CanonicalEldEvent = {
  hashVersion: typeof ELD_HASH_VERSION;
  deviceRef: string;
  eventRef: string;
  deviceSequence: number;
  eventType: EldEventType;
  eventCode: string | null;
  dutyStatus: EldDutyStatus | null;
  recordOrigin: EldDeviceRecordOrigin;
  eventAt: string;
  eventUtcOffsetMinutes: number | null;
  unitId: number | null;
  latitude: number | null;
  longitude: number | null;
  locationAccuracyM: number | null;
  locationSource: EldLocationSource | null;
  jurisdiction: string | null;
  odometerKm: number | null;
  engineHours: number | null;
  vehicleSpeedKph: number | null;
  annotation: string | null;
  supersedesEventRef: string | null;
};

const nn = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

/**
 * The explicitly ordered participating object. `eventAt` is normalized to UTC milliseconds so two
 * spellings of the same instant hash the same; the offset the device reported travels separately.
 */
export function canonicalEldEvent(deviceRef: string, e: EldEventInput): CanonicalEldEvent {
  const at = new Date(e.eventAt);
  if (Number.isNaN(at.getTime())) throw new Error("eventAt is not a parseable ISO-8601 instant");
  return {
    hashVersion: ELD_HASH_VERSION,
    deviceRef,
    eventRef: e.eventRef,
    deviceSequence: e.deviceSequence,
    eventType: e.eventType,
    eventCode: nn(e.eventCode),
    dutyStatus: nn(e.dutyStatus),
    recordOrigin: e.recordOrigin,
    eventAt: at.toISOString(),
    eventUtcOffsetMinutes: nn(e.eventUtcOffsetMinutes),
    unitId: nn(e.unitId),
    latitude: nn(e.latitude),
    longitude: nn(e.longitude),
    locationAccuracyM: nn(e.locationAccuracyM),
    locationSource: nn(e.locationSource),
    jurisdiction: nn(e.jurisdiction),
    odometerKm: nn(e.odometerKm),
    engineHours: nn(e.engineHours),
    vehicleSpeedKph: nn(e.vehicleSpeedKph),
    annotation: nn(e.annotation),
    supersedesEventRef: nn(e.supersedesEventRef),
  };
}

/** The bytes that are hashed. Key order is the declaration order above; JSON.stringify keeps it. */
export function canonicalEldEventJson(deviceRef: string, e: EldEventInput): string {
  return JSON.stringify(canonicalEldEvent(deviceRef, e));
}

/** The pre-image of `eventHash`. Hashing itself is the caller's (node:crypto on the server, WebCrypto on a device). */
export function eldEventHashPreimage(payloadHash: string, previousEventHash: string | null, hashVersion: string = ELD_HASH_VERSION): string {
  return `${hashVersion}\n${previousEventHash ?? ""}\n${payloadHash}`;
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Structural validation an event must pass before it is hashed. Returns the reasons rather than
 * throwing, so a batch can report every problem at once.
 */
export function validateEldEventShape(e: EldEventInput): string[] {
  const r: string[] = [];
  if (!UUID_V4.test(e.eventRef)) r.push("eventRef must be a UUID v4");
  if (!Number.isInteger(e.deviceSequence) || e.deviceSequence < 0 || e.deviceSequence > Number.MAX_SAFE_INTEGER) r.push("deviceSequence must be a non-negative integer");
  if (!ELD_EVENT_TYPES.includes(e.eventType)) r.push(`eventType ${String(e.eventType)} is not a known structural type`);
  if (!ELD_RECORD_ORIGINS_DEVICE.includes(e.recordOrigin)) r.push("recordOrigin must be automatic or driver for a device-originated event");
  if (Number.isNaN(Date.parse(e.eventAt))) r.push("eventAt must be an ISO-8601 instant");
  if (e.eventType === "duty_status_change" && !e.dutyStatus) r.push("duty_status_change requires dutyStatus");
  if (e.eventType !== "duty_status_change" && e.dutyStatus) r.push("dutyStatus is only carried by duty_status_change");
  if (e.dutyStatus && !ELD_DUTY_STATUSES.includes(e.dutyStatus)) r.push("dutyStatus is not one of the four legal statuses");
  if (e.eventType === "correction" && !e.supersedesEventRef) r.push("correction requires supersedesEventRef");
  if (e.eventType !== "correction" && e.supersedesEventRef) r.push("supersedesEventRef is only carried by a correction");
  if (e.supersedesEventRef && !UUID_V4.test(e.supersedesEventRef)) r.push("supersedesEventRef must be a UUID v4");
  if (e.supersedesEventRef && e.supersedesEventRef === e.eventRef) r.push("an event cannot supersede itself");
  if (e.previousEventHash != null && !HEX64.test(e.previousEventHash)) r.push("previousEventHash must be 64 lowercase hex characters");
  if (e.declaredEventHash != null && !HEX64.test(e.declaredEventHash)) r.push("declaredEventHash must be 64 lowercase hex characters");
  if (e.eventUtcOffsetMinutes != null && (!Number.isInteger(e.eventUtcOffsetMinutes) || Math.abs(e.eventUtcOffsetMinutes) > 14 * 60)) r.push("eventUtcOffsetMinutes must be an integer within ±840");
  if (e.latitude != null && (e.latitude < -90 || e.latitude > 90)) r.push("latitude out of range");
  if (e.longitude != null && (e.longitude < -180 || e.longitude > 180)) r.push("longitude out of range");
  if (e.jurisdiction != null && e.jurisdiction.length > 8) r.push("jurisdiction is at most 8 characters");
  if (e.annotation != null && e.annotation.length > 500) r.push("annotation is at most 500 characters");
  if (e.eventCode != null && e.eventCode.length > 40) r.push("eventCode is at most 40 characters");
  return r;
}
