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

**Gates.** See the commit.
