# C1b-1 — One rule ledger

*2026-09-24, re-gated 2026-09-25. Branch `claude/leaseos-compliance-survey-5faxe8`, on `main` = `242b619`. Migration `0189`.*

## Owner questions: what this slice assumed

The owner asked to be told before C1b code, and the report asked C1b-Q1 to Q4. The owner then said
"Continue" without answering them. This slice proceeds on the **recommended answer to each**. Each one is
recorded here so it can be reversed, and none of them changes how dispatch decides anything today.

| Question | Assumed (recommended) | Where it lives | Cost of reversing |
|---|---|---|---|
| C1b-Q1: generalize `hosRuleLimitHistory` in place or copy into a new ledger | **In place, additive.** HOS history is not rewritten | `0189`, `promotionLedger.ts` | A new table plus a copy. `0189` only adds columns |
| C1b-Q2: who verifies a source or rule revision | **Never the proposer, never an automated path; a named person.** The `compliance.source.verify` permission comes with the first procedure (C1b-2) | `validateRuleEvidence`, `verifySourceRevision` | Swap the permission name in C1b-2 |
| C1b-Q3: which rules need two verifiers | **BLOCK rules at the statute or regulator-order tier** | `admission.requiresSecondVerifier` | One function |
| C1b-Q4: seeds as `candidate` rows | **Yes, when they are loaded.** C1b-1 loads none. The loader is C1b-2 | — | Nothing has been loaded |

## What changed

**`0189_rule_ledger_generalization.sql`.** It is additive except for three backfills.

* Changes to `hosRuleLimitHistory`:
  * New columns: `ruleFamily` (default `hos_limit`), `ruleRef`, `domain`, `authorityTier`, `dispatchEffect`,
    `sourceRevisionRef`, `sourceHash`, `proposedByUserId`, `secondVerifierUserId`, `secondVerifiedAt` and
    `payloadJson`.
  * `profileKey`, `limitKey` and `value` become nullable, because a non-HOS rule has none of them.
  * New index on (`ruleFamily`, `ruleRef`).
  * Backfill on existing rows: `ruleRef = profileKey.limitKey`, `domain = 'hos'`, and `authorityTier` from the
    design's §4 mapping table.
* Changes to `knowledgeVersions`:
  * New columns: `citation`, `section`, `publicationDate`, `retrievedAt`, `repealedAt` and `status`.
  * `status` is backfilled: `verified` where a verifier is recorded, `superseded` where a successor is
    recorded, and `candidate` otherwise.

**`server/_core/knowledge/promotionLedger.ts`.** This is the existing engine, generalized. No new engine module was added.

