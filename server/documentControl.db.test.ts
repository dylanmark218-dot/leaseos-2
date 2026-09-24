/**
 * Document Control, Checkpoint A (0178) — the definition registry and the catalog seed, through the router.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";

// DC-E renders PDFs through the storage layer; kept in memory here, as commercialOffice.db.test does.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));
import { seedDocumentCatalog } from "./_core/documentCatalogSeed";
import { SYSTEM_DEFINITIONS } from "./_core/documentDefinitions";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 260_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
  // Older suites in the same database address "operator 1" and "unit 1" and expect them in the default scope. This
  // suite assigns the operators and units it creates to a business; so that the first row of either table is never one
  // of those, an unowned operator and unit go in first (a no-op for the ids when another suite has already got there).
  await pool.execute("INSERT INTO operators (name, company) VALUES ('DC fixture (default scope)', 'LeaseOS')");
  await pool.execute("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'vac truck')", [`U-DC-${rnd()}`]);
});
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

d("the catalog seed is idempotent and traceable", () => {
  it("imports 43 new definitions, aliases three onto existing kinds, registers 81 artifacts verified by hash — and a second run changes nothing", async () => {
    const db = drizzle(pool as never) as never;
    const first = await seedDocumentCatalog(db, { importedByUserId: 1 });
    expect(first.definitions.refused).toEqual([]);
    expect(first.artifacts.refused).toEqual([]);
    expect(first.definitions.aliased).toEqual({ commercial_invoice: "invoice", disposal_ticket_waste_disposal_receipt: "disposal_ticket", freight_and_oilfield_manifest: "manifest" });
    // Migration 0178 already inserted the system rows; the seed finds them unchanged.
    expect(first.definitions.created.length + first.definitions.unchanged + first.definitions.updated.length).toBe(SYSTEM_DEFINITIONS.length + 43);
    expect(first.artifacts.registered + first.artifacts.unchanged).toBe(81);
    expect(first.artifacts.missingOnDisk).toEqual([]);
    const second = await seedDocumentCatalog(db, { importedByUserId: 1 });
    expect(second.definitions.created).toEqual([]);
    expect(second.definitions.updated).toEqual([]);
    expect(second.definitions.unchanged).toBe(SYSTEM_DEFINITIONS.length + 43);
    expect(second.artifacts.registered).toBe(0);
    expect(second.artifacts.unchanged).toBe(81);
    expect(second.categories.created).toEqual([]);
    const [[counts]] = await pool.query<mysql.RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM documentDefinitions WHERE scopeKey='platform') AS defs, (SELECT COUNT(*) FROM documentSourceArtifacts) AS arts, (SELECT COUNT(*) FROM documentSourceArtifacts WHERE hashVerifiedAt IS NOT NULL) AS verified, (SELECT COUNT(*) FROM commercialCategoryTypes WHERE kind='document_type' AND bookOrgRef IS NULL) AS cats");
    expect(Number(counts!.defs)).toBe(SYSTEM_DEFINITIONS.length + 43);
    expect(Number(counts!.arts)).toBe(81);
    expect(Number(counts!.verified)).toBe(81);
    expect(Number(counts!.cats)).toBe(SYSTEM_DEFINITIONS.length + 43);
    // Every artifact of a family traces to its source collection and hash; a PDF/DOCX pair is two artifacts of one definition.
    const [bol] = await pool.query<mysql.RowDataPacket[]>("SELECT extension, sourceCollection, sha256, variantNo FROM documentSourceArtifacts WHERE definitionKey='bill_of_lading' ORDER BY extension");
    expect(bol.map(r => r.extension)).toEqual(["docx", "pdf"]);
    expect(bol.every(r => r.sourceCollection === "LeaseOS-Freight-and-Transportation-Templates" && /^[a-f0-9]{64}$/.test(r.sha256) && r.variantNo === 1)).toBe(true);
    const [inv] = await pool.query<mysql.RowDataPacket[]>("SELECT sourcePackageKey FROM documentSourceArtifacts WHERE definitionKey='invoice'");
    expect(inv.length).toBe(2);
    expect(inv.every(r => r.sourcePackageKey === "commercial_invoice")).toBe(true);
    const [[dup]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM documentDefinitions WHERE definitionKey IN ('commercial_invoice','disposal_ticket_waste_disposal_receipt','freight_and_oilfield_manifest')");
    expect(Number(dup!.n)).toBe(0);
  }, 60_000);

  it("only management may seed; the office reads the catalog with the compliance notice on the name", async () => {
    const book = await org(); const office = await member(book, ["office"]); const mgr = await member(book, ["management"]);
    await expect(callerFor(office).documentControl.definitions.catalogSeed()).rejects.toThrow(/document.catalog.manage|FORBIDDEN|Requires/);
    const r = await callerFor(mgr).documentControl.definitions.catalogSeed();
    expect(r.definitions.refused).toEqual([]);
    const list = await callerFor(office).documentControl.definitions.list();
    expect(list.length).toBeGreaterThanOrEqual(SYSTEM_DEFINITIONS.length + 43);
    const dot = list.find(x => x.definitionKey === "dot_fmcsa_registration_authority")!;
    expect(dot.label).toContain("Not an official FMCSA, DOT or other agency form");
    expect(dot.layer).toBe("platform");
    const wm = (await callerFor(office).documentControl.definitions.get({ definitionKey: "waste_manifest_internal_record" })).definition;
    expect(wm.representationPolicy).toBe("attach_official_record_required");
    const jsa = await callerFor(office).documentControl.definitions.get({ definitionKey: "job_safety_analysis" });
    expect(jsa.artifacts.map(a => a.extension).sort()).toEqual(["docx", "pdf"]);
    expect(jsa.definition.numberingPolicy).toBe("leaseos_series_optional");
    expect(jsa.definition.leaseosTemplateAvailable).toBe(true);
  }, 60_000);
});

d("tenants see the platform catalog and change only their own layer", () => {
  it("an overlay renames a definition for one business and not another; the other cannot retire it; the platform row is untouched", async () => {
    const a = await org(), b = await org();
    const mgrA = await member(a, ["management"]), mgrB = await member(b, ["management"]), officeA = await member(a, ["office"]);
    await callerFor(mgrA).documentControl.definitions.catalogSeed();
    await expect(callerFor(officeA).documentControl.definitions.overlay({ definitionKey: "job_safety_analysis", changes: { displayName: "Pride JSA" } })).rejects.toThrow();
    const ov = await callerFor(mgrA).documentControl.definitions.overlay({ definitionKey: "job_safety_analysis", changes: { displayName: "Pride JSA", numberSeriesType: "PJSA", allowedLinkKinds: ["job", "customer_account"] } });
    expect(ov.created).toBe(true);
    const seenByA = await callerFor(officeA).documentControl.definitions.get({ definitionKey: "job_safety_analysis" });
    expect(seenByA.definition).toMatchObject({ displayName: "Pride JSA", numberSeriesType: "PJSA", layer: "tenant", overlayRef: ov.overlayRef, numberingPolicy: "leaseos_series_optional", signaturePolicy: "required_multi" });
    expect(seenByA.definition.allowedLinkKinds).toContain("customer_account");
    expect(seenByA.definition.allowedLinkKinds).toContain("operator");
    const seenByB = await callerFor(mgrB).documentControl.definitions.get({ definitionKey: "job_safety_analysis" });
    expect(seenByB.definition).toMatchObject({ displayName: "Job Safety Analysis", numberSeriesType: "JSA", layer: "platform", overlayRef: null });
    await expect(callerFor(mgrB).documentControl.definitions.retire({ definitionKey: "job_safety_analysis", reason: "not ours to retire" })).rejects.toThrow(/no active definition or overlay/);
    const again = await callerFor(mgrA).documentControl.definitions.overlay({ definitionKey: "job_safety_analysis", changes: { printPolicy: "controlled_copy" } });
    expect(again.created).toBe(false);
    expect((await callerFor(officeA).documentControl.definitions.get({ definitionKey: "job_safety_analysis" })).definition.printPolicy).toBe("controlled_copy");
    const [[platform]] = await pool.query<mysql.RowDataPacket[]>("SELECT displayName, numberSeriesType, printPolicy FROM documentDefinitions WHERE definitionKey='job_safety_analysis' AND scopeKey='platform'");
    expect(platform).toMatchObject({ displayName: "Job Safety Analysis", numberSeriesType: "JSA", printPolicy: "printable" });
    await callerFor(mgrA).documentControl.definitions.retire({ definitionKey: "job_safety_analysis", reason: "back to the platform name" });
    expect((await callerFor(officeA).documentControl.definitions.get({ definitionKey: "job_safety_analysis" })).definition.layer).toBe("platform");
  }, 60_000);

  it("a business authors its own definition under tenant-authorable numbering only, invisible to another business, and cannot shadow a platform key", async () => {
    const a = await org(), b = await org();
    const mgrA = await member(a, ["management"]), officeB = await member(b, ["office"]);
    const key = `pride_consultant_sheet_${rnd().toLowerCase()}`;
    const created = await callerFor(mgrA).documentControl.definitions.create({ definitionKey: key, displayName: "Consultant daily sheet", documentClass: "operational_form", allowedOrigins: ["organization_template", "external_scanned"], numberingPolicy: "leaseos_series_optional", numberSeriesType: "CDS", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["customer_job_number"], allowedLinkKinds: ["job", "customer", "operator"], signaturePolicy: "required_single", revisionPolicy: "immutable_supersede", readCategory: "job_operational" });
    expect(created.layer).toBe("tenant_authored");
    expect((await callerFor(mgrA).documentControl.definitions.get({ definitionKey: key })).definition).toMatchObject({ layer: "tenant_authored", numberSeriesType: "CDS", importAllowed: true });
    await expect(callerFor(officeB).documentControl.definitions.get({ definitionKey: key })).rejects.toThrow(/No document definition/);
    await expect(callerFor(mgrA).documentControl.definitions.create({ definitionKey: "field_ticket", displayName: "x", documentClass: "operational_form", allowedOrigins: ["external_scanned"], numberingPolicy: "archival_only", externalReferencePolicy: "forbidden", allowedLinkKinds: ["job"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "job_operational" })).rejects.toThrow(/already names a definition/);
    // The input schema itself refuses the policies a tenant may not author.
    await expect(callerFor(mgrA).documentControl.definitions.create({ definitionKey: `x_${rnd().toLowerCase()}`, displayName: "x", documentClass: "operational_form", allowedOrigins: ["external_scanned"], numberingPolicy: "domain_managed" as never, externalReferencePolicy: "forbidden", allowedLinkKinds: ["job"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "job_operational" })).rejects.toThrow();
  }, 60_000);
});

/* ===================== Checkpoint B (0179) — the origin-aware register ===================== */

