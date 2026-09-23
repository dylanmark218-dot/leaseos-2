/**
 * 0179 — the canonical ELD event: what a device records, how it is serialized, and what is hashed.
 *
 * Shared by the server ledger and the device runtime, and written so that a Kotlin, Swift, Rust or
 * C producer can reproduce the same bytes without a JavaScript runtime. Nothing here touches a
 * database or a network, and nothing here knows a regulation: the event vocabulary is structural
 * (a duty-status change carries a duty status; a correction names what it corrects) and every
 * threshold, interval and rule stays in the verified registry where it belongs.
 *
 * IDENTITY. An event has two identities and the ledger enforces both:
 *   `eventRef`        a UUID v4 the device mints when the event is recorded, stable for ever;
 *   `deviceSequence`  the device's own monotonic counter, so the ledger can tell a gap from a
 *                     delay and order events from one device without trusting its clock.
 * The operator, the unit's ownership and the organization are NOT in the payload as identity: the
 * server resolves them from the enrolled device. A `unitNumber` may be stated and is checked; no
 * field names a driver.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LEASEOS ELD CANONICAL FORM — hash version `eld-h1`
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * The canonical bytes of an event are the UTF-8 encoding (no byte-order mark) of a JSON text
 * produced under the rules below. The rules are a strict subset of RFC 8785 (JSON Canonicalization
 * Scheme); an implementation MAY use a JCS library but MUST NOT need one, because everything a
 * producer has to do is stated here:
 *
 *   1. Value kinds: object, array, string, integer, `true`, `false`, `null`. No other kind exists.
 *      Floating-point numbers are forbidden in canonical form; every decimal quantity is carried
 *      as an integer at a stated fixed scale (see the field table).
 *   2. Object: `{` members `}`; members are `"key":value` joined by `,`; members ordered by key,
 *      ascending, comparing keys as sequences of Unicode code points (for ASCII keys this is byte
 *      order). Every key in this contract is ASCII. No duplicate keys.
 *   3. Array: `[` elements joined by `,` `]`; element order is significant and preserved.
 *   4. String: `"` + escaped characters + `"`. Escape U+0022 as `\"`, U+005C as `\\`, U+0008 as
 *      `\b`, U+0009 as `\t`, U+000A as `\n`, U+000C as `\f`, U+000D as `\r`, and every other code
 *      point below U+0020 as `\u` followed by four LOWERCASE hex digits. Every other code point,
 *      including U+007F, U+2028, U+2029 and all non-ASCII, is emitted as its UTF-8 bytes unescaped.
 *      Strings MUST be well-formed Unicode: an unpaired surrogate is a refusal, not an escape.
 *      No Unicode normalization is applied: two different code-point sequences are two events.
 *   5. Integer: `-?(0|[1-9][0-9]*)`, magnitude at most 2^53 − 1 (9007199254740991). No `+`, no
 *      leading zeros, no fraction, no exponent. Negative zero is encoded as `0`.
 *   6. No whitespace anywhere. No trailing newline.
 *   7. Absence and null are the same thing: every participating field is present in the canonical
 *      object, and an optional field the producer did not set is encoded as `null`.
 *   8. Timestamps are integers: `eventAtMs` is milliseconds since 1970-01-01T00:00:00Z. The offset
 *      the device's clock was set to travels separately as `eventUtcOffsetMinutes`.
 *   9. UUIDs are the 36-character hyphenated form in LOWERCASE hex. A producer MUST emit lowercase;
 *      the server lowercases before canonicalizing so a mixed-case reference cannot become a
 *      second identity.
 *  10. Hashes are 64 LOWERCASE hex characters of SHA-256.
 *  11. Enumerations (`eventType`, `dutyStatus`, `recordOrigin`, `locationSource`) are their string
 *      values, verbatim.
 *
 * The two hashes:
 *   payloadHash = SHA-256( canonical bytes of the participating object below )
 *   eventHash   = SHA-256( UTF-8("eld-h1") ‖ 0x0A ‖ UTF-8(previousEventHash or "") ‖ 0x0A ‖ UTF-8(payloadHash) )
 * where `previousEventHash` is the device's claim: the `eventHash` of ITS previous event
 * (deviceSequence − 1), or absent for the first event it ever recorded. The chain is per device.
 *
 * Participating object (21 keys; the encoder sorts them, this table is by meaning):
 *
 *   key                     kind      participation
 *   hashVersion             string    protocol constant "eld-h1"
 *   deviceRef               string    device-authored claim of its own enrolled reference (server-minted at enrolment, stable, known to the device)
 *   eventRef                string    device-authored UUID v4, lowercase
 *   deviceSequence          integer   device-authored, ≥ 0
 *   eventType               string    device-authored enumeration
 *   eventCode               string?   device-authored, optional
 *   dutyStatus              string?   device-authored enumeration, only on duty_status_change
 *   recordOrigin            string    device-authored: automatic | driver
 *   eventAtMs               integer   device-authored device clock, ms since epoch
 *   eventUtcOffsetMinutes   integer?  device-authored, −840…840
 *   unitNumber              string?   device-authored claim of a unit's number (a stable, device-visible identifier; the server resolves and checks ownership)
 *   latitudeE7              integer?  device-authored, degrees × 10^7, −900000000…900000000
 *   longitudeE7             integer?  device-authored, degrees × 10^7, −1800000000…1800000000
 *   locationAccuracyMm      integer?  device-authored, millimetres, ≥ 0
 *   locationSource          string?   device-authored enumeration
 *   jurisdiction            string?   device-authored claim, ≤ 8 chars
 *   odometerM               integer?  device-authored, metres, ≥ 0
 *   engineHoursMillis       integer?  device-authored, thousandths of an hour, ≥ 0
 *   vehicleSpeedKphMillis   integer?  device-authored, thousandths of a km/h, ≥ 0
 *   annotation              string?   device-authored, ≤ 500 chars
 *   supersedesEventRef      string?   device-authored UUID v4, only on correction
 *
 * NOT participating, because the server assigns them and a device could not know them:
 *   the row id, orgRef, operatorId, unitId, receivedAt, sourceKind, sourceRef, submittedByUserId,
 *   createdAt. Integrity of what the device claimed and the server's determination of who owns the
 *   event are two different facts, and only the first is under the hash.
 *
 * Fixed scales are a deliberate, explicit precision: 10^-7 degrees (≈ 1.1 cm), 1 mm, 1 m,
 * 0.001 h (3.6 s) and 0.001 km/h. The server stores derived floating columns for querying; the
 * canonical bytes are the record.
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

/** The largest integer the canonical form carries (2^53 − 1), so every implementation agrees. */
export const ELD_MAX_INTEGER = 9007199254740991;

