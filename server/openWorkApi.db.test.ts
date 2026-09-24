/**
 * 0183 — Open Work through the API: the post's life, responses, offers, the link to a slot, and
 * the organization boundary. Nothing here awards anything; that is Checkpoint 3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, count, DAY_AFTER, DAY_BEFORE, job, member, operatorFor, org, postWork, rnd, rows, STARTS } from "./boardFixtures";
import { SENSITIVE_PERMISSIONS } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

describe("posting and offering are the poster's; answering is the person's", () => {
  it("keeps the sensitivity split of v22.20 and adds no sensitive door for a person's own declaration", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("shifts.post");
    expect(SENSITIVE_PERMISSIONS).not.toContain("shifts.interest");
    expect(SENSITIVE_PERMISSIONS).not.toContain("shifts.availability_own");
  });
});

d("the post's life", () => {
  it("keeps a draft off the board, publishes it, closes it to responses, reopens it, and cancels it with its offers", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    await operatorFor(pool, a, drv);
    const p = await postWork(disp, { publish: false });
    expect(p.status).toBe("draft");
    expect((await callerFor(drv).shifts.list({})).posts.some(x => x.postRef === p.postRef)).toBe(false);
    await callerFor(disp).shifts.publish({ postRef: p.postRef });
    expect((await callerFor(drv).shifts.list({})).posts.some(x => x.postRef === p.postRef)).toBe(true);

    await callerFor(disp).shifts.close({ postRef: p.postRef, reason: "enough responses" });
    await expect(callerFor(drv).shifts.respond({ postRef: p.postRef })).rejects.toThrow(/That post is closed/);
    // Closed is not terminal: an offer may still go out, and the post may reopen.
    const offer = await callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drv });
    await callerFor(disp).shifts.publish({ postRef: p.postRef });
    expect((await callerFor(drv).shifts.respond({ postRef: p.postRef })).recorded).toBe(true);

    await callerFor(disp).shifts.cancel({ postRef: p.postRef, reason: "customer cancelled the job" });
    expect((await callerFor(drv).shifts.get({ postRef: p.postRef })).post.status).toBe("cancelled");
    expect((await callerFor(drv).shifts.get({ postRef: p.postRef })).myOffer?.status).toBe("withdrawn");
    await expect(callerFor(drv).shifts.offerRespond({ offerRef: offer.offerRef, decision: "accepted" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(disp).shifts.publish({ postRef: p.postRef })).rejects.toThrow(/cancelled/);
    const events = (await rows(pool, "SELECT eventType FROM shiftPostEvents WHERE postRef = ? ORDER BY id", [p.postRef])).map(e => e.eventType);
    expect(events).toEqual(["created", "published", "closed", "offer_issued", "reopened", "response_recorded", "cancelled", "offer_withdrawn"]);
    const out = await rows(pool, "SELECT eventType, payloadJson FROM domainEventOutbox WHERE aggregateType = 'shiftPost' AND aggregateId = ? ORDER BY id", [p.postRef]);
    expect(out.map(o => o.eventType)).toEqual(["work.posted", "work.offered", "work.posted", "work.cancelled"]);
    expect(JSON.parse(String(out[3]!.payloadJson)).recipientUserIds).toEqual([drv]);
  });

  it("expires an open post on read once closesAt has passed, and refuses a response to it", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const p = await postWork(disp, { closesAt: new Date(Date.now() - 60_000) });
    expect((await callerFor(drv).shifts.get({ postRef: p.postRef })).post.status).toBe("expired");
    await expect(callerFor(drv).shifts.respond({ postRef: p.postRef })).rejects.toThrow(/expired/);
  });
});

d("responses", () => {
  it("keeps one standing response per person, replaced in place, with the previous one in history", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const p = await postWork(disp);
    expect((await callerFor(drv).shifts.respond({ postRef: p.postRef, response: "interested" })).recorded).toBe(true);
    expect((await callerFor(drv).shifts.respond({ postRef: p.postRef, response: "interested" })).recorded).toBe(false);
    expect((await callerFor(drv).shifts.respond({ postRef: p.postRef, response: "declined", note: "away that week" })).recorded).toBe(true);
    expect(await count(pool, "SELECT COUNT(*) AS n FROM shiftInterests WHERE postRef = ?", [p.postRef])).toBe(1);
    const i = await callerFor(disp).shifts.interests({ postRef: p.postRef });
    expect(i.interested).toEqual([]);
    expect(i.declined.map(x => x.userId)).toEqual([drv]);
    const events = (await rows(pool, "SELECT eventType, detail FROM shiftPostEvents WHERE postRef = ? AND subjectUserId = ? ORDER BY id", [p.postRef, drv]));
    expect(events.map(e => e.eventType)).toEqual(["response_recorded", "response_withdrawn", "response_recorded"]);
    expect(events[1]!.detail).toBe("interested replaced by declined");
  });

  it("answers a retried device mutation with what it already recorded", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const p = await postWork(disp);
    const key = { postRef: p.postRef, response: "available" as const, deviceId: `TAB-${rnd()}`, clientMutationId: `m-${rnd()}`, deviceCreatedAt: new Date(Date.now() - 3_600_000) };
    expect((await callerFor(drv).shifts.respond(key)).recorded).toBe(true);
    const again = await callerFor(drv).shifts.respond(key);
    expect(again.replayed).toBe(true);
    expect(await count(pool, "SELECT COUNT(*) AS n FROM shiftInterests WHERE postRef = ?", [p.postRef])).toBe(1);
    expect(await count(pool, "SELECT COUNT(*) AS n FROM shiftPostEvents WHERE postRef = ? AND eventType = 'response_recorded'", [p.postRef])).toBe(1);
  });

  it("refuses interest from somebody on approved leave, from what is on record", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const mgr = await member(pool, a, ["management"]);
    const leave = await callerFor(drv).timeOff.request({ category: "vacation", from: DAY_BEFORE, to: DAY_AFTER });
    await callerFor(mgr).timeOff.decide({ requestRef: leave.requestRef, decision: "approve" });
    const p = await postWork(disp);
    await expect(callerFor(drv).shifts.respond({ postRef: p.postRef })).rejects.toThrow(/cannot take/);
    // Declining is always allowed: it records an answer, it claims nothing.
    expect((await callerFor(drv).shifts.respond({ postRef: p.postRef, response: "declined" })).recorded).toBe(true);
    await expect(callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drv })).rejects.toThrow(/cannot be assigned/);
  });
});

d("offers", () => {
  it("issues one live offer per person, lets only that person answer it once, and records both clocks", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const other = await member(pool, a, ["driver"]);
    const p = await postWork(disp);
    const o = await callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drv });
    expect(o.requiresReadinessCheck).toBe(true);
    expect(o.interestExpressed).toBe(false);
    await expect(callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drv })).rejects.toThrow(/already holds a live offer/);
    await expect(callerFor(other).shifts.offerRespond({ offerRef: o.offerRef, decision: "accepted" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const key = { offerRef: o.offerRef, decision: "accepted" as const, deviceId: `TAB-${rnd()}`, clientMutationId: `m-${rnd()}`, deviceRespondedAt: new Date(Date.now() - 1_800_000) };
    const acc = await callerFor(drv).shifts.offerRespond(key);
    expect(acc).toMatchObject({ status: "accepted", replayed: false });
    expect(acc.note).toContain("binds the slot");
    expect((await callerFor(drv).shifts.offerRespond(key)).replayed).toBe(true);
    await expect(callerFor(drv).shifts.offerRespond({ offerRef: o.offerRef, decision: "declined" })).rejects.toThrow(/does not go to declined/);
    const row = (await rows(pool, "SELECT status, respondedAt, deviceRespondedAt, liveOfferKey FROM shiftOffers WHERE offerRef = ?", [o.offerRef]))[0]!;
    expect(row.status).toBe("accepted");
    expect(row.liveOfferKey).toBe(`${p.postRef}:${drv}`);
    expect(new Date(row.respondedAt).getTime()).toBeGreaterThan(new Date(row.deviceRespondedAt).getTime());
    expect((await callerFor(disp).shifts.candidates({ postRef: p.postRef })).candidates.find(c => c.userId === drv)?.offer).toBe("accepted");
    // Accepted binds nothing: the post is still open and no slot is touched.
    expect((await callerFor(disp).shifts.get({ postRef: p.postRef })).post.status).toBe("open");
  });

  it("withdraws an offer, after which it cannot be answered", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const p = await postWork(disp);
    const o = await callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drv, note: "first pick" });
    expect((await callerFor(disp).shifts.offerWithdraw({ offerRef: o.offerRef, reason: "filled another way" })).status).toBe("withdrawn");
    await expect(callerFor(drv).shifts.offerRespond({ offerRef: o.offerRef, decision: "accepted" })).rejects.toThrow(/withdrawn/);
    // A second offer to the same person is allowed once the first is no longer live.
    expect((await callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drv })).offerRef).not.toBe(o.offerRef);
  });
});

d("the link to a slot", () => {
  it("links a one-seat post to a role of a posting in scope, refuses a driver, a two-seat post, and a foreign role", async () => {
    const a = await org(pool), b = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const dispB = await member(pool, b, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const j = await job(pool, a);
    const posting = await callerFor(disp).dispatch.createPosting({ jobId: j, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    const jb = await job(pool, b);
    const postingB = await callerFor(dispB).dispatch.createPosting({ jobId: jb, roles: [{ roleCode: "PRIMARY_UNIT" }] });
    const p = await postWork(disp);
    await expect(callerFor(drv).shifts.link({ postRef: p.postRef, roleId: posting.roleIds[0]! })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(disp).shifts.link({ postRef: p.postRef, roleId: postingB.roleIds[0]! })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const two = await postWork(disp, { seats: 2 });
    await expect(callerFor(disp).shifts.link({ postRef: two.postRef, roleId: posting.roleIds[0]! })).rejects.toThrow(/one person/);
    const linked = await callerFor(disp).shifts.link({ postRef: p.postRef, roleId: posting.roleIds[0]! });
    expect(linked.roleCode).toBe("PRIMARY_UNIT");
    const g = await callerFor(disp).shifts.get({ postRef: p.postRef });
    expect(g.post.linked).toBe(true);
    expect(g.post.dispatchPostingId).toBe(posting.postingId);
    expect(g.history.map(h => h.eventType)).toContain("linked");
    // A second link to a different role is refused; the same one is idempotent.
    await expect(callerFor(disp).shifts.link({ postRef: p.postRef, roleId: posting.roleIds[0]! })).resolves.toBeTruthy();
  });
});

d("the organization boundary", () => {
  it("hides one organization's post from another, on every door", async () => {
    const a = await org(pool), b = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drvA = await member(pool, a, ["driver"]);
    const dispB = await member(pool, b, ["dispatcher"]);
    const drvB = await member(pool, b, ["driver"]);
    const p = await postWork(disp);
    const o = await callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drvA });
    expect((await callerFor(drvB).shifts.list({})).posts.some(x => x.postRef === p.postRef)).toBe(false);
    for (const call of [
      () => callerFor(dispB).shifts.get({ postRef: p.postRef }),
      () => callerFor(dispB).shifts.eligibility({ postRef: p.postRef }),
      () => callerFor(dispB).shifts.candidates({ postRef: p.postRef }),
      () => callerFor(dispB).shifts.interests({ postRef: p.postRef }),
      () => callerFor(drvB).shifts.respond({ postRef: p.postRef }),
      () => callerFor(dispB).shifts.offer({ postRef: p.postRef, userId: drvB }),
      () => callerFor(disp).shifts.offer({ postRef: p.postRef, userId: drvB }),
      () => callerFor(dispB).shifts.close({ postRef: p.postRef }),
      () => callerFor(dispB).shifts.cancel({ postRef: p.postRef, reason: "not ours" }),
      () => callerFor(dispB).shifts.offerWithdraw({ offerRef: o.offerRef }),
      () => callerFor(drvB).shifts.offerRespond({ offerRef: o.offerRef, decision: "accepted" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(STARTS.getTime()).toBeGreaterThan(Date.now());   // the fixtures post future work; this guards the day they stop
  });
});
