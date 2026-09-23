# LeaseOS migration histories — reconciliation (RI-0.5)

Read on 2026-09-23 from the trees of `leaseos-2` `origin/main` (`6b01a0e`), the v23.26–v23.29 line
(`claude/mobile-hardware-scanner-mzp1e1-v2327`, `e162752`), `leaseos` `main` (`9bb2651`) and every
unmerged `leaseos-2` branch that carries a migration. No file was renamed, renumbered, added or
applied.

---

## 1. Runner semantics (Step 5) — what a migration's identity actually is

| Question | Answer | Where |
|---|---|---|
| Recorded by filename, prefix, hash, or order? | **By full filename** (`schemaMigrations.fileName`, UNIQUE), with the **sha256 of the file's contents** stored beside it. The numeric prefix has no identity of its own; it only affects sort order | `server/_core/migrationLedger.ts:20-32,58-67` |
| Ordering | lexical sort of `^\d{4}_.*\.sql$` in `drizzle/` — the ledger runner (`readMigrationFiles`) and the CI shell runner (`ls drizzle/*.sql \| sort`) agree | `migrationLedger.ts:27`, `scripts/apply-migrations.sh` |
| Duplicate numeric prefixes | **Legal to both runners.** Two distinct filenames are two migrations; they apply in lexical order (`0157_seal_verification_unavailable.sql` before `0157_signature_device_attestation.sql`). No code anywhere reads the prefix as a key | CI gate log `audit/knowledge-export/gate-final.log:161-162`; `migrationLedger.db.test.ts` "advances a fresh database through every real migration" |
| Renaming an already-applied file | The ledger runner does **not** re-execute it: the old name becomes `missingFiles`, the new name becomes `pending`, state = **DRIFT**, and `migrateUp` **refuses to run anything** until the ledger row is corrected by hand. The CI shell runner has no ledger and always starts from an empty database, so a rename is invisible to CI — which is exactly why CI cannot prove a rename is safe | `migrationLedger.ts:71-74,79` |
| Editing an applied file | DRIFT (checksum mismatch); refused | `migrationLedger.ts:69` |
| History table | `schemaMigrations` — created by `ensureLedger()` at runtime; **not** in `drizzle/schema.ts` and **not** created by any `drizzle/*.sql` (so it is outside table parity, by design) | grep: 0 hits in schema/SQL |
| `drizzle/meta/_journal.json` | not read by either runner (17 stale entries, 0000–0015 and 0018); only `pnpm db:push` (drizzle-kit) would, and nothing calls it | `package.json:13` |
| CI detection/ordering | gate 0 refuses files at `0016`/`0017`; gate 2 applies all files in lexical order to a dropped-and-recreated database; gate 3 checks `COUNT(mysqlTable) == COUNT(^CREATE TABLE across *.sql)`; there is **no prefix-uniqueness check** and **no cross-branch check** | `scripts/ci-gate.sh:21-49`, `scripts/verify-parity.sh` |
| Baseline | `migrate.ts baseline --yes` records every file as applied without running, only on an empty ledger | `migrationLedger.ts:88-96` |

**Consequence.** A file may be renumbered safely **only** if no persistent database has a ledger row
with its old name. That is a fact about environments, not about the repository, and §3 shows it
cannot be proven from here.

---

## 2. The complete matrix

`✓` = present with that exact content (blob-identical across columns unless noted). Rows `0000`–`0167`
are 164 files, **byte-identical on all three lines** (checked blob by blob), so they are summarised.

