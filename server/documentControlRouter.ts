/**
 * Document Control — the router (DC-A onward).
 *
 * The register itself is the 0144 `commercialOffice.documents.*` surface,
 * extended in later checkpoints. This router carries what Document Control
 * adds on top: the definition registry and its catalog (A), and from B the
 * origin-aware intake, references, links and numbering.
 *
 * Every procedure resolves the acting business from the session
 * (`resolveActingScope`); nothing here reads a tenant from input. A platform
 * definition is readable by every business and changeable by none; a tenant's
 * overlay or own definition is visible only inside that tenant's book.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { documentDefinitions, documentSourceArtifacts } from "../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { seedDocumentCatalog } from "./_core/documentCatalogSeed";
import { CONTROL_STATES, IMPORT_CHANNELS, LINK_ROLES, LINK_SOURCES, REFERENCE_SOURCES } from "./_core/documentRegister";
import { amendDocument, confirmDocument, DocumentControlRefusal, documentView, issueDocument, listDocuments, registerControlledDocument, supersedeDocument, voidDocument, withdrawDocument, type Actor } from "./_core/documentRegisterService";
import { storageKeyInput } from "./_core/storageKey";
import {
  applyOverlay, DEFINITION_KEY_PATTERN, definitionRefusals, DOCUMENT_CLASSES, DOCUMENT_LINK_KINDS, EXTERNAL_REFERENCE_POLICIES, EXTERNAL_REFERENCE_TYPES, ORIGIN_KINDS,
  EXTERNAL_ORIGINS, ISSUER_KINDS, PRINT_POLICIES, READ_CATEGORIES, RENDERED_ORIGINS, representationLabel, REVISION_POLICIES, rowToDefinition, SIGNATURE_POLICIES, TENANT_AUTHORABLE_NUMBERING, TENANT_OVERRIDABLE_COLUMNS,
  type DocumentDefinitionRow, type DocumentDefinitionSeed, type EffectiveDefinition,
} from "./_core/documentDefinitions";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";

async function bookFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = await resolveActingScope(db, userId);
  return { db, bookOrgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId };
}
const j = (v: unknown[]) => JSON.stringify(v);
const tenantRef = () => `DEF-T-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/** A service refusal becomes the TRPC code it names; anything else is rethrown untouched. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof DocumentControlRefusal) throw new TRPCError({ code: e.code, message: e.message }); throw e; }
}
const actorOf = (ctx: { user: { id: number } }, deviceRef?: string | null): Actor => ({ userId: ctx.user.id, source: "human", deviceRef: deviceRef ?? null });
const issuerInput = z.object({ issuerKind: z.enum(ISSUER_KINDS), issuerOrgRef: z.string().max(64).nullable().optional(), issuerFacilityId: z.number().int().positive().nullable().optional(), issuerName: z.string().max(220).nullable().optional() });
const referenceInput = z.object({ referenceType: z.enum(EXTERNAL_REFERENCE_TYPES), referenceValue: z.string().min(1).max(120), issuer: issuerInput.nullable().optional(), source: z.enum(REFERENCE_SOURCES).optional(), confirmed: z.boolean().optional(), duplicateOverrideReason: z.string().min(10).max(300).nullable().optional() });
const linkInput = z.object({ recordType: z.enum(DOCUMENT_LINK_KINDS), recordRef: z.string().min(1).max(80), recordId: z.number().int().positive().nullable().optional(), role: z.enum(LINK_ROLES).nullable().optional(), source: z.enum(LINK_SOURCES).optional(), confirmed: z.boolean().optional() });
const bytesInput = { contentHash: z.string().regex(/^[a-f0-9]{64}$/), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), byteLength: z.number().int().nonnegative().nullable().optional(), mimeType: z.string().max(120).nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional(), fieldTicketDocumentId: z.number().int().positive().nullable().optional(), storageKey: storageKeyInput.nullable().optional() };

/** Platform rows plus this business's rows, folded into the effective view: overlay applied where one exists, tenant-authored rows as their own layer. */
async function effectiveDefinitions(db: Awaited<ReturnType<typeof bookFor>>["db"], bookOrgRef: string | null, includeRetired: boolean): Promise<EffectiveDefinition[]> {
  const rows = (await db.select().from(documentDefinitions).where(bookOrgRef ? or(isNull(documentDefinitions.orgRef), eq(documentDefinitions.orgRef, bookOrgRef)) : isNull(documentDefinitions.orgRef))) as unknown as DocumentDefinitionRow[];
  const platform = rows.filter(r => r.orgRef === null);
  const own = rows.filter(r => r.orgRef !== null);
  const out: EffectiveDefinition[] = [];
  for (const p of platform) {
    if (!includeRetired && p.status !== "active") continue;
    const overlay = own.find(o => o.definitionKey === p.definitionKey && o.status === "active") ?? null;
    out.push(applyOverlay(rowToDefinition(p), overlay));
  }
  const platformKeys = new Set(platform.map(p => p.definitionKey));
  for (const o of own) {
    if (platformKeys.has(o.definitionKey)) continue;
    if (!includeRetired && o.status !== "active") continue;
    out.push(rowToDefinition(o));
  }
  return out.sort((a, b) => a.definitionKey.localeCompare(b.definitionKey));
}

