/**
 * SEC-004 — webhook delivery claiming, against a real MariaDB and the real dispatcher.
 *
 * The defect: two dispatchers (the drain worker, the heartbeat retry sweep, the office's
 * manual dispatch, or two worker processes) could both compute attempt n for the same
 * (subscription, event), both POST it, and only then collide on
 * UNIQUE(subscriptionId, eventId, attempt). The consumer received two requests; the database
 * kept one row, and the loser threw. These tests pin the fix: an attempt is claimed in the
 * database before anything is sent, and only the claimant sends.
 *
 * Time: `now` is the scheduling clock the service already takes (backoff, due-ness). The
 * lease is measured on `leaseNow`, which defaults to the real clock; tests pass it explicitly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { claimIsLive, dispatchWebhooks, newClaimToken, setWebhookPoster, sweepWebhookRetries, WEBHOOK_ATTEMPT_TIMEOUT_MS, WEBHOOK_CLAIM_LEASE_MS, type Poster } from "./webhookDispatchService";
import { encryptSecret, mfaKey } from "./_core/externalIdentityPolicy";
import { MAX_ATTEMPTS } from "./_core/integrationGateway";

process.env.LEASEOS_PORTAL_MFA_KEY = "c".repeat(64);

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 8 }); });
const mySubscriptions: string[] = [];
afterEach(async () => {
  // Hygiene: a revoked subscription is never dispatched, so nothing this suite left behind can be picked up later.
  if (pool && mySubscriptions.length) await pool.query("UPDATE webhookSubscriptions SET status = 'revoked' WHERE subscriptionRef IN (?)", [mySubscriptions.splice(0)]);
});
afterAll(async () => { setWebhookPoster(defaultPosterForRestore); if (pool) await pool.end(); });

// The module's own poster, so other suites in the same worker are not left with ours.
let defaultPosterForRestore: Poster;
beforeAll(async () => { const m = await import("./webhookDispatchService"); defaultPosterForRestore = m.currentWebhookPoster?.(); });

// Both clocks sit years away from every other suite's (those run in 2026), because the gate
// runs all files at once against one database: another suite's sweep must never find this
// suite's failed rows due or its claims expired, and this suite's sweeps are tenant-scoped.
const T0 = new Date("2035-01-01T12:00:00Z");
const LEASE_T0 = new Date("2035-06-01T00:00:00Z");
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

type Seen = { url: string; body: string; headers: Record<string, string> };
/**
 * A poster that records every request and can be held open, the way a slow consumer holds a
 * real one. `seen` counts only the given events: a sweep also retries other suites' due
 * deliveries in a shared database, and those requests are not this test's business.
 */
function recordingPoster(events: string[], opts: { status?: number | ((n: number) => number); delayMs?: number } = {}) {
  const all: Seen[] = [];
  const mine = (x: Seen) => events.includes(JSON.parse(x.body).eventId);
  const poster: Poster = async (url, body, headers) => {
    const req = { url, body, headers };
    all.push(req);
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    const n = all.filter(mine).length;
    const s = typeof opts.status === "function" ? (mine(req) ? opts.status(n) : 200) : opts.status ?? 200;
    return { status: s };
  };
  return { get seen() { return all.filter(mine); }, poster };
}

async function subscriptionAndEvent(orgRef?: string) {
  const t = tag();
  const org = orgRef ?? `ORG-${t}`;
  const subscriptionRef = `WH-${t}`;
  mySubscriptions.push(subscriptionRef);
  const [s] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO webhookSubscriptions (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId) VALUES (?, ?, 'sec004', 'https://erp.example/hook', ?, '[\"sec004.*\"]', 'active', 1)",
    [org, subscriptionRef, encryptSecret("secret", mfaKey()!)]);
  const eventId = await event(org);
  return { org, subscriptionId: Number(s.insertId), subscriptionRef, eventId };
}

async function event(org: string) {
  const eventId = `EV-${tag()}`.slice(0, 40);
  await pool.execute(
    "INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt) VALUES (?, 'sec004.test', 1, 'ticket', 'T-1', ?, 'corr', 'system', '{\"n\":1}', ?, 0, ?)",
    [eventId, org, T0, T0]);
  return eventId;
}

async function rows(eventId: string) {
  const [r] = await pool.execute<mysql.RowDataPacket[]>("SELECT id, attempt, status, claimedAt, claimedBy, orgRef FROM webhookDeliveries WHERE eventId = ? ORDER BY attempt", [eventId]);
  return r;
}

