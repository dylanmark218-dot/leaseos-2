# C1a — Readiness hardening (the dispatch compliance contract)

Status: **complete on branch `feat/compliance-c1a-readiness-contract`**, not merged. No C1b or C2 work
started. No new engine, no second readiness authority.

## SHAs and gates

| | |
|---|---|
| Starting SHA (before prerequisite merges) | `006069057b8a245ce00c0453d500f1e69c9e916c` (`main`) |
| PR #4 | head `c72a55a`, main merged into it as `8ad53d6` (only the generated `LEASEOS_CURRENT_STATE.md` conflicted; regenerated); gate PASS at `8ad53d6`; CI green; **merged as `38d26770bdcd5b4bd89f14fee6874559492394bf`** |
| Main gate after PR #4 | PASS. 312 files, 4334 passed, 3 skipped; 166 migrations (head `0169`) |
| PR #5 | head `e6b65f22ffc0af4e8ac29dfcb8e5e9506006c287` (contains `38d2677`); CI green; server change limited to `dispatch.readiness` returning `capabilities`/`capabilityVerdict`; **merged as `6b01a0eaf5f1147fd0db0499e3cd9fccf3c03ee1`** |
| Main gate after PR #5 | PASS. 315 files, 4416 passed, 3 skipped; 166 migrations (head `0169`); 647/36/2 procedures; build OK |
| C1a as first built | `1272b2d` + `7c07bef` on `38d2677` (full gate PASS, CI green) |
| C1a rebased | onto `6b01a0e`. Only `LEASEOS_CURRENT_STATE.md` conflicted textually; `dispatchRouter.ts` merged with **both** #5's capability picture and C1a's tenant scope check in `dispatch.readiness` (read and verified, not assumed) |
| Migration used | **`0174_dispatch_override_provenance.sql`**. Built as `0172`; the re-scan at integration found `0172`/`0173` claimed by `claude/training-academy-workforce-q3mdse`, so C1a moved to the first number no branch held. See `docs/architecture/MIGRATION_COLLISION_REGISTER.md` |
| C1a rebased gate / PR / merge | recorded in "Integration record" at the end of this document |

## PR dependency / conflict matrix (#4, #5, #6, #9)

| PR | Branch | Stacks on | Touches `readinessComposer.ts` | Touches `dispatchRouter.ts` | Migrations | Could overwrite OOS wiring? | Action taken |
|---|---|---|---|---|---|---|---|
| #4 | `readiness-defect-repair` | main | **yes** (OOS read, defect/release split) | no | `0169` | n/a (it *is* the wiring) | main merged in (`8ad53d6`), gate PASS, CI green, **merged** as `38d2677` |
| #5 | `feature/dispatcher-readiness-panel` | #4 | no | yes (`readiness` returns capabilities) | none | **no** (does not touch the composer) | main merged in (`e6b65f2`; `a11yCoverage.test.ts` entries from both sides kept; generated doc regenerated); base retargeted to `main`; focused suites pass |
| #6 | `feature/dispatcher-detail-assignment` | #5 | no | yes | none | no | #5 merged in (`02c0b74`); focused suites pass |
| #9 | `feature/dispatch-role-assignment-backend` | #5 | no | yes (role-slot procedures) | `0170`, `0171` | no | #5 merged in (`84c69fc`); its own 13 suites + count pins pass; **`0170` still collides** with the auth-workspace branch and the driver-portfolio branch |

(Written before integration.) C1a conflicts expected with #5/#6/#9 only in `dispatchRouter.ts` (C1a adds scope checks and changes
`overrideRequest`/`overrideGrant`/`award`; they add procedures and change `readiness`'s return). They
are textual, not semantic. C1a must merge after #5, or #5 must rebase onto C1a, so that #5's
`readiness` return keeps C1a's scope check.

## What changed

### Files

