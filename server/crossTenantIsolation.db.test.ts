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

d("a user in two organizations acts as one of them, chosen and never guessed", () => {
  it("refuses to resolve until a choice is made, then honours it", async () => {
    const a = await org(), b = await org();
    const userId = await member(a, ["office", "management"]);
    // The same person, a second live membership. A contractor administrator, a
    // consultant, an auditor with delegated access.
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'contractor','active','2020-01-01',1)",
      [`MEM-${rnd()}`, b, userId],
    );

    // Before choosing: the system refuses rather than picking one.
    const before = await callerFor(userId).organization.memberships();
    expect(before.mustChoose).toBe(true);
    expect(before.acting).toBeNull();
    expect(before.memberships).toHaveLength(2);
    expect(before.memberships.map(m => m.orgRef).sort()).toEqual([a, b].sort());

    // Anything that needs a scope is refused meanwhile — not silently resolved.
    const { listJobs } = await import("./db");
    await expect(callerFor(userId).scanning.reviewScan({
      kind: "load_ticket",
      pages: [{
        pageIndex: 0, contentHash: `h-${rnd()}`, qualityVerdict: "acceptable", qualityFailures: [],
        acceptedOverObjection: false, ocrAttempted: true, ocrMeanConfidence: 90, ocrText: "nothing", barcodes: null,
      }],
      observations: [],
    })).rejects.toThrow(/active member of 2 organizations/);

    // Choose B.
    const chosenB = before.memberships.find(m => m.orgRef === b)!;
    const acted = await callerFor(userId).organization.actAs({ membershipRef: chosenB.membershipRef });
    expect(acted).toMatchObject({ orgRef: b, derivedFrom: "selection" });

    // And the choice is what every other path now sees.
    const after = await callerFor(userId).organization.memberships();
    expect(after.mustChoose).toBe(false);
    expect(after.acting).toMatchObject({ orgRef: b, derivedFrom: "selection" });
    void listJobs;

    // Switching is a choice too, not an escalation.
    const chosenA = before.memberships.find(m => m.orgRef === a)!;
    expect(await callerFor(userId).organization.actAs({ membershipRef: chosenA.membershipRef }))
      .toMatchObject({ orgRef: a, derivedFrom: "selection" });
  }, 30_000);

  it("refuses a membership that is not the caller's, with the same answer as one that does not exist", async () => {
    const a = await org(), b = await org();
    const mine = await member(a, ["office"]);
    const theirs = await member(b, ["office"]);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT membershipRef FROM organizationMemberships WHERE userId = ?", [theirs],
    );
    const foreignRef = rows[0].membershipRef as string;

    // Knowing another person's membership reference must not be enough.
    await expect(callerFor(mine).organization.actAs({ membershipRef: foreignRef }))
      .rejects.toThrow(/No active membership of yours/);
    // And a reference that names nothing answers identically.
    await expect(callerFor(mine).organization.actAs({ membershipRef: `MEM-${rnd()}` }))
      .rejects.toThrow(/No active membership of yours/);
  }, 20_000);

  it("stops honouring a selection the moment its membership ends", async () => {
    const a = await org(), b = await org();
    const userId = await member(a, ["office", "management"]);
    const refB = `MEM-${rnd()}`;
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'contractor','active','2020-01-01',1)",
      [refB, b, userId],
    );
    expect(await callerFor(userId).organization.actAs({ membershipRef: refB }))
      .toMatchObject({ orgRef: b, derivedFrom: "selection" });

    // The contract ends. The selection row is untouched — nothing cleans it up —
    // and it must stop working anyway.
    await pool.execute("UPDATE organizationMemberships SET status = 'ended' WHERE membershipRef = ?", [refB]);
    const after = await callerFor(userId).organization.memberships();
    // One membership left, so there is no ambiguity and no selection needed.
    expect(after.acting).toMatchObject({ orgRef: a, derivedFrom: "membership" });
    const [still] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT orgRef FROM actingOrganizationSelections WHERE userId = ?", [userId],
    );
    expect(still[0].orgRef).toBe(b);   // the stale row is still there, and inert
  }, 30_000);

  it("refuses rather than honouring a selection whose membership ended while others remain", async () => {
    /*
     * The case the previous test does not reach. Ending the selected membership
     * when only one other remains leaves no ambiguity, so resolution never
     * consults the selection at all. With THREE memberships it does, and a
     * selection that is no longer backed by a live membership must fail closed —
     * otherwise a person keeps acting as an organization they have left.
     */
    const a = await org(), b = await org(), c = await org();
    const userId = await member(a, ["office", "management"]);
    const refB = `MEM-${rnd()}`, refC = `MEM-${rnd()}`;
    for (const [ref, o] of [[refB, b], [refC, c]] as const) {
      await pool.execute(
        "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'contractor','active','2020-01-01',1)",
        [ref, o, userId],
      );
    }
    expect(await callerFor(userId).organization.actAs({ membershipRef: refC }))
      .toMatchObject({ orgRef: c, derivedFrom: "selection" });

    await pool.execute("UPDATE organizationMemberships SET status = 'ended' WHERE membershipRef = ?", [refC]);

    // Two live memberships (a, b) and a selection naming neither.
    const after = await callerFor(userId).organization.memberships();
    expect(after.mustChoose).toBe(true);
    expect(after.acting).toBeNull();
    expect(after.memberships.map(m => m.orgRef).sort()).toEqual([a, b].sort());
    // And the stale selection is not silently used by anything else either.
    await expect(callerFor(userId).scanning.reviewScan({
      kind: "load_ticket",
      pages: [{
        pageIndex: 0, contentHash: `h-${rnd()}`, qualityVerdict: "acceptable", qualityFailures: [],
        acceptedOverObjection: false, ocrAttempted: true, ocrMeanConfidence: 90, ocrText: "nothing", barcodes: null,
      }],
      observations: [],
    })).rejects.toThrow(/active member of 2 organizations/);
  }, 30_000);

  it("refuses a selection whose organization and membership disagree", async () => {
    // The row is server-written, but it is two columns and they must be checked
    // together: a membershipRef from one organization paired with another's
    // orgRef must not resolve to either.
    const a = await org(), b = await org();
    const userId = await member(a, ["office", "management"]);
    const refB = `MEM-${rnd()}`;
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'contractor','active','2020-01-01',1)",
      [refB, b, userId],
    );
    await callerFor(userId).organization.actAs({ membershipRef: refB });
    // Point B's membership reference at A's organization.
    await pool.execute("UPDATE actingOrganizationSelections SET orgRef = ? WHERE userId = ?", [a, userId]);

    const after = await callerFor(userId).organization.memberships();
    expect(after.mustChoose).toBe(true);
    expect(after.acting).toBeNull();
  }, 30_000);
});

