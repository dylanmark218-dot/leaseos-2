/**
 * Checkpoint 5 — the Board's privacy boundary, names, and the ordinary-message event, against a
 * real database.
 *
 * What these prove beyond the membership suite: the manage authority cannot make itself a member of
 * a private group; a dispatcher does not hold the moderation door; an ordinary employee cannot
 * publish into a safety channel or create one; no Board or open-work input accepts an organization
 * from the caller; authors are shown by the name the directory already holds, fall back to `User N`
 * when there is none, never by an email, and never across organizations; and an ordinary message is
 * a provider-neutral outbox fact that carries no body.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { callerFor, member, nextId, org, rnd, rows } from "./boardFixtures";
import { displayIdentities, displayLabel } from "./boardIdentity";
import { handleClaimedBoardEvent } from "./_core/boardOutbox";
import { getDb } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const NOW = () => new Date();

/** A users row for a fixture person: the directory the names come from. */
async function named(userId: number, name: string | null, email: string | null = null) {
  await pool.execute("INSERT INTO users (id, openId, name, email, loginMethod) VALUES (?,?,?,?,'test')", [userId, `oid-${userId}-${rnd()}`, name, email]);
  return userId;
}

describe("the Board and open work take no organization from the caller", () => {
  it("declares no orgRef, tenantId or organizationId input on any board or shifts procedure", () => {
    for (const file of ["server/messageBoardRouter.ts", "server/openShiftsRouter.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\b(orgRef|tenantId|organizationId)\s*:\s*z\./);
    }
  });
});

d("private conversations stay their members'", () => {
  it("refuses the manage authority's self-invitation to a group, while still letting it name others", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);      // creates the group, and so is in it
    const disp2 = await member(pool, a, ["dispatcher"]);     // board.manage, not in it
    const boss = await member(pool, a, ["management"]);      // board.manage and board.moderate, not in it
    const lead = await member(pool, a, ["driver"]);
    const other = await member(pool, a, ["driver"]);
    const newcomer = await member(pool, a, ["driver"]);
    const g = await callerFor(disp).board.createChannel({ type: "group", name: `Crew ${rnd()}`, members: [{ userId: lead, memberRole: "moderator" }, { userId: other, memberRole: "member" }] });
    await callerFor(lead).board.post({ channelRef: g.channelRef, body: "between us", deviceCreatedAt: NOW() });

    for (const manager of [boss, disp2]) {
      await expect(callerFor(manager).board.read({ channelRef: g.channelRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerFor(manager).board.memberAdd({ channelRef: g.channelRef, userId: manager })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await rows(pool, "SELECT COUNT(*) AS n FROM messageChannelMembers WHERE channelRef = ? AND userId IN (?, ?)", [g.channelRef, boss, disp2]))[0]!.n).toBe(0);

    // Naming somebody else is still a manager's to do, and it does not open the room to the manager.
    const added = await callerFor(disp2).board.memberAdd({ channelRef: g.channelRef, userId: newcomer });
    expect(added.added).toBe(true);
    await expect(callerFor(disp2).board.read({ channelRef: g.channelRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The group's own moderator may bring people in, as before.
    const byLead = await callerFor(lead).board.memberAdd({ channelRef: g.channelRef, userId: await member(pool, a, ["driver"]) });
    expect(byLead.added).toBe(true);
  });

  it("will not open a direct conversation or a group with a person from another organization", async () => {
    const a = await org(pool), b = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const drv = await member(pool, a, ["driver"]);
    const stranger = await member(pool, b, ["driver"]);
    await expect(callerFor(drv).board.direct({ userId: stranger })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(disp).board.createChannel({ type: "group", name: `Mixed ${rnd()}`, members: [{ userId: stranger, memberRole: "member" }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await rows(pool, "SELECT COUNT(*) AS n FROM messageChannelMembers WHERE userId = ?", [stranger]))[0]!.n).toBe(0);
  });

  it("keeps the moderation door shut to a dispatcher", async () => {
    const a = await org(pool);
    const x = await member(pool, a, ["driver"]);
    const y = await member(pool, a, ["driver"]);
    const disp = await member(pool, a, ["dispatcher"]);
    const dm = await callerFor(x).board.direct({ userId: y });
    await callerFor(x).board.post({ channelRef: dm.channelRef, body: "private", deviceCreatedAt: NOW() });
    await expect(callerFor(disp).board.moderateRead({ channelRef: dm.channelRef, reason: "curious about what they said" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rows(pool, "SELECT COUNT(*) AS n FROM messageChannelEvents WHERE channelRef = ? AND eventType = 'moderator_read'", [dm.channelRef]))[0]!.n).toBe(0);
  });

  it("refuses an ordinary employee a safety bulletin and a new channel, and lets safety publish", async () => {
    const a = await org(pool);
    const safety = await member(pool, a, ["safety"]);
    const drv = await member(pool, a, ["driver"]);
    const s = await callerFor(safety).board.createChannel({ type: "safety", name: `Safety ${rnd()}` });
    await expect(callerFor(drv).board.createChannel({ type: "safety", name: `Mine ${rnd()}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(drv).board.post({ channelRef: s.channelRef, body: "all trucks stop", priority: "emergency", deviceCreatedAt: NOW(), recipients: [safety] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(drv).board.post({ channelRef: s.channelRef, body: "all trucks stop", priority: "urgent", deviceCreatedAt: NOW(), recipients: [safety] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Reporting a hazard in the safety channel is still anyone's.
    const report = await callerFor(drv).board.post({ channelRef: s.channelRef, body: "ice on the lease road", deviceCreatedAt: NOW(), recipients: [safety] });
    expect(report.requiresAcknowledgement).toBe(false);
    const ok = await callerFor(safety).board.post({ channelRef: s.channelRef, body: "H2S alarm at 04-12", priority: "emergency", deviceCreatedAt: NOW(), recipients: [drv] });
    expect(ok.requiresAcknowledgement).toBe(true);
  });
});

d("authors by name", () => {
  it("shows the directory's name, the operator record's when the account has none, and User N when neither exists", async () => {
    const a = await org(pool);
    const disp = await named(await member(pool, a, ["dispatcher"]), "Dana Dispatch");
    const noName = await named(await member(pool, a, ["driver"]), null);
    const opId = nextId();
    await pool.execute("INSERT INTO operators (id, userId, name, createdAt) VALUES (?,?,?,NOW())", [opId, noName, "Riley Operator"]);
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [a, opId]);
    const emailOnly = await named(await member(pool, a, ["driver"]), "casey@example.com", "casey@example.com");
    const ghost = await member(pool, a, ["driver"]);           // no users row at all

    const g = await callerFor(disp).board.createChannel({ type: "group", name: `Names ${rnd()}`, members: [noName, emailOnly, ghost].map(userId => ({ userId, memberRole: "member" as const })) });
    for (const who of [disp, noName, emailOnly, ghost]) await callerFor(who).board.post({ channelRef: g.channelRef, body: `from ${who}`, deviceCreatedAt: NOW() });

    const seen = await callerFor(noName).board.read({ channelRef: g.channelRef });
    const labelOf = (u: number) => seen.messages.find(m => m.authorUserId === u)!.authorLabel;
    expect(labelOf(disp)).toBe("Dana Dispatch");
    expect(labelOf(noName)).toBe("Riley Operator");
    expect(labelOf(emailOnly)).toBe(`User ${emailOnly}`);
    expect(labelOf(ghost)).toBe(`User ${ghost}`);
    // Nothing the directory holds beyond the name leaves the server.
    expect(JSON.stringify(seen)).not.toContain("@example.com");

    const listed = await callerFor(noName).board.members({ channelRef: g.channelRef });
    expect(listed.members.find(m => m.userId === noName)!.label).toBe("Riley Operator");
  });

  it("keeps a former member's name, marked, and gives a stable fallback for an account that is gone", async () => {
    const a = await org(pool);
    const disp = await named(await member(pool, a, ["dispatcher"]), "Dana Dispatch");
    const leaver = await named(await member(pool, a, ["driver"]), "Lee Leaver");
    const reader = await member(pool, a, ["driver"]);
    const g = await callerFor(disp).board.createChannel({ type: "group", name: `Former ${rnd()}`, members: [leaver, reader].map(userId => ({ userId, memberRole: "member" as const })) });
    await callerFor(leaver).board.post({ channelRef: g.channelRef, body: "last shift", deviceCreatedAt: NOW() });
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = NOW() WHERE userId = ? AND orgRef = ?", [leaver, a]);
    const once = (await callerFor(reader).board.read({ channelRef: g.channelRef })).messages.find(m => m.authorUserId === leaver)!;
    expect(once).toMatchObject({ authorLabel: "Lee Leaver", authorStanding: "former" });

    await pool.execute("DELETE FROM users WHERE id = ?", [leaver]);
    const twice = (await callerFor(reader).board.read({ channelRef: g.channelRef })).messages.find(m => m.authorUserId === leaver)!;
    expect(twice).toMatchObject({ authorLabel: `User ${leaver}`, authorStanding: "unresolved" });
  });

  it("names nobody across the organization boundary, even through an operator record", async () => {
    const a = await org(pool), b = await org(pool);
    const inA = await named(await member(pool, a, ["driver"]), null);
    const inB = await named(await member(pool, b, ["driver"]), "Bo From B");
    // B's workforce record linked to A's person must not name them for A.
    const opB = nextId();
    await pool.execute("INSERT INTO operators (id, userId, name, createdAt) VALUES (?,?,?,NOW())", [opB, inA, "Named By B"]);
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [b, opB]);
    const d0 = (await getDb())!;
    const seenByA = await displayIdentities(d0, [inA, inB], { tenantId: a });
    expect(seenByA.get(inB)).toEqual({ userId: inB, label: `User ${inB}`, standing: "unresolved" });
    expect(seenByA.get(inA)!.label).toBe(`User ${inA}`);
    // The historical single tenant does not name an organization's person either.
    expect((await displayIdentities(d0, [inB], { tenantId: SINGLE_TENANT_ID })).get(inB)!.label).toBe(`User ${inB}`);
  });
});

describe("the display label", () => {
  it("prefers the account name, then the operator name, and never an email", () => {
    expect(displayLabel(7, { userName: "  Ana   Ruiz ", operatorName: "A. Ruiz" })).toBe("Ana Ruiz");
    expect(displayLabel(7, { userName: "", operatorName: "A. Ruiz" })).toBe("A. Ruiz");
    expect(displayLabel(7, { userName: "ana@x.io", operatorName: null })).toBe("User 7");
    expect(displayLabel(7, {})).toBe("User 7");
  });
});

d("an ordinary message is an outbox fact", () => {
  it("writes message.posted for everyone but the author, with no body, and the in-app consumer notifies each once", async () => {
    const a = await org(pool);
    const disp = await member(pool, a, ["dispatcher"]);
    const one = await member(pool, a, ["driver"]);
    const two = await member(pool, a, ["driver"]);
    const g = await callerFor(disp).board.createChannel({ type: "group", name: `Ev ${rnd()}`, members: [one, two].map(userId => ({ userId, memberRole: "member" as const })) });
    const m = await callerFor(one).board.post({ channelRef: g.channelRef, body: "SECRET-BODY-TEXT gate code", deviceCreatedAt: NOW() });
    const out = await rows(pool, "SELECT eventId, eventType, aggregateId, payloadJson, tenantId FROM domainEventOutbox WHERE aggregateType = 'boardMessage' AND aggregateId = ?", [m.messageRef]);
    expect(out.map(r => r.eventType)).toEqual(["message.posted"]);
    expect(String(out[0]!.payloadJson)).not.toContain("SECRET-BODY-TEXT");
    const payload = JSON.parse(String(out[0]!.payloadJson));
    expect(payload.recipientUserIds.sort()).toEqual([disp, two].sort());

    const d0 = (await getDb())!;
    const args = { eventId: String(out[0]!.eventId), eventType: "message.posted", aggregateId: m.messageRef, payloadJson: String(out[0]!.payloadJson), tenantId: String(out[0]!.tenantId), now: NOW() };
    expect(await handleClaimedBoardEvent(d0, args)).toEqual({ notificationsWritten: 2, alreadyNotified: 0 });
    expect(await handleClaimedBoardEvent(d0, args)).toEqual({ notificationsWritten: 0, alreadyNotified: 2 });
  });
});
