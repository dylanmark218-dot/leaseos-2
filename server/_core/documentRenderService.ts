/**
 * Document Control — preparing and rendering a document from a template (DC-E).
 *
 * `prepare` is the dry run and the AI Secretary's future primitive: for a
 * released revision and the records the document is about, it resolves every
 * auto-fillable mapped field from LeaseOS Records with its provenance, names
 * the fields only a person may supply, says which of those are still
 * missing, and says whether LeaseOS can render this layout at all.
 *
 * `renderFromTemplate` does the same and then, for a layout the present
 * renderer executes (markdown text through `renderPdf`), fills it — a
 * missing value is a visible blank, never an invention — renders the PDF,
 * stores it, and registers it through the one write path with its template
 * revision, render manifest and, where the definition mints, a number that
 * was reserved before rendering so the paper carries it and issued in the
 * same transaction as the row. A layout the renderer cannot execute is
 * refused with the reason, not rendered badly.
 */
import { and, eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { evidenceRecords, documentSourceArtifacts, documentTemplateArtifacts, documentTemplateRevisions, documentTemplates } from "../../drizzle/schema";
import { MINTING_POLICIES, type OriginKind } from "./documentDefinitions";
import { type Actor, type Book, definitionFor, DocumentControlRefusal, registerControlledDocument, type LinkInput, type RegisterResult, templateRevisionForRender } from "./documentRegisterService";
import { fillMarkdown, markdownToLines, renderManifestHash, RENDERERS, type FieldMapping } from "./documentTemplates";
import { ensureSeriesRow, reserveNumber, voidNumber } from "./numberSeries";
import { authorityOf, semanticField } from "./semanticFields";
import { resolveSemanticContext, type SemanticContext } from "./semanticResolver";
import { renderPdf, sha256Hex } from "./ticketPdf";

type Db = MySql2Database<Record<string, unknown>>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ORIGIN_FOR_SOURCE: Record<string, OriginKind> = { leaseos_standard: "leaseos_generated", organization_custom: "organization_template", customer_supplied: "customer_template", external_form: "external_form_rendered" };

export type PreparedField = { printedField: string; semanticKey: string | null; authority: "auto_fill" | "human_only" | "server_only"; value: string | number | null; source: string | null; required: boolean; state: "filled" | "human_supplied" | "server_at_issue" | "missing" };
export type Preparation = { templateRef: string; templateRevisionRef: string; definitionKey: string; layoutKind: string; rendererKey: string; renderable: boolean; rendererNote: string; originKind: OriginKind; fields: PreparedField[]; missingRequired: string[]; notFound: string[]; wouldMint: boolean; /** The records the document is about, after the load supplied its job, operator and unit. */ context: SemanticContext };

export async function prepareFromTemplate(db: Db, args: { book: Book; templateRevisionRef: string; context: SemanticContext; humanValues?: Record<string, string | number | null> }): Promise<Preparation> {
  const rev = (await db.select().from(documentTemplateRevisions).where(eq(documentTemplateRevisions.revisionRef, args.templateRevisionRef)).limit(1))[0];
  if (!rev) throw new DocumentControlRefusal("NOT_FOUND", `Template revision ${args.templateRevisionRef} does not exist`);
  const tpl = (await db.select().from(documentTemplates).where(eq(documentTemplates.id, rev.templateId)).limit(1))[0];
  if (!tpl || (tpl.orgRef !== null && tpl.orgRef !== args.book.bookOrgRef)) throw new DocumentControlRefusal("NOT_FOUND", `Template revision ${args.templateRevisionRef} is not in this business's library`);
  await templateRevisionForRender(db, args.book, tpl.definitionKey, args.templateRevisionRef);
  const definition = await definitionFor(db, args.book, tpl.definitionKey);
  const mapping = JSON.parse(rev.fieldMappingJson) as FieldMapping;
  const resolved = await resolveSemanticContext(db, args.book, args.context);
  const human = args.humanValues ?? {};
  const fields: PreparedField[] = mapping.fields.map(fld => {
    const authority = authorityOf(fld.semanticKey);
    let value: string | number | null = null; let source: string | null = null; let state: PreparedField["state"] = "missing";
    if (authority === "auto_fill" && fld.semanticKey) {
      const p = resolved.provenance[fld.semanticKey];
      if (p && p.value !== null) { value = p.value; source = `${p.source}#${p.recordId}`; state = "filled"; }
    } else if (authority === "server_only") {
      state = "server_at_issue";
    }
    // A person's value stands for a human-only field, and only there: it never overrides a record's value or a server-set one.
    if (authority === "human_only") {
      const v = human[fld.printedField] ?? (fld.semanticKey ? human[fld.semanticKey] : undefined);
      if (v !== undefined && v !== null && v !== "") { value = v; source = "human"; state = "human_supplied"; }
    }
    return { printedField: fld.printedField, semanticKey: fld.semanticKey, authority, value, source, required: !!fld.required, state };
  });
  const renderer = RENDERERS[rev.rendererKey];
  return {
    templateRef: tpl.templateRef, templateRevisionRef: rev.revisionRef, definitionKey: tpl.definitionKey, layoutKind: rev.layoutKind, rendererKey: rev.rendererKey, renderable: renderer?.present ?? false, rendererNote: renderer?.note ?? "unknown renderer",
    originKind: ORIGIN_FOR_SOURCE[tpl.sourceKind]!, fields, missingRequired: fields.filter(x => x.required && x.state === "missing").map(x => x.printedField), notFound: resolved.notFound,
    wouldMint: MINTING_POLICIES.includes(definition.numberingPolicy) && !!definition.numberSeriesType, context: resolved.context,
  };
}

export type StorageRead = (relKey: string) => Promise<Buffer>;

/** The layout text of a markdown revision: the repository's seed artifact, or a business's uploaded layout read back from the evidence store — either way hash-checked against what the revision released. */
async function layoutTextOf(db: Db, rev: { id: number; layoutArtifactId: number | null; layoutStorageKey: string | null; layoutContentHash: string }, storageRead: StorageRead | undefined): Promise<string> {
  const { id: revisionId, layoutArtifactId } = rev;
  if (layoutArtifactId == null && rev.layoutStorageKey?.startsWith("evidence:")) {
    // DC-G: a company's own markdown layout, uploaded as evidence when the template was created.
    if (!storageRead) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — this revision's layout is in the evidence store and no reader was given");
    const ev = (await db.select({ storageKey: evidenceRecords.storageKey }).from(evidenceRecords).where(eq(evidenceRecords.id, Number(rev.layoutStorageKey.slice("evidence:".length)))).limit(1))[0];
    if (!ev?.storageKey) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — the layout's evidence record has no stored bytes");
    const bytes = await storageRead(ev.storageKey);
    if (sha256Hex(bytes) !== rev.layoutContentHash) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — the stored layout does not hash to what the revision released (${rev.layoutContentHash.slice(0, 12)}…); refusing to render from bytes that are not the layout`);
    return bytes.toString("utf8");
  }
  if (layoutArtifactId == null) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — this revision has no layout artifact LeaseOS can read");
  const art = (await db.select().from(documentSourceArtifacts).where(eq(documentSourceArtifacts.id, layoutArtifactId)).limit(1))[0];
  if (!art?.repositoryPath) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — the layout's bytes are not in the repository's seed data");
  const bytes = readFileSync(art.repositoryPath);
  if (sha256Hex(bytes) !== art.sha256) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — the layout on disk does not hash to its registered SHA-256 (${art.sha256.slice(0, 12)}…); refusing to render from bytes that are not the artifact`);
  void revisionId; void documentTemplateArtifacts;
  return bytes.toString("utf8");
}

export type RenderResult = RegisterResult & { contentHash: string; byteLength: number; storageKey: string; unfilled: string[]; preparation: Preparation };

export async function renderFromTemplate(db: Db, args: { book: Book; actor: Actor; templateRevisionRef: string; context: SemanticContext; humanValues?: Record<string, string | number | null>; title?: string; links?: LinkInput[]; requestedState?: "issued" | "proposed"; storagePut: (relKey: string, data: Buffer, contentType: string) => Promise<{ key: string }>; storageRead?: StorageRead }): Promise<RenderResult> {
  const prep = await prepareFromTemplate(db, { book: args.book, templateRevisionRef: args.templateRevisionRef, context: args.context, humanValues: args.humanValues });
  if (!prep.renderable) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — LeaseOS cannot render a ${prep.layoutKind} layout: ${prep.rendererNote}. The template is registered and printable as supplied; a document on it is registered from the filled copy.`);
  if (prep.notFound.length) throw new DocumentControlRefusal("NOT_FOUND", `BLOCKED — ${prep.notFound.join(", ")} not in this business's records`);
  if (prep.missingRequired.length && (args.requestedState ?? "issued") === "issued") throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — required fields have no value: ${prep.missingRequired.join(", ")}; supply them or render as proposed`);
  const rev = (await db.select().from(documentTemplateRevisions).where(eq(documentTemplateRevisions.revisionRef, args.templateRevisionRef)).limit(1))[0]!;
  const tpl = (await db.select().from(documentTemplates).where(eq(documentTemplates.id, rev.templateId)).limit(1))[0]!;
  const definition = await definitionFor(db, args.book, tpl.definitionKey);
  const requestedState = args.requestedState ?? "issued";
  const now = new Date();
  // The number, where the definition mints: reserved before rendering so the paper carries it, issued in the register's transaction, voided if rendering fails.
  let reserved: { allocationRef: string; number: string } | null = null;
  if (requestedState === "issued" && prep.wouldMint) {
    await ensureSeriesRow(db, { orgRef: args.book.bookOrgRef, sequenceType: definition.numberSeriesType! }, now);
    const r = await reserveNumber(db, { orgRef: args.book.bookOrgRef, sequenceType: definition.numberSeriesType! }, { actor: { userId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null }, at: now });
    reserved = { allocationRef: r.allocationRef, number: r.number };
  }
  try {
    const values: Record<string, string | number | null> = {};
    for (const f of prep.fields) {
      if (f.state === "filled" || f.state === "human_supplied") values[f.printedField] = f.value;
      else if (f.semanticKey === "document.controlNumber") values[f.printedField] = reserved?.number ?? null;
      else if (f.semanticKey === "document.issuedAt") values[f.printedField] = now.toISOString();
      else if (f.semanticKey === "document.title") values[f.printedField] = args.title ?? definition.displayName;
      else if (f.semanticKey === "document.templateRevisionRef") values[f.printedField] = rev.revisionRef;
    }
    const layout = await layoutTextOf(db, rev, args.storageRead);
    const filled = fillMarkdown(layout, values);
    const lines = markdownToLines(filled.text);
    const title = args.title ?? definition.displayName;
    const notice = definition.representationNotice ? [`NOTICE: ${definition.representationNotice}`, ""] : [];
    const bytes = renderPdf(`${title}${reserved ? ` — ${reserved.number}` : ""}`, [...notice, ...lines, "", `Rendered by LeaseOS from ${tpl.templateRef} revision ${rev.revision} (${rev.revisionRef}).`]);
    const contentHash = sha256Hex(bytes);
    const sourceSnapshotHash = sha(JSON.stringify({ values, revision: rev.revisionRef, title }));
    const stored = await args.storagePut(`documents/${args.book.bookOrgRef ?? "default"}/${tpl.templateKey}/${contentHash.slice(0, 16)}.pdf`, bytes, "application/pdf");
    const links: LinkInput[] = [...(args.links ?? [])];
    const add = (recordType: string, id: number | null | undefined) => { if (id != null && !links.some(l => l.recordType === recordType)) links.push({ recordType, recordRef: String(id), recordId: id, role: "subject", source: "domain" }); };
    // Linked to what it was filled from: the load's operator and unit are the document's, whether or not the caller named them.
    const c = prep.context;
    add("job", c.jobId); add("load", c.loadId); add("operator", c.operatorId); add("unit", c.unitId); add("facility", c.facilityId); add("customer_account", c.customerAccountId);
    const reg = await registerControlledDocument(db, {
      book: args.book, actor: args.actor, definitionKey: definition.definitionKey, title, originKind: prep.originKind, issuer: { issuerKind: "tenant", issuerOrgRef: args.book.bookOrgRef },
      contentHash, sourceSnapshotHash, byteLength: bytes.length, mimeType: "application/pdf", storageKey: stored.key, templateRevisionRef: rev.revisionRef,
      renderManifestHash: renderManifestHash({ releaseManifestHash: rev.releaseManifestHash ?? "", sourceSnapshotHash }), controlNumber: reserved?.number ?? null, reservedAllocationRef: reserved?.allocationRef ?? null,
      requestedState, importChannel: "system", links: links.filter(l => definition.allowedLinkKinds.includes(l.recordType as never)), occurredAt: now,
    });
    return { ...reg, contentHash, byteLength: bytes.length, storageKey: stored.key, unfilled: filled.unfilled, preparation: prep };
  } catch (e) {
    if (reserved) await voidNumber(db, { scopeKey: args.book.bookOrgRef ?? "default", allocationRef: reserved.allocationRef, reasonCode: "record_insert_failed", reasonText: `render failed: ${String((e as Error).message).slice(0, 200)}`, actor: { userId: args.actor.userId } }).catch(() => undefined);
    throw e;
  }
}