/** Fixed scales, named once so no reader has to remember them. */
export const ELD_SCALE = {
  degreesE7: 10_000_000,
  metresToMm: 1_000,
  kmToM: 1_000,
  hoursToMillis: 1_000,
  kphToMillis: 1_000,
} as const;

/**
 * Storage limits of the ledger's `timestamp(3)` column (MariaDB TIMESTAMP range), stated in the
 * contract so a device with a wrong clock is refused with a reason rather than failing an insert.
 */
export const ELD_EVENT_AT_MS_MIN = 1_000;                 // 1970-01-01T00:00:01Z
export const ELD_EVENT_AT_MS_MAX = 2_147_483_647_000;     // 2038-01-19T03:14:07Z

/** What a device submits for one event. Strict: an unknown field is a refusal, not an ignore. */
export type EldEventInput = {
  eventRef: string;
  deviceSequence: number;
  eventType: EldEventType;
  eventCode?: string | null;
  dutyStatus?: EldDutyStatus | null;
  recordOrigin: EldDeviceRecordOrigin;
  /** Milliseconds since the Unix epoch, UTC, from the device's clock. */
  eventAtMs: number;
  eventUtcOffsetMinutes?: number | null;
  unitNumber?: string | null;
  latitudeE7?: number | null;
  longitudeE7?: number | null;
  locationAccuracyMm?: number | null;
  locationSource?: EldLocationSource | null;
  jurisdiction?: string | null;
  odometerM?: number | null;
  engineHoursMillis?: number | null;
  vehicleSpeedKphMillis?: number | null;
  annotation?: string | null;
  supersedesEventRef?: string | null;
  /** The device's claim about its previous event's hash; null for its first event. */
  previousEventHash: string | null;
  /** Optional: what the device computed. When present and different, the server refuses the event. */
  declaredEventHash?: string | null;
};

/* ------------------------------------------------------------------ */
/* The canonical encoder                                                */
/* ------------------------------------------------------------------ */

/** The value kinds the canonical form admits. Nothing else can be encoded. */
export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export class CanonicalEncodingError extends Error {}

const HEX4 = (n: number) => n.toString(16).padStart(4, "0");

/** Rule 4. Exported so a test can pin every escape independently of an object. */
export function canonicalString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + HEX4(c);
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A high surrogate must be followed by a low one; then the pair is one code point, emitted raw.
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new CanonicalEncodingError(`unpaired high surrogate at index ${i}`);
      out += s[i]! + s[i + 1]!;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalEncodingError(`unpaired low surrogate at index ${i}`);
    else out += s[i]!;
  }
  return out + '"';
}