/** A row exactly as a worker leaves it between claiming and finishing — i.e. after crashing there. */
async function crashedClaim(x: { org: string; subscriptionId: number; eventId: string; attempt: number; claimedAt: Date }) {
  await pool.execute(
    "INSERT INTO webhookDeliveries (orgRef, deliveryRef, subscriptionId, eventId, eventType, attempt, status, requestHash, signature, at, claimedAt, claimedBy) VALUES (?, ?, ?, ?, 'sec004.test', ?, 'queued', 'h', 's', ?, ?, 'crashed-worker#1')",
    [x.org, `DLV-${tag()}`, x.subscriptionId, x.eventId, x.attempt, T0, x.claimedAt]);
}

const after = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe("SEC-004: the lease, without a database", () => {
  it("a live worker always finishes long before its claim can expire", () => {
    // The lease is compared across processes on their own clocks; the margin is deliberate.
    expect(WEBHOOK_CLAIM_LEASE_MS).toBeGreaterThanOrEqual(10 * WEBHOOK_ATTEMPT_TIMEOUT_MS);
  });

  it("a claim is live strictly inside the lease, and a claim with no timestamp is never live", () => {
    const at = new Date("2035-06-01T00:00:00Z");
    expect(claimIsLive({ claimedAt: at }, new Date(at.getTime() + WEBHOOK_CLAIM_LEASE_MS - 1))).toBe(true);
    expect(claimIsLive({ claimedAt: at }, new Date(at.getTime() + WEBHOOK_CLAIM_LEASE_MS))).toBe(false);
    expect(claimIsLive({ claimedAt: null }, at)).toBe(false);
  });

  it("a claim token names the worker, is unique per claim, fits the column, and carries nothing secret", () => {
    const a = newClaimToken("worker-7"), b = newClaimToken("worker-7");
    expect(a).toMatch(/^worker-7#[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(newClaimToken("x".repeat(200)).length).toBeLessThanOrEqual(64);
    expect(newClaimToken()).not.toContain(process.env.LEASEOS_PORTAL_MFA_KEY!);
  });
});

d("SEC-004: only the worker that claims an attempt sends it", () => {
  it("1–4. two workers race for the same new attempt: one claims, one POST, one row, and the loser does not throw", async () => {
    const x = await subscriptionAndEvent();
    const p = recordingPoster([x.eventId], { delayMs: 150 });
    setWebhookPoster(p.poster);
    const [a, b] = await Promise.allSettled([
      dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: LEASE_T0, workerId: "worker-a" }),
      dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: LEASE_T0, workerId: "worker-b" }),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(p.seen).toHaveLength(1);
    const r = await rows(x.eventId);
    expect(r.map(y => [y.attempt, y.status])).toEqual([[1, "delivered"]]);
    // Whoever won is on the record, and the other one reports that it sent nothing.
    expect(String(r[0].claimedBy)).toMatch(/^worker-[ab]#/);
    const results = [a, b].flatMap(s => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof dispatchWebhooks>>>).value.results);
    expect(results.filter(y => y.eventId === x.eventId)).toHaveLength(1);
  });

  it("five concurrent workers still produce exactly one POST", async () => {
    const x = await subscriptionAndEvent();
    const p = recordingPoster([x.eventId], { delayMs: 100 });
    setWebhookPoster(p.poster);
    await Promise.all(Array.from({ length: 5 }, (_, i) => dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: LEASE_T0, workerId: `w${i}` })));
    expect(p.seen).toHaveLength(1);
    expect((await rows(x.eventId)).map(y => [y.attempt, y.status])).toEqual([[1, "delivered"]]);
  });

  it("5. a delivered attempt is never claimed again, alone or under a race", async () => {
    const x = await subscriptionAndEvent();
    const p = recordingPoster([x.eventId]);
    setWebhookPoster(p.poster);
    await dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: LEASE_T0 });
    await Promise.all([1, 2, 3].map(() => dispatchWebhooks({ eventIds: [x.eventId], now: after(T0, 86_400_000), leaseNow: after(LEASE_T0, 86_400_000) })));
    expect(p.seen).toHaveLength(1);
    expect((await rows(x.eventId)).map(y => [y.attempt, y.status])).toEqual([[1, "delivered"]]);
  });

  it("6–7. a retryable failure waits for its backoff, then the NEXT attempt is claimed and sent once", async () => {
    const x = await subscriptionAndEvent();
    const p = recordingPoster([x.eventId], { status: n => (n === 1 ? 503 : 200) });
    setWebhookPoster(p.poster);
    await dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: LEASE_T0 });
    expect((await rows(x.eventId)).map(y => [y.attempt, y.status])).toEqual([[1, "failed"]]);
    // Not due at +30 s (the first backoff is one minute).
    await dispatchWebhooks({ eventIds: [x.eventId], now: after(T0, 30_000), leaseNow: LEASE_T0 });
    expect(p.seen).toHaveLength(1);
    // Due at +61 s: two sweeps race; attempt 2 is sent once.
    await Promise.all([sweepWebhookRetries(after(T0, 61_000), { leaseNow: LEASE_T0, orgRef: x.org }), sweepWebhookRetries(after(T0, 61_000), { leaseNow: LEASE_T0, orgRef: x.org })]);
    expect(p.seen).toHaveLength(2);
    expect((await rows(x.eventId)).map(y => [y.attempt, y.status])).toEqual([[1, "failed"], [2, "delivered"]]);
    expect(p.seen.map(s => s.headers["x-leaseos-delivery"])).toEqual([`${x.subscriptionRef}:${x.eventId}:1`, `${x.subscriptionRef}:${x.eventId}:2`]);
  });

  it("8. a dead delivery is not resent by dispatch or by the sweep", async () => {
    const x = await subscriptionAndEvent();
    await pool.execute(
      "INSERT INTO webhookDeliveries (orgRef, deliveryRef, subscriptionId, eventId, eventType, attempt, status, requestHash, signature, at) VALUES (?, ?, ?, ?, 'sec004.test', ?, 'dead', 'h', 's', ?)",
      [x.org, `DLV-${tag()}`, x.subscriptionId, x.eventId, MAX_ATTEMPTS, T0]);
    const p = recordingPoster([x.eventId]);
    setWebhookPoster(p.poster);
    await dispatchWebhooks({ eventIds: [x.eventId], now: after(T0, 86_400_000), leaseNow: LEASE_T0 });
    await sweepWebhookRetries(after(T0, 86_400_000), { leaseNow: LEASE_T0, orgRef: x.org });
    expect(p.seen).toHaveLength(0);
  });

  it("9 & 14. a worker that crashed after claiming (before sending) is recovered once its lease expires — the same attempt is sent, once", async () => {
    const x = await subscriptionAndEvent();
    await crashedClaim({ ...x, attempt: 1, claimedAt: LEASE_T0 });
    const p = recordingPoster([x.eventId], { delayMs: 50 });
    setWebhookPoster(p.poster);
    // Two recoverers race after expiry: one reclaims, one POST.
    const expired = after(LEASE_T0, WEBHOOK_CLAIM_LEASE_MS + 1_000);
    await Promise.all([
      dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: expired, workerId: "recover-a" }),
      sweepWebhookRetries(T0, { leaseNow: expired, workerId: "recover-b", orgRef: x.org }),
    ]);
    expect(p.seen).toHaveLength(1);
    expect(p.seen[0]!.headers["x-leaseos-delivery"]).toBe(`${x.subscriptionRef}:${x.eventId}:1`);
    const r = await rows(x.eventId);
    expect(r.map(y => [y.attempt, y.status])).toEqual([[1, "delivered"]]);
    expect(String(r[0].claimedBy)).toMatch(/^recover-[ab]#/);
  });

  it("10. a live claim is not stolen — not by dispatch, the sweep, or a scheduling clock pushed into the future", async () => {
    const x = await subscriptionAndEvent();
    await crashedClaim({ ...x, attempt: 1, claimedAt: LEASE_T0 });
    const p = recordingPoster([x.eventId]);
    setWebhookPoster(p.poster);
    const stillLive = after(LEASE_T0, WEBHOOK_CLAIM_LEASE_MS - 1_000);
    await dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: stillLive });
    await sweepWebhookRetries(T0, { leaseNow: stillLive, orgRef: x.org });
    // The office procedure lets a caller supply `now`. It must not move the lease.
    await dispatchWebhooks({ eventIds: [x.eventId], now: after(T0, 10 * 365 * 86_400_000), leaseNow: stillLive });
    expect(p.seen).toHaveLength(0);
    expect((await rows(x.eventId)).map(y => [y.attempt, y.status, y.claimedBy])).toEqual([[1, "queued", "crashed-worker#1"]]);
  });

  it("11. organization A cannot claim or send organization B's delivery", async () => {
    const b = await subscriptionAndEvent();
    const orgA = `ORG-${tag()}`;
    const p = recordingPoster([b.eventId]);
    setWebhookPoster(p.poster);
    // A dispatch scoped to A, naming B's event, touches nothing.
    await dispatchWebhooks({ eventIds: [b.eventId], now: T0, leaseNow: LEASE_T0, orgRef: orgA });
    expect(p.seen).toHaveLength(0);
    expect(await rows(b.eventId)).toHaveLength(0);
    // A's subscription never receives B's event, even from an unscoped (system) dispatch.
    const a = await subscriptionAndEvent(orgA);
    await dispatchWebhooks({ eventIds: [b.eventId, a.eventId], now: T0, leaseNow: LEASE_T0 });
    const aRows = await pool.execute<mysql.RowDataPacket[]>("SELECT eventId, orgRef FROM webhookDeliveries WHERE subscriptionId = ?", [a.subscriptionId]);
    expect(aRows[0].map(r => [r.eventId, r.orgRef])).toEqual([[a.eventId, orgA]]);
    expect((await rows(b.eventId)).map(r => r.orgRef)).toEqual([b.org]);
  });

  it("12. the database still refuses a second row for the same (subscription, event, attempt)", async () => {
    const x = await subscriptionAndEvent();
    await crashedClaim({ ...x, attempt: 1, claimedAt: LEASE_T0 });
    await expect(crashedClaim({ ...x, attempt: 1, claimedAt: LEASE_T0 })).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("13. different deliveries proceed concurrently: two workers, two events, one POST each", async () => {
    const x = await subscriptionAndEvent();
    const e2 = await event(x.org);
    const p = recordingPoster([x.eventId, e2], { delayMs: 80 });
    setWebhookPoster(p.poster);
    await Promise.all([
      dispatchWebhooks({ eventIds: [x.eventId, e2], now: T0, leaseNow: LEASE_T0, workerId: "w1" }),
      dispatchWebhooks({ eventIds: [e2, x.eventId], now: T0, leaseNow: LEASE_T0, workerId: "w2" }),
    ]);
    expect(p.seen.map(s => JSON.parse(s.body).eventId).sort()).toEqual([x.eventId, e2].sort());
    expect((await rows(x.eventId)).map(y => y.status)).toEqual(["delivered"]);
    expect((await rows(e2)).map(y => y.status)).toEqual(["delivered"]);
  });

  it("15. crash AFTER the consumer received the POST but BEFORE LeaseOS recorded it: resent once, with the same delivery id — at-least-once, not exactly-once", async () => {
    const x = await subscriptionAndEvent();
    // The consumer already has attempt 1 (we cannot see that from here); the worker died before finishing.
    const consumerSaw = [`${x.subscriptionRef}:${x.eventId}:1`];
    await crashedClaim({ ...x, attempt: 1, claimedAt: LEASE_T0 });
    const p = recordingPoster([x.eventId]);
    setWebhookPoster(p.poster);
    await dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: after(LEASE_T0, WEBHOOK_CLAIM_LEASE_MS + 1) });
    consumerSaw.push(...p.seen.map(s => s.headers["x-leaseos-delivery"]!));
    // Two receipts of one attempt, identifiable as one: the consumer deduplicates on x-leaseos-delivery (or eventId).
    expect(consumerSaw).toEqual([`${x.subscriptionRef}:${x.eventId}:1`, `${x.subscriptionRef}:${x.eventId}:1`]);
  });

  it("a worker that overran its lease cannot overwrite the outcome recorded by the worker that recovered it", async () => {
    const x = await subscriptionAndEvent();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let calls = 0;
    setWebhookPoster(async (_url, body) => {
      if (JSON.parse(body).eventId !== x.eventId) return { status: 200 };
      calls++;
      if (calls === 1) { await held; return { status: 503 }; }
      return { status: 200 };
    });
    // Slow worker claims at LEASE_T0 and hangs in the POST.
    const slow = dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: LEASE_T0, workerId: "slow" });
    await new Promise(r => setTimeout(r, 100));
    // After expiry a second worker reclaims the same attempt and delivers it.
    const fast = await dispatchWebhooks({ eventIds: [x.eventId], now: T0, leaseNow: after(LEASE_T0, WEBHOOK_CLAIM_LEASE_MS + 1), workerId: "fast" });
    expect(fast.results.map(r => r.status)).toEqual(["delivered"]);
    release();
    const late = await slow;
    expect(late.results.map(r => r.status)).toEqual(["claim_lost"]);
    const r = await rows(x.eventId);
    expect(r.map(y => [y.attempt, y.status])).toEqual([[1, "delivered"]]);
    expect(String(r[0].claimedBy)).toMatch(/^fast#/);
  });
});
