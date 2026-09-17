/**
 * 0139 — the disposal-facility directory on this lineage: leads stay leads, caching
 * obeys the licence, coordinates verify only from reviewed evidence, assessments
 * fail closed and are immutable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 250_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: string) { const userId = seq++; await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]); return userId; }

d("facility directory — seed and licences", () => {
  it("imports the 23 v7 leads as leads: community-level coordinates, nothing routable, each with lead evidence under the operator's site; a second run is idempotent", async () => {
    const safety = await withRole("safety");
    const first = await callerFor(safety).facilityDirectory.seedLeads();
    const again = await callerFor(safety).facilityDirectory.seedLeads();
    expect(first.inserted + first.existing).toBe(23);
    expect(again).toMatchObject({ inserted: 0, existing: 23, routable: 0 });
    const features = await callerFor(safety).facilityDirectory.features({ province: "AB" });
    expect(features.length).toBeGreaterThanOrEqual(20);
    expect(features.every(f => !f.routable && f.coordinatePrecision === "community_only")).toBe(true);
    const [ev] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM facilityEvidence e JOIN facilities f ON f.id = e.facilityId WHERE f.operatorNameFromSource IS NOT NULL AND e.licenceKey = 'company_website' AND e.reviewState = 'lead' AND e.cachedContent = 0 AND e.title LIKE 'Facility lead%'");
    expect(Number(ev[0]!.n)).toBeGreaterThanOrEqual(23);
    const one = await callerFor(safety).facilityDirectory.get({ facilityKey: "secure-fox-creek-lead" });
    expect(one.routable).toBe(false);
    expect(one.links.googleDirections).toBeNull();   // no directions to a community-level pin
    expect(one.links.website).toContain("secure.ca");
  }, 60_000);

  it("refuses to cache content under the AER's copyright, accepts an AER reference with the WM approval number, and lists the licence register", async () => {
    const office = await withRole("office"), safety = await withRole("safety");
    await callerFor(safety).facilityDirectory.seedLeads();
    await expect(callerFor(office).facilityDirectory.evidenceRecord({ facilityKey: "secure-fox-creek-lead", publisher: "Alberta Energy Regulator", title: "ST107 row", sourceUrl: "https://www.aer.ca/providing-information/data-and-reports/statistical-reports/st107", licenceKey: "aer_copyright", claimType: "regulator_approval", claimValue: "(the whole row copied here)", cachedContent: true, retrievedAt: new Date("2026-09-17") }))
      .rejects.toThrow(/does not permit caching/);
    const okRef = await callerFor(office).facilityDirectory.evidenceRecord({ facilityKey: "secure-fox-creek-lead", publisher: "Alberta Energy Regulator", title: "ST107 lists this facility", sourceUrl: "https://www.aer.ca/providing-information/data-and-reports/statistical-reports/st107", licenceKey: "aer_copyright", claimType: "regulator_approval", cachedContent: false, retrievedAt: new Date("2026-09-17"), regulatorRef: "WM 0000", confidence: "high" });
    expect(okRef).toMatchObject({ reviewState: "lead", attribution: "Source: Alberta Energy Regulator" });
    const f = await callerFor(office).facilityDirectory.get({ facilityKey: "secure-fox-creek-lead" });
    expect(f.facility.regulatorRef).toBe("WM 0000");
    await expect(callerFor(office).facilityDirectory.evidenceRecord({ facilityKey: "secure-fox-creek-lead", publisher: "x", title: "x", sourceUrl: "https://example.com", licenceKey: "not_a_licence", claimType: "other", retrievedAt: new Date() })).rejects.toThrow(/Unknown licence/);
    const lic = await callerFor(office).facilityDirectory.licences.list();
    expect(lic.find(l => l.licenceKey === "aer_copyright")).toMatchObject({ cachePermitted: false, status: "permission_required" });
    expect(lic.find(l => l.licenceKey === "ogl_alberta")).toMatchObject({ cachePermitted: true, attributionText: expect.stringContaining("Open Government Licence – Alberta") });
    expect((await callerFor(office).facilityDirectory.vocabulary.list()).every(v => v.verificationStatus === "candidate")).toBe(true);
  }, 30_000);
});

d("facility directory — verification and assessment", () => {
  it("verifies coordinates only from reviewed, high-confidence coordinate evidence by a second person; assessments fail closed on a lead and go compatible only with everything in place; every assessment is a new immutable row", async () => {
    const office = await withRole("office"), safety = await withRole("safety"), safety2 = await withRole("safety"), dispatcher = await withRole("dispatcher");
    const facilityKey = `fac-${rnd()}`;
    await pool.execute("INSERT INTO facilities (facilityKey, name, status, province, facilityType, latitude, longitude, coordinatePrecision, coordinateSourceUrl, disposition) VALUES (?,?,'open','AB','industrial_waste',54.4,-116.8,'community_only','https://example.org/lead','approximate_facility')", [facilityKey, `Test Facility ${rnd()}`]);
    const [l] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, material) VALUES (?, 1, 'produced water')", [`LD-${rnd()}`]);
    const loadId = l.insertId;
    // 1. A lead assessed as it stands: insufficient information, with the reasons named.
    const a1 = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "produced_water" });
    expect(a1).toMatchObject({ outcome: "insufficient_information", blocking: true, dispatchable: false });
    expect(a1.reasonCodes).toEqual(expect.arrayContaining(["facility_capability_missing", "acceptance_evidence_missing", "coordinate_not_verified"]));
    // 2. Coordinates: recorded by office, refused before review, refused when the recorder reviews, verified after safety reviews.
    const coord = await callerFor(safety).facilityDirectory.evidenceRecord({ facilityKey, publisher: "Government of Alberta", title: "Hydrovac facilities list 2026-04-10", sourceUrl: "https://www.alberta.ca/system/files/epa-facilities-list-hydrovac-waste.pdf", licenceKey: "ogl_alberta", claimType: "site_coordinate", claimValue: "54.4001,-116.8002 (from the listed address)", cachedContent: true, retrievedAt: new Date("2026-09-17"), confidence: "high" });
    await expect(callerFor(safety).facilityDirectory.coordinateVerify({ facilityKey, evidenceId: coord.evidenceId, latitude: 54.4001, longitude: -116.8002, precision: "verified_site" })).rejects.toThrow(/is lead; a second person must review/);
    await expect(callerFor(safety).facilityDirectory.evidenceReview({ evidenceId: coord.evidenceId, reviewState: "reviewed", note: "I checked my own work" })).rejects.toThrow(/second person/);
    await callerFor(safety2).facilityDirectory.evidenceReview({ evidenceId: coord.evidenceId, reviewState: "reviewed", note: "address matches the list; coordinates from the listed address" });
    await expect(callerFor(safety).facilityDirectory.coordinateVerify({ facilityKey, evidenceId: coord.evidenceId, latitude: 54.4001, longitude: -116.8002, precision: "verified_entrance" })).rejects.toThrow(/entrance needs entrance evidence/);
    const v = await callerFor(safety).facilityDirectory.coordinateVerify({ facilityKey, evidenceId: coord.evidenceId, latitude: 54.4001, longitude: -116.8002, precision: "verified_site" });
    expect(v).toMatchObject({ coordinatePrecision: "verified_site", routable: true });
    const g = await callerFor(office).facilityDirectory.get({ facilityKey });
    expect(g.links.googleDirections).toContain("54.4001");
    // 3. Acceptance: verified only from reviewed accepts_waste_stream evidence.
    await expect(callerFor(safety).facilityDirectory.capabilitySet({ facilityKey, wasteCode: "produced_water", acceptanceStatus: "verified" })).rejects.toThrow(/reviewed accepts_waste_stream evidence/);
    const acc = await callerFor(office).facilityDirectory.evidenceRecord({ facilityKey, publisher: "Facility", title: "Acceptance letter", sourceUrl: "https://example.org/acceptance", licenceKey: "company_website", claimType: "accepts_waste_stream", claimValue: "accepts produced water", retrievedAt: new Date("2026-09-10"), confidence: "high" });
    await callerFor(safety).facilityDirectory.evidenceReview({ evidenceId: acc.evidenceId, reviewState: "reviewed", note: "letter on file" });
    await callerFor(safety).facilityDirectory.capabilitySet({ facilityKey, wasteCode: "produced_water", acceptanceStatus: "verified", evidenceId: acc.evidenceId });
    const a2 = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "produced_water", accountRequired: true, accountApproved: false, routeReviewPassed: false });
    expect(a2).toMatchObject({ outcome: "facility_confirmation_required", blocking: true });
    expect(a2.reasonCodes).toEqual(expect.arrayContaining(["account_approval_required", "route_review_required"]));
    const a3 = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "produced_water", accountRequired: true, accountApproved: true, routeReviewPassed: true });
    expect(a3).toMatchObject({ outcome: "compatible_verified", blocking: false, dispatchable: true, engineVersion: "facility-compatibility/1" });
    // 4. A different waste stream is incompatible by name, and the history is three immutable rows.
    const a4 = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "hydrovac_slurry" });
    expect(a4.outcome).toBe("insufficient_information");   // no capability row for slurry: unknown, not refused
    const history = await callerFor(office).facilityDirectory.assessments({ loadId });
    expect(history.map(h => h.outcome)).toEqual(["insufficient_information", "facility_confirmation_required", "compatible_verified", "insufficient_information"]);
    expect(history[0]!.reasonCodes).toContain("coordinate_not_verified");   // the first row still says what it said
  }, 60_000);
});
