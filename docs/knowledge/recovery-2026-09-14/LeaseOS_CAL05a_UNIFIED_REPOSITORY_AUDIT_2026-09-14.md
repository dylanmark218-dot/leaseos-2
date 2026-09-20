# LeaseOS unified repository audit — CAL05a reconciliation — 2026-09-14

## Scope

This audit adds the reconciled LeaseOS package to the previously unified 107-branch repository without discarding the earlier Git history. The incoming repository was inspected as a real `.git` repository, not reconstructed from its CSV manifests.

The supplied reconciliation package contained three exact source anchors:

- v20 — 229 files
- v22.16 — 558 files
- CAL05a — 730 files

Its own ingestion audit recorded 181 top-level input entries, 99 unique SHA-256 payloads, 82 exact duplicate copies collapsed across 56 duplicate groups, and zero normalized-name conflicts. Its branch manifest contains 77 upgrade refs; every one is explicitly a cumulative-snapshot pointer, not a reconstructed one-feature historical patch.

## Merge result

The new unified repository keeps the earlier LeaseOS repository as one parent and the reconciled repository as the other parent.

- Previous unified v22.16 main: `888482953dd8aaaa0e9e745dbba3cb7f047e813b`
- Incoming reconciled main: `80b995fabfe149e6f17178a63bfce71eb0d1f715`
- Exact incoming CAL05a snapshot: `bcfe993d54c08e7c45da254312d5e0643e2e08c6`
- New canonical merged `main`: `50a17103ea439fbb12a4f2bb9cbdef0f9b5f2118`
- Combined proposed fix stack: `integration/cal05a-recommended-fixes` at `f3186a54bdc6a9bd7e7b66e0cdb54d20ba225618`

The `main` merge commit has both old and new repository histories as parents and its tree is byte-identical to the incoming reconciled `main` at the integration point. The exact CAL05a source remains separately anchored at `source/cal05a-original` and tag `source-cal05a`.

Every incoming branch is additionally preserved under `reconciled/*`, so branch-name collisions do not overwrite the earlier traceability branches. Canonical aliases were added for B22.17 Communications, B22.18 Communications/Dispatch, and B22.19 Offline Package. The final audit graph contains 203 local branches and 11 tags including the audit tag.

## Snapshot progression

The incoming reconciler measured v22.16 → CAL05a as:

- 172 added paths
- 33 modified paths
- 0 removed paths
- 525 unchanged paths

The major new implementation families include communications routing/policy/offline package support, versioned HOS rules and clocks, route geography provenance, source licence review, feed collection/advisories, enforcement/OOS persistence, organization/membership groundwork, device safety latches, roadside panel grants, durable outbox leases, leave/open shifts/qualifications/crews, message board/revisions/attachments, agent runs, knowledge passages/retrieval probes and measurement identity.

The old exact v22.16 source and the reconciled v22.16 source have no substantive application-code divergence: their visible differences are generated/backup artifacts plus executable-bit differences on helper scripts.

## Current CAL05a source measurements

Static/generated source measurements on the clean CAL05a line are:

- 309 `mysqlTable(...)` declarations
- 309 `CREATE TABLE` statements across migration SQL
- 102 SQL migration files
- 483 role-authorized procedure call sites
- 36 external portal procedures
- 2 machine/integration procedures
- 0 bare `protectedProcedure`
- 328 permissions
- 112 sensitive/fail-closed permissions on supplied CAL05a
- 8 universal self-scoped permissions
- 161 server test files
- 2,653 source `it(...)` cases
- 4 native runtime bindings still throwing `NotOnDeviceError`

On `integration/cal05a-recommended-fixes`, the sensitive set becomes 119 and the added regression case raises the source test count to 2,654.

## Static integrity checks independently performed

The reconciled main/source tree was checked for repository-level defects:

- Git object integrity: clean (`git fsck --full --no-reflogs`)
- non-empty exact duplicate files in the reconciled repository tree: 0
- non-empty exact duplicate implementation files: 0
- case-folding path collisions: 0
- unresolved Git conflict markers in implementation source: 0
- obvious embedded private keys / GitHub tokens / AWS access keys / OpenAI key literals: 0
- schema table declarations versus `CREATE TABLE` statements: 309 / 309

The large tracked historical artifacts are deliberate: cumulative diffs and exact source ZIPs are preserved under `archive/` for recordkeeping.

## Material findings

### 1. HIGH — fail-closed permission drift survived into CAL05a

The CAL05a sensitive set has 112 unique entries, but seven already-documented truth-changing permissions are still absent even though the permissions and production actions exist:

`invoicing.void`, `invoicing.dispute.resolve`, `geo.import`, `geo.locationVerifyFromGrid`, `geo.access.decide`, `spatial.structure.verify`, `spatial.route.approve`.

Prepared branch: `fix/cal05a-fail-closed-permission-drift`. The combined candidate raises the set to 119 and adds a regression test.

### 2. MEDIUM — CI still selects the wrong pnpm version

`package.json` pins pnpm 10.4.1, while `.github/workflows/ci.yml` explicitly requests pnpm 9.

