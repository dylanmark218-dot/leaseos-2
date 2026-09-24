/**
 * Document Control — the register's one write path (DC-B, 0179).
 *
 * Every controlled record is written here, inside one transaction: the row,
 * its links, its external references and the timeline event that says what
 * just happened. `registerRefusals` (pure) runs first; the database-backed
 * checks — the definition the business sees, scope of every linked record,
 * duplicate references within an issuer, the evidence record's existence and
 * hash — run inside the transaction so nothing is decided on a stale read.
 *
 * Numbers: a `domain_managed` number is handed in by the domain that minted
 * it. A `leaseos_series*` number is minted by Checkpoint C's allocator; until
 * then `issueDocument` accepts a number the caller minted through
 * `nextTrackingNumber` and records it. Nothing here mints.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { commercialDocumentLinks, commercialDocuments, disposalTickets, documentControlEvents, documentDefinitions, documentDerivatives, documentExternalReferences, documentExtractions, documentTemplateRevisions, documentTemplates, evidenceRecords, facilities, fieldTicketDocuments, fieldTickets, jobs, loads, numberAllocations, recordAmendments, retentionPolicies, trackingReferences, trips, units } from "../../drizzle/schema";
import { SINGLE_TENANT_ID } from "./actingScope";
import { applyOverlay, rowToDefinition, type DocumentDefinitionRow, type DocumentLinkKind, type EffectiveDefinition, type ExternalReferenceType, type IssuerKind, type OriginKind } from "./documentDefinitions";
import { factsMutable, issuerScopeKey, nextControlState, normaliseReferenceValue, provenanceSentence, referenceDuplicateVerdict, registerRefusals, type ControlState, type DocumentEventType, type ImportChannel, type IssuerInput, type LinkRole, type LinkSource, type ReferenceSource } from "./documentRegister";
import { consumeFromBlock, ensureSeriesRow, issueReserved, mintNumberInTx, NumberSeriesRefusal, voidNumber } from "./numberSeries";
import { MINTING_POLICIES } from "./documentDefinitions";

type Db = MySql2Database<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class DocumentControlRefusal extends Error {
  constructor(public readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED" | "FORBIDDEN", message: string) { super(message); }
}
const refuse = (code: DocumentControlRefusal["code"], msg: string): never => { throw new DocumentControlRefusal(code, msg); };

export type Actor = { userId: number; source?: "human" | "system" | "ai" | "integration" | "external"; deviceRef?: string | null };
export type Book = { bookOrgRef: string | null };
const scopeKeyOf = (b: Book) => b.bookOrgRef ?? SINGLE_TENANT_ID;
const mintRef = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/** The definition as this business sees it, or a refusal naming the key. */
export async function definitionFor(db: Db | Tx, book: Book, definitionKey: string): Promise<EffectiveDefinition> {
  const rows = (await db.select().from(documentDefinitions).where(and(eq(documentDefinitions.definitionKey, definitionKey), book.bookOrgRef ? or(isNull(documentDefinitions.orgRef), eq(documentDefinitions.orgRef, book.bookOrgRef)) : isNull(documentDefinitions.orgRef)))) as unknown as DocumentDefinitionRow[];
  const platform = rows.find(r => r.orgRef === null && r.status === "active");
  const own = rows.find(r => r.orgRef !== null && r.status === "active");
  if (platform) return applyOverlay(rowToDefinition(platform), own ?? null);
  if (own) return rowToDefinition(own);
  return refuse("NOT_FOUND", `No active document definition "${definitionKey}" in this business's catalog`);
}

/**
 * Whether a linked record is one this business may see. Kinds with a resolver
 * are checked by id (or by their human ref); kinds without one are stored as
 * the ref the person typed and never as an id. A record another business owns
 * is "not found", never "forbidden".
 */
export async function linkTargetInScope(db: Db | Tx, book: Book, link: { recordType: string; recordId: number | null; recordRef: string }): Promise<{ ok: true; recordId: number | null; recordRef: string } | { ok: false; reason: string }> {
  const orgCond = <T extends { orgRef: any }>(t: T) => book.bookOrgRef ? eq(t.orgRef, book.bookOrgRef) : or(isNull(t.orgRef), eq(t.orgRef, SINGLE_TENANT_ID));
  const notFound = (what: string) => ({ ok: false as const, reason: `${what} ${link.recordRef} is not in this business's records` });
  switch (link.recordType) {
    case "job": {
      const j = (await db.select({ id: jobs.id, jobCode: jobs.jobCode }).from(jobs).where(and(link.recordId != null ? eq(jobs.id, link.recordId) : eq(jobs.jobCode, link.recordRef), orgCond(jobs))).limit(1))[0];
      return j ? { ok: true, recordId: j.id, recordRef: j.jobCode } : notFound("job");
    }
    case "load": {
      const l = (await db.select({ id: loads.id, loadNumber: loads.loadNumber, jobId: loads.jobId }).from(loads).where(link.recordId != null ? eq(loads.id, link.recordId) : eq(loads.loadNumber, link.recordRef)).limit(1))[0];
      if (!l) return notFound("load");
      const j = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, l.jobId), orgCond(jobs))).limit(1))[0];
      return j ? { ok: true, recordId: l.id, recordRef: l.loadNumber } : notFound("load");
    }
    case "trip": {
      const t = (await db.select({ id: trips.id, tripNumber: trips.tripNumber }).from(trips).where(and(link.recordId != null ? eq(trips.id, link.recordId) : eq(trips.tripNumber, link.recordRef), orgCond(trips))).limit(1))[0];
      return t ? { ok: true, recordId: t.id, recordRef: t.tripNumber } : notFound("trip");
    }
    case "field_ticket": {
      const f = (await db.select({ id: fieldTickets.id, ticketNumber: fieldTickets.ticketNumber, jobId: fieldTickets.jobId }).from(fieldTickets).where(link.recordId != null ? eq(fieldTickets.id, link.recordId) : eq(fieldTickets.ticketNumber, link.recordRef)).limit(1))[0];
      if (!f) return notFound("field ticket");
      const j = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, f.jobId), orgCond(jobs))).limit(1))[0];
      return j ? { ok: true, recordId: f.id, recordRef: f.ticketNumber } : notFound("field ticket");
    }
    case "disposal_ticket": {
      const d = (await db.select({ id: disposalTickets.id, ticketNumber: disposalTickets.ticketNumber, jobId: disposalTickets.jobId, loadId: disposalTickets.loadId }).from(disposalTickets).where(link.recordId != null ? eq(disposalTickets.id, link.recordId) : eq(disposalTickets.ticketNumber, link.recordRef)).limit(1))[0];
      if (!d) return notFound("disposal ticket");
      const jobId = d.jobId ?? (d.loadId ? (await db.select({ jobId: loads.jobId }).from(loads).where(eq(loads.id, d.loadId)).limit(1))[0]?.jobId ?? null : null);
      if (jobId == null) return book.bookOrgRef ? notFound("disposal ticket") : { ok: true, recordId: d.id, recordRef: d.ticketNumber };
      const j = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, jobId), orgCond(jobs))).limit(1))[0];
      return j ? { ok: true, recordId: d.id, recordRef: d.ticketNumber } : notFound("disposal ticket");
    }
    case "facility": {
      const f = (await db.select({ id: facilities.id, name: facilities.name, orgRef: facilities.orgRef }).from(facilities).where(link.recordId != null ? eq(facilities.id, link.recordId) : eq(facilities.name, link.recordRef)).limit(1))[0];
      // A facility is a shared directory row: any business may link to it. The link says which one; it grants nothing.
      return f ? { ok: true, recordId: f.id, recordRef: f.name } : notFound("facility");
    }
    case "unit": {
      const u = (await db.select({ id: units.id, unitNumber: units.unitNumber }).from(units).where(and(link.recordId != null ? eq(units.id, link.recordId) : eq(units.unitNumber, link.recordRef), book.bookOrgRef ? sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${units.id} LIMIT 1) = ${book.bookOrgRef}` : sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${units.id} LIMIT 1) IS NULL`)).limit(1))[0];
      return u ? { ok: true, recordId: u.id, recordRef: u.unitNumber } : notFound("unit");
    }
    case "operator": {
      if (link.recordId == null) return { ok: false, reason: "an operator link needs the operator id" };
      const rows = (await db.execute(sql`SELECT op.id FROM operators op WHERE op.id = ${link.recordId} AND ${book.bookOrgRef ? sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'operator' AND o.recordId = op.id LIMIT 1) = ${book.bookOrgRef}` : sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'operator' AND o.recordId = op.id LIMIT 1) IS NULL`} LIMIT 1`)) as unknown as [unknown[]];
      const found = Array.isArray(rows[0]) && rows[0].length > 0;
      return found ? { ok: true, recordId: link.recordId, recordRef: link.recordRef } : notFound("operator");
    }
    default:
      // No resolver: the ref is kept as typed, and no id is stored that could point into another business.
      return { ok: true, recordId: null, recordRef: link.recordRef };
  }
}

