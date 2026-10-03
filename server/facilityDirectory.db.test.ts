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

/**
 * 0233 — the ArcGIS importer reads only from a source a person approved in the source registry. This is
 * what an operator does once after deploying: seed the registry, then a manager approves the source as it
 * stands. A re-request, when one is needed, comes from a second manager, because whoever asks for an
 * approval does not grant it.
 */
async function approvedInRegistry(sourceKey: string) {
  const manager = await withRole("management"), requester = await withRole("management");
  await callerFor(manager).sourceRegistry.seed();
  let { source, approvals } = await callerFor(manager).sourceRegistry.get({ sourceKey });
  const standing = approvals.find(a => a.state === "approved");
  if (source.lifecycle === "approved" && standing && standing.sourceRevision === source.revision && standing.expiresAt && new Date(standing.expiresAt).getTime() > Date.now() + 86_400_000) return;
  if (source.lifecycle !== "pending_approval") {
    await callerFor(requester).sourceRegistry.requestReview({ sourceKey, expectedRowVersion: source.rowVersion, scope: ["facility_directory.arcgis_import"], reason: "facility directory test: the layer is imported below" });
    source = (await callerFor(manager).sourceRegistry.get({ sourceKey })).source;
  }
  await callerFor(manager).sourceRegistry.approve({ sourceKey, expectedRowVersion: source.rowVersion, reviewBy: new Date(Date.now() + 90 * 86_400_000), note: "facility directory test: approving the seeded layer as it stands" });
}

