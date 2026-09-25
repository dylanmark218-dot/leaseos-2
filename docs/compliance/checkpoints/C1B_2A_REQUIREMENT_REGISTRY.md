# C1b-2a — The requirement registry, read one way

*2026-09-25. Branch `claude/leaseos-compliance-survey-5faxe8`, on `main` = `a9a7246`. No migration.*

C1b-2 was planned as one slice: put requirements under the rule ledger, make revisions immutable,
fix the loader defects and record `requirementRef`. The survey for it found a dependency the plan did
not know about (below), so it is split.

* **C1b-2a (this):** everything that does not depend on that dependency.
* **C1b-2b:** verification through the ledger. It needs an owner decision.

## What changed

**`server/requirementRegistry.ts` (new service, not a `_core` engine).** This is the one place that
answers "which requirements are in force". Before this, three procedures answered it three ways.

| Reader | Before | Now |
|---|---|---|
| `compliance.passport` / `jobPassport` | every stored row, **every version**, superseded or not; each row's `packKey` dropped | the governing revision of each key, with its pack |
| `requirement.workAuthorization` | **the seed constants only**; the table was never read | the registry at `ctx.at` (stored revisions, then compliance and equipment seeds) |
| `requirement.packActivate` | a pack had to be a seed; a stored `compliancePacks` row was "Unknown pack" | stored packs and seed packs; the same for automatic activation |

**Revisions are immutable.** `compliance.requirementLoad` no longer updates the previous version.
Before, it set that version's status to `superseded` and its `effectiveUntil` to the new `effectiveFrom`
the moment the new version was loaded. For a new version effective in the future, that left an interval
in which **neither** version applied.

`governingRevisions` now decides from the stored versions and their dates:

* Only revisions recorded by the date asked about count.
* Of those, the highest version already in force governs.
* A later version that is not yet in force leaves the earlier one governing until its date.
* A stored key suppresses its seed even while its only revision is not yet in force.

Rows the old path overwrote keep their mark. Their original status is recovered from
`verifiedByUserId`, which the old path never cleared. The data is read correctly, not rewritten.

**`requirementLoad`:**
* It accepts every subject the column holds. Before, `equipment`, `attachment` and `work_context`
  requirements could exist only as seeds.
* It accepts a `packKey`, validated against the known packs. Before, a stored requirement could not
  belong to a pack.

**`requirementRef` on every passport item.** Each item records `{ key, version, origin: registry | seed | code }`.
This is the exact revision the answer used. Work authorization's items carry it too, because they are
built by the same function.

## What did not change, and why

* **Who can verify a requirement.** `requirementLoad` still lets a controller store a requirement as
  `verified` in one step, when they state the source is verified and name an authority. Changing that
  is C1b-2b, and it waits for the owner decision below.
* **Dispatch.** `composeReadiness` does not read the requirement registry at all, so
  `dispatchEligibilityChecks` gets no `requirementRef` column. The column would always be empty. It
  comes with the checkpoint that makes dispatch read requirements.
* **`geo.sourceReview`.** The plan said it would go through the ledger. It clears a dataset
  **licence** (`externalDataSources`), which is not a regulatory rule. Putting licence decisions in the rule
  ledger would mix two ladders the design keeps apart (§4). It stays where it is. This is recorded as a
  deviation from the plan.

## The dependency behind the split (owner decision for C1b-2b)

C1b-1 built the rule ledger so that a rule revision is verified against a **verified source revision**
(`knowledgeVersions`), whose hash it records. A source revision belongs to a `knowledgeDocuments` row.
Documents enter only through `knowledge/repository.ts`, which is unwired, and only from a source with a
stored **licence assessment**. Today exactly one source has an assessment: Alberta 511.

So routing requirement verification through the ledger today would mean that **no requirement could be
verified at all** until someone makes a licence assessment for the regulatory instruments requirements
cite (federal and provincial statute sites). That assessment is a legal decision, not an engineering one.

Options for C1b-2b:

| Option | What it means | Cost |
|---|---|---|
| **A.** Assess the instrument sources first | A person records a `link_only` licence assessment for each statute publisher. Documents are registered as links (no text stored). Requirements are verified against those source revisions | Needs the assessments. Wires `knowledge/repository`, which removes one engine from the SPINE unwired census |
| **B.** Citation-level verification now, source revision later (recommended) | Requirements are verified at the bar HOS figures already meet: named instrument, section, official URL checked by the citation guard, a named verifier who is not the proposer, and two verifiers for a blocking statute. `sourceRevisionRef` is optional until A is done, then required | A requirement verified under B carries no source hash. `rulesOnStaleSources` cannot watch it until it is re-verified under A |
| **C.** Keep single-person verification until A | Nothing changes for verification | The self-verification the C1b plan set out to remove stays |

## Tests

`server/requirementRegistry.db.test.ts`, 11 cases:
* **Pure revision choice:**
  * in force versus recorded;
  * the old in-place supersession undone;
  * an overwritten unverified revision never recovered as verified;
  * withdrawn;
  * not yet effective.
* **Through the API:**
  * v1 is byte-identical after v2 is loaded, and governs until v2's date;
  * every subject type is accepted; an unknown pack is refused;
  * a passport item carries the governing revision, with one item per key (not one per version);
  * seed origin, and a stored revision replacing its seed;
  * work authorization reads a stored requirement, honours its pack, and a stored pack can be activated.

`compliancePassport.test.ts` and `requirementEngine.test.ts` pass unchanged. `compliancePassport.test.ts`
does not pass when run a second time against the same database: it loads a verified CA-AB requirement
and asserts the state before it. That is true before this change as well; it is recorded here, not fixed.

## Gate

Full gate from an empty database on this branch (`main` = `a9a7246` merged in):
* All migrations applied. Parity is 413/413. Typecheck is clean, with 0 test-file type errors.
* 364 files: 5341 passed, 3 skipped, and 1 failed. The failure was `widgetPersistence.db.test.ts`
  ("creates the cascade and the per-owner uniqueness"), which timed out at 5 s while rebuilding tables
  in its own `…_widgets` database under full-suite load.
  * The same case failed the same way in the C1b-1 re-gate.
  * It passes 22/22 alone.
  * It touches nothing in this change.
  * CI on `main` passes it.
* The build passes and `LEASEOS_CURRENT_STATE.md` was regenerated.