/**
 * DC-D: the template revision a document says it was rendered from must exist,
 * be released (a draft renders nothing; a retired one takes no new records —
 * the records already on it stay), belong to this definition, and be the
 * platform's or this business's own. Returns the revision's release manifest
 * so the document can prove what it was rendered from.
 */
export async function templateRevisionForRender(db: Db | Tx, book: Book, definitionKey: string, revisionRef: string): Promise<{ revisionId: number; templateRef: string; releaseManifestHash: string | null; sourceKind: string }> {
  const rev = (await db.select().from(documentTemplateRevisions).where(eq(documentTemplateRevisions.revisionRef, revisionRef)).limit(1))[0];
  if (!rev) return refuse("NOT_FOUND", `Template revision ${revisionRef} does not exist`);
  const tpl = (await db.select().from(documentTemplates).where(eq(documentTemplates.id, rev.templateId)).limit(1))[0];
  if (!tpl || (tpl.orgRef !== null && tpl.orgRef !== book.bookOrgRef)) return refuse("NOT_FOUND", `Template revision ${revisionRef} is not in this business's library`);
  if (tpl.definitionKey !== definitionKey) return refuse("PRECONDITION_FAILED", `BLOCKED — template ${tpl.templateRef} renders ${tpl.definitionKey}, not ${definitionKey}`);
  if (rev.status === "draft") return refuse("PRECONDITION_FAILED", `BLOCKED — revision ${revisionRef} is a draft; release it before rendering from it`);
  if (rev.status === "retired") return refuse("PRECONDITION_FAILED", `BLOCKED — revision ${revisionRef} is retired; the records already on it stay, new ones take the current revision`);
  if (tpl.status !== "active") return refuse("PRECONDITION_FAILED", `BLOCKED — template ${tpl.templateRef} is retired`);
  return { revisionId: rev.id, templateRef: tpl.templateRef, releaseManifestHash: rev.releaseManifestHash, sourceKind: tpl.sourceKind };
}

async function nextEventSequence(tx: Tx, documentId: number): Promise<number> {
  const last = (await tx.select({ sequence: documentControlEvents.sequence }).from(documentControlEvents).where(eq(documentControlEvents.documentId, documentId)).orderBy(desc(documentControlEvents.sequence)).limit(1))[0];
  return (last?.sequence ?? 0) + 1;
}

/** Append one timeline event. Sequence is per document and unique, so two writers cannot both claim the same position. */
export async function appendDocumentEvent(tx: Tx, args: { documentId: number; eventType: DocumentEventType; actor: Actor; previousState?: string | null; newState?: string | null; detail?: Record<string, unknown>; occurredAt?: Date }): Promise<number> {
  const sequence = await nextEventSequence(tx, args.documentId);
  await tx.insert(documentControlEvents).values({ documentId: args.documentId, sequence, eventType: args.eventType, actorUserId: args.actor.userId, actorSource: args.actor.source ?? "human", deviceRef: args.actor.deviceRef ?? null, previousState: args.previousState ?? null, newState: args.newState ?? null, detailJson: args.detail ? JSON.stringify(args.detail) : null, occurredAt: args.occurredAt ?? new Date() });
  return sequence;
}

export type ReferenceInput = { referenceType: ExternalReferenceType | string; referenceValue: string; issuer?: IssuerInput | null; source?: ReferenceSource; confirmed?: boolean; duplicateOverrideReason?: string | null; mirrorOf?: { table: string; id: number; column: string } | null };
export type LinkInput = { recordType: DocumentLinkKind | string; recordRef: string; recordId?: number | null; role?: LinkRole | string | null; source?: LinkSource; confirmed?: boolean };

export type RegisterArgs = {
  book: Book;
  actor: Actor;
  definitionKey: string;
  title: string;
  originKind: OriginKind;
  issuer: IssuerInput;
  contentHash: string;
  sourceSnapshotHash?: string | null;
  byteLength?: number | null;
  mimeType?: string | null;
  evidenceRecordId?: number | null;
  fieldTicketDocumentId?: number | null;
  storageKey?: string | null;
  counterpartyOrgRef?: string | null;
  issuedAt?: Date | null;
  templateRevisionRef?: string | null;
  renderManifestHash?: string | null;
  controlNumber?: string | null;
  /** DC-E: a number reserved before rendering (so the PDF can carry it) is issued here, in the same transaction as the row. */
  reservedAllocationRef?: string | null;
  requestedState: ControlState;
  importChannel?: ImportChannel | null;
  externalReferences?: ReferenceInput[];
  links?: LinkInput[];
  occurredAt?: Date;
};

export type RegisterResult = { documentId: number; documentRef: string; controlState: ControlState; controlNumber: string | null; definitionRef: string; references: string[]; provenance: string };

/**
 * Register one controlled record. The single door: the 0144 procedures and
 * every later checkpoint (intake, rendering, the disposal slice) come through
 * here. Returns the row's identity and the sentence a reader is told.
 */
