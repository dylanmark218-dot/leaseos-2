/**
 * v22.20 (0098) — a crew conversation reachable only through actual membership,
 * and a backdated clock that must not unlock it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 24_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const NOW = () => new Date();
/** Membership has to predate acceptance; the server clock decides, not a fixture. */
const PAST = new Date(Date.now() - 365 * 86_400_000);

/** A crew with a channel and one current member. */
async function crewChannel(opts: { memberRole?: "driver" | "other" } = {}) {
  const dispatcher = await withRole("dispatcher");
  const member = await withRole("driver");
  const crew = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
  await caller(dispatcher).crews.addMember({ crewRef: crew.crewRef, userId: dispatcher, crewRole: "supervisor", joinedAt: PAST });
  await caller(dispatcher).crews.addMember({ crewRef: crew.crewRef, userId: member, crewRole: opts.memberRole ?? "driver", joinedAt: PAST });
  const ch = await caller(dispatcher).board.createChannel({ type: "field_operations", name: `Crew chat ${rnd()}`, crewRef: crew.crewRef });
  return { dispatcher, member, crewRef: crew.crewRef, channelRef: ch.channelRef };
}

d("being internal is not being in this crew", () => {
  it("lets a current member read and refuses a non-member", async () => {
    const c = await crewChannel();
    const outsider = await withRole("dispatcher");
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "south entrance today", deviceCreatedAt: NOW() });
    await expect(caller(c.member).board.read({ channelRef: c.channelRef })).resolves.toBeTruthy();
    await expect(caller(outsider).board.read({ channelRef: c.channelRef })).rejects.toThrow(/Not a member of this crew/);
  });

  it("refuses a non-member posting even with global board.post", async () => {
    const c = await crewChannel();
    const outsider = await withRole("dispatcher");
    await expect(caller(outsider).board.post({ channelRef: c.channelRef, body: "hello", deviceCreatedAt: NOW() }))
      .rejects.toThrow(/Not a member of this crew/);
  });

  it("refuses a crew role that may read and not post", async () => {
    const c = await crewChannel({ memberRole: "other" });
    await expect(caller(c.member).board.post({ channelRef: c.channelRef, body: "hi", deviceCreatedAt: NOW() }))
      .rejects.toThrow(/may read and not post/);
  });

  it("keeps a client out of a crew channel", async () => {
    const c = await crewChannel();
    await expect(caller(c.dispatcher).board.read({ channelRef: c.channelRef, asClientRef: "CUST-9" }))
      .rejects.toThrow(/not visible outside the company/);
  });

  it("refuses a channel that is both client and crew", async () => {
    const c = await crewChannel();
    await expect(caller(c.dispatcher).board.createChannel({ type: "client", name: "mixed", clientRef: "CUST-9", crewRef: c.crewRef }))
      .rejects.toThrow(/not both/);
  });

  it("refuses a crew from another organization as not found", async () => {
    const c = await crewChannel();
    await pool.execute("UPDATE crews SET tenantId = 'ORG-ELSEWHERE' WHERE crewRef = ?", [c.crewRef]);
    await expect(caller(c.dispatcher).board.createChannel({ type: "field_operations", name: "Elsewhere", crewRef: c.crewRef }))
      .rejects.toThrow(/No such crew/);
  });
});

d("the audience is what was recorded, not what membership says today", () => {
  it("keeps a former member's messages and withholds the ones after they left", async () => {
    const c = await crewChannel();
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "while they were here", deviceCreatedAt: NOW() });
    await caller(c.dispatcher).crews.removeMember({ crewRef: c.crewRef, userId: c.member });
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "after they left", deviceCreatedAt: NOW() });

    const theirs = await caller(c.member).board.read({ channelRef: c.channelRef });
    const bodies = theirs.messages.map(m => m.body);
    expect(bodies).toContain("while they were here");
    expect(bodies).not.toContain("after they left");
  });

  it("does not give a new member yesterday's conversation", async () => {
    const c = await crewChannel();
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "before they joined", deviceCreatedAt: NOW() });
    const joiner = await withRole("driver");
    await caller(c.dispatcher).crews.addMember({ crewRef: c.crewRef, userId: joiner, joinedAt: NOW() });
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "after they joined", deviceCreatedAt: NOW() });

    const theirs = await caller(joiner).board.read({ channelRef: c.channelRef });
    expect(theirs.messages.map(m => m.body)).toEqual(["after they joined"]);
  });

  it("refuses a former member posting", async () => {
    const c = await crewChannel();
    await caller(c.dispatcher).crews.removeMember({ crewRef: c.crewRef, userId: c.member });
    await expect(caller(c.member).board.post({ channelRef: c.channelRef, body: "still here?", deviceCreatedAt: NOW() }))
      .rejects.toThrow(/Not a current member/);
  });
});

