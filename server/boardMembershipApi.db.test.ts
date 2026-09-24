/**
 * 0182 — the board with membership, against a real database.
 *
 * What these prove: an explicit channel admits its members and nobody else; management is nobody
 * else; moderation is the one way in and it is recorded; another organization's channel and people
 * are not found; a former member keeps what they were sent and nothing after.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, count, member, org, rnd, rows } from "./boardFixtures";
import { SENSITIVE_PERMISSIONS } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const NOW = () => new Date();

describe("publishing and moderating are sensitive; membership changes ride on posting", () => {
  it("fails closed on the two new authorities and not on the door a group's moderator uses", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("board.publish");
    expect(SENSITIVE_PERMISSIONS).toContain("board.moderate");
    expect(SENSITIVE_PERMISSIONS).not.toContain("board.post");
  });
});

d("an explicit channel admits its members and nobody else", () => {
  it("refuses a non-member on the channel path and hides the message on the message path", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const inside = await member(pool, a, ["driver"]);
    const outside = await member(pool, a, ["driver"]);
    const c = await callerFor(disp).board.createChannel({ type: "group", name: `Night crew ${rnd()}`, members: [{ userId: inside, memberRole: "member" }] });
    expect(c.membershipMode).toBe("explicit");
    const m = await callerFor(inside).board.post({ channelRef: c.channelRef, body: "on my way", deviceCreatedAt: NOW() });
    await expect(callerFor(outside).board.read({ channelRef: c.channelRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(outside).board.history({ messageRef: m.messageRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await callerFor(inside).board.read({ channelRef: c.channelRef })).messages.map(x => x.messageRef)).toEqual([m.messageRef]);
    expect((await callerFor(disp).board.read({ channelRef: c.channelRef })).messages).toHaveLength(1);   // the creator is a moderator member
  });

  it("does not admit management, or board.manage, to a direct channel — and records the one way in", async () => {
    const a = await org(pool);
    const x = await member(pool, a, ["driver"]);
    const y = await member(pool, a, ["driver"]);
    const boss = await member(pool, a, ["management"]);
    const disp = await member(pool, a, ["dispatcher"]);   // holds board.manage
    const dm = await callerFor(x).board.direct({ userId: y });
    expect(dm.created).toBe(true);
    // B asking for A resolves to the same room.
    expect((await callerFor(y).board.direct({ userId: x })).channelRef).toBe(dm.channelRef);
    await callerFor(x).board.post({ channelRef: dm.channelRef, body: "private", deviceCreatedAt: NOW() });
    await expect(callerFor(boss).board.read({ channelRef: dm.channelRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(disp).board.read({ channelRef: dm.channelRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(disp).board.memberAdd({ channelRef: dm.channelRef, userId: disp })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const seen = await callerFor(boss).board.moderateRead({ channelRef: dm.channelRef, reason: "harassment complaint filed 2026-10-20" });
    expect(seen.messages.map(m => m.body)).toEqual(["private"]);
    const ev = await rows(pool, "SELECT eventType, actorUserId, detail FROM messageChannelEvents WHERE channelRef = ? AND eventType = 'moderator_read'", [dm.channelRef]);
    expect(ev).toHaveLength(1);
    expect(Number(ev[0]!.actorUserId)).toBe(boss);
    expect(ev[0]!.detail).toContain("complaint");
    // The members can see that it happened.
    const history = await callerFor(x).board.members({ channelRef: dm.channelRef });
    expect(history.members.map(m => m.userId).sort()).toEqual([x, y].sort());
  });

  it("lets a group's own moderator add and remove members, refuses a plain member, and keeps a leaver's history", async () => {
    const a = await org(pool);
    const lead = await member(pool, a, ["driver"]);
    const one = await member(pool, a, ["driver"]);
    const two = await member(pool, a, ["driver"]);
    const disp = await member(pool, a, ["dispatcher"]);
    const c = await callerFor(disp).board.createChannel({ type: "group", name: `G ${rnd()}`, members: [{ userId: lead, memberRole: "moderator" }, { userId: one, memberRole: "member" }] });
    await expect(callerFor(one).board.memberAdd({ channelRef: c.channelRef, userId: two })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = await callerFor(lead).board.post({ channelRef: c.channelRef, body: "before two joined", deviceCreatedAt: NOW() });
    expect((await callerFor(lead).board.memberAdd({ channelRef: c.channelRef, userId: two })).added).toBe(true);
    const after = await callerFor(lead).board.post({ channelRef: c.channelRef, body: "after", deviceCreatedAt: NOW() });
    // A new member does not inherit the conversation before they joined.
    expect((await callerFor(two).board.read({ channelRef: c.channelRef })).messages.map(m => m.messageRef)).toEqual([after.messageRef]);
    // A leaver keeps what they were sent, and nothing after.
    expect((await callerFor(one).board.memberRemove({ channelRef: c.channelRef, userId: one })).removed).toBe(true);
    const later = await callerFor(lead).board.post({ channelRef: c.channelRef, body: "after one left", deviceCreatedAt: NOW() });
    const oneSees = (await callerFor(one).board.read({ channelRef: c.channelRef })).messages.map(m => m.messageRef);
    expect(oneSees).toContain(before.messageRef);
    expect(oneSees).not.toContain(later.messageRef);
    await expect(callerFor(one).board.post({ channelRef: c.channelRef, body: "still here?", deviceCreatedAt: NOW() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await count(pool, "SELECT COUNT(*) AS n FROM messageChannelEvents WHERE channelRef = ? AND eventType IN ('member_added','member_left')", [c.channelRef])).toBe(5);
  });

  it("lets a read-only member read and not post", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const ro = await member(pool, a, ["driver"]);
    const c = await callerFor(disp).board.createChannel({ type: "department", name: `Ops ${rnd()}`, membershipMode: "explicit", members: [{ userId: ro, memberRole: "read_only" }] });
    await callerFor(disp).board.post({ channelRef: c.channelRef, body: "notice", deviceCreatedAt: NOW() });
    expect((await callerFor(ro).board.read({ channelRef: c.channelRef })).messages).toHaveLength(1);
    await expect(callerFor(ro).board.post({ channelRef: c.channelRef, body: "reply", deviceCreatedAt: NOW() })).rejects.toThrow(/read and not post/);
  });

  it("lists in the inbox only the channels the caller may open", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const open = await callerFor(disp).board.createChannel({ type: "dispatch", name: `D ${rnd()}` });
    const closed = await callerFor(disp).board.createChannel({ type: "group", name: `G ${rnd()}` });
    const refs = (await callerFor(drv).board.mine()).channels.map(c => c.channelRef);
    expect(refs).toContain(open.channelRef);
    expect(refs).not.toContain(closed.channelRef);
  });
});

d("the organization boundary", () => {
  it("does not find another organization's channel, and will not name its people as members", async () => {
    const a = await org(pool), b = await org(pool);
    const dispA = await member(pool, a, ["dispatcher"]);
    const dispB = await member(pool, b, ["dispatcher"]);
    const personB = await member(pool, b, ["driver"]);
    const c = await callerFor(dispA).board.createChannel({ type: "group", name: `G ${rnd()}` });
    await expect(callerFor(dispB).board.read({ channelRef: c.channelRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispB).board.moderateRead({ channelRef: c.channelRef, reason: "cross-organization curiosity" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(dispA).board.memberAdd({ channelRef: c.channelRef, userId: personB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispA).board.direct({ userId: personB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispA).board.createChannel({ type: "group", name: "mixed", members: [{ userId: personB, memberRole: "member" }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