Prepared branch: `fix/cal05a-ci-pnpm-alignment`.

### 3. MEDIUM — release autodetection and checkpoint history disagree

The committed current-state file says `v22.20`, and multiple current source files label work as v22.20, but the supplied checkpoint series ends at B22.19 plus an `UNRELEASED 0079` candidate. With no explicit argument, `scripts/current-state.sh` emits `LEASEOS.B22.19.OFFLINE.PACKAGE.md` as the release string.

Prepared branch: `fix/cal05a-release-source-of-truth`, which adds an explicit `LEASEOS_RELEASE` marker carrying the already-claimed `v22.20`. It does **not** fabricate a missing B22.20 historical checkpoint.

### 4. HIGH — workflow worker still is not started in production lifecycle

CAL05a substantially improves the worker: leases, durable backoff, dead letters and single-owner claim routing are present. The repository's own current-state description still states that nothing in the production server lifecycle starts the worker. `workflowInstances`, `workflowTransitions` and `billingAuthorityBands` are also schema-reserved without reachable production behavior.

### 5. HIGH — native field runtime remains the largest deployment gap

Server-side/offline contracts are much stronger, but Capacitor shell, encrypted SQLite, hardware keystore, encrypted native file vault, camera, GPS, biometric signing and local notifications remain unimplemented. B22.19's communications package is served and acknowledged but is not persisted into an encrypted native vault for true no-network use.

### 6. HIGH — HOS architecture exists; verified HOS authority does not

CAL05a adds versioned profiles/figures, jurisdiction selection, separate clocks and fail-closed decisions. The seeded HOS figures remain unverified, BC oil-well service and territorial schedules are deliberately empty, and no short-haul/home-terminal radius/RODS decision layer was found. Compliance conclusions correctly remain UNKNOWN.

### 7. HIGH — tenant isolation improved but is not system-wide

Organizations and memberships now exist. Request organization resolution, enforcement, release policy and inbox isolation have real cross-tenant behavior/tests. The current-state file explicitly says organization-wide isolation is not yet a system property and that remaining tenant-scoped tables are unscoped where production does not yet read them.

### 8. HIGH — routing/jurisdiction/communications data remains source-limited

The imported Alberta graph can route where data has been built. P0/P5 province-wide routing is still absent. A coordinate-level province/territory boundary layer is not loaded, so source-wide province metadata is intentionally only `probable`. ISED spectrum, BC resource-road radio maps and CRTC coverage still lack importers/licence clearance.

### 9. MEDIUM — production migration runner still has no applied ledger

`scripts/apply-migrations.sh` runs all SQL files in order every time. Keep it for disposable CI schema proof; use a tracked/ledgered migration mechanism for repeat production deployment.

### 10. MEDIUM — communications package lifecycle stops at detection

The server can seal/hash/version packages and detect staleness, but nothing automatically rebuilds a stale package or notifies a driver already in the field. A dedicated offline driver communications screen/call-reminder workflow is also still missing.

## What CAL05a closes or materially improves from the previous audit

The new source is not merely a branch reorganization. It materially advances:

- HOS from persistence-only toward a versioned fail-closed rule engine
- multi-company work from generic authorization toward organizations/memberships and tested isolated surfaces
- enforcement/OOS from partial logic toward persistent policy/release paths
- communications from research/seed concepts to route-aware policy, dispatch reach and sealed offline packages
- workforce toward time off, open shifts, qualifications and crews
- company messaging toward a persisted message board with revisions and authorized attachments
- AI Secretary/agent architecture toward action gateway, agent runs, admitted context, knowledge passages and retrieval-quality probes
- feed/source governance toward source review, collectors, provenance and road advisories

Those gains are reflected in the updated gap matrix rather than leaving the older gaps marked wholly missing.

## Full gate limitation for this audit

The incoming source package labels CAL05a as gate-verified and its own checkpoint material records prior successful gates. This audit does **not** re-claim those results as independently rerun. The supplied tree has no `node_modules`; pnpm is not locally installed and external package installation is unavailable in this environment. Therefore the complete dependency/typecheck/Vitest/MySQL/build/device/browser gate was not independently rerun here.

The independently performed checks are the Git/static/schema/branch/duplicate/secret/reconciliation checks listed above. The next release gate should run from an empty disposable database against `integration/cal05a-recommended-fixes`.

## Recommended merge order

1. Review/merge `fix/cal05a-ci-pnpm-alignment`.
2. Review/merge `fix/cal05a-fail-closed-permission-drift`.
3. Review/merge `fix/cal05a-release-source-of-truth`.
4. Run the complete empty-database CI gate on `integration/cal05a-recommended-fixes`.
5. Wire the production workflow worker.
6. Complete tenant isolation across all production-readable records.
7. Build the native encrypted field runtime and persist communications packages offline.
8. Verify HOS rules and source/licensing inputs before enabling authoritative compliance decisions.
9. Expand routing/jurisdiction/communications data coverage only from permitted sources.
10. Work the remaining medium/low product gaps from `UNIFIED_GAP_MATRIX_CAL05a_2026-09-14.csv`.
