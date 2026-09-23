# B23.1A — organization authorization, hardened for deployment

B23.1 scoped role grants to the organization that issued them. This checkpoint
does not extend that work; it tries to break it, and reports what broke.

The headline: **B23.1 as committed failed against a real database**, and every
handler that authorizes twice was refusing everybody.

> **Corrected by B23.1B, 2026-09-23.** Two claims in the original version of
> this document were wrong, and the corrections matter more than the claims did.
>
> **"The CI workflow does not run the database tests."** It does, and always
> has. `.github/workflows/ci.yml` has carried a `mariadb:10.11` service,
> `DATABASE_URL` and `bash scripts/ci-gate.sh` since the repository's first
> commit. That sentence was not checked before it was written.
>
> **"26 failures."** 26 is what a *local* run produced against a database reused
> across runs, and most of them were the fixture-collision artefact described in
> §3 rather than anything B23.1 did. On a clean database — which is what CI uses
> — B23.1 failed **11 tests in 6 files**, and all 11 were the authorization
> regressions below. CI ran, went red, and said so at the time; nobody was
> watching, and no branch protection required it. See
> `LEASEOS_B23_1B_CI_ENFORCEMENT.md`.

---

## 1. The six risks, and what each turned out to be

| # | Risk as stated | What was actually true |
|---|---|---|
| 1 | The 20-case adversarial DB suite skipped locally | It skipped **locally only**. CI had been running it against MariaDB 10.11 all along and had been red since B23.0; see the correction above. |
| 2 | Unknown `unscoped_legacy` production population | Unknowable from here, so a read-only diagnostic was built to count it **before** the window rather than after. |
| 3 | `bootstrapManagementRole` wrote a global grant | Confirmed, and fixed: organization-scoped, refuses a multi-organization target, and reports the platform-wide population it declines to count. |
| 4 | Zero-membership grants assigned literal `orgRef='default'` | Correct as designed, and now pinned: `'default'` is the historical single tenant this deployment already acts as for such people, not an invented organization. |
| 5 | Divergent migration numbering | Confirmed worse than stated: **0157 collides on this very branch**, and 0168 and 0169 collide across lineages. |
| 6 | 0170 introduced into a repo whose filename ordering is its registry | Confirmed. `_journal.json` has been dead since 0018; `apply-migrations.sh` sorts filenames. The slot is the registry. |

---

## 2. The failure B23.1 shipped

`authorize()` gained an organization axis in B23.1, and the procedure gate was
taught to pass it. **Four handlers that call `authorize` a second time — after
the gate, once they have loaded the record — were not.**

```
records.evidence.seal
records.evidence.queueSend
records.evidence.requestDeviceDeletion
records.maintenance.recordRelease
```

To `grantsInOrganization`, an absent organization means *unresolved*: it cannot
judge an organization-confined grant, so the grant does not apply. That is
fail-closed and right in general. After 0170, **every grant a real user holds is
organization-confined**, so those four handlers refused everybody. Evidence
sealing, queued sends, device-copy deletion and work-order release were all dead
on arrival.

It passed every gate for one reason: the fixtures still wrote
`scopeType='global'`, which reaches every organization. The tests were the only
callers left in the system holding authority the product no longer issues. It
surfaced the moment one fixture was corrected to write what 0170 actually leaves
behind.

**Guarded now**, in `legacyGrantHardening.test.ts` §6: the source is scanned for
every call to the decision function or a wrapper that forwards to it, and each
must name the organization it is deciding in. Three files are allowlisted with
reasons; the allowlist fails if a listed file stops calling it. The guard was
verified by putting the bug back and watching it fail.

---

## 3. What else the database found

Once the database tests actually ran, a second class of failure appeared and it
is **not** an authorization bug:

`enforcementApi.test.ts` and its neighbours name fixed record ids (`unitId: 127`).
The tenant-scope suites create units from the auto-increment and claim them for
an organization in `coreRecordOwnership`. On a fresh database the ids never
meet. On a database kept across runs they eventually do, and every suite that
reaches a hardcoded id then reports `Work order N not found` — a tenant-scope
refusal that is entirely correct about a row another suite took ownership of two
runs ago.

Proven by deleting one row: 39 tests went from failing to passing with no code
change.

`ci-gate.sh` drops and recreates the database at gate 1, so **the gate is clean
and the gate is the answer.** Re-running `vitest` against a database you keep is
what produces the ghosts. That is now written at the top of the gate script.

This is a pre-existing property of the test suite, older than this lineage, and
fixing it is a test-isolation exercise rather than an authorization one. It is
recorded as a remaining risk rather than quietly bundled in here.

---

## 4. Evidence, not inspection

| Claim | How it is established |
|---|---|
| 0170 classifies legacy grants correctly | `scripts/verify-migration-0170.sh` — builds the pre-0170 world in a scratch database, seeds a row of every legacy shape, applies 0170 **alone**, asserts 32 properties including that no category gained cross-company authority. Gate 3b. |
| The database suites ran | `ci-gate.sh` fails if a `.db.test.ts` skips while a database is configured, **and** fails if the named authorization suites are absent. |
| The migration slot is free | `_core/migrationSlots.ts` is pure, so `migrationSlots.test.ts` hands it a synthetic tree containing the exact collision we are preventing, and the 0157 allowlist is proved not to mask one elsewhere. |
| Who loses access at deployment | `scripts/role-grant-diagnostic.sh` — read-only, predicts the classification before the window and verifies it after. Exit 0 / 2 / 3 is the verdict. |
| Rollback | There is none. Stated plainly in the checklist: the migrations are forward-only and the backfill overwrites the only copy of the old scope. The plan is *restore the backup*. |

---

## 5. Counts

Reported separately, because merging them is how "the tests pass" came to mean
"the tests that ran passed".

| | Files | Passed | Failed | Skipped |
|---|---|---|---|---|
| **No `DATABASE_URL`** | 256 + 55 skipped | 3454 | 14 | 902 |
| **Full gate, clean database** | 312 | 4370 | 0 | 3 |

- The **14** are `fieldroute.test.ts`, byte-identical to the documented
  baseline: that file needs a database but does not gate on `DATABASE_URL`, so
  it fails rather than skipping. With a database, all 14 pass.
- The **902** are the database-gated suites. 899 executed and passed under the
  gate; the remaining 3 are explicit `it.skip` in `agentRuntimeApi.test.ts`,
  unrelated to the database and carrying their own reasons.
- **899 database-backed cases executed that had never executed before.**

---

## 6. Remaining risks

1. **Shared-database test collisions** (§3). Pre-existing; the gate's clean
   database hides it and re-runs expose it. Worth its own checkpoint: give the
   ownership-claiming suites a reserved id range, or stop hardcoding record ids.
2. **The production `unscoped_legacy` population is still unknown.** The
   diagnostic tells you; nobody has run it against production yet. That is the
   first step of the deployment, not of this checkpoint.
3. **Numeric migration slots remain.** Detection is in place; reconciliation of
   0157/0168/0169 and a real applied-migrations table are deliberately not
   attempted here. See `LEASEOS_MIGRATION_POLICY.md`.
4. **Platform-wide grants have no revocation path.** None exist after this work,
   and none can be created, but a legacy one cannot be cleared through any
   procedure — only by hand. Surfaced in three places rather than fixed, because
   fixing it means deciding who may hold platform authority, which is an
   architecture question this checkpoint was told not to answer.
