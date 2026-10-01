# C1b-3 — one document-validity decision, and qualification reads through D-05

> **Reconciled with #52 (2026-09-25).** #52 (SPINE item 2) unified the same four document-validity
> decisions first and was merged. The owner ruled that #52's model governs, so on merging main the
> document-validity half of this checkpoint was resolved to main: `complianceDocumentValidity.ts`,
> `compliancePassport.ts`, `dispatchReadiness.ts`, `readinessComposer.ts`, `widgetSources.ts` and the body
> of `validityOf` are main's. Dropped with it: `claimValidity`/`governingClaim`/`asClaimVerification`, the
> exported per-surface helpers, `documentValidityCharacterization.test.ts`, and the document-validity cases
> and census 1/10 in `documentValidityCanonical.test.ts`. Kept: `readExpiry` (the qualification readers
> use it), `heldFromValidity`, and the whole D-05 qualification read adapter (`qualificationReads.ts`
> and the readiness/crew/open-shift/calendar routers reading through it), adapted to main's
> `complianceDocumentValidity` row type. The sections below describe the branch as first written.

**Status:** **merged** in #57 as `3127f11` (2026-09-26). The post-merge record is at the end of this
document. It covers what reached `main`, and what is still open.
**Base:** `main` @ `3d05d32` (merge of #54, C1b-2b). **Migration head:** `0198_requirement_verification` (unchanged).
**Migration:** none. Nothing needed a schema change: the adapter reads existing columns, and every
reconciliation is in code.

**Scope boundary (held):**
- No C2, no new engine, no V2 of any engine.
- No change to dispatch readiness output (proven over the whole characterization matrix).
- No writer, no data migration, no schema change.
- `workerQualifications` and `operatorCapabilities` are not deleted.
- `dispatchMatching`, `openShifts` and `fieldTicket` are not reconciled.

---

## 1. The four document-validity implementations

Before C1b-3, four places each decided "is this document in force" in their own way:

| # | Where | Rule before | Used by |
|---|---|---|---|
| 1 | `widgetSources.expiryState` | `expiresAt - now < warnDays·86400000` (milliseconds); a null verification read as verified | vault tile |
| 2 | `compliancePassport.evaluateRequirement` | `expiresAt <= now` expired; its own day arithmetic and claim selection | passport, work authorization, packs |
| 3 | `readinessComposer.credentialState` | own "best row" selection; no instant (the caller compared) | dispatch readiness composer |
| 4 | `dispatchReadiness.credentialBlocker` | `expiresAt < asOf` expired | dispatch readiness |

The unwired `_core/complianceDocumentValidity.ts` (SPINE item 2) had a fifth rule set, which nothing
called: newest captured row, and a severity table.

### Characterization first (`server/documentValidityCharacterization.test.ts`, commit `4056d51`)

These tests were frozen on `main` **before** any replacement. They take NOW = 2026-10-15T12:00:00Z and
cover these expiry cases:
- no expiry;
- +400 days;
- later today;
- ±1 second;
- the exact instant;
- −10 days;
- exactly 30 days;
- 30.5 days;
- a date-only value (midnight UTC);
- a local end of day in a −07:00 timezone.

Each case runs against verified, needs_review, rejected and null verification, plus four multi-row
selection cases. The `BEFORE` literal was generated from `main`. `RESOLVED` lists each changed output
with its reason; every other cell must still equal `BEFORE`.

### Semantic differences discovered, and how each was resolved

| Difference | Canonical choice | Visible change |
|---|---|---|
| Exact instant: passport `<=`, dispatch `<` | `<` (in force at the instant, expired 1 ms later): dispatch's rule, so dispatch is unchanged | passport at the exact instant: `expired` → `expiring:0` (verified), `evidence_unverified:0` (needs_review) |
| Warning window: tile in milliseconds, passport in whole days | whole days (`floor`), `expiring` iff `noticeDays > 0 && days <= noticeDays` | tile at 30.5 days with a 30-day window: `current` → `expiring` |
| Null verification: tile read it as verified | anything other than `verified`/`rejected` is `needs_review` | tile for null verification with no expiry: `current` → `unverified` |
| Row selection: the unwired adapter used the newest captured row; the live callers used verified > needs_review > rejected, then the latest expiry | the live rule (it was the one in production) | none |
| Precedence of unverified vs expired: tile names unverified first; passport and dispatch name the expiry first | kept per caller: this is presentation. The engine reports both `state` and `expiry` | none |

**Dispatch output is identical across the whole matrix** (the `dispatch` column of `RESOLVED` is
unchanged).

## 2. The canonical path

```
producer (complianceDocuments / academyQualifications / workerQualifications rows)
   → _core/documentValidity.ts   readExpiry(expiresAt, at, noticeDays) → {expiry, daysRemaining}
                                 validityOf(versions, at)              → Validity (versions, supersession)
   → _core/complianceDocumentValidity.ts
                                 governingClaim / claimValidity / complianceDocumentValidity
                                 (selection + verification + expiry; no user-facing strings)
   → projection / adapter (wording lives here only)
        widgetSources.expiryState      VAULT_WORD[state]
        compliancePassport             claimValidity → PassportItem status/reason
        readinessComposer.credentialState  complianceDocumentValidity → present / not present
        dispatchReadiness.credentialBlocker  readExpiry(…, 0).expiry === "expired"
        qualificationReads.effectiveQualifications  (D-05, below)
   → consumers: vault tile, passport / work authorization / packs, dispatch readiness, shift readiness,
                crews, open shifts, calendar
```

`documentValidity` was **extended once**: `readExpiry` and `ExpiryClass` were added, and `validityOf`
now uses `readExpiry`. `complianceDocumentValidity` was rewritten as a thin selection layer over it.
It has no strings and takes every input explicitly (`at` and `noticeDays`, never `new Date()`).

### Deleted

- The four inline expiry rules above.
- From `complianceDocumentValidity.ts`: `documentExpiry`, `ExpiringDocument` and `SEVERITY`.
- From `qualificationValidity.ts`: `countsAsHeld` and `missingFrom`, which had no remaining users.
- Every direct `workerQualifications` query in the four readers.

### Deferred and named, not hidden

The census allowlists each of these with its reason:

- `medicalFitnessForDispatch` (`compliancePassport.ts`) compares `credential.expiresAt <= now`. It
  feeds dispatch, so moving it to `<` would change dispatch at the exact instant. That is a C2 follow-up.
- Composer Academy acceptance: `q.status === "current" && (!q.expiresAt || q.expiresAt > now)` in the
  dispatch composer. It is qualification validity that dispatch owns (C2).
- The Academy binding window and the calendar view window are not document-validity decisions.

## 3. The D-05 qualification read adapter — `server/qualificationReads.ts`

`effectiveQualifications(d, { tenantId, userId, at, codes? }) → EffectiveQualification[]`. It is
read-only: it contains no `insert`, `update` or `delete`, and the census enforces that.

### Provenance on every result

Each result carries:
- `userId`, `code`, `orgRef`;
- `source` (`ACADEMY_QUALIFICATION` | `LEGACY_WORKER_QUALIFICATION` | null), `sourceRef`, `legacyFallback`;
- `state` (the engine's verdict), `held`, `notHeld`, `reason`;
- `issuedAt`, `expiresAt`;
- `verification`, `verifiedByUserId`, `issuer`, `certificateNumber`;
- `academyQualificationRef`;
- `evidence`, the linked `complianceDocuments` verdict: ref, type, state and expiry;
- `discrepancies`.

### Precedence (per person and code; deterministic)

1. **`academyQualifications`.** Status maps as follows:
   - `current`/`expired` → verified;
   - `pending` → uploaded;
   - `rejected`/`revoked` → rejected.

   The rows are then decided by `validityOf`. A stored status of `expired` forces expired
   (`ACADEMY_STATUS_EXPIRED`) even when the date says otherwise. When any Academy row exists, it
   decides, and canonical never loses to a more permissive legacy row.
2. **`complianceDocuments` evidence.** When the governing Academy row is an `external_credential` with
   a `complianceDocumentId`, that document is read through `complianceDocumentValidity`. Evidence that
   is not in force (expired, rejected, unverified or missing) means the qualification is **not held**
   (`EVIDENCE_NOT_IN_FORCE`).
3. **Legacy fallback.** This applies only when no Academy row exists for the code. It returns
   `source = LEGACY_WORKER_QUALIFICATION`, `legacyFallback: true` and `issuer = legacy:recordedBy:N`.
4. **Otherwise** nothing is on record: `source: null`, `state: none`, not held (`unknown`).

If a legacy row exists alongside a canonical one and reads differently, the result gets
`LEGACY_DISAGREES`, which names the legacy holding. Nothing is rewritten.

### Legacy fallback behaviour

- It is used only where no canonical record exists, and is marked explicitly (`legacyFallback: true`).
- Superseded rows yield to their successor.
- **Insufficient provenance reads UNKNOWN.** A legacy row that claims `verified` without a
  `verifiedByUserId` and `verifiedAt` is treated as extracted, so it is not held and the code is
  `unknown`.

  This is stricter than before, where `verificationState = 'verified'` alone counted. No production
  writer of `workerQualifications` exists, so only test fixtures were affected; they now record a
  verifier.
- A verified row with no expiry is not held (`unknown`: "no expiry recorded"). This matches the old
  readers.

### Tenancy

- The organization is always `resolveActingScope(...)` / `acting.tenantId`, from the server and never
  from input.
- **Person scope:** `userInScope(userId, {tenantId})` runs first. If it fails, the read **fails closed**:
  every requested code comes back `source: null` / `unknown`, and nothing is read about that person.
- **Academy rows** have no organization column. They are reached only through a person already in scope.
- **Legacy rows** are filtered on `tenantId`, which is exact for a named organization. For the
  single-tenant default, the filter is `'default'` or `NULL`. A legacy row stamped for organization A
  is invisible to a read in organization B, even for the right person.
- **Finding:** before C1b-3, all four readers queried `workerQualifications` by `userId` with **no
  organization filter**. They are now scoped and fail closed.

## 4. The four readers

| Reader | Before | After | Semantics preserved |
|---|---|---|---|
| Shift readiness (`readinessRouter.checksFor`) | own query + `qualificationValidity` | `effectiveQualifications` for the required codes at `startsAt`; `acting.tenantId` now captured in `forTime` too | held → satisfied; not held → failed/unknown with the same reason codes |
| Crews (`crewRouter` forecast) | own query, verified & in date at `from` | `effectiveQualifications(...).filter(held)` at `from` | the same codes count |
| Open shifts (`openShiftsRouter` eligibility) | own query + `missingFrom` | not-held entries → `{code, reason, why}` | the same `qualification_*` reasons and detail text; the eligibility decision itself stays inline (the `openShifts` duplication is **not** reconciled) |
| Calendar (`calendarRouter` qualification expiries) | own query, verified rows only | adapter results with a source, skipping none/unverified/rejected, inside the view window | the same events; source type is `academyQualification` or `workerQualification` |

Each reader also uses `readExpiry` where it checked a licence expiry inline (readiness, open shifts).

**Remaining direct `workerQualifications` readers:** one, `server/qualificationReads.ts`. The census
test enforces this. `_core/qualificationValidity.ts` mentions the table only in a type comment.

**Remaining credential-store writers.** All are unchanged, and none were added:
- `complianceDocuments`: `complianceRouter` (insert, update), `db.ts` (insert, update), `hosRouter`
  (insert) and `workforceRouter` (insert).
- `academyQualifications`: `trainingAcademyRouter` (2 inserts, 1 update).
- `workerQualifications`: **none** in production.
- `operatorCapabilities`: no production reference at all.

## 5. Tests

**New in C1b-3:**
- `documentValidityCharacterization.test.ts` (2): frozen before/after matrix.
- `documentValidityCanonical.test.ts` (13): canonical cases 2–9, plus the census:
  - (1) the four callers route through the engine;
  - (10) no expiry arithmetic remains outside the named allowlist;
  - only the adapter reads `workerQualifications`;
  - (24) no writers exist;
  - `operatorCapabilities` is untouched and the adapter writes nothing.
- `qualificationReads.db.test.ts` (16):
  - cases 11–23;
  - the precedence rules: Academy, evidence, legacy; conflicting legacy loses; discrepancies are exposed;
  - explicit legacy fallback;
  - insufficient provenance reads UNKNOWN;
  - superseded rows;
  - tenant crossing, both at the adapter and through the readers: a dispatcher in B cannot read A's
    person, and a legacy row stamped for A is invisible from B;
  - the four readers.

**Updated:**
- Legacy fixtures in `readinessApi`, `crewForecast`, `calendarProjectionApi` and `qualificationStore`
  now record a verifier on `verified` rows.
- `documentValidity.test` has the new route scan.
- `engineReachability.test`: `complianceDocumentValidity` is no longer declared unwired, and the pin
  moves down by one: 63 → 62 on the C1b-3 base, 84 → 83 after merging `main` (#7 declared 21 AI Secretary modules).

**Focused run** (fresh database; 74 files covering document validity, passport, requirements, work
authorization, Academy, crews, readiness, open shifts, calendar, qualification, tenancy/authorization,
widgets, dispatch readiness and the SPINE census): **1046 passed, 30 skipped, 0 failed.**

**Typecheck:** both `tsc --noEmit` and `tsc --noEmit -p tsconfig.tests.json` are clean.

**Full gate** (`scripts/ci-gate.sh`, fresh database): **PASS**, 368 files, 5397 passed, 3 skipped, 0 failed.

## 6. SPINE impact

- **Item 2.** `complianceDocumentValidity` is **resolved**. It is wired (widget, passport, composer and
  dispatch all decide through it or its core) and has been removed from `DECLARED_UNWIRED` (83
  remain). The three remaining duplications are `dispatchMatching`, `openShifts` and `fieldTicket`.

  The adapter moves `openShifts`' qualification *reads* onto the canonical projection, but its
  eligibility decision is still inline. That duplication is **not** resolved.
- `docs/register/SPINE_WIRING_PLAN.md` is hash-pinned and not edited. Its status is tracked here and
  in the implementation plan.

## 7. What remains for credential cleanup (not C1b-3)

- `medicalFitnessForDispatch` `<=` → canonical `<` (dispatch-affecting; C2).
- Composer Academy acceptance → the adapter (dispatch-affecting; C2).
- `workerQualifications` retirement: it has no writer. Retiring it needs an owner decision on the
  historical rows (migrate into Academy `external_credential`, or archive) before any delete.
- An organization column on `academyQualifications`, if cross-organization people become possible.
  Today scope comes through the person.

## 8. Rollback

Revert the C1b-3 commits. There is no migration, so no data or schema needs reverting.

## 9. Post-merge record (checked on `main` @ `b02e6df`, 2026-10-01)

#57 merged as `3127f11` on 2026-09-26. Before it merged, `main` was merged into the branch, and #52's
document-validity model was kept in every file both changed (see the note at the top). Since then `main`
has taken #59, #102, #104 and #108, among others. This section records what of C1b-3 is on `main` today.

**On `main`:**
- `server/qualificationReads.ts`, the D-05 adapter. It is read-only and organization-scoped. Its
  precedence is Academy, then `complianceDocuments` evidence, then an explicit legacy fallback. It is
  still the only production reader of `workerQualifications`; `server/documentValidityCanonical.test.ts`
  enforces that.
- Four readers go through the adapter:
  - shift readiness (`readinessRouter.ts`);
  - crews (`crewRouter.ts`);
  - the calendar (`calendarRouter.ts`);
  - open shifts. These now read through `openShiftsService.ts:156` (`effectiveQualifications`). The
    router no longer reads qualifications itself.
- `readExpiry` and `heldFromValidity`, and `academyVerdict` in `_core/qualificationValidity.ts`, where
  #52's guard requires it to be.
- `server/qualificationReads.db.test.ts`, covering precedence, fallback, provenance and tenant crossing.

**Not on `main`.** These were dropped when #52's model was chosen:
- C1b-3's own document-validity routing;
- `documentValidityCharacterization.test.ts`;
- the document-validity cases and census 1 and 10 in `documentValidityCanonical.test.ts`.

#52's `complianceValidityGuard.test.ts` now does that census job.

**SPINE item 2.** `docs/register/SPINE_ITEM2_DUPLICATIONS.md` records all four pairs as resolved.
`complianceDocumentValidity` was resolved by #52. `openShifts`, `dispatchMatching` and `fieldTicket` were
resolved by the item-2 work recorded there. The register marks item 2 **COMPLETE** only after its last
branch merges and CI on the resulting `main` is green. That record belongs to that register, not to this
document. `server/engineReachability.test.ts` pins 73 unwired engines on `main`.

**The two deferrals from §2:**
- `medicalFitnessForDispatch`: **resolved by #52.** It now takes the canonical verdict
  (`compliancePassport.ts:388`, called from `readinessComposer.ts:536`).
- Composer Academy acceptance: **still open.** `readinessComposer.ts:506` still reads
  `q.status === "current" && (!q.expiresAt || q.expiresAt > now)` inline. It affects dispatch, so moving
  it onto the adapter or the canonical verdict is C2 work.

**Credential cleanup still open (unchanged):**
- retire `workerQualifications`. It has no writer, and its historical rows need an owner decision first;
- an organization column on `academyQualifications`, if people can belong to more than one organization.

**Gate on `main`.** `scripts/ci-gate.sh` was run on a fresh database with Node 22.23.3, the version
`.nvmrc` pins; gate 0a refuses any other version.
- At `240b2dd`: 6941 passed, 3 skipped, and **1 failed**. The failure was the census "open work consumes
  the adapter's verdict and decides no qualification itself" in `documentValidityCanonical.test.ts`.
- **Cause:** two merges collided.
  - #59 added that census check. It forbids the open-work files from importing anything from
    `documentValidity`.
  - The SPINE item-2 open-shift rule (`c2dc622`) imports `readExpiry` from it, in
    `_core/openShifts.ts`, to judge the licence date.
- **Fix:** #117 (`8ccf578`, merged as `b02e6df`). It allows exactly that one name in exactly that file.
  A licence date is not a qualification, and `readExpiry` is the canonical expiry primitive.
- That test file is the only difference between `240b2dd` and `b02e6df`. At `b02e6df` it passes, along
  with `qualificationReads.db`, `complianceValidityGuard` and `engineReachability` (4 files, 53 tests).