| File | Change |
|---|---|
| `server/_core/complianceFinding.ts` | **new**: the typed contract (`ComplianceFinding`), D-02 classification, strictest-wins merge, override classes, empty approved-override-policy registry, shared coverage rule |
| `server/_core/complianceFinding.test.ts` | **new**: 42 pure cases |
| `server/complianceReadinessC1a.db.test.ts` | **new**: 15 database-backed cases through the real procedures |
| `server/telematics.test.ts`, `server/surfaces.test.ts` (unchanged; a C1a test was leaving an expired policy that the unscoped exception centre showed a driver — fixed in the C1a test) | an undetermined fault is now UNKNOWN/BLOCK/APPROVED_POLICY_ONLY instead of manager-overridable |
| `docs/compliance/*` | the Checkpoint 0 documents brought onto this branch and updated; D-05 matrix; tenancy follow-up; this record |
| `drizzle/0174_dispatch_override_provenance.sql`, `drizzle/schema.ts` | grantor/policy/scope/expiry/org on `dispatchOverrides`; `ruleSetHash`/`orgRef` on `dispatchEligibilityChecks`; fingerprint widened to 80 |
| `server/readinessComposer.ts` | findings merged strictest-wins; structured dangerous goods; complete fact set; rule-set and policy hashes; enforcement version |
| `server/_core/dispatchReadiness.ts` | `requestOverride` decided by override class; policy-only overrides |
| `server/_core/dispatchAward.ts` | SHA-256 canonical fingerprint; 11 new facts; `decideAward` uses the shared coverage rule |
| `server/_core/dispatchEnforcement.ts` | the legacy enforced path uses the same coverage rule |
| `server/_core/readinessCapabilities.ts` | the unsafe cast removed |
| `server/dispatchEnforcementService.ts` | shared grant loader (grantor, not requester); tenant-scope helpers; legacy recompute carries the route |
| `server/dispatchRouter.ts` | tenant scope on every procedure; policy reference on requests; grant provenance; persisted `orgRef`/`ruleSetHash` |
| `server/routers.ts` | `jobUnits.create` passes the acting scope to the gated path |
| `server/dispatchGate.test.ts`, `server/dispatchEnforcement.test.ts`, `server/_core/dispatchAward.test.ts`, `server/commsDispatch.test.ts` | updated to the new contract (see "tests changed", below); nothing deleted |
| `LEASEOS_CURRENT_STATE.md` | regenerated by `scripts/current-state.sh` |

### Defects fixed

| ID | Defect | Fix |
|---|---|---|
| R-2 / C1a-3 | The award path recorded the **requester** as the override grantor, in `dispatchRouter.award` **and** in the legacy `createJobUnitGated` | Grantor columns (0174); `overrideGrant` records grantor, role, time, reason, class, policy, scope and expiry; both paths read them through one loader; a grant whose grantor equals the requester, or with no recorded grantor (every pre-0174 row), is not a grant |
| R-3 / C1a-4 | `mergeBlockers` kept the first duplicate, so a later non-overridable duplicate was dropped | `mergeFindings`: strictest by (effect, override class, severity, result), deterministic tie-break, evidence of all duplicates kept, order-independent |
| R-4 / C1a-5 | A stray `minimumRole` field behind `as DispatchBlocker` hid a missing `overrideAuthority` | Typed return, no cast; the classification decides what may release it |
| R-6 / C1a-2 | Override-ability was a bare boolean; "overridable blocking" findings were silently unawardable; safety UNKNOWNs were releasable by any manager | Explicit `overrideClass` (`NEVER_OVERRIDABLE`, `APPROVED_POLICY_ONLY`, `WARNING_ONLY`, `INFORMATIONAL`) read by request, grant, award and the legacy path; there is **no general manager override** |
| R-5 / C1a-6 | Insurance, enforcement, roadside, faults, calibration, medical, HOS, device, unit documents, route status, legacy licence and rules were outside the fingerprint; FNV-1a 32-bit | 11 new facts plus corrected trailer, route, material and destination versions; `canonicalJson` + SHA-256 (`EF2-…`) |
| R-7 / C1a-7 | Dangerous goods decided by `/tdg\|dangerous\|hazard/i` over the job's free text | `dangerousGoodsAuthority` over `loadProfiles` verified classification; free text can only raise suspicion (UNKNOWN), never establish DG or non-DG |
| R-8 | The legacy enforced path recomputed facts without the check's route | The route is carried through |
| — | PR #4 left `enforcement_result_unknown` manager-overridable | Classified `NEVER_OVERRIDABLE` (regulator order) |
| — | No tenant scoping anywhere on `dispatch.*` | Every procedure resolves the caller's organization server-side and refuses other tenants' identities and checks as "not found" |

### D-02, as encoded

