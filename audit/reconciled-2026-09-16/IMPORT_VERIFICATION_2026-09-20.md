# Import verification — reconciled v22.21 onto `claude/new-session-32erhi`

Date: 2026-09-20 · Verifier: Claude Code session `session_01WT6zntTafcKuL74iGfEHwH`

This records what was imported into this repository, what was checked rather than
assumed, and what was found. It is written to be falsifiable: every number below
came from a command run against this tree, and the commands are named.

## 1. What was imported

The repository was empty — two commits, no files. The reconciliation package
delivered four artifacts, and all four agree with each other:

| Artifact | SHA-256 verified | What it established |
| --- | --- | --- |
| `leaseos-master-2026-09-16.bundle` | yes | 424 refs. `515ce64` is reachable from exactly one branch, `integration/reconciled-2026-09-16`. |
| `leaseos-reconciled-v22.21-src.zip` | yes | 868 files, **byte-identical** to the tree of `515ce64` (`diff -rq`, zero differences). |
| `leaseos-recovered-source-chat4-chat5-2026-09-16.zip` | yes | The Chat 4 / Chat 5 recovery inputs. Superseded by the tip. |
| `gate-final.log` | yes | The gate output for `515ce64`, timestamped to the commit's own date. |

The two uploaded copies of the recovery zip are byte-identical to each other.

`515ce64` was merged into the repository's own root with
`--allow-unrelated-histories`, so both lineages are preserved. The merge added the
reconciled source without altering it: the merge tree and the tree of `515ce64` are
the same object (`5b53ea0384d84e19dc7d2568dd5123b328ae9749`), and
`git diff 515ce64 <merge>` is empty.

The recovery zip's apparent "missing" files are renames, not losses. Its staged
migrations were renumbered onto the tip — `0089→0118`, `0090→0119`, `0091→0120`,
`PENDING-5→0121`, `PENDING-6→0122` — and its `.patch.md` / `.append.ts` staging
files were consumed when applied. Of its 43 comparable files, 27 are byte-identical
to the tip and 2 differ by deliberate improvement.

## 2. The gate was re-run, not trusted

`gate-final.log` was treated as a claim to test. The full `scripts/ci-gate.sh` was
run from an empty database on the configuration the audit names — MariaDB 10.11.14,
Node 22, pnpm 10.4.1.

**It did not pass.** Four tests failed. Two independent causes were found, neither
introduced by the import, both now fixed (commit `2c342b8`).

### 2.1 A calendar-pinned fixture

`server/workforce.test.ts` hired its subject with `startDate` 2026-09-14.
Onboarding tasks are given `dueBy = startDate + dueDays` (`workforceRouter.ts:89`),
and orientation and device enrolment are due at +3 days. `onboardingStatus`
compares `dueBy` against the real clock, so from **2026-09-17** onward the summary
reads `6 required task(s) open, 2 overdue` and the assertion fails permanently.
The recorded gate run had four days left on it.

This is the same defect the reconciliation already fixed once, in
`promotionLedger.db.test.ts`, whose own comment says the calendar passing a fixture
date "is how this was found".

### 2.2 Database-backed suites contending under parallel test files

Every suite shares one schema, and vitest runs files in parallel. The sharpest case
is the outbox: `workflowEndToEnd.test.ts` starts a **real** drain worker, and its
claim query (`server/_core/workflowRuntime.ts:339`) filters on nothing but
`processedAt IS NULL`. While that worker is alive it claims events that
`workflowOrchestration.test.ts` inserted for its own two workers, which then find
nothing and fail an assertion about work they never received.

Two full parallel runs failed four tests between them and never the same four:

| Run | Failures |
| --- | --- |
| 1 | 2 outbox tests, 1 `oosPolicyApi` approval race, 1 `workforce` |
| 2 | 2 different outbox tests, 1 `commercialProjects`, 1 `workforce` |

Only `workforce` repeated, because only it was deterministic.

`fileParallelism` is now off. It costs no wall clock — 179 s serialised against
182 s in the recorded parallel run — because collection dominates the run.

### 2.3 A real race, which only CI was unlucky enough to hit

Once CI ran the whole gate it failed on one test that had passed three times
here: `oosPolicyApi` — *two approvers cannot both approve into one scope*, with
two approvals fulfilled where one was expected. It failed with `fileParallelism`
already off, so test interference was ruled out. This is an application defect,
not a test defect.