export async function registerControlledDocument(db: Db, args: RegisterArgs): Promise<RegisterResult> {
  const definition = await definitionFor(db, args.book, args.definitionKey);
  const refs = args.externalReferences ?? [];
  const links = args.links ?? [];
  const problems = registerRefusals({ definition, originKind: args.originKind, issuer: args.issuer, templateRevisionRef: args.templateRevisionRef ?? null, controlNumber: args.controlNumber ?? null, requestedState: args.requestedState, externalReferences: refs, links, evidenceRecordId: args.evidenceRecordId ?? null, fieldTicketDocumentId: args.fieldTicketDocumentId ?? null, storageKey: args.storageKey ?? null });
  if (problems.length) refuse("PRECONDITION_FAILED", `BLOCKED — ${problems.join("; ")}`);
  await ensureSeriesRow(db, { orgRef: null, sequenceType: "DOC" }, args.occurredAt);
  if (!args.controlNumber && args.requestedState === "issued" && MINTING_POLICIES.includes(definition.numberingPolicy) && definition.numberSeriesType) await ensureSeriesRow(db, { orgRef: args.book.bookOrgRef, sequenceType: definition.numberSeriesType }, args.occurredAt);

  return db.transaction(async tx => {
    if (args.evidenceRecordId) {
      const ev = (await tx.select({ id: evidenceRecords.id }).from(evidenceRecords).where(eq(evidenceRecords.id, args.evidenceRecordId)).limit(1))[0];
      if (!ev) refuse("NOT_FOUND", `Evidence record ${args.evidenceRecordId} does not exist`);
    }
    if (args.fieldTicketDocumentId) {
      const ftd = (await tx.select({ id: fieldTicketDocuments.id, contentHash: fieldTicketDocuments.contentHash }).from(fieldTicketDocuments).where(eq(fieldTicketDocuments.id, args.fieldTicketDocumentId)).limit(1))[0];
      if (!ftd) refuse("NOT_FOUND", `Field-ticket document ${args.fieldTicketDocumentId} does not exist`);
      if (ftd.contentHash !== args.contentHash) refuse("PRECONDITION_FAILED", `BLOCKED — the hash given is not the generated document's hash`);
    }
    if (args.issuer.issuerFacilityId != null) {
      const f = (await tx.select({ id: facilities.id }).from(facilities).where(eq(facilities.id, args.issuer.issuerFacilityId)).limit(1))[0];
      if (!f) refuse("NOT_FOUND", `Facility ${args.issuer.issuerFacilityId} does not exist`);
    }
    let templateBinding: { templateRef: string; releaseManifestHash: string | null; sourceKind: string } | null = null;
    if (args.templateRevisionRef) {
      const t = await templateRevisionForRender(tx, args.book, definition.definitionKey, args.templateRevisionRef);
      templateBinding = t;
      // The source of the form and the origin must agree: a customer's form is a customer_template rendering, not a LeaseOS one.
      const expected: Record<string, OriginKind> = { leaseos_standard: "leaseos_generated", organization_custom: "organization_template", customer_supplied: "customer_template", external_form: "external_form_rendered" };
      if (expected[t.sourceKind] !== args.originKind) refuse("PRECONDITION_FAILED", `BLOCKED — a ${t.sourceKind} template renders as ${expected[t.sourceKind]}, not ${args.originKind}`);
    }
    // Every link is resolved inside the transaction; a record another business owns is not found.
    const resolvedLinks: { recordType: string; recordRef: string; recordId: number | null; role: string | null; source: LinkSource; confirmed: boolean }[] = [];
    for (const l of links) {
      const r = await linkTargetInScope(tx, args.book, { recordType: l.recordType, recordId: l.recordId ?? null, recordRef: l.recordRef });
      if (!r.ok) throw new DocumentControlRefusal("NOT_FOUND", `BLOCKED — ${r.reason}`);
      resolvedLinks.push({ recordType: l.recordType, recordRef: r.recordRef, recordId: r.recordId, role: l.role ?? null, source: l.source ?? "human", confirmed: l.confirmed ?? true });
    }
    const scopeKey = scopeKeyOf(args.book);
    // Duplicate references within one issuer are judged before the row exists, so a refusal writes nothing.
    const preparedRefs = refs.map(r => {
      const issuer = r.issuer ?? args.issuer;
      return { ...r, issuer, value: normaliseReferenceValue(r.referenceValue), issuerScope: issuerScopeKey(issuer) };
    });
    for (const r of preparedRefs) {
      const priors = await tx.select({ documentId: documentExternalReferences.documentId, contentHash: commercialDocuments.contentHash }).from(documentExternalReferences).innerJoin(commercialDocuments, eq(commercialDocuments.id, documentExternalReferences.documentId))
        .where(and(eq(documentExternalReferences.bookScopeKey, scopeKey), eq(documentExternalReferences.referenceType, String(r.referenceType)), eq(documentExternalReferences.issuerScopeKey, r.issuerScope), eq(documentExternalReferences.referenceValue, r.value), sql`${commercialDocuments.status} <> 'withdrawn'`, sql`${commercialDocuments.controlState} <> 'void'`));
      const verdict = referenceDuplicateVerdict({ sameIssuerSameValue: priors, contentHash: args.contentHash });
      if (verdict.outcome === "exact_duplicate") refuse("CONFLICT", `BLOCKED — ${r.referenceType} ${r.referenceValue} from this issuer is already registered as document #${verdict.matches[0]} with identical bytes; this is the same document`);
      if (verdict.outcome === "possible_duplicate" && !r.duplicateOverrideReason) refuse("CONFLICT", `REVIEW — ${r.referenceType} ${r.referenceValue} from this issuer is already registered as document #${verdict.matches[0]} with different bytes; confirm it is a different document with a recorded reason`);
      (r as { duplicateOf?: number }).duplicateOf = verdict.outcome === "possible_duplicate" ? verdict.matches[0] : undefined;
    }
    if (args.controlNumber) {
      const taken = (await tx.select({ id: commercialDocuments.id }).from(commercialDocuments).where(and(eq(commercialDocuments.bookScopeKey, scopeKey), eq(commercialDocuments.controlNumber, args.controlNumber))).limit(1))[0];
      if (taken) refuse("CONFLICT", `Control number ${args.controlNumber} is already on document #${taken.id}`);
    }
    // The series rows must exist before the transaction (INSERT IGNORE inside it deadlocks under contention).
    const now = args.occurredAt ?? new Date();
    // The archival identity, minted in this transaction with its ledger row: a failed insert rolls the counter back.
    const docMint = await mintNumberInTx(tx, { orgRef: null, sequenceType: "DOC" }, { recordType: "commercialDocument", recordId: null, actor: { userId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null }, at: now });
    const documentRef = docMint.number;
    // A control number, where the definition's series mints one and none was handed in.
    let controlNumber = args.controlNumber ?? null;
    let controlMint: { allocationRef: string } | null = null;
    if (!controlNumber && args.requestedState === "issued" && MINTING_POLICIES.includes(definition.numberingPolicy)) {
      if (definition.numberSeriesType) {
        const m = await mintNumberInTx(tx, { orgRef: args.book.bookOrgRef, sequenceType: definition.numberSeriesType }, { recordType: "commercialDocument", recordId: null, actor: { userId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null }, at: now });
        controlNumber = m.number; controlMint = m;
      } else if (definition.numberingPolicy === "leaseos_series") {
        throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — ${definition.definitionKey} requires a control number and names no series; set one on the definition`);
      }
    }
    const ins = await tx.insert(commercialDocuments).values({
      documentRef, bookOrgRef: args.book.bookOrgRef, bookScopeKey: scopeKey, documentType: definition.definitionKey, definitionKey: definition.definitionKey, definitionRef: definition.definitionRef, title: args.title,
      contentHash: args.contentHash, sourceSnapshotHash: args.sourceSnapshotHash ?? null, byteLength: args.byteLength ?? null, mimeType: args.mimeType ?? null,
      evidenceRecordId: args.evidenceRecordId ?? null, fieldTicketDocumentId: args.fieldTicketDocumentId ?? null, storageKey: args.storageKey ?? null, counterpartyOrgRef: args.counterpartyOrgRef ?? null, issuedAt: args.issuedAt ?? null,
      retentionPolicyId: definition.retentionPolicyId, retentionClass: definition.retentionPolicyId ? (await tx.select({ policyKey: retentionPolicies.policyKey }).from(retentionPolicies).where(eq(retentionPolicies.id, definition.retentionPolicyId)).limit(1))[0]?.policyKey ?? null : null,
      registeredByUserId: args.actor.userId, originKind: args.originKind, issuerKind: args.issuer.issuerKind, issuerOrgRef: args.issuer.issuerOrgRef ?? null, issuerFacilityId: args.issuer.issuerFacilityId ?? null, issuerName: args.issuer.issuerName ?? null,
      controlNumber, controlNumberIssuedAt: controlNumber ? now : null, controlState: args.requestedState, templateRevisionRef: args.templateRevisionRef ?? null, renderManifestHash: args.renderManifestHash ?? null,
      capturedByUserId: args.actor.userId, capturedByDeviceRef: args.actor.deviceRef ?? null, importChannel: args.importChannel ?? null,
      confirmedByUserId: args.requestedState === "confirmed" || args.requestedState === "issued" ? args.actor.userId : null, confirmedAt: args.requestedState === "confirmed" || args.requestedState === "issued" ? now : null,
      issuedByUserId: args.requestedState === "issued" ? args.actor.userId : null,
    });
    const documentId = Number(ins[0]?.insertId ?? 0);
    if (!documentId) refuse("PRECONDITION_FAILED", "Document insert returned no id");
    await tx.update(numberAllocations).set({ recordId: documentId }).where(eq(numberAllocations.allocationRef, docMint.allocationRef));
    if (controlMint) await tx.update(numberAllocations).set({ recordId: documentId }).where(eq(numberAllocations.allocationRef, controlMint.allocationRef));
    if (args.reservedAllocationRef) {
      try {
        const issued = await issueReserved(tx, { allocationRef: args.reservedAllocationRef, scopeKey, recordType: "commercialDocument", recordId: documentId, actor: { userId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null }, at: now });
        if (issued.number !== controlNumber) throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — the reserved number ${issued.number} is not the control number on the document (${controlNumber})`);
      } catch (e) { if (e instanceof NumberSeriesRefusal) throw new DocumentControlRefusal(e.code, `BLOCKED — ${e.message}`); throw e; }
    }
    await tx.insert(trackingReferences).values({ trackingNumber: documentRef, entityType: "commercialDocument", entityId: documentId, issuedAt: now, issuedByUserId: args.actor.userId, deviceId: args.actor.deviceRef ?? null });
    for (const l of resolvedLinks) await tx.insert(commercialDocumentLinks).values({ documentId, recordType: l.recordType, recordRef: l.recordRef, recordId: l.recordId, role: l.role, source: l.source, confirmationStatus: l.confirmed ? "confirmed" : "proposed", linkedByUserId: args.actor.userId, linkedByDeviceRef: args.actor.deviceRef ?? null });
    const referenceRefs: string[] = [];
    for (const r of preparedRefs) {
      const referenceRef = mintRef("XREF");
      await tx.insert(documentExternalReferences).values({ referenceRef, bookOrgRef: args.book.bookOrgRef, bookScopeKey: scopeKey, documentId, referenceType: String(r.referenceType), referenceValue: r.value, referenceValueRaw: r.referenceValue.trim().slice(0, 120), issuerKind: r.issuer.issuerKind, issuerOrgRef: r.issuer.issuerOrgRef ?? null, issuerFacilityId: r.issuer.issuerFacilityId ?? null, issuerName: r.issuer.issuerName ?? null, issuerScopeKey: r.issuerScope, source: r.source ?? "human_entered", confirmationStatus: r.confirmed ?? (r.source !== "ocr_proposed") ? "confirmed" : "proposed", confirmedByUserId: r.confirmed ?? (r.source !== "ocr_proposed") ? args.actor.userId : null, confirmedAt: r.confirmed ?? (r.source !== "ocr_proposed") ? now : null, mirrorOfTable: r.mirrorOf?.table ?? null, mirrorOfId: r.mirrorOf?.id ?? null, mirrorOfColumn: r.mirrorOf?.column ?? null, duplicateOfDocumentId: (r as { duplicateOf?: number }).duplicateOf ?? null, duplicateOverrideReason: r.duplicateOverrideReason ?? null, createdByUserId: args.actor.userId });
      referenceRefs.push(referenceRef);
    }
    const first: DocumentEventType = args.requestedState === "issued" ? "document.issued" : args.requestedState === "confirmed" ? "document.confirmed" : args.requestedState === "proposed" ? "document.proposed" : "document.captured";
    await appendDocumentEvent(tx, { documentId, eventType: first, actor: args.actor, previousState: null, newState: args.requestedState, occurredAt: now, detail: { documentRef, definitionKey: definition.definitionKey, originKind: args.originKind, issuerKind: args.issuer.issuerKind, controlNumber, contentHash: args.contentHash, links: resolvedLinks.length, references: referenceRefs.length, templateRevisionRef: args.templateRevisionRef ?? null } });
    if (templateBinding) await appendDocumentEvent(tx, { documentId, eventType: "document.template_bound", actor: args.actor, occurredAt: now, detail: { templateRef: templateBinding.templateRef, templateRevisionRef: args.templateRevisionRef, releaseManifestHash: templateBinding.releaseManifestHash, renderManifestHash: args.renderManifestHash ?? null, sourceKind: templateBinding.sourceKind } });
    if (controlNumber) await appendDocumentEvent(tx, { documentId, eventType: "document.number_issued", actor: args.actor, occurredAt: now, detail: { controlNumber, series: definition.numberSeriesType, policy: definition.numberingPolicy, minted: controlMint ? "leaseos_series" : "domain_managed" } });
    return { documentId, documentRef, controlState: args.requestedState, controlNumber, definitionRef: definition.definitionRef, references: referenceRefs, provenance: provenanceSentence({ originKind: args.originKind, issuerKind: args.issuer.issuerKind, issuerName: args.issuer.issuerName ?? null, templateRevisionRef: args.templateRevisionRef ?? null, controlNumber }) };
  });
}

