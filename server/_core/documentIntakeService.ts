/**
 * Document Control — scanner and import convergence (DC-F).
 *
 * Three acts, all on the one register:
 *
 *   captureDocument    bytes a device or the office sends — a photo, a PDF, an
 *                      exported file — hashed by the server, stored once as the
 *                      evidence record, registered at `captured` under whatever
 *                      definition is known (usually none). NO TEMPLATE AND NO
 *                      KNOWN FORM EVER PREVENTS THIS.
 *   proposeExtraction  an OCR engine's reading of a captured document, turned
 *                      into a PROPOSAL through the existing extraction engine:
 *                      a `documentExtractions` row, an assistant proposal with
 *                      its fields and questions, the raw text kept as a
 *                      derivative, and any number the reading found as an
 *                      `ocr_proposed` external reference. The register row's
 *                      facts (definition, issuer, state beyond `proposed`) do
 *                      not move. A person confirms through `confirmDocument`.
 *   attachDerivative   bytes derived from the original (OCR text, a page
 *                      image, a thumbnail, a redaction): their own row, their
 *                      own storage key and hash, and the original's hash they
 *                      came from. The original is never touched.
 *
 * LeaseOS runs no OCR engine here. `OcrResult` is engine-neutral and arrives
 * from whatever produced it — a device's on-board recogniser, a server-side
 * engine when one is wired, a person's transcription flagged as such. What
 * this module guarantees is what happens to the reading, not where it came
 * from: it is recorded, attributed, and proposed. Never applied.
 */
import { and, eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { assistantProposals, assistantQuestions, commercialDocumentLinks, commercialDocuments, documentDerivatives, documentExternalReferences, documentExtractions, evidenceRecords, proposalFields } from "../../drizzle/schema";
import { SINGLE_TENANT_ID } from "./actingScope";
import { FORMS, type FormDefinition } from "./aiProposal";
import { documentControlForms, formFor } from "./documentControlForms";
import type { ExternalReferenceType, OriginKind } from "./documentDefinitions";
import { EXTERNAL_ORIGINS } from "./documentDefinitions";
import { classifyDocument, extractToProposal, type DocumentType, type OcrResult } from "./documentExtraction";
import { factsMutable, type ImportChannel, issuerScopeKey, type IssuerInput, nextControlState, normaliseReferenceValue, registerRefusals } from "./documentRegister";
import { type Actor, appendDocumentEvent, type Book, definitionFor, DocumentControlRefusal, documentInBook, type LinkInput, linkTargetInScope, type ReferenceInput, registerControlledDocument } from "./documentRegisterService";
import { sha256Hex } from "./ticketPdf";

type Db = MySql2Database<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type StoragePut = (relKey: string, data: Buffer, contentType: string) => Promise<{ key: string }>;

const mintRef = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const scopeKeyOf = (b: Book) => b.bookOrgRef ?? SINGLE_TENANT_ID;

/* ------------------------------------------------------------------ */
/* What a capture accepts                                               */
/* ------------------------------------------------------------------ */

/** As evidence.upload: nothing over this enters. */
export const CAPTURE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * The kinds of bytes a scan or an import may be, with the signature the bytes
 * must open with. A declared type whose bytes say otherwise is refused — the
 * register records what a thing is, not what a client called it.
 */
export const CAPTURE_MIME_TYPES: Readonly<Record<string, { ext: string; signatures: readonly (readonly number[])[]; imports: boolean }>> = {
  "image/jpeg": { ext: "jpg", signatures: [[0xff, 0xd8, 0xff]], imports: false },
  "image/png": { ext: "png", signatures: [[0x89, 0x50, 0x4e, 0x47]], imports: false },
  "image/webp": { ext: "webp", signatures: [[0x52, 0x49, 0x46, 0x46]], imports: false },
  "image/tiff": { ext: "tif", signatures: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]], imports: false },
  "image/heic": { ext: "heic", signatures: [], imports: false },
  "application/pdf": { ext: "pdf", signatures: [[0x25, 0x50, 0x44, 0x46]], imports: true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx", signatures: [[0x50, 0x4b]], imports: true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: "xlsx", signatures: [[0x50, 0x4b]], imports: true },
  "text/csv": { ext: "csv", signatures: [], imports: true },
  "text/plain": { ext: "txt", signatures: [], imports: true },
};