`oosPolicyApprove` in `server/commsRouter.ts` knew about the hazard — its comment
describes it exactly — and guarded it with `GET_LOCK`/`RELEASE_LOCK`. The guard
did not hold. `RELEASE_LOCK` sat in a `finally` block *inside* the transaction
callback, so it ran before drizzle issued `COMMIT`. A second approver could take
the advisory lock while the winner's approval was still uncommitted, read a scope
that still looked clear, and approve into it too.

Rather than trust a re-run, the mechanism was tested directly with two
connections against the migrated schema, holding one transaction open:

| Second approver's read | Blocked? | Approved policies it saw |
| --- | --- | --- |
| plain `SELECT` | no | 0 — a clear scope, so it approves as well |
| `SELECT … FOR UPDATE` | yes | blocks until the winner commits, then refuses |

The advisory lock is replaced by a locking read over the scope, taken before the
conflict check. A locking read returns the latest committed row rather than the
transaction's snapshot, so the loser blocks until the winner commits and then
sees the policy it must refuse against. Scope is matched NULL-safely and without
the tenant, which locks a superset of the rows the conflict check considers —
never fewer than the contended ones.

### 2.4 Result after the fixes

```
== PASS ==            exit 0
191 test files        3035 passed | 3 skipped
tables 356            migrations 118
role-authorized 526   external 36   integration 2
LEASEOS_CURRENT_STATE.md  regenerated identical
```

Every number matches `gate-final.log` exactly.

## 3. Found and reported, deliberately not changed

These are real and were left alone because each is a decision for the repository
owner, not a mechanical correction.

1. ~~**The release row disagrees with the release file.**~~ **Closed.**
   `LEASEOS_CURRENT_STATE.md` stated the release was **v22.21** and named
   `LEASEOS_RELEASE` as where it is read from, while `LEASEOS_RELEASE` contained
   **v22.20**. Gate 8 could not catch it: it extracted the release *from the
   document* and passed it back as argument 1, so the one row the document sources
   from a file was compared only against itself.

   The document was right and the file was stale. `LEASEOS_RELEASE` was written
   once, in `4567d40` ("make CAL05a release version an explicit source of truth"),
   and never bumped; `56390c8` then moved the document to v22.21 in the same change
   that moved Tables 350→356 and Migrations 113→118, both of which are correct for
   this tree. `LEASEOS_B22_21_TRAINING_ACADEMY.md` withheld the v22.21 label
   "until the repository's normal pnpm dependency tree and disposable MySQL test
   database are available and the complete CI gate runs" — the condition the
   reconciliation satisfied — and checkpoint 0088 already targets v22.22.

   `LEASEOS_RELEASE` now reads v22.21, and gate 8 takes no argument, so the
   document is regenerated from the file it names. Verified both ways:
   regenerating at v22.21 reproduces the committed document byte for byte, and
   seeding a wrong release makes gate 8 fail and name the row, which it did not do
   before.

2. **No `LICENSE` file.** Named in the audit's own gap list. Which licence is the
   owner's choice.

3. **No `README.md`.** The root has `README_RECONCILIATION.md`; a newcomer landing
   on the repository page finds no general orientation.

4. ~~**CI runs five of the eleven named checks in the gate.**~~ **Closed.** The
   workflow ran migrations, parity, typecheck, tests and build as direct steps,
   omitting the reserved-slot check (gate 0), the bare-`protectedProcedure` check
   (gate 5), the portal and machine gates (7b, 7c) and the current-state freshness
   check (gate 8). Commit `489f209` replaced the inline steps with
   `scripts/ci-gate.sh`, so CI now runs the whole gate. That is what caught §2.3.

5. **`drizzle/meta/_journal.json` is stale** relative to the 118 migration files.
   Nothing in the gate reads it; `scripts/apply-migrations.sh` globs the directory.

6. **The reachability gate does not see the recovered knowledge tranche.**
   `coreEngines()` in `server/engineReachability.test.ts:68` is a flat
   `readdirSync("server/_core")`, so it enumerates the 167 modules sitting directly
   in that directory and never descends. The nine modules the reconciliation
   recovered into `server/_core/knowledge/` are therefore outside the wired-or-
   declared discipline entirely: they are neither counted as reachable nor required
   to be declared unwired. The gate's 34-unwired baseline is correct for what it
   measures; it simply does not measure this tranche.