/** Rule 5. */
export function canonicalInteger(n: number): string {
  if (typeof n !== "number" || !Number.isInteger(n)) throw new CanonicalEncodingError(`not an integer: ${String(n)}`);
  if (Math.abs(n) > ELD_MAX_INTEGER) throw new CanonicalEncodingError(`integer magnitude exceeds 2^53-1: ${n}`);
  if (Object.is(n, -0)) return "0";
  return String(n);                                   // an integer within ±2^53−1 prints as plain decimal
}

/** Rule 2: keys compared as code-point sequences. */
function compareKeys(a: string, b: string): number {
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!, cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/**
 * Rules 1–6. Produces the canonical JSON text; the canonical BYTES are its UTF-8 encoding. Refuses
 * anything outside the admitted value kinds rather than guessing a representation.
 */
export function canonicalEncode(value: CanonicalValue): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return canonicalInteger(value);
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEncode).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareKeys);
    return `{${keys.map(k => `${canonicalString(k)}:${canonicalEncode((value as Record<string, CanonicalValue>)[k]!)}`).join(",")}}`;
  }
  throw new CanonicalEncodingError(`value of type ${typeof value} has no canonical form`);
}

/* ------------------------------------------------------------------ */
/* The event's participating object                                     */
/* ------------------------------------------------------------------ */

/** The participating fields. All 21 are always present; optional ones are null when unset. */
export type CanonicalEldEvent = {
  hashVersion: typeof ELD_HASH_VERSION;
  deviceRef: string;
  eventRef: string;
  deviceSequence: number;
  eventType: EldEventType;
  eventCode: string | null;
  dutyStatus: EldDutyStatus | null;
  recordOrigin: EldDeviceRecordOrigin;
  eventAtMs: number;
  eventUtcOffsetMinutes: number | null;
  unitNumber: string | null;
  latitudeE7: number | null;
  longitudeE7: number | null;
  locationAccuracyMm: number | null;
  locationSource: EldLocationSource | null;
  jurisdiction: string | null;
  odometerM: number | null;
  engineHoursMillis: number | null;
  vehicleSpeedKphMillis: number | null;
  annotation: string | null;
  supersedesEventRef: string | null;
};

export const CANONICAL_ELD_EVENT_KEYS = [
  "hashVersion", "deviceRef", "eventRef", "deviceSequence", "eventType", "eventCode", "dutyStatus", "recordOrigin", "eventAtMs",
  "eventUtcOffsetMinutes", "unitNumber", "latitudeE7", "longitudeE7", "locationAccuracyMm", "locationSource", "jurisdiction",
  "odometerM", "engineHoursMillis", "vehicleSpeedKphMillis", "annotation", "supersedesEventRef",
] as const;

const nn = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

/** Rule 9: lowercase. Applied to every UUID before it participates. */
export const normalizeUuid = (s: string) => s.toLowerCase();

/** The participating object. Building it here, and only here, is what fixes the field list. */
export function canonicalEldEvent(deviceRef: string, e: EldEventInput): CanonicalEldEvent {
  return {
    hashVersion: ELD_HASH_VERSION,
    deviceRef,
    eventRef: normalizeUuid(e.eventRef),
    deviceSequence: e.deviceSequence,
    eventType: e.eventType,
    eventCode: nn(e.eventCode),
    dutyStatus: nn(e.dutyStatus),
    recordOrigin: e.recordOrigin,
    eventAtMs: e.eventAtMs,
    eventUtcOffsetMinutes: nn(e.eventUtcOffsetMinutes),
    unitNumber: nn(e.unitNumber),
    latitudeE7: nn(e.latitudeE7),
    longitudeE7: nn(e.longitudeE7),
    locationAccuracyMm: nn(e.locationAccuracyMm),
    locationSource: nn(e.locationSource),
    jurisdiction: nn(e.jurisdiction),
    odometerM: nn(e.odometerM),
    engineHoursMillis: nn(e.engineHoursMillis),
    vehicleSpeedKphMillis: nn(e.vehicleSpeedKphMillis),
    annotation: nn(e.annotation),
    supersedesEventRef: e.supersedesEventRef == null ? null : normalizeUuid(e.supersedesEventRef),
  };
}

/** The canonical text of an event. Its UTF-8 bytes are what `payloadHash` covers. */
export function canonicalEldEventJson(deviceRef: string, e: EldEventInput): string {
  return canonicalEncode(canonicalEldEvent(deviceRef, e) as unknown as CanonicalValue);
}

