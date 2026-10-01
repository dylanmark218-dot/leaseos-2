/**
 * SPINE item 2, openShifts — one eligibility rule, and the router enforces it (owner's ruling).
 *
 * Before: `_core/openShifts.ts` refused wrong role, not rostered and overlapping work; the router
 * refused missing/expired licence and unverified/expired/unknown qualifications; neither refused
 * everything, and `shifts.expressInterest` checked nothing at all. Now `shiftEligibility` in the engine
 * is the one rule — the union of both — and the router only reads the records it needs and enforces the
 * answer. Seeing a post (shifts.read), saying you would take it (shifts.interest) and posting/assigning
 * work (shifts.post) stay three different permissions; only the work-taking action is gated by
 * eligibility, and it fails closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 921_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });

const STARTS = new Date("2026-11-10T06:00:00Z");
const ENDS = new Date("2026-11-10T18:00:00Z");

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
/** The person's operator record, owned by the organization, with a licence expiry (or none). */
async function licence(orgRef: string, userId: number, expires: Date | null) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseClass, licenseExpiresAt, createdAt) VALUES (?,?,?,?,NOW())", [userId, `Op ${rnd()}`, "1", expires]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, o.insertId]);
  return o.insertId;
}
/** On this organization's roster: an active crew membership, optionally on a rotation. */
async function roster(orgRef: string, userId: number, rotation?: { on: number; off: number; anchor: Date }) {
  const crewRef = `CR-${rnd()}`;
  await pool.execute("INSERT INTO crews (crewRef, tenantId, name, createdByUserId) VALUES (?,?,?,1)", [crewRef, orgRef, `Crew ${crewRef}`]);
  await pool.execute("INSERT INTO crewMembers (crewRef, userId, crewRole, rotationOnDays, rotationOffDays, rotationAnchor, joinedAt) VALUES (?,?,'driver',?,?,?,NOW())",
    [crewRef, userId, rotation?.on ?? null, rotation?.off ?? null, rotation?.anchor ?? null]);
}
/** A worker who could take the shift: driver, rostered, licensed, nothing booked. */
async function eligibleDriver(orgRef: string, roles = ["driver"]) {
  const userId = await member(orgRef, roles);
  const operatorId = await licence(orgRef, userId, new Date("2027-06-01T00:00:00Z"));
  await roster(orgRef, userId);
  return { userId, operatorId };
}
const post = (dispatcher: number, over: Record<string, unknown> = {}) =>
  caller(dispatcher).shifts.post({ title: "Vac truck operator", startsAt: STARTS, endsAt: ENDS, requiredRole: "driver", ...over });
