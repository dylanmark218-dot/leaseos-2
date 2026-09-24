# Document Control — implementation record

One record for the implementation checkpoints of `docs/document-control/document-control-design.md`.
Each section names the SHA it was built on, the migration it added, what it reused, what it tested,
and what it deliberately left out. Counts are read from the gate output, not written by hand.

Starting point: `main` = `0cd4817` (release `v23.25`, migration head `0174`); branch
`claude/document-control-architecture-jlffzk`, base commit `7759056` (the design document).

Baseline gates on the untouched tree, run locally against MariaDB 10.11: 174 migrations apply,
parity 410/410, `tsc --noEmit` clean, test-file type errors 0, vitest 330 files / 4702 passed /
3 skipped / 0 failed, production build clean.

---

## Checkpoint A — definition registry and catalog (migration 0178)

**What it adds.** `documentDefinitions` (the behaviour of a class of controlled record: origin,
numbering, external-reference, signature, revision, print, extraction, read category, sensitivity,
jurisdiction, representation policies — each a column) and `documentSourceArtifacts` (every supplied
artifact by SHA-256 with source collection, role and family). Fifteen system definitions are inserted
by the migration, generated from `SYSTEM_DEFINITIONS` in `server/_core/documentDefinitions.ts` and
held in step by test. The supplied catalog (46 families, 81 artifacts, 3.7 MB under
`data/document-control/`) is asserted by `seedDocumentCatalog`: 43 new definitions, three families
(`commercial_invoice`, `disposal_ticket_waste_disposal_receipt`, `freight_and_oilfield_manifest`)
attached to the kinds the register already had, twelve package keys shortened to the register's
40-character limit with the package key kept on the row, every artifact's hash recomputed from disk
before its row is marked verified.

**Product behaviour the caveats became.** `representationPolicy` + `representationNotice`: the five
US carrier-compliance records carry "Not an official FMCSA, DOT or other agency form or filing" in
their displayed label; the internal waste-manifest record is `attach_official_record_required` and
carries "Not the official EPA Uniform Hazardous Waste Manifest…"; NORM, environmental and oilfield
records carry the jurisdiction notice and `jurisdictionPolicy = configurable_verify_by_jurisdiction`;
every definition has `regulatoryBasis = not_inferred_from_template`. No retention period and no
regulatory field list is seeded anywhere; `retentionPolicyId` NULL means UNCONFIGURED.

**Numbering translated, not adopted.** `CONTROLLED_SEQUENCE_*` → `leaseos_series_optional` (a series
the tenant may enable; detected codes such as `JSA`, `BOL`, `POD` become the series type; "FOR" is
recognised as the word FORM and discarded); `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` →
`archival_only`; receipts are `archival_only`; the facility receipt and scale ticket are
`external_only` with a required external reference and can never be rendered by LeaseOS.

**Reused.** `commercialCategoryTypes(document_type)` (each definition key becomes a built-in
document type so the 0144 register accepts it unchanged); `layerFor`-style platform/tenant layering;
`resolveActingScope`/`SINGLE_TENANT_ID`; `roleProcedure` + `OPERATIONAL_PROCEDURE_PERMISSIONS` +
`SENSITIVE_PERMISSIONS`; `restrictedVault.SensitivityTier`; the `evidenceRelationships.entityType`
vocabulary (mapped, not copied). Not built: a second category catalog, a second permission scheme,
a per-form table.

**Surface.** Router `server/documentControlRouter.ts`, seven procedures: `definitions.list/get`
(`document.read`), `definitions.catalogSeed/overlay/create/retire` (`document.catalog.manage`,
sensitive), `artifacts.list` (`document.read`). Eight new permissions in the union
(`document.read|intake|confirm|issue|void|catalog.manage|series.manage|template.manage`), granted by
role (management holds all; office holds up to void and templates; driver intake and read). A tenant
overlay may change only `TENANT_OVERRIDABLE_COLUMNS`; a tenant-authored definition may only use
`leaseos_series_optional | external_only | archival_only`.

**Tests.** `server/_core/documentDefinitions.test.ts` (19): enum/schema mirror, link-vocabulary
mapping, system invariants, SQL/constant agreement, 46/81 catalog counts, one definition per PDF/DOCX
pair and per two-PDF family, template optional everywhere, numbering translation, compliance and
waste-manifest representation, jurisdiction policy, extraction profiles, invariant refusals, overlay
column discipline. `server/documentControl.db.test.ts` (4): seed twice with identical state, 81
artifacts verified by hash, role gate on seeding, overlay visible to one business only and untouched
platform row, tenant-authored definition with numbering restricted by the input schema, key
shadowing refused.

**Gates.** `tsc` clean; test-file type errors 0; parity 412/412; procedure census 641 (+7);
reachability, reserved-word, migration-ledger and commercial-office suites green;
`LEASEOS_CURRENT_STATE.md` regenerated. Build: see the commit.

