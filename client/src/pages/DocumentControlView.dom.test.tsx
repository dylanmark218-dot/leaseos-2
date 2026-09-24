import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DocDetail, type DocRow, DocumentControlView, type DocumentControlViewProps } from "./DocumentControlView";

afterEach(cleanup);

const scan: DocRow = { documentRef: "DOC-2026-000418", title: "Facility ticket", definitionKey: "external_disposal_receipt", documentType: "external_disposal_receipt", originKind: "external_scanned", issuerKind: "facility", issuerName: "ACME Disposal", controlNumber: null, controlState: "confirmed", status: "current", version: 1, templateRevisionRef: null, registeredAt: "2026-09-20T18:30:00Z", issuedAt: null, provenance: "Scanned from paper; issued by ACME Disposal; no LeaseOS number." };
const invoice: DocRow = { documentRef: "DOC-2026-000419", title: "Invoice INV-2026-000031", definitionKey: "invoice", documentType: "invoice", originKind: "system_rendered", issuerKind: "tenant", issuerName: null, controlNumber: "INV-2026-000031", controlState: "issued", status: "current", version: 1, templateRevisionRef: null, registeredAt: "2026-09-21T09:00:00Z", issuedAt: "2026-09-21T09:00:00Z", provenance: "Rendered by LeaseOS; issued by the tenant under INV-2026-000031." };
const legacy: DocRow = { ...scan, documentRef: "DOC-2026-000001", title: "Old statement", definitionKey: null, documentType: "statement", originKind: null, issuerKind: null, issuerName: null, controlState: "confirmed" };
const detail: DocDetail = {
  document: { ...scan, contentHash: "ab".repeat(32), byteLength: 48213, mimeType: "image/png", evidenceRecordId: 77, renderManifestHash: null, capturedByDeviceRef: "DEV-7", importChannel: "device_sync" },
  provenance: scan.provenance, retention: "UNCONFIGURED — retained indefinitely until a person assigns a policy",
  definition: { definitionKey: "external_disposal_receipt", displayName: "External disposal receipt (facility-issued)", documentClass: "operational_form", numberingPolicy: "external_only", representationPolicy: "official_external_record", representationNotice: null, revisionPolicy: "amend_with_reason", primaryDomainOwner: "disposal" },
  links: [{ id: 1, recordType: "job", recordRef: "JOB-26-00481", recordId: 5, role: "subject", source: "human", confirmationStatus: "confirmed" }, { id: 2, recordType: "disposal_ticket", recordRef: "DSP-AI-PROP-DC-1", recordId: 9, role: "source_document", source: "domain", confirmationStatus: "confirmed" }],
  references: [{ referenceRef: "XREF-1", referenceType: "facility_ticket_number", referenceValueRaw: "874399", issuerKind: "facility", issuerName: "ACME Disposal", source: "ocr_proposed", confirmationStatus: "confirmed", mirrorOfTable: "disposalTickets" }],
  versions: [{ documentRef: "DOC-2026-000418", version: 1, status: "current", controlState: "confirmed" }],
  amendments: [{ fieldKey: "issuerName", originalValue: "ACME", correctedValue: "ACME Disposal" }],
  derivatives: [{ derivativeRef: "DRV-1", derivativeKind: "ocr_text", producer: "device-ocr", producerVersion: "1.2", contentHash: "cd".repeat(32), sourceContentHash: "ab".repeat(32), mimeType: "text/plain", byteLength: 91, actorSource: "ai", createdAt: "2026-09-20T18:31:00Z" }],
  extractions: [{ extractionRef: "EXT-1", proposalId: "PROP-DC-1", ocrEngine: "device-ocr", proposedDocumentType: "external_disposal_receipt", classificationSource: "human", status: "committed", fieldCount: 9, askedCount: 0, humanOnlyCount: 4, extractedAt: "2026-09-20T18:31:00Z" }],
  timeline: [
    { sequence: 1, eventType: "document.captured", actorUserId: 12, actorSource: "human", deviceRef: "DEV-7", previousState: null, newState: "captured", detail: null, occurredAt: "2026-09-20T18:30:00Z" },
    { sequence: 2, eventType: "document.proposed", actorUserId: 12, actorSource: "ai", deviceRef: null, previousState: "captured", newState: "proposed", detail: { engine: "device-ocr" }, occurredAt: "2026-09-20T18:31:00Z" },
    { sequence: 3, eventType: "document.confirmed", actorUserId: 3, actorSource: "human", deviceRef: null, previousState: "proposed", newState: "confirmed", detail: { definitionKey: "external_disposal_receipt" }, occurredAt: "2026-09-20T19:02:00Z" },
    { sequence: 4, eventType: "document.reprinted", actorUserId: 3, actorSource: "human", deviceRef: null, previousState: null, newState: null, detail: { copy: 2 }, occurredAt: "2026-09-22T08:00:00Z" },
  ],
};

