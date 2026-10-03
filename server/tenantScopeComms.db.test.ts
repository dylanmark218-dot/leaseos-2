/**
 * SEC-1 — a communication package belongs to one organization.
 *
 * `communicationPackages` has no organization column. A package is anchored to a job, trip or unit
 * when one is named, and is always built by someone; those are its owner. Before this:
 *   - packageBuild stored client-supplied job, trip and unit ids unchecked;
 *   - packageFetch and packageStatus found a package by reference, or the newest by label, in any
 *     organization — so a driver could carry another company's route package;
 *   - packageBuild's predecessor lookup was by label alone, so one company's build marked another
 *     company's current package `superseded`, and that company's drivers could no longer fetch it.
 * Rule now: every anchor in scope; an unanchored package belongs to its builder's organization.
 * Across the boundary the answer is the not-found a missing package gets. Baseline V8.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 944_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, role: string) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function trip(orgRef: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, orgRef) VALUES (?,?)", [`TRP-${rnd()}`, orgRef]);
  return r.insertId;
}
const build = (userId: number, label: string, extra: Record<string, unknown> = {}) =>
  callerFor(userId).comms.packageBuild({ label, segments: [{ segmentId: `SEG-${rnd()}`, label: "Forestry Trunk Road", lengthKm: 12 }], province: "AB", ...extra } as never);

d("a communication package belongs to one organization", () => {
  it("is not built against another organization's trip, and is not fetched or checked across the boundary", async () => {
    const A = await org(), B = await org();
    const dispatcherA = await member(A, "dispatcher"), driverA = await member(A, "driver");
    const dispatcherB = await member(B, "dispatcher"), driverB = await member(B, "driver");

    await expect(build(dispatcherA, `Route ${rnd()}`, { tripId: await trip(B) })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const labelB = `Route ${rnd()}`;
    const builtB = await build(dispatcherB, labelB);
    await expect(callerFor(driverA).comms.packageFetch({ packageRef: builtB.packageRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(driverA).comms.packageFetch({ label: labelB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispatcherA).comms.packageStatus({ packageRef: builtB.packageRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The owner's driver carries it.
    await expect(callerFor(driverB).comms.packageFetch({ label: labelB })).resolves.toMatchObject({ packageRef: builtB.packageRef });
  }, 60_000);

  it("one organization's build never supersedes another's package of the same label", async () => {
    const A = await org(), B = await org();
    const dispatcherA = await member(A, "dispatcher"), driverA = await member(A, "driver");
    const dispatcherB = await member(B, "dispatcher");
    const label = `Shared road name ${rnd()}`;

    const builtA = await build(dispatcherA, label);
    const builtB = await build(dispatcherB, label);
    expect(builtB.supersedes).toBeNull();
    const [[{ status }]] = (await pool.query("SELECT status FROM communicationPackages WHERE packageRef = ?", [builtA.packageRef])) as unknown as [[{ status: string }]];
    expect(status).toBe("current");
    // A's driver, asking by label, gets A's package — not B's newer one.
    await expect(callerFor(driverA).comms.packageFetch({ label })).resolves.toMatchObject({ packageRef: builtA.packageRef });
  }, 60_000);
});