/** The row, in this business's book, or not found. */
export async function documentInBook(db: Db | Tx, book: Book, documentRef: string) {
  const doc = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, documentRef)).limit(1))[0];
  if (!doc || (book.bookOrgRef ? doc.bookOrgRef !== book.bookOrgRef : doc.bookOrgRef !== null)) return refuse("NOT_FOUND", "Document not in this business's register");
  return doc;
}

/**
 * Confirm an external document: a person says what it is (the definition),
 * who issued it, and which facts stand. Facts are mutable only until now.
 */
export async function confirmDocument(db: Db, args: { book: Book; actor: Actor; documentRef: string; definitionKey?: string; issuer?: IssuerInput; title?: string; issuedAt?: Date | null; externalReferences?: ReferenceInput[]; links?: LinkInput[]; confirmReferenceRefs?: string[]; confirmLinkIds?: number[]; occurredAt?: Date }): Promise<{ documentRef: string; controlState: ControlState; definitionKey: string }> {
  return db.transaction(async tx => {
    const doc = await documentInBook(tx, args.book, args.documentRef);
    const transition = nextControlState(doc.controlState, "confirm");
    if (!transition.ok) refuse("PRECONDITION_FAILED", `BLOCKED — ${transition.reason}`);
    if (!factsMutable(doc.controlState)) refuse("PRECONDITION_FAILED", "BLOCKED — the facts of this document are frozen; correct it by amendment or supersession");
    const definitionKey = args.definitionKey ?? doc.definitionKey ?? doc.documentType;
    const definition = await definitionFor(tx, args.book, definitionKey);
    const originKind = doc.originKind;
    if (!originKind) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — a document with no recorded origin cannot be confirmed under Document Control; register it again with its origin");
    const issuer: IssuerInput = args.issuer ?? { issuerKind: doc.issuerKind ?? "unknown", issuerOrgRef: doc.issuerOrgRef, issuerFacilityId: doc.issuerFacilityId, issuerName: doc.issuerName };
    if (issuer.issuerKind === "unknown") refuse("PRECONDITION_FAILED", "BLOCKED — confirmation names the issuer; 'unknown' is where a document waits, not where it is confirmed");
    if (definition.documentClass === "unclassified") refuse("PRECONDITION_FAILED", "BLOCKED — confirm the document under the definition it is, not as unclassified");
    const existingRefs = await tx.select().from(documentExternalReferences).where(eq(documentExternalReferences.documentId, doc.id));
    const existingLinks = await tx.select().from(commercialDocumentLinks).where(eq(commercialDocumentLinks.documentId, doc.id));
    const newRefs = args.externalReferences ?? [];
    const newLinks = args.links ?? [];
    const confirmRefs = new Set(args.confirmReferenceRefs ?? []);
    const confirmLinks = new Set(args.confirmLinkIds ?? []);
    const refsAfter = [...existingRefs.filter(r => r.confirmationStatus === "confirmed" || confirmRefs.has(r.referenceRef)).map(r => ({ referenceType: r.referenceType, referenceValue: r.referenceValueRaw })), ...newRefs.map(r => ({ referenceType: r.referenceType, referenceValue: r.referenceValue }))];
    const linksAfter = [...existingLinks.filter(l => l.confirmationStatus === "confirmed" || confirmLinks.has(l.id)).map(l => ({ recordType: l.recordType })), ...newLinks.map(l => ({ recordType: l.recordType }))];
    const problems = registerRefusals({ definition, originKind, issuer, templateRevisionRef: doc.templateRevisionRef, controlNumber: doc.controlNumber, requestedState: "confirmed", externalReferences: refsAfter, links: linksAfter, evidenceRecordId: doc.evidenceRecordId, fieldTicketDocumentId: doc.fieldTicketDocumentId, storageKey: doc.storageKey });
    if (problems.length) refuse("PRECONDITION_FAILED", `BLOCKED — ${problems.join("; ")}`);
    const now = args.occurredAt ?? new Date();
    const scopeKey = scopeKeyOf(args.book);
    for (const l of newLinks) {
      const r = await linkTargetInScope(tx, args.book, { recordType: l.recordType, recordId: l.recordId ?? null, recordRef: l.recordRef });
      if (!r.ok) throw new DocumentControlRefusal("NOT_FOUND", `BLOCKED — ${r.reason}`);
      await tx.insert(commercialDocumentLinks).values({ documentId: doc.id, recordType: l.recordType, recordRef: r.recordRef, recordId: r.recordId, role: l.role ?? null, source: l.source ?? "human", confirmationStatus: "confirmed", linkedByUserId: args.actor.userId, linkedByDeviceRef: args.actor.deviceRef ?? null });
      await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.link_added", actor: args.actor, occurredAt: now, detail: { recordType: l.recordType, recordRef: r.recordRef, recordId: r.recordId, role: l.role ?? null } });
    }
    for (const id of Array.from(confirmLinks)) {
      const l = existingLinks.find(x => x.id === id);
      if (!l) throw new DocumentControlRefusal("NOT_FOUND", `Link ${id} is not on this document`);
      await tx.update(commercialDocumentLinks).set({ confirmationStatus: "confirmed" }).where(eq(commercialDocumentLinks.id, id));
      await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.link_confirmed", actor: args.actor, occurredAt: now, detail: { recordType: l.recordType, recordRef: l.recordRef } });
    }
    for (const r of newRefs) {
      const ri = r.issuer ?? issuer;
      const value = normaliseReferenceValue(r.referenceValue);
      const issuerScope = issuerScopeKey(ri);
      const priors = await tx.select({ documentId: documentExternalReferences.documentId, contentHash: commercialDocuments.contentHash }).from(documentExternalReferences).innerJoin(commercialDocuments, eq(commercialDocuments.id, documentExternalReferences.documentId))
        .where(and(eq(documentExternalReferences.bookScopeKey, scopeKey), eq(documentExternalReferences.referenceType, String(r.referenceType)), eq(documentExternalReferences.issuerScopeKey, issuerScope), eq(documentExternalReferences.referenceValue, value), sql`${documentExternalReferences.documentId} <> ${doc.id}`, sql`${commercialDocuments.status} <> 'withdrawn'`, sql`${commercialDocuments.controlState} <> 'void'`));
      const verdict = referenceDuplicateVerdict({ sameIssuerSameValue: priors, contentHash: doc.contentHash });
      if (verdict.outcome === "exact_duplicate") refuse("CONFLICT", `BLOCKED — ${r.referenceType} ${r.referenceValue} from this issuer is already registered as document #${verdict.matches[0]} with identical bytes`);
      if (verdict.outcome === "possible_duplicate" && !r.duplicateOverrideReason) refuse("CONFLICT", `REVIEW — ${r.referenceType} ${r.referenceValue} from this issuer is already on document #${verdict.matches[0]}; confirm it is a different document with a recorded reason`);
      const referenceRef = mintRef("XREF");
      await tx.insert(documentExternalReferences).values({ referenceRef, bookOrgRef: args.book.bookOrgRef, bookScopeKey: scopeKey, documentId: doc.id, referenceType: String(r.referenceType), referenceValue: value, referenceValueRaw: r.referenceValue.trim().slice(0, 120), issuerKind: ri.issuerKind, issuerOrgRef: ri.issuerOrgRef ?? null, issuerFacilityId: ri.issuerFacilityId ?? null, issuerName: ri.issuerName ?? null, issuerScopeKey: issuerScope, source: r.source ?? "human_entered", confirmationStatus: "confirmed", confirmedByUserId: args.actor.userId, confirmedAt: now, mirrorOfTable: r.mirrorOf?.table ?? null, mirrorOfId: r.mirrorOf?.id ?? null, mirrorOfColumn: r.mirrorOf?.column ?? null, duplicateOfDocumentId: verdict.outcome === "possible_duplicate" ? verdict.matches[0] : null, duplicateOverrideReason: r.duplicateOverrideReason ?? null, createdByUserId: args.actor.userId });
      await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.reference_added", actor: args.actor, occurredAt: now, detail: { referenceRef, referenceType: r.referenceType, referenceValue: value, issuerScope } });
    }
    for (const ref of Array.from(confirmRefs)) {
      const r = existingRefs.find(x => x.referenceRef === ref);
      if (!r) throw new DocumentControlRefusal("NOT_FOUND", `Reference ${ref} is not on this document`);
      // A reference proposed while the issuer was unknown takes the issuer the person names now: the number was always theirs.
      const carry = r.issuerKind === "unknown" && issuer.issuerKind !== "unknown" ? { issuerKind: issuer.issuerKind, issuerOrgRef: issuer.issuerOrgRef ?? null, issuerFacilityId: issuer.issuerFacilityId ?? null, issuerName: issuer.issuerName ?? null, issuerScopeKey: issuerScopeKey(issuer) } : {};
      await tx.update(documentExternalReferences).set({ confirmationStatus: "confirmed", confirmedByUserId: args.actor.userId, confirmedAt: now, ...carry }).where(eq(documentExternalReferences.id, r.id));
      await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.reference_confirmed", actor: args.actor, occurredAt: now, detail: { referenceRef: ref, referenceType: r.referenceType, referenceValue: r.referenceValue } });
    }
    // Anything still proposed after confirmation is rejected: a confirmed record carries no maybes.
    await tx.update(documentExternalReferences).set({ confirmationStatus: "rejected" }).where(and(eq(documentExternalReferences.documentId, doc.id), eq(documentExternalReferences.confirmationStatus, "proposed")));
    await tx.delete(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.documentId, doc.id), eq(commercialDocumentLinks.confirmationStatus, "proposed")));
    await tx.update(commercialDocuments).set({ controlState: "confirmed", definitionKey: definition.definitionKey, definitionRef: definition.definitionRef, documentType: definition.definitionKey, issuerKind: issuer.issuerKind, issuerOrgRef: issuer.issuerOrgRef ?? null, issuerFacilityId: issuer.issuerFacilityId ?? null, issuerName: issuer.issuerName ?? null, title: args.title ?? doc.title, issuedAt: args.issuedAt === undefined ? doc.issuedAt : args.issuedAt, confirmedByUserId: args.actor.userId, confirmedAt: now, retentionPolicyId: doc.retentionPolicyId ?? definition.retentionPolicyId }).where(eq(commercialDocuments.id, doc.id));
    if (doc.definitionKey !== definition.definitionKey) await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.classified", actor: args.actor, occurredAt: now, previousState: doc.controlState, newState: doc.controlState, detail: { from: doc.definitionKey, to: definition.definitionKey } });
    await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.confirmed", actor: args.actor, occurredAt: now, previousState: doc.controlState, newState: "confirmed", detail: { definitionKey: definition.definitionKey, issuerKind: issuer.issuerKind, issuerName: issuer.issuerName ?? null } });
    return { documentRef: doc.documentRef, controlState: "confirmed", definitionKey: definition.definitionKey };
  });
}