d("facility directory — seed and licences", () => {
  it("imports the 36 leads (23 from v7, 13 more from the operator brief) as leads: community-level or unknown coordinates, nothing routable, each with lead evidence under the operator's site; a second run is idempotent", async () => {
    const safety = await withRole("safety");
    const first = await callerFor(safety).facilityDirectory.seedLeads();
    const again = await callerFor(safety).facilityDirectory.seedLeads();
    expect(first.inserted + first.existing).toBe(36);
    expect(again).toMatchObject({ inserted: 0, existing: 36, routable: 0 });
    const features = await callerFor(safety).facilityDirectory.features({ province: "AB" });
    expect(features.length).toBeGreaterThanOrEqual(20);
    const seeded = features.filter(f => /-(lead|ambiguous|service)$/.test(f.facilityKey));
    expect(seeded.length).toBeGreaterThanOrEqual(20);
    expect(seeded.every(f => !f.routable && f.coordinatePrecision === "community_only")).toBe(true);
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

d("facility directory — the driver's half", () => {
  it("finds sites near Edson by straight-line distance with the precision caveat; a call-ahead acceptance is the facility confirmation the engine asks for, and it expires; wait reports age into UNKNOWN; hours carry who stated them", async () => {
    const safety = await withRole("safety"), safety2 = await withRole("safety"), driver = await withRole("driver"), dispatcher = await withRole("dispatcher");
    await callerFor(safety).facilityDirectory.seedLeads();
    // 1. Nearby: from Edson, the Edson leads are closest and every lead says the distance is to the community.
    const near = await callerFor(driver).facilityDirectory.nearby({ latitude: 53.58, longitude: -116.44, radiusKm: 150, wasteCode: "hydrovac_slurry" });
    expect(near.facilities.length).toBeGreaterThan(3);
    expect(near.facilities[0]!.distanceKm).toBeLessThan(5);
    const leads = near.facilities.filter(f => f.coordinatePrecision === "community_only");
    expect(leads.length).toBeGreaterThan(3);
    expect(leads.every(f => f.acceptance === "unknown" && f.distanceNote === "distance to the community, not the gate")).toBe(true);
    // 2. A facility with verified coordinates and a capability that needs the facility's confirmation.
    const facilityKey = `fac-${rnd()}`;
    await pool.execute("INSERT INTO facilities (facilityKey, name, status, province, facilityType, phone, latitude, longitude, coordinatePrecision, coordinateSourceUrl, disposition) VALUES (?,?,'open','AB','trd','780-555-0100',53.60,-116.40,'verified_site','https://example.org/verified','verified_facility')", [facilityKey, `Edson TRD ${rnd()}`]);
    const ev = await callerFor(safety).facilityDirectory.evidenceRecord({ facilityKey, publisher: "Facility", title: "Accepts slurry subject to daily confirmation", sourceUrl: "https://example.org/acceptance", licenceKey: "company_website", claimType: "accepts_waste_stream", retrievedAt: new Date(), confidence: "medium" });
    await callerFor(safety2).facilityDirectory.evidenceReview({ evidenceId: ev.evidenceId, reviewState: "reviewed", note: "confirmed with the facility manager" });
    await callerFor(safety).facilityDirectory.capabilitySet({ facilityKey, wasteCode: "hydrovac_slurry", acceptanceStatus: "confirmation_required", evidenceId: ev.evidenceId, conditions: "call the day of" });
    const [l] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, material) VALUES (?, 1, 'hydrovac slurry')", [`LD-${rnd()}`]);
    const loadId = l.insertId;
    const before = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "hydrovac_slurry", routeReviewPassed: true });
    expect(before).toMatchObject({ outcome: "facility_confirmation_required", dispatchable: false, callAhead: null });
    expect(before.reasonCodes).toContain("facility_confirmation_required");
    // 3. The driver calls ahead: an acceptance needs who they spoke to; conditions must be stated.
    await expect(callerFor(driver).facilityDirectory.callAhead.record({ facilityKey, loadId, outcome: "accepted" })).rejects.toThrow(/who at the facility accepted/);
    await expect(callerFor(driver).facilityDirectory.callAhead.record({ facilityKey, loadId, outcome: "accepted_with_conditions", spokeTo: "Dana at the scale" })).rejects.toThrow(/State the conditions/);
    const call = await callerFor(driver).facilityDirectory.callAhead.record({ facilityKey, loadId, outcome: "accepted", spokeTo: "Dana at the scale", quotedWaitMinutes: 20, validForHours: 6 });
    expect(call.validUntil).not.toBeNull();
    const after = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "hydrovac_slurry", routeReviewPassed: true });
    expect(after).toMatchObject({ outcome: "compatible_verified", dispatchable: true, callAhead: { callAheadRef: call.callAheadRef, outcome: "accepted" } });
    // 4. The driver view: wait quoted on the call is the freshest report; hours unknown until someone states them.
    const view = await callerFor(driver).facilityDirectory.driverView({ facilityKey, loadId });
    expect(view.currentWait).toMatchObject({ state: "reported", waitMinutes: 20, source: "facility_stated" });
    expect(view.callAhead).toMatchObject({ callAheadRef: call.callAheadRef, spokeTo: "Dana at the scale" });
    expect(view.hoursToday).toMatchObject({ state: "unknown" });
    expect(view.links.googleDirections).toContain("53.6");
    await callerFor(dispatcher).facilityDirectory.hours.set({ facilityKey, source: "facility_stated", statedAt: new Date(), days: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, opensAt: "07:00", closesAt: "17:00" })) });
    const view2 = await callerFor(driver).facilityDirectory.driverView({ facilityKey, loadId });
    expect(view2.hoursToday).toMatchObject({ state: "as_stated", opensAt: "07:00", closesAt: "17:00", source: "facility_stated" });
    // 5. An expired call-ahead is no confirmation; an old wait report is no wait.
    await pool.execute("UPDATE facilityCallAheads SET validUntil = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE callAheadRef = ?", [call.callAheadRef]);
    await pool.execute("UPDATE facilityWaitReports SET reportedAt = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE facilityId = (SELECT id FROM facilities WHERE facilityKey = ?)", [facilityKey]);
    const expired = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId, facilityKey, loadWasteCode: "hydrovac_slurry", routeReviewPassed: true });
    expect(expired).toMatchObject({ outcome: "facility_confirmation_required", dispatchable: false, callAhead: null });
    const view3 = await callerFor(driver).facilityDirectory.driverView({ facilityKey, loadId });
    expect(view3.currentWait).toMatchObject({ state: "unknown" });
    expect(view3.callAhead).toMatchObject({ state: "none_valid" });
    // 6. A driver's own observation of the queue.
    await callerFor(driver).facilityDirectory.wait.report({ facilityKey, waitMinutes: 45, trucksInQueue: 6 });
    expect((await callerFor(driver).facilityDirectory.driverView({ facilityKey })).currentWait).toMatchObject({ state: "reported", waitMinutes: 45, trucksInQueue: 6, source: "driver_observed" });
  }, 60_000);
});

