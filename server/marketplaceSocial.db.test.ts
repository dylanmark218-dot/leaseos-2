/**
 * The marketplace social layer (0235) through the real router, against a real database.
 *
 * The thing that is proved here, beyond the rows: notifications are not a new engine. A follow
 * that matches an opening posting, an invitation, a published clarification and an award outcome
 * each become `workflowNotifications` rows in the OTHER organization's tenant, and the universal
 * inbox (`surfaces.inbox`) hands them to that organization's dispatcher. The tender discussion is
 * private until the client publishes it, and published it names nobody.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("marketplace social layer — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped social-layer suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 350_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => {
  // Every marketplace write queues an outbox row. Left unprocessed, hundreds of them sit ahead of the
  // outbox worker suites' own events in a FIFO claim of fifty; mark what this suite queued as
  // processed so those suites find theirs. (Checked in-test above, where the rows are the point.)
  if (pool) await pool.execute("UPDATE domainEventOutbox SET processedAt = NOW() WHERE eventType LIKE 'marketplace.%' AND processedAt IS NULL");
  await pool?.end();
});

async function org(name: string) {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, name]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function notificationsFor(orgRef: string) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT notificationKey, recipientRole, title, body, deepLink, status FROM workflowNotifications WHERE tenantId = ? ORDER BY id", [orgRef]);
  return rows;
}

const bid = (totalCents: number) => ({ pricingType: "fixed_price" as const, currency: "CAD", fixedTotalCents: totalCents, components: [], exclusions: [], qualifications: { certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityCents: null, equipmentTypes: [] }, unitsOffered: 2, availableFrom: null, notes: null, attachments: [] });

d("the opportunity feed: following and matching notifications", () => {
  it("tells a following organization, once, through the inbox when a matching public posting opens for bidding", async () => {
    const client = await org("Feed Energy");
    const follower = await org("Fox Creek Vac");
    const elsewhere = await org("Grande Prairie Gravel");
    const everything = await org("Hears It All Ltd.");
    const clientOffice = await member(client, ["office"]);
    const followerDispatch = await member(follower, ["dispatcher"]);
    const elsewhereDispatch = await member(elsewhere, ["dispatcher"]);
    const everythingDispatch = await member(everything, ["dispatcher"]);

    const f1 = await callerFor(followerDispatch).marketplace.followSet({ workType: "FLUID_HAULING", operatingArea: "Fox Creek" });
    expect(f1.created).toBe(true);
    expect((await callerFor(followerDispatch).marketplace.followSet({ workType: "fluid_hauling", operatingArea: " fox creek " })).created).toBe(false);   // same key
    await callerFor(elsewhereDispatch).marketplace.followSet({ workType: "GRAVEL", operatingArea: null });
    await callerFor(everythingDispatch).marketplace.followSet({});
    expect(await callerFor(followerDispatch).marketplace.followsMine()).toHaveLength(1);

    const p = await callerFor(clientOffice).marketplace.postingCreate({ title: "Produced water haul", workType: "FLUID_HAULING", operatingArea: "Fox Creek", visibility: "open", biddingClosesAt: new Date(Date.now() + 86_400_000) });
    await callerFor(clientOffice).marketplace.postingPublish({ postingRef: p.postingRef });
    expect(await notificationsFor(follower)).toHaveLength(0);                       // publishing is not yet opening
    const opened = await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: p.postingRef });
    // At least the specific follower and the follow-everything one; a database carrying follows from earlier runs may add more.
    expect(opened.notifiedOrganizations).toBeGreaterThanOrEqual(2);

    const got = await notificationsFor(follower);
    expect(got.map(n => n.recipientRole).sort()).toEqual(["dispatcher", "management", "office"]);
    expect(got[0]).toMatchObject({ title: "Work matching what you follow: Produced water haul", deepLink: `/marketplace/postings/${p.postingRef}`, status: "queued" });
    expect(got[0]!.body).toMatch(/FLUID_HAULING · Fox Creek · bids close/);
    expect(await notificationsFor(elsewhere)).toHaveLength(0);
    expect(await notificationsFor(everything)).toHaveLength(3);
    expect(await notificationsFor(client)).toHaveLength(0);

    // The universal inbox hands it to the follower's dispatcher — the existing surface, not a new one.
    const inbox = await callerFor(followerDispatch).surfaces.inbox();
    expect(inbox.items.some(i => i.kind === "notification" && i.title === "Work matching what you follow: Produced water haul")).toBe(true);
    const otherInbox = await callerFor(elsewhereDispatch).surfaces.inbox();
    expect(otherInbox.items.some(i => i.title.startsWith("Work matching"))).toBe(false);

    // An invite-only tender reaches nobody by following.
    const priv = await callerFor(clientOffice).marketplace.postingCreate({ title: "Quiet haul", workType: "FLUID_HAULING", operatingArea: "Fox Creek", distribution: "invite_only" });
    await callerFor(clientOffice).marketplace.postingPublish({ postingRef: priv.postingRef });
    expect((await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: priv.postingRef })).notifiedOrganizations).toBe(0);

    await callerFor(followerDispatch).marketplace.followRemove({ followRef: f1.followRef });
    expect(await callerFor(followerDispatch).marketplace.followsMine()).toHaveLength(0);
    await expect(callerFor(elsewhereDispatch).marketplace.followRemove({ followRef: f1.followRef })).rejects.toThrow(/Follow not found/);
  });
});

d("the tender discussion", () => {
  it("keeps a question private until the client publishes it, then shows it to every bidder with the asker withheld", async () => {
    const client = await org("Tender Energy");
    const asker = await org("Curious Vac");
    const other = await org("Other Vac");
    const stranger = await org("Stranger Ltd.");
    const clientOffice = await member(client, ["office"]);
    const askerOffice = await member(asker, ["office"]);
    const otherOffice = await member(other, ["office"]);
    const strangerOffice = await member(stranger, ["office"]);

    const p = await callerFor(clientOffice).marketplace.postingCreate({ title: "Disposal run", workType: "FLUID_HAULING", visibility: "sealed" });
    await expect(callerFor(askerOffice).marketplace.questionAsk({ postingRef: p.postingRef, question: "Is disposal included?" })).rejects.toThrow(/Posting not found/);   // a draft is invisible
    await callerFor(clientOffice).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientOffice).marketplace.postingOpenBidding({ postingRef: p.postingRef });
    // Both contractors start a bid, so both have a stake in the clarifications.
    await callerFor(askerOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(100_000) });
    await callerFor(otherOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(110_000) });

    await expect(callerFor(clientOffice).marketplace.questionAsk({ postingRef: p.postingRef, question: "Asking myself?" })).rejects.toThrow(/does not ask itself/);
    const q = await callerFor(askerOffice).marketplace.questionAsk({ postingRef: p.postingRef, question: "Is disposal included in the bid, or billed separately?" });
    expect(q.status).toBe("open");
    expect((await notificationsFor(client)).some(n => n.title === "Bidder question on Disposal run")).toBe(true);

    // Private: the client and the asker see it; the other bidder and a stranger do not.
    expect((await callerFor(clientOffice).marketplace.clarifications({ postingRef: p.postingRef }))).toMatchObject([{ clarificationRef: q.clarificationRef, askerOrgRef: asker, status: "open", answer: null }]);
    expect((await callerFor(askerOffice).marketplace.clarifications({ postingRef: p.postingRef }))).toMatchObject([{ clarificationRef: q.clarificationRef, mine: true, askerOrgRef: asker }]);
    expect(await callerFor(otherOffice).marketplace.clarifications({ postingRef: p.postingRef })).toEqual([]);
    expect(await callerFor(strangerOffice).marketplace.clarifications({ postingRef: p.postingRef })).toEqual([]);   // public posting, nothing published

    // Only the client answers; publishing needs an answer; the answer is written once.
    await expect(callerFor(askerOffice).marketplace.questionAnswer({ clarificationRef: q.clarificationRef, answer: "Yes." })).rejects.toThrow(/Only the client organization/);
    await expect(callerFor(clientOffice).marketplace.clarificationPublish({ clarificationRef: q.clarificationRef })).rejects.toThrow(/Answer the question before publishing/);
    await callerFor(clientOffice).marketplace.questionAnswer({ clarificationRef: q.clarificationRef, answer: "Disposal is billed separately by the facility; bid the haul only." });
    await expect(callerFor(clientOffice).marketplace.questionAnswer({ clarificationRef: q.clarificationRef, answer: "Changed my mind." })).rejects.toThrow(/written once/);
    expect((await notificationsFor(asker)).some(n => n.title === "Your question on Disposal run was answered")).toBe(true);
    expect(await callerFor(otherOffice).marketplace.clarifications({ postingRef: p.postingRef })).toEqual([]);   // answered is still private

    const pub = await callerFor(clientOffice).marketplace.clarificationPublish({ clarificationRef: q.clarificationRef });
    expect(pub.notifiedOrganizations).toBe(2);
    await expect(callerFor(clientOffice).marketplace.clarificationPublish({ clarificationRef: q.clarificationRef })).rejects.toThrow(/Already published/);
    const seenByOther = await callerFor(otherOffice).marketplace.clarifications({ postingRef: p.postingRef });
    expect(seenByOther).toMatchObject([{ clarificationRef: q.clarificationRef, status: "published", askerOrgRef: null, mine: false, question: "Is disposal included in the bid, or billed separately?", answer: "Disposal is billed separately by the facility; bid the haul only." }]);
    expect((await callerFor(askerOffice).marketplace.clarifications({ postingRef: p.postingRef }))[0]?.askerOrgRef).toBe(asker);
    expect((await callerFor(strangerOffice).marketplace.clarifications({ postingRef: p.postingRef }))[0]?.askerOrgRef).toBeNull();
    const otherNotes = await notificationsFor(other);
    expect(otherNotes.filter(n => n.title === "Clarification on Disposal run")).toHaveLength(3);
    expect(otherNotes.find(n => n.title === "Clarification on Disposal run")!.body).toMatch(/^Q: Is disposal included.*\nA: Disposal is billed separately/);

    // A notice is the client's own clarification, public from birth, and refused once bidding closes.
    const n = await callerFor(clientOffice).marketplace.noticeIssue({ postingRef: p.postingRef, notice: "Road ban lifted on the lease road as of this morning." });
    expect(n.status).toBe("published");
    expect((await callerFor(otherOffice).marketplace.clarifications({ postingRef: p.postingRef })).map(c => c.kind)).toEqual(["question", "notice"]);
    await callerFor(clientOffice).marketplace.postingCloseBidding({ postingRef: p.postingRef });
    await expect(callerFor(clientOffice).marketplace.noticeIssue({ postingRef: p.postingRef, notice: "Too late for this." })).rejects.toThrow(/while the tender is live/);
    await expect(callerFor(askerOffice).marketplace.questionAsk({ postingRef: p.postingRef, question: "Also too late?" })).rejects.toThrow(/while the tender is live/);

    const trail = await callerFor(clientOffice).marketplace.postingEvents({ postingRef: p.postingRef });
    const types = trail.map(e => e.eventType);
    for (const t of ["question_asked", "question_answered", "clarification_published", "notice_issued"]) expect(types).toContain(t);
  });
});

d("profiles, preferred contractors and invitation notifications", () => {
  it("lets a client invite its preferred list in one act, tells each invitee through the inbox, and reads a company's public face", async () => {
    const client = await org("Preferring Energy");
    const a = await org("Preferred Vac A");
    const b = await org("Preferred Vac B");
    const clientOffice = await member(client, ["office"]);
    const aOffice = await member(a, ["office"]);
    const aDispatch = await member(a, ["dispatcher"]);

    await expect(callerFor(clientOffice).marketplace.preferredAdd({ contractorOrgRef: client })).rejects.toThrow(/cannot prefer itself/);
    await expect(callerFor(clientOffice).marketplace.preferredAdd({ contractorOrgRef: "ORG-NOBODY" })).rejects.toThrow(/Contractor organization not found/);
    await callerFor(clientOffice).marketplace.preferredAdd({ contractorOrgRef: a, note: "Reliable on Fox Creek work" });
    await callerFor(clientOffice).marketplace.preferredAdd({ contractorOrgRef: b });
    await callerFor(clientOffice).marketplace.preferredAdd({ contractorOrgRef: a, note: "Updated note" });   // upsert, not a duplicate
    const list = await callerFor(clientOffice).marketplace.preferredList();
    expect(list.map(x => [x.contractorOrgRef, x.note])).toEqual([[a, "Updated note"], [b, null]]);

    const p = await callerFor(clientOffice).marketplace.postingCreate({ title: "Private tender", workType: "FLUID_HAULING", distribution: "invite_only" });
    const inv = await callerFor(clientOffice).marketplace.postingInvitePreferred({ postingRef: p.postingRef });
    expect(inv).toMatchObject({ invited: 2, alreadyInvited: 0 });
    expect((await callerFor(clientOffice).marketplace.postingInvitePreferred({ postingRef: p.postingRef }))).toMatchObject({ invited: 0, alreadyInvited: 2 });
    const aNotes = await notificationsFor(a);
    expect(aNotes.filter(n => n.title === "Invited to tender: Private tender")).toHaveLength(3);
    const inbox = await callerFor(aDispatch).surfaces.inbox();
    expect(inbox.items.some(i => i.title === "Invited to tender: Private tender")).toBe(true);

    // The profile: what the company declares beside what the system records; no rating invented.
    await callerFor(aOffice).marketplace.profileUpsert({ displayName: "Preferred Vac A Ltd.", description: "Tri-drive vac units, Fox Creek and Whitecourt.", workTypes: ["FLUID_HAULING"], operatingAreas: ["Fox Creek", "Whitecourt"], equipmentTypes: ["TRI_DRIVE_VAC"] });
    await callerFor(aOffice).marketplace.profileUpsert({ displayName: "Preferred Vac A Ltd.", workTypes: ["FLUID_HAULING", "HYDROVAC"], operatingAreas: ["Fox Creek"], equipmentTypes: ["TRI_DRIVE_VAC"] });
    const prof = await callerFor(clientOffice).marketplace.profileGet({ orgRef: a });
    expect(prof.organization).toMatchObject({ name: "Preferred Vac A", status: "active" });
    expect(prof.declared).toMatchObject({ displayName: "Preferred Vac A Ltd.", workTypes: ["FLUID_HAULING", "HYDROVAC"], operatingAreas: ["Fox Creek"] });
    expect(prof.recorded).toMatchObject({ contractorProfile: null, marketplaceAwards: 0, rating: "not_available" });
    expect((await callerFor(clientOffice).marketplace.profileGet({ orgRef: b })).declared).toBeNull();
    await expect(callerFor(clientOffice).marketplace.profileGet({ orgRef: "ORG-NOBODY" })).rejects.toThrow(/Organization not found/);

    await callerFor(clientOffice).marketplace.preferredRemove({ contractorOrgRef: b });
    expect((await callerFor(clientOffice).marketplace.preferredList()).map(x => x.contractorOrgRef)).toEqual([a]);
  });

  it("tells the winner and the others when the client awards", async () => {
    const client = await org("Awarding Energy");
    const winner = await org("Winning Vac");
    const loser = await org("Losing Vac");
    const clientMgmt = await member(client, ["management"]);
    const winnerOffice = await member(winner, ["office"]);
    const loserOffice = await member(loser, ["office"]);
    const p = await callerFor(clientMgmt).marketplace.postingCreate({ title: "Awarded haul", workType: "FLUID_HAULING", visibility: "open" });
    await callerFor(clientMgmt).marketplace.postingPublish({ postingRef: p.postingRef });
    await callerFor(clientMgmt).marketplace.postingOpenBidding({ postingRef: p.postingRef });
    const w = await callerFor(winnerOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(200_000) });
    await callerFor(winnerOffice).marketplace.bidSubmit({ bidRef: w.bidRef });
    const l = await callerFor(loserOffice).marketplace.bidDraftSave({ postingRef: p.postingRef, content: bid(190_000) });
    await callerFor(loserOffice).marketplace.bidSubmit({ bidRef: l.bidRef });
    await callerFor(clientMgmt).marketplace.postingCloseBidding({ postingRef: p.postingRef });
    await callerFor(clientMgmt).marketplace.award({ postingRef: p.postingRef, bidRef: w.bidRef, rationale: "Two units on the date; the cheaper bid offered none until next week." });
    expect((await notificationsFor(winner)).filter(n => n.title === "Awarded: Awarded haul")).toHaveLength(3);
    expect((await notificationsFor(loser)).filter(n => n.title === "Not awarded: Awarded haul")).toHaveLength(3);
    expect((await notificationsFor(loser)).some(n => n.title.startsWith("Awarded:"))).toBe(false);
  });
});
