/**
 * B1 — tenant-first webhook dispatch, against a real MariaDB and the real dispatcher.
 *
 * THE INVARIANT: filter by tenant, THEN touch anything belonging to a subscription. Dispatching
 * tenant A's event must never resolve tenant B's signing secret, and nothing about tenant B's
 * subscription rows — a secret that will not resolve, an event-type list that will not parse — may
 * decide whether tenant A's event goes out.
 *
 * SEC-004 already made secret resolution lazy, so "never resolve a foreign secret" held on main;
 * W1–W3 and W5–W7 pin it so it cannot quietly regress. What did NOT hold is the rest of the
 * sentence: the dispatcher still SELECTed every active subscription in the table and parsed each
 * one's `eventTypesJson` before the per-event tenant check, so one foreign row with a damaged
 * event-type list aborted dispatch for every organization (W4), and a mixed-tenant batch — which
 * the retry sweep legitimately builds — let one tenant's damaged row stop the other's (W8).
 *
 * How "never resolved" is observed: the signing-secret resolver is wrapped (behaviour unchanged)
 * and every subscription it is asked about is recorded. How "never even read" is observed: a
 * damaged row the dispatcher reads is reported by name on `console.warn`, so a foreign damaged row
 * that produces no warning was never looked at.
 *
 * Hygiene: the gate runs every file against one database, and a damaged ACTIVE subscription would
 * be read by any unscoped dispatcher in another suite. Every row this file creates is revoked after
 * each test, and each test uses tenants of its own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { dispatchWebhooks, setWebhookPoster, currentWebhookPoster, type Poster } from "./webhookDispatchService";
import { encryptSecret, mfaKey } from "./_core/externalIdentityPolicy";
import { resolveWebhookSigningSecret } from "./webhookSecretService";

vi.mock("./webhookSecretService", async importOriginal => {
  const m = await importOriginal<typeof import("./webhookSecretService")>();
  return { ...m, resolveWebhookSigningSecret: vi.fn(m.resolveWebhookSigningSecret) };
});

process.env.LEASEOS_PORTAL_MFA_KEY = "b".repeat(64);

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let restorePoster: Poster;
const mine: string[] = [];

beforeAll(() => {
  if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  restorePoster = currentWebhookPoster();
});
afterEach(async () => {
  vi.mocked(resolveWebhookSigningSecret).mockClear();
  vi.restoreAllMocks();
  if (pool && mine.length) await pool.query("UPDATE webhookSubscriptions SET status = 'revoked' WHERE subscriptionRef IN (?)", [mine.splice(0)]);
});
afterAll(async () => {
  setWebhookPoster(restorePoster);
  await pool?.end();
});

describe("tenant-first webhook dispatch — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set").toBeTruthy();
  });
});

const RUN = randomBytes(4).toString("hex").toUpperCase();
let seq = 0;
const tenant = () => `TI-${RUN}-${++seq}`;
// A clock years from every other suite's, so no other suite's sweep finds this file's rows due.
const NOW = new Date("2036-03-01T12:00:00Z");

type Sub = { ref: string; url: string; orgRef: string | null };
async function subscription(orgRef: string | null, opts: { secret?: "good" | "unreadable"; eventTypesJson?: string } = {}): Promise<Sub> {
  const ref = `WH-TI-${RUN}-${++seq}`;
  const url = `https://${ref.toLowerCase()}.receiver.test/hook`;
  const secretEnc = opts.secret === "unreadable" ? "not-a-ciphertext" : encryptSecret(`secret-${ref}`, mfaKey()!);
  mine.push(ref);
  await pool.execute(
    "INSERT INTO webhookSubscriptions (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId) VALUES (?, ?, 'b1', ?, ?, ?, 'active', 1)",
    [orgRef, ref, url, secretEnc, opts.eventTypesJson ?? '["b1.*"]']
  );
  return { ref, url, orgRef };
}

async function event(tenantId: string) {
  const eventId = `EV-TI-${RUN}-${++seq}`;
  await pool.execute(
    "INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt) VALUES (?, 'b1.test', 1, 'test', '1', ?, 'corr', 'system', '{}', ?, 0, ?)",
    [eventId, tenantId, NOW, NOW]
  );
  return eventId;
}

/** Every (subscriptionRef, eventId) pair the dispatcher actually put on the wire. */
function wire() {
  const sent: { ref: string; eventId: string; url: string }[] = [];
  setWebhookPoster(async (url, body, headers) => {
    sent.push({ ref: headers["x-leaseos-delivery"]!.split(":")[0]!, eventId: JSON.parse(body).eventId, url });
    return { status: 200 };
  });
  return sent;
}

/** Which subscriptions the signing-secret resolver was asked about. */
const resolvedRefs = () => vi.mocked(resolveWebhookSigningSecret).mock.calls.map(([row]) => (row as unknown as { subscriptionRef: string }).subscriptionRef);

/** Which of the given subscriptions the dispatcher named in a warning. */
function warnings() {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return (refs: string[]) => spy.mock.calls.map(c => String(c[0])).filter(m => refs.some(r => m.includes(r)));
}