d("facility directory — the operator briefs of 2026-09-17", () => {
  it("seeds 77 sites: LSDs become approximate_site pins (never routable), NTS stays unconverted, contacts land in their columns, former operators become aliases, Virden is conflicting and fails closed, a producer-private site fails closed", async () => {
    const safety = await withRole("safety"), driver = await withRole("driver"), dispatcher = await withRole("dispatcher");
    const first = await callerFor(safety).facilityDirectory.seedBrief();
    expect(first.inserted + first.existing).toBe(77);
    expect(first.routable).toBe(0);
    const again = await callerFor(safety).facilityDirectory.seedBrief();
    expect(again).toMatchObject({ inserted: 0, existing: 77 });
    // R360 West Edson TRD: LSD-derived pin near Edson, dispatch and site phones, a former-operator alias, not routable.
    const edson = await callerFor(driver).facilityDirectory.driverView({ facilityKey: "r360-west-edson-trd" });
    expect(edson.facility).toMatchObject({ coordinatePrecision: "approximate_site", legalLocation: "07-18-053-18 W5M", routable: false, parentCompany: "Waste Connections", commercialAccess: "commercial_preapproval_required" });
    expect(edson.contact).toMatchObject({ phone: "780-723-1912", dispatchPhone: "1-855-591-5360", email: "info@r360canada.com" });
    expect(edson.links.googleDirections).toBeNull();
    expect(edson.warnings).toEqual(expect.arrayContaining([expect.stringContaining("not a verified entrance")]));
    const g = await callerFor(driver).facilityDirectory.get({ facilityKey: "r360-west-edson-trd" });
    expect(g.aliases.map(a => a.alias)).toEqual(expect.arrayContaining(["SECURE West Edson TRD", "Tervita West Edson TRD"]));
    expect(Math.abs(g.facility.latitude! - 53.56)).toBeLessThan(0.1);
    // Silverberry Landfill has an NTS-style description: no pin, location stays unknown rather than guessed.
    const nts = await callerFor(driver).facilityDirectory.get({ facilityKey: "r360-silverberry-landfill" });
    expect(nts.facility).toMatchObject({ coordinatePrecision: "unknown", latitude: null, legalLocation: "A-08-088-20 W6M" });
    // Nearby from Edson now finds the LSD-located sites with the ±2 km caveat.
    const near = await callerFor(driver).facilityDirectory.nearby({ latitude: 53.58, longitude: -116.44, radiusKm: 60 });
    expect(near.facilities.some(f => f.facilityKey === "r360-west-edson-trd" && f.distanceNote?.includes("LSD centre"))).toBe(true);
    // Virden: two conflicting evidence rows, lifecycle conflicting; an assessment fails closed and names it.
    const [l] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, material) VALUES (?, 1, 'drill cuttings')", [`LD-${rnd()}`]);
    const virden = await callerFor(driver).facilityDirectory.get({ facilityKey: "virden-facility-conflicting" });
    expect(virden.evidence.filter(e => e.reviewState === "conflicting").length).toBe(2);
    const a = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId: l.insertId, facilityKey: "virden-facility-conflicting", loadWasteCode: "drill_cuttings" });
    expect(a.blocking).toBe(true);
    expect(a.reasonCodes).toEqual(expect.arrayContaining(["evidence_conflict", "lifecycle_conflicting"]));
    // A producer-private site: even fully verified, it does not take third-party loads.
    const key = `private-${rnd()}`;
    await pool.execute("INSERT INTO facilities (facilityKey, name, status, province, facilityType, latitude, longitude, coordinatePrecision, coordinateSourceUrl, disposition, commercialAccess, lifecycle) VALUES (?,?,'open','SK','swd',51.0,-108.0,'verified_site','https://example.org/v','verified_facility','operator_private','operating')", [key, "Producer SWD"]);
    const p = await callerFor(dispatcher).facilityDirectory.assessLoad({ loadId: l.insertId, facilityKey: key, loadWasteCode: "produced_water" });
    expect(p.reasonCodes).toContain("operator_private");
    expect(p.blocking).toBe(true);
    // The Alberta-registry rows carry the OGL licence and the WM number where the brief gave one.
    const voda = await callerFor(driver).facilityDirectory.get({ facilityKey: "voda-grande-cache" });
    expect(voda.facility.regulatorRef).toBe("WM 074");
    expect(voda.evidence[0]).toMatchObject({ licenceKey: "ogl_alberta", reviewState: "lead" });
  }, 60_000);
});

