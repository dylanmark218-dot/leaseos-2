# C1b-2b — Requirement verification through the ledger

*2026-09-25. Branch `claude/leaseos-compliance-survey-5faxe8`, restarted from `main` = `88608f3` (PR #15
merged). Migration `0198`.*

## Owner decision

**C1b-Q2 = B.** Citation verification is permitted as a transitional trust level. Source-document
verification becomes mandatory per authority or domain as sources are admitted.

This is a **transitional architecture**. It is **not** a claim that LeaseOS has completed a legal-source
licensing assessment:
* No government site's licence has been judged acceptable because its content is public.
* Where licensing is unresolved, the citation route is open, source-document ingestion is marked pending,
  and a governance task is opened for the licence assessment.

## Verification levels

The levels are read from append-only events (`requirementVerificationEvents`). They are never written over
a row.

| Level | Meaning | Authoritative? |
|---|---|---|
| `UNVERIFIED` | Proposed; not yet verified by the required people. Also every row written before 0198, including those the old one-step path marked `verified` | No. It yields `requirement_unverified`, which means UNKNOWN |
| `CITATION_VERIFIED` | People verified it against a named official instrument, its citation and an official URL. LeaseOS does **not** hold an admitted source-document revision, so there is no automated change detection (`sourceMonitoringAvailable: false`) | Yes, during the transition |
| `SOURCE_DOCUMENT_VERIFIED` | Bound to an admitted, versioned source document. The ledger promotion records its content hash (`sourceMonitoringAvailable: true`) | Yes |
| `SUPERSEDED` | Derived: a later verified revision of the same requirement is in force at the date asked about | No longer governs; fully auditable |
| `WITHDRAWN` | A `withdrawn` event | No. The requirement no longer applies |

Citation-only verification is never called source-document verification. The ledger records the level on
each promotion: `hosRuleLimitHistory.verificationLevel`, with method `OFFICIAL_CITATION` for the citation
route.

## What a revision must carry before citation verification

