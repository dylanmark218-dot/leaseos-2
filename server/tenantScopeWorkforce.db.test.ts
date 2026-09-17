/**
 * P4.1 router 8 — workforce. An applicant belongs to the organization that is hiring (0147: the
 * row carries the acting organization; NULL = the single tenant's). A person's training,
 * competency, onboarding, probation and offboarding are in scope through membership. Across the
 * boundary the answer is "not found", never "forbidden".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 262_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

d("workforce belongs to the hiring organization and the person's organization", () => {
  it("stamps an applicant with the hiring organization and lists only its own; another organization's HR does not find it; training and offboarding follow the person's membership", async () => {
    const A = await org(), B = await org();
    const hrA = await member(A, ["hr"]), hrB = await member(B, ["hr"]), hrLegacy = await member(null, ["hr"]);
    const personA = await member(A, ["driver"]), personB = await member(B, ["driver"]);
    const app = await callerFor(hrA).workforce.applicantCreate({ fullName: `Applicant ${rnd()}`, contact: { phone: "780-555-0199" }, roleApplied: "Vac truck operator", source: "referral" });
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM applicants WHERE applicantRef = ?", [app.applicantRef]);
    expect(row[0]!.orgRef).toBe(A);
    expect((await callerFor(hrA).workforce.applicantList()).applicants.some(a => a.applicantRef === app.applicantRef)).toBe(true);
    expect((await callerFor(hrB).workforce.applicantList()).applicants.some(a => a.applicantRef === app.applicantRef)).toBe(false);
    expect((await callerFor(hrLegacy).workforce.applicantList()).applicants.some(a => a.applicantRef === app.applicantRef)).toBe(false);
    await expect(callerFor(hrB).workforce.screeningRecord({ applicantRef: app.applicantRef, kind: "driver_abstract", result: "pass" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The single tenant's applicant carries no organization and is invisible to A.
    const legacyApp = await callerFor(hrLegacy).workforce.applicantCreate({ fullName: `Applicant ${rnd()}`, contact: {}, roleApplied: "Swamper", source: "walk-in" });
    const [lrow] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM applicants WHERE applicantRef = ?", [legacyApp.applicantRef]);
    expect(lrow[0]!.orgRef).toBeNull();
    expect((await callerFor(hrA).workforce.applicantList()).applicants.some(a => a.applicantRef === legacyApp.applicantRef)).toBe(false);
    expect((await callerFor(hrLegacy).workforce.applicantList()).applicants.some(a => a.applicantRef === legacyApp.applicantRef)).toBe(true);
    // A person's records follow their membership.
    await expect(callerFor(hrA).workforce.trainingRecord({ userId: personB, courseCode: "TDG_GROUND", title: "TDG Ground", completedAt: new Date("2026-09-15T00:00:00Z") } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${personB} not found` });
    const trn = await callerFor(hrA).workforce.trainingRecord({ userId: personA, courseCode: "TDG_GROUND", title: "TDG Ground", completedAt: new Date("2026-09-15T00:00:00Z") } as never);
    await expect(callerFor(hrB).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Training ${trn.trainingRef} not found` });
    await expect(callerFor(hrB).workforce.offboardingOpen({ userId: personA, reason: "resigned", lastDay: new Date("2026-10-01") } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${personA} not found` });
    const off = await callerFor(hrA).workforce.offboardingOpen({ userId: personA, reason: "resigned", lastDay: new Date("2026-10-01") } as never);
    await expect(callerFor(hrB).workforce.offboardingStatus({ offboardingRef: off.offboardingRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(hrA).workforce.offboardingStatus({ offboardingRef: off.offboardingRef })).resolves.toBeTruthy();
  }, 60_000);
});
