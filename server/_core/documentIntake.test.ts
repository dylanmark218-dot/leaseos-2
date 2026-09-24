/**
 * Document Control, Checkpoint F — what a capture accepts and what a reading proposes, without a database.
 */
import { describe, expect, it } from "vitest";
import { FORMS } from "./aiProposal";
import { documentControlForms } from "./documentControlForms";
import { classifyDocument, extractToProposal } from "./documentExtraction";
import { CAPTURE_MAX_BYTES, CAPTURE_MIME_TYPES, captureRefusals, DEFINITION_FOR_DOCUMENT_TYPE, OCR_DOCUMENT_TYPES, OCR_REFERENCE_FIELDS } from "./documentIntakeService";
import { EXTERNAL_REFERENCE_TYPES, SYSTEM_DEFINITIONS } from "./documentDefinitions";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = new TextEncoder().encode("%PDF-1.4\n");

describe("what a capture accepts", () => {
  it("takes images and PDFs as scans, office files as imports, and refuses bytes that do not open as their declared type", () => {
    expect(captureRefusals({ byteLength: 10, mimeType: "image/png", head: png, originKind: "external_scanned" })).toEqual([]);
    expect(captureRefusals({ byteLength: 10, mimeType: "application/pdf", head: pdf, originKind: "external_scanned" })).toEqual([]);
    expect(captureRefusals({ byteLength: 10, mimeType: "application/pdf", head: png, originKind: "external_digital_import" })).toEqual([expect.stringMatching(/do not open as one/)]);
    expect(captureRefusals({ byteLength: 10, mimeType: "application/zip", head: png, originKind: "external_scanned" })).toEqual([expect.stringMatching(/not a kind of bytes/)]);
    expect(captureRefusals({ byteLength: 0, mimeType: "image/png", head: new Uint8Array(), originKind: "external_scanned" })).toEqual(expect.arrayContaining([expect.stringMatching(/no bytes/)]));
    expect(captureRefusals({ byteLength: CAPTURE_MAX_BYTES + 1, mimeType: "image/png", head: png, originKind: "external_scanned" })).toEqual([expect.stringMatching(/15 MB/)]);
    expect(captureRefusals({ byteLength: 10, mimeType: "image/png", head: png, originKind: "leaseos_generated" })).toEqual([expect.stringMatching(/rendered, not captured/)]);
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(captureRefusals({ byteLength: 10, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", head: docx, originKind: "external_scanned" })).toEqual([expect.stringMatching(/external_digital_import/)]);
    expect(captureRefusals({ byteLength: 10, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", head: docx, originKind: "external_digital_import" })).toEqual([]);
    for (const [mime, k] of Object.entries(CAPTURE_MIME_TYPES)) expect(k.ext, mime).toMatch(/^[a-z0-9]{2,5}$/);
  });
});

describe("what a reading proposes", () => {
  it("maps a machine's document type to a definition the register has, and OCR number fields to reference types the register has", () => {
    const keys = new Set(SYSTEM_DEFINITIONS.map(d => d.definitionKey));
    for (const [t, k] of Object.entries(DEFINITION_FOR_DOCUMENT_TYPE)) { expect(keys.has(k), `${t} → ${k}`).toBe(true); expect(OCR_DOCUMENT_TYPES).toContain(t); }
    expect(DEFINITION_FOR_DOCUMENT_TYPE.disposal_ticket).toBe("external_disposal_receipt");   // a scan of the facility's ticket is the facility's paper, never LeaseOS's record
    expect(DEFINITION_FOR_DOCUMENT_TYPE.load_ticket).toBeUndefined();
    for (const [f, t] of Object.entries(OCR_REFERENCE_FIELDS)) expect(EXTERNAL_REFERENCE_TYPES, f).toContain(t);
  });

  it("a named form takes the reading even where the classifier would not, and every field it proposes is proposed — none confirmed, the sensitive ones asked of a person", () => {
    const ocr = { engine: "t", rawText: "NORM survey background 0.2 max 1.4 uSv/h", fields: [{ key: "backgroundReading", confidence: 99, value: 0.2 }, { key: "jurisdiction", confidence: 99, value: "AB" }] };
    const classification = classifyDocument({ ocr });
    expect(classification.documentType).toBe("unknown");
    const forms = { ...FORMS, ...Object.fromEntries(Object.entries(documentControlForms()).map(([k, c]) => [k, c.form])) };
    const none = extractToProposal({ ocr, classification, forms });
    expect(none.refusal).toMatch(/No form accepts/);
    const norm = extractToProposal({ ocr, classification, forms, formKey: "norm_survey_handling" });
    expect(norm.refusal).toBeUndefined();
    expect(norm.formKey).toBe("norm_survey_handling");
    expect(norm.fields.length).toBeGreaterThan(5);
    expect(norm.fields.every(f => f.status === "proposed" && f.source === "photo_ocr")).toBe(true);
    const reading = norm.fields.find(f => f.key === "backgroundReading")!;
    expect(reading.value).toBe(0.2);
    expect(norm.questions.some(q => q.fieldKey === "backgroundReading" && q.reason === "sensitive_human_only")).toBe(true);
    expect(norm.counts.autoFiled).toBe(0);
  });
});
