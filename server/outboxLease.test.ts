/**
 * v22.20 (0089) — what the drain worker does when things go wrong.
 *
 * Each of these fails against the previous implementation, which is the point:
 * a crashed worker owned its event forever, a retry did not wait, and a dead
 * letter was represented by a claim that never cleared.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { CLAIM_LEASE_SECONDS, createWorkerPorts } from "./_core/workflowRuntime";


const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const rnd = () => Math.random().toString(36).slice(2, 10).toUpperCase();

async function anEvent(over: Record<string, string | null> = {}) {
  const eventId = `EVT-${rnd()}`;
  await pool.execute(
    `INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, actorSource, payloadJson, occurredAt)
     VALUES (?, 'test.event', 1, 'testAggregate', ?, 'default', 'system', '{}', NOW())`,
    [eventId, `AGG-${rnd()}`]);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT id FROM domainEventOutbox WHERE eventId = ?", [eventId]);
  const id = Number(rows[0].id);
  for (const [col, val] of Object.entries(over)) {
    await pool.execute(`UPDATE domainEventOutbox SET ${col} = ${val === null ? "NULL" : "?"} WHERE id = ?`, val === null ? [id] : [val, id]);
  }
  return { id, eventId };
}
/**
 * Whether a real claim would offer this event. A claim takes up to 50 events from the whole outbox,
 * which other suites share, and nothing here processes them: left claimed they would sit behind the
 * lease (CLAIM_LEASE_SECONDS) where no worker could take them. So every claim taken here is released.
 */
const claimable = async (id: number, workerId: string) => {
  const got = await createWorkerPorts(pool as never).claimBatch(workerId, 50);
  const ids = got.map((e: { id: number }) => e.id);
  if (ids.length) {
    await pool.query(
      `UPDATE domainEventOutbox SET claimedAt = NULL, claimedBy = NULL, attemptCount = GREATEST(attemptCount - 1, 0)
        WHERE claimedBy = ? AND id IN (${ids.map(() => "?").join(",")})`, [workerId, ...ids]);
  }
  return ids.includes(id);
};

d("a crashed worker eventually loses its event", () => {
  it("does not offer an event whose claim is still fresh", async () => {
    const { id } = await anEvent();
    await pool.execute("UPDATE domainEventOutbox SET claimedAt = NOW(), claimedBy = 'worker-dead' WHERE id = ?", [id]);
    expect(await claimable(id, "worker-b")).toBe(false);
  });

  it("offers it once the lease has expired — this is the crash recovery", async () => {
    const { id } = await anEvent();
    await pool.execute(
      "UPDATE domainEventOutbox SET claimedAt = DATE_SUB(NOW(), INTERVAL ? SECOND), claimedBy = 'worker-dead' WHERE id = ?",
      [CLAIM_LEASE_SECONDS + 30, id]);
    expect(await claimable(id, "worker-b")).toBe(true);
  });

  it("never offers a processed event, however old its claim", async () => {
    const { id } = await anEvent();
    await pool.execute(
      "UPDATE domainEventOutbox SET processedAt = NOW(), claimedAt = DATE_SUB(NOW(), INTERVAL 3600 SECOND) WHERE id = ?", [id]);
    expect(await claimable(id, "worker-b")).toBe(false);
  });
});

d("a failed event waits", () => {
  it("is not offered before its retry time and is offered after", async () => {
    const { id } = await anEvent();
    await pool.execute("UPDATE domainEventOutbox SET retryAvailableAt = DATE_ADD(NOW(), INTERVAL 300 SECOND) WHERE id = ?", [id]);
    expect(await claimable(id, "worker-a")).toBe(false);
    await pool.execute("UPDATE domainEventOutbox SET retryAvailableAt = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?", [id]);
    expect(await claimable(id, "worker-a")).toBe(true);
  });

  it("persists the backoff the classifier computed, instead of discarding it", async () => {
    const { id } = await anEvent();
    const ports = createWorkerPorts(pool as never);
    // `classifyFailure` returns "failed" for a retryable attempt; there is no "retry" status. The old
    // value fell through the same branch as "failed" — markFailed only special-cases dead_letter —
    // so the assertions held, while the test described a state that cannot occur. If that branch
    // ever grew an explicit default, this would have quietly started testing something else.
    await ports.markFailed(id, { status: "failed", reason: "upstream timeout", retryAfterMs: 60_000 });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT claimedAt, claimedBy, lastError, retryAvailableAt, TIMESTAMPDIFF(SECOND, NOW(), retryAvailableAt) AS waitS FROM domainEventOutbox WHERE id = ?", [id]);
    expect(rows[0].claimedAt).toBeNull();
    expect(rows[0].claimedBy).toBeNull();
    expect(rows[0].lastError).toBe("upstream timeout");
    expect(Number(rows[0].waitS)).toBeGreaterThan(50);
    expect(await claimable(id, "worker-a")).toBe(false);
  });
});

d("a dead letter says it is one", () => {
  it("records the state and the reason rather than leaving a claim stuck", async () => {
    const { id } = await anEvent();
    const ports = createWorkerPorts(pool as never);
    await ports.markFailed(id, { status: "dead_letter", reason: "payload cannot be parsed", retryAfterMs: null });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT deadLetteredAt, deadLetterReason, claimedAt, claimedBy FROM domainEventOutbox WHERE id = ?", [id]);
    expect(rows[0].deadLetteredAt).toBeTruthy();
    expect(rows[0].deadLetterReason).toBe("payload cannot be parsed");
    // The old shape kept the claim to stop it circulating — which the lease
    // would now expire, putting a poison event back into rotation.
    expect(rows[0].claimedAt).toBeNull();
    expect(rows[0].claimedBy).toBeNull();
  });

  it("is never claimed again, even long after any lease would have expired", async () => {
    const { id } = await anEvent();
    const ports = createWorkerPorts(pool as never);
    await ports.markFailed(id, { status: "dead_letter", reason: "terminal", retryAfterMs: null });
    await pool.execute("UPDATE domainEventOutbox SET deadLetteredAt = DATE_SUB(NOW(), INTERVAL 7 DAY) WHERE id = ?", [id]);
    expect(await claimable(id, "worker-b")).toBe(false);
  });
});

d("two workers do not both get the same event", () => {
  it("hands a claimable event to exactly one of two concurrent claimers", async () => {
    const { id } = await anEvent();
    const [a, b] = await Promise.all([
      createWorkerPorts(pool as never).claimBatch("worker-a", 50),
      createWorkerPorts(pool as never).claimBatch("worker-b", 50),
    ]);
    const holders = [a, b].filter(batch => batch.some((e: { id: number }) => e.id === id)).length;
    expect(holders).toBe(1);
  });
});
