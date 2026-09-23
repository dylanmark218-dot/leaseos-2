/**
 * Document Control — catalog seeding (DC-A, 0178).
 *
 * Reads the supplied template catalog from `data/document-control/` and asserts
 * it into the registry: LeaseOS's own system definitions, the catalog's 46
 * families (43 new definitions; three attach to kinds the register already
 * had), and every one of the 81 source artifacts by SHA-256.
 *
 * Idempotent by construction. A definition is keyed by (scope, key, version)
 * and an artifact by its hash; a re-run inserts nothing it already holds. A
 * platform definition whose policy the code constant has since changed is
 * updated in place and reported — the row is a catalog entry, not a record,
 * and records cite the `definitionRef` they were confirmed under.
 *
 * Provenance is verified, not copied: for every artifact whose bytes are in
 * the repository the hash is recomputed from disk and must equal the
 * manifest's before the row is marked verified. A file that is missing is
 * registered unverified and named in the report; a file whose bytes differ
 * from the manifest is a refusal, because a template whose hash does not
 * match its provenance is exactly the thing this table exists to catch.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commercialCategoryTypes, documentDefinitions, documentSourceArtifacts, type InsertDocumentDefinition, type InsertDocumentSourceArtifact } from "../../drizzle/schema";
import {
  definitionFromPackageEntry, definitionPolicyDigest, definitionRefusals, PACKAGE_DEFINITION_ALIASES, resolvePackageKey, rowToDefinition, SYSTEM_DEFINITIONS,
  type DocumentDefinitionRow, type DocumentDefinitionSeed, type PackageDefinitionEntry,
} from "./documentDefinitions";

export const CATALOG_ROOT = "data/document-control";
export const CATALOG_SEED_FILE = "document_definitions.seed.json";
export const CATALOG_MANIFEST_FILE = "source_artifact_manifest.csv";
export const PLATFORM_SCOPE = "platform";

type Db = MySql2Database<Record<string, unknown>>;

export type ManifestRow = {
  source_archive_dir: string; source_path: string; file_name: string; extension: string; size_bytes: string; sha256: string; role: string;
  title_candidate: string; template_code_or_doc_ref: string; revision_detected: string; pages: string;
};

/** RFC-4180 enough for the manifest: quoted fields, doubled quotes, no embedded newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (!lines.length) return [];
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!);
  return lines.slice(1).map(l => { const cells = split(l); return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])); });
}

export function sha256Hex(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

const platformRef = (key: string, version = 1) => `DEF-P-${key}-v${version}`;
const newBatchRef = () => `DCB-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
const j = (v: unknown[]) => JSON.stringify(v);

function toInsert(d: DocumentDefinitionSeed, extra: { orgRef: string | null; definitionRef: string; createdByUserId: number | null }): InsertDocumentDefinition {
  return {
    definitionRef: extra.definitionRef, orgRef: extra.orgRef, scopeKey: extra.orgRef ?? PLATFORM_SCOPE, definitionKey: d.definitionKey, definitionVersion: 1, status: "active",
    documentClass: d.documentClass, displayName: d.displayName, description: d.description, primaryDomainOwner: d.primaryDomainOwner, allowedOriginsJson: j(d.allowedOrigins),
    numberingPolicy: d.numberingPolicy, numberSeriesType: d.numberSeriesType, externalReferencePolicy: d.externalReferencePolicy, allowedExternalReferenceTypesJson: j(d.allowedExternalReferenceTypes),
    leaseosTemplateAvailable: d.leaseosTemplateAvailable, customTemplateAllowed: d.customTemplateAllowed, importAllowed: d.importAllowed,
    requiredFieldsJson: j(d.requiredFields), optionalFieldsJson: j(d.optionalFields), allowedLinkKindsJson: j(d.allowedLinkKinds),
    signaturePolicy: d.signaturePolicy, revisionPolicy: d.revisionPolicy, printPolicy: d.printPolicy, extractionProfileKey: d.extractionProfileKey,
    readCategory: d.readCategory, sensitivityTier: d.sensitivityTier, jurisdictionsJson: j(d.jurisdictions), jurisdictionPolicy: d.jurisdictionPolicy, regulatoryBasis: d.regulatoryBasis,
    representationPolicy: d.representationPolicy, representationNotice: d.representationNotice, industriesJson: j(d.industries), packKey: d.packKey, sourcePackageKey: d.sourcePackageKey,
    source: d.source, createdByUserId: extra.createdByUserId, activatedAt: new Date(),
  };
}

export type CatalogSeedReport = {
  importBatchRef: string;
  templates: TemplateSeedReport;
  definitions: { created: string[]; updated: string[]; unchanged: number; aliased: Record<string, string>; refused: string[] };
  categories: { created: string[]; unchanged: number };
  artifacts: { registered: number; unchanged: number; verified: number; missingOnDisk: string[]; refused: string[] };
};

/** Load the catalog files from the repository. Exposed so tests can read the same inputs the seeder does. */
export function loadCatalog(root = CATALOG_ROOT): { entries: PackageDefinitionEntry[]; manifest: ManifestRow[] } {
  const seed = JSON.parse(readFileSync(join(root, CATALOG_SEED_FILE), "utf8")) as { definitions: PackageDefinitionEntry[] };
  const manifest = parseCsv(readFileSync(join(root, CATALOG_MANIFEST_FILE), "utf8")) as ManifestRow[];
  return { entries: seed.definitions, manifest };
}

