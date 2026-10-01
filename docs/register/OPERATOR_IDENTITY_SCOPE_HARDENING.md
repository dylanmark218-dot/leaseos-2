# Operator identity and scope hardening — checkpoint

> **Status: OPID-1 to OPID-7 closed on `claude/operator-identity-scope-hardening`.** The finding
> below was committed first, before any test or code (`7702582`, from `main` @ `b35bac4`). Then
> came the RED suite (`20ef18c`) and the fix. What the fix did, and what is still open, is in
> [Result](#result) at the end. The analysis is kept as the record of what was found.

## Why this exists

PR #21 (merged 2026-09-24) fixed the widget tiles that passed `actor.userId` where an `operators.id`
was expected. Its description named, as out of scope, several other places that resolve a person's
operator record with `.limit(1)` and no organization filter, and noted that `hos.status` did not
scope-check its `operatorId`. This checkpoint re-audits those on current `main` and records what is
still open, so the hardening work starts from a written list and not from memory.

## The rule

1. A caller's operator identity comes from the canonical link only: authenticated user →
   `operators.userId` → `operators.id`, filtered to the acting organization through
   `coreRecordOwnership` (`ownershipScopeWhere`). The one resolver is `operatorForUserInScope`
   (`server/db.ts`).
2. `userId == operatorId` is never assumed. The two come from different sequences.
3. No arbitrary or first-row resolution. `operators.userId` has no unique constraint, so two in-scope
   records are `ambiguous` and refused; row order never decides.
4. Every operator lookup is tenant/organization scoped.
5. `hos.status` and every other procedure that takes or derives an operator id checks that the
   operator belongs to the acting organization.
6. A legacy or unowned row is visible only to the historical single tenant (`ownershipScopeWhere`
   already says so). It must never become a way into another organization's records.
7. Fail closed. Where identity or ownership is ambiguous, the answer is `none`/`unknown`/`NOT_FOUND`,
   never a guess.

## Already closed on `main`

| Where | Closed by | How |
|---|---|---|
| Widget tiles (`hosRemaining`, `documentExpiry`, `unitReadiness`) | #21 | `operatorForUserInScope`, branded `OperatorId`, fail closed |
| `shifts.eligibility` / `shifts.expressInterest` | SPINE item 2 | `operatorForUserInScope`; the `operators.id == userId` read removed |
| `hos.status`, `hos.tripFeasibility`, `hos.attestHours`, `hos.recordScannedLog`, `dutyRecords.list` | `4bcd241` | `server/hosScope.ts`: `requireHosOperatorInScope`, `selfOperatorInScope`, strict acting scope |
| Telematics self lookups | P0-A2 | `server/telematicsScope.ts` uses `operatorForUserInScope` |
| Unscoped `operatorForUser` in `routers.ts` | earlier P4.1 work | deleted |
| Ended membership revived as the single tenant | #64 | `resolveActingScope` refuses it |

## Still open on `main` @ `b35bac4`

Each one reads `operators` by `userId` with `.limit(1)` and no ownership filter. Each will get a RED
database test before it is changed. The impact column is what reading the code shows. The RED tests
will confirm or correct it.

| ID | Site | What the chosen row controls | Impact if the first row is the wrong one |
|---|---|---|---|
| OPID-1 | `recordsService.resolveOperatorForUser` (`server/recordsService.ts:37`), 7 callers in `recordsRouter.ts` | `records.evidence.listForOperator` returns that operator's evidence with no scope check ("scoped by construction"); `records.roadside.open` loads that operator's roadside candidates; `authorizeRecordScope` treats it as the caller's own operator | **Cross-tenant read.** A person with an operator record in organization B, acting in A, is served B's evidence and roadside data for that record. |
| OPID-2 | `dispatch.whatAmIMissing` (`server/dispatchRouter.ts:384`) | the operator whose readiness is composed | `assertReadinessSubjectInScope` runs afterwards, so another organization's operator is refused, not leaked. Still first row wins: a person with records in two organizations can be refused for their own, and two in-scope records pick one silently. |
| OPID-3 | `workforceRouter.ownerFor` (`server/workforceRouter.ts:47`) | the `complianceDocuments` owner when onboarding or training writes a verified credential | **Cross-tenant write.** Organization A's onboarding can file a verified credential under organization B's operator record. |
| OPID-4 | hire in `workforceRouter` (`server/workforceRouter.ts:104`) | whether an operator record is created for a hired driver | The existence check is unscoped, so a hire in A creates no operator record when one exists in B. The insert writes no `coreRecordOwnership` row, so the new record is unowned and visible only to the single tenant (rule 6). |
| OPID-5 | `payrollService.resolveOwnPayrollProfile` (`server/payrollService.ts:49`) | the profile shown as the caller's own | `ownProfileOrThrow` checks the profile's entity afterwards, so another organization's profile is refused, not leaked. First row still wins; the caller's real profile in the acting organization can be missed. |
| OPID-6 | `customerCommercialService.callerAssignedToJob` (`server/customerCommercialService.ts:953`) | whether a field-only caller may read a job's commercial field summary | First row, unscoped. Its fallback also matches `jobs.driver` (free text) to `operators.name`, so any operator who shares the typed name counts as assigned. |

## What the hardening branch will do

A. **RED.** One database-backed suite through `appRouter.createCaller`. For each OPID it builds the
   collision on purpose: the caller has an operator record in another organization, or two in their
   own, or one whose id equals another person's user id. It asserts the fail-closed answer. Each case
   must fail on `main` before any fix.
B. **Fix.** Every site above resolves through `operatorForUserInScope` with the scope its router
   already uses, and treats `none` and `ambiguous` as refusals. OPID-4 records ownership for the
   operator it creates. OPID-6's name match is removed or limited to the resolved operator; this
   one changes behaviour, so the RED test pins whichever rule is chosen.
C. A source guard: outside `operatorForUserInScope`, no production code reads `operators` by
   `userId`.
D. Typecheck, the full gate (`scripts/ci-gate.sh`) against a fresh MariaDB, and the mutation check:
   putting each first-row lookup back must fail a named test.
E. `LEASEOS_CURRENT_STATE.md` regenerated by `scripts/current-state.sh`, and this document updated
   to what was closed and what was not.

## Out of scope

- Routers still on the non-strict `resolveActingScope`, which is not an operator-identity question;
  their own checkpoints cover them.
- `operators.userId` uniqueness per organization as a database constraint. That needs a migration and
  a data check of existing rows; it is recorded here as the follow-up that would make rule 3
  structural instead of enforced in code.

## Result

Every site now resolves through `operatorForUserInScope` with the scope its router already uses.
`none` and `ambiguous` are refusals.

| ID | Change | Fail-closed answer |
|---|---|---|
| OPID-1 | `resolveOperatorForUser` resolves in `actingScopeFor(userId)`; its 7 callers are unchanged | no operator: `listForOperator` is `[]`, `roadside.open` has no records, a near miss carries no operator |
| OPID-2 | `whatAmIMissing` uses the scope it already resolved | `unknown`, with a note that says none or more than one |
| OPID-3 | `ownerFor` resolves in the verifier's acting scope | none: filed under the person as `user`; two: `PRECONDITION_FAILED` |
| OPID-4 | hire checks for a record in the hiring scope and creates one through `createOperator`, which records ownership (none for the single tenant) | a record elsewhere no longer stops one being created here |
| OPID-5 | `resolveOwnPayrollProfile` takes the money scope, resolved before the lookup | no profile: `NOT_FOUND`, as before |
| OPID-6 | `callerAssignedToJob` takes the commercial scope; the name match is against the resolved record only | not assigned: `NOT_FOUND` |
| OPID-7 | `shifts.award` (`server/shiftAwardService.ts`, which came from `main` in the 2026-10-01 merge) resolves the person in the post's scope. It had read the first row and then checked that row was in scope | none: `no_operator_record`; two: `no_operator_record` with its own reason, and nothing is bound |

**Tests.** `server/operatorIdentityScope.db.test.ts`: 12 cases, all RED on `b35bac4` and GREEN
here. OPID-7 has two cases in `server/shiftAward.db.test.ts`, next to the award's own fixtures.
Both are RED with `main`'s award code and GREEN here. `server/operatorIdentityGuard.test.ts` is
the source guard: no production file filters `operators` by `userId` except
`operatorForUserInScope` and `boardIdentity.displayIdentities`, a batched, organization-scoped read
of display names. Reading the column after a lookup by operator id is allowed (`jobRoomService`).
The guard caught OPID-7 the first time `main` was merged in. One fixture was corrected:
`customerCommercial.db.test.ts` created its drivers' operator records with no owner, which only
the unscoped lookup let through. They are now owned by the test's organization, and no assertion
changed.

**Mutation check.** Putting back `main`'s version of each changed file one at a time (records,
dispatch, workforce, payroll, commercial) fails that file's OPID cases and the source guard, every
time.

