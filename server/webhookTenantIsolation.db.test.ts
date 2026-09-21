/**
 * v23.28 — LeaseOS must never decrypt tenant B's subscription secret to dispatch tenant A's event.
 *
 * This is the defect the suite kept half-reporting as a flake. `dispatchWebhooks` loaded EVERY
 * active subscription and called `decryptSecret` on all of them at the top of the loop, before
 * `ev.tenantId !== s.orgRef` had decided which were even relevant. Two test files encrypting under
 * different server keys was merely the cheapest way to notice; in production the same shape is a
 * key rotation, a restored row, or a tenant whose secret was written under a previous key — and
 * any one of them took the whole dispatch down, for everybody, with a swallowed exception.
 *
 * These tests reproduce it deterministically, in one file, in one process, with no reliance on
 * which order Vitest happens to schedule anything.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { encryptSecret } from "./_core/externalIdentityPolicy";
import { SECRET_UNREADABLE, dispatchWebhooks, setWebhookPoster } from "./webhookDispatchService";

/*
 * One key for this file, set before anything imports the dispatcher. Tenant separation is proven
 * by ORGANIZATION, not by juggling server keys — an undecryptable row is produced deliberately
 * below by encrypting under a DIFFERENT key, which is what a rotated secret looks like.
 */
process.env.LEASEOS_PORTAL_MFA_KEY = "d".repeat(64);
const SERVER_KEY = Buffer.from("d".repeat(64), "hex");
const OTHER_KEY = Buffer.from("e".repeat(64), "hex");

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

async function subscription(orgRef: string, key: Buffer, eventTypes = ["iso.*"]) {
  const subscriptionRef = `WS-${rnd()}${rnd()}`;
  await pool.execute(
    `INSERT INTO webhookSubscriptions (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId, createdAt)
     VALUES (?,?,?,?,?,?,?,?,NOW())`,
    [orgRef, subscriptionRef, `sub ${rnd()}`, "https://example.invalid/hook",
     encryptSecret(`secret-${rnd()}`, key), JSON.stringify(eventTypes), "active", 1],
  );
  return subscriptionRef;
}

async function event(tenantId: string, eventType = "iso.happened") {
  const eventId = `EV-${rnd()}${rnd()}`.slice(0, 40);
  await pool.execute(
    `INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt)
     VALUES (?,?,1,'ticket',?,?,?,'system','{}',NOW(),0,NOW())`,
    [eventId, eventType, `AG-${rnd()}`, tenantId, `C-${rnd()}`],
  );
  return eventId;
}

const deliveriesFor = async (eventId: string) => {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT subscriptionId, status, error, signature FROM webhookDeliveries WHERE eventId = ?", [eventId]);
  return rows;
};
const subIdOf = async (ref: string) => {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM webhookSubscriptions WHERE subscriptionRef = ?", [ref]);
  return rows[0]!.id as number;
};

const NOW = new Date("2026-09-21T12:00:00Z");

