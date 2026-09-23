# LeaseOS — Document Control: Design (Checkpoint 0, revised for template-independent documents)

Status: **design only — not approved for implementation.** No migration is created or reserved by this
document. No production code is changed. This revision incorporates the owner's architectural expansion:
Document Control must not depend on a LeaseOS template existing, and templated, company-form and
scanned third-party documents must all land in the same authoritative record layer.

| | |
|---|---|
| Surveyed at | `main` = `0cd4817cca5ca7cfa66af8984bcf02b7268edbdb`, branch `claude/document-control-architecture-jlffzk` (no commits ahead of `main` before this document) |
| Migration head on `main` | `0174_dispatch_override_provenance.sql` (0172/0173 claimed by open branches; 0175 earmarked by the compliance plan; **this design names no slot** — assigned at PR time per `docs/architecture/MIGRATION_COLLISION_REGISTER.md`) |
| Prior on-disk checkpoint | **None.** No file in the repository described Document Control before this one; the earlier checkpoint discussion existed only in conversation. This is therefore the first written version, and §26 records what the expansion changed relative to that discussion. |
| Companion | (none yet) — an implementation plan follows only after this design is reviewed |

The question Document Control must answer is:

> For this job, load, unit, person or period: which documents exist, who issued each one, is the copy we
> hold the original or a rendering, which version is in force, what LeaseOS-authoritative facts is it
> linked to, and can we prove none of it was altered?

LeaseOS already holds most of the parts of that answer. It holds them in a document register that
already exists (`commercialDocuments`, migration 0144), an evidence vault with seals and legal holds, a
configurable number counter, a proposal-and-confirm pipeline, a device-attested signature chain, and an
audit-package assembler. This design **extends** those. It does not add a parallel register, a second
allocator, a second seal scheme, or a second review queue.

---

## 0. Binding constraints

**0.1 The SPINE moratorium.** `docs/compliance/unified-compliance-engine-design.md` §0 records the
standing rule from `SPINE_WIRING_PLAN.md`: *"no new engines until this path is wired."* Document
Control is written so that its first checkpoint is not a new engine: it is columns and tables added
beside the 0144 register, an allocation ledger added beside the existing counter, and procedures added
under the existing permission maps. Whether that reading is accepted is **owner decision D-DC-01**.
Everything that requires the AI runtime (OCR classification wiring, the AI Secretary preparing forms)
is sequenced after the moratorium lifts and is marked as such.

**0.2 Existing engines are reused, not rebuilt.** §22 lists them by name with file references. The
recurring defect in this repository is a second vocabulary for an existing thing
(`docs/hybrid-seam/HS_CONTRACTS.md:113`, `docs/register/SCOPE_RECONCILIATION_2026-09-21.md` header).
Where this design proposes a name, it first states which existing name was searched for.

**0.3 No regulatory facts are invented.** Retention periods, required-field lists imposed by a
regulator, and jurisdiction rules ship as data with `statutorySourceStatus = unverified` and evaluate to
UNKNOWN until a person verifies them (`server/_core/retentionPolicy.ts:22` invariant #10;
`LEASEOS_B20_20_V20_21_COMPLIANCE_REGISTRY.md:52`). This design contains none.

**0.4 Propose → show evidence → human confirm → commit.** The ground rule from
`docs/REMAINING_BUILD_REGISTER.md:9-12` applies to every path that turns bytes into a record.

---

## 1. Current-state survey (what exists, with the file that proves it)

### 1.1 A document register already exists

`commercialDocuments` / `commercialDocumentLinks` / `commercialDocumentDeliveries`
(`drizzle/schema.ts:8633-8681`, `drizzle/0144_commercial_document_registry.sql`, procedures
`commercialOffice.documents.{register,supersede,withdraw,link,retentionAssign,deliveryRecord,
deliveryUpdate,get,list}` at `server/commercialOfficeRouter.ts:549-685`).

What it already has: a unique `documentRef` (a `DOC-` number from `nextTrackingNumber`), `bookOrgRef`
tenancy, a `documentType` validated against `commercialCategoryTypes` rows of kind `document_type`
(`schema.ts:8360`; ten built-ins seeded in 0144: invoice, credit_note, statement, manifest,
field_ticket, disposal_ticket, vendor_bill, purchase_order, remittance, audit_package; businesses may add
their own), `version` + `supersedesDocumentId` + `supersededByDocumentId`, a required SHA-256
`contentHash`, an optional `sourceSnapshotHash`, a byte pointer that must be one of `evidenceRecordId`
| `fieldTicketDocumentId` | `storageKey`, `counterpartyOrgRef`, `issuedAt`, `retentionPolicyId` +
`retentionClass`, and status `current | superseded | withdrawn` with `statusReason`. Withdrawal is
refused under legal hold. Links carry forward on supersede. Audit packages already gather from it
(`server/auditRouter.ts:26`, `registryDocumentsFor`).

What it lacks, and what this design adds: origin and issuer provenance, a definition (behaviour) key
separate from the label, a business control number distinct from the archival `DOC-` ref, a review
lifecycle for documents that arrive as bytes before they are understood, external identifiers, template
provenance, and automatic registration of the PDFs LeaseOS itself renders.

### 1.2 Bytes, hashes, seals, holds, retention

* `evidenceRecords` (`schema.ts:48`): `storageKey`, `mimeType`, `trackingNumber` (unique),
  `clientCaptureRef` (unique; makes an offline upload idempotent), `sealState`, `currentVersion`,
  `legalHold`. **No hash at upload**, **no orgRef** (scope through job or capturer,
  `server/db.ts:854-863`).
* `evidenceVersions` / `evidenceSeals` (`schema.ts:2756/2772`) with `sealEvidence`,
  `amendSealedEvidence`, `verifySealAgainstStored` (`server/_core/evidenceSeal.ts:139/214/271`).
  SHA-256 hex everywhere; canonical manifest; a seal needs at least one relationship; an unreadable
  object is `content_unavailable`, never a pass.
* `evidenceRelationships` (`schema.ts:2737`): closed `entityType` enum of 24 values, `entityId` or
  `entityRef`, `role`.
* Storage: `storagePut` / `storageGetSignedUrl` / `storageRead` (`server/storage.ts:51/97`), key
  validation `server/_core/storageKey.ts`. No durable URLs (0168).
* `retentionPolicies` (`schema.ts:2797`) with `statutorySourceStatus` default `unverified`;
  `computeEffectiveRetention` (`server/_core/retentionPolicy.ts:77`). **No writer and no seed exist**;
  the evidence path uses a hard-coded `DEFAULT_POLICY` (`server/recordsRouter.ts:61-70`).
* `legalHolds` / `legalHoldRecords` (`schema.ts:2838/2856`): evidence-only; `hasActiveLegalHold`
  (`server/recordsService.ts:290`).
* `restrictedVault.serveRestricted` (`server/_core/restrictedVault.ts:220`) and
  `restrictedAccessGrants/Events` for RESTRICTED material; category-neutral `MTR-` numbers.

### 1.3 Rendering, signatures, printing

* One renderer, `renderPdf(title, lines)` (`server/_core/ticketPdf.ts:18`), hand-written PDF 1.4,
  base-14 fonts, ASCII only, deterministic for identical lines. Callers: field ticket revisions and the
  completion package (`server/closeoutRouter.ts:328-361, ~485-515`), invoices
  (`server/invoicingRouter.ts:58-77`), audit package cover (`server/auditRouter.ts:205-221`). Output
  rows: `fieldTicketDocuments` (`schema.ts:5066`, `contentHash` + `sourceSnapshotHash`). **No renderer
  or template version is stored anywhere. No layout template concept exists** — layouts are line
  builders in code. `formDefinitions` (`schema.ts:2172`) and `dispatchTemplates` have no server usage;
  the live capture forms are `FORMS` in `server/_core/aiProposal.ts:112`.
* Signatures: `fieldTicketSignatures` via `recordSignature` (`server/closeoutRouter.ts:~52-97`),
  methods `drawn|device_auth|pin|paper_scan|portal_link`, device attestation
  `checkSignatureAttestation` over `canonicalSignaturePayload({ticketNumber, revision, payloadHash,
  signerName, signedAt})` (`server/_core/deviceSignature.ts:145/102`), no biometric material stored.
  `signatoryAuthorities` + `signatureDecision` (`server/_core/siteCloseout.ts:111`). Internal
  approvals: `commercialApprovalService.decide`. Academy certificate signatures use a non-cryptographic
  FNV `stableHash` (`server/_core/trainingAcademy.ts:36`).
* **No print or reprint audit exists.** `evidenceAccessEvents.action` already contains `printed`
  (`schema.ts:3041`) and nothing writes it. `sheetSerialAllocations.state` and
  `academyAssessmentSheets.state` contain `printed` and nothing moves rows there.

### 1.4 Numbering

* `trackingSequences` + `nextTrackingNumber(db, {sequenceType, branch?, at?, format?})`
  (`schema.ts:934`, `server/_core/trackingNumbers.ts:60`): configurable prefix/separator/year/month/
  width/reset, `LAST_INSERT_ID` discipline, wired to FT, INV, BB, CR, WO(write-off), DSP, DLY, SIG,
  ORG, DOC, MRO, CSW; guarded by `server/trackingNumberCoverage.test.ts`. **Not gapless**: minted in
  its own transaction before the record insert (`closeoutRouter.ts:140-142` burns an FT number on
  NOT_FOUND); **no allocation ledger**; **no orgRef** (per-business scoping is the
  `${type}@${hash8(bookOrgRef)}` workaround at `commercialOfficeRouter.ts:108-110`).
* `commercialNumberingPolicies` + `numberingPolicyFor` (`schema.ts:8323`,
  `server/_core/commercialPolicy.ts:57`): per-business format configuration, only applied to CLI/VEN
  today.
* `sheetSerialAllocations` + `allocateSerialBlock` (`schema.ts:8237`,
  `server/_core/sheetSerialAllocator.ts:128`): the only ledger-backed allocation — a `reserved|printed|
  voided` row written **in the same transaction** as the counter bump, "so a gap is always
  explainable". `docs/REMAINING_BUILD_REGISTER.md:25` rules that `trackingSequences` is the counter
  and a second allocator is the duplication to avoid.
* `trackingReferences` (`schema.ts:951`): designed as the number → (entityType, entityId) index with
  delegation fields; **no production writer**.
* Client-supplied numbers still exist for `jobCode`, `manifestNumber`, `workOrderNumber`,
  `incidentNumber`, `tailgateMeetings.trackingNumber`.

