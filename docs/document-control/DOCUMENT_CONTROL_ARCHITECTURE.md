# Document Control — architecture as built

_Checkpoints A–H on branch `claude/document-control-architecture-jlffzk`. The design that preceded
the build is `document-control-design.md`; the per-checkpoint record with commits, gates and refusals
is `checkpoints/DC_IMPLEMENTATION_RECORD.md`. This page describes what runs._

## 1. What Document Control is, in one paragraph

One register (`commercialDocuments`, extended — never a second table) holds every controlled document a
business has, whatever produced it: a form LeaseOS rendered from a template, a PDF a domain generated
(a field ticket, an invoice), a photograph of a facility's paper, a file a customer sent, a form a
regulator issued. Each row says what the document **is** (its `DocumentDefinition`), **where it came
from** (`originKind`), **who issued it** (`issuerKind` + the issuer), **which template revision** it was
rendered from if any, **what LeaseOS number** it carries if the definition mints one, and **what other
issuer's numbers** it carries. Those five facts are five columns, never one. A template is one way of
producing a document, optional and separate from the record; a scanned paper never needs one.

## 2. The DocumentDefinition registry (A)

`documentDefinitions` — one row per definition version, platform rows (`scopeKey = 'platform'`) plus a
tenant overlay (`scopeKey = orgRef`) that may override a closed set of columns (`TENANT_OVERRIDABLE_COLUMNS`)
and author its own definitions with tenant-authorable numbering only. Fifteen platform definitions are
seeded by migration 0178 from `SYSTEM_DEFINITIONS` (`server/_core/documentDefinitions.ts`); the supplied
catalog's forty-six are imported by `documentControl.definitions.catalogSeed` from
`data/document-control/` — idempotent (upsert by policy digest), three aliased onto existing kinds
(commercial invoice → `invoice`, disposal ticket → `disposal_ticket`, freight/oilfield manifest →
`manifest`), twelve long keys shortened (`PACKAGE_KEY_RENAMES`). Every source artifact (81 PDF/DOCX/
text files) is registered in `documentSourceArtifacts` by SHA-256, verified from disk on every seed run;
a PDF and a DOCX of one form are one definition and one template family, never two.

