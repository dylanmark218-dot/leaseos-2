# Document Control — completion report

_Document Control Engine + Template / External Document Catalog, checkpoints A–H, built against the
supplied package `LeaseOS_Document_Control_Templates_and_Claude_Build_Instructions_2026-09-23.zip` with
the live repository as the authority. Every claim below was verified by a gate run named in
`DC_IMPLEMENTATION_RECORD.md`; nothing is reported as passing that was not run._

## Repository

| | |
|---|---|
| Starting SHA (branch base on `main`) | `0cd4817` — "Checkpoint I: the dispatcher's screen can fill a slot (#11)" |
| Design commit (Phase 1, design only) | `7759056` |
| Final SHA | `e49c96e` |
| Branch | `claude/document-control-architecture-jlffzk` (the session's designated branch; the suggested `feature/document-control-template-catalog` was not used because this session may push only to its designated branch) |
| Commits created (implementation) | A `7dbc06b` · B `3d3daef` · C `4d8ede2` · D `7e329e5` · E `c4f9815` · F `04cc6b3` · G `f6b95f2` · H `e49c96e` |
| Size | 178+ files, ~15,000 insertions over the design commit; 3.7 MB of catalog data under `data/document-control/` (136 files: 66 canonical PDF/DOCX, extracted text, reference material, CSV/JSON catalog, SHA-256 sums) |

## Database

**Tables added (10):** `documentDefinitions`, `documentSourceArtifacts` (0178); `documentExternalReferences`,
`documentControlEvents` (0179); `numberBlocks`, `numberAllocations` (0180); `documentTemplates`,
`documentTemplateRevisions`, `documentTemplateArtifacts` (0181); `documentDerivatives` (0182).

**Tables extended (never replaced):** `commercialDocuments` (+20 Document Control columns, unique
`(bookScopeKey, controlNumber)`), `commercialDocumentLinks` (recordId, role, source, confirmationStatus,
device), `trackingSequences` (orgRef, scopeKey, unique per scope/series/branch/period),
`documentExtractions` (documentId), `disposalTickets` (verifiedByUserId, verifiedAt, verificationNote).

**Migrations:** `0178_document_control_definitions.sql`, `0179_document_control_register.sql`,
`0180_document_control_numbering.sql`, `0181_document_control_templates.sql`,
`0182_document_control_intake.sql`, `0183_document_control_disposal.sql` — claimed consecutively from the
first free number after a fresh scan of open branches (register: `docs/architecture/MIGRATION_COLLISION_REGISTER.md`;
re-check at PR time). 177 migrations apply on a fresh database; schema/migration parity 420/420.

**Indexes and constraints (32 across the six migrations), the ones that hold the invariants:** unique
definition per scope/key/version; unique artifact SHA-256; unique control number per book; unique external
reference per document/type/issuer/value with a lookup index per book; unique event sequence per document;
unique number allocation per scope/series/branch/period/sequence and unique idempotency key; CHECK on
device-block ranges; unique template key per scope; unique revision per template; unique artifact per
revision; unique derivative per document/kind/hash. **Triggers (5):** `documentControlEvents` append-only
(UPDATE and DELETE refused); `documentTemplateRevisions_released_immutable`; `documentDerivatives_never_overwritten`;
`commercialDocuments_original_immutable` (a captured row's bytes pointer and hash never change).

## Definitions imported

* 15 platform system definitions seeded by 0178 from `SYSTEM_DEFINITIONS` (invoice, credit note,
  statement, manifest, field ticket, disposal ticket, vendor bill, purchase order, remittance, audit
  package, external disposal receipt, scale ticket, fuel receipt, expense receipt, unclassified external
  document).
* The package's 46 definitions imported by `documentControl.definitions.catalogSeed`: **43 new**, **3
  aliased** onto existing kinds (commercial invoice → `invoice`, disposal ticket / waste disposal receipt →
  `disposal_ticket`, freight and oilfield manifest → `manifest`), 12 long keys shortened
  (`PACKAGE_KEY_RENAMES`, e.g. `waste_manifest_internal_record`, `oilfield_waste_tracking_form`,
  `dot_fmcsa_registration_authority`). Idempotent: a second run inserts nothing and reports it.
* 81 source artifacts registered by SHA-256 and verified from disk on every run; PDF/DOCX pairs are one
  definition and one template family each.
* Regulatory provenance is product behaviour: `representationPolicy` + `representationNotice` per
  definition ("Internal record. Not the official EPA Uniform Hazardous Waste Manifest."; "Internal
  compliance record; not an agency-issued form."), printed on every rendering and shown on every detail;
  jurisdiction-neutral core (`jurisdictions`, `jurisdictionPolicy`, `regulatoryBasis` as data);
  retention UNCONFIGURED until a person assigns a policy; nothing invented.

## Templates

* 46 template families seeded from the catalog (one per definition family), each with a released
  revision; the 4 markdown-rendered compliance records are renderable by the present text renderer
  (`leaseos_text_v1` = `renderPdf`), the 42 PDF/DOCX families are registered and printable as supplied
  (no PDF-overlay or HTML renderer exists; owner decision D-DC-05, not disguised).
* Standard semantic mappings released as revision 2 for 14 families (revision 1 retired, artifacts
  carried; records already rendered stay on revision 1).
* Company templates: upload (untrusted bytes: type, signature, size, hash; PDF, DOCX or markdown-text),
  map through the semantic layer, draft, release (immutable at the database), supersede, retire. A
  markdown-text company template renders through the present renderer; scenario A of the disposal slice
  proves it end to end.

## Scanner / import convergence

`documents.capture` (server-hashed, stored once as evidence, registered at `captured`, no template and no
known form required, idempotent by capture reference, declared type must match bytes) →
`documents.extract` (engine-neutral OCR reading → proposal only: `documentExtractions`, assistant
proposal with every field `proposed` and sensitive fields asked, raw text as derivative, numbers as
`ocr_proposed` references) → `documents.confirm` by a person. Unknown forms are retained as
`needs_classification`. Original immutable (trigger); derivatives append-only (trigger). No OCR engine
and no native scanner/printer integration is claimed; the two procedures are the server contract a
native front-end calls.

## Disposal flow

Proved by two DB tests: **B, with no LeaseOS disposal template** — job → load → facility paper → scan →
extraction → confirm → assistant commit (`disposal_ticket_create`, unchanged) creating the disposal
record and linking the register row to it → disposal line refused until verified →
`commercialOffice.disposal.verifyTicket` (who/when recorded, load → `disposal_verified`, linked documents
told) → disposal line → invoice document rendered by `invoicing.render` and registered under `INV-…` →
audit trail by load, by ticket, and the scan's timeline event by event, actor by actor. **A** adds the
company's own disposal ticket rendered and issued under the `DSP-…` number beside the paper. B passes.

## Security

Existing `roleProcedure` framework only: 8 new permissions (`document.read/intake/confirm/issue/void/
catalog.manage/series.manage/template.manage`) granted per role in `recordsAuthorization.ts`; 36 new
procedures mapped (35 `documentControl.*` + `commercialOffice.disposalTicketVerify`); census 670. The acting
business comes from `resolveActingScope`, never from a request body; every read and write is book-scoped;
cross-tenant links, extractions, derivatives, verifications, templates and searches fail closed as "not
found" before anything is stored (tested at B, D, F, G, H). Idempotency on capture, allocation, seeding,
attachment. Uploaded bytes untrusted and signature-checked.

## Verification

Per checkpoint, the full `scripts/ci-gate.sh` on a fresh database (reserved slots, migrations, table
parity, `tsc --noEmit`, test-file typecheck ratchet at 0, bare-procedure check, complete vitest suite
including column parity and reserved-word audit) plus `pnpm build`; focused suites first. Final gate
(H): 177 migrations, parity 420/420, tsc clean, test-file type errors 0, vitest 4799 passed / 3 skipped / 1 failed
(the pre-existing calendar guard below), build clean. Document Control's own tests: 80 (`documentControl.db.test.ts` 21,
`numberSeries.db.test.ts` 7, `documentDefinitions.test.ts` 20, `documentRegister.test.ts` 13,
`documentTemplates.test.ts` 6, `semanticFields.test.ts` 6, `documentIntake.test.ts` 3,
`DocumentControlView.dom.test.tsx` 4). Concurrency: eight workers minting fifteen numbers each on one
series get 120 distinct numbers, 120 ledger rows and no gap.

**Pre-existing failure, not this branch's:** `server/calendarFixtures.test.ts` — a date-triggered guard
that fails from 2026-09-24 because fixtures in `capitalAssets.test.ts` (untouched here) fall inside its
three-week window; proved identical on the untouched base `7759056` in a worktree. Left for its owner.

**Required test matrix (25):** 1 F/G · 2 A · 3 B · 4 B · 5 B/F/G · 6 F · 7 D · 8 D/E · 9 C/B (reprint is an
event, never a number) · 10 B (amend/supersede) · 11 A/H (representation notice) · 12 A/H · 13 G ·
14 H · 15 A · 16 D · 17 A · 18 D · 19 C · 20 C · 21 C · 22 C · 23 G (stale layout) · 24 F · 25 G.

## Existing engines reused (not rebuilt)

`commercialDocuments/Links/Deliveries` register (0144); `commercialCategoryTypes`; `evidenceRecords`,
seals, `storagePut/storageRead`; `trackingSequences` + `nextTrackingNumber`; `commercialNumberingPolicies`;
`recordAmendments`; `aiProposal.FORMS` and the proposal tables; `documentExtraction` (classify, dispose,
extract); `assistantCommitService` + `disposal_ticket_create`; `renderPdf`/`sha256Hex`;
`resolveActingScope` / `coreRecordOwnership`; `closeout` field tickets; `invoicing.render`;
`searchEverything`; the client's `DashboardRoute`, components and container/view/DOM-test pattern.

## Outstanding work (named, with its seam)

* Native scanning and printing (Capacitor): `capture`/`extract` are the server contract; no shim built.
* PDF/DOCX field mapping renderer (`pdf_overlay`, `html_layout` absent — D-DC-05).
* OCR engine wiring (server-side or device) and a facility-alias resolver (D-DC-07).
* Jurisdiction pack content (structure exists, nothing seeded); retention policies per definition.
* AI Secretary model calls (prepare/propose primitives exist; the boundary is enforced by the state
  machine and the actor source on every event).
* Verification automation from facility-statement matching (the verifier is a person today).
* Billing-readiness wiring for `evaluateBillingReadiness` (no production caller before or after).
* Tenant scoping of the non-register entity searches in `searchEverything` (pre-existing gap; the register
  hits are scoped).
* The `calendarFixtures` guard on `capitalAssets.test.ts` (pre-existing, date-triggered).
