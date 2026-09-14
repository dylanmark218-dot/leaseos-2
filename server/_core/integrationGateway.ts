/**
 * Integration gateway — the engines.
 *
 * Outbound: a delivery is the outbox event's JSON, signed with the
 * subscription's secret over `timestamp.body` (HMAC-SHA256), retried on a
 * fixed schedule, and dead after its last attempt — every attempt kept.
 * Inbound: a feed is accepted only within the client's scope and only when
 * it is well-formed; what it becomes is a PROPOSAL, and the intake says so.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_ATTEMPTS = 6;
/** Minutes before each retry: 1, 5, 30, 120, 720 — then dead. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
export function verifySignature(secret: string, timestamp: number, body: string, signature: string, now: Date, toleranceSeconds = 300): { valid: boolean; reason: string | null } {
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return { valid: false, reason: "Timestamp outside tolerance — replay refused" };
  const expected = signPayload(secret, timestamp, body);
  const a = Buffer.from(expected, "hex"), b = Buffer.from(signature.length === expected.length ? signature : "0".repeat(expected.length), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? { valid: true, reason: null } : { valid: false, reason: "Signature does not match" };
}

export function deliveryOutcome(args: { attempt: number; responseStatus: number | null; error: string | null; at: Date }): { status: "delivered" | "failed" | "dead"; nextAttemptAt: Date | null; reason: string } {
  if (args.responseStatus != null && args.responseStatus >= 200 && args.responseStatus < 300) return { status: "delivered", nextAttemptAt: null, reason: `HTTP ${args.responseStatus}` };
  const reason = args.error ?? `HTTP ${args.responseStatus}`;
  if (args.attempt >= MAX_ATTEMPTS) return { status: "dead", nextAttemptAt: null, reason: `${reason} — attempt ${args.attempt} of ${MAX_ATTEMPTS}; dead, a person re-queues it` };
  const minutes = BACKOFF_MINUTES[Math.min(args.attempt - 1, BACKOFF_MINUTES.length - 1)]!;
  return { status: "failed", nextAttemptAt: new Date(args.at.getTime() + minutes * 60_000), reason: `${reason} — retry ${args.attempt + 1} in ${minutes} min` };
}

export function subscribed(eventTypes: readonly string[], eventType: string): boolean {
  return eventTypes.some(t => t === "*" || t === eventType || (t.endsWith(".*") && eventType.startsWith(t.slice(0, -1))));
}

/* ---- inbound ---- */

export type Feed = "gps_position" | "fuel_transaction" | "eld_duty_status" | "vehicle_telemetry" | "fault_code" | "safety_event" | "video_clip" | "generic";
export type Intake = { accepted: boolean; refusals: string[]; becomes: string; note: string };

export function intakeDecision(args: { feed: Feed; scopes: readonly string[]; payload: Record<string, unknown> }): Intake {
  const r: string[] = [];
  if (!args.scopes.includes(args.feed)) r.push(`Client is not scoped for ${args.feed}`);
  const p = args.payload;
  const num = (k: string) => typeof p[k] === "number" && Number.isFinite(p[k] as number);
  const str = (k: string) => typeof p[k] === "string" && (p[k] as string).length > 0;
  const iso = (k: string) => str(k) && !Number.isNaN(Date.parse(p[k] as string));
  let becomes = "inbound event only", note = "";
  switch (args.feed) {
    case "gps_position":
      if (!num("latitude") || !num("longitude")) r.push("latitude and longitude are required numbers");
      if (!iso("recordedAt")) r.push("recordedAt is required (ISO 8601)");
      if (!str("unitRef")) r.push("unitRef is required");
      becomes = "position evidence"; note = "Stored as evidence with its time and source. It is not projected onto a route or a board until a routing source exists (P0), and it never makes a unit WORKING by itself.";
      break;
    case "fuel_transaction":
      if (!iso("occurredAt")) r.push("occurredAt is required (ISO 8601)");
      if (!num("quantity") || (p.quantity as number) <= 0) r.push("quantity must be a positive number");
      if (!num("total") || (p.total as number) < 0) r.push("total must be a non-negative number");
      if (!str("unitRef")) r.push("unitRef is required");
      becomes = "fuel transaction proposal"; note = "Enters the fuel ledger as needs_review with jurisdiction from the card statement when given, else unknown. A person confirms it; the card statement match tests it.";
      break;
    case "eld_duty_status":
      if (!["driving", "on_duty", "sleeper_berth", "off_duty"].includes(String(p.dutyStatus))) r.push("dutyStatus must be driving, on_duty, sleeper_berth or off_duty");
      if (!iso("startedAt")) r.push("startedAt is required (ISO 8601)");
      if (!str("operatorRef")) r.push("operatorRef is required");
      becomes = "duty record"; note = "Recorded with source = the client. HOS conclusions are the rule engine's, and the rules are unverified (P9).";
      break;
    case "vehicle_telemetry":
      if (!iso("recordedAt")) r.push("recordedAt is required (ISO 8601)");
      if (!str("unitRef")) r.push("unitRef is required");
      if (!["odometerKm", "engineHours", "ptoHours", "idleMinutes", "fuelLevelPct"].some(num)) r.push("at least one of odometerKm, engineHours, ptoHours, idleMinutes, fuelLevelPct is required");
      becomes = "telemetry snapshot"; note = "Stored as evidence with its source. The odometer is reconciled against trips and the shop, not trusted over them.";
      break;
    case "fault_code":
      if (!str("code")) r.push("code is required");
      if (!["j1939", "obd2", "proprietary"].includes(String(p.protocol))) r.push("protocol must be j1939, obd2 or proprietary");
      if (!iso("seenAt")) r.push("seenAt is required (ISO 8601)");
      if (!str("unitRef")) r.push("unitRef is required");
      becomes = "fault observation"; note = "Counted and spanned per unit and code. Its severity is a rule with no verified source: the unit is REVIEW until a mechanic acknowledges the fault and determines it.";
      break;
    case "safety_event":
      if (!["harsh_brake", "rapid_acceleration", "harsh_cornering", "speeding", "seatbelt", "distraction", "collision_suspected", "other"].includes(String(p.kind))) r.push("kind is not a recognized driving event");
      if (!iso("recordedAt")) r.push("recordedAt is required (ISO 8601)");
      if (!str("unitRef")) r.push("unitRef is required");
      becomes = "driving event for review"; note = "Queued for a person to coach, dismiss or escalate. No score is computed about the driver.";
      break;
    case "video_clip":
      if (!str("clipRef")) r.push("clipRef is required");
      if (!str("clipHash") || !/^[a-f0-9]{64}$/i.test(String(p.clipHash))) r.push("clipHash must be the clip's SHA-256");
      if (!str("eventRef") && !(str("unitRef") && iso("recordedAt"))) r.push("either eventRef, or unitRef and recordedAt, is required");
      becomes = "video evidence pointer"; note = "A pointer with a hash, attached to the event it belongs to; viewing it needs its own permission and is logged.";
      break;
    case "generic":
      becomes = "inbound event only"; note = "Kept with its hash for a person to route; nothing is created from it.";
      break;
  }
  return { accepted: r.length === 0, refusals: r, becomes, note };
}
