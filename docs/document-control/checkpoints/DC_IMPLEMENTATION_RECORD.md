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