| Finding | Result | Effect | Override class |
|---|---|---|---|
| active OOS (`oos.*`), `enforcement_result_unknown`, required-but-unevaluated enforcement | UNSATISFIED / UNKNOWN | BLOCK | NEVER_OVERRIDABLE |
| licence, required credential, medical, HOS, inspection, registration, insurance, route, permit, DG classification, TDG document, required-capability **unknowns**; undetermined telematics fault; trailer compatibility unknown | UNKNOWN | BLOCK | APPROVED_POLICY_ONLY (no policy approved, so effectively never) |
| expired/missing/insufficient versions of the above, critical defect, missing mechanic release, roadside event, radio not authorized | UNSATISFIED | BLOCK | NEVER_OVERRIDABLE |
| communication plan incomplete (company policy), availability, documents, destination acceptance unverified, maintenance overdue, route review, insurance proof, calibration, device, HOS **attested** (P8.3) | UNKNOWN / UNSATISFIED / SATISFIED | WARN | WARNING_ONLY (acknowledged by the producer's authority, never the requester) |

**Operational consequence the owner should see:** the posting award and the *enforced* legacy path can
no longer be completed by overriding `hos_unknown`, `route_not_evaluated`, `medical_fitness_unknown`
or similar UNKNOWNs. The facts must be established: an approved route, today's HOS attestation, a
verified medical. The composer still receives no computed HOS (`hoursAvailableMinutes` is null), so
**every award now needs a same-day HOS attestation**. A trailer always reads
`trailer_compatibility_unknown` (the composer never establishes compatibility), so **every trailer
dispatch now blocks** until C3. Enforcement mode `off`/`advisory` for `jobUnits.create` is unchanged.

## SPINE path (C1a-10)

```
producer engines (credentials, medical, HOS attestation, unit, insurance, defects/releases, roadside,
  telematics, calibration, enforcement read from outOfServiceOrders [PR #4], Academy, dangerous goods
  from loadProfiles, route approval, communications, capability contract)
  → DispatchBlocker (unchanged producer vocabulary)
  → classifyBlocker → ComplianceFinding            server/_core/complianceFinding.ts
  → mergeFindings (strictest wins)                  readinessComposer.mergeBlockers
  → composeReadiness: eligibility + facts + SHA-256 fingerprint + ruleSetHash   (the ONE composer)
  → dispatch.evaluate: dispatchEligibilityChecks (findings, fingerprint, ruleSetHash, orgRef)
  → dispatch.overrideRequest / overrideGrant: dispatchOverrides (requester, grantor, class, policy, scope, expiry)
  → dispatch.award → decideAward → uncoveredFindings → awardAssignment (FOR UPDATE, dispatchAuditEvents)
    or jobUnits.create → createJobUnitGated → decideLegacyAssignment → uncoveredFindings (same rule)
```

`complianceFinding` is reached from a router (`dispatchRouter`, `readinessComposer`), so it is **not**
added to `DECLARED_UNWIRED`.

**Moratorium status:** unchanged, and not lifted. C1a is reconciliation (one contract over the existing
composer) plus safety fixes. None of the thirteen SPINE engines moved off `DECLARED_UNWIRED`; SPINE
item 1 (boundary confirmation) and item 2 (the four duplications, including
`complianceDocumentValidity`) are not done. What C1a makes real is the dispatch half of the path:
one typed decision from findings to award, with provenance.

## Tests

New: `server/_core/complianceFinding.test.ts` (42), `server/complianceReadinessC1a.db.test.ts` (15).

| # | Required | Where |
|---|---|---|
| 1 | government OOS blocks dispatch | C1a-8 e2e (readiness → `blocked`, `oos.vehicle` BLOCK) |
| 2 | OOS cannot be overridden | C1a-8 (request refused; manager grant refused; controller refused) |
| 3 | repair is not release | C1a-8 (shop release recorded → still BLOCK; `orderRelease` refused) |
| 4 | authorized release removes the OOS contribution | C1a-8 (safety finding + `orderRelease` → no `oos.*`) |
| 5 | real override grantor recorded | C1a-3 DB test (row columns) |
| 6 | requester and grantor distinct | C1a-3 DB test (self-grant refused), pure `uncoveredFindings`, legacy row test |
| 7 | strictest duplicate wins | pure (`NEVER_OVERRIDABLE` kept over overridable) |
| 8 | order independent | pure (every pair `merge(A,B) ≡ merge(B,A)`; composer merge too) |
| 9 | no unsafe cast | pure (typed keys; source scan) |
| 10 | DG free text cannot establish compliance | pure + DB |
| 11 | missing structured DG authority → UNKNOWN | pure + DB |
| 12 | insurance change invalidates | DB |
| 13 | OOS change invalidates | DB (award refused "changed") |
| 14 | HOS change invalidates | DB |
| 15 | credential change invalidates | DB (structured and legacy licence) |
| 16 | route/permit change invalidates | DB (dependency hash, then revocation) |
| 17 | rule-set change invalidates | DB (`ruleSetHash` moves on a new Academy binding) |
| 18 | tenant-crossing refused | DB (readiness, evaluate, request, grant, award; injected tenant ignored) |
| 19 | safety UNKNOWN never green | pure (merge → `unknown`; administrator grant does not award) + D-02 table |
| 20 | refusal is server-side | C1a-8 (API refusal; no `assignment_approved` row) |

Tests changed, with the reason (none deleted, none skipped):

* `dispatchGate.test.ts`: the checklist now says a route unknown needs verification or an approved policy.
  "Awards when a manager granted the override" became "a manager's grant alone never releases a
  route-legality unknown", plus "an approved policy releases it". The Unit 142 end-to-end now shows the
  manager refused, then the facts established and only warnings acknowledged.
* `dispatchEnforcement.test.ts`: enforced mode no longer "assigns once the unknowns are overridden".
  It assigns once they are established. The pure case uses an administrative unknown for the
  acknowledgement path and asserts that a route unknown is not released.
* `dispatchAward.test.ts`, `commsDispatch.test.ts`: fixtures carry the new facts and grant fields.
* `telematics.test.ts`: an unassessed fault is asserted as UNKNOWN / BLOCK / APPROVED_POLICY_ONLY, where it
  used to be asserted as manager-overridable.

## Unresolved risks

1. **Operational:** awards now require facts that are often not yet recorded: HOS (no computed hours),
   route approvals, and trailer compatibility. This is D-02 working as decided, but it will surface
   immediately in any deployment running `enforced`. The approved-override-policy registry is the
   designed release valve and is empty.
2. **Same condition, different codes:** `truck_insurance_*` (base engine) and `insurance_coverage_*`
   (composer) describe one condition under two codes. Strictest-wins works per code, not per condition.
3. **Stored checks from before C1a** carry `EF-` fingerprints and re-evaluate once. Their stored
   blockers are re-classified on read, so an old check's safety unknowns are now refused at award.
4. **Two other hashers remain** (`structures.hashPart`, `commPackage.hashOf`). They were not unified
   to avoid changing route and package outputs.
5. **Carrier-scope OOS** matches only through enforcement events on this unit, trailer or operator,
   as in PR #4. A carrier-wide order recorded against a different unit does not ground this one.
6. **Unscoped tables** remain: see `docs/compliance/follow-ups/TENANCY_UNSCOPED_COMPLIANCE_TABLES.md`.
7. **No outbox events** are emitted for `compliance.evaluated`/`blocker.*` yet. The audit trail is the
   persisted check and override rows plus `dispatchAuditEvents`.
8. **Shift readiness** (R-10) is still a separate authority; D-06's behavioural-equivalence tests are not
   written.
9. **`0170` collision** among PR #9, the auth-workspace branch and the driver-portfolio branch (which
   also reuses `0169`) is unresolved and is not this checkpoint's to resolve.