| Slot | `leaseos-2` main | v2327 line (v23.29) | `leaseos` main | unmerged `leaseos-2` branches | SQL equivalent? | Conflict? |
|---|---|---|---|---|---|---|
| 0000–0015 | ✓ (16) | ✓ | ✓ | ✓ | identical | no |
| **0016, 0017** | absent (gate-reserved) | absent | absent | absent | — | no; historical reservation, never filled |
| 0018–0093 | ✓ (76) | ✓ | ✓ | ✓ | identical | no |
| **0094, 0095** | absent | absent | absent | absent | — | gap, unexplained in every tree (`audit/reconciled-2026-09-16/IMPORT_VERIFICATION_2026-09-20.md:184-192` flags it) |
| 0096, 0097 | ✓ | ✓ | ✓ | ✓ | identical | no |
| **0098** | absent | absent | absent | absent | — | gap, unexplained |
| 0099–0156 | ✓ (58) | ✓ | ✓ | ✓ | identical | no |
| **0157** `_seal_verification_unavailable` | ✓ `8bbaf49` | ✓ same | ✓ same | ✓ | `ALTER evidenceSeals` (adds `content_unavailable`) | **duplicate prefix, distinct files, distinct tables** — see §4 |
| **0157** `_signature_device_attestation` | ✓ `f1882d7` | ✓ same | ✓ same | ✓ | `ALTER fieldTicketSignatures` + index | |
| 0158–0167 | ✓ (10) | ✓ | ✓ | ✓ | identical | no |
| **0168** `_retire_storage_capability_urls` | ✓ (data-only `UPDATE … storageUrl = NULL`) | **absent** | ✓ | ✓ | — | |
| **0168** `_movement_permits` | absent | ✓ (`CREATE movementPermits`, `movementPermitDeterminations`) | absent | absent | unrelated to the other 0168 | **prefix collision across lines**; both could coexist under the runner, but the number is already spent on main |
| **0169** `_defect_resolution` | ✓ **(merged via PR #4, 2026-09-23)** `ALTER maintenanceDefects` + index | absent | absent | ✓ on 6 branches (`3e5edcb`, identical) | — | |
| **0169** `_print_audit` | absent | ✓ (`ALTER commercialDocumentDeliveries` + `CREATE fieldPrinters`, `fieldPrinterAssignments`) | absent | absent | unrelated | **collides with main's 0169** |
| **0169** `_trip_stop_provenance` | absent | absent | ✓ (`ALTER tripStops` +5 provenance columns) | absent | unrelated | **collides with main's 0169** (the owner's recorded RELEASE BLOCKER) |
| **0169** `_driver_portfolio` | absent | absent | absent | `claude/driver-portfolio-credential-wallet-ya8928` (`CREATE driverRequirementBindings`, `driverPortfolioEvents`) | unrelated | **collides with main's 0169** |
| **0170** `_dispatch_role_types` | absent | absent | absent | `feature/dispatch-role-assignment-backend`, `feature/dispatch-assignment-ui` (`bb7894f`) — `CREATE dispatchRoleTypes`, `ALTER dispatchRoles`, seed INSERT | unrelated | three-way collision |
| **0170** `_organization_scoped_role_grants` | absent | absent | absent | `claude/leaseos-auth-workspace-system-t008ad` — `ALTER userRoleAssignments` ×5, drop/recreate unique index, 4 data `UPDATE`s | unrelated; **data-rewriting** | three-way collision |
| **0170** `_driver_portfolio_events_append_only` | absent | absent | absent | driver-portfolio branch — 2 triggers | unrelated | three-way collision |
| **0171** `_dispatch_role_assignment_events` | absent | absent | absent | dispatch backend/ui (`09898f0`) — `CREATE dispatchRoleAssignmentEvents` | — | none yet |
| **0172** `_dispatch_override_provenance` | absent | absent | absent | `feat/compliance-c1a-readiness-contract` — `ALTER dispatchOverrides`, `ALTER dispatchEligibilityChecks` | unrelated | two-way collision |
| **0172** `_training_wallet_renewal_handoff` | absent | absent | absent | `claude/training-academy-workforce-q3mdse` — 7 ALTERs + 5 `CREATE TABLE` | unrelated | two-way collision |
| **0173** `_wallet_history_guards` | absent | absent | absent | training-academy branch — 3 triggers | — | none yet (but skips 0169–0171 it does not carry) |

**Semantic duplicates with different prefixes: none found.** Every distinct filename creates or
alters different objects. In particular the four 0169s, three 0170s and two 0172s are unrelated
migrations that merely share a number; none is a rewrite of another.

Table-parity note: every branch's `mysqlTable` count matches its `CREATE TABLE` count (gate 3) —
408/166 on main, 412/166 on the v2327 line, 410/168 on the dispatch branches, 413/167 on the
training branch — so each tree is internally consistent; the conflicts are only between trees.

---

## 3. Applied-vs-unknown (Step 6)