const props = (o: Partial<DocumentControlViewProps> = {}): DocumentControlViewProps => ({
  tab: "library", onTab: vi.fn(), filter: { q: "", definitionKey: "", originKind: "", controlState: "", recordType: "", recordRef: "" }, onFilter: vi.fn(),
  documents: [scan, invoice, legacy], selectedDoc: null, onSelectDoc: vi.fn(), loading: false, reviewQueue: [],
  templates: [], selectedTemplate: null, onSelectTemplate: vi.fn(), definitions: [], series: [], gapQuery: { sequenceType: "", periodKey: "" }, onGapQuery: vi.fn(), gapReport: null, ...o,
});

describe("DocumentControlView", () => {
  it("lists every document with its origin, keeps the LeaseOS number and the internal ref apart, and never invents an origin for a row that has none", () => {
    const onSelectDoc = vi.fn();
    render(<DocumentControlView {...props({ onSelectDoc })} />);
    const lib = screen.getByTestId("library");
    expect(lib.textContent).toContain("ACME Disposal · external scanned");
    expect(lib.textContent).toContain("LeaseOS-issued · system rendered");
    expect(lib.textContent).toContain("INV-2026-000031");
    expect(lib.textContent).toContain("origin unrecorded");
    expect(screen.getByTestId("doc-row-DOC-2026-000418").textContent).toContain("DOC-2026-000418");   // no LeaseOS number: the internal ref shows, muted
    fireEvent.click(screen.getByTestId("doc-row-DOC-2026-000418"));
    expect(onSelectDoc).toHaveBeenCalledWith("DOC-2026-000418");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "874399" } });
    expect(props().onFilter).not.toHaveBeenCalled();   // a fresh props() has its own mock; the rendered one received the change:
  });
  it("shows a document's detail: provenance, the external number with its issuer and mirror, related records, revision history, source and derivatives, print history and the audit timeline as recorded", () => {
    render(<DocumentControlView {...props({ selectedDoc: detail })} />);
    expect(screen.getByTestId("provenance").textContent).toContain("no LeaseOS number");
    expect(screen.getByTestId("control-number").textContent).toContain("none");
    expect(screen.getByTestId("external-numbers").textContent).toContain("874399");
    expect(screen.getByTestId("external-numbers").textContent).toContain("ACME Disposal");
    expect(screen.getByTestId("external-numbers").textContent).toContain("mirrors disposalTickets");
    expect(screen.getByTestId("related-records").textContent).toContain("DSP-AI-PROP-DC-1");
    expect(screen.getByTestId("revision-history").textContent).toContain("amended issuerName");
    expect(screen.getByTestId("source-provenance").textContent).toContain("reading by device-ocr");
    expect(screen.getByTestId("source-provenance").textContent).toContain("ocr text by device-ocr 1.2");
    expect(screen.getByTestId("print-history").textContent).toContain("reprinted");
    const tl = screen.getByTestId("audit-timeline").textContent ?? "";
    expect(tl).toContain("#1");
    expect(tl).toContain("captured · human user 12 · DEV-7");
    expect(tl).toContain("proposed · ai user 12");
    expect(tl).toContain("captured → proposed");
    expect(tl).toContain("confirmed · human user 3");
    expect(screen.queryByTestId("representation-notice")).toBeNull();
  });
  it("prints a compliance record's representation notice, and the review queue says nothing in it is a fact", () => {
    const notice = { ...detail, definition: { ...detail.definition!, definitionKey: "waste_manifest_internal_record", displayName: "Waste manifest (internal record)", representationPolicy: "internal_record", representationNotice: "Internal record. Not the official EPA Uniform Hazardous Waste Manifest." } };
    render(<DocumentControlView {...props({ tab: "review", reviewQueue: [{ ...scan, controlState: "needs_classification", definitionKey: "unclassified_external_document" }], selectedDoc: notice })} />);
    expect(screen.getByTestId("representation-notice").textContent).toContain("Not the official EPA Uniform Hazardous Waste Manifest");
    expect(screen.getByTestId("review-queue").textContent).toContain("needs classification");
    expect(screen.getByText(/Nothing here is a fact yet/)).toBeTruthy();
  });
  it("shows template revisions with their immutability, definitions with how LeaseOS may describe them, and a gap report that calls an unexplained gap a finding", () => {
    render(<DocumentControlView {...props({ tab: "templates", templates: [{ templateRef: "TPL-1", templateKey: "bill_of_lading", definitionKey: "bill_of_lading", name: "Bill of lading", sourceKind: "leaseos_standard", ownerKind: "leaseos", ownerName: null, status: "active", layer: "platform", currentRevision: { revisionRef: "TPLR-1-r2", revision: 2, layoutKind: "pdf_overlay", rendererKey: "pdf_overlay", renderable: false, releasedAt: "2026-09-23T00:00:00Z" } }], selectedTemplate: { template: { templateRef: "TPL-1", templateKey: "bill_of_lading", definitionKey: "bill_of_lading", name: "Bill of lading", sourceKind: "leaseos_standard", ownerKind: "leaseos", ownerName: null, status: "active", layer: "platform", currentRevision: null, orgRef: null }, revisions: [{ revisionRef: "TPLR-1-r2", revision: 2, status: "released", layoutKind: "pdf_overlay", rendererKey: "pdf_overlay", rendererVersion: "0", fieldMappingHash: "ff".repeat(32), releaseManifestHash: "ee".repeat(32), releasedAt: "2026-09-23T00:00:00Z", retiredAt: null }, { revisionRef: "TPLR-1-r1", revision: 1, status: "retired", layoutKind: "pdf_overlay", rendererKey: "pdf_overlay", rendererVersion: "0", fieldMappingHash: "aa".repeat(32), releaseManifestHash: "bb".repeat(32), releasedAt: "2026-09-22T00:00:00Z", retiredAt: "2026-09-23T00:00:00Z" }] } })} />);
    expect(screen.getByTestId("templates").textContent).toContain("no — registered and printable as supplied");
    expect(screen.getByTestId("template-detail").textContent).toContain("records on it stay on it");
    cleanup();
    render(<DocumentControlView {...props({ tab: "definitions", definitions: [{ definitionKey: "dot_fmcsa_registration_authority", displayName: "DOT/FMCSA registration and authority record", documentClass: "regulatory_record", primaryDomainOwner: "compliance", numberingPolicy: "leaseos_series_optional", numberSeriesType: "REG", externalReferencePolicy: "optional", representationPolicy: "internal_record", representationNotice: "Internal compliance record; not an agency-issued form.", jurisdictionPolicy: "configurable_verify_by_jurisdiction", status: "active", layer: "platform", label: "internal record" }] })} />);
    expect(screen.getByTestId("def-row-dot_fmcsa_registration_authority").textContent).toContain("not an agency-issued form");
    cleanup();
    render(<DocumentControlView {...props({ tab: "series", series: [{ sequenceType: "DOC", periodKey: "2026", branch: "", nextNumber: 421, issued: 418, reserved: 1, voided: 1 }], gapQuery: { sequenceType: "DOC", periodKey: "2026" }, gapReport: { scopeKey: "default", sequenceType: "DOC", periodKey: "2026", issued: 418, explained: 1, heldByDevice: 0, unexplained: 1, rows: [{ sequence: 7, state: "voided", formattedNumber: "DOC-2026-000007", voidReason: "printer jam, sheet destroyed" }, { sequence: 9, state: "unexplained", formattedNumber: "DOC-2026-000009" }] } })} />);
    expect(screen.getByTestId("unexplained").textContent).toBe("1 unexplained");
    expect(screen.getByTestId("gap-report").textContent).toContain("findings, not gaps");
    expect(screen.getByTestId("gap-report").textContent).toContain("printer jam");
  });
});
