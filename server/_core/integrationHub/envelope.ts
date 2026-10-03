/**
 * Integration Hub — the canonical event envelope.
 *
 * One shape for every event that crosses the Hub, inbound or outbound. The two properties that
 * matter most are the ones a retry cannot change: the logical event identity and the idempotency
 * key are DERIVED from what the event is (tenant, connector, external key), never from when it was
 * attempted. A delivery retried six times is one event with six attempts, not six events.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const ENVELOPE_SCHEMA_VERSION = "1.0";

/** JSON with keys sorted at every level and `undefined` dropped, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export function payloadHash(payload: unknown): string { return sha256(typeof payload === "string" ? payload : canonicalJson(payload)); }

/** The logical event id for something received from outside: tenant + connector + the sender's own key. */
export function inboundEventId(args: { orgRef: string; connectorRef: string; idempotencyKey: string }): string {
  return `IEV-${sha256(`${args.orgRef}\u0000${args.connectorRef}\u0000${args.idempotencyKey}`).slice(0, 40)}`;
}
/** A correlation id is inherited when present and minted otherwise; it is never regenerated on retry. */
export function correlationIdFor(existing: string | null | undefined, seed: string): string {
  return existing && existing.trim() ? existing.trim().slice(0, 64) : `COR-${sha256(seed).slice(0, 32)}`;
}

export const IntegrationEnvelope = z.object({
  eventId: z.string().min(1).max(64),
  eventType: z.string().min(1).max(80).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "dotted lower-case namespaces"),
  schemaVersion: z.string().min(1).max(20),
  orgRef: z.string().min(1).max(64),
  connectorRef: z.string().min(1).max(64),
  sourceSystem: z.string().min(1).max(80),
  occurredAt: z.string().datetime({ offset: true }),
  recordedAt: z.string().datetime({ offset: true }),
  correlationId: z.string().min(1).max(64),
  idempotencyKey: z.string().min(1).max(120),
  contentType: z.string().min(1).max(80),
  payloadHash: z.string().length(64),
  payload: z.unknown(),
}).strict();
export type IntegrationEnvelope = z.infer<typeof IntegrationEnvelope>;

/** Build an envelope for an event received through a connector. Deterministic for the same input. */
export function envelopeForInbound(args: {
  orgRef: string; connectorRef: string; sourceSystem: string; eventType: string; schemaVersion: string;
  idempotencyKey: string; payload: unknown; contentType?: string; occurredAt?: Date | null; receivedAt: Date;
  correlationId?: string | null;
}): IntegrationEnvelope {
  const eventId = inboundEventId(args);
  return IntegrationEnvelope.parse({
    eventId, eventType: args.eventType, schemaVersion: args.schemaVersion, orgRef: args.orgRef, connectorRef: args.connectorRef,
    sourceSystem: args.sourceSystem, occurredAt: (args.occurredAt ?? args.receivedAt).toISOString(), recordedAt: args.receivedAt.toISOString(),
    correlationId: correlationIdFor(args.correlationId, eventId), idempotencyKey: args.idempotencyKey,
    contentType: args.contentType ?? "application/json", payloadHash: payloadHash(args.payload), payload: args.payload,
  });
}
