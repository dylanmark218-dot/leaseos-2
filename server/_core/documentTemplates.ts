/**
 * Document Control — templates and their revisions (DC-D, 0181).
 *
 * A template is one way of producing a document under a definition. It is
 * never the record. A family has a source (LeaseOS standard, the business's
 * own, a customer's, an external form LeaseOS may fill without owning) and
 * revisions; a revision is what a document is rendered from and carries a
 * layout hash, a field-mapping hash, the renderer and its version, and one
 * release manifest over all of them. Once released, a revision is immutable
 * — the database refuses the change (0181 trigger) — and a changed mapping
 * is a new revision, because a mapping change alters what a rendering means.
 *
 * Renderers are named honestly. `leaseos_text_v1` is `renderPdf` in
 * `ticketPdf.ts`, text lines into PDF 1.4; it can render a markdown-text
 * layout with placeholders. `pdf_overlay` (filling an uploaded PDF) needs a
 * library the tree does not have (design D-DC-05): a revision that names it
 * is registered, printable as its source artifact, and not renderable by
 * LeaseOS until that decision lands. Nothing here pretends otherwise.
 */
import { createHash } from "node:crypto";
import { PACKAGE_KEY_RENAMES, resolvePackageKey } from "./documentDefinitions";

export const TEMPLATE_SOURCE_KINDS = ["leaseos_standard", "organization_custom", "customer_supplied", "external_form"] as const;
export type TemplateSourceKind = (typeof TEMPLATE_SOURCE_KINDS)[number];
export const TEMPLATE_OWNER_KINDS = ["leaseos", "tenant", "customer", "regulator", "facility", "other_third_party"] as const;
export type TemplateOwnerKind = (typeof TEMPLATE_OWNER_KINDS)[number];
export const REVISION_STATUSES = ["draft", "released", "retired"] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];
export const LAYOUT_KINDS = ["leaseos_layout", "markdown_text", "pdf_overlay", "docx_source", "html_layout"] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];
export const TEMPLATE_ARTIFACT_ROLES = ["printable", "printable_alternate", "editable_source", "render_source", "reference"] as const;
export type TemplateArtifactRole = (typeof TEMPLATE_ARTIFACT_ROLES)[number];

/** The renderers LeaseOS actually has. A layout kind whose renderer is absent is registered, not rendered. */
export const RENDERERS: Readonly<Record<string, { version: string; present: boolean; layoutKinds: readonly LayoutKind[]; note: string }>> = {
  leaseos_text_v1: { version: "1", present: true, layoutKinds: ["leaseos_layout", "markdown_text"], note: "server/_core/ticketPdf.ts renderPdf — text lines into PDF 1.4, base-14 fonts, ASCII" },
  pdf_overlay: { version: "0", present: false, layoutKinds: ["pdf_overlay", "docx_source"], note: "filling an uploaded PDF or DOCX needs a PDF library (design D-DC-05); until then the source artifact is printable as supplied" },
  html_layout: { version: "0", present: false, layoutKinds: ["html_layout"], note: "no HTML renderer in the tree" },
};