/** The definitions the seeder will assert: the system rows, then the catalog's, translated. Refusals are returned, never thrown, so one bad entry does not hide the rest. */
export function planDefinitions(entries: PackageDefinitionEntry[]): { definitions: DocumentDefinitionSeed[]; aliased: Record<string, string>; refused: string[] } {
  const out: DocumentDefinitionSeed[] = [...SYSTEM_DEFINITIONS];
  const aliased: Record<string, string> = {};
  const refused: string[] = [];
  const seen = new Set(out.map(d => d.definitionKey));
  for (const e of entries) {
    const alias = PACKAGE_DEFINITION_ALIASES[e.document_definition_key];
    if (alias) { aliased[e.document_definition_key] = alias; continue; }
    const resolved = resolvePackageKey(e.document_definition_key);
    if (seen.has(resolved)) { refused.push(`${e.document_definition_key}: duplicate key in catalog (resolves to ${resolved})`); continue; }
    let d: DocumentDefinitionSeed | null;
    try { d = definitionFromPackageEntry(e); } catch (err) { refused.push(String((err as Error).message)); continue; }
    if (!d) continue;
    const problems = definitionRefusals(d);
    if (problems.length) { refused.push(...problems); continue; }
    seen.add(d.definitionKey);
    out.push(d);
  }
  for (const d of SYSTEM_DEFINITIONS) { const p = definitionRefusals(d); if (p.length) refused.push(...p); }
  return { definitions: out, aliased, refused };
}

/** Which definition and variant each manifest artifact belongs to, by hash, from the seed's variant lists. */
export function artifactFamilies(entries: PackageDefinitionEntry[], root = CATALOG_ROOT): Map<string, { definitionKey: string; sourcePackageKey: string; variantNo: number; repositoryPath: string }> {
  const out = new Map<string, { definitionKey: string; sourcePackageKey: string; variantNo: number; repositoryPath: string }>();
  for (const e of entries) {
    for (const v of e.variants) {
      for (const f of v.files) {
        const full = join(root, f);
        if (!existsSync(full)) continue;
        const hash = sha256Hex(readFileSync(full));
        out.set(hash, { definitionKey: resolvePackageKey(e.document_definition_key), sourcePackageKey: e.document_definition_key, variantNo: v.variant, repositoryPath: `${root}/${f}` });
      }
    }
  }
  return out;
}

const REFERENCE_ROOT = `${CATALOG_ROOT}/reference`;
/** Reference artifacts live under data/document-control/reference/<source path>; the drop-in TypeScript is kept as .txt so nothing compiles it. */
function referencePathFor(m: ManifestRow): string {
  const p = `${REFERENCE_ROOT}/${m.source_path}`;
  return m.extension === "ts" ? `${p}.txt` : p;
}