| Environment | Evidence | Status |
|---|---|---|
| CI disposable MariaDB (`scripts/ci-gate.sh`, every push/PR) | gate logs under `audit/*/gate-final.log` list every file applied from `0000_…` through the branch tip; `leaseos` `audit/v23.25-b23-engines/gate-final.log:172-174` shows `0167`, `0168_retire…`, `0169_trip_stop_provenance` applied, `== PASS ==`; `leaseos-2` CI (workflow `CI`, id 363091144) ran on PR #4/#5 with `0169_defect_resolution` | **definitely applied — to throwaway databases only**, dropped after each run |
| `migrationLedger.db.test.ts` | applies the real corpus through the ledger in a test database | same: throwaway |
| Any persistent database (production, staging, demo, a developer's) | **no artifact in either repository**: no Dockerfile, compose file, `.env*`, platform manifest, deploy workflow (only `CI` and the Copilot agent workflow exist), Terraform, runbook, or ledger dump. `audit/hardening-2026-09-21/REMEDIATION.md:188-197` records the same finding independently. `DATABASE_URL` is "supplied by the host" | **UNKNOWN** |
| `0168_movement_permits`, `0169_print_audit` (v2327 line) | present only on that branch; no persistent-application evidence | UNKNOWN (never on main) |
| `0169_trip_stop_provenance` (`leaseos` main) | applied in `leaseos` CI; no persistent evidence | UNKNOWN |
| `0016`, `0017`, `0094`, `0095`, `0098` | never existed as files on any line | **definitely not applied** anywhere |

Nothing here may be read as "not deployed". If a persistent database exists, the only way to learn
what it ran is `DATABASE_URL=… pnpm tsx scripts/migrate.ts status` against it (read-only; it creates
the ledger table if absent, which is the one side effect), or a `SELECT fileName FROM schemaMigrations`.
That is an owner/operator action and is the **first step of any renumbering**.

---

## 4. Duplicate `0157` — disposition

- Both files are distinct, both create/alter different tables, both are byte-identical across all
  three lines, and both have been applied in lexical order by every CI run since they landed
  (v22.75/v22.76). Under the filename-keyed ledger the pair is **legal and unambiguous**.
- Renaming either would turn every ledgered database into DRIFT (§1) for zero benefit.
- **Disposition: keep both as they are, permanently, and record them as the one grandfathered
  duplicate.** The gate in §6 encodes that exception explicitly.

---

## 5. Safe numbering strategy (no slot reserved here)

1. **A number is taken by whatever merges to `main` first.** `0169` is taken (`_defect_resolution`).
   Every other file numbered `0169`–`0173` on an unmerged branch is a **candidate**, not a claim, and
   is renumbered by its author at merge time to `max(prefix on main) + 1` — allowed only because
   those files have never been applied to a persistent database as far as §3 can tell, and only after
   the operator confirms that with `migrate.ts status` on each real environment (see §3). If a ledger
   row with the old name exists somewhere, that environment's row is renamed in the same change
   (`UPDATE schemaMigrations SET fileName=… WHERE fileName=…`, checksum unchanged) — a documented,
   reviewed operator step, never a re-run.
2. **Ported migrations from other lines never keep their number.** `0168_movement_permits` and
   `0169_print_audit` (v2327), `0169_trip_stop_provenance` (`leaseos`) land on main under new numbers,
   with a header comment naming the origin file and commit.
3. **Merge order decides the sequence**; the owner picks it. A plausible order that minimises rework:
   the branches already stacked on `main` (`feat/compliance-c1a`, PR #9, PR #6, PR #11) take
   `0170`–`0172`… in their merge order; `auth-workspace` (data-rewriting `0170`) merges alone with a
   fresh number; `driver-portfolio` and `training-academy` renumber; the lineage ports take the numbers
   after those. The Route Intelligence checkpoints RI-2/3/4a/5/6/9/10/11 take numbers only when they
   merge.
4. **Historical gaps stay gaps.** `0016`, `0017`, `0094`, `0095`, `0098` are never filled; the gate keeps
   refusing `0016`/`0017` and should refuse the other three the same way once the gate lands.
5. **Cross-branch visibility.** Since CI cannot see other branches, a lightweight `docs/register/MIGRATION_SLOTS.md`
   (or a section of the register) lists every unmerged migration-bearing branch and its candidate
   files, updated at PR-open time. This is a convention, not a gate; the gate below protects `main`.

---

## 6. Duplicate-prefix gate — design (Step 12; not implemented)

**What it detects (on the tree being gated):**

- two or more `drizzle/*.sql` files sharing a four-digit prefix → FAIL, naming both files;
- a prefix in the refused set `{0016, 0017, 0094, 0095, 0098}` → FAIL (extends gate 0);
- a filename not matching `^\d{4}_[a-z0-9_]+\.sql$` → FAIL;
- a new gap (prefix N absent while N+1 present, N not in the historical-gap set) → **WARN only**
  in the first release, FAIL after the owner confirms no branch depends on a gap.

**How the legitimate exception is represented:** a checked-in allow-list, one line per grandfathered
pair with the reason, e.g.

```
# drizzle/PREFIX_EXCEPTIONS — grandfathered duplicate prefixes. Adding a line here needs owner sign-off.
0157 0157_seal_verification_unavailable.sql 0157_signature_device_attestation.sql  # v22.75/v22.76 landed in parallel; both applied everywhere in lexical order; renaming would DRIFT ledgers
```

The gate reads the file and refuses any duplicate **not** listed, and refuses a listed pair whose
filenames no longer both exist (so the exception cannot outlive the files). Future duplicates are
therefore prohibited by default and admissible only by an explicit, reviewed line.

**Is the current 0157 duplication legal under the runner?** Yes (§1, §4). The gate's job is not to
outlaw what the runner accepts, but to stop a *second* pair forming by accident on the branch that is
being merged — which is how three unrelated `0170`s already exist.

**Placement:** `scripts/ci-gate.sh` gate 0b, before migrations apply; also runnable standalone
(`bash scripts/check-migration-prefixes.sh`) so a branch author can run it before opening a PR.
Landing it is a separate, owner-approved change **after** the 0169–0173 renumbering, so it does not
go red against unmerged work that is being renumbered anyway.