All of the following are checked by `citationProblems`. Each missing item has its own refusal code.
* named instrument;
* issuing authority;
* jurisdiction;
* section, subsection or equally precise citation;
* official government or regulator URL (the citation guard's register of official domains);
* effective date, or an explicit `effectiveDateUnknown`;
* proposer identity;
* authority type;
* a content-and-citation fingerprint (`citationHash`) that still matches the stored revision.

Verifier identity, the verification timestamp and the method `OFFICIAL_CITATION` are recorded by the
events and the ledger promotion. The revision itself is immutable: a database trigger refuses UPDATE and
DELETE.

## Separation of duties and two-person approval

* **Proposer ≠ verifier.** `approvalCheck` compares user ids recorded in the events. It is not about roles or
  endpoints: the test proposer is a controller, who holds verify and second-approve, and is refused on both.
* **Dispatch-blocking** (`missingSeverity = blocked`): proposer → verifier 1 (`requirementVerify`) →
  verifier 2 (`requirementSecondApprove`) → promoted. Both verifiers must be different from each other and
  from the proposer. Step order is enforced. A source-document upgrade needs two people again, and both
  must name the same source revision.
* **Informational:** one independent verifier. A second approval is refused as not required.
* **A rejection** resets the pending approvals for that level.
* **The approval that completes the threshold** promotes through the ledger (`promoteRule`, family
  `compliance_requirement`, one rule per revision `key@vN`) in the same transaction as its events. If the
  ledger refuses, nothing is written.
* **HOS controls are unchanged.** `hos.limitPromote` still goes through `promote()` with its own rules.

## Permissions

These are separate permissions. All are sensitive (fail-closed) except `propose`.

| Permission | Procedures | Roles |
|---|---|---|
| `compliance.requirement.propose` | `compliance.requirementLoad` | controller, safety, legal |
| `compliance.requirement.verify` | `compliance.requirementVerify` | controller, safety, legal, management |
| `compliance.requirement.second_approve` | `compliance.requirementSecondApprove` | controller, legal, management |
| `compliance.requirement.retire` | `compliance.requirementWithdraw` | controller, management |
| `compliance.verification.govern` | `compliance.verificationPolicySet` | legal, management |
| `compliance.passport.read` (existing) | `compliance.requirementProvenance` | existing holders |

**Tenancy.**
* A revision's `orgRef` is the proposer's acting organization, from `actingScopeFor`, never input.
* Verification, withdrawal and provenance of another organization's revision answer "not found".
* The registry that the passport and work authorization read is the caller's organization's own revisions,
  plus rows written before 0198 (which have no organization), plus seeds.

## The legacy one-step path

* `compliance.requirementLoad` is **proposal creation only**. It still accepts `sourceVerified` and
  `requestedStatus` so old callers do not break, ignores both, and says so in its `note`.
* It always stores `unverified` and writes a `proposed` event.
* Rows written before 0198 that the old path marked `verified` are **UNVERIFIED**. They have no recorded
  proposer, so they cannot be verified in place and must be proposed again.
  * This is a deliberate tightening. A passport that read READY from such a row now reads UNKNOWN until the
    requirement is re-proposed and verified.
* Nothing is left behind:
  * `requirementVerification.ts` is the only production file that inserts a requirement. A source-scan
    test pins this, and pins that the insert writes `unverified`.
  * No production file updates `complianceRequirements` or the events.
  * The database refuses both anyway.

## Source-document transition

**Policy.** `sourceVerificationPolicies` is append-only and governed by `compliance.verification.govern`.
* It holds rows `{ issuingAuthority?, domain?, jurisdiction?, mode: CITATION_ALLOWED | SOURCE_DOCUMENT_REQUIRED }`
  per organization.
* The most specific matching row wins, then the latest.
* The default is `CITATION_ALLOWED`, the transitional answer.
* A row recorded later does not apply to an earlier date.
* It is not exposed in any UI.

**Moving an authority to `SOURCE_DOCUMENT_REQUIRED`.** New citation-only verifications for that authority
are refused. Existing citation-verified revisions keep their level and stay historically reproducible;
nothing is rewritten.

**When a source document becomes available:**
1. The source is ingested and admitted in the knowledge repository (outside this slice).
2. A verifier calls `requirementVerify` with target `SOURCE_DOCUMENT_VERIFIED` and the admitted
   `sourceRevisionRef`. For a blocking rule, a second verifier follows.
3. Each approval **compares** the admitted document with the approved citation. The document must be from
   the cited publisher's site, and the comparison is stored on the event.
4. The level becomes `SOURCE_DOCUMENT_VERIFIED`, and the ledger records the source hash. The citation
   promotion is marked `SUPERSEDED` in the ledger and stays there. The citation-verification events are
   untouched. Nothing is upgraded silently.

**What "admitted" means.** The document left quarantine through the licence gate, and its version is
`verified` and not repealed. The Alberta 511 source, the one with an assessment, can use this route.

**Licensing.** No licence is inferred from a site being public. Every citation promotion ensures one open
`operationalTasks` row per publisher and organization:
* task type `source_licence_assessment`;
* assigned to `legal`;
* requires evidence;
* description: "source-document ingestion is pending".

## Dates

Verification is not activation. `governingRevisions` is the canonical selection:
* Only revisions recorded by the evaluation time count, and only events recorded by then decide their level.
* Of the revisions verified (or withdrawn) by then and in force then, the highest version governs.
* An unverified proposal never displaces a verified revision. A future verified revision waits for its date.
* If the governing revision is withdrawn, the requirement no longer applies.
* With nothing verified in force, the newest revision stands, UNVERIFIED.

**Overlap.** A proposal may not take effect before a revision already on record (`OVERLAPPING_REVISION`).
Equal start dates resolve to the higher version.

**Gap.** A revision past its `effectiveUntil` stands for its key and simply does not apply. Nothing older
returns.

**Timestamps.** All timestamps written are truncated to seconds (the column precision), so fingerprints and
event ordering are exact.

## Provenance to the finding

Every passport and work-authorization item carries
`requirementRef = { key, version, origin, provenance }`. `provenance` holds:
* `level`;
* `promotionRef` (the ledger row);
* `verifierUserIds`;
* `proposedByUserId`;
* `citation { instrumentTitle, issuingAuthority, citation, officialUrl, jurisdiction }`;
* `sourceRevisionRef`;
* `sourceMonitoringAvailable`;
* `citationHash`.

That is: requirement → exact revision → verification level → citation → verifiers → ledger promotion.
`compliance.requirementProvenance` returns every revision with its citation, fingerprint and every event
in order.

Dispatch is not given a `requirementRef`: `composeReadiness` does not read the requirement registry, and a
fabricated reference would be worse than none. No dispatch rules table was created.

## Readers migrated

`compliance.passport`, `compliance.jobPassport`, `requirement.workAuthorization` and the
`requirement.packActivate` count all read the registry through `loadRequirementRegistry(seeds, at, tenantId)`.
Pack behaviour is unchanged:
* verification does not activate a pack;
* activating a pack does not verify a requirement (a test shows an unverified requirement in an active
  pack still reads "has not been verified").

## SPINE status (the moratorium is not lifted)

**Using the generalized ledger:**
* HOS limits (`hos.limitPromote` → `promote`);
* compliance requirements (this slice, `promoteRule`, both levels).

**Still outside it:**
* **Knowledge sources.** `knowledgeVersions` source verification: `verifySourceRevision` exists, but no
  production route calls it, and documents enter only through the unwired `knowledge/repository`.
* **Dataset licences.** `externalDataSources` (`geo.sourceReview`). Deliberately separate: it is a licence
  decision, not a rule.
* **Spatial facts.** Spatial and road facts: `roadRestrictions`, `structures` and the location/vehicle
  verification in `spatialRouter`.
* **Other registries.** `regulatoryThresholds` and `taxRules`.
* **Evidence verification, single-person by design (D-04).** Credential verification
  (`complianceDocuments`, `compliance.credentialVerify`); workforce, shop, asset and insurance verifications.
* **HOS profiles.** `hos.profileVerify`, which has its own two-person rule (0124).

**SPINE item 2 duplications remaining:** all four.
* `dispatchMatching`, `openShifts` and `fieldTicket` are untouched.
* **`complianceDocumentValidity` has not been reconciled.** It is still `DECLARED_UNWIRED`, and the four
  inline expiry decisions (`widgetSources.expiryState`, `compliancePassport.evaluateRequirement`,
  `readinessComposer.credentialState`, `dispatchReadiness.credentialBlocker`) remain. That is C1b-3.

**Census.** No new engine module was added. The unwired count stays at 63, and `DECLARED_UNWIRED` is
unchanged. `requirementVerification.ts` is a service beside `requirementRegistry.ts`, over the existing
ledger engine.

**Before the registry can contribute to the canonical dispatch composer:**
1. C1b-3: one document-validity path, so a passport item and a dispatch credential blocker cannot disagree
   about expiry.
2. A typed mapping from a passport item (status, effect, `requirementRef`) to a `ComplianceFinding`, in the
   C1a classification. No second composer.
3. `composeReadiness` reads the registry for the subjects it already evaluates (operator, unit, trailer)
   and merges those findings with `mergeFindings`, with the tenant from its existing scope. The findings
   then carry `requirementRef` into `dispatchEligibilityChecks`.
4. Re-verification of any legacy one-step `verified` requirement that production relies on. They are
   UNVERIFIED now.

## Tests

`server/requirementVerification.db.test.ts` has 25 cases, covering the owner's twenty.

| # | Case | Where |
|---|---|---|
| 1 | proposer cannot self-verify (by id, through both endpoints) | "1." |
| 2 | same user cannot be verifier 1 and 2 | "2." |
| 3 | blocking needs two independent verifiers; ledger row names both | "3." |
| 4 | informational: one verifier; a second approval refused | "4." |
| 5 | unverified is not authoritative (one approval: `requirement_unverified`, no ledger row) | "3." |
| 6 | citation-verified requirement evaluated, provenance on the item | "6." |
| 7 | missing / unofficial URL refused | "7." |
| 8 | missing citation, instrument, authority, authority type refused | "8." |
| 9 | `SOURCE_DOCUMENT_REQUIRED` closes citation for that authority only | "9." |
| 10 | admitted source permits source verification; quarantined, other-publisher and missing refs refused | "9.", "10." |
| 11 | source promotion keeps the citation history (events and ledger) | "11." |
| 12 | future verified revision waits for its date | "12/13." |
| 13 | historic evaluation selects the historic revision and level | "12/13." |
| 14 | pack membership honoured | "14/15." |
| 15 | inactive pack not activated by verification; activation verifies nothing | "14/15." |
| 16 | old one-step request stores a proposal; legacy verified row is UNVERIFIED; source scan; DB refuses UPDATE/DELETE | "16." ×2 |
| 17 | another organization's verifier gets "not found"; its registry excludes the revision | "17." |
| 18 | verifier permissions fail closed; privileged ones sensitive | "18." |
| 19 | withdrawn no longer applies; history stays; cannot be re-verified | "19." |
| 20 | superseded revision derived and auditable | "12/13." |

Also covered:
* a gap between revisions, and a refused overlapping revision;
* an explicitly unknown effective date;
* one licensing task per publisher;
* the pure rules (level at a date, rejection reset, policy specificity and time, a verified revision over a
  later proposal, identity checks, fingerprint).

**Mutation check.** Disabling the proposer check, or the same-verifier check, turns its tests red. Both were
restored.

**Existing suites updated:**
* `compliancePassport.test.ts`: the READY path now needs proposal plus two verifiers.
* `requirementRegistry.db.test.ts`: legacy rows read UNVERIFIED; the tenant argument added.
* `operationalApiAuthorization.test.ts`: the procedure census goes from 634 to 639.

## Race protection (found in self-review)

* **Two first approvals submitted at the same moment** used to leave a blocking requirement with two pending
  approvals and no valid next step. `approvalCheck` now accepts a second approval whenever at least one
  approval is pending, and a completion counts every approval pending.
* **Two verifiers completing at the same moment** could both promote. The completing transaction now locks
  the revision row (`SELECT … FOR UPDATE`) and refuses a second promotion to the same level. The refusal
  rolls back the ledger row too.

## Gate

The complete MariaDB gate ran from an empty database on this branch (base `main` = `88608f3`).

**First run: 2 failures, both caused by this change.**
* `crossLayerIntegrity`: the router-surface pin, 698 → 703.
* `procedureAuthorization`: the procedure-permission census, 634 → 639.

Both pins count mounted procedures, and this slice adds five. They were updated with a note.
`operationalApiAuthorization` has the same census and was updated before the run. These were not flakes and
not failures that already existed.

**Final run (after the race fix): PASS.**
* 178 migrations; parity 415/415.
* Typecheck clean; 0 test-file type errors; 0 bare procedures.
* 365 files: 5366 passed, 3 skipped, **0 failed**. No database-backed suite was skipped.
* Build OK; 657 role-authorized procedures; `LEASEOS_CURRENT_STATE.md` current.
* The `widgetPersistence` timeout seen in the C1b-1 and C1b-2a gates did not recur.

Focused suites on the final code: 268 passed across 13 files (C1b-2b, C1b-1 ledger, C1b-2a registry,
passport, work authorization, HOS, census, SPINE and knowledge-write guards). The acting-scope and tenant
suites: 49 passed.
