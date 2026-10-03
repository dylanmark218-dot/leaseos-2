/**
 * 0220 — the ELD ledger's pure half: validation, hashing, batch preparation, chain assessment.
 *
 * No database, no network. Everything a device could also run. The store (`eldLedgerStore.ts`)
 * is the only thing that writes; this file decides what a well-formed batch is and what the rows
 * already on record say about a device's chain.
 *
 * Three refusals shape it:
 *   a batch with any malformed event is refused whole — half a device's day is not a record;
 *   a hash the device declared that the server cannot reproduce refuses that batch;
 *   a gap in the sequence is REPORTED, never filled — a missing event is a diagnostic condition,
 *   not permission to manufacture history.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ELD_DUTY_STATUSES, ELD_EVENT_AT_MS_MAX, ELD_EVENT_AT_MS_MIN, ELD_EVENT_TYPES, ELD_HASH_VERSION, ELD_LOCATION_SOURCES, ELD_MAX_INTEGER,
  ELD_RECORD_ORIGINS_DEVICE, canonicalEldEventJson, eldEventHashPreimage, normalizeUuid, validateEldEventShape,
  type EldEventInput,
} from "../../../shared/eld/eldEvent";

/** SHA-256 over the UTF-8 bytes of a canonical text, lowercase hex. */
export const sha256Hex = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/* ------------------------------------------------------------------ */
/* Reason codes                                                         */
/* ------------------------------------------------------------------ */

export const ELD_APPEND_REASON_CODES = [
  "inserted",
  "replayed",                     // same identity, same content: already on record
  "conflict_event_ref",           // same eventRef, different content: kept as evidence
  "conflict_device_sequence",     // same (device, sequence), different content: kept as evidence
  "schema_invalid",
  "batch_internal_duplicate",     // the batch contradicts itself
  "declared_hash_mismatch",       // the device's own eventHash does not match what its bytes hash to
  "device_unknown",
  "device_not_active",
  "device_no_organization",
  "device_not_callers",
  "operator_unresolved",          // a duty-status event from a device whose user has no operator record
  "operator_ambiguous",
  "operator_not_in_organization",
  "unit_unknown",
  "unit_not_in_organization",
] as const;
export type EldAppendReasonCode = (typeof ELD_APPEND_REASON_CODES)[number];

/* ------------------------------------------------------------------ */
/* Input schema — strict, so an unexpected field is a refusal           */
/* ------------------------------------------------------------------ */

/**
 * Strict on purpose. There is no `operatorName`, `operatorRef`, `orgRef`, `unitId` or `deviceId`
 * here, and because the object is strict, a client that sends one is refused rather than ignored.
 * Identity comes from the enrolled device; a name in a payload is never identity, and a unit is
 * named by its number and resolved on the server.
 */
export const ELD_EVENT_INPUT = z.object({
  eventRef: z.string().min(36).max(36),
  deviceSequence: z.number().int().nonnegative().max(ELD_MAX_INTEGER),
  eventType: z.enum(ELD_EVENT_TYPES),
  eventCode: z.string().max(40).nullish(),
  dutyStatus: z.enum(ELD_DUTY_STATUSES).nullish(),
  recordOrigin: z.enum(ELD_RECORD_ORIGINS_DEVICE),
  /** Integer milliseconds since the epoch; the canonical form carries no timestamp text. */
  eventAtMs: z.number().int().min(ELD_EVENT_AT_MS_MIN).max(ELD_EVENT_AT_MS_MAX),
  eventUtcOffsetMinutes: z.number().int().min(-840).max(840).nullish(),
  unitNumber: z.string().min(1).max(40).nullish(),
  // Fixed-scale integers, never floats: the canonical form forbids them (see shared/eld/eldEvent.ts).
  latitudeE7: z.number().int().min(-900_000_000).max(900_000_000).nullish(),
  longitudeE7: z.number().int().min(-1_800_000_000).max(1_800_000_000).nullish(),
  locationAccuracyMm: z.number().int().nonnegative().max(ELD_MAX_INTEGER).nullish(),
  locationSource: z.enum(ELD_LOCATION_SOURCES).nullish(),
  jurisdiction: z.string().max(8).nullish(),
  odometerM: z.number().int().nonnegative().max(ELD_MAX_INTEGER).nullish(),
  engineHoursMillis: z.number().int().nonnegative().max(ELD_MAX_INTEGER).nullish(),
  vehicleSpeedKphMillis: z.number().int().nonnegative().max(ELD_MAX_INTEGER).nullish(),
  annotation: z.string().max(500).nullish(),
  supersedesEventRef: z.string().max(64).nullish(),
  previousEventHash: z.string().length(64).nullable(),
  declaredEventHash: z.string().length(64).nullish(),
}).strict();

export type EldEventInputParsed = z.infer<typeof ELD_EVENT_INPUT>;

/* ------------------------------------------------------------------ */
/* Hashing                                                              */
/* ------------------------------------------------------------------ */

export type HashedEldEvent = {
  input: EldEventInput;
  canonicalJson: string;
  payloadHash: string;
  eventHash: string;
  hashVersion: typeof ELD_HASH_VERSION;
};

/**
 * Deterministic: the same device, the same event, the same bytes, the same two hashes — on this
 * server, on a device, or in any implementation that follows the canonical form's stated rules.
 * The server ALWAYS computes both hashes itself; a hash the sender declared is compared against
 * this result and never substituted for it.
 */