d("B1 — a subscription is only ever touched for its own tenant's events", () => {
  it("W1. dispatching tenant A's event never resolves tenant B's secret", async () => {
    const [A, B] = [tenant(), tenant()];
    const a = await subscription(A);
    const b = await subscription(B);
    const ev = await event(A);
    const sent = wire();

    await dispatchWebhooks({ eventIds: [ev], now: NOW });

    expect(sent).toEqual([{ ref: a.ref, eventId: ev, url: a.url }]);
    expect(resolvedRefs()).toEqual([a.ref]);
    expect(resolvedRefs()).not.toContain(b.ref);
  });

  it("W2. and the reciprocal: tenant B's event never resolves tenant A's secret", async () => {
    const [A, B] = [tenant(), tenant()];
    const a = await subscription(A);
    const b = await subscription(B);
    const ev = await event(B);
    const sent = wire();

    await dispatchWebhooks({ eventIds: [ev], now: NOW });

    expect(sent).toEqual([{ ref: b.ref, eventId: ev, url: b.url }]);
    expect(resolvedRefs()).toEqual([b.ref]);
    expect(resolvedRefs()).not.toContain(a.ref);
  });

  it("W3. a mixed-tenant batch sends each event only to its own tenant's subscriptions", async () => {
    const [A, B] = [tenant(), tenant()];
    const a = await subscription(A);
    const b = await subscription(B);
    const evA = await event(A);
    const evB = await event(B);
    const sent = wire();

    await dispatchWebhooks({ eventIds: [evA, evB], now: NOW });

    expect(sent.map(s => `${s.ref}>${s.eventId}`).sort()).toEqual([`${a.ref}>${evA}`, `${b.ref}>${evB}`].sort());
    expect(resolvedRefs().sort()).toEqual([a.ref, b.ref].sort());
  });

  it("W4. a foreign subscription with damaged configuration is never read, so it cannot stop tenant A", async () => {
    const [A, B] = [tenant(), tenant()];
    const a = await subscription(A);
    const b = await subscription(B, { secret: "unreadable", eventTypesJson: "{not json" });
    const ev = await event(A);
    const sent = wire();
    const warned = warnings();

    const r = await dispatchWebhooks({ eventIds: [ev], now: NOW });

    expect(sent).toEqual([{ ref: a.ref, eventId: ev, url: a.url }]);
    expect(r.results.map(x => [x.subscriptionRef, x.status])).toEqual([[a.ref, "delivered"]]);
    expect(resolvedRefs()).not.toContain(b.ref);
    // Not merely tolerated: never looked at. A row the dispatcher reads and cannot use is named in a warning.
    expect(warned([b.ref])).toEqual([]);
  });

  it("W5. a tenant with no subscriptions resolves nothing and sends nothing", async () => {
    const [A, C] = [tenant(), tenant()];
    const a = await subscription(A);
    const ev = await event(C);
    const sent = wire();

    const r = await dispatchWebhooks({ eventIds: [ev], now: NOW });

    expect(r).toEqual({ attempted: 0, results: [], skipped: null });
    expect(sent).toEqual([]);
    expect(resolvedRefs()).not.toContain(a.ref);
  });

  it("W6. an explicit orgRef narrows the batch; it never widens it", async () => {
    const [A, B] = [tenant(), tenant()];
    const a = await subscription(A);
    const b = await subscription(B);
    const evA = await event(A);
    const evB = await event(B);
    const sent = wire();

    await dispatchWebhooks({ eventIds: [evA, evB], now: NOW, orgRef: A });
    expect(sent).toEqual([{ ref: a.ref, eventId: evA, url: a.url }]);
    expect(resolvedRefs()).toEqual([a.ref]);

    // An orgRef that owns none of the events selects nothing at all — not its own subscriptions, not anyone's.
    const C = tenant();
    const c = await subscription(C);
    vi.mocked(resolveWebhookSigningSecret).mockClear();
    const r = await dispatchWebhooks({ eventIds: [evB], now: NOW, orgRef: C });
    expect(r).toEqual({ attempted: 0, results: [], skipped: null });
    expect(resolvedRefs()).toEqual([]);
    expect(sent.map(s => s.ref)).not.toContain(b.ref);
    expect(sent.map(s => s.ref)).not.toContain(c.ref);
  });

  it("W7. a subscription with no organization is inert: never resolved, never sent", async () => {
    const A = tenant();
    const orphan = await subscription(null, { eventTypesJson: '["*"]' });
    const a = await subscription(A);
    const ev = await event(A);
    const sent = wire();

    await dispatchWebhooks({ eventIds: [ev], now: NOW });

    expect(sent).toEqual([{ ref: a.ref, eventId: ev, url: a.url }]);
    expect(resolvedRefs()).not.toContain(orphan.ref);
  });

  it("W8. in a mixed-tenant batch, tenant B's damaged subscriptions stop neither tenant A nor B's healthy one", async () => {
    const [A, B] = [tenant(), tenant()];
    const a = await subscription(A);
    const bad = await subscription(B, { eventTypesJson: "{not json" });
    // Parses, but is not a list of event types: `subscribed()` would throw on it just the same.
    const misshapen = await subscription(B, { eventTypesJson: '"*"' });
    const good = await subscription(B);
    const evA = await event(A);
    const evB = await event(B);
    const sent = wire();
    const warned = warnings();

    await dispatchWebhooks({ eventIds: [evA, evB], now: NOW });

    expect(sent.map(s => `${s.ref}>${s.eventId}`).sort()).toEqual([`${a.ref}>${evA}`, `${good.ref}>${evB}`].sort());
    expect(resolvedRefs()).not.toContain(bad.ref);
    expect(resolvedRefs()).not.toContain(misshapen.ref);
    // B's damaged rows are in scope (B has an event here), so they are read — and each is reported, by name, without its configuration.
    const w = warned([bad.ref, misshapen.ref]);
    expect(w).toHaveLength(2);
    for (const line of w) {
      expect(line).not.toContain("{not json");
      expect(line).not.toContain(bad.url);
      expect(line).not.toContain(misshapen.url);
    }
  });
});
