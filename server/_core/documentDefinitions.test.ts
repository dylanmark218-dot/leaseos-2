/**
 * Document Control, Checkpoint A — the definition registry's rules, without a database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { documentDefinitions } from "../../drizzle/schema";
import { loadCatalog, parseCsv, planDefinitions } from "./documentCatalogSeed";
import {
  applyOverlay, DEFINITION_STATUSES, definitionFromPackageEntry, definitionPolicyDigest, definitionRefusals, DOCUMENT_CLASSES, DOCUMENT_LINK_KINDS, EVIDENCE_ENTITY_TO_LINK_KIND,
  EXTERNAL_REFERENCE_POLICIES, EXTERNAL_ORIGINS, JURISDICTION_POLICIES, NUMBERING_POLICIES, PACKAGE_DEFINITION_ALIASES, PRINT_POLICIES, REGULATORY_BASES, RENDERED_ORIGINS,
  representationLabel, REPRESENTATION_POLICIES, resolvePackageKey, REVISION_POLICIES, rowToDefinition, SENSITIVITY_TIERS, seriesTypeFromTemplateCode, SIGNATURE_POLICIES, SYSTEM_DEFINITIONS,
  type DocumentDefinitionRow, type DocumentDefinitionSeed,
} from "./documentDefinitions";
import { evidenceRelationships } from "../../drizzle/schema";

const enumValues = (col: string): string[] => ((getTableColumns(documentDefinitions) as Record<string, { enumValues?: string[] }>)[col]!.enumValues ?? []);

describe("boundaries the catalog keeps (DC-H)", () => {
  it("HOS remains domain-owned: no platform definition and none of the package's is an hours-of-service record, and no definition's owner is the HOS domain", () => {
    const pkg = JSON.parse(readFileSync("data/document-control/document_definitions.seed.json", "utf8")) as { definitions: { document_definition_key?: string; definitionKey?: string }[] };
    const packageKeys = pkg.definitions.map(d => d.document_definition_key ?? d.definitionKey ?? "").filter(Boolean);
    expect(packageKeys.length).toBeGreaterThan(30);
    for (const k of [...SYSTEM_DEFINITIONS.map(d => d.definitionKey), ...packageKeys]) expect(k, k).not.toMatch(/\bhos\b|hours_of_service|daily_log|logbook|\beld\b/);
    for (const d of SYSTEM_DEFINITIONS) expect(d.primaryDomainOwner, d.definitionKey).not.toBe("hos");
  });
});

describe("the vocabularies in code are the enums in the schema", () => {
  it("mirrors every enum column", () => {
    expect(enumValues("status")).toEqual([...DEFINITION_STATUSES]);
    expect(enumValues("documentClass")).toEqual([...DOCUMENT_CLASSES]);
    expect(enumValues("numberingPolicy")).toEqual([...NUMBERING_POLICIES]);
    expect(enumValues("externalReferencePolicy")).toEqual([...EXTERNAL_REFERENCE_POLICIES]);
    expect(enumValues("signaturePolicy")).toEqual([...SIGNATURE_POLICIES]);
    expect(enumValues("revisionPolicy")).toEqual([...REVISION_POLICIES]);
    expect(enumValues("printPolicy")).toEqual([...PRINT_POLICIES]);
    expect(enumValues("sensitivityTier")).toEqual([...SENSITIVITY_TIERS]);
    expect(enumValues("jurisdictionPolicy")).toEqual([...JURISDICTION_POLICIES]);
    expect(enumValues("regulatoryBasis")).toEqual([...REGULATORY_BASES]);
    expect(enumValues("representationPolicy")).toEqual([...REPRESENTATION_POLICIES]);
  });

  it("maps every evidenceRelationships entity type onto the one link vocabulary", () => {
    const evidenceKinds = (getTableColumns(evidenceRelationships) as Record<string, { enumValues?: string[] }>).entityType!.enumValues!;
    for (const k of evidenceKinds) {
      expect(EVIDENCE_ENTITY_TO_LINK_KIND[k], `${k} is not mapped`).toBeDefined();
      expect(DOCUMENT_LINK_KINDS).toContain(EVIDENCE_ENTITY_TO_LINK_KIND[k]);
    }
  });
});

describe("system definitions", () => {
  it("are all valid, unique, and include the unclassified home and the externally issued kinds", () => {
    const keys = SYSTEM_DEFINITIONS.map(d => d.definitionKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of SYSTEM_DEFINITIONS) expect(definitionRefusals(d), d.definitionKey).toEqual([]);
    expect(keys).toContain("unclassified_external_document");
    expect(keys).toContain("external_disposal_receipt");
    expect(keys).toContain("scale_ticket");
    // The ten 0144 kinds are all there.
    for (const k of ["invoice", "credit_note", "statement", "manifest", "field_ticket", "disposal_ticket", "vendor_bill", "purchase_order", "remittance", "audit_package"]) expect(keys).toContain(k);
  });

  it("never mints a LeaseOS number for an externally issued document, and never renders one", () => {
    const external = SYSTEM_DEFINITIONS.filter(d => d.numberingPolicy === "external_only");
    expect(external.map(d => d.definitionKey).sort()).toEqual(["external_disposal_receipt", "scale_ticket", "vendor_bill"]);
    // A receipt has an external issuer but no number of its own to require: archival, never minted.
    for (const k of ["fuel_receipt", "expense_receipt"]) expect(SYSTEM_DEFINITIONS.find(d => d.definitionKey === k)).toMatchObject({ numberingPolicy: "archival_only", numberSeriesType: null });
    for (const d of external) {
      expect(d.externalReferencePolicy).toBe("required");
      expect(d.numberSeriesType).toBeNull();
      expect(d.allowedOrigins.every(o => EXTERNAL_ORIGINS.includes(o))).toBe(true);
      expect(d.allowedOrigins.some(o => RENDERED_ORIGINS.includes(o))).toBe(false);
    }
  });

  it("lets a domain-managed kind name its domain's series, and leaves the archival kinds with none", () => {
    expect(SYSTEM_DEFINITIONS.find(d => d.definitionKey === "field_ticket")).toMatchObject({ numberingPolicy: "domain_managed", numberSeriesType: "FT", primaryDomainOwner: "closeout" });
    expect(SYSTEM_DEFINITIONS.find(d => d.definitionKey === "disposal_ticket")).toMatchObject({ numberingPolicy: "domain_managed", numberSeriesType: "DSP", primaryDomainOwner: "disposal" });
    expect(SYSTEM_DEFINITIONS.find(d => d.definitionKey === "unclassified_external_document")).toMatchObject({ numberingPolicy: "archival_only", numberSeriesType: null, documentClass: "unclassified", importAllowed: true });
  });

  it("agrees with the rows migration 0178 inserts — the SQL is generated from this constant, and the two may not drift", () => {
    const sql = readFileSync("drizzle/0178_document_control_definitions.sql", "utf8");
    const inserted = Array.from(sql.matchAll(/\('DEF-P-([a-z0-9_]+)-v1','platform','([a-z0-9_]+)'/g)).map(m => m[2]!);
    expect(inserted.sort()).toEqual(SYSTEM_DEFINITIONS.map(d => d.definitionKey).sort());
    for (const d of SYSTEM_DEFINITIONS) {
      expect(sql).toContain(`'${d.numberingPolicy}'`);
      expect(sql).toContain(`'${d.definitionKey}'`);
    }
  });
});

describe("the supplied catalog, translated", () => {
  const { entries, manifest } = loadCatalog();

  it("holds 46 families and 81 source artifacts with well-formed hashes", () => {
    expect(entries.length).toBe(46);
    expect(manifest.length).toBe(81);
    for (const m of manifest) expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(manifest.map(m => m.sha256)).size).toBe(81);
  });

  it("derives 43 new definitions and attaches three to kinds the register already had", () => {
    const plan = planDefinitions(entries);
    expect(plan.refused).toEqual([]);
    expect(plan.aliased).toEqual(PACKAGE_DEFINITION_ALIASES);
    expect(Object.keys(plan.aliased).sort()).toEqual(["commercial_invoice", "disposal_ticket_waste_disposal_receipt", "freight_and_oilfield_manifest"]);
    expect(plan.definitions.length).toBe(SYSTEM_DEFINITIONS.length + 43);
    expect(new Set(plan.definitions.map(d => d.definitionKey)).size).toBe(plan.definitions.length);
    expect(resolvePackageKey("commercial_invoice")).toBe("invoice");
    expect(resolvePackageKey("job_safety_analysis")).toBe("job_safety_analysis");
  });

  it("makes one definition of a PDF/DOCX pair, and one of two PDF variants", () => {
    const bol = entries.find(e => e.document_definition_key === "bill_of_lading")!;
    expect(bol.variants[0]!.files.length).toBe(2);
    expect(bol.variants[0]!.files.some(f => f.endsWith(".pdf")) && bol.variants[0]!.files.some(f => f.endsWith(".docx"))).toBe(true);
    const dot = entries.find(e => e.document_definition_key === "dot_fmcsa_registration_and_authority_record")!;
    expect(dot.variants.length).toBe(2);
    const plan = planDefinitions(entries);
    expect(plan.definitions.filter(d => d.definitionKey === "bill_of_lading").length).toBe(1);
    expect(plan.definitions.filter(d => d.definitionKey === "dot_fmcsa_registration_authority").length).toBe(1);
    // Keys longer than the register's 40-character limit are shortened; the package key stays on the row.
    for (const d of plan.definitions) expect(d.definitionKey.length, d.definitionKey).toBeLessThanOrEqual(40);
    expect(plan.definitions.find(d => d.definitionKey === "waste_manifest_internal_record")!.sourcePackageKey).toBe("waste_manifest_hazardous_waste_manifest_internal_record");
  });

  it("makes every template optional: each family may arrive as a scan or an upload with no template at all", () => {
    for (const e of entries) {
      expect(e.template_required_for_document_control, e.document_definition_key).toBe(false);
      const d = definitionFromPackageEntry(e);
      if (!d) continue;
      expect(d.importAllowed).toBe(true);
      expect(d.allowedOrigins).toContain("external_scanned");
      expect(d.allowedOrigins).toContain("external_digital_import");
    }
  });

  it("turns 'review required' into the archival ref only, and a controlled-sequence candidate into a series the tenant may enable", () => {
    const d = (k: string) => definitionFromPackageEntry(entries.find(e => e.document_definition_key === k)!)!;
    expect(d("boc_3_process_agent_record").numberingPolicy).toBe("archival_only");
    expect(d("boc_3_process_agent_record").numberSeriesType).toBeNull();
    expect(d("job_safety_analysis")).toMatchObject({ numberingPolicy: "leaseos_series_optional", numberSeriesType: "JSA" });
    expect(d("bill_of_lading")).toMatchObject({ numberingPolicy: "leaseos_series_optional", numberSeriesType: "BOL", externalReferencePolicy: "optional" });
    // "FOR" is the word FORM mis-read as a code; it never becomes a series.
    expect(seriesTypeFromTemplateCode("FOR")).toBeNull();
    expect(seriesTypeFromTemplateCode("FRM-COM-RNT-001")).toBeNull();
    expect(seriesTypeFromTemplateCode("bol")).toBe("BOL");
    expect(d("oilfield_waste_tracking_generator_compliance_form")).toMatchObject({ definitionKey: "oilfield_waste_tracking_form", numberSeriesType: null });
  });

  it("represents internal compliance records as internal, never as an agency form", () => {
    const plan = planDefinitions(entries);
    for (const d of plan.definitions.filter(x => x.packKey === "us")) {
      expect(d.representationPolicy).toBe("internal_record");
      expect(d.representationNotice).toMatch(/Not an official FMCSA, DOT or other agency form/);
      expect(d.jurisdictions).toEqual(["US"]);
      expect(representationLabel(d)).toContain("Not an official");
    }
    expect(plan.definitions.filter(x => x.packKey === "us").map(x => x.definitionKey).sort()).toEqual(["boc_3_process_agent_record", "carrier_credential_and_permit_checklist", "carrier_insurance_evidence_record", "dot_fmcsa_registration_authority", "dot_roadside_inspection_record"]);
  });

  it("makes the internal waste-manifest record carry the official manifest rather than replace it", () => {
    const wm = definitionFromPackageEntry(entries.find(e => e.document_definition_key === "waste_manifest_hazardous_waste_manifest_internal_record")!)!;
    expect(wm.representationPolicy).toBe("attach_official_record_required");
    expect(wm.representationNotice).toMatch(/Not the official EPA Uniform Hazardous Waste Manifest/);
    expect(wm.documentClass).toBe("regulated_record");
    expect(wm.printPolicy).toBe("controlled_copy");
    expect(representationLabel(wm)).toContain("Not the official EPA");
  });

  it("keeps NORM and environmental records jurisdiction-configurable with no regulatory basis inferred from a template", () => {
    const plan = planDefinitions(entries);
    for (const d of plan.definitions.filter(x => x.sourcePackageKey?.startsWith("norm_") || x.sourcePackageKey?.startsWith("environmental_") || x.sourcePackageKey?.startsWith("spill_"))) {
      expect(d.jurisdictionPolicy).toBe("configurable_verify_by_jurisdiction");
      expect(d.regulatoryBasis).toBe("not_inferred_from_template");
      expect(d.jurisdictions).toEqual(["*"]);
      expect(d.representationNotice).toMatch(/Jurisdiction-specific requirements are not established by this template/);
    }
  });

  it("hands the three structured compliance seeds an extraction profile and nothing else a made-up one", () => {
    const plan = planDefinitions(entries);
    const withProfile = plan.definitions.filter(d => d.sourcePackageKey && d.extractionProfileKey).map(d => [d.definitionKey, d.extractionProfileKey]);
    expect(withProfile.sort()).toEqual([
      ["environmental_spill_reporting_form", "environmental_spill_report"],
      ["norm_survey_and_handling_record", "norm_survey_handling"],
      ["oilfield_waste_tracking_form", "oilfield_waste_tracking_generator"],
    ]);
  });

  it("refuses a definition that breaks an invariant, naming each problem", () => {
    const base = definitionFromPackageEntry(entries.find(e => e.document_definition_key === "job_safety_analysis")!)!;
    const bad: DocumentDefinitionSeed = { ...base, numberingPolicy: "external_only", externalReferencePolicy: "forbidden", allowedExternalReferenceTypes: [], jurisdictions: ["alberta"] };
    const refusals = definitionRefusals(bad);
    expect(refusals.some(r => /external_only numbering needs a required external reference/.test(r))).toBe(true);
    expect(refusals.some(r => /cannot render a document whose number belongs to an external issuer/.test(r))).toBe(true);
    expect(refusals.some(r => /ISO-3166/.test(r))).toBe(true);
  });
});

describe("rows, overlays and digests", () => {
  const row = (d: DocumentDefinitionSeed, orgRef: string | null): DocumentDefinitionRow => ({
    id: 1, definitionRef: orgRef ? "DEF-T-X" : `DEF-P-${d.definitionKey}-v1`, orgRef, scopeKey: orgRef ?? "platform", definitionKey: d.definitionKey, definitionVersion: 1, status: "active",
    documentClass: d.documentClass, displayName: d.displayName, description: d.description, primaryDomainOwner: d.primaryDomainOwner, allowedOriginsJson: JSON.stringify(d.allowedOrigins),
    numberingPolicy: d.numberingPolicy, numberSeriesType: d.numberSeriesType, externalReferencePolicy: d.externalReferencePolicy, allowedExternalReferenceTypesJson: JSON.stringify(d.allowedExternalReferenceTypes),
    leaseosTemplateAvailable: d.leaseosTemplateAvailable, customTemplateAllowed: d.customTemplateAllowed, importAllowed: d.importAllowed, requiredFieldsJson: JSON.stringify(d.requiredFields), optionalFieldsJson: JSON.stringify(d.optionalFields),
    allowedLinkKindsJson: JSON.stringify(d.allowedLinkKinds), signaturePolicy: d.signaturePolicy, revisionPolicy: d.revisionPolicy, printPolicy: d.printPolicy, extractionProfileKey: d.extractionProfileKey, retentionPolicyId: null, workflowKey: null,
    readCategory: d.readCategory, sensitivityTier: d.sensitivityTier, jurisdictionsJson: JSON.stringify(d.jurisdictions), jurisdictionPolicy: d.jurisdictionPolicy, regulatoryBasis: d.regulatoryBasis,
    representationPolicy: d.representationPolicy, representationNotice: d.representationNotice, industriesJson: JSON.stringify(d.industries), packKey: d.packKey, sourcePackageKey: d.sourcePackageKey, source: d.source,
  });

  it("round-trips a definition through a stored row with an identical policy digest", () => {
    for (const d of SYSTEM_DEFINITIONS) expect(definitionPolicyDigest(rowToDefinition(row(d, null)))).toBe(definitionPolicyDigest(d));
  });

  it("applies only the permitted columns of an overlay; numbering, origins, signature and sensitivity stay the platform's", () => {
    const platform = rowToDefinition(row(SYSTEM_DEFINITIONS.find(d => d.definitionKey === "disposal_ticket")!, null));
    const overlayRow = row({ ...SYSTEM_DEFINITIONS.find(d => d.definitionKey === "disposal_ticket")!, displayName: "Pride disposal ticket", numberingPolicy: "external_only", signaturePolicy: "none", sensitivityTier: "RESTRICTED", allowedOrigins: ["external_scanned"], printPolicy: "controlled_copy", allowedLinkKinds: ["job", "customer_account"], numberSeriesType: "PDT" }, "ORG-A");
    const eff = applyOverlay(platform, overlayRow);
    expect(eff.layer).toBe("tenant");
    expect(eff.displayName).toBe("Pride disposal ticket");
    expect(eff.printPolicy).toBe("controlled_copy");
    expect(eff.numberSeriesType).toBe("PDT");
    expect(eff.allowedLinkKinds).toEqual(expect.arrayContaining([...platform.allowedLinkKinds, "customer_account"]));
    expect(eff.numberingPolicy).toBe(platform.numberingPolicy);
    expect(eff.signaturePolicy).toBe(platform.signaturePolicy);
    expect(eff.sensitivityTier).toBe(platform.sensitivityTier);
    expect(eff.allowedOrigins).toEqual(platform.allowedOrigins);
    expect(applyOverlay(platform, null)).toBe(platform);
  });
});

describe("the manifest parser", () => {
  it("handles quoted fields with commas and doubled quotes", () => {
    const rows = parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n');
    expect(rows).toEqual([{ a: "1", b: "x, y", c: 'he said "hi"' }]);
  });
});
