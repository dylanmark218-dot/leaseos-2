/**
 * Document Control, Checkpoint B — the register's rules, without a database.
 */
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { commercialDocumentLinks, commercialDocuments, documentControlEvents, documentExternalReferences } from "../../drizzle/schema";
import { ISSUER_KINDS, ORIGIN_KINDS, rowToDefinition, SYSTEM_DEFINITIONS, type DocumentDefinitionRow, type DocumentDefinitionSeed, type EffectiveDefinition } from "./documentDefinitions";
import { actsFrom, CONFIRMATION_STATUSES, CONTROL_STATES, factsMutable, IMPORT_CHANNELS, issuerScopeKey, LINK_CONFIRMATIONS, LINK_SOURCES, nextControlState, normaliseReferenceValue, ORIGIN_FROM_DISPOSAL_SOURCE, provenanceSentence, REFERENCE_SOURCES, referenceDuplicateVerdict, registerRefusals, type RegisterInput } from "./documentRegister";

const enumValues = (table: object, col: string): string[] => ((getTableColumns(table as never) as Record<string, { enumValues?: string[] }>)[col]!.enumValues ?? []);

const asEffective = (d: DocumentDefinitionSeed): EffectiveDefinition => rowToDefinition({
  id: 1, definitionRef: `DEF-P-${d.definitionKey}-v1`, orgRef: null, scopeKey: "platform", definitionKey: d.definitionKey, definitionVersion: 1, status: "active",
  documentClass: d.documentClass, displayName: d.displayName, description: d.description, primaryDomainOwner: d.primaryDomainOwner, allowedOriginsJson: JSON.stringify(d.allowedOrigins),
  numberingPolicy: d.numberingPolicy, numberSeriesType: d.numberSeriesType, externalReferencePolicy: d.externalReferencePolicy, allowedExternalReferenceTypesJson: JSON.stringify(d.allowedExternalReferenceTypes),
  leaseosTemplateAvailable: d.leaseosTemplateAvailable, customTemplateAllowed: d.customTemplateAllowed, importAllowed: d.importAllowed, requiredFieldsJson: "[]", optionalFieldsJson: "[]", allowedLinkKindsJson: JSON.stringify(d.allowedLinkKinds),
  signaturePolicy: d.signaturePolicy, revisionPolicy: d.revisionPolicy, printPolicy: d.printPolicy, extractionProfileKey: d.extractionProfileKey, retentionPolicyId: null, workflowKey: null,
  readCategory: d.readCategory, sensitivityTier: d.sensitivityTier, jurisdictionsJson: JSON.stringify(d.jurisdictions), jurisdictionPolicy: d.jurisdictionPolicy, regulatoryBasis: d.regulatoryBasis,
  representationPolicy: d.representationPolicy, representationNotice: d.representationNotice, industriesJson: "[]", packKey: d.packKey, sourcePackageKey: d.sourcePackageKey, source: d.source,
} as DocumentDefinitionRow);
const def = (key: string) => asEffective(SYSTEM_DEFINITIONS.find(d => d.definitionKey === key)!);

const base = (over: Partial<RegisterInput>): RegisterInput => ({
  definition: def("external_disposal_receipt"), originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: 7, issuerName: "Facility XYZ" }, templateRevisionRef: null, controlNumber: null,
  requestedState: "captured", externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "874399" }], links: [{ recordType: "load" }], evidenceRecordId: 11, fieldTicketDocumentId: null, storageKey: null, ...over,
});

describe("the vocabularies in code are the enums in the schema", () => {
  it("mirrors the register's new columns", () => {
    expect(enumValues(commercialDocuments, "originKind")).toEqual([...ORIGIN_KINDS]);
    expect(enumValues(commercialDocuments, "issuerKind")).toEqual([...ISSUER_KINDS]);
    expect(enumValues(commercialDocuments, "controlState")).toEqual([...CONTROL_STATES]);
    expect(enumValues(commercialDocuments, "importChannel")).toEqual([...IMPORT_CHANNELS]);
    expect(enumValues(documentExternalReferences, "source")).toEqual([...REFERENCE_SOURCES]);
    expect(enumValues(documentExternalReferences, "confirmationStatus")).toEqual([...CONFIRMATION_STATUSES]);
    expect(enumValues(documentExternalReferences, "issuerKind")).toEqual([...ISSUER_KINDS]);
    expect(enumValues(commercialDocumentLinks, "source")).toEqual([...LINK_SOURCES]);
    expect(enumValues(commercialDocumentLinks, "confirmationStatus")).toEqual([...LINK_CONFIRMATIONS]);
    expect(enumValues(documentControlEvents, "actorSource")).toEqual(["human", "system", "ai", "integration", "external"]);
  });
});