/** Issue a document the tenant produced: it takes its control number (minted by the caller through the series) and leaves the mutable states for good. */
export async function issueDocument(db: Db, args: { book: Book; actor: Actor; documentRef: string; controlNumber: string | null; deviceNumber?: { blockRef: string; sequence: number; deviceRef: string; idempotencyKey: string } | null; occurredAt?: Date }): Promise<{ documentRef: string; controlState: ControlState; controlNumber: string | null; minted: "leaseos_series" | "device_block" | "domain_managed" | "none" }> {
  const pre = await documentInBook(db, args.book, args.documentRef);
  const preDef = await definitionFor(db, args.book, pre.definitionKey ?? pre.documentType);
  const willMint = !args.controlNumber && !pre.controlNumber && !args.deviceNumber && MINTING_POLICIES.includes(preDef.numberingPolicy) && !!preDef.numberSeriesType;
  if (willMint) await ensureSeriesRow(db, { orgRef: args.book.bookOrgRef, sequenceType: preDef.numberSeriesType! }, args.occurredAt);
  return db.transaction(async tx => {
    const doc = await documentInBook(tx, args.book, args.documentRef);
    const transition = nextControlState(doc.controlState, "issue");
    if (!transition.ok) refuse("PRECONDITION_FAILED", `BLOCKED — ${transition.reason}`);
    const originKind = doc.originKind;
    if (!originKind) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — a document with no recorded origin cannot be issued");
    const definition = await definitionFor(tx, args.book, doc.definitionKey ?? doc.documentType);
    let controlNumber = args.controlNumber ?? doc.controlNumber;
    let minted: "leaseos_series" | "device_block" | "domain_managed" | "none" = args.controlNumber ? "domain_managed" : "none";
    const now0 = args.occurredAt ?? new Date();
    if (!controlNumber && MINTING_POLICIES.includes(definition.numberingPolicy)) {
      if (args.deviceNumber) {
        if (args.actor.deviceRef && args.actor.deviceRef !== args.deviceNumber.deviceRef) throw new DocumentControlRefusal("PRECONDITION_FAILED", "BLOCKED — the number's device is not the device making the request");
        try {
          const m = await consumeFromBlock(tx, { scopeKey: scopeKeyOf(args.book), blockRef: args.deviceNumber.blockRef, sequence: args.deviceNumber.sequence, deviceRef: args.deviceNumber.deviceRef, recordType: "commercialDocument", recordId: doc.id, idempotencyKey: args.deviceNumber.idempotencyKey, actor: { userId: args.actor.userId, deviceRef: args.deviceNumber.deviceRef }, at: now0 });
          controlNumber = m.number; minted = "device_block";
        } catch (e) { if (e instanceof NumberSeriesRefusal) throw new DocumentControlRefusal(e.code, `BLOCKED — ${e.message}`); throw e; }
      } else if (definition.numberSeriesType) {
        const m = await mintNumberInTx(tx, { orgRef: args.book.bookOrgRef, sequenceType: definition.numberSeriesType }, { recordType: "commercialDocument", recordId: doc.id, actor: { userId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null }, at: now0, idempotencyKey: `issue:${doc.documentRef}` });
        controlNumber = m.number; minted = "leaseos_series";
      }
    } else if (args.deviceNumber) {
      throw new DocumentControlRefusal("PRECONDITION_FAILED", `BLOCKED — ${definition.definitionKey} (${definition.numberingPolicy}) does not take a device-issued number`);
    }
    const refs = await tx.select({ referenceType: documentExternalReferences.referenceType, referenceValueRaw: documentExternalReferences.referenceValueRaw }).from(documentExternalReferences).where(and(eq(documentExternalReferences.documentId, doc.id), eq(documentExternalReferences.confirmationStatus, "confirmed")));
    const problems = registerRefusals({ definition, originKind, issuer: { issuerKind: doc.issuerKind ?? "unknown", issuerOrgRef: doc.issuerOrgRef, issuerFacilityId: doc.issuerFacilityId, issuerName: doc.issuerName }, templateRevisionRef: doc.templateRevisionRef, controlNumber, requestedState: "issued", externalReferences: refs.map(r => ({ referenceType: r.referenceType, referenceValue: r.referenceValueRaw })), links: [], evidenceRecordId: doc.evidenceRecordId, fieldTicketDocumentId: doc.fieldTicketDocumentId, storageKey: doc.storageKey });
    if (problems.length) refuse("PRECONDITION_FAILED", `BLOCKED — ${problems.join("; ")}`);
    if (controlNumber && controlNumber !== doc.controlNumber) {
      const taken = (await tx.select({ id: commercialDocuments.id }).from(commercialDocuments).where(and(eq(commercialDocuments.bookScopeKey, scopeKeyOf(args.book)), eq(commercialDocuments.controlNumber, controlNumber))).limit(1))[0];
      if (taken) refuse("CONFLICT", `Control number ${controlNumber} is already on document #${taken.id}`);
    }
    const now = args.occurredAt ?? new Date();
    await tx.update(commercialDocuments).set({ controlState: "issued", controlNumber, controlNumberIssuedAt: controlNumber ? (doc.controlNumberIssuedAt ?? now) : null, issuedByUserId: args.actor.userId, confirmedByUserId: doc.confirmedByUserId ?? args.actor.userId, confirmedAt: doc.confirmedAt ?? now }).where(eq(commercialDocuments.id, doc.id));
    if (controlNumber && controlNumber !== doc.controlNumber) await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.number_issued", actor: args.actor, occurredAt: now, detail: { controlNumber, series: definition.numberSeriesType, policy: definition.numberingPolicy, minted } });
    await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.issued", actor: args.actor, occurredAt: now, previousState: doc.controlState, newState: "issued", detail: { controlNumber, minted } });
    return { documentRef: doc.documentRef, controlState: "issued", controlNumber, minted };
  });
}