d("facility directory — regulator layer import and the LSD finder", () => {
  it("imports SK-shaped features under the confirmed licence, refuses an unconfirmed licence or a missing field by name, records the run, and never overwrites a verified coordinate", async () => {
    const safety = await withRole("safety"), safety2 = await withRole("safety");
    const { latLonToUtm } = await import("./_core/projections");
    const { SK_FACILITIES } = await import("./_core/arcgisImport");
    const k = latLonToUtm(51.4667, -109.1667, 13);   // Kindersley
    const ring = (e: number, n: number) => [[e - 40, n - 40], [e + 40, n - 40], [e + 40, n + 40], [e - 40, n + 40], [e - 40, n - 40]];
    const lic = `WP${rnd()}`;
    const features = [
      { attributes: { LICENCENUM: lic, OWNERNAME: "R360 CANADA", LICTYPE: "WASTE FACILITY", LICSTATUS: "ACTIVE", SURFACELOC: "16-16-030-23W3" }, geometry: { rings: [ring(k.easting, k.northing)] } },
      { attributes: { LICENCENUM: `WP${rnd()}`, OWNERNAME: "CENOVUS ENERGY INC.", LICTYPE: "OIL SATELLITE", LICSTATUS: "SUSPENDED", SURFACELOC: "08-29-052-23W3" }, geometry: { rings: [ring(k.easting + 5000, k.northing + 5000)] } },
      { attributes: { OWNERNAME: "NO LICENCE NUMBER" }, geometry: null },
    ];
    await approvedInRegistry("sk_petroleum_gis");
    const base = { source: "sk_facilities", layerUrl: SK_FACILITIES.layerUrl, wkid: 2957, layerFields: SK_FACILITIES.fields, mapping: SK_FACILITIES.mapping, features };
    await expect(callerFor(safety).facilityDirectory.arcgis.importFeatures({ ...base, licenceKey: "mb_unconfirmed" })).rejects.toThrow(/permission_required/);
    await expect(callerFor(safety).facilityDirectory.arcgis.importFeatures({ ...base, licenceKey: "sk_unrestricted_use_v2", layerFields: ["OBJECTID", "LICENCENUM"] })).rejects.toThrow(/no field for: operator → OWNERNAME/);
    const run = await callerFor(safety).facilityDirectory.arcgis.importFeatures({ ...base, licenceKey: "sk_unrestricted_use_v2" });
    expect(run).toMatchObject({ featureCount: 3, inserted: 2, updated: 0, skipped: 1, attribution: expect.stringContaining("Standard Unrestricted Use Data Licence") });
    // The run names the registry authority it ran under, and its provenance row says the same.
    expect(run.provenance).toMatchObject({ sourceKey: "sk_petroleum_gis", endpointRef: "sk_petroleum_gis/petroleum_facilities_layer_17" });
    const [prov] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT d.importRef, d.sourceRevision, d.purpose, d.sourceFormat, d.featureCount, d.coordinateSystem, d.importedByUserId, s.sourceKey, s.revision, e.endpointRef, a.state AS approvalState, a.sourceRevision AS approvedRevision FROM facilityImportRuns r JOIN externalDatasetImports d ON d.id = r.externalDatasetImportId JOIN externalDataSources s ON s.id = d.externalDataSourceId JOIN externalSourceEndpoints e ON e.id = d.endpointId JOIN externalSourceApprovals a ON a.id = d.approvalId WHERE r.importRef = ?",
      [run.importRef]);
    expect(prov[0]).toMatchObject({ importRef: run.provenance.datasetImportRef, sourceKey: "sk_petroleum_gis", endpointRef: "sk_petroleum_gis/petroleum_facilities_layer_17", purpose: "facility_directory.arcgis_import", sourceFormat: "arcgis_json_supplied", featureCount: 3, coordinateSystem: "EPSG:2957", importedByUserId: safety, approvalState: "approved" });
    expect(prov[0]!.sourceRevision).toBe(prov[0]!.revision);
    expect(prov[0]!.approvedRevision).toBe(prov[0]!.revision);
    const key = `sk_facilities:${lic}`;
    const v = await callerFor(safety).facilityDirectory.driverView({ facilityKey: key });
    expect(v.facility).toMatchObject({ coordinatePrecision: "approximate_site", regulatorRef: lic, lifecycle: "operating", commercialAccess: "unknown", routable: false, province: "SK" });
    expect(v.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Commercial access unknown")]));
    const g = await callerFor(safety).facilityDirectory.get({ facilityKey: key });
    expect(Math.abs(g.facility.latitude! - 51.4667)).toBeLessThan(0.001);
    expect(g.evidence[0]).toMatchObject({ licenceKey: "sk_unrestricted_use_v2", claimType: "site_coordinate", confidence: "high", reviewState: "lead", cachedContent: true });
    const suspended = await callerFor(safety).facilityDirectory.get({ facilityKey: `sk_facilities:${features[1]!.attributes.LICENCENUM}` });
    expect(suspended.facility.lifecycle).toBe("suspended");
    // A person verifies the coordinate from the regulator's evidence; a re-import refreshes the record but keeps the verified coordinate.
    await callerFor(safety2).facilityDirectory.evidenceReview({ evidenceId: g.evidence[0]!.id, reviewState: "reviewed", note: "regulator geometry; matches the LSD" });
    await callerFor(safety2).facilityDirectory.coordinateVerify({ facilityKey: key, evidenceId: g.evidence[0]!.id, latitude: 51.4670, longitude: -109.1660, precision: "verified_site" });
    const again = await callerFor(safety).facilityDirectory.arcgis.importFeatures({ ...base, licenceKey: "sk_unrestricted_use_v2" });
    expect(again).toMatchObject({ inserted: 0, updated: 2 });
    const after = await callerFor(safety).facilityDirectory.get({ facilityKey: key });
    expect(after.facility).toMatchObject({ coordinatePrecision: "verified_site", latitude: 51.467, longitude: -109.166 });
    expect(after.routable).toBe(true);
    const runs = await callerFor(safety).facilityDirectory.arcgis.runs();
    expect(runs.find(r => r.importRef === run.importRef)).toMatchObject({ source: "sk_facilities", licenceKey: "sk_unrestricted_use_v2", inserted: 2, skipped: 1 });
    expect((await callerFor(safety).facilityDirectory.arcgis.presets()).sk_facilities.mapping.id).toBe("LICENCENUM");
  }, 60_000);

  it("finds sites from a legal land description, saying whether the origin is the surveyed grid or the theoretical centroid, and refuses gibberish", async () => {
    const driver = await withRole("driver"), safety = await withRole("safety");
    await callerFor(safety).facilityDirectory.seedBrief();
    const r = await callerFor(driver).facilityDirectory.lsdFind({ lsd: "07-18-053-18 W5M", radiusKm: 80 });   // R360 West Edson TRD's own LSD
    expect(r.outcome).toBe("located");
    if (r.outcome !== "located") return;
    expect(["ats_grid", "theoretical"]).toContain(r.origin.basis);
    expect(r.facilities[0]).toMatchObject({ facilityKey: "r360-west-edson-trd" });
    expect(r.facilities[0]!.distanceKm).toBeLessThan(2);
    expect(r.note).toContain("call ahead");
    const bad = await callerFor(driver).facilityDirectory.lsdFind({ lsd: "not-an-lsd" });
    expect(bad.outcome).toBe("invalid");
  }, 30_000);
});

