# LeaseOS — how to allocate a migration

**Read this before creating any migration file.** The four-digit slot is
load-bearing and has already been allocated wrongly three times.

---

## Why the number matters more than it looks

`scripts/apply-migrations.sh` applies migrations like this:

```bash
for f in $(ls drizzle/*.sql | sort); do ... done
```

`sort`, on the filename. And `drizzle/meta/_journal.json` has been abandoned
since **0018** — 17 entries, snapshots stopping at 0007, against 166 migrations
on disk. Drizzle's own registry is dead; **the filename is the registry.**

So two files in one slot do not "both get applied and it's fine". Their order
is decided by whatever follows the digits, alphabetically. A merge can reorder
DDL that depends on the statement before it, and nothing notices: the table
count still matches, so `verify-parity.sh` passes.

## What has already gone wrong

| Slot | Occupants | Where |
|---|---|---|
| **0157** | `0157_seal_verification_unavailable.sql`, `0157_signature_device_attestation.sql` | both on this branch, both applied |
| **0168** | `0168_retire_storage_capability_urls.sql` / `0168_movement_permits.sql` | different lineages |
| **0169** | `0169_defect_resolution.sql` / `0169_print_audit.sql` | different lineages |

The B23.0 report recommended "migration 0169" for B23.1. It was already taken,
twice, by two unrelated migrations. The check below is what caught it.

---

## Allocating a slot

**1. The head on your branch is not the answer.**

```bash
ls drizzle/*.sql | sed 's|drizzle/||' | sort | tail -3
```

**2. Check every lineage, because the collision comes from the ones you are not
looking at.**

```bash
git fetch origin '+refs/heads/*:refs/remotes/origin/*'

for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/); do
  echo "$b :: $(git ls-tree --name-only "$b" drizzle/ \
    | sed 's|drizzle/||' | grep -E '^[0-9]{4}_' | sort | tail -2 | tr '\n' ' ')"
done
```

**3. Take the first slot free in ALL of them** — not head+1 on yours.

**4. Name it `NNNN_lower_case_with_underscores.sql`.** The guard rejects
anything else, because a name the runner cannot order is worse than a
collision: it sorts somewhere nobody intended.

**5. Let the guard confirm it.**

```bash
pnpm exec vitest run server/migrationSlots.test.ts
```

---

## The guard

`server/_core/migrationSlots.ts` — pure, so it is tested against synthetic
trees rather than only the real one. `auditMigrationSlots(files)` reports:

- **duplicate slots**, except those in `KNOWN_DUPLICATE_SLOTS`
- **malformed filenames** the runner cannot order
- **reserved slots** (0016, 0017) that must stay empty

`KNOWN_DUPLICATE_SLOTS` holds **0157 only**. It is a baseline, not an amnesty:
a duplicate in any other slot fails, and `migrationSlots.test.ts` includes a
case proving the 0157 entry does not mask a collision elsewhere. A test also
fails if 0157 is ever reconciled, so the entry cannot outlive its debt.

### Why the historical duplicates are not renamed

Renaming an applied migration changes nothing in a database that has already
run it. It only makes the tree disagree with every deployed database about what
has been applied. Detection first; reconciliation is a separate, deliberate
exercise with a plan for the deployed estate.

---

## Should LeaseOS stop using numeric slots?

Numeric slots are fine for a single line of development and get dangerous with
concurrent branches — which is what this repository now has. Two better schemes
exist, and **neither is adopted here**, deliberately: both change how 166
applied migrations are ordered, and this was a defensive checkpoint.

**Timestamp prefixes** (`20260923T154500_name.sql`) make collisions
astronomically unlikely and keep `sort` working, but the existing four-digit
files would sort *after* every timestamped one under plain `sort`, so adoption
needs a runner change or a one-time renumber.

**A real applied-migrations table** (what `_journal.json` was meant to be) is
the proper fix: record what ran, refuse to re-run it, stop inferring order from
filenames. That is the recommended direction, and it is its own checkpoint —
it needs a backfill of the 166 already applied, on every deployed database,
before it can be trusted to decide what to run.

Until then: allocate with the procedure above, and let the guard check you.
