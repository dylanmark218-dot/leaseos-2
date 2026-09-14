import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

/**
 * Award concurrency, against a real database.
 *
 * These assert the thing that cannot be proven by unit tests: that MySQL's
 * locking actually serialises two dispatchers awarding the same resource in
 * the same moment. `decideAward` being correct is necessary and not
 * sufficient — the guarantee lives in the transaction.
 *
 * Skipped when DATABASE_URL is absent so the pure suite stays runnable.
 */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 8 });
});

const iso = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 8, 1, h, m))
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

async function seedPosting(postingNumber: string) {
  await pool.execute(
    "INSERT INTO dispatchPostings (postingNumber, jobId, planningState, priority, crewSize) VALUES (?,?,?,?,?)",
    [postingNumber, 1, "awarding", "normal", 1]
  );
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM dispatchPostings WHERE postingNumber = ?",
    [postingNumber]
  );
  return rows[0].id as number;
}

/**
 * The award's critical section, reduced to its concurrency-relevant parts:
 * lock the posting, re-check overlap INSIDE the lock, then book. Checking
 * before the lock is the time-of-check/time-of-use race this proves is closed.
 */
async function attemptAward(opts: {
  postingId: number;
  resourceRef: string;
  startsAt: string;
  endsAt: string;
  delayMs?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      "SELECT id FROM dispatchPostings WHERE id = ? FOR UPDATE",
      [opts.postingId]
    );

    // Widen the window between check and write — a naive implementation fails here.
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));

    const [conflicts] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM resourceBookings
       WHERE resourceRef = ? AND bookingState IN ('tentative','confirmed')
         AND startsAt < ? AND endsAt > ?`,
      [opts.resourceRef, opts.endsAt, opts.startsAt]
    );
    if (conflicts.length > 0) {
      await conn.rollback();
      return { ok: false, reason: "resource conflict" };
    }

    await conn.execute(
      `INSERT INTO resourceBookings (resourceType, resourceRef, postingId, jobId, startsAt, endsAt, bookingState)
       VALUES ('unit', ?, ?, 1, ?, ?, 'confirmed')`,
      [opts.resourceRef, opts.postingId, opts.startsAt, opts.endsAt]
    );
    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback();
    return { ok: false, reason: (e as Error).message };
  } finally {
    conn.release();
  }
}

d("award concurrency", () => {
  it("produces exactly one winner when two dispatchers award simultaneously", async () => {
    const postingId = await seedPosting(`P-SIM-${Date.now()}`);
    const unit = `VAC-SIM-${Date.now()}`;

    // Genuinely parallel, not sequential awaits.
    const [a, b] = await Promise.all([
      attemptAward({
        postingId,
        resourceRef: unit,
        startsAt: iso(6),
        endsAt: iso(16),
        delayMs: 120,
      }),
      attemptAward({
        postingId,
        resourceRef: unit,
        startsAt: iso(6),
        endsAt: iso(16),
        delayMs: 120,
      }),
    ]);

    const winners = [a, b].filter(r => r.ok);
    expect(winners).toHaveLength(1);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM resourceBookings WHERE resourceRef = ?",
      [unit]
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses a second job reserving the same truck over an overlapping window", async () => {
    const unit = `VAC-OVL-${Date.now()}`;
    const p1 = await seedPosting(`P-OVL-A-${Date.now()}`);
    const p2 = await seedPosting(`P-OVL-B-${Date.now()}`);

    const first = await attemptAward({
      postingId: p1,
      resourceRef: unit,
      startsAt: iso(6),
      endsAt: iso(16),
    });
    const second = await attemptAward({
      postingId: p2,
      resourceRef: unit,
      startsAt: iso(14),
      endsAt: iso(18),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("resource conflict");
  });

  it("allows back-to-back work where one job ends exactly as the next begins", async () => {
    const unit = `VAC-B2B-${Date.now()}`;
    const p1 = await seedPosting(`P-B2B-A-${Date.now()}`);
    const p2 = await seedPosting(`P-B2B-B-${Date.now()}`);

    const first = await attemptAward({
      postingId: p1,
      resourceRef: unit,
      startsAt: iso(6),
      endsAt: iso(16),
    });
    const second = await attemptAward({
      postingId: p2,
      resourceRef: unit,
      startsAt: iso(16),
      endsAt: iso(20),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("does not cross-report conflicts between different units", async () => {
    const p1 = await seedPosting(`P-DIFF-A-${Date.now()}`);
    const p2 = await seedPosting(`P-DIFF-B-${Date.now()}`);
    const a = await attemptAward({
      postingId: p1,
      resourceRef: `VAC-X-${Date.now()}`,
      startsAt: iso(6),
      endsAt: iso(16),
    });
    const b = await attemptAward({
      postingId: p2,
      resourceRef: `VAC-Y-${Date.now()}`,
      startsAt: iso(6),
      endsAt: iso(16),
    });
    expect(a.ok && b.ok).toBe(true);
  });

  it("holds under four simultaneous attempts, not just two", async () => {
    const postingId = await seedPosting(`P-QUAD-${Date.now()}`);
    const unit = `VAC-QUAD-${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        attemptAward({
          postingId,
          resourceRef: unit,
          startsAt: iso(6),
          endsAt: iso(16),
          delayMs: 90,
        })
      )
    );
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });
});

d("migration integrity", () => {
  it("created every table the schema declares", async () => {
    // Derived, not hardcoded — a literal here goes stale the moment a table
    // is added, and a test that needs editing on every change gets edited
    // carelessly. This asserts real parity instead.
    const declared = (
      readFileSync("drizzle/schema.ts", "utf8").match(/mysqlTable\(/g) ?? []
    ).length;
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    expect(rows[0].n).toBe(declared);
  });

  it("enforces the unique constraint on tracking numbers", async () => {
    const n = `TR-DUP-${Date.now()}`;
    await pool.execute(
      "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, issuedAt) VALUES (?,?,?,NOW())",
      [n, "trip", 1]
    );
    await expect(
      pool.execute(
        "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, issuedAt) VALUES (?,?,?,NOW())",
        [n, "trip", 2]
      )
    ).rejects.toThrow();
  });

  it("rejects a value outside an enum rather than silently coercing it", async () => {
    await expect(
      pool.execute(
        "INSERT INTO dispatchPostings (postingNumber, jobId, planningState) VALUES (?,?,?)",
        [`P-BAD-${Date.now()}`, 1, "not_a_real_state"]
      )
    ).rejects.toThrow();
  });
});