export async function seedDocumentCatalog(db: Db, args: { importedByUserId: number | null; root?: string }): Promise<CatalogSeedReport> {
  const root = args.root ?? CATALOG_ROOT;
  const { entries, manifest } = loadCatalog(root);
  const importBatchRef = newBatchRef();
  const plan = planDefinitions(entries);
  const report: CatalogSeedReport = {
    importBatchRef,
    definitions: { created: [], updated: [], unchanged: 0, aliased: plan.aliased, refused: plan.refused },
    categories: { created: [], unchanged: 0 },
    artifacts: { registered: 0, unchanged: 0, verified: 0, missingOnDisk: [], refused: [] },
    templates: { families: { created: [], unchanged: 0, skipped: [] }, revisions: { released: [], unchanged: 0 }, artifactsLinked: 0, renderableNow: [] },
  };

  // Definitions: platform scope only. Tenant overlays are never touched by a seed.
  const existing = (await db.select().from(documentDefinitions).where(eq(documentDefinitions.scopeKey, PLATFORM_SCOPE))) as unknown as DocumentDefinitionRow[];
  const byKey = new Map(existing.map(r => [`${r.definitionKey}@${r.definitionVersion}`, r]));
  for (const d of plan.definitions) {
    const row = byKey.get(`${d.definitionKey}@1`);
    if (!row) {
      await db.insert(documentDefinitions).values(toInsert(d, { orgRef: null, definitionRef: platformRef(d.definitionKey), createdByUserId: args.importedByUserId }));
      report.definitions.created.push(d.definitionKey);
      continue;
    }
    const stored = rowToDefinition(row);
    if (definitionPolicyDigest(stored) === definitionPolicyDigest(d)) { report.definitions.unchanged++; continue; }
    const upd = toInsert(d, { orgRef: null, definitionRef: row.definitionRef, createdByUserId: row.orgRef ? null : args.importedByUserId });
    const { definitionRef: _r, scopeKey: _s, definitionKey: _k, definitionVersion: _v, status: _st, createdByUserId: _c, activatedAt: _a, ...policy } = upd;
    await db.update(documentDefinitions).set(policy).where(eq(documentDefinitions.id, row.id));
    report.definitions.updated.push(d.definitionKey);
  }

  // Category rows, so the 0144 register accepts every definition key as a document type.
  const cats = await db.select({ categoryKey: commercialCategoryTypes.categoryKey }).from(commercialCategoryTypes).where(and(eq(commercialCategoryTypes.kind, "document_type"), isNull(commercialCategoryTypes.bookOrgRef)));
  const have = new Set(cats.map(c => c.categoryKey));
  for (const d of plan.definitions) {
    if (have.has(d.definitionKey)) { report.categories.unchanged++; continue; }
    await db.insert(commercialCategoryTypes).values({ bookOrgRef: null, kind: "document_type", categoryKey: d.definitionKey, label: d.displayName, builtIn: true, source: `document_definition ${platformRef(d.definitionKey)}`, createdByUserId: args.importedByUserId });
    report.categories.created.push(d.definitionKey);
    have.add(d.definitionKey);
  }

  // Artifacts, by hash. Bytes on disk are verified against the manifest before a row says so.
  const families = artifactFamilies(entries, root);
  const known = new Set((await db.select({ sha256: documentSourceArtifacts.sha256 }).from(documentSourceArtifacts)).map(r => r.sha256));
  for (const m of manifest) {
    if (!/^[a-f0-9]{64}$/.test(m.sha256)) { report.artifacts.refused.push(`${m.source_path}: manifest hash is not a SHA-256`); continue; }
    const fam = families.get(m.sha256);
    const repositoryPath = fam?.repositoryPath ?? referencePathFor(m);
    let verified = false;
    if (existsSync(repositoryPath)) {
      const actual = sha256Hex(readFileSync(repositoryPath));
      if (actual !== m.sha256) { report.artifacts.refused.push(`${m.source_path}: bytes at ${repositoryPath} hash to ${actual.slice(0, 12)}…, manifest says ${m.sha256.slice(0, 12)}…`); continue; }
      verified = true;
    } else {
      report.artifacts.missingOnDisk.push(m.source_path);
    }
    if (known.has(m.sha256)) {
      report.artifacts.unchanged++;
      if (verified) { await db.update(documentSourceArtifacts).set({ hashVerifiedAt: new Date(), repositoryPath }).where(and(eq(documentSourceArtifacts.sha256, m.sha256), isNull(documentSourceArtifacts.hashVerifiedAt))); report.artifacts.verified++; }
      continue;
    }
    const row: InsertDocumentSourceArtifact = {
      artifactRef: `ART-${m.sha256.slice(0, 16).toUpperCase()}`, sha256: m.sha256, sourceCollection: m.source_archive_dir, sourcePath: m.source_path, fileName: m.file_name, extension: m.extension,
      byteLength: Number(m.size_bytes) || 0, role: m.role as InsertDocumentSourceArtifact["role"], titleCandidate: m.title_candidate || null, templateCodeDetected: m.template_code_or_doc_ref || null,
      revisionDetected: m.revision_detected || null, pages: m.pages ? Number(m.pages) : null, definitionKey: fam?.definitionKey ?? null, sourcePackageKey: fam?.sourcePackageKey ?? null,
      variantNo: fam?.variantNo ?? null, repositoryPath: existsSync(repositoryPath) ? repositoryPath : null, hashVerifiedAt: verified ? new Date() : null, importBatchRef, importedByUserId: args.importedByUserId,
    };
    await db.insert(documentSourceArtifacts).values(row);
    report.artifacts.registered++;
    if (verified) report.artifacts.verified++;
    known.add(m.sha256);
  }
  report.templates = await seedStandardTemplates(db, { importedByUserId: args.importedByUserId, entries });
  return report;
}

