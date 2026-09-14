# LeaseOS Chat1–Chat5 reconciliation summary

## Raw input scope

Five raw outer archives were audited recursively:

- Chat1: v20 material
- Chat2: v22.16 routing-graph material
- Chat3: CAL05a / v22.19-era complete source material
- Chat4: B28H widget-engine / branch-arrival material
- Chat5: Driver Academy, crew readiness, field assessment, sheet serial, and Academy readiness candidate material

## Duplicate result

- Outer files: **237**
- Recursive non-archive entries after opening nested ZIPs: **3,403**
- Unique byte contents: **980**
- Exact duplicate entries beyond the first copy: **2,423**
- Exact duplicate groups: **792**
- Scan errors: **0**

The duplicate policy is content-addressed: identical bytes are represented once in canonical source/history and every original occurrence remains traceable in `RECURSIVE_MANIFEST.csv` and `EXACT_DUPLICATE_REPORT.md`.

## Exact full-source checkpoints

Three complete application snapshots form a trustworthy sequence:

- v20: **229 files**
- v22.16: **558 files**
- CAL05a: **730 files**

Tree deltas:

- v20 → v22.16: **338 added, 20 modified, 9 deleted, 200 unchanged**
- v22.16 → CAL05a: **172 added, 33 modified, 0 deleted, 525 unchanged**

The B28H package is a staged widget-engine candidate, not a complete later application snapshot. Chat5 is another partial candidate line, not a complete source tree. Neither is silently promoted into production `main`.

## Branch policy

- `main` — canonical application source plus reconciliation/audit metadata.
- `source/*` / `baseline/*` — exact source anchors.
- `upgrade/*` — merge/traceability branches for named upgrades. Where exact intermediate source deltas are unavailable, the branch is evidence/traceability rather than fabricated history.
- `candidate/*` — staged feature packages not yet production-integrated.
- `fix/*` — isolated corrections found by review.
- `integration/*` — recommended merge stacks / port plans.
- `archive/*` — provenance and deduplicated historical material.
- `restricted/*` — material that should only be pushed to a private repository.

Redundant legacy namespaces (`incoming-b28/*`, `reconciled/*`, `legacy/*`) from prior reconciliation bundles are intentionally omitted from the cleaned deliverable because they duplicated canonical refs.
