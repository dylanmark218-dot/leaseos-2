# Document Control — two implementations, one decision

The merged design (`DOCUMENT_CONTROL_NUMBERING_DESIGN_2026-09-23.md`, PR #18) and its ruling
(`D00_MORATORIUM_DECISION_BRIEF.md`) say Checkpoint 1 starts next as its own PR. Before writing it,
the pre-work scan found that **Document Control has already been built**, on another branch, by
another session, from the template package this session never received. Building Checkpoint 1 here
would make a third copy of the same engine. This brief puts the choice to the owner.

Measured 2026-09-24 against `main` = `1680e94`. The other branch was checked out in a worktree and its full gate run for this brief; nothing on it was changed.

---

## What exists

| | Merged design (this folder, on `main`) | Branch `claude/document-control-architecture-jlffzk` |
|---|---|---|
| Status | design only, approved (PR #18), D-00 to D-03 ruled | design + checkpoints A–H implemented; **no PR**; base `0cd4817`, 36 commits behind `main` |
| Input | the owner's written instructions | the same instructions **plus** `LeaseOS_Document_Control_Templates_and_Claude_Build_Instructions_2026-09-23.zip` (66 canonical PDF/DOCX forms, 46 definition families, SHA-256 sums, provenance caveats under `data/document-control/`, 3.7 MB) |
| Size | 1,182-line design | own 1,064-line design, 16,856 added lines across 189 files, 6 migrations, 10 new tables, 35 procedures, 8 permissions, 80 tests |
| Gate (run independently for this brief, MariaDB 10.11.14, fresh database, on the branch's own base) | n/a | gates 0–5 pass: migrations apply, parity 420/420, `tsc` clean, test-file type errors 0, zero bare procedures. Gate 6: **4,799 passed, 3 skipped, 1 failed**; all 80 Document Control tests pass. The one failure is `server/calendarFixtures.test.ts`, a date-triggered guard already fixed on `main` by `59ae3f3`; it disappears at rebase. Gates 7–8 (build, current-state) were not reached because the gate stops at the first failure |

## Where they agree

Almost everywhere that matters. Both:

* make **`documentDefinitions`** a versioned, tenant-overridable registry of *behaviour*, separate from templates and records, with every enforced policy a column and company definitions added without a migration;
* make **origin and issuer** mandatory, with LeaseOS never shown as the issuer of an external document;
* keep **`trackingSequences`** as the one counter, add a tenant scope to it, and add a **per-number ledger** written in the same transaction as the record, with device blocks cut from the locked counter and a gap report;
* model **external references** in their own table with issuer-scoped uniqueness;
* keep templates optional, scans template-independent, OCR a proposal, HOS and SDS as boundaries, retention unconfigured until a person assigns it;
* reuse the vault, the proposal store, the typed commit, `renderPdf`, `roleProcedure` and NOT_FOUND scoping, and add an append-only, trigger-guarded event table.

The other branch adds one thing the merged design lacks and should keep: a per-definition
**representation notice** ("Internal record. Not the official EPA Uniform Hazardous Waste Manifest."),
printed on every rendering. It is the right guard for a catalog that includes US regulatory look-alikes.

## Where they differ

| # | Question | Merged design | Other branch | Weight |
|---|---|---|---|---|
| 1 | **Record identity across corrections** | new `documentRecords` table; one id for the life of the document; revisions in `documentRevisions` (I-1) | extends the 0144 `commercialDocuments` register (+20 columns); a correction is a **new row**; the control number **moves** from the superseded row to the new one in the same transaction; the chain is `supersedes`/`supersededBy`; the superseded row's `controlNumber` becomes NULL, and the ledger row (`numberAllocations.recordId`) keeps pointing at the first row | the one real architectural difference. Theirs works and reuses more; the cost is that "the document" is a chain of rows, not a row, and every lookup from a number, a printed QR or the ledger must follow the chain to the current row. Worth one fix at adoption: resolve number → current row through the chain in one tested function, so no caller follows it by hand |
| 2 | Scope built | D-00 carve-out: Checkpoints 1, 2, 6 now; templates, rendering, OCR, print, native, administration **deferred until the spine is wired** | A (definitions), B (register), C (numbering + device blocks), D (templates), E (semantic mapping + render), F (capture/extract/confirm), G (disposal slice), H (search + screens) — **D, E, F, H are past the carve-out** | ruling conflict |
| 3 | Migration numbers | none reserved | `0178`–`0183`; **`0179` now collides with `main`'s `0179_trip_stop_provenance`**; `0182` and `0183` are also claimed by four and three other open branches | mechanical; renumber `0179`–`0183` past every claim at rebase (the highest claim today is `0186`) |
| 4 | D-02 archival `DOC-` number | shown, optional per class (ruled) | office screens only, never printed, never in portals (D-DC-02) | compatible; theirs is a narrower display rule inside the ruling |
| 5 | D-03 numbering scope | company-wide (ruled) | per-tenant series for new tenants, historical single tenant keeps the global counters (D-DC-03) | compatible |
| 6 | Live-path change | none before Checkpoint 6 | `closeoutRouter` refuses a disposal line naming an **unverified** disposal ticket | inside the carve-out's disposal slice, but it changes what a dispatcher sees; it needs to be known, not discovered |
| 7 | Two design documents in one folder | `DOCUMENT_CONTROL_NUMBERING_DESIGN_2026-09-23.md` | `document-control-design.md` + `DOCUMENT_CONTROL_ARCHITECTURE.md` + records | one must be marked superseded by the other |
| 8 | Numbering policy values | six, incl. `no_human_sequence` | five (`leaseos_series`, `_optional`, `domain_managed`, `external_only`, `archival_only`) | equivalent; SDS maps to `external_only` there |

## The options

**A. Adopt the other branch as the implementation (recommended).**
Rebase it onto `main`, renumber `0179`–`0183` past every claim, regenerate `LEASEOS_CURRENT_STATE.md`,
and ship it in PRs that follow the carve-out: **A+B+C** (definitions, register, numbering) first,
**G** (disposal slice) second, and **D, E, F, H** held on the branch, built and declared unwired, until
the spine is wired or the owner widens the ruling. Accept difference 1 by amending I-1 in the merged
design to "one control number and one supersede chain for the life of the document". Mark whichever
design document is not canonical as superseded.
*Cost:* the owner accepts the register-extension model; four checkpoints of finished work wait.
*Buys:* nothing is written twice; the supplied catalog and its provenance land as delivered.

**B. Adopt it and widen the ruling.** As A, but rule that D, E, F and H may merge too, because they
are built, gated and reach nothing the spine depends on.
*Cost:* the moratorium's bound moves from "record layer" to "document subsystem". That is the
owner's call and would be the second carve-out of the moratorium in two days.

**C. Build Checkpoint 1 here to the merged design, and close the other branch.**
*Cost:* rewrites roughly A+B+C of finished, gated work to change one identity decision; the catalog
import would still have to be taken from that branch.
*Buys:* the stricter record-identity invariant.

## Recommendation

**A.** The two designs converge on every invariant except how a corrected document keeps its
identity, and the other branch's answer to that is sound. Rewriting finished work to change it would
cost more than it protects.