**Left out on purpose.** Semantic required fields (Checkpoint E), template revisions (D), the
register extension that makes definitions govern records (B), storage upload of the binaries
(they stay as repository seed data with `repositoryPath`; `storageKey` is filled when a tenant's
storage receives them in D).

---

## Checkpoint B — the origin-aware register (migration 0179)

**What it adds.** The 0144 `commercialDocuments` row now carries `originKind` (eight values; NULL on
legacy rows reads as "unrecorded", never a guess), `issuerKind` with its resolution (`issuerOrgRef`,
`issuerFacilityId`, `issuerName`), `definitionRef`/`definitionKey`, `controlNumber` (unique per
business through `bookScopeKey`, NULL on every externally issued document), `controlState`
(`captured → needs_classification | proposed → confirmed → issued`, side exits `void` and
`withdrawn`), template and render provenance, capture device and import channel, and who confirmed,
issued or voided it. `commercialDocumentLinks` gains `recordId` beside the ref, a `role`, and whether
a person, the owning domain or an extraction proposed it. Two new tables: `documentExternalReferences`
(issuer-scoped identifiers: Facility A's 12345 and Facility B's 12345 both exist; within one issuer
identical bytes are refused and different bytes need a recorded reason; a row that mirrors a
domain-owned column says so) and `documentControlEvents` (append-only, per-document sequence, with
BEFORE UPDATE/DELETE triggers that refuse outright).

**The single write path.** `server/_core/documentRegisterService.ts`: `registerControlledDocument`,
`confirmDocument`, `issueDocument`, `voidDocument`, `supersedeDocument`, `withdrawDocument`,
`amendDocument`, `documentView`, `listDocuments`. Every write runs `registerRefusals` (pure,
`documentRegister.ts`) and then, inside one transaction, resolves every link against the acting
business's scope (a record another business owns is "not found", never "forbidden"), judges duplicate
references, and appends the timeline event. The three rules that never bend: LeaseOS is never the
issuer; an externally issued document never carries a LeaseOS-minted number; an external document
cannot skip confirmation while a rendered one enters issued.

**Revisions.** A supersession is a new row with `version + 1` that carries the provenance, links and
confirmed references forward and takes the control number from the old row (released in the same
transaction so the unique index sees one holder at a time). The same bytes are refused: a reprint
is a print event, not a revision. `amend_with_reason` definitions correct keyed facts (issuer name,
issued date, title) with the original and corrected values kept side by side in `recordAmendments`
(its first production writer); the bytes and the hash are never touched. `domain_managed`
definitions refuse amendment: their domain corrects them.

**Reused.** 0144 register, links and deliveries (extended in place; the legacy `register` and
`supersede` procedures keep working, bind the definition and the scope key, and record no origin);
`recordAmendments`; `nextTrackingNumber` for the archival `DOC-` ref (bound into the transaction in
Checkpoint C); `evidenceRecords` legal-hold refusal on withdraw; `coreRecordOwnership` for unit and
operator scope; `jobs.orgRef` for job, load, trip, field-ticket and disposal-ticket scope;
`facilities` as a shared directory. Not built: a second link table, a second audit ledger beyond the
per-domain append-only convention the repository already uses, a numbering allocator (C).

**Surface.** Ten procedures: `documents.intake` (`document.intake`), `registerRendered`
(`document.issue`), `confirm` (`document.confirm`), `issue` (`document.issue`), `void`
(`document.void`), `supersede` (`document.issue`), `withdraw` (`document.void`), `amend`
(`document.confirm`), `get`/`list` (`document.read`). Census 651 (+10).

**Tests.** `server/_core/documentRegister.test.ts` (13): enum/schema mirror, the three rules,
import-acceptance and template-reference refusals, unclassified waiting states, evidence-not-key
for externals, issuer scope keys and value normalisation, duplicate verdicts, the lifecycle table,
disposal-source translation, provenance sentences. `server/documentControl.db.test.ts` (+5):
facility scan in → proposed reference and link → confirmed by a person with the timeline in
sequence → frozen facts → amendment kept beside the original; two facilities' 12345 coexist, same
bytes refused, different bytes need a reason, search by the facility's number shows origin on each;
cross-tenant link not found, cross-tenant read/confirm/list empty, unclassified named by a person;
rendered field ticket issued with its domain number, duplicate number refused, same-bytes
supersession refused as a reprint, amendment refused for domain-managed, supersession carries the
number and links, append-only timeline enforced by the database, void refused after issue,
withdrawal keeps the number; void of a captured scan, legacy 0144 path reads "origin unrecorded"
and cannot be issued.

**Gates.** See the commit: `tsc` clean, test-file type errors 0, parity 414/414, census 651,
reachability, reserved-word, migration-ledger, commercial-office, audit-package and portal
suites green, current state regenerated, build clean.

---

## Checkpoint C — controlled numbering with a ledger (migration 0180)