/** Void a document that was never issued. The row and its number stay; the number is explained, never reused. */
export async function voidDocument(db: Db, args: { book: Book; actor: Actor; documentRef: string; reason: string; occurredAt?: Date }): Promise<{ documentRef: string; controlState: ControlState }> {
  return db.transaction(async tx => {
    const doc = await documentInBook(tx, args.book, args.documentRef);
    const transition = nextControlState(doc.controlState, "void");
    if (!transition.ok) refuse("PRECONDITION_FAILED", `BLOCKED — ${transition.reason}; an issued document is withdrawn or superseded, not voided`);
    const now = args.occurredAt ?? new Date();
    await tx.update(commercialDocuments).set({ controlState: "void", voidedByUserId: args.actor.userId, voidedAt: now, voidReason: args.reason, statusReason: `voided by user ${args.actor.userId}: ${args.reason}` }).where(eq(commercialDocuments.id, doc.id));
    await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.voided", actor: args.actor, occurredAt: now, previousState: doc.controlState, newState: "void", detail: { reason: args.reason, controlNumber: doc.controlNumber } });
    if (doc.controlNumber) {
      const ledger = (await tx.select({ id: numberAllocations.id }).from(numberAllocations).where(and(eq(numberAllocations.scopeKey, scopeKeyOf(args.book)), eq(numberAllocations.formattedNumber, doc.controlNumber), eq(numberAllocations.state, "issued"))).limit(1))[0];
      if (ledger) await voidNumber(tx, { scopeKey: scopeKeyOf(args.book), formattedNumber: doc.controlNumber, reasonCode: "cancelled_before_issue", reasonText: args.reason.slice(0, 300), actor: { userId: args.actor.userId }, at: now });
      await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.number_voided", actor: args.actor, occurredAt: now, detail: { controlNumber: doc.controlNumber, reason: args.reason, ledgered: !!ledger } });
    }
    return { documentRef: doc.documentRef, controlState: "void" };
  });
}

/**
 * A new version of a confirmed or issued document. The old row keeps its
 * number, hash and timeline; the new row carries the provenance forward and
 * says what it supersedes and why. A reprint is not a supersession: same
 * bytes means nothing changed.
 */
