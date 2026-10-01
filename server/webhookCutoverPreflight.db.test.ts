/**
 * S2-E Phase 2A — cutover readiness, proved against a real database with a production-shaped mix.
 *
 * Phase 1's suite (`webhookSecretMigration.db.test.ts`) proves each behaviour on the row it creates.
 * This suite asks the Phase 2 questions: given a table that looks like production — active, paused
 * and revoked legacy rows, rows already migrated, references that are broken, point at the wrong
 * purpose, or at a disabled secret, and a row with nothing at all — does the backfill leave every
 * one of them exactly as safe as it found it, and does the preflight then say precisely which of
 * them stands in the way of cutover, without ever handing back a secret?
 *
 * S2E2-T17 is the one to read first. It builds the best case this repository can produce — a
 * managed-shaped provider, data that is fully ready, every reference resolving, the production
 * write possible — and shows that the preflight still refuses, for exactly one reason: nothing
 * observes the fleet. A preflight that could be talked into "ready" from here would be the fake
 * boolean the design forbids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import {
  probeWebhookSigningSecret,
  resolveWebhookSigningSecret,
  webhookSecretStorageOf,
} from "./webhookSecretService";
import { migrateWebhookSecrets, webhookSecretReadiness } from "./webhookSecretMigration";
import { webhookCutoverPreflight, webhookCutoverPreflightFromEnvironment } from "./webhookCutoverPreflight";
import { createEnvironmentKeyProvider, type KeyDescriptor, type SecretKeyProvider, type SecretPurpose } from "./_core/secretCrypto";
import { signPayload, verifySignature } from "./_core/integrationGateway";
import { encryptSecret as legacyEnc } from "./_core/externalIdentityPolicy";
import { createSecret, describeSecret, disableSecret } from "./secretStore";
import { dispatchWebhooks, setWebhookPoster } from "./webhookDispatchService";

/* The dispatcher builds its keys from the environment; the fixtures below must agree with it. */
process.env.LEASEOS_PORTAL_MFA_KEY = "8".repeat(64);
process.env.LEASEOS_KEY_WEBHOOK_V1 = "7".repeat(64);

const DB_URL = process.env.DATABASE_URL;

describe("webhook cutover preflight — preconditions", () => {
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

/** The environment provider, exactly as `environmentSecretKeys()` builds it in production today. */
const envKeys = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("7") } } });
const LEGACY = Buffer.from(hexKey("8"), "hex");
const K = { keys: envKeys, legacyKey: LEGACY, isProduction: false };

/**
 * A managed-shaped provider that behaves like the production one would: it reports `"managed"`
 * because it is a separate implementation holding its material in its own key table — NOT the
 * environment provider relabelled, which `createEnvironmentKeyProvider` no longer permits.
 */
function managedFake(config: Partial<Record<SecretPurpose, { keyId: string; hex: string }>>): SecretKeyProvider {
  const held = new Map<string, KeyDescriptor>();
  for (const [purpose, k] of Object.entries(config)) held.set(`${purpose}:${k.keyId}`, { keyId: k.keyId, key: Buffer.from(k.hex, "hex") });
  return {
    kind: "managed",
    getActiveKey: purpose => [...held.entries()].find(([k]) => k.startsWith(`${purpose}:`))?.[1] ?? null,
    getDecryptKey: (purpose, keyId) => held.get(`${purpose}:${keyId}`) ?? null,
  };
}
/** The same key material as the environment provider, so canonical rows written under either read under both. */
const managed = managedFake({ WEBHOOK_SECRET: { keyId: "webhook-v1", hex: hexKey("7") } });

const RUN = randomBytes(4).toString("hex");
let seq = 0;

type Status = "active" | "paused" | "revoked";

