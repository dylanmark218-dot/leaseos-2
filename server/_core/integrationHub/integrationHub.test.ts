/**
 * Integration Hub — the pure decisions, exercised without a database or a network.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, correlationIdFor, envelopeForInbound, inboundEventId, payloadHash } from "./envelope";
import { CONNECTOR_DEFINITIONS, connectorDefinition, validateConnectorInstance } from "./registry";
import { applyContract, contractChecksum, contractPolicyRefusal, contractToJsonSchema, DataSyncContract, idempotencyKeyFor, SHARED_CONTRACTS, sharedContract } from "./contracts";
import { afterAttempt, assessConnectorHealth, CIRCUIT_OPEN_AFTER_FAILURES, readinessVerdict, shouldAttempt } from "./health";
import { MAX_UNACKNOWLEDGED_REQUEUES, nextDeadLetterState, requeueAllowed } from "./deadLetter";
import { decideConflict } from "./conflict";
import { cursorAdvance, nextScheduledSync } from "./sync";
import { assessInbound, hmacOver, verifyInboundCredential, type InboundHeaders } from "./inboundIntake";
import { assessHubHealth, type HubMetrics } from "./metrics";

const NOW = new Date("2026-09-24T12:00:00Z");

describe("the canonical envelope", () => {
  it("derives one logical event id from tenant + connector + key, so a retry is the same event", () => {
    const a = inboundEventId({ orgRef: "ORG-A", connectorRef: "CONN-1", idempotencyKey: "evt-9" });
    expect(a).toBe(inboundEventId({ orgRef: "ORG-A", connectorRef: "CONN-1", idempotencyKey: "evt-9" }));
    expect(a).not.toBe(inboundEventId({ orgRef: "ORG-B", connectorRef: "CONN-1", idempotencyKey: "evt-9" }));   // same external id, other tenant
    expect(a).toMatch(/^IEV-[0-9a-f]{40}$/);
  });
  it("hashes canonically (key order does not matter) and carries every field the spec names", () => {
    expect(payloadHash({ b: 1, a: [{ z: 1, y: undefined }] })).toBe(payloadHash({ a: [{ z: 1 }], b: 1 }));
    const env = envelopeForInbound({ orgRef: "ORG-A", connectorRef: "CONN-1", sourceSystem: "generic_signed_webhook_source", eventType: "ticket.received", schemaVersion: "1.0", idempotencyKey: "k1", payload: { x: 1 }, receivedAt: NOW, correlationId: null });
    expect(Object.keys(env).sort()).toEqual(["connectorRef", "contentType", "correlationId", "eventId", "eventType", "idempotencyKey", "occurredAt", "orgRef", "payload", "payloadHash", "recordedAt", "schemaVersion", "sourceSystem"]);
    expect(env.correlationId).toBe(correlationIdFor(null, env.eventId));
    expect(correlationIdFor(" given ", "x")).toBe("given");
    expect(() => envelopeForInbound({ orgRef: "ORG-A", connectorRef: "C", sourceSystem: "s", eventType: "Bad Type", schemaVersion: "1.0", idempotencyKey: "k", payload: {}, receivedAt: NOW })).toThrow();
  });
  it("canonicalizes consistently, dropping undefined and sorting keys", () => {
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
    expect(canonicalJson({ b: 1, a: 1 })).toBe(canonicalJson({ a: 1, b: 1 }));
  });
});

describe("the connector registry", () => {
  it("has a typed definition per provider family and says honestly which are production-authorized", () => {
    const keys = CONNECTOR_DEFINITIONS.map(d => d.key);
    expect(keys).toEqual(expect.arrayContaining(["generic_signed_webhook_source", "generic_webhook_sink", "generic_polling_source", "alberta_511_road_conditions", "eld_provider", "telematics_provider", "fuel_card_network", "disposal_facility_system", "customer_system", "vendor_system", "accounting_system", "payroll_system", "email_sms_provider", "mapping_data_source", "document_storage_provider", "government_regulatory_feed"]));
    expect(CONNECTOR_DEFINITIONS.filter(d => d.productionAuthorized).map(d => d.key).sort()).toEqual(["generic_polling_source", "generic_signed_webhook_source", "generic_webhook_sink"]);
    const ab = connectorDefinition("alberta_511_road_conditions")!;
    expect(ab.productionAuthorized).toBe(false);
    expect(ab.externalSourceKey).toBe("ab511");
    expect(ab.boundaryNote).toMatch(/refuses to fetch/);
    expect(connectorDefinition("nope")).toBeNull();
  });
  it("refuses an unsupported auth method, secret-looking config, and a critical flag the definition does not support", () => {
    const d = connectorDefinition("generic_webhook_sink")!;
    expect(validateConnectorInstance({ definition: d, authMethod: "mutual_tls", config: {}, critical: false })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/does not support mutual_tls/)] });
    expect(validateConnectorInstance({ definition: d, authMethod: "hmac_shared_secret", config: { labels: { apiKey: "abc" } }, critical: false })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/looks like secret material/)] });
    expect(validateConnectorInstance({ definition: d, authMethod: "hmac_shared_secret", config: {}, critical: true })).toMatchObject({ ok: false });
    expect(validateConnectorInstance({ definition: connectorDefinition("accounting_system")!, authMethod: "api_key", config: { baseUrl: "https://erp.example" }, critical: true })).toMatchObject({ ok: true });
    expect(validateConnectorInstance({ definition: d, authMethod: "hmac_shared_secret", config: { unknown: 1 }, critical: false })).toMatchObject({ ok: false });
  });
});

describe("versioned declarative contracts", () => {
  const c = sharedContract("generic.observation")!;
  it("maps, normalizes and validates, and names every reason on refusal instead of trimming to fit", () => {
    const ok = applyContract(c, { id: 42, type: " ticket.received ", occurredAt: "2026-09-24T10:00:00Z", data: { a: 1 } });
    expect(ok).toMatchObject({ ok: true, externalId: "42", mapped: { externalId: "42", kind: "ticket.received", occurredAt: "2026-09-24T10:00:00.000Z", data: { a: 1 } }, tombstone: false });
    const bad = applyContract(c, { type: 5, occurredAt: "yesterday", deleted: true });
    expect(bad).toMatchObject({ ok: false, externalId: null });
    if (!bad.ok) expect(bad.reasons).toEqual(["id is required for idempotency", "deletions are not accepted by contract generic.observation v1", "id is required", "type: expected a string", "occurredAt: expected an ISO 8601 date-time"]);
    expect(applyContract(c, [1, 2])).toMatchObject({ ok: false, reasons: ["record must be a JSON object"] });
    expect(applyContract(c, { id: "1", type: "x" }, { schemaVersion: "2.0" })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/schema version 2.0/)] });
    if (ok.ok) expect(idempotencyKeyFor(c, ok, {})).toBe("42");
  });
  it("applies the closed transform set and the validation rules", () => {
    const t = DataSyncContract.parse({ ...c, contractKey: "t", fields: [
      { source: "n", target: "cents", required: true, transform: "cents_from_decimal" },
      { source: "e", target: "when", required: true, transform: "epoch_seconds_to_iso" },
      { source: "s", target: "status", required: true, transform: "enum_map", enumMap: { A: "active" } },
      { source: "q", target: "qty", required: false, transform: "number", validation: { min: 0, max: 10 } },
      { source: "u", target: "unit", required: false, transform: "upper", validation: { pattern: "^[A-Z]{1,3}$" } },
      { source: "b", target: "flag", required: false, transform: "boolean" },
    ], idempotencyStrategy: "external_id_and_revision" });
    const r = applyContract(t, { id: "7", revision: "3", n: "12.345", e: 1_700_000_000, s: "A", q: 5, u: "kg", b: "true" });
    expect(r).toMatchObject({ ok: true, mapped: { cents: 1235, when: "2023-11-14T22:13:20.000Z", status: "active", qty: 5, unit: "KG", flag: true }, revision: "3" });
    if (r.ok) expect(idempotencyKeyFor(t, r, {})).toBe("7@3");
    const r2 = applyContract(t, { id: "7", n: "x", e: -1, s: "Z", q: 11, u: "kilograms", b: "maybe" });
    if (!r2.ok) expect(r2.reasons).toEqual(["n: expected a decimal amount", "e: expected epoch seconds", 's: value "Z" is not in the contract\'s enum map', "q: above 10", "u: does not match ^[A-Z]{1,3}$", "b: expected a boolean"]);
  });
  it("fails closed for safety/billing/dispatch entities with external ownership and a permissive policy, and renders JSON Schema", () => {
    expect(contractPolicyRefusal({ ...c, destinationEntity: "billing_invoice", conflictPolicy: "source_wins" })).toMatch(/must be reject_review or manual/);
    expect(contractPolicyRefusal({ ...c, destinationEntity: "billing_invoice", conflictPolicy: "source_wins", dataOwnership: "leaseos" })).toBeNull();
    expect(contractPolicyRefusal(c)).toBeNull();
    const js = contractToJsonSchema(c);
    expect(js).toMatchObject({ $id: "leaseos:contract:generic.observation:v1", required: ["externalId", "kind"], properties: { externalId: { type: "string" } } });
    expect(contractChecksum(c)).toHaveLength(64);
    expect(SHARED_CONTRACTS.map(s => s.contractKey)).toEqual(["generic.observation", "alberta511.road_advisory"]);
    expect(sharedContract("alberta511.road_advisory")!.conflictPolicy).toBe("source_wins");
    expect(sharedContract("nope")).toBeNull();
  });
});

describe("connector health and the circuit breaker", () => {
  it("derives every state from evidence and opens the circuit after a run of failures", () => {
    const base = { status: "active" as const, consecutiveFailures: 0, lastSuccessAt: NOW, lastFailureClass: null, circuitOpenUntil: null, openDeadLetters: 0, now: NOW };
    expect(assessConnectorHealth(base).state).toBe("healthy");
    expect(assessConnectorHealth({ ...base, status: "disabled" }).state).toBe("disabled");
    expect(assessConnectorHealth({ ...base, status: "suspended" }).state).toBe("suspended");
    expect(assessConnectorHealth({ ...base, lastFailureClass: "authentication_or_configuration" }).state).toBe("authentication_required");
    expect(assessConnectorHealth({ ...base, openDeadLetters: 2 }).state).toBe("dead_letter_backlog");
    expect(assessConnectorHealth({ ...base, consecutiveFailures: 1, lastFailureClass: "rate_limited" }).state).toBe("rate_limited");
    expect(assessConnectorHealth({ ...base, consecutiveFailures: 2, lastFailureClass: "retryable_failure" }).state).toBe("degraded");
    expect(assessConnectorHealth({ ...base, lastSuccessAt: null }).state).toBe("unknown");
    expect(assessConnectorHealth({ ...base, freshnessSeconds: 60, lastSyncAt: new Date(NOW.getTime() - 3600_000) }).state).toBe("degraded");
    let c = { consecutiveFailures: 0, circuitOpenUntil: null as Date | null };
    for (let i = 0; i < CIRCUIT_OPEN_AFTER_FAILURES; i++) c = afterAttempt(c, "failure", NOW);
    expect(c.circuitOpenUntil!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(assessConnectorHealth({ ...base, ...c, lastFailureClass: "retryable_failure" }).state).toBe("failing");
    expect(shouldAttempt({ status: "active", circuitOpenUntil: c.circuitOpenUntil, now: NOW })).toMatchObject({ attempt: false, terminal: false });
    expect(shouldAttempt({ status: "active", circuitOpenUntil: c.circuitOpenUntil, now: new Date(NOW.getTime() + 6 * 60_000) })).toEqual({ attempt: true });
    expect(shouldAttempt({ status: "revoked", circuitOpenUntil: null, now: NOW })).toMatchObject({ attempt: false, terminal: true });
    expect(afterAttempt(c, "success", NOW)).toEqual({ consecutiveFailures: 0, circuitOpenUntil: null });
  });
  it("speaks to readiness only for critical connectors and never rounds unknown up to PASS", () => {
    expect(readinessVerdict("healthy", false)).toBe("NOT_EVALUATED");
    expect(readinessVerdict("healthy", true)).toBe("PASS");
    expect(readinessVerdict("unknown", true)).toBe("UNKNOWN");
    expect(readinessVerdict("failing", true)).toBe("BLOCKED");
    expect(readinessVerdict("degraded", true)).toBe("REVIEW");
  });
});

describe("dead letters move only when a person moves them", () => {
  it("follows the transition table and caps unacknowledged requeues", () => {
    expect(nextDeadLetterState("open", "requeued")).toEqual({ ok: true, to: "requeued" });
    expect(nextDeadLetterState("resolved", "requeued")).toMatchObject({ ok: false });
    expect(nextDeadLetterState("cancelled", "reopened")).toEqual({ ok: true, to: "open" });
    expect(nextDeadLetterState("requeued", "acknowledged")).toMatchObject({ ok: false });
    expect(requeueAllowed({ state: "open", requeueCount: MAX_UNACKNOWLEDGED_REQUEUES, acknowledgedAt: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/acknowledge/) });
    expect(requeueAllowed({ state: "acknowledged", requeueCount: MAX_UNACKNOWLEDGED_REQUEUES, acknowledgedAt: NOW })).toEqual({ ok: true });
  });
});

describe("conflicts", () => {
  const src = { value: { a: 1 }, revisedAt: new Date(NOW.getTime() + 1000) }, mine = { value: { a: 0 }, revisedAt: NOW };
  it("applies only safe policies, holds fail-closed entities for review, and needs both times for newest-wins", () => {
    expect(decideConflict({ policy: "source_wins", entityType: "road_advisory", dataOwnership: "external", source: src, leaseos: mine })).toMatchObject({ decision: "source_applied", applied: { a: 1 } });
    expect(decideConflict({ policy: "leaseos_wins", entityType: "road_advisory", dataOwnership: "external", source: src, leaseos: mine })).toMatchObject({ decision: "leaseos_kept" });
    expect(decideConflict({ policy: "newest_wins", entityType: "road_advisory", dataOwnership: "shared", source: src, leaseos: mine })).toMatchObject({ decision: "newest_applied", applied: { a: 1 } });
    expect(decideConflict({ policy: "newest_wins", entityType: "road_advisory", dataOwnership: "shared", source: { ...src, revisedAt: null }, leaseos: mine })).toMatchObject({ decision: "pending" });
    expect(decideConflict({ policy: "source_wins", entityType: "dispatch_assignment", dataOwnership: "external", source: src, leaseos: mine })).toMatchObject({ decision: "pending", applied: { a: 0 }, reason: expect.stringMatching(/fail-closed/) });
    expect(decideConflict({ policy: "manual", entityType: "x", dataOwnership: "external", source: src, leaseos: mine })).toMatchObject({ decision: "pending" });
  });
});

describe("sync planning", () => {
  it("never advances a cursor past uncommitted work", () => {
    expect(cursorAdvance({ committed: "a", candidate: "b", pageCommitted: false })).toMatchObject({ advance: false });
    expect(cursorAdvance({ committed: "a", candidate: "a", pageCommitted: true })).toMatchObject({ advance: false, reason: "cursor unchanged" });
    expect(cursorAdvance({ committed: "a", candidate: null, pageCommitted: true })).toMatchObject({ advance: false });
    expect(cursorAdvance({ committed: "a", candidate: "b", pageCommitted: true })).toMatchObject({ advance: true });
    expect(nextScheduledSync(NOW, 60)!.getTime()).toBe(NOW.getTime() + 60_000);
    expect(nextScheduledSync(NOW, null)).toBeNull();
  });
});

describe("inbound intake", () => {
  const connector = { status: "active", authMethod: "hmac_shared_secret", maxPayloadBytes: 1024, inboundEventTypes: ["ticket.*"], contentTypes: ["application/json"], schemaVersions: ["1.0"] };
  const secret = "s3cret-s3cret";
  const ts = String(Math.floor(NOW.getTime() / 1000));
  const body = '{"id":"T-1"}';
  const good: InboundHeaders = { signature: hmacOver(secret, ts, body), timestamp: ts, contentType: "application/json", eventType: "ticket.received", idempotencyKey: "T-1" };
  const creds = [{ kind: "hmac_secret" as const, secret, status: "active" as const, retiringUntil: null }];
  it("accepts a valid signed event and refuses each named failure", () => {
    expect(assessInbound({ connector, headers: good, body, credentials: creds, now: NOW })).toMatchObject({ accepted: true, eventType: "ticket.received", idempotencyKey: "T-1", schemaVersion: "1.0" });
    const refuse = (h: InboundHeaders, patch: Partial<typeof connector> = {}, b = body) => { const r = assessInbound({ connector: { ...connector, ...patch }, headers: { ...good, ...h }, body: b, credentials: creds, now: NOW }); return r.accepted ? "accepted" : r.code; };
    expect(refuse({ signature: "0".repeat(64) })).toBe("signature_mismatch");
    expect(refuse({}, {}, '{"id":"T-2"}')).toBe("signature_mismatch");                                        // tampered body
    expect(refuse({ timestamp: String(Number(ts) - 600), signature: hmacOver(secret, String(Number(ts) - 600), body) })).toBe("timestamp_outside_tolerance");
    expect(refuse({}, { status: "suspended" })).toBe("connector_not_active");
    expect(refuse({}, { maxPayloadBytes: 5 })).toBe("payload_too_large");
    expect(refuse({ contentType: "text/xml" })).toBe("unsupported_content_type");
    expect(refuse({ schemaVersion: "9.9" })).toBe("unknown_schema_version");
    expect(refuse({ eventType: "invoice.paid" })).toBe("unsupported_event_type");
    expect(refuse({ eventType: "Ticket Received" })).toBe("unsupported_event_type");
    expect(refuse({ idempotencyKey: "" })).toBe("missing_idempotency_key");
    expect(assessInbound({ connector, headers: { ...good, signature: hmacOver(secret, ts, "{bad") }, body: "{bad", credentials: creds, now: NOW })).toMatchObject({ accepted: false, code: "malformed_payload" });
    expect(assessInbound({ connector: null, headers: good, body, credentials: creds, now: NOW })).toMatchObject({ accepted: false, code: "unknown_connector", recordable: false });
    expect(assessInbound({ connector, headers: good, body, credentials: [], now: NOW })).toMatchObject({ accepted: false, code: "no_credential" });
  });
  it("verifies a retiring secret inside its grace and not after, and an API key by hash", () => {
    const retiring = [{ kind: "hmac_secret" as const, secret, status: "retiring" as const, retiringUntil: new Date(NOW.getTime() + 60_000) }];
    expect(verifyInboundCredential({ authMethod: "hmac_shared_secret", headers: good, body, credentials: retiring, now: NOW })).toMatchObject({ ok: true });
    expect(verifyInboundCredential({ authMethod: "hmac_shared_secret", headers: good, body, credentials: retiring, now: new Date(NOW.getTime() + 120_000) })).toMatchObject({ ok: false, code: "no_credential" });
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const keyCreds = [{ kind: "api_key" as const, secret: createHash("sha256").update("the-key").digest("hex"), status: "active" as const, retiringUntil: null }];
    expect(verifyInboundCredential({ authMethod: "api_key", headers: { apiKey: "the-key" }, body, credentials: keyCreds, now: NOW })).toMatchObject({ ok: true });
    expect(verifyInboundCredential({ authMethod: "api_key", headers: { apiKey: "wrong" }, body, credentials: keyCreds, now: NOW })).toMatchObject({ ok: false, code: "invalid_credential" });
    expect(verifyInboundCredential({ authMethod: "oidc", headers: good, body, credentials: creds, now: NOW })).toMatchObject({ ok: false });
  });
});

describe("hub metrics → one health line", () => {
  const m: HubMetrics = { at: NOW, outbox: { queueDepth: 0, oldestQueuedAgeSeconds: null, deadLettered: 0 }, deliveries: { queued: 0, retryBacklog: 0, attempted24h: 0, succeeded24h: 0, failed24h: 0, dead: 0, oldestQueuedAgeSeconds: null }, deadLetters: { open: 0, oldestOpenAgeSeconds: null }, connectors: {}, sync: { pending: 0, running: 0, failed24h: 0, staleConnectors: 0 }, inbound: { accepted24h: 0, rejected24h: 0, quarantined24h: 0, authFailures24h: 0, schemaFailures24h: 0 }, rateLimitEvents24h: 0, workerHeartbeatAgeSeconds: 5, perTenantFailures24h: {} };
  it("degrades on dead letters or failing connectors or a stale heartbeat, lags on age, and is otherwise current", () => {
    expect(assessHubHealth(m)).toMatchObject({ state: "healthy" });
    expect(assessHubHealth({ ...m, deadLetters: { open: 1, oldestOpenAgeSeconds: 10 } })).toMatchObject({ state: "degraded" });
    expect(assessHubHealth({ ...m, connectors: { failing: 1 } })).toMatchObject({ state: "degraded" });
    expect(assessHubHealth({ ...m, workerHeartbeatAgeSeconds: 900 })).toMatchObject({ state: "degraded" });
    expect(assessHubHealth({ ...m, deliveries: { ...m.deliveries, oldestQueuedAgeSeconds: 900 } })).toMatchObject({ state: "lagging" });
    expect(assessHubHealth({ ...m, sync: { ...m.sync, staleConnectors: 1 } })).toMatchObject({ state: "lagging" });
  });
});