export async function supersedeDocument(db: Db, args: { book: Book; actor: Actor; documentRef: string; reason: string; contentHash: string; sourceSnapshotHash?: string | null; byteLength?: number | null; evidenceRecordId?: number | null; fieldTicketDocumentId?: number | null; storageKey?: string | null; templateRevisionRef?: string | null; renderManifestHash?: string | null; title?: string; occurredAt?: Date }): Promise<{ documentRef: string; supersedes: string; version: number; controlNumber: string | null }> {
  const old = await documentInBook(db, args.book, args.documentRef);
  if (old.status !== "current") refuse("CONFLICT", `Document is ${old.status}; only the current version can be superseded`);
  if (old.controlState !== "confirmed" && old.controlState !== "issued") refuse("PRECONDITION_FAILED", `BLOCKED — a ${old.controlState} document is corrected in place, not superseded`);
  if (old.contentHash === args.contentHash) refuse("BAD_REQUEST", "The new version has the same content hash as the old; nothing changed — a reprint of the same bytes is a print event, not a revision");
  if (!args.evidenceRecordId && !args.fieldTicketDocumentId && !args.storageKey) refuse("BAD_REQUEST", "BLOCKED — the new version needs a pointer to its bytes");
  if (old.originKind && ["leaseos_generated", "organization_template", "customer_template", "external_form_rendered"].includes(old.originKind) && !(args.templateRevisionRef ?? old.templateRevisionRef)) refuse("PRECONDITION_FAILED", "BLOCKED — a templated document's new version names the template revision it was rendered from");
  const definition = await definitionFor(db, args.book, old.definitionKey ?? old.documentType);
  if (definition.revisionPolicy === "reference_versioned" && !args.evidenceRecordId && !args.storageKey) refuse("BAD_REQUEST", "A reference document's new version is the publisher's new file");
  if (args.templateRevisionRef) await templateRevisionForRender(db, args.book, definition.definitionKey, args.templateRevisionRef);
  await ensureSeriesRow(db, { orgRef: null, sequenceType: "DOC" }, args.occurredAt);
  return db.transaction(async tx => {
    const documentRef = (await mintNumberInTx(tx, { orgRef: null, sequenceType: "DOC" }, { recordType: "commercialDocument", recordId: null, actor: { userId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null }, at: args.occurredAt })).number;
    const links = await tx.select().from(commercialDocumentLinks).where(eq(commercialDocumentLinks.documentId, old.id));
    const refs = await tx.select().from(documentExternalReferences).where(and(eq(documentExternalReferences.documentId, old.id), eq(documentExternalReferences.confirmationStatus, "confirmed")));
    const now = args.occurredAt ?? new Date();
    const ins = await tx.insert(commercialDocuments).values({
      documentRef, bookOrgRef: old.bookOrgRef, bookScopeKey: old.bookScopeKey, documentType: old.documentType, definitionKey: old.definitionKey, definitionRef: old.definitionRef, title: args.title ?? old.title, version: old.version + 1, supersedesDocumentId: old.id,
      contentHash: args.contentHash, sourceSnapshotHash: args.sourceSnapshotHash ?? null, byteLength: args.byteLength ?? null, mimeType: old.mimeType, evidenceRecordId: args.evidenceRecordId ?? null, fieldTicketDocumentId: args.fieldTicketDocumentId ?? null, storageKey: args.storageKey ?? null,
      counterpartyOrgRef: old.counterpartyOrgRef, issuedAt: old.issuedAt, retentionPolicyId: old.retentionPolicyId, retentionClass: old.retentionClass, retentionAssignedByUserId: old.retentionAssignedByUserId, registeredByUserId: args.actor.userId, statusReason: `supersedes ${old.documentRef}: ${args.reason}`,
      originKind: old.originKind, issuerKind: old.issuerKind, issuerOrgRef: old.issuerOrgRef, issuerFacilityId: old.issuerFacilityId, issuerName: old.issuerName,
      // The number belongs to the document, not the version: a void or reissue is explicit, never implied by a new version.
      controlNumber: null, controlNumberIssuedAt: null, controlState: old.controlState, templateRevisionRef: args.templateRevisionRef ?? old.templateRevisionRef, renderManifestHash: args.renderManifestHash ?? null,
      capturedByUserId: args.actor.userId, capturedByDeviceRef: args.actor.deviceRef ?? null, importChannel: old.importChannel, confirmedByUserId: args.actor.userId, confirmedAt: now, issuedByUserId: old.controlState === "issued" ? args.actor.userId : null,
    });
    const newId = Number(ins[0]?.insertId ?? 0);
    // The number moves to the new version with the old one released in the same statement pair: the unique index sees one holder at a time.
    await tx.update(commercialDocuments).set({ status: "superseded", supersededByDocumentId: newId, statusReason: `superseded by ${documentRef}: ${args.reason}`, controlNumber: null }).where(eq(commercialDocuments.id, old.id));
    if (old.controlNumber) await tx.update(commercialDocuments).set({ controlNumber: old.controlNumber, controlNumberIssuedAt: old.controlNumberIssuedAt }).where(eq(commercialDocuments.id, newId));
    for (const l of links) await tx.insert(commercialDocumentLinks).values({ documentId: newId, recordType: l.recordType, recordRef: l.recordRef, recordId: l.recordId, role: l.role, source: l.source, confirmationStatus: l.confirmationStatus, linkedByUserId: args.actor.userId });
    for (const r of refs) await tx.insert(documentExternalReferences).values({ referenceRef: mintRef("XREF"), bookOrgRef: r.bookOrgRef, bookScopeKey: r.bookScopeKey, documentId: newId, referenceType: r.referenceType, referenceValue: r.referenceValue, referenceValueRaw: r.referenceValueRaw, issuerKind: r.issuerKind, issuerOrgRef: r.issuerOrgRef, issuerFacilityId: r.issuerFacilityId, issuerName: r.issuerName, issuerScopeKey: r.issuerScopeKey, source: r.source, confirmationStatus: "confirmed", confirmedByUserId: r.confirmedByUserId, confirmedAt: r.confirmedAt, mirrorOfTable: r.mirrorOfTable, mirrorOfId: r.mirrorOfId, mirrorOfColumn: r.mirrorOfColumn, duplicateOfDocumentId: null, duplicateOverrideReason: `carried from ${old.documentRef}`, createdByUserId: args.actor.userId });
    await appendDocumentEvent(tx, { documentId: old.id, eventType: "document.superseded", actor: args.actor, occurredAt: now, previousState: old.controlState, newState: old.controlState, detail: { supersededBy: documentRef, reason: args.reason, previousHash: old.contentHash, newHash: args.contentHash } });
    await appendDocumentEvent(tx, { documentId: newId, eventType: old.controlState === "issued" ? "document.issued" : "document.confirmed", actor: args.actor, occurredAt: now, previousState: null, newState: old.controlState, detail: { documentRef, supersedes: old.documentRef, version: old.version + 1, reason: args.reason, controlNumber: old.controlNumber, contentHash: args.contentHash, templateRevisionRef: args.templateRevisionRef ?? old.templateRevisionRef } });
    return { documentRef, supersedes: old.documentRef, version: old.version + 1, controlNumber: old.controlNumber };
  });
}

/** Withdraw an issued or confirmed document. The row, its hash and its number stay; withdrawn is a state. Refused under legal hold. */
export async function withdrawDocument(db: Db, args: { book: Book; actor: Actor; documentRef: string; reason: string; occurredAt?: Date }): Promise<{ documentRef: string; controlState: ControlState }> {
  return db.transaction(async tx => {
    const doc = await documentInBook(tx, args.book, args.documentRef);
    const transition = nextControlState(doc.controlState, "withdraw");
    if (!transition.ok) refuse("PRECONDITION_FAILED", `BLOCKED — ${transition.reason}`);
    if (doc.evidenceRecordId) {
      const ev = (await tx.select({ legalHold: evidenceRecords.legalHold }).from(evidenceRecords).where(eq(evidenceRecords.id, doc.evidenceRecordId)).limit(1))[0];
      if (ev?.legalHold) refuse("PRECONDITION_FAILED", "BLOCKED — the underlying evidence record is under legal hold; the document cannot be withdrawn while it stands");
    }
    const now = args.occurredAt ?? new Date();
    await tx.update(commercialDocuments).set({ status: "withdrawn", controlState: "withdrawn", statusReason: `withdrawn by user ${args.actor.userId}: ${args.reason}` }).where(eq(commercialDocuments.id, doc.id));
    await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.withdrawn", actor: args.actor, occurredAt: now, previousState: doc.controlState, newState: "withdrawn", detail: { reason: args.reason } });
    return { documentRef: doc.documentRef, controlState: "withdrawn" };
  });
}

/**
 * A field-level correction to a confirmed external document under
 * `amend_with_reason`: the original value and the corrected one are kept side
 * by side in `recordAmendments`, the row is updated, the timeline says so.
 * Only the keyed facts (issuer, references, title, issued date) are
 * amendable; the bytes and the hash are never touched.
 */
export async function amendDocument(db: Db, args: { book: Book; actor: Actor; documentRef: string; reason: string; changes: { title?: string; issuedAt?: Date | null; issuerName?: string | null; issuerFacilityId?: number | null; issuerOrgRef?: string | null }; occurredAt?: Date }): Promise<{ documentRef: string; amendments: string[] }> {
  return db.transaction(async tx => {
    const doc = await documentInBook(tx, args.book, args.documentRef);
    const definition = await definitionFor(tx, args.book, doc.definitionKey ?? doc.documentType);
    if (definition.revisionPolicy !== "amend_with_reason") refuse("PRECONDITION_FAILED", `BLOCKED — ${definition.definitionKey} is corrected by ${definition.revisionPolicy === "domain_managed" ? "its owning domain" : "supersession"}, not by amendment`);
    if (doc.controlState !== "confirmed" && doc.controlState !== "issued") refuse("PRECONDITION_FAILED", `BLOCKED — a ${doc.controlState} document is still mutable; confirm it first or correct it directly`);
    const now = args.occurredAt ?? new Date();
    const fields: [string, unknown, unknown][] = [];
    if (args.changes.title !== undefined && args.changes.title !== doc.title) fields.push(["title", doc.title, args.changes.title]);
    if (args.changes.issuedAt !== undefined && (args.changes.issuedAt?.getTime() ?? null) !== (doc.issuedAt?.getTime() ?? null)) fields.push(["issuedAt", doc.issuedAt?.toISOString() ?? null, args.changes.issuedAt?.toISOString() ?? null]);
    if (args.changes.issuerName !== undefined && args.changes.issuerName !== doc.issuerName) fields.push(["issuerName", doc.issuerName, args.changes.issuerName]);
    if (args.changes.issuerFacilityId !== undefined && args.changes.issuerFacilityId !== doc.issuerFacilityId) fields.push(["issuerFacilityId", doc.issuerFacilityId, args.changes.issuerFacilityId]);
    if (args.changes.issuerOrgRef !== undefined && args.changes.issuerOrgRef !== doc.issuerOrgRef) fields.push(["issuerOrgRef", doc.issuerOrgRef, args.changes.issuerOrgRef]);
    if (!fields.length) refuse("BAD_REQUEST", "Nothing to amend");
    for (const [fieldKey, from, to] of fields) await tx.insert(recordAmendments).values({ entityType: "commercialDocument", entityId: doc.id, trackingNumber: doc.documentRef, fieldKey, originalValue: from == null ? null : String(from), correctedValue: to == null ? null : String(to), reason: args.reason, actorUserId: args.actor.userId, afterSignature: doc.controlState === "issued", occurredAt: now });
    await tx.update(commercialDocuments).set({ ...(args.changes.title !== undefined ? { title: args.changes.title } : {}), ...(args.changes.issuedAt !== undefined ? { issuedAt: args.changes.issuedAt } : {}), ...(args.changes.issuerName !== undefined ? { issuerName: args.changes.issuerName } : {}), ...(args.changes.issuerFacilityId !== undefined ? { issuerFacilityId: args.changes.issuerFacilityId } : {}), ...(args.changes.issuerOrgRef !== undefined ? { issuerOrgRef: args.changes.issuerOrgRef } : {}) }).where(eq(commercialDocuments.id, doc.id));
    await appendDocumentEvent(tx, { documentId: doc.id, eventType: "document.amended", actor: args.actor, occurredAt: now, previousState: doc.controlState, newState: doc.controlState, detail: { reason: args.reason, fields: fields.map(([k, from, to]) => ({ fieldKey: k, from, to })) } });
    return { documentRef: doc.documentRef, amendments: fields.map(f => f[0]) };
  });
}