/** Why bytes cannot be captured, or nothing. Pure, so a device can run it before sending. */
export function captureRefusals(input: { byteLength: number; mimeType: string; head: Uint8Array; originKind: OriginKind }): string[] {
  const out: string[] = [];
  if (input.byteLength === 0) out.push("no bytes were sent");
  if (input.byteLength > CAPTURE_MAX_BYTES) out.push(`a capture is ${CAPTURE_MAX_BYTES / 1024 / 1024} MB or smaller`);
  const kind = CAPTURE_MIME_TYPES[input.mimeType.toLowerCase()];
  if (!kind) { out.push(`${input.mimeType} is not a kind of bytes the register captures (an image, a PDF, or an exported office file)`); return out; }
  if (kind.signatures.length && !kind.signatures.some(sig => sig.every((b, i) => input.head[i] === b))) out.push(`declared ${input.mimeType} but the bytes do not open as one`);
  if (!EXTERNAL_ORIGINS.includes(input.originKind)) out.push(`a capture is an external document; origin ${input.originKind} is rendered, not captured`);
  if (input.originKind === "external_scanned" && kind.imports && input.mimeType !== "application/pdf") out.push(`a scan is an image or a PDF; a ${kind.ext} file is an external_digital_import`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Capture                                                              */
/* ------------------------------------------------------------------ */

export type CaptureArgs = {
  book: Book; actor: Actor; bytes: Buffer; fileName: string; mimeType: string; title: string;
  originKind: OriginKind; importChannel?: ImportChannel; clientCaptureRef?: string | null; capturedAt?: Date | null; latitude?: number | null; longitude?: number | null;
  definitionKey?: string; issuer?: IssuerInput; links?: LinkInput[]; externalReferences?: ReferenceInput[]; requestedState?: "captured" | "needs_classification";
  storagePut: StoragePut;
};
export type CaptureResult = { documentRef: string; documentId: number; evidenceRecordId: number; contentHash: string; byteLength: number; controlState: string; definitionKey: string; alreadyCaptured: boolean; duplicateOfDocumentRef: string | null };

export async function captureDocument(db: Db, args: CaptureArgs): Promise<CaptureResult> {
  const mimeType = args.mimeType.toLowerCase();
  const problems = captureRefusals({ byteLength: args.bytes.byteLength, mimeType, head: args.bytes.subarray(0, 8), originKind: args.originKind });
  if (problems.length) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — ${problems.join("; ")}`);
  const definitionKey = args.definitionKey ?? "unclassified_external_document";
  const definition = await definitionFor(db, args.book, definitionKey);
  const issuer: IssuerInput = args.issuer ?? { issuerKind: "unknown" };
  const requestedState = args.requestedState ?? "captured";
  const links = args.links ?? [];
  const refs = args.externalReferences ?? [];
  // Everything that can be refused is refused before any byte is stored: the register's invariants, then every link's scope.
  const registerProblems = registerRefusals({ definition, originKind: args.originKind, issuer, templateRevisionRef: null, controlNumber: null, requestedState, externalReferences: refs, links, evidenceRecordId: -1, fieldTicketDocumentId: null, storageKey: null });
  if (registerProblems.length) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — ${registerProblems.join("; ")}`);
  for (const l of links) {
    const r = await linkTargetInScope(db, args.book, { recordType: l.recordType, recordId: l.recordId ?? null, recordRef: l.recordRef });
    if (!r.ok) throw new DocumentControlRefusal("NOT_FOUND", `BLOCKED — ${r.reason}`);
  }

  // Hashed here, from the bytes received. A client's hash is never written to the register.
  const contentHash = sha256Hex(args.bytes);
  const scopeKey = scopeKeyOf(args.book);

  // Idempotent by the device's own reference: the same capture sent twice is one document.
  let evidenceRecordId: number | null = null;
  if (args.clientCaptureRef) {
    const existing = (await db.select({ id: evidenceRecords.id }).from(evidenceRecords).where(eq(evidenceRecords.clientCaptureRef, args.clientCaptureRef)).limit(1))[0];
    if (existing) {
      const doc = (await db.select().from(commercialDocuments).where(and(eq(commercialDocuments.evidenceRecordId, existing.id), eq(commercialDocuments.bookScopeKey, scopeKey))).limit(1))[0];
      if (doc) return { documentRef: doc.documentRef, documentId: doc.id, evidenceRecordId: existing.id, contentHash: doc.contentHash, byteLength: doc.byteLength ?? args.bytes.byteLength, controlState: doc.controlState, definitionKey: doc.definitionKey ?? doc.documentType, alreadyCaptured: true, duplicateOfDocumentRef: null };
      // The bytes landed but the register write did not: finish it on the same evidence record rather than storing the bytes again.
      evidenceRecordId = existing.id;
    }
  }
  // The same bytes already in this business's register: still captured (a second copy of one paper from another device is a fact), and said so.
  const sameBytes = (await db.select({ documentRef: commercialDocuments.documentRef }).from(commercialDocuments).where(and(eq(commercialDocuments.bookScopeKey, scopeKey), eq(commercialDocuments.contentHash, contentHash))).limit(1))[0];

  if (evidenceRecordId == null) {
    const ext = CAPTURE_MIME_TYPES[mimeType]!.ext;
    const stored = await args.storagePut(`${scopeKey}/document-control/${contentHash.slice(0, 2)}/${contentHash}.${ext}`, args.bytes, mimeType);
    const jobLink = links.find(l => l.recordType === "job" && l.recordId != null);
    const inserted = await db.insert(evidenceRecords).values({
      jobId: jobLink?.recordId ?? null, title: args.title.slice(0, 220), category: "document_control", storageKey: stored.key, storageUrl: null, mimeType,
      capturedAt: args.capturedAt ?? new Date(), capturedBy: args.actor.userId, latitude: args.latitude ?? null, longitude: args.longitude ?? null,
      status: "needs_review", notes: `Document Control capture: ${args.fileName.slice(0, 160)}`, clientCaptureRef: args.clientCaptureRef ?? null, recordType: definitionKey.slice(0, 60),
    });
    evidenceRecordId = Number(inserted[0].insertId);
  }

  const reg = await registerControlledDocument(db, {
    book: args.book, actor: args.actor, definitionKey, title: args.title, originKind: args.originKind, issuer,
    contentHash, byteLength: args.bytes.byteLength, mimeType, evidenceRecordId, requestedState, importChannel: args.importChannel ?? "office_upload",
    externalReferences: refs, links, occurredAt: args.capturedAt ?? undefined,
  });
  if (sameBytes) {
    await db.transaction(async tx => { await appendDocumentEvent(tx, { documentId: reg.documentId, eventType: "document.captured", actor: { ...args.actor, source: "system" }, detail: { note: "same bytes already in the register", duplicateOfDocumentRef: sameBytes.documentRef, contentHash } }); });
  }
  return { documentRef: reg.documentRef, documentId: reg.documentId, evidenceRecordId, contentHash, byteLength: args.bytes.byteLength, controlState: reg.controlState, definitionKey, alreadyCaptured: false, duplicateOfDocumentRef: sameBytes?.documentRef ?? null };
}

/* ------------------------------------------------------------------ */
/* Extraction as proposal                                               */
/* ------------------------------------------------------------------ */

/** The engine-neutral document types an OCR hint may name (documentExtraction's `DocumentType`, as a list for input validation). */
export const OCR_DOCUMENT_TYPES = ["expense_receipt", "fuel_receipt", "disposal_ticket", "load_ticket", "scale_ticket", "invoice", "safety_document", "unknown"] as const satisfies readonly DocumentType[];

/** What a machine's classification proposes the document is. A proposal: the definition a person confirms may differ. */
export const DEFINITION_FOR_DOCUMENT_TYPE: Partial<Record<DocumentType, string>> = {
  expense_receipt: "expense_receipt",
  fuel_receipt: "fuel_receipt",
  disposal_ticket: "external_disposal_receipt",   // a scan of a facility's ticket is the facility's paper, never LeaseOS's disposal record
  scale_ticket: "scale_ticket",
  invoice: "vendor_bill",
};

/** OCR field keys that name another issuer's number, and the reference type each proposes. */
export const OCR_REFERENCE_FIELDS: Readonly<Record<string, ExternalReferenceType>> = {
  facilityTicketNumber: "facility_ticket_number", receivingTicketNumber: "facility_ticket_number", ticketNumber: "facility_ticket_number",
  manifestNumber: "manifest_number", receiptNumber: "receipt_number", invoiceNumber: "supplier_invoice_number",
};

export type ExtractionArgs = { book: Book; actor: Actor; documentRef: string; ocr: OcrResult; /** What the person who scanned it said it was, if anything: still a proposal until confirmed. */ expectedDefinitionKey?: string | null; storagePut: StoragePut };
export type ExtractionResult = {
  extractionRef: string; documentRef: string; controlState: string; proposalId: string | null; formKey: string | null; proposedDefinitionKey: string | null;
  classification: { documentType: string; confidence: number; source: string; ambiguous: boolean; reasons: string[] };
  counts: { autoFiled: number; review: number; asked: number; humanOnly: number }; questions: number; proposedReferences: string[]; derivativeRef: string; refusal: string | null;
};

const allForms = (): Record<string, FormDefinition> => ({ ...FORMS, ...Object.fromEntries(Object.entries(documentControlForms()).map(([k, c]) => [k, c.form])) });

export async function proposeExtraction(db: Db, args: ExtractionArgs): Promise<ExtractionResult> {
  const doc = await documentInBook(db, args.book, args.documentRef);
  if (!factsMutable(doc.controlState)) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — a ${doc.controlState} document's facts are frozen; an extraction proposes nothing to it (attach the reading as a derivative instead)`);
  if (!doc.evidenceRecordId) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — only a captured document (one with original evidence) is extracted from");

  // Whose word says what the document is: the register's (a person confirmed or captured it under a definition), the scanner's hint, or the classifier's.
  const classification = classifyDocument({ ocr: args.ocr });
  const registered = doc.definitionKey && doc.definitionKey !== "unclassified_external_document" ? doc.definitionKey : null;
  const proposedDefinitionKey = registered ?? args.expectedDefinitionKey ?? DEFINITION_FOR_DOCUMENT_TYPE[classification.documentType] ?? null;
  let definition = null as Awaited<ReturnType<typeof definitionFor>> | null;
  if (proposedDefinitionKey) { try { definition = await definitionFor(db, args.book, proposedDefinitionKey); } catch { definition = null; } }
  const profileKey = definition?.extractionProfileKey ?? null;
  const form = profileKey ? formFor(profileKey) : null;
  const outcome = extractToProposal({ ocr: args.ocr, classification, forms: allForms(), formKey: form ? form.key : null });
  const extractionRef = mintRef("EXT");
  const now = new Date();
  const rawTextHash = sha256Hex(Buffer.from(args.ocr.rawText, "utf8"));

  return db.transaction(async tx => {
    // The reading itself, as a derivative of the original: attributed to the engine, hashed, and pointing at the original's hash.
    const derivative = await attachDerivativeTx(tx, { book: args.book, actor: { ...args.actor, source: "ai" }, doc, derivativeKind: "ocr_text", bytes: Buffer.from(args.ocr.rawText, "utf8"), mimeType: "text/plain", producer: args.ocr.engine, producerVersion: args.ocr.engineVersion ?? null, extractionRef, storagePut: args.storagePut });

    let proposalId: string | null = null;
    if (!outcome.refusal && outcome.formKey) {
      proposalId = mintRef("PROP-DC");
      const linkRows = await tx.select().from(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.documentId, doc.id), eq(commercialDocumentLinks.confirmationStatus, "confirmed")));
      const linkId = (kind: string) => linkRows.find(l => l.recordType === kind && l.recordId != null)?.recordId ?? null;
      await tx.insert(assistantProposals).values({
        proposalId, formKey: outcome.formKey, formVersion: allForms()[outcome.formKey]!.version, title: `${definition?.displayName ?? outcome.formKey} — ${doc.documentRef}`.slice(0, 180), targetRef: doc.documentRef.slice(0, 180), targetRecordId: doc.id,
        jobId: linkId("job"), loadId: linkId("load"), facilityId: linkId("facility") ?? doc.issuerFacilityId ?? null, unitId: linkId("unit"), operatorId: linkId("operator"),
        createdByUserId: args.actor.userId, notes: [`Proposed by ${args.ocr.engine}${args.ocr.engineVersion ? ` ${args.ocr.engineVersion}` : ""} from ${doc.documentRef}.`, ...classification.reasons].join(" "),
        commitState: outcome.questions.length ? "awaiting_answers" : "awaiting_readback", capturedOffline: false,
      });
      if (outcome.fields.length) await tx.insert(proposalFields).values(outcome.fields.map(f => ({ proposalId: proposalId!, fieldKey: f.key.slice(0, 60), label: f.label.slice(0, 180), fieldValue: f.value == null ? null : String(f.value), precision: f.precision, source: "photo_ocr" as const, confidence: f.confidence, status: "proposed" as const, sourceUtterance: f.sourceUtterance ?? null })));
      if (outcome.questions.length) await tx.insert(assistantQuestions).values(outcome.questions.map(q => ({ questionRef: mintRef("Q"), proposalId: proposalId!, fieldKey: q.fieldKey.slice(0, 80), question: q.question.slice(0, 400), reason: q.reason, optionsJson: q.options ? JSON.stringify(q.options) : null, priority: q.priority, status: "pending" as const })));
    }

    await tx.insert(documentExtractions).values({
      extractionRef, evidenceRecordId: doc.evidenceRecordId, proposalId, documentId: doc.id, ocrEngine: args.ocr.engine.slice(0, 80), ocrEngineVersion: args.ocr.engineVersion?.slice(0, 40) ?? null,
      documentType: (proposedDefinitionKey ?? classification.documentType).slice(0, 60), classificationConfidence: registered ? 100 : classification.confidence,
      classificationSource: registered || args.expectedDefinitionKey ? "human" : classification.source === "merchant_memory" ? "merchant_memory" : "ocr_model",
      rawTextHash, contentSha256: doc.contentHash, fieldCount: outcome.fields.length, autoFiledCount: outcome.counts.autoFiled, reviewCount: outcome.counts.review, askedCount: outcome.counts.asked, humanOnlyCount: outcome.counts.humanOnly,
      extractedAt: now, extractedByUserId: args.actor.userId, status: proposalId ? "proposed" : "extracted",
    });

    // Another issuer's number the reading found: proposed, never confirmed, and only where the proposed definition carries that kind of reference.
    const proposedReferences: string[] = [];
    if (definition) {
      const existing = await tx.select().from(documentExternalReferences).where(eq(documentExternalReferences.documentId, doc.id));
      const issuer: IssuerInput = { issuerKind: doc.issuerKind ?? "unknown", issuerOrgRef: doc.issuerOrgRef, issuerFacilityId: doc.issuerFacilityId, issuerName: doc.issuerName };
      const issuerScope = issuerScopeKey(issuer);
      for (const f of args.ocr.fields) {
        const referenceType = OCR_REFERENCE_FIELDS[f.key];
        if (!referenceType || f.value == null || String(f.value).trim() === "") continue;
        if (!definition.allowedExternalReferenceTypes.includes(referenceType)) continue;
        const value = normaliseReferenceValue(String(f.value));
        if (existing.some(r => r.referenceType === referenceType && r.issuerScopeKey === issuerScope && r.referenceValue === value)) continue;
        const referenceRef = mintRef("XREF");
        await tx.insert(documentExternalReferences).values({ referenceRef, bookOrgRef: args.book.bookOrgRef, bookScopeKey: scopeKeyOf(args.book), documentId: doc.id, referenceType, referenceValue: value, referenceValueRaw: String(f.value).trim().slice(0, 120), issuerKind: issuer.issuerKind, issuerOrgRef: issuer.issuerOrgRef ?? null, issuerFacilityId: issuer.issuerFacilityId ?? null, issuerName: issuer.issuerName ?? null, issuerScopeKey: issuerScope, source: "ocr_proposed", confirmationStatus: "proposed", createdByUserId: args.actor.userId });
        await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.reference_added", actor: { ...args.actor, source: "ai" }, occurredAt: now, detail: { referenceRef, referenceType, referenceValue: value, source: "ocr_proposed", confidence: f.confidence, extractionRef } });
        proposedReferences.push(referenceRef);
      }
    }

    // The row moves to `proposed` when a form took the reading, to `needs_classification` when nothing did. Its facts stay where they were.
    const act = proposalId ? "propose" : "classify";
    const transition = nextControlState(doc.controlState, act);
    const newState = transition.ok ? transition.to : doc.controlState;
    if (transition.ok && newState !== doc.controlState) await tx.update(commercialDocuments).set({ controlState: newState }).where(eq(commercialDocuments.id, doc.id));
    await appendDocumentEvent(tx, {
      documentId: doc.id, eventType: proposalId ? "document.proposed" : "document.extraction_recorded", actor: { ...args.actor, source: "ai" }, occurredAt: now, previousState: doc.controlState, newState,
      detail: { extractionRef, proposalId, formKey: outcome.formKey || null, proposedDefinitionKey, classification: { documentType: classification.documentType, confidence: classification.confidence, source: classification.source, ambiguous: classification.ambiguous }, counts: outcome.counts, questions: outcome.questions.length, proposedReferences, derivativeRef: derivative.derivativeRef, refusal: outcome.refusal ?? null, engine: args.ocr.engine },
    });
    return {
      extractionRef, documentRef: doc.documentRef, controlState: newState, proposalId, formKey: outcome.formKey || null, proposedDefinitionKey,
      classification: { documentType: classification.documentType, confidence: classification.confidence, source: classification.source, ambiguous: classification.ambiguous, reasons: classification.reasons },
      counts: outcome.counts, questions: outcome.questions.length, proposedReferences, derivativeRef: derivative.derivativeRef, refusal: outcome.refusal ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Derivatives                                                          */
/* ------------------------------------------------------------------ */

export type DerivativeKind = (typeof documentDerivatives.$inferInsert)["derivativeKind"];
export const DERIVATIVE_KINDS = ["ocr_text", "extraction_json", "page_image", "thumbnail", "searchable_pdf", "redaction", "other"] as const;
const DERIVATIVE_EXT: Record<string, string> = { "text/plain": "txt", "application/json": "json", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

type DocRow = typeof commercialDocuments.$inferSelect;
type DerivativeTxArgs = { book: Book; actor: Actor; doc: DocRow; derivativeKind: DerivativeKind; bytes: Buffer; mimeType: string; producer: string; producerVersion?: string | null; extractionRef?: string | null; storagePut: StoragePut };
export type DerivativeResult = { derivativeRef: string; documentRef: string; derivativeKind: DerivativeKind; contentHash: string; sourceContentHash: string; storageKey: string; byteLength: number; alreadyAttached: boolean };

async function attachDerivativeTx(tx: Tx, a: DerivativeTxArgs): Promise<DerivativeResult> {
  if (!a.bytes.byteLength) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — a derivative has bytes");
  if (a.bytes.byteLength > CAPTURE_MAX_BYTES) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — a derivative is ${CAPTURE_MAX_BYTES / 1024 / 1024} MB or smaller`);
  const contentHash = sha256Hex(a.bytes);
  if (contentHash === a.doc.contentHash) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — these bytes are the original; a derivative is something made from it");
  const scopeKey = scopeKeyOf(a.book);
  const prior = (await tx.select().from(documentDerivatives).where(and(eq(documentDerivatives.documentId, a.doc.id), eq(documentDerivatives.derivativeKind, a.derivativeKind), eq(documentDerivatives.contentHash, contentHash))).limit(1))[0];
  if (prior) return { derivativeRef: prior.derivativeRef, documentRef: a.doc.documentRef, derivativeKind: prior.derivativeKind, contentHash, sourceContentHash: prior.sourceContentHash, storageKey: prior.storageKey, byteLength: prior.byteLength, alreadyAttached: true };
  const ext = DERIVATIVE_EXT[a.mimeType.toLowerCase()] ?? "bin";
  // Its own key, content-addressed under the document: it can never be the original's key and never collide with another derivation.
  const stored = await a.storagePut(`${scopeKey}/document-control/derivatives/${a.doc.documentRef}/${a.derivativeKind}/${contentHash}.${ext}`, a.bytes, a.mimeType);
  const derivativeRef = mintRef("DRV");
  await tx.insert(documentDerivatives).values({
    derivativeRef, bookOrgRef: a.book.bookOrgRef, bookScopeKey: scopeKey, documentId: a.doc.id, evidenceRecordId: a.doc.evidenceRecordId, sourceContentHash: a.doc.contentHash, derivativeKind: a.derivativeKind,
    producer: a.producer.slice(0, 80), producerVersion: a.producerVersion?.slice(0, 40) ?? null, extractionRef: a.extractionRef ?? null, storageKey: stored.key, contentHash, mimeType: a.mimeType.slice(0, 120), byteLength: a.bytes.byteLength,
    createdByUserId: a.actor.userId, actorSource: a.actor.source ?? "system",
  });
  await appendDocumentEvent(tx, { documentId: a.doc.id, eventType: "document.derivative_added", actor: a.actor, detail: { derivativeRef, derivativeKind: a.derivativeKind, producer: a.producer, contentHash, sourceContentHash: a.doc.contentHash, byteLength: a.bytes.byteLength, extractionRef: a.extractionRef ?? null } });
  return { derivativeRef, documentRef: a.doc.documentRef, derivativeKind: a.derivativeKind, contentHash, sourceContentHash: a.doc.contentHash, storageKey: stored.key, byteLength: a.bytes.byteLength, alreadyAttached: false };
}

export async function attachDerivative(db: Db, args: Omit<DerivativeTxArgs, "doc"> & { documentRef: string }): Promise<DerivativeResult> {
  const doc = await documentInBook(db, args.book, args.documentRef);
  return db.transaction(tx => attachDerivativeTx(tx, { ...args, doc }));
}

/** The derivatives and extractions of a document, for its detail view. */
export async function intakeViewOf(db: Db | Tx, documentId: number) {
  const [derivatives, extractions] = await Promise.all([
    db.select().from(documentDerivatives).where(eq(documentDerivatives.documentId, documentId)).orderBy(documentDerivatives.id),
    db.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId)).orderBy(documentExtractions.id),
  ]);
  return {
    derivatives: derivatives.map(d => ({ derivativeRef: d.derivativeRef, derivativeKind: d.derivativeKind, producer: d.producer, producerVersion: d.producerVersion, extractionRef: d.extractionRef, contentHash: d.contentHash, sourceContentHash: d.sourceContentHash, mimeType: d.mimeType, byteLength: d.byteLength, storageKey: d.storageKey, createdByUserId: d.createdByUserId, actorSource: d.actorSource, createdAt: d.createdAt })),
    extractions: extractions.map(e => ({ extractionRef: e.extractionRef, proposalId: e.proposalId, ocrEngine: e.ocrEngine, ocrEngineVersion: e.ocrEngineVersion, proposedDocumentType: e.documentType, classificationConfidence: e.classificationConfidence, classificationSource: e.classificationSource, contentSha256: e.contentSha256, fieldCount: e.fieldCount, autoFiledCount: e.autoFiledCount, reviewCount: e.reviewCount, askedCount: e.askedCount, humanOnlyCount: e.humanOnlyCount, status: e.status, extractedAt: e.extractedAt, extractedByUserId: e.extractedByUserId })),
  };
}