const overlayInput = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  customTemplateAllowed: z.boolean().optional(),
  numberSeriesType: z.string().regex(/^[A-Z][A-Z0-9]{1,23}$/).nullable().optional(),
  printPolicy: z.enum(PRINT_POLICIES).optional(),
  retentionPolicyId: z.number().int().positive().nullable().optional(),
  optionalFields: z.array(z.string().min(1).max(80)).max(200).optional(),
  allowedLinkKinds: z.array(z.enum(DOCUMENT_LINK_KINDS)).max(40).optional(),
  industries: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export const documentControlRouter = router({
  definitions: router({
    /** The catalog as this business sees it. Platform definitions with the business's overlay applied, then the business's own. */
    list: roleProcedure("documentControl.definitionsList")
      .input(z.object({ documentClass: z.enum(DOCUMENT_CLASSES).optional(), packKey: z.string().max(24).optional(), includeRetired: z.boolean().default(false) }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        let defs = await effectiveDefinitions(db, bookOrgRef, input?.includeRetired ?? false);
        if (input?.documentClass) defs = defs.filter(d => d.documentClass === input.documentClass);
        if (input?.packKey) defs = defs.filter(d => d.packKey === input.packKey);
        return defs.map(d => ({ ...d, label: representationLabel(d) }));
      }),
    get: roleProcedure("documentControl.definitionGet")
      .input(z.object({ definitionKey: z.string().regex(DEFINITION_KEY_PATTERN) }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const d = (await effectiveDefinitions(db, bookOrgRef, true)).find(x => x.definitionKey === input.definitionKey);
        if (!d) throw new TRPCError({ code: "NOT_FOUND", message: `No document definition "${input.definitionKey}" in this business's catalog` });
        const artifacts = await db.select().from(documentSourceArtifacts).where(eq(documentSourceArtifacts.definitionKey, input.definitionKey));
        return { definition: { ...d, label: representationLabel(d) }, artifacts: artifacts.map(a => ({ artifactRef: a.artifactRef, sha256: a.sha256, role: a.role, fileName: a.fileName, extension: a.extension, byteLength: a.byteLength, sourceCollection: a.sourceCollection, sourcePackageKey: a.sourcePackageKey, variantNo: a.variantNo, pages: a.pages, hashVerifiedAt: a.hashVerifiedAt, repositoryPath: a.repositoryPath })), overridable: TENANT_OVERRIDABLE_COLUMNS };
      }),
    /**
     * Assert the supplied catalog into the platform registry. Management only;
     * a second run inserts nothing it already holds and says so.
     */
    catalogSeed: roleProcedure("documentControl.catalogSeed")
      .mutation(async ({ ctx }) => {
        const { db } = await bookFor(ctx.user.id);
        return seedDocumentCatalog(db, { importedByUserId: ctx.user.id });
      }),
    /** A business's overlay on a platform definition: only the permitted columns, only in its own book. */
    overlay: roleProcedure("documentControl.definitionOverlay")
      .input(z.object({ definitionKey: z.string().regex(DEFINITION_KEY_PATTERN), changes: overlayInput }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        if (!bookOrgRef) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BLOCKED — an overlay belongs to an organization; the historical single tenant changes the platform catalog through a release, not an overlay" });
        const platform = (await db.select().from(documentDefinitions).where(and(isNull(documentDefinitions.orgRef), eq(documentDefinitions.definitionKey, input.definitionKey), eq(documentDefinitions.status, "active"))).limit(1))[0] as unknown as DocumentDefinitionRow | undefined;
        if (!platform) throw new TRPCError({ code: "NOT_FOUND", message: `No active platform definition "${input.definitionKey}" to overlay` });
        const existing = (await db.select().from(documentDefinitions).where(and(eq(documentDefinitions.orgRef, bookOrgRef), eq(documentDefinitions.definitionKey, input.definitionKey), eq(documentDefinitions.status, "active"))).limit(1))[0] as unknown as DocumentDefinitionRow | undefined;
        const c = input.changes;
        const patch = {
          ...(c.displayName !== undefined ? { displayName: c.displayName } : {}),
          ...(c.description !== undefined ? { description: c.description } : {}),
          ...(c.customTemplateAllowed !== undefined ? { customTemplateAllowed: c.customTemplateAllowed } : {}),
          ...(c.numberSeriesType !== undefined ? { numberSeriesType: c.numberSeriesType } : {}),
          ...(c.printPolicy !== undefined ? { printPolicy: c.printPolicy } : {}),
          ...(c.retentionPolicyId !== undefined ? { retentionPolicyId: c.retentionPolicyId } : {}),
          ...(c.optionalFields !== undefined ? { optionalFieldsJson: j(c.optionalFields) } : {}),
          ...(c.allowedLinkKinds !== undefined ? { allowedLinkKindsJson: j(c.allowedLinkKinds) } : {}),
          ...(c.industries !== undefined ? { industriesJson: j(c.industries) } : {}),
        };
        if (!Object.keys(patch).length) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing to overlay" });
        if (existing) {
          await db.update(documentDefinitions).set(patch).where(eq(documentDefinitions.id, existing.id));
          return { definitionKey: input.definitionKey, overlayRef: existing.definitionRef, created: false };
        }
        // The overlay row starts as a copy of the platform policy so the unoverridden columns read the same; only the permitted ones ever differ.
        const { id: _id, definitionRef: _ref, orgRef: _o, scopeKey: _s, createdByUserId: _c, ...base } = platform as DocumentDefinitionRow & { createdByUserId: number | null; createdAt: Date; activatedAt: Date | null; retiredAt: Date | null; retiredByUserId: number | null };
        const overlayRef = tenantRef();
        await db.insert(documentDefinitions).values({ ...(base as object), ...patch, definitionRef: overlayRef, orgRef: bookOrgRef, scopeKey: bookOrgRef, createdByUserId: ctx.user.id, createdAt: undefined, activatedAt: new Date(), retiredAt: null, retiredByUserId: null, source: `tenant_overlay of ${platform.definitionRef} by user ${ctx.user.id}` } as never);
        return { definitionKey: input.definitionKey, overlayRef, created: true };
      }),
    /**
     * A business's own definition, for paperwork the platform catalog does not
     * name. Its numbering may only be optional-series, external-only or
     * archival: the policies under which LeaseOS never mints for another issuer
     * and never pretends a domain it does not own numbered something.
     */
    create: roleProcedure("documentControl.definitionCreate")
      .input(z.object({
        definitionKey: z.string().regex(DEFINITION_KEY_PATTERN), displayName: z.string().min(1).max(200), description: z.string().max(2000).optional(),
        documentClass: z.enum(DOCUMENT_CLASSES.filter(c => c !== "unclassified") as [string, ...string[]]),
        allowedOrigins: z.array(z.enum(ORIGIN_KINDS)).min(1).max(8),
        numberingPolicy: z.enum(TENANT_AUTHORABLE_NUMBERING as unknown as [string, ...string[]]),
        numberSeriesType: z.string().regex(/^[A-Z][A-Z0-9]{1,23}$/).nullable().optional(),
        externalReferencePolicy: z.enum(EXTERNAL_REFERENCE_POLICIES), allowedExternalReferenceTypes: z.array(z.enum(EXTERNAL_REFERENCE_TYPES)).max(20).default([]),
        allowedLinkKinds: z.array(z.enum(DOCUMENT_LINK_KINDS)).min(1).max(40),
        signaturePolicy: z.enum(SIGNATURE_POLICIES.filter(s => s !== "domain_managed") as [string, ...string[]]),
        revisionPolicy: z.enum(REVISION_POLICIES.filter(r => r !== "domain_managed") as [string, ...string[]]),
        printPolicy: z.enum(PRINT_POLICIES).default("printable"), readCategory: z.enum(READ_CATEGORIES),
        jurisdictions: z.array(z.string().regex(/^(\*|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/)).min(1).max(20).default(["*"]),
        requiredFields: z.array(z.string().min(1).max(80)).max(200).default([]), optionalFields: z.array(z.string().min(1).max(80)).max(200).default([]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        if (!bookOrgRef) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BLOCKED — a tenant-authored definition belongs to an organization" });
        const clash = (await db.select({ id: documentDefinitions.id }).from(documentDefinitions).where(and(eq(documentDefinitions.definitionKey, input.definitionKey), or(isNull(documentDefinitions.orgRef), eq(documentDefinitions.orgRef, bookOrgRef)))).limit(1))[0];
        if (clash) throw new TRPCError({ code: "CONFLICT", message: `"${input.definitionKey}" already names a definition this business can see; overlay it or choose another key` });
        const seed: DocumentDefinitionSeed = {
          definitionKey: input.definitionKey, documentClass: input.documentClass as DocumentDefinitionSeed["documentClass"], displayName: input.displayName, description: input.description ?? null,
          primaryDomainOwner: "document_control", allowedOrigins: input.allowedOrigins, numberingPolicy: input.numberingPolicy as DocumentDefinitionSeed["numberingPolicy"], numberSeriesType: input.numberSeriesType ?? null,
          externalReferencePolicy: input.externalReferencePolicy, allowedExternalReferenceTypes: input.allowedExternalReferenceTypes, leaseosTemplateAvailable: false, customTemplateAllowed: true,
          importAllowed: input.allowedOrigins.some(o => o === "external_scanned" || o === "external_digital_import" || o === "reference_document"),
          requiredFields: input.requiredFields, optionalFields: input.optionalFields, allowedLinkKinds: input.allowedLinkKinds,
          signaturePolicy: input.signaturePolicy as DocumentDefinitionSeed["signaturePolicy"], revisionPolicy: input.revisionPolicy as DocumentDefinitionSeed["revisionPolicy"], printPolicy: input.printPolicy,
          extractionProfileKey: null, readCategory: input.readCategory, sensitivityTier: "INTERNAL", jurisdictions: input.jurisdictions, jurisdictionPolicy: "configurable_verify_by_jurisdiction",
          regulatoryBasis: "not_inferred_from_template", representationPolicy: "internal_record", representationNotice: null, industries: [], packKey: null, sourcePackageKey: null,
          source: `tenant_authored by user ${ctx.user.id}`,
        };
        const problems = definitionRefusals(seed);
        if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: `BLOCKED — ${problems.join("; ")}` });
        const definitionRef = tenantRef();
        await db.insert(documentDefinitions).values({
          definitionRef, orgRef: bookOrgRef, scopeKey: bookOrgRef, definitionKey: seed.definitionKey, definitionVersion: 1, status: "active", documentClass: seed.documentClass, displayName: seed.displayName, description: seed.description,
          primaryDomainOwner: seed.primaryDomainOwner, allowedOriginsJson: j(seed.allowedOrigins), numberingPolicy: seed.numberingPolicy, numberSeriesType: seed.numberSeriesType, externalReferencePolicy: seed.externalReferencePolicy,
          allowedExternalReferenceTypesJson: j(seed.allowedExternalReferenceTypes), leaseosTemplateAvailable: false, customTemplateAllowed: true, importAllowed: seed.importAllowed, requiredFieldsJson: j(seed.requiredFields), optionalFieldsJson: j(seed.optionalFields),
          allowedLinkKindsJson: j(seed.allowedLinkKinds), signaturePolicy: seed.signaturePolicy, revisionPolicy: seed.revisionPolicy, printPolicy: seed.printPolicy, extractionProfileKey: null, readCategory: seed.readCategory, sensitivityTier: "INTERNAL",
          jurisdictionsJson: j(seed.jurisdictions), jurisdictionPolicy: seed.jurisdictionPolicy, regulatoryBasis: seed.regulatoryBasis, representationPolicy: seed.representationPolicy, representationNotice: null, industriesJson: j([]), packKey: null, sourcePackageKey: null,
          source: seed.source, createdByUserId: ctx.user.id, activatedAt: new Date(),
        });
        return { definitionRef, definitionKey: seed.definitionKey, layer: "tenant_authored" as const };
      }),
    /** Retire a business's own definition or overlay. A platform definition is never retired from inside a tenant. */
    retire: roleProcedure("documentControl.definitionRetire")
      .input(z.object({ definitionKey: z.string().regex(DEFINITION_KEY_PATTERN), reason: z.string().min(5).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        if (!bookOrgRef) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BLOCKED — only an organization's own definitions can be retired here" });
        const own = (await db.select({ id: documentDefinitions.id, definitionRef: documentDefinitions.definitionRef }).from(documentDefinitions).where(and(eq(documentDefinitions.orgRef, bookOrgRef), eq(documentDefinitions.definitionKey, input.definitionKey), eq(documentDefinitions.status, "active"))).limit(1))[0];
        if (!own) throw new TRPCError({ code: "NOT_FOUND", message: `This business has no active definition or overlay "${input.definitionKey}" of its own` });
        await db.update(documentDefinitions).set({ status: "retired", retiredAt: new Date(), retiredByUserId: ctx.user.id, description: `retired by user ${ctx.user.id}: ${input.reason}` }).where(eq(documentDefinitions.id, own.id));
        return { definitionRef: own.definitionRef, status: "retired" as const };
      }),
  }),
  /**
   * DC-B — the register, origin-aware. Every write goes through
   * `documentRegisterService`; these procedures decide who may ask.
   */
  documents: router({
    /**
     * Take an external document in: a scan or an upload, its original bytes
     * already in the evidence vault, under the definition a person or an
     * extraction proposes — or as unclassified. It enters captured; nothing
     * here is confirmed, and no LeaseOS number is minted for it.
     */
    intake: roleProcedure("documentControl.documentIntake")
      .input(z.object({
        definitionKey: z.string().regex(DEFINITION_KEY_PATTERN).default("unclassified_external_document"), title: z.string().min(1).max(300),
        originKind: z.enum(EXTERNAL_ORIGINS as unknown as [string, ...string[]]), issuer: issuerInput.default({ issuerKind: "unknown" }), importChannel: z.enum(IMPORT_CHANNELS).default("office_upload"), deviceRef: z.string().max(64).nullable().optional(),
        evidenceRecordId: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().nullable().optional(), mimeType: z.string().max(120).nullable().optional(),
        issuedAt: z.coerce.date().nullable().optional(), counterpartyOrgRef: z.string().max(64).nullable().optional(),
        externalReferences: z.array(referenceInput).max(20).default([]), links: z.array(linkInput).max(20).default([]),
        requestedState: z.enum(["captured", "needs_classification", "proposed"]).default("captured"),
      }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => registerControlledDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx, input.deviceRef), definitionKey: input.definitionKey, title: input.title, originKind: input.originKind as never, issuer: input.issuer, contentHash: input.contentHash, byteLength: input.byteLength, mimeType: input.mimeType, evidenceRecordId: input.evidenceRecordId, issuedAt: input.issuedAt, counterpartyOrgRef: input.counterpartyOrgRef, requestedState: input.requestedState, importChannel: input.importChannel, externalReferences: input.externalReferences, links: input.links }));
      }),
    /**
     * Register something LeaseOS rendered (or a domain minted): a field ticket
     * PDF, an invoice, a completion package. Issued by the tenant, with the
     * number its domain gave it where the definition is domain-managed.
     */
    registerRendered: roleProcedure("documentControl.documentRegisterRendered")
      .input(z.object({
        definitionKey: z.string().regex(DEFINITION_KEY_PATTERN), title: z.string().min(1).max(300), originKind: z.enum(RENDERED_ORIGINS as unknown as [string, ...string[]]),
        ...bytesInput, templateRevisionRef: z.string().max(64).nullable().optional(), renderManifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), controlNumber: z.string().max(64).nullable().optional(),
        issuedAt: z.coerce.date().nullable().optional(), counterpartyOrgRef: z.string().max(64).nullable().optional(), requestedState: z.enum(["issued", "proposed"]).default("issued"),
        externalReferences: z.array(referenceInput).max(20).default([]), links: z.array(linkInput).max(20).default([]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => registerControlledDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx), definitionKey: input.definitionKey, title: input.title, originKind: input.originKind as never, issuer: { issuerKind: "tenant", issuerOrgRef: bookOrgRef }, contentHash: input.contentHash, sourceSnapshotHash: input.sourceSnapshotHash, byteLength: input.byteLength, mimeType: input.mimeType, evidenceRecordId: input.evidenceRecordId, fieldTicketDocumentId: input.fieldTicketDocumentId, storageKey: input.storageKey, issuedAt: input.issuedAt, counterpartyOrgRef: input.counterpartyOrgRef, templateRevisionRef: input.templateRevisionRef, renderManifestHash: input.renderManifestHash, controlNumber: input.controlNumber, requestedState: input.requestedState, importChannel: "system", externalReferences: input.externalReferences, links: input.links }));
      }),
    /** A person says what an external document is, who issued it, and which proposed facts stand. */
    confirm: roleProcedure("documentControl.documentConfirm")
      .input(z.object({ documentRef: z.string().min(1).max(64), definitionKey: z.string().regex(DEFINITION_KEY_PATTERN).optional(), issuer: issuerInput.optional(), title: z.string().min(1).max(300).optional(), issuedAt: z.coerce.date().nullable().optional(), externalReferences: z.array(referenceInput).max(20).default([]), links: z.array(linkInput).max(20).default([]), confirmReferenceRefs: z.array(z.string().max(40)).max(50).default([]), confirmLinkIds: z.array(z.number().int().positive()).max(50).default([]), deviceRef: z.string().max(64).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => confirmDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx, input.deviceRef), ...input }));
      }),
    /** Issue a tenant-produced document. The control number, where the definition mints one, comes from the series (Checkpoint C); a domain-managed number is handed in. */
    issue: roleProcedure("documentControl.documentIssue")
      .input(z.object({ documentRef: z.string().min(1).max(64), controlNumber: z.string().max(64).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => issueDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx), documentRef: input.documentRef, controlNumber: input.controlNumber ?? null }));
      }),
    void: roleProcedure("documentControl.documentVoid")
      .input(z.object({ documentRef: z.string().min(1).max(64), reason: z.string().min(10).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => voidDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx), ...input }));
      }),
    supersede: roleProcedure("documentControl.documentSupersede")
      .input(z.object({ documentRef: z.string().min(1).max(64), reason: z.string().min(10).max(500), ...bytesInput, templateRevisionRef: z.string().max(64).nullable().optional(), renderManifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), title: z.string().min(1).max(300).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => supersedeDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx), ...input }));
      }),
    withdraw: roleProcedure("documentControl.documentWithdraw")
      .input(z.object({ documentRef: z.string().min(1).max(64), reason: z.string().min(10).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => withdrawDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx), ...input }));
      }),
    /** A keyed-fact correction under amend_with_reason: original and corrected values are kept side by side; the bytes never change. */
    amend: roleProcedure("documentControl.documentAmend")
      .input(z.object({ documentRef: z.string().min(1).max(64), reason: z.string().min(10).max(500), changes: z.object({ title: z.string().min(1).max(300).optional(), issuedAt: z.coerce.date().nullable().optional(), issuerName: z.string().max(220).nullable().optional(), issuerFacilityId: z.number().int().positive().nullable().optional(), issuerOrgRef: z.string().max(64).nullable().optional() }) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => amendDocument(db, { book: { bookOrgRef }, actor: actorOf(ctx), ...input }));
      }),
    get: roleProcedure("documentControl.documentGet")
      .input(z.object({ documentRef: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return guarded(() => documentView(db, { bookOrgRef }, input.documentRef));
      }),
    list: roleProcedure("documentControl.documentsList")
      .input(z.object({ definitionKey: z.string().regex(DEFINITION_KEY_PATTERN).optional(), originKind: z.enum(ORIGIN_KINDS).optional(), issuerKind: z.enum(ISSUER_KINDS).optional(), controlState: z.enum(CONTROL_STATES).optional(), recordType: z.enum(DOCUMENT_LINK_KINDS).optional(), recordRef: z.string().max(80).optional(), recordId: z.number().int().positive().optional(), includeSuperseded: z.boolean().default(false), q: z.string().max(120).optional(), limit: z.number().int().positive().max(500).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        return listDocuments(db, { bookOrgRef }, input ?? {});
      }),
  }),
  artifacts: router({
    /** The supplied catalog's provenance: every source artifact by hash, optionally for one family. */
    list: roleProcedure("documentControl.sourceArtifactsList")
      .input(z.object({ definitionKey: z.string().regex(DEFINITION_KEY_PATTERN).optional(), sourceCollection: z.string().max(120).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { db } = await bookFor(ctx.user.id);
        const conds = [];
        if (input?.definitionKey) conds.push(eq(documentSourceArtifacts.definitionKey, input.definitionKey));
        if (input?.sourceCollection) conds.push(eq(documentSourceArtifacts.sourceCollection, input.sourceCollection));
        const rows = await (conds.length ? db.select().from(documentSourceArtifacts).where(and(...conds)) : db.select().from(documentSourceArtifacts));
        return rows.map(a => ({ artifactRef: a.artifactRef, sha256: a.sha256, sourceCollection: a.sourceCollection, sourcePath: a.sourcePath, fileName: a.fileName, extension: a.extension, byteLength: a.byteLength, role: a.role, definitionKey: a.definitionKey, sourcePackageKey: a.sourcePackageKey, variantNo: a.variantNo, pages: a.pages, templateCodeDetected: a.templateCodeDetected, revisionDetected: a.revisionDetected, hashVerifiedAt: a.hashVerifiedAt, importBatchRef: a.importBatchRef }));
      }),
  }),
});