export function hashEldEvent(deviceRef: string, e: EldEventInput): HashedEldEvent {
  const canonicalJson = canonicalEldEventJson(deviceRef, e);
  const payloadHash = sha256Hex(canonicalJson);
  const eventHash = sha256Hex(eldEventHashPreimage(payloadHash, e.previousEventHash, ELD_HASH_VERSION));
  return { input: e, canonicalJson, payloadHash, eventHash, hashVersion: ELD_HASH_VERSION };
}

/* ------------------------------------------------------------------ */
/* Batch preparation                                                    */
/* ------------------------------------------------------------------ */

export type BatchProblem = { eventRef: string | null; deviceSequence: number | null; code: EldAppendReasonCode; detail: string };

export type PreparedBatch =
  | { ok: true; events: HashedEldEvent[] }
  | { ok: false; problems: BatchProblem[] };

/**
 * Validate every event, hash every event, and refuse the batch if it contradicts itself. Ordered
 * by deviceSequence on the way out so the store writes a device's events in its own order.
 *
 * A batch may legitimately contain the same event twice (a retry inside one package): identical
 * copies collapse to one. Two events sharing an eventRef or a sequence with DIFFERENT content are
 * a contradiction the device must sort out, and the batch is refused whole rather than the store
 * choosing one.
 */
export function prepareEldBatch(deviceRef: string, raw: unknown[]): PreparedBatch {
  const problems: BatchProblem[] = [];
  const hashed: HashedEldEvent[] = [];
  raw.forEach((candidate, i) => {
    const parsed = ELD_EVENT_INPUT.safeParse(candidate);
    if (!parsed.success) {
      const ref = candidate && typeof candidate === "object" && typeof (candidate as { eventRef?: unknown }).eventRef === "string" ? (candidate as { eventRef: string }).eventRef : null;
      problems.push({ eventRef: ref, deviceSequence: null, code: "schema_invalid", detail: `event[${i}]: ${parsed.error.issues.slice(0, 3).map(x => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ")}` });
      return;
    }
    const e: EldEventInput = { ...parsed.data, eventRef: normalizeUuid(parsed.data.eventRef), supersedesEventRef: parsed.data.supersedesEventRef == null ? parsed.data.supersedesEventRef : normalizeUuid(parsed.data.supersedesEventRef) };
    const shape = validateEldEventShape(e);
    if (shape.length) { problems.push({ eventRef: e.eventRef, deviceSequence: e.deviceSequence, code: "schema_invalid", detail: shape.join("; ") }); return; }
    const h = hashEldEvent(deviceRef, e);
    if (e.declaredEventHash != null && e.declaredEventHash.toLowerCase() !== h.eventHash) {
      problems.push({ eventRef: e.eventRef, deviceSequence: e.deviceSequence, code: "declared_hash_mismatch", detail: `device declared ${e.declaredEventHash}, its bytes hash to ${h.eventHash}` });
      return;
    }
    hashed.push(h);
  });
  if (problems.length) return { ok: false, problems };

  // Self-consistency: collapse identical copies; refuse contradictions.
  const byRef = new Map<string, HashedEldEvent>();
  const bySeq = new Map<number, HashedEldEvent>();
  const out: HashedEldEvent[] = [];
  for (const h of hashed) {
    const r = byRef.get(h.input.eventRef);
    const s = bySeq.get(h.input.deviceSequence);
    if (r && r.eventHash === h.eventHash) continue;                                   // exact duplicate inside the batch
    if (r) problems.push({ eventRef: h.input.eventRef, deviceSequence: h.input.deviceSequence, code: "batch_internal_duplicate", detail: `eventRef appears twice with different content (${r.eventHash} vs ${h.eventHash})` });
    else if (s) problems.push({ eventRef: h.input.eventRef, deviceSequence: h.input.deviceSequence, code: "batch_internal_duplicate", detail: `deviceSequence ${h.input.deviceSequence} appears twice with different content (${s.input.eventRef} vs ${h.input.eventRef})` });
    else { byRef.set(h.input.eventRef, h); bySeq.set(h.input.deviceSequence, h); out.push(h); }
  }
  if (problems.length) return { ok: false, problems };
  out.sort((a, b) => a.input.deviceSequence - b.input.deviceSequence);
  return { ok: true, events: out };
}

/* ------------------------------------------------------------------ */
/* Chain assessment                                                     */
/* ------------------------------------------------------------------ */

// The chain assessment is pure and runs on the device too (checkpoint 2d), so it lives in the shared
// contract beside the canonical form; re-exported here so every server import keeps its path.
export { assessDeviceChain, type ChainAssessment, type ChainLinkState, type ChainRow } from "../../../shared/eld/chain";

/* ------------------------------------------------------------------ */
/* The signed batch envelope                                            */
/* ------------------------------------------------------------------ */

function canonicalSorted(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSorted).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalSorted(obj[k])}`).join(",")}}`;
}

/**
 * What the device signs when it pushes a batch — the same sorted-key canonical form
 * `canonicalDevicePackage` uses for evidence packages, over the batch's own fields.
 */
export function canonicalEldBatch(input: { deviceRef: string; batchRef: string; signedAt: Date; nonce: string; events: unknown[] }): Buffer {
  return Buffer.from(canonicalSorted({ deviceRef: input.deviceRef, batchRef: input.batchRef, signedAt: input.signedAt.toISOString(), nonce: input.nonce, events: input.events }), "utf8");
}
