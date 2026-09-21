import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { BACKOFF_MINUTES, MAX_ATTEMPTS, deliveryOutcome, intakeDecision, signPayload, subscribed, verifySignature } from "./_core/integrationGateway";
import { INTEGRATION_PROCEDURE_PERMISSIONS, INTEGRATION_SENSITIVE_PERMISSIONS } from "./_core/recordsAuthorization";
import { integrationProcedure } from "./_core/trpc";
import { setWebhookPoster } from "./integrationRouter";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

process.env.LEASEOS_PORTAL_MFA_KEY = "b".repeat(64);
const NOW = new Date("2026-09-10T12:00:00Z");

describe("a delivery is signed, replay-bounded, retried on a schedule, and dead after its attempts", () => {
  it("signs over timestamp.body and verifies within five minutes only", () => {
    const ts = Math.floor(NOW.getTime() / 1000);
    const sig = signPayload("s3cret", ts, '{"a":1}');
    expect(verifySignature("s3cret", ts, '{"a":1}', sig, NOW)).toEqual({ valid: true, reason: null });
    expect(verifySignature("s3cret", ts, '{"a":2}', sig, NOW).reason).toBe("Signature does not match");
    expect(verifySignature("other", ts, '{"a":1}', sig, NOW).valid).toBe(false);
    expect(verifySignature("s3cret", ts - 600, '{"a":1}', signPayload("s3cret", ts - 600, '{"a":1}'), NOW).reason).toContain("replay refused");
  });
  it("delivers on 2xx, schedules 1, 5, 30, 120, 720 minutes, and is dead on the sixth failure", () => {
    expect(deliveryOutcome({ attempt: 1, responseStatus: 204, error: null, at: NOW })).toMatchObject({ status: "delivered" });
    const f1 = deliveryOutcome({ attempt: 1, responseStatus: 503, error: null, at: NOW });
    expect(f1).toMatchObject({ status: "failed" });
    expect(f1.nextAttemptAt!.getTime() - NOW.getTime()).toBe(60_000);
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120, 720]);
    expect(deliveryOutcome({ attempt: 5, responseStatus: null, error: "ECONNREFUSED", at: NOW }).nextAttemptAt!.getTime() - NOW.getTime()).toBe(720 * 60_000);
    const dead = deliveryOutcome({ attempt: MAX_ATTEMPTS, responseStatus: 500, error: null, at: NOW });
    expect(dead).toMatchObject({ status: "dead", nextAttemptAt: null });
    expect(dead.reason).toContain("a person re-queues it");
  });
  it("matches exact types and dotted wildcards", () => {
    expect(subscribed(["ticket.*"], "ticket.signed")).toBe(true);
    expect(subscribed(["ticket.signed"], "ticket.signed")).toBe(true);
    expect(subscribed(["invoice.*"], "ticket.signed")).toBe(false);
    expect(subscribed(["*"], "anything")).toBe(true);
  });
});

describe("intake is by scope and shape, and what it becomes is a proposal", () => {
  it("accepts a well-formed fuel transaction as a proposal, refuses an out-of-scope feed, and names each missing field", () => {
    const ok = intakeDecision({ feed: "fuel_transaction", scopes: ["fuel_transaction"], payload: { occurredAt: "2026-09-10T09:40:00Z", quantity: 275, total: 412.5, unitRef: "142" } });
    expect(ok).toMatchObject({ accepted: true, becomes: "fuel transaction proposal" });
    expect(ok.note).toContain("needs_review");
    const bad = intakeDecision({ feed: "fuel_transaction", scopes: ["gps_position"], payload: { quantity: -1 } });
    expect(bad.refusals).toEqual(["Client is not scoped for fuel_transaction", "occurredAt is required (ISO 8601)", "quantity must be a positive number", "total must be a non-negative number", "unitRef is required"]);
    const gps = intakeDecision({ feed: "gps_position", scopes: ["gps_position"], payload: { latitude: 53.5, longitude: -113.4, recordedAt: "2026-09-10T09:40:00Z", unitRef: "142" } });
    expect(gps.note).toContain("never makes a unit WORKING by itself");
    expect(intakeDecision({ feed: "eld_duty_status", scopes: ["eld_duty_status"], payload: { dutyStatus: "napping", startedAt: "x", operatorRef: "" } }).refusals).toHaveLength(3);
  });
});

