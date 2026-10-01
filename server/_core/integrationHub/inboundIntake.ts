/**
 * Integration Hub — the pure part of accepting an inbound event.
 *
 * Everything that can be refused before a row is written is refused here, with
 * a named reason: an unknown or stopped connector, a credential that does not
 * verify, a stale or future timestamp, an oversized body, an unsupported
 * content type, an unknown schema version, an unsupported event type, a body
 * that is not JSON. The tenant is the connector's; the request never says
 * whose data it is.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "./envelope";

export const INBOUND_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type InboundRefusalCode =
  | "unknown_connector" | "connector_not_active" | "no_credential" | "invalid_credential" | "signature_mismatch"
  | "timestamp_outside_tolerance" | "payload_too_large" | "unsupported_content_type" | "unknown_schema_version"
  | "unsupported_event_type" | "malformed_payload" | "missing_idempotency_key" | "wrong_scope";

export type InboundHeaders = { signature?: string | null; timestamp?: string | null; apiKey?: string | null; contentType?: string | null; schemaVersion?: string | null; eventType?: string | null; idempotencyKey?: string | null; correlationId?: string | null; contentLength?: number | null };

export type CredentialForVerify = { kind: "hmac_secret" | "api_key"; secret: string; status: "active" | "retiring"; retiringUntil: Date | null };

export type IntakeVerdict =
  | { accepted: true; payload: unknown; idempotencyKey: string; eventType: string; schemaVersion: string; contentType: string; credentialUsed: number }
  | { accepted: false; code: InboundRefusalCode; reason: string; recordable: boolean };

export function hmacOver(secret: string, timestamp: string, body: string): string { return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"); }
function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** The verify step alone, so rotation (active + retiring) is one rule in one place. */
export function verifyInboundCredential(args: { authMethod: string; headers: InboundHeaders; body: string; credentials: CredentialForVerify[]; now: Date }): { ok: true; credentialIndex: number } | { ok: false; code: InboundRefusalCode; reason: string } {
  const live = args.credentials.filter(c => c.status === "active" || (c.status === "retiring" && c.retiringUntil && c.retiringUntil.getTime() > args.now.getTime()));
  if (!live.length) return { ok: false, code: "no_credential", reason: "the connector has no live inbound credential" };
  if (args.authMethod === "hmac_shared_secret") {
    const ts = args.headers.timestamp?.trim(); const sig = args.headers.signature?.trim();
    if (!ts || !sig) return { ok: false, code: "invalid_credential", reason: "x-leaseos-timestamp and x-leaseos-signature are required" };
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(args.now.getTime() / 1000 - tsNum) > INBOUND_TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, code: "timestamp_outside_tolerance", reason: `timestamp outside ±${INBOUND_TIMESTAMP_TOLERANCE_SECONDS}s — replay refused` };
    for (let i = 0; i < live.length; i++) {
      const c = live[i]!; if (c.kind !== "hmac_secret") continue;
      if (safeEqualHex(sig.toLowerCase(), hmacOver(c.secret, ts, args.body))) return { ok: true, credentialIndex: args.credentials.indexOf(c) };
    }
    return { ok: false, code: "signature_mismatch", reason: "signature does not match any live secret" };
  }
  if (args.authMethod === "api_key") {
    const key = args.headers.apiKey?.trim();
    if (!key) return { ok: false, code: "invalid_credential", reason: "no API key presented" };
    const h = sha256(key);
    for (let i = 0; i < live.length; i++) { const c = live[i]!; if (c.kind === "api_key" && safeEqualHex(h, c.secret)) return { ok: true, credentialIndex: args.credentials.indexOf(c) }; }
    return { ok: false, code: "invalid_credential", reason: "unknown API key" };
  }
  return { ok: false, code: "invalid_credential", reason: `inbound authentication method ${args.authMethod} is not accepted at this edge` };
}

export function assessInbound(args: {
  connector: { status: string; authMethod: string; maxPayloadBytes: number; inboundEventTypes: readonly string[]; contentTypes: readonly string[]; schemaVersions: readonly string[] } | null;
  headers: InboundHeaders; body: string; credentials: CredentialForVerify[]; now: Date;
}): IntakeVerdict {
  const c = args.connector;
  if (!c) return { accepted: false, code: "unknown_connector", reason: "unknown connector", recordable: false };
  if (c.status !== "active") return { accepted: false, code: "connector_not_active", reason: `connector is ${c.status}`, recordable: false };
  const bytes = Buffer.byteLength(args.body);
  if (bytes > c.maxPayloadBytes || (args.headers.contentLength ?? 0) > c.maxPayloadBytes) return { accepted: false, code: "payload_too_large", reason: `payload ${bytes} bytes exceeds the connector's ${c.maxPayloadBytes}`, recordable: false };
  const v = verifyInboundCredential({ authMethod: c.authMethod, headers: args.headers, body: args.body, credentials: args.credentials, now: args.now });
  if (!v.ok) return { accepted: false, code: v.code, reason: v.reason, recordable: false };
  const contentType = (args.headers.contentType ?? "").split(";")[0]!.trim().toLowerCase() || "application/json";
  if (!c.contentTypes.includes(contentType)) return { accepted: false, code: "unsupported_content_type", reason: `content type ${contentType} is not accepted (${c.contentTypes.join(", ")})`, recordable: true };
  const schemaVersion = (args.headers.schemaVersion ?? "").trim() || c.schemaVersions[0] || "1.0";
  if (!c.schemaVersions.includes(schemaVersion)) return { accepted: false, code: "unknown_schema_version", reason: `schema version ${schemaVersion} is unknown (${c.schemaVersions.join(", ")})`, recordable: true };
  const eventType = (args.headers.eventType ?? "").trim();
  if (!eventType || !/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(eventType)) return { accepted: false, code: "unsupported_event_type", reason: "x-leaseos-event is required and must be a dotted lower-case name", recordable: true };
  if (!c.inboundEventTypes.some(t => t === "*" || t === eventType || (t.endsWith(".*") && eventType.startsWith(t.slice(0, -1))))) return { accepted: false, code: "unsupported_event_type", reason: `event type ${eventType} is not one this connector declares`, recordable: true };
  const idempotencyKey = (args.headers.idempotencyKey ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 120) return { accepted: false, code: "missing_idempotency_key", reason: "x-idempotency-key is required (1–120 characters)", recordable: true };
  let payload: unknown;
  try { payload = JSON.parse(args.body); } catch { return { accepted: false, code: "malformed_payload", reason: "body is not valid JSON", recordable: true }; }
  if (payload == null || typeof payload !== "object") return { accepted: false, code: "malformed_payload", reason: "body must be a JSON object or array", recordable: true };
  return { accepted: true, payload, idempotencyKey, eventType, schemaVersion, contentType, credentialUsed: v.credentialIndex };
}