d("facility directory — Alberta's hydrovac list (OGL–Alberta) and duplicate proposals", () => {
  it("imports the 89 listed facilities as confirmation-required hydrovac sites with cached OGL evidence, keeps WM 042's two sites apart, pins LSD rows at ±2 km, and proposes — never applies — same-LSD duplicates against the brief's sites", async () => {
    const safety = await withRole("safety"), driver = await withRole("driver");
    await callerFor(safety).facilityDirectory.seedBrief();
    const first = await callerFor(safety).facilityDirectory.hydrovac.import();
    expect(first.rows).toBe(89);
    expect(first.inserted + first.existing).toBe(89);
    expect(first.withCoordinates).toBeGreaterThanOrEqual(50);
    expect(first.attribution).toContain("Open Government Licence – Alberta");
    expect(await callerFor(safety).facilityDirectory.hydrovac.import()).toMatchObject({ inserted: 0, existing: 89 });
    // WM 212 Pure Environmental, Fort Kent: AER-regulated, LSD-pinned, hazardous, confirmation required.
    const pure = await callerFor(driver).facilityDirectory.driverView({ facilityKey: "ab_hydrovac:wm212:fort-kent" });
    expect(pure.facility).toMatchObject({ regulatorRef: "WM 212", coordinatePrecision: "approximate_site", legalLocation: "9-14-063-04-W4M", commercialAccess: "commercial_preapproval_required", routable: false, province: "AB" });
    expect(pure.contact.phone).toBe("587-792-0855");
    expect(pure.accepts).toEqual([expect.objectContaining({ wasteCode: "hydrovac_slurry", acceptanceStatus: "confirmation_required", conditions: "A hazardous waste management facility" })]);
    const g = await callerFor(driver).facilityDirectory.get({ facilityKey: "ab_hydrovac:wm212:fort-kent" });
    expect(g.evidence[0]).toMatchObject({ licenceKey: "ogl_alberta", claimType: "accepts_waste_stream", cachedContent: true, reviewState: "lead" });
    expect(g.evidence[0]!.claimValue).toContain("based on information provided by the facility");
    // An EPEA row with an address and no LSD: no pin, location stays unknown, the phone is there.
    const village = await callerFor(driver).facilityDirectory.driverView({ facilityKey: "ab_hydrovac:00432185:edmonton" });
    expect(village.facility).toMatchObject({ regulatorRef: "EPEA 00432185", coordinatePrecision: "unknown", physicalAddress: expect.stringContaining("6415-75 Street") });
    expect(village.contact.phone).toBe("780-446-8444");
    // WM 042 twice on the list, two facilities here.
    expect((await callerFor(driver).facilityDirectory.get({ facilityKey: "ab_hydrovac:wm042:elk-point" })).facility.name).toContain("Elk Point");
    expect((await callerFor(driver).facilityDirectory.get({ facilityKey: "ab_hydrovac:wm042:niton-junction" })).facility.name).toContain("Niton Junction");
    // The list still says Tervita for West Edson; the brief says R360 runs it, at the same LSD. Proposed as one site, not merged.
    const dups = await callerFor(safety).facilityDirectory.duplicates();
    const westEdson = dups.proposals.find(p => p.members.some(m => m.facilityKey === "r360-west-edson-trd"));
    expect(westEdson).toBeDefined();
    expect(westEdson!.members.map(m => m.facilityKey).sort()).toEqual(expect.arrayContaining(["r360-west-edson-trd", "ab_hydrovac:wm078:west-edson"]));
    expect(westEdson!.applied).toBe(false);
    expect((await callerFor(driver).facilityDirectory.get({ facilityKey: "ab_hydrovac:wm078:west-edson" })).aliases.some(a => a.relationship === "former_operator")).toBe(true);
  }, 90_000);
});