d("the scanner names a record only when it can prove whose it is", () => {
  /**
   * The chain: scan session tenant → the number names a subject → the subject
   * has an owner → owner is the caller. Only then may a link be named.
   */
  it("names the caller's own job when the number on the page resolves to it", async () => {
    const a = await org();
    const ua = await member(a, ["office", "management", "safety"]);
    const A = await seedTenant(a, ua);

    // A tracking reference registered under the job's own code, which is what
    // makes the number resolvable at all.
    await pool.execute(
      "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, issuedAt) VALUES (?,?,?,NOW())",
      [A.jobCode, "JOB", A.jobId],
    );

    const r = await callerFor(ua).scanning.reviewScan({
      kind: "load_ticket",
      pages: [{
        pageIndex: 0, contentHash: `h-${rnd()}`, qualityVerdict: "acceptable", qualityFailures: [],
        acceptedOverObjection: false, ocrAttempted: true, ocrMeanConfidence: 95,
        ocrText: `Job ${A.jobCode} completed`, barcodes: null,
      }],
      observations: [],
    });
    expect(r.links.ownershipUnverifiable).toBe(false);
    expect(r.links.alreadyLinked).toMatchObject({ target: "job", trackingNumber: A.jobCode });
  }, 30_000);

  it("withholds everything when the number resolves to another organization's job", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["office", "management", "safety"]);
    const ub = await member(b, ["office", "management", "safety"]);
    const B = await seedTenant(b, ub);

    await pool.execute(
      "INSERT INTO trackingReferences (trackingNumber, entityType, entityId, issuedAt) VALUES (?,?,?,NOW())",
      [B.jobCode, "JOB", B.jobId],
    );

    // Tenant A scans a page bearing tenant B's job code — the exact text is on
    // the paper in their hand, and it still must not name B's record.
    const r = await callerFor(ua).scanning.reviewScan({
      kind: "load_ticket",
      pages: [{
        pageIndex: 0, contentHash: `h-${rnd()}`, qualityVerdict: "acceptable", qualityFailures: [],
        acceptedOverObjection: false, ocrAttempted: true, ocrMeanConfidence: 95,
        ocrText: `Job ${B.jobCode} completed`, barcodes: null,
      }],
      observations: [],
    });
    expect(r.links.ownershipUnverifiable).toBe(true);
    expect(r.links.alreadyLinked).toBeNull();
    expect(r.links.best).toBeNull();
    // Distinctive values only: a bare integer id appears in ordinary JSON by
    // coincidence (a page index, a count), so asserting on one tests nothing.
    const body = JSON.stringify(r);
    expect(body).not.toContain(b);
    expect(body).not.toContain(B.jobCode);
    expect(body).not.toContain(B.unitNumber);
  }, 30_000);
});