export function rendererFor(layoutKind: LayoutKind): { rendererKey: string; rendererVersion: string; renderable: boolean } {
  const entry = Object.entries(RENDERERS).find(([, r]) => r.layoutKinds.includes(layoutKind));
  if (!entry) return { rendererKey: "none", rendererVersion: "0", renderable: false };
  return { rendererKey: entry[0], rendererVersion: entry[1].version, renderable: entry[1].present };
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A field mapping: printed field → semantic field key (Checkpoint E fills the registry; the shape is fixed here). */
export type FieldMapping = { version: 1; fields: { printedField: string; semanticKey: string | null; transform?: string | null; required?: boolean }[] };
export const EMPTY_MAPPING: FieldMapping = { version: 1, fields: [] };

export function canonicalMapping(m: FieldMapping): string {
  const fields = [...m.fields].map(f => ({ printedField: f.printedField, semanticKey: f.semanticKey ?? null, transform: f.transform ?? null, required: !!f.required })).sort((a, b) => a.printedField.localeCompare(b.printedField));
  return JSON.stringify({ version: m.version, fields });
}
export function mappingHash(m: FieldMapping): string { return sha256(canonicalMapping(m)); }

/** The one hash a document cites to prove what it was rendered from. */
export function releaseManifestHash(r: { layoutContentHash: string; fieldMappingHash: string; rendererKey: string; rendererVersion: string; editableSourceHash?: string | null }): string {
  return sha256(JSON.stringify({ layoutContentHash: r.layoutContentHash, fieldMappingHash: r.fieldMappingHash, rendererKey: r.rendererKey, rendererVersion: r.rendererVersion, editableSourceHash: r.editableSourceHash ?? null }));
}

/** What a rendered document records beside its revision, so revision 3 is reconstructable after revision 4. */
export function renderManifestHash(r: { releaseManifestHash: string; sourceSnapshotHash: string | null }): string {
  return sha256(JSON.stringify({ releaseManifestHash: r.releaseManifestHash, sourceSnapshotHash: r.sourceSnapshotHash ?? null }));
}

/**
 * The supplied package's markdown render sources, by file stem, and the
 * definition each one renders. These four families therefore have a layout
 * the present renderer can execute; the other forty-two are PDF/DOCX and are
 * registered as printable sources under `pdf_overlay`.
 */
export const MARKDOWN_RENDER_SOURCES: Readonly<Record<string, string>> = {
  dot_fmcsa_registration_authority: "dot_fmcsa_registration_authority",
  environmental_spill_report: "environmental_spill_reporting_form",
  norm_survey_handling: "norm_survey_and_handling_record",
  oilfield_waste_tracking_generator: "oilfield_waste_tracking_form",
};

/** The placeholders a markdown-text layout asks for, in order of first appearance, deduplicated. */
export function placeholdersOf(markdown: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Fill a markdown-text layout: every placeholder present in `values` is replaced; a missing one is left as a visible blank, never invented. */
export function fillMarkdown(markdown: string, values: Record<string, string | number | null | undefined>): { text: string; unfilled: string[] } {
  const unfilled: string[] = [];
  const text = markdown.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined || v === null || v === "") { if (!unfilled.includes(key)) unfilled.push(key); return "________"; }
    return String(v);
  });
  return { text, unfilled };
}

/** Markdown-text to the lines `renderPdf` takes: headings become upper-case lines, list markers stay, bold markers drop, runs of blank lines collapse. */
export function markdownToLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s/.test(raw);
    const line = raw.replace(/^#{1,6}\s*/, "").replace(/\*\*(.*?)\*\*/g, "$1");
    const l = heading ? line.toUpperCase() : line;
    if (l === "" && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out;
}

/** The family key a seeded standard template carries: the package key, so the two PDF variants of one form share one family. */
export function templateKeyForPackage(packageKey: string): string { return packageKey; }
export function definitionKeyForPackage(packageKey: string): string { return resolvePackageKey(packageKey); }
export const RENAMED_PACKAGE_KEYS = PACKAGE_KEY_RENAMES;

export type CustomTemplateInput = { mimeType: string; byteLength: number; fileName: string };
// DC-G: a markdown-text layout is the one kind of company template the present renderer executes (`leaseos_text_v1`); a PDF or DOCX is registered and printable as supplied.
const ACCEPTED_CUSTOM_MIME = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown"]);
export const MAX_CUSTOM_TEMPLATE_BYTES = 15 * 1024 * 1024;

/** An uploaded company or customer form is untrusted input: a PDF or a DOCX, under the evidence size cap, with a plain file name. It is stored, hashed and registered; it is never executed and never trusted to describe itself. */
export function customTemplateRefusals(i: CustomTemplateInput): string[] {
  const out: string[] = [];
  if (!ACCEPTED_CUSTOM_MIME.has(i.mimeType)) out.push(`a template is a PDF, a DOCX or a markdown-text layout; ${i.mimeType} is not accepted`);
  if (i.byteLength <= 0 || i.byteLength > MAX_CUSTOM_TEMPLATE_BYTES) out.push(`a template is between 1 byte and ${MAX_CUSTOM_TEMPLATE_BYTES} bytes`);
  if (!/^[A-Za-z0-9._ -]{1,220}$/.test(i.fileName)) out.push("the file name carries only letters, digits, dot, dash, underscore and space");
  return out;
}
export function layoutKindForMime(mimeType: string): LayoutKind { return mimeType === "application/pdf" ? "pdf_overlay" : mimeType === "text/markdown" ? "markdown_text" : "docx_source"; }