describe("the three rules that never bend", () => {
  it("LeaseOS is never the issuer: a rendered document issued by a facility is refused", () => {
    const r = registerRefusals(base({ definition: def("field_ticket"), originKind: "system_rendered", issuer: { issuerKind: "facility", issuerFacilityId: 7 }, controlNumber: "FT-2026-000001", requestedState: "issued", externalReferences: [], links: [{ recordType: "job" }], evidenceRecordId: null, fieldTicketDocumentId: 3 }));
    expect(r.some(x => /issued by the tenant; LeaseOS never issues/.test(x))).toBe(true);
  });

  it("an externally issued document never carries a LeaseOS-minted number", () => {
    const r = registerRefusals(base({ controlNumber: "DSP-2026-000009" }));
    expect(r.some(x => /carries no LeaseOS control number/.test(x))).toBe(true);
    expect(r.some(x => /can only belong to a document the tenant issued/.test(x))).toBe(true);
    expect(r.some(x => /never carries a LeaseOS control number/.test(x))).toBe(true);
  });

  it("an external document cannot skip confirmation, and a rendered one enters issued", () => {
    expect(registerRefusals(base({ requestedState: "issued" })).some(x => /confirmed, never issued/.test(x))).toBe(true);
    expect(registerRefusals(base({ definition: def("field_ticket"), originKind: "system_rendered", issuer: { issuerKind: "tenant" }, controlNumber: "FT-2026-000001", requestedState: "captured", externalReferences: [], links: [{ recordType: "job" }], evidenceRecordId: null, fieldTicketDocumentId: 3 })).some(x => /enters issued/.test(x))).toBe(true);
    expect(registerRefusals(base({ definition: def("field_ticket"), originKind: "system_rendered", issuer: { issuerKind: "tenant" }, controlNumber: "FT-2026-000001", requestedState: "issued", externalReferences: [], links: [{ recordType: "job" }], evidenceRecordId: null, fieldTicketDocumentId: 3 }))).toEqual([]);
  });

  it("accepts the facility's paper ticket as a scan with its own number and no LeaseOS number", () => {
    expect(registerRefusals(base({}))).toEqual([]);
    expect(registerRefusals(base({ requestedState: "confirmed" }))).toEqual([]);
    // Confirmed without the facility's number: the definition requires it.
    expect(registerRefusals(base({ requestedState: "confirmed", externalReferences: [] })).some(x => /requires the issuer's reference before it is confirmed/.test(x))).toBe(true);
    // Captured without it is fine: the number is proposed or typed later.
    expect(registerRefusals(base({ externalReferences: [] }))).toEqual([]);
  });

  it("refuses an import under a definition that does not accept imports, and a template ref where no template applies", () => {
    expect(registerRefusals(base({ definition: def("invoice"), originKind: "external_digital_import", issuer: { issuerKind: "vendor", issuerName: "ACME" }, externalReferences: [], links: [] })).some(x => /does not accept imported or scanned documents/.test(x))).toBe(true);
    expect(registerRefusals(base({ templateRevisionRef: "TPLR-1" })).some(x => /has no template; a template revision was given/.test(x))).toBe(true);
    expect(registerRefusals(base({ definition: def("field_ticket"), originKind: "organization_template", issuer: { issuerKind: "tenant" }, controlNumber: "FT-1", requestedState: "issued", externalReferences: [], links: [], evidenceRecordId: null, storageKey: "x/y.pdf" })).some(x => /needs the template revision it was rendered from/.test(x))).toBe(true);
  });

  it("keeps an unclassified document in the waiting states and never confirmed as unclassified", () => {
    expect(registerRefusals(base({ definition: def("unclassified_external_document"), externalReferences: [], links: [{ recordType: "job" }] }))).toEqual([]);
    expect(registerRefusals(base({ definition: def("unclassified_external_document"), requestedState: "confirmed", externalReferences: [], links: [] })).some(x => /confirmed only under a definition/.test(x))).toBe(true);
  });

  it("requires the original evidence for an external document, not a bare storage key", () => {
    expect(registerRefusals(base({ evidenceRecordId: null, storageKey: "a/b.pdf" })).some(x => /needs the evidence record, not a bare storage key/.test(x))).toBe(true);
  });
});

describe("issuer scope and reference normalisation", () => {
  it("scopes by facility, then organization, then normalised name, so two facilities may both issue 12345", () => {
    expect(issuerScopeKey({ issuerKind: "facility", issuerFacilityId: 3, issuerName: "x" })).toBe("facility:3");
    expect(issuerScopeKey({ issuerKind: "customer", issuerOrgRef: "ORG-1" })).toBe("org:ORG-1");
    expect(issuerScopeKey({ issuerKind: "vendor", issuerName: "ScaleCo Ltd." })).toBe(issuerScopeKey({ issuerKind: "vendor", issuerName: "SCALECO LIMITED" }));
    expect(issuerScopeKey({ issuerKind: "facility", issuerFacilityId: 3 })).not.toBe(issuerScopeKey({ issuerKind: "facility", issuerFacilityId: 4 }));
    expect(issuerScopeKey({ issuerKind: "unknown" })).toBe("unknown:unknown");
    expect(normaliseReferenceValue("  ab 12  34 ")).toBe("AB 12 34");
  });

  it("judges duplicates within an issuer by bytes: identical is the same document, different needs a person", () => {
    expect(referenceDuplicateVerdict({ sameIssuerSameValue: [], contentHash: "a" })).toEqual({ outcome: "unique", matches: [] });
    expect(referenceDuplicateVerdict({ sameIssuerSameValue: [{ documentId: 5, contentHash: "a" }], contentHash: "a" })).toEqual({ outcome: "exact_duplicate", matches: [5] });
    expect(referenceDuplicateVerdict({ sameIssuerSameValue: [{ documentId: 5, contentHash: "b" }], contentHash: "a" })).toEqual({ outcome: "possible_duplicate", matches: [5] });
  });
});

describe("the lifecycle", () => {
  it("moves only along named transitions", () => {
    expect(nextControlState("captured", "confirm")).toEqual({ ok: true, to: "confirmed" });
    expect(nextControlState("captured", "classify")).toEqual({ ok: true, to: "needs_classification" });
    expect(nextControlState("confirmed", "issue")).toEqual({ ok: true, to: "issued" });
    expect(nextControlState("issued", "void").ok).toBe(false);
    expect(nextControlState("issued", "withdraw")).toEqual({ ok: true, to: "withdrawn" });
    expect(nextControlState("void", "confirm").ok).toBe(false);
    expect(nextControlState("withdrawn", "issue").ok).toBe(false);
    expect(actsFrom("captured").sort()).toEqual(["classify", "confirm", "propose", "void"]);
    expect(actsFrom("issued")).toEqual(["withdraw"]);
    expect(factsMutable("proposed")).toBe(true);
    expect(factsMutable("confirmed")).toBe(false);
  });

  it("translates the disposal domain's source words without migrating them", () => {
    expect(ORIGIN_FROM_DISPOSAL_SOURCE.photo_ocr).toBe("external_scanned");
    expect(ORIGIN_FROM_DISPOSAL_SOURCE.facility_portal).toBe("external_digital_import");
  });

  it("tells a reader where a document came from in one sentence, and says so when nothing was recorded", () => {
    expect(provenanceSentence({ originKind: null, issuerKind: null, issuerName: null, templateRevisionRef: null, controlNumber: null })).toMatch(/Origin unrecorded/);
    expect(provenanceSentence({ originKind: "external_scanned", issuerKind: "facility", issuerName: "Facility XYZ", templateRevisionRef: null, controlNumber: null })).toBe("Scanned from paper; the original scan is held as evidence, issued by Facility XYZ; no LeaseOS number.");
    expect(provenanceSentence({ originKind: "system_rendered", issuerKind: "tenant", issuerName: null, templateRevisionRef: null, controlNumber: "FT-2026-000012" })).toBe("Rendered by LeaseOS from a frozen snapshot, issued by this company; LeaseOS control number FT-2026-000012.");
    expect(provenanceSentence({ originKind: "organization_template", issuerKind: "tenant", issuerName: null, templateRevisionRef: "TPLR-9", controlNumber: null })).toMatch(/from template revision TPLR-9/);
  });
});