## Next recommended checkpoint

**C1b — requirement registry reconciliation** (authority tier, immutable versions, generalized promotion
ledger with the HOS history preserved, `complianceDocumentValidity` resolution, and the credential
read adapter from the D-05 matrix). It is safe to begin once C1a is reviewed and merged, and it needs
owner answers to the D-05 questions in `docs/compliance/credential-store-reconciliation.md`.

## Owner decisions recorded after review (2026-09-23)

* **Fail-closed UNKNOWN is kept as built.** No blanket override policy will be added to make current
  flows easier; the approved-override-policy registry stays empty.
  * Missing HOS authority may be met by the same-day HOS attestation path, until calculated or
    verified HOS state replaces it (HOS work).
  * Unknown truck/trailer compatibility stays blocking until C3 establishes it from verified fleet data.
  * Government OOS stays absolutely non-overridable.
  * Safety-critical UNKNOWN stays non-green.
* **D-05 approved:** see `docs/compliance/credential-store-reconciliation.md`.
* **Merge order:** PR #5, then C1a, then restack #6 and #9.

## Review round on PR #12 (before merge)

An independent review of the rebased diff found no bypass of the OOS, grant-provenance,
tighten-only or legacy-path invariants. It did find these, all fixed before merge, each with a test:

| Finding | Severity | Fix | Test |
|---|---|---|---|
| `dispatch.evaluate` read the posting before any scope check: another tenant's posting could be attached to a check, and "Posting not found" was an existence oracle | blocking | the posting's job must be in scope ("not found" otherwise); a posting paired with a different `jobId` is refused; `award` re-scopes the posting | DB "review fixes" |
| `dispatch.whatAmIMissing` did not scope the `unitId`/`jobId` it was given | blocking | scoped like `readiness` | DB "review fixes" |
| `dispatch.enforcementSet/Get` let any organization read or write the **global** setting the legacy path uses (pre-existing) | blocking | only the historical single tenant may touch the global row; entity rows must be in scope | DB "review fixes" |
| The legacy path compared job and unit before checking scope, which leaked a foreign check's job; `actingScope` was optional | should-fix | scope first; `actingScope` required | DB "review fixes" (mutation-checked: removing the fixes turns it red) |
| **Time-driven expiry was outside the fingerprint:** a policy valid at 23:50 and lapsed at 00:10 left every row unchanged, so an award inside the reuse window went through on the old answer | should-fix (safety) | new fact `expiryStateVersion`: whether each governing expiry had passed **at the evaluation instant**; calibration status in `calibrationVersion` | DB "time itself stales a check" |
| `lone_worker_satellite_unknown` (WARN) was easier to release than `lone_worker_no_satellite` | should-fix | UNKNOWN / BLOCK / APPROVED_POLICY_ONLY (`CLASSIFICATION_VERSION` → `c1a.2`) | pure |
| Strictest-wins tied on label only, so the dispatcher-grade duplicate could win over the manager-grade one by arrival order | should-fix | acknowledgement authority and subject join the order | pure |
| An approved-policy grant was not re-checked against the policy's current grantor role; the second approver could be blank | nit | re-checked at award; both approvers must be named | pure |
| The legacy recompute dropped the check's trailer | nit | carried through | covered by existing suites |

