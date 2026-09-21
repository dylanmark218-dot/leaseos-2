# LeaseOS — v20.17 Checkpoint: P3 Integrity Closure

| | Previous | New |
|---|---|---|
| Version | v20.16 | **v20.17** |
| Tables | 140 | **141** |
| Migrations | 30 | **31** |
| Procedures (role-authorized) | 152 | **152** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,028 | **1,044** |
| Test files | 46 | **47** |
| Parity | 140/140 column-level | **141/141 column-level** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 454.9 kb |
| CI gate | manual sequence | **`scripts/ci-gate.sh`** |

Reserved slots 0016/0017 untouched — and the gate script now refuses to run if
they are not. **P3 is closed.**

---

## The release requirements, each met

The specification named four. Here is each one and what holds it.

### 1. Fingerprinting is the service's act, not the caller's

The commit sequence is now exactly the one specified:

```
Proposal → Authorization → Context re-resolution → Fingerprint gate
  → Typed adapter → Destination permission → Destination lock → Write
  → Evidence auto-file → Commit receipt
```

Nobody calls a duplicate check. `executeAssistantCommit` runs it for every
document form and refuses on its own. Tested by committing two different photos
of the same receipt through the ordinary path with no hint of a duplicate
check anywhere in the call: the second is refused as `possible_duplicate`.

**The override is a recorded act, not a parameter.** It lives on the proposal
row as who and why — `duplicateOverrideByUserId`, `duplicateOverrideReason`.
`executeAssistantCommit` takes no override argument. A test sets the boolean
with no name attached and confirms the gate ignores it: a flag is not an act.

**Exact duplicates are refused even with an override on file.** Same bytes,
nothing to review.

**Event forms are not fingerprinted.** An unload stop is not a piece of paper.
Two defect reports about the same unit are two reports, not a duplicate.

### 2. Home-base distance is evidence, never a determination

`remoteWorkEvidence.ts`. The output type carries `taxConclusion:
"not_determined"` as a **literal type** — not an enum with other values, not a
nullable field somebody could later populate. A downstream reader that wants a
tax conclusion has to get one from a person; the type cannot express it. The
persisted table has no column that could hold one either.

Distance source ladder: operator-confirmed > routed > geodesic > unknown, and
the record says which rung it reached. Missing coordinates yield
`insufficient_evidence` with a reason, never a silent zero. `(0, 0)` is
treated as a failed fix, not the Gulf of Guinea. The year summary counts days,
nights and distances and asserts, by test, that it has no `eligible` key.

### 3. The auto-filer reuses the vault

One receipt now belongs to the **expense**, the **financial entity**, the
**worker**, the **tax year**, the **job** and the **unit** — six relationships
on one `evidenceRecord`, zero copies. `evidenceRelationships` already did this;
it just did not know about financial entities, so the enum gained
`expenseRecord`, `financialEntity`, `taxYear` and `user` by forward migration.
The test counts the evidence rows after filing and asserts exactly one.

### 4. Concurrency, and the gate as a script

**Two concurrent commits of one proposal.** `Promise.all` on the same
proposal: both return `committed: true`, exactly one `replayed`, and the
database holds one expense, one receipt, one fingerprint. The row lock on the
proposal was always there; this is the first test that races it.

**`scripts/ci-gate.sh`.** The sequence every checkpoint has passed since v20.2,
as an artefact: reserved-slot check → drop and recreate → migrations → table
parity → typecheck → bare-`protectedProcedure` count → full suite (which now
includes column-level parity and the reserved-word audit) → build. Fails at the
first gate that fails and says which.

---

## Two things the gate caught on its first run

**A cast that hid a bug.** I wrote the fingerprint insert with
`as typeof documentFingerprints.$inferInsert` and included a `proposalId`
column that did not exist. Drizzle silently dropped it; the cast silenced the
type error that would have told me. Two tests then failed querying a column
that was never written. Fixed by adding the column and **removing the cast** —
the type system had the answer and I had told it not to speak.

**Fixtures written before uniqueness existed.** The receipt test hardcoded
"Fuel Stop #12 / 2026-09-08 / $546". Fine when nothing enforced document
uniqueness; a collision with the previous run's receipt now. And the disposal
test expected its duplicate to be refused by the write path's own check — it
now gets refused one layer earlier, by the fingerprint gate. Both are the new
gate working. The receipt fixture is now unique per run; the disposal test
accepts either refusal and asserts the write-path guard still stands behind the
gate.

---

## Files

**New:** `0032_integrity_closure.sql` · `remoteWorkEvidence.ts` ·
`integrityClosure.test.ts` (16) · `scripts/ci-gate.sh`

**Changed:** `assistantCommitService.ts` (gate, auto-filer, helpers) ·
`schema.ts` · `assistantCommitService.test.ts` (fixtures)

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative rule loaded; every determination correctly UNKNOWN.

---

## Exact next tranche

**v20.18 — P4 Secure Field Runtime.** Encrypted device database and file
vault, device-keystore-backed keys, server-issued device identity and
revocation, key rotation, sync receipts with hash verification, conflict
handling, storage-pressure rules. The governing rule from the specification:
*no connectivity should prevent synchronization, not prevent work.*

Everything in P3 was shaped for this. Proposals, questions, fingerprints,
extractions and remote-work evidence are all rows with no dependence on the
network to exist. P4 is where those rows learn to live encrypted on a tablet in
a place with no signal, and to prove on reconnection that they were not altered
on the way back.

Then **v21.0 — Portal Foundation**, on the composition engine that already
exists and the API that already gates it.
