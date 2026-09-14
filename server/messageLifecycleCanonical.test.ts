/**
 * v22.20 (0097) — one receipt vocabulary, and edits that append.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

describe("there is exactly one receipt vocabulary", () => {
  const board = readFileSync("server/_core/messageBoard.ts", "utf8");
  const lifecycle = readFileSync("server/_core/messageLifecycle.ts", "utf8");
  const router = readFileSync("server/messageBoardRouter.ts", "utf8");

  it("declares receipt states in the lifecycle and nowhere else", () => {
    expect(lifecycle).toContain("export type ReceiptState");
    // The board re-exports; it does not define a second set of values.
    expect(board).not.toMatch(/export type DeliveryState\s*=\s*"/);
    expect(board).not.toMatch(/export type Receipt = \{/);
  });

  it("has no translation between two receipt models in the router", () => {
    expect(router).not.toContain("BoardDeliveryState");
    // The shape of the old mapping: a state name rewritten to another vocabulary.
    expect(router).not.toMatch(/"opened"\s*\?\s*"read"/);
    expect(router).not.toMatch(/===\s*"actioned".*\?\s*"acknowledged"/);
  });

  it("summarises acknowledgement from evidence timestamps, not from the state name", () => {
    const fn = board.slice(board.indexOf("export function acknowledgementStatus"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("r.at.acknowledged");
    expect(body).toContain("r.at.delivered");
    // A receipt at `resolved` was acknowledged on the way; asking the state
    // name would need a lossy map to find that out.
    expect(body).not.toMatch(/state === "acknowledged"/);
  });

  it("moves receipts through one adapter rather than per-resolver writes", () => {
    expect(router).toContain("async function advanceReceipt");
    const writes = router.match(/set\(\{\s*state:/g) ?? [];
    expect(writes.length).toBeLessThanOrEqual(1);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 20_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

async function bulletin(priority: "normal" | "urgent" = "urgent") {
  const safety = await withRole("safety");
  const driver = await withRole("driver");
  const c = await caller(safety).board.createChannel({ type: "safety", name: `S ${rnd()}` });
  const m = await caller(safety).board.post({
    channelRef: c.channelRef, body: "Do not use Unit 318", priority,
    deviceCreatedAt: new Date(), recipients: [driver],
  });
  return { safety, driver, channelRef: c.channelRef, messageRef: m.messageRef };
}

d("the server records what it witnessed and nothing else", () => {
  it("stamps acceptance at the server's own time, not the device's", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const c = await caller(safety).board.createChannel({ type: "safety", name: `S ${rnd()}` });
    const onDevice = new Date(Date.now() - 2 * 3_600_000);
    const m = await caller(safety).board.post({ channelRef: c.channelRef, body: "x", deviceCreatedAt: onDevice, recipients: [driver] });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT acceptedAt, deliveredAt, openedAt FROM messageReceipts WHERE messageRef = ?", [m.messageRef]);
    expect(rows[0].acceptedAt).toBeTruthy();
    expect(new Date(rows[0].acceptedAt).getTime()).toBeGreaterThan(onDevice.getTime() + 3_600_000);
    // Nothing witnessed delivery or opening yet.
    expect(rows[0].deliveredAt).toBeNull();
    expect(rows[0].openedAt).toBeNull();
  });

  it("still shows the sender Sent, not Delivered, on server acceptance", async () => {
    const b = await bulletin();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT state FROM messageReceipts WHERE messageRef = ?", [b.messageRef]);
    expect(rows[0].state).toBe("accepted");
  });

  it("fills delivery no earlier than the open that proved it", async () => {
    const b = await bulletin();
    const openedAt = new Date();
    await caller(b.driver).board.open({ messageRef: b.messageRef, at: openedAt });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT deliveredAt, openedAt FROM messageReceipts WHERE messageRef = ?", [b.messageRef]);
    // Opening proves it arrived; it does not prove it arrived earlier.
    expect(new Date(rows[0].deliveredAt).getTime()).toBe(new Date(rows[0].openedAt).getTime());
  });

  it("does not move a timestamp later when an older event retries", async () => {
    const b = await bulletin();
    const first = new Date();
    await caller(b.driver).board.open({ messageRef: b.messageRef, at: first });
    await caller(b.driver).board.open({ messageRef: b.messageRef, at: new Date(first.getTime() + 60_000) });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT openedAt FROM messageReceipts WHERE messageRef = ?", [b.messageRef]);
    expect(Math.abs(new Date(rows[0].openedAt).getTime() - first.getTime())).toBeLessThan(2000);
  });

  it("is idempotent on acknowledgement and cannot regress to opened", async () => {
    const b = await bulletin();
    await caller(b.driver).board.acknowledge({ messageRef: b.messageRef });
    const again = await caller(b.driver).board.acknowledge({ messageRef: b.messageRef });
    expect(again.note).toContain("Already acknowledged");
    const back = await caller(b.driver).board.open({ messageRef: b.messageRef });
    expect(back.state).toBe("acknowledged");
    expect(back.note).toContain("does not go backwards");
  });

  it("survives two concurrent opens with exactly one state", async () => {
    const b = await bulletin();
    await Promise.allSettled([
      caller(b.driver).board.open({ messageRef: b.messageRef }),
      caller(b.driver).board.open({ messageRef: b.messageRef }),
    ]);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT state FROM messageReceipts WHERE messageRef = ?", [b.messageRef]);
    expect(rows).toHaveLength(1);
    expect(["opened", "acknowledged"]).toContain(rows[0].state);
  });

  it("reports acknowledged from the timestamp even once the state has moved past it", async () => {
    const b = await bulletin();
    await caller(b.driver).board.acknowledge({ messageRef: b.messageRef });
    await pool.execute("UPDATE messageReceipts SET state = 'resolved', resolvedAt = NOW() WHERE messageRef = ?", [b.messageRef]);
    const s = await caller(b.safety).board.acknowledgements({ messageRef: b.messageRef });
    expect(s.acknowledged).toEqual([b.driver]);
    expect(s.outstanding).toBe(false);
  });
});

d("edits append and withdrawal preserves", () => {
  async function mine() {
    const author = await withRole("dispatcher");
    const c = await caller(author).board.createChannel({ type: "dispatch", name: `D ${rnd()}` });
    const m = await caller(author).board.post({ channelRef: c.channelRef, body: "Use the north access", deviceCreatedAt: new Date() });
    return { author, channelRef: c.channelRef, messageRef: m.messageRef };
  }

  it("keeps the original as revision 1 and appends the edit", async () => {
    const b = await mine();
    const e = await caller(b.author).board.edit({ messageRef: b.messageRef, body: "Use the SOUTH access", reason: "wrong direction" });
    expect(e.revision).toBe(2);
    const h = await caller(b.author).board.history({ messageRef: b.messageRef });
    expect(h.originalBody).toBe("Use the north access");
    expect(h.currentBody).toBe("Use the SOUTH access");
    expect(h.edited).toBe(true);
    expect(h.revisionCount).toBe(2);
  });

  it("produces revision 3 on a second edit", async () => {
    const b = await mine();
    await caller(b.author).board.edit({ messageRef: b.messageRef, body: "second" });
    const third = await caller(b.author).board.edit({ messageRef: b.messageRef, body: "third" });
    expect(third.revision).toBe(3);
    const h = await caller(b.author).board.history({ messageRef: b.messageRef });
    expect(h.revisions.map(r => r.body)).toEqual(["Use the north access", "second", "third"]);
  });

  it("does not change either clock when edited", async () => {
    const b = await mine();
    const before = await caller(b.author).board.history({ messageRef: b.messageRef });
    await caller(b.author).board.edit({ messageRef: b.messageRef, body: "changed" });
    const after = await caller(b.author).board.history({ messageRef: b.messageRef });
    expect(after.deviceCreatedAt.getTime()).toBe(before.deviceCreatedAt.getTime());
    expect(after.serverReceivedAt!.getTime()).toBe(before.serverReceivedAt!.getTime());
  });

  it("withdraws without erasing anything", async () => {
    const b = await mine();
    await caller(b.author).board.edit({ messageRef: b.messageRef, body: "second" });
    await caller(b.author).board.withdraw({ messageRef: b.messageRef });
    const h = await caller(b.author).board.history({ messageRef: b.messageRef });
    expect(h.currentBody).toBeNull();
    expect(h.originalBody).toBe("Use the north access");
    expect(h.revisionCount).toBe(2);
    expect(h.withdrawnAt).toBeTruthy();
  });

  it("refuses to edit a withdrawn message", async () => {
    const b = await mine();
    await caller(b.author).board.withdraw({ messageRef: b.messageRef });
    await expect(caller(b.author).board.edit({ messageRef: b.messageRef, body: "sneaky" })).rejects.toThrow(/is withdrawn/);
  });

  it("refuses somebody else's message even with posting rights", async () => {
    const b = await mine();
    const other = await withRole("dispatcher");
    await expect(caller(other).board.edit({ messageRef: b.messageRef, body: "not mine" }))
      .rejects.toThrow(/Only the author edits their own message/);
    await expect(caller(other).board.withdraw({ messageRef: b.messageRef }))
      .rejects.toThrow(/Moderation|separate authority/);
  });

  it("refuses another organization's message", async () => {
    const b = await mine();
    await pool.execute("UPDATE messageChannels SET tenantId = 'ORG-ELSEWHERE' WHERE channelRef = ?", [b.channelRef]);
    // "No such channel" told the caller their message existed and had moved.
    // Every messageRef refusal now says the same thing, so possessing a
    // reference distinguishes nothing.
    await expect(caller(b.author).board.history({ messageRef: b.messageRef })).rejects.toThrow(/No such message/);
  });
});

describe("revision 1 is constructed in exactly one place", () => {
  /**
   * The original body is stored once, in `boardMessages.body`. Turning it into
   * the canonical revision shape was written out in four resolvers, which is
   * the "two writable originals" hazard in a different coat — four
   * constructions are four chances for history to disagree about what was first
   * said. One constructor, and this test fails if a second appears.
   */
  it("has no hand-built revision-1 literal in the router", () => {
    const router = readFileSync("server/messageBoardRouter.ts", "utf8");
    const handBuilt = router.match(/revision:\s*1\s*,/g) ?? [];
    // The single constructor is allowed; anything beyond it is a second origin.
    expect(handBuilt).toHaveLength(1);
    expect(router).toContain("function originalRevision(");
  });

  it("derives the original from the stored message rather than a revisions row", () => {
    const router = readFileSync("server/messageBoardRouter.ts", "utf8");
    const ctor = router.slice(router.indexOf("function originalRevision("));
    const body = ctor.slice(0, ctor.indexOf("}"));
    expect(body).toContain("message.body");
    expect(body).not.toContain("messageRevisions");
  });
});