* HOS changes:
  * Every HOS read (`promote`'s prior-row lookup, `ledgerFor`, `believedOn`, `pendingFutureRules`) is
    restricted to `ruleFamily = 'hos_limit'`.
  * `promote` also writes the shared vocabulary (`ruleFamily`, `ruleRef`, `domain`, `authorityTier`).
  * `validateEvidence` is split. `validateCitedEvidence` holds the instrument, jurisdiction, citation, date and
    freshness checks in the same order as before, and is shared with other rule families.
* Additions for other rule families:
  * `promoteRule` is a new promotion path for rules other than HOS. It records only a ledger row and never writes a live row.
    It requires:
    * a `verified`, unrepealed source revision (looked up, not trusted), whose hash it copies;
    * a proposer who is not the verifier;
    * a second, distinct verifier for a blocking statute or regulator order;
    * a dispatch effect the authority can carry (guidance and best practice are capped at WARN).
  * `believedRuleOn`: the rule in force at a given date, as known at that date. A future rule applies from its
    date without anyone flipping a status.
  * `ruleHistory`, `rulesOnStaleSources` (rules whose source revision was superseded, withdrawn, repealed
    or re-hashed after they were verified), and `verifySourceRevision` (never the person who fetched the
    document).
  * `lifecycleOf` and `LIFECYCLE_TRANSITIONS` implement `candidate → reviewed → verified → active → superseded | withdrawn`.
    They read the lifecycle from the stored status and dates. Nothing is rewritten, and no person moves a rule
    to `active`.

**`server/_core/knowledge/admission.ts`** gains the §4 table (`tierForAuthority`, `isGuidance`,
`maxEffectFor`, `requiresSecondVerifier`), next to the authority levels it maps.

## What did not change

* **Dispatch.** No readiness, award or enforcement code reads the new columns yet. C1b-2 adds
  `requirementRef` to findings and checks.
* **HOS behaviour.** It is identical, and this is proven (see Tests).
* **The SPINE census.** No new engine module was added. The unwired count stays at 63. `DECLARED_UNWIRED` is unchanged.
* **Routes and permissions.** No procedure was added.
  * `promoteRule` and `verifySourceRevision` have no production caller until C1b-2 routes
    `requirementLoad` and `geo.sourceReview` through them.
  * The module is reached through `hosRouter`, so the census
    counts it as wired. The generic path in it is **not** yet reached, and it is recorded here rather than hidden.

## Tests

`server/ruleLedger.db.test.ts`, 30 cases.

* **0189 on a database that already holds HOS history.**
  * A scratch database is built to the pre-0189 shape from `0118` and `0120`, then filled with four HOS
    promotions (superseded, future, corrected, and the three authority types) and three source revisions.
  * It is snapshotted and then migrated.
  * Every pre-existing column of every row is compared value for value. The backfill is asserted.
  * The pre-0189 `believedOn` algorithm returns the same answer before and after for six dates.
* **HOS reads see HOS rows only.** A non-HOS FUTURE row in the same table never appears in
  `pendingFutureRules`, `ledgerFor` or `believedOn`. This was mutation-checked: removing the family filter
  from `pendingFutureRules` turns it red.
* **What a non-HOS rule must show.** 15 refusals and 2 acceptances; the mapping table; lifecycle and transitions.
* **The live ledger.**
  * The payload, hash, tier and both verifiers are recorded.
  * An unverified or missing source is refused.
  * Point in time: nothing before recording; v1 today; v2 on its date. Nothing is superseded early.
  * A duplicate is refused. A correction supersedes without rewriting. Correcting an unknown promotion is refused.
  * A rule whose source is superseded is listed as stale.
  * Source verification is refused to the person who fetched the document, and only moves `candidate` or `reviewed`.

Existing suites still pass unchanged: `promotionLedger.db`, `hos`, `federalCandidates.db`, `federalCandidateCorrection`,
`scopeGuard.db`, `engineReachability`, `spineWiringPlan`. Run alone on a fresh database, `federalCandidates.db`
fails, because its seeds are written by `hos.test.ts`. It passes once that suite has run. It reads
`hosRuleLimits` and `hosRuleProfiles`, which this change does not touch. That is an existing order dependence,
recorded here so it is not mistaken for a regression.

## SPINE

C1b-1 advances no SPINE item. Item 2's `complianceDocumentValidity` reconciliation is C1b-3. The moratorium
stands.

## Gate

Full gate from an empty database on this branch (`main` = `1680e94` merged in):

* All 171 migrations applied. Table parity is 410/410.
* Typecheck is clean, and there are 0 test-file type errors.
* 0 bare procedures.
* 343 test files: 4991 passed, 3 skipped. No database-backed suite was skipped.
* The build passes. 652 role-authorized procedures (unchanged).
* `LEASEOS_CURRENT_STATE.md` was regenerated.

The first gate run had 3 failures, all in `dispatchRoleUnassign.db.test.ts` (from #11, already on `main`). The
error was `Duplicate entry '…:dispatcher:*' for key 'userRoleAssignments_activeGrantKey_unique'`. Four suites
(`dispatchRoleAssignment`, `dispatchRoleReadiness`, `dispatchRoleStaffing` and `dispatchRoleUnassign`) each
draw user ids from `880_000_000 + random(50_000)`, then count up from there. Vitest runs files
concurrently, so two suites sometimes hand out the same id.
* The suite passes 10/10 when run alone, and the second full run passed.
* It does not touch anything C1b-1 changed.
* **Proposed fix** (not made here, because it is outside this slice): give each file its own window, e.g.
  `880_`, `881_`, `882_` and `883_000_000`.

**Re-gate on `main` = `242b619`** (S1 session hardening and repository hardening merged in; `main` added
`0175_session_families.sql`):
* 172 migrations applied. Parity is 411/411. Typecheck is clean, with 0 test-file type errors.
* 356 files: 5155 passed, 3 skipped, and 1 failed. The failure was `widgetPersistence.db.test.ts`, whose
  table-rebuild step hit the 5 s timeout under full-suite load. That suite uses its own database and
  touches nothing in this change. It passes 22/22 alone.
* The build passes and `LEASEOS_CURRENT_STATE.md` is current.

**CI on `da8aadf`.** Both runs failed in about 3 s. The job was never assigned a runner (`runner_id` 0, and the
logs return 404), so no step ran. The merge of `main` above re-triggers CI.

**Migration number.** Since the 2026-09-24 scan, two more branches have claimed `0189`
(`claude/document-control-design-imsd3n` and `claude/mechanic-portal-domain-82efa9`). The register records
this. Under its rule the first to merge keeps the number, and nothing is renamed pre-emptively.
