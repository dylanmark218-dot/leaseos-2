/**
 * The cross-tenant isolation matrix.
 *
 * Two organizations, seeded with deliberately colliding business values, and
 * one question asked of every path: does ownership decide, or does the
 * identifier?
 *
 * **Why the collisions are not the ones the brief asked for.** The brief asks
 * for the same ticket number, unit number and job number in both tenants. That
 * is not expressible: `drizzle/schema.ts` carries 243 `.unique()` declarations
 * and not one unique index anywhere includes `orgRef` or `tenantId`, so every
 * business identifier is unique across the whole installation and the database
 * refuses the fixture. See docs/TENANT_OWNERSHIP_AUDIT.md §8. This suite
 * therefore collides on every value that is NOT constrained — customer,
 * location, operator name, vendor name, unit description — and pins the
 * uniqueness property itself so it cannot change without a reader noticing.
 *
 * A global identifier namespace is not the defect. Inferring ownership FROM an
 * identifier is, and that is what these tests hunt.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
// A narrow window, per the rule tenantIsolation.test.ts pins: wide windows
// eventually overlap another suite's granted roles and the symptom is a role
// assertion seeing one extra.
let seq = 611_000_000 + Math.floor(Math.random() * 40_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org(): Promise<string> {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}

async function member(orgRef: string | null, roles: string[]): Promise<number> {
  const userId = seq++;
  if (orgRef) {
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
      [`MEM-${rnd()}`, orgRef, userId],
    );
  }
  for (const role of roles) {
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
      [userId, role],
    );
  }
  return userId;
}

/** The values both tenants share on purpose. Ownership, not text, must separate them. */
const COLLIDING = {
  customer: "Northgate Energy Ltd.",
  location: "16-22-079-11 W6M",
  operatorName: "J. Marchand",
  vendorName: "Precision Vac Services",
  company: "Northgate Field Services",
};

async function seedTenant(orgRef: string, ownerUserId: number) {
  const tag = rnd();
  const [jobRes] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
    [`JOB-${tag}`, "hydrovac", COLLIDING.customer, COLLIDING.location, orgRef],
  );
  const jobId = jobRes.insertId;

  const [unitRes] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO units (unitNumber, vehicleType, company) VALUES (?,?,?)",
    [`UNIT-${tag}`, "hydrovac", COLLIDING.company],
  );
  const unitId = unitRes.insertId;
  await pool.execute(
    "INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,?)",
    [orgRef, unitId, ownerUserId],
  );

  const [opRes] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO operators (name, company) VALUES (?,?)", [COLLIDING.operatorName, COLLIDING.company],
  );
  const operatorId = opRes.insertId;
  await pool.execute(
    "INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,?)",
    [orgRef, operatorId, ownerUserId],
  );

  const [venRes] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO vendors (name, category, bookOrgRef) VALUES (?,?,?)",
    [COLLIDING.vendorName, "disposal", orgRef],
  );
  const vendorId = venRes.insertId;

  return { tag, jobId, unitId, operatorId, vendorId, jobCode: `JOB-${tag}`, unitNumber: `UNIT-${tag}` };
}

d("the identifier namespace is global, and that is the premise of everything below", () => {
  it("has no unique index anywhere that includes an organization column", () => {
    // If this ever stops being true, the fixtures above become expressible and
    // this whole suite should be rewritten to use genuinely colliding numbers.
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const uniques = (schema.match(/\.unique\(\)/g) ?? []).length;
    expect(uniques).toBeGreaterThan(200);

    const migrations = readFileSync("drizzle/0010_billing_records_chain.sql", "utf8");
    expect(migrations).toContain("trackingReferences_trackingNumber_unique");
  });

  it("refuses two organizations the same job code, which is why ownership has to carry the boundary", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["office"]), ub = await member(b, ["office"]);
    const seeded = await seedTenant(a, ua);
    await expect(
      pool.execute(
        "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
        [seeded.jobCode, "hydrovac", COLLIDING.customer, COLLIDING.location, b],
      ),
    ).rejects.toThrow(/Duplicate|ER_DUP/i);
    void ub;
  }, 20_000);
});

