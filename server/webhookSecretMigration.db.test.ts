/**
 * S2-E Phase 1 — moving a live outbound signing secret, proved against a real database.
 *
 * TWO TESTS CARRY MOST OF THE WEIGHT.
 *
 * **E16/E17 are the fence around OD-E2.** They start a subscription on secret A, fail an attempt,
 * change the effective secret to B at the storage layer, and then prove the next attempt's outbound
 * signature verifies under B and **fails** under A — through the real dispatcher, on both the
 * ordinary retry path and the expired-attempt reclaim path, which re-sign separately. Asserting by
 * identity is the point: a test that only checked "a signature exists" would pass against an
 * implementation that had silently frozen the secret at delivery creation, which is precisely the
 * design LeaseOS rejected.
 *
 * **E7 is the fail-closed fence.** It gives a subscription a perfectly good legacy secret *and* a
 * broken canonical reference, so a silent fallback would succeed and return a value this test can
 * name. Most fail-closed tests are satisfied by an empty database; this one is not.
 *
 * E3 is the compatibility keystone: the same secret, timestamp and body must produce a
 * byte-identical HMAC before and after the storage migration, or a receiver notices.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import {
  readWebhookSecretForMigration,
  resolveWebhookSigningSecret,
  webhookSecretStorageOf,
} from "./webhookSecretService";
import { migrateWebhookSecrets, webhookSecretReadiness } from "./webhookSecretMigration";
import { createEnvironmentKeyProvider } from "./_core/secretCrypto";
import { signPayload, verifySignature } from "./_core/integrationGateway";
import { encryptSecret as legacyEnc } from "./_core/externalIdentityPolicy";
import { createSecret, describeSecret } from "./secretStore";
import { dispatchWebhooks, setWebhookPoster, sweepWebhookRetries } from "./webhookDispatchService";

/*
 * The dispatcher builds its own keys from the environment — `mfaKey()` for the legacy shared key and
 * `environmentSecretKeys()` for the canonical one — so the tests that drive real dispatch must make
 * the environment agree with the fixtures below. Distinct material for the two, deliberately: if
 * they were the same bytes, a regression that resolved a canonical secret under the legacy key would
 * still pass.
 */
process.env.LEASEOS_PORTAL_MFA_KEY = "8".repeat(64);
process.env.LEASEOS_KEY_WEBHOOK_V1 = "7".repeat(64);

const DB_URL = process.env.DATABASE_URL;

describe("webhook secret migration — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
});
afterAll(async () => {
  await pool?.end();
});

const hexKey = (seed: string) => seed.repeat(64).slice(0, 64);

/** The canonical webhook key. Distinct material from the legacy shared key, by design. */
const keys = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("7") } } });
const LEGACY = Buffer.from(hexKey("8"), "hex");
const K = { keys, legacyKey: LEGACY, isProduction: false };

const RUN = randomBytes(4).toString("hex");
let seq = 0;