const interestRows = async (postRef: string, userId: number) =>
  Number((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM shiftInterests WHERE postRef = ? AND userId = ?", [postRef, userId]))[0][0].n);

/** Both answers for one person: what the view says, and whether the work-taking action goes through. */
async function bothAnswers(dispatcher: number, postRef: string, userId: number) {
  const view = await caller(dispatcher).shifts.eligibility({ postRef, userId });
  let action: "recorded" | "refused";
  try { await caller(userId).shifts.expressInterest({ postRef }); action = "recorded"; }
  catch (e) { expect(e).toMatchObject({ code: "PRECONDITION_FAILED" }); action = "refused"; }
  return { view, action, rows: await interestRows(postRef, userId) };
}

d("one eligibility rule, enforced where work is taken", () => {
  it("passes a rostered, licensed driver with no clash — the view says eligible and the interest is recorded", async () => {
    const A = await org();
    const dispatcher = await member(A, ["dispatcher"]);
    const w = await eligibleDriver(A);
    const p = await post(dispatcher);
    const r = await bothAnswers(dispatcher, p.postRef, w.userId);
    expect(r.view).toMatchObject({ eligible: true, reasons: [] });
    expect(r.action).toBe("recorded");
    expect(r.rows).toBe(1);
  }, 60_000);

  const refusals: { name: string; code: string; setup: (A: string) => Promise<{ userId: number; over?: Record<string, unknown> }> }[] = [
    { name: "the wrong role", code: "wrong_role", setup: async A => ({ userId: (await eligibleDriver(A, ["mechanic"])).userId }) },
    { name: "nobody on this organization's roster", code: "not_rostered", setup: async A => { const u = await member(A, ["driver"]); await licence(A, u, new Date("2027-06-01T00:00:00Z")); return { userId: u }; } },
    { name: "off-hitch on the day", code: "not_rostered", setup: async A => { const u = await member(A, ["driver"]); await licence(A, u, new Date("2027-06-01T00:00:00Z")); await roster(A, u, { on: 7, off: 7, anchor: new Date("2026-11-01T00:00:00Z") }); return { userId: u }; } },
    { name: "work already booked over the window", code: "overlaps_existing", setup: async A => {
      const w = await eligibleDriver(A);
      await pool.execute("INSERT INTO resourceBookings (resourceType, resourceRef, postingId, startsAt, endsAt, bookingState) VALUES ('operator', ?, 777, ?, ?, 'confirmed')", [String(w.operatorId), new Date("2026-11-10T10:00:00Z"), new Date("2026-11-10T20:00:00Z")]);
      return { userId: w.userId };
    } },
    { name: "no licence on record", code: "no_licence_recorded", setup: async A => { const u = await member(A, ["driver"]); await roster(A, u); return { userId: u }; } },
    { name: "a licence that expires before the shift", code: "licence_expired", setup: async A => { const u = await member(A, ["driver"]); await licence(A, u, new Date("2026-11-01T00:00:00Z")); await roster(A, u); return { userId: u }; } },
    { name: "a required qualification nobody recorded", code: "qualification_unknown", setup: async A => ({ userId: (await eligibleDriver(A)).userId, over: { requiredQualifications: ["H2S"] } }) },
  ];
  for (const r of refusals) {
    it(`refuses ${r.name} (${r.code}) in the view and at the interest, and records nothing`, async () => {
      const A = await org();
      const dispatcher = await member(A, ["dispatcher"]);
      const s = await r.setup(A);
      const p = await post(dispatcher, s.over);
      const both = await bothAnswers(dispatcher, p.postRef, s.userId);
      expect(both.view.eligible).toBe(false);
      expect(both.view.reasons.map(x => x.code)).toContain(r.code);
      expect(both.action).toBe("refused");
      expect(both.rows).toBe(0);
    }, 60_000);
  }

  it("fails closed when the person's operator record is ambiguous — two records, no licence chosen", async () => {
    const A = await org();
    const dispatcher = await member(A, ["dispatcher"]);
    const w = await eligibleDriver(A);
    await licence(A, w.userId, new Date("2027-06-01T00:00:00Z"));
    const p = await post(dispatcher);
    const both = await bothAnswers(dispatcher, p.postRef, w.userId);
    expect(both.view.eligible).toBe(false);
    expect(both.action).toBe("refused");
  }, 60_000);

  it("takes no role, qualification, person or organization from the input", async () => {
    const A = await org();
    const dispatcher = await member(A, ["dispatcher"]);
    const mechanic = await eligibleDriver(A, ["mechanic"]);
    const p = await post(dispatcher, { requiredQualifications: ["H2S"] });
    const claims = { roles: ["driver"], requiredRole: "mechanic", qualifications: ["H2S"], currentQualifications: ["H2S"], eligible: true, userId: dispatcher, tenantId: A, orgRef: A };
    await expect(caller(mechanic.userId).shifts.expressInterest({ postRef: p.postRef, ...claims } as never)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await interestRows(p.postRef, mechanic.userId)).toBe(0);
    expect(await interestRows(p.postRef, dispatcher)).toBe(0);
  }, 60_000);

  it("keeps another organization out: its worker cannot reach the post, and is not eligible for it", async () => {
    const A = await org(), B = await org();
    const dispatcherA = await member(A, ["dispatcher"]);
    const outsider = await eligibleDriver(B);
    const p = await post(dispatcherA);
    await expect(caller(outsider.userId).shifts.expressInterest({ postRef: p.postRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(outsider.userId).shifts.eligibility({ postRef: p.postRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const view = await caller(dispatcherA).shifts.eligibility({ postRef: p.postRef, userId: outsider.userId });
    expect(view.eligible).toBe(false);
    expect(view.reasons.map(x => x.code)).toEqual(["not_in_organization"]);
    expect(await interestRows(p.postRef, outsider.userId)).toBe(0);
  }, 60_000);
});

d("seeing, wanting and assigning are three permissions", () => {
  it("lets an ineligible worker see the post but not take it; a dispatcher posts but does not express interest; a worker cannot post", async () => {
    const A = await org();
    const dispatcher = await member(A, ["dispatcher"]);
    const mechanic = await eligibleDriver(A, ["mechanic"]);
    const p = await post(dispatcher);
    // VIEW_OPEN_SHIFT (shifts.read): visibility is not gated by eligibility.
    const listed = await caller(mechanic.userId).shifts.list({});
    expect(listed.posts.map(x => x.postRef)).toContain(p.postRef);
    expect((await caller(mechanic.userId).shifts.eligibility({ postRef: p.postRef })).eligible).toBe(false);
    // EXPRESS_INTEREST (shifts.interest): the work-taking action is gated, and fails closed.
    await expect(caller(mechanic.userId).shifts.expressInterest({ postRef: p.postRef })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // The dispatcher holds shifts.post, not shifts.interest.
    await expect(caller(dispatcher).shifts.expressInterest({ postRef: p.postRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // ASSIGN_SHIFT (shifts.post): a worker cannot post work.
    await expect(post(mechanic.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