### 1.5 Scan, OCR, proposals, commit

* Pure engines with **no production caller**: `classifyDocument`, `extractToProposal`, `disposeField`,
  `CONFIDENCE_POLICY`, `ALWAYS_HUMAN` (`server/_core/documentExtraction.ts:27-391`); `DocumentType =
  expense_receipt | fuel_receipt | disposal_ticket | load_ticket | scale_ticket | invoice |
  safety_document | unknown`. An unclassifiable upload does not fail: it returns `unknown` with a refusal
  "file it as evidence, do not extract" and the evidence row stays `needs_review`.
* Wired and transactional: `assistantProposals` / `proposalFields` (`schema.ts:2182/2235`, field
  `source` includes `photo_ocr`, `status` `proposed|confirmed|rejected|corrected`), `checkCommit`
  (`server/_core/aiProposal.ts:621`, refuses without an acknowledged read-back and re-run inside the
  commit transaction), `planAssistantCommit` adapter registry (`server/_core/assistantCommitAdapters.ts:
  785`, unknown form fails closed), `executeAssistantCommit` (`server/_core/assistantCommitService.ts:
  114`, one receipt per proposal, second authorization, fingerprint gate, auto-file to
  `evidenceRelationships`).
* Dedupe: `documentFingerprints` + `assessDuplicate` + `commitPermittedUnder`
  (`server/_core/documentFingerprint.ts:188/235`): `exact_duplicate` refused even with override;
  `possible_duplicate` needs a recorded human override; global scope (no org column).
* Disposal already has a photo-OCR form (`aiProposal.ts:289`) and adapter (`assistantCommitAdapters.ts:
  ~585-689`): server-resolved load and facility, OCR'd `facilityName` is a hint only, one facility
  ticket per load, gross − tare = net within 20 kg, lands `needs_review`, `chainState` untouched.
* `documentValidity.ts` states the rule this design inherits: *"a document on file is not a document
  in force"*; `validityOf` is the one validity function (`server/_core/documentValidity.ts:2/72`).

### 1.6 Field runtime and offline

`LocalCapture` (`client/src/runtime/contracts.ts:35`) with vault-referenced files and SHA-256; `Outbox`
refuses a capture with no job or unit; nothing unsynchronised is ever deleted; `SyncEngine.syncOnce`
uploads **only `files[0]`** (`syncEngine.ts:139` — a multi-page scan loses pages beyond the first);
signed packages, nonces, `admitPackage`, `verifyPackageItems` (declared = computed = seal). Offline
class per capability (`server/_core/offlineCapability.ts:31`): `server_authoritative` records may not
be created on a device; a device assessment travels as a claim.

### 1.7 Authorization, tenancy, events, search

* Role + closed `Permission` union (`server/recordsAuthorization.ts:45`), `roleProcedure(name)` with an
  unmapped name throwing at wiring time, `authorizationDecisions` row per call, evidence read
  per-category, SENSITIVE permissions fail closed. External identities via `externalProcedure` and
  `EXTERNAL_KIND_PERMISSIONS`.
* Tenancy: `orgRef varchar(64)` (NULL = historical single tenant) on 38 tables, `bookOrgRef` on 13
  commercial tables, `resolveActingScope` never from input.
* Events: `emitDomainEvent(tx, …)` (`server/_core/eventEmitter.ts:115`) into `domainEventOutbox`;
  typed emitters in `domainEmitters.ts` have no production caller; only enforcement publishes today.
* Search: `surfaces.search` → `searchEverything(q)` (`server/surfacesService.ts:206`), `LIKE` over 14
  reference columns including `disposalTickets.facilityTicketNumber`; not tenant-scoped; no document
  title search. `walkEvidenceChain` (`server/_core/evidenceChainWalk.ts:112`) is the per-job chain.

### 1.8 Domain owners Document Control links to (authority stays with them)

| Domain | Owns | Document Control may only |
|---|---|---|
| Closeout / custody (`fieldTickets`, `fieldTicketRevisions`, `manifests`, `manifestCustodyEvents`, `manifestAmendments` with DB trigger `manifests_seal_guard`) | ticket lifecycle, signature state, custody events, acceptance/rejection at facility, sealed snapshot hashes | register the rendered artifact, link it, mirror its number |
| Disposal (`disposalTickets.facilityTicketNumber`, `verificationStatus`, weights, `disposalReconciliation`, `facilityStatements` matching) | facility ticket number, measured quantities, verification | hold the scan, link it to the disposal ticket / load, mirror the facility number as an external reference |
| Compliance / Academy (`complianceDocuments`, `academyQualifications`, `academyCertificates`, `validityOf`) | verification state, issued/expiry facts, in-force verdicts, qualification grants | hold the file as evidence; never compute validity |
| Fleet / readiness (`readinessComposer`, `mechanicRelease`, `outOfServiceOrders`, `insurancePolicies/Certificates`) | unit service state, release, OOS, policy facts | hold the CVIP/insurance file and reference `certificateRef`/`policyNumber` |
| HOS (`dutyRecords`, `hosAttestations`, `hosRuleProfiles`) | duty events, clocks, attestations ("a correction is a second statement, not an edit") | archive exported or scanned artifacts; a document never satisfies an HOS check |
| Billing / AR / AP (`invoices`, `customerPurchaseOrders`, `vendorBills`, `fuelStatements`, `expenseRecords`) | PO/AFE values, amounts, tax treatment, match outcomes | hold the PO/receipt/statement file and point at the record |
| Safety (`incidentReports`, `nearMissReports`, `tailgateMeetings`, `incidentMatters` in the restricted vault) | incident facts, statements, escalation, sensitivity tier | link by `trackingNumber`; route RESTRICTED material through `serveRestricted` |

---

## 2. Reuse matrix

Legend: **R** reuse as is · **E** extend · **N** new, justified · **U** unify (one vocabulary replaces
several).

| Capability | Existing | Missing | R/E/N/U | Proposed work (checkpoint) |
|---|---|---|---|---|
| Authoritative document record | `commercialDocuments` + links + deliveries (0144) | origin/issuer, definition key + version, control number, control state, template ref, capture device | **E** | DC1 |
| Document behaviour definition | `commercialCategoryTypes(kind=document_type)` = label catalog; `FORMS` in code = capture fields | behaviour policies (numbering, origin, signature, revision, print, extraction, links, jurisdictions) | **N** (`documentDefinitions`), keyed to the existing category key | DC1 |
| Origin / provenance | `disposalTickets.source`, `proposalFields.source`, `importBatches.confidence`, `manifestPartySnapshots.source` (all local) | one origin vocabulary on the record | **U** into `originKind` + `issuerKind` on the register row | DC1 |
| External identifiers | `disposalTickets.facilityTicketNumber`, `facilityStatementLines.facilityTicketNumber`, `tripStops.ticketNumber`, `loads.loadTicketNumber`, `customerPurchaseOrders.poNumber`, `vendorBills.vendorInvoiceNumber`, `insurancePolicies.policyNumber`, `complianceDocuments.identifier` | an issuer-scoped reference table that indexes all of them and holds the ones no domain owns | **N** (`documentExternalReferences`) as an index + holder; domain columns stay authoritative | DC1 |
| Entity links | `commercialDocumentLinks` (string ref), `evidenceRelationships` (enum), `manifestEvidenceLinks`, `complianceDocuments.ownerType`, `auditPackageItems.sourceTable` | one link vocabulary; id beside ref; role; proposed/confirmed | **E** `commercialDocumentLinks` + **U** vocabulary catalog (`documentLinkKinds`, code) | DC1 |
| Controlled number series | `trackingSequences` + `nextTrackingNumber` + `commercialNumberingPolicies`; `sheetSerialAllocations` ledger discipline; `trackingReferences` (unwired) | `orgRef` scope, allocation ledger, tx-bound minting, void, gap report | **E** counter, **N** ledger (`numberAllocations`) borrowed from sheet serials, **wire** `trackingReferences` | DC1 |
| Bytes, hash, seal | `evidenceRecords/Versions/Seals`, `storage.ts`, `documentFingerprint` | hash at upload; multi-file upload | **R** + two defect fixes | DC1 (hash), DC3 (multi-page) |
| Retention, legal hold | `retentionPolicies`, `computeEffectiveRetention`, `legalHolds` | policy writer/seed; hold on a register row; UNCONFIGURED state | **E** | DC1 (UNCONFIGURED read path), later (policy CRUD) |
| Revisions / corrections | `commercialDocuments` supersede chain; `manifestAmendments` (reason code, two-person, hash chain, trigger); `recordAmendments` (unwired) | per-definition revision policy | **R** register chain; **wire** `recordAmendments` for field-level corrections | DC1 (policy column), DC2 (amend) |
| Audit history | `emitDomainEvent` + outbox; `evidenceAccessEvents`; `externalAccessLog` | document events actually emitted; print action written | **R** + first real publisher outside enforcement | DC1 |
| Permissions | `roleProcedure`, permission maps, `authorizationDecisions`, `externalProcedure` | `documentControl.*` permissions | **E** maps | DC1 |
| Templates and rendering | `renderPdf` (text only), `fieldTicketDocuments` | template + revision entities, layout hash, mapping hash, renderer version, non-ASCII/graphics renderer | **N** (`documentTemplates`, `documentTemplateRevisions`), renderer choice is **D-DC-05** | DC2 |
| Company form import | — | upload, field mapping, released revision | **N**, phased (§7) | DC2/DC3 |
| Scanner without template | `evidence.upload`, `classifyDocument`, `extractToProposal`, proposals, fingerprints, disposal adapter | intake procedure creating the register row *before* classification; `document_control_confirm` adapter; unclassified state | **E** pipeline; **N** one adapter case | DC1 (manual intake, no OCR), DC3 (OCR wiring, post-moratorium) |
| Print / reprint | `evidenceAccessEvents.printed` (unwritten), `commercialDocumentDeliveries.channel=print` | print event with device, copy marking | **E** | DC4 |
| Jurisdiction packs | `"CA-AB"`-style codes, `"*"`, `compliancePacks` seeds, `companyPackActivations`, verified-source columns | definition packs | **R** pattern, **N** seed sets (`core`, `canada`, `alberta`; `us` empty) | DC1 (core+alberta labels only, no regulatory content) |
| AI Secretary | `secretaryCoordination`, `actionGateway`, `aiProposal`, `ALWAYS_HUMAN` | "this job requires these forms" | **R** engines; **N** `documentRequirementProfiles` generalising `manifestEvidenceProfiles` | DC5 (post-moratorium) |
| Search | `searchEverything`, `walkEvidenceChain` | register columns and external refs in search; tenant scope | **E** | DC1 |
| Audit packages | `auditPackage.assemble`, `registryDocumentsFor` | nothing for DC1 (register rows flow in already) | **R** | — |