**Gate.** `scripts/ci-gate.sh` on Node 22.23.3 (`.nvmrc`) against a fresh MariaDB 10.11.14.
Gates 0 to 7c pass: typecheck clean, test-file type ratchet 0, procedure census unchanged (743
role procedures), **443 files, 6,785 passed, 3 skipped, 0 failed**, no database suite skipped,
fixture isolation, the production build and the production-only boot, 36 external and 2
integration procedures. Gate 8 was stale only by the two new test files. The document was
regenerated by `scripts/current-state.sh` (441/6115 → 443/6128) and is committed separately.

## Still open after this branch

- **OPID-6 name match.** A field-only caller still counts as assigned when `jobs.driver` (free text)
  equals their own in-scope operator's name. That is now limited to the caller's own record. Two
  people with the same name in one organization still both match. Removing the legacy match changes
  behaviour for jobs with no dispatch role, so it needs an owner ruling.
- **Hire names any user id.** `workforce.applicantDecide` takes `userId` from input and does not
  check that the user is in the hiring organization before creating their operator record and
  onboarding plan. That is a separate scope finding, not an operator-identity one.
- **Uniqueness as a constraint.** `operators.userId` is still not unique per organization. Rule 3
  is enforced in code. A database constraint needs a migration and a check of existing rows.