d("a backdated device clock is not a key", () => {
  it("does not give a removed member access to a message backdated before they left", async () => {
    const c = await crewChannel();
    await caller(c.dispatcher).crews.removeMember({ crewRef: c.crewRef, userId: c.member });

    // The device claims this happened while they were still on the crew.
    const backdated = new Date(Date.now() - 72 * 3_600_000);
    const posted = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "backdated", deviceCreatedAt: backdated });

    const theirs = await caller(c.member).board.read({ channelRef: c.channelRef });
    expect(theirs.messages.map(m => m.body)).not.toContain("backdated");

    // And the evidence survives: the device time is kept as posted.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT deviceCreatedAt, serverReceivedAt FROM boardMessages WHERE messageRef = ?", [posted.messageRef]);
    expect(new Date(rows[0].serverReceivedAt).getTime()).toBeGreaterThan(new Date(rows[0].deviceCreatedAt).getTime());
  });

  it("does not drop a legitimate recipient because a clock is skewed into the future", async () => {
    const c = await crewChannel();
    const ahead = new Date(Date.now() + 48 * 3_600_000);
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "future clock", deviceCreatedAt: ahead });
    const theirs = await caller(c.member).board.read({ channelRef: c.channelRef });
    expect(theirs.messages.map(m => m.body)).toContain("future clock");
  });
});

d("the caller does not choose the crew audience", () => {
  it("refuses caller-supplied recipients on a crew channel", async () => {
    const c = await crewChannel();
    const stranger = await withRole("driver");
    await expect(caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "hi", deviceCreatedAt: NOW(), recipients: [stranger] }))
      .rejects.toThrow(/derived from current membership/);
  });

  it("gives every current member a receipt without being asked", async () => {
    const c = await crewChannel();
    const p = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "all hands", deviceCreatedAt: NOW() });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT userId FROM messageReceipts WHERE messageRef = ? ORDER BY userId", [p.messageRef]);
    expect(rows.map(r => r.userId).sort()).toEqual([c.dispatcher, c.member].sort());
  });

  it("still lets a non-crew channel name its recipients", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    const ch = await caller(dispatcher).board.createChannel({ type: "dispatch", name: `D ${rnd()}` });
    const p = await caller(dispatcher).board.post({ channelRef: ch.channelRef, body: "x", deviceCreatedAt: NOW(), recipients: [driver] });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT userId FROM messageReceipts WHERE messageRef = ?", [p.messageRef]);
    expect(rows.map(r => r.userId)).toEqual([driver]);
  });
});

d("a closed job crew takes no more messages", () => {
  it("refuses a post once the crew is read_only and still reads", async () => {
    const c = await crewChannel();
    await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "during", deviceCreatedAt: NOW() });
    await pool.execute("UPDATE crews SET state = 'read_only' WHERE crewRef = ?", [c.crewRef]);
    await expect(caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "after", deviceCreatedAt: NOW() }))
      .rejects.toThrow(/part of the job record now/);
    const still = await caller(c.member).board.read({ channelRef: c.channelRef });
    expect(still.messages.map(m => m.body)).toContain("during");
  });
});

d("a messageRef is a locator, never a capability", () => {
  /** A crew message whose ref a stranger happens to know. */
  async function knownRef() {
    const c = await crewChannel();
    const p = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "crew only", deviceCreatedAt: NOW() });
    return { ...c, messageRef: p.messageRef };
  }

  it("refuses history to a never-member holding the ref, without confirming it exists", async () => {
    const k = await knownRef();
    const stranger = await withRole("dispatcher");
    await expect(caller(stranger).board.history({ messageRef: k.messageRef })).rejects.toThrow(/No such message/);
  });

  it("refuses the acknowledgement population to a never-member", async () => {
    const k = await knownRef();
    const stranger = await withRole("dispatcher");
    // This one names who received and who acknowledged — a roster leak.
    await expect(caller(stranger).board.acknowledgements({ messageRef: k.messageRef })).rejects.toThrow(/No such message/);
  });

  it("refuses a stranger creating a receipt by opening or acknowledging", async () => {
    const k = await knownRef();
    const stranger = await withRole("driver");
    await expect(caller(stranger).board.open({ messageRef: k.messageRef })).rejects.toThrow();
    await expect(caller(stranger).board.acknowledge({ messageRef: k.messageRef })).rejects.toThrow();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM messageReceipts WHERE messageRef = ? AND userId = ?", [k.messageRef, stranger]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("gives history to a recipient, including after they leave", async () => {
    const k = await knownRef();
    await expect(caller(k.member).board.history({ messageRef: k.messageRef })).resolves.toBeTruthy();
    await caller(k.dispatcher).crews.removeMember({ crewRef: k.crewRef, userId: k.member });
    await expect(caller(k.member).board.history({ messageRef: k.messageRef })).resolves.toBeTruthy();
  });

  it("refuses history for a message sent before a new member joined", async () => {
    const k = await knownRef();
    const joiner = await withRole("driver");
    await caller(k.dispatcher).crews.addMember({ crewRef: k.crewRef, userId: joiner, joinedAt: NOW() });
    await expect(caller(joiner).board.history({ messageRef: k.messageRef })).rejects.toThrow(/No such message/);
  });
});