/** Everything a reader may know about one document: the row, its provenance sentence, references, links, versions and the timeline in sequence. */
export async function documentView(db: Db, book: Book, documentRef: string) {
  const doc = await documentInBook(db, book, documentRef);
  const [links, refs, events, amendments, derivatives, extractions] = await Promise.all([
    db.select().from(commercialDocumentLinks).where(eq(commercialDocumentLinks.documentId, doc.id)),
    db.select().from(documentExternalReferences).where(eq(documentExternalReferences.documentId, doc.id)),
    db.select().from(documentControlEvents).where(eq(documentControlEvents.documentId, doc.id)).orderBy(documentControlEvents.sequence),
    db.select().from(recordAmendments).where(and(eq(recordAmendments.entityType, "commercialDocument"), eq(recordAmendments.entityId, doc.id))).orderBy(recordAmendments.occurredAt),
    // DC-F: what was made from the original, and what was read from it (proposals, never facts).
    db.select().from(documentDerivatives).where(eq(documentDerivatives.documentId, doc.id)).orderBy(documentDerivatives.id),
    db.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id)).orderBy(documentExtractions.id),
  ]);
  const chain: { documentRef: string; version: number; status: string; controlState: string }[] = [];
  let cur: typeof doc | undefined = doc;
  while (cur?.supersedesDocumentId) { cur = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, cur.supersedesDocumentId)).limit(1))[0]; if (cur) chain.unshift({ documentRef: cur.documentRef, version: cur.version, status: cur.status, controlState: cur.controlState }); }
  chain.push({ documentRef: doc.documentRef, version: doc.version, status: doc.status, controlState: doc.controlState });
  cur = doc;
  while (cur?.supersededByDocumentId) { cur = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, cur.supersededByDocumentId)).limit(1))[0]; if (cur) chain.push({ documentRef: cur.documentRef, version: cur.version, status: cur.status, controlState: cur.controlState }); }
  let definition: EffectiveDefinition | null = null;
  try { definition = await definitionFor(db, book, doc.definitionKey ?? doc.documentType); } catch { definition = null; }
  return {
    document: doc,
    provenance: provenanceSentence({ originKind: doc.originKind, issuerKind: doc.issuerKind, issuerName: doc.issuerName, templateRevisionRef: doc.templateRevisionRef, controlNumber: doc.controlNumber }),
    definition: definition ? { definitionKey: definition.definitionKey, displayName: definition.displayName, documentClass: definition.documentClass, numberingPolicy: definition.numberingPolicy, representationPolicy: definition.representationPolicy, representationNotice: definition.representationNotice, revisionPolicy: definition.revisionPolicy, primaryDomainOwner: definition.primaryDomainOwner } : null,
    retention: doc.retentionClass ?? "UNCONFIGURED — retained indefinitely until a person assigns a policy",
    links, references: refs, versions: chain, amendments,
    derivatives: derivatives.map(x => ({ derivativeRef: x.derivativeRef, derivativeKind: x.derivativeKind, producer: x.producer, producerVersion: x.producerVersion, extractionRef: x.extractionRef, contentHash: x.contentHash, sourceContentHash: x.sourceContentHash, mimeType: x.mimeType, byteLength: x.byteLength, storageKey: x.storageKey, actorSource: x.actorSource, createdByUserId: x.createdByUserId, createdAt: x.createdAt })),
    extractions: extractions.map(x => ({ extractionRef: x.extractionRef, proposalId: x.proposalId, ocrEngine: x.ocrEngine, ocrEngineVersion: x.ocrEngineVersion, proposedDocumentType: x.documentType, classificationConfidence: x.classificationConfidence, classificationSource: x.classificationSource, contentSha256: x.contentSha256, fieldCount: x.fieldCount, autoFiledCount: x.autoFiledCount, reviewCount: x.reviewCount, askedCount: x.askedCount, humanOnlyCount: x.humanOnlyCount, status: x.status, extractedAt: x.extractedAt, extractedByUserId: x.extractedByUserId })),
    timeline: events.map(e => ({ sequence: e.sequence, eventType: e.eventType, actorUserId: e.actorUserId, actorSource: e.actorSource, deviceRef: e.deviceRef, previousState: e.previousState, newState: e.newState, detail: e.detailJson ? (JSON.parse(e.detailJson) as Record<string, unknown>) : null, occurredAt: e.occurredAt, recordedAt: e.recordedAt })),
  };
}

/** Which issuer kinds a facility-issued reference may carry when the disposal domain mirrors its number. */
export const DISPOSAL_MIRROR = { table: "disposalTickets", column: "facilityTicketNumber" } as const;

/** Documents in a business's book, by the facets the office searches on. */
export async function listDocuments(db: Db, book: Book, f: { definitionKey?: string; originKind?: OriginKind; issuerKind?: IssuerKind; controlState?: ControlState; recordType?: string; recordRef?: string; recordId?: number; includeSuperseded?: boolean; q?: string; limit?: number }) {
  const conds = [book.bookOrgRef ? eq(commercialDocuments.bookOrgRef, book.bookOrgRef) : isNull(commercialDocuments.bookOrgRef)];
  if (f.definitionKey) conds.push(eq(commercialDocuments.definitionKey, f.definitionKey));
  if (f.originKind) conds.push(eq(commercialDocuments.originKind, f.originKind));
  if (f.issuerKind) conds.push(eq(commercialDocuments.issuerKind, f.issuerKind));
  if (f.controlState) conds.push(eq(commercialDocuments.controlState, f.controlState));
  if (!f.includeSuperseded) conds.push(eq(commercialDocuments.status, "current"));
  if (f.recordType && (f.recordRef || f.recordId != null)) {
    const ids = (await db.select({ documentId: commercialDocumentLinks.documentId }).from(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.recordType, f.recordType), f.recordId != null ? eq(commercialDocumentLinks.recordId, f.recordId) : eq(commercialDocumentLinks.recordRef, f.recordRef!)))).map(x => x.documentId);
    if (!ids.length) return [];
    conds.push(inArray(commercialDocuments.id, ids));
  }
  if (f.q) {
    const pat = `%${f.q}%`;
    const byRef = (await db.select({ documentId: documentExternalReferences.documentId }).from(documentExternalReferences).where(and(eq(documentExternalReferences.bookScopeKey, scopeKeyOf(book)), sql`${documentExternalReferences.referenceValue} LIKE ${pat.toUpperCase()}`))).map(x => x.documentId);
    conds.push(or(sql`${commercialDocuments.documentRef} LIKE ${pat}`, sql`${commercialDocuments.controlNumber} LIKE ${pat}`, sql`${commercialDocuments.title} LIKE ${pat}`, sql`${commercialDocuments.issuerName} LIKE ${pat}`, byRef.length ? inArray(commercialDocuments.id, byRef) : sql`FALSE`)!);
  }
  const rows = await db.select().from(commercialDocuments).where(and(...conds)).orderBy(desc(commercialDocuments.registeredAt)).limit(Math.min(f.limit ?? 200, 500));
  return rows.map(r => ({ ...r, provenance: provenanceSentence({ originKind: r.originKind, issuerKind: r.issuerKind, issuerName: r.issuerName, templateRevisionRef: r.templateRevisionRef, controlNumber: r.controlNumber }) }));
}