**What it adds.** Nothing replaces the counter. `trackingSequences` gains `orgRef`/`scopeKey`
(COALESCE(orgRef,'default')) and its unique index gains the scope, so a business's `JSA` series is
its own while the archival `DOC` series and every legacy caller (FT, INV, DSP, CR, …) stay on the
default scope untouched. Around the counter: `numberAllocations` (one row per minted number, written
in the SAME transaction as the counter bump and the record — a failed insert rolls the counter back
and leaves no gap; `reserved | issued | voided | damaged | lost | unused_retired` with a reason code
and text; unique on (scope, series, branch, period, sequence), which is the database's own refusal
to issue a number twice; unique idempotency key per scope and series) and `numberBlocks` (a
contiguous range cut from the same row-locked counter for one enrolled, active device to issue
offline; `active | exhausted | retired | device_lost`; unique first sequence; CHECK on the range).

**Engine.** `server/_core/numberSeries.ts`: `ensureSeriesRow` (INSERT IGNORE outside the transaction
— inside it deadlocks under contention, as the sheet-serial allocator found), `mintNumberInTx`
(inside the caller's transaction, idempotent on a key), `reserveNumber` / `issueReserved`
(two-phase for drafts), `voidNumber`, `allocateDeviceBlock`, `consumeFromBlock` (block must be the
device's and active, sequence inside the range, replay on the device's capture reference, the unique
index refuses a second consumption), `retireBlock` (every unissued number of a lost or retired device
gets a row saying why; the counter never moves back; nothing is reissued), `gapReport` (every
sequence handed out with its state: issued, explained, `held_by_device` for a live block, or
`unexplained` — zero for anything minted through this module; a non-zero count on FT/INV/DSP is the
legacy path's burn, reported honestly), `listSeries`. Formats come from the business's
`commercialNumberingPolicies` row when it wrote one, else prefix = series type in the standard
shape, and are frozen on the counter row per period. `MAX(number)+1` appears nowhere.

**Register integration.** The archival `DOC-` ref and any `leaseos_series*` control number are now
minted inside the register's transaction with their ledger rows; `documents.issue` mints from the
business's series, or consumes a device-issued number from the device's block; voiding a document
that carries a series number explains the number in the ledger; `trackingReferences` (unique per
number) is written only for the global default scope — a business-scoped series has the same shape
in every book and is indexed by the ledger and the register's (book, controlNumber) index.

**Reused.** `trackingSequences` + the `LAST_INSERT_ID` discipline and `assertExactlyOneRowUpdated` /
`affectedRowsFrom` / `singleNumberFrom` from `sheetSerialAllocator`; `formatTrackingNumber` /
`periodKeyFor` / `DEFAULT_FORMAT` from `trackingNumbers`; `commercialNumberingPolicies` +
`numberingPolicyFor` for per-business formats (configured through the existing
`commercialOffice.numbering.set`); `fieldDevices` for enrolment and status; `trackingReferences`
as the global index. Not built: a second counter, a second allocator, a per-tenant fork of the
legacy series (D-DC-03: historical counters stay), a device-side minting path (a device only ever
holds a range the server cut).

**Surface.** Six procedures: `series.list`, `series.gapReport`, `series.blocks` (`document.read`);
`series.allocateDeviceBlock`, `series.retireDeviceBlock`, `series.voidNumber`
(`document.series.manage`, management). `documents.issue` gains `deviceNumber`. Census 657 (+6).

**Tests.** `server/numberSeries.db.test.ts` (7): eight workers × fifteen mints → 120 distinct, 120
ledger rows, no gap; six concurrent device blocks → disjoint contiguous ranges from one counter and
a server mint beyond them; consume outside the block / from another device refused, retried capture
replayed, second consumption refused by the database; lost tablet → six lost rows with the reason,
two issued kept, consumption refused after loss, replacement block starts after, report explains
all; void keeps the row and the counter, a rolled-back mint leaves no gap, a retried key mints
nothing; series independent, businesses isolated (both mint 000001), the legacy default-scope
counter untouched, another business cannot void; the register mints JSA-…-000001/000002 for
rendered JSAs, a proposed one takes a device-block number at issue, the gap report reads
1..6 with the two unconsumed block numbers held then `unused_retired` after retirement, office
cannot cut blocks.

**Gates.** See the commit: `tsc` clean, test-file type errors 0, parity 416/416, census 657,
reachability, reserved-word, migration-ledger, tracking-number coverage, commercial-office and
Document Control suites green, current state regenerated, build clean.

---

## Checkpoint D — template families and immutable released revisions (migration 0181)

**What it adds.** `documentTemplates` (a family: definition, source — `leaseos_standard |
organization_custom | customer_supplied | external_form` — owner, key; platform or one business),
`documentTemplateRevisions` (what a document is rendered from: layout kind and hash, field-mapping
JSON and hash, renderer key and version, one release manifest over all of them; `draft | released
| retired`), `documentTemplateArtifacts` (a PDF and a DOCX of one form are two artifacts of one
revision, never two definitions and never two templates). **Released is immutable at the
database**: a BEFORE UPDATE trigger refuses any change to a released revision's layout, mapping,
renderer, manifest or release columns, and permits only released → retired.

**Seeded standards.** The catalog seed now creates one platform family per supplied package family
(46), revision 1 released, every artifact attached with its role (66 canonical PDF/DOCX + the four
markdown render sources = 70 links; the two DOT/FMCSA PDF variants are `printable` and
`printable_alternate` under one revision). Layout: `markdown_text` where the package supplies a
render source (four families, renderable by the present `renderPdf` text renderer as
`leaseos_text_v1`), else `pdf_overlay` (forty-two families, registered and printable as supplied,
**not renderable** until the PDF library decision D-DC-05 — `RENDERERS` says so by name). Revision 1
mappings are empty; Checkpoint E releases mapped revisions. A rerun creates nothing.

**Register binding.** A rendered document naming a `templateRevisionRef` is refused unless the
revision exists, is released (a draft renders nothing; a retired revision takes no new records — the
records already on it stay), belongs to the document's definition, and is the platform's or this
business's own; the template's source must agree with the origin (a customer's form renders as
`customer_template`, never as LeaseOS's). The binding is a timeline event carrying the release
manifest hash.

**Custom forms (foundation).** `templates.createCustom` takes a business's or a customer's form as
uploaded into the evidence vault — a PDF or a DOCX under the evidence size cap with a plain file
name, hashed and registered untouched, never executed — and opens revision 1 as a draft with no
fields mapped. `revisionDraft` makes revision N+1 from a new layout, a new mapping or both (the
unchanged pair is refused; one draft at a time); `revisionRelease` computes the manifest, makes it
current and retires the previous released one for new records; `retire` closes the family. A
platform standard cannot be drafted from inside a business. Arbitrary-PDF field detection is not
built; a mapping is typed by a person against the semantic registry (E).

**Reused.** `documentSourceArtifacts` (A) as the artifact store; `renderPdf` (`ticketPdf.ts`) as the
one renderer; `evidenceRecords` + `evidence.upload` for custom-form bytes; the register (B) for the
binding. Not built: a second renderer, a PDF library, an AcroForm reader, a per-format definition.

**Surface.** Six procedures: `templates.list/get` (`document.read`); `createCustom`,
`revisionDraft`, `revisionRelease`, `retire` (`document.template.manage`: management and office).
Census 663 (+6).

**Tests.** `server/_core/documentTemplates.test.ts` (6): enum mirror, renderer honesty, mapping
hash independent of field order, manifests change with every input, the four markdown sources
fill and render to PDF 1.4 through the present renderer with no invented values, untrusted-upload
refusals. `server/documentControl.db.test.ts` (+2): 46 families / ≥46 released revisions / 70
artifact links, PDF+DOCX under one revision with source collection and hash, invoice family on the
existing definition, DOT variants under one revision, database refuses mapping/renderer/status
changes on a released revision, platform standard not draftable; a business uploads a PDF form
(HTML refused), a driver cannot release, a draft renders nothing, wrong origin refused, document
issued and bound on revision 1, revision 2 drafted from a mapping change and released, revision 1
retired for new records and refused, the earlier document still on revision 1, another business
sees nothing, unchanged mapping refused.

**Closing the checkpoint.** Two things the first run showed: (1) a rendering is linked to the
load's operator and unit whether or not the caller named them — `resolveSemanticContext` now returns
the effective context (the load supplies its job, operator and unit) and `renderFromTemplate` links
from that, so the record is about what it was filled from; (2) `definitions.get` returns
`extractionForm` — the slot list a scan of that kind is proposed against, from `formFor` — so the
compliance forms are reached from production code, not only from a test. Two repository census
pins that count procedures (`crossLayerIntegrity` 696→728, `operationalApiAuthorization` 634→666)
were bumped for the 32 procedures of A–E; they had not been run at A–D (focused suites only), so
their bump lands here. The suite seeds one unowned operator and unit before its own tenant-owned
ones: older suites in the shared database address "operator 1"/"unit 1" in the default scope.

**Gates (full `scripts/ci-gate.sh`, fresh database).** 175 migrations apply; parity 419/419;
tsc clean; test-file type errors 0 (pin 0); vitest 336 files: 4764 passed, 3 skipped, 2 failed:
`calendarFixtures.test.ts` — **pre-existing and date-triggered**: on 2026-09-24 the fixtures in
`capitalAssets.test.ts` (a file this branch does not touch) fall within the guard's three-week
window; it fails identically on the untouched base `7759056` (proved in a worktree) and is not
this branch's; and `dispatchConcurrency.test.ts › created every table the schema declares` —
**caused by this session's own concurrent edit**: the F table was added to `drizzle/schema.ts`
while the E gate was running against an E-migrated database; on the E tree alone (F edits
stashed) the test passes, and the F gate carries it. Build clean.

---

## Checkpoint E — the semantic field layer, mapped revisions, prepare and render (no migration)

**What it adds.** `server/_core/semanticFields.ts`: one registry of keys in the repository's nouns
(`operator.name`, `unit.unitNumber`, `job.jobCode`, `load.quantity`, `facility.name`,
`billing.afeNumber`, …) each naming the table and column it is read from, with three authorities
that are the AI Secretary boundary made concrete — `auto_fill` (read from LeaseOS Records),
`human_only` (signatures, hazards, weights and readings, acceptance, another issuer's number,
jurisdiction: no renderer and no model supplies them), `server_only` (the control number, the
archival ref, the issue timestamp: set at issue, never by a person or a template). A test checks
every auto-fill source against `drizzle/schema.ts`. `semanticResolver.ts` copies those values from
the authoritative rows in the acting business's scope and names the row each came from. Adding a
key is a code change with a test; it is not tenant-configurable.

**Mapped revisions.** `documentStandardMappings.ts` maps the printed labels of fourteen
representative families (BOL, POD, JSA, tailgate, daily safety report, incident report, oilfield
load ticket, disposal ticket, waste pickup ticket, hotshot ticket, and the four markdown-rendered
compliance records) to the registry; the seeder releases each as revision 2 (retiring the empty
revision 1 for new records, carrying the artifacts) and is idempotent by mapping hash. The disposal
mapping keeps the facility's number, the weights and the acceptance out of any auto-fill. The
remaining 32 families keep their empty revision until a person maps them; nothing is guessed from a
PDF. A business's own mapping is validated against the same registry (`driver.fullName` is refused;
`operator.name` is the key).

**Forms reconciled.** `documentControlForms.ts` compiles the package's four structured compliance
forms from the reference JSON (kept with its SHA-256) to the engine's `FormDefinition` at load,
refusing any field type the engine lacks; a test holds the compiled forms against the drop-in's keys
and field counts. `formFor` answers the engine's forms first, then these, then nothing. The drop-in
TypeScript is not copied.

**Prepare and render.** `documentRenderService.prepareFromTemplate` (the dry run and the Secretary's
future primitive): every mapped field resolved with provenance (`jobs.location#17`), person-only
fields left to the person (a person's value never overrides a record's), server-only fields marked
for issue, required-and-missing named, and whether LeaseOS can render the layout at all.
`renderFromTemplate`: for a markdown-text layout, fill (a missing value is a visible blank, never an
invention), render through `renderPdf`, store, and register through the one write path bound to the
revision with a render manifest, links to the records it was prepared from as `domain`-sourced, and
— where the definition mints — a number reserved before rendering so the paper carries it, issued in
the register's transaction, voided with a reason if rendering fails. A layout the renderer cannot
execute is refused with the D-DC-05 reason. The definition's representation notice is printed at the
top of every rendering.

**Reused.** `renderPdf`/`sha256Hex` (`ticketPdf.ts`); `storagePut`; `FORMS` and `FieldType`
(`aiProposal.ts`); `coreRecordOwnership` for operator/unit scope; `jobs`, `loads`, `billingBooks`,
`facilities`, `customerAccounts`, `organizations` as the authoritative sources; the register (B),
the series (C: `reserveNumber`/`issueReserved`), the templates (D). Not built: a duplicate domain
field, a PDF-filling renderer, a model call.

**Surface.** Three procedures: `semantic.fields` and `semantic.prepare` (`document.read`),
`semantic.render` (`document.issue`). Census 666 (+3).

**Tests.** `server/_core/semanticFields.test.ts` (6): registry integrity against the schema,
authorities, mapping refusals, the fourteen standard mappings valid with record and person fields
mixed and `operator.name` reused across six or more forms, the disposal mapping's human-only facts,
the four compliance forms compiled and matched to the drop-in. `server/documentControl.db.test.ts`
(+2): mapped revision 2 released once with revision 1 retired and artifacts carried, rerun releases
nothing, a business's unknown key refused; prepare resolves site and unit from real rows with
provenance, marks the archival ref server-at-issue and the reading human-only, names
`jurisdiction` as required-and-missing, finds nothing across tenants, refuses to issue with a
required blank, renders a NORM record from a person's jurisdiction and reading (the record's site
value not overridden) to a real PDF 1.4 whose hash matches the stored bytes, bound to its revision
with a render manifest and domain-sourced links, and refuses a PDF layout by name.

**Gates.** See the commit.


## Checkpoint F — scanner and import convergence

**Commit.** _(filled at commit)_ · migration `0182_document_control_intake.sql` (next free after 0181 on this
branch; register updated) · census 669 (+3) · `documentIntakeService.ts`, `documentIntake.test.ts`,
`documentControl.db.test.ts` (+5).

**Capture.** `documents.capture` takes bytes — a photo, a PDF, an exported office file — and does what a
scanner front-end needs done on the server: refuses what cannot be captured before any byte is stored
(size, a declared MIME type the bytes do not open as, a rendered origin, an office file called a scan,
a register invariant, a link out of scope), hashes the bytes itself (a client's hash is never written),
stores them once under a content-addressed key, creates the `evidenceRecords` row (category
`document_control`, the device's `clientCaptureRef` for idempotency, the job from a job link), and
registers the row at `captured` under whatever definition is known — by default
`unclassified_external_document`. NO TEMPLATE AND NO KNOWN FORM PREVENTS THIS. The same capture
reference twice is one document and no second object; the same bytes under a new reference are
captured and flagged with the document they duplicate. The evidence engine (`evidenceRecords`,
`storagePut`, seals) is reused as is; nothing about it changed.

**Extraction as proposal.** `documents.extract` takes an engine-neutral `OcrResult` (LeaseOS runs
no recogniser here; the reading comes from a device's engine, a server engine when one is wired, or
a person's transcription flagged as such) and runs it through the existing extraction engine
(`classifyDocument`, `extractToProposal` — extended by one optional argument, the form the
document's definition names, so a form outside the engine's four keyword types can take a reading
when the register or the scanner already said what the document is). What comes out is recorded as
a proposal only: a `documentExtractions` row (0027, now tied to the register row by `documentId`),
an `assistantProposals` row with `proposalFields` (every field `proposed`, source `photo_ocr`) and
`assistantQuestions` (every sensitive field asked of a person), the raw text as an `ocr_text`
derivative, and any number the reading found as an `ocr_proposed`, unconfirmed external reference —
only where the proposed definition carries that kind of reference. The register row's facts do
not move: definition, issuer and every confirmed reference stay what they were; the state goes to
`proposed` (a form took the reading) or `needs_classification` (nothing did — the document is
retained, in the review facet, never dropped). A person confirms through `documents.confirm`, which
now carries the issuer they name onto a reference proposed while the issuer was unknown. A frozen
document (confirmed, issued, withdrawn) refuses an extraction. The proposal itself stays in the
assistant's review queue for its typed domain commit (the disposal adapter, in G).

**Derivatives.** `documentDerivatives` (0182): what was made from the original — OCR text, a page
image, a thumbnail, a redaction, a searchable PDF — with its own storage key (content-addressed under
the document, never the original's), its own hash, its producer and version, and the original's
hash it came from. Idempotent on (document, kind, hash). Byte-identical to the original is refused: a
derivative is something made from it. Two database triggers make the invariants hold below the
application: a derivative row's columns are never updatable, and a captured document's `contentHash`
and `evidenceRecordId` are never updatable (a corrected scan is a new document). `documents.get`
returns `derivatives` and `extractions` beside links, references, versions, amendments and the
timeline, which records `document.derivative_added`, `document.extraction_recorded` and
`document.proposed` with the engine, the proposal and the counts.

**Not built, and not called built.** No OCR engine, no native scanner or printer integration, no
browser shim presented as either: the `capture`/`extract` procedures are the server contract a
native front-end (Capacitor or otherwise) calls with the bytes and the reading it produced. No
`document_control_confirm` adapter in `planAssistantCommit`: a document's facts are confirmed by
`documents.confirm`; a proposal's domain facts commit through the adapter the form already has
(disposal, fuel, expense) — G wires the disposal case to the register row. No facility-alias
resolver (D-DC-07 open).

**Reused.** `evidenceRecords` + `storagePut` + `sha256Hex`; `classifyDocument`, `disposeField`,
`extractToProposal`, `CONFIDENCE_POLICY` (`documentExtraction.ts`); `assistantProposals`,
`proposalFields`, `assistantQuestions`, `documentExtractions`; the register (B) for the row, the
references and the events; `formFor` (E) for the form.

**Tests.** `server/_core/documentIntake.test.ts` (3): what a capture accepts (types, signatures,
sizes, origins), the document-type → definition and OCR-field → reference-type maps name only
things the register has, a named form takes a reading the classifier would not and proposes every
field with the sensitive ones asked. `server/documentControl.db.test.ts` (+5): capture of a PNG and a
PDF with no template and no definition (server hash, one object, idempotent by capture reference,
declared type must match bytes, duplicate bytes flagged); an unknown form retained as
`needs_classification` with its reading kept as a derivative of the original; a facility ticket's
reading as proposal fields, questions, a proposed reference and a proposed definition with the row's
facts unmoved until a person confirms (and then the reference carries the named issuer; a further
extraction refused as frozen; a scanner's say-so recorded as a human classification, still
unconfirmed); the original immutable at the database (hash and evidence pointer not updatable,
derivative not updatable, original bytes not a derivative, idempotent re-attach); cross-tenant
extract, attach, read and capture-with-link all fail closed with nothing stored.

**Gates (full `scripts/ci-gate.sh`, fresh database).** 176 migrations apply (0182 included); parity
420/420; tsc clean; test-file type errors 0 (pin 0); vitest 337 files: 4773 passed, 3 skipped, 1 failed —
`calendarFixtures.test.ts`, the pre-existing date-triggered guard recorded under E (fails identically
on the untouched base `7759056`; not this branch's). Build clean.


## Checkpoint G — the disposal vertical slice

**Commit.** _(filled at commit)_ · migration `0183_document_control_disposal.sql` · census 670 (+1:
`commercialOffice.disposal.verifyTicket`) · `documentControl.db.test.ts` (+2, the two scenarios).

**The path, as it runs.** job → load (arrived at the facility) → the facility hands the driver its
paper → the driver photographs it and names the job and load (`documents.capture`, links `human`) →
the device's reading is proposed (`documents.extract`: an assistant proposal for the `disposal_ticket`
form, the facility's number as an `ocr_proposed` reference; nothing in the disposal domain, nothing on
the row's facts) → the office confirms the document (`documents.confirm`: the paper is the facility's
receipt, the facility issued it, the number stands) and **the proposal follows the confirmed facts**
(its `facilityId`/`loadId`/`jobId` are set from the confirmed issuer and links — server-resolved,
never read off the paper) → the office works the proposal in the assistant (answers what the reading
asked of a person, reads back, acknowledges) and the one typed commit path (`fieldRoute.assistant.commit`
→ `disposal_ticket_create`, v20.16, unchanged) creates the `disposalTickets` row in `needs_review` —
and now, in the same transaction, the register row is linked to the record it became (`disposal_ticket`,
source `domain`, role `source_document`), the facility's number on it is marked a mirror of
`disposalTickets.facilityTicketNumber`, the extraction is committed and the disposal row's
`evidenceRefs` names the document → a disposal line on a field ticket that names the LeaseOS ticket is
**refused until a person verifies it** (`closeout.lineAdd`, new rule; a number that is nobody's ticket
is kept as typed) → the verifier's act (`commercialOffice.disposal.verifyTicket`, new: in scope through
the ticket's job, refuses another business's ticket as not found; records who and when in the disposal
domain's own new columns, advances the load to `disposal_verified` where it was at or past the facility,
and tells every register row linked to the ticket with a `document.domain_verified` event) → the
disposal line enters → the invoice's document is rendered by the invoicing engine (`invoicing.render`)
and registered as the tenant's issued record under the domain's number (`documents.registerRendered`,
definition `invoice`, `system_rendered`, `INV-…`, linked to the job, the load, the disposal ticket and
the invoice) → the audit trail: the register lists the documents of a load, a disposal ticket, a job,
each with its own origin, issuer and number, and the scan's timeline reconstructs the chain with its
actors and sources (captured → derivative → reference proposed → proposed → reference confirmed →
classified → confirmed → linked to the disposal record → verified by the domain).

**B passes without any LeaseOS disposal template.** The facility's paper is the original, the
`disposalTickets` row is the fact, the register row is the controlled record that ties them; no
template is looked up, none exists for the definition, none is asked for. **A** adds the company's own
disposal ticket: a markdown-text layout uploaded as untrusted bytes (hashed, kept as evidence, read back
only against the hash the revision released — `layoutTextOf` now reads an uploaded layout from the
evidence store), mapped through the semantic layer, released as revision 2, rendered from the records
(the load's driver and unit, the facility) and the person's values as `proposed`, then issued under the
disposal record's number by the office (`documents.issue` with the domain-managed number). Three
records on one disposal, each with its origin: the facility's paper (`external_scanned`, no LeaseOS
number), the company's ticket (`organization_template`, `DSP-…`), the invoice (`system_rendered`,
`INV-…`). The paper is never replaced by the rendering; a second rendering is a second document, and
the issued one keeps its revision and its number.

**Two catalog and template changes, both small.** The `invoice` definition allows a `disposal_ticket`
link (an invoice for a disposal haul cites the ticket it bills; 0178's seed regenerated — the migration
is unmerged). `text/markdown` is accepted as a custom template layout (`markdown_text`), the one kind
the present renderer executes; a PDF or DOCX is still registered and printable as supplied, not
rendered (D-DC-05 unchanged).

**Not built.** No facility-statement matching → verification automation (the verifier is a person; the
statement engine is untouched and can feed the same act later); no billing-readiness wiring beyond the
disposal-line rule (`evaluateBillingReadiness` has no production caller today and gets none here); no
invoice drafting through the closeout chain in the test — the invoice's rows are fixtured as the office
suites fixture them, the document is rendered by the real engine and registered by the real path.

**Reused.** `executeAssistantCommit` + `disposal_ticket_create` (v20.16) as the one path from proposal
to disposal record; `assistant.answer/readBack/acknowledge/commit`; `closeout.ticketOpen/lineAdd`;
`invoicing.render`; `fieldTicketDocuments`; the register (B), intake (F), templates (D), semantic layer
(E). `loads.chainState` advanced by the verifier, as the adapter's own comment reserved for it.

**Tests.** `server/documentControl.db.test.ts` (+2): B, the whole path with no template, with the
audit trail asserted event by event and actor by actor; A, the company template path on top of it,
with the three-origin picture and the stale-layout check. The G edits to `closeoutRouter`,
`assistantCommitService` and `commercialOfficeRouter` are covered by those two plus the existing
`siteCloseout`, `assistantCommitService` and `commercialOffice.db` suites, re-run green.

**Gates (full `scripts/ci-gate.sh`, fresh database).** 177 migrations apply (0183 included); parity
420/420; tsc clean; test-file type errors 0 (pin 0); vitest 337 files: 4775 passed, 3 skipped, 1 failed —
`calendarFixtures.test.ts`, the pre-existing date-triggered guard recorded under E. Build clean. (The G
commit `f6b95f2` carried this paragraph as a placeholder; it is filled here, at H.)

## Checkpoint H — search, audit, screens, documentation

**Commit.** _(filled at commit)_ · no migration · census 670 (no new procedure; search extended in
place) · `client/src/pages/DocumentControl.tsx`, `DocumentControlView.tsx`,
`DocumentControlView.dom.test.tsx`; `surfacesService.searchEverything` extended; HOS boundary test.

**Search.** `surfaces.search` now finds the register's rows by `documentRef`, LeaseOS number, title,
and another issuer's number on the document (`documentExternalReferences`, issuer-scoped), and only in
the caller's book: the router resolves the acting scope and passes it; `searchEverything` searches the
register only when a book is given, so any other caller keeps exactly the behaviour it had. Each hit
is labelled with its number (the LeaseOS one, else the issuer's, else the ref), definition, title,
issuer ("LeaseOS-issued" / the facility's name / "issuer unknown") and origin, and deep-links to the
document's detail. The pre-existing tenant gap in the other entity searches is unchanged and noted
(§19 of the design).

**Screens.** `/document-control` (`DashboardRoute`, the existing layout and components; the container/
pure-view/DOM-test split the Commercial Office uses). Document Library: every document whatever its
origin, an origin badge on each row ("ACME Disposal · external scanned", "LeaseOS-issued · system
rendered", "origin unrecorded" for a legacy row), the LeaseOS number in the number column and the
internal ref muted where there is none, filters by text, definition, origin, state and related record.
Record detail: provenance sentence, the representation notice where the definition carries one,
internal record vs. LeaseOS controlled number vs. template revision side by side, bytes and retention,
external numbers with issuer, source, confirmation and mirror, related records with role/source/
confirmation, revision history and amendments, source and derivatives (readings and what was made from
the original), print/reprint history from the timeline ("a reprint never mints a new number"), and the
audit timeline as recorded — sequence, event, actor, actor source, device, state before and after,
detail. Review Queue: the register's own `captured` / `needs_classification` / `proposed` states — not a
second queue — with "nothing here is a fact yet". Template Library: families with source, layer, current
revision, renderable-or-not ("registered and printable as supplied"), and a revision list with hashes
and manifests, retired ones readable. Definitions: class, owner, numbering, reference policy,
representation label and notice, jurisdiction policy, layer. Number Series: counters, device blocks,
and a gap report per period naming every void's reason and calling an unexplained gap a finding. All
read-only: writes stay on their own procedures, and no administration app was built beside the product.

**Documentation.** `docs/document-control/DOCUMENT_CONTROL_ARCHITECTURE.md` (as built: registry,
record, numbering, templates, semantic layer, scanner convergence and the OCR boundary, the disposal
slice, search and screens, the jurisdiction / AI Secretary / HOS / Driver Wallet / Fleet / SDS
boundaries, security and tenancy, sequence recovery, what is not built); the design document points to
it; the migration register carries 0178–0183; `LEASEOS_CURRENT_STATE.md` regenerated; this record.

**Boundary proved.** `documentDefinitions.test.ts`: no platform definition and none of the package's
forty-six is an hours-of-service record, and no definition's owner is the HOS domain (matrix 14).

**Tests.** `DocumentControlView.dom.test.tsx` (4): the library with origins and numbers kept apart and
no origin invented; the detail with every section; the representation notice and the review queue's
wording; templates' immutability note, a definition's notice, and the gap report's finding.
`documentDefinitions.test.ts` (+1). Search covered by the existing `surfaces` suites plus the
register's own list tests; a DB assertion of the register hit is in `documentControl.db.test.ts` (+1).

**Gates (full `scripts/ci-gate.sh`, fresh database).** 177 migrations apply; parity 420/420; tsc clean;
test-file type errors 0 (pin 0); vitest 338 files: 4799 passed, 3 skipped, 1 failed —
`calendarFixtures.test.ts`, the pre-existing date-triggered guard recorded under E. Build clean. The first
H run also caught two things this checkpoint then fixed: the new view had a jsdom suite but no entry in
the axe accessibility suite (`a11y.dom.test.tsx` now renders its five screens and a record detail;
the container is declared not-a-surface with its reason), and the reserved-word audit flagged the word
`precision` in the DC suite (removed from the raw-SQL neighbourhood; the engine's rule is asserted in
`documentIntake.test.ts`).
