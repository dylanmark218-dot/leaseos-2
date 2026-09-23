/**
 * Document Control, Checkpoint A (0178) — the definition registry and the catalog seed, through the router.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
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