/** The pre-image of `eventHash`, as text; hash its UTF-8 bytes. */
export function eldEventHashPreimage(payloadHash: string, previousEventHash: string | null, hashVersion: string = ELD_HASH_VERSION): string {
  return `${hashVersion}\n${previousEventHash ?? ""}\n${payloadHash}`;
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEX64 = /^[0-9a-f]{64}$/;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= ELD_MAX_INTEGER;
const intIn = (v: number | null | undefined, lo: number, hi: number) => v == null || (isInt(v) && v >= lo && v <= hi);

/**
 * Structural validation an event must pass before it is hashed. Returns the reasons rather than
 * throwing, so a batch can report every problem at once.
 */
export function validateEldEventShape(e: EldEventInput): string[] {
  const r: string[] = [];
  if (!UUID_V4.test(e.eventRef)) r.push("eventRef must be a UUID v4");
  if (!isInt(e.deviceSequence) || e.deviceSequence < 0) r.push("deviceSequence must be a non-negative integer");
  if (!ELD_EVENT_TYPES.includes(e.eventType)) r.push(`eventType ${String(e.eventType)} is not a known structural type`);
  if (!ELD_RECORD_ORIGINS_DEVICE.includes(e.recordOrigin)) r.push("recordOrigin must be automatic or driver for a device-originated event");
  if (!isInt(e.eventAtMs) || e.eventAtMs < ELD_EVENT_AT_MS_MIN || e.eventAtMs > ELD_EVENT_AT_MS_MAX) r.push(`eventAtMs must be an integer between ${ELD_EVENT_AT_MS_MIN} and ${ELD_EVENT_AT_MS_MAX} (ms since epoch, within the storable range)`);
  if (e.eventType === "duty_status_change" && !e.dutyStatus) r.push("duty_status_change requires dutyStatus");
  if (e.eventType !== "duty_status_change" && e.dutyStatus) r.push("dutyStatus is only carried by duty_status_change");
  if (e.dutyStatus && !ELD_DUTY_STATUSES.includes(e.dutyStatus)) r.push("dutyStatus is not one of the four legal statuses");
  if (e.eventType === "correction" && !e.supersedesEventRef) r.push("correction requires supersedesEventRef");
  if (e.eventType !== "correction" && e.supersedesEventRef) r.push("supersedesEventRef is only carried by a correction");
  if (e.supersedesEventRef && !UUID_V4.test(e.supersedesEventRef)) r.push("supersedesEventRef must be a UUID v4");
  if (e.supersedesEventRef && normalizeUuid(e.supersedesEventRef) === normalizeUuid(e.eventRef)) r.push("an event cannot supersede itself");
  if (e.previousEventHash != null && !HEX64.test(e.previousEventHash)) r.push("previousEventHash must be 64 lowercase hex characters");
  if (e.declaredEventHash != null && !HEX64.test(e.declaredEventHash)) r.push("declaredEventHash must be 64 lowercase hex characters");
  if (!intIn(e.eventUtcOffsetMinutes, -840, 840)) r.push("eventUtcOffsetMinutes must be an integer within ±840");
  if (!intIn(e.latitudeE7, -900_000_000, 900_000_000)) r.push("latitudeE7 must be an integer within ±900000000");
  if (!intIn(e.longitudeE7, -1_800_000_000, 1_800_000_000)) r.push("longitudeE7 must be an integer within ±1800000000");
  if (!intIn(e.locationAccuracyMm, 0, ELD_MAX_INTEGER)) r.push("locationAccuracyMm must be a non-negative integer");
  if (!intIn(e.odometerM, 0, ELD_MAX_INTEGER)) r.push("odometerM must be a non-negative integer");
  if (!intIn(e.engineHoursMillis, 0, ELD_MAX_INTEGER)) r.push("engineHoursMillis must be a non-negative integer");
  if (!intIn(e.vehicleSpeedKphMillis, 0, ELD_MAX_INTEGER)) r.push("vehicleSpeedKphMillis must be a non-negative integer");
  if (e.locationSource != null && !ELD_LOCATION_SOURCES.includes(e.locationSource)) r.push("locationSource is not a known source");
  if (e.unitNumber != null && (e.unitNumber.length === 0 || e.unitNumber.length > 40)) r.push("unitNumber is 1 to 40 characters");
  if (e.jurisdiction != null && e.jurisdiction.length > 8) r.push("jurisdiction is at most 8 characters");
  if (e.annotation != null && e.annotation.length > 500) r.push("annotation is at most 500 characters");
  if (e.eventCode != null && e.eventCode.length > 40) r.push("eventCode is at most 40 characters");
  for (const [k, v] of Object.entries({ eventCode: e.eventCode, jurisdiction: e.jurisdiction, annotation: e.annotation, unitNumber: e.unitNumber })) {
    if (typeof v === "string") { try { canonicalString(v); } catch (err) { r.push(`${k}: ${(err as Error).message}`); } }
  }
  return r;
}