/** Create a subscription in a chosen storage state. `orgRef` is per-test so tenants cannot collide. */
async function subscription(state: {
  legacySecret?: string;
  canonicalSecret?: string;
  status?: "active" | "paused" | "revoked";
  orgRef?: string;
} = {}) {
  const ref = `WH-${RUN}-${++seq}`;
  const orgRef = state.orgRef ?? `org-${RUN}-${seq}`;
  const enc = state.legacySecret ? legacyEnc(state.legacySecret, LEGACY) : null;

  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO webhookSubscriptions
       (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId, createdAt)
     VALUES (?, ?, ?, 'https://receiver.test/hook', ?, '["*"]', ?, 1, NOW())`,
    [orgRef, ref, `Test ${ref}`, enc, state.status ?? "active"]
  );
  const id = res.insertId;

  if (state.canonicalSecret) {
    const { secretRef } = await createSecret({ purpose: "WEBHOOK_SECRET", plaintext: state.canonicalSecret, keys });
    await pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ?", [secretRef, id]);
  }
  return { id, ref, orgRef };
}

const columns = async (id: number) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT secretEnc, secretRef, status FROM webhookSubscriptions WHERE id = ?",
    [id]
  );
  return r[0]! as { secretEnc: string | null; secretRef: string | null; status: string };
};

/** Queue an outbox event this subscription's tenant will receive. */
async function outboxEvent(orgRef: string) {
  const eventId = `EV-${RUN}-${++seq}`;
  await pool.execute(
    `INSERT INTO domainEventOutbox
       (eventId, tenantId, eventType, eventVersion, aggregateType, aggregateId, payloadJson, occurredAt, createdAt)
     VALUES (?, ?, 'test.event', 1, 'test', '1', '{"k":"v"}', NOW(), NOW())`,
    [eventId, orgRef]
  );
  return eventId;
}

/** Capture what the dispatcher actually put on the wire. */
type Sent = { url: string; body: string; headers: Record<string, string> };
function capture(status = 500) {
  const sent: Sent[] = [];
  setWebhookPoster(async (url, body, headers) => {
    sent.push({ url, body, headers });
    return { status };
  });
  return sent;
}

d("E1/E6 — the compatibility reader prefers canonical and still reads legacy", () => {
  it("E1. a legacy-only subscription resolves through the legacy key", async () => {
    const secret = "legacy-signing-secret-aaa";
    const { id } = await subscription({ legacySecret: secret });

    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("legacy");
    expect(await resolveWebhookSigningSecret(row, K)).toBe(secret);
  });

  it("E6. with both present, the canonical reference wins", async () => {
    /*
     * Both are readable and they differ, so the assertion names which one was used. If the resolver
     * preferred legacy, it would return the legacy value and this fails by identity.
     */
    const { id } = await subscription({ legacySecret: "legacy-value", canonicalSecret: "canonical-value" });

    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("transitional");
    expect(await resolveWebhookSigningSecret(row, K)).toBe("canonical-value");
  });

  it("E26. a canonical-only subscription resolves through the new key", async () => {
    const { id } = await subscription({ canonicalSecret: "canonical-only-value" });
    await pool.execute("UPDATE webhookSubscriptions SET secretEnc = NULL WHERE id = ?", [id]);

    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("canonical");
    expect(await resolveWebhookSigningSecret(row, K)).toBe("canonical-only-value");
  });

  it("E28. a backfilled secret carries purpose WEBHOOK_SECRET", async () => {
    const { id } = await subscription({ legacySecret: "purpose-check" });
    await migrateWebhookSecrets({ ...K, batchSize: 50 });

    const described = (await describeSecret((await columns(id)).secretRef!))!;
    expect(described.purpose).toBe("WEBHOOK_SECRET");
    expect(described.keyId).toBe("webhook-v1");
  });
});

d("E7/E8/E25/E27 — a broken reference fails closed and never falls back", () => {
  it("E7. a present-but-missing reference fails rather than using the working legacy secret", async () => {
    const legacySecret = "legacy-would-have-worked";
    const { id } = await subscription({ legacySecret });
    await pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ?", ["sec_does_not_exist_00000000000", id]);

    const row = await columns(id);
    const outcome = await resolveWebhookSigningSecret(row, K).then(v => `resolved:${v}`, e => `refused:${(e as Error).message}`);

    expect(outcome, "a broken reference must not hand signing back to the legacy secret").not.toBe(`resolved:${legacySecret}`);
    expect(outcome.startsWith("refused:")).toBe(true);
  });

  it("E8. a reference to another purpose's secret is refused", async () => {
    const multi = createEnvironmentKeyProvider({
      WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("7") } },
      MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("9") } },
    });
    const { secretRef } = await createSecret({ purpose: "MFA_SECRET", plaintext: "not-a-webhook-secret", keys: multi });

    const { id } = await subscription({ legacySecret: "legacy-present" });
    await pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ?", [secretRef, id]);

    await expect(
      resolveWebhookSigningSecret(await columns(id), { keys: multi, legacyKey: LEGACY })
    ).rejects.toThrow(/no such secret/);
  });

  it("E27. a canonical reference whose key is unavailable fails closed", async () => {
    const { id } = await subscription({ legacySecret: "legacy-present", canonicalSecret: "canonical-value" });
    const noWebhookKey = createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("9") } } });

    await expect(
      resolveWebhookSigningSecret(await columns(id), { keys: noWebhookKey, legacyKey: LEGACY })
    ).rejects.toThrow();
  });

  it("E25. a subscription with neither representation fails closed", async () => {
    const { id } = await subscription({});
    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("none");
    await expect(resolveWebhookSigningSecret(row, K)).rejects.toThrow(/no signing secret/);
  });

  it("E11. a legacy-only subscription with no legacy key fails closed", async () => {
    const { id } = await subscription({ legacySecret: "needs-legacy-key" });
    await expect(
      resolveWebhookSigningSecret(await columns(id), { keys, legacyKey: null })
    ).rejects.toThrow(/legacy key is not configured/);
  });

  it("E13. a missing WEBHOOK_SECRET key does not stop legacy-only signing", async () => {
    /*
     * Release 1 must be deployable before the canonical key is provisioned everywhere. A legacy-only
     * subscription cannot need the new key, and must not be made to.
     */
    const { id } = await subscription({ legacySecret: "legacy-still-fine" });
    const noWebhookKey = createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("9") } } });

    expect(await resolveWebhookSigningSecret(await columns(id), { keys: noWebhookKey, legacyKey: LEGACY }))
      .toBe("legacy-still-fine");
  });
});

d("E2/E3/E14 — the secret survives, and so does the signature", () => {
  it("E2. the backfilled secret is byte-identical", async () => {
    const secret = "exact-secret-value-9f3b2c";
    const { id } = await subscription({ legacySecret: secret });

    await migrateWebhookSecrets({ ...K, batchSize: 50 });

    expect(await resolveWebhookSigningSecret(await columns(id), K)).toBe(secret);
  });

  it("E3. the same secret, timestamp and body produce an identical HMAC across the migration", async () => {
    /*
     * The compatibility keystone. If this differs by one byte, every receiver starts rejecting
     * deliveries the moment the backfill runs.
     */
    const secret = "protocol-stability-secret";
    const { id } = await subscription({ legacySecret: secret });
    const timestamp = 1790000000;
    const body = JSON.stringify({ eventId: "EV-1", payload: { a: 1 } });

    const before = signPayload(await resolveWebhookSigningSecret(await columns(id), K), timestamp, body);

    await migrateWebhookSecrets({ ...K, batchSize: 50 });

    const after = signPayload(await resolveWebhookSigningSecret(await columns(id), K), timestamp, body);

    expect(after, "storage migration must be invisible to the receiver").toBe(before);
    // And a receiver holding the original secret still verifies it.
    expect(verifySignature(secret, timestamp, body, after, new Date(timestamp * 1000)).valid).toBe(true);
  });

  it("E14. the backfill does not rotate the customer's secret", async () => {
    const secret = "do-not-rotate-me";
    const { id } = await subscription({ legacySecret: secret });

    await migrateWebhookSecrets({ ...K, batchSize: 50 });

    const row = await columns(id);
    expect(await resolveWebhookSigningSecret(row, K)).toBe(secret);
    expect(row.secretEnc, "the rollback path is retained through Release 1").not.toBeNull();
    expect(webhookSecretStorageOf(row)).toBe("transitional");
  });
});

d("E9/E10/E12/E24 — the backfill is idempotent, resumable and fails closed", () => {
  /*
   * E9 and E10 assert about the rows they create, never about whole-table counts.
   *
   * An earlier version checked `second.scanned === 0` and `partial.migrated === 1` globally, and
   * broke the moment anything else left a row in the table — which a mutation run does routinely,
   * and which any other suite creating a webhook subscription would do in the gate's shared
   * database. The property under test is "this row migrates once and stays put", and that is what
   * these now say.
   */
  it("E9. a second run does not re-migrate a row that is already done", async () => {
    const { id, ref } = await subscription({ legacySecret: "idem" });

    await migrateWebhookSecrets({ ...K, batchSize: 500 });
    const refAfterFirst = (await columns(id)).secretRef;
    expect(refAfterFirst, "the first run must have migrated it").toBeTruthy();

    const second = await migrateWebhookSecrets({ ...K, batchSize: 500 });

    expect(second.failures.some(f => f.subscriptionRef === ref)).toBe(false);
    expect((await columns(id)).secretRef, "a migrated row is not repointed by a rerun").toBe(refAfterFirst);

    const [secretRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM encryptedSecrets WHERE secretRef = ?",
      [refAfterFirst]
    );
    expect(secretRows[0]!.n, "no duplicate canonical secret").toBe(1);
  });

  it("E10. a bounded run migrates some and leaves the rest for the next one", async () => {
    const secrets = ["res-a", "res-b", "res-c"];
    const ids: number[] = [];
    for (const s of secrets) ids.push((await subscription({ legacySecret: s })).id);

    const migratedOf = async () => (await Promise.all(ids.map(async i => Boolean((await columns(i)).secretRef)))).filter(Boolean).length;

    /*
     * Bounded means "looked at one row", not "succeeded on one row" — `scanned` is the assertion
     * that holds whether or not that row happened to be migratable, which is what makes it
     * independent of whatever else is in the table.
     */
    const partial = await migrateWebhookSecrets({ ...K, batchSize: 1, maxBatches: 1 });
    expect(partial.scanned, "one batch of one row scans exactly one row").toBe(1);
    expect(partial.complete, "a bounded run never claims completion").toBe(false);
    expect(await migratedOf()).toBeLessThan(ids.length);

    await migrateWebhookSecrets({ ...K, batchSize: 500 });

    expect(await migratedOf(), "the rest are picked up by a later run").toBe(ids.length);
    for (let i = 0; i < ids.length; i += 1) {
      expect(await resolveWebhookSigningSecret(await columns(ids[i]!), K)).toBe(secrets[i]);
    }
  });

  it("E12. a missing WEBHOOK_SECRET key refuses to start the run", async () => {
    const noWebhookKey = createEnvironmentKeyProvider({ MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("9") } } });
    await expect(migrateWebhookSecrets({ keys: noWebhookKey, legacyKey: LEGACY }))
      .rejects.toThrow(/no active WEBHOOK_SECRET key/);
  });

  it("E11b. a missing legacy key refuses to start the run", async () => {
    await expect(migrateWebhookSecrets({ keys, legacyKey: null }))
      .rejects.toThrow(/LEASEOS_PORTAL_MFA_KEY is not configured/);
  });

  it("E24. an unmigratable row is reported and left signing on legacy", async () => {
    const good = "healthy-row";
    const goodSub = await subscription({ legacySecret: good });
    const badSub = await subscription({ legacySecret: "will-be-corrupted" });
    await pool.execute("UPDATE webhookSubscriptions SET secretEnc = ? WHERE id = ?", ["not.valid.ciphertext", badSub.id]);

    const result = await migrateWebhookSecrets({ ...K, batchSize: 50 });

    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.some(f => f.subscriptionRef === badSub.ref)).toBe(true);
    expect(result.complete, "a run with failures is never complete").toBe(false);

    const bad = await columns(badSub.id);
    expect(bad.secretEnc, "the unmigratable row is left exactly as it was").toBe("not.valid.ciphertext");
    expect(bad.secretRef).toBeNull();
    expect((await columns(goodSub.id)).secretRef, "the healthy row in the same batch still migrated").toBeTruthy();

    // Scaffolding this test created, this test removes: a permanently-broken row would otherwise
    // make every later whole-table readiness assertion fail for an unrelated reason.
    await pool.execute("DELETE FROM webhookSubscriptions WHERE id = ?", [badSub.id]);
  });

  it("a run whose every row fails stops instead of spinning", async () => {
    /*
     * The S2-D defect, available to write again in this loop shape: a cumulative no-progress check
     * would refetch the failing row forever. Bounded by the test timeout — if this regresses, it
     * hangs rather than fails, which is itself the signal.
     */
    const bad = await subscription({ legacySecret: "corrupt-me" });
    await pool.execute("UPDATE webhookSubscriptions SET secretEnc = ? WHERE id = ?", ["garbage", bad.id]);

    const result = await migrateWebhookSecrets({ ...K, batchSize: 10 });

    expect(result.failed).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
    await pool.execute("DELETE FROM webhookSubscriptions WHERE id = ?", [bad.id]);
  });
});

d("E15/E16/E17 — OD-E2: every attempt signs with the CURRENT secret", () => {
  it("E15. a first attempt signs with the subscription's current secret", async () => {
    const secret = "current-at-send";
    const s = await subscription({ legacySecret: secret });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: new Date("2026-05-01T10:00:00Z") });

    expect(sent.length).toBe(1);
    const ts = Number(sent[0]!.headers["x-leaseos-timestamp"]);
    expect(verifySignature(secret, ts, sent[0]!.body, sent[0]!.headers["x-leaseos-signature"]!, new Date(ts * 1000)).valid).toBe(true);
  });

  it("E6b. the DISPATCHER signs with the canonical secret when both are present", async () => {
    /*
     * E6 proves the resolver prefers canonical; this proves the dispatcher actually goes through it.
     * The distinction is not pedantic — a mutation that replaced the dispatcher's call with a direct
     * legacy decrypt left E6 passing, because E6 never touches the dispatch path. The two secrets
     * differ, so the outbound signature names which one was used.
     */
    const s = await subscription({ legacySecret: "dispatcher-legacy", canonicalSecret: "dispatcher-canonical" });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: new Date("2026-05-06T10:00:00Z") });

    expect(sent.length).toBe(1);
    const ts = Number(sent[0]!.headers["x-leaseos-timestamp"]);
    const sig = sent[0]!.headers["x-leaseos-signature"]!;
    expect(verifySignature("dispatcher-canonical", ts, sent[0]!.body, sig, new Date(ts * 1000)).valid, "the dispatcher must use the canonical secret").toBe(true);
    expect(verifySignature("dispatcher-legacy", ts, sent[0]!.body, sig, new Date(ts * 1000)).valid, "the dispatcher must not fall back to legacy when a reference resolves").toBe(false);
  });

  it("E16. a RETRY after the secret changes verifies under the new secret and NOT the old", async () => {
    /*
     * THE OD-E2 FENCE. Secret A signs attempt 1, which fails. The subscription's effective secret
     * becomes B. The retry must verify under B and fail under A — asserted both ways, so an
     * implementation that froze the secret at delivery creation cannot pass.
     */
    const A = "secret-A-original";
    const B = "secret-B-replacement";
    const s = await subscription({ legacySecret: A });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    const t1 = new Date("2026-05-01T10:00:00Z");
    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: t1 });
    expect(sent.length).toBe(1);

    // The effective signing secret becomes B, at the storage layer — exactly what a future rotation
    // will do. Phase 1 ships no rotation API, so the test performs the write itself.
    await pool.execute("UPDATE webhookSubscriptions SET secretEnc = ? WHERE id = ?", [legacyEnc(B, LEGACY), s.id]);

    // Past the 1-minute backoff for attempt 2.
    const t2 = new Date(t1.getTime() + 5 * 60_000);
    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: t2 });

    expect(sent.length, "the retry must actually have been sent").toBe(2);
    const retry = sent[1]!;
    const ts = Number(retry.headers["x-leaseos-timestamp"]);
    const sig = retry.headers["x-leaseos-signature"]!;

    expect(verifySignature(B, ts, retry.body, sig, new Date(ts * 1000)).valid, "retry must verify under the CURRENT secret").toBe(true);
    expect(verifySignature(A, ts, retry.body, sig, new Date(ts * 1000)).valid, "retry must NOT verify under the superseded secret").toBe(false);
  });

  it("E17. a RECLAIMED attempt after the secret changes also uses the new secret", async () => {
    /*
     * `reclaimExpiredAttempt` is a separate code path that re-signs independently, so a freeze could
     * survive here while the ordinary retry stayed correct. It gets its own fence.
     */
    const A = "reclaim-secret-A";
    const B = "reclaim-secret-B";
    const s = await subscription({ legacySecret: A });
    const eventId = await outboxEvent(s.orgRef);

    // Attempt 1 claims the row and then the "worker" dies before recording an outcome: the poster
    // throws, so nothing is finished and the claim is left live.
    const sent: Sent[] = [];
    setWebhookPoster(async (url, body, headers) => { sent.push({ url, body, headers }); throw new Error("worker died"); });
    const t1 = new Date("2026-05-01T10:00:00Z");
    const leaseT1 = new Date("2026-05-01T10:00:00Z");
    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: t1, leaseNow: leaseT1 }).catch(() => undefined);

    const [queued] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT status, attempt FROM webhookDeliveries WHERE subscriptionId = ? ORDER BY id DESC LIMIT 1", [s.id]
    );
    expect(queued[0]?.status, "the attempt should be left claimed").toBe("queued");

    await pool.execute("UPDATE webhookSubscriptions SET secretEnc = ? WHERE id = ?", [legacyEnc(B, LEGACY), s.id]);

    // The lease expires, and a recovering worker reclaims the SAME attempt.
    const reclaimed = capture();
    const leaseLater = new Date(leaseT1.getTime() + 10 * 60_000);
    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: t1, leaseNow: leaseLater });

    expect(reclaimed.length, "the expired attempt must have been reclaimed and re-sent").toBe(1);
    const r = reclaimed[0]!;
    const ts = Number(r.headers["x-leaseos-timestamp"]);
    const sig = r.headers["x-leaseos-signature"]!;

    expect(verifySignature(B, ts, r.body, sig, new Date(ts * 1000)).valid, "reclaim must verify under the CURRENT secret").toBe(true);
    expect(verifySignature(A, ts, r.body, sig, new Date(ts * 1000)).valid, "reclaim must NOT verify under the superseded secret").toBe(false);
  });

  it("a retry after BACKFILL keeps signing with the same value", async () => {
    // The migration must be invisible to an in-flight delivery, not merely to a new one.
    const secret = "in-flight-during-backfill";
    const s = await subscription({ legacySecret: secret });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    const t1 = new Date("2026-05-02T10:00:00Z");
    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: t1 });

    await migrateWebhookSecrets({ ...K, batchSize: 50 });
    expect(webhookSecretStorageOf(await columns(s.id))).toBe("transitional");

    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: new Date(t1.getTime() + 5 * 60_000) });

    expect(sent.length).toBe(2);
    const r = sent[1]!;
    const ts = Number(r.headers["x-leaseos-timestamp"]);
    expect(verifySignature(secret, ts, r.body, r.headers["x-leaseos-signature"]!, new Date(ts * 1000)).valid).toBe(true);
  });
});

d("E18/E19/E22 — delivery behaviour and protocol are unchanged", () => {
  it("E18. a revoked subscription sends nothing", async () => {
    const s = await subscription({ legacySecret: "revoked-sub", status: "revoked" });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    const r = await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now: new Date("2026-05-03T10:00:00Z") });

    expect(sent.length).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it("E18b. a revoked subscription sends nothing on the fleet-wide path either", async () => {
    /*
     * `dispatchWebhooks` has two subscription queries — one scoped by `orgRef`, one fleet-wide — and
     * `sweepWebhookRetries` uses the fleet-wide one. E18 only exercises the scoped branch, so a
     * status filter dropped from the other would have gone unnoticed; a mutation aimed there did
     * exactly that and survived. This covers the branch the retry sweep actually runs.
     */
    const s = await subscription({ legacySecret: "revoked-fleet-wide", status: "revoked" });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    await dispatchWebhooks({ eventIds: [eventId], now: new Date("2026-05-03T11:00:00Z") });

    expect(sent.length, "a revoked subscription must not be selected by the fleet-wide query").toBe(0);
  });

  it("E19. changing only the URL leaves the signing secret untouched", async () => {
    const secret = "url-change-safe";
    const s = await subscription({ legacySecret: secret });
    const before = await columns(s.id);

    await pool.execute("UPDATE webhookSubscriptions SET url = ? WHERE id = ?", ["https://elsewhere.test/hook", s.id]);

    const after = await columns(s.id);
    expect(after.secretEnc).toBe(before.secretEnc);
    expect(after.secretRef).toBe(before.secretRef);
    expect(await resolveWebhookSigningSecret(after, K)).toBe(secret);
  });

  it("E22. the outbound protocol is unchanged — headers, algorithm and tolerance", async () => {
    const secret = "protocol-shape";
    const s = await subscription({ legacySecret: secret });
    const eventId = await outboxEvent(s.orgRef);
    const sent = capture();

    const now = new Date("2026-05-04T10:00:00Z");
    await dispatchWebhooks({ orgRef: s.orgRef, eventIds: [eventId], now });

    const h = sent[0]!.headers;
    expect(Object.keys(h).sort()).toEqual([
      "content-type", "x-leaseos-delivery", "x-leaseos-event", "x-leaseos-signature", "x-leaseos-timestamp",
    ]);
    expect(h["x-leaseos-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(h["x-leaseos-timestamp"])).toBe(Math.floor(now.getTime() / 1000));
    // No internal identifier reaches the wire.
    const wire = JSON.stringify(sent[0]);
    expect(wire).not.toContain("sec_");
    expect(wire).not.toContain("webhook-v1");
    expect(wire).not.toContain(secret);
    // The documented 300-second tolerance still refuses an older timestamp.
    const ts = Number(h["x-leaseos-timestamp"]);
    expect(verifySignature(secret, ts, sent[0]!.body, h["x-leaseos-signature"]!, new Date((ts + 301) * 1000)).valid).toBe(false);
  });
});

d("E20/E21/E23 — nothing on the way out carries a secret", () => {
  it("E20/E21. a subscription row and a refusal carry neither plaintext nor envelope", async () => {
    const secret = "leak-candidate-4d5e6f";
    const s = await subscription({ legacySecret: secret });
    await migrateWebhookSecrets({ ...K, batchSize: 50 });

    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM webhookSubscriptions WHERE id = ?", [s.id]);
    const everyValue = Object.values(rows[0]!).map(v => (v instanceof Date ? v.toISOString() : String(v))).join(" ");
    expect(everyValue, "a subscription query must never surface the signing secret").not.toContain(secret);
    expect(everyValue).not.toContain("v1.WEBHOOK_SECRET");

    const messages: string[] = [];
    await pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ?", ["sec_missing_00000000000000000", s.id]);
    await resolveWebhookSigningSecret(await columns(s.id), K).catch(e => messages.push((e as Error).message));
    await readWebhookSecretForMigration(await columns(s.id), LEGACY).catch(e => messages.push((e as Error).message));

    const all = messages.join(" ");
    expect(messages.length).toBe(2);
    expect(all).not.toContain(secret);
    expect(all).not.toContain("v1.WEBHOOK_SECRET");
  });

  it("E23. the readiness report carries counts only", async () => {
    const secret = "readiness-secret-value";
    await subscription({ legacySecret: secret });

    const report = await webhookSecretReadiness();
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sec_");
    expect(Object.values(report).every(v => typeof v === "number" || typeof v === "boolean")).toBe(true);
    expect(report.total).toBe(report.legacyOnly + report.transitional + report.canonicalOnly + report.invalidBothNull);
  });

  it("E29. readiness does not claim Release 2 readiness from database state alone", async () => {
    /*
     * The report can say "no enabled subscription still needs the legacy key". It cannot say every
     * deployed instance understands canonical references — no query can — and the field is named so
     * that reading it as deployment convergence is difficult.
     */
    const report = await webhookSecretReadiness();
    expect(Object.keys(report)).not.toContain("releaseTwoReady");
    expect(Object.keys(report)).not.toContain("safeToCutover");
    expect(report).toHaveProperty("noEnabledLegacyDependence");
  });
});