---

## 3. Conceptual architecture

```
LeaseOS Standard Template ──┐
Organization Custom Template ├─► Generated / filled document ──┐
Customer-Supplied Template ──┤                                 │
External / Regulatory Form ──┘                                 │
                                                               ├─► DOCUMENT CONTROL
System-rendered artifact (invoice, completion package, cover) ─┤   (the 0144 register, extended)
                                                               │   documentRef always · controlNumber
External paper ─► scan/upload ─► evidenceRecords (sealed)      │   sometimes · origin + issuer always
   ─► classification proposal ─► human confirmation ───────────┤   · links · external refs · revisions
External digital ─► import/portal/API ─► evidenceRecords ──────┘   · retention · audit history
```

Three rules hold in every path:

1. **The register row is the authoritative record; the evidence record is the bytes.** A register row
   points at bytes (`evidenceRecordId` | `fieldTicketDocumentId` | `storageKey`, as 0144 already
   requires). The bytes are sealed and never edited. A new version is a new register row.
2. **A template is optional. An origin is not.** Every register row states `originKind` and
   `issuerKind`. `templateRevisionRef` is NULL for anything not produced from a template.
3. **A number is minted only where LeaseOS is the issuer on the tenant's behalf.** A document issued
   by a facility, a regulator, a manufacturer or a customer carries that issuer's identifier as an
   *external reference*; LeaseOS never fabricates a business number for it. The archival `DOC-`
   `documentRef` exists on every row regardless.

---

## 4. Document Definition registry

Name searched for first: `formDefinitions` (exists, unused, capture-field shape only),
`commercialCategoryTypes(document_type)` (label + key only), `dispatchTemplates` (dispatch recurrence,
not documents), `FORMS` (capture forms in code). None describes *behaviour*. The proposed name is
`documentDefinitions`; its `definitionKey` **is** the `commercialCategoryTypes.categoryKey` of kind
`document_type`, so the 0144 register's `documentType` validation keeps working unchanged. Activating
a definition upserts its category row (built-in, source = the definition ref).

### 4.1 Proposed `documentDefinitions` (one row per definition version)

| Column | Type / values | Meaning |
|---|---|---|
| `definitionRef` | varchar(64) unique, `DEF-…` | immutable identity of this version |
| `orgRef` | varchar(64), NULL = platform-provided | tenant overlay; platform rows are `builtIn` |
| `definitionKey` | varchar(40), `^[a-z][a-z0-9_]{1,39}$` | e.g. `field_ticket`, `disposal_ticket`, `external_disposal_receipt`, `sds`, `unclassified_external_document` |
| `definitionVersion` | int | unique (`orgRef`, `definitionKey`, `definitionVersion`) |
| `status` | `draft \| active \| retired` | exactly one `active` per (org, key); a retired version stays readable for records that cite it |
| `supersedesDefinitionId` | int | chain |
| `documentClass` | `operational_form \| controlled_credential \| financial_commercial \| regulated_record \| reference_document \| incident_evidence \| unclassified` | the behavioural class from the catalog (§9) |
| `displayName`, `description` | text | |
| `primaryDomainOwner` | `document_control \| closeout \| custody \| disposal \| compliance \| academy \| fleet \| insurance \| hos \| billing \| safety \| restricted_vault` | who owns the *facts*; Document Control owns the artifact |
| `allowedOriginsJson` | JSON array of `originKind` (§5) | e.g. SDS: `["external_digital_import","external_scanned","reference_document"]` |
| `numberingPolicy` | enum (§6.1) | |
| `numberSeriesType` | varchar(24), nullable | the `trackingSequences.sequenceType` used when the policy mints |
| `externalReferencePolicy` | `forbidden \| optional \| required` | |
| `allowedExternalReferenceTypesJson` | JSON array | subset of the reference-type catalog (§6.4) |
| `leaseosTemplateAvailable` | boolean | informational; a released `documentTemplates` row of source `leaseos_standard` is the fact |
| `customTemplateAllowed` | boolean | may a tenant or customer template be released for this key |
| `importAllowed` | boolean | may bytes enter without a template (scan/upload/portal/API) |
| `requiredFieldsJson`, `optionalFieldsJson` | JSON arrays of semantic field keys (§12) | what must be confirmed before `issued` / `confirmed` |
| `allowedLinkKindsJson` | JSON array from `documentLinkKinds` (§6.5) | e.g. field ticket: job, load, trip, unit, operator, customer_account |
| `signaturePolicy` | `none \| optional \| required_single \| required_multi \| domain_managed` | `domain_managed` = the owning domain's signature chain (field tickets, certificates) |
| `revisionPolicy` | `immutable_supersede \| amend_with_reason \| domain_managed \| reference_versioned` | see §6.6 |
| `printPolicy` | `not_printable \| printable \| controlled_copy` | `controlled_copy` = every print is an audited copy with a copy number |
| `extractionProfileKey` | varchar(40), nullable | the `documentExtraction.DocumentType` / `FORMS` key used when bytes arrive; NULL = no extraction offered |
| `retentionPolicyId` | int, nullable | NULL = **UNCONFIGURED**: retained indefinitely, disposition never eligible, surfaced as a finding (the restricted-vault doc §9 stance, `docs/knowledge/source/LEASEOS_RESTRICTED_RECORDS_VAULT.md:492-527`) |
| `workflowKey` | varchar(40), nullable | state-machine policy beyond the register's own `controlState` (§6.7); NULL = register lifecycle only |
| `readCategory` | varchar(40) | the evidence read category the record is served under (`evidence.read_<category>`; a new category reaches nobody until granted) |
| `sensitivityTier` | `INTERNAL \| CONFIDENTIAL \| RESTRICTED \| HIGHLY_RESTRICTED` (existing vocabulary, `restrictedVault.ts:23`) | RESTRICTED and above are served only through `serveRestricted` |
| `jurisdictionsJson` | JSON array of codes (`"CA-AB"`, `"CA"`, `"US"`, `"*"`) | applicability, same code style as `complianceRequirements` |
| `industriesJson` | JSON array | e.g. `["oilfield","fluid_hauling","general_freight"]`; informational for the catalog UI |
| `packKey` | varchar(24) | the seed pack that shipped it (`core`, `canada`, `alberta`, `us`, or NULL for tenant-authored) |
| `source` | varchar(160) not null | provenance of the definition itself (same discipline as `commercialCategoryTypes.source`) |
| `createdByUserId`, `createdAt`, `activatedAt`, `retiredAt` | | |

**What the definition is not.** It is not the document. It is not a template (a template is one way of
producing a document under a definition). It is not a regulatory requirement (a requirement, when one
exists, lives in `complianceRequirements` with a verified source and *references* a definition key).

**Overlay rule.** A tenant row with the same `definitionKey` as a platform row overrides only the
columns a tenant is allowed to override: `customTemplateAllowed`, `numberSeriesType`, `printPolicy`,
`retentionPolicyId`, `optionalFieldsJson`, `allowedLinkKindsJson` (superset only), `displayName`. A
tenant may not loosen `numberingPolicy`, `allowedOriginsJson`, `signaturePolicy`, `revisionPolicy` or
`sensitivityTier` of a platform definition. The allowed-override set is a code constant, tested.

**Why columns and not one policy JSON.** Every enforced policy is a column so the database and the
type system carry it; JSON is used only for extensible lists (fields, links, jurisdictions). This is
the same split `retentionPolicies` and `complianceRequirements` already use.

### 4.2 Tenant-authored definitions without schema changes

A tenant creates a definition row (`orgRef` set, `packKey` NULL) with `documentClass`,
`allowedOriginsJson`, a `numberingPolicy` of `leaseos_series_optional` | `external_only` |
`archival_only`, and its own field and link lists. No table is added per document type. The catalog
(§9) is therefore seed data, and the fifteen representative classes in §20 are rows.

---

## 5. Origin and provenance model

Names searched for first: `source` (used locally on `disposalTickets`, `proposalFields`,
`importBatches`, `dutyRecords`), `capturedBy`, `actorSource` (outbox: `human|system|ai|integration`).
None is a document origin. Two new columns on the register row:

**`originKind`** — how the document came to exist in LeaseOS:

| Value | Meaning | Template? | Bytes are |
|---|---|---|---|
| `leaseos_generated` | filled and rendered by LeaseOS from a released **LeaseOS standard** template revision on the tenant's behalf | required | a rendering |
| `organization_template` | filled and rendered by LeaseOS from the tenant's own released template revision | required | a rendering |
| `customer_template` | filled and rendered by LeaseOS from a customer/consultant-supplied released template revision | required | a rendering |
| `external_form_rendered` | LeaseOS filled an approved regulator or third-party form; LeaseOS does not own the form definition | required | a rendering |
| `system_rendered` | rendered by code from a frozen snapshot with no template (today: field ticket R1/R2, completion package, invoice, audit cover) | none | a rendering |
| `external_scanned` | paper photographed or scanned; LeaseOS holds the image | none | the original scan (immutable evidence) |
| `external_digital_import` | a file or payload that arrived by upload, portal, email or API | none | the original file/payload |
| `reference_document` | a published document LeaseOS merely holds (SDS, policy, procedure, contract) | none | the publisher's file |

**`issuerKind`** — who issued the document, with resolution columns:

| Value | `issuerOrgRef` | `issuerFacilityId` | `issuerName` |
|---|---|---|---|
| `tenant` (the operating company; LeaseOS is never the issuer) | the tenant | — | — |
| `customer` | customer org when linked | — | captured text otherwise |
| `facility` | facility's org when known | facility row | captured text otherwise |
| `vendor` | vendor org when linked | — | captured text |
| `regulator` / `government_authority` | — | — | captured text |
| `manufacturer` (SDS) | — | — | captured text |
| `other_third_party` | — | — | captured text |
| `unknown` | — | — | captured text or NULL (allowed only while `controlState` is `captured`/`needs_classification`) |

Also on the row: `capturedByUserId`, `capturedByDeviceRef` (from `fieldDevices.deviceRef` when the
bytes came through a sync package), `importChannel` (`device_sync | office_upload | portal | api |
email`), `issuedAt` (the date printed on the document, as confirmed — never OCR-only).

