/**
 * Shared seeding for the board and open-work database suites. Test-only: imported by
 * `*.db.test.ts` files and by nothing in production.
 */
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

export const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
let seq = 270_000_000 + Math.floor(Math.random() * 50_000);
export const nextId = () => seq++;

export const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

export async function org(pool: mysql.Pool) {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}

/** A person: a member of `orgRef` (or the single tenant when null) holding `roles` globally. */
export async function member(pool: mysql.Pool, orgRef: string | null, roles: string[]) {
  const userId = nextId();
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

/** An operator record linked to a person, owned by the organization, with a licence. */
export async function operatorFor(pool: mysql.Pool, orgRef: string | null, userId: number, licenceExpires: Date | null = new Date("2028-01-01T00:00:00Z")) {
  const id = nextId();
  await pool.execute("INSERT INTO operators (id, userId, name, licenseClass, licenseExpiresAt, createdAt) VALUES (?,?,?,?,?,NOW())", [id, userId, `Op ${rnd()}`, "1", licenceExpires]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, id]);
  return id;
}

export async function job(pool: mysql.Pool, orgRef: string | null) {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'water_haul','transport','Acme','LSD','dispatched',0)", [orgRef, jobCode]);
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return Number(rows[0]!.id);
}

/** Clock-relative, so the calendar never passes these fixtures: work 45 days out, 06:00–18:00 UTC. */
const DAY = 86_400_000;
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
export const STARTS = new Date(dayStart(Date.now() + 45 * DAY) + 6 * 3_600_000);
export const ENDS = new Date(STARTS.getTime() + 12 * 3_600_000);
/** A day before and after the work, for leave and availability windows. */
export const DAY_BEFORE = new Date(dayStart(STARTS.getTime()) - DAY);
export const DAY_AFTER = new Date(dayStart(STARTS.getTime()) + DAY);
export const TWO_DAYS_AFTER = new Date(dayStart(STARTS.getTime()) + 2 * DAY);
export const DAY_OF = new Date(dayStart(STARTS.getTime()));

export function postWork(dispatcher: number, over: Record<string, unknown> = {}) {
  return callerFor(dispatcher).shifts.post({ title: `Vac ${rnd()}`, startsAt: STARTS, endsAt: ENDS, requiredRole: "driver", ...over } as never);
}

export const count = async (pool: mysql.Pool, sql: string, p: unknown[] = []) =>
  Number((await pool.query<mysql.RowDataPacket[]>(sql, p))[0][0]!.n);
export const rows = async (pool: mysql.Pool, sql: string, p: unknown[] = []) =>
  (await pool.query<mysql.RowDataPacket[]>(sql, p))[0];
