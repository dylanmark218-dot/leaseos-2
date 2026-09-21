# LeaseOS — v20.12.2 Checkpoint: Verified Source Registry

| | Previous | New |
|---|---|---|
| Version | v20.12.1 | **v20.12.2** |
| Tables | 131 | **131** (no schema change) |
| Migrations | 23 | **23** |
| Procedures (role-authorized) | 142 | **142** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 104 | **104** |
| Sensitive permissions | 31 | **31** |
| Tests | 828 | **864** |
| Test files | 35 | **36** |
| Parity | 131/131 | **131/131** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 361.5 kb |

No map data imported. No downloader written. This tranche turned the
verification into records the runtime consumes.

---

## The correction, first

The research summary said **"nine of eleven are clean"** while separately
flagging three as unresolved. Eleven minus three is eight.

Seeding nine would have marked one blocked source usable — and the seed is what
the licence gate reads, so the arithmetic would have become a permission.
`externalSourceSeeds.test.ts` now holds **8 verified / 3 unverified / 11 total**
and names the three by key, so the count cannot drift back.

---

## What is now machine-enforced

**Eight verified sources seeded** with authority, licence name and URL,
attribution text, commercial-use and redistribution terms, rate limits, refresh
interval, retrieval date and verification date: `osm`, `nrn`, `canvec`, `ats`,
`ats_road_allowance`, `drivebc_open511`, `msc_geomet`, `cwfis`.

**Three left inert.** `aer_st37`, `aer_st102` and `ab511` keep
`commercialUsePermitted: "unknown"` and `redistributionPermitted: "unknown"` —
which is the honest state. Nobody said no; nobody confirmed yes. Under
`evaluateSourceUsage` that is inspection only.

**A second barrier on the blocked three.** All three carry
`attributionText: null` deliberately. A source cannot reach operational use by
someone editing `status` and the permission flags — the attribution check still
refuses, because somebody has to have actually recorded what the publisher
requires shown. Two tests pin the layering: forging `status` alone is caught by
the commercial-use check; forging status *and* permissions is caught by
attribution.

**Caveats travel with the data, not in prose.** `SOURCE_CAVEATS` and
`ADVISORY_ONLY_SOURCES` are consumed by tests and stored in the row's `notes`.

---

## The specific regressions requested, all passing

| Requirement | How it is held |
|---|---|
| OSM offline packaging surfaces the derivative-database obligation | `offline_package` returns `derivedDatabaseObligation: true` with the caveat text; OSM is asserted the *only* share-alike source |
| ST37/ST102/511 cannot become offline-bundle sources while redistribution is unknown | refused across `operational_decision`, `redistribute`, `offline_package`; inspection stays open |
| 511 throttled centrally at 10/60s | rate limit seeded and `planFeedFetch` refuses the eleventh call, serves cache, returns a wait |
| CWFIS advisory but cannot satisfy a safety constraint | `isAdvisoryOnly("cwfis")` true while the licence gate *permits* it — advisory is about fitness, not permission |
| Missing required attribution blocks operation | `collectAttributions` names exactly the three; usage gate refuses them |
| Version and retrieval dates survive into the registry | DB test asserts `retrievedAt`, `verifiedAt`, `rateLimitCalls`, `requiresApiKey` persisted |

---

## Two judgement calls

**The seeder does not downgrade.** Re-running it never reverts a row somebody
has since verified. If the AER legal work completes and the row is marked
verified with real attribution text, a later seed run leaves it alone. Pinned by
a test that verifies AER, re-seeds, and asserts it stayed verified. A seeder
that silently undoes legal work is worse than no seeder.

**Software is a separate registry, not rows in `externalDataSources`.** A
software licence and a data licence create different obligations, and
`evaluateSourceUsage` asks data questions — may this be redistributed, is it
fresh enough to satisfy a constraint. Those are meaningless about GDAL. Mixing
them would let the gate return confident nonsense. `SOFTWARE_COMPONENTS` holds
the eight, with **MapLibre GL JS (BSD-3-Clause) and MapLibre Native
(BSD-2-Clause) kept distinct** — a test asserts their licences differ, so they
cannot be collapsed later. PostGIS keeps its "do not fork it into the product"
caveat; GDAL keeps its build-dependency caveat.

---

## Bugs found

**A test-isolation defect in my own suite.** The no-downgrade test mutates a
seeded row, and the database persists between runs — so the *second* run of the
file read the first run's mutation and failed for the wrong reason. Fixed with a
reset in `beforeAll`, and verified by running the file twice in a row against
the same database.

**A mis-aimed assertion.** I asserted the forged-status case would be caught by
the attribution check; it is actually caught earlier by commercial-use. Both
correct, my assertion named the wrong barrier. Split into two tests that pin the
layering explicitly, which is a stronger property than the original.

---

## Also in this tranche

`LEASEOS_B20_9_UNIVERSAL_PERMISSIONS.md` — the v20.12.1 checkpoint that shipped
without its own document. Recorded retrospectively and marked as such.

`DATA_SOURCES.md` rewritten from a verification queue into a statement of what
was verified, with the corrected count. The old drift guard asserted every row
was unverified; it now asserts the document and the seed agree.

---

## Genuine blockers

**BLOCKED — AER ST37, AER ST102, Alberta 511.**
*Why:* not published under an open licence; commercial fleet use and offline
redistribution unconfirmed.
*Required input:* written confirmation from AER (Terms of Use) and Alberta 511
(developer terms) covering both uses.
*Safe work continuing:* everything else. The gates make these inert rather than
dangerous, and the seeder will not overwrite the row when confirmation arrives.

**BLOCKED — P0 branch reconciliation.** Spatial Navigation, LoadSense and
Integrated Operations source still never supplied. Slots 0016/0017 reserved.

**BLOCKED — P9 tax/HOS/retention rules.** Loading path exists
(controller-only); no rule loaded, so determinations correctly return UNKNOWN.

---

## Exact next tranche

**v20.13 — P3 Completion (not a new AI Secretary).**

The trunk already has `aiProposal.ts`, persisted `formDefinitions`,
`assistantProposals` and `proposalFields`, and the four-way assistant
authorization split with `assistant.commit` sensitive. Extraction, gap detection
and read-back are not to be rebuilt.

Remaining sequence: document-image extraction and OCR → persistent question
queue → merchant memory → duplicate and document fingerprint matching →
home-base distance → auto-filer → **commit adapters**.

The adapters come first among the writes, because the gap identified is real:
`assistant.commit` currently produces the committed field set rather than
performing a typed write into the target domain record. `assistantCommitAdapters.ts`
with an explicit allowlist — `unload_stop` → trip stop, `load_stop` → load,
`defect_report` → maintenance defect, `expense_receipt` → expense draft,
`disposal_ticket` → disposal proposal — each independently authorized,
transactional, idempotent, provenance-preserving, and forbidden from turning an
OCR value into a billable or regulatory-certified fact.