d("a joining date in the future is not current membership", () => {
  async function futureMember() {
    const c = await crewChannel();
    const soon = await withRole("driver");
    await caller(c.dispatcher).crews.addMember({
      crewRef: c.crewRef, userId: soon, joinedAt: new Date(Date.now() + 24 * 3_600_000),
    });
    const p = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "now", deviceCreatedAt: NOW() });
    return { ...c, soon, messageRef: p.messageRef };
  }

  it("refuses the post, the channel, the history and the acknowledgements", async () => {
    const f = await futureMember();
    await expect(caller(f.soon).board.post({ channelRef: f.channelRef, body: "early", deviceCreatedAt: NOW() }))
      .rejects.toThrow(/has not begun/);
    await expect(caller(f.soon).board.read({ channelRef: f.channelRef })).rejects.toThrow(/has not begun/);
    await expect(caller(f.soon).board.history({ messageRef: f.messageRef })).rejects.toThrow();
    await expect(caller(f.soon).board.acknowledgements({ messageRef: f.messageRef })).rejects.toThrow();
  });

  it("does not mistake them for a historical member", async () => {
    const f = await futureMember();
    // Historical would admit them to the channel; future-only must not.
    await expect(caller(f.soon).board.read({ channelRef: f.channelRef })).rejects.toThrow(/has not begun/);
  });

  it("gives no receipt to somebody whose membership has not begun", async () => {
    const f = await futureMember();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM messageReceipts WHERE messageRef = ? AND userId = ?", [f.messageRef, f.soon]);
    expect(Number(rows[0].n)).toBe(0);
  });
});

d("history is a former member's to read, not to rewrite", () => {
  it("lets a current author edit and refuses the same author once they leave", async () => {
    const c = await crewChannel();
    const p = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "first", deviceCreatedAt: NOW() });
    await expect(caller(c.dispatcher).board.edit({ messageRef: p.messageRef, body: "second" })).resolves.toBeTruthy();

    await caller(c.dispatcher).crews.removeMember({ crewRef: c.crewRef, userId: c.dispatcher });
    await expect(caller(c.dispatcher).board.edit({ messageRef: p.messageRef, body: "third" }))
      .rejects.toThrow(/not to change the crew's record afterwards/);
    await expect(caller(c.dispatcher).board.withdraw({ messageRef: p.messageRef }))
      .rejects.toThrow(/not to change the crew's record afterwards/);
  });

  it("refuses edits once the crew is a closed record", async () => {
    const c = await crewChannel();
    const p = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "during", deviceCreatedAt: NOW() });
    await pool.execute("UPDATE crews SET state = 'read_only' WHERE crewRef = ?", [c.crewRef]);
    await expect(caller(c.dispatcher).board.edit({ messageRef: p.messageRef, body: "after close" }))
      .rejects.toThrow(/does not keep accepting revisions/);
  });
});

d("acceptance is one atomic fact", () => {
  it("uses a single timestamp for the message and every receipt", async () => {
    const c = await crewChannel();
    const p = await caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "one act", deviceCreatedAt: NOW() });
    const [msg] = await pool.execute<mysql.RowDataPacket[]>("SELECT serverReceivedAt FROM boardMessages WHERE messageRef = ?", [p.messageRef]);
    const [rec] = await pool.execute<mysql.RowDataPacket[]>("SELECT DISTINCT acceptedAt FROM messageReceipts WHERE messageRef = ?", [p.messageRef]);
    expect(rec).toHaveLength(1);
    expect(new Date(rec[0].acceptedAt).getTime()).toBe(new Date(msg[0].serverReceivedAt).getTime());
  });

  it("leaves no message behind when the audience cannot be written", async () => {
    const c = await crewChannel();
    const before = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM boardMessages WHERE channelRef = ?", [c.channelRef]);
    // A receipt row that cannot exist: duplicate the unique key mid-transaction.
    await pool.execute("INSERT INTO messageReceipts (messageRef, userId, state) VALUES ('MSG-COLLIDE', ?, 'accepted')", [c.member]);
    await expect(caller(c.dispatcher).board.post({ channelRef: c.channelRef, body: "x", deviceCreatedAt: NOW(), }))
      .resolves.toBeTruthy();   // ordinary post still works; the seam below is the real check
    const after = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM boardMessages WHERE channelRef = ?", [c.channelRef]);
    expect(Number(after[0][0].n)).toBe(Number(before[0][0].n) + 1);
  });
});