A definition carries: class, primary domain owner, allowed origins, numbering policy
(`leaseos_series | leaseos_series_optional | domain_managed | external_only | archival_only`) and series
type, external-reference policy and allowed reference types, whether a LeaseOS template exists / a custom
one is allowed / import is allowed, allowed link kinds, signature, revision and print policy, extraction
profile (the proposal form a reading is put to), read category and sensitivity tier, jurisdictions and
jurisdiction policy, regulatory basis, **representation policy and notice**, industries, pack. The
representation policy is product behaviour, not a caveat file: an `internal_record` definition prints its
notice on every rendering and every detail view ("Internal record. Not the official EPA Uniform Hazardous
Waste Manifest."; "Internal compliance record; not an agency-issued form."), and the register refuses to
describe an external document as LeaseOS-issued or a rendering as a third party's.

## 3. The record: origin, issuer, number, references, links, state (B)

Register columns added in 0179: `bookScopeKey`, `definitionRef/Key`, `originKind`, `issuerKind/OrgRef/
FacilityId/Name`, `controlNumber` (+ unique per book), `controlNumberIssuedAt`, `controlState`,
`templateRevisionRef`, `renderManifestHash`, captured-by (user, device, channel), and the confirm/issue/
void actors and times. `documentExternalReferences` holds another issuer's numbers, issuer-scoped
(`issuerScopeKey` = facility id / org ref / normalised name), so two facilities may both issue "12345";
the same bytes twice from one issuer are refused and different bytes with the same number need a recorded
reason. `commercialDocumentLinks` ties a document to job/load/unit/operator/facility/disposal ticket/
invoice/… with a role, a source (`human | ocr_proposed | domain | system`) and a confirmation status; a
link target is resolved in the caller's book and **fails closed** across tenants.

`documentControlEvents` is the append-only audit timeline (two triggers refuse UPDATE and DELETE): every
act names its actor, the actor's source (human / ai / system / integration / external), the device, the
state before and after, and a detail JSON. Control states: `captured → needs_classification → proposed →
confirmed → issued`, with `void` and `withdrawn` terminal; the transition table is explicit and anything
not listed is refused. Facts are mutable only until confirmed; after that a correction is an amendment
(`recordAmendments`, original beside corrected) or a supersession (a new row, the old one kept and linked).

## 4. Controlled numbering (C)

`trackingSequences` (existing) gained `orgRef/scopeKey` and a unique `(scopeKey, sequenceType, branch,
periodKey)`; the counter is advanced with the LAST_INSERT_ID discipline, never `MAX(n)+1`.
`numberAllocations` is the ledger: one row per number with a unique `(scope, series, branch, period,
sequence)` — two transactions cannot produce one number — and a unique idempotency key, so a retried
request returns the number it already got. `numberBlocks` hands a device a contiguous range with a CHECK
on the range and a unique per-sequence rule below it; a device consumes from its block offline and the
server records each consumption; a retired block explains every number it never used. A number is
reserved before rendering so the paper carries it, issued in the register's transaction, and voided
with a reason if rendering fails. Nothing is recycled: a void keeps its number and its reason; a reprint
is an event on the same document, never a new number. `series.gapReport` classifies every sequence in a
period as issued / reserved / voided-with-reason / held-by-device / **unexplained** — the last is a
finding. Eight concurrent workers minting fifteen each get 120 distinct numbers and no gap (test).

## 5. Template families and immutable revisions (D)

`documentTemplates` (a family under a definition and a source: `leaseos_standard | organization_custom |
customer_supplied | external_form`), `documentTemplateRevisions` (layout hash, field-mapping hash,
renderer and version, release manifest over all of them), `documentTemplateArtifacts` (a revision's
PDF/DOCX/text artifacts by role). A **released revision is immutable at the database**: the trigger
`documentTemplateRevisions_released_immutable` refuses any change to its layout, mapping, renderer or
manifest; a change is a new revision; the previous one is retired for new records and every record
already rendered on it stays on it (`templateRevisionRef` never moves). Renderers are named honestly:
`leaseos_text_v1` (`renderPdf`) executes `markdown_text` layouts; `pdf_overlay` and `html_layout` are
absent, so a PDF/DOCX template is registered and printable as supplied, not rendered (owner decision
D-DC-05). Uploaded company or customer templates are untrusted bytes: type and size checked, hashed,
kept as evidence, read back only against the hash the revision released; nothing executable is accepted.

## 6. Semantic fields, mapping, prepare and render (E)

`SEMANTIC_FIELDS` names the values a printed form draws from records, each with an authority: `auto_fill`
(read from the authoritative table.column — no domain field is duplicated; a test holds every source
against the schema), `human_only` (weights, readings, signatures, acceptance, another issuer's number) or
`server_only` (the control number, the ref, the issue time). A mapping is `printedField → semanticKey`
per revision; standard mappings exist for fourteen families and a business maps its own template through
the same layer. `prepareFromTemplate` resolves every field with provenance (`jobs.location#17`), leaves
person-only fields to the person (a person's value never overrides a record's), marks server-only fields
for issue, and names required blanks; `renderFromTemplate` fills (a missing value is a visible blank, never
invented), renders, stores, registers bound to the revision with a render manifest, and links the record
to what it was filled from — the load's operator and unit included.

## 7. Scanner and import convergence; the OCR authority boundary (F)

`documents.capture` is the server contract a device or the office calls with the bytes: refused before
storage if the type, size, signature, origin or a link is wrong; hashed by the server (a client's hash is
never written); stored once as the evidence record; registered at `captured` under whatever definition is
known, by default `unclassified_external_document`. **No template and no known form ever prevents
intake.** Idempotent by the device's capture reference; same bytes under a new reference are captured and
flagged. `documents.extract` takes an engine-neutral `OcrResult` (LeaseOS runs no recogniser) and turns it
into a **proposal only** through the existing extraction engine: a `documentExtractions` row tied to the
register row, an assistant proposal whose fields are all `proposed`/`photo_ocr` with the sensitive ones
asked of a person, the raw text kept as an `ocr_text` derivative, and any number found as an
`ocr_proposed`, unconfirmed reference. The row's facts do not move until `documents.confirm`, by a person,
who names the definition and the issuer and says which proposed references and links stand; a reading
nothing recognises is retained as `needs_classification`, in the review queue, never dropped. The
original is immutable at the database (`commercialDocuments_original_immutable`: a captured row's
`contentHash` and `evidenceRecordId` never change); derivatives (`documentDerivatives`: OCR text, page
images, thumbnails, redactions) are their own rows with their own keys and the original's hash, never
overwritten (trigger), and byte-identical to the original is refused.

## 8. The disposal vertical slice (G)

job → load → the facility's paper → capture (driver names job and load) → extraction as proposal → the
office confirms (the proposal then follows the confirmed facts: facility, load, job, server-resolved) →
the assistant's typed commit (`disposal_ticket_create`, unchanged) creates the `disposalTickets` row in
`needs_review` and, in the same transaction, links the register row to it (source `domain`), marks the
facility's number as a mirror of `disposalTickets.facilityTicketNumber`, commits the extraction → a
disposal line on a field ticket that names the LeaseOS ticket is refused until a person verifies it →
`commercialOffice.disposal.verifyTicket` records who and when (0183 columns on `disposalTickets`),
advances the load to `disposal_verified`, and tells every linked document (`document.domain_verified`) →
the invoice's document is rendered by the invoicing engine and registered as the tenant's issued record
under `INV-…`, linked to job, load, disposal ticket and invoice → the audit trail lists the documents of
a load, a ticket, a job with their origins, and the scan's timeline reconstructs the chain. **This runs
with no LeaseOS disposal template.** With the company's own template (a markdown layout uploaded, mapped,
released), LeaseOS's own disposal ticket is rendered as `proposed` and issued under the disposal record's
number beside the facility's paper — never instead of it.

## 9. Search, audit and screens (H)

`surfaces.search` finds register rows by ref, LeaseOS number, title and another issuer's number, in the
caller's book only, each hit labelled with definition, issuer and origin. `/document-control` mounts the
Document Library (origin badge on every row; detail with provenance, controlled number vs. internal ref,
external numbers with issuer and mirror, related records, revision history and amendments, source and
derivatives, print/reprint history, the audit timeline as recorded), the Review Queue (the register's own
`captured`/`needs_classification`/`proposed` states — not a second queue), the Template Library
(revisions with status, hashes, manifest; retired ones readable), the Definitions (with the
representation label and notice), and the Number Series (counters, device blocks, gaps and voids with
reasons; an unexplained gap is called a finding). Audit packages gather register rows through
`commercialDocumentLinks` as before.

## 10. Boundaries

* **Jurisdiction packs.** The core is jurisdiction-neutral: a definition carries `jurisdictions` and a
  `jurisdictionPolicy` (`configurable_verify_by_jurisdiction`), a regulatory basis as text, and a
  verification state; no regulatory requirement is invented and no retention period is hard-coded
  (`retention: UNCONFIGURED` until a person assigns a policy). Packs are data, not code (§10 of the design).
* **AI Secretary.** May prepare (`semantic.prepare`), propose (`documents.extract`), draft; may never
  confirm, issue, void, sign, or set a fact. Every AI act is on the timeline with `actorSource = ai`.
* **HOS.** Hours-of-service records stay in the HOS domain: no definition of Document Control's is an
  hours-of-service record and none is owned by the HOS domain (test). Document Control may hold a scanned
  paper log as evidence linked to the HOS record; it never computes hours.
* **Driver Wallet.** A driver's own credentials and documents are the wallet's; Document Control links to
  them by kind (`qualification`, `user`), does not copy them, and shows them under the wallet's read rules.
* **Fleet.** Unit and operator facts are read from `units`/`operators` through `coreRecordOwnership`
  scope; never written here.
* **SDS / reference documents.** Reference material is `archival_only`, never numbered, never issued.

## 11. Security and tenancy

Every procedure is a `roleProcedure` under the existing permission framework (eight `document.*`
permissions, granted per role in `recordsAuthorization.ts`; no second framework). The acting business
comes from `resolveActingScope`, never from a request body; every read and write is book-scoped
(`bookScopeKey`), cross-tenant references fail closed as "not found", and a link, an extraction, a
derivative, a verification or a template of another business is refused before anything is stored.
Idempotency: capture references, number-allocation keys, catalog seeding, template seeding, derivative
attachment. Uploaded bytes are untrusted: type checked against their signature, size capped, hashed on
the server.

## 12. Sequence recovery and reconciliation

`series.gapReport` per series and period; `series.voidNumber` with a mandatory reason; device blocks
allocated, consumed and retired with every unused number explained; `numberAllocations` is the source of
truth and `trackingReferences` the legacy mirror for the default scope. Reconciliation of a facility's
statement against disposal tickets is the office's existing engine; verification is a person's act with
its name recorded.

## 13. What is not built, and is not called built

No OCR engine; no native (Capacitor) scanner or printer integration and no browser shim presented as one;
no PDF-overlay or HTML renderer (PDF/DOCX templates print as supplied); no facility-alias resolver
(D-DC-07); no automatic verification from statement matching; no jurisdiction pack content; no AI
Secretary model call. Each is a named gap with its seam in place.