**Invariants (enforced in the one register write path, tested):**

* `originKind ∈ {leaseos_generated, organization_template, customer_template, external_form_rendered,
  system_rendered}` ⇒ `issuerKind = tenant` and `templateRevisionRef` is set for the first four and
  NULL for `system_rendered`.
* `originKind ∈ {external_scanned, external_digital_import, reference_document}` ⇒
  `templateRevisionRef` is NULL and `controlNumber` is NULL unless the definition's numbering policy is
  `leaseos_series_optional` **and** the tenant elected it (the "we number our incoming paper" case, an
  explicit tenant setting).
* `issuerKind ≠ tenant` ⇒ `numberingPolicy` may not be `leaseos_series`. LeaseOS cannot present an
  externally issued document as tenant-issued.
* An `evidenceRecords` row pointed at by an `external_*` register row must be sealed before the register
  row can leave `captured`.
* `originKind` and `issuerKind` are immutable once `controlState ≥ confirmed`. Correcting them is a
  supersede with reason, never an update.

The four existing local `source` columns are **not** migrated. `disposalTickets.source` stays the
disposal domain's word; when Document Control registers the disposal scan it maps `photo_ocr` →
`external_scanned`, `facility_portal` → `external_digital_import`.

---

## 6. Record model: the register, numbering, references, links, revisions, states

### 6.1 Numbering policy per definition

Names searched for first: `resetPeriod`, `sequenceType`, `numberingPolicy` (exists as
`commercialNumberingPolicies` — that is *format*, not *whether*). The proposed enum
`documentDefinitions.numberingPolicy`:

| Value | LeaseOS mints a business number? | `controlNumber` | External reference | Typical |
|---|---|---|---|---|
| `leaseos_series` | yes, required, before `issued` | required, unique per `orgRef` | per policy | field ticket (FT), BOL, JSA, POD, tenant-issued disposal ticket |
| `leaseos_series_optional` | only if the tenant enables it for this key | nullable | per policy | company custom ticket where the paper carries pre-printed numbers; incoming paper the office chooses to number |
| `domain_managed` | the owning domain mints in its own series; the register **mirrors** | required, copied, read-only | per policy | invoice (INV), manifest (MRO), disposal ticket record (DSP), incident matter (MTR), academy certificate |
| `external_only` | never | must be NULL | **required** | facility disposal receipt, scale ticket, driver licence, insurance certificate, supplier invoice |
| `archival_only` | never | must be NULL | optional | SDS, policies, photos, HOS export, unclassified documents |

Every row also has `documentRef` (`DOC-…`, the archival identity 0144 already mints) and `id`. Whether
the `DOC-` ref is shown to users for `external_only` and `archival_only` rows is **D-DC-02** (the
recommended default: shown as "LeaseOS file no." in office screens, never on printed output, never in
the customer portal).

The user's candidate names map as: `LEASEOS_SEQUENCE_REQUIRED` → `leaseos_series`;
`LEASEOS_SEQUENCE_OPTIONAL` → `leaseos_series_optional`; `DOMAIN_MANAGED_SEQUENCE` →
`domain_managed`; `EXTERNAL_SEQUENCE_ONLY` → `external_only`; `ARCHIVAL_SEQUENCE_ONLY` and
`NO_HUMAN_SEQUENCE` collapse into `archival_only` because the archival `DOC-` identity exists on every
row and the only remaining question (display) is a policy, not a model, decision.

### 6.2 The series mechanism (extend the counter, add the ledger)

`nextTrackingNumber` stays the one counter. Three additions, all inside the existing module:

1. **`orgRef` on `trackingSequences`** (NULL = platform/single tenant), replacing the
   `${type}@${hash8(bookOrgRef)}` sequence-name workaround. Existing global counters (FT, INV, DSP, DOC)
   keep their rows with `orgRef = NULL`; whether they are split per tenant is **D-DC-03** (recommended:
   new tenants get per-tenant series from birth; the historical tenant keeps its counters).
2. **`numberAllocations` ledger**, the `sheetSerialAllocations` discipline generalised: one row per
   minted number, written **in the same transaction** as the counter bump and the record insert
   (a tx-accepting `nextTrackingNumberTx(tx, …)` variant; the `db`-taking entry point remains for
   existing callers and is migrated caller by caller). Columns: `allocationRef`, `orgRef`,
   `sequenceType`, `periodKey`, `sequence`, `formattedNumber`, `state` `reserved | issued | voided`,
   `recordType` + `recordId` (set at issue), `reservedByUserId`, `reservedAt`, `issuedAt`,
   `voidedByUserId`, `voidedAt`, `voidReasonCode` (`record_insert_failed | cancelled_before_issue |
   duplicate_issue | printed_and_spoiled | migration_gap | other`), `voidReasonText`. Unique
   (`orgRef`, `sequenceType`, `periodKey`, `sequence`).
3. **`trackingReferences` becomes the issued-number index** (it already has `trackingNumber` unique,
   `entityType/entityId`, `issuedBy`/`onBehalfOf`/`deviceId` delegation fields, and no writer): written
   at `issued`, read by search and by the Void/Gap report.

Consequences: a number is *reserved* when a draft that needs one is created, *issued* when the record
commits, *voided* with a reason otherwise — so a gap is always explainable, which is the property the
sheet-serial allocator already proves. A `reserved` row older than a configurable window with no
record is a finding, not silently reused. Offline devices never mint series numbers
(`server_authoritative` class); an offline-captured document carries `clientCaptureRef` and receives its
number at office issue. Pre-allocating printed blocks to devices (the sheet-serial pattern) is deferred
and is **D-DC-04**.

### 6.3 Register row additions (extend `commercialDocuments`)