describe("the machine gate is wired like the others", () => {
  it("refuses to mount an unmapped inbound procedure and counts ingestion as sensitive", () => {
    expect(() => integrationProcedure("inbound.notAThing")).toThrow(/No integration permission mapped/);
    expect(Object.keys(INTEGRATION_PROCEDURE_PERMISSIONS).sort()).toEqual(["inbound.ingest", "inbound.me"]);
    expect(INTEGRATION_SENSITIVE_PERMISSIONS).toEqual(["inbound.ingest"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_200_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
let FIXTURE_ENTITY_ID = 1;   // P4.1: a real, unowned financial entity, created in beforeAll
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 6 });
  FIXTURE_ENTITY_ID = 5_100_000 + Math.floor(Math.random() * 90_000);
  // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
  await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [FIXTURE_ENTITY_ID, key("FE"), `entity ${FIXTURE_ENTITY_ID}`]);
});
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const machine = (k: string | null) => appRouter.createCaller({ req: { headers: k ? { "x-integration-key": k } : {} } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

/**
 * The reference an ingest returned, asserted rather than coerced.
 *
 * `resultRef` is typed `string | null | undefined` — an ingest that is rejected
 * or deduped to nothing has no reference to give. Wrapping it in `String()`
 * would satisfy the compiler and produce the literal text "null" or
 * "undefined", which is not a missing value but a perfectly ordinary string to
 * look a row up by. The lookup would then find nothing for a reason that has
 * nothing to do with the behaviour under test.
 */
function resultRef(ref: string | null | undefined): string {
  expect(ref, "an accepted ingest should have returned a resultRef").toEqual(expect.any(String));
  return ref as string;
}

d("machines, in and out", () => {
  it("registers a fuel-card feed, ingests a transaction as needs_review, dedupes by key, refuses out of scope, and is refused after revocation", async () => {
    const controller = await withRole("controller");
    const reg = await callerFor(controller).integration.clientRegister({ name: "FleetCard Co", kind: "fuel_card", scopes: ["fuel_transaction"] });
    expect(reg.key.length).toBeGreaterThan(30);
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT keyHash, scopesJson FROM integrationClients WHERE clientRef = ?", [reg.clientRef]);
    expect(row[0].keyHash).not.toContain(reg.key);
    await expect(machine(null).inbound.me()).rejects.toThrow(/No integration key/);
    await expect(machine("nope").inbound.me()).rejects.toThrow(/Unknown integration key/);
    expect(await machine(reg.key).inbound.me()).toMatchObject({ clientRef: reg.clientRef, kind: "fuel_card", scopes: ["fuel_transaction"] });

    const unitNo = key("U").slice(0, 20);
    await pool.execute("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [unitNo]);
    const r1 = await machine(reg.key).inbound.ingest({ feed: "fuel_transaction", idempotencyKey: "txn-88192", payload: { occurredAt: "2026-09-10T09:40:00Z", quantity: 275, total: 412.5, unitRef: unitNo, jurisdiction: "CA-AB", vendorName: "Cardlock Nisku", fuelType: "diesel", financialEntityId: FIXTURE_ENTITY_ID } });
    expect(r1).toMatchObject({ status: "accepted", becomes: "fuel transaction proposal" });
    const [fuel] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, jurisdiction, jurisdictionSource, payerType, hosRuleConclusion FROM fuelTransactions WHERE fuelRef = ?", [resultRef(r1.resultRef)]);
    expect(fuel[0]).toMatchObject({ status: "needs_review", jurisdiction: "CA-AB", jurisdictionSource: "fleet_card_statement", payerType: "company", hosRuleConclusion: "unknown" }); // a proposal, never confirmed
    // Same key again: the same event, and no second transaction; different content under the same key is named.
    const r2 = await machine(reg.key).inbound.ingest({ feed: "fuel_transaction", idempotencyKey: "txn-88192", payload: { occurredAt: "2026-09-10T09:40:00Z", quantity: 275, total: 412.5, unitRef: unitNo, jurisdiction: "CA-AB", vendorName: "Cardlock Nisku", fuelType: "diesel", financialEntityId: FIXTURE_ENTITY_ID } });
    expect(r2).toMatchObject({ status: "duplicate", inboundRef: r1.inboundRef, resultRef: r1.resultRef });
    const r3 = await machine(reg.key).inbound.ingest({ feed: "fuel_transaction", idempotencyKey: "txn-88192", payload: { occurredAt: "2026-09-10T09:40:00Z", quantity: 999, total: 1, unitRef: unitNo } });
    expect(r3.note).toContain("DIFFERENT content");
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM fuelTransactions WHERE fuelRef = ?", [resultRef(r1.resultRef)]);
    expect(Number(n[0].n)).toBe(1);
    // Out of scope: rejected and kept as rejected; a GPS client's position is evidence only.
    const r4 = await machine(reg.key).inbound.ingest({ feed: "gps_position", idempotencyKey: "pos-1", payload: { latitude: 53.5, longitude: -113.4, recordedAt: "2026-09-10T09:41:00Z", unitRef: unitNo } });
    expect(r4).toMatchObject({ status: "rejected" });
    if (r4.status === "rejected") expect(r4.refusals[0]).toBe("Client is not scoped for gps_position");
    const gps = await callerFor(controller).integration.clientRegister({ name: "Telematics Co", kind: "telematics", scopes: ["gps_position"] });
    const r5 = await machine(gps.key).inbound.ingest({ feed: "gps_position", idempotencyKey: "pos-1", payload: { latitude: 53.5, longitude: -113.4, recordedAt: "2026-09-10T09:41:00Z", unitRef: unitNo } });
    expect(r5).toMatchObject({ status: "accepted", becomes: "position evidence" });
    const list = await callerFor(controller).integration.inboundList({ clientRef: reg.clientRef });
    expect(list.events.map(e => e.status)).toEqual(["rejected", "accepted"]);
    // Revoked: refused by name; the audit trail holds the refusals.
    await callerFor(controller).integration.clientRevoke({ clientRef: reg.clientRef, reason: "Card program ended" });
    await expect(machine(reg.key).inbound.me()).rejects.toThrow(/revoked/);
    const [audits] = await pool.execute<mysql.RowDataPacket[]>("SELECT outcome FROM authorizationDecisions WHERE subjectType = 'integrationClient' AND subjectId = ? ORDER BY id", [reg.clientRef]);
    expect(audits.map(a => a.outcome)).toContain("allowed");
  });

  it("subscribes a webhook with a secret shown once, delivers a signed event, retries a failing endpoint on the schedule, and goes dead", async () => {
    const controller = await withRole("controller");
    await expect(callerFor(controller).integration.webhookSubscribe({ name: "x", url: "http://insecure.example/hook", eventTypes: ["*"] })).rejects.toThrow(/https only/);
    const sub = await callerFor(controller).integration.webhookSubscribe({ name: "Customer ERP", url: "https://erp.example/leaseos", eventTypes: ["test.*"] });
    expect(sub.secret.length).toBeGreaterThan(30);
    const [srow] = await pool.execute<mysql.RowDataPacket[]>("SELECT secretEnc FROM webhookSubscriptions WHERE subscriptionRef = ?", [sub.subscriptionRef]);
    expect(srow[0].secretEnc).not.toContain(sub.secret);
    const eventId = key("EV").slice(0, 40);
    await pool.execute("INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt) VALUES (?, 'test.signed', 1, 'ticket', 'FT-1', 'default', ?, 'system', ?, NOW(), 0, NOW())", [eventId, key("C").slice(0, 40), JSON.stringify({ ticketNumber: "FT-1" })]);
    // A fake endpoint that verifies the signature with the secret it was given, then starts failing.
    const seen: { body: string; headers: Record<string, string> }[] = [];
    let failing = false;
    setWebhookPoster(async (_url, body, headers) => { seen.push({ body, headers }); return failing ? { status: 503 } : { status: 200 }; });
    const t0 = new Date("2026-09-10T12:00:00Z");
    const d1 = await callerFor(controller).integration.webhookDispatch({ now: t0 });
    expect(d1.results.filter(r => r.eventId === eventId)).toEqual([{ subscriptionRef: sub.subscriptionRef, eventId, attempt: 1, status: "delivered", reason: "HTTP 200" }]);
    const got = seen[seen.length - 1]!;
    expect(verifySignature(sub.secret, Number(got.headers["x-leaseos-timestamp"]), got.body, got.headers["x-leaseos-signature"], t0).valid).toBe(true);
    expect(JSON.parse(got.body)).toMatchObject({ eventId, eventType: "test.signed", payload: { ticketNumber: "FT-1" } });
    // Delivered events are not re-sent.
    expect((await callerFor(controller).integration.webhookDispatch({ now: t0 })).results.filter(r => r.eventId === eventId)).toEqual([]);
    // A second event against a failing endpoint: attempt 1 fails, retry not due at +30s, due at +1 min, … dead at the sixth.
    failing = true;
    const ev2 = key("EV").slice(0, 40);
    await pool.execute("INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt) VALUES (?, 'test.failed', 1, 'ticket', 'FT-2', 'default', ?, 'system', '{}', NOW(), 0, NOW())", [ev2, key("C").slice(0, 40)]);
    const a1 = await callerFor(controller).integration.webhookDispatch({ now: t0 });
    expect(a1.results.find(r => r.eventId === ev2)).toMatchObject({ attempt: 1, status: "failed" });
    expect((await callerFor(controller).integration.webhookDispatch({ now: new Date(t0.getTime() + 30_000) })).results.find(r => r.eventId === ev2)).toBeUndefined();
    let t = new Date(t0.getTime() + 60_000);
    let last: { attempt: number; status: string } | undefined;
    for (let i = 0; i < 6; i++) { const r = (await callerFor(controller).integration.webhookDispatch({ now: t })).results.find(x => x.eventId === ev2); if (r) last = r; t = new Date(t.getTime() + 721 * 60_000); }
    expect(last).toMatchObject({ attempt: 6, status: "dead" });
    const dl = await callerFor(controller).integration.deliveries({ subscriptionRef: sub.subscriptionRef });
    expect(dl.deliveries.filter(x => x.eventId === ev2).map(x => [x.attempt, x.status]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[1, "failed"], [2, "failed"], [3, "failed"], [4, "failed"], [5, "failed"], [6, "dead"]]); // every attempt kept
    // Paused subscriptions are skipped; a revoked one cannot come back.
    await callerFor(controller).integration.webhookSetStatus({ subscriptionRef: sub.subscriptionRef, status: "revoked" });
    await expect(callerFor(controller).integration.webhookSetStatus({ subscriptionRef: sub.subscriptionRef, status: "active" })).rejects.toThrow(/not reactivated/);
  });
});