7. **The migration runner verifies one retention guard and reports six.**
   `scripts/apply-migrations.sh:38` counts exactly one trigger,
   `academyCertificates_retention_guard` from 0108, then prints "migrations applied
   and Academy retention guard verified". Migration 0121 installs five more
   `BEFORE DELETE` guards — on `academyCourseVersions`, `academyModules`,
   `academyContentBlocks`, `academyAssessmentAttempts` and
   `academyStatementsOfExperience` — and none of them is checked. A run that
   silently lost those five would still print the success line. The comment above
   the check calls certificate retention "a legal/compliance invariant, not an
   optional convenience", which is the argument for extending the count rather
   than narrowing the message.

8. **The migrations row explains two gaps in the numbering and there are five.**
   `LEASEOS_CURRENT_STATE.md:11` reads `(slots 0016/0017 reserved and absent)`.
   The range 0000–0122 holds 123 numbers and the directory holds 118 files, so five
   numbers have no migration: 0016 and 0017 as documented, and **0094, 0095 and
   0098**, which nothing in the tree accounts for. The audit's separate claim that
   0123 is the next free slot is correct and was re-verified; the risk here is a
   reader taking the parenthetical as a complete account of the numbering and
   treating those three as reusable.

9. **"Bare protectedProcedure: 0" does not measure what gate 5 enforces.**
   Both counts run over the same 43 routers, but not the same pattern.
   `scripts/current-state.sh:26` counts `protectedProcedure\s*$|protectedProcedure\.`
   while `scripts/ci-gate.sh:44` counts `\w+:\s*protectedProcedure\b`. The gate
   asks whether a procedure is *mounted* bare; the document asks whether the symbol
   appears bare at all. Both currently report 0, which is why the divergence is
   invisible — but the row reads as a restatement of the gate and is not one.

## 4. Fixed, because there was only one defensible answer

**CI could never have applied its own migrations** (commit `e4a4442`). The workflow
provisioned `mysql:8.0`, but `drizzle/0021_active_role_uniqueness.sql` declares a
generated column ending in `PERSISTENT` — MariaDB's keyword, which MySQL 8.0 rejects
outright, accepting only `VIRTUAL` and `STORED`. The run would have stopped at
migration 21 of 118. `PERSISTENT` occurs exactly once in the whole directory, so
one keyword stood between the committed CI and a run that meant anything.
`server/reservedWordColumns.test.ts` agrees on the intended engine: it derives its
reserved set from the live server and pins the answer MariaDB 10.11 gives. The
service is now `mariadb:10.11`.

## 5. Confidentiality

The audit warns that `restricted/chat5-assessor-key` holds
`LEASEOS_ASSESSOR_KEY_CONFIDENTIAL.html` and must not reach a public remote.

That branch was not imported. The file is absent from the tip's tree, from all 39
commits of its ancestry, and from every ref in this repository.

One detail is worth recording rather than glossing. Fetching the tip made git
follow tags, and that dragged in `cc33ee3` — the head of the restricted branch,
carrying `archive/raw/chat5/LEASEOS_ASSESSOR_KEY_CONFIDENTIAL.html` — as an
**unreachable** object in the local store. Unreachable objects are never sent by
`git push`, and `git ls-remote` confirms the remote holds no such ref and no such
commit. It has since been pruned locally (`reflog expire --expire=now --all`
followed by `gc --prune=now`), and a sweep of every commit object remaining in the
database finds no file matching *assessor*. The lesson generalises: fetching a
single branch out of this bundle is not the same as fetching only that branch's
objects. The bundle's other
423 refs were never fetched as branches. The 33 tags that `git fetch` followed were
checked and **all 33 point outside this branch's history**; they were deleted
locally, so nothing but `claude/new-session-32erhi` can be pushed. Separately, a
scan of every blob in the object database found no private keys, cloud keys,
bearer tokens or credential literals; the only credential-shaped strings are test
fixtures and an ephemeral CI service password.

## 6. What this verification does not claim

It does not claim the recovered code is correct beyond what its own tests assert.
It does not claim any regulatory figure is verified — invariant P9 was re-tested and
holds: every HOS value in the tree is an unverified candidate or a fixture. It does
not claim the audit's six remaining gaps were closed; they were re-tested and are
genuinely still open, and `0123` is confirmed as the next free migration slot.
