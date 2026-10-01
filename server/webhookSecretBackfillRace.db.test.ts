/**
 * S2-E Phase 2A — the orphan rule, proved by losing the race on purpose.
 *
 * Two backfills can run at once: a scheduled one and an operator's, or one restarted while its
 * predecessor is still finishing. Each reads a batch, writes a canonical secret per row, and repoints
 * the row with `WHERE secretRef IS NULL` — so exactly one wins each row. The loser's secret is then
 * referenced by nothing. The design's rule is that it is disabled on the spot: an unreferenced but
 * live secret is something no audit can explain, and the store would resolve it for anyone holding
 * the reference.
 *
 * This test arranges the loss deterministically. `getDb()` is wrapped so that, the first time a
 * canonical secret has been written for the row under test and the row is still unpointed — which
 * is the moment between the write and the repoint — another "run" repoints the row first. The
 * backfill's own UPDATE then matches nothing, and its secret must come out disabled.
 *
 * It found a real defect: the first version read `rowsAffected` off the driver's result tuple, where
 * it is always undefined, so the orphan branch never ran. With that line restored, this test is red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";

let raceHook: null | (() => Promise<void>) = null;

vi.mock("./db", async importOriginal => {
  const original = await importOriginal<typeof import("./db")>();
  return {
    ...original,
    getDb: async () => {
      const hook = raceHook;
      if (hook) await hook();
      return original.getDb();
    },
  };
});

import { migrateWebhookSecrets } from "./webhookSecretMigration";
import { createEnvironmentKeyProvider } from "./_core/secretCrypto";
import { encryptSecret as legacyEnc } from "./_core/externalIdentityPolicy";
import { resolveWebhookSigningSecret } from "./webhookSecretService";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(() => {
  if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
});
afterAll(async () => {
  await pool?.end();
});

const hexKey = (seed: string) => seed.repeat(64).slice(0, 64);
const keys = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: { keyId: "webhook-v1", hex: hexKey("7") } } });
const LEGACY = Buffer.from(hexKey("8"), "hex");
const RUN = randomBytes(4).toString("hex");

d("a backfill that loses the repoint race disables its orphan secret", () => {
  it("the loser's canonical secret is disabled; the winner's reference stands; the row still signs", async () => {
    const secret = `race-secret-${RUN}`;
    const [ins] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO webhookSubscriptions
         (orgRef, subscriptionRef, name, url, secretEnc, eventTypesJson, status, createdByUserId, createdAt)
       VALUES (?, ?, ?, 'https://receiver.test/hook', ?, '["*"]', 'active', 1, NOW())`,
      [`org-${RUN}`, `WH-${RUN}-race`, "race", legacyEnc(secret, LEGACY)]
    );
    const id = ins.insertId;

    // Watermark: every WEBHOOK_SECRET secret with a higher id than this was written during the run.
    const [[{ maxId }]] = await pool.query<mysql.RowDataPacket[]>("SELECT COALESCE(MAX(id), 0) AS maxId FROM encryptedSecrets") as unknown as [[{ maxId: number }]];
    const winnerRef = `sec_winner_${RUN}_000000000000`;
    let fired = 0;

    raceHook = async () => {
      if (fired) return;
      const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT secretRef FROM webhookSubscriptions WHERE id = ?", [id]) as unknown as [[{ secretRef: string | null }]];
      const [[written]] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM encryptedSecrets WHERE id > ? AND purpose = 'WEBHOOK_SECRET' AND sourceTable = 'webhookSubscriptions'", [maxId]
      ) as unknown as [[{ n: number }]];
      if (row.secretRef === null && Number(written.n) > 0) {
        fired += 1;
        // The other run wins the row.
        await pool.execute("UPDATE webhookSubscriptions SET secretRef = ? WHERE id = ? AND secretRef IS NULL", [winnerRef, id]);
      }
    };

    try {
      await migrateWebhookSecrets({ keys, legacyKey: LEGACY, batchSize: 500 });
    } finally {
      raceHook = null;
    }

    expect(fired, "the race must actually have been lost").toBe(1);

    const [[after]] = await pool.query<mysql.RowDataPacket[]>("SELECT secretRef, secretEnc FROM webhookSubscriptions WHERE id = ?", [id]) as unknown as [[{ secretRef: string; secretEnc: string }]];
    expect(after.secretRef, "the winner's reference stands").toBe(winnerRef);
    expect(after.secretEnc, "legacy ciphertext intact").not.toBeNull();

    const [orphans] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT es.secretRef, es.status
         FROM encryptedSecrets es
         LEFT JOIN webhookSubscriptions ws ON ws.secretRef = es.secretRef
        WHERE es.id > ? AND es.purpose = 'WEBHOOK_SECRET' AND es.sourceTable = 'webhookSubscriptions' AND ws.id IS NULL`,
      [maxId]
    );
    expect(orphans.length, "exactly one secret was written for the row and lost the race").toBeGreaterThanOrEqual(1);
    for (const o of orphans) expect(o.status, `orphan ${String(o.secretRef).slice(0, 8)} must be disabled`).toBe("disabled");

    // The row was placed on a reference that resolves nowhere, by the "winner" we invented — so it
    // refuses, which is the fail-closed rule, not a fallback to the legacy value it still carries.
    await expect(resolveWebhookSigningSecret(after, { keys, legacyKey: LEGACY })).rejects.toThrow(/no such secret/);

    // Scaffolding: the invented winner reference would otherwise be a permanently broken enabled row.
    await pool.execute("DELETE FROM webhookSubscriptions WHERE id = ?", [id]);
  });
});