/** A subscription in a chosen storage state, under a chosen tenant. */
async function subscription(state: {
  legacySecret?: string;
  canonicalSecret?: string;
  status?: Status;
  orgRef: string;
}) {
  const ref = `WH-${RUN}-${++seq}`;
  const enc = state.legacySecret ? legacyEnc(state.legacySecret, LEGACY) : null;
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO webhookSubscriptions
       (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId, createdAt)
     VALUES (?, ?, ?, 'https://receiver.test/hook', ?, '["*"]', ?, 1, NOW())`,
    [state.orgRef, ref, `Test ${ref}`, enc, state.status ?? "active"]
  );
  const id = res.insertId;
  let secretRef: string | null = null;
  if (state.canonicalSecret) {
    secretRef = (await createSecret({ purpose: "WEBHOOK_SECRET", plaintext: state.canonicalSecret, keys: envKeys })).secretRef;
    await pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ?", [secretRef, id]);
  }
  return { id, ref, orgRef: state.orgRef, secretRef };
}

const columns = async (id: number) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT secretEnc, secretRef, status FROM webhookSubscriptions WHERE id = ?", [id]);
  return r[0]! as { secretEnc: string | null; secretRef: string | null; status: Status };
};

const repoint = (id: number, secretRef: string | null) =>
  pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ?", [secretRef, id]);

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

type Sent = { url: string; body: string; headers: Record<string, string> };
function capture(status = 500) {
  const sent: Sent[] = [];
  setWebhookPoster(async (url, body, headers) => {
    sent.push({ url, body, headers });
    return { status };
  });
  return sent;
}

const org = (label: string) => `org-${RUN}-${label}`;

d("S2E2-T1..T7 — the compatibility reader, state by state", () => {
  const o = org("reader");

  it("S2E2-T1. legacy-only resolves, whatever the subscription's status", async () => {
    for (const status of ["active", "paused", "revoked"] as const) {
      const secret = `legacy-${status}-${RUN}`;
      const { id } = await subscription({ legacySecret: secret, status, orgRef: o });
      const row = await columns(id);
      expect(webhookSecretStorageOf(row)).toBe("legacy");
      expect(await resolveWebhookSigningSecret(row, K)).toBe(secret);
      expect(await probeWebhookSigningSecret(row, K)).toEqual({ resolvable: true });
    }
  });

  it("S2E2-T2. transitional resolves the canonical value, not the legacy one", async () => {
    const { id } = await subscription({ legacySecret: "legacy-side", canonicalSecret: "canonical-side", orgRef: o });
    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("transitional");
    expect(await resolveWebhookSigningSecret(row, K)).toBe("canonical-side");
  });

  it("S2E2-T3. canonical-only resolves with no legacy key at all", async () => {
    const { id } = await subscription({ canonicalSecret: "canonical-alone", orgRef: o });
    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("canonical");
    // No legacy key offered: a canonical-only row must not need one.
    expect(await resolveWebhookSigningSecret(row, { keys: envKeys, legacyKey: null })).toBe("canonical-alone");
  });

  it("S2E2-T4. a broken canonical reference refuses and never falls back to the legacy ciphertext beside it", async () => {
    const legacySecret = "legacy-would-work-t4";
    const { id } = await subscription({ legacySecret, orgRef: o });
    await repoint(id, `sec_broken_${RUN}_000000000000`);
    const row = await columns(id);

    const outcome = await resolveWebhookSigningSecret(row, K).then(v => `resolved:${v}`, e => `refused:${(e as Error).message}`);
    expect(outcome).not.toBe(`resolved:${legacySecret}`);
    expect(outcome).toMatch(/^refused:/);
    expect(await probeWebhookSigningSecret(row, K)).toEqual({ resolvable: false, refusal: "missing_or_wrong_purpose" });
  });

  it("S2E2-T5. a reference to another purpose's secret refuses identically, and does not fall back", async () => {
    const multi = createEnvironmentKeyProvider({
      WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("7") } },
      MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("9") } },
    });
    const { secretRef } = await createSecret({ purpose: "MFA_SECRET", plaintext: "an-mfa-seed", keys: multi });
    const legacySecret = "legacy-would-work-t5";
    const { id } = await subscription({ legacySecret, orgRef: o });
    await repoint(id, secretRef);
    const row = await columns(id);

    const k = { keys: multi, legacyKey: LEGACY };
    await expect(resolveWebhookSigningSecret(row, k)).rejects.toThrow(/no such secret/);
    expect(await probeWebhookSigningSecret(row, k)).toEqual({ resolvable: false, refusal: "missing_or_wrong_purpose" });
  });

  it("S2E2-T6. a disabled canonical secret refuses and does not fall back", async () => {
    const legacySecret = "legacy-would-work-t6";
    const { id, secretRef } = await subscription({ legacySecret, canonicalSecret: "was-canonical", orgRef: o });
    await disableSecret(secretRef!);
    const row = await columns(id);

    await expect(resolveWebhookSigningSecret(row, K)).rejects.toThrow(/disabled/);
    expect(await probeWebhookSigningSecret(row, K)).toEqual({ resolvable: false, refusal: "disabled" });
  });

  it("S2E2-T7. both-null refuses", async () => {
    const { id } = await subscription({ orgRef: o });
    const row = await columns(id);
    expect(webhookSecretStorageOf(row)).toBe("none");
    await expect(resolveWebhookSigningSecret(row, K)).rejects.toThrow(/no signing secret/);
    expect(await probeWebhookSigningSecret(row, K)).toEqual({ resolvable: false, refusal: "unsignable" });
  });
});

d("the representative backfill — a production-shaped mix, bounded batches, nothing changes but secretRef", () => {
  /*
   * Two tenants. `clean` holds the rows a healthy production would hold: they must all be ready
   * after the backfill. `dirty` holds the damage: a both-null row, references that are broken, point
   * at the wrong purpose or at a disabled secret, and a corrupt legacy ciphertext. The backfill must
   * leave the dirty tenant exactly as it found it and report what it could not do.
   */
  const clean = org("clean");
  const dirty = org("dirty");
  const TS = 1790000000;
  const BODY = JSON.stringify({ eventId: "EV-fixed", payload: { n: 1 } });

  type Fixture = { id: number; ref: string; secret: string | null; status: Status; label: string };
  const fixtures: Fixture[] = [];
  const before = new Map<number, { secretEnc: string | null; secretRef: string | null; hmac: string | null }>();
  let wrongPurposeKeys: SecretKeyProvider;

  const add = async (label: string, state: Parameters<typeof subscription>[0], secret: string | null) => {
    const s = await subscription(state);
    fixtures.push({ id: s.id, ref: s.ref, secret, status: state.status ?? "active", label });
    return s;
  };

  it("builds the mix and records every row's ciphertext, reference and signature", async () => {
    await add("active legacy-only #1", { legacySecret: `al1-${RUN}`, orgRef: clean }, `al1-${RUN}`);
    await add("active legacy-only #2", { legacySecret: `al2-${RUN}`, orgRef: clean }, `al2-${RUN}`);
    await add("active legacy-only #3", { legacySecret: `al3-${RUN}`, orgRef: clean }, `al3-${RUN}`);
    await add("paused legacy-only", { legacySecret: `pl-${RUN}`, status: "paused", orgRef: clean }, `pl-${RUN}`);
    await add("revoked legacy-only", { legacySecret: `rl-${RUN}`, status: "revoked", orgRef: clean }, `rl-${RUN}`);
    await add("transitional", { legacySecret: `tr-legacy-${RUN}`, canonicalSecret: `tr-canon-${RUN}`, orgRef: clean }, `tr-canon-${RUN}`);

    await add("invalid both-null (active)", { orgRef: dirty }, null);
    const broken = await add("broken canonical ref (active, legacy present)", { legacySecret: `bk-${RUN}`, orgRef: dirty }, null);
    await repoint(broken.id, `sec_broken_${RUN}_mix000000000`);
    wrongPurposeKeys = createEnvironmentKeyProvider({
      WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("7") } },
      MFA_SECRET: { active: { keyId: "mfa-v1", hex: hexKey("9") } },
    });
    const mfa = await createSecret({ purpose: "MFA_SECRET", plaintext: "mfa-seed", keys: wrongPurposeKeys });
    const wrong = await add("wrong-purpose canonical ref (active, legacy present)", { legacySecret: `wp-${RUN}`, orgRef: dirty }, null);
    await repoint(wrong.id, mfa.secretRef);
    const disabled = await add("disabled canonical secret (paused, legacy present)", { legacySecret: `ds-${RUN}`, canonicalSecret: `ds-canon-${RUN}`, status: "paused", orgRef: dirty }, null);
    await disableSecret(disabled.secretRef!);
    const corrupt = await add("corrupt legacy ciphertext (active)", { legacySecret: `cr-${RUN}`, orgRef: dirty }, null);
    await pool.execute("UPDATE webhookSubscriptions SET secretEnc = ? WHERE id = ?", ["not.valid.ciphertext", corrupt.id]);

    for (const f of fixtures) {
      const row = await columns(f.id);
      before.set(f.id, { secretEnc: row.secretEnc, secretRef: row.secretRef, hmac: f.secret ? signPayload(await resolveWebhookSigningSecret(row, K), TS, BODY) : null });
    }
    expect(fixtures.length).toBe(11);
  });

  it("the preflight BEFORE the backfill names the legacy dependence, and canonical-only is zero", async () => {
    const report = await webhookCutoverPreflight({ keys: envKeys, legacyKey: LEGACY, scope: { orgRefs: [clean] } });
    expect(report.webhookData.counts).toMatchObject({ total: 6, enabled: 4, legacyOnly: 5, transitional: 1, canonicalOnly: 0, invalidBothNull: 0, enabledUnsignable: 0, enabledLegacyOnly: 3, noEnabledLegacyDependence: false });
    expect(report.webhookData.ready).toBe(false);
    expect(report.webhookData.blockers).toEqual(["3 enabled subscription(s) still sign from legacy ciphertext; run the backfill"]);
    expect(report.cutoverAllowed).toBe(false);
  });

  it("a bounded run scans exactly its batch and never claims completion", async () => {
    const partial = await migrateWebhookSecrets({ ...K, batchSize: 2, maxBatches: 1 });
    expect(partial.scanned).toBe(2);
    expect(partial.complete).toBe(false);
  });

  it("the run to completion migrates every legacy row it can, reports the one it cannot, and stops", async () => {
    const result = await migrateWebhookSecrets({ ...K, batchSize: 3 });
    const corrupt = fixtures.find(f => f.label.startsWith("corrupt"))!;
    expect(result.failures.some(f => f.subscriptionRef === corrupt.ref), "the corrupt row is reported by reference").toBe(true);
    expect(result.complete, "a run with a failure never claims completion").toBe(false);
    for (const f of fixtures.filter(x => x.label.endsWith("legacy-only") || /legacy-only #/.test(x.label))) {
      expect((await columns(f.id)).secretRef, `${f.label} migrated`).toMatch(/^sec_/);
    }
  });

  it("S2E2-T8. every migrated plaintext is byte-identical, and the legacy ciphertext is untouched on every row", async () => {
    for (const f of fixtures) {
      const row = await columns(f.id);
      expect(row.secretEnc, `${f.label}: secretEnc unchanged`).toBe(before.get(f.id)!.secretEnc);
      if (f.secret) expect(await resolveWebhookSigningSecret(row, K), `${f.label}: plaintext`).toBe(f.secret);
    }
  });

  it("S2E2-T9. the HMAC over the same (timestamp, body) is byte-identical before and after", async () => {
    for (const f of fixtures) {
      if (!f.secret) continue;
      const after = signPayload(await resolveWebhookSigningSecret(await columns(f.id), K), TS, BODY);
      expect(after, `${f.label}: signature`).toBe(before.get(f.id)!.hmac);
      expect(verifySignature(f.secret, TS, BODY, after, new Date(TS * 1000)).valid).toBe(true);
    }
  });

  it("rows the backfill could not or must not touch are exactly as they were", async () => {
    for (const f of fixtures.filter(x => !x.secret)) {
      const row = await columns(f.id);
      expect(row.secretRef, `${f.label}: secretRef`).toBe(before.get(f.id)!.secretRef);
      expect(row.secretEnc, `${f.label}: secretEnc`).toBe(before.get(f.id)!.secretEnc);
    }
    // The transitional row was not re-migrated: its reference is the one it had.
    const tr = fixtures.find(f => f.label === "transitional")!;
    expect((await columns(tr.id)).secretRef).toBe(before.get(tr.id)!.secretRef);
    // A failed legacy row that is still valid ciphertext stays usable: the corrupt one is the only unusable row, and it was unusable before.
    const broken = fixtures.find(f => f.label.startsWith("broken"))!;
    expect(await probeWebhookSigningSecret(await columns(broken.id), K)).toEqual({ resolvable: false, refusal: "missing_or_wrong_purpose" });
  });

  it("a second run is idempotent: no row is repointed again and no duplicate secret appears", async () => {
    const refs = new Map(await Promise.all(fixtures.map(async f => [f.id, (await columns(f.id)).secretRef] as const)));
    await migrateWebhookSecrets({ ...K, batchSize: 50 });
    for (const f of fixtures) expect((await columns(f.id)).secretRef, f.label).toBe(refs.get(f.id));
    for (const ref of [...refs.values()].filter((r): r is string => Boolean(r) && !r!.includes("broken"))) {
      const [n] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM encryptedSecrets WHERE secretRef = ?", [ref]);
      expect(Number(n[0]!.n), ref.slice(0, 8)).toBeLessThanOrEqual(1);
    }
  });

  it("the readiness counts mean exactly what their names say", async () => {
    const r = await webhookSecretReadiness({ orgRefs: [clean, dirty] });
    expect(r).toEqual({
      total: 11, //            every row under the two tenants
      enabled: 8, //           status = 'active'
      legacyOnly: 1, //        secretEnc present, secretRef absent: only the corrupt row is still legacy-only
      transitional: 9, //      both present: 5 migrated + the original transitional + broken + wrong-purpose + disabled
      canonicalOnly: 0, //     never produced by Release 1
      invalidBothNull: 1, //   the both-null row
      enabledUnsignable: 1, // enabled AND both-null
      enabledLegacyOnly: 1, // enabled AND legacy-only: the corrupt row
      noEnabledLegacyDependence: false,
    });
    expect(r.total).toBe(r.legacyOnly + r.transitional + r.canonicalOnly + r.invalidBothNull);
    expect(r.enabledUnsignable).toBeLessThanOrEqual(r.invalidBothNull);
    expect(r.enabledLegacyOnly).toBeLessThanOrEqual(r.legacyOnly);
  });

  it("S2E2-T15. readiness refuses cutover while an enabled legacy-only row remains", async () => {
    const o = org("t15");
    const { id } = await subscription({ legacySecret: "still-legacy", orgRef: o });
    const blocked = await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [o] } });
    expect(blocked.webhookData.ready).toBe(false);
    expect(blocked.webhookData.counts.enabledLegacyOnly).toBe(1);
    expect(blocked.webhookData.blockers.some(b => /legacy ciphertext/.test(b))).toBe(true);
    expect(blocked.cutoverAllowed).toBe(false);

    await migrateWebhookSecrets({ ...K, batchSize: 50 });
    expect((await columns(id)).secretRef).toMatch(/^sec_/);
    const after = await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [o] } });
    expect(after.webhookData.ready).toBe(true);
    expect(after.webhookData.counts.noEnabledLegacyDependence).toBe(true);
    // Data readiness is not deployment readiness: the verdict is still no.
    expect(after.cutoverAllowed).toBe(false);
  });

  it("S2E2-T16. readiness refuses cutover while an enabled unsignable row remains", async () => {
    const o = org("t16");
    const { id } = await subscription({ orgRef: o });
    const blocked = await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [o] } });
    expect(blocked.webhookData.ready).toBe(false);
    expect(blocked.webhookData.counts).toMatchObject({ enabledUnsignable: 1, enabledLegacyOnly: 0, noEnabledLegacyDependence: true });
    expect(blocked.webhookData.blockers.some(b => /cannot sign/.test(b))).toBe(true);
    expect(blocked.webhookData.enabledUnresolvable).toEqual([{ subscriptionRef: expect.stringMatching(/^WH-/), status: "active", storage: "none", refusal: "unsignable" }]);
    expect(blocked.cutoverAllowed).toBe(false);

    // Pausing it removes the dependence; the row itself is left for an operator to decide about.
    await pool.execute("UPDATE webhookSubscriptions SET status = 'paused' WHERE id = ?", [id]);
    const paused = await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [o] } });
    expect(paused.webhookData.ready).toBe(true);
    expect(paused.webhookData.counts.invalidBothNull).toBe(1);
  });

  it("existing canonical references that do not resolve are reported by category, enabled or not", async () => {
    const report = await webhookCutoverPreflight({ keys: wrongPurposeKeys, legacyKey: LEGACY, scope: { orgRefs: [dirty] } });
    expect(report.existingCanonicalSecrets.resolvable).toBe(false);
    expect(report.existingCanonicalSecrets.checked).toBe(3);
    expect(report.existingCanonicalSecrets.unresolvable.map(u => [u.status, u.storage, u.refusal]).sort()).toEqual([
      ["active", "transitional", "missing_or_wrong_purpose"], // broken reference
      ["active", "transitional", "missing_or_wrong_purpose"], // wrong purpose — indistinguishable by design
      ["paused", "transitional", "disabled"], //                 disabled secret, on a paused row: still reported
    ]);
    // The enabled view sees the enabled damage only, plus the corrupt legacy row and the both-null row.
    expect(report.webhookData.enabledUnresolvable.map(u => u.refusal).sort()).toEqual([
      "legacy_undecryptable", // corrupt legacy ciphertext
      "missing_or_wrong_purpose",
      "missing_or_wrong_purpose",
      "unsignable",
    ]);
    expect(report.blockers.some(b => /existing canonical secrets: 3 reference/.test(b))).toBe(true);
  });

  it("nothing in the report is a secret, an envelope, a reference or key material", async () => {
    const report = await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [clean, dirty] } });
    const text = JSON.stringify(report);
    for (const f of fixtures) if (f.secret) expect(text).not.toContain(f.secret);
    expect(text).not.toContain("sec_");
    expect(text).not.toContain("v1.WEBHOOK_SECRET");
    expect(text).not.toContain(hexKey("7"));
    expect(text).not.toContain(hexKey("8"));
  });

  it("the preflight persists nothing: no secret row is created by asking", async () => {
    const count = async () => Number((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM encryptedSecrets"))[0][0]!.n);
    const n0 = await count();
    await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [clean] } });
    await webhookCutoverPreflight({ keys: envKeys, legacyKey: LEGACY, scope: { orgRefs: [clean] } });
    expect(await count()).toBe(n0);
  });

  it("scaffolding this suite corrupted, this suite removes", async () => {
    const corrupt = fixtures.find(f => f.label.startsWith("corrupt"))!;
    await pool.execute("DELETE FROM webhookSubscriptions WHERE id = ?", [corrupt.id]);
  });
});

d("S2E2-T10/T11 — retry and reclaim re-read the CURRENT canonical reference", () => {
  /*
   * E16/E17 prove the rule on legacy rows. These prove it on canonical ones: the secret changes by
   * the reference being repointed at a new canonical secret — what a future rotation does — and
   * both re-signing paths must follow the reference, not the value they signed with last time.
   */
  it("S2E2-T10. a retry signs under B, not A, and does not re-send the recorded signature", async () => {
    const o = org("t10");
    const s = await subscription({ canonicalSecret: "canonical-A", orgRef: o });
    const eventId = await outboxEvent(o);
    const sent = capture();
    const t1 = new Date("2026-06-01T10:00:00Z");
    await dispatchWebhooks({ orgRef: o, eventIds: [eventId], now: t1 });
    expect(sent.length).toBe(1);

    const b = await createSecret({ purpose: "WEBHOOK_SECRET", plaintext: "canonical-B", keys: envKeys });
    await repoint(s.id, b.secretRef);

    await dispatchWebhooks({ orgRef: o, eventIds: [eventId], now: new Date(t1.getTime() + 5 * 60_000) });
    expect(sent.length).toBe(2);
    const [first, retry] = sent as [Sent, Sent];
    const ts = Number(retry.headers["x-leaseos-timestamp"]);
    const sig = retry.headers["x-leaseos-signature"]!;
    expect(verifySignature("canonical-B", ts, retry.body, sig, new Date(ts * 1000)).valid).toBe(true);
    expect(verifySignature("canonical-A", ts, retry.body, sig, new Date(ts * 1000)).valid).toBe(false);
    expect(sig, "the recorded signature of attempt 1 is not reused").not.toBe(first.headers["x-leaseos-signature"]);

    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT attempt, signature FROM webhookDeliveries WHERE subscriptionId = ? ORDER BY attempt", [s.id]);
    expect(rows.map(r => r.attempt)).toEqual([1, 2]);
    expect(rows[1]!.signature).toBe(sig);
    expect(rows[0]!.signature).not.toBe(sig);
  });

  it("S2E2-T11. a reclaimed attempt signs under B, not A, and the row's recorded signature is replaced", async () => {
    const o = org("t11");
    const s = await subscription({ canonicalSecret: "reclaim-A", orgRef: o });
    const eventId = await outboxEvent(o);
    const died: Sent[] = [];
    setWebhookPoster(async (url, body, headers) => { died.push({ url, body, headers }); throw new Error("worker died"); });
    const t1 = new Date("2026-06-01T10:00:00Z");
    await dispatchWebhooks({ orgRef: o, eventIds: [eventId], now: t1, leaseNow: t1 }).catch(() => undefined);
    const [queued] = await pool.query<mysql.RowDataPacket[]>("SELECT id, status, attempt, signature FROM webhookDeliveries WHERE subscriptionId = ? ORDER BY id DESC LIMIT 1", [s.id]);
    expect(queued[0]?.status).toBe("queued");
    const recordedA = queued[0]!.signature as string;

    const b = await createSecret({ purpose: "WEBHOOK_SECRET", plaintext: "reclaim-B", keys: envKeys });
    await repoint(s.id, b.secretRef);

    const reclaimed = capture();
    await dispatchWebhooks({ orgRef: o, eventIds: [eventId], now: t1, leaseNow: new Date(t1.getTime() + 10 * 60_000) });
    expect(reclaimed.length).toBe(1);
    const r = reclaimed[0]!;
    const ts = Number(r.headers["x-leaseos-timestamp"]);
    const sig = r.headers["x-leaseos-signature"]!;
    expect(verifySignature("reclaim-B", ts, r.body, sig, new Date(ts * 1000)).valid).toBe(true);
    expect(verifySignature("reclaim-A", ts, r.body, sig, new Date(ts * 1000)).valid).toBe(false);
    expect(sig, "the signature recorded under A is not re-sent").not.toBe(recordedA);

    const [after] = await pool.query<mysql.RowDataPacket[]>("SELECT attempt, signature FROM webhookDeliveries WHERE id = ?", [queued[0]!.id]);
    expect(after[0]!.attempt, "the SAME attempt was reclaimed").toBe(queued[0]!.attempt);
    expect(after[0]!.signature, "the stored signature now names the secret that was actually used").toBe(sig);
  });
});

d("S2E2-T12..T14 — the production write, through the real store", () => {
  it("S2E2-T12. an environment provider cannot create a WEBHOOK_SECRET in production, and nothing is written", async () => {
    const count = async () => Number((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM encryptedSecrets"))[0][0]!.n);
    const n0 = await count();
    await expect(createSecret({ purpose: "WEBHOOK_SECRET", plaintext: "x", keys: envKeys, isProduction: true })).rejects.toThrow(/managed key provider/);
    expect(await count()).toBe(n0);
    const report = await webhookCutoverPreflightFromEnvironment(process.env, { orgRefs: [org("none")] });
    expect(report.managedKeyProvider).toMatchObject({ ready: false, kind: "environment", activeWebhookKeyId: "webhook-v1" });
    expect(report.productionCanonicalWrite).toMatchObject({ possible: false, reason: expect.stringMatching(/managed key provider/) });
  });

  it("S2E2-T13. a managed provider creates a canonical WEBHOOK_SECRET in production that the resolver reads back without the legacy key", async () => {
    const { secretRef, keyId } = await createSecret({ purpose: "WEBHOOK_SECRET", plaintext: "fresh-production-secret", keys: managed, isProduction: true });
    expect(secretRef).toMatch(/^sec_/);
    expect(keyId).toBe("webhook-v1");
    const described = (await describeSecret(secretRef))!;
    expect(described).toMatchObject({ purpose: "WEBHOOK_SECRET", keyId: "webhook-v1", status: "active" });
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT envelope FROM encryptedSecrets WHERE secretRef = ?", [secretRef]);
    expect(String(row[0]!.envelope)).toMatch(/^v1\.WEBHOOK_SECRET\.webhook-v1\./);
    // A canonical-only row, read as production would read it: managed provider, no legacy key at all.
    expect(await resolveWebhookSigningSecret({ secretEnc: null, secretRef }, { keys: managed, legacyKey: null, isProduction: true })).toBe("fresh-production-secret");
  });

  it("S2E2-T14. a managed provider with no active WEBHOOK_SECRET key fails closed", async () => {
    const noWebhook = managedFake({ MFA_SECRET: { keyId: "mfa-v1", hex: hexKey("9") } });
    await expect(createSecret({ purpose: "WEBHOOK_SECRET", plaintext: "x", keys: noWebhook, isProduction: true })).rejects.toThrow(/no active key configured for WEBHOOK_SECRET/);
    const report = await webhookCutoverPreflight({ keys: noWebhook, legacyKey: LEGACY, scope: { orgRefs: [org("none")] } });
    expect(report.managedKeyProvider).toMatchObject({ ready: false, kind: "managed", activeWebhookKeyId: null, blockers: ["no active WEBHOOK_SECRET key is configured"] });
    expect(report.productionCanonicalWrite.possible).toBe(false);
  });
});

d("S2E2-T17 — fleet convergence cannot be silently assumed", () => {
  it("with every other component ready, the preflight still refuses, for the fleet alone", async () => {
    const o = org("t17");
    await subscription({ legacySecret: "will-migrate", orgRef: o });
    await subscription({ legacySecret: "legacy-paused", status: "paused", orgRef: o });
    await migrateWebhookSecrets({ ...K, batchSize: 50 });

    const report = await webhookCutoverPreflight({ keys: managed, legacyKey: LEGACY, scope: { orgRefs: [o] } });

    expect(report.webhookData.ready, "data is ready").toBe(true);
    expect(report.managedKeyProvider, "provider is ready").toMatchObject({ ready: true, kind: "managed", activeWebhookKeyId: "webhook-v1" });
    expect(report.existingCanonicalSecrets, "references resolve").toMatchObject({ resolvable: true, checked: 2, unresolvable: [] });
    expect(report.productionCanonicalWrite, "the write is possible").toEqual({ possible: true, keyId: "webhook-v1" });

    expect(report.fleet.state).toBe("not_provable");
    expect(report.cutoverAllowed).toBe(false);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatch(/^fleet convergence not provable:/);
  });

  it("the verdict is derived from the components and is never a stored field", async () => {
    const report = await webhookCutoverPreflight({ keys: envKeys, legacyKey: LEGACY, scope: { orgRefs: [org("none")] } });
    const independentlyReady = report.fleet.state === "compatible" && report.webhookData.ready && report.managedKeyProvider.ready && report.existingCanonicalSecrets.resolvable && report.productionCanonicalWrite.possible;
    expect(report.cutoverAllowed).toBe(independentlyReady);
    expect(report.cutoverAllowed).toBe(report.blockers.length === 0);
    expect(Object.keys(report).sort()).toEqual(["blockers", "cutoverAllowed", "existingCanonicalSecrets", "fleet", "managedKeyProvider", "productionCanonicalWrite", "webhookData"]);
  });
});
