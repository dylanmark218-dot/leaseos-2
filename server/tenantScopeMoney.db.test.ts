/**
 * P4.1 router 4 — the financial entity is the tenant boundary for money (0146).
 *
 * A member's entity is theirs: another organization's member cannot list it, read its
 * registrations, open a period on it or plan a run against it — every answer is "not found",
 * never "forbidden". The default scope (no membership) sees only unowned entities, the
 * historical single tenant's. A caller's own payroll profile is visible only in the
 * organization whose entity pays it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 270_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  return userId;
}
const entityInput = () => ({ entityRef: `FE-${rnd()}`, legalName: `Entity ${rnd()} Ltd`, taxpayerType: "corporation" as const, jurisdiction: "AB" });

d("money is scoped by financial entity", () => {
  it("owns a new entity by the acting organization; another organization's member finds nothing; the default scope sees only unowned entities", async () => {
    const a = await org(), b = await org();
    const ctlA = await member(a, ["controller", "payroll_admin"]), ctlB = await member(b, ["controller", "payroll_admin"]), legacy = await member(null, ["controller", "payroll_admin"]);
    const made = await callerFor(ctlA).finance.entityCreate(entityInput());
    const entityId = made.id as number;
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM financialEntities WHERE id = ?", [entityId]);
    expect(row!.orgRef).toBe(a);
    expect((await callerFor(ctlA).finance.entitiesList()).some(e => e.id === entityId)).toBe(true);
    expect((await callerFor(ctlB).finance.entitiesList()).some(e => e.id === entityId)).toBe(false);
    expect((await callerFor(legacy).finance.entitiesList()).some(e => e.id === entityId)).toBe(false);
    await expect(callerFor(ctlB).finance.registrationsList({ financialEntityId: entityId })).rejects.toThrow(/not found/);
    await expect(callerFor(ctlB).payroll.periodOpen({ periodRef: `PP-${rnd()}`, financialEntityId: entityId, startsOn: new Date("2026-09-01"), endsOn: new Date("2026-09-15"), payDate: new Date("2026-09-20") } as never)).rejects.toThrow(/not found/);
    // A's own period on it: allowed; B's list of periods does not include it; the default scope neither.
    const period = await callerFor(ctlA).payroll.periodOpen({ periodRef: `PP-${rnd()}`, financialEntityId: entityId, startsOn: new Date("2026-09-01"), endsOn: new Date("2026-09-15"), payDate: new Date("2026-09-20") } as never);
    expect(period).toBeTruthy();
    expect((await callerFor(ctlA).payroll.periodsList()).some(p => p.financialEntityId === entityId)).toBe(true);
    expect((await callerFor(ctlB).payroll.periodsList()).some(p => p.financialEntityId === entityId)).toBe(false);
    expect((await callerFor(legacy).payroll.periodsList()).some(p => p.financialEntityId === entityId)).toBe(false);
    // A legacy entity, created under the default scope, stays unowned and is visible only there.
    const legacyMade = await callerFor(legacy).finance.entityCreate(entityInput());
    const [[lrow]] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM financialEntities WHERE id = ?", [legacyMade.id as number]);
    expect(lrow!.orgRef).toBeNull();
    expect((await callerFor(legacy).finance.entitiesList()).some(e => e.id === legacyMade.id)).toBe(true);
    expect((await callerFor(ctlA).finance.entitiesList()).some(e => e.id === legacyMade.id)).toBe(false);
  }, 30_000);

  it("shows a payroll profile only to the organization whose entity pays it, and a caller's own pay only inside that organization", async () => {
    const a = await org(), b = await org();
    const adminA = await member(a, ["payroll_admin", "controller"]), adminB = await member(b, ["payroll_admin", "controller"]);
    const worker = await member(a, ["driver"]);
    const ent = await callerFor(adminA).finance.entityCreate(entityInput());
    const employeeNumber = `EMP-${rnd()}`;
    await callerFor(adminA).payroll.profileUpsert({ employeeNumber, financialEntityId: ent.id as number, userId: worker, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" });
    expect((await callerFor(adminA).payroll.profilesList()).some(p => p.employeeNumber === employeeNumber)).toBe(true);
    expect((await callerFor(adminB).payroll.profilesList()).some(p => p.employeeNumber === employeeNumber)).toBe(false);
    await expect(callerFor(adminB).payroll.profileUpsert({ employeeNumber: `EMP-${rnd()}`, financialEntityId: ent.id as number, userId: worker, workerKind: "employee", employmentType: "full_time", defaultPayMethod: "hourly" })).rejects.toThrow(/not found/);
    // The worker, acting in A, can read their own time; the same worker acting in B has no profile there.
    expect(Array.isArray(await callerFor(worker).payroll.myTimeEntries({ from: new Date("2026-09-01"), to: new Date("2026-09-30") }))).toBe(true);
    const workerInB = await member(b, ["driver"]);
    await pool.execute("UPDATE employeePayrollProfiles SET userId = ? WHERE employeeNumber = ?", [workerInB, employeeNumber]);   // the same person, now acting for B, paid by A's entity
    await expect(callerFor(workerInB).payroll.myTimeEntries({ from: new Date("2026-09-01"), to: new Date("2026-09-30") })).rejects.toThrow(/in this organization/);
  }, 30_000);
});
