/**
 * Shared seeding for the board and open-work database suites. Test-only: imported by
 * `*.db.test.ts` files and by nothing in production.
 */
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

export const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
// Its own range, clear of every suite's band (testIdBands.test.ts lists them; 285_000_000 and 331_000_000 are
// the neighbours). Nine suites import this module and each draws a contiguous run from a random start, so the
// window is wide: two runs of a few dozen ids in thirty million do not meet. It was 270_000_000, which is
// tenantScopeMoney.db.test.ts's band — the guard reads only *.test.ts, so it could not see this file.
let seq = 300_000_000 + Math.floor(Math.random() * 30_000_000);
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
  // #52 (on main): the legacy operators.licenseExpiresAt date alone is an unverified licence, so a ready
  // driver also needs a verified driver_licence document. Same expiry, so an expired fixture stays expired.
  if (licenceExpires) await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'driver_licence', 'Driver licence', NOW(), ?, 'verified')", [id, licenceExpires]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, id]);
  return id;
}

/**
 * On the organization's crew roster: an active crew membership with no rotation, so on shift every day.
 * The open-shift rule (SPINE item 2, `shiftEligibility`) refuses anyone not rostered.
 */
export async function onRoster(pool: mysql.Pool, orgRef: string | null, userId: number) {
  const crewRef = `CR-${rnd()}${rnd()}`.slice(0, 40);
  await pool.execute("INSERT INTO crews (crewRef, tenantId, name, createdByUserId) VALUES (?,?,?,1)", [crewRef, orgRef ?? "default", `Crew ${crewRef}`]);
  await pool.execute("INSERT INTO crewMembers (crewRef, userId, crewRole, joinedAt) VALUES (?, ?, 'driver', NOW())", [crewRef, userId]);
}

/** A driver the one rule lets take driver work: a member, with a licensed operator record, on the roster. */
export async function worker(pool: mysql.Pool, orgRef: string | null) {
  const userId = await member(pool, orgRef, ["driver"]);
  await operatorFor(pool, orgRef, userId);
  await onRoster(pool, orgRef, userId);
  return userId;
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