New columns: `definitionRef`, `definitionKey` (denormalised = existing `documentType`; the two are
kept equal by the write path until `documentType` is retired), `originKind`, `issuerKind`,
`issuerOrgRef`, `issuerFacilityId`, `issuerName`, `controlNumber` (unique per `bookOrgRef` when not
NULL), `controlState` (§6.7), `templateRevisionRef`, `renderManifestHash` (§13), `capturedByUserId`,
`capturedByDeviceRef`, `importChannel`, `confirmedByUserId`, `confirmedAt`, `issuedByUserId`,
`voidedAt`, `voidReason`. `bookOrgRef` stays the tenancy column (the register's existing convention).

Retired vocabulary on this row: none. `status current|superseded|withdrawn` stays and continues to
express *version currency*; `controlState` expresses *review/issue lifecycle*. They are orthogonal.

### 6.4 External references — `documentExternalReferences` (new)

| Column | Notes |
|---|---|
| `referenceRef`, `orgRef`, `documentId` | |
| `referenceType` | varchar(40) validated against a catalog: `facility_ticket_number`, `scale_ticket_number`, `customer_po`, `afe`, `manifest_number`, `regulatory_identifier`, `supplier_invoice_number`, `bol_number`, `customer_job_number`, `licence_number`, `certificate_number`, `policy_number`, `permit_number`, `receipt_number`, `other` — extensible per tenant like `commercialCategoryTypes` |
| `referenceValue` | varchar(120), normalised (trimmed, upper-cased for comparison; original kept in `referenceValueRaw`) |
| `issuerKind`, `issuerOrgRef`, `issuerFacilityId`, `issuerName` | the issuer of *this identifier* (may differ from the document's issuer, e.g. a customer PO quoted on a facility ticket) |
| `source` | `ocr_proposed \| human_entered \| portal_submitted \| api_imported \| domain_mirrored` |
| `confirmationStatus` | `proposed \| confirmed \| rejected`; `confirmedByUserId`, `confirmedAt` |
| `mirrorOfTable`, `mirrorOfId`, `mirrorOfColumn` | set when `source = domain_mirrored` (e.g. `disposalTickets.facilityTicketNumber`); the row is then read-only in Document Control and the domain remains authoritative |

**Uniqueness is issuer-scoped.** The comparison key is (`orgRef`, `referenceType`, issuer scope,
`referenceValue`) where issuer scope = `issuerFacilityId` ?? `issuerOrgRef` ?? normalised
`issuerName`. Two facilities may both issue "12345". A collision within one issuer is not a hard
refusal at reference level: it produces a `possible_duplicate` finding routed through the existing
`assessDuplicate` / `commitPermittedUnder` gate (`documentFingerprint.ts:188/235`) — an identical
content hash is `exact_duplicate` and refused; a different content hash with the same issuer reference
needs a recorded human override. The disposal domain's stricter rule (one facility ticket per load,
`assistantCommitService.ts:594`) remains the disposal domain's.

### 6.5 Entity links (extend `commercialDocumentLinks`, unify the vocabulary)

Add `recordId` (int, nullable beside the existing `recordRef` string), `role` (varchar 40, the
`manifestEvidenceLinks.relationship` idea generalised: `subject | supporting | origin_ticket |
scale_ticket | facility_acceptance | signature | photo | authorization | attachment`), `source`
(`human | domain | ocr_proposed`), `confirmationStatus` (`proposed | confirmed`), `linkedByDeviceRef`.

`documentLinkKinds` (code constant, tested): the union of `evidenceRelationships.entityType` (24
values) normalised to snake_case, plus `customer_account`, `vendor`, `billing_book`, `purchase_order`,
`material` (for SDS → `wasteStreamVocabulary` / product), `written_program`, `document` (document →
document, e.g. a POD referencing its BOL). The four other polymorphic conventions in the repository are
**not** migrated in DC1; the catalog maps each existing enum value to one canonical kind so search and
the chain walk can join them. Full unification is an owner-sequenced later item (**D-DC-06**).

A link to a `server_authoritative` fact (load, disposal ticket, field ticket) can be *proposed* by
OCR but is *confirmed* only by a person or by the owning domain (the disposal adapter links the scan
to the load it resolved; Document Control records that as `source = domain`).

### 6.6 Revision policy

| Policy | Mechanism (existing) | Applies to |
|---|---|---|
| `immutable_supersede` | new register row, `version+1`, supersede chain, reason ≥ 10 chars (0144 `supersede`) | most generated documents, imported files |
| `amend_with_reason` | `immutable_supersede` **plus** a `recordAmendments` row per changed field (`schema.ts:1353`, wire its first writer): `fieldKey`, original → corrected, reason, `afterSignature`, actor + `onBehalfOf`; a two-person rule for post-signature amendments borrowed from `amendmentAllowed` (`manifestCustody.ts:80`) | field-level corrections to confirmed external documents (a mis-keyed facility ticket number) |
| `domain_managed` | the owning domain's chain (`fieldTicketRevisions`, `manifestAmendments` with trigger, HOS "second statement") | field ticket, manifest, HOS artifacts, certificates |
| `reference_versioned` | supersede chain keyed by publisher version/date; `current | superseded` only, never "amended" | SDS, policies, procedures, contracts |

A withdrawn or voided document keeps its number (the invoice-void precedent, `LEASEOS_B22_11_
CREDITS_VOIDS.md`).

### 6.7 Control state (register lifecycle)

`controlState`: `captured → needs_classification | proposed → confirmed → issued → current` with
side exits `void` (before issue; number voided in the ledger) and `withdrawn` (after issue; existing
0144 status). Rendered documents enter at `issued` (they are produced from confirmed data). External
documents enter at `captured` and cannot skip `confirmed`. `needs_classification` is the home of the
`unclassified_external_document` definition (§8). A definition's optional `workflowKey` may add domain
steps (e.g. `awaiting_customer_signature`) through the existing `workflowInstances` /
`attemptTransition` engine rather than a second state machine.

---

## 7. Template sources and versioning

Names searched for first: `formDefinitions` (unused), `dispatchTemplates` (not documents),
`writtenProgramVersions` (controlled *programs*; the closest release pattern), `academyCourseVersions`.
Proposed:

**`documentTemplates`**: `templateRef`, `orgRef` (tenant that may use it), `definitionKey`,
`sourceKind` `leaseos_standard | organization_custom | customer_supplied | external_form`,
`ownerKind` `leaseos | tenant | customer | regulator | facility | other_third_party` + `ownerOrgRef` /
`ownerName`, `name`, `status` `active | retired`.

**`documentTemplateRevisions`**: `revisionRef`, `templateId`, `revision` (int, unique per template),
`status` `draft | released | retired`, `layoutKind` `leaseos_layout | pdf_overlay | html_layout`,
`layoutStorageKey` (the uploaded PDF or layout spec, stored through `storagePut`),
`layoutContentHash` (SHA-256), `fieldMappingJson` (printed field → semantic field key, §12),
`fieldMappingHash`, `rendererKey` + `rendererVersion` required at release, `releasedByUserId`,
`releasedAt`, `supersedesRevisionId`, `retiredAt`.

Rules: a released revision is immutable (layout hash and mapping hash frozen; a DB trigger in the
`manifests_seal_guard` style is recommended). **Changing a field mapping is a new revision** — there is
no separate mapping version because a mapping change alters what a rendering means, and one identity
is simpler to reconstruct than two. A customer-supplied or external form is never modified in place;
a corrected form is a new revision that names the reason. A document records `templateRevisionRef`
and a `renderManifestHash` = sha256 of canonical `{layoutContentHash, fieldMappingHash, rendererKey,
rendererVersion, sourceSnapshotHash}` so that "ticket issued with Company Template V3" is
reconstructable after V4 is released even if the revision row were ever damaged.

Renderer: `renderPdf` cannot draw onto an uploaded PDF, place a logo, a signature image or a QR code.
Filling a company or customer form requires a PDF library (`pdf-lib` or equivalent). Adding one is
**D-DC-05** and belongs to DC2, not DC1.

**Company form import, phased.** Phase A (DC2): office uploads the PDF, marks field regions
manually on screen, maps each to a semantic field, releases revision 1 — no automatic field detection.
Phase B (DC3): AcroForm field-name detection where the PDF has form fields, proposing mappings for
confirmation. Phase C (later, post-moratorium): AI-proposed region detection on flat PDFs, still
confirmed by a person. Automatic arbitrary-PDF mapping is **not** a first-phase requirement.

---

## 8. Scanner without a template

Invariant: **no template match ever prevents a document from entering Document Control.**

Mapped onto what exists:

| Step | Mechanism | Status |
|---|---|---|
| 1. Save original | `evidence.upload` (`server/routers.ts:403`) → `storagePut` → `evidenceRecords` (`clientCaptureRef` idempotent) | exists; **defect**: only `files[0]` syncs (`syncEngine.ts:139`) — multi-page fix in DC3 |
| 2. Hash original | server computes SHA-256 from stored bytes at upload and writes it to `evidenceVersions` v1 / seal (today only at seal time) | DC1 defect fix |
| 3. Register row | new `documentControl.intake` procedure: creates the register row at `controlState = captured`, `definitionKey = unclassified_external_document`, `originKind = external_scanned` or `external_digital_import`, `issuerKind = unknown`, pointer `evidenceRecordId`, links proposed from the capture's `jobId`/`unitId` (source `human` if the driver chose them, else `ocr_proposed`) | DC1 |
| 4. Propose class | `classifyDocument` (extend `DocumentType` with the definition keys that have `extractionProfileKey`); merchant memory reused | DC3 (post-moratorium: it is model-backed) |
| 5. Propose issuer | facility name → **no resolver exists today**; proposal carries `issuerName` text and, when a facility alias matches `facilityAliases.alias` exactly, a proposed `issuerFacilityId` (`confirmationStatus = proposed`) | DC3; alias resolver is small and non-AI, can land in DC1 if the owner wants it (**D-DC-07**) |
| 6. Propose external number | `proposalFields` row `facilityTicketNumber` (existing disposal form) → `documentExternalReferences` row `source = ocr_proposed` | DC3 |
| 7. Propose job/load/facility | server-resolved columns on `assistantProposals` (`loadId`, `facilityId`) — never from OCR text alone; `loadRef` text must match the resolved id or commit is refused (`assistantCommitService.ts:446-647`) | exists |
| 8. Show confidence | `proposalFields.confidence` + `assistantQuestions` (`missing_required | low_confidence | ambiguous_classification …`) | exists |
| 9. Human confirms | `assistant.answer/setStatus/readBack/acknowledge`; `checkCommit` re-run inside the transaction | exists |
| 10. Commit | new adapter case `document_control_confirm` in `planAssistantCommit`: sets `definitionRef`, `issuerKind/…`, external references (`confirmed`), links (`confirmed`), `controlState = confirmed`; when the definition's `primaryDomainOwner` is `disposal`, the existing `disposal_ticket_create` adapter runs in the same transaction and the register row is linked to the created `disposalTickets` row with `source = domain` | DC1 (manual path: the person types the fields; the same adapter is used with `source = human_entered`), DC3 (OCR-fed) |
| 11. Original immutable | `evidenceSeals`; `verifySealAgainstStored` on demand; register row points at the sealed record | exists |

**Manual intake in DC1 is the point.** The register, the definitions, the external references and
the links do not need OCR. A driver photographs an unknown receipt; the office (or the driver, offline)
types "Facility XYZ, ticket 874399, load L-…" and confirms. That satisfies the disposal acceptance
requirement (§17) before any model is wired, and it means the OCR checkpoint later only *pre-fills* a
form that already exists.

**If classification fails** the row stays `needs_classification` under
`unclassified_external_document` (numbering `archival_only`, class `unclassified`, all origins
allowed, no required fields, links optional). It appears in the Review Queue and in job search
(**D-DC-08**: recommended yes, badged "unclassified"). It is never dropped, never auto-deleted, and is
subject to the UNCONFIGURED retention rule (retained indefinitely until classified).

---

## 9. Document catalog (initial, configurable, not one table per document)

Every entry is a `documentDefinitions` row. Class → default policies:

| `documentClass` | numbering default | signature default | revision default | typical origins |
|---|---|---|---|---|
| `operational_form` | `leaseos_series` | `required_single` or `domain_managed` | `domain_managed` or `immutable_supersede` | templates, system_rendered, scanned |
| `controlled_credential` | `external_only` | `none` | `immutable_supersede` (a renewal is a new document) | scanned, imported |
| `financial_commercial` | `domain_managed` (LeaseOS-issued) / `external_only` (received) | `domain_managed` | `domain_managed` | system_rendered, imported |
| `regulated_record` | `domain_managed` or `external_only` | `domain_managed` | `domain_managed` | system_rendered, scanned |
| `reference_document` | `archival_only` | `none` | `reference_versioned` | reference_document, imported |
| `incident_evidence` | `domain_managed` (incident number) / `archival_only` (photo, statement) | `optional` | `amend_with_reason` | scanned, system_rendered |
| `unclassified` | `archival_only` | `none` | `immutable_supersede` | scanned, imported |

Seed keys by group (labels only; no regulatory content; jurisdictions `"*"` unless stated):

* **Safety / daily operations** (`operational_form`): `toolbox_talk`, `tailgate_meeting`
  (links to `tailgateMeetings.trackingNumber`; attendee signatures are a gap in that domain, §1.8),
  `safety_meeting_minutes`, `jsa`, `hazard_assessment`, `flha` (`"CA-AB"`, `"CA"`),
  `pre_job_safety_checklist`, `daily_safety_report`, `site_inspection`, `yard_inspection`,
  `daily_field_report`, `progress_report`.
* **Incident / evidence** (`incident_evidence`): `incident_report`, `accident_report`,
  `injury_report`, `near_miss_report`, `spill_environmental_report`, `witness_statement`
  (sensitivity per `incidentMatters`), `investigation_report` (RESTRICTED by default),
  `corrective_action_record`, `evidence_photo`, `evidence_video`.
* **Driver / personnel** (`controlled_credential` unless noted): `drivers_licence`,
  `employee_qualification_record`, `training_certificate`, `first_aid_certificate`,
  `h2s_certificate`, `tdg_certificate`, `whmis_certificate`, `company_training_record`;
  `timesheet`, `daily_work_record`, `expense_report`, `mileage_record` (`financial_commercial`,
  `domain_managed` by payroll/expense). Credential validity stays in `complianceDocuments` /
  `validityOf`; the register row is evidence only (§15).
* **Vehicle / fleet** (`controlled_credential` for registration/insurance/permit/inspection
  certificate; `operational_form` for pre/post-trip; `financial_commercial` for repair work order):
  `vehicle_registration`, `insurance_certificate`, `vehicle_inspection_certificate` (CVIP where
  `"CA-AB"`), `maintenance_record`, `repair_work_order`, `pre_trip_inspection`,
  `post_trip_inspection`, `permit`, `equipment_inspection`, `rental_record`, `equipment_inventory`.
* **Freight / field operations** (`operational_form`): `bill_of_lading`, `proof_of_delivery`,
  `trip_ticket`, `load_confirmation`, `field_ticket` (domain_managed, FT), `load_ticket`,
  `disposal_ticket` (domain_managed, DSP — the LeaseOS-recorded disposal fact),
  `external_disposal_receipt` (`external_only`), `scale_ticket` (`external_only`),
  `weight_inspection_record`, `manifest` (domain_managed, MRO), `dangerous_goods_shipping_document`
  (`regulated_record`; TDG reference set is absent per the knowledge index — no content seeded),
  `hotshot_delivery_ticket`.
* **Oilfield** (`operational_form` / `regulated_record`): `waste_manifest`, `waste_disposal_receipt`,
  `water_load_ticket`, `fluid_ticket`, `sand_material_ticket`, `crude_product_ticket`,
  `waste_tracking_document`, `norm_documentation`, `lease_site_paperwork`,
  `consultant_job_paperwork`, `environmental_spill_paperwork`.
* **Commercial / billing** (`financial_commercial`): `invoice` (domain_managed, INV),
  `supplier_invoice` (`external_only`), `purchase_order`, `customer_purchase_order`
  (`external_only`; the PO fact lives in `customerPurchaseOrders`), `rate_confirmation`,
  `service_agreement`, `work_order`, `job_ticket`, `change_order`, `receipt`, `fuel_receipt`
  (`external_only`; fact in `fuelTransactions`), `expense_receipt`.
* **Company / regulatory / reference** (`reference_document` unless noted): `insurance_policy_document`
  (`controlled_credential`), `permit_document`, `operating_authority_document`
  (`controlled_credential`), `policy`, `procedure` (both may point at `writtenProgramVersions`),
  `sds`, `contract`, `certificate`, `regulatory_correspondence`.
* **System**: `unclassified_external_document`, `hos_export` (§14), `audit_package_cover`
  (system_rendered), `completion_package` (system_rendered).

Existing 0144 built-ins (`credit_note`, `statement`, `vendor_bill`, `remittance`, `audit_package`)
become definitions of class `financial_commercial` with `domain_managed` / `external_only` numbering.

---

## 10. Jurisdiction and configuration packs

The repository already models jurisdiction as ISO-3166-2-style code strings (`"CA-AB"` about 180 times,
`"*"` = any) with no enum or table, and already has the pack idea (`compliancePacks` seeds,
`packsActivatedBy`, `companyPackActivations` keyed by `financialEntityId`). Document Control reuses the
code style and the activation idea:

* A **definition pack** is a seed set: `core` (jurisdiction `"*"`), `canada` (`"CA"`), `alberta`
  (`"CA-AB"`), `us` (`"US"`, **empty in the first implementation**), with province/state extensions as
  further packs. Packs ship labels, classes and behaviour defaults only.
* A definition's `jurisdictionsJson` states where it is *relevant*; relevance filters the catalog UI
  and the AI Secretary's "required forms" later. It never blocks intake: a US form scanned by an Alberta
  tenant still enters as `external_scanned` under its definition or as unclassified.
* Regulatory content — required fields imposed by a regulator, retention minimums, numbering rules a
  regulator imposes — is **not** in the definition. It lives where the repository already keeps
  regulatory facts: `complianceRequirements` (with `verificationStatus`, source authority/URL), and
  `retentionPolicies` (with `statutorySourceStatus`). A definition may reference a requirement key; the
  requirement carries the citation. Nothing in this design seeds a period or a mandatory field list.
* Terminology (FMCSA, OSHA, EPA, TDG, OHS) appears only in pack-scoped `displayName`/`description`
  strings, never in code or the core schema.
* Pack activation for Document Control is keyed by `orgRef` (the existing `financialEntityId` keying
  is noted as a gap in §1 of the numbering survey; Document Control does not repeat it).

---

## 11. AI Secretary boundary

Vocabulary is the fixed one in `docs/register/AI_RUNTIME_TERMINOLOGY.md` (proposal, extraction
envelope, gap, clarification question, read-back, capability vs tool, automation mode, never-automatic
floor). Existing engines: `secretaryCoordination.propose/briefing/accept` with `NEVER_AUTOMATIC`,
`actionGateway.decide`, `aiProposal` (`detectGaps`, `checkCommit`, `detectOverreach`),
`documentExtraction.ALWAYS_HUMAN`.

What the Secretary may do for Document Control (post-moratorium, DC5):

* Say "this job requires these definitions" by evaluating a `documentRequirementProfiles` row (a
  generalisation of `manifestEvidenceProfiles`: per job type / customer / jurisdiction, which
  definition keys are required, approved by a person). Missing = a gap, never a block on its own; the
  block decision belongs to the automation policy (the monitoring-notice precedent,
  `REMAINING_BUILD_REGISTER.md:74`).
* Pre-fill semantic fields from **LeaseOS Records** only (§12): organization identity/logo/address,
  operator, unit, trailer, customer, consultant contact, job, site/LSD, date/time, load, material,
  facility, quantities the load record already holds, contacts, PO/AFE from `customerPurchaseOrders`
  / `billingBooks`, dispatch information. Every pre-filled field is a `proposalFields` row with `source
  = system_inferred` and `status = proposed`.

What it may never do (enforced by `ALWAYS_HUMAN` extended for documents, and by the adapter): supply
scale weights, quantities not already recorded by a measurement path, disposal acceptance, customer
acceptance, any signature, instrument readings, external issue dates or numbers, regulatory
determinations, or the classification of a RESTRICTED document. Formal issue requires the definition's
signature policy to be satisfied by a person or by the owning domain, and `checkCommit` (read-back
acknowledged) before commit. The model never names procedures, SQL, tenant or permissions.

---

## 12. Semantic field model

Survey of existing naming: `FORMS` field keys are camelCase leaves (`facilityName`, `loadRef`,
`unitNumber`, `grossKg`); the domain word for driver is **operator** (`operators`, `operatorId`,
`evidenceRelationships.operator`); there is no `lease` table — site facts are `jobs.location`,
`siteLocationId`, `atsLegalSubdivisions` (LSD). The registry therefore uses dotted paths with the
repository's nouns and camelCase leaves:

`organization.legalName`, `organization.address`, `organization.logo` (an evidence pointer),
`job.jobCode`, `job.customer`, `job.location`, `site.lsd`, `site.surfaceLocation`,
`dispatch.id`, `operator.id`, `operator.name`, `unit.number`, `trailer.number`,
`load.quantity`, `load.quantityUnit`, `load.material`, `load.loadTicketNumber`,
`facility.name`, `facility.id`, `customerPurchaseOrder.poNumber`, `billingBook.afeNumber`,
`document.controlNumber`, `document.issuedAt`, `signature.customerRepresentative`.

The registry is a code constant (`semanticFields`, tested like `FORMS`), each entry declaring: the
authoritative source (table.column or "human only"), the value type (reusing `FormFieldDef.type`),
whether it is `AUTO_FILE_ELIGIBLE`, `ALWAYS_HUMAN`, or `server_only` (weights, acceptance, signatures),
and `precisionSensitive`. Template field mappings (§7) and definition required/optional fields (§4)
reference these keys, so the same `operator.name` feeds a field ticket, a BOL, a JSA and a disposal
ticket. Adding a key is a code change with a test; it is not tenant-configurable in the first phase.

---

## 13. Template versioning and reconstructability

A document produced from a template stores: `templateRevisionRef` (identity + revision + source kind
through the revision row), `renderManifestHash` (§7), `sourceSnapshotHash` (the frozen data, as
`fieldTicketDocuments` already does), `contentHash` of the output bytes. Re-rendering V3 after V4 is
released uses the retired-but-readable V3 revision; the result's `contentHash` must equal the stored
one or the reprint is refused and logged (the `portal.documentDownload` hash-check precedent,
`server/portalRouter.ts:417-428`). Renderer version is required at release and recorded, closing the
"no renderer version stored anywhere" gap.

---

## 14. HOS special boundary

HOS records are not documents and are not templated. `dutyRecords`, `hosAttestations`,
`hosRuleProfiles` remain authoritative; corrections are second statements (`hosRouter.ts:143`). Document
Control defines `hos_export` (`regulated_record`, `system_rendered`, `archival_only`, `revisionPolicy =
domain_managed`, `printPolicy = controlled_copy`) for a future exported logbook artifact, and reuses the
existing scanned-paper path (`complianceDocuments` docType `hos_daily_log`, `needs_review`,
`hosRouter.ts:72-102`) by registering that document as `external_scanned` evidence. No document in
the register satisfies an HOS check, changes a duty event, or is editable. This exception is explicit.

---

## 15. Reference documents (SDS) special boundary

`sds` is `reference_document`, `archival_only`, `issuerKind = manufacturer`, origins
`external_digital_import | external_scanned | reference_document`, `revisionPolicy =
reference_versioned`. Row fields used: `issuerName` (manufacturer/supplier), `issuedAt` (revision date
as printed), optional external reference `other` for the publisher's revision code, links of kind
`material` (to `wasteStreamVocabulary` / product) and `unit`/`job` where an SDS is carried, and the
register's `current | superseded` status for currency. Attachments (annexes) are additional register
rows linked with role `attachment`. LeaseOS never numbers an SDS and never claims to have issued it.
`knowledgeDocuments` (AI retrieval corpus) is a different thing and is not used for SDS control.

Credentials follow the same shape: a `drivers_licence` register row is evidence; the credential fact
and its validity stay in `complianceDocuments` + `validityOf`. A PDF in a future Driver Wallet (a
projection, `unified-compliance-engine-design.md:287`) is evidence, not proof the qualification is in
force.

---

## 16. Scan + template convergence

Both origins land in the same register and therefore share: search (§19), links, billing linkage
(through the domain record they are linked to, never directly), audit history, customer portal
(`portal.customer.documents` already exists), records vault, retention, exports, and audit packages
(`registryDocumentsFor` already gathers register rows). They differ, visibly and permanently, in
`originKind`, `issuerKind`, `templateRevisionRef` and the bytes' nature (original vs rendering). A
scanned paper ticket whose extracted fields equal a LeaseOS-generated ticket's fields is still a
different record with a different provenance; nothing merges them.

---

## 17. Disposal vertical slice (mixed origin)

```
jobs (JOB-…) → dispatch (slot/assignment, Checkpoint I) → operator + unit → loads (L-…)
 → [optional] LeaseOS field/load ticket: fieldTickets FT-… (domain_managed) → fieldTicketDocuments R1
     → register row: definition field_ticket, originKind system_rendered (or organization_template
       later), issuerKind tenant, controlNumber = FT-…, links job/load/unit/operator (source domain)
 → facility: manifestCustodyEvents arrived_facility → accepted_by_facility | rejected_by_facility
 → facility hands over paper ticket #874399
 → driver photographs it offline: LocalCapture (jobId, unitId, file sha256) → sync → evidence.upload
     (clientCaptureRef idempotent) → evidenceRecords (hashed at upload, sealed)
 → documentControl.intake: register row captured, unclassified_external_document, external_scanned,
     issuerKind unknown, links job/unit proposed
 → proposal (DC1: typed by a person; DC3: classifyDocument + extractToProposal pre-fill):
     definition external_disposal_receipt, issuerKind facility, issuerFacilityId (server-resolved;
     alias hint only), external reference facility_ticket_number 874399 (proposed), load link proposed
 → human confirms (read-back) → commit:
     document_control_confirm adapter → register row confirmed, references + links confirmed
     disposal_ticket_create adapter (existing) → disposalTickets row DSP-…, facilityTicketNumber
       874399, verificationStatus needs_review, one facility ticket per load enforced
     register row linked to the DSP row (source domain); reference row becomes domain_mirrored
 → disposal verification (existing: reconcileDisposal, facilityStatements matching by the facility
     ticket number) → billingBooks disposal_verified
 → invoicing: invoices INV-… → fieldTicketDocuments kind invoice → register row (system_rendered,
     domain_managed INV)
 → audit package: auditPackage.assemble gathers register rows via commercialDocumentLinks; the FT
     rendering, the facility scan, the DSP record and the invoice appear with their origins
```

The tenant never needs a LeaseOS-designed disposal-ticket template for this to work: the paper is the
facility's, the scan is the original, the `disposalTickets` row is the LeaseOS fact, and the register
row is the controlled record that ties them. That is the acceptance requirement, met in DC1 by manual
intake and pre-filled in DC3.

---

## 18. Administration screens (design only; nothing built in this checkpoint)

| Screen | Backing procedures (all `roleProcedure`, permissions in §21) | Notes |
|---|---|---|
| Document Library | `documentControl.list/get` (filters: definition, class, origin, issuer, state, job, period) | one list, origin badge on every row |
| Template Library | `documentControl.templates.*` (DC2) | source kind, released revisions, retired revisions still readable |
| Document Definitions | `documentControl.definitions.list/get/activate/retire/overlay` | platform rows read-only except the overlay set (§4.1) |
| Number Series | `documentControl.series.list/configure` (extends `commercialNumberingPolicies`), `documentControl.series.void` | shows reserved/issued/voided counts per series/period |
| Imported Company Forms | Template Library filtered to `organization_custom` / `customer_supplied` (DC2) | |
| External / Scanned Documents | Document Library filtered to `external_*` origins | issuer resolution status |
| Review Queue | existing pending-proposal list (`listPendingProposals`) + register rows in `captured`/`needs_classification`/`proposed` | one queue, not a second (Exception Centre source) |
| Void / Gap Report | `documentControl.series.gapReport` over `numberAllocations` + `trackingReferences` | every gap has a reason or is a finding |
| Print / Reprint History | `evidenceAccessEvents.printed` + `commercialDocumentDeliveries(channel=print)` (DC4) | copy number for `controlled_copy` |
| Audit Timeline | outbox events `document.*` + `evidenceAccessEvents` + `externalAccessLog` for a document | read-only |

---

## 19. Search experience

Extend `searchEverything` (`server/surfacesService.ts:206`) with the register's `documentRef`,
`controlNumber`, `title`, and `documentExternalReferences.referenceValue` (issuer-scoped), and add a
job view that unions `commercialDocumentLinks` (documents) with `evidenceRelationships` (raw evidence
not yet registered) and `walkEvidenceChain` (domain records). Each hit shows definition, origin badge
("LeaseOS-issued" / "Facility XYZ" / "ScaleCo" / "external receipt"), state and number:

```
JOB 26-00481
  FT-2026-004812        field_ticket               issued by tenant (LeaseOS)        current
  FACILITY XYZ #773621  external_disposal_receipt  issued by facility (scan)         confirmed
  JSA-2026-008811       jsa                        issued by tenant (LeaseOS)        current
  BOL-2026-000991       bill_of_lading             issued by tenant (LeaseOS)        current
  ScaleCo #557284       scale_ticket               issued by ScaleCo (scan)          confirmed
  DOC-2026-…            fuel_receipt               issued by vendor (scan)           needs_classification
```

Tenant scoping of search is a pre-existing gap and is fixed in the same change (register rows carry
`bookOrgRef`; the union query filters by acting scope).

---

## 20. Decision matrix (representative classes)

| Class | Generated by LeaseOS? | LeaseOS template? | Custom template? | Scan/import? | LeaseOS number | External ref | Signature | Revision | Primary owner | Document Control role |
|---|---|---|---|---|---|---|---|---|---|---|
| Field ticket | yes | yes (DC2; today system_rendered) | yes | yes (paper copy) | `domain_managed` FT | optional (customer PO/AFE) | `domain_managed` (customer rep, device-attested) | `domain_managed` (`fieldTicketRevisions`) | closeout | register the rendering, link, mirror number |
| Disposal ticket (LeaseOS-recorded) | yes (record), rendering optional | yes (DC2) | yes | yes | `domain_managed` DSP | required when facility-issued paper exists | `optional` | `domain_managed` | disposal | register, link to DSP row |
| External disposal receipt | no | no | no | yes | none (`external_only`) | required `facility_ticket_number` | `none` (facility's ink is on the scan) | `amend_with_reason` (keyed fields only) | disposal (facts) / document control (artifact) | authoritative artifact record |
| BOL | yes | yes (DC2) | yes (customer forms common) | yes | `leaseos_series` BOL | optional (`bol_number` when carrier-issued) | `required_single` | `immutable_supersede` | document control | authoritative |
| POD | yes | yes (DC2) | yes | yes | `leaseos_series` POD | optional | `required_single` | `immutable_supersede` | document control | authoritative |
| JSA | yes | yes (DC2) | yes | yes | `leaseos_series` JSA | none | `required_multi` (attendees) | `immutable_supersede` | safety (facts, when a domain record exists) | authoritative until a safety-meeting domain record exists |
| Incident report | yes | yes (DC2) | yes | yes | `domain_managed` (`incidentNumber`, today client-supplied — a gap to fix in that domain) | optional (regulator file no.) | `optional` | `amend_with_reason` | safety / restricted vault | register the artifact; RESTRICTED served via `serveRestricted` |
| Driver licence | no | no | no | yes | none | required `licence_number` | `none` | `immutable_supersede` | compliance (`complianceDocuments`) | evidence only |
| Training certificate | no (external) / yes (academy) | no | no | yes | `domain_managed` (academy `certificateRef`) or none | `certificate_number` | `domain_managed` | `domain_managed` / `immutable_supersede` | academy / compliance | evidence only |
| Insurance certificate | no (insurer) / yes (`insurance.certificateIssue`) | no | no | yes | `domain_managed` (`certificateRef`) or none | `policy_number` | `none` | `immutable_supersede` | insurance | evidence only |
| Vehicle inspection (CVIP) | no | no | no | yes | none | `certificate_number` | `none` | `immutable_supersede` | fleet / compliance | evidence only |
| Work order (repair) | yes | yes (DC2) | yes | yes (vendor's) | `leaseos_series` WO — **prefix clash**: `WO` is the write-off sequence in `cashRouter.ts:225` (**D-DC-09**) | optional (vendor WO no.) | `optional` | `immutable_supersede` | fleet | register; fleet owns status |
| Fuel receipt | no | no | no | yes | none | `receipt_number` optional | `none` | `immutable_supersede` | fuel / expense | evidence only; fact in `fuelTransactions` |
| SDS | no | no | no | yes | none | publisher revision optional | `none` | `reference_versioned` | document control | authoritative reference record |
| HOS export | yes (system) | no | no | no | none | none | `none` | `domain_managed` (regenerate, never edit) | HOS | archive only |

---

## 21. Permissions (declared now, mapped in DC1)

Following `PROCEDURE_AUTHORIZATION_INVENTORY.md` rules (reads and writes separate; acts that create
fact are SENSITIVE; running and approving in different roles):

`documentControl.read` (per `readCategory`, reusing `evidence.read_<category>`),
`documentControl.intake` (SENSITIVE), `documentControl.confirm` (SENSITIVE; the person who captured
may confirm their own external document — the office may re-confirm), `documentControl.issue`
(SENSITIVE), `documentControl.supersede` (SENSITIVE), `documentControl.withdraw` (SENSITIVE),
`documentControl.void_number` (SENSITIVE; not the same role as `issue`), `documentControl.link`,
`documentControl.definitions.read`, `documentControl.definitions.manage` (SENSITIVE, management only),
`documentControl.series.manage` (SENSITIVE), `documentControl.templates.manage` (DC2),
`documentControl.print` (DC4). External identities: `portal.customer.documents` and
`portal.documentDownload` already exist; a facility identity gains `portal.facility.documents`
(read own issuer's rows) in DC1. Counts and inventory updated in the same PR.

---

## 22. Existing LeaseOS systems reused, and what must not be rebuilt

**Reused (by name):** `commercialDocuments/Links/Deliveries` + `commercialOffice.documents.*`;
`commercialCategoryTypes(document_type)`; `evidenceRecords/Versions/Seals/Relationships` +
`sealEvidence/verifySealAgainstStored/amendSealedEvidence` + `storagePut/storageGetSignedUrl/
storageRead/storageKeyInput`; `clientCaptureRef` idempotency; `documentFingerprints` +
`assessDuplicate/commitPermittedUnder`; `retentionPolicies` + `computeEffectiveRetention` +
`legalHolds/hasActiveLegalHold`; `restrictedVault.serveRestricted` + grants/events;
`trackingSequences` + `nextTrackingNumber` + `commercialNumberingPolicies/numberingPolicyFor` +
`trackingReferences`; the `sheetSerialAllocations` ledger discipline; `recordAmendments`;
`manifestAmendments`/`amendmentAllowed` two-person rule; `renderPdf/sha256Hex` + `fieldTicketDocuments`;
`recordSignature/signatureDecision/signatoryAuthorities` + `checkSignatureAttestation/
canonicalSignaturePayload`; `commercialApprovalService.decide`; `assistantProposals/proposalFields/
assistantQuestions` + `aiProposal` (`FORMS`, `detectGaps`, `checkCommit`, read-back) +
`planAssistantCommit`/`executeAssistantCommit` receipts + `classifyDocument/extractToProposal/
ALWAYS_HUMAN/CONFIDENCE_POLICY`; `documentValidity.validityOf`; `fieldDevices`/sync packages/
`LocalCapture`/`Outbox`/`SyncEngine`/`FileVault`; `offlineCapability` classes; `roleProcedure` +
permission maps + `authorizationDecisions` + `externalProcedure`; `resolveActingScope`/`orgScopeWhere`;
`emitDomainEvent` + outbox + `workflowRules`; `workflowInstances/attemptTransition`;
`searchEverything` + `walkEvidenceChain`; `auditPackage.assemble/releaseDecision` +
`registryDocumentsFor`; `manifestEvidenceProfiles/closeDecision` (pattern for requirement profiles);
`complianceRequirements`/`retentionPolicies` source discipline; `"CA-AB"` jurisdiction codes and the
pack activation pattern; `secretaryCoordination`/`actionGateway`; `attachmentAuthorization` (reference,
not copy).

**Must not be rebuilt:** a parallel documents table; a second counter or allocator; a second
seal/hash scheme (three helpers already duplicate `canonicalJson/sha256` — this design adds none and
recommends the consolidation as a separate hygiene item); a second review queue or proposal engine; a
second device identity, capture envelope or sync vocabulary; a second permission system; a second
search; a second jurisdiction vocabulary; a "Driver Wallet" store (it is a projection); a scan ledger
named `scanAudits` (that table is the QR/NFC access log and is not a document scanner); an
"orchestrator".

---

## 23. Owner decisions

| ID | Decision | Recommended default |
|---|---|---|
| D-DC-01 | Is Document Control DC1 an extension of the 0144 register (allowed under the SPINE moratorium) or a new engine (blocked)? | Extension: no new pipeline, no model call, columns + one ledger + procedures; OCR wiring (DC3) and Secretary (DC5) wait for the moratorium |
| D-DC-02 | Show the archival `DOC-` ref to users for `external_only` / `archival_only` documents? | Office screens only, labelled "LeaseOS file no."; never printed, never in portals |
| D-DC-03 | Split the historical global FT/INV/DSP/DOC counters per tenant? | New tenants: per-tenant series from birth. Historical single tenant: keep existing counters. No renumbering |
| D-DC-04 | Pre-allocate printed number blocks to devices for offline issue (sheet-serial pattern)? | Not in DC1–DC3; revisit with printing (DC4) |
| D-DC-05 | Add a PDF library (`pdf-lib` or equivalent) so LeaseOS can fill uploaded company/customer forms? | Yes, at DC2, with a decision record; `renderPdf` stays for text-only artifacts |
| D-DC-06 | Unify the four polymorphic link conventions onto `documentLinkKinds`? | Catalog + mapping in DC1; physical unification is a separate hygiene checkpoint |
| D-DC-07 | Build the exact-match facility alias resolver (non-AI) in DC1? | Yes: small, deterministic, proposal-only, confirms nothing |
| D-DC-08 | Do `needs_classification` documents appear in job search and the customer portal? | Job search yes (badged); customer portal no until confirmed |
| D-DC-09 | Resolve the `WO` prefix clash (write-off sequence vs work order)? | Rename the write-off series to `WOF` before any work-order series is introduced; a data fix, not a renumbering of issued refs |
| D-DC-10 | External-reference duplicate policy within one issuer | Same content hash: refused. Different content: `possible_duplicate` with recorded override |
| D-DC-11 | Which document classes are ALWAYS_HUMAN for the Secretary beyond the listed facts? | The listed facts plus any field of a `regulated_record` |
| D-DC-12 | Retention UNCONFIGURED behaviour for register rows with no policy | Retain indefinitely, disposition never eligible, surfaced as a finding; no default months applied (this diverges from the evidence path's hard-coded 120 months and should be reconciled there, not here) |
| D-DC-13 | Retire `complianceArtifacts` (thin legacy header with client-set `legal_hold`) in favour of the register? | Yes, after DC1, with a data migration reviewed separately |
| D-DC-14 | Multi-page scan upload (only `files[0]` syncs today): fix in DC1 or DC3? | DC1 if the client change is small; it is a correctness defect independent of OCR |
| D-DC-15 | Jurisdiction packs seeded in DC1 | `core`, `canada`, `alberta` labels only; `us` empty |

---

## 24. Regulatory-source gaps (nothing seeded)

Retention minimums for any class; TDG shipping-document required fields (reference set absent per the
knowledge index); CVIP/inspection certificate content rules; OHS meeting-record requirements. Each
enters, when it does, as a `complianceRequirements` / `retentionPolicies` row with a citation,
`unverified` until a person verifies it.

---

## 25. Safety risks and unresolved questions

* **Fabricated issuance.** The invariant "issuer ≠ tenant ⇒ no `leaseos_series`" must be enforced in
  the single write path and covered by a test that tries every origin × policy combination.
* **Number burn.** Until callers move to the tx-bound variant, existing FT/INV minting still burns
  numbers on failure; the ledger records them as `voided(record_insert_failed)` only for migrated
  callers. Migration order: DC1 migrates the register's own `DOC` minting and new series; FT/INV in
  the closeout/invoicing checkpoints.
* **Global fingerprint scope.** `documentFingerprints` has no org column; a cross-tenant
  `possible_duplicate` would leak that another tenant holds the same document. The register's
  reference-level check is org-scoped; the fingerprint table needs `orgRef` before multi-tenant use.
* **Hash at upload trusts nothing from the client** — the server computes it from stored bytes, as
  `deviceRouter` already does at sync.
* **Evidence tenancy is indirect** (`evidenceRecords` has no `orgRef`). Register rows carry
  `bookOrgRef`; a register row may only point at evidence whose derived scope matches.
* Unresolved: whether `writtenProgramVersions` (policies/procedures) folds into the register as
  `reference_document` rows or stays a domain with a link; whether tailgate attendee signatures become
  document signatures or a safety-domain fact (they are facts about a meeting, so the latter is
  recommended).

---

## 26. What this revision changed (relative to the conversation-only checkpoint)

1. Document Control no longer assumes a LeaseOS template. `templateRevisionRef` is nullable; origin
   and issuer are mandatory on every row.
2. The authoritative record is the **existing 0144 register**, extended — the earlier discussion did
   not know it existed. No parallel table.
3. A `documentDefinitions` registry (behaviour) is separated from templates (layout) and from
   `commercialCategoryTypes` (labels), keyed to the same category key.
4. Numbering is a per-definition **policy** with five values; the mechanism stays `trackingSequences`
   with an `orgRef`, a same-transaction allocation ledger borrowed from the sheet-serial allocator, and
   `trackingReferences` wired as the issued index. LeaseOS never mints for external issuers.
5. External identifiers become issuer-scoped `documentExternalReferences`, indexing the six existing
   domain columns and holding the ones no domain owns.
6. The scanner path is defined so that manual intake works in DC1 with no OCR and no model, and the
   OCR checkpoint only pre-fills.
7. Jurisdiction packs, the AI Secretary boundary, HOS and SDS exceptions, the semantic field
   registry, and the decision matrix are new sections.
8. The first implementation checkpoint is re-ordered to the repository's dependencies (§27).

---

## 27. Recommended first implementation checkpoint (DC1) and the sequence after it

**DC1 — "the register knows where a document came from"** (one migration slot, assigned at PR time):

1. `documentDefinitions` + seed of the representative rows in §20 plus
   `unclassified_external_document` (packs `core`/`canada`/`alberta`, labels only).
2. Register row extension (§6.3) and the single write path that enforces the origin/issuer/numbering
   invariants (§5); `documentType` kept equal to `definitionKey`.
3. `documentExternalReferences` with issuer-scoped uniqueness and the mirror columns; mirrors written
   for `disposalTickets.facilityTicketNumber` and `customerPurchaseOrders.poNumber` from their existing
   write paths (two small hooks, no behaviour change in those domains).
4. `commercialDocumentLinks` extension (`recordId`, `role`, `source`, `confirmationStatus`) and the
   `documentLinkKinds` catalog with the mapping from `evidenceRelationships.entityType`.
5. Numbering: `orgRef` on `trackingSequences`, `numberAllocations` ledger, `nextTrackingNumberTx`,
   `trackingReferences` writes, `documentControl.series.void`, gap report query; the register's own
   `DOC` series migrated to the tx variant; `WO` clash resolved per D-DC-09.
6. Evidence: SHA-256 computed from stored bytes at upload and written to the v1 version row (defect
   fix; `evidenceRecords` schema unchanged).
7. Manual intake and confirm: `documentControl.intake`, `documentControl.confirm` (adapter case
   `document_control_confirm` in `planAssistantCommit`, human-entered fields), the exact-match facility
   alias hint (D-DC-07), and the disposal linkage of §17 via the existing `disposal_ticket_create`
   adapter.
8. Auto-registration of what LeaseOS already renders: closeout R1/R2, completion package, invoice and
   audit cover renders create register rows (`system_rendered`, `domain_managed`) in the same
   transaction — closing the "renders are not registered" gap and making the job search (§19) complete.
9. Audit events: `document.registered | confirmed | issued | superseded | withdrawn | number_voided`
   through `emitDomainEvent(tx, …)` — the first publisher outside enforcement; `evidenceAccessEvents`
   `viewed/downloaded` written from the register's read path (not best-effort for SENSITIVE reads).
10. Permissions (§21), procedure inventory, count pins, parity and reachability tests, and the
    `regulatoryDataDiscipline` guard extended to the seeds (no periods, no mandatory field lists).

Deliberately **not** in DC1: templates and rendering onto forms, company form import, OCR wiring,
printing, the Secretary, bulk legacy digitisation, physical link unification, retention policy CRUD.

**After DC1:** DC2 templates + revisions + PDF library + form import phase A; DC3 OCR intake wiring
(post-moratorium) + multi-page sync fix (or earlier per D-DC-14) + form import phase B; DC4 printing
and controlled copies + print audit; DC5 `documentRequirementProfiles` + AI Secretary preparation
(post-moratorium); DC6 bulk legacy digitisation and `complianceArtifacts` retirement.

Why this order differs from the requested list: the repository already has the record, the seal, the
counter and the proposal pipeline, so "definitions → register extension → references → links →
series ledger → evidence hash → manual intake → auto-registration → events → permissions" produces a
usable disposal slice at the end of DC1 without a template, an OCR model, or a printer, and every later
checkpoint only adds a producer of rows the register already accepts.