/** True when the platform registry already holds every system definition — the cheap check callers make before they insist on a seed. */
export async function systemDefinitionsPresent(db: Db): Promise<boolean> {
  const rows = await db.select({ definitionKey: documentDefinitions.definitionKey }).from(documentDefinitions).where(and(eq(documentDefinitions.scopeKey, PLATFORM_SCOPE), sql`${documentDefinitions.status} = 'active'`));
  const have = new Set(rows.map(r => r.definitionKey));
  return SYSTEM_DEFINITIONS.every(d => have.has(d.definitionKey));
}

/* ===================== DC-D (0181) — the supplied families as standard templates ===================== */

import { documentTemplateArtifacts, documentTemplateRevisions, documentTemplates } from "../../drizzle/schema";
import { EMPTY_MAPPING, MARKDOWN_RENDER_SOURCES, mappingHash, releaseManifestHash, rendererFor, templateKeyForPackage, type LayoutKind } from "./documentTemplates";

export type TemplateSeedReport = { families: { created: string[]; unchanged: number; skipped: string[] }; revisions: { released: string[]; unchanged: number }; artifactsLinked: number; renderableNow: string[] };

/**
 * One standard family per supplied package family, revision 1 released, every
 * artifact of the family attached with its role. Idempotent: a family or
 * revision that exists is left exactly as it is — a released revision could
 * not be changed even if the seeder wanted to. Layout: a markdown render
 * source where the package has one (renderable by the present renderer),
 * else the printable PDF under `pdf_overlay` (registered, not renderable
 * until D-DC-05).
 */
