/**
 * Document Control, Checkpoint D — templates and revisions, without a database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { documentTemplateArtifacts, documentTemplateRevisions, documentTemplates } from "../../drizzle/schema";
import { canonicalMapping, customTemplateRefusals, EMPTY_MAPPING, fillMarkdown, LAYOUT_KINDS, layoutKindForMime, mappingHash, MARKDOWN_RENDER_SOURCES, markdownToLines, placeholdersOf, releaseManifestHash, renderManifestHash, rendererFor, RENDERERS, REVISION_STATUSES, TEMPLATE_ARTIFACT_ROLES, TEMPLATE_OWNER_KINDS, TEMPLATE_SOURCE_KINDS, type FieldMapping } from "./documentTemplates";
import { renderPdf } from "./ticketPdf";
import { loadCatalog } from "./documentCatalogSeed";

const enumValues = (table: object, col: string): string[] => ((getTableColumns(table as never) as Record<string, { enumValues?: string[] }>)[col]!.enumValues ?? []);

describe("vocabularies mirror the schema", () => {
  it("template, revision and artifact enums", () => {
    expect(enumValues(documentTemplates, "sourceKind")).toEqual([...TEMPLATE_SOURCE_KINDS]);
    expect(enumValues(documentTemplates, "ownerKind")).toEqual([...TEMPLATE_OWNER_KINDS]);
    expect(enumValues(documentTemplateRevisions, "status")).toEqual([...REVISION_STATUSES]);
    expect(enumValues(documentTemplateRevisions, "layoutKind")).toEqual([...LAYOUT_KINDS]);
    expect(enumValues(documentTemplateArtifacts, "role")).toEqual([...TEMPLATE_ARTIFACT_ROLES]);
  });
});

describe("renderers are named honestly", () => {
  it("the present renderer takes leaseos and markdown-text layouts; PDF overlay and DOCX are registered, not renderable", () => {
    expect(rendererFor("markdown_text")).toEqual({ rendererKey: "leaseos_text_v1", rendererVersion: "1", renderable: true });
    expect(rendererFor("pdf_overlay")).toMatchObject({ rendererKey: "pdf_overlay", renderable: false });
    expect(rendererFor("docx_source")).toMatchObject({ rendererKey: "pdf_overlay", renderable: false });
    expect(RENDERERS.pdf_overlay!.note).toMatch(/D-DC-05/);
    expect(layoutKindForMime("application/pdf")).toBe("pdf_overlay");
    expect(layoutKindForMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx_source");
  });
});

describe("hashes that prove what a document was rendered from", () => {
  it("a mapping hash ignores field order and defaults; a manifest changes with any input; a render manifest binds the snapshot", () => {
    const a: FieldMapping = { version: 1, fields: [{ printedField: "Driver", semanticKey: "operator.name" }, { printedField: "Unit", semanticKey: "unit.number", required: false }] };
    const b: FieldMapping = { version: 1, fields: [{ printedField: "Unit", semanticKey: "unit.number" }, { printedField: "Driver", semanticKey: "operator.name", transform: null }] };
    expect(canonicalMapping(a)).toBe(canonicalMapping(b));
    expect(mappingHash(a)).toBe(mappingHash(b));
    expect(mappingHash({ version: 1, fields: [{ printedField: "Driver", semanticKey: "operator.id" }] })).not.toBe(mappingHash(a));
    expect(mappingHash(EMPTY_MAPPING)).toMatch(/^[a-f0-9]{64}$/);
    const m1 = releaseManifestHash({ layoutContentHash: "a".repeat(64), fieldMappingHash: mappingHash(a), rendererKey: "leaseos_text_v1", rendererVersion: "1" });
    const m2 = releaseManifestHash({ layoutContentHash: "a".repeat(64), fieldMappingHash: mappingHash(a), rendererKey: "leaseos_text_v1", rendererVersion: "2" });
    expect(m1).not.toBe(m2);
    expect(renderManifestHash({ releaseManifestHash: m1, sourceSnapshotHash: "b".repeat(64) })).not.toBe(renderManifestHash({ releaseManifestHash: m1, sourceSnapshotHash: "c".repeat(64) }));
  });
});

describe("the supplied markdown render sources", () => {
  const { manifest } = loadCatalog();
  const mdRows = manifest.filter(m => m.role === "render_template_source");

  it("are four, each mapped to one definition, with placeholders the present renderer can fill", () => {
    expect(mdRows.length).toBe(4);
    for (const m of mdRows) {
      const stem = m.file_name.replace(/\.md$/, "");
      expect(MARKDOWN_RENDER_SOURCES[stem], stem).toBeDefined();
      const text = readFileSync(`data/document-control/reference/${m.source_path}`, "utf8");
      const keys = placeholdersOf(text);
      expect(keys.length).toBeGreaterThan(10);
      expect(keys[0]).toBe("title");
      const filled = fillMarkdown(text, { title: "NORM Survey", [keys[1]!]: "DOC-2026-000001" });
      expect(filled.text).toContain("DOC-2026-000001");
      expect(filled.unfilled.length).toBe(keys.length - 2);
      expect(filled.text).toContain("________");
      const lines = markdownToLines(filled.text);
      const pdf = renderPdf("NORM Survey", lines);
      expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.4");
    }
  });

  it("never invents a value for a missing placeholder", () => {
    const { text, unfilled } = fillMarkdown("Weight: {{netKg}} kg, by {{operator.name}}", { "operator.name": "R. Singh" });
    expect(text).toBe("Weight: ________ kg, by R. Singh");
    expect(unfilled).toEqual(["netKg"]);
  });
});

describe("an uploaded company or customer form is untrusted input", () => {
  it("accepts a PDF or DOCX under the cap with a plain name and refuses the rest, naming why", () => {
    expect(customTemplateRefusals({ mimeType: "application/pdf", byteLength: 1024, fileName: "PrideVac_DisposalTicket_2026.pdf" })).toEqual([]);
    expect(customTemplateRefusals({ mimeType: "text/html", byteLength: 10, fileName: "x.html" })).toEqual(expect.arrayContaining([expect.stringMatching(/PDF or a DOCX/)]));
    expect(customTemplateRefusals({ mimeType: "application/pdf", byteLength: 16 * 1024 * 1024, fileName: "big.pdf" })).toEqual(expect.arrayContaining([expect.stringMatching(/between 1 byte and/)]));
    expect(customTemplateRefusals({ mimeType: "application/pdf", byteLength: 10, fileName: "../../etc/passwd" })).toEqual(expect.arrayContaining([expect.stringMatching(/file name carries only/)]));
  });
});