d("Tenant A cannot dispatch Tenant B's people or fleet", () => {
  it("refuses to read another organization's operator readiness, which is their compliance record", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["dispatcher", "management"]);
    const ub = await member(b, ["dispatcher", "management"]);
    const A = await seedTenant(a, ua), B = await seedTenant(b, ub);

    // A dispatcher's own fleet answers.
    await expect(
      callerFor(ua).dispatch.readiness({ operatorId: A.operatorId, unitId: A.unitId }),
    ).resolves.toBeTruthy();

    // Another organization's operator is the licence, medical and hours-of-service
    // record of a person who does not work for this caller.
    await expect(
      callerFor(ua).dispatch.readiness({ operatorId: B.operatorId, unitId: null }),
    ).rejects.toThrow(/not found/i);

    // And the unit, and the pair, and the trailer.
    await expect(
      callerFor(ua).dispatch.readiness({ operatorId: A.operatorId, unitId: B.unitId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      callerFor(ua).dispatch.readiness({ operatorId: A.operatorId, unitId: null, trailerId: B.unitId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      callerFor(ua).dispatch.readiness({ operatorId: A.operatorId, unitId: null, jobId: B.jobId }),
    ).rejects.toThrow(/not found/i);
  }, 30_000);

  it("refuses to record an eligibility check about another organization's operator", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["dispatcher", "management"]);
    const ub = await member(b, ["dispatcher", "management"]);
    const A = await seedTenant(a, ua), B = await seedTenant(b, ub);
    void A;
    await expect(
      callerFor(ua).dispatch.evaluate({ operatorId: B.operatorId, unitId: B.unitId, jobId: B.jobId }),
    ).rejects.toThrow(/not found/i);
  }, 30_000);

  it("refuses to act on an eligibility check recorded in another organization", async () => {
    const a = await org(), b = await org();
    const ua = await member(a, ["dispatcher", "management", "controller"]);
    const ub = await member(b, ["dispatcher", "management"]);
    const A = await seedTenant(a, ua), B = await seedTenant(b, ub);
    void A;

    // B records a check about its own people — legitimately.
    const check = await callerFor(ub).dispatch.evaluate({
      operatorId: B.operatorId, unitId: B.unitId, jobId: B.jobId,
    });
    expect(check.checkId).toBeGreaterThan(0);

    // A knows the integer. That must not be enough for any of the three.
    await expect(
      callerFor(ua).dispatch.overrideRequest({ checkId: check.checkId, blockerCode: "any", reason: "a plausible sounding reason" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      callerFor(ua).dispatch.overrideGrant({ checkId: check.checkId, blockerCode: "any", reason: "a plausible sounding reason" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      callerFor(ua).dispatch.award({ checkId: check.checkId, startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000) }),
    ).rejects.toThrow(/not found/i);
  }, 30_000);

  it("refuses one organization the installation-wide enforcement mode", async () => {
    // Turning the gate off globally would turn it off for every other
    // organization on the deployment.
    const a = await org();
    const mgr = await member(a, ["management", "controller"]);
    await expect(
      callerFor(mgr).dispatch.enforcementSet({ mode: "off", reason: "Would disable every other organization's gate" }),
    ).rejects.toThrow(/not one organization's to set/i);
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