export async function seedStandardTemplates(db: Db, args: { importedByUserId: number | null; entries: PackageDefinitionEntry[] }): Promise<TemplateSeedReport> {
  const report: TemplateSeedReport = { families: { created: [], unchanged: 0, skipped: [] }, revisions: { released: [], unchanged: 0 }, artifactsLinked: 0, renderableNow: [] };
  const artifacts = await db.select().from(documentSourceArtifacts);
  const mdByStem = new Map<string, (typeof artifacts)[number]>();
  for (const a of artifacts) if (a.role === "render_template_source" && a.extension === "md") mdByStem.set(a.fileName.replace(/\.md$/, ""), a);
  const existingFamilies = await db.select().from(documentTemplates).where(eq(documentTemplates.scopeKey, PLATFORM_SCOPE));
  const byKey = new Map(existingFamilies.map(f => [f.templateKey, f]));
  for (const e of args.entries) {
    const templateKey = templateKeyForPackage(e.document_definition_key);
    const definitionKey = resolvePackageKey(e.document_definition_key);
    const family = artifacts.filter(a => a.sourcePackageKey === e.document_definition_key);
    if (!family.length) { report.families.skipped.push(`${templateKey}: no registered artifacts`); continue; }
    let fam = byKey.get(templateKey);
    if (!fam) {
      const templateRef = `TPL-P-${templateKey}`.slice(0, 40);
      await db.insert(documentTemplates).values({ templateRef, orgRef: null, scopeKey: PLATFORM_SCOPE, templateKey, definitionKey, sourceKind: "leaseos_standard", ownerKind: "leaseos", name: e.display_name, sourcePackageKey: e.document_definition_key, createdByUserId: args.importedByUserId });
      fam = (await db.select().from(documentTemplates).where(eq(documentTemplates.templateRef, templateRef)).limit(1))[0]!;
      report.families.created.push(templateKey);
    } else report.families.unchanged++;
    const rev1 = (await db.select().from(documentTemplateRevisions).where(and(eq(documentTemplateRevisions.templateId, fam.id), eq(documentTemplateRevisions.revision, 1))).limit(1))[0];
    if (rev1) { report.revisions.unchanged++; continue; }
    // Layout: the markdown render source when the package supplies one, else the first printable PDF (variant 1).
    const mdStem = Object.entries(MARKDOWN_RENDER_SOURCES).find(([, defKey]) => defKey === definitionKey)?.[0];
    const md = mdStem ? mdByStem.get(mdStem) ?? null : null;
    const printables = family.filter(a => a.role === "printable_template").sort((a, b) => (a.variantNo ?? 0) - (b.variantNo ?? 0));
    const editable = family.find(a => a.role === "editable_template_source") ?? null;
    const layoutKind: LayoutKind = md ? "markdown_text" : "pdf_overlay";
    const layoutArtifact = md ?? printables[0] ?? null;
    if (!layoutArtifact) { report.families.skipped.push(`${templateKey}: no layout artifact`); continue; }
    const renderer = rendererFor(layoutKind);
    const fieldMappingHash = mappingHash(EMPTY_MAPPING);
    const manifest = releaseManifestHash({ layoutContentHash: layoutArtifact.sha256, fieldMappingHash, rendererKey: renderer.rendererKey, rendererVersion: renderer.rendererVersion, editableSourceHash: editable?.sha256 ?? null });
    const revisionRef = `TPLR-P-${templateKey}-r1`.slice(0, 40);
    const ins = await db.insert(documentTemplateRevisions).values({ revisionRef, templateId: fam.id, revision: 1, status: "released", layoutKind, layoutArtifactId: layoutArtifact.id, layoutStorageKey: null, layoutContentHash: layoutArtifact.sha256, fieldMappingJson: JSON.stringify(EMPTY_MAPPING), fieldMappingHash, rendererKey: renderer.rendererKey, rendererVersion: renderer.rendererVersion, releaseManifestHash: manifest, notes: `seeded from ${CATALOG_ROOT} (${e.document_definition_key}); fields unmapped until Checkpoint E`, createdByUserId: args.importedByUserId, releasedByUserId: args.importedByUserId, releasedAt: new Date() });
    const revisionId = Number(ins[0]?.insertId ?? 0);
    const roles: { artifactId: number; role: "printable" | "printable_alternate" | "editable_source" | "render_source" | "reference" }[] = [];
    printables.forEach((p, i) => roles.push({ artifactId: p.id, role: i === 0 ? "printable" : "printable_alternate" }));
    if (editable) roles.push({ artifactId: editable.id, role: "editable_source" });
    if (md) roles.push({ artifactId: md.id, role: "render_source" });
    for (const r of roles) { await db.insert(documentTemplateArtifacts).values({ revisionId, artifactId: r.artifactId, role: r.role }); report.artifactsLinked++; }
    report.revisions.released.push(revisionRef);
    if (renderer.renderable) report.renderableNow.push(templateKey);
  }
  return report;
}
