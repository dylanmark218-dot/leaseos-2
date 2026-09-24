# RI-P2 — one OSM extract loader

**Base:** `origin/main` `6f52b57` (v23.25; 169 migrations; 410 tables). **Branch:**
`claude/ri-p2-osmload-fold`. **Migrations:** none. **Tables:** none. **Scope:** lineage-port manifest
item A2 only — fold `osmLoadPlan` into `osmLoad` and delete it, after proving the one loader enforces
every rule the deleted one did. Independent of RI-0.6 and RI-P0 (neither merged); touches no file they
touch.

## Why the v23.29 fold could not be ported as-is

The v23.29 line (`ea19db9` deleted `osmLoadPlan`, `f0fa33f` folded its header check into `osmLoad`)
kept the header, the format version and the extract-hash check, but dropped three rules
`osmLoadPlan` enforced:

1. **A header missing a required field was accepted.** `osmLoadPlan` refused a header without
   `sourceKey`, `extractFile`, `extractSha256` or `extractPublishedAt` and named the field. The fold
   only compared the hash *when present*, so a header with no hash skipped the check, and the
   extractor it shipped wrote `extractPublishedAt: ""` whenever the date argument was omitted.
2. **A header naming another source was loaded under the caller's.** `osmLoadPlan` took the source
   from the header; `osmLoad` takes it from the caller and never compared the two, so a British
   Columbia extract loaded as `geofabrik_osm_ab` would get Alberta's id prefix and jurisdiction on
   every edge. The fold's extractor also defaulted the source to `geofabrik_osm_ab`.
3. **A valid header with no records was a successful build of nothing.** `osmLoadPlan`'s
   `planIsLoadable` refused it; the fold had no equivalent.

Deleting `osmLoadPlan` under the hard rule ("do not delete apparently duplicated code until semantic
equivalence is proven") required restoring all three first.

A further fact decided the risk: on `main`, `osmLoadPlan` could not read any real extract — it
expected a `nodeIds` field and a header line, and `tools/osm-extract.py` wrote `nodes` and no header.
The working pair was the extractor and `osmLoad`. No production or script code imported
`osmLoadPlan`; only its own test and the engine census named it.

## Equivalence — every `osmLoadPlan` test and where it now lives

| `osmLoadPlan.test.ts` case | Successor in `osmLoad.test.ts` | Note |
|---|---|---|
| reads a well-formed header and its ways | "reads a well-formed header and its ways, and keeps the header on the plan" | plan now carries `header` |
| takes the source's standing from the registry, not from the file | "takes the source's standing from the registry, not from the file" | a header claiming its own prefix/confidence is ignored |
| refuses a version it does not read | "refuses a version it does not read, and the plan is not loadable" + v23.29 "refuses a format version it does not know" | |
| stops at a bad header instead of thousands of rejections | "stops at a bad header with exactly one refusal, however many lines follow" + v23.29 "stops on a first line that is not a header" | reason `bad_header` (was `wrong_format`) |
| names the header field that is missing | **RESTORED** "names the header field that is missing, for every required field" | all four fields, detail `header has no <field>` |
| reports an unparseable line by number and keeps reading | "reports an unparseable line by number and keeps reading" | reason `malformed_json` (was `unparseable`) |
| refuses a way whose node ids and coordinates disagree | "refuses a way whose node ids and coordinates disagree, inside a real plan" | reason `arrays_disagree` (was `geometry_mismatch`) |
| refuses a way record missing a required field | "refuses a way record missing a required field, inside a real plan" | |
| refuses an unregistered source even though it has an id prefix | "refuses an unregistered source even though the registry would hand it an id prefix" | stronger: `planLoad` throws, no plan exists |
| refuses a header with no ways behind it | **RESTORED** "refuses a valid header with no way records behind it" | `planIsLoadable` carried over |
| refuses an empty file without crashing on it | "refuses an empty file without crashing on it" + v23.29 "refuses an empty extract" | |
| — (new) | **RESTORED** "refuses a header that names a different source than the one being loaded" | `source_mismatch` |
| — (new) | "is loadable when every line was refused for a healthy reason" | per-line refusals are counted, not fatal |
| — (new) | "osmLoadPlan is gone, and nothing … still imports it"; "the extractor writes the header … with no silent source or date" | guard verified to fail on a planted import |

The three refusal-reason renames (`wrong_format`→`bad_header`, `unparseable`→`malformed_json`,
`geometry_mismatch`→`arrays_disagree`) are `osmLoad`'s existing vocabulary; nothing outside the two
test files read the old names.

## Changes

| File | Change |
|---|---|
| `server/_core/osmLoad.ts` | v23.29 header reading, plus: required-field check, source agreement (`source_mismatch`), unconditional hash comparison, `header` on `LoadPlan`, `planIsLoadable` |
| `server/_core/osmLoad.test.ts` | v23.29 suite + every `osmLoadPlan` case translated (31 cases) |
| `server/_core/osmLoadPlan.ts`, `osmLoadPlan.test.ts` | deleted |
| `tools/osm-extract.py` | writes the header; **requires** `SOURCE_KEY` and `PUBLISHED_AT` arguments (no Alberta default, no blank date); usage now says to hash the `.pbf`, which is what the header records |
| `server/engineReachability.test.ts` | `osmLoadPlan` removed from `DECLARED_UNWIRED`; pin 57 → 56 |
| `docs/LEASEOS_MAPPING_ROUTING_GPS_SPEC.md` | the M2 loader section names `osmLoad.ts` |
| `LEASEOS_CURRENT_STATE.md` | regenerated (test counts) |

Not changed: `docs/register/SPINE_WIRING_PLAN.md` still lists `osmLoadPlan` among the off-spine
engines. It is hash-pinned by `server/spineWiringPlan.test.ts` as a dated record and its guard checks
only the on-spine table, so it is left as written.

## Gate

Full `scripts/ci-gate.sh` against MariaDB 10.11 on the final tree: 333 files, **4,779 passed, 1
failed, 3 skipped**; test-file type errors 0; migrations 169; tables 410. The one failure is the
pre-existing calendar tripwire `server/calendarFixtures.test.ts`, which fails identically on the
untouched `6f52b57` (recorded in RI-P0): `server/capitalAssets.test.ts` holds unreviewed fixture
dates 2026-10-15, 2026-10-20 and 2026-10-31. Not this checkpoint's; it needs an owner review of that
fixture. Focused: `osmLoad.test.ts` 31/31; the OSM import, topology, source-neutrality, engine census,
SPINE-plan guard, documentation and register suites all pass.

## Follow-ups

The extractor's first real run with the new header should be recorded (Alberta and one other
province) the way v23.24 recorded the Edmonton slice. RI-3 (province graph) now builds on one loader.