CI on the first PR head (`47b8a43`) failed once in `server/b20WorkflowWiring.test.ts` (sealed incident →
tasks); the other run on the same commit passed. **Root cause:** that suite's `drainAll` ran the
outbox worker for a fixed 300 ms over the whole outbox in id order, so events other suites enqueued
concurrently (C1a's OOS end-to-end among them) could push this test's event past the window. **Fix:**
drain until every event that existed at the start is processed, dead-lettered or deferred, with a
15 s ceiling. No assertion was loosened.

## Integration record (final)

| | |
|---|---|
| PR #4 merge | `38d26770bdcd5b4bd89f14fee6874559492394bf` |
| PR #5 | head `e6b65f2`; **merge `6b01a0eaf5f1147fd0db0499e3cd9fccf3c03ee1`**; main gate PASS (315 files, 4416 passed, 3 skipped) |
| C1a PR | **#12**, head `50ae78f216a46cf06f37b0770f30ed16f87aecf9` (rebased onto `6b01a0e`, then the review-round fixes); GitHub CI green (push and PR runs) |
| C1a merge | **`42c454f34933a252138bfdad3c2f4535758d5e79`** (merge commit; tree identical to the gated `50ae78f`) |
| Gate on the actual resulting `main` (`42c454f`) | **PASS** gates 0–8. **317** test files, **4492 passed**, **3 skipped** (pre-existing `agentRuntimeApi`), no DB suite skipped. Typecheck clean; test-file type errors 0/0. Bare `protectedProcedure` 0. Build OK. 408 tables; **167 migrations, head `0174_dispatch_override_provenance.sql`**; 647 role / 36 external / 2 integration procedures |
| Migration | `0174` (moved from `0172` at integration; see `docs/architecture/MIGRATION_COLLISION_REGISTER.md`) |
| Restack | PR #6 ← main merged (`1aaf4f7`), base retargeted to `main`; PR #9 ← main merged (`3e8aef0`, `dispatchRouter.ts` resolved to keep both #9's role-slot procedures and every C1a guard), base retargeted to `main`. Neither merged |

Every "Starting/ending SHA" assumption earlier in this document is superseded by this table.