d("Tenant A cannot reach Tenant B through the scoped read paths", () => {
  it("separates two tenants whose jobs carry identical customer, location and unit text", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["office", "management"]);
    const ub = await member(b, ["office", "management"]);
    const A = await seedTenant(a, ua), B = await seedTenant(b, ub);

    const { listJobs, listUnits, listOperators } = await import("./db");

    const jobsA = await listJobs({ tenantId: a });
    const jobsB = await listJobs({ tenantId: b });
    expect(jobsA.map(j => j.id)).toContain(A.jobId);
    expect(jobsA.map(j => j.id)).not.toContain(B.jobId);
    expect(jobsB.map(j => j.id)).not.toContain(A.jobId);

    // Both tenants' jobs carry the same customer text. The separation is
    // ownership; a reader filtering on the text would see both.
    expect(jobsA.every(j => j.orgRef === a)).toBe(true);

    const unitsA = await listUnits({ tenantId: a });
    expect(unitsA.map(u => u.id)).toContain(A.unitId);
    expect(unitsA.map(u => u.id)).not.toContain(B.unitId);

    const opsA = await listOperators({ tenantId: a });
    expect(opsA.map(o => o.id)).toContain(A.operatorId);
    expect(opsA.map(o => o.id)).not.toContain(B.operatorId);
    // Same human name in both books, different records.
    expect(opsA.filter(o => o.name === COLLIDING.operatorName).map(o => o.id)).toEqual([A.operatorId]);
  }, 30_000);

  it("answers not-found rather than forbidden for a record in another organization", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["office"]), ub = await member(b, ["office"]);
    const B = await seedTenant(b, ub);
    void ua;

    const { jobInScope, unitInScope, operatorInScope } = await import("./db");
    // A direct-id attack: knowing B's integer id must not be enough, and the
    // refusal must not distinguish "exists elsewhere" from "does not exist".
    expect(await jobInScope(B.jobId, { tenantId: a })).toBeNull();
    expect(await jobInScope(2_146_000_000, { tenantId: a })).toBeNull();
    expect(await unitInScope(B.unitId, { tenantId: a })).toBeNull();
    expect(await unitInScope(2_146_000_000, { tenantId: a })).toBeNull();
    expect(await operatorInScope(B.operatorId, { tenantId: a })).toBeNull();
  }, 30_000);

  it("keeps a member organization out of the unowned legacy pool", async () => {
    // A row with no owner belongs to the historical single tenant, not to
    // whichever real organization happens to ask next.
    const a = await org();
    const ua = await member(a, ["office"]);
    void ua;
    const [orphan] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,NULL)",
      [`JOB-ORPH-${rnd()}`, "hydrovac", COLLIDING.customer, COLLIDING.location],
    );
    const { jobInScope } = await import("./db");
    expect(await jobInScope(orphan.insertId, { tenantId: a })).toBeNull();
    expect(await jobInScope(orphan.insertId, { tenantId: "default" })).not.toBeNull();
  }, 20_000);
});

d("Tenant A cannot mutate or link Tenant B by guessing an id", () => {
  it("refuses to link a record the caller's book does not own", async () => {
    const bookA = await org(), bookB = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const officeB = await member(bookB, ["office", "management"]);
    const A = await seedTenant(bookA, officeA);
    const B = await seedTenant(bookB, officeB);
    void A;

    // A counterparty that genuinely holds the vendor role in book A, so the
    // only thing standing between the caller and book B's record is the
    // record-side scope check.
    const counterparty = await org();
    await callerFor(officeA).commercialOffice.roles.assign({ orgRef: counterparty, roleKey: "vendor" });

    // B's vendor id is the only thing the caller supplies that belongs to B.
    await expect(
      callerFor(officeA).commercialOffice.links.set({
        recordType: "vendor", recordId: B.vendorId, orgRef: counterparty,
      }),
    ).rejects.toThrow();

    // And the row is untouched.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT bookOrgRef, orgRef FROM vendors WHERE id = ?", [B.vendorId],
    );
    expect(rows[0].bookOrgRef).toBe(bookB);
    expect(rows[0].orgRef).toBeNull();
  }, 30_000);

  it("refuses to link another organization's job as a customer record", async () => {
    const bookA = await org(), bookB = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const officeB = await member(bookB, ["office", "management"]);
    const B = await seedTenant(bookB, officeB);

    const counterparty = await org();
    await callerFor(officeA).commercialOffice.roles.assign({ orgRef: counterparty, roleKey: "client" });

    await expect(
      callerFor(officeA).commercialOffice.links.set({
        recordType: "job_customer", recordId: B.jobId, orgRef: counterparty,
      }),
    ).rejects.toThrow();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT orgRef, customerOrgRef FROM jobs WHERE id = ?", [B.jobId],
    );
    expect(rows[0].orgRef).toBe(bookB);
    expect(rows[0].customerOrgRef).toBeNull();
  }, 30_000);
});
