# LeaseOS repository audit — 2026-09-14

## Scope

- Source archive SHA-256: `2313f57bcf0a7576418ff46ccdd7be055719b3f1e621e474c4efa7ec84a29004`
- Outer archive: **100 files / 70 unique hashes**.
- **95 of 100 outer files are exact byte-for-byte copies of files already present inside the supplied v22.16 project snapshot.**
- Canonical supplied v22.16 snapshot: **558 files**, of which **436** are TypeScript/TSX/JS/SQL/shell source or migration files.
- Checkpoint/upgrade documents converted into Git traceability branches: **74**.

## Duplicate disposition

The cleaned `main` branch keeps one canonical copy of source and checkpoint files. The two identical project ZIPs, duplicate cumulative diffs, and numbered Markdown copies from the outer archive are not committed again. Their hashes and mappings are retained in `audit/duplicate-groups.csv`. The unique research report and one canonical cumulative diff are preserved under `archive/`.

Inside the final project tree there were no duplicated implementation files by content. The only repeated bytes were three intentionally empty `.gitkeep` placeholders. `vite.config.ts.bak` is an ignored backup artifact; it remains recoverable on `source/v22.16-original` but is removed from `main`.

## Static code/repository checks performed

- No unresolved Git conflict markers were found.
- No obvious private keys, GitHub tokens, AWS access keys, or simple hard-coded secret assignments were found by pattern scan.
- Migration slots `0016` and `0017` are intentionally absent and documented as reserved; the final tree contains **72 SQL migrations** ending at `0073_road_graph.sql`.
- The supplied generated state reports **264 tables, 395 role-authorized procedures, 89 test files and 1,527 test cases**.
- A full dependency/typecheck/test/database gate could not be rerun in this container because the supplied archive does not include dependencies and `pnpm`/MariaDB are not available here. The repository therefore records the supplied test claims but does not relabel them as independently re-executed.

## Material audit findings

### 1. Fail-closed permission drift

`LEASEOS_B22_11` through `LEASEOS_B22_16` document the sensitive-permission count increasing from **94 to 102**, but the final `SENSITIVE_PERMISSIONS` array contains **95** entries. `geo.graph.build` is present, while seven actions documented by the intervening checkpoints are absent from the fail-closed set:

`invoicing.void`, `invoicing.dispute.resolve`, `geo.import`, `geo.locationVerifyFromGrid`, `geo.access.decide`, `spatial.structure.verify`, `spatial.route.approve`.

Because `roleProcedure` uses `isSensitivePermission()` to decide whether an authorization action must refuse execution when its audit row cannot be written, this is a meaningful enforcement mismatch, not only a documentation count error. A merge-ready correction is provided on branch `fix/fail-closed-permission-drift`; `main` intentionally preserves the supplied runtime behavior.

### 2. Current-state release autodetection

Running `scripts/current-state.sh` with no argument generates `LEASEOS.B22.16.ROUTING.GRAPH.md` as the release string instead of `v22.16`. CI currently passes an explicit release back into the script, so this does not prove the CI gate fails, but the standalone generator's advertised default is incorrect. A merge-ready correction is on branch `fix/current-state-release-autodetect`.

## Line inventory

- `.js`: 822 lines
- `.jsx`: 0 lines
- `.md`: 14,219 lines
- `.sh`: 295 lines
- `.sql`: 6,132 lines
- `.ts`: 72,085 lines
- `.tsx`: 16,772 lines

## Historical reconstruction boundary

The archive provides two source states that can be reconstructed exactly: **v20.2** and **v22.16**. It also provides checkpoint reports for the upgrades between them, but not full intermediate snapshots. The repository therefore does **not** invent intermediate code. Each `upgrade/*` branch is a traceability/merge-planning branch containing a generated manifest tied to the real checkpoint document. Exact source history is represented by `baseline/v20.2`, `source/v22.16-original`, the cumulative diff, and the final `main` import.
