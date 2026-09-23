/**
 * Document Control, Checkpoint A (0178) — the definition registry and the catalog seed, through the router.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { seedDocumentCatalog } from "./_core/documentCatalogSeed";
import { SYSTEM_DEFINITIONS } from "./_core/documentDefinitions";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 260_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
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