d("tenant isolation in webhook dispatch", () => {
  it("1. never decrypts a foreign tenant's subscription, and does not die trying", async () => {
    const orgA = `ORG-A-${rnd()}`, orgB = `ORG-B-${rnd()}`;
    const a1 = await subscription(orgA, SERVER_KEY);
    // Tenant B's row is unreadable under this server's key — exactly the shape that used to throw.
    const b1 = await subscription(orgB, OTHER_KEY);
    const evA = await event(orgA);

    const sent: string[] = [];
    setWebhookPoster(async (_u, body) => { sent.push(body); return { status: 200 }; });

    // The whole dispatch used to fail here. It must now succeed for A and never touch B.
    const r = await dispatchWebhooks({ eventIds: [evA], now: NOW });

    expect(r.skipped).toBeNull();
    expect(r.results.map(x => x.subscriptionRef)).toEqual([a1]);
    expect(r.results[0]!.status).toBe("delivered");
    expect(sent).toHaveLength(1);

    const rows = await deliveriesFor(evA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriptionId).toBe(await subIdOf(a1));
    // No delivery row for B, and no error mentioning it.
    expect(rows.map(x => x.subscriptionId)).not.toContain(await subIdOf(b1));
  });

  it("2. holds in the reciprocal direction", async () => {
    const orgA = `ORG-A-${rnd()}`, orgB = `ORG-B-${rnd()}`;
    await subscription(orgA, OTHER_KEY);          // A is now the unreadable one
    const b1 = await subscription(orgB, SERVER_KEY);
    const evB = await event(orgB);

    setWebhookPoster(async () => ({ status: 200 }));
    const r = await dispatchWebhooks({ eventIds: [evB], now: NOW });

    expect(r.results.map(x => x.subscriptionRef)).toEqual([b1]);
    expect(r.results[0]!.status).toBe("delivered");
  });

  it("3. keeps each event to its own tenant in a mixed batch", async () => {
    const orgA = `ORG-A-${rnd()}`, orgB = `ORG-B-${rnd()}`;
    const a1 = await subscription(orgA, SERVER_KEY);
    const b1 = await subscription(orgB, SERVER_KEY);
    const evA = await event(orgA);
    const evB = await event(orgB);

    setWebhookPoster(async () => ({ status: 200 }));
    // The retry sweep legitimately batches across organizations; each event must still only meet
    // its own tenant's subscriptions.
    const r = await dispatchWebhooks({ eventIds: [evA, evB], now: NOW });

    const pairs = r.results.map(x => `${x.subscriptionRef}:${x.eventId}`).sort();
    expect(pairs).toEqual([`${a1}:${evA}`, `${b1}:${evB}`].sort());
    expect(pairs).not.toContain(`${a1}:${evB}`);
    expect(pairs).not.toContain(`${b1}:${evA}`);
  });

  it("4. isolates one corrupt secret to its own subscription and records it", async () => {
    const orgA = `ORG-A-${rnd()}`;
    const good = await subscription(orgA, SERVER_KEY);
    const bad = await subscription(orgA, OTHER_KEY);   // same tenant, unreadable secret
    const evA = await event(orgA);

    const sent: string[] = [];
    setWebhookPoster(async (_u, body) => { sent.push(body); return { status: 200 }; });
    const r = await dispatchWebhooks({ eventIds: [evA], now: NOW });

    const byRef = Object.fromEntries(r.results.map(x => [x.subscriptionRef, x]));
    // The healthy subscription still goes out — the old code lost it to the other one's throw.
    expect(byRef[good]!.status).toBe("delivered");
    expect(sent).toHaveLength(1);
    // The broken one is a recorded failure, not a silent hole.
    expect(byRef[bad]!.status).toBe("failed");
    expect(byRef[bad]!.reason).toContain(SECRET_UNREADABLE);

    const rows = await deliveriesFor(evA);
    const badId = await subIdOf(bad);
    const badRow = rows.find(x => x.subscriptionId === badId);
    expect(badRow).toBeTruthy();
    expect(badRow!.status).toBe("failed");
    expect(badRow!.error).toBe(SECRET_UNREADABLE);
    // Nothing was signed, because nothing was sent.
    expect(badRow!.signature).toBe("");
  });

  it("5. leaks no other organization's configuration in the failure it records", async () => {
    const orgA = `ORG-A-${rnd()}`, orgB = `ORG-B-${rnd()}`;
    await subscription(orgA, OTHER_KEY);
    const bName = `B-SECRET-NAME-${rnd()}`;
    await pool.execute(
      `INSERT INTO webhookSubscriptions (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId, createdAt)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [orgB, `WS-${rnd()}${rnd()}`, bName, "https://tenant-b-private.invalid/hook",
       encryptSecret("s", SERVER_KEY), JSON.stringify(["iso.*"]), "active", 1],
    );
    const evA = await event(orgA);

    setWebhookPoster(async () => ({ status: 200 }));
    const r = await dispatchWebhooks({ eventIds: [evA], now: NOW });

    const body = JSON.stringify(r);
    expect(body).not.toContain(bName);
    expect(body).not.toContain("tenant-b-private");
    expect(body).not.toContain(orgB);
    const rows = await deliveriesFor(evA);
    expect(JSON.stringify(rows)).not.toContain(bName);
  });

  it("6. reads nothing at all when the events belong to a tenant with no subscriptions", async () => {
    const orgLonely = `ORG-L-${rnd()}`;
    await subscription(`ORG-OTHER-${rnd()}`, OTHER_KEY);
    const ev = await event(orgLonely);
    setWebhookPoster(async () => ({ status: 200 }));
    const r = await dispatchWebhooks({ eventIds: [ev], now: NOW });
    expect(r.attempted).toBe(0);
    expect(r.results).toEqual([]);
    expect(await deliveriesFor(ev)).toEqual([]);
  });

  it("7. honours an explicit orgRef as a narrowing, never a widening", async () => {
    const orgA = `ORG-A-${rnd()}`, orgB = `ORG-B-${rnd()}`;
    await subscription(orgA, SERVER_KEY);
    const b1 = await subscription(orgB, SERVER_KEY);
    const evA = await event(orgA);
    const evB = await event(orgB);

    setWebhookPoster(async () => ({ status: 200 }));
    const r = await dispatchWebhooks({ eventIds: [evA, evB], now: NOW, orgRef: orgB });
    expect(r.results.map(x => x.subscriptionRef)).toEqual([b1]);
    expect(r.results.map(x => x.eventId)).toEqual([evB]);
  });
});
