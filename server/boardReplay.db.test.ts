/**
 * 0182 — a retried post is one post, and both acknowledgement clocks are kept.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, count, member, org, rnd, rows } from "./boardFixtures";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const NOW = () => new Date();

d("replay identity", () => {
  it("answers the same device mutation with the message it already wrote, and writes nothing", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const c = await callerFor(disp).board.createChannel({ type: "road_conditions", name: `R ${rnd()}` });
    const key = { channelRef: c.channelRef, body: "KM 42 washed out", deviceCreatedAt: new Date(Date.now() - 3_600_000), deviceId: `TAB-${rnd()}`, clientMutationId: `m-${rnd()}` };
    const first = await callerFor(disp).board.post(key);
    const again = await callerFor(disp).board.post(key);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.messageRef).toBe(first.messageRef);
    expect(await count(pool, "SELECT COUNT(*) AS n FROM boardMessages WHERE channelRef = ?", [c.channelRef])).toBe(1);
    // A different mutation from the same device is a second message.
    const other = await callerFor(disp).board.post({ ...key, clientMutationId: `m-${rnd()}` });
    expect(other.messageRef).not.toBe(first.messageRef);
    expect(await count(pool, "SELECT COUNT(*) AS n FROM boardMessages WHERE channelRef = ?", [c.channelRef])).toBe(2);
  });

  it("refuses a device's mutation id reused by somebody else", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const c = await callerFor(disp).board.createChannel({ type: "dispatch", name: `D ${rnd()}` });
    const key = { channelRef: c.channelRef, body: "x", deviceCreatedAt: NOW(), deviceId: `TAB-${rnd()}`, clientMutationId: `m-${rnd()}` };
    await callerFor(disp).board.post(key);
    await expect(callerFor(drv).board.post(key)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

d("acknowledgement", () => {
  it("records once, keeps the device clock beside the server's, and does not move on a second acknowledgement", async () => {
    const a = await org(pool);
    const safety = await member(pool, a, ["safety"]);
    const drv = await member(pool, a, ["driver"]);
    const c = await callerFor(safety).board.createChannel({ type: "safety", name: `S ${rnd()}` });
    const m = await callerFor(safety).board.post({ channelRef: c.channelRef, body: "Do not use Unit 318", priority: "urgent", deviceCreatedAt: NOW(), recipients: [drv] });
    const onDevice = new Date(Date.now() - 2 * 3_600_000);   // acknowledged offline two hours ago
    const first = await callerFor(drv).board.acknowledge({ messageRef: m.messageRef, deviceAcknowledgedAt: onDevice });
    expect(first.note).toBe("Acknowledged.");
    const r1 = (await rows(pool, "SELECT acknowledgedAt, deviceAcknowledgedAt FROM messageReceipts WHERE messageRef = ? AND userId = ?", [m.messageRef, drv]))[0]!;
    expect(Math.abs(new Date(r1.deviceAcknowledgedAt).getTime() - onDevice.getTime())).toBeLessThan(2000);
    // The server's stamp is the server's: not the device's two-hours-ago.
    expect(new Date(r1.acknowledgedAt).getTime()).toBeGreaterThan(onDevice.getTime() + 3_600_000);

    const again = await callerFor(drv).board.acknowledge({ messageRef: m.messageRef, deviceAcknowledgedAt: NOW() });
    expect(again.note).toBe("Already acknowledged.");
    const r2 = (await rows(pool, "SELECT acknowledgedAt, deviceAcknowledgedAt FROM messageReceipts WHERE messageRef = ? AND userId = ?", [m.messageRef, drv]))[0]!;
    expect(new Date(r2.acknowledgedAt).getTime()).toBe(new Date(r1.acknowledgedAt).getTime());
    expect(new Date(r2.deviceAcknowledgedAt).getTime()).toBe(new Date(r1.deviceAcknowledgedAt).getTime());
    // One acknowledged event, not two.
    expect(await count(pool, "SELECT COUNT(*) AS n FROM domainEventOutbox WHERE aggregateType = 'boardMessage' AND aggregateId = ? AND eventType = 'message.acknowledged'", [m.messageRef])).toBe(1);
  });

  it("gives another organization's person no receipt to acknowledge", async () => {
    const a = await org(pool), b = await org(pool);
    const safety = await member(pool, a, ["safety"]);
    const drv = await member(pool, a, ["driver"]);
    const stranger = await member(pool, b, ["driver"]);
    const c = await callerFor(safety).board.createChannel({ type: "safety", name: `S ${rnd()}` });
    const m = await callerFor(safety).board.post({ channelRef: c.channelRef, body: "bulletin", priority: "urgent", deviceCreatedAt: NOW(), recipients: [drv] });
    await expect(callerFor(stranger).board.acknowledge({ messageRef: m.messageRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
