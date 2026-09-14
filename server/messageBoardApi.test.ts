/**
 * v22.20 (0096) — the board, the client who must not read it, and the two clocks.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("creating a channel is sensitive; posting in one is not", () => {
  it("fails closed on channel management only", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("board.manage");
    expect(SENSITIVE_PERMISSIONS).not.toContain("board.post");
    expect(SENSITIVE_PERMISSIONS).not.toContain("board.read");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 19_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const NOW = () => new Date();

d("a client channel is separated, not filtered", () => {
  it("refuses an outside viewer every internal channel", async () => {
    const dispatcher = await withRole("dispatcher");
    for (const type of ["dispatch", "safety", "maintenance", "general"] as const) {
      const c = await caller(dispatcher).board.createChannel({ type, name: `${type} ${rnd()}` });
      await expect(caller(dispatcher).board.read({ channelRef: c.channelRef, asClientRef: "CUST-9" }))
        .rejects.toThrow(/not visible outside the company/);
    }
  });

  it("lets a client into their own channel and not another client's", async () => {
    const dispatcher = await withRole("dispatcher");
    const mine = await caller(dispatcher).board.createChannel({ type: "client", name: "Client 9", clientRef: "CUST-9" });
    await expect(caller(dispatcher).board.read({ channelRef: mine.channelRef, asClientRef: "CUST-9" })).resolves.toBeTruthy();
    await expect(caller(dispatcher).board.read({ channelRef: mine.channelRef, asClientRef: "CUST-8" }))
      .rejects.toThrow(/different client/);
  });

  it("refuses a client channel that names no client", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(caller(dispatcher).board.createChannel({ type: "client", name: "nameless" }))
      .rejects.toThrow(/must name its client/);
  });

  it("does not reach another organization's channel", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).board.createChannel({ type: "general", name: `G ${rnd()}` });
    await pool.execute("UPDATE messageChannels SET tenantId = 'ORG-ELSEWHERE' WHERE channelRef = ?", [c.channelRef]);
    await expect(caller(dispatcher).board.read({ channelRef: c.channelRef })).rejects.toThrow(/No such channel/);
  });
});

d("both clocks survive", () => {
  it("keeps the device time and stamps the server's beside it", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).board.createChannel({ type: "road_conditions", name: `Roads ${rnd()}` });
    const onDevice = new Date(Date.now() - 3 * 3_600_000);   // recorded three hours ago
    const posted = await caller(dispatcher).board.post({
      channelRef: c.channelRef, body: "KM 42 washed out", deviceCreatedAt: onDevice, deviceId: "TAB-9",
    });
    expect(posted.lagSeconds).toBeGreaterThan(10_000);
    expect(posted.note).toContain("before it reached the server");

    const read = await caller(dispatcher).board.read({ channelRef: c.channelRef });
    const m = read.messages[0];
    expect(Math.abs(m.deviceCreatedAt.getTime() - onDevice.getTime())).toBeLessThan(2000);
    expect(m.serverReceivedAt!.getTime()).toBeGreaterThan(m.deviceCreatedAt.getTime());
    expect(read.note).toContain("they are different facts");
  });

  it("shows the sender Sent rather than Delivered when the server has it", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).board.createChannel({ type: "dispatch", name: `D ${rnd()}` });
    const p = await caller(dispatcher).board.post({ channelRef: c.channelRef, body: "copy", deviceCreatedAt: NOW() });
    expect(p.senderLabel).toBe("Sent");
    expect(p.senderLabel).not.toBe("Delivered");
  });
});

d("urgency is derived, and reading is not acknowledging", () => {
  async function bulletin(priority: "normal" | "urgent") {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const c = await caller(safety).board.createChannel({ type: "safety", name: `S ${rnd()}` });
    const m = await caller(safety).board.post({
      channelRef: c.channelRef, body: "Do not use Unit 318", priority, deviceCreatedAt: NOW(), recipients: [driver],
    });
    return { safety, driver, channelRef: c.channelRef, messageRef: m.messageRef, requires: m.requiresAcknowledgement };
  }

  it("requires acknowledgement for urgent and not for normal, whatever the poster wanted", async () => {
    expect((await bulletin("urgent")).requires).toBe(true);
    expect((await bulletin("normal")).requires).toBe(false);
  });

  it("counts opening separately from acknowledging", async () => {
    const b = await bulletin("urgent");
    await caller(b.driver).board.open({ messageRef: b.messageRef });
    const mid = await caller(b.safety).board.acknowledgements({ messageRef: b.messageRef });
    expect(mid.acknowledged).toEqual([]);
    expect(mid.readNotAcknowledged).toEqual([b.driver]);
    expect(mid.outstanding).toBe(true);

    await caller(b.driver).board.acknowledge({ messageRef: b.messageRef });
    const done = await caller(b.safety).board.acknowledgements({ messageRef: b.messageRef });
    expect(done.acknowledged).toEqual([b.driver]);
    expect(done.outstanding).toBe(false);
  });

  it("does not move a receipt backwards", async () => {
    const b = await bulletin("urgent");
    await caller(b.driver).board.acknowledge({ messageRef: b.messageRef });
    const back = await caller(b.driver).board.open({ messageRef: b.messageRef });
    expect(back.note).toContain("does not go backwards");
  });

  it("gives nobody a receipt they were not sent", async () => {
    const b = await bulletin("urgent");
    const stranger = await withRole("driver");
    await expect(caller(stranger).board.acknowledge({ messageRef: b.messageRef }))
      .rejects.toThrow(/No receipt for this person/);
  });

  it("says plainly when acknowledgement was never required", async () => {
    const b = await bulletin("normal");
    const s = await caller(b.safety).board.acknowledgements({ messageRef: b.messageRef });
    expect(s.line).toContain("(not required)");
  });
});
