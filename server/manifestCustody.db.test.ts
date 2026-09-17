/**
 * P3.1 — the manifest chain of custody through the real router (0129/0130).
 *
 * The five invariants the checkpoint promised, each asserted by its reason:
 * a tenant cannot bind another tenant's operator or unit; a sealed manifest
 * cannot be silently reassigned (router and trigger); an amendment needs a
 * reason and a second person and keeps the previous hash; facility acceptance
 * cannot precede arrival; a duplicate ticket is detected and named; closing
 * follows the load class's evidence profile — REVIEW with none, BLOCKED
 * naming what is missing. Plus: the backfill kept the legacy text as snapshots.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 210_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const T = (h: number) => new Date(Date.UTC(2026, 8, 17, h));

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function legacyMember(roles: string[]) {
  const userId = seq++;
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function owned(orgRef: string, recordType: "unit" | "operator" | "load", recordId: number) {
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, recordType, recordId]);
}
async function fixtures(orgRef: string) {
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, licenseNumber) VALUES (?,?)", [`Op ${rnd()}`, `LIC-${rnd()}`]);
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  const [tr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`T-${rnd()}`, "trailer"]);
  const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name) VALUES (?)", [`Fixture Disposal ${rnd()}`]);
  await owned(orgRef, "operator", op.insertId); await owned(orgRef, "unit", u.insertId); await owned(orgRef, "unit", tr.insertId);
  const manifestNumber = `MAN-${rnd()}`;
  // P4.1: a manifest belongs to a tenant (manifests.orgRef, written since v22.48); the fixture stamps the one it is for.
  await pool.execute("INSERT INTO manifests (manifestNumber, material, driver, trailer, facility, status, orgRef) VALUES (?,?,?,?,?,'draft',?)", [manifestNumber, "produced water", "Text Driver", "Text Trailer", "Text Facility", orgRef]);
  return { operatorId: op.insertId, unitId: u.insertId, trailerId: tr.insertId, facilityId: f.insertId, manifestNumber };
}
async function evidence(title: string) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt) VALUES (?,?,NOW())", [title, "ticket"]);
  return e.insertId;
}

d("binding and tenancy", () => {
  it("binds canonical records with snapshots of what they were called, and refuses another tenant's operator or unit", async () => {
    const a = await org(), b = await org();
    const office = await member(a, ["office"]);
    const f = await fixtures(a);
    const r = await callerFor(office).manifestCustody.bind({ manifestNumber: f.manifestNumber, operatorId: f.operatorId, unitId: f.unitId, trailerUnitId: f.trailerId, destinationFacilityId: f.facilityId, loadClass: "produced_water" });
    expect(r.snapshots.map(s => s.role).sort()).toEqual(["destination_facility", "operator", "trailer", "unit"]);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    const other = await fixtures(b);
    await expect(callerFor(office).manifestCustody.bind({ manifestNumber: f.manifestNumber, operatorId: other.operatorId })).rejects.toThrow(/Operator is not owned by this organization/);
    await expect(callerFor(office).manifestCustody.bind({ manifestNumber: f.manifestNumber, unitId: other.unitId })).rejects.toThrow(/Unit is not owned by this organization/);
    // A manifest owned by A is invisible to B, not "forbidden" — nothing about its existence leaks.
    const officeB = await member(b, ["office"]);
    await expect(callerFor(officeB).manifestCustody.chain({ manifestNumber: f.manifestNumber })).rejects.toThrow(/Manifest not found/);
  }, 20_000);
});

d("custody, sealing, and the guard", () => {
  it("seals on departure; acceptance cannot precede arrival; a sealed manifest is not silently reassigned — by the router or by raw SQL", async () => {
    const a = await org(); const office = await member(a, ["office"]); const f = await fixtures(a);
    const c = callerFor(office);
    await c.manifestCustody.bind({ manifestNumber: f.manifestNumber, operatorId: f.operatorId, unitId: f.unitId, destinationFacilityId: f.facilityId, loadClass: "produced_water" });
    await c.manifestCustody.custodyRecord({ manifestNumber: f.manifestNumber, eventType: "loaded", occurredAt: T(6) });
    // Accepting before arriving is refused by its reason.
    await expect(c.manifestCustody.custodyRecord({ manifestNumber: f.manifestNumber, eventType: "accepted_by_facility", occurredAt: T(7), facilityId: f.facilityId })).rejects.toThrow(/CUSTODY_OUT_OF_ORDER/);
    const dep = await c.manifestCustody.custodyRecord({ manifestNumber: f.manifestNumber, eventType: "departed_origin", occurredAt: T(7) });
    expect(dep.sealed).toBe(true);
    // The router refuses a rebind after sealing.
    await expect(c.manifestCustody.bind({ manifestNumber: f.manifestNumber, unitId: f.trailerId })).rejects.toThrow(/sealed/);
    // And so does the database, around the router.
    await expect(pool.execute("UPDATE manifests SET driver = 'Somebody Else' WHERE manifestNumber = ?", [f.manifestNumber])).rejects.toThrow(/require an amendment/);
    await expect(pool.execute("UPDATE manifests SET operatorId = 999999 WHERE manifestNumber = ?", [f.manifestNumber])).rejects.toThrow(/require an amendment/);
  }, 20_000);

  it("amends only with a reason, a second person and a real change — keeping the previous hash", async () => {
    const a = await org(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]); const f = await fixtures(a);
    const c = callerFor(office);
    await c.manifestCustody.bind({ manifestNumber: f.manifestNumber, operatorId: f.operatorId, unitId: f.unitId, loadClass: "produced_water" });
    await c.manifestCustody.custodyRecord({ manifestNumber: f.manifestNumber, eventType: "loaded", occurredAt: T(6) });
    await c.manifestCustody.custodyRecord({ manifestNumber: f.manifestNumber, eventType: "departed_origin", occurredAt: T(7) });
    const before = await c.manifestCustody.chain({ manifestNumber: f.manifestNumber });
    const amend = { manifestNumber: f.manifestNumber, reasonCode: "party_correction" as const, reasonText: "Trailer swapped at the lease; the field ticket names the second trailer", requestedByUserId: office, changes: { trailerUnitId: f.trailerId } };
    await expect(callerFor(office).manifestCustody.amend(amend)).rejects.toThrow(/AMENDMENT_SAME_PERSON/);
    await expect(callerFor(mgr).manifestCustody.amend({ ...amend, reasonText: "typo" })).rejects.toThrow(/AMENDMENT_NO_REASON/);
    await expect(callerFor(mgr).manifestCustody.amend({ ...amend, changes: {} })).rejects.toThrow(/AMENDMENT_NO_CHANGE/);
    const done = await callerFor(mgr).manifestCustody.amend(amend);
    expect(done.amendmentNo).toBe(1);
    expect(done.previousHash).toBe(before.currentHash);
    expect(done.replacementHash).not.toBe(done.previousHash);
    const after = await c.manifestCustody.chain({ manifestNumber: f.manifestNumber });
    expect(after.manifest.trailerUnitId).toBe(f.trailerId);
    expect(after.manifest.amendmentCount).toBe(1);
    expect(after.amendments[0]?.changesJson).toContain("trailerUnitId");
    expect(after.snapshots.filter(s => s.source === "amendment").map(s => s.role)).toEqual(["trailer"]);
  }, 20_000);
});

d("evidence and closing", () => {
  it("detects a duplicate ticket across manifests, and closes only against an approved evidence profile", async () => {
    const a = await org(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]); const f = await fixtures(a); const g = await fixtures(a);
    const c = callerFor(office);
    for (const m of [f, g]) {
      await c.manifestCustody.bind({ manifestNumber: m.manifestNumber, operatorId: m.operatorId, unitId: m.unitId, destinationFacilityId: m.facilityId, loadClass: "produced_water" });
      for (const [ev, h] of [["loaded", 6], ["departed_origin", 7], ["arrived_facility", 9], ["accepted_by_facility", 10], ["unloaded", 11]] as const)
        await c.manifestCustody.custodyRecord({ manifestNumber: m.manifestNumber, eventType: ev, occurredAt: T(h), facilityId: m.facilityId });
    }
    const disposal = await evidence("Disposal ticket DSP-1"), scale = await evidence("Scale ticket SC-1"), photo = await evidence("Photo");
    await c.manifestCustody.evidenceAttach({ manifestNumber: f.manifestNumber, evidenceRecordId: disposal, relationship: "disposal_ticket" });
    await expect(c.manifestCustody.evidenceAttach({ manifestNumber: g.manifestNumber, evidenceRecordId: disposal, relationship: "disposal_ticket" }))
      .rejects.toThrow(new RegExp(`DUPLICATE_TICKET.*${f.manifestNumber}`));
    // The same photo may be evidence on both — a photo is not a ticket.
    await c.manifestCustody.evidenceAttach({ manifestNumber: f.manifestNumber, evidenceRecordId: photo, relationship: "photo" });
    await c.manifestCustody.evidenceAttach({ manifestNumber: g.manifestNumber, evidenceRecordId: photo, relationship: "photo" });

    // No profile: REVIEW. Unapproved profile: REVIEW. Approved and missing: BLOCKED naming it. Complete: PASS.
    expect((await c.manifestCustody.close({ manifestNumber: f.manifestNumber, occurredAt: T(12) })).verdict).toBe("REVIEW");
    await c.manifestCustody.evidenceProfileSet({ loadClass: "produced_water", required: ["disposal_ticket", "scale_ticket"] });
    expect(await c.manifestCustody.close({ manifestNumber: f.manifestNumber, occurredAt: T(12) })).toMatchObject({ verdict: "REVIEW", code: "PROFILE_NOT_APPROVED" });
    await expect(c.manifestCustody.evidenceProfileApprove({ loadClass: "produced_water" })).rejects.toThrow(/second person/);
    await callerFor(mgr).manifestCustody.evidenceProfileApprove({ loadClass: "produced_water" });
    expect(await c.manifestCustody.close({ manifestNumber: f.manifestNumber, occurredAt: T(12) })).toMatchObject({ verdict: "BLOCKED", missing: ["scale_ticket"] });
    await c.manifestCustody.evidenceAttach({ manifestNumber: f.manifestNumber, evidenceRecordId: scale, relationship: "scale_ticket" });
    const closed = await c.manifestCustody.close({ manifestNumber: f.manifestNumber, occurredAt: T(12) });
    expect(closed.verdict).toBe("PASS");
    const chain = await c.manifestCustody.chain({ manifestNumber: f.manifestNumber });
    expect(chain.manifest.status).toBe("complete");
    expect(chain.events[chain.events.length - 1]?.eventType).toBe("closed");
    // Closed: no more evidence, no more amendments.
    await expect(c.manifestCustody.evidenceAttach({ manifestNumber: f.manifestNumber, evidenceRecordId: await evidence("late"), relationship: "photo" })).rejects.toThrow(/closed manifest/);
  }, 30_000);
});

d("the backfill", () => {
  it("kept every legacy text party as a snapshot row, and the text itself", async () => {
    // P4.1: a legacy manifest (no orgRef) is the historical single tenant's — read here by an unaffiliated office user,
    // not by an organization's member, who would not find it.
    const office = await legacyMember(["office"]);
    // A legacy manifest: text parties, no references. Re-run the backfill statements for it, as the migration did for the rows it found.
    const manifestNumber = `MAN-LEGACY-${rnd()}`;
    await pool.execute("INSERT INTO manifests (manifestNumber, driver, trailer, route, facility, status) VALUES (?,?,?,?,?,'verified')", [manifestNumber, "R. Legacy", "TR-77", "Hwy 63 north", "Old Facility Name Ltd."]);
    for (const [role, col] of [["operator", "driver"], ["trailer", "trailer"], ["route", "route"], ["destination_facility", "facility"]] as const)
      await pool.execute(`INSERT INTO manifestPartySnapshots (manifestId, role, canonicalEntityId, capturedName, source) SELECT id, ?, NULL, ${col}, 'backfilled_text' FROM manifests WHERE manifestNumber = ?`, [role, manifestNumber]);
    const chain = await callerFor(office).manifestCustody.chain({ manifestNumber });
    expect(chain.snapshots.map(s => [s.role, s.capturedName, s.source])).toEqual([
      ["operator", "R. Legacy", "backfilled_text"], ["trailer", "TR-77", "backfilled_text"], ["route", "Hwy 63 north", "backfilled_text"], ["destination_facility", "Old Facility Name Ltd.", "backfilled_text"],
    ]);
    expect(chain.manifest.facility).toBe("Old Facility Name Ltd.");
    expect(chain.manifest.destinationFacilityId).toBeNull();
  }, 20_000);
});