async function evidence(userId: number, hash: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, storageKey, mimeType, capturedAt, capturedBy, status, recordType) VALUES (?,?,?,?,NOW(),?,'needs_review','disposal_ticket')", [`scan ${hash.slice(0, 8)}`, "disposal", `${userId}/evidence/${hash.slice(0, 12)}.jpg`, "image/jpeg", userId]);
  return r.insertId;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function facility(name: string) { const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, facilityType, status) VALUES (?,?,'open')", [name, "disposal"]); return r.insertId; }
async function job(orgRef: string | null) { const code = `JOB-${rnd()}`; const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, customer, location) VALUES (?,?,?,?,?)", [orgRef, code, "disposal", "Cust", "LSD 1-2-3-4"]); return { id: r.insertId, code }; }

d("the register keeps origin, issuer and number apart", () => {
  it("takes a facility's paper ticket in as a scan: external issuer, facility number, no LeaseOS number, captured — then confirmed by a person", async () => {
    const a = await org(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const fac = await facility(`Facility XYZ ${rnd()}`); const j = await job(a); const ev = await evidence(office, sha("scan-1")); const c = callerFor(office);
    const reg = await c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "Facility ticket 874399", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: fac, issuerName: "Facility XYZ" }, evidenceRecordId: ev, contentHash: sha("scan-1"), importChannel: "device_sync", deviceRef: "DEV-TEST-1", externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: " 874399 ", source: "ocr_proposed" }], links: [{ recordType: "job", recordRef: j.code, source: "ocr_proposed", confirmed: false }] });
    expect(reg.controlState).toBe("captured");
    expect(reg.controlNumber).toBeNull();
    expect(reg.documentRef).toMatch(/^DOC-/);
    expect(reg.provenance).toMatch(/Scanned from paper.*issued by Facility XYZ; no LeaseOS number/);
    const before = await c.documentControl.documents.get({ documentRef: reg.documentRef });
    expect(before.references[0]).toMatchObject({ referenceType: "facility_ticket_number", referenceValue: "874399", confirmationStatus: "proposed", issuerScopeKey: `facility:${fac}`, source: "ocr_proposed" });
    expect(before.links[0]).toMatchObject({ recordType: "job", recordRef: j.code, recordId: j.id, confirmationStatus: "proposed", source: "ocr_proposed" });
    expect(before.document).toMatchObject({ originKind: "external_scanned", issuerKind: "facility", controlNumber: null, capturedByDeviceRef: "DEV-TEST-1", importChannel: "device_sync", definitionKey: "external_disposal_receipt" });
    // Issued is not an act on an external document; a LeaseOS number is not either.
    await expect(c.documentControl.documents.issue({ documentRef: reg.documentRef })).rejects.toThrow(/cannot be issued|never issued/);
    const confirmed = await c.documentControl.documents.confirm({ documentRef: reg.documentRef, confirmReferenceRefs: [before.references[0]!.referenceRef], confirmLinkIds: [before.links[0]!.id], issuedAt: new Date("2026-09-20T15:00:00Z") });
    expect(confirmed.controlState).toBe("confirmed");
    const after = await c.documentControl.documents.get({ documentRef: reg.documentRef });
    expect(after.references[0]!.confirmationStatus).toBe("confirmed");
    expect(after.links[0]!.confirmationStatus).toBe("confirmed");
    expect(after.document.controlNumber).toBeNull();
    expect(after.timeline.map(e => e.eventType)).toEqual(["document.captured", "document.link_confirmed", "document.reference_confirmed", "document.confirmed"]);
    expect(after.timeline.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(after.retention).toMatch(/UNCONFIGURED/);
    // Once confirmed, the facts are frozen: a second confirmation is refused, a keyed correction is an amendment kept beside the original.
    await expect(c.documentControl.documents.confirm({ documentRef: reg.documentRef })).rejects.toThrow(/cannot be confirmed|frozen/);
    const amended = await c.documentControl.documents.amend({ documentRef: reg.documentRef, reason: "the office mis-keyed the facility's trading name", changes: { issuerName: "Facility XYZ Disposal Ltd" } });
    expect(amended.amendments).toEqual(["issuerName"]);
    const view = await c.documentControl.documents.get({ documentRef: reg.documentRef });
    expect(view.document.issuerName).toBe("Facility XYZ Disposal Ltd");
    expect(view.amendments[0]).toMatchObject({ fieldKey: "issuerName", originalValue: "Facility XYZ", correctedValue: "Facility XYZ Disposal Ltd", entityType: "commercialDocument" });
    expect(view.document.contentHash).toBe(sha("scan-1"));
  }, 60_000);

  it("lets two facilities both issue ticket 12345, refuses the same bytes twice from one facility, and needs a recorded reason for different bytes with the same number", async () => {
    const a = await org(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const facA = await facility(`Fac A ${rnd()}`), facB = await facility(`Fac B ${rnd()}`); const c = callerFor(office);
    const r1 = await c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "A 12345", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: facA }, evidenceRecordId: await evidence(office, sha("A-12345")), contentHash: sha("A-12345"), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "12345" }] });
    const r2 = await c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "B 12345", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: facB }, evidenceRecordId: await evidence(office, sha("B-12345")), contentHash: sha("B-12345"), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "12345" }] });
    expect(r1.documentRef).not.toBe(r2.documentRef);
    await expect(c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "A 12345 again", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: facA }, evidenceRecordId: await evidence(office, sha("A-12345")), contentHash: sha("A-12345"), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "12345" }] })).rejects.toThrow(/identical bytes; this is the same document/);
    await expect(c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "A 12345 rescan", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: facA }, evidenceRecordId: await evidence(office, sha("A-12345-rescan")), contentHash: sha("A-12345-rescan"), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "12345" }] })).rejects.toThrow(/REVIEW.*different bytes/);
    const r3 = await c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "A 12345 rescan", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: facA }, evidenceRecordId: await evidence(office, sha("A-12345-rescan")), contentHash: sha("A-12345-rescan"), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "12345", duplicateOverrideReason: "second page of the same ticket, photographed separately" }] });
    const v = await c.documentControl.documents.get({ documentRef: r3.documentRef });
    expect(v.references[0]!.duplicateOverrideReason).toMatch(/second page/);
    expect(v.references[0]!.duplicateOfDocumentId).not.toBeNull();
    // Search by the facility's number finds both facilities' tickets, origin visible on each.
    const hits = await c.documentControl.documents.list({ q: "12345" });
    expect(hits.length).toBe(3);
    expect(hits.every(h => h.originKind === "external_scanned" && h.issuerKind === "facility" && h.controlNumber === null)).toBe(true);
  }, 60_000);

  it("fails closed across tenants: a link to another business's job is not found, and another business cannot read the document", async () => {
    const a = await org(), b = await org(); const officeA = await member(a, ["office"]), officeB = await member(b, ["office"]); const mgr = await member(a, ["management"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const jB = await job(b); const jA = await job(a);
    await expect(callerFor(officeA).documentControl.documents.intake({ definitionKey: "unclassified_external_document", title: "unknown slip", originKind: "external_digital_import", evidenceRecordId: await evidence(officeA, sha("x1")), contentHash: sha("x1"), links: [{ recordType: "job", recordRef: jB.code }] })).rejects.toThrow(/not in this business's records/);
    const ok = await callerFor(officeA).documentControl.documents.intake({ definitionKey: "unclassified_external_document", title: "unknown slip", originKind: "external_digital_import", evidenceRecordId: await evidence(officeA, sha("x1")), contentHash: sha("x1"), links: [{ recordType: "job", recordRef: jA.code }] });
    expect(ok.controlState).toBe("captured");
    await expect(callerFor(officeB).documentControl.documents.get({ documentRef: ok.documentRef })).rejects.toThrow(/not in this business's register/);
    await expect(callerFor(officeB).documentControl.documents.confirm({ documentRef: ok.documentRef, definitionKey: "fuel_receipt", issuer: { issuerKind: "vendor", issuerName: "Shell" } })).rejects.toThrow(/not in this business's register/);
    expect((await callerFor(officeB).documentControl.documents.list({ q: "unknown slip" })).length).toBe(0);
    // Unclassified stays unclassified until a person names it; naming it as unclassified is refused, naming it is allowed.
    await expect(callerFor(officeA).documentControl.documents.confirm({ documentRef: ok.documentRef, issuer: { issuerKind: "vendor", issuerName: "Shell" } })).rejects.toThrow(/not as unclassified/);
    const named = await callerFor(officeA).documentControl.documents.confirm({ documentRef: ok.documentRef, definitionKey: "fuel_receipt", issuer: { issuerKind: "vendor", issuerName: "Shell" } });
    expect(named.definitionKey).toBe("fuel_receipt");
    const v = await callerFor(officeA).documentControl.documents.get({ documentRef: ok.documentRef });
    expect(v.timeline.map(e => e.eventType)).toEqual(["document.captured", "document.classified", "document.confirmed"]);
  }, 60_000);

  it("registers what LeaseOS rendered as issued by the tenant with its domain number; a new version keeps the number and the old row keeps its hash; the same bytes are a reprint, not a revision", async () => {
    const a = await org(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const j = await job(a); const c = callerFor(office);
    await expect(c.documentControl.documents.registerRendered({ definitionKey: "field_ticket", title: "FT r1", originKind: "system_rendered", contentHash: sha("ft-r1"), storageKey: "tickets/FT-1/R1.pdf", links: [{ recordType: "job", recordRef: j.code }] })).rejects.toThrow(/numbered by its domain \(FT\)/);
    const ft = await c.documentControl.documents.registerRendered({ definitionKey: "field_ticket", title: "FT r1", originKind: "system_rendered", contentHash: sha("ft-r1"), storageKey: "tickets/FT-1/R1.pdf", controlNumber: `FT-2026-${rnd().slice(0, 6)}`, links: [{ recordType: "job", recordRef: j.code, role: "subject" }] });
    expect(ft.controlState).toBe("issued");
    expect(ft.provenance).toMatch(/Rendered by LeaseOS from a frozen snapshot, issued by this company; LeaseOS control number FT-/);
    await expect(c.documentControl.documents.registerRendered({ definitionKey: "field_ticket", title: "FT dup", originKind: "system_rendered", contentHash: sha("ft-dup"), storageKey: "tickets/FT-1/R1b.pdf", controlNumber: ft.controlNumber!, links: [] })).rejects.toThrow(/already on document/);
    await expect(c.documentControl.documents.supersede({ documentRef: ft.documentRef, reason: "reprinted for the customer", contentHash: sha("ft-r1"), storageKey: "tickets/FT-1/R1.pdf" })).rejects.toThrow(/reprint of the same bytes is a print event, not a revision/);
    await expect(c.documentControl.documents.amend({ documentRef: ft.documentRef, reason: "typo in the title of the ticket", changes: { title: "x" } })).rejects.toThrow(/corrected by its owning domain/);
    const v2 = await c.documentControl.documents.supersede({ documentRef: ft.documentRef, reason: "post-site supplement added two standby hours", contentHash: sha("ft-r2"), storageKey: "tickets/FT-1/R2.pdf" });
    expect(v2.version).toBe(2);
    expect(v2.controlNumber).toBe(ft.controlNumber);
    const old = await c.documentControl.documents.get({ documentRef: ft.documentRef });
    expect(old.document).toMatchObject({ status: "superseded", contentHash: sha("ft-r1"), controlNumber: null, controlState: "issued" });
    expect(old.timeline.map(e => e.eventType)).toEqual(["document.issued", "document.number_issued", "document.superseded"]);
    const neu = await c.documentControl.documents.get({ documentRef: v2.documentRef });
    expect(neu.document).toMatchObject({ status: "current", version: 2, contentHash: sha("ft-r2"), controlNumber: ft.controlNumber, originKind: "system_rendered", issuerKind: "tenant" });
    expect(neu.links[0]).toMatchObject({ recordType: "job", recordRef: j.code, role: "subject" });
    expect(neu.versions.map(x => x.version)).toEqual([1, 2]);
    // The timeline is append-only at the database: no update, no delete.
    await expect(pool.execute("UPDATE documentControlEvents SET eventType='x' WHERE documentId = (SELECT id FROM commercialDocuments WHERE documentRef = ?)", [ft.documentRef])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM documentControlEvents WHERE documentId = (SELECT id FROM commercialDocuments WHERE documentRef = ?)", [ft.documentRef])).rejects.toThrow(/append-only/);
    // Void is for what was never issued; an issued document is withdrawn.
    await expect(c.documentControl.documents.void({ documentRef: v2.documentRef, reason: "entered against the wrong job" })).rejects.toThrow(/withdrawn or superseded, not voided/);
    const w = await c.documentControl.documents.withdraw({ documentRef: v2.documentRef, reason: "entered against the wrong job" });
    expect(w.controlState).toBe("withdrawn");
    expect((await c.documentControl.documents.get({ documentRef: v2.documentRef })).document.controlNumber).toBe(ft.controlNumber);
  }, 60_000);

  it("voids a captured scan and keeps the row; the 0144 register path still works and reads as origin unrecorded", async () => {
    const a = await org(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const c = callerFor(office);
    const r = await c.documentControl.documents.intake({ definitionKey: "unclassified_external_document", title: "blurry", originKind: "external_scanned", evidenceRecordId: await evidence(office, sha("blur")), contentHash: sha("blur") });
    const v = await c.documentControl.documents.void({ documentRef: r.documentRef, reason: "blurry duplicate of a scan already confirmed" });
    expect(v.controlState).toBe("void");
    expect((await c.documentControl.documents.get({ documentRef: r.documentRef })).document).toMatchObject({ controlState: "void", voidReason: "blurry duplicate of a scan already confirmed" });
    const legacy = await c.commercialOffice.documents.register({ documentType: "invoice", title: "legacy registered PDF", contentHash: sha("legacy"), storageKey: "legacy/inv.pdf" });
    const lv = await c.documentControl.documents.get({ documentRef: legacy.documentRef });
    expect(lv.provenance).toMatch(/Origin unrecorded/);
    expect(lv.document).toMatchObject({ definitionKey: "invoice", controlState: "confirmed", originKind: null });
    await expect(c.documentControl.documents.issue({ documentRef: legacy.documentRef, controlNumber: "INV-X" })).rejects.toThrow(/no recorded origin/);
  }, 60_000);
});

/* ===================== Checkpoint D (0181) — template families and immutable revisions ===================== */

d("standard template families are seeded once, released, and immutable", () => {
  it("seeds 46 families with revision 1 released, PDF/DOCX pairs under one revision, four renderable now; a rerun changes nothing; the database refuses a change to a released revision", async () => {
    const a = await org(); const mgr = await member(a, ["management"]); const office = await member(a, ["office"]);
    const first = await callerFor(mgr).documentControl.definitions.catalogSeed();
    expect(first.templates.families.skipped).toEqual([]);
    expect(first.templates.families.created.length + first.templates.families.unchanged).toBe(46);
    expect(first.templates.revisions.released.length + first.templates.revisions.unchanged).toBe(46);
    const renderableFamilies = ["dot_fmcsa_registration_and_authority_record", "environmental_compliance_spill_reporting_form", "norm_survey_and_handling_record", "oilfield_waste_tracking_generator_compliance_form"];
    expect(first.templates.renderableNow.every(k => renderableFamilies.includes(k))).toBe(true);
    if (first.templates.revisions.released.length) expect(first.templates.renderableNow.sort()).toEqual(renderableFamilies);
    const second = await callerFor(mgr).documentControl.definitions.catalogSeed();
    expect(second.templates.families.created).toEqual([]);
    expect(second.templates.revisions.released).toEqual([]);
    expect(second.templates.artifactsLinked).toBe(0);
    const [[counts]] = await pool.query<mysql.RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM documentTemplates WHERE scopeKey='platform') AS fams, (SELECT COUNT(*) FROM documentTemplateRevisions WHERE status='released') AS revs, (SELECT COUNT(*) FROM documentTemplateArtifacts a JOIN documentTemplateRevisions r ON r.id = a.revisionId WHERE r.revision = 1) AS arts");
    expect(Number(counts!.fams)).toBe(46);
    expect(Number(counts!.revs)).toBeGreaterThanOrEqual(46);
    expect(Number(counts!.arts)).toBe(66 + 4);   // revision 1 of every family: 66 canonical PDF/DOCX artifacts + 4 markdown render sources (mapped revisions carry their own links)
    const lib = await callerFor(office).documentControl.templates.list();
    const bol = lib.find(t => t.templateKey === "bill_of_lading")!;
    expect(bol).toMatchObject({ definitionKey: "bill_of_lading", sourceKind: "leaseos_standard", ownerKind: "leaseos", layer: "platform" });
    expect(bol.currentRevision).toMatchObject({ layoutKind: "pdf_overlay", renderable: false });   // revision 2 once the standard mapping (DC-E) is released
    const bolFull = await callerFor(office).documentControl.templates.get({ templateRef: bol.templateRef });
    const rev1 = bolFull.revisions.find(r => r.revision === 1)!;
    expect(rev1.artifacts.map(x => [x.role, x.extension]).sort()).toEqual([["editable_source", "docx"], ["printable", "pdf"]]);
    expect(rev1.artifacts.every(x => /^[a-f0-9]{64}$/.test(x.sha256) && x.sourceCollection === "LeaseOS-Freight-and-Transportation-Templates")).toBe(true);
    // The invoice family attaches to the existing `invoice` definition; the DOT family has two PDF variants under one revision.
    expect(lib.find(t => t.templateKey === "commercial_invoice")!.definitionKey).toBe("invoice");
    const dot = await callerFor(office).documentControl.templates.get({ templateRef: lib.find(t => t.templateKey === "dot_fmcsa_registration_and_authority_record")!.templateRef });
    const dotRev1 = dot.revisions.find(r => r.revision === 1)!;
    expect(dotRev1.artifacts.map(x => x.role).sort()).toEqual(["printable", "printable_alternate", "render_source"]);
    expect(dotRev1).toMatchObject({ layoutKind: "markdown_text", rendererKey: "leaseos_text_v1" });
    expect(dot.revisions[0]!).toMatchObject({ layoutKind: "markdown_text", rendererKey: "leaseos_text_v1", renderable: true });
    // Released is immutable at the database.
    await expect(pool.execute("UPDATE documentTemplateRevisions SET fieldMappingJson = '{\"version\":1,\"fields\":[{\"printedField\":\"x\",\"semanticKey\":null}]}' WHERE revisionRef = ?", [bol.currentRevision!.revisionRef])).rejects.toThrow(/immutable; a change is a new revision/);
    await expect(pool.execute("UPDATE documentTemplateRevisions SET rendererVersion = '9' WHERE revisionRef = ?", [bol.currentRevision!.revisionRef])).rejects.toThrow(/immutable/);
    await expect(pool.execute("UPDATE documentTemplateRevisions SET status = 'draft' WHERE revisionRef = ?", [bol.currentRevision!.revisionRef])).rejects.toThrow(/immutable/);
    // A platform standard cannot be drafted from inside a business.
    await expect(callerFor(mgr).documentControl.templates.revisionDraft({ templateRef: bol.templateRef, fieldMapping: { version: 1, fields: [{ printedField: "Shipper", semanticKey: "organization.legalName" }] } })).rejects.toThrow(/revised by a release/);
  }, 90_000);

  it("a business uploads its own form, maps it, releases it, renders a document on it, then releases revision 2 — and the document stays on revision 1", async () => {
    const a = await org(), b = await org(); const mgr = await member(a, ["management"]); const office = await member(a, ["office"]); const officeB = await member(b, ["office"]); const driver = await member(a, ["driver"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const c = callerFor(office); const m = callerFor(mgr);
    const pdfHash = sha("PrideVac_DisposalTicket_2026.pdf"); const ev = await evidence(office, pdfHash);
    await expect(m.documentControl.templates.createCustom({ definitionKey: "disposal_ticket", templateKey: "pridevac_disposal_ticket", name: "PrideVac disposal ticket", sourceKind: "organization_custom", evidenceRecordId: ev, contentHash: pdfHash, byteLength: 90_000, fileName: "PrideVac_DisposalTicket_2026.html", mimeType: "text/html" })).rejects.toThrow(/PDF, a DOCX or a markdown-text layout/);
    const tpl = await m.documentControl.templates.createCustom({ definitionKey: "disposal_ticket", templateKey: "pridevac_disposal_ticket", name: "PrideVac disposal ticket", sourceKind: "organization_custom", evidenceRecordId: ev, contentHash: pdfHash, byteLength: 90_000, fileName: "PrideVac_DisposalTicket_2026.pdf", mimeType: "application/pdf" });
    expect(tpl).toMatchObject({ layoutKind: "pdf_overlay", renderable: false });
    expect(tpl.rendererNote).toMatch(/D-DC-05/);
    // A driver may not manage templates; a draft renders nothing.
    await expect(callerFor(driver).documentControl.templates.revisionRelease({ revisionRef: tpl.revisionRef })).rejects.toThrow(/template.manage|Requires|FORBIDDEN/);
    await expect(c.documentControl.documents.registerRendered({ definitionKey: "disposal_ticket", title: "DSP on draft", originKind: "organization_template", contentHash: sha("dsp-x"), storageKey: "dsp/x.pdf", templateRevisionRef: tpl.revisionRef, controlNumber: `DSP-${rnd()}` })).rejects.toThrow(/is a draft/);
    const r1 = await m.documentControl.templates.revisionRelease({ revisionRef: tpl.revisionRef });
    expect(r1.releaseManifestHash).toMatch(/^[a-f0-9]{64}$/);
    // Wrong origin for the template's source is refused; the right one is issued and bound.
    await expect(c.documentControl.documents.registerRendered({ definitionKey: "disposal_ticket", title: "DSP wrong origin", originKind: "leaseos_generated", contentHash: sha("dsp-1"), storageKey: "dsp/1.pdf", templateRevisionRef: tpl.revisionRef, controlNumber: `DSP-${rnd()}` })).rejects.toThrow(/renders as organization_template/);
    const doc = await c.documentControl.documents.registerRendered({ definitionKey: "disposal_ticket", title: "DSP on PrideVac form", originKind: "organization_template", contentHash: sha("dsp-1"), storageKey: "dsp/1.pdf", templateRevisionRef: tpl.revisionRef, renderManifestHash: sha("render-1"), controlNumber: `DSP-${rnd()}` });
    const v1 = await c.documentControl.documents.get({ documentRef: doc.documentRef });
    expect(v1.document.templateRevisionRef).toBe(tpl.revisionRef);
    expect(v1.timeline.map(e => e.eventType)).toEqual(["document.issued", "document.template_bound", "document.number_issued"]);
    expect(v1.timeline[1]!.detail).toMatchObject({ templateRef: tpl.templateRef, releaseManifestHash: r1.releaseManifestHash, sourceKind: "organization_custom" });
    expect(v1.provenance).toMatch(new RegExp(`from template revision ${tpl.revisionRef}`));
    // Revision 2: a mapping change is a new revision; releasing it retires revision 1 for new records only.
    const draft2 = await m.documentControl.templates.revisionDraft({ templateRef: tpl.templateRef, fieldMapping: { version: 1, fields: [{ printedField: "Driver Name", semanticKey: "operator.name" }, { printedField: "Ticket #", semanticKey: "document.controlNumber", required: true }] } });
    expect(draft2).toMatchObject({ revision: 2, status: "draft", supersedes: tpl.revisionRef });
    await expect(m.documentControl.templates.revisionDraft({ templateRef: tpl.templateRef, fieldMapping: { version: 1, fields: [] } })).rejects.toThrow(/still a draft/);
    await m.documentControl.templates.revisionRelease({ revisionRef: draft2.revisionRef });
    const full = await c.documentControl.templates.get({ templateRef: tpl.templateRef });
    expect(full.revisions.map(r => [r.revision, r.status])).toEqual([[2, "released"], [1, "retired"]]);
    expect((await c.documentControl.documents.get({ documentRef: doc.documentRef })).document.templateRevisionRef).toBe(tpl.revisionRef);   // still revision 1
    await expect(c.documentControl.documents.registerRendered({ definitionKey: "disposal_ticket", title: "DSP on retired r1", originKind: "organization_template", contentHash: sha("dsp-2"), storageKey: "dsp/2.pdf", templateRevisionRef: tpl.revisionRef, controlNumber: `DSP-${rnd()}` })).rejects.toThrow(/is retired; the records already on it stay/);
    const onR2 = await c.documentControl.documents.registerRendered({ definitionKey: "disposal_ticket", title: "DSP on r2", originKind: "organization_template", contentHash: sha("dsp-2"), storageKey: "dsp/2.pdf", templateRevisionRef: draft2.revisionRef, controlNumber: `DSP-${rnd()}` });
    expect((await c.documentControl.documents.get({ documentRef: onR2.documentRef })).document.templateRevisionRef).toBe(draft2.revisionRef);
    // Another business sees neither the template nor may it render on it; the unchanged mapping is refused as a new revision.
    expect((await callerFor(officeB).documentControl.templates.list()).some(t => t.templateRef === tpl.templateRef)).toBe(false);
    await expect(callerFor(officeB).documentControl.templates.get({ templateRef: tpl.templateRef })).rejects.toThrow(/not in this business's library/);
    await expect(m.documentControl.templates.revisionDraft({ templateRef: tpl.templateRef, fieldMapping: { version: 1, fields: [{ printedField: "Ticket #", semanticKey: "document.controlNumber", required: true }, { printedField: "Driver Name", semanticKey: "operator.name" }] } })).rejects.toThrow(/Nothing changed/);
  }, 90_000);
});


/* ===================== Checkpoint E — semantic fields, mapped revisions, prepare and render ===================== */

async function operator(orgRef: string, name: string) { const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, company) VALUES (?,?)", [name, "Pride Vac"]); await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, "operator", r.insertId]); return r.insertId; }
async function unit(orgRef: string, unitNumber: string) { const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [unitNumber, "vac truck"]); await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, "unit", r.insertId]); return r.insertId; }
async function load(jobId: number, operatorId: number, unitId: number) { const n = `L-${rnd()}`; const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, operatorId, unitId, material, quantity, quantityUnit, measurementMethod) VALUES (?,?,?,?,?,?,?,?)", [n, jobId, operatorId, unitId, "produced water", 18.5, "m3", "meter"]); return { id: r.insertId, loadNumber: n }; }

d("the semantic layer: mapped standard revisions, resolution with provenance, and rendering through the present renderer", () => {
  it("releases mapped revision 2 of the representative families once, retiring revision 1; a rerun releases nothing", async () => {
    const a = await org(); const mgr = await member(a, ["management"]); const office = await member(a, ["office"]);
    const first = await callerFor(mgr).documentControl.definitions.catalogSeed();
    expect(first.mappings.refused).toEqual([]);
    const again = await callerFor(mgr).documentControl.definitions.catalogSeed();
    expect(again.mappings.released).toEqual([]);
    expect(again.mappings.unchanged).toBeGreaterThanOrEqual(14);
    const lib = await callerFor(office).documentControl.templates.list({ definitionKey: "bill_of_lading" });
    const bol = await callerFor(office).documentControl.templates.get({ templateRef: lib[0]!.templateRef });
    expect(bol.revisions.map(r => [r.revision, r.status])).toEqual([[2, "released"], [1, "retired"]]);
    expect(bol.revisions[0]!.fieldMapping.fields.find(f => f.printedField === "Driver")).toMatchObject({ semanticKey: "operator.name", required: true });
    expect(bol.revisions[0]!.artifacts.map(x => x.role).sort()).toEqual(["editable_source", "printable"]);   // artifacts carried to the mapped revision
    expect(bol.revisions[0]!.releaseManifestHash).not.toBe(bol.revisions[1]!.releaseManifestHash);
    // A business's own mapping is validated against the same registry.
    const pdfHash = sha(`custom-${rnd()}`); const ev = await evidence(office, pdfHash);
    const tpl = await callerFor(mgr).documentControl.templates.createCustom({ definitionKey: "job_safety_analysis", templateKey: `pride_jsa_${rnd().toLowerCase()}`, name: "Pride JSA", sourceKind: "organization_custom", evidenceRecordId: ev, contentHash: pdfHash, byteLength: 1000, fileName: "Pride_JSA.pdf", mimeType: "application/pdf" });
    await callerFor(mgr).documentControl.templates.revisionRelease({ revisionRef: tpl.revisionRef });
    await expect(callerFor(mgr).documentControl.templates.revisionDraft({ templateRef: tpl.templateRef, fieldMapping: { version: 1, fields: [{ printedField: "Driver Name", semanticKey: "driver.fullName" }] } })).rejects.toThrow(/not in the semantic registry/);
    const ok = await callerFor(mgr).documentControl.templates.revisionDraft({ templateRef: tpl.templateRef, fieldMapping: { version: 1, fields: [{ printedField: "Driver Name", semanticKey: "operator.name" }, { printedField: "Hazards", semanticKey: "hazard.description", required: true }] } });
    expect(ok.revision).toBe(2);
  }, 90_000);

  it("prepares from LeaseOS Records with provenance, leaves person-only fields to the person, and renders a NORM record bound to its revision — but refuses to render a PDF layout it cannot execute", async () => {
    const a = await org(), b = await org(); const mgr = await member(a, ["management"]); const office = await member(a, ["office"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const j = await job(a); const op = await operator(a, "R. Singh"); const u = await unit(a, `VT-${rnd().slice(0, 4)}`); const l = await load(j.id, op, u); const fac = await facility(`Tervita ${rnd()}`);
    const c = callerFor(office);
    const norm = (await c.documentControl.templates.list({ definitionKey: "norm_survey_and_handling_record" }))[0]!;
    expect(norm.currentRevision).toMatchObject({ revision: 2, layoutKind: "markdown_text", renderable: true });
    const prep = await c.documentControl.semantic.prepare({ templateRevisionRef: norm.currentRevision!.revisionRef, context: { jobId: j.id, loadId: l.id, facilityId: fac } });
    expect(prep).toMatchObject({ renderable: true, originKind: "leaseos_generated", wouldMint: false, notFound: [] });
    const site = prep.fields.find(f => f.printedField === "siteOrLeaseName")!;
    expect(site).toMatchObject({ authority: "auto_fill", value: "LSD 1-2-3-4", state: "filled" });
    expect(site.source).toBe(`jobs.location#${j.id}`);
    expect(prep.fields.find(f => f.printedField === "wellOrEquipmentId")).toMatchObject({ state: "filled", source: `units.unitNumber#${u}` });
    expect(prep.fields.find(f => f.printedField === "documentRef")).toMatchObject({ authority: "server_only", state: "server_at_issue" });
    expect(prep.fields.find(f => f.printedField === "backgroundReading")).toMatchObject({ authority: "human_only", state: "missing" });
    expect(prep.missingRequired).toEqual(["jurisdiction"]);
    // Cross-tenant records are not found; a required person-only field cannot be issued blank.
    const jB = await job(b);
    await expect(c.documentControl.semantic.prepare({ templateRevisionRef: norm.currentRevision!.revisionRef, context: { jobId: jB.id } })).resolves.toMatchObject({ notFound: [`job ${jB.id}`] });
    await expect(c.documentControl.semantic.render({ templateRevisionRef: norm.currentRevision!.revisionRef, context: { jobId: jB.id } })).rejects.toThrow(/not in this business's records/);
    await expect(c.documentControl.semantic.render({ templateRevisionRef: norm.currentRevision!.revisionRef, context: { jobId: j.id } })).rejects.toThrow(/required fields have no value: jurisdiction/);
    // A person supplies what only a person may; the record's values are never overridden by a person's.
    const r = await c.documentControl.semantic.render({ templateRevisionRef: norm.currentRevision!.revisionRef, context: { jobId: j.id, loadId: l.id, facilityId: fac }, humanValues: { jurisdiction: "CA-AB", backgroundReading: 0.08, surveyorName: "D. Mark", siteOrLeaseName: "SOMEWHERE ELSE" }, title: "NORM survey — LSD 1-2-3-4" });
    expect(r).toMatchObject({ controlState: "issued", controlNumber: null, definitionRef: "DEF-P-norm_survey_and_handling_record-v1" });
    expect(r.provenance).toMatch(/Rendered by LeaseOS from template revision/);
    expect(r.storageKey).toMatch(new RegExp(`^documents/${a}/norm_survey_and_handling_record/`));
    const bytes = objects.get(r.storageKey)!;
    expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(sha(bytes as never)).toBe(r.contentHash);
    expect(r.unfilled).toContain("maxGammaReading");
    expect(r.unfilled).not.toContain("backgroundReading");
    const v = await c.documentControl.documents.get({ documentRef: r.documentRef });
    expect(v.document).toMatchObject({ originKind: "leaseos_generated", issuerKind: "tenant", templateRevisionRef: norm.currentRevision!.revisionRef, controlNumber: null, importChannel: "system" });
    expect(v.document.renderManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(v.timeline.map(e => e.eventType)).toEqual(["document.issued", "document.template_bound"]);
    expect(v.links.map(x => x.recordType).sort()).toEqual(["facility", "job", "load", "operator", "unit"]);
    expect(v.links.every(x => x.source === "domain" && x.confirmationStatus === "confirmed")).toBe(true);
    expect(v.definition!.representationNotice).toMatch(/Jurisdiction-specific/);
    // A PDF layout is registered and printable as supplied, and LeaseOS says plainly that it cannot render it.
    const bol = (await c.documentControl.templates.list({ definitionKey: "bill_of_lading" }))[0]!;
    await expect(c.documentControl.semantic.render({ templateRevisionRef: bol.currentRevision!.revisionRef, context: { jobId: j.id, loadId: l.id } })).rejects.toThrow(/cannot render a pdf_overlay layout.*D-DC-05/);
    // The registry is readable; the number a rendered document would carry is server-only.
    const fields = await c.documentControl.semantic.fields();
    expect(fields.find(f => f.key === "document.controlNumber")!.authority).toBe("server_only");
  }, 90_000);
});

d("scanner and import convergence (DC-F): capture with no template, extraction as proposal, derivatives beside an immutable original", () => {
  const shaB = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`scan ${tag}`)]);
  const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
  const b64 = (b: Buffer) => b.toString("base64");
  async function tenant() { const a = await org(); await callerFor(await member(a, ["management"])).documentControl.definitions.catalogSeed(); return a; }
  async function evidenceRow(id: number) { const [r] = await pool.execute<mysql.RowDataPacket[]>("SELECT storageKey, clientCaptureRef, capturedBy, category, recordType FROM evidenceRecords WHERE id = ?", [id]); return r[0]!; }

  it("captures a photo and a PDF with no template and no definition: hashed by the server, stored once, registered captured; the same capture reference twice is one document; declared types must match the bytes", async () => {
    const a = await tenant(); const driver = await member(a, ["driver"]); const c = callerFor(driver);
    const bytes = png(rnd()); const ref = `CAP-${rnd()}-${rnd()}`;
    const base = { title: "Something the driver was handed", fileName: "IMG_0001.png", mimeType: "image/png", dataBase64: b64(bytes), clientCaptureRef: ref, importChannel: "device_sync" as const, deviceRef: "DEV-1" };
    const r = await c.documentControl.documents.capture(base);
    expect(r).toMatchObject({ controlState: "captured", definitionKey: "unclassified_external_document", alreadyCaptured: false, duplicateOfDocumentRef: null, byteLength: bytes.byteLength, contentHash: shaB(bytes) });
    const ev = await evidenceRow(r.evidenceRecordId);
    expect(ev).toMatchObject({ clientCaptureRef: ref, capturedBy: driver, category: "document_control", recordType: "unclassified_external_document" });
    expect(objects.get(ev.storageKey)!.equals(bytes)).toBe(true);
    expect(ev.storageKey).toContain(shaB(bytes));
    // Sent twice (an offline retry): one document, no second object.
    const objectsBefore = objects.size;
    const again = await c.documentControl.documents.capture(base);
    expect(again).toMatchObject({ alreadyCaptured: true, documentRef: r.documentRef, evidenceRecordId: r.evidenceRecordId });
    expect(objects.size).toBe(objectsBefore);
    // What a thing is, is what its bytes say.
    await expect(c.documentControl.documents.capture({ ...base, clientCaptureRef: null, mimeType: "application/pdf", fileName: "x.pdf" })).rejects.toThrow(/do not open as one/);
    await expect(c.documentControl.documents.capture({ ...base, clientCaptureRef: null, mimeType: "application/zip" })).rejects.toThrow(/not a kind of bytes/);
    await expect(c.documentControl.documents.capture({ ...base, clientCaptureRef: null, originKind: "leaseos_generated" as never })).rejects.toThrow();
    // A PDF import, no template, no definition.
    const p = await c.documentControl.documents.capture({ title: "Vendor statement", fileName: "statement.pdf", mimeType: "application/pdf", dataBase64: b64(pdf(rnd())), originKind: "external_digital_import", importChannel: "office_upload" });
    expect(p.controlState).toBe("captured");
    const v = await c.documentControl.documents.get({ documentRef: r.documentRef });
    expect(v.document).toMatchObject({ evidenceRecordId: r.evidenceRecordId, contentHash: shaB(bytes), originKind: "external_scanned", issuerKind: "unknown", templateRevisionRef: null, controlNumber: null, capturedByDeviceRef: "DEV-1" });
    expect(v.derivatives).toEqual([]); expect(v.extractions).toEqual([]);
    expect(v.timeline.map(e => e.eventType)).toEqual(["document.captured"]);
    // The same bytes under another capture reference: captured (a second copy of one paper is a fact) and said so.
    const dup = await c.documentControl.documents.capture({ ...base, clientCaptureRef: `CAP-${rnd()}-${rnd()}` });
    expect(dup.duplicateOfDocumentRef).toBe(r.documentRef); expect(dup.documentRef).not.toBe(r.documentRef);
  }, 60_000);

  it("keeps an unknown form: a reading nothing recognises is recorded and kept as a derivative of the original, and the document waits as needs_classification — never dropped", async () => {
    const a = await tenant(); const office = await member(a, ["office"]); const c = callerFor(office);
    const bytes = png(rnd());
    const r = await c.documentControl.documents.capture({ title: "Unknown paper", fileName: "a.png", mimeType: "image/png", dataBase64: b64(bytes) });
    const text = `Handwritten note ${rnd()} — nothing a form recognises`;
    const x = await c.documentControl.documents.extract({ documentRef: r.documentRef, ocr: { engine: "test-ocr", engineVersion: "0.1", rawText: text, fields: [] } });
    expect(x).toMatchObject({ proposalId: null, formKey: null, proposedDefinitionKey: null, controlState: "needs_classification", questions: 0, proposedReferences: [] });
    expect(x.refusal).toMatch(/No form accepts/);
    expect(x.classification.documentType).toBe("unknown");
    const v = await c.documentControl.documents.get({ documentRef: r.documentRef });
    expect(v.document).toMatchObject({ controlState: "needs_classification", definitionKey: "unclassified_external_document", contentHash: shaB(bytes) });
    expect(v.extractions).toHaveLength(1);
    expect(v.extractions[0]).toMatchObject({ extractionRef: x.extractionRef, proposalId: null, status: "extracted", ocrEngine: "test-ocr", contentSha256: shaB(bytes), proposedDocumentType: "unknown", classificationSource: "ocr_model" });
    expect(v.derivatives).toHaveLength(1);
    const d = v.derivatives[0]!;
    expect(d).toMatchObject({ derivativeRef: x.derivativeRef, derivativeKind: "ocr_text", producer: "test-ocr", producerVersion: "0.1", extractionRef: x.extractionRef, sourceContentHash: shaB(bytes), contentHash: shaB(Buffer.from(text, "utf8")), mimeType: "text/plain", actorSource: "ai" });
    const ev = await evidenceRow(r.evidenceRecordId);
    expect(d.storageKey).not.toBe(ev.storageKey);
    expect(objects.get(d.storageKey)!.toString("utf8")).toBe(text);
    expect(objects.get(ev.storageKey)!.equals(bytes)).toBe(true);
    expect(v.timeline.map(e => e.eventType)).toEqual(["document.captured", "document.derivative_added", "document.extraction_recorded"]);
    // It is in the register, in the review facet, found by title.
    const waiting = await c.documentControl.documents.list({ controlState: "needs_classification", q: "Unknown paper" });
    expect(waiting.some(h => h.documentRef === r.documentRef)).toBe(true);
    // A second reading of the same paper is another extraction, not a replacement; the same text is the same derivative.
    const x2 = await c.documentControl.documents.extract({ documentRef: r.documentRef, ocr: { engine: "test-ocr", engineVersion: "0.2", rawText: text, fields: [] } });
    expect(x2.derivativeRef).toBe(x.derivativeRef);
    expect((await c.documentControl.documents.get({ documentRef: r.documentRef })).extractions).toHaveLength(2);
  }, 60_000);

  it("OCR is a proposal: a facility ticket's reading becomes proposal fields and questions, a proposed reference and a proposed definition; the row's facts move only when a person confirms them", async () => {
    const a = await tenant(); const office = await member(a, ["office"]); const c = callerFor(office);
    const fac = await facility(`ACME Disposal ${rnd()}`); const j = await job(a);
    const bytes = png(rnd());
    const r = await c.documentControl.documents.capture({ title: "Facility paper", fileName: "t.png", mimeType: "image/png", dataBase64: b64(bytes), links: [{ recordType: "job", recordRef: j.code, recordId: j.id, confirmed: true }] });
    const x = await c.documentControl.documents.extract({ documentRef: r.documentRef, ocr: {
      engine: "device-ocr", engineVersion: "1.2", documentTypeHint: "disposal_ticket", documentTypeConfidence: 92,
      rawText: "ACME DISPOSAL FACILITY  DISPOSAL TICKET 874399  MANIFEST  GROSS 21000 KG  TARE 9000 KG  NET 12000 KG  m3",
      fields: [{ key: "facilityName", confidence: 99, value: "ACME Disposal" }, { key: "facilityTicketNumber", confidence: 97, value: "874399" }, { key: "grossWeightKg", confidence: 99, value: 21000 }, { key: "tareWeightKg", confidence: 99, value: 9000 }, { key: "netWeightKg", confidence: 99, value: 12000 }, { key: "material", confidence: 70, value: "produced water" }],
    } });
    expect(x).toMatchObject({ proposedDefinitionKey: "external_disposal_receipt", formKey: "disposal_ticket", controlState: "proposed", refusal: null });
    expect(x.proposalId).toMatch(/^PROP-DC-/);
    expect(x.proposedReferences).toHaveLength(1);
    expect(x.counts.humanOnly).toBeGreaterThanOrEqual(4);   // the weights, the ticket number, the date
    expect(x.counts.autoFiled).toBe(1);                       // the facility name: low-risk metadata, still proposed
    expect(x.questions).toBeGreaterThan(0);
    // The proposal engine's tables hold it, every field proposed and photo_ocr — nothing confirmed by a machine.
    const [prop] = await pool.execute<mysql.RowDataPacket[]>("SELECT commitState, targetRef, targetRecordId, jobId, formKey, createdByUserId FROM assistantProposals WHERE proposalId = ?", [x.proposalId]);
    expect(prop[0]).toMatchObject({ commitState: "awaiting_answers", targetRef: r.documentRef, targetRecordId: r.documentId, jobId: j.id, formKey: "disposal_ticket", createdByUserId: office });
    const [flds] = await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM proposalFields WHERE proposalId = ?", [x.proposalId]);
    expect(flds.length).toBeGreaterThanOrEqual(6);
    expect(flds.every(f => f.status === "proposed" && f.source === "photo_ocr")).toBe(true);
    expect(flds.find(f => f.fieldKey === "netWeightKg")).toMatchObject({ fieldValue: "12000" });   // read as printed: exact (the engine's rule; asserted in documentIntake.test)
    const [qs] = await pool.execute<mysql.RowDataPacket[]>("SELECT fieldKey, reason FROM assistantQuestions WHERE proposalId = ? AND status = 'pending'", [x.proposalId]);
    expect(qs.find(q => q.fieldKey === "netWeightKg")!.reason).toBe("sensitive_human_only");
    // The register row: still unclassified, still unknown issuer; the number is proposed, by OCR, unconfirmed.
    const before = await c.documentControl.documents.get({ documentRef: r.documentRef });
    expect(before.document).toMatchObject({ definitionKey: "unclassified_external_document", issuerKind: "unknown", controlState: "proposed", contentHash: shaB(bytes) });
    expect(before.references[0]).toMatchObject({ referenceType: "facility_ticket_number", referenceValue: "874399", source: "ocr_proposed", confirmationStatus: "proposed", issuerKind: "unknown" });
    expect(before.extractions[0]).toMatchObject({ status: "proposed", proposalId: x.proposalId, classificationSource: "ocr_model", proposedDocumentType: "external_disposal_receipt" });
    expect(before.timeline.map(e => e.eventType)).toEqual(["document.captured", "document.derivative_added", "document.reference_added", "document.proposed"]);
    expect(before.timeline[3]!.detail).toMatchObject({ proposalId: x.proposalId, engine: "device-ocr", proposedDefinitionKey: "external_disposal_receipt" });
    // A person confirms: definition, issuer, and the number OCR proposed — which takes the issuer they name.
    const ok = await c.documentControl.documents.confirm({ documentRef: r.documentRef, definitionKey: "external_disposal_receipt", issuer: { issuerKind: "facility", issuerFacilityId: fac, issuerName: "ACME Disposal" }, confirmReferenceRefs: [before.references[0]!.referenceRef] });
    expect(ok).toMatchObject({ controlState: "confirmed", definitionKey: "external_disposal_receipt" });
    const after = await c.documentControl.documents.get({ documentRef: r.documentRef });
    expect(after.references[0]).toMatchObject({ confirmationStatus: "confirmed", issuerKind: "facility", issuerFacilityId: fac, issuerScopeKey: `facility:${fac}`, source: "ocr_proposed" });
    expect(after.document).toMatchObject({ issuerKind: "facility", contentHash: shaB(bytes) });
    // Frozen now: a further reading proposes nothing to it.
    await expect(c.documentControl.documents.extract({ documentRef: r.documentRef, ocr: { engine: "device-ocr", rawText: "again", fields: [] } })).rejects.toThrow(/frozen/);
    // A driver who scanned it and said what it was: the say-so is a classification of source human, still proposed until confirmed.
    const r2 = await c.documentControl.documents.capture({ title: "Second paper", fileName: "u.png", mimeType: "image/png", dataBase64: b64(png(rnd())) });
    const x2 = await c.documentControl.documents.extract({ documentRef: r2.documentRef, expectedDefinitionKey: "scale_ticket", ocr: { engine: "device-ocr", rawText: "GROSS TARE NET KG SCALE", fields: [{ key: "netWeightKg", confidence: 99, value: 100 }] } });
    expect(x2).toMatchObject({ proposedDefinitionKey: "scale_ticket", formKey: "disposal_ticket", controlState: "proposed" });
    expect((await c.documentControl.documents.get({ documentRef: r2.documentRef })).extractions[0]).toMatchObject({ classificationSource: "human", proposedDocumentType: "scale_ticket" });
    expect((await c.documentControl.documents.get({ documentRef: r2.documentRef })).document.definitionKey).toBe("unclassified_external_document");
  }, 60_000);

  it("the original is immutable: its hash and bytes never change, a derivative is never overwritten, and the original's own bytes are not a derivative", async () => {
    const a = await tenant(); const office = await member(a, ["office"]); const c = callerFor(office);
    const bytes = png(rnd());
    const r = await c.documentControl.documents.capture({ title: "Scan", fileName: "s.png", mimeType: "image/png", dataBase64: b64(bytes) });
    const page = png(`page-${rnd()}`);
    const d1 = await c.documentControl.documents.attachDerivative({ documentRef: r.documentRef, derivativeKind: "page_image", mimeType: "image/png", dataBase64: b64(page), producer: "deskew", producerVersion: "2.0" });
    expect(d1).toMatchObject({ alreadyAttached: false, sourceContentHash: shaB(bytes), contentHash: shaB(page), byteLength: page.byteLength });
    expect(d1.storageKey).toContain(`/derivatives/${r.documentRef}/page_image/`);
    const d2 = await c.documentControl.documents.attachDerivative({ documentRef: r.documentRef, derivativeKind: "page_image", mimeType: "image/png", dataBase64: b64(page), producer: "deskew" });
    expect(d2).toMatchObject({ alreadyAttached: true, derivativeRef: d1.derivativeRef });
    await expect(c.documentControl.documents.attachDerivative({ documentRef: r.documentRef, derivativeKind: "other", mimeType: "image/png", dataBase64: b64(bytes), producer: "copy" })).rejects.toThrow(/are the original/);
    // The database itself refuses: a captured row's bytes and a derivative's bytes are not updatable.
    await expect(pool.execute("UPDATE commercialDocuments SET contentHash = ? WHERE id = ?", [shaB(page), r.documentId])).rejects.toThrow(/never change/);
    await expect(pool.execute("UPDATE commercialDocuments SET evidenceRecordId = NULL WHERE id = ?", [r.documentId])).rejects.toThrow(/never change/);
    await expect(pool.execute("UPDATE documentDerivatives SET storageKey = 'elsewhere' WHERE derivativeRef = ?", [d1.derivativeRef])).rejects.toThrow(/never overwritten/);
    const ev = await evidenceRow(r.evidenceRecordId);
    expect(objects.get(ev.storageKey)!.equals(bytes)).toBe(true);
    const v = await c.documentControl.documents.get({ documentRef: r.documentRef });
    expect(v.document.contentHash).toBe(shaB(bytes));
    expect(v.derivatives).toHaveLength(1);
    expect(v.timeline.map(e => e.eventType)).toEqual(["document.captured", "document.derivative_added"]);
  }, 60_000);

  it("fails closed across tenants: another business cannot extract from, attach to, or capture against this business's records", async () => {
    const a = await tenant(); const b = await tenant(); const officeA = await member(a, ["office"]); const officeB = await member(b, ["office"]);
    const ca = callerFor(officeA), cb = callerFor(officeB);
    const jA = await job(a);
    const r = await ca.documentControl.documents.capture({ title: "A's scan", fileName: "a.png", mimeType: "image/png", dataBase64: b64(png(rnd())) });
    await expect(cb.documentControl.documents.extract({ documentRef: r.documentRef, ocr: { engine: "x", rawText: "y", fields: [] } })).rejects.toThrow(/not in this business/);
    await expect(cb.documentControl.documents.attachDerivative({ documentRef: r.documentRef, derivativeKind: "thumbnail", mimeType: "image/png", dataBase64: b64(png("t")), producer: "thumb" })).rejects.toThrow(/not in this business/);
    await expect(cb.documentControl.documents.get({ documentRef: r.documentRef })).rejects.toThrow(/not in this business/);
    const [n0] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE title = 'B against A'");
    const objectsBefore = objects.size;
    await expect(cb.documentControl.documents.capture({ title: "B against A", fileName: "b.png", mimeType: "image/png", dataBase64: b64(png(rnd())), links: [{ recordType: "job", recordRef: jA.code, recordId: jA.id }] })).rejects.toThrow(/not in this business's records/);
    const [n1] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE title = 'B against A'");
    expect(n1[0]!.n).toBe(n0[0]!.n);       // refused before any byte was stored
    expect(objects.size).toBe(objectsBefore);
  }, 60_000);
});

d("search (DC-H): the register is found by another issuer's number, labelled with its origin, in the caller's book only", () => {
  it("finds a scanned facility receipt by the facility's number and by title; another business finds nothing", async () => {
    const a = await org(); const b = await org();
    const officeA = await member(a, ["office", "management"]); const officeB = await member(b, ["office", "management"]);
    await callerFor(officeA).documentControl.definitions.catalogSeed();
    const fac = await facility(`Search Fac ${rnd()}`); const number = `SRCH${rnd()}`;
    const reg = await callerFor(officeA).documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: `Facility ticket ${number}`, originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: fac, issuerName: "Search Facility" }, evidenceRecordId: await evidence(officeA, sha(number)), contentHash: sha(number), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: number, source: "human_entered", confirmed: true }] });
    const hitsA = (await callerFor(officeA).surfaces.search({ q: number })).hits.filter(h => h.entityType === "document");
    expect(hitsA).toHaveLength(1);
    expect(hitsA[0]).toMatchObject({ entityId: reg.documentRef, status: "captured", readPermission: "document.read" });
    expect(hitsA[0]!.label).toContain(`Search Facility #${number}`);
    expect(hitsA[0]!.label).toContain("external_disposal_receipt");
    expect(hitsA[0]!.label).toContain("Search Facility; external scanned");
    expect(hitsA[0]!.deepLink.route).toBe(`/document-control?ref=${reg.documentRef}`);
    expect((await callerFor(officeA).surfaces.search({ q: reg.documentRef })).hits.some(h => h.entityId === reg.documentRef)).toBe(true);
    expect((await callerFor(officeB).surfaces.search({ q: number })).hits.filter(h => h.entityType === "document")).toEqual([]);
  }, 60_000);
});

d("the disposal vertical slice (DC-G): job → load → facility → the facility's paper → scan → confirm → disposal record → verification → billing → invoice → audit trail", () => {
  const shaB = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`scan ${tag}`)]);
  const b64 = (b: Buffer) => b.toString("base64");
  async function tenant() { const a = await org(); await callerFor(await member(a, ["management"])).documentControl.definitions.catalogSeed(); return a; }

  /** The paper's reading, as a device's recogniser would hand it over. The facility's number, the weights, the load the driver keyed. */
  const readingOf = (loadNumber: string, ticket: string) => ({
    engine: "device-ocr", engineVersion: "1.2", documentTypeHint: "disposal_ticket" as const, documentTypeConfidence: 90,
    rawText: `ACME DISPOSAL FACILITY  DISPOSAL TICKET ${ticket}  LOAD ${loadNumber}  GROSS 21000 KG  TARE 9000 KG  NET 12000 KG  m3`,
    fields: [
      { key: "facilityName", confidence: 99, value: "ACME Disposal" }, { key: "facilityTicketNumber", confidence: 97, value: ticket }, { key: "loadRef", confidence: 96, value: loadNumber },
      { key: "ticketDate", confidence: 95, value: "2026-09-20" }, { key: "grossWeightKg", confidence: 99, value: 21000 }, { key: "tareWeightKg", confidence: 99, value: 9000 }, { key: "netWeightKg", confidence: 99, value: 12000 }, { key: "material", confidence: 90, value: "produced water" },
    ],
  });

  /** Everything after the scan is confirmed: the disposal record through the assistant's typed commit, verification, a billing line, an invoice rendered and registered. Shared by both scenarios. */
  async function fromConfirmedScanToInvoice(a: string, office: number, ids: { job: { id: number; code: string }; load: { id: number; loadNumber: string }; fac: number; op: number; un: number; documentRef: string; proposalId: string }) {
    const c = callerFor(office);
    // The office works the proposal in the assistant: answers what the reading asked of a person (they have the paper), reads back, acknowledges — then the one typed commit path creates the disposal record.
    const [qs] = await pool.execute<mysql.RowDataPacket[]>("SELECT fieldKey FROM assistantQuestions WHERE proposalId = ? AND status = 'pending'", [ids.proposalId]);
    const values: Record<string, string | number> = { facilityTicketNumber: "874399", ticketDate: "2026-09-20", grossWeightKg: 21000, tareWeightKg: 9000, netWeightKg: 12000, loadRef: ids.load.loadNumber, material: "produced water", facilityName: "ACME Disposal" };
    for (const q of qs) if (values[q.fieldKey] !== undefined) await c.fieldRoute.assistant.answer({ proposalId: ids.proposalId, fieldKey: q.fieldKey, value: values[q.fieldKey]! });   // exact by default: the person read it off the paper
    await c.fieldRoute.assistant.readBack({ proposalId: ids.proposalId });
    await c.fieldRoute.assistant.acknowledge({ proposalId: ids.proposalId });
    const commit = await c.fieldRoute.assistant.commit({ proposalId: ids.proposalId });
    expect(commit, JSON.stringify(commit)).toMatchObject({ committed: true, targetType: "disposal_ticket" });
    const dspId = (commit as { targetRecordId: number }).targetRecordId;
    const [dspRows] = await pool.execute<mysql.RowDataPacket[]>("SELECT ticketNumber, verificationStatus, facilityTicketNumber, loadId, facilityId, netKg, evidenceRefs, verifiedByUserId FROM disposalTickets WHERE id = ?", [dspId]);
    const dsp = dspRows[0]!;
    expect(dsp).toMatchObject({ verificationStatus: "needs_review", facilityTicketNumber: "874399", loadId: ids.load.id, facilityId: ids.fac, netKg: 12000, verifiedByUserId: null });
    expect(JSON.parse(dsp.evidenceRefs).documentRef).toBe(ids.documentRef);
    // The register heard: the scan is linked to the record it became, the facility's number is a mirror of the domain's column, the extraction is committed.
    const afterCommit = await c.documentControl.documents.get({ documentRef: ids.documentRef });
    expect(afterCommit.links.find(l => l.recordType === "disposal_ticket")).toMatchObject({ recordRef: dsp.ticketNumber, recordId: dspId, source: "domain", confirmationStatus: "confirmed", role: "source_document" });
    expect(afterCommit.references[0]).toMatchObject({ referenceValue: "874399", confirmationStatus: "confirmed", mirrorOfTable: "disposalTickets", mirrorOfId: dspId, mirrorOfColumn: "facilityTicketNumber" });
    expect(afterCommit.extractions[0]!.status).toBe("committed");
    expect(afterCommit.document.controlNumber).toBeNull();   // the facility's paper never gets a LeaseOS number
    // Billing: a disposal line naming the ticket is refused until a person verifies it; another business cannot verify it.
    const ft = await c.closeout.ticketOpen({ jobId: ids.job.id, unitId: ids.un, operatorId: ids.op, serviceDescription: "Disposal haul" });
    const line = { ticketNumber: ft.ticketNumber, lineKind: "disposal" as const, description: "Disposal — ACME 874399", quantity: 12, quantityUnit: "t", measurementMethod: "scale" as const, sourceTrackingNumber: dsp.ticketNumber as string };
    await expect(c.closeout.lineAdd(line)).rejects.toThrow(/needs_review.*verified ticket/);
    const b = await tenant(); const officeB = await member(b, ["office"]);
    await expect(callerFor(officeB).commercialOffice.disposal.verifyTicket({ ticketNumber: dsp.ticketNumber, outcome: "verified" })).rejects.toThrow(/not found/);
    const ver = await c.commercialOffice.disposal.verifyTicket({ ticketNumber: dsp.ticketNumber, outcome: "verified", note: "matches the facility's paper 874399" });
    expect(ver).toMatchObject({ verificationStatus: "verified", loadChainState: "disposal_verified", alreadyVerified: false });
    expect(ver.documentsTold).toBeGreaterThanOrEqual(1);
    const [v2] = await pool.execute<mysql.RowDataPacket[]>("SELECT d.verificationStatus, d.verifiedByUserId, d.verifiedAt, d.verificationNote, l.chainState FROM disposalTickets d JOIN loads l ON l.id = d.loadId WHERE d.id = ?", [dspId]);
    expect(v2[0]).toMatchObject({ verificationStatus: "verified", verifiedByUserId: office, chainState: "disposal_verified" });
    expect(v2[0]!.verifiedAt).not.toBeNull();
    expect((await c.commercialOffice.disposal.verifyTicket({ ticketNumber: dsp.ticketNumber, outcome: "verified" })).alreadyVerified).toBe(true);
    const added = await c.closeout.lineAdd(line);
    expect(added.lineId).toBeGreaterThan(0);
    // The invoice: its rows as the office's own suites fixture them, its document rendered by the invoicing engine, registered as the tenant's issued record under the domain's number.
    const invoiceNumber = `INV-${rnd()}`;
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, ?, 'Cust', 'invoiced', NOW(), NOW(), NOW())", [`BB-${rnd()}`, ids.job.id]);
    const [inv] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO invoices (invoiceNumber, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, gstTreatment) VALUES (?, NOW(), ?, ?, 'Cust', 240000, 12000, 252000, 'CAD', 'approved', 'taxable')", [invoiceNumber, book.insertId, ids.job.id]);
    await pool.execute("INSERT INTO invoiceLines (invoiceId, lineNo, fieldTicketLineId, description, quantityMillis, billableQuantityMillis, unit, rateMillis, amountCents, basis) VALUES (?, 1, ?, 'Disposal — ACME 874399', 12000, 12000, 't', 200000, 240000, 'verified disposal ticket')", [inv.insertId, added.lineId]);
    const calc = { lines: [{ lineNo: 1, description: "Disposal — ACME 874399", billableQuantityMillis: 12000, unit: "t", rateMillis: 200000, amountCents: 240000, basis: `verified disposal ticket ${dsp.ticketNumber}` }], subtotalCents: 240000, taxCents: 12000, totalCents: 252000, ratePercent: 5 };
    await pool.execute("INSERT INTO billingSnapshots (invoiceId, billingBookId, capturedAt, sourceFactsJson, calculatedLinesJson, subtotalCents, totalCents, payloadHash) VALUES (?, ?, NOW(), ?, ?, 240000, 252000, ?)", [inv.insertId, book.insertId, JSON.stringify({ disposalTicket: dsp.ticketNumber }), JSON.stringify(calc), sha(`${invoiceNumber}-snapshot`)]);
    const rendered = await c.invoicing.render({ invoiceNumber });
    expect(rendered.alreadyRendered).toBe(false);
    const [ftd] = await pool.execute<mysql.RowDataPacket[]>("SELECT id, storageKey, contentHash FROM fieldTicketDocuments WHERE documentRef = ?", [rendered.documentRef]);
    expect(objects.get(ftd[0]!.storageKey)!.subarray(0, 4).toString()).toBe("%PDF");
    const invDoc = await c.documentControl.documents.registerRendered({
      definitionKey: "invoice", title: `Invoice ${invoiceNumber}`, originKind: "system_rendered", contentHash: rendered.contentHash, byteLength: rendered.byteLength, mimeType: "application/pdf", fieldTicketDocumentId: ftd[0]!.id, controlNumber: invoiceNumber,
      links: [{ recordType: "job", recordRef: ids.job.code, recordId: ids.job.id }, { recordType: "load", recordRef: ids.load.loadNumber, recordId: ids.load.id }, { recordType: "disposal_ticket", recordRef: dsp.ticketNumber, recordId: dspId }, { recordType: "invoice", recordRef: invoiceNumber }],
    });
    expect(invDoc).toMatchObject({ controlState: "issued", controlNumber: invoiceNumber });
    expect(invDoc.provenance).toMatch(/LeaseOS|rendered/i);
    return { dspId, dspNumber: dsp.ticketNumber as string, invoiceNumber, invoiceDocumentRef: invDoc.documentRef, fieldTicketNumber: ft.ticketNumber };
  }

  it("B — NO LeaseOS disposal template: the facility's paper is the original, the disposal row is the fact, the register ties them; every step and its actor are on the timeline", async () => {
    const a = await tenant(); const office = await member(a, ["office"]); const driver = await member(a, ["driver"]);
    const fac = await facility(`ACME Disposal ${rnd()}`); const j = await job(a); const op = await operator(a, "Dana Driver"); const un = await unit(a, `U-${rnd()}`); const l = await load(j.id, op, un);
    await pool.execute("UPDATE loads SET chainState = 'arrived_disposal' WHERE id = ?", [l.id]);
    const c = callerFor(office); const cd = callerFor(driver);
    // No template of any kind for this facility's paper — none in the library, none asked for.
    expect((await c.documentControl.templates.list({})).filter(t => t.definitionKey === "external_disposal_receipt")).toEqual([]);
    // The driver photographs what the facility handed over and says what load it was for.
    const bytes = png(rnd());
    const cap = await cd.documentControl.documents.capture({ title: "Facility ticket", fileName: "ticket.png", mimeType: "image/png", dataBase64: b64(bytes), importChannel: "device_sync", deviceRef: "DEV-7", links: [{ recordType: "job", recordRef: j.code, recordId: j.id, confirmed: true }, { recordType: "load", recordRef: l.loadNumber, recordId: l.id, confirmed: true }] });
    expect(cap.controlState).toBe("captured");
    const x = await cd.documentControl.documents.extract({ documentRef: cap.documentRef, expectedDefinitionKey: "external_disposal_receipt", deviceRef: "DEV-7", ocr: readingOf(l.loadNumber, "874399") });
    expect(x).toMatchObject({ proposedDefinitionKey: "external_disposal_receipt", formKey: "disposal_ticket", controlState: "proposed" });
    expect(x.proposalId).toBeTruthy();
    // The reading made no disposal record and no fact: nothing in the domain yet, the row still unclassified.
    const [n0] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM disposalTickets WHERE loadId = ?", [l.id]);
    expect(n0[0]!.n).toBe(0);
    const before = await c.documentControl.documents.get({ documentRef: cap.documentRef });
    expect(before.document).toMatchObject({ definitionKey: "unclassified_external_document", issuerKind: "unknown" });
    // The office confirms: the paper is the facility's receipt, the facility issued it, the number the reading found stands.
    await c.documentControl.documents.confirm({ documentRef: cap.documentRef, definitionKey: "external_disposal_receipt", issuer: { issuerKind: "facility", issuerFacilityId: fac, issuerName: "ACME Disposal" }, confirmReferenceRefs: [before.references[0]!.referenceRef] });
    const [prop] = await pool.execute<mysql.RowDataPacket[]>("SELECT facilityId, loadId, jobId, commitState FROM assistantProposals WHERE proposalId = ?", [x.proposalId]);
    expect(prop[0]).toMatchObject({ facilityId: fac, loadId: l.id, jobId: j.id });   // the proposal follows the confirmed facts — server-resolved, not read off the paper
    const done = await fromConfirmedScanToInvoice(a, office, { job: j, load: l, fac, op, un, documentRef: cap.documentRef, proposalId: x.proposalId! });
    // The audit trail: by load, by disposal ticket, by job — the scan and the invoice, each with its own origin; the scan's timeline reconstructs the chain with its actors.
    const byLoad = await c.documentControl.documents.list({ recordType: "load", recordRef: l.loadNumber });
    expect(byLoad.map(h => [h.definitionKey, h.originKind, h.issuerKind, h.controlNumber]).sort()).toEqual([["external_disposal_receipt", "external_scanned", "facility", null], ["invoice", "system_rendered", "tenant", done.invoiceNumber]]);
    const byDsp = await c.documentControl.documents.list({ recordType: "disposal_ticket", recordRef: done.dspNumber });
    expect(byDsp.map(h => h.documentRef).sort()).toEqual([cap.documentRef, done.invoiceDocumentRef].sort());
    const chain = await c.documentControl.documents.get({ documentRef: cap.documentRef });
    expect(chain.timeline.map(e => e.eventType)).toEqual(["document.captured", "document.derivative_added", "document.reference_added", "document.proposed", "document.reference_confirmed", "document.classified", "document.confirmed", "document.link_added", "document.domain_verified"]);
    expect(chain.timeline.map(e => e.actorUserId)).toEqual([driver, driver, driver, driver, office, office, office, office, office]);
    expect(chain.timeline.map(e => e.actorSource)).toEqual(["human", "ai", "ai", "ai", "human", "human", "human", "human", "human"]);
    expect(chain.timeline[8]!.detail).toMatchObject({ domain: "disposal", recordRef: done.dspNumber, outcome: "verified", loadChainState: "disposal_verified" });
    expect(chain.document.contentHash).toBe(shaB(bytes));
    expect(chain.provenance).toMatch(/Scanned from paper.*issued by ACME Disposal; no LeaseOS number/);
    expect(chain.links.map(x => x.recordType).sort()).toEqual(["disposal_ticket", "job", "load"]);
    // The invoice's own record names the same chain.
    const invView = await c.documentControl.documents.get({ documentRef: done.invoiceDocumentRef });
    expect(invView.links.map(x => x.recordType).sort()).toEqual(["disposal_ticket", "invoice", "job", "load"]);
    expect(invView.document).toMatchObject({ originKind: "system_rendered", issuerKind: "tenant", controlNumber: done.invoiceNumber, templateRevisionRef: null });
  }, 120_000);

  it("A — the company's own disposal ticket template, uploaded, mapped, released, rendered from the verified facts and issued under the domain's number — beside the facility's paper, never instead of it", async () => {
    const a = await tenant(); const office = await member(a, ["office"]); const mgr = await member(a, ["management"]); const driver = await member(a, ["driver"]);
    const fac = await facility(`ACME Disposal ${rnd()}`); const j = await job(a); const op = await operator(a, "Dana Driver"); const un = await unit(a, `U-${rnd()}`); const l = await load(j.id, op, un);
    await pool.execute("UPDATE loads SET chainState = 'arrived_disposal' WHERE id = ?", [l.id]);
    const c = callerFor(office); const m = callerFor(mgr); const cd = callerFor(driver);
    // Template administration: the company uploads its own markdown layout (untrusted bytes: hashed, kept as evidence, read back only against that hash), maps it, releases it.
    const layout = Buffer.from("# {{title}}\n\nTicket no.: {{ticket_no}}\nLoad: {{load}}\nDriver: {{driver}}\nUnit: {{unit}}\nFacility: {{facility}}\nFacility ticket: {{facility_ticket}}\nNet (kg): {{net_kg}}\n\nSigned: {{customer_rep}}\n", "utf8");
    const layoutKey = `${mgr}/evidence/${shaB(layout).slice(0, 12)}.md`; objects.set(layoutKey, layout);
    const [evRow] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, storageKey, mimeType, capturedAt, capturedBy, status, recordType) VALUES ('ACME disposal ticket layout', 'template', ?, 'text/markdown', NOW(), ?, 'needs_review', 'template')", [layoutKey, mgr]);
    const tpl = await m.documentControl.templates.createCustom({ definitionKey: "disposal_ticket", templateKey: `acme_disposal_ticket_${rnd().toLowerCase()}`, name: "ACME disposal ticket", sourceKind: "organization_custom", evidenceRecordId: evRow.insertId, contentHash: shaB(layout), byteLength: layout.byteLength, fileName: "acme_disposal_ticket.md", mimeType: "text/markdown" });
    expect(tpl).toMatchObject({ layoutKind: "markdown_text", renderable: true });
    await m.documentControl.templates.revisionRelease({ revisionRef: tpl.revisionRef });
    const r2 = await m.documentControl.templates.revisionDraft({ templateRef: tpl.templateRef, fieldMapping: { version: 1, fields: [
      ["title", "document.title"], ["ticket_no", "document.controlNumber"], ["load", "load.loadNumber"], ["driver", "operator.name"], ["unit", "unit.unitNumber"], ["facility", "facility.name"], ["facility_ticket", "external.facilityTicketNumber"], ["net_kg", "scale.netKg"], ["customer_rep", "signature.customerRepresentative"],
    ].map(([printedField, semanticKey]) => ({ printedField: printedField!, semanticKey: semanticKey! })) } });
    await m.documentControl.templates.revisionRelease({ revisionRef: r2.revisionRef });
    // The facility's paper still goes through the scan, exactly as in B.
    const cap = await cd.documentControl.documents.capture({ title: "Facility ticket", fileName: "ticket.png", mimeType: "image/png", dataBase64: b64(png(rnd())), importChannel: "device_sync", links: [{ recordType: "job", recordRef: j.code, recordId: j.id, confirmed: true }, { recordType: "load", recordRef: l.loadNumber, recordId: l.id, confirmed: true }] });
    const x = await cd.documentControl.documents.extract({ documentRef: cap.documentRef, expectedDefinitionKey: "external_disposal_receipt", ocr: readingOf(l.loadNumber, "874399") });
    const before = await c.documentControl.documents.get({ documentRef: cap.documentRef });
    await c.documentControl.documents.confirm({ documentRef: cap.documentRef, definitionKey: "external_disposal_receipt", issuer: { issuerKind: "facility", issuerFacilityId: fac, issuerName: "ACME Disposal" }, confirmReferenceRefs: [before.references[0]!.referenceRef] });
    const done = await fromConfirmedScanToInvoice(a, office, { job: j, load: l, fac, op, un, documentRef: cap.documentRef, proposalId: x.proposalId! });
    // Now LeaseOS's own disposal ticket, rendered from the records (the load's driver and unit, the facility) and the person's values, proposed until issued under the disposal record's number.
    const rendered = await c.documentControl.semantic.render({ templateRevisionRef: r2.revisionRef, context: { jobId: j.id, loadId: l.id, facilityId: fac }, humanValues: { facility_ticket: "874399", net_kg: 12000, customer_rep: "M. Johnson" }, requestedState: "proposed", links: [{ recordType: "disposal_ticket", recordRef: done.dspNumber, recordId: done.dspId }] });
    expect(rendered).toMatchObject({ controlState: "proposed", controlNumber: null });
    expect(rendered.unfilled).toEqual(["ticket_no"]);   // the number comes at issue, never invented at render
    expect(rendered.preparation.fields.find(f => f.printedField === "driver")).toMatchObject({ value: "Dana Driver", state: "filled" });
    expect(rendered.preparation.fields.find(f => f.printedField === "ticket_no")).toMatchObject({ state: "server_at_issue" });
    expect(objects.get(rendered.storageKey)!.subarray(0, 4).toString()).toBe("%PDF");
    const issued = await c.documentControl.documents.issue({ documentRef: rendered.documentRef, controlNumber: done.dspNumber });
    expect(issued).toMatchObject({ controlState: "issued", controlNumber: done.dspNumber });
    const v = await c.documentControl.documents.get({ documentRef: rendered.documentRef });
    expect(v.document).toMatchObject({ definitionKey: "disposal_ticket", originKind: "organization_template", issuerKind: "tenant", templateRevisionRef: r2.revisionRef, controlNumber: done.dspNumber });
    expect(v.links.map(x => x.recordType).sort()).toEqual(["disposal_ticket", "facility", "job", "load", "operator", "unit"]);
    // Three records on one disposal, each with its own origin: the facility's paper, the company's ticket, the invoice. The paper is not replaced by the rendering.
    const byDsp = await c.documentControl.documents.list({ recordType: "disposal_ticket", recordRef: done.dspNumber });
    expect(byDsp.map(h => [h.definitionKey, h.originKind, h.controlNumber]).sort()).toEqual([["disposal_ticket", "organization_template", done.dspNumber], ["external_disposal_receipt", "external_scanned", null], ["invoice", "system_rendered", done.invoiceNumber]]);
    // A stale layout cannot rewrite the record: re-rendering the same revision after the fact is a new document, and the issued one stays on its revision with its manifest.
    expect(v.document.renderManifestHash).not.toBeNull();
    const again = await c.documentControl.semantic.render({ templateRevisionRef: r2.revisionRef, context: { jobId: j.id, loadId: l.id, facilityId: fac }, humanValues: { facility_ticket: "874399", net_kg: 12000 }, requestedState: "proposed" });
    expect(again.documentRef).not.toBe(rendered.documentRef);
    expect((await c.documentControl.documents.get({ documentRef: rendered.documentRef })).document.controlNumber).toBe(done.dspNumber);
  }, 120_000);
});
