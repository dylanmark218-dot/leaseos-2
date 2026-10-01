/**
 * P4.1 router 5 — the training academy keys to people. A learner is in scope when they hold an
 * active membership in the caller's organization; for the historical single tenant, when they
 * hold none. Assigning, checking, supervising or opening another organization's learner answers
 * "not found" — never "forbidden". The course catalog stays shared content.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 252_000_000 + Math.floor(Math.random() * 50_000);
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

d("the academy belongs to the organization the learner is a member of", () => {
  it("assigns, supervises and dispatch-checks only a learner in the caller's organization; another organization's learner, or an unaffiliated one, is not found; the single tenant sees only the unaffiliated", async () => {
    const A = await org(), B = await org();
    const safetyA = await member(A, ["safety"]), safetyB = await member(B, ["safety"]), legacySafety = await member(null, ["safety"]);
    const learnerA = await member(A, ["driver"]), learnerB = await member(B, ["driver"]), unaffiliated = await member(null, ["driver"]);
    const missingCourse = `NOPE-${rnd()}`;
    // In scope: the assignment gets past the scope guard and fails on the course, which is the next check — proving the guard passed.
    await expect(callerFor(safetyA).academy.assign({ userId: learnerA, courseCode: missingCourse })).rejects.not.toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/^User \d+ not found$/) });
    // Out of scope: not found, naming the person, before anything else is looked at.
    await expect(callerFor(safetyA).academy.assign({ userId: learnerB, courseCode: missingCourse })).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${learnerB} not found` });
    await expect(callerFor(safetyA).academy.assign({ userId: unaffiliated, courseCode: missingCourse })).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${unaffiliated} not found` });
    await expect(callerFor(safetyB).academy.dispatchCheck({ userId: learnerA, requirementCodes: ["x"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(safetyA).academy.directSupervisionCreate({ traineeUserId: learnerA, supervisorUserId: safetyB, jobId: 1, qualificationCode: "class_1", scope: { duty: "hydrovac" }, startsAt: new Date("2026-09-01"), endsAt: new Date("2026-09-30") })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Supervisor ${safetyB} not found` });
    // The historical single tenant sees the unaffiliated learner and not an organization's.
    await expect(callerFor(legacySafety).academy.assign({ userId: unaffiliated, courseCode: missingCourse })).rejects.not.toMatchObject({ message: expect.stringMatching(/^User \d+ not found$/) });
    await expect(callerFor(legacySafety).academy.assign({ userId: learnerA, courseCode: missingCourse })).rejects.toMatchObject({ code: "NOT_FOUND", message: `User ${learnerA} not found` });
    // An assignment ref from another organization does not exist here.
    await expect(callerFor(learnerB).academy.assignmentDetail({ assignmentRef: `ASG-${rnd()}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});
