/**
 * 0205 — publishing is not posting.
 *
 * An emergency, or anything in an announcement channel, needs `board.publish`; `board.post` alone
 * is refused. An emergency writes a channel event and an outbox row in the same transaction as the
 * message, and an announcement with nobody to acknowledge it is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, member, org, rnd, rows } from "./boardFixtures";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const NOW = () => new Date();

d("emergency and announcement need the publish authority", () => {
  it("refuses a driver's emergency in a dispatch channel and lets safety publish it, with the event and the outbox row", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const safety = await member(pool, a, ["safety"]);
    const c = await callerFor(disp).board.createChannel({ type: "dispatch", name: `D ${rnd()}` });
    await expect(callerFor(drv).board.post({ channelRef: c.channelRef, body: "fire at the lease", priority: "emergency", deviceCreatedAt: NOW(), recipients: [disp] }))
      .rejects.toThrow(/takes board.publish/);
    const m = await callerFor(safety).board.post({ channelRef: c.channelRef, body: "Stop work — fire at the lease", priority: "emergency", deviceCreatedAt: NOW(), recipients: [disp, drv] });
    expect(m.requiresAcknowledgement).toBe(true);
    const ev = await rows(pool, "SELECT eventType FROM messageChannelEvents WHERE channelRef = ? AND messageRef = ?", [c.channelRef, m.messageRef]);
    expect(ev.map(e => e.eventType)).toEqual(["emergency_posted"]);
    const out = await rows(pool, "SELECT eventType, payloadJson FROM domainEventOutbox WHERE aggregateType = 'boardMessage' AND aggregateId = ?", [m.messageRef]);
    expect(out).toHaveLength(1);
    expect(out[0]!.eventType).toBe("message.critical.created");
    const payload = JSON.parse(String(out[0]!.payloadJson));
    expect(payload.recipientUserIds.sort()).toEqual([disp, drv].sort());
    // Never the body.
    expect(String(out[0]!.payloadJson)).not.toContain("fire at the lease");
  });

  it("refuses a driver's post into an announcement channel whatever its priority", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const c = await callerFor(disp).board.createChannel({ type: "announcement", name: `All hands ${rnd()}` });
    await expect(callerFor(drv).board.post({ channelRef: c.channelRef, body: "hi all", deviceCreatedAt: NOW(), recipients: [disp] })).rejects.toThrow(/publishing/);
  });

  it("resolves an announcement's audience from the organization when none is named, and refuses the single tenant's silence", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const one = await member(pool, a, ["driver"]);
    const two = await member(pool, a, ["driver"]);
    const c = await callerFor(disp).board.createChannel({ type: "announcement", name: `All hands ${rnd()}` });
    const m = await callerFor(disp).board.post({ channelRef: c.channelRef, body: "Safety stand-down Friday", priority: "urgent", deviceCreatedAt: NOW() });
    const receipts = await rows(pool, "SELECT userId FROM messageReceipts WHERE messageRef = ?", [m.messageRef]);
    expect(receipts.map(r => Number(r.userId)).sort()).toEqual([disp, one, two].sort());
    const status = await callerFor(disp).board.acknowledgements({ messageRef: m.messageRef });
    expect(status.required).toBe(true);
    expect(status.outstanding).toBe(true);

    // The historical single tenant has no membership table to resolve an audience from.
    const legacy = await member(pool, null, ["dispatcher"]);
    const lc = await callerFor(legacy).board.createChannel({ type: "announcement", name: `Legacy ${rnd()}` });
    await expect(callerFor(legacy).board.post({ channelRef: lc.channelRef, body: "hello?", deviceCreatedAt: NOW() })).rejects.toThrow(/no roll-call/);
  });

  it("refuses a recipient from another organization by name", async () => {
    const a = await org(pool), b = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const stranger = await member(pool, b, ["driver"]);
    const c = await callerFor(disp).board.createChannel({ type: "safety", name: `S ${rnd()}` });
    await expect(callerFor(disp).board.post({ channelRef: c.channelRef, body: "for you", deviceCreatedAt: NOW(), recipients: [stranger] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
